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
import { realpath } from "node:fs/promises";
import { contractSha256, readContract } from "../../core/contract.js";
import { recheckArtifacts } from "../../core/evidence.js";
import { isProtectedPath, checkFrozen, recheckContract, recheckTree } from "../../core/freeze.js";
import { decide, type GateInput } from "../../core/gate.js";
import { writeHandback } from "../../core/handback.js";
import { recordUsage } from "../../core/meter.js";
import { readProjectConfig } from "../../core/config.js";
import { isNotFound, resolveSymlinkInRepo } from "../../core/paths.js";
import { runValidator, type RunOutcome } from "../../core/runner.js";
import {
  clearBlocked,
  findSessionTasks,
  findUnresolvedProposal,
  readApproval,
  readBlocked,
  readState,
  updateState,
  type Approval,
} from "../../core/task.js";
import type { Contract, ProjectConfig } from "../../core/types.js";
import { registerTools } from "./tools.js";

/**
 * A task this session manages, with everything the event handlers need. All
 * judgment (gate order, evidence verdicts, freeze conflicts) stays in core;
 * this adapter only translates Pi events into core calls and core results
 * into Pi returns. `contract` is the session-start snapshot used only for
 * cheap checks; the gate re-reads the authoritative contract.toml every time.
 */
export interface ActiveTask {
  taskId: string;
  /** Realpath of the repository root, resolved once at session start. */
  root: string;
  session: string;
  contract: Contract;
  approval: Approval;
  project: ProjectConfig;
}

export interface AdapterTimeouts {
  toolCallMs: number;
  toolResultMs: number;
  messageEndMs: number;
  sessionStartMs: number;
  /** Added on top of the approved validator timeout for the gate handler. */
  gateMarginMs: number;
  shutdownWaitMs: number;
}

const DEFAULT_TIMEOUTS: AdapterTimeouts = {
  toolCallMs: 10_000,
  toolResultMs: 60_000,
  messageEndMs: 10_000,
  sessionStartMs: 120_000,
  gateMarginMs: 120_000,
  shutdownWaitMs: 10_000,
};

interface ValidationHandle {
  controller: AbortController;
  done: Promise<void>;
}

