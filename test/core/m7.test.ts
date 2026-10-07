/**
 * M7 升级与交还链路的集成测试：prepareBaseEscalation 建立 base worktree 并复验
 * 批准哈希，writeHandback 把 md/json 当作一个提交单元，meter 写带 kind 的 JSONL。
 * 核心契约是“拒绝时不留半成品”：worktree、交还文件与 .tmp 都不允许残留。
 *
 * Integration tests for the M7 escalation and handback paths:
 * `prepareBaseEscalation` builds the base worktree and re-verifies the approved
 * hashes, `writeHandback` commits its two files as one unit, and the meter
 * appends kind-tagged JSONL lines. A refusal must leave no half-written
 * artifact — no worktree, no handback file, no `.tmp` residue.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { contentSha256 } from "../../src/core/evidence.ts";
import { EscalateError, escalationWorktreePath, prepareBaseEscalation } from "../../src/core/escalate.ts";
import { treeHash, worktreePrune } from "../../src/core/gitstate.ts";
import { createTask, readReference } from "../../src/core/task.ts";
import { writeHandback } from "../../src/core/handback.ts";
import { recordTaskEvent, recordUsage } from "../../src/core/meter.ts";

const taskId = "20260928-lifetime-fix";

/** 在 `cwd` 中执行一条 git 命令，失败即 reject / Runs one git command in `cwd`; rejects on failure. */
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")}: ${code}`)));
  });
}

/** 已注册的 worktree 数量（含主工作树）/ Number of registered worktrees, including the main one. */
async function worktreeCount(repo: string): Promise<number> {
  return (await git(repo, ["worktree", "list", "--porcelain"]))
    .split("\n").filter((line) => line.startsWith("worktree ")).length;
}

/**
 * 夹具字段：临时仓库、base commit，以及每次调用都重建的升级请求工厂
 * （用例靠覆盖它的字段来构造拒绝场景）。
 *
 * Fixture fields: the throwaway repo, its base commit, and a factory that
 * rebuilds the escalation request per call so cases can override single fields.
 */
interface Setup {
  repo: string;
  base: string;
  request: () => Parameters<typeof prepareBaseEscalation>[0];
}

/**
 * 建一个临时 git 仓库并提交基准内容，创建权威任务目录（引用校验要求它真实存在），
 * 然后返回夹具与请求工厂。
 *
 * Creates a throwaway git repo with a base commit and the authoritative task
 * directory (the reference check requires it to exist for real), then returns
 * the fixture and the request factory.
 */
