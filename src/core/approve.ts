import type { Approval } from "./task.js";
import type { Contract } from "./types.js";

const VIEW_MAX_LINES = 40;
const GOAL_MAX_CHARS = 300;

interface Section {
  header: string;
  items: string[];
}

/**
 * The post-approval task view appended to the session as one message, hard
 * capped at 40 lines: goal, non-goals, acceptance ids (red items marked),
 * regression ids, frozen paths, and the two model-facing tools' purpose.
 * Oversized list sections are truncated from the tail with an explicit
 * remainder marker; the fixed framing lines are never dropped.
 */
export function renderTaskView(contract: Contract, approval: Approval): string {
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
  return lines.slice(0, VIEW_MAX_LINES).join("\n");
}

function oneline(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
