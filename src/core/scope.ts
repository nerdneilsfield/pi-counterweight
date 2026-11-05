/**
 * `.cw/scope.txt`：每行一个仓库相对路径前缀，`#` 开头和空行忽略。文件存在且有内容时，写工具只能写前缀之内的路径，
 * `.cw/` 下的路径不受限制。前缀按路径段匹配：`src` 管 `src` 和 `src/a.ts`，不管 `srcx`。
 * 这个文件本身由各宿主的保护逻辑始终保护。两个仓库里这个文件逐字节相同，不引用任何宿主。
 *
 * `.cw/scope.txt`: one repo-relative prefix per line; `#` lines and blanks are ignored. When the file has
 * content, write tools may only touch paths under a prefix; anything under `.cw/` is exempt.
 * Byte-identical in both repositories.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const SCOPE_FILE = ".cw/scope.txt";

/** 没有文件、读失败或没有有效行时为 null，即不限制。 */
export async function readScope(repo: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(path.join(repo, SCOPE_FILE), "utf8");
  } catch {
    return null;
  }
  const prefixes = text.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/^(\.\/)+/, "").replace(/\/+$/, ""))
    .filter((line) => line !== "");
  return prefixes.length === 0 ? null : prefixes;
}

/** 仓库相对路径在范围内（或在 `.cw/` 下）为 true。 */
export function inScope(relative: string, prefixes: readonly string[]): boolean {
  const normalized = relative.split(path.sep).join("/");
  if (normalized === ".cw" || normalized.startsWith(".cw/")) return true;
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export const scopeReason = (target: string): string =>
  `[counterweight] ${target} 在 ${SCOPE_FILE} 划定的范围之外，写入被拒绝；如需修改范围请由用户手动完成。`;
