/**
 * Counterweight 的 pi 扩展入口（轻量版）：注册五个事件处理器（session_start、tool_call、
 * agent_before_settle、message_end、session_shutdown），把 pi 事件翻译成 core 调用，再把结论
 * 翻译回 pi 的返回值。没有任务、没有契约、没有批准流程：装上之后，pi 收到任务就直接干活。
 *
 * 行为只在配置了 `.cw/project.toml` 时生效：`[check]` 配了结束检查，每轮结束跑一次、失败反馈一次；
 * `[protect]` 配了受保护路径，`edit`/`write` 直接拦截、结算时如实报告变化。没有配置就完全被动。
 *
 * Counterweight's pi extension entry (lite): five event handlers that translate
 * pi events into core calls and back. No tasks, no contracts, no approval flow —
 * once installed, pi works on the task immediately.
 *
 * Behavior only activates for a configured `.cw/project.toml`: `[check]` runs
 * once per settled turn and feeds a failure back once; `[protect]` blocks
 * direct writes and reports changes at settle time. Without a config the
 * extension is fully passive.
 */
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { checkPassed, renderCheckReport, runEndCheck, type CheckOutcome } from "../../core/check.js";
import { loadProjectConfig, type ProjectConfig } from "../../core/config.js";
import { treeHash } from "../../core/gitstate.js";
import { recordEvent, recordUsage } from "../../core/meter.js";
import { isNotFound, realpathOr, resolveSymlinkInRepo } from "../../core/paths.js";
import { changedProtected, isProtected, snapshotProtected } from "../../core/protect.js";
import { registerTools } from "./tools.js";

/**
 * 各事件处理的时间预算（毫秒）。扩展入口允许用 `timeouts` 参数局部覆盖，未覆盖的取
 * `DEFAULT_TIMEOUTS`。预算耗尽时对应处理走自己的 fail-safe 回退，不留后台任务继续跑。
 *
 * Per-event time budgets in milliseconds. The extension entry point accepts a
 * partial override; unset fields fall back to `DEFAULT_TIMEOUTS`. A lapsed
 * budget drives that handler's fail-safe fallback and leaves no work running
 * in the background.
 */
export interface AdapterTimeouts {
  toolCallMs: number;
  sessionStartMs: number;
  messageEndMs: number;
  /**
   * 在结束检查自己的超时之上追加的余量（毫秒），供结算处理本身使用。
   *
   * Added on top of the end check's own timeout for the settle handler.
   */
  checkMarginMs: number;
  /**
   * 关闭时等待检查进程组回收的时间；shutdown 处理器实际用它的两倍作为超时。
   *
   * Time to wait for the check process group to be reaped at shutdown; the
   * shutdown handler uses twice this value as its timeout.
   */
  shutdownWaitMs: number;
}

/**
 * 各事件处理超时的默认值（毫秒），只被扩展入口的 `timeouts` 参数覆盖。
 *
 * Default time budgets in milliseconds; overridable only through the
 * extension entry point's `timeouts` parameter.
 */
const DEFAULT_TIMEOUTS: AdapterTimeouts = {
  toolCallMs: 10_000,
  sessionStartMs: 120_000,
  messageEndMs: 10_000,
  checkMarginMs: 120_000,
  shutdownWaitMs: 10_000,
};

/**
 * 一次正在进行的结束检查，shutdown 必须回收。
 *
 * An end check in flight that shutdown must reap.
 */
