/**
 * 路径护栏：把外部输入解析成仓库内相对路径，并拒绝 `..`、绝对路径与符号链接逃逸。
 *
 * Path guardrails: external input is resolved to a repo-relative path that
 * stays inside the repository. `..` and absolute paths are rejected lexically,
 * never normalized away, and every symlink target is re-checked against the
 * repo root. Every failure throws — nothing here fails open.
 */
import { access, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * 解析写入目标在仓库内的真实相对路径。目标本身存在时走 `realpath`；目标缺失时从最近的现存祖先解析，
 * 这样 `alias -> tests` 下尚不存在的 `alias/new.ts` 仍落到 `tests/new.ts`，指向仓库外的目录链接同样拦得住。
 * 祖先不可解析、解析结果逃出仓库，或路径上没有任何现存节点时抛错。
 *
 * Real repo-relative path of a write target. An existing target uses `realpath`.
 * A missing target walks up to the nearest existing ancestor, so `alias/new.ts`
 * under `alias -> tests` still lands on `tests/new.ts`, and a directory link
 * pointing outside the repo is caught the same way. Throws when an ancestor
 * cannot be resolved, the result escapes the repo, or nothing on the path exists.
 */
export async function resolveWriteTarget(root: string, relative: string): Promise<string> {
  const parts = relativeParts(relative);
  const absolute = path.join(root, ...parts);
  let leaf;
  try {
    leaf = await lstat(absolute);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    leaf = null;
  }
  if (leaf !== null) {
    if (leaf.isSymbolicLink()) {
      try {
        return await containedRelative(root, absolute, relative);
      } catch (error) {
        if (isNotFound(error)) throw new Error(`path: dangling symlink ${relative}`);
        throw error;
      }
    }
    return await containedRelative(root, absolute, relative);
  }
  for (let length = parts.length - 1; length >= 1; length -= 1) {
    const ancestor = path.join(root, ...parts.slice(0, length));
    let stat;
    try {
      stat = await lstat(ancestor);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      const realAncestor = await containedRelative(root, ancestor, relative);
      const rest = parts.slice(length);
      return realAncestor === "" ? rest.join("/") : [realAncestor, ...rest].join("/");
    }
    throw new Error(`path: write target is not a directory ${relative}`);
  }
  return relative;
}

/**
 * `candidate` 的 realpath 必须落在 `root` 内，返回仓库内相对路径。
 *
 * The realpath of `candidate` must stay inside `root`; returns the repo-relative form.
 */
async function containedRelative(root: string, candidate: string, label: string): Promise<string> {
  const target = await realpath(candidate);
  if (!pathInside(root, target)) throw new Error(`path: symlink escapes repository ${label}`);
  const relative = path.relative(root, target);
  return relative === "" ? "" : relative.split(path.sep).join("/");
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
 * pi 1.0.0 写入工具（`resolveToCwd`）对路径参数做的规范化：去掉前导 `@`、把 Unicode 空格换成普通空格、
 * 展开 `~`、把 `file://` 转成本地路径，再对 `cwd` 解析。读工具在此基础上还会试截图文件名变体，见
 * `resolvePiReadPath`。这里复刻安装包里的行为，不引用 pi 包，好让 core 保持可独立运行。
 *
 * Normalization pi 1.0.0's write tools (`resolveToCwd`) apply to a path argument:
 * strip a leading `@`, fold Unicode spaces to ASCII spaces, expand `~`, turn
 * `file://` into a local path, then resolve against `cwd`. The read tool tries
 * screenshot filename variants on top of that (`resolvePiReadPath`). Replicated
 * from the installed package so core stays free of a pi import.
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function resolvePiToolPath(value: string, cwd: string): string {
  return resolveNormalized(normalizePiPath(value), cwd);
}

/**
 * pi 1.0.0 读工具（`resolveReadPathAsync`）实际打开的路径：先按写入口径解析，目标不存在时再依次试
 * macOS 截图的窄不换行空格、NFD 与弯引号变体，命中现存文件才采用。
 *
 * The path pi 1.0.0's read tool (`resolveReadPathAsync`) actually opens: the
 * write resolution first, then the macOS screenshot, NFD, and curly-quote
 * variants, adopting one only when that file exists.
 */
export async function resolvePiReadPath(value: string, cwd: string): Promise<string> {
  const resolved = resolvePiToolPath(value, cwd);
  if (await exists(resolved)) return resolved;
  const nfd = resolved.normalize("NFD");
  const candidates = [
    resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
    nfd,
    resolved.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ];
  for (const candidate of candidates) {
    if (candidate !== resolved && await exists(candidate)) return candidate;
  }
  return resolved;
}

/**
 * `normalizePath`（pi `utils/paths.js`）里与本平台相关的部分。Windows 盘符转换只在 win32 上执行，这里不复刻。
 *
 * The parts of pi's `normalizePath` (`utils/paths.js`) that apply here. The
 * Windows drive-letter rewrite runs on win32 only and is not replicated.
 */
function normalizePiPath(input: string): string {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  const home = homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return path.join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

function resolveNormalized(normalized: string, cwd: string): string {
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
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
