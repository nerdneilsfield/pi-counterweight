/**
 * M3 冻结保护验收测试：冻结哈希冲突的检出与落盘、冲突差异编号与去重、证据失效（树/契约变化）、
 * 受保护路径集合，以及 10MB / 5000 文件规模下的单次检查时间预算；每个用例都在临时 git 仓库上运行。
 *
 * M3 freeze protection: detecting and recording frozen-blob conflicts, the
 * numbered diff trail and its de-duplication, verified-evidence invalidation on
 * tree or contract change, the protected-path set, and the per-call time budget
 * at 10 MB and 5000 files. Every case runs against a throwaway git repository in
 * the OS temp directory; the real worktree is never touched.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { contractSha256 } from "../../src/core/contract.ts";
import { checkFrozen, isProtectedPath, recheckContract, recheckTree } from "../../src/core/freeze.ts";
import { blobHash, blobHashes, treeHash } from "../../src/core/gitstate.ts";
import { acquireLock, createTask, readState, TaskLockError, updateState } from "../../src/core/task.ts";
import type { Contract } from "../../src/core/types.ts";

const taskId = "20260928-lifetime-fix";

/**
 * 在 `cwd` 下执行 git 并返回 stdout；非零退出即 reject，让仓库准备的失败立刻暴露。
 *
 * Runs git in `cwd` and resolves its stdout; a non-zero exit rejects, so a broken
 * fixture setup fails loudly instead of producing an unexpected tree.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")}`)));
  });
}

/**
 * 建带基线提交的临时 git 仓库（`tracked.txt` + `tests/a.py`）并创建本任务台账；一用例一仓库。
 *
 * Throwaway git repo with a baseline commit (`tracked.txt`, `tests/a.py`) plus
 * this task's ledger; one repo per case so cases cannot leak into each other.
 */
async function gitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cw-m3-"));
  await git(root, ["init"]);
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "tests", "a.py"), "check\n");
  await git(root, ["add", "tracked.txt", "tests/a.py"]);
  await git(root, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  await createTask(root, taskId, "gateway/medium");
  return root;
}

/**
 * 构造 `frozen_blobs` 映射：以当前 `tests/a.py` 的 blob 哈希作为已批准值，之后任何写入都算冲突。
 *
 * Builds the `frozen_blobs` map using the current `tests/a.py` blob hash as the
 * approved value, so any later write to that file becomes a conflict.
 */
async function frozen(root: string): Promise<Record<string, string>> {
  const blob = await blobHash(root, "tests/a.py");
  return { "tests/a.py": blob.value! };
}

/**
 * 写入一条绑定当前树哈希的 `last_verified`，作为「已验证后又发生变化」的对照起点；契约哈希可注入。
 *
 * Seeds `last_verified` against the current tree hash so a later mutation has
 * evidence to invalidate; the contract hash is injectable to exercise drift.
 */
async function seedVerified(root: string, contractHash = "a".repeat(64)): Promise<void> {
  const tree = await treeHash(root);
  await updateState(root, taskId, "s", (state) => ({
    ...state,
    last_verified: { run: 1, tree: tree.value!, contract_sha256: contractHash },
  }));
}

/**
 * 最小契约 fixture：只填冻结与证据失效判定会读到的字段。
 *
 * Minimal contract fixture: only the fields freeze and evidence invalidation
 * actually read are meaningful here.
 */
function contractOf(acceptance: string[]): Contract {
  return {
    version: 1, task_id: taskId, tier: "change", deliverable: "code", goal: "g",
    non_goals: [], acceptance, red: acceptance.slice(0, 1), regression: [],
    frozen: [], interface: [], baseline_inputs: [], approved_failures: [],
  };
}

