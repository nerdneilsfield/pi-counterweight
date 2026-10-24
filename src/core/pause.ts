/**
 * PAUSE：agent 第一次要改源码时拦下这一次编辑，让一个看不到工作区的强模型读完前面的调查，写一份修复计划。
 * 只拦一次；计划是建议，执行者可以不同意。本文件只含纯逻辑，不引用 pi。
 * 证据与限制见 README 的 PAUSE 一节：只在弱执行者上验证过，所以默认关闭。
 */

/** 这些路径的写入不算“改源码”：本扩展自己的目录，和常见的临时目录。 */
const SCRATCH_PREFIXES = [".cw/", "tmp/"];

/**
 * 这次写入是不是对仓库源码的第一手改动。仓库外、`.cw/`、常见草稿目录都不算。
 * `relative` 是已经解析成仓库相对路径（用 `/` 分隔）的目标，仓库外时为 null。
 */
export function isSourceEdit(relative: string | null): boolean {
  if (relative === null) return false;
  return !SCRATCH_PREFIXES.some((prefix) => relative === prefix.slice(0, -1) || relative.startsWith(prefix));
}

/** 会话里一条消息的最小形状。只取序列化需要的字段，避免依赖 pi 的类型。 */
export interface TranscriptMessage {
  role: string;
  content?: unknown;
  toolName?: string;
  command?: string;
  output?: string;
  summary?: string;
}

/** transcript 的字符预算。超出时丢最早的，保留最近的调查。 */
export const TRANSCRIPT_BUDGET = 60_000;
/** 单条工具结果的上限。读大文件的结果通常是噪声。 */
const TOOL_RESULT_CAP = 2_000;

/**
 * 把会话消息渲染成给 planner 的纯文本。保留用户请求、助手的文字与工具调用、工具结果（截断），
 * 丢掉思考块和图片。超过预算时从最早处丢，并在开头注明丢了多少。
 */
export function renderTranscript(messages: readonly TranscriptMessage[], budget: number = TRANSCRIPT_BUDGET): string {
  const blocks: string[] = [];
  for (const message of messages) {
    const block = renderMessage(message);
    if (block !== "") blocks.push(block);
  }
  let total = 0;
  let start = blocks.length;
  while (start > 0 && total + blocks[start - 1]!.length <= budget) {
    start -= 1;
    total += blocks[start]!.length;
  }
  const dropped = start;
  const kept = blocks.slice(start).join("\n\n");
  return dropped === 0 ? kept : `（更早的 ${dropped} 段记录因超出长度预算被省略）\n\n${kept}`;
}

function renderMessage(message: TranscriptMessage): string {
  switch (message.role) {
    case "user":
      return `[用户]\n${textOf(message.content)}`;
    case "assistant":
      return renderAssistant(message.content);
    case "toolResult": {
      const body = textOf(message.content);
      const cut = body.length > TOOL_RESULT_CAP ? `${body.slice(0, TOOL_RESULT_CAP)}\n…（已截断）` : body;
      return `[工具结果 ${message.toolName ?? ""}]\n${cut}`;
    }
    case "bashExecution":
      return `[bash] ${message.command ?? ""}\n${(message.output ?? "").slice(0, TOOL_RESULT_CAP)}`;
    case "compactionSummary":
    case "branchSummary":
      return `[此前的摘要]\n${message.summary ?? ""}`;
    default:
      return "";
  }
}

function renderAssistant(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const item = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
    if (item.type === "text" && typeof item.text === "string" && item.text.trim() !== "") parts.push(item.text);
    if (item.type === "toolCall" && typeof item.name === "string") {
      parts.push(`调用 ${item.name} ${JSON.stringify(item.arguments ?? {}).slice(0, 400)}`);
    }
  }
  return parts.length === 0 ? "" : `[助手]\n${parts.join("\n")}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } =>
      block !== null && typeof block === "object"
      && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** 交给 planner 的正文：调查记录，加上被拦下的那次编辑。 */
export function plannerMessage(transcript: string, target: string, tool: string, input: Record<string, unknown>): string {
  return `到目前为止的记录：\n\n${transcript}\n\n---\n它正要做的第一次源码编辑：${tool} ${target}\n${JSON.stringify(input).slice(0, 1_500)}\n`;
}

/** 拒绝理由：把计划交回主模型，并明说这是建议、拦截只发生一次。 */
export function pauseReason(plan: string): string {
  return `[counterweight] 这是本回合第一次改源码，已先请 planner 读完调查写了一份计划。`
    + `计划只是建议：你看得到代码，它看不到。不同意就说明哪里不同意，然后照你的判断重新发起这次编辑，这类拦截本回合不会再出现。\n\n${plan}`;
}
