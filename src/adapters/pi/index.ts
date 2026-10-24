/**
 * Counterweight 的 pi 扩展入口。没有任务、契约或批准。
 *
 * `[check]` 在每轮正常结束时跑一次，失败把输出交回一次。`[protect]` 拦截 `edit`/`write`。
 * `[models]` 决定六个角色用哪个模型，没配的角色调用时返回不可用。
 * `[auto]` 让 review / over_review、史官、PAUSE 由扩展自己触发，而不是等模型想起来调用；默认全关。
 * 没有配置或配置非法时，不检查、不拦截。助手用量仍写入 `.cw/meter.jsonl`。
 * 每次用户回合都往系统提示的 `counterweight` 段写一段说话和构建约束，不管有没有配置。
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
import path from "node:path";
import { changedFiles, chronicleReport, workingDiff } from "../../core/auto.js";
import { checkPassed, renderCheckReport, runEndCheck, type CheckOutcome } from "../../core/check.js";
import { loadProjectConfig, type ProjectConfig } from "../../core/config.js";
import { repoToplevel } from "../../core/gitstate.js";
import { recordEvent, recordUsage } from "../../core/meter.js";
import { isNotFound, realpathOr, resolvePiToolPath, resolveWriteTarget } from "../../core/paths.js";
import { isSourceEdit, pauseReason, plannerMessage, renderTranscript, type TranscriptMessage } from "../../core/pause.js";
import { isProtected } from "../../core/protect.js";
import { sessionSection } from "../../roles/prompts.js";
import { roleTimeoutMs } from "../../roles/run.js";
import { runSetup } from "./setup.js";
import { chronicle, queueChronicle, registerTools, reviewMessage, runAndMeter } from "./tools.js";

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
  /**
   * 测试用：覆盖 PAUSE 的外层预算。不传就由 planner 的角色超时推出（默认 300 秒加余量）。
   * 超时就放行这次编辑：计划只是建议，不能因为规划者慢而卡住主流程。
   *
   * Test override for the PAUSE budget; by default it follows the planner's role timeout.
   */
  pauseMs?: number;
  /**
   * 测试用：覆盖自动审查与汇报的外层预算。不传就由各角色超时推出，在结束检查自己的预算之外另算。
   *
   * Test override for the automatic review and chronicle budget; by default it follows the role timeouts.
   */
  autoMs?: number;
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
 * 结算处理超时或抛异常时的回退文本：如实报告「本轮没有得到检查结论」，绝不报告通过。
 *
 * Fallback text when the settle handler times out or throws: an honest "no
 * check conclusion this turn", never a pass.
 */
const SETTLE_FALLBACK = "[counterweight] 结束检查未能完成（处理超时或内部错误）；本轮没有得到检查结论。";

const settleEntry = (content: string) => ({
  type: "custom_message" as const,
  customType: "counterweight",
  content,
  display: true,
});

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
 * 扩展入口：注册全部事件处理器、角色工具与 `/cw-setup`、`/cw-version` 命令，并把本会话的仓库根、
 * 配置与检查状态保存在闭包里。作为扩展的默认导出，由 pi 在加载扩展时调用一次。
 *
 * Entry point of the extension: registers every event handler, the `cw_explore`
 * tool, and the `/cw-version` command, and keeps this session's repo root,
 * config, and check state in a closure. Exported as the extension default, so
 * pi calls it once when the extension loads.
 *
 * @param pi - pi 扩展 API 句柄 / The pi extension API handle
 * @param timeouts - 覆盖默认的事件超时 / Overrides for the default timeouts
 * @param roleCli - 测试用：覆盖角色子进程的 pi CLI / Test only: override the CLI role children run
 * @param realWaitMs - 测试用：只压短角色子进程的真实等待，配置里的超时和外层预算推导不变 / Test only: shorten the real wait only
 */
