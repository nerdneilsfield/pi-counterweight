/**
 * M5 适配层事件测试：pi 事件被翻译成 core 调用后必须守住的对外契约——tool_call 的写入
 * 拦截、tool_result 的冻结冲突记账、agent_before_settle 门禁的续跑/结束/取消/超时路径，
 * 以及 message_end 的 usage 记账与 session_shutdown 的验证进程回收。
 *
 * M5 adapter event tests. Each case drives the registered handlers through a
 * fake `ExtensionAPI` and a throwaway repo, then asserts only observable
 * outcomes: returned entries, `state.json`, handback material, and process
 * liveness. The invariants under test are that a block or an undetermined
 * verdict never degrades into a pass, and that every timeout or cancellation
 * finishes its own cleanup before returning.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import counterweight, { type AdapterTimeouts } from "../../src/adapters/pi/index.ts";
import { canonicalSha256 } from "../../src/core/canonical.ts";
import { readProjectConfig } from "../../src/core/config.ts";
import { contractSha256, readContract } from "../../src/core/contract.ts";
import { blobHash, treeHash } from "../../src/core/gitstate.ts";
import { createTask, readState, updateState, type Approval } from "../../src/core/task.ts";
import type { Contract, ValidatorConfig } from "../../src/core/types.ts";

/** 验证器替身脚本（`mode` 决定行为）/ Validator stand-in; `mode` picks its behavior. */
const fixture = path.join(import.meta.dirname, "../fixtures/validators/fake.sh");
/** 全文件统一的任务 id（每例只建一个任务）/ The one task id every case here works on. */
const taskId = "20260928-lifetime-fix";
/** 轮询等待用的小延时，供在途进程用例使用 / Short sleep for the polling loops below. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 事件处理器的最小形状：入参宽松，返回值按事件约定 / Minimal handler shape; params are loose. */
type Handler = (event: any, ctx: any) => any;

/**
 * 记录注册结果的最小 `ExtensionAPI` 替身：`on`/`registerTool`/`registerCommand` 只把入参
 * 存进可断言的集合，由用例手动触发事件、直接调用工具与命令。
 *
 * Minimal `ExtensionAPI` double that only records registrations, so a case can
 * fire events, call tools, and inspect commands by hand. `call` dispatches to
 * the most recently registered handler for an event name, i.e. the adapter's
 * current wiring rather than any earlier one.
 */
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

/**
 * 最小 `ExtensionContext`：`cwd` 指向被测仓库，notify/confirm 收集进数组便于断言，并返回
 * 可手动 abort 的 controller 用来模拟用户取消；默认 `hasUI: false`（print 模式）。
 *
 * Minimal `ExtensionContext`: `cwd` is the repo under test, notifications and
 * confirmations are captured for assertions, and the returned `controller` lets
 * a case abort the signal to simulate a user cancel. Defaults to `hasUI: false`,
 * the print mode where no confirmation can happen.
 */
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

/** 在 `cwd` 里跑 git 并返回 stdout；非零退出即 reject / Runs git in `cwd`; non-zero exit rejects. */
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
 * `setup()` 的产物：临时仓库与已解析的契约、批准，加上改写批准/预置证据的辅助函数。
 * What `setup()` returns: the temp repo, contract and approval, plus helpers to
 * rewrite the approval or seed evidence.
 */
interface Setup {
  repo: string;
  contract: Contract;
  approval: Approval;
  /**
   * 覆写 approval.json 再落盘；未给出的字段沿用基线 approval。
   * Rewrites approval.json over the baseline; unset fields keep baseline values.
   */
  writeApproval: (changes?: Partial<Approval>) => Promise<void>;
  /** 指向 fake.sh 的验证器配置；`mode` 决定行为 / Validator config backed by fake.sh. */
  validator: (mode: string, payload?: string, code?: string, timeout_s?: number) => ValidatorConfig;
  /** 预置与当前树一致的 last_verified，使证据看似有效 / Seeds `last_verified` so the evidence looks valid. */
  seedVerified: () => Promise<void>;
  /** 补写 run 1 的 run.json（产物复核要读）/ Writes run 1's run.json, read by the artifact re-check. */
  seedRunRecord: () => Promise<void>;
}

