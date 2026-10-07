/**
 * M6 先红门禁与批准链路的集成测试：在临时 git 仓库上驱动 runRedCheck、
 * judgeRedBaseline、writeApproval、提议采纳/消费与 renderTaskView。失败路径的
 * 统一语义是“拒绝而不是将就”——无法隔离、契约漂移、未采纳提议、取消与超时都
 * 不得留下批准记录，也不得发布 last_verified。
 *
 * Integration tests for the M6 red gate and approval chain: drives
 * `runRedCheck`, `judgeRedBaseline`, `writeApproval`, proposal adoption and
 * consumption, and `renderTaskView` against throwaway git repos. Every failure
 * path refuses rather than compromises — un-isolatable inputs, contract drift,
 * un-adopted proposals, cancellation, and timeouts leave no approval record and
 * publish no `last_verified`.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { renderTaskView } from "../../src/core/approve.ts";
import { contractSha256, readContract } from "../../src/core/contract.ts";
import { contentSha256 } from "../../src/core/evidence.ts";
import { judgeRedBaseline, runRedCheck, CannotIsolateError } from "../../src/core/redcheck.ts";
import { runValidator } from "../../src/core/runner.ts";
import { treeHash } from "../../src/core/gitstate.ts";
import { createTask, proposalAdopted, readState, updateState, writeApproval, writeProposal } from "../../src/core/task.ts";
import type { Approval } from "../../src/core/task.ts";
import type { Contract, ValidatorConfig } from "../../src/core/types.ts";

/** 本文件所有验证器都通过这一个固定脚本驱动 / Every validator here runs through this one fixture script. */
const fixture = path.join(import.meta.dirname, "../fixtures/validators/fake.sh");
const taskId = "20260928-lifetime-fix";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 验证器报告里单个检查项的最小形状 / Minimal shape of one check entry in a validator report. */
type Check = { id: string; status: string; message?: string };

/**
 * 构造一份完整的 protocol-1 报告文本；只有 checks 由用例决定，其余字段固定。
 *
 * Build a complete protocol-1 report body; only `checks` varies per case, every
 * other field is pinned to the happy-path shape.
 */
function payload(checks: Check[]): string {
  return JSON.stringify({
    protocol: 1, run_id: "1", complete: true, checks,
    build: { required: false }, summary: "x", logs: [],
  });
}

/**
 * 夹具契约：acceptance 为 [red1, keep]、red 为 [red1]、regression 为 [reg1]，
 * 并冻结 tests/a.py；任一字段可整体覆盖。
 *
 * Fixture contract: acceptance `[red1, keep]`, red `[red1]`, regression
 * `[reg1]`, `tests/a.py` frozen; any field can be overridden wholesale.
 */
function contractOf(overrides: Partial<Contract> = {}): Contract {
  return {
    version: 1,
    task_id: taskId,
    tier: "change",
    deliverable: "code",
    goal: "fix lifetime issue",
    non_goals: [],
    acceptance: ["red1", "keep"],
    red: ["red1"],
    regression: ["reg1"],
    frozen: ["tests/a.py"],
    interface: [],
    baseline_inputs: ["tests/a.py"],
    approved_failures: [],
    ...overrides,
  };
}

/**
 * 把契约渲染成 contract.toml 文本。批准链路比对的是落盘字节的哈希，所以用例
 * 都先写盘再 readContract 读回，而不是直接拿内存对象去批准。
 *
 * Render a contract as `contract.toml` text. The approval chain hashes the
 * bytes on disk, so cases write the file first and `readContract` it back
 * instead of approving the in-memory object.
 */
function contractToml(contract: Contract): string {
  return `version = 1
task_id = "${contract.task_id}"
tier = "${contract.tier}"
deliverable = "${contract.deliverable}"
goal = "${contract.goal}"
acceptance = [${contract.acceptance.map((id) => `"${id}"`).join(", ")}]
red = [${contract.red.map((id) => `"${id}"`).join(", ")}]
regression = [${contract.regression.map((id) => `"${id}"`).join(", ")}]
frozen = [${contract.frozen.map((id) => `"${id}"`).join(", ")}]
baseline_inputs = [${contract.baseline_inputs.map((id) => `"${id}"`).join(", ")}]
approved_failures = [${contract.approved_failures.map((item) => `{ id = "${item.id}", reason = "${item.reason}" }`).join(", ")}]
`;
}

