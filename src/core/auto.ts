/**
 * 强制启用的收尾审查与史官汇报：把“等模型想起来调用”变成“每次正常结束都自动做”。
 * 本文件只含纯逻辑（取 diff、拼汇报、判断要跑哪些），不引用 pi。
 *
 * Forced review and chronicle at settle time. Pure logic, no pi imports.
 */
import { git } from "./gitstate.js";

/** diff 的字符上限。超出就截断并注明，免得把审查者的上下文塞满。 */
export const DIFF_CAP = 80_000;

/**
 * 工作树相对 HEAD 的改动，含未跟踪文件。不在 git 仓库里、或没有任何提交时返回 null。
 * 用 `git add -N` 不合适（会改索引），所以未跟踪文件单独列名字，不展开内容。
 */
export async function workingDiff(repo: string): Promise<string | null> {
  // 不在仓库里、或还没有提交时 git 退出码非 0：当作没有可审的 diff。
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const result = await git(repo, args);
      return result.code === 0 ? result.stdout : null;
    } catch {
      return null;
    }
  };
  const tracked = await run(["diff", "HEAD", "--no-ext-diff", "--no-color"]);
  if (tracked === null) return null;
  const untracked = await run(["ls-files", "--others", "--exclude-standard", "--", ":!.cw"]);
  const names = untracked === null ? [] : untracked.split("\n").filter((line) => line !== "");
  const tail = names.length === 0 ? "" : `\n# 未跟踪的新文件（只列名字）：\n${names.map((name) => `# ${name}`).join("\n")}\n`;
  const body = `${tracked}${tail}`;
  if (body.trim() === "") return "";
  return body.length > DIFF_CAP ? `${body.slice(0, DIFF_CAP)}\n# …（diff 超过 ${DIFF_CAP} 字符，已截断）\n` : body;
}

/** 自动汇报给史官的正文：本轮用户请求、改动文件列表和结束检查结果。不含 diff 全文，史官自己有 read。 */
export function chronicleReport(request: string, files: string[], checkLine: string | null): string {
  const list = files.length === 0 ? "（无）" : files.slice(0, 40).join("\n");
  return `一轮工作结束。\n\n用户请求：\n${request.trim() === "" ? "（未取到）" : request.slice(0, 2_000)}\n\n改动的文件：\n${list}\n`
    + `${checkLine === null ? "" : `\n结束检查：${checkLine}\n`}\n时间：${new Date().toISOString()}。提交信息与日期请以仓库为准，不要编造。`;
}

/** 从 diff 里取出改动文件名。 */
export function changedFiles(diff: string): string[] {
  const seen = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/\1$/gm)) seen.add(match[1]!);
  for (const match of diff.matchAll(/^# (?!未跟踪|…)(.+)$/gm)) seen.add(match[1]!);
  return [...seen];
}
