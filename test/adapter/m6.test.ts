import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import counterweight, { type AdapterTimeouts } from "../../src/adapters/pi/index.ts";
import { canonicalSha256 } from "../../src/core/canonical.ts";
import { contractSha256, readContract } from "../../src/core/contract.ts";
import { contentSha256 } from "../../src/core/evidence.ts";
import { blobHash, treeHash } from "../../src/core/gitstate.ts";
import { readProjectConfig } from "../../src/core/config.ts";
import { checkFrozen } from "../../src/core/freeze.ts";
import { createTask, readState, updateState, writeProposal } from "../../src/core/task.ts";

const fixture = path.join(import.meta.dirname, "../fixtures/validators/fake.sh");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const slug = "lifetime-fix";
const ymd = () => {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
};
const taskId = `${ymd()}-${slug}`;

type Handler = (event: any, ctx: any) => any;

function fakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  commands: Map<string, { description?: string; handler: Handler }>;
  sent: Array<{ message: { customType: string; content: string; display: boolean }; options?: { triggerTurn?: boolean } }>;
  call: (name: string, event: unknown, ctx: ExtensionContext) => Promise<any>;
} {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description?: string; handler: Handler }>();
  const sent: Array<{ message: any; options?: any }> = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => undefined;
    },
    registerTool: (_tool: unknown) => undefined,
    registerCommand: (name: string, options: { description?: string; handler: Handler }) => {
      commands.set(name, options);
    },
    sendMessage: (message: any, options?: any) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    handlers,
    commands,
    sent,
    call: async (name, event, ctx) => {
      const list = handlers.get(name) ?? [];
      if (list.length === 0) throw new Error(`no handler registered for ${name}`);
      return list.at(-1)!(event, ctx);
    },
  };
}

function fakeCtx(
  repo: string,
  options: { hasUI?: boolean; confirmResult?: boolean; session?: string; confirmGate?: Promise<void> } = {},
) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const confirms: Array<string> = [];
  let waitForIdleCalls = 0;
  const ctx = {
    cwd: repo,
    mode: (options.hasUI ?? false) ? "tui" : "print",
    hasUI: options.hasUI ?? false,
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      confirm: async (title: string, message: string) => {
        confirms.push(`${title}: ${message}`);
        if (options.confirmGate !== undefined) await options.confirmGate;
        return options.confirmResult ?? false;
      },
    },
    sessionManager: { getSessionId: () => options.session ?? "s1" },
    signal: undefined,
    waitForIdle: async () => {
      waitForIdleCalls++;
    },
  };
  return {
    ctx: ctx as unknown as ExtensionContext,
    notifications,
    confirms,
    idleCalls: () => waitForIdleCalls,
  };
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

const redOkPayload = JSON.stringify({
  protocol: 1, run_id: "@RUN@", complete: true,
  checks: [
    { id: "red1", status: "fail", message: "AssertionError: owner alive" },
    { id: "keep", status: "pass" },
    { id: "reg1", status: "pass" },
  ],
  build: { required: false }, summary: "x", logs: [],
});

const validatorArgv = (mode: string, payload: string, code = "0") =>
  `["/bin/sh", "${fixture}", "${mode}", ${JSON.stringify(payload)}, "${code}"]`;

const projectToml = (validatorArgvText: string) => `version = 1

[validator]
cmd = ${validatorArgvText}
timeout_s = 600

[models]
cheap = "g/cheap"
medium = "g/medium"
strong = "g/strong"
explorer = "g/explorer"

[tiers]
script = "cheap"
change = "medium"
interface = "strong"
`;

