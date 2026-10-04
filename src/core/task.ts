import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { contractSha256, readContract } from "./contract.js";
import { recordTaskEvent } from "./meter.js";
import { assertTaskId, isNotFound, pathInside } from "./paths.js";
import { rejectUnknown } from "./schema.js";
import { Type } from "typebox";
import type { Contract, LockHolder, TaskReference, TaskState } from "./types.js";

const hexSha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const gitObjectId = Type.String({ pattern: "^[0-9a-f]{40,64}$" });

const stateSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("drafting"), Type.Literal("approved"), Type.Literal("running"),
    Type.Literal("verified"), Type.Literal("handed_back"), Type.Literal("cancelled"),
  ]),
  model: Type.String({ minLength: 1 }),
  base_commit: Type.Union([gitObjectId, Type.Null()]),
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

const approvalSchema = Type.Object({
  version: Type.Literal(1),
  contract_sha256: hexSha256,
  project_config_sha256: hexSha256,
  validator: Type.Object({
    cmd: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    timeout_s: Type.Integer({ minimum: 1 }),
    env: Type.Record(Type.String(), Type.String()),
  }, { additionalProperties: false }),
  base_commit: gitObjectId,
  baseline_inputs_sha256: Type.Record(Type.String({ minLength: 1 }), hexSha256),
  /** Content hashes of the repo files the validator cmd references (frozen at approval). */
  validator_inputs_sha256: Type.Record(Type.String({ minLength: 1 }), hexSha256),
  frozen_blobs: Type.Record(Type.String({ minLength: 1 }), gitObjectId),
  red_check_run: Type.Integer({ minimum: 0 }),
  approved_at: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

/** Approved task record (`.cw/tasks/<id>/approval.json`), written by the M6 approval flow. */
export interface Approval {
  version: 1;
  contract_sha256: string;
  project_config_sha256: string;
  validator: { cmd: string[]; timeout_s: number; env: Record<string, string> };
  base_commit: string;
  baseline_inputs_sha256: Record<string, string>;
  validator_inputs_sha256: Record<string, string>;
  frozen_blobs: Record<string, string>;
  /** Run number of the approving red-check run; 0 when the deliverable skips it. */
  red_check_run: number;
  approved_at: string;
}

const blockedSchema = Type.Object({
  version: Type.Literal(1),
  reason: Type.String({ minLength: 1 }),
  questions: Type.Array(Type.String()),
  session: Type.String({ minLength: 1 }),
  created_at: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

/** A `report_blocked` record awaiting the next gate decision. */
export interface BlockedReport {
  version: 1;
  reason: string;
  questions: string[];
  session: string;
  created_at: string;
}

const PROPOSAL_STATUSES = ["approved", "rejected", "pending", "consumed"] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

const proposalSchema = Type.Object({
  version: Type.Literal(1),
  n: Type.Integer({ minimum: 1 }),
  field: Type.String({ minLength: 1 }),
  new_value: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
  status: Type.Union(PROPOSAL_STATUSES.map((value) => Type.Literal(value))),
  session: Type.String({ minLength: 1 }),
  created_at: Type.String({ minLength: 1 }),
  // Set when a successful (re-)approval consumes an `approved` proposal:
  // the contract version that incorporated the change, and when.
  resolved_in_contract_sha256: Type.Optional(hexSha256),
  resolved_at: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export interface Proposal {
  version: 1;
  n: number;
  field: string;
  new_value: string;
  reason: string;
  status: ProposalStatus;
  session: string;
  created_at: string;
  resolved_in_contract_sha256?: string;
  resolved_at?: string;
}

export class TaskLockError extends Error {
  readonly holder: LockHolder;
  constructor(holder: LockHolder) {
    super(`task lock held by pid ${holder.pid} session ${holder.session}`);
    this.name = "TaskLockError";
    this.holder = holder;
  }
}

export async function createTask(
  repo: string, taskId: string, model: string, baseCommit: string | null = null,
): Promise<string> {
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
    task_id: taskId, status: "drafting", model, base_commit: baseCommit,
    repairs_used: 0, tokens_used: 0, wall_started_at: null,
    last_verified: null, evidence_invalid_reason: null, conflicts: [], sessions: [], version: 1,
  };
  const release = await acquireLock(repo, taskId, "create");
  try {
    await putState(dir, taskId, state);
    await recordTaskEvent(repo, taskId, "create", "task_created", { model, base_commit: baseCommit });
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

/** Read and schema-check the approved task record. */
export async function readApproval(repo: string, taskId: string): Promise<Approval> {
  const file = path.join(await existingTaskDir(repo, taskId), "approval.json");
  await rejectUnexpected(file, "approval.json");
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  rejectUnknown(approvalSchema, parsed, "approval.json");
  return parsed as Approval;
}

/**
 * Harness-only write of the approval record plus the `drafting`/`handed_back`
 * → `approved` transition, registering the approving session. Everything
 * happens inside one task lock, and the state precondition is checked BEFORE
 * any file is touched: a concurrent approver that already moved the task
 * forward makes this call fail without overwriting a single field of the
 * winner. Refuses when the task is in any other state. On success, every
 * `approved` (user-confirmed) contract-change proposal is atomically consumed
 * — marked with the contract version that incorporated it — so the gate stops
 * blocking on it; `pending`, `rejected`, and later proposals are untouched.
 */
export async function writeApproval(
  repo: string, taskId: string, session: string, approval: Approval, contract: Contract,
  isCancelled?: () => boolean,
): Promise<TaskState> {
  assertTaskId(taskId);
  const cancelled = (): Error => new Error("approve: 用户已取消，拒绝批准");
  return withTaskLock(repo, taskId, session, async () => {
    const dir = await existingTaskDir(repo, taskId);
    const state = await readState(repo, taskId);
    if (state.status !== "drafting" && state.status !== "handed_back") {
      throw new Error(`approve: task status is ${state.status}, not drafting/handed_back`);
    }
    if (isCancelled?.()) throw cancelled();
    // The approval must describe exactly the contract currently on disk; a
    // file edited between the red check and this write refuses the approval.
    const fresh = await readContract(path.join(dir, "contract.toml"), repo, taskId);
    const freshSha = contractSha256(fresh);
    if (freshSha !== contractSha256(contract) || freshSha !== approval.contract_sha256) {
      throw new Error("approve: 契约在批准过程中再次变化，拒绝批准");
    }
    // Only user-approved proposals that the current contract actually adopted
    // belong to this approval version; anything else refuses the approval and
    // keeps blocking until the user applies or rejects it.
    const adoptable: Proposal[] = [];
    for (const proposal of await readProposals(repo, taskId)) {
      if (proposal.status !== "approved") continue;
      if (!proposalAdopted(fresh, proposal)) {
        throw new Error(
          `approve: 提议 ${proposal.n}（字段 ${proposal.field}）未在当前契约采纳新值，拒绝批准`);
      }
      adoptable.push(proposal);
    }
    rejectUnknown(approvalSchema, approval, "approval.json");
    const file = path.join(dir, "approval.json");
    await rejectUnexpected(file, "approval.json");
    if (isCancelled?.()) throw cancelled();
    await atomicWrite(file, `${JSON.stringify(approval, null, 2)}\n`);
    if (isCancelled?.()) {
      // The cancel landed between the record write and the state transition:
      // remove the record this call just wrote so nothing partial survives.
      await rm(file, { force: true });
      throw cancelled();
    }
    const sessions = state.sessions.includes(session) ? state.sessions : [...state.sessions, session];
    const next: TaskState = { ...state, status: "approved", sessions };
    await putState(dir, taskId, next);
    await consumeProposals(repo, taskId, approval.contract_sha256, adoptable);
    return next;
  });
}

/**
 * Whether the proposal's change is actually present in `contract`: string
 * fields compare textually; list fields compare against the new_value parsed
 * as a JSON string array (whitespace-tolerant). Unknown fields and
 * non-string-list values never match — fail closed.
 */
export function proposalAdopted(
  contract: Contract, proposal: Pick<Proposal, "field" | "new_value">,
): boolean {
  const current = (contract as unknown as Record<string, unknown>)[proposal.field];
  if (typeof current === "string") return current === proposal.new_value;
  if (Array.isArray(current) && current.every((item) => typeof item === "string")) {
    try {
      const parsed: unknown = JSON.parse(proposal.new_value);
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return false;
      return (parsed as string[]).join("\u0000") === (current as string[]).join("\u0000");
    } catch {
      return false;
    }
  }
  return false;
}

/** All schema-valid proposals of the task, by number; malformed files are skipped. */
async function readProposals(repo: string, taskId: string): Promise<Proposal[]> {
  const proposals = path.join(await existingTaskDir(repo, taskId), "proposals");
  let names: string[];
  try {
    names = (await readdir(proposals)).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const found: Proposal[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(proposals, name);
    await rejectUnexpected(file, name);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      rejectUnknown(proposalSchema, parsed, name);
      found.push(parsed as Proposal);
    } catch {
      // A malformed proposal cannot drive the gate; ignore it here.
    }
  }
  return found;
}

/**
 * Mark the given proposals `consumed`, bound to the contract version that
 * resolved them. Runs under the caller's task lock, so the consumption is
 * atomic with the approval record and state transition.
 */
async function consumeProposals(
  repo: string, taskId: string, contractSha: string, adoptable: readonly Proposal[],
): Promise<void> {
  if (adoptable.length === 0) return;
  const proposals = path.join(await existingTaskDir(repo, taskId), "proposals");
  for (const proposal of adoptable) {
    const consumed: Proposal = {
      ...proposal,
      status: "consumed",
      resolved_in_contract_sha256: contractSha,
      resolved_at: new Date().toISOString(),
    };
    rejectUnknown(proposalSchema, consumed, `${proposal.n}.json`);
    const file = path.join(proposals, `${proposal.n}.json`);
    await rejectUnexpected(file, `${proposal.n}.json`);
    await atomicWrite(file, `${JSON.stringify(consumed, null, 2)}\n`);
  }
}

/** All task directories whose state has one of the given statuses, sorted by id. */
export async function findTasksByStatus(repo: string, statuses: readonly TaskState["status"][]): Promise<string[]> {
  const root = await realpath(repo);
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, ".cw", "tasks"), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      assertTaskId(entry.name);
      const state = await readState(root, entry.name);
      if (statuses.includes(state.status)) matches.push(entry.name);
    } catch {
      // A malformed or foreign task directory is not manageable.
    }
  }
  return matches.sort();
}

/** Active tasks for a session: status `approved`/`running` with the session registered. */
export async function findSessionTasks(repo: string, session: string): Promise<string[]> {
  const root = await realpath(repo);
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, ".cw", "tasks"), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      assertTaskId(entry.name);
      const state = await readState(root, entry.name);
      if ((state.status === "approved" || state.status === "running") && state.sessions.includes(session)) {
        matches.push(entry.name);
      }
    } catch {
      // A malformed or foreign task directory is not manageable from this session.
    }
  }
  return matches.sort();
}

async function taskFileLocked<T>(
  repo: string, taskId: string, session: string, body: (dir: string) => Promise<T>,
): Promise<T> {
  return withTaskLock(repo, taskId, session, async () => body(await existingTaskDir(repo, taskId)));
}

/** Record the model's `report_blocked` report for the next gate decision. */
export async function writeBlocked(
  repo: string, taskId: string, session: string, report: { reason: string; questions: string[] },
): Promise<void> {
  await taskFileLocked(repo, taskId, session, async (dir) => {
    const record: BlockedReport = {
      version: 1, reason: report.reason, questions: report.questions,
      session, created_at: new Date().toISOString(),
    };
    rejectUnknown(blockedSchema, record, "blocked.json");
    await atomicWrite(path.join(dir, "blocked.json"), `${JSON.stringify(record)}\n`);
  });
}

/**
 * The pending `report_blocked` record, or null. A malformed record throws:
 * an unreadable block report must not be silently ignored by the gate.
 */
export async function readBlocked(repo: string, taskId: string): Promise<BlockedReport | null> {
  const dir = await existingTaskDir(repo, taskId);
  const file = path.join(dir, "blocked.json");
  await rejectUnexpected(file, "blocked.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  rejectUnknown(blockedSchema, parsed, "blocked.json");
  return parsed as BlockedReport;
}

/** Remove the block record once the gate has turned it into handback material. */
export async function clearBlocked(repo: string, taskId: string, session: string): Promise<void> {
  await taskFileLocked(repo, taskId, session, async (dir) => {
    await rejectUnexpected(path.join(dir, "blocked.json"), "blocked.json");
    await rm(path.join(dir, "blocked.json"), { force: true });
  });
}

export interface ProposalInput {
  field: string;
  new_value: string;
  reason: string;
  status: ProposalStatus;
}

/** Append a contract-change proposal as `proposals/<max+1>.json` under the task lock. */
export async function writeProposal(
  repo: string, taskId: string, session: string, input: ProposalInput,
): Promise<Proposal> {
  return taskFileLocked(repo, taskId, session, async (dir) => {
    const proposals = await taskSubdir(repo, taskId, "proposals");
    const used = (await readdir(proposals))
      .map((name) => Number(name.replace(/\.json$/, "")))
      .filter((value) => Number.isInteger(value) && value > 0);
    const proposal: Proposal = {
      version: 1, n: (used.length === 0 ? 0 : Math.max(...used)) + 1,
      field: input.field, new_value: input.new_value, reason: input.reason,
      status: input.status, session, created_at: new Date().toISOString(),
    };
    rejectUnknown(proposalSchema, proposal, "proposal.json");
    await atomicWrite(path.join(dir, "proposals", `${proposal.n}.json`), `${JSON.stringify(proposal, null, 2)}\n`);
    return proposal;
  });
}

/**
 * Highest-numbered proposal that still blocks autonomous work. `pending`
 * waits for a human decision; `approved` waits for the M6 contract
 * regeneration and red-check rerun (a successful approval consumes it only
 * when the contract actually adopted it, see `writeApproval`); `rejected` and
 * `consumed` let work continue.
 */
export async function findUnresolvedProposal(repo: string, taskId: string): Promise<Proposal | null> {
  const found = (await readProposals(repo, taskId))
    .filter((proposal) => proposal.status !== "rejected" && proposal.status !== "consumed");
  return found.length === 0 ? null : found.at(-1)!;
}
