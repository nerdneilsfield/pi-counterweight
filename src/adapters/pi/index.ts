/**
 * Counterweight 的 pi 扩展入口：注册 6 个事件处理器（session_start、tool_call、tool_result、
 * agent_before_settle、message_end、session_shutdown），把 pi 事件翻译成 core 调用，再把 core
 * 的结论翻译回 pi 的返回值。所有判断（门禁顺序、证据三态、冻结冲突、预算口径）都在 core，
 * 本层只是翻译器。
 *
 * 每个处理器都套统一超时包装：预算耗尽或抛异常时走各自的 fail-safe 回退——写入保护拒绝本次写入，
 * 门禁按「无法判定」写交还材料并交还任务，绝不判 pass。接管的任务保存在闭包里，同一时刻至多一个
 * 验证在跑，由 shutdown 或命令回收。
 *
 * Counterweight's pi extension entry: it registers six event handlers
 * (session_start, tool_call, tool_result, agent_before_settle, message_end,
 * session_shutdown) and translates pi events into core calls, then core
 * decisions back into pi returns. All judgment — gate order, the three
 * evidence verdicts, freeze conflicts, budget semantics — lives in core; this
 * layer is only a translator.
 *
 * Every handler runs through the shared timeout wrapper: when the budget
 * lapses or the work throws, each takes its own fail-safe fallback — the
 * write guard refuses the call, the gate hands the task back with
 * `undetermined` material, never a pass. The adopted task lives in a closure;
 * at most one validation runs at a time and shutdown or a command reaps it.
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
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";import { canonicalSha256 } from "../../core/canonical.js";
import { contractSha256, readContract } from "../../core/contract.js";
import { readReference } from "../../core/task.js";
import { REFERENCE_FILE } from "../../core/escalate.js";
import { recheckArtifacts } from "../../core/evidence.js";
import { isProtectedPath, checkFrozen, recheckContract, recheckTree } from "../../core/freeze.js";
import { decide, type GateInput } from "../../core/gate.js";
import { writeHandback } from "../../core/handback.js";
import { recordUsage } from "../../core/meter.js";
import { readProjectConfig } from "../../core/config.js";
import { isNotFound, resolveSymlinkInRepo } from "../../core/paths.js";
import { runValidator, revokeRunVerification, type RunOutcome } from "../../core/runner.js";
import {
  clearBlocked,
  findSessionTasks,
  findUnresolvedProposal,
  readApproval,
  readBlocked,
  readState,
  updateState,
  withTaskLock,
  type Approval,
} from "../../core/task.js";import type { Contract, ProjectConfig } from "../../core/types.js";
import { registerCommands } from "./commands.js";
import { registerTools } from "./tools.js";

/**
 * 本会话接管的某个任务，以及各事件处理需要的一切：工作树与账本的 realpath、会话 id、会话开始时
 * 读到的契约快照、批准记录与项目配置。所有判断（门禁顺序、证据结论、冻结冲突）都留在 core；
 * 本适配层只把 pi 事件翻译成 core 调用、把 core 结果翻译成 pi 返回。
 *
 * `root` 是工作树（通常等于仓库根；在工作树里启动的会话则是升级用的 worktree），`ledger` 是持有
 * `.cw/tasks/<id>/` 的权威仓库根，始终是任务写入的那个账本。
 *
 * A task this session manages, with everything the event handlers need. All
 * judgment (gate order, evidence verdicts, freeze conflicts) stays in core;
 * this adapter only translates Pi events into core calls and core results
 * into Pi returns. `contract` is the session-start snapshot used only for
 * cheap checks; the gate re-reads the authoritative contract.toml every time.
 *
 * `root` is the working tree (equal to the repo root normally; an escalation
 * worktree for a session started there). `ledger` is the authoritative repo
 * root holding `.cw/tasks/<id>/` — always the ledger the task writes to.
 */
export interface ActiveTask {
  taskId: string;
  /**
   * 工作树的 realpath，会话开始时解析一次。
   *
   * Realpath of the working tree, resolved once at session start.
   */
  root: string;
  /**
   * 权威仓库根（`.cw/` 账本）的 realpath。
   *
   * Realpath of the authoritative repo root (`.cw/` ledger).
   */
  ledger: string;
  /**
   * 本会话的 session id；接管任务要求它已登记在该任务的会话列表中。
   *
   * This session's id; adopting a task requires it to be listed on that task.
   */
  session: string;
  /**
   * 会话开始时读到的契约快照，只用于廉价检查；门禁每次结算都重读 contract.toml。
   *
   * Session-start contract snapshot used for cheap checks only; the gate
   * re-reads the authoritative contract.toml on every settle.
   */
  contract: Contract;
  /**
   * 批准记录：冻结 blob、批准哈希、验证器命令与超时；门禁拿当前事实与它比对。
   *
   * The approval record: frozen blobs, approved hashes, validator command and
   * timeout; the gate compares current facts against it.
   */
  approval: Approval;
  /**
   * 加载时读到的项目配置；门禁每次都会核对它是否仍与批准版本一致。
   *
   * Project config as read at load time; the gate checks it against the
   * approved version on every settle.
   */
  project: ProjectConfig;
}