// 契约：只报告冲突、保留差异，绝不还原被篡改的文件；冲突产物落在 .cw/ 下，记录冲突本身不改变树哈希证据。
// Contract: report the conflict and keep the difference — never restore the
// tampered file. Artifacts live under `.cw/`, so recording a conflict cannot
// change the tree-hash evidence it invalidates.
test("冻结文件被外部修改：报告冲突、保存差异、不还原、证据失效", async () => {
  const root = await gitRepo();
  const blobs = await frozen(root);
  await seedVerified(root);
  await writeFile(path.join(root, "tests", "a.py"), "tampered\n");
  const treeDuring = await treeHash(root);
  const statusDuring = await git(root, ["status", "--porcelain", "--", ".", ":(exclude).cw"]);

  const outcome = await checkFrozen(root, taskId, "s", blobs);
  expect(outcome.git).toBe(true);
  expect(outcome.conflicts).toHaveLength(1);
  const conflict = outcome.conflicts[0]!;
  const actualBlob = (await blobHash(root, "tests/a.py")).value!;
  expect(conflict).toEqual({
    path: "tests/a.py", expected: blobs["tests/a.py"], actual: actualBlob, found_at: conflict.found_at,
  });
  expect(Number.isNaN(Date.parse(conflict.found_at))).toBe(false);

  // 不修改工作树：内容保持被外部修改后的样子。
  expect(await readFile(path.join(root, "tests", "a.py"), "utf8")).toBe("tampered\n");

  const state = await readState(root, taskId);
  expect(state.last_verified).toBeNull();
  expect(state.evidence_invalid_reason).toContain("tests/a.py");
  expect(state.conflicts).toEqual([conflict]);

  // 冲突文件写入自身不改变工作树证据计算（差异落在被排除的 .cw 下）。
  expect((await treeHash(root)).value).toBe(treeDuring.value);
  expect(await git(root, ["status", "--porcelain", "--", ".", ":(exclude).cw"])).toBe(statusDuring);

  expect(outcome.diffs).toEqual([`.cw/tasks/${taskId}/conflicts/1.diff`]);
  const diffText = await readFile(
    path.join(root, ".cw", "tasks", taskId, "conflicts", "1.diff"), "utf8",
  );
  expect(diffText).toContain(`path: tests/a.py`);
  expect(diffText).toContain(`expected: ${blobs["tests/a.py"]}`);
  expect(diffText).toContain(`actual: ${actualBlob}`);
  expect(diffText).toContain("+tampered");
  expect(diffText).toContain("-check");

  const entries = await readdir(path.join(root, ".cw", "tasks", taskId));
  expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

// 边界：中途一次无冲突的检查不重置编号——下一个序号取现存最大 .diff + 1，历史差异永不被覆盖。
// Boundary: a clean check in between does not reset numbering — the next index
// is max(existing `.diff`) + 1, so earlier diffs are never overwritten.
test("冲突编号递增且不覆盖前次差异", async () => {
  const root = await gitRepo();
  const blobs = await frozen(root);
  const file = path.join(root, "tests", "a.py");

  await writeFile(file, "tampered\n");
  expect((await checkFrozen(root, taskId, "s", blobs)).diffs)
    .toEqual([`.cw/tasks/${taskId}/conflicts/1.diff`]);

  await writeFile(file, "check\n");
  const restored = await checkFrozen(root, taskId, "s", blobs);
  expect(restored.conflicts).toEqual([]);
  expect(restored.diffs).toEqual([]);

  await writeFile(file, "again\n");
  const second = await checkFrozen(root, taskId, "s", blobs);
  expect(second.conflicts).toHaveLength(1);
  expect(second.diffs).toEqual([`.cw/tasks/${taskId}/conflicts/2.diff`]);

  const first = await readFile(path.join(root, ".cw", "tasks", taskId, "conflicts", "1.diff"), "utf8");
  expect(first).toContain("+tampered");
  expect(first).not.toContain("+again");
  const latest = await readFile(path.join(root, ".cw", "tasks", taskId, "conflicts", "2.diff"), "utf8");
  expect(latest).toContain("+again");

  const state = await readState(root, taskId);
  expect(state.conflicts).toHaveLength(2);
});

test("新增测试文件与 notes.md 不冲突，状态不动", async () => {
  const root = await gitRepo();
  const blobs = await frozen(root);
  await writeFile(path.join(root, "tests", "b.py"), "new\n");
  await writeFile(path.join(root, ".cw", "tasks", taskId, "notes.md"), "# notes\n");
  // 先写文件后取树：新测试文件本身是树变化，由 recheckTree 负责（见下组测试）。
  await seedVerified(root);
  const before = await readState(root, taskId);

  const outcome = await checkFrozen(root, taskId, "s", blobs);
  expect(outcome).toEqual({ git: true, conflicts: [], newConflicts: [], diffs: [] });
  expect(await readState(root, taskId)).toEqual(before);

  // notes.md 不在树哈希内：改动不触发证据失效。
  await writeFile(path.join(root, ".cw", "tasks", taskId, "notes.md"), "# more\n");
  expect(await recheckTree(root, taskId, "s")).toBeNull();
  expect((await readState(root, taskId)).last_verified).not.toBeNull();
});

// 只豁免任务目录顶层的 notes.md：嵌套 notes.md、其它任务目录、不在 frozen/interface 里的路径都不受保护。
// Only the task's top-level notes.md is exempt — nested notes.md, other tasks'
// directories and paths outside frozen/interface are not protected.
test("受保护集合：frozen+interface+project.toml+任务目录除 notes.md", () => {
  const contract = { frozen: ["tests/a.py"], interface: ["src/api.ts"] };
  expect(isProtectedPath("tests/a.py", contract, taskId)).toBe(true);
  expect(isProtectedPath("src/api.ts", contract, taskId)).toBe(true);
  expect(isProtectedPath(".cw/project.toml", contract, taskId)).toBe(true);
  expect(isProtectedPath(`.cw/tasks/${taskId}/state.json`, contract, taskId)).toBe(true);
  expect(isProtectedPath(`.cw/tasks/${taskId}/contract.toml`, contract, taskId)).toBe(true);
  expect(isProtectedPath(`.cw/tasks/${taskId}/runs/1/result.json`, contract, taskId)).toBe(true);
  expect(isProtectedPath(`.cw/tasks/${taskId}/notes.md`, contract, taskId)).toBe(false);
  expect(isProtectedPath(`.cw/tasks/${taskId}/sub/notes.md`, contract, taskId)).toBe(true);
  expect(isProtectedPath(".cw/tasks/20260928-other-task/state.json", contract, taskId)).toBe(false);
  expect(isProtectedPath("tests/b.py", contract, taskId)).toBe(false);
  expect(isProtectedPath("src/other.ts", contract, taskId)).toBe(false);
});

// 树哈希或契约哈希不一致都把 last_verified 置空并写下原因；契约按 contractSha256 比对，与树无关。
// A tree-hash or contract-hash mismatch clears `last_verified` and records the reason; contracts are
// compared by `contractSha256`, independently of the tree.
test("recheckTree 与 recheckContract 使已验证证据失效", async () => {
  const root = await gitRepo();
  await seedVerified(root, "b".repeat(64));
  await writeFile(path.join(root, "tracked.txt"), "changed\n");
  expect(await recheckTree(root, taskId, "s")).toBe("worktree tree changed since verification");
  let state = await readState(root, taskId);
  expect(state.last_verified).toBeNull();
  expect(state.evidence_invalid_reason).toBe("worktree tree changed since verification");
  // 已失效后再查不再动作。
  expect(await recheckTree(root, taskId, "s")).toBeNull();

  const base = contractOf(["keep"]);
  const altered = contractOf(["other"]);
  await seedVerified(root, contractSha256(base));
  expect(await recheckContract(root, taskId, "s", base)).toBeNull();
  expect((await readState(root, taskId)).last_verified).not.toBeNull();
  expect(await recheckContract(root, taskId, "s", altered)).toBe("contract changed since verification");
  state = await readState(root, taskId);
  expect(state.last_verified).toBeNull();
  expect(state.evidence_invalid_reason).toBe("contract changed since verification");
});

// 安全边界：越界 symlink 只报路径守卫的结论（actual=null），差异文件不包含仓库外的文件内容。
// Security boundary: an escaping symlink is reported as a path-guard failure
// (`actual` null) and the diff never echoes content from outside the repository.
test("symlink 保护：逃逸、悬空、仓内别名", async () => {
  const root = await gitRepo();
  const blobs = await frozen(root);
  const link = path.join(root, "tests", "a.py");

  const outside = await mkdtemp(path.join(tmpdir(), "cw-m3-out-"));
  await writeFile(path.join(outside, "secret.txt"), "outside\n");
  await rm(link);
  await symlink(path.join(outside, "secret.txt"), link);
  const escape = await checkFrozen(root, taskId, "s", blobs);
  expect(escape.conflicts).toHaveLength(1);
  expect(escape.conflicts[0]!.path).toBe("tests/a.py");
  expect(escape.conflicts[0]!.actual).toBeNull();
  const escapeDiff = await readFile(
    path.join(root, ".cw", "tasks", taskId, "conflicts", "1.diff"), "utf8",
  );
  expect(escapeDiff).toContain("symlink escapes repository");
  expect(escapeDiff).not.toContain("outside");
  expect((await readState(root, taskId)).last_verified).toBeNull();

  await rm(link);
  await symlink("nowhere", link);
  const dangling = await checkFrozen(root, taskId, "s", blobs);
  expect(dangling.conflicts[0]!.actual).toBeNull();
  // M5 去重：与逃逸冲突相同的 path+expected+actual 不再重复记录。
  expect(dangling.diffs).toEqual([]);
  expect(dangling.newConflicts).toEqual([]);

  await rm(link);
  await writeFile(path.join(root, "tests", "other.py"), "other\n");
  await symlink("other.py", link);
  const alias = await checkFrozen(root, taskId, "s", blobs);
  expect(alias.conflicts[0]!.actual).toBe((await blobHash(root, "tests/other.py")).value);
  // 新 actual 是新冲突，编号延续且不覆盖前次差异。
  expect(alias.diffs).toEqual([`.cw/tasks/${taskId}/conflicts/2.diff`]);
  const danglingReadback = await readFile(
    path.join(root, ".cw", "tasks", taskId, "conflicts", "1.diff"), "utf8",
  );
  expect(danglingReadback).toContain("symlink escapes repository");
});

// 降级契约：非 git 工作树算不出 blob 哈希，于是不报冲突、不绑定证据、不改状态，recheckTree 也放行。
// Degrade rule: a non-git worktree has no blob hashes, so nothing is reported,
// no evidence is bound, no state changes, and `recheckTree` passes.
test("非 Git 仓库：不校验、不绑定、不改状态", async () => {
  const plain = await mkdtemp(path.join(tmpdir(), "cw-m3-plain-"));
  await mkdir(path.join(plain, "tests"), { recursive: true });
  await writeFile(path.join(plain, "tests", "a.py"), "check\n");
  await createTask(plain, taskId, "gateway/medium");
  await updateState(plain, taskId, "s", (state) => ({
    ...state,
    last_verified: { run: 1, tree: "f".repeat(40), contract_sha256: "a".repeat(64) },
  }));
  const before = await readState(plain, taskId);

  const outcome = await checkFrozen(plain, taskId, "s", { "tests/a.py": "0".repeat(40) });
  expect(outcome).toEqual({ git: false, conflicts: [], newConflicts: [], diffs: [] });
  expect(await readState(plain, taskId)).toEqual(before);
  expect(await recheckTree(plain, taskId, "s")).toBeNull();
  expect(await readState(plain, taskId)).toEqual(before);
});

// 锁契约：状态写入必须持任务锁——抢锁失败抛 TaskLockError 且状态保持原样，释放后同一次检查才生效。
// Lock contract: state writes require the task lock; a losing session throws
// `TaskLockError` and leaves state untouched, and the same check succeeds once
// the lock is released.
test("冻结检查的状态写入需要任务锁", async () => {
  const root = await gitRepo();
  const blobs = await frozen(root);
  await writeFile(path.join(root, "tests", "a.py"), "tampered\n");
  const release = await acquireLock(root, taskId, "s");
  await expect(checkFrozen(root, taskId, "t", blobs)).rejects.toBeInstanceOf(TaskLockError);
  expect((await readState(root, taskId)).conflicts).toEqual([]);
  await release();
  const outcome = await checkFrozen(root, taskId, "t", blobs);
  expect(outcome.conflicts).toHaveLength(1);
});

// M3 性能预算：冻结总量不超过 10MB 时，单次检查必须低于 200ms（此处是单个 10MiB 文件）。
// M3 budget: one check must stay under 200 ms for up to 10 MB of frozen content.
test("10MB 冻结文件单次检查低于 200ms", async () => {
  const root = await gitRepo();
  await writeFile(path.join(root, "big.bin"), Buffer.alloc(10 * 1024 * 1024, 0x61));
  await git(root, ["add", "big.bin"]);
  await git(root, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "big"]);
  const blob = (await blobHash(root, "big.bin")).value!;
  const start = performance.now();
  const outcome = await checkFrozen(root, taskId, "s", { "big.bin": blob });
  const elapsed = performance.now() - start;
  expect(outcome.conflicts).toEqual([]);
  expect(elapsed).toBeLessThan(200);
});

// 同一 200ms 预算下的规模边界：5000 个冻结路径（约 5MiB）在无冲突与 3 处冲突（含写 3 个 diff）时都要达标。
// Scale boundary for the same budget: 5000 frozen paths (~5 MiB) must stay
// under 200 ms both clean and with three conflicts, diff writing included.
test("5000 个 1KiB 冻结文件：无冲突与少量冲突均低于 200ms", async () => {
  const root = await gitRepo();
  await mkdir(path.join(root, "tests", "gen"), { recursive: true });
  const rels: string[] = [];
  for (let i = 0; i < 5000; i++) {
    const rel = `tests/gen/f${String(i).padStart(4, "0")}.bin`;
    await writeFile(path.join(root, rel), `${"x".repeat(1024)}\n`);
    rels.push(rel);
  }
  await git(root, ["add", "tests"]);
  await git(root, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "bulk"]);
  const frozen: Record<string, string> = {};
  for (let start = 0; start < rels.length; start += 500) {
    const slice = rels.slice(start, start + 500);
    const hashes = await blobHashes(root, slice);
    slice.forEach((rel, index) => { frozen[rel] = hashes[index]!; });
  }

  const cleanStart = performance.now();
  const clean = await checkFrozen(root, taskId, "s", frozen);
  const cleanMs = performance.now() - cleanStart;
  expect(clean.conflicts).toEqual([]);
  expect(clean.diffs).toEqual([]);
  expect(cleanMs).toBeLessThan(200);

  for (const i of [7, 1234, 4999]) {
    await writeFile(path.join(root, `tests/gen/f${String(i).padStart(4, "0")}.bin`), "tampered\n");
  }
  const conflictStart = performance.now();
  const conflicted = await checkFrozen(root, taskId, "s", frozen);
  const conflictMs = performance.now() - conflictStart;
  expect(conflicted.conflicts).toHaveLength(3);
  expect(conflicted.diffs).toEqual([
    `.cw/tasks/${taskId}/conflicts/1.diff`,
    `.cw/tasks/${taskId}/conflicts/2.diff`,
    `.cw/tasks/${taskId}/conflicts/3.diff`,
  ]);
  expect(conflictMs).toBeLessThan(200);
}, 60_000);
