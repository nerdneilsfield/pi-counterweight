import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { readProjectConfig } from "../../src/core/config.ts";;
import { contractSha256, readContract } from "../../src/core/contract.ts";
import { blobHash, headCommit, isClean, treeHash } from "../../src/core/gitstate.ts";
import { allocateRun, createTask, readReference, readState, saveReference, TaskLockError, updateState, withTaskLock } from "../../src/core/task.ts";

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

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cw-m1-"));
  await git(root, ["init"]);
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  return root;
}

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
  const outside = await mkdtemp(path.join(tmpdir(), "cw-m1-out-"));
  await writeFile(path.join(outside, "x"), "x\n");
  await symlink(path.join(outside, "x"), path.join(root, "tests", "escape"));
  await writeFile(file, contract({ rest: `frozen = ["tests/escape"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/symlink escapes/);
  await symlink(path.join(outside, "missing"), path.join(root, "tests", "dangling"));
  await writeFile(file, contract({ rest: `frozen = ["tests/dangling"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/symlink target missing/);
  await mkdir(path.join(root, ".cw", "tasks", "20260928-lifetime-fix"), { recursive: true });
  await writeFile(file, contract({ rest: `baseline_inputs = [".cw/tasks/20260928-lifetime-fix/state.json"]` }));
  await expect(readContract(file, root)).rejects.toThrow(/task state/);
  await writeFile(file, contract({ rest: `baseline_inputs = [".cw/validate.sh", "tests/a.py"]` }));
  expect((await readContract(file, root)).baseline_inputs).toEqual([".cw/validate.sh", "tests/a.py"]);
});

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

test("陈旧锁回收：死 pid 回收，活 pid 与损坏内容继续拒绝", async () => {
  const root = await repo();
  await createTask(root, "20260928-lifetime-fix", "gateway/medium");
  const lockPath = path.join(root, ".cw", "tasks", "20260928-lifetime-fix", "lock");

  // 死 pid（真实退出过的子进程，kill(pid,0) → ESRCH）：回收并接管。
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
  const live = `${JSON.stringify({ pid: process.pid, session: "other", acquired_at: "now" })}\n`;
  await writeFile(lockPath, live);
  await expect(withTaskLock(root, "20260928-lifetime-fix", "session-a", async () => undefined))
    .rejects.toBeInstanceOf(TaskLockError);
  expect(await readFile(lockPath, "utf8")).toBe(live);

  // 损坏的锁内容：无法证明持有者已死，不回收，拒绝。
  await writeFile(lockPath, "not-json\n");
  await expect(withTaskLock(root, "20260928-lifetime-fix", "session-a", async () => undefined))
    .rejects.toBeInstanceOf(TaskLockError);
  await rm(lockPath, { force: true });
}, 20_000);

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