const contractToml = (overrides: {
  deliverable?: string; acceptance?: string[]; red?: string[]; regression?: string[];
  frozen?: string[]; baselineInputs?: string[]; approvedFailures?: string; goal?: string;
} = {}) => `version = 1
task_id = "${taskId}"
tier = "change"
deliverable = "${overrides.deliverable ?? "code"}"
goal = "${overrides.goal ?? "fix lifetime issue"}"
acceptance = [${(overrides.acceptance ?? ["red1", "keep"]).map((id) => `"${id}"`).join(", ")}]
red = [${(overrides.red ?? ["red1"]).map((id) => `"${id}"`).join(", ")}]
regression = [${(overrides.regression ?? ["reg1"]).map((id) => `"${id}"`).join(", ")}]
frozen = [${(overrides.frozen ?? ["tests/a.py"]).map((id) => `"${id}"`).join(", ")}]
baseline_inputs = [${(overrides.baselineInputs ?? ["tests/a.py"]).map((id) => `"${id}"`).join(", ")}]
${overrides.approvedFailures ? `approved_failures = [${overrides.approvedFailures}]` : ""}
`;

async function setup(): Promise<{ repo: string; base: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-m6-"));
  await git(repo, ["init"]);
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await writeFile(path.join(repo, "tests", "a.py"), "base\n");
  await git(repo, ["add", "tracked.txt", "tests/a.py"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await mkdir(path.join(repo, ".cw"), { recursive: true });
  await writeFile(path.join(repo, ".cw", "project.toml"),
    projectToml(validatorArgv("reportrun", redOkPayload)));
  return { repo, base };
}

async function startAdapter(repo: string, timeouts?: Partial<AdapterTimeouts>) {
  const fake = fakePi();
  counterweight(fake.pi, timeouts);
  const context = fakeCtx(repo);
  await fake.call("session_start", { type: "session_start", reason: "startup" }, context.ctx);
  return { fake, ...context };
}

async function runCmd(fake: ReturnType<typeof fakePi>, args: string, ctx: ExtensionContext): Promise<void> {
  const command = fake.commands.get("cw");
  if (command === undefined) throw new Error("/cw not registered");
  await command.handler(args, ctx);
}

const lastNotify = (notifications: Array<{ message: string; type?: string }>) =>
  notifications.at(-1)?.message ?? "";

const settleEvent = () => ({
  type: "agent_before_settle",
  entries: [],
  continue: false,
  outcome: "completed",
  context: { canContinue: true },
});

const toolCallEvent = (toolName: string, input: Record<string, unknown>) => ({
  type: "tool_call", toolCallId: "t1", toolName, input,
});

test("task new：干净树创建 drafting 任务与契约模板并记录 base_commit；脏树拒绝且不改工作树", async () => {
  const { repo, base } = await setup();
  const { fake, ctx, notifications } = await startAdapter(repo);

  await runCmd(fake, `task new ${slug} --tier change`, ctx);
  expect(lastNotify(notifications)).toContain("已创建任务");
  const state = await readState(repo, taskId);
  expect(state.status).toBe("drafting");
  expect(state.base_commit).toBe(base);
  const template = await readFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), "utf8");
  expect(template).toContain(`task_id = "${taskId}"`);
  expect(template).toContain('tier = "change"');

  // 重复 slug：任务已存在。
  await runCmd(fake, `task new ${slug}`, ctx);
  expect(lastNotify(notifications)).toContain("already exists");

  // 脏工作树：拒绝且不动工作树。
  await writeFile(path.join(repo, "tracked.txt"), "dirty\n");
  const treeBefore = (await treeHash(repo)).value!;
  await runCmd(fake, "task new another-fix", ctx);
  expect(lastNotify(notifications)).toContain("不干净");
  expect((await treeHash(repo)).value).toBe(treeBefore);
  const tasks = await readdir(path.join(await realpath(repo), ".cw", "tasks"));
  expect(tasks.filter((name) => !name.startsWith("lock")).sort()).toEqual([taskId].sort());

  // 参数错误。
  await runCmd(fake, `task new Bad_Slug`, ctx);
  expect(lastNotify(notifications)).toContain("slug");
  await runCmd(fake, `task new some-fix --tier huge`, ctx);
  expect(lastNotify(notifications)).toContain("--tier");
}, 20_000);

