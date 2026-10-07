/**
 * 注册 Counterweight 暴露给模型的三个工具：report_blocked（报告受阻）、propose_contract_change
 * （提议契约变更；直接写受保护文件会被拒绝）与 cw_explore（只读探索者，带审计与记账）。
 *
 * 三个工具都是 `sequential`：它们读任务账本、向账本追加记录，不能彼此或与并行的同级调用交错。
 * 工具本身不做判断，只把事实写进 core 的账本与计量文件；门禁在结算时读取这些记录。
 *
 * Registers the three model-facing Counterweight tools: report_blocked,
 * propose_contract_change (direct writes to protected files are refused), and
 * cw_explore (the read-only explorer, audited and metered).
 *
 * All three are declared `sequential`: they read the task ledger and append to
 * it, so they must not interleave with each other or with parallel sibling
 * calls. The tools judge nothing; they record facts into the core ledger and
 * meter files, and the gate reads those records at settle time.
 */
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { finalizeExplorerAnswer } from "../../core/explore.js";
import { recordTaskEvent, recordUsage } from "../../core/meter.js";
import { treeHash } from "../../core/gitstate.js";
import { readState, updateState, writeBlocked, writeProposal } from "../../core/task.js";
import { runExplorer } from "../../explorer/run.js";
import type { ActiveTask } from "./index.js";

/**
 * 工具注册所需的依赖：读取当前受管任务的回调，以及两个只给测试用的注入口。生产调用不传这两个口，
 * CLI 发现与子进程预算由 `runExplorer` 使用自身默认值。
 *
 * What tool registration needs: a callback for the currently managed task plus
 * two test seams. Production calls pass neither seam; CLI discovery and the
 * subprocess budget stay with `runExplorer`'s own defaults.
 */
export interface ToolRegistration {
  /**
   * 当前正在管理的任务；本会话不管理任务时为 null。
   *
   * Currently managed task, or null when this session manages none.
   */
  getTask: () => ActiveTask | null;
  /**
   * 测试接缝：覆盖探索者 CLI 的发现结果。
   *
   * Test seam: overrides explorer CLI discovery.
   */
  explorerCliPath?: string;
  /**
   * 测试接缝：覆盖探索者子进程的预算。
   *
   * Test seam: overrides the explorer subprocess budget.
   */
  explorerTimeoutMs?: number;
}

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: undefined };
}

/**
 * 注册模型可见的工具。`report_blocked` 与 `propose_contract_change` 会读写任务账本，是 harness
 * 工具；`cw_explore` 交给只读探索者子进程。三者都声明为 `sequential`，彼此以及与并行的同级调用
 * 不能交错。
 *
 * The two model-facing harness tools. Both are declared `sequential`: they
 * read and append task-ledger files and must not interleave with each other
 * or with parallel sibling calls.
 */
export function registerTools(pi: ExtensionAPI, registration: ToolRegistration): void {
  /**
   * report_blocked：记录受阻报告（原因 + 待答问题）。没有受管任务时只回一句说明、不落记录；记录
   * 本身不改变任务状态，交还由本轮结束时的门禁完成。
   *
   * report_blocked: records a blocked report (reason plus open questions). With
   * no managed task it only answers and writes nothing; the record changes no
   * status — the gate hands the task back when the turn settles.
   */
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

  /**
   * propose_contract_change：把契约字段改动写成提议文件。有交互界面时当场问用户并记
   * approved/rejected，没有界面时记 pending；本工具从不直接改 contract.toml，生成新契约版本与
   * 重跑先红检查归批准流程。
   *
   * propose_contract_change: writes a field change as a proposal file. With a UI
   * it asks the user and records approved/rejected, otherwise pending. It never
   * edits contract.toml itself; regenerating the contract and re-running the
   * red check belong to the approval flow.
   */
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

  /**
   * cw_explore：把问题交给只读探索者子进程，回答经后处理（30 行上限、`path:line` 引用校验）后
   * 返回。拒绝条件、token 记账与不可信标记都在 `runExploreForTask` 里，这里只是入口。
   *
   * cw_explore: hands the question to the read-only explorer subprocess and
   * returns the post-processed answer (30-line cap, `path:line` validation).
   * Refusal rules, token accounting, and the untrusted marking live in
   * `runExploreForTask`; this registration is only the entry point.
   */
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
 * 对受管任务跑一轮探索者：子进程调用前后各取一次树哈希，用量计入父会话的计量与任务预算，回答经后
 * 处理（30 行上限、`path:line` 校验），运行期间树哈希发生变化就给回答打上不可信标记。
 *
 * One explorer round for the managed task: subprocess run with tree
 * bookkeeping around it, usage into the parent meter and budget, answer
 * post-processed (30-line cap, `path:line` validation), and an untrusted
 * marking whenever the tree hash moved across the run.
 *
 * @returns 给模型的一段文本：拒绝原因、失败说明（带本次 token 消耗）或最终回答 /
 * One text block for the model: refusal, failure note with tokens spent, or the finalized answer
 *
 * @remarks
 * 权限以权威账本为准，不看内存里的注册信息：状态不是 approved/running、或本会话已不在任务的会话
 * 列表里，就不起子进程，只返回拒绝文案。用量无论成败都记账（token 已经花掉），回答出来与否都写一条
 * `explore` 任务事件，供审计。
 *
 * Authority is the ledger, not the in-memory registration: a state other than
 * approved/running, or a session no longer listed on the task, spawns no
 * subprocess and only returns a refusal. Usage is metered no matter how the run
 * ended — the tokens were spent — and every round writes one `explore` task
 * event for audit.
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
 * 探索者不得写入：运行期间树哈希发生变化（或树哈希根本算不出来）就把回答标为不可信（plan M8
 * item 5）。被改动的文件保持原样，不做回滚。
 *
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
