/**
 * 受保护路径：项目配置里写死的路径列表，外加 harness 自己的控制面文件 `.cw/project.toml`。
 * `edit` / `write` 对受保护目标直接拦截。没有内容快照、没有结算时的变化报告。
 *
 * Protected paths: the literal list from the project config plus the harness's
 * own control file `.cw/project.toml`. Direct `edit`/`write` calls against a
 * protected target are blocked. There is no content snapshot and no settle-time
 * change report.
 */
import path from "node:path";

/**
 * harness 自己的控制面文件，无论项目配置如何都受保护；模型不能通过改它来关掉检查或保护。
 *
 * The harness's own control file, protected no matter what the project config
 * says: the model must not be able to turn the check or the guard off by
 * editing it.
 */
export const CONFIG_FILE = ".cw/project.toml";

/**
 * 判断一个仓库内相对路径是否属于受保护集合：等于某条路径，或位于某条目录前缀之下。
 *
 * Whether a repo-relative path is protected: it equals a pattern or lives
 * under a pattern used as a directory prefix. Pure and lexical — callers
 * resolve symlinks separately before asking.
 *
 * @param relative - 仓库内相对路径 / Repo-relative path.
 * @param patterns - 规范化的受保护路径列表 / Normalized protected-path patterns.
 */
export function isProtected(relative: string, patterns: readonly string[]): boolean {
  const normalized = relative.split(path.sep).join("/");
  if (normalized === CONFIG_FILE) return true;
  return patterns.some((pattern) => normalized === pattern || normalized.startsWith(`${pattern}/`));
}