test("task approve：脏工作树下先红用原始基线；确认后写 approval、状态 approved、任务视图追加、工作树不变", async () => {
  const { repo, base } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  const ctx = context.ctx;
  await runCmd(fake, `task new ${slug}`, ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({}));
  // 实现修改：先红必须仍然使用原始基线。
  await writeFile(path.join(repo, "tracked.txt"), "implementation\n");
  await writeFile(path.join(repo, "src.py"), "impl\n");
  // 验证器把运行目录写进 summary，用于证明它运行在隔离基线。
  const pwdPayload = redOkPayload.replace('"summary":"x"', '"summary":"@PWD@"');
  await writeFile(path.join(repo, ".cw", "project.toml"),
    projectToml(validatorArgv("reportrun", pwdPayload)));
  const treeBefore = (await treeHash(repo)).value!;
  const trackedBefore = await readFile(path.join(repo, "tracked.txt"), "utf8");

  await runCmd(fake, "task approve", ctx);

  // approval.json 内容。
  const approval = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"));
  const contract = await readContract(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), repo);
  expect(approval.version).toBe(1);
  expect(approval.contract_sha256).toBe(contractSha256(contract));
  expect(approval.project_config_sha256).toBe(canonicalSha256(await readProjectConfig(path.join(repo, ".cw", "project.toml"))));
  expect(approval.validator).toEqual({
    cmd: ["/bin/sh", fixture, "reportrun", pwdPayload, "0"], timeout_s: 600, env: {},
  });
  expect(approval.base_commit).toBe(base);
  expect(approval.baseline_inputs_sha256).toEqual({
    "tests/a.py": await contentSha256(repo, "tests/a.py"),
  });
  expect(approval.frozen_blobs).toEqual({
    "tests/a.py": (await blobHash(repo, "tests/a.py")).value,
  });
  expect(approval.red_check_run).toBe(1);
  expect(approval.approved_at).toBeTruthy();

  // 状态与会话登记。
  const state = await readState(repo, taskId);
  expect(state.status).toBe("approved");
  expect(state.sessions).toEqual(["s1"]);

  // 先红运行记录：run 1 落在权威账本，验证器运行在隔离基线目录。
  const runDir = path.join(repo, ".cw", "tasks", taskId, "runs", "1");
  const record = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  expect(record.git).toBe(true);
  expect(record.tree_before).toBe(record.tree_after);
  const result = JSON.parse(await readFile(path.join(runDir, "result.json"), "utf8"));
  expect(result.summary).toContain("cw-red-");
  expect(result.summary).not.toBe(await realpath(repo));

  // 当前工作树保持不变。
  expect((await treeHash(repo)).value).toBe(treeBefore);
  expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe(trackedBefore);

  // 任务视图：空闲后追加一条 ≤40 行消息，不触发轮次。
  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0]!.message.customType).toBe("counterweight");
  expect(fake.sent[0]!.message.display).toBe(true);
  expect(fake.sent[0]!.options).toEqual({ triggerTurn: false });
  const view = fake.sent[0]!.message.content as string;
  expect(view.split("\n").length).toBeLessThanOrEqual(40);
  expect(view).toContain("fix lifetime issue");
  expect(view).toContain("- red1（先红：基线必须失败）");
  expect(view).toContain("propose_contract_change");
  expect(view).toContain("report_blocked");
  expect(context.idleCalls()).toBe(1);
  expect(context.confirms).toHaveLength(1);
  expect(context.confirms[0]).toContain("AssertionError: owner alive");
  expect(context.confirms[0]).toContain("- tests/a.py");

  // 批准后本会话立即受门禁保护：契约文件被 block。
  const blocked = await fake.call("tool_call", toolCallEvent("write", {
    path: `.cw/tasks/${taskId}/contract.toml`, content: "x",
  }), ctx);
  expect(blocked).toMatchObject({ block: true });

  // 清理完整：worktree 元数据只剩主工作树（prune 只在临时目录已删除时清元数据）。
  const worktrees = await git(repo, ["worktree", "list", "--porcelain"]);
  expect(worktrees.split("worktree ").length - 1).toBe(1);
}, 30_000);

