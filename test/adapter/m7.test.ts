import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import counterweight, { type AdapterTimeouts } from "../../src/adapters/pi/index.ts";
import { contractSha256, readContract } from "../../src/core/contract.ts";
import { contentSha256 } from "../../src/core/evidence.ts";
import { escalationWorktreePath } from "../../src/core/escalate.ts";
import { blobHash } from "../../src/core/gitstate.ts";
import { acquireLock, createTask, findSessionTasks, readReference, readState, updateState, type Approval } from "../../src/core/task.ts";
import type { TaskState } from "../../src/core/types.ts";

const fixture = path.join(import.meta.dirname, "../fixtures/validators/fake.sh");
const ymd = () => {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
};
const taskId = `${ymd()}-lifetime-fix`;

type Handler = (event: any, ctx: any) => any;

interface PiCall { method: string; phase: number }

function fakePi(options: { setModelFn?: (model: { provider: string; id: string }) => boolean } = {}): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  commands: Map<string, { description?: string; handler: Handler }>;
  sent: Array<{ message: { customType: string; content: string; display: boolean }; options?: { triggerTurn?: boolean } }>;
  setModels: Array<{ provider: string; id: string }>;
  call: (name: string, event: unknown, ctx: ExtensionContext) => Promise<any>;
} {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description?: string; handler: Handler }>();
  const sent: Array<{ message: any; options?: any }> = [];
  const setModels: Array<{ provider: string; id: string }> = [];
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
    setModel: async (model: { provider: string; id: string }) => {
      setModels.push(model);
      return options.setModelFn ? options.setModelFn(model) : true;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    handlers,
    commands,
    sent,
    setModels,
    call: async (name, event, ctx) => {
      const list = handlers.get(name) ?? [];
      if (list.length === 0) throw new Error(`no handler registered for ${name}`);
      return list.at(-1)!(event, ctx);
    },
  };
}

/** A proxy that records EVERY method call the adapter makes on `pi`. */
function recordingPi(base: ReturnType<typeof fakePi>, phase: () => number): {
  pi: ExtensionAPI;
  calls: PiCall[];
} {
  const calls: PiCall[] = [];
  const pi = new Proxy(base.pi, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), phase: phase() });
          return Reflect.apply(value, target, args);
        };
      }
      return value;
    },
  });
  return { pi: pi as ExtensionAPI, calls };
}

interface CtxOptions {
  hasUI?: boolean;
  confirmResult?: boolean;
  session?: string;
  /** The session's current model (`ctx.model`), for model-restore assertions. */
  currentModel?: { provider: string; id: string };
  /** Registry entries that resolve to undefined (model adoption failure). */
  missingModels?: string[];
  /** Make the replaced session's sendMessage throw (late withSession failure). */
  failSendMessage?: boolean;
  newSession?: (options: { withSession?: (c: ExtensionContext) => Promise<void> }) => Promise<{ cancelled: boolean }>;
}

