import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import counterweight, { type AdapterTimeouts } from "../../src/adapters/pi/index.ts";
import { contractSha256, readContract } from "../../src/core/contract.ts";
import { blobHash, treeHash } from "../../src/core/gitstate.ts";
import { createTask, readState, updateState, type Approval } from "../../src/core/task.ts";
import type { Contract, ValidatorConfig } from "../../src/core/types.ts";

const fixture = path.join(import.meta.dirname, "../fixtures/validators/fake.sh");
const taskId = "20260928-lifetime-fix";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Handler = (event: any, ctx: any) => any;

function fakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  tools: Array<{ name: string; executionMode?: string; execute: Handler }>;
  commands: Map<string, { description?: string; handler: Handler }>;
  call: (name: string, event: unknown, ctx: ExtensionContext) => Promise<any>;
} {
  const handlers = new Map<string, Handler[]>();
  const tools: Array<{ name: string; executionMode?: string; execute: Handler }> = [];
  const commands = new Map<string, { description?: string; handler: Handler }>();
  const pi = {
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => undefined;
    },
    registerTool: (tool: { name: string; executionMode?: string; execute: Handler }) => {
      tools.push(tool);
    },
    registerCommand: (name: string, options: { description?: string; handler: Handler }) => {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    handlers,
    tools,
    commands,
    call: async (name, event, ctx) => {
      const list = handlers.get(name) ?? [];
      if (list.length === 0) throw new Error(`no handler registered for ${name}`);
      return list.at(-1)!(event, ctx);
    },
  };
}

function fakeCtx(repo: string, options: { hasUI?: boolean; confirmResult?: boolean } = {}) {
  const notifications: Array<string> = [];
  const confirms: Array<string> = [];
  const controller = new AbortController();
  const ctx = {
    cwd: repo,
    mode: "print",
    hasUI: options.hasUI ?? false,
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      confirm: async (title: string, message: string) => {
        confirms.push(`${title}: ${message}`);
        return options.confirmResult ?? false;
      },
    },
    sessionManager: { getSessionId: () => "s1" },
    signal: controller.signal,
  };
  return { ctx: ctx as unknown as ExtensionContext, notifications, confirms, controller };
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

interface Setup {
  repo: string;
  contract: Contract;
  approval: Approval;
  writeApproval: (changes?: Partial<Approval>) => Promise<void>;
  validator: (mode: string, payload?: string, code?: string, timeout_s?: number) => ValidatorConfig;
  seedVerified: () => Promise<void>;
}

const projectToml = `version = 1

[validator]
cmd = ["/bin/sh", "-c", "true"]

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

async function setup(options: { deliverable?: string; frozen?: string[] } = {}): Promise<Setup> {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-m5-"));
  await git(repo, ["init"]);
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await mkdir(path.join(repo, "tests"));
  await writeFile(path.join(repo, "tests", "a.py"), "check\n");
  await git(repo, ["add", "tracked.txt", "tests/a.py"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  await createTask(repo, taskId, "gateway/medium");
  await writeFile(path.join(repo, ".cw", "project.toml"), projectToml);
  const contractFile = path.join(repo, ".cw", "tasks", taskId, "contract.toml");
  const frozen = options.frozen ?? ["tests/a.py"];
  await writeFile(contractFile, `version = 1
