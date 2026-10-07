/**
 * 验证器运行器：在任务锁内占用一个 run 目录，把验证器命令跑成以自己为组长的独立进程组，
 * 运行前后对工作树与验收输入取快照，落盘 `run.json`，并只在结果未被作废时发布 `last_verified`。
 *
 * Validator runner: claims a run directory under the task lock, runs the
 * validator command as its own detached process group, snapshots the worktree
 * and the acceptance inputs before and after, persists `run.json`, and
 * publishes `last_verified` only for a result that was never discarded.
 * Undetermined — timeout, cancel, terminating signal, runner or record error —
 * is never promoted to a pass.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { contractSha256 } from "./contract.js";
import type { GateFailure } from "./gate.js";
import { contentSha256, judgeEvidence, validatorInputFiles, type ResultReport, type Verdict } from "./evidence.js";
import { treeHash } from "./gitstate.js";
import { isNotFound } from "./paths.js";
import { assertRunRecord, writeRunRecord, type RunRecord } from "./runrecord.js";
import { recordTaskEvent } from "./meter.js";
import { readState, runsDir, withTaskLock, writeState } from "./task.js";
import type { Contract, GitValue, LastVerified, ValidatorConfig } from "./types.js";
import { readFile } from "node:fs/promises";

/** SIGTERM 后留给进程组的退出宽限期，超时才升级为 SIGKILL。 / Grace period after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** 等待整个进程组消失时的轮询间隔 / Poll interval while waiting for the whole group to exit. */
const GROUP_POLL_MS = 50;

/**
 * 一次验证器运行所需的全部输入：账本根、实际运行的工作树、任务与会话身份、契约、验证器配置，
 * 以及批准时冻结的输入哈希和取消信号。
 *
 * Everything one validator run needs: the ledger root, the tree the command
 * actually runs in, the task and session identity, the contract, the validator
 * config, the hashes frozen at approval, and a cancellation signal. `repo` is
 * the authoritative ledger root even when the session runs somewhere else.
 */