export default function counterweight(pi: ExtensionAPI, timeouts?: Partial<AdapterTimeouts>, roleCli?: string, realWaitMs?: number): void {
  const limits: AdapterTimeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  let repo: string | null = null;
  let project: ProjectConfig | null = null;
  let repairUsed = false;
  let checkRun: CheckHandle | null = null;
  // PAUSE 每个用户回合只介入一次；和结束检查的修复额度一样，只有 before_agent_start 才重置。
  let pauseUsed = false;
  // 本回合用户的原话，自动汇报要用。结算触发的续跑不会覆盖它。
  let turnRequest = "";
  // 自动审查的发现最多让主模型续跑一轮；和修复额度、PAUSE 额度一样，只有 before_agent_start 才重置。
  let findingsUsed = false;

  const notifyError = (ctx: ExtensionContext, message: string): void => {
    try {
      ctx.ui.notify(message, "error");
    } catch {
      // Notifications must never mask the underlying failure path.
    }
  };

  // ---- session_start: repo root, then the optional config ----
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) =>
    withTimeout(limits.sessionStartMs, async () => {
      repo = await sessionRoot(ctx.cwd);
      try {
        project = await loadProjectConfig(repo);
        repairUsed = false;
        pauseUsed = false;
        const check = project?.check ?? null;
        if (check !== null) {
          const guard = project !== null && project.protect.paths.length > 0
            ? `；受保护路径 ${project.protect.paths.length} 条`
            : "";
          ctx.ui.notify(`Counterweight: 结束检查已启用（${check.cmd.join(" ")}）${guard}`, "info");
        }
      } catch (error) {
        // An unreadable or invalid config never half-arms the harness: report
        // it and leave tool calls alone for this session. The repo root stays,
        // so usage metering still has somewhere to write.
        project = null;
        notifyError(ctx, `Counterweight: 配置加载失败，本会话不拦截工具调用（${
          error instanceof Error ? error.message : "未知错误"}）`);
      }
      return undefined;
    }, async () => {
      // The budget lapsed, possibly after a config had already been assigned.
      // The root stays for metering; the loaded config does not, or a late
      // assignment would arm protection the fallback just called passive.
      project = null;
      repairUsed = false;
      pauseUsed = false;
      if (repo === null) repo = await sessionRoot(ctx.cwd).catch(() => realpathOr(ctx.cwd));
      notifyError(ctx, "Counterweight: 会话初始化未能在时限内完成，本会话不拦截工具调用");
      return undefined;
    }));

  // ---- tool_call: block direct writes to protected paths ----
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const protectedResult = await withTimeout(limits.toolCallMs, async (signal) => {
      const root = repo;
      if (root === null || project === null || signal.aborted) return undefined;
      const raw = writeToolPath(event);
      if (raw === null) return undefined;
      return await checkProtectedTarget(root, ctx.cwd, protectedPatterns(project), raw);
    }, () => {
      notifyError(ctx, "Counterweight: 写入保护检查未能在时限内完成，本次调用被拒绝");
      return { block: true, reason: "[counterweight] 保护检查超时或失败，写入被拒绝" };
    });
    // 受保护的先拦；没被拦的写入才轮到 PAUSE。
    if (protectedResult !== undefined) return protectedResult;
    return await pauseBeforeFirstEdit(event, ctx);
  });

  /**
   * PAUSE：本回合第一次对源码的 edit/write，拦下它，让 planner 读完调查写一份计划。
   * 只在 `[auto].pause` 打开时介入。任何失败（超时、没拿到回答、会话记录读不出）都放行这次编辑——
   * 计划是建议，不是闸门；而且额度先扣再请求，所以失败也不会让同一回合被反复拦。
   */
  async function pauseBeforeFirstEdit(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
    const root = repo;
    const planner = project?.models.planner ?? null;
    if (root === null || project === null || !project.auto.pause || planner === null || pauseUsed) return undefined;
    const raw = writeToolPath(event);
    if (raw === null) return undefined;
    const relative = toRepoRelative(root, ctx.cwd, raw);
    if (!isSourceEdit(relative)) return undefined;
    pauseUsed = true;
    const started = Date.now();
    const session = ctx.sessionManager.getSessionId();
    return await withTimeout(pauseBudget(), async (signal) => {
      const messages = ctx.sessionManager.buildSessionProjection().messages as unknown as TranscriptMessage[];
      const message = plannerMessage(renderTranscript(messages), relative!, event.toolName, event.input as Record<string, unknown>);
      const run = await runAndMeter(ctx, root, "planner", "cw_pause", planner, message, signal, { getProject: () => project, getRepo: () => repo, cliPath: roleCli, realWaitMs });
      await recordEvent(root, session, "pause", {
        outcome: run.answer === null ? "failed" : "planned", ms: Date.now() - started, tool: event.toolName,
      });
      return run.answer === null ? undefined : { block: true, reason: pauseReason(run.answer.trim()) };
    }, async () => {
      await recordEvent(root, session, "pause", { outcome: "timeout", ms: Date.now() - started, tool: event.toolName });
      return undefined;
    });
  }

  // 新的用户回合重置一次反馈额度，并写入 counterweight 段。
  // 结算触发的续跑不发这个事件，所以失败链的额度不会被续跑重置，这段也不会叠第二次。
  // Pi 每个回合重建 options，直接赋值不会覆盖 appendSystemPrompt。
  // OMP 没有 systemPromptOptions，事件给的是 `systemPrompt: string[]`，返回新数组替换；
  // OMP 可能对同一次提交重放整条链，每次都从事件给的基线追加，所以不会叠加。
  pi.on("before_agent_start", (event) => {
    repairUsed = false;
    pauseUsed = false;
    findingsUsed = false;
    const prompt = (event as { prompt?: unknown }).prompt;
    if (typeof prompt === "string") turnRequest = prompt;
    const section = sessionSection(project?.auto ?? { review: false, chronicle: false });
    const options = (event as { systemPromptOptions?: { sections: Record<string, string> } }).systemPromptOptions;
    if (options !== undefined) {
      options.sections.counterweight = section;
      return undefined;
    }
    const base = (event as { systemPrompt?: unknown }).systemPrompt;
    return Array.isArray(base) ? ({ systemPrompt: [...base, section] } as never) : undefined;
  });

  // ---- agent_before_settle (pi) / session_stop (OMP): run the configured end check once ----
  pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => {
    const check = project?.check ?? null;
    const budgetMs = (check === null ? limits.checkMarginMs : check.timeout_s * 1000 + limits.checkMarginMs) + autoBudget();
    return withTimeout(budgetMs, async (signal) => {
      if (event.outcome !== "completed") return undefined;
      const report = await runCheckOnce(ctx, signal);
      const entries = report === undefined ? [...event.entries] : [...event.entries, settleEntry(report.text)];
      if (report?.retrying) return { entries, continue: true };
      // 检查还要求修复时代码会再变，审查没有意义；定稿了才自动审查与汇报。
      const auto = await runAuto(ctx, report?.text ?? null, signal);
      if (auto.text !== null) entries.push(settleEntry(auto.text));
      if (report === undefined && auto.text === null) return undefined;
      return auto.continueRun ? { entries, continue: true } : { entries };
    }, () => event.outcome === "completed" && hasCheck() ? { entries: [...event.entries, settleEntry(SETTLE_FALLBACK)] } : undefined);
  });

  // OMP 在主会话即将结束时发 `session_stop`，不带 entries：报告走通知，失败反馈走 `additionalContext` 续跑。
  // pi 不发这个事件；OMP 不发 `agent_before_settle`，所以同一轮只会有一边触发。
  // OMP sends `session_stop` when the main session is about to settle, with no entries: the report goes
  // through a notification and the failure feedback through `additionalContext`. pi never sends it,
  // and OMP never sends `agent_before_settle`, so only one side fires per turn.
  (pi as unknown as { on(name: string, handler: (event: { signal?: AbortSignal }, ctx: ExtensionContext) => unknown): void })
    .on("session_stop", (event, ctx) => {
      const check = project?.check ?? null;
      const budgetMs = (check === null ? limits.checkMarginMs : check.timeout_s * 1000 + limits.checkMarginMs) + autoBudget();
      return withTimeout(budgetMs, async (signal) => {
        const report = await runCheckOnce(ctx, signal, event.signal);
        if (report !== undefined) ctx.ui.notify(report.text, report.passed ? "info" : "warning");
        if (report?.retrying) return { continue: true, additionalContext: report.text };
        const auto = await runAuto(ctx, report?.text ?? null, signal);
        if (auto.text !== null) ctx.ui.notify(auto.text, "info");
        return auto.continueRun && auto.text !== null ? { continue: true, additionalContext: auto.text } : undefined;
      }, () => {
        if (hasCheck()) notifyError(ctx, SETTLE_FALLBACK);
        return undefined;
      });
    });

  const hasCheck = (): boolean => repo !== null && (project?.check ?? null) !== null;

  /**
   * 角色子进程的实际超时（毫秒）：`[timeouts]` 里配的优先，否则用内置默认。
   * 外层预算由它推出，所以用户调大角色超时时，外层不会先把它掐掉。
   */
  const roleMs = (role: "review" | "over_review" | "historian" | "planner"): number => {
    const seconds = project?.timeouts[role];
    return seconds === undefined ? roleTimeoutMs(role) : seconds * 1000;
  };

  // PAUSE 的外层预算：planner 的超时加一点余量。测试可用 pauseMs 压低它。
  const pauseBudget = (): number => timeouts?.pauseMs ?? roleMs("planner") + 15_000;

  // 自动运行的外层预算：review 与 over_review 并行（取较长者），再加串行的史官，再加余量。
  const autoRunMs = (): number => {
    const auto = project?.auto;
    if (auto === undefined) return 0;
    const reviewPart = auto.review ? Math.max(roleMs("review"), roleMs("over_review")) : 0;
    const chroniclePart = auto.chronicle ? roleMs("historian") : 0;
    return timeouts?.autoMs ?? reviewPart + chroniclePart + 15_000;
  };

  const autoBudget = (): number => {
    const auto = project?.auto;
    return auto !== undefined && (auto.review || auto.chronicle) ? autoRunMs() : 0;
  };

  /**
   * 结算时的强制审查与汇报，只在 `[auto]` 打开时有动作。
   * review 与 over_review 并行，各自只读；它们只报告，不决定检查是否通过。发现了问题就把原文交回主模型，
   * 并最多续跑一轮（每个用户回合一次），续跑后的结算只汇报不再审查——否则两边会互相追着跑。
   * 史官走和 `cw_chronicle` 同一条队列。任何一步失败都只是不产出文字，绝不影响检查结论。
   *
   * Forced review and chronicle at settle. Findings go back to the main model with at most one forced
   * follow-up per user turn; a failure here only yields no text and never touches the check verdict.
   */
  async function runAuto(
    ctx: ExtensionContext, checkLine: string | null, signal: AbortSignal,
  ): Promise<{ text: string | null; continueRun: boolean }> {
    // 审查和汇报只是附加：它们坏了或拖得太久，都不能把已经得到的检查结论变成「未能完成」。
    // 所以它持有自己的预算和取消，且比外层预算（检查预算 + autoMs）短，一定先到点。
    const own = new AbortController();
    const forward = () => own.abort();
    if (signal.aborted) own.abort();
    else signal.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(() => own.abort(), Math.max(0, autoRunMs() - 1_000));
    try {
      return await runAutoUnsafe(ctx, checkLine, own.signal);
    } catch {
      return { text: null, continueRun: false };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", forward);
    }
  }

  async function runAutoUnsafe(
    ctx: ExtensionContext, checkLine: string | null, signal: AbortSignal,
  ): Promise<{ text: string | null; continueRun: boolean }> {
    const root = repo;
    const config = project;
    if (root === null || config === null || (!config.auto.review && !config.auto.chronicle)) {
      return { text: null, continueRun: false };
    }
    const diff = await workingDiff(root);
    const changed = diff !== null && diff.trim() !== "";
    const plan = { review: config.auto.review && changed, chronicle: config.auto.chronicle && changed };
    if (!plan.review && !plan.chronicle) return { text: null, continueRun: false };
    const lines: string[] = [];
    let continueRun = false;
    const registration = { getProject: () => project, getRepo: () => repo, cliPath: roleCli, realWaitMs };

    if (plan.review) {
      const message = reviewMessage({ request: turnRequest, diff: diff! });
      const [correct, over] = await Promise.all([
        runAndMeter(ctx, root, "review", "cw_review", config.models.review!, message, signal, registration),
        runAndMeter(ctx, root, "over_review", "cw_over_review", config.models.over_review!, message, signal, registration),
      ]);
      const findings = [correct, over]
        .map((run) => run.answer?.trim() ?? "")
        .filter((answer) => answer !== "" && answer !== "none" && !answer.startsWith("ASK:"));
      if (findings.length > 0) {
        // 额度只决定要不要再续跑一轮；续跑后的最终 diff 照样审查，发现记为事实，不再打断。
        const again = !findingsUsed;
        lines.push(again
          ? `[counterweight] 自动审查有发现，处理或说明为什么不处理：\n\n${findings.join("\n\n")}`
          : `[counterweight] 自动审查（续跑之后）仍有发现，不再续跑：\n\n${findings.join("\n\n")}`);
        findingsUsed = true;
        continueRun = again;
      }
    }

    if (plan.chronicle && !continueRun && lines.length === 0 && config.models.historian !== null) {
      const report = chronicleReport(turnRequest, changedFiles(diff!), checkLine);
      await queueChronicle(() => chronicle(ctx, root, config.models.historian!, report, signal, registration));
    }
    return { text: lines.length === 0 ? null : lines.join("\n\n"), continueRun };
  }

  /**
   * 执行一次结算检查：配置了结束检查就运行，不看工作树有没有变化。
   * 通过就报一行事实；失败把尾部事实反馈一次并续跑；第二次失败如实报告后结束。
   * 取消时返回 undefined：被取消的检查不对本轮下结论。
   *
   * Runs the settle check whenever a check is configured, whether or not the
   * worktree changed. A pass reports one line; a failure feeds the tail facts
   * back once and continues; a second failure is reported as-is and the turn
   * ends. A cancelled check returns undefined: it makes no claim about the turn.
   */
  async function runCheckOnce(
    ctx: ExtensionContext,
    outerSignal: AbortSignal,
    hostSignal?: AbortSignal,
  ): Promise<{ text: string; retrying: boolean; passed: boolean } | undefined> {
    const root = repo;
    const check = project?.check ?? null;
    if (root === null || check === null) return undefined;

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
    link(hostSignal);

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

    const passed = checkPassed(outcome);
    const retrying = !passed && !repairUsed;
    const text = renderCheckReport(outcome, {
      command: check.cmd.join(" "),
      final: !passed && repairUsed,
    });
    // Consumed for the rest of this user turn. A pass does not hand the
    // allowance back; only before_agent_start does.
    if (retrying) repairUsed = true;
    await recordEvent(root, session, "check", {
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut,
      spawn_error: outcome.runnerError,
      ms: Date.now() - started,
      outcome: outcome.runnerError !== null ? "spawn_error" : passed ? "passed" : retrying ? "feedback" : "reported",
    });
    return { text, retrying, passed };
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
    getRepo: () => repo,
    cliPath: roleCli,
    realWaitMs,
  });

  // RPC 客户端（如 Paseo）要等命令处理函数返回才收到 prompt 的响应，并按 60 秒判超时；
  // 一串对话框答完远不止这么久，所以问答放到后台，命令立刻返回。
  // An RPC client (Paseo, for one) gets the prompt response only after the command handler returns
  // and times out at 60 s; a run of dialogs takes far longer, so the dialogs continue in the background.
  let setupRunning = false;
  pi.registerCommand("cw-setup", {
    description: "一步步设置 Counterweight：选模型、结束检查、受保护路径，写入 .cw/project.toml",
    handler: async (_args, ctx) => {
      if (repo === null) return notifyError(ctx, "Counterweight: 会话尚未确定仓库根");
      if (!ctx.hasUI) return notifyError(ctx, "Counterweight: /cw-setup 需要交互界面");
      if (setupRunning) return notifyError(ctx, "Counterweight: /cw-setup 正在进行");
      const root = repo;
      setupRunning = true;
      void runSetup(ctx, root)
        .then(async (written) => {
          if (!written) return;
          project = await loadProjectConfig(root);
          repairUsed = false;
        })
        .catch((error: unknown) => notifyError(ctx, `Counterweight: /cw-setup 失败（${
          error instanceof Error ? error.message : "未知错误"}）`))
        .finally(() => { setupRunning = false; });
    },
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
 * 本会话的仓库根：cwd 在 git 工作树内时用工作树根（这样子目录启动仍读根上的配置、检查和计量），
 * 否则用 cwd 自身的 realpath。
 *
 * This session's repo root: the git worktree root when cwd is inside one, so a
 * session started in a subdirectory still reads the root config, check, and
 * meter. Otherwise the realpath of cwd itself.
 */
async function sessionRoot(cwd: string): Promise<string> {
  const here = await realpathOr(cwd);
  try {
    const toplevel = await repoToplevel(here);
    return toplevel === null ? here : await realpathOr(toplevel);
  } catch {
    return here;
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
 * 判断写入工具能否碰 `raw`。相对路径先按 pi 的口径对 `cwd` 解析，再和仓库根比较，避免把子目录启动
 * 误当成根替换。词法命中直接拒绝；否则解析真实路径（缺失叶子沿最近的现存祖先走），指向受保护路径或
 * 仓库外的别名同样拒绝。只有仓库内、且解析后仍不受保护的新文件才放行。
 *
 * Whether a write tool may touch `raw`. A relative path is resolved against
 * `cwd` the way pi resolves it, then compared with the repo root, so starting
 * in a subdirectory is not treated as a naive root substitution. A lexical hit
 * is refused; otherwise the real path is resolved (a missing leaf walks up to
 * the nearest existing ancestor) and an alias into a protected path or outside
 * the repo is refused too. Only a new file that stays unprotected inside the
 * repo is allowed.
 *
 * @returns `undefined` 表示放行；`{ block: true; reason }` 表示拒绝本次调用 /
 * `undefined` to allow the call, `{ block: true; reason }` to refuse it
 */
async function checkProtectedTarget(
  root: string, cwd: string, patterns: readonly string[], raw: string,
): Promise<ToolCallEventResult | undefined> {
  const lexical = toRepoRelative(root, cwd, raw);
  if (lexical === null) {
    return {
      block: true,
      reason: `[counterweight] 路径不在仓库内，无法核对受保护集合，已拒绝：${raw}`,
    };
  }
  if (isProtected(lexical, patterns)) return { block: true, reason: PROTECTED_REASON(lexical) };
  let resolved: string;
  try {
    resolved = await resolveWriteTarget(root, lexical);
  } catch (error) {
    // Nothing on the path exists: a new file, already judged lexically. A
    // symlink escape, a dangling link, or a non-directory ancestor cannot be
    // checked, so the write is refused.
    if (isNotFound(error)) return undefined;
    return { block: true, reason: UNVERIFIABLE_REASON(raw) };
  }
  if (isProtected(resolved, patterns)) {
    const via = resolved === lexical ? "" : `（路径 ${raw} 指向该受保护文件）`;
    return { block: true, reason: `${PROTECTED_REASON(resolved)}${via}` };
  }
  return undefined;
}

/**
 * 内置写入工具的文件路径参数：只有 `edit` 与 `write` 会声明要改的路径。bash 等其它改写工作树的
 * 途径不在这里拦截。
 *
 * File-path inputs of built-in write tools. Only `edit` and `write` declare a
 * path they will modify. Bash and other routes to the worktree are not
 * intercepted here.
 */
function writeToolPath(event: ToolCallEvent): string | null {
  if (event.toolName !== "edit" && event.toolName !== "write") return null;
  const value = (event.input as Record<string, unknown>).path;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 仓库相对路径（分隔符统一成 `/`）。先按 pi 1.0.0 写入工具的 `resolveToCwd` 解析（`@` 前缀、
 * Unicode 空格、`~`、`file://`），再和仓库根比较；目标落在仓库之外时返回 null。符号链接的核对是
 * 调用方 `checkProtectedTarget` 的后续步骤。
 *
 * Repo-relative form. Resolved the way pi 1.0.0's write tools resolve
 * (`resolveToCwd`: `@` prefix, Unicode spaces, `~`, `file://`), then compared
 * with the repo root. Null when the target escapes the repository. Symlink
 * resolution is the caller's next step.
 */
function toRepoRelative(repoRoot: string, cwd: string, value: string): string | null {
  const absolute = resolvePiToolPath(value, cwd);
  const relative = path.relative(repoRoot, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}