task_id = "${taskId}"
tier = "change"
deliverable = "${options.deliverable ?? "code"}"
goal = "fix lifetime issue"
acceptance = ["keep"]
red = ["keep"]
regression = ["reg"]
frozen = [${frozen.map((item) => `"${item}"`).join(", ")}]
`);
  const contract = await readContract(contractFile, repo);
  const baseApproval: Approval = {
    version: 1,
    contract_sha256: contractSha256(contract),
    project_config_sha256: "0".repeat(64),
    validator: { cmd: ["/bin/sh", fixture, "none"], timeout_s: 600, env: {} },
    base_commit: (await git(repo, ["rev-parse", "HEAD"])).trim(),
    baseline_inputs_sha256: {},
    frozen_blobs: { "tests/a.py": (await blobHash(repo, "tests/a.py")).value! },
    red_check_run: 1,
    approved_at: new Date().toISOString(),
  };
  const writeApproval = async (changes: Partial<Approval> = {}): Promise<void> => {
    const approval = { ...baseApproval, ...changes };
    await writeFile(
      path.join(repo, ".cw", "tasks", taskId, "approval.json"),
      `${JSON.stringify(approval, null, 2)}\n`,
    );
  };
  await writeApproval();
  await updateState(repo, taskId, "s1", (state) => ({ ...state, status: "approved", sessions: ["s1"] }));
  return {
    repo,
    contract,
    approval: baseApproval,
    writeApproval,
    validator: (mode, payload = "-", code = "0", timeout_s = 600) => ({
      cmd: ["/bin/sh", fixture, mode, payload, code],
      timeout_s,
      env: {},
    }),
    seedVerified: async () => {
      const tree = await treeHash(repo);
      await updateState(repo, taskId, "s1", (state) => ({
        ...state,
        last_verified: { run: 1, tree: tree.value!, contract_sha256: contractSha256(contract) },
      }));
    },
  };
}

function report(checks: unknown, extra = ""): string {
  return JSON.stringify({
    protocol: 1, run_id: "1", complete: true, checks,
    build: { required: false }, summary: "x", logs: [],
    ...JSON.parse(extra || "{}"),
  });
}

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

async function startSession(repo: string, timeouts?: Partial<AdapterTimeouts>) {
  const fake = fakePi();
  counterweight(fake.pi, timeouts);
  const context = fakeCtx(repo);
  await fake.call("session_start", { type: "session_start", reason: "startup" }, context.ctx);
  return { fake, ...context };
}

test("工具按声明顺序注册且全部 sequential", async () => {
  const { repo } = await setup();
  const { fake } = await startSession(repo);
  expect(fake.tools.map((tool) => tool.name)).toEqual(["report_blocked", "propose_contract_change"]);
  expect(fake.tools.every((tool) => tool.executionMode === "sequential")).toBe(true);
  expect(fake.commands.has("cw-version")).toBe(true);
});

test("edit 冻结文件被 block，新测试文件放行，逃出仓库被 block", async () => {
  const { repo } = await setup();
  const { fake, ctx } = await startSession(repo);

  const blocked = await fake.call("tool_call", toolCallEvent("edit", {
    path: "tests/a.py", edits: [],
  }), ctx);
  expect(blocked).toMatchObject({ block: true });
  expect(blocked.reason).toContain("propose_contract_change");

  const allowed = await fake.call("tool_call", toolCallEvent("edit", {
    path: "tests/test_new.py", edits: [],
  }), ctx);
  expect(allowed ?? null).toBeNull();

  const writeBlocked = await fake.call("tool_call", toolCallEvent("write", {
    path: `.cw/tasks/${taskId}/state.json`, content: "{}",
  }), ctx);
  expect(writeBlocked).toMatchObject({ block: true });

  const escape = await fake.call("tool_call", toolCallEvent("write", {
    path: "../../outside.txt", content: "x",
  }), ctx);
  expect(escape).toMatchObject({ block: true });

  const readAllowed = await fake.call("tool_call", toolCallEvent("read", {
    path: "tests/a.py",
  }), ctx);
  expect(readAllowed ?? null).toBeNull();
});

test("bash 修改冻结文件：tool_result 记录冲突、追加一行事实、文件不还原、证据失效", async () => {
  const { repo } = await setup();
  const { fake, ctx } = await startSession(repo);
  await writeFile(path.join(repo, "tests", "a.py"), "tampered\n");
  await updateState(repo, taskId, "s1", (state) => ({
    ...state,
    last_verified: { run: 1, tree: "0".repeat(64), contract_sha256: "1".repeat(64) },
  }));

  const result = await fake.call("tool_result", {
    type: "tool_result", toolCallId: "t2", toolName: "bash",
    input: { command: "echo x >> tests/a.py" },
    content: [{ type: "text", text: "done" }],
    isError: false,
  }, ctx);

  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(2);
  expect(content[0]!.text).toBe("done");
  expect(content[1]!.text).toContain("冻结文件冲突");
  expect(content[1]!.text).toContain("tests/a.py");

  expect(await readFile(path.join(repo, "tests", "a.py"), "utf8")).toBe("tampered\n");
  const state = await readState(repo, taskId);
  expect(state.last_verified).toBeNull();
  expect(state.conflicts).toHaveLength(1);
});

test("无冻结声明时 tool_result 不追加内容", async () => {
  const { repo } = await setup({ frozen: [] });
  const { fake, ctx } = await startSession(repo);
  const result = await fake.call("tool_result", {
    type: "tool_result", toolCallId: "t3", toolName: "bash",
    input: { command: "true" },
    content: [{ type: "text", text: "ok" }],
    isError: false,
  }, ctx);
  expect(result ?? null).toBeNull();
});

test("report_blocked 后门禁直接交还，不运行验证", async () => {
  const { repo, validator, writeApproval } = await setup();
  // 验证器若运行会改写 tracked.txt 并留 marker；被 blocked 短路时不能发生。
  await writeApproval({ validator: validator("touch") });
  const { fake, ctx } = await startSession(repo);

  const tool = fake.tools.find((item) => item.name === "report_blocked")!;
  const toolResult = await tool.execute("x", {
    reason: "契约与现有接口冲突", questions: ["选 A 还是 B"],
  }, undefined, undefined, ctx);
  expect(toolResult.content[0].text).toContain("已记录");

  const result = await fake.call("agent_before_settle", settleEvent(), ctx);
  const entry = (result as { entries?: Array<{ content: string }> }).entries?.at(-1);
  expect(entry?.content).toContain("任务交还");
  expect(entry?.content).toContain("blocked");
  expect((result as { continue?: boolean }).continue).toBeUndefined();

  const state = await readState(repo, taskId);
  expect(state.status).toBe("handed_back");
  expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");
  const material = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "handback.json"), "utf8"));
  expect(material.reason).toBe("blocked");
  expect(material.questions).toContain("选 A 还是 B");
  expect(existsSync(path.join(repo, ".cw", "tasks", taskId, "blocked.json"))).toBe(false);
});

test("验证 fail 时续跑：追加事实消息、repairs_used 递增", async () => {
  const { repo, validator, writeApproval } = await setup();
  await writeApproval({ validator: validator("report", report(
    [{ id: "keep", status: "fail", message: "断言失败" }, { id: "reg", status: "pass" }], "",
  ), "1") });
  const { fake, ctx } = await startSession(repo);

  const result = await fake.call("agent_before_settle", settleEvent(), ctx);
  expect(result).toMatchObject({ continue: true });
  const entry = (result as { entries: Array<{ type: string; customType: string; content: string; display: boolean }> }).entries.at(-1)!;
  expect(entry.type).toBe("custom_message");
  expect(entry.customType).toBe("counterweight");
  expect(entry.display).toBe(true);
  expect(entry.content).toContain("[counterweight] 验收未通过（第 1/3 次自动修复）");
  expect(entry.content).toContain("keep: 断言失败");
  expect(entry.content).toContain("runs/1/stdout.log");

  const state = await readState(repo, taskId);
  expect(state.status).toBe("running");
  expect(state.repairs_used).toBe(1);
});

test("验证 pass 时结束：状态 verified、last_verified 落盘、不请求续跑", async () => {
  const { repo, validator, writeApproval } = await setup();
  await writeApproval({ validator: validator("report", report(
    [{ id: "keep", status: "pass" }, { id: "reg", status: "pass" }],
  )) });
  const { fake, ctx } = await startSession(repo);

  const result = await fake.call("agent_before_settle", settleEvent(), ctx);
  const entries = (result as { entries?: unknown[] }).entries ?? [];
  expect(entries).toHaveLength(1);
  expect((result as { continue?: boolean }).continue).toBeUndefined();

  const state = await readState(repo, taskId);
  expect(state.status).toBe("verified");
  expect(state.last_verified?.run).toBe(1);
  const material = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "handback.json"), "utf8"));
  expect(material.reason).toBe("finish");
  expect(material.auto_verified).toBe(true);
});

test("取消：验证进程组被终止，无续跑、无交还", async () => {
  const { repo, validator, writeApproval } = await setup();
  await writeApproval({ validator: validator("hang", "-", "0", 600) });
  const { fake, ctx, controller } = await startSession(repo);

  const settling = fake.call("agent_before_settle", settleEvent(), ctx);
  const pid = await (async () => {
    const runs = path.join(repo, ".cw", "tasks", taskId, "runs");
    for (let attempt = 0; attempt < 100; attempt++) {
      await delay(100);
      try {
        const names = await readdir(runs);
        const runDir = names.sort().at(-1);
        if (runDir !== undefined) {
          const text = await readFile(path.join(runs, runDir, "child.pid"), "utf8").catch(() => null);
          if (text !== null) return Number(text.trim());
        }
      } catch {
        // runs 目录尚未创建
      }
    }
    return undefined;
  })();
  expect(pid).toBeGreaterThan(0);

  controller.abort();
  const result = await settling;
  expect(result ?? null).toBeNull();
  expect(() => process.kill(pid!, 0)).toThrow();

  const state = await readState(repo, taskId);
  expect(state.status).toBe("running");
  expect(state.last_verified).toBeNull();
});

test("门禁超时：结论 undetermined 并交还，验证进程被终止", async () => {
  const { repo, validator, writeApproval } = await setup();
  // validator 自身 1s 超时开始清理，包装器预算 1s + 1s margin 在清理窗口内到期，
  // 因此走的是门禁包装器超时路径而非验证器超时路径。
  await writeApproval({ validator: validator("hang", "-", "0", 1) });
  const { fake, ctx } = await startSession(repo, { gateMarginMs: 1_000 });

  const result = await fake.call("agent_before_settle", settleEvent(), ctx);
  const entry = (result as { entries: Array<{ content: string }> }).entries.at(-1)!;
  expect(entry.content).toContain("无法判定");

  const state = await readState(repo, taskId);
  expect(state.status).toBe("handed_back");
  const material = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "handback.json"), "utf8"));
  expect(material.reason).toBe("undetermined");

  const runs = await readdir(path.join(repo, ".cw", "tasks", taskId, "runs"));
  const pid = Number(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "runs", runs.at(-1)!, "child.pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);

test("恢复会话：树变化使证据失效，repairs_used 与 tokens_used 保持原值", async () => {
  const { repo, seedVerified } = await setup();
  await seedVerified();
  await updateState(repo, taskId, "s1", (state) => ({
    ...state, status: "running", repairs_used: 2, tokens_used: 500,
  }));
  await writeFile(path.join(repo, "tracked.txt"), "changed\n");

  await startSession(repo);

  const state = await readState(repo, taskId);
  expect(state.last_verified).toBeNull();
  expect(state.evidence_invalid_reason).toContain("tree");
  expect(state.repairs_used).toBe(2);
  expect(state.tokens_used).toBe(500);
});

test("message_end 把 assistant usage 交给 meter 并累计 tokens_used", async () => {
  const { repo } = await setup();
  const { fake, ctx } = await startSession(repo);

  await fake.call("message_end", {
    type: "message_end",
    message: {
      role: "assistant", model: "g/medium",
      usage: {
        input: 100, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 155,
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.1, total: 3.2 },
      },
    },
  }, ctx);
  await fake.call("message_end", {
    type: "message_end",
    message: { role: "user", content: "hi", timestamp: 0 },
  }, ctx);

  const lines = (await readFile(
    path.join(repo, ".cw", "tasks", taskId, "meter.jsonl"), "utf8")).trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    session: "s1", model: "g/medium",
    input: 100, output: 20, cache_read: 30, cache_write: 5, cost_total: 3.2,
  });
  const state = await readState(repo, taskId);
  expect(state.tokens_used).toBe(155);
});

test("无 UI 的契约变更提议被记录并在门禁时交还", async () => {
  const { repo, validator, writeApproval } = await setup();
  await writeApproval({ validator: validator("touch") });
  const { fake, ctx } = await startSession(repo);

  const tool = fake.tools.find((item) => item.name === "propose_contract_change")!;
  const toolResult = await tool.execute("x", {
    field: "acceptance", new_value: '["keep2"]', reason: "验收条件有误",
  }, undefined, undefined, ctx);
  expect(toolResult.content[0].text).toContain("proposals/1.json");

  await fake.call("agent_before_settle", settleEvent(), ctx);
  const state = await readState(repo, taskId);
  expect(state.status).toBe("handed_back");
  expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");
  const material = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "handback.json"), "utf8"));
  expect(material.questions.join("\n")).toContain("proposals/1.json");
});

test("有 UI 批准提议：记录 approved，门禁交还等待新契约版本", async () => {
  const { repo } = await setup();
  const wired = fakePi();
  counterweight(wired.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: true });
  await wired.call("session_start", { type: "session_start", reason: "startup" }, context.ctx);

  const tool = wired.tools.find((item) => item.name === "propose_contract_change")!;
  const toolResult = await tool.execute("x", {
    field: "frozen", new_value: '["tests/b.py"]', reason: "冻结范围过宽",
  }, undefined, undefined, context.ctx);
  expect(toolResult.content[0].text).toContain("批准");
  expect(context.confirms[0]).toContain("frozen");

  await wired.call("agent_before_settle", settleEvent(), context.ctx);
  const state = await readState(repo, taskId);
  expect(state.status).toBe("handed_back");
  const proposal = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "proposals", "1.json"), "utf8"));
  expect(proposal.status).toBe("approved");
});

test("有 UI 拒绝提议：门禁照常进行（非 code 交付直接结束）", async () => {
  const { repo } = await setup({ deliverable: "repro" });
  const wired = fakePi();
  counterweight(wired.pi);
  const context = fakeCtx(repo, { hasUI: true, confirmResult: false });
  await wired.call("session_start", { type: "session_start", reason: "startup" }, context.ctx);

  const tool = wired.tools.find((item) => item.name === "propose_contract_change")!;
  const toolResult = await tool.execute("x", {
    field: "frozen", new_value: "[]", reason: "无需冻结",
  }, undefined, undefined, context.ctx);
  expect(toolResult.content[0].text).toContain("拒绝");

  const result = await wired.call("agent_before_settle", settleEvent(), context.ctx);
  const entries = (result as { entries?: unknown[] }).entries ?? [];
  expect(entries).toHaveLength(1);
  const state = await readState(repo, taskId);
  expect(state.status).toBe("verified");
});

test("契约文件与批准版本漂移：门禁交还且不验证", async () => {
  const { repo, validator, writeApproval } = await setup();
  await writeApproval({ validator: validator("touch") });
  const contractFile = path.join(repo, ".cw", "tasks", taskId, "contract.toml");
  await writeFile(contractFile, (await readFile(contractFile, "utf8")).replace('goal = "fix lifetime issue"', 'goal = "drifted goal"'));
  const { fake, ctx } = await startSession(repo);

  const result = await fake.call("agent_before_settle", settleEvent(), ctx);
  const entry = (result as { entries?: Array<{ content: string }> }).entries?.at(-1);
  expect(entry?.content).toContain("任务交还");
  expect((result as { continue?: boolean }).continue).toBeUndefined();
  const state = await readState(repo, taskId);
  expect(state.status).toBe("handed_back");
  expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");
});

test("无活动任务时适配层保持被动", async () => {
  const { repo } = await setup();
  await rm(path.join(repo, ".cw", "tasks", taskId), { recursive: true, force: true });
  const { fake, ctx } = await startSession(repo);

  expect((await fake.call("tool_call", toolCallEvent("edit", {
    path: "tests/a.py", edits: [],
  }), ctx)) ?? null).toBeNull();
  expect((await fake.call("agent_before_settle", settleEvent(), ctx)) ?? null).toBeNull();
});

test("session_shutdown 幂等且无验证运行时直接返回", async () => {
  const { repo } = await setup();
  const { fake, ctx } = await startSession(repo);
  await fake.call("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  await fake.call("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  expect(true).toBe(true);
});