export interface RunRequest {
  repo: string;
  /**
   * 验证器实际运行并参与快照哈希的工作树；缺省等于 `repo`。
   *
   * The working tree the validator runs in and snapshots hash (M7). Defaults
   * to `repo`; differs only for a session inside an escalation worktree,
   * while `repo` stays the authoritative ledger root.
   */
  workRoot?: string;
  taskId: string;
  session: string;
  contract: Contract;
  validator: ValidatorConfig;
  /** 批准时决定的契约基线输入内容哈希 / Content hashes of the contract's baseline inputs, set at approval. */
  approvedInputHashes: Record<string, string>;
  /**
   * 批准时冻结的验证器输入哈希：验证器 cmd 引用到的仓库文件（通常是它的脚本，往往位于 `.cw/` 下，
   * 树哈希看不见那里的漂移）；与基线输入并列，每次运行前后各快照一次，漂移即作废本次结果。
   *
   * Approved content hashes of the repo files the validator cmd references
   * (`approval.validator_inputs_sha256`). Snapshotted before/after every run
   * next to the baseline inputs; drift discards the result.
   */
  approvedValidatorInputs: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * 一次验证器运行的结果：run 号与目录、已落盘的运行记录、门禁判定、已发布的证据锚点，以及
 * 未通过的必需检查。
 *
 * The result of one validator run: the run number and directory, the persisted
 * record, the gate verdict, the evidence anchor this run published (if any),
 * and the required checks that did not pass.
 */
export interface RunOutcome {
  run: number;
  dir: string;
  record: RunRecord;
  /**
   * 门禁判定；作废、取消、超时与信号终止一律是 `undetermined`。
   *
   * Gate verdict; a discarded run, a cancel, a timeout, and a terminating
   * signal all degrade to `undetermined`.
   */
  verdict: Verdict;
  /** 本次运行发布的证据锚点；被取消或未通过时为 null。 / Anchor this run published; null when cancelled or failing. */
  lastVerified: LastVerified | null;
  /** 未通过的必需检查，供门禁的继续消息使用。 / Required checks that did not pass, for the gate's continue message. */
  failures: GateFailure[];
}

/**
 * 在任务锁内执行一次完整验证器运行：抢占 run 目录、跑命令、运行前后快照、落盘 `run.json`、
 * 判定证据，并据此发布或撤销 `last_verified`。
 *
 * Runs one full validator run under the task lock: claims the run directory,
 * spawns the command, snapshots the tree and inputs before and after, writes
 * `run.json`, judges the evidence, and then publishes or revokes
 * `last_verified`.
 *
 * @param request - 本次运行的输入：账本根、实际工作树、任务与会话身份、契约、验证器与批准哈希。
 * @returns 运行号与目录、已落盘的记录、门禁判定、可选证据锚点、未通过的必需检查。
 * @remarks
 * 副作用：写 run 目录（`stdout.log`、`stderr.log`、`run.json`）、可能改写 `state.json` 的证据锚点、
 * 追加计量事件。取消只要在发布之前到达就作废本次结果——包括裁决过程中，以及状态写入与原子重命名
 * 之间——并只撤销本次 run 的锚点。失败方向保守：任何不确定都不会判成 pass，而且本函数返回时
 * 验证器的进程组一定已经被回收。
 *
 * Side effects: the run directory, a possible `state.json` rewrite, and meter
 * events. A cancel landing before publication discards the result and revokes
 * exactly this run's anchor; uncertainty never turns into a pass, and the
 * validator's process group is always reclaimed before this promise settles.
 */
export async function runValidator(request: RunRequest): Promise<RunOutcome> {
  return withTaskLock(request.repo, request.taskId, request.session, async () => {
    const work = request.workRoot ?? request.repo;
    const dir = await claimRun(request.repo, request.taskId);
    const run = Number(path.basename(dir));
    const started = new Date().toISOString();
    await recordTaskEvent(request.repo, request.taskId, request.session, "validation_started", { run });
    // The approved input set covers the contract's baseline inputs plus the
    // repo files the validator cmd references (its script, often under `.cw/`
    // where the tree hash cannot see drift).
    const validatorInputs = await validatorInputFiles(work, request.validator.cmd);
    const inputFiles = [...new Set([...request.contract.baseline_inputs, ...validatorInputs])];
    const approvedInputs = { ...request.approvedInputHashes, ...request.approvedValidatorInputs };
    const before = await snapshot(work, inputFiles);
    const outcome = await runValidatorProcess({
      cwd: work,
      cmd: request.validator.cmd,
      env: {
        ...process.env,
        ...request.validator.env,
        CW_TASK_ID: request.taskId,
        CW_RESULT_DIR: dir,
        CW_RUN_ID: String(run),
        CW_REQUIRED_IDS: requiredIds(request.contract),
      },
      timeoutMs: request.validator.timeout_s * 1000,
      stdoutPath: path.join(dir, "stdout.log"),
      stderrPath: path.join(dir, "stderr.log"),
      signal: request.signal,
    });
    try {
      const after = await snapshot(work, inputFiles);
      const discard = discardReason(outcome);
      const artifacts = discard !== null ? { hashes: emptyHashes(), error: null } : await artifactHashes(work, dir);
      const recordError = [before.error, after.error, artifacts.error]
        .filter((item): item is string => item !== null)
        .join("; ") || null;
      let record: RunRecord = {
        version: 1,
        run,
        started_at: started,
        ended_at: new Date().toISOString(),
        exit_code: outcome.exitCode,
        term_signal: outcome.signal,
        timed_out: outcome.timedOut,
        cancelled: outcome.cancelled,
        result_discarded: discard !== null,
        runner_error: outcome.runnerError,
        record_error: recordError,
        git: before.git,
        tree_before: before.tree,
        tree_after: after.tree,
        input_hashes_before: before.inputs,
        input_hashes_after: after.inputs,
        artifact_hashes: artifacts.hashes,
      };
      await writeRunRecord(path.join(dir, "run.json"), record);
      let verdict: Verdict;
      if (discard !== null) {
        verdict = { conclusion: "undetermined", reasons: [discard] };
      } else {
        verdict = await judgeEvidence(work, dir, request.contract, approvedInputs, inputFiles);
      }
      // A cancel that arrives while the verdict is being judged still discards
      // the result: no last_verified may be published after cancellation.
      // `outcome.cancelled` stays live until dispose, so this covers cancels
      // landing after the validator exited but before publication.
      if (discard === null && outcome.cancelled) {
        verdict = { conclusion: "undetermined", reasons: ["cancelled"] };
        record = { ...record, cancelled: true, result_discarded: true, artifact_hashes: emptyHashes() };
        await writeRunRecord(path.join(dir, "run.json"), record);
      }
      let lastVerified: LastVerified | null = null;
      if (verdict.conclusion === "pass" && !outcome.cancelled) {
        lastVerified = await recordVerification(request, run, record, verdict, outcome);
        if (lastVerified !== null && outcome.cancelled) {
          // The cancel landed between the pre-write check and the atomic
          // rename (or just after it): revoke exactly this run's record. An
          // older verification belonging to another run is left untouched.
          // The task lock is already held by runValidator, so the revocation
          // must not take it again.
          await revokeRunVerification(request.repo, request.taskId, request.session, run);
          lastVerified = null;
          verdict = { conclusion: "undetermined", reasons: ["cancelled"] };
          record = { ...record, cancelled: true, result_discarded: true, artifact_hashes: emptyHashes() };
          await writeRunRecord(path.join(dir, "run.json"), record);
        }
        if (lastVerified === null && outcome.cancelled) {
          verdict = { conclusion: "undetermined", reasons: ["cancelled"] };
          record = { ...record, cancelled: true, result_discarded: true, artifact_hashes: emptyHashes() };
          await writeRunRecord(path.join(dir, "run.json"), record);
        }
      }
      const failures = verdict.conclusion === "fail" ? await failureChecks(dir, request.contract) : [];
      await recordTaskEvent(request.repo, request.taskId, request.session, "validation_finished", {
        run,
        conclusion: verdict.conclusion,
        timed_out: outcome.timedOut,
        cancelled: outcome.cancelled,
      });
      return { run, dir, record, verdict, lastVerified, failures };
    } finally {
      outcome.dispose();
    }
  });
}

/**
 * 一次验证器进程运行的结果：退出码、终止信号、超时与取消标志、启动错误，以及释放信号监听的句柄。
 *
 * One validator process run: exit code, terminal signal, timeout and cancel
 * flags, a launch error, and the handle that releases the parent-signal
 * listener.
 */
export interface ProcessRun {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /**
   * 是否被取消；在 `dispose` 之前保持实时跟踪，因此也覆盖进程退出后才到达的取消。
   *
   * Live: stays true-tracking until `dispose` for cancels landing after exit.
   */
  readonly cancelled: boolean;
  /**
   * 进程从未真正启动时写入（spawn 失败或命令为空）。
   *
   * Set when the process never started (spawn failure or empty command).
   */
  runnerError: string | null;
  /**
   * 调用方不再读取 `cancelled` 之后，释放父信号监听。
   *
   * Release the parent-signal listener once the caller stops reading `cancelled`.
   */
  dispose(): void;
}

/**
 * 把一条验证器命令跑成以自己为组长的独立进程组；超时或调用方取消时先对整个进程组发 SIGTERM，
 * 宽限期过后升级为 SIGKILL，组内进程全部消失后本 Promise 才 resolve。
 *
 * Run one validator command detached as its own process-group leader inside
 * `cwd`, stdout/stderr into the given log files. Timeout or caller abort first
 * SIGTERMs the whole group, SIGKILL follows after the grace period; the
 * promise resolves only after every group member is gone, so no late result
 * can race the caller's judgment.
 *
 * @param options - 命令 argv、工作目录、环境、超时、stdout/stderr 日志路径与可选的取消信号。
 * @returns 退出码、终止信号、超时/取消标志、启动错误与释放信号监听的 `dispose`。
 * @remarks
 * 日志文件以 `wx` 打开，同名文件已存在即失败，避免覆盖别的 run 的证据。命令为空或 spawn 失败时
 * 不会留下任何进程：退出码为 null，原因写进 `runnerError`。信号一律发给整个进程组（`-pid`），
 * 而不是单个 pid，所以验证器派生的子进程不会在调用方开始裁决之后继续写结果。
 */
export async function runValidatorProcess(options: {
  cwd: string;
  cmd: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  signal?: AbortSignal;
}): Promise<ProcessRun> {
  const stdout = await open(options.stdoutPath, "wx");
  const stderr = await open(options.stderrPath, "wx");
  const abort = linkAbort(options.signal, options.timeoutMs);
  let child: ChildProcess | undefined;
  let watch: ChildWatch | undefined;
  let runnerError: string | null = null;
  try {
    if (!abort.signal.aborted && options.cmd.length > 0) {
      child = spawn(options.cmd[0]!, options.cmd.slice(1), {
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", stdout.fd, stderr.fd],
        env: options.env,
      });
      watch = watchChild(child);
    } else if (options.cmd.length === 0) {
      runnerError = "validator command empty";
    }
  } catch (error) {
    runnerError = error instanceof Error ? error.message : "validator failed to start";
  } finally {
    await stdout.close();
    await stderr.close();
  }
  const stop = watch ? await stopGroup(watch, abort) : { exitCode: null, signal: null };
  // The timeout is decided once the group is gone, but the parent-signal
  // listener must survive the return: a cancel landing while the caller
  // snapshots, judges, and publishes evidence has to stay visible through
  // `cancelled`. The caller releases the listener via `dispose` when it stops
  // reading it.
  abort.cancelTimer();
  const failure = runnerError ?? watch?.state.spawnError ?? null;
  return {
    exitCode: failure === null ? stop.exitCode : null,
    signal: stop.signal,
    timedOut: abort.timedOut,
    get cancelled() { return abort.cancelled; },
    runnerError: failure,
    dispose: () => abort.dispose(),
  };
}

/**
 * 本次结果是否必须作废，以及写进 run 记录、并直接当作判定理由的原因；返回 null 表示结果可用。
 *
 * Whether this run's result must be discarded, plus the reason written to the
 * run record and reused verbatim as the undetermined verdict reason; null
 * means the result is usable. The branch order is the contract: cancel beats
 * timeout, and timeout beats a terminating signal.
 */
function discardReason(
  outcome: { cancelled: boolean; timedOut: boolean; signal: string | null },
): string | null {
  if (outcome.cancelled) return "cancelled";
  if (outcome.timedOut) return "timed out";
  if (outcome.signal !== null) return `terminated by signal ${outcome.signal}`;
  return null;
}

/**
 * 尽力从 `result.json` 里恢复未通过的必需检查（acceptance 与未被批准豁免的 regression 中状态为
 * `fail` 或 `skip` 的项），供门禁的继续消息展示。
 *
 * Best-effort extraction of failed required checks for the gate's continue
 * message. The verdict itself is already judged by judgeEvidence; this only
 * recovers per-check `{id, message}` detail, degrading to an empty list when
 * the result file is unreadable or malformed.
 */
async function failureChecks(runDir: string, contract: Contract): Promise<GateFailure[]> {
  const approved = new Set(contract.approved_failures.map((item) => item.id));
  const required = new Set([...contract.acceptance, ...contract.regression.filter((id) => !approved.has(id))]);
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(runDir, "result.json"), "utf8"));
    const checks = (parsed as Pick<ResultReport, "checks">).checks;
    if (!Array.isArray(checks)) return [];
    return checks
      .filter((check) => check !== null && typeof check === "object"
        && typeof (check as { id?: unknown }).id === "string"
        && required.has((check as { id: string }).id)
        && ((check as { status?: unknown }).status === "fail" || (check as { status?: unknown }).status === "skip"))
      .map((check) => {
        const shaped = check as { id: string; message?: string };
        return { id: shaped.id, message: shaped.message ?? "" };
      });
  } catch {
    return [];
  }
}

