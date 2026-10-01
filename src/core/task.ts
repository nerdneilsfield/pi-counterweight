import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertTaskId, isNotFound, pathInside } from "./paths.js";
import { rejectUnknown } from "./schema.js";
import { Type } from "typebox";
import type { LockHolder, TaskReference, TaskState } from "./types.js";

const stateSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("drafting"), Type.Literal("approved"), Type.Literal("running"),
    Type.Literal("verified"), Type.Literal("handed_back"), Type.Literal("cancelled"),
  ]),
  model: Type.String({ minLength: 1 }),
  repairs_used: Type.Integer({ minimum: 0 }),
  tokens_used: Type.Integer({ minimum: 0 }),
  wall_started_at: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  last_verified: Type.Union([Type.Object({
    run: Type.Integer({ minimum: 1 }),
    tree: Type.String({ minLength: 1 }),
    contract_sha256: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }), Type.Null()]),
  evidence_invalid_reason: Type.Union([Type.String(), Type.Null()]),
  conflicts: Type.Array(Type.Unknown()),
  sessions: Type.Array(Type.String({ minLength: 1 })),
  version: Type.Literal(1),
}, { additionalProperties: false });

const lockSchema = Type.Object({
  pid: Type.Integer({ minimum: 1 }),
  session: Type.String({ minLength: 1 }),
  acquired_at: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const lockFlags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW;

export class TaskLockError extends Error {
  readonly holder: LockHolder;
  constructor(holder: LockHolder) {
    super(`task lock held by pid ${holder.pid} session ${holder.session}`);
    this.name = "TaskLockError";
    this.holder = holder;
  }
}

export async function createTask(repo: string, taskId: string, model: string): Promise<string> {
  assertTaskId(taskId);
  const parent = await ensureParents(repo);
  const dir = path.join(parent, taskId);
  await rejectUnexpected(dir, "task directory");
  try {
    await mkdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`task already exists ${taskId}`);
    }
    throw error;
  }
  const state: TaskState = {
    task_id: taskId, status: "drafting", model,
    repairs_used: 0, tokens_used: 0, wall_started_at: null,
    last_verified: null, evidence_invalid_reason: null, conflicts: [], sessions: [], version: 1,
  };
  const release = await acquireLock(repo, taskId, "create");
  try {
    await putState(dir, taskId, state);
  } finally {
    await release();
  }
  return realpath(dir);
}

