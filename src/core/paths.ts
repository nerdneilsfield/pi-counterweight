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

/** Repo-relative path that cannot escape or name `.cw`. Missing files stay lexical. */
export async function repoPath(repo: string, value: string, allowCwScript: boolean): Promise<string> {
  if (value === "" || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`path: must be repo-relative ${value}`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw new Error(`path: escapes repository ${value}`);
  }
  const parts = normalized.split(path.sep).filter((part) => part !== ".");
  if (parts.some((part) => part === "..")) throw new Error(`path: escapes repository ${value}`);
  const cw = parts.includes(".cw");
  if (cw && !allowCwScript) throw new Error(`path: .cw is not allowed ${value}`);
  if (cw && (parts.length < 2 || parts[0] !== ".cw")) throw new Error(`path: .cw location invalid ${value}`);

  const root = await realpath(repo);
  let cursor = root;
  const resolved: string[] = [];
  for (const part of parts) {
    const next = path.join(cursor, part);
    let stat;
    try {
      stat = await lstat(next);
    } catch (error) {
      if (isNotFound(error)) return normalized;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(next);
      } catch (error) {
        if (isNotFound(error)) throw new Error(`path: symlink target missing ${value}`);
        throw error;
      }
      if (!isInside(root, target)) throw new Error(`path: symlink escapes repository ${value}`);
      cursor = target;
      resolved.push(...path.relative(root, target).split(path.sep).filter(Boolean));
    } else {
      cursor = next;
      resolved.push(part);
    }
    if (resolved[0] === ".cw" && resolved[1] === "tasks") throw new Error(`path: task state is not a baseline input ${value}`);
  }
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
