import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeBlocked, writeProposal } from "../../core/task.js";
import type { ActiveTask } from "./index.js";

export interface ToolRegistration {
  /** Currently managed task, or null when this session manages none. */
  getTask: () => ActiveTask | null;
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
      await writeBlocked(task.repo, task.taskId, task.session, {
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
      const proposal = await writeProposal(task.repo, task.taskId, task.session, {
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
}
