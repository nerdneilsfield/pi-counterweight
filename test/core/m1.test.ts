/**
 * M1 核心测试：project.toml 与契约解析（含路径校验）、git 工作树/对象哈希、任务锁与 run 编号分配。
 *
 * M1 core tests: `project.toml` and contract parsing with path validation, git
 * tree and blob hashing, the per-task lock (concurrency and stale-lock
 * reclamation) and run-number allocation. Every case builds its own throwaway
 * git repository, so nothing outside the OS temp directory is read or written.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { readProjectConfig } from "../../src/core/config.ts";;
import { contractSha256, readContract } from "../../src/core/contract.ts";
import { blobHash, headCommit, isClean, treeHash } from "../../src/core/gitstate.ts";
import { allocateRun, createTask, readReference, readState, saveReference, TaskLockError, updateState, withTaskLock } from "../../src/core/task.ts";

// 最小合规 project.toml：只显式写 validator 与 models/tiers，其余字段用来验证默认值补齐。
// Minimal valid project.toml: only `validator` and `models`/`tiers` are spelled out; the other
// fields exercise default filling.
const project = `version = 1
[validator]
cmd = ["./.cw/validate.sh"]
[models]
cheap = "gateway/cheap"
medium = "gateway/medium"
strong = "gateway/strong"
explorer = "gateway/cheap"
[tiers]
script = "cheap"
change = "medium"
interface = "strong"
`;

/**
 * 拼出一份合法契约 TOML，`fields.body` 换掉 acceptance/red 两行，`fields.rest` 追加其余字段。
 *
 * Builds contract TOML text with valid defaults; `fields.body` replaces the
 * `acceptance`/`red` lines and `fields.rest` appends further keys, so each case
 * can vary exactly one rule.
 */
function contract(fields: Record<string, string>): string {
  return `version = 1
task_id = "20260928-lifetime-fix"
tier = "change"
deliverable = "code"
goal = "fix lifetime"
${fields.body ?? `acceptance = ["tests/a.py::keep"]
red = ["tests/a.py::keep"]`}
${fields.rest ?? ""}`;
}

/**
 * 造一个临时 git 仓库并把 `tracked.txt` 提交为 base，供 tree 哈希、干净判定与锁的用例当起点。
 *
 * Creates a temporary git repository with `tracked.txt` committed as `base`,
 * giving the tree-hash, cleanliness and lock cases a starting point. The commit
 * carries an inline identity, so it does not depend on the machine's git config.
 */
async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cw-m1-"));
  await git(root, ["init"]);
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  return root;
}

// 契约：缺失字段补默认值，显式写的 0 仍要生效；未知嵌套字段（env 非字符串、budget/models 多余键）一律拒绝。
// Contract: missing fields fall back to defaults while an explicit 0 still wins; unknown nested
// fields — non-string `env` values, extra `budget`/`models` keys — are rejected.
test("project.toml 缺省字段补齐，嵌套未知字段拒绝", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cw-m1-cfg-"));
  const file = path.join(root, "project.toml");
  await writeFile(file, project);
  const config = await readProjectConfig(file);
  expect(config.validator.timeout_s).toBe(600);
  expect(config.validator.env).toEqual({});
  expect(config.budget.repairs).toBe(3);
  expect(config.budget.tokens).toBe(2_000_000);
  await writeFile(file, `${project}\n[validator.env]\nCI = "1"\n[budget]\nrepairs = 0\n`);
  expect((await readProjectConfig(file)).validator.env).toEqual({ CI: "1" });
  expect((await readProjectConfig(file)).budget.repairs).toBe(0);
  await writeFile(file, `${project}\n[validator.env]\nN = 1\n`);
  await expect(readProjectConfig(file)).rejects.toThrow(/string/);
  await writeFile(file, `${project}\n[budget]\nrepairs = 1\nextra = true\n`);
  await expect(readProjectConfig(file)).rejects.toThrow(/additional properties/);
  await writeFile(file, project.replace("[models]", "[models]\nspare = \"gateway/x\"\n"));
  await expect(readProjectConfig(file)).rejects.toThrow(/additional properties/);
});