/** 在 `cwd` 中执行一条 git 命令，失败即 reject / Runs one git command in `cwd`; rejects on failure. */
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")}`)));
  });
}

/** 用例共享的默认契约 / The default contract shared by the cases below. */
const baseContract = contractOf();

/**
 * 建一个临时 git 仓库并提交基准内容，创建任务目录、写入 contract.toml；
 * 返回仓库路径、base commit，以及从磁盘读回（哈希与落盘字节一致）的契约。
 *
 * Sets up a throwaway git repo with a base commit, a task directory, and
 * `contract.toml`; returns the repo path, the base commit, and the contract as
 * read back from disk so its sha256 matches the stored bytes.
 */
async function setup(): Promise<{ repo: string; base: string; contract: Contract }> {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-m6core-"));
  await git(repo, ["init"]);
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await writeFile(path.join(repo, "tests", "a.py"), "base\n");
  await git(repo, ["add", "tracked.txt", "tests/a.py"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await createTask(repo, taskId, "unassigned", base);
  const file = path.join(repo, ".cw", "tasks", taskId, "contract.toml");
  await writeFile(file, contractToml(baseContract));
  return { repo, base, contract: await readContract(file, repo) };
}

/**
 * 用共享的 fake.sh 夹具构造验证器配置：mode 选行为（reportrun/touch/hang/none…），
 * payloadText 是报告文本（`-` 表示不用），退出码与超时可覆盖。
 *
 * Builds a validator config around the shared `fake.sh` fixture: `mode` picks
 * the behavior (reportrun / touch / hang / none …), `payloadText` is the report
 * body (`-` when unused), and exit code / timeout are overridable.
 */
const validator = (mode: string, payloadText = "-", code = "0", timeout_s = 600): ValidatorConfig =>
  ({ cmd: ["/bin/sh", fixture, mode, payloadText, code], timeout_s, env: {} });

/**
 * 组装一次 runRedCheck 请求，session 固定为 s1。
 *
 * Assembles a `runRedCheck` request; the session is pinned to "s1".
 */
const redCheckRequest = (
  repo: string, contract: Contract, base: string, cmd: ValidatorConfig,
) => ({ repo, taskId, session: "s1", contract, validator: cmd, baseCommit: base });

/**
 * 预期被先红判定接受的报告：red1 失败、keep 与 reg1 通过。
 *
 * The report a passing red check expects: red1 fails while keep and reg1 pass.
 */
const redOkPayload = payload([
  { id: "red1", status: "fail", message: "AssertionError: owner alive" },
  { id: "keep", status: "pass" },
  { id: "reg1", status: "pass" },
]);

/**
 * 已注册的 worktree 数量（含主工作树）；基线清理干净后必须回到 1。
 *
 * Number of registered worktrees including the main one; must return to 1 once
 * the temporary baseline is cleaned up.
 */
async function worktreeCount(repo: string): Promise<number> {
  const text = await git(repo, ["worktree", "list", "--porcelain"]);
  return text.split("worktree ").length - 1;
}

test("先红判定：red 失败且其余通过为 ok；pass/skip/error/缺失/重复均拒绝", () => {
  const contract = baseContract;
  const ok = judgeRedBaseline(contract, {
    protocol: 1, run_id: "1", complete: true, checks: [
      { id: "red1", status: "fail", message: "AssertionError: owner alive" },
      { id: "keep", status: "pass" },
      { id: "reg1", status: "pass" },
    ], build: { required: false }, summary: "x", logs: [],
  });
  expect(ok.ok).toBe(true);

  for (const status of ["pass", "skip", "error"]) {
    const judged = judgeRedBaseline(contract, {
      protocol: 1, run_id: "1", complete: true, checks: [
        { id: "red1", status }, { id: "keep", status: "pass" }, { id: "reg1", status: "pass" },
      ], build: { required: false }, summary: "x", logs: [],
    });
    expect(judged.ok).toBe(false);
    expect(judged.reasons.join("; ")).toContain(`先红项未以失败执行 red1（${status}）`);
  }

  const missing = judgeRedBaseline(contract, {
    protocol: 1, run_id: "1", complete: true, checks: [
      { id: "keep", status: "pass" }, { id: "reg1", status: "pass" },
    ], build: { required: false }, summary: "x", logs: [],
  });
  expect(missing.ok).toBe(false);
  expect(missing.reasons.join("; ")).toContain("先红项缺失 red1");

  const dup = judgeRedBaseline(contract, {
    protocol: 1, run_id: "1", complete: true, checks: [
      { id: "red1", status: "fail" }, { id: "red1", status: "fail" },
      { id: "keep", status: "pass" }, { id: "reg1", status: "pass" },
    ], build: { required: false }, summary: "x", logs: [],
  });
  expect(dup.ok).toBe(false);
  expect(dup.reasons.join("; ")).toContain("重复 ID");

  const nonRed = judgeRedBaseline(contract, {
    protocol: 1, run_id: "1", complete: true, checks: [
      { id: "red1", status: "fail" }, { id: "keep", status: "fail" }, { id: "reg1", status: "pass" },
    ], build: { required: false }, summary: "x", logs: [],
  });
  expect(nonRed.ok).toBe(false);
  expect(nonRed.reasons.join("; ")).toContain("非先红验收项未通过 keep");

  const regression = judgeRedBaseline(contract, {
    protocol: 1, run_id: "1", complete: true, checks: [
      { id: "red1", status: "fail" }, { id: "keep", status: "pass" }, { id: "reg1", status: "fail" },
    ], build: { required: false }, summary: "x", logs: [],
  });
  expect(regression.ok).toBe(false);
  expect(regression.reasons.join("; ")).toContain("回归项未通过 reg1");
});

test("先红判定：存量失败豁免的回归可以失败但必须出现在报告中", () => {
  const contract = contractOf({ approved_failures: [{ id: "reg1", reason: "另开任务" }] });
  const shape = (checks: Check[]) => ({
    protocol: 1 as const, run_id: "1", complete: true, checks,
    build: { required: false }, summary: "x", logs: [],
  });
  // 豁免只放宽状态要求，不放宽报告要求：漏报等同于未验证。
  // The exemption relaxes the status requirement only, never the reporting one:
  // a missing entry counts as unverified.
  const exempt = judgeRedBaseline(contract, shape([
    { id: "red1", status: "fail" }, { id: "keep", status: "pass" }, { id: "reg1", status: "fail" },
  ]));
  expect(exempt.ok).toBe(true);

  const unreported = judgeRedBaseline(contract, shape([
    { id: "red1", status: "fail" }, { id: "keep", status: "pass" },
  ]));
  expect(unreported.ok).toBe(false);
  expect(unreported.reasons.join("; ")).toContain("存量失败未在报告中出现 reg1");
});

test("先红检查：脏工作树下用原始基线与当前验收输入运行，工作树保持不变，临时目录与 worktree 清理干净", async () => {
  const { repo, base, contract } = await setup();
  // 实现修改：改 tracked 文件 + 新增实现文件（都不在 baseline_inputs 中）。
  await writeFile(path.join(repo, "tracked.txt"), "implementation\n");
  await writeFile(path.join(repo, "src.py"), "impl\n");
  const treeBefore = (await treeHash(repo)).value!;

  // 报告里回填验证器的实际 pwd 与 run id（fake.sh 的 reportrun 负责替换占位符），
  // 下面的断言靠它证明验证器确实跑在隔离基线目录、且 run id 与账本一致。
  // The report echoes the validator's real pwd and run id (fake.sh's reportrun
  // substitutes the placeholders), which lets the assertions below prove it ran
  // in the isolated baseline directory with the ledger's run id.
  const outcome = await runRedCheck(redCheckRequest(repo, contract, base, validator(
    "reportrun",
    redOkPayload.replace('"summary":"x"', '"summary":"@PWD@"').replace('"run_id":"1"', '"run_id":"@RUN@"'),
  )));

  expect(outcome.valid).toBe(true);
  expect(outcome.red.ok).toBe(true);
  expect(outcome.redFailures).toEqual([
    { id: "red1", status: "fail", message: "AssertionError: owner alive" },
  ]);
  expect(outcome.baselineInputs).toEqual(["tests/a.py"]);
  expect(outcome.record.git).toBe(true);
  expect(outcome.record.tree_before).toBe(outcome.record.tree_after);
  expect(outcome.record.cancelled).toBe(false);
  expect(outcome.inputHashes["tests/a.py"]).toMatch(/^[0-9a-f]{64}$/);

  // 验证器确实运行在隔离基线目录，而不是当前工作树。
  const result = JSON.parse(await readFile(path.join(outcome.runDir, "result.json"), "utf8")) as { summary: string };
  expect(result.summary).toContain("cw-red-");
  expect(result.summary).not.toBe(repo);

  // 当前工作树完全未动；run 记录落在权威任务账本。
  expect((await treeHash(repo)).value).toBe(treeBefore);
  const realRepo = await realpath(repo);
  expect(outcome.runDir.startsWith(path.join(realRepo, ".cw", "tasks", taskId, "runs"))).toBe(true);

  // 清理：worktree 元数据只剩主工作树（prune 只在目录已删除时清元数据，
  // 所以计数为 1 同时证明临时目录与元数据都已清理）。
  expect(await worktreeCount(repo)).toBe(1);
});

test("先红检查：验收输入缺失或 base_commit 不存在时拒绝隔离", async () => {
  const { repo, base, contract } = await setup();
  // 无法忠实隔离就直接拒绝批准，绝不在当前半成品工作树上跑先红检查。
  // Un-isolatable inputs refuse the approval outright: the red check never runs
  // against the current half-done worktree.
  await rm(path.join(repo, "tests", "a.py"));
  await expect(runRedCheck(redCheckRequest(repo, contract, base, validator("none"))))
    .rejects.toBeInstanceOf(CannotIsolateError);

  await expect(runRedCheck(redCheckRequest(repo, contract, "1".repeat(40), validator("none"))))
    .rejects.toBeInstanceOf(CannotIsolateError);
});

test("先红检查：验证器改动基线 → undetermined 拒绝；超时杀掉进程组并清理", async () => {
  const { repo, base, contract } = await setup();
  const touched = await runRedCheck(redCheckRequest(repo, contract, base, validator(
    "touch",
    payload([
      { id: "red1", status: "fail" }, { id: "keep", status: "pass" }, { id: "reg1", status: "pass" },
    ]),
  )));
  expect(touched.valid).toBe(false);
  expect(touched.validityReasons.join("; ")).toContain("worktree changed during validation");

  // 超时：hang 模式忽略 SIGTERM，5s 后 SIGKILL；返回时进程组必须已死。
  const waiting = runRedCheck(redCheckRequest(repo, contract, base, validator("hang", "-", "0", 1)));
  const runs = path.join(repo, ".cw", "tasks", taskId, "runs");
  // hang 模式的子进程把 PID 写进 child.pid；先取到 PID，超时返回后才能证明整个
  // 进程组已被杀（对已消失的 PID 发信号 0 会抛错）。
  // The hang-mode child writes its PID to child.pid; capturing it up front lets
  // the test prove the whole process group is dead once the run returns (signal
  // 0 to a vanished PID throws).
  let pid: number | undefined;
  for (let attempt = 0; attempt < 100 && pid === undefined; attempt++) {
    await delay(100);
    try {
      const names = await readdir(runs);
      const runDir = names.sort().at(-1);
      if (runDir !== undefined) {
        const text = await readFile(path.join(runs, runDir, "child.pid"), "utf8").catch(() => null);
        if (text !== null) pid = Number(text.trim());
      }
    } catch {
      // runs 目录尚未创建
    }
  }
  expect(pid).toBeGreaterThan(0);
  const timedOut = await waiting;
  expect(timedOut.valid).toBe(false);
  expect(() => process.kill(pid!, 0)).toThrow();
  expect(await worktreeCount(repo)).toBe(1);
}, 20_000);

/**
 * 占位批准记录：哈希全是哑值，只用于 renderTaskView 这类只读展示字段、
 * 不校验一致性的用例。
 *
 * Placeholder approval with dummy hashes; only for cases like `renderTaskView`
 * that read display fields and never verify hash consistency.
 */
function approvalOf(contract: Contract): Approval {
  return {
    version: 1,
    contract_sha256: "0".repeat(64),
    project_config_sha256: "0".repeat(64),
    validator: { cmd: ["/bin/true"], timeout_s: 600, env: {} },
    base_commit: "0".repeat(40),
    baseline_inputs_sha256: {},
    validator_inputs_sha256: {},
    frozen_blobs: {},
    red_check_run: 1,
    approved_at: "2026-10-01T00:00:00.000Z",
  };
}

test("并发批准：后到者锁内被拒且不覆盖已批准记录任何字段", async () => {
  const { repo, base, contract } = await setup();
  // 局部同名 helper 遮蔽占位版：并发用例需要真实的 contract_sha256。
  // Shadows the module-level placeholder: the race case needs a real
  // `contract_sha256` to get past `writeApproval`'s consistency check.
  const approvalOf = (approvedAt: string): Approval => ({
    version: 1,
    contract_sha256: contractSha256(contract),
    project_config_sha256: "0".repeat(64),
    validator: { cmd: ["/bin/true"], timeout_s: 600, env: {} },
    base_commit: base,
    baseline_inputs_sha256: {},
    validator_inputs_sha256: {},
    frozen_blobs: {},
    red_check_run: 1,
    approved_at: approvedAt,
  });
  const approvalA = approvalOf("winner-A");
  const approvalB = approvalOf("loser-B");
  await writeApproval(repo, taskId, "sA", approvalA, contract);

  // 后到者拿到锁后在状态检查处被拒：approval.json 与会话登记保持胜者原样。
  await expect(writeApproval(repo, taskId, "sB", approvalB, contract))
    .rejects.toThrow(/not drafting\/handed_back/);
  const onDisk = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"));
  expect(onDisk).toEqual(approvalA);
  const state = await readState(repo, taskId);
  expect(state.status).toBe("approved");
  expect(state.sessions).toEqual(["sA"]);

  // 真并发：锁竞争只产生一个胜者，落盘内容必为胜者负载，败者会话不登记。
  await updateState(repo, taskId, "sA", (current) => ({ ...current, status: "handed_back" }));
  const [raceA, raceB] = await Promise.allSettled([
    writeApproval(repo, taskId, "sA2", { ...approvalA, approved_at: "race-A" }, contract),
    writeApproval(repo, taskId, "sB2", { ...approvalB, approved_at: "race-B" }, contract),
  ]);
  const settled = [raceA, raceB];
  const fulfilled = settled.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof writeApproval>>> =>
    item.status === "fulfilled");
  expect(fulfilled).toHaveLength(1);
  const winnerSessions = fulfilled[0]!.value.sessions;
  const loserSession = winnerSessions.includes("sA2") ? "sB2" : "sA2";
  const onDisk2 = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"));
  expect(onDisk2.approved_at).toBe(winnerSessions.includes("sA2") ? "race-A" : "race-B");
  const state2 = await readState(repo, taskId);
  expect(state2.sessions).toContain(winnerSessions.at(-1)!);
  expect(state2.sessions).not.toContain(loserSession);
});

test("批准与契约漂移：契约在先红后再次修改则拒绝批准", async () => {
  const { repo, base, contract } = await setup();
  const drifted = contractOf({ goal: "changed on disk" });
  const approval = {
    ...approvalOfReal(contract, base),
    contract_sha256: contractSha256(contract),
  };
  // 磁盘上的契约已改为 drifted，writeApproval 传入的却是旧 contract。
  const file = path.join(repo, ".cw", "tasks", taskId, "contract.toml");
  await writeFile(file, contractToml(drifted));
  await expect(writeApproval(repo, taskId, "sA", approval, contract))
    .rejects.toThrow(/再次变化/);
  await expect(readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"))
    .rejects.toThrow();
});

/**
 * 哈希由真实契约与 base commit 计算出的批准记录；先红后契约漂移等用例只能用
 * 它来构造一个“本来会成功”的批准。
 *
 * An approval whose hashes are computed from the real contract and base commit;
 * only this builder can produce an approval that would otherwise succeed.
 */
function approvalOfReal(contract: Contract, base: string): Approval {
  return {
    version: 1,
    contract_sha256: contractSha256(contract),
    project_config_sha256: "0".repeat(64),
    validator: { cmd: ["/bin/true"], timeout_s: 600, env: {} },
    base_commit: base,
    baseline_inputs_sha256: {},
    validator_inputs_sha256: {},
    frozen_blobs: {},
    red_check_run: 1,
    approved_at: new Date().toISOString(),
  };
}

test("先红覆盖：基线祖先为指向仓库外 canary 的符号链接时写前拒绝，canary 内容不变", async () => {
  // 仓库外的金丝雀文件：旧实现先写后查会沿基线符号链接把它改写。
  const canaryDir = await mkdtemp(path.join(tmpdir(), "cw-canary-"));
  const canary = path.join(canaryDir, "canary.txt");
  await writeFile(canary, "canary\n");
  try {
    const repo = await mkdtemp(path.join(tmpdir(), "cw-m6sym-"));
    await git(repo, ["init"]);
    await writeFile(path.join(repo, "tracked.txt"), "base\n");
    // 基线提交里 tests 是指向仓库外文件的符号链接。
    await symlink(canary, path.join(repo, "tests"));
    await git(repo, ["add", "tracked.txt", "tests"]);
    await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
    const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
    // 当前工作树的“实现”：tests 换成真实目录 + 修改后的验收文件（工作树脏）。
    await rm(path.join(repo, "tests"));
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "tests", "a.py"), "current\n");
    await createTask(repo, taskId, "unassigned", base);
    const contract = contractOf({});
    const file = path.join(repo, ".cw", "tasks", taskId, "contract.toml");
    await writeFile(file, contractToml(contract));

    await expect(runRedCheck(redCheckRequest(repo, contract, base, validator("none"))))
      .rejects.toThrow(/符号链接/);

    // 写前拒绝：canary 保持原样；隔离基线与元数据已清理。
    expect(await readFile(canary, "utf8")).toBe("canary\n");
    const text = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(text.split("worktree ").length - 1).toBe(1);
  } finally {
    await rm(canaryDir, { recursive: true, force: true });
  }
});