interface CheckHandle {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * 统一的处理器包装：超时由它自己持有的 AbortSignal 表达，预算耗尽即 abort；被包装的工作始终被等到
 * 结束，所以取消与清理都在回退结果产生之前完成，返回后没有后台 promise 继续跑。抛异常与超时落到
 * 同一个回退——对 tool_call 是显式拦截，对结算检查是如实报告「未能完成」，绝不会是「通过」。
 *
 * Unified handler wrapper. The timeout owns an AbortSignal that is aborted when
 * the budget lapses; the wrapped work receives it and is always awaited to
 * completion, so cancellation and cleanup finish before the fallback result is
 * produced. An exception lands in the same fallback as a timeout — for
 * tool_call an explicit block, for the settle check an honest "did not
 * finish", never a pass.
 */
async function withTimeout<R>(
  ms: number,
  run: (signal: AbortSignal) => Promise<R>,
  fallback: () => R | Promise<R>,
): Promise<R> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  try {
    const result = await run(controller.signal);
    return timedOut ? await fallback() : result;
  } catch {
    return await fallback();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 扩展入口：注册全部事件处理器、`cw_explore` 工具与 `/cw-version` 命令，并把本会话的仓库根、
 * 配置与检查状态保存在闭包里。作为扩展的默认导出，由 pi 在加载扩展时调用一次。
 *
 * Entry point of the extension: registers every event handler, the `cw_explore`
 * tool, and the `/cw-version` command, and keeps this session's repo root,
 * config, and check state in a closure. Exported as the extension default, so
 * pi calls it once when the extension loads.
 *
 * @param pi - pi 扩展 API 句柄 / The pi extension API handle
 * @param timeouts - 覆盖默认的事件超时 / Overrides for the default timeouts
 */
export default function counterweight(pi: ExtensionAPI, timeouts?: Partial<AdapterTimeouts>): void {
  const limits: AdapterTimeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  let repo: string | null = null;
  let project: ProjectConfig | null = null;
  let protectedSnapshot: Map<string, string | null> | null = null;
  let lastCheckTree: string | null = null;
  let repairUsed = false;
  let checkRun: CheckHandle | null = null;

  const notifyError = (ctx: ExtensionContext, message: string): void => {
    try {
      ctx.ui.notify(message, "error");
    } catch {
      // Notifications must never mask the underlying failure path.
    }
  };

  // ---- session_start: load config, snapshot the protected set, remember the tree ----
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) =>
    withTimeout(limits.sessionStartMs, async () => {
      repo = await realpathOr(ctx.cwd);
      try {
        project = await loadProjectConfig(repo);
        protectedSnapshot = await snapshotProtected(repo, protectedPatterns(project));
        lastCheckTree = await currentTree(repo);
        repairUsed = false;
        const check = project?.check ?? null;
        if (check !== null) {
          const guard = project !== null && project.protect.paths.length > 0
            ? `；受保护路径 ${project.protect.paths.length} 条`
            : "";
          ctx.ui.notify(`Counterweight: 结束检查已启用（${check.cmd.join(" ")}）${guard}`, "info");
        }
      } catch (error) {
        // An unreadable or invalid config never half-arms the harness: report
        // it and stay passive for this session.
        project = null;
        protectedSnapshot = null;
        lastCheckTree = null;
        notifyError(ctx, `Counterweight: 配置加载失败，本会话保持被动（${
          error instanceof Error ? error.message : "未知错误"}）`);
      }
      return undefined;
    }, () => {
      notifyError(ctx, "Counterweight: 会话初始化未能在时限内完成，本会话保持被动");
      return undefined;
    }));