test("task approve：red 通过/缺失/重复/跳过、非先红验收失败、回归失败均拒绝；存量失败豁免回归后可批准", async () => {
  const { repo } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  const ctx = context.ctx;
  await runCmd(fake, `task new ${slug}`, ctx);
  const contractFile = path.join(repo, ".cw", "tasks", taskId, "contract.toml");
  await writeFile(contractFile, contractToml({}));

  const check = (id: string, status: string, message = "boom") => ({ id, status, message });
  const cases: Array<{ name: string; payload: string; contract?: string; reason: string }> = [
    {
      name: "red 在基线通过",
      payload: JSON.stringify({ protocol: 1, run_id: "@RUN@", complete: true, checks: [check("red1", "pass"), check("keep", "pass"), check("reg1", "pass")], build: { required: false }, summary: "x", logs: [] }),
      reason: "先红项未以失败执行 red1（pass）",
    },
    {
      name: "red 缺失",
      payload: JSON.stringify({ protocol: 1, run_id: "@RUN@", complete: true, checks: [check("keep", "pass"), check("reg1", "pass")], build: { required: false }, summary: "x", logs: [] }),
      reason: "先红项缺失 red1",
    },
    {
      name: "red 重复",
      payload: JSON.stringify({ protocol: 1, run_id: "@RUN@", complete: true, checks: [check("red1", "fail"), check("red1", "fail"), check("keep", "pass"), check("reg1", "pass")], build: { required: false }, summary: "x", logs: [] }),
      reason: "拒绝",
    },
    {
      name: "red 跳过",
      payload: JSON.stringify({ protocol: 1, run_id: "@RUN@", complete: true, checks: [check("red1", "skip"), check("keep", "pass"), check("reg1", "pass")], build: { required: false }, summary: "x", logs: [] }),
      reason: "先红项未以失败执行 red1（skip）",
    },
    {
      name: "非先红验收失败",
      payload: JSON.stringify({ protocol: 1, run_id: "@RUN@", complete: true, checks: [check("red1", "fail"), check("keep", "fail"), check("reg1", "pass")], build: { required: false }, summary: "x", logs: [] }),
      reason: "非先红验收项未通过 keep",
    },
    {
      name: "回归失败",
      payload: JSON.stringify({ protocol: 1, run_id: "@RUN@", complete: true, checks: [check("red1", "fail"), check("keep", "pass"), check("reg1", "fail")], build: { required: false }, summary: "x", logs: [] }),
      reason: "回归项未通过 reg1",
    },
  ];
  for (const item of cases) {
    await writeFile(path.join(repo, ".cw", "project.toml"), projectToml(validatorArgv("reportrun", item.payload)));
    await runCmd(fake, "task approve", ctx);
    expect(lastNotify(context.notifications), item.name).toContain("拒绝");
    expect(lastNotify(context.notifications), item.name).toContain(item.reason);
    await expect(readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"), item.name)
      .rejects.toThrow();
    expect((await readState(repo, taskId)).status).toBe("drafting");
  }

  // 存量失败豁免 reg1 后，同样的回归失败可以批准。
  await writeFile(contractFile, contractToml({ approvedFailures: '{ id = "reg1", reason = "另开任务" }' }));
  await runCmd(fake, "task approve", ctx);
  expect(lastNotify(context.notifications)).toContain("已批准");
  expect((await readState(repo, taskId)).status).toBe("approved");
}, 30_000);

test("task approve：验证器无报告（undetermined）拒绝；无 UI 拒绝并提示交互模式；确认被拒不批准", async () => {
  const { repo } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  await runCmd(fake, `task new ${slug}`, context.ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({}));

  await writeFile(path.join(repo, ".cw", "project.toml"), projectToml(validatorArgv("none", "-")));
  await runCmd(fake, "task approve", context.ctx);
  expect(lastNotify(context.notifications)).toContain("先红检查运行无效");
  expect((await readState(repo, taskId)).status).toBe("drafting");

  await writeFile(path.join(repo, ".cw", "project.toml"), projectToml(validatorArgv("reportrun", redOkPayload)));
  const noUi = fakeCtx(repo, { hasUI: false });
  await runCmd(fake, "task approve", noUi.ctx);
  expect(lastNotify(noUi.notifications)).toContain("交互模式");
  expect(noUi.confirms).toHaveLength(0);
  expect((await readState(repo, taskId)).status).toBe("drafting");

  const declined = fakeCtx(repo, { hasUI: true, confirmResult: false });
  await runCmd(fake, "task approve", declined.ctx);
  expect(declined.confirms).toHaveLength(1);
  expect(lastNotify(declined.notifications)).toContain("未确认");
  expect((await readState(repo, taskId)).status).toBe("drafting");
  await expect(readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8")).rejects.toThrow();
}, 30_000);

test("非 code 交付物：跳过先红直接批准，red_check_run 0，无 UI 也可批准", async () => {
  const { repo } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: false });
  await runCmd(fake, `task new ${slug}`, context.ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({
    deliverable: "repro", acceptance: [], red: [], regression: [], frozen: [], baselineInputs: [],
  }));
  await runCmd(fake, "task approve", context.ctx);
  expect(lastNotify(context.notifications)).toContain("已批准");
  const approval = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"));
  expect(approval.red_check_run).toBe(0);
  expect((await readState(repo, taskId)).status).toBe("approved");
  expect(fake.sent).toHaveLength(1);
}, 30_000);

