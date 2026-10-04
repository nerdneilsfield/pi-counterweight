import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveInRepo } from "./paths.js";

/**
 * The explorer's answer is bounded prose; the plan fixes the cap at 30 lines.
 */
export const EXPLORER_MAX_LINES = 30;

export interface FinalizedAnswer {
  /** The answer text as returned to the model, after bounding and annotation. */
  text: string;
  /** True when the answer exceeded the line cap and was cut. */
  truncated: boolean;
  /** `path:line` references judged invalid (also annotated inline). */
  invalidRefs: string[];
  /** Conclusion lines lacking a trailing `path:line` reference (also annotated inline). */
  missingRefs: string[];
}

/**
 * A conclusion reference at the end of a line: `repo-relative/path:line`.
 * The path group excludes `:` so URLs (`https://…`) never match, and it must
 * contain `.` or `/` so bare numeric ratios (`3:1`, `8080:80`) are not
 * mistaken for references; the line number is capped at 9 digits.
 */
const TRAILING_REF = /(^|\s)([^\s:]*[./][^\s:]*):(\d{1,9})\s*$/;

/**
 * Post-process one explorer answer (plan M8 item 3): cut anything past 30
 * lines and note the cut, then check every line's trailing `path:line`
 * reference — the path must exist inside the repository and the line number
 * must fall within the file. Invalid references are annotated with
 * 〔引用无效〕; conclusion lines without a reference are annotated with
 * 〔缺少引用〕 (the bare `未找到` answer is exempt). Annotations are never
 * removed.
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