test("任务视图：≤40 行，含目标、先红标记与工具用途；超长列表截断并注明余量", () => {
  const view = renderTaskView(baseContract, approvalOf(baseContract));
  const lines = view.split("\n");
  expect(lines.length).toBeLessThanOrEqual(40);
  expect(view).toContain("fix lifetime issue");
  expect(view).toContain("- red1（先红：基线必须失败）");
  expect(view).toContain("- keep");
  expect(view).toContain("propose_contract_change");
  expect(view).toContain("report_blocked");

  // 四类列表各 30 项：验证 40 行硬上限下的尾部截断与“其余 N 项”余量提示。
  // Four list sections of 30 items each: exercises truncation from the tail
  // under the 40-line hard cap and the explicit remainder marker.
  const long = contractOf({
    non_goals: Array.from({ length: 30 }, (_, index) => `非目标 ${index}`),
    acceptance: Array.from({ length: 30 }, (_, index) => `acc${index}`),
    red: ["acc0"],
    regression: Array.from({ length: 30 }, (_, index) => `reg${index}`),
    frozen: Array.from({ length: 30 }, (_, index) => `frozen${index}.py`),
  });
  const capped = renderTaskView(long, approvalOf(long));
  expect(capped.split("\n").length).toBeLessThanOrEqual(40);
  expect(capped).toContain("（其余");
  expect(capped).toContain("- acc0（先红：基线必须失败）");
});

