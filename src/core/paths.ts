import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const TASK_ID = /^(\d{8})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

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

/** Repo-relative segments. `.`, `..`, and empty segments are rejected, not normalized away. */
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
 * Walk `value` from `repo`. The returned path is the repo-relative location actually checked.
 * Lexical `.cw` rules apply before the walk, and again to each symlink target.
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

export function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
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

function forbid(parts: string[], allowCwScript: boolean, value: string): void {
  const cw = parts.indexOf(".cw");
  if (cw < 0) return;
  if (!allowCwScript) throw new Error(`path: .cw is not allowed ${value}`);
  if (parts.slice(cw + 1).includes("tasks")) throw new Error(`path: task state is not a baseline input ${value}`);
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
