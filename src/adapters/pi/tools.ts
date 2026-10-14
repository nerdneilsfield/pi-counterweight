/**
 * 四个只读角色工具。没配模型的角色仍注册，调用时返回错误。
 * 用量记入 `.cw/meter.jsonl`；记账失败不丢已经拿到的回答。
 */
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectConfig } from "../../core/config.js";
import { recordEvent, recordUsage } from "../../core/meter.js";
import { rolePromptPath, type RoleName } from "../../roles/prompts.js";
import { runRole } from "../../roles/run.js";

export interface ToolRegistration {
  getProject: () => ProjectConfig | null;
  getRepo: () => string | null;
  /** 测试用：覆盖 pi CLI。 */
  cliPath?: string;
  /** 测试用：覆盖该角色的超时。 */
  timeoutMs?: Partial<Record<RoleName, number>>;
}

const ROLES: Array<{
  name: RoleName;
  tool: string;
  label: string;
  description: string;
  input: "question" | "review";
}> = [
  {
    name: "explorer",
    tool: "cw_explore",
    label: "探索代码",
    description: "把一个代码问题交给只读探索者。它只有 read 和 grep，返回带来源的结论。不做修改。",
    input: "question",
  },
  {
    name: "review",
    tool: "cw_review",
    label: "正确性审查",
    description: "把这次的要求和 diff 交给只读审查。它只报行为错误和被削弱的真实边界，不报缺测试、不提重构、不改文件。",
    input: "review",
  },
  {
    name: "over_review",
    tool: "cw_over_review",
    label: "过度工程审查",
    description: "把这次的要求和 diff 交给只读审查。它只报没资格留下的抽象、兜底、多余测试和防御性分支，不评对错、不改文件。",
    input: "review",
  },
  {
    name: "research",
    tool: "cw_research",
    label: "研究问题",
    description: "把主模型读代码仍定不下来的问题交给只读研究角色。结论在前，没读到的标未核实。不实现。",
    input: "question",
  },
];

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: undefined };
}

export function registerTools(pi: ExtensionAPI, registration: ToolRegistration): void {
  for (const role of ROLES) {
    const parameters = role.input === "question"
      ? Type.Object({ question: Type.String({ minLength: 1 }) }, { additionalProperties: false })
      : Type.Object({
          request: Type.String({ minLength: 1 }),
          diff: Type.String({ minLength: 1 }),
        }, { additionalProperties: false });
    pi.registerTool({
      name: role.tool,
      label: role.label,
      description: role.description,
      parameters,
      execute: async (_id, params, signal, _onUpdate, ctx: ExtensionToolContext) => {
        const model = registration.getProject()?.models[role.name] ?? null;
        if (model === null) {
          return text(`[counterweight] 未配置 [models].${role.name}，${role.tool} 不可用。`);
        }
        const repo = registration.getRepo();
        if (repo === null) return text(`[counterweight] 会话尚未确定仓库根，${role.tool} 不可用。`);
        const message = role.input === "question"
          ? (params as { question: string }).question
          : reviewMessage(params as { request: string; diff: string });
        return text(await runAndMeter(ctx, repo, role.name, role.tool, model, message, signal, registration));
      },
    });
  }
}

function reviewMessage(params: { request: string; diff: string }): string {
  return `要求：\n${params.request}\n\ndiff：\n${params.diff}\n`;
}

async function runAndMeter(
  ctx: ExtensionToolContext, repo: string, role: RoleName, tool: string, model: string,
  message: string, signal: AbortSignal | undefined, registration: ToolRegistration,
): Promise<string> {
  const session = ctx.sessionManager.getSessionId();
  const run = await runRole({
    role,
    workRoot: repo,
    model,
    message,
    signal,
    cliPath: registration.cliPath,
    timeoutMs: registration.timeoutMs?.[role],
  });
  let spent = 0;
  let meterError: string | null = null;
  for (const sample of run.usage) {
    try {
      await recordUsage(repo, {
        time: new Date().toISOString(),
        session,
        model,
        input: sample.input,
        output: sample.output,
        cache_read: sample.cacheRead,
        cache_write: sample.cacheWrite,
        cost_total: sample.costTotal,
      });
    } catch (error) {
      meterError ??= error instanceof Error ? error.message : "未知错误";
    }
    spent += sample.totalTokens > 0
      ? sample.totalTokens
      : sample.input + sample.output + sample.cacheRead + sample.cacheWrite;
  }
  const meterNote = meterError === null ? "" : `；用量未能写入计量（${meterError}）`;
  if (run.error !== null) {
    await recordEvent(repo, session, role, {
      outcome: "failed", error: run.error, tokens: spent,
      timed_out: run.timedOut, cancelled: run.cancelled,
    });
    return `[counterweight] ${tool} 未返回结果（${run.error}）；本次消耗 ${spent} token${meterNote}。`;
  }
  await recordEvent(repo, session, role, { outcome: "answered", tokens: spent, timed_out: false });
  return `[counterweight] ${tool}（模型 ${model}，提示 ${rolePromptPath(role)}，消耗 ${spent} token${meterNote}）：\n${run.answer}`;
}