// 契约：每条规则单独触发一次失败——重复条目、red 非 acceptance 子集、approved_failures 与 red 重叠、
// 空验收、`.`/`..` 路径逃逸、`.cw` 禁区、绝对路径；末尾用一份合法契约确认通过路径能走通。
// Contract: each rule fails on its own — duplicate entries, `red` not a subset of `acceptance`,
// `approved_failures` overlapping `red`, empty acceptance, `.`/`..` escapes, the `.cw` reserve,
// absolute paths — then one valid contract proves the happy path still works.
test("契约规则各自失败并通过", async () => {
  const root = await repo();
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "tests", "a.py"), "pass\n");
  const file = path.join(root, "contract.toml");
  const cases: Array<[string, RegExp]> = [
    [contract({ body: `acceptance = ["tests/a.py::keep", "tests/a.py::keep"]\nred = ["tests/a.py::keep"]` }), /duplicate acceptance/],
    [contract({ body: `acceptance = ["tests/a.py::keep"]\nred = ["tests/a.py::keep", "tests/a.py::keep"]` }), /duplicate red/],
    [contract({ body: `acceptance = ["tests/a.py::keep"]\nred = ["tests/a.py::other"]` }), /not a subset/],
    [contract({ body: `acceptance = ["tests/a.py::keep"]\nred = ["tests/a.py::keep"]\n[[approved_failures]]\nid = "tests/a.py::keep"\nreason = "known"` }), /overlaps/],
    [contract({ body: `acceptance = []\nred = []` }), /non-empty acceptance and red/],
    [contract({ rest: `frozen = ["../outside.py"]` }), /refuses \. or \.\./],
    [contract({ rest: `frozen = [".cw/state.json"]` }), /\.cw is not allowed/],
    [contract({ rest: `interface = ["/tmp/abs.py"]` }), /repo-relative/],
  ];
  for (const [text, pattern] of cases) {
    await writeFile(file, text);
    await expect(readContract(file, root)).rejects.toThrow(pattern);
  }
  await writeFile(file, contract({ rest: `frozen = ["tests/a.py"]\ninterface = ["tests/a.py"]\nbaseline_inputs = [".cw/validate.sh"]` }));
  await mkdir(path.join(root, ".cw"));
  await writeFile(path.join(root, ".cw", "validate.sh"), "#!/bin/sh\n");
  const ok = await readContract(file, root);
  expect(ok.red).toEqual(["tests/a.py::keep"]);
  // frozen 路径经符号链接指向仓库外、或链接目标不存在，都必须拒绝。
  // A `frozen` path symlinking out of the repo, or pointing at a missing target, must be rejected.
  const outside = await mkdtemp(path.join(tmpdir(), "cw-m1-out-"));
  await writeFile(path.join(outside, "x"), "x\n");
  await symlink(path.join(outside, "x"), path.join(root, "tests", "escape"));
  await writeFile(file, contract({ rest: `frozen = ["tests/escape"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/symlink escapes/);
  await symlink(path.join(outside, "missing"), path.join(root, "tests", "dangling"));
  await writeFile(file, contract({ rest: `frozen = ["tests/dangling"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/symlink target missing/);
  // baseline_inputs 指向本任务的 state.json 必须拒绝；指向校验脚本与源码路径则通过。
  // `baseline_inputs` naming this task's own `state.json` is rejected; existing script and source
  // paths are accepted.
  await mkdir(path.join(root, ".cw", "tasks", "20260928-lifetime-fix"), { recursive: true });
  await writeFile(file, contract({ rest: `baseline_inputs = [".cw/tasks/20260928-lifetime-fix/state.json"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/task state/);
  await writeFile(file, contract({ rest: `baseline_inputs = [".cw/validate.sh", "tests/a.py"]` }));
  expect((await readContract(file, root)).baseline_inputs).toEqual([".cw/validate.sh", "tests/a.py"]);
});

// 契约：deliverable 不是 code 时允许空 acceptance/red；contractSha256 基于规范化内容，字段顺序不同但语义一致的两份契约哈希相同。
// Contract: a non-code deliverable may leave `acceptance`/`red` empty; `contractSha256` hashes
// normalized content, so the same contract written in a different key order hashes identically.
test("非代码交付物允许空验收，字段顺序不影响哈希", async () => {
  const root = await repo();
  const first = path.join(root, "a.toml");
  const second = path.join(root, "b.toml");
  const body = `version = 1
task_id = "20260928-lifetime-fix"
tier = "script"
deliverable = "diagnosis"
goal = "explain"
acceptance = []
red = []
`;
  await writeFile(first, body);
  await writeFile(second, `goal = "explain"
red = []
acceptance = []
deliverable = "diagnosis"
tier = "script"
task_id = "20260928-lifetime-fix"
version = 1
`);
  const left = await readContract(first, root);
  const right = await readContract(second, root);
  expect(contractSha256(left)).toBe(contractSha256(right));
  expect(left.deliverable).toBe("diagnosis");
});

// 契约：treeHash 看得见已跟踪文件的修改与新增未跟踪文件，忽略 .gitignore 命中项和 .cw/，同一工作区重复计算稳定，
// 且始终用临时 index，不污染仓库真实 index。
// Contract: `treeHash` sees modified tracked files and new untracked ones, ignores `.gitignore`
// hits and `.cw/`, is stable across repeated calls on an unchanged worktree, and always uses a
// temporary index — the repository's real index stays untouched.
test("未跟踪与忽略文件对 tree 的影响，且真实 index 不变", async () => {
  const root = await repo();
  const beforeStatus = await git(root, ["status", "--porcelain"]);
  const beforeCached = await git(root, ["diff", "--cached"]);
  expect(beforeStatus).toBe("");
  const base = await treeHash(root);
  expect(base.supported).toBe(true);
  await writeFile(path.join(root, "tracked.txt"), "changed\n");
  await writeFile(path.join(root, "new.txt"), "new\n");
  const changed = await treeHash(root);
  expect(changed.value).not.toBe(base.value);
  const withGitignore = await treeHash(root);
  expect(withGitignore.value).toBe(changed.value);
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  const gitignoreOnly = await treeHash(root);
  expect(gitignoreOnly.value).not.toBe(withGitignore.value);
  await writeFile(path.join(root, "ignored.txt"), "nope\n");
  await mkdir(path.join(root, ".cw"));
  await writeFile(path.join(root, ".cw", "state"), "nope\n");
  const ignored = await treeHash(root);
  expect(ignored.value).toBe(gitignoreOnly.value);
  await writeFile(path.join(root, "ignored.txt"), "changed-ignored\n");
  await writeFile(path.join(root, ".cw", "state"), "changed-cw\n");
  expect((await treeHash(root)).value).toBe(gitignoreOnly.value);
  await writeFile(path.join(root, "new.txt"), "newer\n");
  expect((await treeHash(root)).value).not.toBe(ignored.value);
  const status = await git(root, ["status", "--porcelain"]);
  expect(status).not.toBe(beforeStatus);
  expect(status).toContain(" M tracked.txt");
  expect(status).toContain("?? new.txt");
  expect(status).not.toContain("ignored.txt");
  expect(status).toContain("?? .cw/");
  expect(await git(root, ["diff", "--cached"])).toBe(beforeCached);
  const blob = await blobHash(root, "tracked.txt");
  expect(blob.value).toMatch(/^[0-9a-f]{40}$/);
  expect((await blobHash(root, "missing.txt")).value).toBeNull();
});

// 边界：无提交的空仓库仍算得出 tree，headCommit 为 null 且视为干净；非 git 目录下三个函数都返回
// `{ supported: false }` 而不抛错，调用方必须把它当“无法判断”，而不是“干净”。
// Boundary: an empty repository still yields a tree hash, with a null head commit and a clean
// worktree; outside git, all three helpers return `{ supported: false }` instead of throwing, and
// callers must read that as "unknown" rather than "clean".
test("空仓库与非 Git 仓库", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "cw-m1-empty-"));
  await git(empty, ["init"]);
  expect((await headCommit(empty)).value).toBeNull();
  expect((await isClean(empty)).value).toBe(true);
  await writeFile(path.join(empty, "only.txt"), "x\n");
  const tree = await treeHash(empty);
  expect(tree.value).toMatch(/^[0-9a-f]{40}$/);
  const plain = await mkdtemp(path.join(tmpdir(), "cw-m1-plain-"));
  expect(await isClean(plain)).toEqual({ supported: false });
  expect(await treeHash(plain)).toEqual({ supported: false });
  expect(await blobHash(plain, "x")).toEqual({ supported: false });
});

// 契约：锁按任务互斥——另一个会话在锁被持有时 updateState / allocateRun 抛 TaskLockError，状态与计数保持原样；
// 持有者已死则回收其锁；run 编号从 1 起按任务单调递增；createTask 拒绝已存在的任务。
// Contract: the lock is per-task and exclusive — while it is held, another session's `updateState`
// and `allocateRun` raise `TaskLockError` and leave the counters untouched; a dead holder's lock is
// reclaimed; run numbers start at 1 and grow monotonically per task; `createTask` refuses an
// existing task.
test("并发接管只有一方持锁，计数不回滚", async () => {
  const root = await repo();
  const dir = await createTask(root, "20260928-lifetime-fix", "gateway/medium");
  const reference = await saveReference(root, path.join(root, "ref.json"), "20260928-lifetime-fix");
  expect(reference.path).toBe(dir);
  expect((await readReference(path.join(root, "ref.json"))).path).toBe(dir);
  let releaseOuter: (() => void) | undefined;
  let finished!: Promise<unknown>;
  const held = new Promise<void>((done) => {
    finished = withTaskLock(root, "20260928-lifetime-fix", "session-a", () => new Promise<void>((unlock) => {
      releaseOuter = unlock;
      done();
    }));
  });
  await held;
  await expect(updateState(root, "20260928-lifetime-fix", "session-b", (state) => ({ ...state, repairs_used: 9 })))
    .rejects.toBeInstanceOf(TaskLockError);
  expect((await readState(root, "20260928-lifetime-fix")).repairs_used).toBe(0);
  releaseOuter?.();
  await finished;
  await createTask(root, "20260928-other-fix", "gateway/medium");
  // 陈旧锁（持有进程已死，ESRCH）可安全回收：获取成功并重写锁内容。
  // Stale lock (holder dead, ESRCH): reclaimed safely, acquisition succeeds and rewrites the file.
  const crashed = path.join(root, ".cw", "tasks", "20260928-other-fix", "lock");
  await writeFile(crashed, `${JSON.stringify({ pid: 2 ** 30, session: "dead", acquired_at: "x" })}\n`);
  let releaseDead: (() => void) | undefined;
  let finishedDead!: Promise<unknown>;
  const enteredDead = new Promise<void>((done) => {
    finishedDead = withTaskLock(root, "20260928-other-fix", "session-c", () => new Promise<void>((unlock) => {
      releaseDead = unlock;
      done();
    }));
  });
  await enteredDead;
  expect(JSON.parse(await readFile(crashed, "utf8"))).toMatchObject({
    pid: process.pid, session: "session-c",
  });
  releaseDead?.();
  await finishedDead;
  expect(await allocateRun(root, "20260928-other-fix", "session-c")).toBe(1);
  let releaseSecond: (() => void) | undefined;
  let finishedSecond!: Promise<unknown>;
  const entered = new Promise<void>((done) => {
    finishedSecond = withTaskLock(root, "20260928-lifetime-fix", "session-a", () => new Promise<void>((unlock) => {
      releaseSecond = unlock;
      done();
    }));
  });
  await entered;
  await expect(allocateRun(root, "20260928-lifetime-fix", "session-b")).rejects.toBeInstanceOf(TaskLockError);
  releaseSecond?.();
  await finishedSecond;
  const first = await allocateRun(root, "20260928-lifetime-fix", "session-a");
  const second = await allocateRun(root, "20260928-lifetime-fix", "session-a");
  expect([first, second]).toEqual([1, 2]);
  const updated = await updateState(root, "20260928-lifetime-fix", "session-a", (state) => ({ ...state, repairs_used: state.repairs_used + 1 }));
  expect(updated.repairs_used).toBe(1);
  expect((await readState(root, "20260928-lifetime-fix")).repairs_used).toBe(1);
  await expect(createTask(root, "20260928-lifetime-fix", "gateway/medium")).rejects.toThrow(/already exists/);
  expect((await readState(root, "20260928-lifetime-fix")).repairs_used).toBe(1);
});

// 契约：只有 pid 可证明已死（ESRCH）且锁内容两次读取一致时才回收；活 pid 的其他会话、无法解析的锁内容一律拒绝——
// 宁可拒绝也不误抢别人的锁。
// Contract: a lock is reclaimed only when its pid is provably gone (`ESRCH`) and the file content
// reads identically twice; a live pid from another session, or content that cannot be parsed, is
// still refused — a false refusal beats stealing a lock that may be held.
test("陈旧锁回收：死 pid 回收，活 pid 与损坏内容继续拒绝", async () => {
  const root = await repo();
  await createTask(root, "20260928-lifetime-fix", "gateway/medium");
  const lockPath = path.join(root, ".cw", "tasks", "20260928-lifetime-fix", "lock");

  // 死 pid（真实退出过的子进程，kill(pid,0) → ESRCH）：回收并接管。
  // Dead pid (a child that already exited, kill(pid,0) → ESRCH): reclaimed and taken over.
  const dead = await new Promise<number>((resolve, reject) => {
    const child = spawn("node", ["-e", "process.exit(0)"]);
    child.once("close", () => resolve(child.pid!));
    child.once("error", reject);
  });
  const stale = `${JSON.stringify({ pid: dead, session: "ghost", acquired_at: "then" })}\n`;
  await writeFile(lockPath, stale);
  let release: (() => void) | undefined;
  let finished!: Promise<unknown>;
  const entered = new Promise<void>((done) => {
    finished = withTaskLock(root, "20260928-lifetime-fix", "session-a", () =>
      new Promise<void>((unlock) => { release = unlock; done(); }));
  });
  await entered;
  expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
    pid: process.pid, session: "session-a",
  });
  release?.();
  await finished;

  // 活 pid（本进程）+ 其他会话：拒绝且锁内容原样保留。
  // Live pid (this process) held by another session: refused, the lock file left byte-identical.
  const live = `${JSON.stringify({ pid: process.pid, session: "other", acquired_at: "now" })}\n`;
  await writeFile(lockPath, live);
  await expect(withTaskLock(root, "20260928-lifetime-fix", "session-a", async () => undefined))
    .rejects.toBeInstanceOf(TaskLockError);
  expect(await readFile(lockPath, "utf8")).toBe(live);

  // 损坏的锁内容：无法证明持有者已死，不回收，拒绝。
  // Corrupt lock content: the holder cannot be proven dead, so it is refused, not reclaimed.
  await writeFile(lockPath, "not-json\n");
  await expect(withTaskLock(root, "20260928-lifetime-fix", "session-a", async () => undefined))
    .rejects.toBeInstanceOf(TaskLockError);
  await rm(lockPath, { force: true });
}, 20_000);

// 契约：契约里的路径必须 repo 相对且已规范化，`.`/`..` 直接拒绝，经 symlink 别名访问 .cw 仍算禁区；
// 已跟踪的 .cw 文件不进 tree，createTask 遇 symlink 任务目录拒绝且仓库外文件不受影响。
// Contract: contract paths must be repo-relative and normalized — any `.`/`..` segment is refused,
// and `.cw` stays off-limits even through a symlink alias. Tracked `.cw` files never enter the
// tree, and `createTask` refuses a symlinked task directory instead of writing outside the repo.
test("路径规范化、symlink 禁区与已跟踪 .cw 不进入 tree", async () => {
  const root = await repo();
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "tests", "a.py"), "pass\n");
  await mkdir(path.join(root, ".cw", "tasks"), { recursive: true });
  const file = path.join(root, "contract.toml");
  await writeFile(file, contract({ rest: `frozen = ["tests/../tests/a.py"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/refuses \. or \.\./);
  await writeFile(file, contract({ rest: `frozen = ["tests/a.py/../../outside.py"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/refuses \. or \.\./);
  await symlink(path.join(root, ".cw"), path.join(root, "alias"));
  await writeFile(file, contract({ rest: `frozen = ["alias/tasks/20260928-lifetime-fix/state.json"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/\.cw is not allowed/);
  await writeFile(file, contract({ rest: `baseline_inputs = ["alias/validate.sh"]` }));
  const aliased = await readContract(file, root);
  expect(aliased.baseline_inputs).toEqual([".cw/validate.sh"]);
  await writeFile(file, contract({ rest: `baseline_inputs = [".cw/missing/tasks/state.json"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/task state/);
  await writeFile(file, contract({ rest: `frozen = ["tests/./a.py", "tests/a.py"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/refuses \. or \.\./);
  // 两个不同的路径解析到同一个文件（经 symlink）时算重复 frozen 条目。
  // Two paths resolving to the same file (via symlink) count as duplicate `frozen` entries.
  await mkdir(path.join(root, "nested"));
  await symlink(path.join(root, "tests", "a.py"), path.join(root, "nested", "same.py"));
  await writeFile(file, contract({ rest: `frozen = ["tests/a.py", "nested/same.py"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/duplicate frozen/);

  await writeFile(path.join(root, ".cw", "tracked"), "secret\n");
  await git(root, ["add", ".cw/tracked"]);
  await git(root, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "track cw"]);
  const withTracked = await treeHash(root);
  if (!withTracked.supported) throw new Error("git tree expected");
  await writeFile(path.join(root, ".cw", "tracked"), "changed\n");
  expect((await treeHash(root)).value).toBe(withTracked.value);
  const listed = await git(root, ["ls-tree", "-r", "--name-only", withTracked.value]);
  expect(listed).not.toContain(".cw");
  const outside = await mkdtemp(path.join(tmpdir(), "cw-m1-ledger-"));
  await writeFile(path.join(outside, "state.json"), "{\"repairs_used\":7}\n");
  await symlink(outside, path.join(root, ".cw", "tasks", "20260928-outside-fix"));
  await expect(createTask(root, "20260928-outside-fix", "gateway/medium")).rejects.toThrow(/symlink/);
  expect(await readFile(path.join(outside, "state.json"), "utf8")).toContain("7");
  expect((await blobHash(root, "missing.txt")).value).toBeNull();
});

/**
 * 跑一条 git 命令并返回 stdout；非零退出时用 stderr 作为错误抛出，方便用例直接断言失败路径。
 *
 * Runs one git command in `cwd` and resolves with its stdout; a non-zero exit
 * rejects with the captured stderr.
 */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}
