/**
 * 批准后追加到会话的“任务视图”渲染：把契约压缩成不超过 40 行的清单，固定框架行永不丢弃，超长小节从尾部截断并留下省略标记。
 *
 * Post-approval task-view rendering: packs the contract into at most 40 lines
 * of plain text. Fixed framing lines are never dropped; oversized list sections
 * lose their tail with an explicit remainder marker.
 */
import type { Approval } from "./task.js";
import type { Contract } from "./types.js";

/**
 * 渲染上限：整条视图的硬行数（40）与目标行的字符预算（超长压平后以 `…` 收尾）。
 *
 * Rendering limits: the view's hard line cap and the character budget for the
 * single goal line, which is flattened and ellipsized when it overflows.
 */
const VIEW_MAX_LINES = 40;
const GOAL_MAX_CHARS = 300;

interface Section {
  header: string;
  items: string[];
}

/**
 * 批准后追加到会话的“任务视图”消息，40 行硬上限：目标、非目标、验收项 id（先红项带标注）、回归项 id、
 * 冻结路径，以及两个面向模型的工具的用途。超长小节从尾部逐项截断（先截最长的小节）并给出显式的剩余标记；
 * 固定框架行永不丢弃。传入 `notes`（M7 升级）时，前一模型的笔记在“未经验证”标记下紧随其后，同样按行数截断。
 *
 * The post-approval task view appended to the session as one message, hard
 * capped at 40 lines: goal, non-goals, acceptance ids (red items marked),
 * regression ids, frozen paths, and the two model-facing tools' purpose.
 * Oversized list sections are truncated from the tail with an explicit
 * remainder marker; the fixed framing lines are never dropped. When `notes`
 * is given (M7 escalation), the previous model's notes follow under an
 * explicit unverified marker, truncated the same way.
 */
export function renderTaskView(contract: Contract, approval: Approval, notes: string | null = null): string {
  const red = new Set(contract.red);
  const sections: Section[] = [
    { header: "非目标：", items: contract.non_goals.map((item) => `- ${item}`) },
    {
      header: "验收项：",
      items: contract.acceptance.map((id) => `- ${id}${red.has(id) ? "（先红：基线必须失败）" : ""}`),
    },
    { header: "回归项：", items: contract.regression.map((item) => `- ${item}`) },
    { header: "冻结文件：", items: contract.frozen.map((item) => `- ${item}`) },
  ];
  const fixed = [
    `[counterweight] 任务 ${contract.task_id} 已批准`,
    `目标：${oneline(contract.goal, GOAL_MAX_CHARS)}`,
    "受保护：冻结与接口文件、.cw/ 账本不可直接写入；契约变更用 propose_contract_change。",
    "受阻时用 report_blocked（原因与问题清单）上报，本轮结束将交还。",
    `验证：${approval.validator.cmd.join(" ")}`,
  ];
  const items = sections.map((section) => [...section.items]);
  const dropped = sections.map(() => 0);
  const lineCount = () => fixed.length + sections.reduce((total, section, index) =>
    total + (section.items.length > 0 ? 1 : 0) + items[index]!.length + (dropped[index]! > 0 ? 1 : 0), 0);
  while (lineCount() > VIEW_MAX_LINES) {
    const index = items.reduce((best, list, current) =>
      list.length > items[best]!.length ? current : best, 0);
    if (items[index]!.length === 0) break;
    items[index]!.pop();
    dropped[index] = dropped[index]! + 1;
  }
  const lines = [...fixed];
  for (let index = 0; index < sections.length; index++) {
    if (sections[index]!.items.length === 0) continue;
    lines.push(sections[index]!.header);
    lines.push(...items[index]!);
    if (dropped[index]! > 0) lines.push(`（其余 ${dropped[index]} 项略）`);
  }
  const trimmedNotes = notes?.trim();
  if (trimmedNotes !== undefined && trimmedNotes !== "") {
    const noteLines = ["前一模型的笔记，未经验证：", ...trimmedNotes.split("\n")];
    const room = VIEW_MAX_LINES - lines.length;
    if (room > 1) {
      const kept = noteLines.slice(0, room - 1);
      if (kept.length < noteLines.length) kept.push("（笔记其余部分略，见 handback.md）");
      lines.push(...kept);
    }
  }
  return lines.slice(0, VIEW_MAX_LINES).join("\n");
}

/**
 * 压平空白并把文字截到 `max` 个字符，超出时以 `…` 收尾。
 *
 * Flattens whitespace and truncates to `max` characters, appending `…` when cut.
 */
function oneline(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