/**
 * 各事件处理与门禁的时间预算（毫秒）。扩展入口允许用 `timeouts` 参数局部覆盖，未覆盖的取
 * `DEFAULT_TIMEOUTS`。预算耗尽时对应处理走自己的 fail-safe 回退，不留后台任务继续跑。
 *
 * Per-event time budgets in milliseconds. The extension entry point accepts a
 * partial override; unset fields fall back to `DEFAULT_TIMEOUTS`. A lapsed
 * budget drives that handler's fail-safe fallback and leaves no work running
 * in the background.
 */
export interface AdapterTimeouts {
  toolCallMs: number;
  toolResultMs: number;
  messageEndMs: number;
  sessionStartMs: number;
  /**
   * 在已批准的验证器超时之上追加的余量（毫秒），供门禁处理本身使用。
   *
   * Added on top of the approved validator timeout for the gate handler.
   */
  gateMarginMs: number;
  /**
   * 关闭时等待验证进程组回收的时间；shutdown 处理器实际用它的两倍作为超时。
   *
   * Time to wait for the validation process group to be reaped at shutdown;
   * the shutdown handler uses twice this value as its timeout.
   */
  shutdownWaitMs: number;
}

/**
 * 各事件处理与门禁超时的默认值（毫秒），只被扩展入口的 `timeouts` 参数覆盖。
 *
 * Default time budgets in milliseconds; overridable only through the
 * extension entry point's `timeouts` parameter.
 */
const DEFAULT_TIMEOUTS: AdapterTimeouts = {
  toolCallMs: 10_000,
  toolResultMs: 60_000,
  messageEndMs: 10_000,
  sessionStartMs: 120_000,
  gateMarginMs: 120_000,
  shutdownWaitMs: 10_000,
};

/**
 * 一次正在进行、shutdown 必须回收的验证（门禁或命令驱动的先红检查）。
 *
 * A validation (gate or command-driven red check) that shutdown must reap.
 */
export interface ValidationHandle {
  /**
   * 取消该次验证的控制器；abort 先发 SIGTERM 给进程组，5 秒宽限后升级为 SIGKILL。
   *
   * Aborting it kills the validator process group: SIGTERM first, SIGKILL
   * after a 5s grace period.
   */
  controller: AbortController;
  /**
   * 验证进程组及其清理彻底结束的 promise；等它结束再继续。
   *
   * Resolves once the validator process group and its cleanup have settled.
   */
  done: Promise<void>;
}

/**
 * 统一的处理器包装：超时由它自己持有的 AbortSignal 表达，预算耗尽即 abort；被包装的工作始终被等到
 * 结束，所以取消与清理都在回退结果产生之前完成，返回后没有后台 promise 继续跑。抛异常与超时落到
 * 同一个回退——对 tool_call 是显式拦截，对门禁是 `undetermined` 交还，绝不会是 pass。
 *
 * Unified handler wrapper. The timeout owns an AbortSignal that is aborted
 * when the budget lapses; the wrapped work receives it and is always awaited
 * to completion, so cancellation and cleanup finish before the fallback
 * result is produced. No background promise keeps running past the return,
 * and an exception lands in the same fallback as a timeout — for tool_call
 * that is an explicit block, for the gate an `undetermined` handback, never a
 * pass.
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
 * 扩展入口：注册全部 pi 事件处理器，以及模型工具（`registerTools`）与命令（`registerCommands`），
 * 并把本会话接管的任务保存在闭包里。作为扩展的默认导出，由 pi 在加载扩展时调用一次。
 *
 * 同一时刻至多一个验证在跑：句柄存在闭包变量 `validation` 中，门禁、shutdown 处理器与命令通过
 * `setValidation` / `stopValidation` 读写它。
 *
 * Entry point of the extension: registers every pi event handler plus the
 * model tools and commands, and keeps the task this session adopted in a
 * closure. Exported as the extension default, so pi calls it once when the
 * extension loads. At most one validation runs at a time; its handle lives in
 * the closure and is read or cleared by the gate, the shutdown handler, and
 * commands.
 *
 * @param pi - pi 扩展 API 句柄 / The pi extension API handle
 * @param timeouts - 覆盖默认的事件与门禁超时 / Overrides for the default timeouts
 */
