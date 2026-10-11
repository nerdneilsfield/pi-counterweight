/**
 * 受保护路径：项目配置里写死的路径列表，外加 harness 自己的控制面文件 `.cw/project.toml`。
 * `edit` / `write` 对受保护目标直接拦截；结算时对比会话开始时的内容快照，发现变化只如实报告，
 * 不拦截、不还原。
 *
 * Protected paths: the literal list from the project config plus the harness's
 * own control file `.cw/project.toml`. Direct `edit`/`write` calls against a
 * protected target are blocked; at settle time the content snapshot taken at
 * session start is compared and any change is reported as a fact — never
 * blocked, never reverted.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
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

/**
 * 对受保护集合做一次内容快照：每个现存普通文件的 sha256（读取失败记 null），符号链接一律跳过。
 *
 * One content snapshot of the protected set: a sha256 per existing regular
 * file (null when unreadable), with every symlink skipped so a link cannot
 * smuggle content from outside the repository into the snapshot.
 *
 * @param root - 仓库根 / Repository root.
 * @param patterns - 规范化的受保护路径列表 / Normalized protected-path patterns.
 * @returns 仓库内相对路径到内容哈希（或 null）的映射 / Map of repo-relative path to content hash (or null).
 */
export async function snapshotProtected(
  root: string, patterns: readonly string[],
): Promise<Map<string, string | null>> {
  const snapshot = new Map<string, string | null>();
  for (const relative of await listProtected(root, patterns)) {
    snapshot.set(relative, await hashProtected(root, relative));
  }
  return snapshot;
}

/**
 * 与快照对比，列出新增、删除或内容变化的受保护文件（按路径排序）。
 *
 * Compares against a snapshot and lists created, deleted, or modified
 * protected files, sorted by path.
 */
export async function changedProtected(
  root: string, patterns: readonly string[], snapshot: Map<string, string | null>,
): Promise<string[]> {
  const current = await snapshotProtected(root, patterns);
  const changed = new Set<string>();
  for (const [file, hash] of snapshot) {
    if (!current.has(file) || current.get(file) !== hash) changed.add(file);
  }
  for (const file of current.keys()) {
    if (!snapshot.has(file)) changed.add(file);
  }
  return [...changed].sort();
}

/**
 * 列出受保护集合里现存的普通文件：直接路径命中文件就取它，命中目录就递归遍历（跳过符号链接与 `.cw`）。
 *
 * Lists the existing regular files of the protected set: a direct path that is
 * a file is taken as-is, a directory is walked recursively while symlinks and
 * `.cw` are skipped.
 */
async function listProtected(root: string, patterns: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const entry of [...patterns, CONFIG_FILE]) {
    let stat;
    try {
      stat = await lstat(path.join(root, entry));
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      files.push(entry);
      continue;
    }
    if (stat.isDirectory()) await walk(root, entry, files);
  }
  return files;
}

/**
 * 递归收集目录下的普通文件；符号链接（目录或文件）与 `.cw` 都不进入快照，读取失败的目录整体跳过。
 *
 * Collects the regular files of one directory recursively. Symlinks (to files
 * or directories) and `.cw` never enter the snapshot, and a directory that
 * cannot be listed is skipped whole.
 */
async function walk(root: string, relative: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".cw") continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(root, child, files);
    else if (entry.isFile()) files.push(child);
  }
}

/**
 * 单个受保护文件的内容哈希；读不到时返回 null（快照里照样有这条路径，所以“读取失败”与“不存在”仍可区分）。
 *
 * Content hash of one protected file; null when it cannot be read. The path
 * still appears in the snapshot, so "unreadable" stays distinguishable from
 * "missing".
 */
async function hashProtected(root: string, relative: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex");
  } catch {
    return null;
  }
}