test("批准后修改 project.toml 验证命令：门禁仍使用批准时的命令", async () => {
  const { repo } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  await runCmd(fake, `task new ${slug}`, context.ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({}));
  await runCmd(fake, "task approve", context.ctx);

  // 换掉 project.toml 的验证命令（全通过 + 不同载荷）。
  const otherPayload = JSON.stringify({
    protocol: 1, run_id: "@RUN@", complete: true,
    checks: [
      { id: "red1", status: "pass" }, { id: "keep", status: "pass" }, { id: "reg1", status: "pass" },
    ],
    build: { required: false }, summary: "other-validator", logs: [],
  });
  await writeFile(path.join(repo, ".cw", "project.toml"), projectToml(validatorArgv("reportrun", otherPayload)));

  const settling = fake.call("agent_before_settle", settleEvent(), context.ctx);
  const result = await settling;
  // 门禁运行的是批准时的命令（red1 fail）→ continue，而不是新命令的 pass。
  expect(result?.continue).toBe(true);
  const message = (result?.entries ?? []).map((entry: any) =>
    typeof entry?.content === "string" ? entry.content : "").join("\n");
  expect(message).toContain("验收未通过");
  const state = await readState(repo, taskId);
  expect(state.repairs_used).toBe(1);
  expect(state.status).toBe("running");
  const run2 = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "runs", "2", "result.json"), "utf8"));
  expect(run2.checks.map((item: any) => item.id)).toContain("red1");
  expect(run2.checks.find((item: any) => item.id === "red1").status).toBe("fail");
}, 30_000);

test("task resume：登记会话、不重建基线、任务视图追加、保护生效；非 approved/running 拒绝", async () => {
  const { repo } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const first = fakeCtx(repo, { hasUI: true, confirmResult: true });
  await runCmd(fake, `task new ${slug}`, first.ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({}));
  await runCmd(fake, "task approve", first.ctx);
  await updateState(repo, taskId, "s1", (current) => ({
    ...current, repairs_used: 2, tokens_used: 1234,
  }));
  const stateBefore = await readState(repo, taskId);

  const second = fakeCtx(repo, { hasUI: true, session: "s2" });
  const sentBefore = fake.sent.length;
  await runCmd(fake, `task resume ${taskId}`, second.ctx);
  const state = await readState(repo, taskId);
  expect(state.sessions.sort()).toEqual(["s1", "s2"]);
  expect(state.repairs_used).toBe(2);
  expect(state.tokens_used).toBe(1234);
  expect(state.last_verified).toBe(stateBefore.last_verified);
  expect(fake.sent.length).toBe(sentBefore + 1);
  expect(fake.sent.at(-1)!.options).toEqual({ triggerTurn: false });
  const blocked = await fake.call("tool_call", toolCallEvent("edit", {
    path: `.cw/tasks/${taskId}/contract.toml`, edits: [],
  }), second.ctx);
  expect(blocked).toMatchObject({ block: true });

  // drafting 任务不能 resume。
  await runCmd(fake, "task new second-fix", second.ctx);
  const secondId = `${ymd()}-second-fix`;
  await runCmd(fake, `task resume ${secondId}`, second.ctx);
  expect(lastNotify(second.notifications)).toContain("drafting");
  expect(lastNotify(second.notifications)).toContain("approved/running");
}, 30_000);

