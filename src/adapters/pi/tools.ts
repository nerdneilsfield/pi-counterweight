import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { finalizeExplorerAnswer } from "../../core/explore.js";
import { recordTaskEvent, recordUsage } from "../../core/meter.js";
import { treeHash } from "../../core/gitstate.js";
import { readState, updateState, writeBlocked, writeProposal } from "../../core/task.js";
import { runExplorer } from "../../explorer/run.js";
import type { ActiveTask } from "./index.js";

export interface ToolRegistration {
  /** Currently managed task, or null when this session manages none. */
  getTask: () => ActiveTask | null;
  /** Test seam: overrides explorer CLI discovery. */
  explorerCliPath?: string;
  /** Test seam: overrides the explorer subprocess budget. */
  explorerTimeoutMs?: number;
}

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: undefined };
}

/**
 * The two model-facing harness tools. Both are declared `sequential`: they
 * read and append task-ledger files and must not interleave with each other
 * or with parallel sibling calls.
 */
export function registerTools(pi: ExtensionAPI, registration: ToolRegistration): void {
  pi.registerTool({
    name: "report_blocked",
    label: "报告受阻",
    description:
      "向 Counterweight 报告当前任务无法继续（缺少决定、权限或信息）。"
      + "记录后本轮结束时任务将被交还给用户，不再运行验收。只在真正受阻时调用。",
    parameters: Type.Object({
      reason: Type.String({ minLength: 1 }),
      questions: Type.Array(Type.String()),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const task = registration.getTask();
      if (task === null) return text("[counterweight] 当前没有受管任务，report_blocked 未记录。");
      await writeBlocked(task.ledger, task.taskId, task.session, {
        reason: params.reason,
        questions: params.questions,
      });
      return text("[counterweight] 受阻报告已记录；本轮结束时将交还，不再运行验收。");
    },
  });

  pi.registerTool({
    name: "propose_contract_change",
    label: "提议契约变更",
    description:
      "提议修改当前任务的契约字段（如 frozen、acceptance）。"
      + "有交互界面时由用户确认；无交互界面时记录提议，本轮结束时任务将被交还给用户决定。"
      + "直接写入受保护文件会被拒绝，必须使用本工具。",
    parameters: Type.Object({
      field: Type.String({ minLength: 1 }),
      new_value: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) => {
      const task = registration.getTask();
      if (task === null) return text("[counterweight] 当前没有受管任务，契约变更提议未记录。");
      const status = ctx.hasUI
        ? await ctx.ui.confirm(
            "Counterweight 契约变更提议",
            `字段：${params.field}\n新值：${params.new_value}\n理由：${params.reason}`,
          )
          ? "approved"
          : "rejected"
        : "pending";
      const proposal = await writeProposal(task.ledger, task.taskId, task.session, {
        field: params.field,
        new_value: params.new_value,
        reason: params.reason,
        status,
      });
      const note = status === "approved"
        ? "提议已获用户批准并记录；新契约版本生成与先红重跑由批准流程完成，完成前本轮结束时将交还。"
        : status === "rejected"
          ? "提议被用户拒绝；当前契约保持不变。"
          : "当前无交互界面，提议已记录；本轮结束时将交还，由用户决定。";
      return text(`[counterweight] 契约变更提议已写入 .cw/tasks/${task.taskId}/proposals/${proposal.n}.json。${note}`);
    },
  });

  pi.registerTool({
    name: "cw_explore",
    label: "探索者提问",
    description:
      "向只读探索者子代理提问代码库问题。探索者在子进程中运行，只有 read 与 grep 两个工具，"
      + "不能修改文件；回答有 30 行上限，逐条校验 path:line 引用。用于定位代码事实（实现位置、调用关系、现状），"
      + "不要用它做需要写入或执行的操作。token 消耗计入当前任务预算。",
    parameters: Type.Object({
      question: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const task = registration.getTask();
      if (task === null) return text("[counterweight] 当前没有受管任务，cw_explore 不可用。");
      return text(await runExploreForTask(task, params.question, signal, registration));
    },
  });
}

/**
 * One explorer round for the managed task: subprocess run with tree
 * bookkeeping around it, usage into the parent meter and budget, answer
 * post-processed (30-line cap, `path:line` validation), and an untrusted
 * marking whenever the tree hash moved across the run.
 */
async function runExploreForTask(
  task: ActiveTask, question: string, signal: AbortSignal | undefined,
  registration: ToolRegistration,
): Promise<string> {
  // The in-memory registration can be stale: another session may have
  // cancelled, handed back, or taken the task over since this session
  // adopted it. The authoritative ledger decides — no subprocess is spawned
  // unless the task is still in an executable state and this session is
  // still registered on it.
  const state = await readState(task.ledger, task.taskId);
  if (state.status !== "approved" && state.status !== "running") {
    return `[counterweight] cw_explore 拒绝执行：任务 ${task.taskId} 当前状态为 ${state.status}，不在可执行状态。`;
  }
  if (!state.sessions.includes(task.session)) {
    return `[counterweight] cw_explore 拒绝执行：本会话已不再登记在任务 ${task.taskId} 的会话列表中。`;
  }
  const model = task.project.models.explorer;
  const before = await treeHash(task.root);
  const run = await runExplorer({
    workRoot: task.root,
    model,
    question,
    signal,
    cliPath: registration.explorerCliPath,
    timeoutMs: registration.explorerTimeoutMs,
  });
  const after = await treeHash(task.root);

  // Usage is accounted no matter how the run ended: the tokens were spent.
  let spent = 0;
  for (const sample of run.usage) {
    await recordUsage(task.ledger, task.taskId, {
      time: new Date().toISOString(),
      session: task.session,
      model,
      input: sample.input,
      output: sample.output,
      cache_read: sample.cacheRead,
      cache_write: sample.cacheWrite,
      cost_total: sample.costTotal,
    });
    spent += sample.totalTokens > 0
      ? sample.totalTokens
      : sample.input + sample.output + sample.cacheRead + sample.cacheWrite;
  }
  if (spent > 0) {
    await updateState(task.ledger, task.taskId, task.session, (current) => ({
      ...current,
      tokens_used: current.tokens_used + spent,
    }));
  }

  if (run.error !== null) {
    await recordTaskEvent(task.ledger, task.taskId, task.session, "explore", {
      outcome: "failed", error: run.error, tokens: spent,
      timed_out: run.timedOut, cancelled: run.cancelled,
      escaped_reads: run.escapedReads.length,
    });
    return `[counterweight] 探索者未返回结果（${run.error}）；本次消耗 ${spent} token。`;
  }
  const finalized = await finalizeExplorerAnswer(run.answer!, task.root);
  const untrusted = treeUntrustedReason(before, after);
  await recordTaskEvent(task.ledger, task.taskId, task.session, "explore", {
    outcome: "answered",
    trusted: untrusted === null,
    truncated: finalized.truncated,
    invalid_refs: finalized.invalidRefs.length,
    missing_refs: finalized.missingRefs.length,
    tokens: spent,
    timed_out: run.timedOut,
  });
  const header = `[counterweight] 探索者回答（模型 ${model}，消耗 ${spent} token）`
    + (untrusted === null ? "" : `；${untrusted}，本次结果不可信`);
  return `${header}：\n${finalized.text}`;
}

/**
 * The explorer must not write; a tree hash that moved across the run (or a
 * tree hash that cannot be computed at all) marks the answer untrusted
 * (plan M8 item 5). The changed files are left as they are.
 */
function treeUntrustedReason(
  before: Awaited<ReturnType<typeof treeHash>>,
  after: Awaited<ReturnType<typeof treeHash>>,
): string | null {
  if (before.supported && after.supported) {
    return before.value !== after.value ? "探索者运行期间仓库树发生变化" : null;
  }
  return "无法核对仓库树哈希";
}
