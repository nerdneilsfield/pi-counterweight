/**
 * 探索者答案的后处理：把答案截到 30 行以内，逐行校验行尾的 `path:line` 引用，并就地标注无效或缺失的引用。
 *
 * Post-processing for explorer answers: bound the text at 30 lines, then check
 * each line's trailing `path:line` reference against the repository and
 * annotate problems in place. Annotations are additive — a later pass never
 * removes them.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveInRepo } from "./paths.js";

/**
 * 探索者答案的行数上限；计划把上限定死在 30 行。
 *
 * The explorer's answer is bounded prose; the plan fixes the cap at 30 lines.
 */
export const EXPLORER_MAX_LINES = 30;

/**
 * 一次后处理的结果：返回给模型的最终文本，以及截断与引用两类事实。
 *
 * The outcome of one post-processing pass: the final text handed to the model,
 * plus the truncation flag and the reference problems found.
 */
export interface FinalizedAnswer {
  /**
   * 返回给模型的答案文本，已完成截断与标注。
   *
   * The answer text as returned to the model, after bounding and annotation.
   */
  text: string;
  /**
   * 答案是否超过行数上限、把尾部切掉。
   *
   * True when the answer exceeded the line cap and was cut.
   */
  truncated: boolean;
  /**
   * 校验为无效的 `path:line` 引用（正文里同样已就地标注）。
   *
   * `path:line` references judged invalid (also annotated inline).
   */
  invalidRefs: string[];
  /**
   * 行尾缺少 `path:line` 引用的结论行（正文里同样已就地标注）。
   *
   * Conclusion lines lacking a trailing `path:line` reference (also annotated inline).
   */
  missingRefs: string[];
}

/**
 * 行尾的结论引用 `仓库内相对路径:行号`。路径分组不含 `:`，所以 URL（`https://…`）永远不会误匹配；
 * 路径还必须含 `.` 或 `/`，因此裸数字比（`3:1`、`8080:80`）不会被当成引用；行号最多 9 位。
 *
 * A conclusion reference at the end of a line: `repo-relative/path:line`.
 * The path group excludes `:` so URLs (`https://…`) never match, and it must
 * contain `.` or `/` so bare numeric ratios (`3:1`, `8080:80`) are not
 * mistaken for references; the line number is capped at 9 digits.
 */
const TRAILING_REF = /(^|\s)([^\s:]*[./][^\s:]*):(\d{1,9})\s*$/;

/**
 * 对一条探索者答案做后处理（计划 M8 第 3 项）：先截到 30 行并注明截断，再逐行检查行尾的 `path:line` 引用——
 * 路径必须存在于仓库内且不逃逸，行号必须落在文件行数范围内。无效引用就地标注〔引用无效〕；
 * 没有引用的结论行标注〔缺少引用〕（裸 `未找到` 答案豁免）。标注只增不减。
 *
 * Post-process one explorer answer (plan M8 item 3): cut anything past 30
 * lines and note the cut, then check every line's trailing `path:line`
 * reference — the path must exist inside the repository and the line number
 * must fall within the file. Invalid references are annotated with
 * 〔引用无效〕; conclusion lines without a reference are annotated with
 * 〔缺少引用〕 (the bare `未找到` answer is exempt). Annotations are never
 * removed.
 *
 * @param answer - 探索者返回的原始答案文本 / Raw answer text returned by the explorer.
 * @param repo - 仓库根路径 / Repository root.
 * @returns 截断、标注后的文本与两类引用问题的清单 / The bounded text plus the reference-problem lists.
 */
export async function finalizeExplorerAnswer(answer: string, repo: string): Promise<FinalizedAnswer> {
  const lines = answer.split("\n");
  let truncated = false;
  if (lines.length > EXPLORER_MAX_LINES) {
    truncated = true;
    lines.length = EXPLORER_MAX_LINES;
  }
  const invalidRefs: string[] = [];
  const missingRefs: string[] = [];
  const checked: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" || line.trim() === "未找到") {
      checked.push(line);
      continue;
    }
    const match = TRAILING_REF.exec(line);
    if (match === null) {
      missingRefs.push(line);
      checked.push(`${line.trimEnd()} 〔缺少引用〕`);
      continue;
    }
    const relative = match[2]!;
    const lineNo = Number(match[3]);
    if (await referenceValid(repo, relative, lineNo)) {
      checked.push(line);
      continue;
    }
    invalidRefs.push(`${relative}:${lineNo}`);
    checked.push(`${line.trimEnd()} 〔引用无效〕`);
  }
  const text = checked.join("\n")
    + (truncated ? `\n〔counterweight 输出超过 ${EXPLORER_MAX_LINES} 行，已截断〕` : "");
  return { text, truncated, invalidRefs, missingRefs };
}

/**
 * 判断一条 `path:line` 引用是否有效：路径经仓库护栏解析且不逃逸、文件可读、行号落在行数之内。
 *
 * Whether one `path:line` reference is valid: the path resolves inside the
 * repository through the guardrails, the file is readable, and the line number
 * falls within the line count. Every failure — bad path, missing file,
 * unreadable content — returns `false`; nothing throws.
 */
async function referenceValid(repo: string, relative: string, lineNo: number): Promise<boolean> {
  if (lineNo < 1 || !Number.isInteger(lineNo)) return false;
  let resolved: string;
  try {
    // Lexical guard (`..`, absolute, `.cw`) plus symlink containment, and
    // ENOENT for anything missing — all failures mean "invalid reference".
    resolved = await resolveInRepo(repo, relative);
  } catch {
    return false;
  }
  let content: string;
  try {
    content = await readFile(path.join(repo, resolved), "utf8");
  } catch {
    return false;
  }
  // An empty file has zero lines: `empty.txt:1` is invalid.
  const total = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return lineNo <= total;
}