export async function saveReference(repo: string, file: string, taskId: string): Promise<TaskReference> {
  const dir = await existingTaskDir(repo, taskId);
  const reference: TaskReference = { task_id: taskId, path: dir };
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${JSON.stringify(reference)}\n`);
  return reference;
}

export async function readReference(file: string): Promise<TaskReference> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  rejectUnknown(Type.Object({
    task_id: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }), parsed, "task reference");
  const reference = parsed as TaskReference;
  assertTaskId(reference.task_id);
  if (!path.isAbsolute(reference.path)) throw new Error("task reference: path must be absolute");
  const actual = await realpath(reference.path);
  if (!isAuthority(actual, reference.task_id)) throw new Error("task reference: not an authority task directory");
  return { task_id: reference.task_id, path: actual };
}

export async function readState(repo: string, taskId: string): Promise<TaskState> {
  const dir = await existingTaskDir(repo, taskId);
  const file = path.join(dir, "state.json");
  await rejectUnexpected(file, "state.json");
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  rejectUnknown(stateSchema, parsed, "state.json");
  const state = parsed as TaskState;
  if (state.task_id !== taskId) throw new Error("state.json: task_id mismatch");
  return state;
}

export async function writeState(repo: string, taskId: string, session: string, state: TaskState): Promise<void> {
  const dir = await existingTaskDir(repo, taskId);
  await assertHeld(dir, session);
  await putState(dir, taskId, state);
}

export async function updateState(
  repo: string, taskId: string, session: string,
  change: (state: TaskState) => TaskState | Promise<TaskState>,
): Promise<TaskState> {
  return withTaskLock(repo, taskId, session, async () => {
    const next = await change(await readState(repo, taskId));
    await writeState(repo, taskId, session, next);
    return next;
  });
}

export async function allocateRun(repo: string, taskId: string, session: string): Promise<number> {
  return withTaskLock(repo, taskId, session, async () => {
    const runs = await runsDir(repo, taskId);
    const names = await readdir(runs);
    const used = names.map((name) => Number(name)).filter((value) => Number.isInteger(value) && value > 0);
    const next = (used.length === 0 ? 0 : Math.max(...used)) + 1;
    await mkdir(path.join(runs, String(next)));
    return next;
  });
}

/**
 * The authoritative task directory's `runs` directory, created if missing.
 * Symlinks and non-directories are rejected so run directories, logs, and
 * results can never land outside the task directory.
 */
export async function runsDir(repo: string, taskId: string): Promise<string> {
  return taskSubdir(repo, taskId, "runs");
}

/** A harness-owned subdirectory of the authoritative task directory. */
export async function taskSubdir(repo: string, taskId: string, name: string): Promise<string> {
  const dir = path.join(await existingTaskDir(repo, taskId), name);
  try {
    await mkdir(dir);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stat = await lstat(dir);
  if (stat.isSymbolicLink()) throw new Error(`${name} must not be a symlink`);
  if (!stat.isDirectory()) throw new Error(`${name} must be a directory`);
  return dir;
}

export async function withTaskLock<T>(
  repo: string, taskId: string, session: string, body: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(repo, taskId, session);
  try {
    return await body();
  } finally {
    await release();
  }
}

export async function acquireLock(repo: string, taskId: string, session: string): Promise<() => Promise<void>> {
  const dir = await existingTaskDir(repo, taskId);
  const lockPath = path.join(dir, "lock");
  const holder: LockHolder = { pid: process.pid, session, acquired_at: new Date().toISOString() };
  const handle = await open(lockPath, lockFlags).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP") throw new Error("task lock must not be a symlink");
    if (error.code !== "EEXIST") throw error;
    await rejectUnexpected(lockPath, "task lock");
    throw new TaskLockError(await readHolder(lockPath));
  });
  try {
    await handle.writeFile(`${JSON.stringify(holder)}\n`);
  } catch (error) {
    await handle.close();
    await rm(lockPath, { force: true });
    throw error;
  }
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await assertHeld(dir, session);
    await rm(lockPath);
  };
}

async function putState(dir: string, taskId: string, state: TaskState): Promise<void> {
  if (state.task_id !== taskId || state.version !== 1) throw new Error("state.json: identity mismatch");
  rejectUnknown(stateSchema, state, "state.json");
  const file = path.join(dir, "state.json");
  await rejectUnexpected(file, "state.json");
  await atomicWrite(file, `${JSON.stringify(state)}\n`);
}

async function assertHeld(dir: string, session: string): Promise<void> {
  const holder = await readHolder(path.join(dir, "lock"));
  if (holder.pid !== process.pid || holder.session !== session) {
    throw new TaskLockError(holder);
  }
}

async function readHolder(lockPath: string): Promise<LockHolder> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
    rejectUnknown(lockSchema, parsed, "task lock");
  } catch (error) {
    if (error instanceof TaskLockError) throw error;
    throw new TaskLockError({ pid: 0, session: "unreadable", acquired_at: "" });
  }
  const holder = parsed as LockHolder;
  if (!(await holderAlive(holder.pid))) {
    throw new TaskLockError({ ...holder, session: `${holder.session} (dead, not reclaimed)` });
  }
  return holder;
}

async function holderAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

async function existingTaskDir(repo: string, taskId: string): Promise<string> {
  assertTaskId(taskId);
  const root = await realpath(repo);
  const dir = await walk(root, [".cw", "tasks", taskId]);
  if (!isAuthority(dir, taskId)) throw new Error("task directory escapes repository");
  return dir;
}

async function ensureParents(repo: string): Promise<string> {
  const root = await realpath(repo);
  let cursor = root;
  for (const part of [".cw", "tasks"]) {
    const next = path.join(cursor, part);
    try {
      cursor = await step(root, next);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await mkdir(next);
      cursor = next;
    }
  }
  if (!pathInside(root, cursor)) throw new Error("task directory escapes repository");
  return cursor;
}

async function walk(root: string, parts: string[]): Promise<string> {
  let cursor = root;
  for (const part of parts) {
    cursor = await step(root, path.join(cursor, part));
  }
  return cursor;
}

async function step(root: string, next: string): Promise<string> {
  const stat = await lstat(next);
  if (stat.isSymbolicLink()) {
    const target = await realpath(next);
    if (!pathInside(root, target)) throw new Error(`task path symlink escapes repository ${next}`);
    throw new Error(`task path must not be a symlink ${next}`);
  }
  if (!stat.isDirectory()) throw new Error(`task path is not a directory ${next}`);
  return next;
}

function isAuthority(dir: string, taskId: string): boolean {
  const parts = dir.split(path.sep);
  return parts.at(-3) === ".cw" && parts.at(-2) === "tasks" && parts.at(-1) === taskId;
}

async function rejectUnexpected(file: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await rejectUnexpected(file, path.basename(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}