/**
 * 返回一张无原型的空哈希表，避免 `__proto__` 这类键的赋值被当成原型赋值而丢掉哈希。
 *
 * Plain `{}` turns an assignment to the key `__proto__` into a prototype
 * assignment: no own property is created and the hash silently disappears
 * from run.json, so recheckArtifacts would never invalidate it.
 */
function emptyHashes(): Record<string, string | null> {
  return Object.create(null) as Record<string, string | null>;
}

/**
 * 占用任务的下一个 run 目录并返回其路径；调用方必须已持有任务锁，编号的互斥就靠这把锁。
 *
 * Claims the task's next run directory and returns its path. The caller must
 * already hold the task lock — that is what makes the numbering race-free.
 *
 * @param repo - 权威账本根 / Authoritative ledger root.
 * @param taskId - 任务 id / Task id.
 * @returns 新建 run 目录的绝对路径，目录名即 run 号 / Absolute path of the new run directory.
 * @throws 该编号目录已存在时抛错；已有 run 绝不被复用或覆盖 / When that numbered directory already exists.
 */
export async function claimRun(repo: string, taskId: string): Promise<string> {
  const runs = await runsDir(repo, taskId);
  const names = await readdir(runs);
  const used = names.map((name) => Number(name)).filter((value) => Number.isInteger(value) && value > 0);
  const next = (used.length === 0 ? 0 : Math.max(...used)) + 1;
  const dir = path.join(runs, String(next));
  try {
    await mkdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`run directory already exists ${next}`);
    }
    throw error;
  }
  return dir;
}