  // ---- tool_call: block direct writes to protected paths ----
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) =>
    withTimeout(limits.toolCallMs, async (signal) => {
      const root = repo;
      if (root === null || signal.aborted) return undefined;
      const raw = writeToolPath(event);
      if (raw === null) return undefined;
      return await checkProtectedTarget(root, protectedPatterns(project), raw);
    }, () => {
      notifyError(ctx, "Counterweight: 写入保护检查未能在时限内完成，本次调用被拒绝");
      return { block: true, reason: "[counterweight] 保护检查超时或失败，写入被拒绝" };
    }));

  // ---- before_agent_start: a new user turn gets a fresh repair allowance ----
  // Internal continues driven by the settle check do not emit this event, so
  // the one-feedback bound per failing chain stays intact.
  pi.on("before_agent_start", () => {
    repairUsed = false;
    return undefined;
  });

  // ---- agent_before_settle: run the configured end check once ----
  pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => {
    const check = project?.check ?? null;
    const budgetMs = check === null ? limits.checkMarginMs : check.timeout_s * 1000 + limits.checkMarginMs;
    return withTimeout(budgetMs, (signal) => runSettle(event, ctx, signal), () => settleFallback(event));
  });

  /**
   * 执行一次结算检查：只在配置了结束检查、本轮正常完成、且工作树自上次检查以来有变化时运行。
   * 通过就报一行事实；失败把尾部事实反馈一次并续跑；第二次失败如实报告后结束。
   *
   * Runs the settle check: only when a check is configured, the turn completed,
   * and the worktree changed since the last check. A pass reports one line; a
   * failure feeds the tail facts back once and continues; a second failure is
   * reported as-is and the turn ends.
   *
   * @remarks
   * 变化判定用树哈希：纯问答轮不跑检查。检查命令自己写出的构建产物不影响下一次判定——检查结束后
   * 重新记录树哈希。受保护文件的变化只报告、不拦截、不还原。
   *
   * Change detection uses the tree hash, so a pure Q&A turn runs no check; the
   * tree hash is re-recorded after the check so artifacts the command itself
   * wrote do not count as further changes. Protected-file changes are only
   * reported.
   */
  async function runSettle(
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
    outerSignal: AbortSignal,
  ): Promise<AgentBeforeSettleEventResult | undefined> {
    const root = repo;
    const check = project?.check ?? null;
    if (root === null || check === null) return undefined;
    if (event.outcome !== "completed") return undefined;
    const tree = await currentTree(root);
    if (tree !== null && lastCheckTree !== null && tree === lastCheckTree) return undefined;

    const session = ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    const forwards: Array<{ source: AbortSignal; fn: () => void }> = [];
    const link = (source: AbortSignal | undefined): void => {
      if (source === undefined) return;
      const fn = () => controller.abort();
      if (source.aborted) fn();
      else {
        source.addEventListener("abort", fn, { once: true });
        forwards.push({ source, fn });
      }
    };
    link(ctx.signal);
    link(outerSignal);

    const patterns = protectedPatterns(project);
    const protectedChanged = await changedProtectedOrNull(root, patterns, protectedSnapshot);
    const started = Date.now();
    let outcome: CheckOutcome;
    try {
      const done = runEndCheck({ repo: root, check, signal: controller.signal });
      checkRun = { controller, done: done.then(() => undefined, () => undefined) };
      outcome = await done;
    } finally {
      for (const { source, fn } of forwards) source.removeEventListener("abort", fn);
      if (checkRun !== null && checkRun.controller === controller) checkRun = null;
    }
    // A cancelled check produces no claim about the turn (the caller's signal
    // was an interrupt or the outer timeout, which reports through its own
    // fallback). A late cancel stays visible until the process group is gone.
    if (outcome.cancelled) return undefined;

    lastCheckTree = await currentTree(root);
    const passed = checkPassed(outcome);
    const retrying = !passed && !repairUsed;
    const text = renderCheckReport(outcome, {
      command: check.cmd.join(" "),
      final: !passed && repairUsed,
      protectedChanged,
    });
    repairUsed = retrying;
    await recordEvent(root, session, "check", {
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut,
      spawn_error: outcome.runnerError,
      ms: Date.now() - started,
      outcome: outcome.runnerError !== null ? "spawn_error" : passed ? "passed" : retrying ? "feedback" : "reported",
    });
    if (protectedChanged !== null && protectedChanged.length > 0) {
      // The change has been reported; accept the current content as the new
      // baseline so the same edit is not re-reported on the next check.
      protectedSnapshot = await snapshotProtected(root, patterns);
    }
    const result = {
      entries: [...event.entries, {
        type: "custom_message" as const,
        customType: "counterweight",
        content: text,
        display: true,
      }],
    };
    return retrying ? { ...result, continue: true } : result;
  }

  /**
   * 结算处理超时或抛异常时的回退：如实报告「本轮没有得到检查结论」，绝不报告通过。
   *
   * Fallback when the settle handler times out or throws: an honest "no check
   * conclusion this turn", never a pass.
   */
  function settleFallback(event: AgentBeforeSettleEvent): AgentBeforeSettleEventResult | undefined {
    if (repo === null || (project?.check ?? null) === null) return undefined;
    if (event.outcome !== "completed") return undefined;
    return {
      entries: [...event.entries, {
        type: "custom_message" as const,
        customType: "counterweight",
        content: "[counterweight] 结束检查未能完成（处理超时或内部错误）；本轮没有得到检查结论。",
        display: true,
      }],
    };
  }

  // ---- message_end: hand assistant usage to the meter ----
  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) =>
    withTimeout(limits.messageEndMs, async (signal) => {
      const root = repo;
      const message = event.message;
      if (root === null || signal.aborted || message.role !== "assistant") return undefined;
      const usage = message.usage;
      if (usage === undefined) return undefined;
      await recordUsage(root, {
        time: new Date().toISOString(),
        session: ctx.sessionManager.getSessionId(),
        model: message.model,
        input: usage.input,
        output: usage.output,
        cache_read: usage.cacheRead,
        cache_write: usage.cacheWrite,
        cost_total: usage.cost?.total ?? null,
      });
      return undefined;
    }, () => undefined));

  // ---- session_shutdown: idempotent termination of a running check ----
  pi.on("session_shutdown", (_event: SessionShutdownEvent, _ctx: ExtensionContext) =>
    withTimeout(limits.shutdownWaitMs * 2, async () => {
      await stopCheck();
      return undefined;
    }, () => undefined));

  registerTools(pi, {
    getProject: () => project,
  });

  pi.registerCommand("cw-version", {
    description: "显示 Counterweight 当前加载的 Pi 版本",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Counterweight: pi ${VERSION}`, "info");
    },
  });

  /**
   * abort 正在跑的结束检查，并等到它的进程组与清理彻底结束；由 shutdown 调用，空闲时是空操作。
   * 只有 `checkRun` 仍指向被等待的那个句柄时才清掉它，避免误清后来者的句柄。
   *
   * Abort the in-flight end check and wait until its process group and cleanup
   * have fully settled. Idempotent; the reference is only cleared when it still
   * points at the awaited handle.
   */
  async function stopCheck(): Promise<void> {
    const current = checkRun;
    if (current === null) return;
    current.controller.abort();
    await current.done;
    if (checkRun !== null && checkRun.controller === current.controller) checkRun = null;
  }
}

/**
 * 受保护路径列表；没有配置时为空（`.cw/project.toml` 本身始终受保护，由 `isProtected` 兜底）。
 *
 * The protected-path patterns; empty without a config (`.cw/project.toml` is
 * always protected through `isProtected`).
 */
function protectedPatterns(project: ProjectConfig | null): string[] {
  return project?.protect.paths ?? [];
}

/**
 * 当前工作树的树哈希；非 git 或失败时返回 null（调用方按“无法判定变化”处理，照常跑检查）。
 *
 * Tree hash of the current worktree, or null when git is unavailable or the
 * hash fails — callers then treat "changed" as unknown and run the check.
 */
async function currentTree(root: string): Promise<string | null> {
  try {
    const value = await treeHash(root);
    return value.supported ? value.value : null;
  } catch {
    return null;
  }
}

/**
 * 与快照对比受保护文件的变化；没有快照或核对失败时返回 null（渲染成「无法核对」）。
 *
 * Protected-file changes against the snapshot, or null when there is no
 * snapshot or the comparison fails (rendered as "cannot verify").
 */
async function changedProtectedOrNull(
  root: string, patterns: readonly string[], snapshot: Map<string, string | null> | null,
): Promise<string[] | null> {
  if (snapshot === null) return null;
  try {
    return await changedProtected(root, patterns, snapshot);
  } catch {
    return null;
  }
}

/**
 * 直接写入受保护路径时的拒绝理由。
 *
 * Block reason for a direct write to a protected path.
 */
const PROTECTED_REASON = (relative: string) => `[counterweight] ${relative} 是受保护路径`
  + "（.cw/project.toml 或项目配置 [protect].paths）；如需修改请由用户手动完成。";

/**
 * 路径无法核对受保护集合（符号链接逃逸仓库或不可解析）时的拒绝理由。
 *
 * Block reason when a path cannot be checked against the protected set (it
 * escapes the repo through a symlink or cannot be resolved).
 */
const UNVERIFIABLE_REASON = (value: string) =>
  `[counterweight] 路径无法核对受保护集合（符号链接逃逸仓库或不可解析），已拒绝：${value}`;

/**
 * 判断写入工具能否碰 `raw`：先查词法路径，对已存在的目标再查解析后的真实路径——指向受保护文件的
 * 别名即使词法名字不在保护集合内也要拦。悬空别名按 fail-closed 拒绝（写入工具会沿链接重建一个无法
 * 核对的目标），只有路径确实不存在（真正的新文件）才放行；映射不到仓库内的路径同样直接拒绝。
 *
 * Whether a write tool may touch `raw`. Checks the lexical path and, for
 * existing targets, the fully resolved real path — an alias pointing at a
 * protected file is blocked even though its lexical name is not protected. A
 * dangling alias is fail-closed: the write tool would follow it and recreate an
 * unverifiable target, so only a plain missing path (a genuinely new file)
 * stays writable.
 *
 * @returns `undefined` 表示放行；`{ block: true; reason }` 表示拒绝本次调用 /
 * `undefined` to allow the call, `{ block: true; reason }` to refuse it
 */
async function checkProtectedTarget(
  root: string, patterns: readonly string[], raw: string,
): Promise<ToolCallEventResult | undefined> {
  const lexical = toRepoRelative(root, raw);
  if (lexical === null) {
    return {
      block: true,
      reason: `[counterweight] 路径不在仓库内，无法核对受保护集合，已拒绝：${raw}`,
    };
  }
  if (isProtected(lexical, patterns)) return { block: true, reason: PROTECTED_REASON(lexical) };
  let resolved: string;
  try {
    resolved = await resolveSymlinkInRepo(root, lexical);
  } catch (error) {
    if (!isNotFound(error)) {
      // Existing target that cannot be resolved inside the repo (symlink
      // escape) — fail closed rather than allow an unverifiable write.
      return { block: true, reason: UNVERIFIABLE_REASON(raw) };
    }
    const absolute = path.join(root, lexical);
    let dangling = false;
    try {
      dangling = (await lstat(absolute)).isSymbolicLink();
    } catch {
      // Nothing exists at the path: a plain new file, judged lexically above.
    }
    if (dangling) {
      return {
        block: true,
        reason: `[counterweight] ${raw} 是指向缺失目标的符号链接，写入会沿链接重建无法核对的路径，已拒绝。`,
      };
    }
    return undefined;
  }
  if (resolved !== lexical && isProtected(resolved, patterns)) {
    return { block: true, reason: `${PROTECTED_REASON(resolved)}（路径 ${raw} 指向该受保护文件）` };
  }
  return undefined;
}

/**
 * 内置写入工具的文件路径参数：只有 `edit` 与 `write` 会声明要改的路径；bash 等其它改写工作树的
 * 途径不在这里预拦，改由结算时的受保护文件对比报告。
 *
 * File-path inputs of built-in write tools. Only `edit` and `write` declare a
 * path they will modify; bash and other routes to the worktree are covered by
 * the settle-time protected-file comparison instead.
 */
function writeToolPath(event: ToolCallEvent): string | null {
  if (event.toolName !== "edit" && event.toolName !== "write") return null;
  const value = (event.input as Record<string, unknown>).path;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 词法上的仓库相对路径（分隔符统一成 `/`）；目标落在仓库之外时返回 null。只看词法，不解析符号链接，
 * 真实路径的核对是调用方 `checkProtectedTarget` 的后续步骤。
 *
 * Lexical repo-relative form, or null when the target escapes the repository.
 */
function toRepoRelative(repoRoot: string, value: string): string | null {
  const absolute = path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
  const relative = path.relative(repoRoot, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}