test("task status：显示状态、预算、最后验证与冲突", async () => {
  const { repo } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  await runCmd(fake, `task new ${slug}`, context.ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({}));
  await runCmd(fake, "task status", context.ctx);
  let text = lastNotify(context.notifications);
  expect(text).toContain("状态：drafting");
  expect(text).toContain("批准：未批准");
  expect(text).toContain("修复 0/3");

  await runCmd(fake, "task approve", context.ctx);
  // 注入一处冻结冲突与验证记录：期望哈希取自篡改前的内容。
  const expectedBlob = (await blobHash(repo, "tests/a.py")).value!;
  await writeFile(path.join(repo, "tests", "a.py"), "tampered\n");
  await checkFrozen(repo, taskId, "s1", { "tests/a.py": expectedBlob });
  await runCmd(fake, "task status", context.ctx);
  text = lastNotify(context.notifications);
  expect(text).toContain("状态：approved");
  expect(text).toContain("先红 run 1");
  expect(text).toContain("冻结冲突：1 处");
  expect(text).toContain("tests/a.py");
}, 30_000);

test("task cancel：终止在途验证并取消任务；其后门禁不动作", async () => {
  const { repo } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  await runCmd(fake, `task new ${slug}`, context.ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({}));
  await runCmd(fake, "task approve", context.ctx);

  // 把批准记录的验证器换成 hang 模式，制造在途验证。
  const approvalFile = path.join(repo, ".cw", "tasks", taskId, "approval.json");
  const approval = JSON.parse(await readFile(approvalFile, "utf8"));
  approval.validator = { cmd: ["/bin/sh", fixture, "hang"], timeout_s: 600, env: {} };
  await writeFile(approvalFile, `${JSON.stringify(approval, null, 2)}\n`);

  const started = await startAdapter(repo);
  const settling = started.fake.call("agent_before_settle", settleEvent(), started.ctx);
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

  await runCmd(started.fake, "task cancel", started.ctx);
  expect(lastNotify(started.notifications)).toContain("已取消");
  const state = await readState(repo, taskId);
  expect(state.status).toBe("cancelled");

  const settleResult = await settling;
  expect(settleResult ?? null).toBeNull();
  expect(() => process.kill(pid!, 0)).toThrow();

  // 取消后门禁不再动作。
  const second = await started.fake.call("agent_before_settle", settleEvent(), started.ctx);
  expect(second ?? null).toBeNull();
  expect((await readState(repo, taskId)).status).toBe("cancelled");
}, 40_000);

