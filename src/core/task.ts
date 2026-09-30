import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertTaskId } from "./paths.js";
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

export class TaskLockError extends Error {
  readonly holder: LockHolder;
  constructor(holder: LockHolder) {
    super(`task lock held by pid ${holder.pid} session ${holder.session}`);
    this.name = "TaskLockError";
    this.holder = holder;
  }
}

export function taskPaths(root: string, taskId: string): { dir: string; state: string; lock: string; runs: string } {
  const dir = path.join(root, ".cw", "tasks", taskId);
  return { dir, state: path.join(dir, "state.json"), lock: path.join(dir, "lock"), runs: path.join(dir, "runs") };
}

export async function createTask(repo: string, taskId: string, model: string): Promise<string> {
  assertTaskId(taskId);
  const paths = taskPaths(repo, taskId);
  await mkdir(paths.dir, { recursive: true });
  const state: TaskState = {
    task_id: taskId, status: "drafting", model,
    repairs_used: 0, tokens_used: 0, wall_started_at: null,
    last_verified: null, evidence_invalid_reason: null, conflicts: [], sessions: [], version: 1,
  };
  await writeState(repo, taskId, state);
  return realpath(paths.dir);
}

export async function saveReference(repo: string, file: string, taskId: string): Promise<TaskReference> {
  assertTaskId(taskId);
  const reference: TaskReference = { task_id: taskId, path: await realpath(taskPaths(repo, taskId).dir) };
  if (path.basename(reference.path) !== taskId) throw new Error("task reference: directory does not match task_id");
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
  const actual = await realpath(reference.path);
  if (path.basename(actual) !== reference.task_id) throw new Error("task reference: directory does not match task_id");
  return { task_id: reference.task_id, path: actual };
}

export async function readState(repo: string, taskId: string): Promise<TaskState> {
  const parsed: unknown = JSON.parse(await readFile(taskPaths(repo, taskId).state, "utf8"));
  rejectUnknown(stateSchema, parsed, "state.json");
  const state = parsed as TaskState;
  if (state.task_id !== taskId) throw new Error("state.json: task_id mismatch");
  return state;
}

export async function writeState(repo: string, taskId: string, state: TaskState): Promise<void> {
  if (state.task_id !== taskId || state.version !== 1) throw new Error("state.json: identity mismatch");
  rejectUnknown(stateSchema, state, "state.json");
  await atomicWrite(taskPaths(repo, taskId).state, `${JSON.stringify(state)}\n`);
}

export async function updateState(
  repo: string, taskId: string, session: string,
  change: (state: TaskState) => TaskState | Promise<TaskState>,
): Promise<TaskState> {
  return withTaskLock(repo, taskId, session, async () => {
    const next = await change(await readState(repo, taskId));
    await writeState(repo, taskId, next);
    return next;
  });
}

export async function allocateRun(repo: string, taskId: string, session: string): Promise<number> {
  return withTaskLock(repo, taskId, session, async () => nextRun(repo, taskId));
}

async function nextRun(repo: string, taskId: string): Promise<number> {
  const runs = taskPaths(repo, taskId).runs;
  await mkdir(runs, { recursive: true });
  const names = await readFileNames(runs);
  const used = names.map((name) => Number(name)).filter((value) => Number.isInteger(value) && value > 0);
  const next = (used.length === 0 ? 0 : Math.max(...used)) + 1;
  await mkdir(path.join(runs, String(next)), { recursive: false });
  return next;
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
  const lockPath = taskPaths(repo, taskId).lock;
  const holder: LockHolder = { pid: process.pid, session, acquired_at: new Date().toISOString() };
  const handle = await open(lockPath, "wx").catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
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
    const current = await readHolder(lockPath);
    if (current.pid !== process.pid || current.session !== session) {
      throw new Error("task lock: holder changed before release");
    }
    await rm(lockPath);
  };
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

async function atomicWrite(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

async function readFileNames(dir: string): Promise<string[]> {
  return readdir(dir);
}


