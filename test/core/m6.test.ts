import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { renderTaskView } from "../../src/core/approve.ts";
import { readContract } from "../../src/core/contract.ts";
import { judgeRedBaseline, runRedCheck, CannotIsolateError } from "../../src/core/redcheck.ts";
import { treeHash } from "../../src/core/gitstate.ts";
import { createTask, readState, updateState, writeApproval } from "../../src/core/task.ts";
import type { Approval } from "../../src/core/task.ts";
import type { Contract, ValidatorConfig } from "../../src/core/types.ts";

const fixture = path.join(import.meta.dirname, "../fixtures/validators/fake.sh");
const taskId = "20260928-lifetime-fix";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Check = { id: string; status: string; message?: string };

function payload(checks: Check[]): string {
  return JSON.stringify({
    protocol: 1, run_id: "1", complete: true, checks,
    build: { required: false }, summary: "x", logs: [],
  });
}

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

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")}`)));
  });
}

const baseContract = contractOf();

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

const validator = (mode: string, payloadText = "-", code = "0", timeout_s = 600): ValidatorConfig =>
  ({ cmd: ["/bin/sh", fixture, mode, payloadText, code], timeout_s, env: {} });

const redCheckRequest = (
  repo: string, contract: Contract, base: string, cmd: ValidatorConfig,
) => ({ repo, taskId, session: "s1", contract, validator: cmd, baseCommit: base });

const redOkPayload = payload([
  { id: "red1", status: "fail", message: "AssertionError: owner alive" },
  { id: "keep", status: "pass" },
  { id: "reg1", status: "pass" },
]);

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

function approvalOf(contract: Contract): Approval {
  return {
    version: 1,
    contract_sha256: "0".repeat(64),
    project_config_sha256: "0".repeat(64),
    validator: { cmd: ["/bin/true"], timeout_s: 600, env: {} },
    base_commit: "0".repeat(40),
    baseline_inputs_sha256: {},
    frozen_blobs: {},
    red_check_run: 1,
    approved_at: "2026-10-01T00:00:00.000Z",
  };
}

test("并发批准：后到者锁内被拒且不覆盖已批准记录任何字段", async () => {
  const { repo } = await setup();
  const approvalA = { ...approvalOf(baseContract), approved_at: "winner-A" };
  const approvalB = { ...approvalOf(baseContract), approved_at: "loser-B" };
  await writeApproval(repo, taskId, "sA", approvalA);

  // 后到者拿到锁后在状态检查处被拒：approval.json 与会话登记保持胜者原样。
  await expect(writeApproval(repo, taskId, "sB", approvalB))
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
    writeApproval(repo, taskId, "sA2", { ...approvalA, approved_at: "race-A" }),
    writeApproval(repo, taskId, "sB2", { ...approvalB, approved_at: "race-B" }),
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