/**
 * 写进每个临时仓库的 `.cw/project.toml`：项目级 validator 会被 approval 覆盖，
 * 其余字段（模型槽位与档位映射）按默认值补齐。
 *
 * The `.cw/project.toml` written into every temp repo. The approved validator
 * overrides its `[validator]` section; everything else is filled with defaults.
 */
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

/**
 * 搭出一个"已批准、可直接跑门禁"的临时仓库：一次基线提交、登记在本会话的 task、契约
 * （deliverable 与 frozen 可调）、project.toml，以及一份哈希都取自真实文件的 approval.json。
 *
 * Builds a throwaway repo that is already approved for gating: one base commit,
 * the task registered on this session, contract.toml (deliverable and frozen
 * list configurable), project.toml, and an approval.json whose hashes are
 * computed from the real files, so no drift is reported unless a case causes it.
 * The repo lives under the OS temp dir and is never removed by this helper.
 *
 * @param options - deliverable 与 frozen 列表的覆盖 / Overrides for deliverable and frozen.
 */
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
    project_config_sha256: canonicalSha256(
      await readProjectConfig(path.join(repo, ".cw", "project.toml"))),
    validator: { cmd: ["/bin/sh", fixture, "none"], timeout_s: 600, env: {} },
    base_commit: (await git(repo, ["rev-parse", "HEAD"])).trim(),
    baseline_inputs_sha256: {},
    validator_inputs_sha256: {},
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
  const seedRunRecord = async (): Promise<void> => {
    const tree = await treeHash(repo);
    const record = {
      version: 1 as const, run: 1,
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      exit_code: 0, term_signal: null, timed_out: false, cancelled: false,
      result_discarded: false, runner_error: null, record_error: null,
      git: true, tree_before: tree.value!, tree_after: tree.value!,
      input_hashes_before: {}, input_hashes_after: {}, artifact_hashes: {},
    };
    const runDir = path.join(repo, ".cw", "tasks", taskId, "runs", "1");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(record)}\n`);
  };
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
    seedRunRecord,
    seedVerified: async () => {
      const tree = await treeHash(repo);
      await updateState(repo, taskId, "s1", (state) => ({
        ...state,
        last_verified: { run: 1, tree: tree.value!, contract_sha256: contractSha256(contract) },
      }));
    },
  };
}

/**
 * 伪造验证器结果 JSON：`checks` 是必要检查数组，`extra` 里的 JSON 会合并覆盖默认字段
 * （用例靠它把 run_id 钉在本轮 run 上，否则结果会被判为过期）。
 *
 * Builds a fake validator result payload; `extra` is merged over the defaults,
 * which is how a case pins the `run_id` a run must report to be accepted.
 */
function report(checks: unknown, extra = ""): string {
  return JSON.stringify({
    protocol: 1, run_id: "1", complete: true, checks,
    build: { required: false }, summary: "x", logs: [],
    ...JSON.parse(extra || "{}"),
  });
}

/**
 * `agent_before_settle` 的最小事件：本轮 completed 且主循环允许继续。
 * Minimal settle event; the gate only reads `outcome` and `canContinue`.
 */
const settleEvent = () => ({
  type: "agent_before_settle",
  entries: [],
  continue: false,
  outcome: "completed",
  context: { canContinue: true },
});

/**
 * `tool_call` 事件工厂：写入拦截只看 `toolName` 与 `input.path`，其余字段是占位。
 * `tool_call` event factory; the write check reads only `toolName` and `input.path`.
 */
const toolCallEvent = (toolName: string, input: Record<string, unknown>) => ({
  type: "tool_call", toolCallId: "t1", toolName, input,
});

/**
 * 注册扩展、造好 ctx，并触发一次 `session_start`（接管任务），返回可断言的 fake 与 ctx。
 *
 * Registers the extension, builds a fake context, and fires `session_start` so
 * the adapter adopts the task. `timeouts` overrides the adapter budgets and is
 * how the gate-timeout case shrinks the margin.
 */
async function startSession(repo: string, timeouts?: Partial<AdapterTimeouts>) {
  const fake = fakePi();
  counterweight(fake.pi, timeouts);
  const context = fakeCtx(repo);
  await fake.call("session_start", { type: "session_start", reason: "startup" }, context.ctx);
  return { fake, ...context };
}

/**
 * 注册契约：工具按固定顺序注册且全部 sequential——它们会写任务台账，不能与兄弟调用交错。
 * Registration contract: fixed tool order and sequential execution; each tool
 * appends to the task ledger, so it must not run beside a sibling call.
 */
test("工具按声明顺序注册且全部 sequential", async () => {
  const { repo } = await setup();
  const { fake } = await startSession(repo);
  expect(fake.tools.map((tool) => tool.name)).toEqual(["report_blocked", "propose_contract_change", "cw_explore"]);
  expect(fake.tools.every((tool) => tool.executionMode === "sequential")).toBe(true);
  expect(fake.commands.has("cw-version")).toBe(true);
});

/**
 * 写入拦截口径：词法路径与 realpath 都要核对，别名指向冻结文件同样被 block；解析不了的
 * 悬空别名 fail-closed；只有真正的新文件放行，`.cw` 下的 notes.md 是显式例外。
 *
 * Blocking shape: both the lexical path and the resolved realpath are checked, a
 * dangling alias is refused fail-closed, a genuinely new file passes, and
 * `notes.md` stays writable as the documented exception.
 */
test("符号链接别名指向冻结文件被 block，悬空别名 fail-closed，逃逸被 block", async () => {
  const { repo } = await setup();
  await symlink(path.join(repo, "tests", "a.py"), path.join(repo, "alias.py"));
  await symlink(path.join(repo, "tests", "fresh.py"), path.join(repo, "dangling.py"));
  // 逃逸目标必须真实存在，否则属于悬空别名（同样 fail-closed）。
  await writeFile(path.join(repo, "..", "outside.txt"), "outside\n");
  await symlink(path.join(repo, "..", "outside.txt"), path.join(repo, "escape.py"));
  const { fake, ctx } = await startSession(repo);

  const alias = await fake.call("tool_call", toolCallEvent("edit", {
    path: "alias.py", edits: [],
  }), ctx);
  expect(alias).toMatchObject({ block: true });
  expect(alias.reason).toContain("tests/a.py");

  const exact = await fake.call("tool_call", toolCallEvent("write", {
    path: "tests/a.py", content: "x",
  }), ctx);
  expect(exact).toMatchObject({ block: true });

  // 悬空别名 fail-closed：write 工具会沿链接重建目标，无法核对即拒绝。
  const dangling = await fake.call("tool_call", toolCallEvent("write", {
    path: "dangling.py", content: "x",
  }), ctx);
  expect(dangling).toMatchObject({ block: true });

  const fresh = await fake.call("tool_call", toolCallEvent("write", {
    path: "tests/brand-new.py", content: "x",
  }), ctx);
  expect(fresh ?? null).toBeNull();

  const escape = await fake.call("tool_call", toolCallEvent("write", {
    path: "escape.py", content: "x",
  }), ctx);
  expect(escape).toMatchObject({ block: true });

  // notes.md 仍可写（受保护集合的显式例外），且其自身路径解析不受 .cw 禁区影响。
  const notes = await fake.call("tool_call", toolCallEvent("edit", {
    path: `.cw/tasks/${taskId}/notes.md`, edits: [],
  }), ctx);
  expect(notes ?? null).toBeNull();
});

/**
 * 边界：别名指向一个已被删除的冻结目标。真实的 fs.writeFile 会沿链接把冻结文件重建出来，
 * 因此这次写入必须先被拦下，且拦截后冻结目标仍然不存在。
 *
 * The dangerous aliasing case: the write tool would follow the dangling link and
 * recreate the frozen file, so the call must be blocked and the target must stay
 * missing afterwards.
 */
test("删除冻结目标后的悬空别名：write 被拦截，冻结目标不被重建", async () => {
  const { repo, approval } = await setup();
  // alias.py -> tests/a.py；随后删除冻结目标：alias 成为指向受保护路径的悬空链接。
  await symlink(path.join(repo, "tests", "a.py"), path.join(repo, "alias.py"));
  await rm(path.join(repo, "tests", "a.py"));
  expect(approval.frozen_blobs["tests/a.py"]).toBeDefined();

  // 等价 fs.writeFile 路径的危险性证明：真实写入会沿悬空链接重建冻结目标。
  await writeFile(path.join(repo, "alias.py"), "recreated\n");
  expect(existsSync(path.join(repo, "tests", "a.py"))).toBe(true);
  await rm(path.join(repo, "tests", "a.py"));

  const { fake, ctx } = await startSession(repo);
  const blocked = await fake.call("tool_call", toolCallEvent("write", {
    path: "alias.py", content: "recreated\n",
  }), ctx);
  expect(blocked).toMatchObject({ block: true });

  // 拦截生效：冻结目标保持不存在，悬空链接本身仍在。
  expect(existsSync(path.join(repo, "tests", "a.py"))).toBe(false);
  await expect(lstat(path.join(repo, "alias.py"))).resolves.toBeTruthy();
});

/**
 * 回归：撤销本次验证要能在"已持锁"的上下文里执行（重入 updateState 不再抛 TaskLockError），
 * 且只作用于指定 run 的证据——其他 run 的 last_verified 必须原样保留。
 *
 * Regression: revocation must work inside an already-held lock and must touch
 * only the given run's evidence; a different run's `last_verified` survives.
 */
test("runner 撤销在已持锁上下文执行：仅清除本次 run 的 last_verified", async () => {
  const { repo } = await setup();
  const seed = async (run: number) => {
    await updateState(repo, taskId, "s1", (state) => ({
      ...state,
      last_verified: {
        run, tree: "0".repeat(64), contract_sha256: "0".repeat(64),
      },
      evidence_invalid_reason: null,
    }));
  };
  const { acquireLock } = await import("../../src/core/task.ts");
  const { revokeRunVerification } = await import("../../src/core/runner.ts");

  // 撤销本次 run：在已持锁上下文内执行（修复前 updateState 重入锁会抛 TaskLockError）。
  await seed(5);
  const release = await acquireLock(repo, taskId, "outer");
  try {
    await revokeRunVerification(repo, taskId, "outer", 5);
    const state = await readState(repo, taskId);
    expect(state.last_verified).toBeNull();
    expect(state.evidence_invalid_reason).toBe("cancelled");
  } finally {
    await release();
  }

  // 不是本次 run 的已验证记录不动。
  await seed(5);
  const release2 = await acquireLock(repo, taskId, "outer");
  try {
    await revokeRunVerification(repo, taskId, "outer", 6);
    const state = await readState(repo, taskId);
    expect(state.last_verified?.run).toBe(5);
    expect(state.evidence_invalid_reason).toBeNull();
  } finally {
    await release2();
  }
});

/**
 * 保护是"只挡写"：写冻结文件与 `.cw` 任务文件被 block（并提示走 propose_contract_change），
 * 新测试文件放行，仓库外路径被 block，而对冻结文件的读取完全不受影响。
 *
 * Protection is write-only: frozen and `.cw` targets are blocked with the
 * `propose_contract_change` hint, a new test file passes, an out-of-repo path is
 * blocked, and reading the frozen file stays allowed.
 */
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

/**
 * 冻结契约：bash 绕不过拦截——tool_result 事后核对，只追加一行事实（路径与差异文件），
 * 不还原文件、不报错，并使已有证据失效；同一持续冲突按 (path, expected, actual) 去重，
 * 但 actual 变化后再算新冲突。
 *
 * bash cannot dodge the freeze: `tool_result` re-checks afterwards, appends one
 * factual line, restores nothing, invalidates the evidence, and dedupes a
 * standing conflict — while a new `actual` is recorded again.
 */
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

  // 同一持续冲突再次出现：不追加新事实、不重复记录、不写新差异。
  const repeat = await fake.call("tool_result", {
    type: "tool_result", toolCallId: "t3", toolName: "bash",
    input: { command: "cat tests/a.py" },
    content: [{ type: "text", text: "listed" }],
    isError: false,
  }, ctx);
  expect(repeat ?? null).toBeNull();
  const stateAfterRepeat = await readState(repo, taskId);
  expect(stateAfterRepeat.conflicts).toHaveLength(1);
  expect((await readdir(path.join(repo, ".cw", "tasks", taskId, "conflicts"))).filter((name) =>
    name.endsWith(".diff"))).toHaveLength(1);

  // 新 actual 是新冲突：必须再次记录，不能被去重吞掉。
  await writeFile(path.join(repo, "tests", "a.py"), "tampered-more\n");
  const again = await fake.call("tool_result", {
    type: "tool_result", toolCallId: "t4", toolName: "bash",
    input: { command: "echo y >> tests/a.py" },
    content: [{ type: "text", text: "done" }],
    isError: false,
  }, ctx);
  const againContent = again.content as Array<{ type: string; text: string }>;
  expect(againContent).toHaveLength(2);
  expect(againContent[1]!.text).toContain("冻结文件冲突");
  const stateAfterNew = await readState(repo, taskId);
  expect(stateAfterNew.conflicts).toHaveLength(2);
  expect((await readdir(path.join(repo, ".cw", "tasks", taskId, "conflicts"))).filter((name) =>
    name.endsWith(".diff"))).toHaveLength(2);
});

/**
 * 边界：frozen 声明为空时 tool_result 直接短路，返回 undefined 即不改动原始结果。
 * Boundary: an empty frozen list short-circuits the check; the result stays untouched.
 */
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

/**
 * 门禁优先级：blocked 高于 validate——已报告受阻时直接交还，验证器一次都不许跑。
 * Gate priority: a reported block outranks validation, so the validator never runs.
 */
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

/**
 * 失败语义：fail 不等于交还——修复预算内继续跑，消息只给事实（失败项与日志路径），
 * 同时把 repairs_used 加一并落盘。
 *
 * Failure semantics: `fail` continues the loop while the repair budget lasts;
 * the message carries facts only, and `repairs_used` is persisted.
 */
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

/**
 * 结束契约：pass 发布 verified 并写 last_verified 与 handback(reason=finish,
 * auto_verified=true)，且不请求续跑。
 * Finish contract: `pass` publishes `verified`, records evidence, and never asks
 * for another round.
 */
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

/**
 * 取消语义：验证中途 abort 不判通过——不请求续跑、不写交还材料，状态停在 running，
 * 但验证进程组必须被杀干净（无残留进程）。
 * Cancel semantics: aborting mid-validation publishes nothing and leaves the
 * state untouched, but the validator process group must be fully reaped.
 */
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

/**
 * 超时语义：门禁包装器预算耗尽 → 结论 undetermined 并交还，绝不判通过；交还材料落盘前
 * 先把验证进程组收干净。
 * Timeout semantics: a lapsed gate budget yields an `undetermined` handback
 * (never a pass) after the validator process group has been reaped.
 */
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

/**
 * 不变量：接管会话时的证据复核只会让证据失效，绝不重置 repairs_used / tokens_used，
 * 也不重建基线。
 * Invariant: adoption-time rechecks only invalidate evidence; counters survive.
 */
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

/**
 * 记账口径：只处理 assistant 消息，usage 以 snake_case 落 meter.jsonl，并把 totalTokens
 * 累加进 state.tokens_used（user 消息一律不记）。
 * Accounting: only assistant usage reaches the meter; `totalTokens` is added to
 * the state, user messages are ignored.
 */
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
  // M7 起计量文件含 task 事件行；usage 行为与此前一致。
  const usage = lines.map((line) => JSON.parse(line) as { kind?: string })
    .filter((record) => record.kind === "usage");
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    session: "s1", model: "g/medium",
    input: 100, output: 20, cache_read: 30, cache_write: 5, cost_total: 3.2,
  });
  const state = await readState(repo, taskId);
  expect(state.tokens_used).toBe(155);
});

/**
 * 无 UI 通道：提议只落盘成 proposals/N.json（status=pending），门禁随后交还给人裁决，
 * 不允许模型自行改契约。
 * No-UI channel: the proposal is recorded as pending and the gate hands back for
 * a human decision.
 */
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

/**
 * 有 UI 通道：用户确认只把提议标成 approved；新契约版本尚未生成，门禁仍按旧批准交还。
 * With UI: a confirm only marks the proposal approved; the gate still hands back
 * until a new contract version exists.
 */
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

/**
 * 拒绝提议不阻塞门禁；且 deliverable 非 code 时无需验证即 finish(autoVerified=false)。
 * A rejected proposal does not stall the gate, and a non-`code` deliverable
 * finishes unverified, so no validator run is needed.
 */
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

/**
 * 漂移检测：contract.toml 与批准哈希不一致即交还且不跑验证器（用会改文件的验证器作探针）。
 * Drift detection: a contract whose hash differs from the approval hands back,
 * with no validator run.
 */
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

/**
 * 缓存不变量：session 快照只用于廉价检查，门禁每次重读权威 contract.toml；外部改动使
 * 已记录证据失效并交还，而不是沿用缓存继续判。
 *
 * Caching invariant: the session snapshot is never trusted at the gate — the
 * authoritative file is re-read, invalidating the evidence and handing back.
 */
test("session_start 后外部改契约：门禁按真实文件判漂移，不使用缓存，证据失效", async () => {
  const { repo, validator, writeApproval, seedVerified, seedRunRecord, contract } = await setup();
  await writeApproval({ validator: validator("touch") });
  await seedRunRecord();
  await seedVerified();
  const { fake, ctx } = await startSession(repo);

  // 会话接管之后（契约已入缓存）外部修改权威 contract.toml。
  const contractFile = path.join(repo, ".cw", "tasks", taskId, "contract.toml");
  await writeFile(contractFile, (await readFile(contractFile, "utf8")).replace(
    'goal = "fix lifetime issue"', 'goal = "externally drifted"'));
  expect(contractSha256(contract)).not.toBe(
    contractSha256(await readContract(contractFile, repo)));

  const result = await fake.call("agent_before_settle", settleEvent(), ctx);
  const entry = (result as { entries?: Array<{ content: string }> }).entries?.at(-1);
  expect(entry?.content).toContain("任务交还");

  const state = await readState(repo, taskId);
  expect(state.status).toBe("handed_back");
  expect(state.last_verified).toBeNull();
  expect(state.evidence_invalid_reason).toContain("contract");
  expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");
  const material = JSON.parse(await readFile(
    path.join(repo, ".cw", "tasks", taskId, "handback.json"), "utf8"));
  expect(material.questions.join("\n")).toContain("契约文件与批准版本不一致");
});

/**
 * 空闲语义：没有受管任务时适配层保持被动——tool_call 与门禁都返回 undefined，绝不 block。
 * Idle semantics: with no active task the adapter stays passive and never blocks.
 */
test("无活动任务时适配层保持被动", async () => {
  const { repo } = await setup();
  await rm(path.join(repo, ".cw", "tasks", taskId), { recursive: true, force: true });
  const { fake, ctx } = await startSession(repo);

  expect((await fake.call("tool_call", toolCallEvent("edit", {
    path: "tests/a.py", edits: [],
  }), ctx)) ?? null).toBeNull();
  expect((await fake.call("agent_before_settle", settleEvent(), ctx)) ?? null).toBeNull();
});

/**
 * 竞态：取消落在"验证通过 → 写 handback → 发布 verified"的窗口内；无论落点先后，
 * 终态必须收敛为未验证（证据撤销、reason=cancelled、不返回"验收通过"）。
 *
 * Race: a cancel landing inside the handback/publish window must converge on the
 * same unverified terminal state and never publish a pass.
 */
test("取消落在 handback/落盘窗口：撤销本次 verified，不返回通过", async () => {
  const { repo, validator, writeApproval } = await setup();
  // 预置大量有效 run，让 writeHandback 的扫描有足够宽度，取消必然落在
  // handback 写盘与状态发布之间；无论落点先后，撤销逻辑收敛同一终态。
  const runsDir = path.join(repo, ".cw", "tasks", taskId, "runs");
  const runRecord = {
    version: 1, run: 0,
    started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    exit_code: 0, term_signal: null, timed_out: false, cancelled: false,
    result_discarded: false, runner_error: null, record_error: null,
    git: true, tree_before: "0".repeat(64), tree_after: "0".repeat(64),
    input_hashes_before: {}, input_hashes_after: {}, artifact_hashes: {},
  };
  const seeded = 120;
  for (let run = 1; run <= seeded; run++) {
    const dir = path.join(runsDir, String(run));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "run.json"), JSON.stringify({ ...runRecord, run }));
    await writeFile(path.join(dir, "result.json"), report(
      [{ id: "keep", status: "pass" }, { id: "reg", status: "pass" }],
      JSON.stringify({ run_id: String(run) })));
  }
  // 本次运行将是 seeded+1，验证器报告的 run_id 必须一致才会判定 pass。
  const nextRun = seeded + 1;
  await writeApproval({ validator: validator("report", report(
    [{ id: "keep", status: "pass" }, { id: "reg", status: "pass" }],
    JSON.stringify({ run_id: String(nextRun) }))) });
  // 大号 notes.md 拉长 handback.md 的写盘窗口：轮询到 handback.json 后立刻
  // 取消，取消标志必然在 md 落盘与状态发布之间置位。
  await writeFile(path.join(repo, ".cw", "tasks", taskId, "notes.md"), "x".repeat(8_000_000));
  const { fake, ctx, controller } = await startSession(repo);

  // 验证通过后 gate 会写 handback.json；轮询到它的一刻触发取消，
  // 此时 finish 分支仍在执行（md 落盘与状态发布在其后），撤销收敛同一终态。
  const taskDir = path.join(repo, ".cw", "tasks", taskId);
  const settling = fake.call("agent_before_settle", settleEvent(), ctx);
  const handbackJson = path.join(taskDir, "handback.json");
  while (!existsSync(handbackJson)) await delay(1);
  controller.abort();
  const result = await settling;

    const entries = (result as { entries?: Array<{ content: string }> }).entries ?? [];
    expect(entries.some((entry) => entry.content.includes("验收通过"))).toBe(false);
    const state = await readState(repo, taskId);
    expect(state.status).not.toBe("verified");
    expect(state.last_verified).toBeNull();
    expect(state.evidence_invalid_reason).toBe("cancelled");
    const material = JSON.parse(await readFile(
      path.join(taskDir, "handback.json"), "utf8"));
    expect(material.reason).toBe("cancelled");
    expect(material.auto_verified).toBe(false);
  }, 20_000);

/**
 * shutdown 契约：返回前验证进程组已清理完毕，在途验证的结果不得发布（状态停在 running）。
 * Shutdown contract: the process group is reaped before shutdown returns, and
 * the in-flight validation publishes nothing.
 */
test("session_shutdown 等待验证进程组清理完成后再释放，不发布验证结果", async () => {
  const { repo, validator, writeApproval } = await setup();
  await writeApproval({ validator: validator("hang", "-", "0", 600) });
  const { fake, ctx } = await startSession(repo);

  const settling = fake.call("agent_before_settle", settleEvent(), ctx);
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

  await fake.call("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  // shutdown 返回时进程组必须已经清理完毕。
  expect(() => process.kill(pid!, 0)).toThrow();

  const result = await settling;
  expect(result ?? null).toBeNull();
  const state = await readState(repo, taskId);
  expect(state.status).toBe("running");
  expect(state.last_verified).toBeNull();
  // 幂等：再次 shutdown 无验证在途，直接返回。
  await fake.call("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
}, 20_000);

/**
 * 幂等：没有在途验证时 shutdown 无副作用，重复调用可直接返回。
 * Idempotent: with nothing in flight, repeated shutdown is a no-op.
 */
test("session_shutdown 幂等且无验证运行时直接返回", async () => {
  const { repo } = await setup();
  const { fake, ctx } = await startSession(repo);
  await fake.call("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  await fake.call("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  expect(true).toBe(true);
});