export default function counterweight(pi: ExtensionAPI, timeouts?: Partial<AdapterTimeouts>): void {
  const limits: AdapterTimeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  let task: ActiveTask | null = null;
  let validation: ValidationHandle | null = null;

  const notifyError = (ctx: ExtensionContext, message: string): void => {
    try {
      ctx.ui.notify(message, "error");
    } catch {
      // Notifications must never mask the underlying failure path.
    }
  };

  // ---- session_start: locate the task, restore checks, never rebuild baseline ----
  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) =>
    withTimeout(limits.sessionStartMs, async (signal) => {
      void event;
      if (signal.aborted) return undefined;
      task = await locateTask(ctx);
      if (task !== null) {
        // Restoring a session with verified evidence re-verifies it: tree,
        // recorded artifact hashes, and contract version. Any drift
        // invalidates the evidence in state.json; the baseline is untouched.
        // These writes only invalidate evidence, so they are never cancelled
        // mid-way: core state functions take no signal and finishing them is
        // the fail-safe direction.
        await recheckTree(task.ledger, task.taskId, task.session, task.root);
        await recheckArtifacts(task.ledger, task.taskId, task.session, task.root);
        await recheckContract(task.ledger, task.taskId, task.session, task.contract);
        // M7: the task's approved model is applied here, at adoption — the
        // single place a session takes on a task. From the first turn on, the
        // adapter never touches model, thinking level, tools, or prompts.
        await applyTaskModel(pi, ctx, task);
        ctx.ui.notify(`Counterweight: 已接管任务 ${task.taskId}`, "info");
      }
      return undefined;
    }, () => {
      task = null;
      notifyError(ctx, "Counterweight: 任务定位失败，本会话不接管任务");
      return undefined;
    }));

  // ---- tool_call: block direct writes to protected paths ----
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) =>
    withTimeout(limits.toolCallMs, async (signal) => {
      const active = task;
      if (active === null || signal.aborted) return undefined;
      const raw = writeToolPath(event);
      if (raw === null) return undefined;
      return checkProtectedTarget(active, raw);
    }, () => {
      notifyError(ctx, "Counterweight: 写入保护检查未能在时限内完成，本次调用被拒绝");
      return { block: true, reason: "[counterweight] 保护检查超时或失败，写入被拒绝" };
    }));

  // ---- tool_result: freeze check, one factual line appended, no extra message ----
  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) =>
    withTimeout(limits.toolResultMs, async (signal) => {
      const active = task;
      if (active === null || signal.aborted) return undefined;
      if (Object.keys(active.approval.frozen_blobs).length === 0) return undefined;
      // Ledger is authoritative for conflict records; the files are hashed
      // in the working tree (they differ only in an escalation worktree).
      const outcome = await checkFrozen(
        active.ledger, active.taskId, active.session, active.approval.frozen_blobs, active.root);
      if (outcome.newConflicts.length === 0) return undefined;
      // Only new conflicts (path + expected + actual not already recorded)
      // get a line; a standing conflict is not re-reported on every result.
      const line = `[counterweight] 冻结文件冲突 ${outcome.newConflicts.length} 处`
        + `（${outcome.newConflicts.map((conflict) => conflict.path).join(", ")}）；`
        + `证据已失效，差异记录：${outcome.diffs.join(", ") || "无"}`;
      const content = [...event.content, { type: "text" as const, text: line }];
      return event.structuredContent !== undefined
        ? { content, structuredContent: event.structuredContent }
        : { content };
    }, () => {
      notifyError(ctx, "Counterweight: 冻结文件检查未能在时限内完成，本次结果未检查");
      return undefined;
    }));

  // ---- agent_before_settle: the gate ----
  pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => {
    const budgetMs = task === null
      ? limits.gateMarginMs
      : task.approval.validator.timeout_s * 1000 + limits.gateMarginMs;
    return withTimeout(budgetMs, async (signal) => runGate(event, ctx, signal), () =>
      undeterminedFallback(event, ctx));
  });

  /**
   * 执行一次门禁（`agent_before_settle` 处理器的主体）：重读权威事实、问 core 要决策、按决策收尾。
   * 决策从不发生在这里——`decide` 才是决策者，本函数只负责取材、跑验证器、把结果翻译成 pi 返回值。
   *
   * Runs the gate for one `agent_before_settle`: re-reads the authoritative
   * facts, asks core for a decision, and carries it out. Deciding never
   * happens here — `decide` owns that; this function gathers input, runs the
   * validator, and reports the outcome.
   *
   * @param event - 本轮结算事件 / The settle event for this turn
   * @param ctx - pi 扩展上下文，用于现取会话 id 与宿主信号 / The pi extension context
   * @param outerSignal - 超时信号，预算耗尽时 abort / Aborted when the handler budget lapses
   * @returns 不干预本轮时为 `undefined`；否则是带 `custom_message` 条目的结果，只有 continue 分支
   * 带 `continue: true` / `undefined` to leave this settle alone; otherwise entries to append,
   * with `continue: true` only on the continue branch
   *
   * @remarks
   * 每次结算都从账本重读契约与状态（会话快照可能已过期），并在任何证据被读之前调用
   * `recheckContract`，让契约漂移先使证据失效；受阻原因按 受阻记录 → 契约漂移 → 配置漂移 →
   * 未落定提议 的优先级合成。预算取自契约自身的 budget，缺省回落到项目配置。内层 AbortController
   * 同时转发 `ctx.signal` 与外层超时信号，交给验证器；退出时摘掉转发，并只清除属于本次的验证句柄。
   * 发布（finish）与交还（handback）都走状态守卫的转换：取消或别的会话已经改了状态时绝不覆盖，
   * 而是把实情回报给模型。本函数自己不判 pass；抛出的异常由外层 `withTimeout` 交给
   * `undeterminedFallback`。
   *
   * Every settle re-reads the contract and state from the ledger (the session
   * snapshot may be stale) and calls `recheckContract` before any evidence is
   * read, so contract drift invalidates evidence first. The blocked reason is
   * composed in this order: blocked record, contract drift, config drift,
   * unresolved proposal. Budgets come from the contract's own budget with the
   * project config as fallback. The inner AbortController forwards both
   * `ctx.signal` and the timeout signal to the validator; on exit the forwards
   * are removed and the handle is cleared only when it is ours.
   *
   * Publication (finish) and handback both use status-guarded transitions: a
   * cancel or another session's decision is never overwritten, the truth is
   * reported instead. This function never decides a pass on its own;
   * exceptions reach `withTimeout` and end in `undeterminedFallback`.
   */
  async function runGate(
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
    outerSignal: AbortSignal,
  ): Promise<AgentBeforeSettleEventResult | undefined> {
    const active = task;
    if (active === null) return undefined;
    if (event.outcome !== "completed") return undefined;
    const { root: work, ledger: repo, taskId } = active;
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

    let outcome: RunOutcome | null = null;
    try {
      // The authoritative contract.toml is re-read for every settle: an
      // external modification after session_start must not be judged against
      // the stale snapshot.
      const contract = await readContract(
        path.join(active.ledger, ".cw", "tasks", taskId, "contract.toml"), active.ledger, taskId);
      let state = await readState(active.ledger, taskId);
      if (state.status !== "approved" && state.status !== "running") return undefined;
      if (state.status === "approved") {
        state = await updateState(active.ledger, taskId, session, (current) => current.status === "approved"
          ? { ...current, status: "running", wall_started_at: current.wall_started_at ?? new Date().toISOString() }
          : current);
      }

      const blocked = await readBlocked(active.ledger, taskId);
      const proposal = await findUnresolvedProposal(active.ledger, taskId);
      const contractDrift = contractSha256(contract) !== active.approval.contract_sha256
        ? `契约文件与批准版本不一致（.cw/tasks/${taskId}/contract.toml）`
        : null;
      // The approved project config is re-hashed every settle: validator and
      // budget semantics were frozen at approval, so any drift (including a
      // file that no longer parses) is visible and fails safe instead of
      // silently changing what the gate enforces.
      const configDrift = await projectConfigDrift(active);
      // A contract that drifted from the verified version invalidates the
      // recorded evidence before anything else reads it.
      await recheckContract(active.ledger, taskId, session, contract);
      const blockedReport = blocked?.reason
        ?? contractDrift
        ?? configDrift
        ?? (proposal === null ? null : unresolvedProposalReason(taskId, proposal.n, proposal.field));

      const tokensBudget = contract.budget?.tokens ?? active.project.budget.tokens;
      const wallMinutes = contract.budget?.wall_minutes ?? active.project.budget.wall_minutes;
      const repairs = contract.budget?.repairs ?? active.project.budget.repairs;
      const base: GateInput = {
        state,
        deliverable: contract.deliverable,
        cancelled: controller.signal.aborted,
        blockedReport,
        budget: {
          tokensExceeded: state.tokens_used >= tokensBudget,
          wallExceeded: state.wall_started_at !== null
            && Date.now() - Date.parse(state.wall_started_at) >= wallMinutes * 60_000,
          repairs,
        },
        freezeConflicts: (await checkFrozen(repo, taskId, session, active.approval.frozen_blobs, work)).conflicts,
        logPath: "",
      };

      let decision = decide(base);
      if (decision.kind === "validate") {
        const run = runValidator({
          repo,
          workRoot: work,
          taskId,
          session,
          contract,
          validator: active.approval.validator,
          approvedInputHashes: active.approval.baseline_inputs_sha256,
          approvedValidatorInputs: active.approval.validator_inputs_sha256,
          signal: controller.signal,
        });
        setValidation({ controller, done: run.then(() => undefined, () => undefined) });
        outcome = await run;
        decision = decide({
          ...base,
          cancelled: controller.signal.aborted,
          verdict: outcome.verdict,
          failures: outcome.failures,
          logPath: `.cw/tasks/${taskId}/runs/${outcome.run}/stdout.log`,
        });
      }

      switch (decision.kind) {
        case "cancel":
          return undefined;
        case "continue": {
          await updateState(repo, taskId, session, (current) => ({ ...current, repairs_used: decision.repairs_used }));
          return {
            entries: [...event.entries, {
              type: "custom_message" as const,
              customType: "counterweight",
              content: decision.message,
              display: true,
            }],
            continue: true,
          };
        }
        case "finish": {
          // Publication is coordinated with cancellation: the verified status
          // is written by a status-guarded transition that re-checks the cancel
          // inside the same task lock. A cancel that already flipped the state
          // is never overwritten with `verified`; a cancel landing after the
          // transition cannot rewrite it either (the cancel transition itself
          // only applies to drafting/approved/running).
          if (controller.signal.aborted) return undefined;
          const material = await writeHandback(repo, taskId, session, {
            contract,
            validator: active.approval.validator,
            reason: "finish",
            questions: [],
            autoVerified: decision.autoVerified,
          });
          const published = await updateState(repo, taskId, session, (current) => {
            if (current.status !== "running" && current.status !== "approved") return current;
            if (controller.signal.aborted) return current;
            return { ...current, status: "verified" };
          });
          if (published.status !== "verified") {
            if (controller.signal.aborted) {
              // The run-level evidence may already be recorded; a cancelled
              // flow must not leave it standing. Scoped to exactly this run.
              if (outcome !== null) {
                await withTaskLock(repo, taskId, session, () =>
                  revokeRunVerification(repo, taskId, session, outcome!.run));
              }
              const cancelledMaterial = await writeHandback(repo, taskId, session, {
                contract,
                validator: active.approval.validator,
                reason: "cancelled",
                questions: ["用户在验收结果发布期间取消任务"],
                autoVerified: false,
              });
              return {
                entries: [...event.entries, {
                  type: "custom_message" as const,
                  customType: "counterweight",
                  content: `[counterweight] 用户取消，验收结果未发布。材料：${cancelledMaterial.md}`,
                  display: true,
                }],
              };
            }
            // Another session's decision (cancel, handback, escalation) won
            // the race: report it instead of claiming a finished task.
            return {
              entries: [...event.entries, {
                type: "custom_message" as const,
                customType: "counterweight",
                content: `[counterweight] 验收通过，但任务状态已变为 ${published.status}，结果未发布`
                  + `。材料：${material.md}`,
                display: true,
              }],
            };
          }
          return {
            entries: [...event.entries, {
              type: "custom_message" as const,
              customType: "counterweight",
              content: `[counterweight] 验收通过，任务结束`
                + `（自动验证：${decision.autoVerified ? "通过" : "未经自动验证"}）。材料：${material.md}`,
              display: true,
            }],
          };
        }
        case "handback": {
          const questions = [...(blocked?.questions ?? [])];
          if (contractDrift !== null) questions.push(contractDrift);
          if (configDrift !== null) questions.push(configDrift);
          if (proposal !== null && blockedReport !== null) questions.push(blockedReport);
          const material = await writeHandback(repo, taskId, session, {
            contract,
            validator: active.approval.validator,
            reason: decision.reason,
            questions,
            autoVerified: false,
          });
          // Status-guarded like the verified publication: a cancel that
          // already flipped the state is never overwritten with handed_back.
          await updateState(repo, taskId, session, (current) => current.status === "approved"
            || current.status === "running"
            ? { ...current, status: "handed_back" }
            : current);
          if (blocked !== null) await clearBlocked(repo, taskId, session);
          return {
            entries: [...event.entries, {
              type: "custom_message" as const,
              customType: "counterweight",
              content: `[counterweight] 任务交还（原因：${decision.reason}）。材料：${material.md}`,
              display: true,
            }],
          };
        }
      }
    } finally {
      for (const { source, fn } of forwards) source.removeEventListener("abort", fn);
      if (validation !== null && validation.controller === controller) setValidation(null);
    }
  }

  /**
   * 门禁处理器超时或抛异常时的回退：先等正在跑的验证彻底结束，再把本轮结论按「无法判定」写成
   * 交还材料、交还任务，绝不判 pass。
   *
   * Timeout or exception inside the gate handler: handback `undetermined`, never a pass.
   *
   * @remarks
   * 副作用：abort 当前验证句柄并等它清理完成（交还材料只在验证器进程组结束后写，避免迟到的结果
   * 与「无法判定」决策竞争），随后写交还材料、把状态改为 `handed_back`（仅当仍是 `running` 或
   * `approved`），并追加一条自定义消息。未接管任务、本轮 outcome 非 `completed`、或状态已不可执行
   * 时直接返回 `undefined`；连交还材料都写不出来时只发一条错误通知，仍然不会给出 pass。
   *
   * Side effects: aborts and awaits the in-flight validation (handback material
   * is written only after the validator process group has settled, so no late
   * result races the `undetermined` decision), then writes the handback
   * material, flips the state to `handed_back` while it is still `running` or
   * `approved`, and appends one custom message. Returns `undefined` when no
   * task is adopted, the turn did not complete, or the state is no longer
   * executable; a failing handback write only notifies and still never
   * produces a pass.
   */
  async function undeterminedFallback(
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
  ): Promise<AgentBeforeSettleEventResult | undefined> {
    const active = task;
    const current = validation;
    if (current !== null) {
      // Handback material is only written after the validator process group
      // and its cleanup have fully settled — no late result may race the
      // undetermined decision.
      current.controller.abort();
      await current.done;
      if (validation !== null && validation.controller === current.controller) setValidation(null);
    }
    if (active === null || event.outcome !== "completed") return undefined;
    try {
      const state = await readState(active.ledger, active.taskId);
      if (state.status !== "running" && state.status !== "approved") return undefined;
      // Re-read the authoritative contract; the session snapshot may be stale.
      const contract = await readContract(
        path.join(active.ledger, ".cw", "tasks", active.taskId, "contract.toml"), active.ledger, active.taskId);
      const material = await writeHandback(active.ledger, active.taskId, active.session, {
        contract,
        validator: active.approval.validator,
        reason: "undetermined",
        questions: ["门禁处理超时或失败，本轮验证结论按无法判定处理"],
        autoVerified: false,
      });
      await updateState(active.ledger, active.taskId, active.session, (current2) =>
        current2.status === "running" || current2.status === "approved"
          ? { ...current2, status: "handed_back" }
          : current2);
      return {
        entries: [...event.entries, {
          type: "custom_message" as const,
          customType: "counterweight",
          content: `[counterweight] 门禁超时或失败，验证结论无法判定，任务交还。材料：${material.md}`,
          display: true,
        }],
      };
    } catch (error) {
      notifyError(ctx, `Counterweight: 门禁失败且交还材料生成失败：${
        error instanceof Error ? error.message : "未知错误"}`);
      return undefined;
    }
  }

  // ---- message_end: hand assistant usage to the meter ----
  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) =>
    withTimeout(limits.messageEndMs, async (signal) => {
      const active = task;
      const message = event.message;
      if (active === null || signal.aborted || message.role !== "assistant") return undefined;
      const usage = message.usage;
      if (usage === undefined) return undefined;
      const session = ctx.sessionManager.getSessionId();
      // A timeout must not leave the usage account half-applied: each write
      // is only started while the handler is still inside its time budget.
      if (signal.aborted) return undefined;
      await recordUsage(active.ledger, active.taskId, {
        time: new Date().toISOString(),
        session,
        model: message.model,
        input: usage.input,
        output: usage.output,
        cache_read: usage.cacheRead,
        cache_write: usage.cacheWrite,
        cost_total: usage.cost?.total ?? null,
      });
      if (signal.aborted) return undefined;
      const total = usage.totalTokens > 0
        ? usage.totalTokens
        : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      await updateState(active.ledger, active.taskId, session, (current) => ({
        ...current,
        tokens_used: current.tokens_used + total,
      }));
      return undefined;
    }, () => undefined));

  // ---- session_shutdown: idempotent termination of any running validation ----
  pi.on("session_shutdown", (_event: SessionShutdownEvent, _ctx: ExtensionContext) =>
    withTimeout(limits.shutdownWaitMs * 2, async () => {
      await stopValidation();
      return undefined;
    }, () => undefined));

  registerTools(pi, { getTask: () => task });

  registerCommands(pi, {
    getTask: () => task,
    setTask: (next) => { task = next; },
    setValidation,
    stopValidation,
  });

  pi.registerCommand("cw-version", {
    description: "显示 Counterweight 当前加载的 Pi 版本",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Counterweight: pi ${VERSION}`, "info");
    },
  });

  /**
   * 记录当前在跑的验证句柄（门禁与命令驱动的先红检查共用这一个槽位），置 null 表示空闲。
   *
   * Store the handle of the validation currently in flight, or null.
   */
  function setValidation(handle: ValidationHandle | null): void {
    validation = handle;
  }

  /**
   * abort 正在跑的验证（门禁或命令驱动的先红检查），并等到它的进程组与清理彻底结束；由 shutdown
   * 处理器与命令调用，空闲时是空操作。只有 `validation` 仍指向被等待的那个句柄时才清掉它，
   * 避免误清后来者的句柄。
   *
   * Abort the in-flight validation (gate or command-driven red check) and
   * wait until its process group and cleanup have fully settled. Idempotent;
   * the reference is only cleared when it still points at the awaited handle.
   */
  async function stopValidation(): Promise<void> {
    const current = validation;
    if (current === null) return;
    // The abort sends SIGTERM to the group, SIGKILL follows after a 5s grace.
    current.controller.abort();
    await current.done;
    if (validation !== null && validation.controller === current.controller) setValidation(null);
  }
}

/**
 * 会话启动时定位该接管的任务：先在仓库（`ctx.cwd`）里按 session 找已登记的活动任务，多个时取最新
 * 的一个并告警；找不到再去看升级工作树的 `.cw/task.json` 引用。
 *
 * Locates the task this session should adopt at startup: first the active
 * tasks registered for this session in the repo, newest one wins with a
 * warning when several match; otherwise the `.cw/task.json` reference of an
 * escalation worktree.
 *
 * @returns 要接管的任务，或 `null`（本会话不接管任务，因此没有门禁）/ The task to adopt, or
 * `null` when this session manages none
 *
 * @remarks
 * 引用损坏、契约或批准记录缺失等错误不会被吞掉，而是抛给 session_start 的回退，落成「本会话不接管
 * 任务」并给出错误通知。
 *
 * Corrupt references and missing contract / approval records are never
 * swallowed: they reach the session_start fallback, which reports an error,
 * rather than leaving a silently ungated session.
 */
async function locateTask(ctx: ExtensionContext): Promise<ActiveTask | null> {
  const repo = ctx.cwd;
  const session = ctx.sessionManager.getSessionId();
  const matches = await findSessionTasks(repo, session);
  if (matches.length > 0) {
    if (matches.length > 1) {
      ctx.ui.notify(`Counterweight: 发现多个活动任务 ${matches.join(", ")}，接管最新的 ${matches.at(-1)}`, "warning");
    }
    return loadTask(repo, repo, matches.at(-1)!, session);
  }
  // M7 escalation worktree: the local `.cw/tasks` is empty; a `.cw/task.json`
  // reference points at the authoritative ledger. Auto-takeover still
  // requires this session to be registered in the ledger — a fresh session
  // runs `/cw task resume` first.
  return locateReferenceTask(repo, session);
}

/**
 * 顺着工作树里的 `.cw/task.json` 引用找到权威账本（引用路径去掉 `.cw/tasks/<id>` 三段即账本根），
 * 并且只在本会话已登记在该任务的会话列表中时才接管——新会话要先 `/cw task resume`。
 *
 * Follows the `.cw/task.json` reference of a worktree to the authoritative
 * ledger (dropping the three trailing `.cw/tasks/<id>` segments) and adopts
 * the task only when this session is registered on it — a fresh session runs
 * `/cw task resume` first.
 *
 * @returns 引用的任务；引用文件不存在或本会话未登记时为 `null` / The referenced task, or
 * `null` when there is no reference file or this session is not registered
 *
 * @throws 引用文件损坏时抛出（区别于「不存在」），让上层报错，绝不静默放开一个没有门禁的会话 /
 * Thrown when the reference file is corrupt (as opposed to missing), so the
 * caller reports it instead of silently ungating the session
 */
async function locateReferenceTask(workRoot: string, session: string): Promise<ActiveTask | null> {
  let reference;
  try {
    reference = await readReference(path.join(workRoot, REFERENCE_FILE));
  } catch (error) {
    if (isNotFound(error)) return null;
    // A corrupt reference must surface, never silently ungated the session.
    throw error;
  }
  // reference.path = <ledger>/.cw/tasks/<taskId>; strip the three segments.
  const ledger = path.resolve(reference.path, "..", "..", "..");
  const state = await readState(ledger, reference.task_id);
  if (!state.sessions.includes(session)) return null;
  return loadTask(workRoot, ledger, reference.task_id, session);
}

/**
 * 读取一个任务的完整会话视图：契约、批准记录与项目配置，全部取自权威任务目录；`root` 取 `workRoot`
 * 的 realpath，`ledger` 单独传入（升级 worktree 里两者不同）。
 *
 * Load the full session view of a task: contract, approval record, and
 * project config, all from the authoritative task directory. Throws when any
 * piece is missing or malformed — callers surface that as an error, never as
 * a silently ungated session.
 *
 * @param workRoot - 工作树根（升级 worktree 里与账本不同）/ Working tree root
 * @param ledger - 权威账本仓库根，持有 `.cw/tasks/<id>/` / The authoritative ledger root
 * @param taskId - 任务 id / Task id
 * @param session - 已登记在该任务上的会话 id / A session id registered on the task
 * @returns 各事件处理器共用的会话视图 / The session view shared by the event handlers
 */
export async function loadTask(
  workRoot: string, ledger: string, taskId: string, session: string,
): Promise<ActiveTask> {
  const root = await realpath(workRoot);
  const contract = await readContract(path.join(ledger, ".cw", "tasks", taskId, "contract.toml"), ledger, taskId);
  const approval = await readApproval(ledger, taskId);
  const project = await readProjectConfig(path.join(ledger, ".cw", "project.toml"));
  return { taskId, root, ledger, session, contract, approval, project };
}

/**
 * 把任务已批准的模型（`state.model`）应用到本会话。只在接管点调用——会话接管、批准、resume、
 * 升级——绝不中途换模型。失败会如实报告而非假装成功：模型名解析不了或 provider 未配认证时保持
 * 会话原模型并通知用户。`state.model` 还是 M7 之前的占位值、或宿主没有模型注册表（旧版假实现/测试）
 * 时静默跳过。
 *
 * Apply the task's approved model (`state.model`) to this session. Called
 * only at adoption points — session takeover, approval, resume, escalation —
 * never mid-task. Failures are reported, never faked: an unresolvable model
 * name or missing provider auth leaves the session's model unchanged and says
 * so. Skips silently when state.model is the pre-M7 placeholder or the host
 * exposes no registry (older fakes/tests).
 */
export async function applyTaskModel(pi: ExtensionAPI, ctx: ExtensionContext, task: ActiveTask): Promise<void> {
  const state = await readState(task.ledger, task.taskId);
  const model = state.model;
  if (model === "unassigned") return;
  const split = model.indexOf("/");
  if (split <= 0) {
    ctx.ui.notify(`Counterweight: state.model 不是 provider/model 形式（${model}），未设置`, "warning");
    return;
  }
  if (typeof pi.setModel !== "function") return;
  const found = ctx.modelRegistry?.find(model.slice(0, split), model.slice(split + 1));
  if (found === undefined) {
    ctx.ui.notify(`Counterweight: 模型 ${model} 不在模型注册表中，未设置`, "error");
    return;
  }
  const applied = await pi.setModel(found);
  if (!applied) {
    ctx.ui.notify(`Counterweight: 模型 ${model} 的 provider 未配置认证，模型未切换`, "warning");
  }
}

/**
 * 存在未落定提议时给门禁的阻塞原因：文案会进入门禁的 blockedReport，说明必须先按提议生成新契约
 * 版本并重跑先红检查，才能继续。
 *
 * Blocked reason handed to the gate while a proposal is unresolved: the text
 * lands in the gate's blockedReport and states that a new contract version and
 * a re-run red check come first.
 */
function unresolvedProposalReason(taskId: string, n: number, field: string): string {
  return `存在未落定的契约变更提议 .cw/tasks/${taskId}/proposals/${n}.json（字段 ${field}），`
    + "需要生成新契约版本并重跑先红检查后才能继续";
}

/**
 * 当前的 `.cw/project.toml` 为何不能再驱动这个任务：规范化哈希与批准版本不一致，或文件已经无法解析。
 * 与批准版本一致时返回 null。fail-safe：读不出来或解析失败一律算作漂移，绝不「读不到就放行」。
 *
 * Why the current `.cw/project.toml` may not drive this task anymore: the
 * canonical hash differs from the approved one, or the file no longer parses.
 * Null when it matches the approval. Fail-safe: unreadable counts as drift.
 */
async function projectConfigDrift(active: ActiveTask): Promise<string | null> {
  try {
    const current = await readProjectConfig(path.join(active.ledger, ".cw", "project.toml"));
    if (canonicalSha256(current) === active.approval.project_config_sha256) return null;
  } catch {
    return "project.toml 不可读或非法（.cw/project.toml），与批准版本不一致，需恢复或重新批准";
  }
  return "project.toml 与批准版本不一致（.cw/project.toml）；验证器与预算以批准快照为准，需恢复或重新批准";
}

/**
 * 直接写入受保护路径（契约或任务文件）时的拒绝理由，指引改用 propose_contract_change。
 *
 * Block reason for a direct write to a protected path: it points the caller at
 * propose_contract_change instead.
 */
const PROTECTED_REASON = (relative: string) => `[counterweight] ${relative} 是受保护路径（契约或任务文件）。`
  + "如需变更请调用 propose_contract_change；不得直接写入。";

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
 * frozen file is blocked even though its lexical name is not protected. A
 * dangling alias is fail-closed: the write tool would follow it and recreate
 * an unverifiable target, so only a plain missing path (a genuinely new file)
 * stays writable.
 *
 * @returns `undefined` 表示放行；`{ block: true; reason }` 表示拒绝本次调用 /
 * `undefined` to allow the call, `{ block: true; reason }` to refuse it
 */
async function checkProtectedTarget(
  active: ActiveTask, raw: string,
): Promise<ToolCallEventResult | undefined> {
  const lexical = toRepoRelative(active.root, raw);
  if (lexical === null) {
    return {
      block: true,
      reason: `[counterweight] 路径不在仓库内，无法核对受保护集合，已拒绝：${raw}`,
    };
  }
  if (isProtectedPath(lexical, active.contract, active.taskId)) {
    return { block: true, reason: PROTECTED_REASON(lexical) };
  }
  let resolved: string;
  try {
    resolved = await resolveSymlinkInRepo(active.root, lexical);
  } catch (error) {
    if (!isNotFound(error)) {
      // Existing target that cannot be resolved inside the repo (symlink
      // escape) — fail closed rather than allow an unverifiable write.
      return { block: true, reason: UNVERIFIABLE_REASON(raw) };
    }
    const absolute = path.join(active.root, lexical);
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
  if (resolved !== lexical && isProtectedPath(resolved, active.contract, active.taskId)) {
    return { block: true, reason: `${PROTECTED_REASON(resolved)}（路径 ${raw} 指向该受保护文件）` };
  }
  return undefined;
}

/**
 * 内置写入工具的文件路径参数：只有 `edit` 与 `write` 会声明要改的路径；bash 等其它改写工作树的
 * 途径不在这里预拦，改由 `tool_result` 的冻结检查兜底。
 *
 * File-path inputs of built-in write tools. Only `edit` and `write` declare a
 * path they will modify; bash and other routes to the worktree are covered by
 * the `tool_result` freeze check instead of pre-blocked here.
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
function toRepoRelative(repo: string, value: string): string | null {
  const absolute = path.isAbsolute(value) ? value : path.resolve(repo, value);
  const relative = path.relative(repo, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}