test("批准的提议：重批前 gate 阻塞交还，重批原子消费后 gate 继续；后来 pending 仍阻塞", async () => {
  const { repo } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  const ctx = context.ctx;
  await runCmd(fake, `task new ${slug}`, ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({}));
  await runCmd(fake, "task approve", ctx);

  // 用户经 propose_contract_change 批准的契约变更（status approved）。
  await writeProposal(repo, taskId, "s1", {
    field: "goal", new_value: "changed", reason: "契约目标写错", status: "approved",
  });
  const runsDir = path.join(repo, ".cw", "tasks", taskId, "runs");

  // 重批前：gate 因未消费提议直接交还，不运行验证；提议细节在交还材料问题中。
  const settled1 = await fake.call("agent_before_settle", settleEvent(), ctx);
  const message1 = (settled1?.entries ?? []).map((entry: any) =>
    typeof entry?.content === "string" ? entry.content : "").join("\n");
  expect(message1).toContain("原因：blocked");
  const material1 = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "handback.json"), "utf8"));
  expect(material1.questions.join("\n")).toContain("契约变更提议");
  expect((await readdir(runsDir)).sort()).toEqual(["1"]);
  expect((await readState(repo, taskId)).status).toBe("handed_back");

  // 契约未采纳提议（goal 改成了别的值）：重批被拒，提议不消费，批准记录保持第一轮。
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"),
    contractToml({ goal: "different" }));
  await runCmd(fake, "task approve", ctx);
  expect(lastNotify(context.notifications)).toContain("未在当前契约采纳");
  const untouched = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "proposals", "1.json"), "utf8"));
  expect(untouched.status).toBe("approved");
  const onDisk = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"));
  expect(onDisk.red_check_run).toBe(1);
  // 用户把契约改到与提议一致：重批成功，提议被原子消费并绑定新契约版本。
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"),
    contractToml({ goal: "changed" }));
  await runCmd(fake, "task approve", ctx);
  const approval = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"));
  expect(approval.red_check_run).toBe(3);
  const proposal = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "proposals", "1.json"), "utf8"));
  expect(proposal.status).toBe("consumed");
  expect(proposal.resolved_in_contract_sha256).toBe(approval.contract_sha256);
  expect(proposal.resolved_at).toBeTruthy();

  // 重批后：提议不再阻塞，gate 实际运行验证器（批准命令下 red1 fail → continue）。
  const settled2 = await fake.call("agent_before_settle", settleEvent(), ctx);
  expect(settled2?.continue).toBe(true);
  const message2 = (settled2?.entries ?? []).map((entry: any) =>
    typeof entry?.content === "string" ? entry.content : "").join("\n");
  expect(message2).toContain("验收未通过");
  expect((await readdir(runsDir)).sort()).toEqual(["1", "2", "3", "4"]);

  // 后来产生的 pending 提议不被清除，继续阻塞；已消费提议保持消费态。
  await writeProposal(repo, taskId, "s1", {
    field: "tier", new_value: "script", reason: "任务变小了", status: "pending",
  });
  const settled3 = await fake.call("agent_before_settle", settleEvent(), ctx);
  const message3 = (settled3?.entries ?? []).map((entry: any) =>
    typeof entry?.content === "string" ? entry.content : "").join("\n");
  expect(message3).toContain("原因：blocked");
  const material3 = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "handback.json"), "utf8"));
  expect(material3.questions.join("\n")).toContain("proposals/2.json");
  const pending = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "proposals", "2.json"), "utf8"));
  expect(pending.status).toBe("pending");
  const consumed = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "proposals", "1.json"), "utf8"));
  expect(consumed.status).toBe("consumed");
}, 30_000);

test("task handback 其他任务：active 任务保护保留", async () => {
  const { repo, base } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  const ctx = context.ctx;
  await runCmd(fake, `task new ${slug}`, ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({}));
  await runCmd(fake, "task approve", ctx);

  // 直接构造第二个已批准任务 B（fixture 方式，不走命令）。
  const idB = `${ymd()}-second-fix`;
  await createTask(repo, idB, "unassigned", base);
  await writeFile(path.join(repo, ".cw", "tasks", idB, "contract.toml"), contractToml({})
    .replace(`task_id = "${taskId}"`, `task_id = "${idB}"`));
  await writeFile(path.join(repo, ".cw", "tasks", idB, "approval.json"), `${JSON.stringify({
    version: 1,
    contract_sha256: "1".repeat(64),
    project_config_sha256: "1".repeat(64),
    validator: { cmd: ["/bin/true"], timeout_s: 600, env: {} },
    base_commit: base,
    baseline_inputs_sha256: {},
    frozen_blobs: {},
    red_check_run: 0,
    approved_at: new Date().toISOString(),
  }, null, 2)}\n`);
  await updateState(repo, idB, "s1", (current) => ({ ...current, status: "approved" }));

  // 交还 B：A 仍是本会话 active，保护不得解除。
  await runCmd(fake, `task handback ${idB}`, ctx);
  expect((await readState(repo, idB)).status).toBe("handed_back");
  expect((await readState(repo, taskId)).status).toBe("approved");
  const stillBlocked = await fake.call("tool_call", toolCallEvent("write", {
    path: `.cw/tasks/${taskId}/contract.toml`, content: "x",
  }), ctx);
  expect(stillBlocked).toMatchObject({ block: true });

  // 无参交还命中唯一 approved 的 A：此时才解除本会话保护。
  await runCmd(fake, "task handback", ctx);
  expect((await readState(repo, taskId)).status).toBe("handed_back");
  const unblocked = await fake.call("tool_call", toolCallEvent("write", {
    path: `.cw/tasks/${taskId}/contract.toml`, content: "x",
  }), ctx);
  expect(unblocked ?? null).toBeNull();
}, 30_000);