/**
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
        await recheckTree(task.root, task.taskId, task.session);
        await recheckArtifacts(task.root, task.taskId, task.session);
        await recheckContract(task.root, task.taskId, task.session, task.contract);
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
      const outcome = await checkFrozen(active.root, active.taskId, active.session, active.approval.frozen_blobs);
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

  async function runGate(
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
    outerSignal: AbortSignal,
  ): Promise<AgentBeforeSettleEventResult | undefined> {
    const active = task;
    if (active === null) return undefined;
    if (event.outcome !== "completed") return undefined;
    const { root: repo, taskId } = active;
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
        path.join(active.root, ".cw", "tasks", taskId, "contract.toml"), active.root);
      let state = await readState(repo, taskId);
      if (state.status !== "approved" && state.status !== "running") return undefined;
      if (state.status === "approved") {
        state = await updateState(repo, taskId, session, (current) => current.status === "approved"
          ? { ...current, status: "running", wall_started_at: current.wall_started_at ?? new Date().toISOString() }
          : current);
      }

      const blocked = await readBlocked(repo, taskId);
      const proposal = await findUnresolvedProposal(repo, taskId);
      const contractDrift = contractSha256(contract) !== active.approval.contract_sha256
        ? `契约文件与批准版本不一致（.cw/tasks/${taskId}/contract.toml）`
        : null;
      // A contract that drifted from the verified version invalidates the
      // recorded evidence before anything else reads it.
      await recheckContract(repo, taskId, session, contract);
      const blockedReport = blocked?.reason
        ?? contractDrift
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
        freezeConflicts: (await checkFrozen(repo, taskId, session, active.approval.frozen_blobs)).conflicts,
        logPath: "",
      };

      let decision = decide(base);
      if (decision.kind === "validate") {
        const run = runValidator({
          repo,
          taskId,
          session,
          contract,
          validator: active.approval.validator,
          approvedInputHashes: active.approval.baseline_inputs_sha256,
          signal: controller.signal,
        });
        validation = { controller, done: run.then(() => undefined, () => undefined) };
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
          const material = await writeHandback(repo, taskId, session, {
            contract,
            validator: active.approval.validator,
            reason: "finish",
            questions: [],
            autoVerified: decision.autoVerified,
          });
          await updateState(repo, taskId, session, (current) => ({ ...current, status: "verified" }));
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
          if (proposal !== null && blockedReport !== null) questions.push(blockedReport);
          const material = await writeHandback(repo, taskId, session, {
            contract,
            validator: active.approval.validator,
            reason: decision.reason,
            questions,
            autoVerified: false,
          });
          await updateState(repo, taskId, session, (current) => ({ ...current, status: "handed_back" }));
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
      if (validation !== null && validation.controller === controller) validation = null;
    }
  }

  /** Timeout or exception inside the gate handler: handback `undetermined`, never a pass. */
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
      if (validation !== null && validation.controller === current.controller) validation = null;
    }
    if (active === null || event.outcome !== "completed") return undefined;
    try {
      const state = await readState(active.root, active.taskId);
      if (state.status !== "running" && state.status !== "approved") return undefined;
      // Re-read the authoritative contract; the session snapshot may be stale.
      const contract = await readContract(
        path.join(active.root, ".cw", "tasks", active.taskId, "contract.toml"), active.root);
      const material = await writeHandback(active.root, active.taskId, active.session, {
        contract,
        validator: active.approval.validator,
        reason: "undetermined",
        questions: ["门禁处理超时或失败，本轮验证结论按无法判定处理"],
        autoVerified: false,
      });
      await updateState(active.root, active.taskId, active.session, (current2) =>
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
      await recordUsage(active.root, active.taskId, {
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
      await updateState(active.root, active.taskId, session, (current) => ({
        ...current,
        tokens_used: current.tokens_used + total,
      }));
      return undefined;
    }, () => undefined));

  // ---- session_shutdown: idempotent termination of any running validation ----
  pi.on("session_shutdown", (_event: SessionShutdownEvent, _ctx: ExtensionContext) =>
    withTimeout(limits.shutdownWaitMs * 2, async () => {
      const current = validation;
      if (current !== null) {
        // Wait for the validator process group and all associated cleanup to
        // finish before releasing the reference; the reference is never
        // dropped while work is still running. Cleanup is bounded: the abort
        // sends SIGTERM to the group, SIGKILL follows after a 5s grace.
        current.controller.abort();
        await current.done;
        validation = null;
      }
      return undefined;
    }, () => undefined));

  registerTools(pi, { getTask: () => task });

  pi.registerCommand("cw-version", {
    description: "显示 Counterweight 当前加载的 Pi 版本",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Counterweight: pi ${VERSION}`, "info");
    },
  });
}

async function locateTask(ctx: ExtensionContext): Promise<ActiveTask | null> {
  const repo = ctx.cwd;
  const session = ctx.sessionManager.getSessionId();
  const matches = await findSessionTasks(repo, session);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    ctx.ui.notify(`Counterweight: 发现多个活动任务 ${matches.join(", ")}，接管最新的 ${matches.at(-1)}`, "warning");
  }
  const taskId = matches.at(-1)!;
  const root = await realpath(repo);
  const contract = await readContract(path.join(root, ".cw", "tasks", taskId, "contract.toml"), root);
  const approval = await readApproval(root, taskId);
  const project = await readProjectConfig(path.join(root, ".cw", "project.toml"));
  return { taskId, root, session, contract, approval, project };
}

function unresolvedProposalReason(taskId: string, n: number, field: string): string {
  return `存在未落定的契约变更提议 .cw/tasks/${taskId}/proposals/${n}.json（字段 ${field}），`
    + "需要生成新契约版本并重跑先红检查后才能继续";
}

const PROTECTED_REASON = (relative: string) => `[counterweight] ${relative} 是受保护路径（契约或任务文件）。`
  + "如需变更请调用 propose_contract_change；不得直接写入。";

const UNVERIFIABLE_REASON = (value: string) =>
  `[counterweight] 路径无法核对受保护集合（符号链接逃逸仓库或不可解析），已拒绝：${value}`;

/**
 * Whether a write tool may touch `raw`. Checks the lexical path and, for
 * existing targets, the fully resolved real path — an alias pointing at a
 * frozen file is blocked even though its lexical name is not protected.
 * Dangling aliases are judged by their eventual parent directory plus final
 * segment, so a safe new file stays writable.
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
  const candidates: string[] = [];
  try {
    candidates.push(await resolveSymlinkInRepo(active.root, lexical));
  } catch (error) {
    if (isNotFound(error)) {
      // Missing target or dangling alias: judge the eventual location —
      // the resolved parent directory plus the final segment.
      const dir = path.posix.dirname(lexical);
      if (dir !== ".") {
        try {
          const resolvedDir = await resolveSymlinkInRepo(active.root, dir);
          const viaParent = resolvedDir === "" ? path.posix.basename(lexical)
            : `${resolvedDir}/${path.posix.basename(lexical)}`;
          candidates.push(viaParent);
        } catch (parentError) {
          if (!isNotFound(parentError)) return { block: true, reason: UNVERIFIABLE_REASON(raw) };
        }
      }
    } else {
      // Existing target that cannot be resolved inside the repo (symlink
      // escape) — fail closed rather than allow an unverifiable write.
      return { block: true, reason: UNVERIFIABLE_REASON(raw) };
    }
  }
  for (const candidate of candidates) {
    if (candidate !== lexical && isProtectedPath(candidate, active.contract, active.taskId)) {
      return { block: true, reason: `${PROTECTED_REASON(candidate)}（路径 ${raw} 指向该受保护文件）` };
    }
  }
  return undefined;
}

/**
 * File-path inputs of built-in write tools. Only `edit` and `write` declare a
 * path they will modify; bash and other routes to the worktree are covered by
 * the `tool_result` freeze check instead of pre-blocked here.
 */
function writeToolPath(event: ToolCallEvent): string | null {
  if (event.toolName !== "edit" && event.toolName !== "write") return null;
  const value = (event.input as Record<string, unknown>).path;
  return typeof value === "string" && value !== "" ? value : null;
}

/** Lexical repo-relative form, or null when the target escapes the repository. */
function toRepoRelative(repo: string, value: string): string | null {
  const absolute = path.isAbsolute(value) ? value : path.resolve(repo, value);
  const relative = path.relative(repo, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}
