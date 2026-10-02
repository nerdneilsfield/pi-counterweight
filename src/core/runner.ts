import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { contractSha256 } from "./contract.js";
import type { GateFailure } from "./gate.js";
import { contentSha256, judgeEvidence, type ResultReport, type Verdict } from "./evidence.js";
import { treeHash } from "./gitstate.js";
import { isNotFound } from "./paths.js";
import { assertRunRecord, writeRunRecord, type RunRecord } from "./runrecord.js";
import { readState, runsDir, withTaskLock, writeState } from "./task.js";
import type { Contract, GitValue, LastVerified, ValidatorConfig } from "./types.js";
import { readFile } from "node:fs/promises";

const KILL_GRACE_MS = 5_000;
const GROUP_POLL_MS = 50;

export interface RunRequest {
  repo: string;
  taskId: string;
  session: string;
  contract: Contract;
  validator: ValidatorConfig;
  approvedInputHashes: Record<string, string>;
  signal?: AbortSignal;
}

export interface RunOutcome {
  run: number;
  dir: string;
  record: RunRecord;
  verdict: Verdict;
  lastVerified: LastVerified | null;
  /** Required checks that did not pass, for the gate's continue message. */
  failures: GateFailure[];
}

export async function runValidator(request: RunRequest): Promise<RunOutcome> {
  return withTaskLock(request.repo, request.taskId, request.session, async () => {
    const dir = await claimRun(request.repo, request.taskId);
    const run = Number(path.basename(dir));
    const started = new Date().toISOString();
    const before = await snapshot(request.repo, request.contract.baseline_inputs);
    const outcome = await runValidatorProcess({
      cwd: request.repo,
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
      const after = await snapshot(request.repo, request.contract.baseline_inputs);
      const discard = discardReason(outcome);
      const artifacts = discard !== null ? { hashes: emptyHashes(), error: null } : await artifactHashes(request.repo, dir);
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
        verdict = await judgeEvidence(request.repo, dir, request.contract, request.approvedInputHashes);
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
      return { run, dir, record, verdict, lastVerified, failures };
    } finally {
      outcome.dispose();
    }
  });
}

export interface ProcessRun {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Live: stays true-tracking until `dispose` for cancels landing after exit. */
  readonly cancelled: boolean;
  /** Set when the process never started (spawn failure or empty command). */
  runnerError: string | null;
  /** Release the parent-signal listener once the caller stops reading `cancelled`. */
  dispose(): void;
}

/**
 * Run one validator command detached as its own process-group leader inside
 * `cwd`, stdout/stderr into the given log files. Timeout or caller abort first
 * SIGTERMs the whole group, SIGKILL follows after the grace period; the
 * promise resolves only after every group member is gone, so no late result
 * can race the caller's judgment.
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
  return {
    exitCode: runnerError === null ? stop.exitCode : null,
    signal: stop.signal,
    timedOut: abort.timedOut,
    get cancelled() { return abort.cancelled; },
    runnerError,
    dispose: () => abort.dispose(),
  };
}

function discardReason(
  outcome: { cancelled: boolean; timedOut: boolean; signal: string | null },
): string | null {
  if (outcome.cancelled) return "cancelled";
  if (outcome.timedOut) return "timed out";
  if (outcome.signal !== null) return `terminated by signal ${outcome.signal}`;
  return null;
}

/**
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
 * Plain `{}` turns an assignment to the key `__proto__` into a prototype
 * assignment: no own property is created and the hash silently disappears
 * from run.json, so recheckArtifacts would never invalidate it.
 */
function emptyHashes(): Record<string, string | null> {
  return Object.create(null) as Record<string, string | null>;
}

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

interface ChildWatch {
  leader: Promise<number | undefined>;
  state: { exited: boolean; code: number | null; signal: string | null };
}

/**
 * Attach lifecycle listeners synchronously right after spawn. The parent closes
 * the log-file handles before awaiting anything else; a listener attached only
 * inside stopGroup could miss the `spawn` or `exit` event entirely.
 */
function watchChild(child: ChildProcess): ChildWatch {
  const state = { exited: false, code: null as number | null, signal: null as string | null };
  let resolveLeader!: (pid: number | undefined) => void;
  const leader = new Promise<number | undefined>((resolve) => { resolveLeader = resolve; });
  child.once("spawn", () => resolveLeader(child.pid));
  child.once("error", () => resolveLeader(undefined));
  child.once("exit", (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
    resolveLeader(child.pid);
  });
  return { leader, state };
}

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
