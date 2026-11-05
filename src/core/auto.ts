/**
 * 强制启用的收尾审查与史官汇报：把“等模型想起来调用”变成“每次正常结束都自动做”。
 * 本文件只含纯逻辑（取 diff、拼汇报、判断要跑哪些），不引用 pi。
 *
 * Forced review and chronicle at settle time. Pure logic, no pi imports.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
 * 当前工作树（含未跟踪文件，遵守 .gitignore）的树对象 id，作为回合的基线。
 * 在临时索引里 `git add -A` 再 `git write-tree`，真实索引不动；临时目录用完即删。
 * 不在 git 仓库里或任何一步失败时返回 null。
 */
export async function snapshotTree(repo: string): Promise<string | null> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "cw-index-"));
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    // 先载入 HEAD：已跟踪但被忽略的文件才不会丢。还没有提交时 read-tree 失败，从空索引开始。
    await git(repo, ["read-tree", "HEAD"], env);
    if ((await git(repo, ["add", "-A"], env)).code !== 0) return null;
    const tree = await git(repo, ["write-tree"], env);
    return tree.code === 0 ? tree.stdout.trim() : null;
  } catch {
    return null;
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** `git diff` 的起止参数：有基线时是基线与当前快照；没有基线时是 HEAD 与当前快照，快照也失败时是 HEAD 与工作树。 */
const diffRange = (base: string | null, end: string | null): string[] => [base ?? "HEAD", ...(end === null ? [] : [end])];

/** 失败（不在仓库里、没有提交）返回 null。 */
async function gitOut(repo: string, args: string[]): Promise<string | null> {
  try {
    const result = await git(repo, args);
    return result.code === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * 回合基线 `base` 到现在的改动，含未跟踪文件的内容，不含 `.cw`。`base` 为 null（没取到基线）时退回 HEAD。
 * 不在 git 仓库里、或没有任何提交又没有基线时返回 null。
 */
export async function workingDiff(repo: string, base: string | null): Promise<string | null> {
  const end = await snapshotTree(repo);
  const body = await gitOut(repo, ["diff", "--no-ext-diff", "--no-color", ...diffRange(base, end), "--", ".", ":!.cw"]);
  if (body === null) return null;
  if (body.trim() === "") return "";
  return body.length > DIFF_CAP ? `${body.slice(0, DIFF_CAP)}\n# …（diff 超过 ${DIFF_CAP} 字符，已截断）\n` : body;
}

/** 自动汇报给史官的正文：本轮用户请求、改动文件列表和结束检查结果。不含 diff 全文，史官自己有 read。 */
export function chronicleReport(request: string, files: string[], checkLine: string | null): string {
  const list = files.length === 0 ? "（无）" : files.slice(0, 40).join("\n");
  return `一轮工作结束。\n\n用户请求：\n${request.trim() === "" ? "（未取到）" : request.slice(0, 2_000)}\n\n改动的文件：\n${list}\n`
    + `${checkLine === null ? "" : `\n结束检查：${checkLine}\n`}\n时间：${new Date().toISOString()}。提交信息与日期请以仓库为准，不要编造。`;
}

/** 基线到现在改动的文件名，由 git 给出，所以重命名和非 ASCII 路径都对。取不到时为空数组。 */
export async function changedFiles(repo: string, base: string | null): Promise<string[]> {
  const end = await snapshotTree(repo);
  const out = await gitOut(repo, ["-c", "core.quotePath=false", "diff", "--name-only", "-z", ...diffRange(base, end), "--", ".", ":!.cw"]);
  return out === null ? [] : out.split("\0").filter((name) => name !== "");
}