test("提议采纳边界：字段值与 new_value 一致才算被契约采纳", () => {
  const contract = baseContract;
  expect(proposalAdopted(contract, { field: "goal", new_value: "fix lifetime issue" })).toBe(true);
  expect(proposalAdopted(contract, { field: "goal", new_value: "changed" })).toBe(false);
  expect(proposalAdopted(contract, { field: "acceptance", new_value: '["red1","keep"]' })).toBe(true);
  // 列表字段按 JSON 解析后逐元素比较：空白不影响判定，非 JSON 文本一律按未采纳
  // 处理（fail closed）。
  // List fields are parsed as JSON and compared element-wise; whitespace is
  // irrelevant and non-JSON text never counts as adopted (fail closed).
  expect(proposalAdopted(contract, { field: "acceptance", new_value: '[ "red1" , "keep" ]' })).toBe(true);
  expect(proposalAdopted(contract, { field: "acceptance", new_value: '["red1"]' })).toBe(false);
  expect(proposalAdopted(contract, { field: "acceptance", new_value: "red1,keep" })).toBe(false);
  expect(proposalAdopted(contract, { field: "nonexistent", new_value: "x" })).toBe(false);
  // 空列表字段：契约确实已为空即视为采纳。
  expect(proposalAdopted(contract, { field: "approved_failures", new_value: "[]" })).toBe(true);
  const exempted = contractOf({ approved_failures: [{ id: "legacy", reason: "另开任务" }] });
  expect(proposalAdopted(exempted, { field: "approved_failures", new_value: "[]" })).toBe(false);
});

