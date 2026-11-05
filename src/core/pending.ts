/**
 * `.cw/pending.md`：project-learning 技能的待批清单。条目是以 `- YYYY-MM-DD |` 开头的行，后面缩进的是证据行，不算条数。
 * 两个仓库里这个文件逐字节相同，不引用任何宿主。
 *
 * The project-learning pending list. An entry is a line starting `- YYYY-MM-DD |`; indented detail lines do not count.
 * Byte-identical in both repositories.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const ENTRY = /^- \d{4}-\d{2}-\d{2} \|/;

/** 文件不存在或读不了时为 0。 */
export async function pendingCount(repo: string): Promise<number> {
  try {
    const text = await readFile(path.join(repo, ".cw", "pending.md"), "utf8");
    return text.split("\n").filter((line) => ENTRY.test(line)).length;
  } catch {
    return 0;
  }
}

/**
 * 把待批条数接到回合结束行（报告第一行）后面；没有报告就单独一行；条数为 0 时原样返回。
 */
export function withPending(report: string | null, count: number): string | null {
  if (count <= 0) return report;
  if (report === null) return `[counterweight] 待批 ${count} 条（.cw/pending.md）`;
  const at = report.indexOf("\n");
  return at === -1 ? `${report}；待批 ${count} 条` : `${report.slice(0, at)}；待批 ${count} 条${report.slice(at)}`;
}