/**
 * 在已持有任务锁的前提下，把本次运行的证据锚点（run 号、运行后的树哈希、契约哈希）写进 `state.json`。
 *
 * Publishes this run's evidence anchor into `state.json` while the task lock is
 * already held, so the plain read/write pair is used and never the lock again.
 * Nothing is published unless the verdict passed and the record carries a git
 * tree, and a cancel that already landed returns null instead of writing.
 */
async function recordVerification(
  request: RunRequest, run: number, record: RunRecord, verdict: Verdict,
  abort: { cancelled: boolean },
): Promise<LastVerified | null> {
  if (verdict.conclusion !== "pass" || !record.git || record.tree_after === null) return null;
  const state = await readState(request.repo, request.taskId);
  if (abort.cancelled) return null;
  const verified: LastVerified = {
    run,
    tree: record.tree_after,
    contract_sha256: contractSha256(request.contract),
  };
  await writeState(request.repo, request.taskId, request.session, { ...state, last_verified: verified });
  return verified;
}

/**
 * 迟到的取消到达后，精确撤销本次 `run` 已发布的验证锚点（锚点为空或属于别的 run 则不动）。
 *
 * Revoke exactly `run`'s published verification after a late cancel. The
 * caller already holds the task lock (runValidator's body), so this uses the
 * plain read/write pair and must never take the lock again. An older
 * `last_verified` belonging to another run is left untouched.
 */