test("提议消费：仅采纳中的 approved 提议被消费，未采纳者拒绝批准且全部保留", async () => {
  const { repo, base, contract } = await setup();
  const approval = approvalOfReal(contract, base);
  await writeProposal(repo, taskId, "s1", {
    field: "goal", new_value: "changed", reason: "目标写错", status: "approved",
  });
  await writeProposal(repo, taskId, "s1", {
    field: "tier", new_value: "script", reason: "任务变小", status: "approved",
  });
  await writeProposal(repo, taskId, "s1", {
    field: "regression", new_value: "[]", reason: "待定", status: "pending",
  });

  // 契约尚未采纳任何提议：批准被拒，所有提议原样保留。
  await expect(writeApproval(repo, taskId, "sA", approval, contract))
    .rejects.toThrow(/未在当前契约采纳/);
  const proposal1 = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "proposals", "1.json"), "utf8"));
  const proposal2 = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "proposals", "2.json"), "utf8"));
  const proposal3 = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "proposals", "3.json"), "utf8"));
  expect(proposal1.status).toBe("approved");
  expect(proposal2.status).toBe("approved");
  expect(proposal3.status).toBe("pending");
  await expect(readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"))
    .rejects.toThrow();

  // 采纳提议 1（goal → changed）：提议 2 仍未采纳，批准继续被拒。
  const adoptedFile = path.join(repo, ".cw", "tasks", taskId, "contract.toml");
  await writeFile(adoptedFile, contractToml(contractOf({ goal: "changed" })));
  const adopted = await readContract(adoptedFile, repo, taskId);
  await expect(writeApproval(repo, taskId, "sA", approvalOfReal(adopted, base), adopted))
    .rejects.toThrow(/提议 2/);
  expect((await readFile(path.join(repo, ".cw", "tasks", taskId, "proposals", "1.json"), "utf8"))
    .includes("approved")).toBe(true);

  // 采纳提议 1 与 2（tier → script）：批准成功，1、2 消费且绑定契约版本，3 保持 pending。
  const fullFile = path.join(repo, ".cw", "tasks", taskId, "contract.toml");
  await writeFile(fullFile, contractToml(contractOf({ goal: "changed", tier: "script" })));
  const full = await readContract(fullFile, repo, taskId);
  const fullApproval = approvalOfReal(full, base);
  await writeApproval(repo, taskId, "sA", fullApproval, full);
  const consumed1 = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "proposals", "1.json"), "utf8"));
  const consumed2 = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "proposals", "2.json"), "utf8"));
  const kept3 = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "proposals", "3.json"), "utf8"));
  expect(consumed1.status).toBe("consumed");
  expect(consumed1.resolved_in_contract_sha256).toBe(fullApproval.contract_sha256);
  expect(consumed1.resolved_at).toBeTruthy();
  expect(consumed2.status).toBe("consumed");
  expect(consumed2.resolved_in_contract_sha256).toBe(fullApproval.contract_sha256);
  expect(kept3.status).toBe("pending");
  expect((await readState(repo, taskId)).status).toBe("approved");
});

