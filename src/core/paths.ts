/**
 * 路径护栏：把外部输入解析成仓库内相对路径，并拒绝 `..`、绝对路径、符号链接逃逸，以及把 `.cw/tasks`（任务账本）当普通文件处理。
 *
 * Path guardrails: external input is resolved to a repo-relative path that stays
 * inside the repository. `..` and absolute paths are rejected lexically, never
 * normalized away; every symlink target is re-checked against the repo root; and
 * the `.cw/tasks` ledger is off-limits as a baseline input. Every failure throws
 * — nothing here fails open.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const TASK_ID = /^(\d{8})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * 校验任务 id 既是 `YYYYMMDD-slug` 形状，又落在真实存在的日期上；`20260231-x` 这类形状合法但日期非法的 id 同样被拒绝。
 *
 * Asserts that a task id matches `YYYYMMDD-slug` and carries a real calendar
 * date: a regex-shaped id like `20260231-x` still throws. Callers rely on it to
 * keep every task directory inside the repository's own `.cw/tasks`.
 *
 * @param taskId - 待校验的任务 id / Task id to check.
 * @throws 形状或日期不合法时 / When the shape or the date is invalid.
 */
export function assertTaskId(taskId: string): void {
  const match = TASK_ID.exec(taskId);
  if (!match) throw new Error(`task_id: invalid ${taskId}`);
  const year = Number(match[1]!.slice(0, 4));
  const month = Number(match[1]!.slice(4, 6));
  const day = Number(match[1]!.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`task_id: invalid date ${taskId}`);
  }
}

/**
 * 仓库内相对路径的分段；`.`、`..` 与空段一律拒绝，而不是规范化掉。
 *
 * Repo-relative segments. `.`, `..`, and empty segments are rejected, not normalized away.
 */
export function relativeParts(value: string): string[] {
  if (value === "" || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`path: must be repo-relative ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`path: refuses . or .. segment ${value}`);
  }
  return parts;
}

/**
 * 从 `repo` 起点逐段走 `value`，返回实际检查到的仓库内相对位置。
 *
 * 词法 `.cw` 规则先于遍历生效，并且对每个符号链接目标重放一次；中途遇到不存在的段时，剩余段按字面量拼接，此时只有 `.cw` 规则可查。
 *
 * Walk `value` from `repo`. The returned path is the repo-relative location actually checked.
 * Lexical `.cw` rules apply before the walk, and again to each symlink target.
 *
 * @param repo - 仓库根，内部 realpath 一次 / Repository root; realpathed once inside.
 * @param value - 待解析的仓库内相对路径 / Repo-relative path to resolve.
 * @param allowCwScript - 是否允许 `.cw`（`.cw/tasks` 除外）/ Whether `.cw` is allowed at all.
 * @returns 仓库内相对结果，尾段可能尚不存在 / Repo-relative result, tail segments may not exist yet.
 * @throws 路径非法、符号链接逃逸或链接目标缺失时 / On an invalid path, a symlink escape, or a missing symlink target.
 */
export async function repoPath(repo: string, value: string, allowCwScript: boolean): Promise<string> {
  const parts = relativeParts(value);
  forbid(parts, allowCwScript, value);
  const root = await realpath(repo);
  let cursor = root;
  let resolved: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const next = path.join(cursor, part);
    let stat;
    try {
      stat = await lstat(next);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      for (const rest of parts.slice(index)) {
        resolved.push(rest);
        forbid(resolved, allowCwScript, value);
      }
      return resolved.join("/");
    }
    if (stat.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(next);
      } catch (error) {
        if (isNotFound(error)) throw new Error(`path: symlink target missing ${value}`);
        throw error;
      }
      if (!pathInside(root, target)) throw new Error(`path: symlink escapes repository ${value}`);
      const relative = path.relative(root, target);
      resolved = relative === "" ? [] : relative.split(path.sep);
      forbid(resolved, allowCwScript, value);
      cursor = target;
    } else {
      resolved = [...resolved, part];
      forbid(resolved, allowCwScript, value);
      cursor = next;
    }
  }
  if (resolved.length === 0) throw new Error(`path: empty ${value}`);
  forbid(resolved, allowCwScript, value);
  return resolved.join("/");
}

/**
 * 判断 `candidate` 是否等于 `root` 或落在 `root` 之下；纯字符串运算，不访问文件系统。
 *
 * Whether `candidate` is `root` itself or lives below it. Purely lexical — both
 * arguments are expected to be absolute, already-realpathed paths, so callers
 * must resolve symlinks before asking.
 */
export function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 在已 realpath 过的仓库 `root` 下彻底解析 `value`（展开每一层符号链接），只用一次 realpath。
 *
 * 词法与解析后都拒绝 `.cw` 段；调用方传入仓库的 realpath，批量检查就不必为每条路径重走一遍。ENOENT 直接向上抛：目标缺失或符号链接悬空。
 *
 * Fully resolve `value` (every symlink) under a pre-resolved repo `root` with
 * one realpath, rejecting `.cw` segments both lexically and after resolution.
 * Callers pass the realpath of the repo so batch checks do not repeat that
 * walk per path. ENOENT propagates: the path is missing or a dangling symlink.
 */
export async function resolveInRepo(root: string, value: string): Promise<string> {
  forbid(relativeParts(value), false, value);
  const resolved = await resolveSymlinkInRepo(root, value);
  forbid(relativeParts(resolved), false, value);
  return resolved;
}

/**
 * 解析仓库内已存在目标的真实路径，但不做 `.cw` 词法禁止（`resolveInRepo` 会做），好让受保护的任务路径也能穿过符号链接解析。
 *
 * 目标缺失或符号链接悬空时 ENOENT 向上抛；逃出仓库则抛错。
 *
 * Real-path resolution of an existing repo-relative target without the `.cw`
 * lexical forbid (`resolveInRepo`), so protected-task paths can be resolved
 * through symlinks too. ENOENT propagates for missing targets and dangling
 * symlinks; escapes throw.
 */
export async function resolveSymlinkInRepo(root: string, value: string): Promise<string> {
  const target = await realpath(path.join(root, value));
  if (!pathInside(root, target)) throw new Error(`path: symlink escapes repository ${value}`);
  return path.relative(root, target).split(path.sep).join("/");
}

/**
 * `.cw` 护栏：不允许 `.cw` 时直接拒绝；允许时（基线脚本可以放在 `.cw` 下）仍然拒绝 `.cw/tasks`，任务账本不能当基线输入。
 *
 * The `.cw` guard: `.cw` is rejected outright unless the caller opted in, and
 * even then `.cw/tasks` stays forbidden — the task ledger must never be a
 * baseline input.
 */
function forbid(parts: string[], allowCwScript: boolean, value: string): void {
  const cw = parts.indexOf(".cw");
  if (cw < 0) return;
  if (!allowCwScript) throw new Error(`path: .cw is not allowed ${value}`);
  if (parts.slice(cw + 1).includes("tasks")) throw new Error(`path: task state is not a baseline input ${value}`);
}

/**
 * 判断抛出的值是否为 ENOENT 错误，让调用方把"文件不存在"与真正的 IO 失败区分开。
 *
 * Whether an unknown thrown value is an ENOENT error, so callers can tell a
 * missing file apart from a genuine I/O failure. ENOTDIR is not covered here;
 * callers that must treat it as missing check separately.
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
