/**
 * 任务账本中枢：掌管 `.cw/tasks/<id>` 目录布局，以及 `state.json`、`approval.json`、
 * `proposals/`、`blocked.json` 的读写、独占任务锁（含死锁回收）与批准时的状态迁移。
 *
 * 所有状态修改都在任务锁内完成；路径的每一段都拒绝符号链接；写入一律原子（临时文件 + rename）；
 * 失败一律抛错——绝不返回默认值或半截文档。`state.json` 是门禁与 CLI 读取的唯一权威。
 *
 * The task-ledger hub: owns the `.cw/tasks/<id>` layout and the read/write paths
 * for `state.json`, `approval.json`, `proposals/`, and `blocked.json`, along
 * with the exclusive task lock (dead-holder reclamation included) and the
 * approval-time state transition.
 *
 * Every mutation runs under the task lock, every path segment is checked
 * against symlinks, and every write is atomic (temp file + rename). Failures
 * throw — nothing here falls back to a default or to a partial document, and
 * `state.json` stays the single authority the gate and the CLI read.
 */
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

/** 内容哈希一律是 64 位小写 hex / Content hashes are always 64 lowercase hex chars. */
const hexSha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
/**
 * git 对象 id：同时接受 sha1（40 位）与 sha256（64 位）仓库的写法。
 *
 * Git object id: accepts both sha1 (40 chars) and sha256 (64 chars) repositories.
 */
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

/**
 * 独占创建且绝不跟随符号链接：`O_EXCL` 保证只有创建者能持有锁文件，目标若是符号链接，内核直接报 `ELOOP`。
 *
 * Exclusive creation that never follows a symlink: `O_EXCL` means only the
 * creator owns the lock file, and a symlinked target fails with `ELOOP` in the
 * kernel before anything is written.
 */
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

/**
 * 已批准任务的落盘记录（`approval.json`），由 M6 批准流程写入；它把「批准了什么」锚定成哈希。
 *
 * Approved task record (`.cw/tasks/<id>/approval.json`), written by the M6 approval flow.
 */