/**
 * 每 5ms 轮询一次条件，超时即抛错；用来把 abort 精确卡在验证器退出之后、
 * 证据判定结束之前。
 *
 * Polls `predicate` every 5ms and throws on timeout; used to land the abort
 * exactly in the window between validator exit and the end of evidence judging.
 */
const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timeout");
};

test("runner 迟到取消：验证器退出后、证据发布前取消 → 不发布 last_verified", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-m6late-"));
  await git(repo, ["init"]);
  await mkdir(path.join(repo, "inputs"), { recursive: true });
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  // 800 个输入文件把“验证器退出 → 证据判定结束”的窗口拉长，让 abort 稳定落在
  // 验证器退出之后、last_verified 发布之前。
  // 800 input files widen the window between validator exit and the end of
  // evidence judging, so the abort reliably lands after the validator exited but
  // before `last_verified` could be published.
  const inputs: string[] = [];
  for (let index = 0; index < 800; index++) {
    const relative = `inputs/f${index}.txt`;
    await writeFile(path.join(repo, relative), `x${index}\n`);
    inputs.push(relative);
  }
  await git(repo, ["add", "tracked.txt", "inputs"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await createTask(repo, taskId, "unassigned", base);
  const contract = contractOf({
    acceptance: ["a"], red: ["a"], regression: [], frozen: [], baseline_inputs: inputs,
  });
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml(contract));
  await updateState(repo, taskId, "s1", (current) => ({ ...current, status: "approved" }));
  const approvedHashes: Record<string, string> = {};
  for (const input of inputs) approvedHashes[input] = (await contentSha256(repo, input))!;

  const payloadText = JSON.stringify({
    protocol: 1, run_id: "@RUN@", complete: true,
    checks: [{ id: "a", status: "pass" }],
    build: { required: false }, summary: "x", logs: [],
  });
  const controller = new AbortController();
  const run = runValidator({
    repo, taskId, session: "s1", contract,
    validator: validator("reportrun", payloadText),
    approvedInputHashes: approvedHashes,
    signal: controller.signal,
  });
  const runDir = path.join(repo, ".cw", "tasks", taskId, "runs", "1");
  await waitFor(async () => {
    try {
      await readFile(path.join(runDir, "result.json"), "utf8");
      return true;
    } catch {
      return false;
    }
  }, 10_000);
  controller.abort();
  const outcome = await run;

  expect(outcome.lastVerified).toBeNull();
  expect(outcome.verdict.conclusion).toBe("undetermined");
  expect(outcome.verdict.reasons).toContain("cancelled");
  expect(outcome.record.cancelled).toBe(true);
  expect(outcome.record.result_discarded).toBe(true);
  const state = await readState(repo, taskId);
  expect(state.last_verified).toBeNull();
}, 30_000);