export async function revokeRunVerification(
  repo: string, taskId: string, session: string, run: number,
): Promise<void> {
  const state = await readState(repo, taskId);
  if (state.last_verified === null || state.last_verified.run !== run) return;
  await writeState(repo, taskId, session, {
    ...state,
    last_verified: null,
    evidence_invalid_reason: "cancelled",
  });
}

/**
 * 按结果报告里声明的产物路径重新取内容哈希，写进 run 记录，供日后 recheckArtifacts 比对。
 *
 * Re-hashes the artifact files the result report declares, reading their
 * content from `repo`. A missing `result.json` is not an error (nothing was
 * claimed); an unreadable report or a failed hash is folded into `error` so it
 * still reaches the run record and the verdict degrades to undetermined.
 */
async function artifactHashes(
  repo: string, runDir: string,
): Promise<{ hashes: Record<string, string | null>; error: string | null }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(runDir, "result.json"), "utf8"));
  } catch (error) {
    if (!isNotFound(error)) {
      return { hashes: {}, error: `result.json unreadable while hashing artifacts: ${errorMessage(error)}` };
    }
    return { hashes: {}, error: null };
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { artifacts?: unknown }).artifacts)) return { hashes: {}, error: null };
  const hashes = emptyHashes();
  let error: string | null = null;
  for (const artifact of (parsed as Pick<ResultReport, "artifacts">).artifacts ?? []) {
    if (artifact === null || typeof artifact !== "object" || typeof (artifact as { path?: unknown }).path !== "string") continue;
    const file = (artifact as { path: string }).path;
    try {
      hashes[file] = await contentSha256(repo, file);
    } catch (cause) {
      hashes[file] = null;
      error = appendError(error, `artifact hash failed ${file}: ${errorMessage(cause)}`);
    }
  }
  return { hashes, error };
}

