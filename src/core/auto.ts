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
 * 一条非只读动作：会改工作树或会花时间的工具调用。只读的 read、grep、find、ls 不在这里。
 * `detail` 是 edit/write 的路径或 bash 的命令字符串。
 */
export interface ActionRecord {
  tool: string;
  detail: string;
}

/** 附进审查输入的动作条数上限。写入在 diff 里已经可见，先被挤掉；命令保留到最后。 */
const ACTION_CAP = 40;
/** 单条命令字符串的字符上限。超长时整条不进审查输入，避免截断后审的是另一条命令。 */
const ACTION_DETAIL_CAP = 2_000;

/**
 * 把本回合的非只读动作收成一段文本，附在 diff 后面交给审查者。
 * 空数组返回空串。diff 只反映改了什么文件，跑了什么命令它看不见，所以命令要单独附上。
 * 这些是工具调用，不是执行结果：调用被拦下或失败时，结果不在这里。
 */
export function renderActions(actions: readonly ActionRecord[]): string {
  if (actions.length === 0) return "";
  // 按发生顺序保留。写入已经体现在 diff 里，名额不够时先舍写入；命令超长时整条不列，
  // 不截成另一条看起来不同的命令。
  const shown: string[] = [];
  let omitted = 0;
  for (const action of actions) {
    const isWrite = action.tool !== "bash" && action.tool !== "powershell";
    if (isWrite && actions.length - omitted > ACTION_CAP) {
      omitted += 1;
      continue;
    }
    if (shown.length >= ACTION_CAP || action.detail.length > ACTION_DETAIL_CAP) {
      omitted += 1;
      continue;
    }
    shown.push(`${shown.length + 1}. ${action.tool} ${action.detail}`);
  }
  const rest = omitted > 0 ? `\n（另有 ${omitted} 条未列出）` : "";
  return `\n本回合的工具调用（不是执行结果，共 ${actions.length} 条）：\n${shown.join("\n")}${rest}\n`;
}

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