function fakeCtx(repo: string, options: CtxOptions = {}) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const replacedSent: Array<{ message: { content: string } }> = [];
  const registry = {
    find: (provider: string, id: string) =>
      options.missingModels?.includes(id) ? undefined : { provider, id },
  };
  const ctx = {
    cwd: repo,
    mode: (options.hasUI ?? false) ? "tui" : "print",
    hasUI: options.hasUI ?? false,
    model: options.currentModel,
    modelRegistry: registry,
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      confirm: async (_title: string, _message: string) => options.confirmResult ?? false,
    },
    sessionManager: { getSessionId: () => options.session ?? "s1" },
    signal: undefined,
    waitForIdle: async () => undefined,
    newSession: options.newSession,
    sendMessage: (message: any, opts?: any) => {
      if (options.failSendMessage) throw new Error("sendMessage failed");
      replacedSent.push({ message });
    },
  };
  return {
    ctx: ctx as unknown as ExtensionContext,
    notifications,
    replacedSent,
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

async function runCmd(fake: ReturnType<typeof fakePi>, args: string, ctx: ExtensionContext): Promise<void> {
  const command = fake.commands.get("cw");
  if (command === undefined) throw new Error("/cw not registered");
  await command.handler(args, ctx);
}

const lastNotify = (notifications: Array<{ message: string }>) => notifications.at(-1)?.message ?? "";

/** Any notification carrying `text` — notify order varies with takeovers. */
const anyNotify = (notifications: Array<{ message: string }>, text: string) =>
  notifications.some((entry) => entry.message.includes(text));

const settleEvent = () => ({
  type: "agent_before_settle",
  entries: [],
  continue: false,
  outcome: "completed",
  context: { canContinue: true },
});

const report = (checks: Array<{ id: string; status: string; message?: string }>) =>
  JSON.stringify({ protocol: 1, run_id: "@RUN@", complete: true, checks, build: { required: false }, summary: "x", logs: [] });

const contractText = (id: string) => `version = 1
task_id = "${id}"
tier = "change"
deliverable = "code"
goal = "fix lifetime issue"
acceptance = ["keep"]
red = ["keep"]
regression = []
frozen = ["tests/a.py"]
baseline_inputs = ["tests/a.py"]
`;

interface Setup {
  repo: string;
  base: string;
  payloadFile: string;
  writePayload: (checks: Array<{ id: string; status: string; message?: string }>) => Promise<void>;
  writeContract: (id: string) => Promise<void>;
  setState: (change: (state: TaskState) => TaskState, session?: string) => Promise<void>;
}

/**
 * A repo whose validator reads the verdict from `<repo>/payload.json`, so a
 * test can change it between gate rounds without touching the approved
 * command. With `approved` (default) the task is already approved; with
 * `approved: false` the task is created by the `/cw task new` command itself.
 */
async function setup(options: { approved?: boolean } = {}): Promise<Setup> {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-m7a-"));
  await git(repo, ["init"]);
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await writeFile(path.join(repo, "tests", "a.py"), "base\n");
  await git(repo, ["add", "tracked.txt", "tests/a.py"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await mkdir(path.join(repo, ".cw"), { recursive: true });
  // The verdict payload lives under `.cw/` (excluded from clean checks and
  // tree hashes), so rewriting it between gate rounds keeps the tree clean.
  const payloadFile = path.join(repo, ".cw", "payload.json");
  await writeFile(path.join(repo, ".cw", "project.toml"), `version = 1

[validator]
cmd = ["/bin/sh", "${fixture}", "reportfile", "${payloadFile}"]
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
`);
  const writeContract = async (id: string) => {
    await writeFile(path.join(repo, ".cw", "tasks", id, "contract.toml"), contractText(id));
  };
  const writePayload = async (checks: Array<{ id: string; status: string; message?: string }>) => {
    await writeFile(payloadFile, `${report(checks)}\n`);
  };
  if (options.approved === false) {
    return {
      repo, base, payloadFile, writePayload, writeContract,
      setState: (change, session = "s1") => updateState(repo, taskId, session, change),
    };
  }
  await createTask(repo, taskId, "g/medium", base);
  await writeContract(taskId);
  const approval: Approval = {
    version: 1,
    contract_sha256: contractSha256(await readContract(
      path.join(repo, ".cw", "tasks", taskId, "contract.toml"), repo, taskId)),
    project_config_sha256: "0".repeat(64),
    validator: { cmd: ["/bin/sh", fixture, "reportfile", payloadFile], timeout_s: 600, env: {} },
    base_commit: base,
    baseline_inputs_sha256: { "tests/a.py": (await contentSha256(repo, "tests/a.py"))! },
    frozen_blobs: { "tests/a.py": (await blobHash(repo, "tests/a.py")).value! },
    red_check_run: 1,
    approved_at: new Date().toISOString(),
  };
  await writeFile(
    path.join(repo, ".cw", "tasks", taskId, "approval.json"),
    `${JSON.stringify(approval, null, 2)}\n`);
  await updateState(repo, taskId, "s1", (state) => ({ ...state, status: "approved", sessions: ["s1"] }));
  return {
    repo, base, payloadFile, writeContract, writePayload,
    setState: (change, session = "s1") => updateState(repo, taskId, session, change),
  };
}

async function startAdapter(
  repo: string, timeouts?: Partial<AdapterTimeouts>,
  fakeOptions?: { setModelFn?: (model: { provider: string; id: string }) => boolean },
) {
  const fake = fakePi(fakeOptions);
  counterweight(fake.pi, timeouts);
  const context = fakeCtx(repo);
  await fake.call("session_start", { type: "session_start", reason: "startup" }, context.ctx);
  return { fake, ...context };
}

/** Meter events of a task, parsed from meter.jsonl (empty when absent). */
async function meterEvents(repo: string, id: string): Promise<string[]> {
  try {
    const text = await readFile(path.join(repo, ".cw", "tasks", id, "meter.jsonl"), "utf8");
    return text.trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.kind === "task")
      .map((line) => line.event as string);
  } catch {
    return [];
  }
}

const worktreeOf = async (repo: string) =>
  escalationWorktreePath(await realpath(repo), taskId);

// ---- task new: tier model selection ----------------------------------------

test("task new 按 tiers/models 选定模型写入 state.model", async () => {
  const { repo } = await setup({ approved: false });
  const { fake, ctx, notifications } = await startAdapter(repo);

  await runCmd(fake, "task new model-fix --tier script", ctx);
  expect(lastNotify(notifications)).toContain("g/cheap");
  expect((await readState(repo, `${ymd()}-model-fix`)).model).toBe("g/cheap");
  expect((await readState(repo, `${ymd()}-model-fix`)).status).toBe("drafting");

  await runCmd(fake, "task new second-fix --tier interface", ctx);
  expect((await readState(repo, `${ymd()}-second-fix`)).model).toBe("g/strong");
}, 20_000);

// ---- cache discipline ------------------------------------------------------

test("缓存纪律：完整模拟任务记录所有 pi 调用；首轮后不切模型/工具/提示，无主动消息；meter 每行可解析", async () => {
  const s = await setup({ approved: false });
  const flowId = `${ymd()}-flow-fix`;
  // 起点先红：红检查在基线上看到 keep 失败。
  await s.writePayload([{ id: "keep", status: "fail", message: "AssertionError: owner alive" }]);

  let phase = 0;
  const base = fakePi();
  const { pi, calls } = recordingPi(base, () => phase);
  counterweight(pi);
  const context = fakeCtx(s.repo, { hasUI: true, confirmResult: true, session: "s1" });
  const ctx = context.ctx;
  const call = async (name: string, event: unknown) => {
    const list = base.handlers.get(name) ?? [];
    return list.at(-1)!(event, ctx);
  };

  phase = 1; // session_start：尚无任务
  await call("session_start", { type: "session_start", reason: "startup" });
  phase = 2; // task new
  await runCmd(base, `task new flow-fix --tier change`, ctx);
  await s.writeContract(flowId);
  phase = 3; // approve：唯一允许的模型设置点与任务视图
  await runCmd(base, "task approve", ctx);

  let state = await readState(s.repo, flowId);
  expect(state.status).toBe("approved");
  expect(state.model).toBe("g/medium");

  phase = 4; // 第一轮：fail → continue（repairs 1）
  const settle1 = await call("agent_before_settle", settleEvent());
  expect(settle1).toMatchObject({ continue: true });
  state = await readState(s.repo, flowId);
  expect(state.repairs_used).toBe(1);
  expect(state.model).toBe("g/medium");

  phase = 5; // 模型继续工作（usage 上账）
  await call("message_end", {
    type: "message_end",
    message: {
      role: "assistant", model: "g/medium",
      usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 155 },
    },
  });

  phase = 6; // 第二轮：改 payload → pass → finish
  await writeFile(s.payloadFile, `${report([{ id: "keep", status: "pass" }])}\n`);
  const settle2 = await call("agent_before_settle", settleEvent());
  expect(settle2?.entries?.at(-1)?.content).toContain("验收通过");
  state = await readState(s.repo, flowId);
  expect(state.status).toBe("verified");
  expect(state.model).toBe("g/medium");

  // 全部 pi 调用都在允许集合内；模型只在批准时设置一次；
  // 除批准任务视图外没有主动发送消息；门禁轮次（4–6）零 pi 调用。
  const allowed = new Set(["on", "registerTool", "registerCommand", "sendMessage", "setModel"]);
  expect(calls.filter((entry) => !allowed.has(entry.method)).map((entry) => entry.method)).toEqual([]);
  expect(calls.filter((entry) => entry.method === "setModel")).toEqual([{ method: "setModel", phase: 3 }]);
  expect(calls.filter((entry) => entry.method === "sendMessage")).toEqual([{ method: "sendMessage", phase: 3 }]);
  expect(base.sent[0]!.message.content).toContain("已批准");
  expect(calls.filter((entry) => entry.phase >= 4)).toEqual([]);

  // meter.jsonl：每行可解析，usage 合计与 tokens_used 一致，事件齐全。
  const lines = (await readFile(path.join(s.repo, ".cw", "tasks", flowId, "meter.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const usage = lines.filter((line) => line.kind === "usage") as Array<
    { input: number; output: number; cache_read: number; cache_write: number }>;
  expect(usage.length).toBeGreaterThan(0);
  const total = usage.reduce((sum, item) =>
    sum + item.input + item.output + item.cache_read + item.cache_write, 0);
  expect(total).toBe(state.tokens_used);
  const events = lines.filter((line) => line.kind === "task").map((line) => line.event);
  for (const expected of ["task_created", "approved", "validation_started", "validation_finished", "finish"]) {
    expect(events).toContain(expected);
  }
  expect(events).not.toContain("escalated");
}, 30_000);

// ---- escalate --from current ----------------------------------------------

test("escalate --from current：同账本替换会话，strong 模型，笔记进任务视图，计数不清零", async () => {
  const s = await setup();
  await s.writePayload([{ id: "keep", status: "pass" }]);
  await s.setState((state) => ({ ...state, status: "running", repairs_used: 2, tokens_used: 500 }));
  await writeFile(path.join(s.repo, ".cw", "tasks", taskId, "notes.md"),
    "# 尝试过的方向\n方向A：已排除\n\n# 建议的下一轮\n下一轮先看 B\n");
  let newSessionCalls = 0;
  let replaced: ReturnType<typeof fakeCtx> | null = null;
  const { fake, notifications } = await startAdapter(s.repo);
  const context = fakeCtx(s.repo, {
    session: "s1",
    newSession: async (options) => {
      newSessionCalls++;
      replaced = fakeCtx(s.repo, { session: "s2" });
      if (options.withSession) await options.withSession(replaced.ctx);
      return { cancelled: false };
    },
  });
  await runCmd(fake, "task escalate --from current", context.ctx);

  expect(newSessionCalls).toBe(1);
  const state = await readState(s.repo, taskId);
  expect(state.model).toBe("g/strong");
  expect(state.sessions).toEqual(["s2"]);
  expect(state.repairs_used).toBe(2);
  expect(state.tokens_used).toBe(500);
  expect(state.status).toBe("running");
  const material = JSON.parse(await readFile(
    path.join(s.repo, ".cw", "tasks", taskId, "handback.json"), "utf8"));
  expect(material.reason).toBe("escalated");
  // 任务视图带着前一模型的笔记发到新会话。
  expect(replaced!.replacedSent).toHaveLength(1);
  expect(replaced!.replacedSent[0]!.message.content).toContain("前一模型的笔记，未经验证");
  expect(replaced!.replacedSent[0]!.message.content).toContain("方向A：已排除");
  // 新会话采用了 strong 模型（启动时接管是 medium，切换是 strong）。
  expect(fake.setModels.at(-1)).toEqual({ provider: "g", id: "strong" });
  expect(fake.setModels.filter((model) => model.id === "strong")).toHaveLength(1);
  expect(lastNotify(replaced!.notifications)).toContain("已切换到升级会话");
  // 没有创建升级 worktree。
  expect(existsSync(await worktreeOf(s.repo))).toBe(false);
}, 20_000);

test("escalate --from current 会话替换被取消：任务保持原状，无升级材料与事件", async () => {
  const s = await setup();
  const { fake } = await startAdapter(s.repo);
  const context = fakeCtx(s.repo, {
    session: "s1",
    newSession: async () => ({ cancelled: true }),
  });
  await runCmd(fake, "task escalate --from current", context.ctx);
  expect(anyNotify(context.notifications, "升级未完成")).toBe(true);
  const state = await readState(s.repo, taskId);
  expect(state.model).toBe("g/medium");
  expect(state.sessions).toEqual(["s1"]);
  // 取消后不得留下宣称升级成功的材料/事件。
  expect(existsSync(path.join(s.repo, ".cw", "tasks", taskId, "handback.json"))).toBe(false);
  expect(await meterEvents(s.repo, taskId)).not.toContain("escalated");
  expect(await meterEvents(s.repo, taskId)).not.toContain("escalate_target");
  expect(fake.setModels.filter((model) => model.id === "strong")).toEqual([]);
}, 20_000);

test("escalate --from current withSession 晚段失败：账本持锁回滚、模型恢复，零材料零事件", async () => {
  const s = await setup();
  await s.setState((state) => ({ ...state, status: "running", repairs_used: 2, tokens_used: 500 }));
  const { fake } = await startAdapter(s.repo);
  let replaced: ReturnType<typeof fakeCtx> | null = null;
  const context = fakeCtx(s.repo, {
    session: "s1",
    currentModel: { provider: "g", id: "medium" },
    newSession: async (options) => {
      replaced = fakeCtx(s.repo, { session: "s2", failSendMessage: true });
      if (options.withSession) await options.withSession(replaced.ctx);
      return { cancelled: false };
    },
  });
  await runCmd(fake, "task escalate --from current", context.ctx);
  // 失败报告走替换后的有效 ctx（旧 ctx 已失效），不二次抛错。
  expect(anyNotify(replaced!.notifications, "升级未完成")).toBe(true);
  expect(anyNotify(replaced!.notifications, "sendMessage failed")).toBe(true);
  // 账本回滚：模型、登记会话、计数全部保持原状。
  const state = await readState(s.repo, taskId);
  expect(state.model).toBe("g/medium");
  expect(state.sessions).toEqual(["s1"]);
  expect(state.repairs_used).toBe(2);
  expect(state.tokens_used).toBe(500);
  // 幸存会话的模型也被恢复：setModel 序列 = 接管 medium → 切 strong → 恢复 medium。
  expect(fake.setModels).toEqual([
    { provider: "g", id: "medium" },
    { provider: "g", id: "strong" },
    { provider: "g", id: "medium" },
  ]);
  expect(anyNotify(replaced!.notifications, "会话模型已恢复")).toBe(true);
  // 绝不出现成功伪消息（成功通知已移到全部可失败步骤之后）。
  expect(replaced!.notifications.some((entry) => entry.message.includes("已切换到升级会话"))).toBe(false);
  // 无假成功材料/事件。
  expect(existsSync(path.join(s.repo, ".cw", "tasks", taskId, "handback.json"))).toBe(false);
  expect(await meterEvents(s.repo, taskId)).not.toContain("escalated");
  expect(await meterEvents(s.repo, taskId)).not.toContain("escalate_target");
  expect(replaced!.replacedSent).toEqual([]);
}, 20_000);

test("escalate --from current 模型恢复失败：明确报告仍为 strong，不宣称原状", async () => {
  const s = await setup();
  await s.setState((state) => ({ ...state, status: "running" }));
  // strong 能切上，但恢复 medium 时 setModel 返回 false（认证缺失）。
  const { fake } = await startAdapter(s.repo, undefined, {
    setModelFn: (model) => model.id !== "medium",
  });
  let replaced: ReturnType<typeof fakeCtx> | null = null;
  const context = fakeCtx(s.repo, {
    session: "s1",
    currentModel: { provider: "g", id: "medium" },
    newSession: async (options) => {
      replaced = fakeCtx(s.repo, { session: "s2", failSendMessage: true });
      if (options.withSession) await options.withSession(replaced.ctx);
      return { cancelled: false };
    },
  });
  await runCmd(fake, "task escalate --from current", context.ctx);
  // 恢复被尝试过且失败经有效 ctx 明确报告，不宣称完全原状。
  expect(fake.setModels.at(-1)).toEqual({ provider: "g", id: "medium" });
  expect(anyNotify(replaced!.notifications, "升级未完成")).toBe(true);
  expect(anyNotify(replaced!.notifications, "模型恢复未生效")).toBe(true);
  expect(anyNotify(replaced!.notifications, "仍为 g/strong")).toBe(true);
  expect(replaced!.notifications.some((entry) => entry.message.includes("已切换到升级会话"))).toBe(false);
  const state = await readState(s.repo, taskId);
  expect(state.model).toBe("g/medium");
  expect(state.sessions).toEqual(["s1"]);
  expect(existsSync(path.join(s.repo, ".cw", "tasks", taskId, "handback.json"))).toBe(false);
  expect(await meterEvents(s.repo, taskId)).not.toContain("escalated");
}, 20_000);

test("escalate --from current 模型接管失败：账本从未被改，零材料零事件", async () => {
  const s = await setup();
  await s.setState((state) => ({ ...state, status: "running", repairs_used: 1, tokens_used: 100 }));
  const { fake } = await startAdapter(s.repo);
  let replaced: ReturnType<typeof fakeCtx> | null = null;
  const context = fakeCtx(s.repo, {
    session: "s1",
    newSession: async (options) => {
      replaced = fakeCtx(s.repo, { session: "s2", missingModels: ["strong"] });
      if (options.withSession) await options.withSession(replaced.ctx);
      return { cancelled: false };
    },
  });
  await runCmd(fake, "task escalate --from current", context.ctx);
  expect(anyNotify(replaced!.notifications, "升级未完成")).toBe(true);
  expect(anyNotify(replaced!.notifications, "不在模型注册表中")).toBe(true);
  expect(anyNotify(replaced!.notifications, "会话模型未改动")).toBe(true);
  const state = await readState(s.repo, taskId);
  expect(state.model).toBe("g/medium");
  expect(state.sessions).toEqual(["s1"]);
  expect(state.repairs_used).toBe(1);
  expect(state.tokens_used).toBe(100);
  expect(existsSync(path.join(s.repo, ".cw", "tasks", taskId, "handback.json"))).toBe(false);
  expect(await meterEvents(s.repo, taskId)).not.toContain("escalated");
  expect(await meterEvents(s.repo, taskId)).not.toContain("escalate_target");
  expect(fake.setModels.filter((model) => model.id === "strong")).toEqual([]);
}, 20_000);

// ---- escalate --from base --------------------------------------------------

test("escalate --from base：worktree、账本引用、释放原会话；无 cwd 不伪造成功，报告手动步骤", async () => {
  const s = await setup();
  await s.setState((state) => ({ ...state, status: "running", repairs_used: 1, tokens_used: 300 }));
  const { fake } = await startAdapter(s.repo);
  let newSessionCalls = 0;
  const context = fakeCtx(s.repo, {
    session: "s1",
    newSession: async () => {
      newSessionCalls++;
      return { cancelled: false };
    },
  });
  await runCmd(fake, "task escalate --from base", context.ctx);

  expect(newSessionCalls).toBe(0);
  const worktree = await worktreeOf(s.repo);
  expect(existsSync(worktree)).toBe(true);
  // worktree 来自 base_commit，输入与批准一致，原工作树未动。
  expect((await git(worktree, ["rev-parse", "HEAD"])).trim()).toBe(s.base);
  expect(await readFile(path.join(worktree, "tests", "a.py"), "utf8")).toBe("base\n");
  expect(await readFile(path.join(s.repo, "tracked.txt"), "utf8")).toBe("base\n");
  const reference = await readReference(path.join(worktree, ".cw", "task.json"));
  expect(reference.task_id).toBe(taskId);
  expect(reference.path).toBe(path.join(await realpath(s.repo), ".cw", "tasks", taskId));
  // 权威账本：模型切 strong、原会话释放、计数不清零；账本只有一份。
  const state = await readState(s.repo, taskId);
  expect(state.model).toBe("g/strong");
  expect(state.sessions).toEqual([]);
  expect(state.repairs_used).toBe(1);
  expect(state.tokens_used).toBe(300);
  expect(state.status).toBe("running");
  expect(existsSync(path.join(worktree, ".cw", "tasks"))).toBe(false);
  const material = JSON.parse(await readFile(
    path.join(s.repo, ".cw", "tasks", taskId, "handback.json"), "utf8"));
  // base 降级不宣称升级成功：材料是"待手动交接"。
  expect(material.reason).toBe("escalate_pending");
  expect(material.questions.join(" ")).toContain(worktree);
  // 报告是明确的操作指引，不宣称升级已完成。
  expect(anyNotify(context.notifications, worktree)).toBe(true);
  expect(anyNotify(context.notifications, `/cw task resume ${taskId}`)).toBe(true);
  expect(anyNotify(context.notifications, "g/strong")).toBe(true);
  const meter = (await readFile(path.join(s.repo, ".cw", "tasks", taskId, "meter.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const target = meter.find((line) => line.event === "escalate_target") as
    { detail: { mode: string; worktree: string; model: string } } | undefined;
  expect(target?.detail).toMatchObject({ mode: "base", worktree, model: "g/strong" });
  expect(meter.map((line) => line.event)).toContain("escalate_pending");
  expect(meter.map((line) => line.event)).not.toContain("escalated");
  // 基础升级不会在本进程切模型（没有新会话可设）。
  expect(fake.setModels.filter((model) => model.id === "strong")).toEqual([]);

  await rm(worktree, { recursive: true, force: true });
  await git(s.repo, ["worktree", "prune"]);
}, 20_000);

test("escalate --from base 输入漂移：拒绝且零残留", async () => {
  const s = await setup();
  await writeFile(path.join(s.repo, "tests", "a.py"), "drifted\n");
  const { fake } = await startAdapter(s.repo);
  const context = fakeCtx(s.repo);
  await runCmd(fake, "task escalate --from base", context.ctx);
  expect(anyNotify(context.notifications, "与批准版本不一致")).toBe(true);
  expect(existsSync(await worktreeOf(s.repo))).toBe(false);
  const state = await readState(s.repo, taskId);
  expect(state.model).toBe("g/medium");
  expect(state.sessions).toEqual(["s1"]);
}, 20_000);

test("escalate --from base 锁被其他会话持有：拒绝且清理 worktree，原会话保持登记", async () => {
  const s = await setup();
  const release = await acquireLock(s.repo, taskId, "other");
  const { fake } = await startAdapter(s.repo);
  const context = fakeCtx(s.repo);
  await runCmd(fake, "task escalate --from base", context.ctx);
  expect(anyNotify(context.notifications, "task lock held")).toBe(true);
  expect(existsSync(await worktreeOf(s.repo))).toBe(false);
  const state = await readState(s.repo, taskId);
  expect(state.sessions).toEqual(["s1"]);
  expect(state.model).toBe("g/medium");
  // 账本未变：无交接材料、无升级事件。
  expect(existsSync(path.join(s.repo, ".cw", "tasks", taskId, "handback.json"))).toBe(false);
  expect(await meterEvents(s.repo, taskId)).not.toContain("escalate_pending");
  expect(await meterEvents(s.repo, taskId)).not.toContain("escalate_target");
  await release();
}, 20_000);

// ---- ledger sharing across the escalation worktree -------------------------

/**
 * `--from base` escalation followed by a registered session taking over in
 * the worktree: the shared setup for ledger-sharing and freeze regressions.
 */
async function escalateAndTakeover(
  s: Setup, beforeTakeover?: () => Promise<void>,
): Promise<{
  worktree: string;
  second: ReturnType<typeof fakePi>;
  secondCtx: ReturnType<typeof fakeCtx>;
}> {
  const { fake, ctx } = await startAdapter(s.repo);
  await runCmd(fake, "task escalate --from base", ctx);
  const worktree = await worktreeOf(s.repo);
  if (beforeTakeover) await beforeTakeover();
  await updateState(s.repo, taskId, "s2", (state) => ({ ...state, sessions: ["s2"] }));
  const second = fakePi();
  counterweight(second.pi);
  const secondCtx = fakeCtx(worktree, { session: "s2" });
  await second.call("session_start", { type: "session_start", reason: "startup" }, secondCtx.ctx);
  expect(lastNotify(secondCtx.notifications)).toContain("已接管任务");
  return { worktree, second, secondCtx };
}

test("升级 worktree 会话经引用接管同一账本；验证器跑在 worktree，主检出不动", async () => {
  const s = await setup();
  await s.setState((state) => ({ ...state, status: "running" }));
  const { worktree, second, secondCtx } = await escalateAndTakeover(s, async () => {
    // 验证器改用 touch 模式证明运行目录。
    const approval = JSON.parse(await readFile(
      path.join(s.repo, ".cw", "tasks", taskId, "approval.json"), "utf8")) as Approval;
    approval.validator = { cmd: ["/bin/sh", fixture, "touch"], timeout_s: 600, env: {} };
    await writeFile(path.join(s.repo, ".cw", "tasks", taskId, "approval.json"),
      `${JSON.stringify(approval, null, 2)}\n`);
    await writeFile(path.join(s.repo, ".cw", "payload.json"),
      `${report([{ id: "keep", status: "pass" }])}\n`);
  });

  // touch 模式把 x 追加到 cwd 的 tracked.txt：证明验证器运行在 worktree。
  const settle = await second.call("agent_before_settle", settleEvent(), secondCtx.ctx);
  // 树在运行中被改 → undetermined → 交还（不发布验证）。
  expect(settle?.entries?.at(-1)?.content).toContain("任务交还");
  expect(await readFile(path.join(worktree, "tracked.txt"), "utf8")).toBe("base\nx");
  expect(await readFile(path.join(s.repo, "tracked.txt"), "utf8")).toBe("base\n");
  const state = await readState(s.repo, taskId);
  expect(state.status).toBe("handed_back");
  expect(state.last_verified).toBeNull();
  expect(state.sessions).toEqual(["s2"]);
  // 账本仍然只在主检出：worktree 里没有 tasks 目录。
  expect(existsSync(path.join(worktree, ".cw", "tasks"))).toBe(false);

  await rm(worktree, { recursive: true, force: true });
  await git(s.repo, ["worktree", "prune"]);
}, 20_000);

test("worktree 会话 tool_result 冻结检查：哈希工作树文件，冲突记入账本，无 ENOENT 降级", async () => {
  const s = await setup();
  await s.setState((state) => ({ ...state, status: "running" }));
  const { worktree, second, secondCtx } = await escalateAndTakeover(s);

  // 冻结文件在【工作树】被改（blob 与批准不一致）。
  await writeFile(path.join(worktree, "tests", "a.py"), "tampered\n");

  const result = await second.call("tool_result", {
    type: "tool_result", toolCallId: "t1", toolName: "bash",
    input: {}, content: [{ type: "text", text: "ok" }], isError: false,
  }, secondCtx.ctx);

  // 冻结冲突行追加到工具结果，且没有任何"检查未完成"的降级通知。
  const text = (result as { content: Array<{ type: string; text: string }> }).content
    .map((item) => item.text).join("\n");
  expect(text).toContain("冻结文件冲突");
  expect(text).toContain("tests/a.py");
  expect(secondCtx.notifications.some((entry) => entry.message.includes("未能"))).toBe(false);

  // 冲突与证据失效落在同一份权威账本（主检出），不在 worktree。
  const state = await readState(s.repo, taskId);
  expect(state.conflicts.length).toBeGreaterThan(0);
  expect(state.last_verified).toBeNull();
  expect(existsSync(path.join(s.repo, ".cw", "tasks", taskId, "conflicts", "1.diff"))).toBe(true);
  expect(existsSync(path.join(worktree, ".cw", "tasks"))).toBe(false);

  await rm(worktree, { recursive: true, force: true });
  await git(s.repo, ["worktree", "prune"]);
}, 20_000);

test("base 升级材料 md 写失败：状态回滚、无 json/md/事件残留", async () => {
  const s = await setup();
  await s.setState((state) => ({ ...state, status: "running" }));
  // 预置同名目录，使 handback.md 的 rename 失败（两文件提交语义回滚 json）。
  await mkdir(path.join(s.repo, ".cw", "tasks", taskId, "handback.md"));
  const { fake } = await startAdapter(s.repo);
  const context = fakeCtx(s.repo);
  await runCmd(fake, "task escalate --from base", context.ctx);

  // 账本回滚到升级前。
  const state = await readState(s.repo, taskId);
  expect(state.model).toBe("g/medium");
  expect(state.sessions).toEqual(["s1"]);
  // 无 worktree 残留、无半份材料、无升级事件。
  expect(existsSync(await worktreeOf(s.repo))).toBe(false);
  expect(existsSync(path.join(s.repo, ".cw", "tasks", taskId, "handback.json"))).toBe(false);
  expect((await meterEvents(s.repo, taskId))).not.toContain("escalate_pending");
  expect((await meterEvents(s.repo, taskId))).not.toContain("escalate_target");
  expect(context.notifications.some((entry) => entry.type === "error")).toBe(true);
}, 20_000);

test("升级 worktree 的 .cw/task.json 引用对模型写入是受保护路径", async () => {
  const s = await setup();
  const { fake } = await startAdapter(s.repo);
  const event = {
    type: "tool_call", toolCallId: "t1", toolName: "write",
    input: { path: ".cw/task.json", content: "{}" },
  };
  const handler = fake.handlers.get("tool_call")!.at(-1)!;
  const result = await handler(event, fakeCtx(s.repo).ctx);
  expect(result).toMatchObject({ block: true });
  expect((result as { reason: string }).reason).toContain("受保护");
}, 20_000);

test("释放原会话后，旧会话重启不会自动接管；新登记会话才会", async () => {
  const s = await setup();
  await writeFile(path.join(s.repo, ".cw", "tasks", taskId, "notes.md"),
    "# 尝试过的方向\n方向A：已排除\n");
  const { fake, ctx } = await startAdapter(s.repo);
  await runCmd(fake, "task escalate --from base", ctx);
  const worktree = await worktreeOf(s.repo);
  expect(await findSessionTasks(s.repo, "s1")).toEqual([]);

  // 未登记的会话（如全新 s3）在 worktree 启动不会接管。
  const third = fakePi();
  counterweight(third.pi);
  const thirdCtx = fakeCtx(worktree, { session: "s3" });
  await third.call("session_start", { type: "session_start", reason: "startup" }, thirdCtx.ctx);
  expect(lastNotify(thirdCtx.notifications)).not.toContain("已接管任务");

  await updateState(s.repo, taskId, "s2", (state) => ({ ...state, sessions: ["s2"] }));
  expect(await findSessionTasks(s.repo, "s2")).toEqual([taskId]);

  // 升级后的新会话在 worktree 里 resume：任务视图带前一模型的笔记（未验证）。
  const resumeCtx = fakeCtx(worktree, { session: "s2" });
  await runCmd(fake, `task resume ${taskId}`, resumeCtx.ctx);
  const view = fake.sent.at(-1)!.message.content;
  expect(view).toContain("前一模型的笔记，未经验证");
  expect(view).toContain("方向A：已排除");

  await rm(worktree, { recursive: true, force: true });
  await git(s.repo, ["worktree", "prune"]);
}, 20_000);