/**
 * 取一次快照：工作树的 git tree 哈希加上每个输入文件的 sha256；失败只记进 `error`，不抛错。
 *
 * One snapshot: the git tree hash plus a sha256 per input. Hash failures are
 * recorded in `error` (the affected entry becomes null) instead of thrown, so
 * the run record is always written and the drift is judged by the evidence
 * rules rather than crashing the runner. A non-git tree yields `git: false`
 * and a null tree.
 */
async function snapshot(
  repo: string, inputs: string[],
): Promise<{ git: boolean; tree: string | null; inputs: Record<string, string | null>; error: string | null }> {
  let error: string | null = null;
  let tree: GitValue<string> = { supported: false };
  try {
    tree = await treeHash(repo);
  } catch (cause) {
    error = appendError(error, `tree hash failed: ${errorMessage(cause)}`);
  }
  const hashes = emptyHashes();
  for (const input of inputs) {
    try {
      hashes[input] = await contentSha256(repo, input);
    } catch (cause) {
      hashes[input] = null;
      error = appendError(error, `input hash failed ${input}: ${errorMessage(cause)}`);
    }
  }
  return { git: tree.supported, tree: tree.supported ? tree.value : null, inputs: hashes, error };
}

function appendError(current: string | null, message: string): string {
  return current === null ? message : `${current}; ${message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unreadable";
}

function requiredIds(contract: Contract): string {
  return [...contract.acceptance, ...contract.regression].join("\n");
}

interface StopResult {
  exitCode: number | null;
  signal: string | null;
}

/**
 * 把调用方的取消信号与超时合成为一个信号，同时保留两种起因：`cancelled` 跟踪父信号，`timedOut`
 * 只跟踪定时器。
 *
 * Merges the caller's abort signal with a timeout into a single signal while
 * keeping the two causes distinguishable: `cancelled` tracks the parent signal
 * and stays live until `dispose`, `timedOut` tracks the timer. The timer is
 * cleared once the group is gone so a finished run is never marked as timed
 * out; the parent listener lives until `dispose` releases it.
 */
function linkAbort(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cancelled: boolean;
  timedOut: boolean;
  cancelTimer: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const state = { cancelled: parent?.aborted === true, timedOut: false };
  const onParent = () => {
    state.cancelled = true;
    controller.abort();
  };
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get cancelled() { return state.cancelled; },
    get timedOut() { return state.timedOut; },
    cancelTimer() { clearTimeout(timer); },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

/**
 * 子进程早期的生命周期状态；`leader` 在 `spawn`、`error`、`exit` 中先到的那个事件上完成，值为 pid。
 *
 * Early child lifecycle state. `leader` settles on whichever of `spawn`,
 * `error`, or `exit` fires first — the value is the child pid — so a caller
 * that awaits it can never miss an event that already happened.
 */
interface ChildWatch {
  leader: Promise<number | undefined>;
  state: { exited: boolean; code: number | null; signal: string | null; spawned: boolean; spawnError: string | null };
}

/**
 * spawn 之后立刻同步挂上生命周期监听：父进程先关日志句柄，监听若等到 stopGroup 里才挂就会漏事件。
 *
 * Attach lifecycle listeners synchronously right after spawn. The parent closes
 * the log-file handles before awaiting anything else; a listener attached only
 * inside stopGroup could miss the `spawn` or `exit` event entirely. An `error`
 * before `spawn` is the async spawn failure (e.g. ENOENT): its message is
 * captured for the run record instead of degrading to a bare exit code.
 */
function watchChild(child: ChildProcess): ChildWatch {
  const state = {
    exited: false, code: null as number | null, signal: null as string | null,
    spawned: false, spawnError: null as string | null,
  };
  let resolveLeader!: (pid: number | undefined) => void;
  const leader = new Promise<number | undefined>((resolve) => { resolveLeader = resolve; });
  child.once("spawn", () => {
    state.spawned = true;
    resolveLeader(child.pid);
  });
  child.once("error", (error: Error) => {
    if (!state.spawned) state.spawnError = error.message;
    resolveLeader(child.pid);
  });
  child.once("exit", (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
    resolveLeader(child.pid);
  });
  return { leader, state };
}

/**
 * 先等出组长的 pid，然后一直等到整个进程组消失：取消或超时一到就对 `-pid` 发 SIGTERM，宽限期
 * 过后补 SIGKILL。
 *
 * Waits for the leader pid, then blocks until the whole process group is gone.
 * An aborted signal — caller cancel or timeout — SIGTERMs `-pid` at once and
 * follows with SIGKILL after the grace period, so a validator that spawned
 * helpers cannot leave grandchildren writing into the run directory while the
 * caller starts judging. Polling stands in for the missing portable "group
 * exited" notification; when spawn never produced a pid, the recorded exit
 * state is returned with exit code 1 as the fallback.
 */
async function stopGroup(watch: ChildWatch, abort: { signal: AbortSignal }): Promise<StopResult> {
  const leader = await watch.leader;
  if (leader === undefined) return { exitCode: watch.state.code ?? 1, signal: watch.state.signal };
  let termSent = false;
  let killSent = false;
  let killAt = 0;
  const arm = () => {
    if (termSent) return;
    termSent = true;
    killAt = Date.now() + KILL_GRACE_MS;
    signalGroup(leader, "SIGTERM");
  };
  if (abort.signal.aborted) arm();
  else abort.signal.addEventListener("abort", arm, { once: true });
  while (!watch.state.exited || groupAlive(leader)) {
    if (abort.signal.aborted) arm();
    if (termSent && !killSent && Date.now() >= killAt) {
      killSent = true;
      signalGroup(leader, "SIGKILL");
    }
    await delay(GROUP_POLL_MS);
  }
  abort.signal.removeEventListener("abort", arm);
  return { exitCode: watch.state.code, signal: watch.state.signal };
}

/**
 * 向整个进程组（`-pid`）发送信号；组已经不在了就静默忽略。
 *
 * Signals the whole process group via `-pid`. ESRCH and EPERM both mean the
 * group is gone — macOS reports EPERM for an already-exited group — and are
 * swallowed because this runs from an abort listener, where a throw would
 * surface as an uncaught exception. Other errors propagate.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    // The group belongs to this process's own detached child, so a same-uid
    // live group cannot refuse the signal. macOS reports EPERM instead of
    // ESRCH for an already-exited group; both mean it is gone. Throwing here
    // would surface as an uncaught exception from the abort listener.
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

/**
 * 进程组里是否还有活着的进程：ESRCH 说明组已消失；EPERM 说明探测被拒、无法证明组已消失，于是按
 * "仍活着"处理；其他错误向上抛。
 *
 * Whether the process group still has a live member: ESRCH means it is gone,
 * EPERM means the probe was refused and nothing proves it is gone — treated as
 * alive — and other errors propagate.
 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