test("redcheck 迟到取消：证据判定期间取消 → valid=false，记录改写为已弃置", async () => {
  const { repo, base, contract } = await setup();
  const controller = new AbortController();
  const run = runRedCheck({
    ...redCheckRequest(repo, contract, base, validator(
      "reportrun",
      redOkPayload.replace('"run_id":"1"', '"run_id":"@RUN@"'),
    )),
    signal: controller.signal,
  });
  const runDir = path.join(repo, ".cw", "tasks", taskId, "runs", "1");
  await waitFor(async () => {
    try {
      await readFile(path.join(runDir, "result.json"), "utf8");
      return true;
    } catch {
      return false;
    }
  }, 10_000);
  // result.json 已出现、本次运行尚未成为批准依据时取消：结果作废，不得发布。
  // Cancel after result.json appeared but before this run could back an approval:
  // the result is discarded and must never be published.
  controller.abort();
  const outcome = await run;

  expect(outcome.valid).toBe(false);
  expect(outcome.validityReasons).toContain("cancelled");
  expect(outcome.record.cancelled).toBe(true);
  expect(outcome.record.result_discarded).toBe(true);
  const text = await git(repo, ["worktree", "list", "--porcelain"]);
  expect(text.split("worktree ").length - 1).toBe(1);
}, 30_000);

test("writeApproval 取消感知：锁内检查取消，不写任何记录", async () => {
  const { repo, base, contract } = await setup();
  const approval = approvalOfReal(contract, base);
  const approvalFile = path.join(repo, ".cw", "tasks", taskId, "approval.json");

  // 窗口一：取消先于锁定写入（进入锁体即已取消）→ 立即拒绝，零写入。
  const pending = writeApproval(repo, taskId, "sA", approval, contract, () => true);
  await expect(pending).rejects.toThrow(/用户已取消/);
  await expect(readFile(approvalFile, "utf8")).rejects.toThrow();
  expect((await readState(repo, taskId)).status).toBe("drafting");

  // 窗口二：记录写入后、状态迁移前取消 → 刚写入的记录被撤除，状态不变。
  // 检查点顺序：锁内开始（1，未取消）、写入前（2，未取消）、写入后（3，取消）。
  let calls = 0;
  const gated = writeApproval(repo, taskId, "sA", approval, contract, () => calls++ >= 2);
  await expect(gated).rejects.toThrow(/用户已取消/);
  await expect(readFile(approvalFile, "utf8")).rejects.toThrow();
  expect((await readState(repo, taskId)).status).toBe("drafting");
  expect(calls).toBe(3);
});
