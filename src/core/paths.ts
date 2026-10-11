/**
 * 路径护栏：把外部输入解析成仓库内相对路径，并拒绝 `..`、绝对路径与符号链接逃逸。
 *
 * Path guardrails: external input is resolved to a repo-relative path that
 * stays inside the repository. `..` and absolute paths are rejected lexically,
 * never normalized away, and every symlink target is re-checked against the
 * repo root. Every failure throws — nothing here fails open.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

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
 * 词法与解析后都拒绝 `.cw` 段；调用方传入仓库的 realpath。ENOENT 直接向上抛：目标缺失或符号链接悬空。
 *
 * Fully resolve `value` (every symlink) under a pre-resolved repo `root` with
 * one realpath, rejecting `.cw` segments both lexically and after resolution.
 * Callers pass the realpath of the repo so batch checks do not repeat that
 * walk per path. ENOENT propagates: the path is missing or a dangling symlink.
 */
export async function resolveInRepo(root: string, value: string): Promise<string> {
  forbid(relativeParts(value), value);
  const resolved = await resolveSymlinkInRepo(root, value);
  forbid(relativeParts(resolved), value);
  return resolved;
}

/**
 * 解析仓库内已存在目标的真实路径，但不做 `.cw` 词法禁止（`resolveInRepo` 会做），好让受保护路径（含 `.cw/project.toml`）也能穿过符号链接解析。
 *
 * 目标缺失或符号链接悬空时 ENOENT 向上抛；逃出仓库则抛错。
 *
 * Real-path resolution of an existing repo-relative target without the `.cw`
 * lexical forbid (`resolveInRepo`), so protected paths — `.cw/project.toml`
 * included — can be resolved through symlinks too. ENOENT propagates for
 * missing targets and dangling symlinks; escapes throw.
 */
export async function resolveSymlinkInRepo(root: string, value: string): Promise<string> {
  const target = await realpath(path.join(root, value));
  if (!pathInside(root, target)) throw new Error(`path: symlink escapes repository ${value}`);
  return path.relative(root, target).split(path.sep).join("/");
}

/**
 * `.cw` 护栏：发现 `.cw` 段直接拒绝，调用方（探索者引用校验）不得把账本当普通代码引用。
 *
 * The `.cw` guard: a `.cw` segment is rejected outright, so callers (explorer
 * reference validation) never treat the harness-owned directory as code.
 */
function forbid(parts: string[], value: string): void {
  if (parts.includes(".cw")) throw new Error(`path: .cw is not allowed ${value}`);
}

/**
 * 解析成真实路径；目标不可解析时退回原值。调用方（适配层与工具）需要同一份把仓库根交给后续
 * 符号链接核对的口径。
 *
 * Realpath with a fallback to the raw value when it cannot be resolved. Callers
 * (the adapter and the tools) need one consistent repo-root value for the
 * later symlink containment checks.
 */
export async function realpathOr(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return value;
  }
}

/**
 * 判断抛出的值是否为 ENOENT 错误，让调用方把“文件不存在”与真正的 IO 失败区分开。
 *
 * Whether an unknown thrown value is an ENOENT error, so callers can tell a
 * missing file apart from a genuine I/O failure. ENOTDIR is not covered here;
 * callers that must treat it as missing check separately.
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