test("契约 task_id 与任务目录不一致：approve 明确拒绝", async () => {
  const { repo } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  await runCmd(fake, `task new ${slug}`, context.ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({})
    .replace(`task_id = "${taskId}"`, 'task_id = "20260101-other-fix"'));
  await runCmd(fake, "task approve", context.ctx);
  expect(lastNotify(context.notifications)).toContain("task_id mismatch");
  await expect(readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"))
    .rejects.toThrow();
  expect((await readState(repo, taskId)).status).toBe("drafting");
}, 30_000);

test("task handback：生成材料并置 handed_back；契约修订后可重新批准且 base_commit 不变", async () => {
  const { repo, base } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  await runCmd(fake, `task new ${slug}`, context.ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({}));
  await runCmd(fake, "task approve", context.ctx);

  await runCmd(fake, "task handback", context.ctx);
  expect(lastNotify(context.notifications)).toContain("已手动交还");
  const handback = await readFile(path.join(repo, ".cw", "tasks", taskId, "handback.md"), "utf8");
  expect(handback).toContain("用户手动交还");
  expect((await readState(repo, taskId)).status).toBe("handed_back");
  // 本会话不再受管：契约文件不再被 block。
  const unblocked = await fake.call("tool_call", toolCallEvent("write", {
    path: `.cw/tasks/${taskId}/contract.toml`, content: "x",
  }), context.ctx);
  expect(unblocked ?? null).toBeNull();

  // 用户修订契约后重新批准：先红重跑（run 2），base_commit 不变。
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({
    goal: "revised goal",
  }));
  await runCmd(fake, "task approve", context.ctx);
  const approval = JSON.parse(
    await readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"));
  expect(approval.red_check_run).toBe(2);
  expect(approval.base_commit).toBe(base);
  expect((await readState(repo, taskId)).status).toBe("approved");
  const blocked = await fake.call("tool_call", toolCallEvent("write", {
    path: `.cw/tasks/${taskId}/contract.toml`, content: "x",
  }), context.ctx);
  expect(blocked).toMatchObject({ block: true });
}, 30_000);

test("批准期间取消：确认对话框等待时 /cw task cancel → 批准拒绝且不写任何记录", async () => {
  const { repo } = await setup();
  const fake = fakePi();
  counterweight(fake.pi);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true, confirmGate: gate });
  const ctx = context.ctx;
  await runCmd(fake, `task new ${slug}`, ctx);
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), contractToml({}));

  const approving = runCmd(fake, "task approve", ctx);
  const deadline = Date.now() + 10_000;
  while (context.confirms.length === 0 && Date.now() < deadline) {
    await delay(5);
  }
  expect(context.confirms.length).toBe(1);

  // 确认等待期间取消：验证槽中的批准 controller 被中止。
  await runCmd(fake, "task cancel", ctx);
  release();
  await approving;

  expect(lastNotify(context.notifications)).toContain("取消");
  await expect(readFile(path.join(repo, ".cw", "tasks", taskId, "approval.json"), "utf8"))
    .rejects.toThrow();
  expect((await readState(repo, taskId)).status).toBe("cancelled");
  expect(fake.sent).toHaveLength(0);
  const worktrees = await git(repo, ["worktree", "list", "--porcelain"]);
  expect(worktrees.split("worktree ").length - 1).toBe(1);
}, 30_000);