export interface Approval {
  version: 1;
  /** 被批准的契约文本哈希；契约再改动即失效 / Hash of the approved contract text; later edits invalidate it. */
  contract_sha256: string;
  /** 批准时的项目配置哈希；配置漂移即阻塞 / Hash of the project config at approval; drift blocks the gate. */
  project_config_sha256: string;
  validator: { cmd: string[]; timeout_s: number; env: Record<string, string> };
  base_commit: string;
  /** 批准时各基线输入的内容哈希，键为仓库内相对路径 / Content hashes of each baseline input by repo-relative path. */
  baseline_inputs_sha256: Record<string, string>;
  validator_inputs_sha256: Record<string, string>;
  /** 冻结文件的 git blob 哈希，键为仓库内相对路径 / Git blob hashes of the frozen files, keyed by path. */
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

/**
 * 等待下一次门禁决策的 `report_blocked` 记录（`blocked.json`）；门禁把它转成回交材料后即删除。
 *
 * A `report_blocked` record awaiting the next gate decision.
 */
export interface BlockedReport {
  version: 1;
  reason: string;
  questions: string[];
  session: string;
  created_at: string;
}

/**
 * 提议的全部状态取值；同时驱动下面的联合类型与 `proposalSchema`。
 *
 * Every proposal status; drives both the union type and `proposalSchema`.
 */
const PROPOSAL_STATUSES = ["approved", "rejected", "pending", "consumed"] as const;

/** 提议状态的联合类型 / Literal union of the proposal statuses. */
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

/**
 * 契约变更提议（`.cw/tasks/<id>/proposals/<n>.json`）：模型请求改契约，用户批准或拒绝，
 * 只有被契约采纳才能解除门禁阻塞。
 *
 * A contract-change proposal (`proposals/<n>.json`, `n` starting at 1). The model
 * asks for a contract edit and a user decides; the gate keeps blocking until the
 * change is actually adopted. `n` is picked under the task lock, so numbers are
 * unique per task.
 */
export interface Proposal {
  version: 1;
  /** 任务内递增的提议编号，也是文件名 / Per-task proposal number, also its file name. */
  n: number;
  field: string;
  new_value: string;
  reason: string;
  status: ProposalStatus;
  session: string;
  created_at: string;
  /** 采纳该提议的契约哈希；仅 `consumed` 时有值 / Contract hash that adopted the change; only on `consumed`. */
  resolved_in_contract_sha256?: string;
  /** 采纳时间（ISO）/ When the change was adopted, ISO timestamp. */
  resolved_at?: string;
}

/**
 * 任务锁不在本进程/本会话手里时抛出；`holder` 是读到的持有者记录，调用方据此告诉用户该等谁。
 *
 * Raised when the task lock is not held by this process and session. `holder`
 * carries the record that was read — a synthetic one when the file is
 * unreadable or its holder is provably dead — so callers can report who to wait
 * for instead of failing silently.
 */
export class TaskLockError extends Error {
  readonly holder: LockHolder;
  constructor(holder: LockHolder) {
    super(`task lock held by pid ${holder.pid} session ${holder.session}`);
    this.name = "TaskLockError";
    this.holder = holder;
  }
}

/**
 * 新建任务账本：建出 `<repo>/.cw/tasks/<id>`，在任务锁内写入初始 `drafting` 状态与创建计量事件。
 *
 * Creates a task ledger: the `<repo>/.cw/tasks/<id>` directory, then the initial
 * `drafting` state plus a best-effort `task_created` meter event, all under the
 * task lock. An existing directory is refused outright, so creating a task can
 * never overwrite another ledger.
 *
 * @param repo - 仓库根 / Repository root.
 * @param taskId - 任务 id（`YYYYMMDD-slug`）/ Task id, `YYYYMMDD-slug`.
 * @param model - 该任务将使用的模型名 / Model the task will run on.
 * @param baseCommit - 基线提交，可为 null / Baseline commit stored in state; may be null.
 * @returns 权威任务目录的 realpath / Realpath of the authority task directory.
 * @throws 目录已存在或账本路径逃逸时 / When the directory exists or the path escapes.
 */
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

/**
 * 把指向权威任务目录的指针写到会话真正工作的地方（如升级 worktree），供之后 `readReference` 找回账本。
 *
 * Writes the pointer that lets a session running elsewhere — an escalation
 * worktree, for example — find the authority task directory again. Parent
 * directories are created and the write is atomic.
 *
 * @param file - 指针文件的存放路径 / Where to write the pointer file.
 * @returns 写入的指针（`path` 为权威任务目录）/ The pointer that was written.
 */
export async function saveReference(repo: string, file: string, taskId: string): Promise<TaskReference> {
  const dir = await existingTaskDir(repo, taskId);
  const reference: TaskReference = { task_id: taskId, path: dir };
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${JSON.stringify(reference)}\n`);
  return reference;
}

/**
 * 读取并重新认证任务指针：schema 拒绝多余字段，任务 id 重校验，`path` 必须绝对，
 * 且 realpath 后仍是 `<…>/.cw/tasks/<id>` 目录。
 *
 * Reads a task pointer and re-authenticates it: the JSON is schema-checked, the
 * task id re-validated, and the path must be absolute with a realpath that is
 * still a `<…>/.cw/tasks/<id>` directory — a forged file cannot redirect the
 * ledger elsewhere.
 *
 * @param file - 指针文件路径 / Path of the pointer file.
 * @returns 认证通过的指针，`path` 已 realpath / The authenticated pointer, realpathed.
 */
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

/**
 * 读取权威 `state.json`：拒绝符号链接，校验 schema，并要求文件里的 `task_id` 与所在目录一致；任何不符都抛错。
 *
 * Reads the authoritative `state.json` of a task: symlinks are refused, the
 * document is schema-checked, and its `task_id` must match the directory it was
 * found in. Nothing here substitutes a default state for an unreadable ledger.
 *
 * @param repo - 仓库根 / Repository root.
 * @param taskId - 任务 id / Task id.
 * @returns 校验通过的任务状态 / The validated task state.
 * @throws 账本缺失或字段非法时 / When the ledger is missing or malformed.
 */
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

/**
 * 整体覆盖 `state.json`（原子写），要求调用方已持锁：进程与 `session` 任一不匹配即抛 `TaskLockError`。
 *
 * Overwrites `state.json` wholesale with an atomic write. It acquires nothing:
 * the caller must already hold the lock for this process and `session`, or the
 * write refuses with `TaskLockError`. Transition legality is the caller's
 * business — this function only checks identity.
 */
export async function writeState(repo: string, taskId: string, session: string, state: TaskState): Promise<void> {
  const dir = await existingTaskDir(repo, taskId);
  await assertHeld(dir, session);
  await putState(dir, taskId, state);
}

/**
 * 读-改-写的原子入口：整段在任务锁内执行，`change` 一定拿到刚读出的权威状态，其返回值写入后锁才释放。
 *
 * The atomic read-modify-write entry point for `state.json`: the callback runs
 * under the task lock, so it always sees freshly read authoritative state and
 * its result is written before the lock is released. The callback owns the
 * transition guard — throwing aborts without writing anything.
 *
 * @param change - 状态变换函数，可抛错放弃 / State transform; throwing aborts the write.
 * @returns 已写入的新状态 / The state that was written.
 */
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

/**
 * 在任务锁内分配 run 号并建出 `runs/<n>` 目录：取已有数字目录的最大值加一，从 1 开始，并发调用者绝不会撞号。
 *
 * Allocates the next run number under the task lock and creates `runs/<n>`, so
 * two concurrent callers can never share a run directory. Numbering starts at 1
 * and ignores non-numeric entries.
 *
 * @returns 分配到的 run 号 / The allocated run number.
 */
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
 * 权威任务目录下的 `runs` 目录，不存在则创建；符号链接与非目录都被拒绝，run 目录、日志、结果因此永远落在任务目录内。
 *
 * The authoritative task directory's `runs` directory, created if missing.
 * Symlinks and non-directories are rejected so run directories, logs, and
 * results can never land outside the task directory.
 */
export async function runsDir(repo: string, taskId: string): Promise<string> {
  return taskSubdir(repo, taskId, "runs");
}

/**
 * 权威任务目录下由 harness 拥有的子目录（`runs`、`proposals` 等）：缺则创建，已存在必须是真目录且不是符号链接。
 *
 * A harness-owned subdirectory of the authoritative task directory.
 */
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

/**
 * 以任务锁包住整段操作并在 `finally` 里释放：回调抛错，或释放本身失败，锁都不会泄漏在文件系统里。
 *
 * Runs `body` under the task lock and releases it in a `finally`, so neither a
 * throwing body nor a failing release leaks the lock file. Re-entering the lock
 * for the same task from the same process throws `TaskLockError` — the live
 * holder is this very process and is never reclaimed — so bodies stay lock-free.
 *
 * @param body - 持锁期间执行的临界区 / The critical section to run while holding the lock.
 * @returns 回调的返回值 / Whatever the body returns.
 */
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

/**
 * 取任务锁：以 `O_EXCL | O_NOFOLLOW` 独占创建 `lock` 文件，写入本进程的持有者记录（pid、session、时间）。
 *
 * Takes the task lock by exclusively creating the `lock` file with this
 * process's holder record, then returns the release function. Contention is
 * reported as `TaskLockError` carrying the holder that was read.
 *
 * @param repo - 仓库根 / Repository root.
 * @param taskId - 任务 id / Task id.
 * @param session - 记入锁并在释放时复核的会话 id / Session id; re-checked on release.
 * @returns 幂等的释放函数（重复调用无副作用）/ Idempotent release function; extra calls are no-ops.
 * @throws {TaskLockError} 锁被活进程占用 / Held by a process that is not provably dead.
 * @remarks
 * 三条失败路径都不放行：`ELOOP`（锁文件是符号链接）直接抛错；`EEXIST` 时只有 `reclaimDeadLock`
 * 能证明持有进程已死且锁内容前后一致，才回收并重试一次；其余一律抛错。写持有者失败会关掉句柄并
 * 删掉刚建的锁文件，不留内容残缺的锁；回收后重试仍被抢先，照样抛 `TaskLockError`。
 */
export async function acquireLock(repo: string, taskId: string, session: string): Promise<() => Promise<void>> {
  const dir = await existingTaskDir(repo, taskId);
  const lockPath = path.join(dir, "lock");
  const holder: LockHolder = { pid: process.pid, session, acquired_at: new Date().toISOString() };
  const openLock = () => open(lockPath, lockFlags);
  const handle = await openLock().catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP") throw new Error("task lock must not be a symlink");
    if (error.code !== "EEXIST") throw error;
    await rejectUnexpected(lockPath, "task lock");
    // A lock whose holder process is provably dead (kill(pid,0) → ESRCH) and
    // whose file content is unchanged between two reads is safely reclaimable;
    // live pids and unresolvable pids (EPERM) keep refusing.
    if (await reclaimDeadLock(lockPath)) {
      return openLock().catch(async (retry: NodeJS.ErrnoException) => {
        if (retry.code === "ELOOP") throw new Error("task lock must not be a symlink");
        if (retry.code !== "EEXIST") throw retry;
        await rejectUnexpected(lockPath, "task lock");
        throw new TaskLockError(await readHolder(lockPath));
      });
    }
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

/**
 * 先查身份（`task_id`、`version`）与 schema，再原子覆盖 `state.json`；目标不得是符号链接。
 *
 * Validates identity and schema, then atomically overwrites `state.json`;
 * a symlinked target is refused before anything is written.
 */
async function putState(dir: string, taskId: string, state: TaskState): Promise<void> {
  if (state.task_id !== taskId || state.version !== 1) throw new Error("state.json: identity mismatch");
  rejectUnknown(stateSchema, state, "state.json");
  const file = path.join(dir, "state.json");
  await rejectUnexpected(file, "state.json");
  await atomicWrite(file, `${JSON.stringify(state)}\n`);
}

/**
 * 核对 `lock` 记录的 pid 与 session 是否都等于本进程与本会话，否则抛 `TaskLockError`；每个写路径都先过这一关。
 *
 * Asserts the `lock` file names this process and this `session`, throwing
 * `TaskLockError` otherwise. Every write path runs it, so a task whose lock was
 * reclaimed elsewhere refuses to write instead of interleaving with the winner.
 */
async function assertHeld(dir: string, session: string): Promise<void> {
  const holder = await readHolder(path.join(dir, "lock"));
  if (holder.pid !== process.pid || holder.session !== session) {
    throw new TaskLockError(holder);
  }
}

/**
 * 读出锁持有者用于报错：文件缺失或损坏时用占位持有者，持有进程可证明已死时在会话名后标注 "(dead, not reclaimed)"。
 *
 * Reads the lock holder for error reporting: a missing or malformed file yields
 * a placeholder holder, and a provably dead holder gets its session label
 * suffixed with "(dead, not reclaimed)" so the caller can tell why it refused.
 */
async function readHolder(lockPath: string): Promise<LockHolder> {
  const holder = await readRawHolder(lockPath);
  if (holder === null) {
    throw new TaskLockError({ pid: 0, session: "unreadable", acquired_at: "" });
  }
  if (!(await holderAlive(holder.pid))) {
    throw new TaskLockError({ ...holder, session: `${holder.session} (dead, not reclaimed)` });
  }
  return holder;
}

/**
 * 解析后的锁内容；文件不存在、JSON 损坏或 schema 不符时返回 null（调用方据此既不回收也不信任）。
 *
 * Parsed lock content, or null when the file is gone or malformed.
 */
async function readRawHolder(lockPath: string): Promise<LockHolder | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
    rejectUnknown(lockSchema, parsed, "task lock");
  } catch {
    return null;
  }
  return parsed as LockHolder;
}

/**
 * 只有锁记录的进程可证明已死（`kill(pid, 0)` → ESRCH）时才删除锁文件。
 *
 * 内容前后读两次必须完全一致，所以两次读之间被别人重新取走的锁（内容已变）绝不会被删除；
 * 任何一次读或解析失败也都保持文件原样。
 *
 * Remove the lock file when its recorded process is provably dead. The content
 * is read twice and must be identical both times, so a lock that another
 * process re-acquired in between (different content) is never removed; any
 * read or parse failure leaves the file untouched.
 */
async function reclaimDeadLock(lockPath: string): Promise<boolean> {
  const stale = await readRawHolder(lockPath);
  if (stale === null || (await holderAlive(stale.pid))) return false;
  const current = await readRawHolder(lockPath);
  if (current === null || JSON.stringify(current) !== JSON.stringify(stale)) return false;
  await rm(lockPath, { force: true });
  return true;
}

/**
 * 用 `kill(pid, 0)` 探活：EPERM 视为存活（进程属于别人），ESRCH 视为已死，其余错误原样抛出。
 *
 * Liveness probe via `kill(pid, 0)`: EPERM counts as alive (someone else's
 * process), ESRCH as dead, and any other error propagates — a lock is never
 * reclaimed on an error that cannot be read.
 */
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

/**
 * 解析已存在的权威任务目录 `<repo>/.cw/tasks/<id>`：仓库根先 realpath，逐段要求真实目录
 * （符号链接一律拒绝，即便没逃出仓库），最后校验 `.cw/tasks/<id>` 身份。
 *
 * Resolves the existing authority task directory `<repo>/.cw/tasks/<id>`: the
 * repo root is realpathed first, every segment must be a real directory —
 * symlinks are refused even when they stay inside the repo — and the final path
 * must match the `.cw/tasks/<id>` authority shape.
 *
 * @throws 任务 id 非法或路径逃逸时 / On an invalid id or an escaping path.
 */
async function existingTaskDir(repo: string, taskId: string): Promise<string> {
  assertTaskId(taskId);
  const root = await realpath(repo);
  const dir = await walk(root, [".cw", "tasks", taskId]);
  if (!isAuthority(dir, taskId)) throw new Error("task directory escapes repository");
  return dir;
}

/**
 * 按需建出 `.cw` 与 `.cw/tasks`：已存在的段必须是真目录（非符号链接），最后确认结果仍在仓库内；
 * 只有 ENOENT 当作「需要创建」。
 *
 * Creates `.cw` and `.cw/tasks` as needed: every existing segment must be a real
 * directory rather than a symlink, only ENOENT is treated as "needs creating",
 * and the result must still sit inside the repository.
 *
 * @returns `.cw/tasks` 的绝对路径 / Absolute path of `.cw/tasks`.
 */
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

/**
 * 从 `root` 起逐段走 `parts`，每段都过 `step`（拒绝符号链接与非目录）；某段不存在时抛 ENOENT。
 *
 * Walks `parts` from `root`, passing each segment through `step` so symlink and
 * non-directory segments are refused; a missing segment throws ENOENT.
 */
async function walk(root: string, parts: string[]): Promise<string> {
  let cursor = root;
  for (const part of parts) {
    cursor = await step(root, path.join(cursor, part));
  }
  return cursor;
}

/**
 * 校验单段路径：符号链接一律拒绝（目标逃出仓库报「逃逸」，其余报「不得为符号链接」），非目录也拒绝。
 *
 * Checks one path segment: symlinks are always refused — an escaping target is
 * reported as an escape, every other one as "must not be a symlink" — and
 * non-directories are refused too. Returns the path unchanged on success.
 */
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

/**
 * 判断路径末三段是否正好是 `.cw`、`tasks`、`taskId`；纯字符串比较，不访问文件系统。
 *
 * Whether the last three segments are exactly `.cw`, `tasks`, `taskId`.
 * Purely lexical — no filesystem access.
 */
function isAuthority(dir: string, taskId: string): boolean {
  const parts = dir.split(path.sep);
  return parts.at(-3) === ".cw" && parts.at(-2) === "tasks" && parts.at(-1) === taskId;
}

/**
 * 读写目标护栏：符号链接一律拒绝；其余情况（不存在、普通文件、目录）都放行，仅 ENOENT 视为无害。
 *
 * Guard for a read/write target: a symlink is refused while everything else
 * passes — a missing file, a regular file, even a directory; only ENOENT is
 * treated as harmless.
 */
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

/**
 * 原子写：先拒绝符号链接目标，把内容写进同目录的 `<file>.<pid>.<uuid>.tmp`，再 `rename` 覆盖；
 * 读者只会看到旧内容或新内容，绝无半截文档。
 *
 * Atomic write: the target may not be a symlink, the contents land in a
 * `<file>.<pid>.<uuid>.tmp` sibling first, and `rename` publishes them in one
 * step — readers see either the old document or the new one, never a partial
 * one. The temp name carries pid and uuid so concurrent writers cannot collide;
 * a failed write may leave its temp file behind.
 */
async function atomicWrite(file: string, contents: string): Promise<void> {
  await rejectUnexpected(file, path.basename(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

/**
 * 读取并 schema 校验已批准任务记录：文件缺失、被符号链接替换或字段非法都抛错。
 *
 * Read and schema-check the approved task record.
 */
export async function readApproval(repo: string, taskId: string): Promise<Approval> {
  const file = path.join(await existingTaskDir(repo, taskId), "approval.json");
  await rejectUnexpected(file, "approval.json");
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  rejectUnknown(approvalSchema, parsed, "approval.json");
  return parsed as Approval;
}

/**
 * 只有 harness 能调用的批准写入：写下 approval.json，完成 `drafting`/`handed_back`
 * → `approved` 迁移，并把本次会话登记进 `sessions`。
 *
 * 全过程在一个任务锁内，且状态前置检查发生在碰任何文件之前：并发批准者若已把任务推进，本次调用直接失败，
 * 不会覆盖赢家的任何字段；其余状态一律拒绝。成功后所有 `approved`（用户已确认）的提议被原子消费——
 * 标记上采纳它的契约版本——门禁不再因此阻塞；`pending`、`rejected` 与更晚的提议不动。
 *
 * Harness-only write of the approval record plus the `drafting`/`handed_back`
 * → `approved` transition, registering the approving session. Everything
 * happens inside one task lock, and the state precondition is checked BEFORE
 * any file is touched: a concurrent approver that already moved the task
 * forward makes this call fail without overwriting a single field of the
 * winner. Refuses when the task is in any other state. On success, every
 * `approved` (user-confirmed) contract-change proposal is atomically consumed
 * — marked with the contract version that incorporated it — so the gate stops
 * blocking on it; `pending`, `rejected`, and later proposals are untouched.
 *
 * @param repo - 仓库根 / Repository root.
 * @param taskId - 任务 id / Task id.
 * @param session - 批准会话，登记进 `state.sessions` / Approving session, registered in `state.sessions`.
 * @param approval - 待写入的记录 / Record to write; must match the contract on disk.
 * @param contract - 调用方已读到的契约 / The caller's contract, compared against disk.
 * @param isCancelled - 取消探测，true 即回滚 / Cancellation probe; true rolls back the write.
 * @returns 迁移后的状态（`approved`，已登记会话）/ New state (`approved`, session registered).
 * @throws 状态不符或提议未被采纳时 / On a wrong status or an unadopted proposal.
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
 * 判断提议的改动是否真的出现在 `contract` 里：字符串字段逐字比较；列表字段把 `new_value`
 * 当 JSON 字符串数组解析后比较（容忍空白与写法差异）。
 *
 * 未知字段与非字符串列表永不匹配——fail closed：宁可判「未采纳」而继续阻塞，也不误放行。
 *
 * Whether the proposal's change is actually present in `contract`: string
 * fields compare textually; list fields compare against the new_value parsed
 * as a JSON string array (whitespace-tolerant). Unknown fields and
 * non-string-list values never match — fail closed.
 *
 * @param contract - 判定的依据，即磁盘上的当前契约 / The contract as it stands on disk.
 * @param proposal - 只取字段名与新值 / Only the field name and the new value are used.
 * @returns 契约中已带该新值时为 true / True when the contract already carries the proposed value.
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

/**
 * 任务下所有 schema 合法的提议，按文件名排序返回；非 `<n>.json` 与损坏的文件跳过，符号链接文件则直接抛错。
 *
 * All schema-valid proposals of the task, by number; malformed files are skipped.
 */
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
 * 把给定提议标记为 `consumed`，并绑定采纳它们的契约版本与时间。
 *
 * 在调用方的任务锁内执行，所以「消费提议」与批准记录、状态迁移属于同一个临界区；每个文件都原子写入。
 *
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

/**
 * 扫描 `.cw/tasks`，返回状态命中给定集合的任务 id（目录名），升序排列；
 * 账本不存在时返回空数组，id 非法或状态读不出来的目录按「不可管理」跳过。
 *
 * All task directories whose state has one of the given statuses, sorted by id.
 */
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

/**
 * 某会话仍可继续操作的活跃任务：状态为 `approved` 或 `running`，且会话已登记在 `sessions` 里；
 * 同样跳过读不出来的目录、升序返回。
 *
 * Active tasks for a session: status `approved`/`running` with the session registered.
 */
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

/**
 * 文件级操作的公共外壳：在任务锁内解析出权威任务目录再交给回调，保证所有调用者取锁与解析目录的顺序一致。
 *
 * Shared shell for file-level operations: resolves the authority task directory
 * inside the task lock and hands it to the callback, so every caller takes the
 * lock and resolves the directory in the same order.
 */
async function taskFileLocked<T>(
  repo: string, taskId: string, session: string, body: (dir: string) => Promise<T>,
): Promise<T> {
  return withTaskLock(repo, taskId, session, async () => body(await existingTaskDir(repo, taskId)));
}

/**
 * 记录模型的 `report_blocked` 上报（原因、待解问题、会话、时间）到 `blocked.json`，
 * 供下一次门禁决策读取；再次上报会整体覆盖。
 *
 * Record the model's `report_blocked` report for the next gate decision.
 */
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
 * 待处理的 `report_blocked` 记录；没有则返回 null。记录存在但损坏时抛错——读不出来的阻塞上报绝不能被门禁静默忽略。
 *
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

/**
 * 门禁把阻塞上报转成回交材料之后，删除 `blocked.json`（本就不存在也算成功）；删除前先拒绝符号链接。
 *
 * Remove the block record once the gate has turned it into handback material.
 */
export async function clearBlocked(repo: string, taskId: string, session: string): Promise<void> {
  await taskFileLocked(repo, taskId, session, async (dir) => {
    await rejectUnexpected(path.join(dir, "blocked.json"), "blocked.json");
    await rm(path.join(dir, "blocked.json"), { force: true });
  });
}

/**
 * 新提议的输入字段；`n`、`session`、`created_at` 由 `writeProposal` 补齐，`status` 由调用方决定。
 *
 * Input fields of a new proposal; `n`, `session`, and `created_at` are filled in
 * by `writeProposal` and `status` is the caller's decision.
 */
export interface ProposalInput {
  field: string;
  new_value: string;
  reason: string;
  status: ProposalStatus;
}

/**
 * 在任务锁内追加一条契约变更提议：编号取 `proposals/` 里已有编号的最大值加一（从 1 起），
 * 原子写入 `proposals/<n>.json`。
 *
 * Append a contract-change proposal as `proposals/<max+1>.json` under the task lock.
 */
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
 * 仍然阻塞自主工作的那条提议：`pending` 等人工裁决，`approved` 等 M6 重生成契约并重跑先红检查
 * （只有契约真的采纳了改动，批准才会消费它，见 `writeApproval`），`rejected` 与 `consumed` 放行。
 *
 * 取的是排序后最后一条（提议按文件名字典序排，编号进入两位数后与数值序不再一致）。
 *
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