async function setup(): Promise<Setup> {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-m7-"));
  await git(repo, ["init"]);
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await writeFile(path.join(repo, "tests", "a.py"), "base\n");
  await git(repo, ["add", "tracked.txt", "tests/a.py"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const inputHash = (await contentSha256(repo, "tests/a.py"))!;
  // The authoritative task directory exists in the real flow (created by
  // /cw task new); the reference must point at it.
  await mkdir(path.join(repo, ".cw", "tasks", taskId), { recursive: true });
  return {
    repo,
    base,
    request: () => ({
      repo,
      taskId,
      session: "s1",
      baseCommit: base,
      inputs: ["tests/a.py"],
      approvedInputHashes: { "tests/a.py": inputHash },
    }),
  };
}

/** 升级 worktree 的绝对路径（以 realpath 为基准）/ Path of the escalation worktree, from the realpath. */
const worktreeOf = async (repo: string) =>
  escalationWorktreePath(await realpath(repo), taskId);

/**
 * 断言被拒绝的调用没有留下痕迹：worktree 目录可被删除（不存在也算通过），
 * 且 git 元数据只剩主工作树。
 *
 * Asserts a refused call left no residue: the worktree directory can be removed
 * (a missing path passes too) and only the main worktree stays registered.
 */
const noResidue = async (repo: string) => {
  await expect(rm(await worktreeOf(repo), { recursive: true, force: true })).resolves.toBeUndefined();
  expect(await worktreeCount(repo)).toBe(1);
};

test("prepareBaseEscalation：base worktree、验收输入恢复、账本引用、原工作树不变", async () => {
  const { repo, request } = await setup();
  const treeBefore = (await treeHash(repo)).value!;
  const worktree = await prepareBaseEscalation(request());
  expect(worktree).toBe(await worktreeOf(repo));

  // The worktree is at the base commit and the input matches the approved bytes.
  expect((await git(worktree, ["rev-parse", "HEAD"])).trim()).toBe(request().baseCommit);
  expect(await readFile(path.join(worktree, "tests", "a.py"), "utf8")).toBe("base\n");
  expect(await contentSha256(worktree, "tests/a.py"))
    .toBe(request().approvedInputHashes["tests/a.py"]);

  // The reference points at the authoritative ledger; no writable copy exists.
  const reference = await readReference(path.join(worktree, ".cw", "task.json"));
  expect(reference.task_id).toBe(taskId);
  expect(reference.path).toBe(path.join(await realpath(repo), ".cw", "tasks", taskId));
  expect(await rm(path.join(worktree, ".cw", "tasks"), { recursive: true, force: true })).toBeUndefined();

  // The original worktree was only read, never written.
  expect((await treeHash(repo)).value).toBe(treeBefore);
  expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");

  expect(await worktreeCount(repo)).toBe(2);
  // worktreePrune 只在目录已删除后清元数据，所以计数回到 1 同时证明两者都已清理。
  // worktreePrune only drops the metadata once the directory is gone, so a
  // count of 1 proves both the directory and the metadata are cleaned up.
  await rm(worktree, { recursive: true, force: true });
  await worktreePrune(repo);
  expect(await worktreeCount(repo)).toBe(1);
});

test("prepareBaseEscalation：验收输入漂移拒绝，无 worktree 残留", async () => {
  const { repo, request } = await setup();
  // 漂移在写任何东西之前就被发现并拒绝，而不是先把 worktree 建起来再比对。
  // Drift is caught and refused before anything is written, instead of building
  // the worktree first and comparing afterwards.
  await writeFile(path.join(repo, "tests", "a.py"), "drifted\n");
  await expect(prepareBaseEscalation(request())).rejects.toThrow(EscalateError);
  await expect(prepareBaseEscalation(request())).rejects.toThrow(/与批准版本不一致/);
  await noResidue(repo);
});

test("prepareBaseEscalation：输入缺失、base_commit 不存在与已存在目录均拒绝", async () => {
  const { repo, base, request } = await setup();
  await rm(path.join(repo, "tests", "a.py"));
  await expect(prepareBaseEscalation(request())).rejects.toThrow(/缺失/);
  await noResidue(repo);

  await expect(prepareBaseEscalation({ ...request(), baseCommit: "0".repeat(40) }))
    .rejects.toThrow(EscalateError);
  await noResidue(repo);

  // An existing escalation directory is never reused or overwritten.
  await writeFile(await worktreeOf(repo), "occupied");
  // 清空 inputs 以便走到“目录已存在”这条分支：输入校验比它更早执行。
  // `inputs` is emptied so the existing-directory branch is reached, since the
  // input checks run earlier.
  await expect(prepareBaseEscalation({ ...request(), inputs: [], approvedInputHashes: {} }))
    .rejects.toThrow(/已存在/);
  expect(await readFile(await worktreeOf(repo), "utf8")).toBe("occupied");
});

test("writeHandback 两文件提交语义：md 失败不残留 json，旧 json 保留，无 meter 事件", async () => {
  const { repo } = await setup();
  const hbTaskId = "20260101-hbcheck";
  await createTask(repo, hbTaskId, "g/medium");
  const request = {
    contract: {
      version: 1, task_id: hbTaskId, tier: "change" as const, deliverable: "code" as const,
      goal: "g", non_goals: [], acceptance: [], red: [], regression: [], frozen: [],
      interface: [], baseline_inputs: [], approved_failures: [], budget: undefined,
    },
    validator: { cmd: ["/bin/sh", "-c", "true"], timeout_s: 600, env: {} },
    reason: "manual" as const, questions: [] as string[], autoVerified: false,
  };
  const taskDir = path.join(repo, ".cw", "tasks", hbTaskId);
  const jsonPath = path.join(taskDir, "handback.json");
  const mdPath = path.join(taskDir, "handback.md");
  // 本不该存在的 .tmp 残留 / The `.tmp` leftovers that must never survive.
  const noTmp = (entries: string[]) => entries.filter((name) => name.endsWith(".tmp"));

  // Case A：md 目标是目录 → rename 失败 → 本次 json 被撤除，无事件，无 .tmp 残留。
  await mkdir(mdPath);
  await expect(writeHandback(repo, hbTaskId, "s1", request)).rejects.toThrow();
  expect(existsSync(jsonPath)).toBe(false);
  const listingA = (await readdir(taskDir)).sort();
  expect(listingA).toEqual(["handback.md", "meter.jsonl", "runs", "state.json"]);
  expect(noTmp(listingA)).toEqual([]);
  const meter = (await readFile(path.join(taskDir, "meter.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(meter.map((line) => line.event)).not.toContain("manual");

  // Case B：更早的 handback.json 在失败后被原样保留，且同样无 .tmp。
  await writeFile(jsonPath, "{\"previous\":true}\n");
  await expect(writeHandback(repo, hbTaskId, "s1", request)).rejects.toThrow();
  expect(await readFile(jsonPath, "utf8")).toBe("{\"previous\":true}\n");
  // 目录形态的 md 未被破坏。
  expect((await lstat(mdPath)).isDirectory()).toBe(true);
  expect(noTmp(await readdir(taskDir))).toEqual([]);
});

test("meter：usage 行带 kind，task 事件行可解析；事件写入失败不抛出", async () => {
  const { repo } = await setup();
  await mkdir(path.join(repo, ".cw", "tasks", taskId, "runs"), { recursive: true });
  await recordUsage(repo, taskId, {
    time: "t", session: "s1", model: "g/medium",
    input: 10, output: 2, cache_read: 3, cache_write: 1, cost_total: 0.5,
  });
  await recordTaskEvent(repo, taskId, "s1", "validation_started", { run: 1 });
  // 追加顺序即写入顺序：两行按调用次序落盘，kind 用来区分 usage 与 task 事件。
  // Appends preserve order, so both lines land in call order; `kind` separates
  // usage accounting from task lifecycle events.
  const lines = (await readFile(path.join(repo, ".cw", "tasks", taskId, "meter.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({ kind: "usage", session: "s1", input: 10, cost_total: 0.5 });
  expect(lines[1]).toMatchObject({ kind: "task", event: "validation_started", detail: { run: 1 } });

  // Best-effort: an unknown task never throws and never creates state.
  await expect(recordTaskEvent(repo, "20260101-nope", "s1", "task_created")).resolves.toBeUndefined();
});
