import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { contractSha256 } from "./contract.js";
import { contentSha256, judgeEvidence, type ResultReport, type Verdict } from "./evidence.js";
import { treeHash } from "./gitstate.js";
import { isNotFound } from "./paths.js";
import { assertRunRecord, writeRunRecord, type RunRecord } from "./runrecord.js";
import { readState, withTaskLock, writeState } from "./task.js";
import type { Contract, LastVerified, ValidatorConfig } from "./types.js";
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
}

export async function runValidator(request: RunRequest): Promise<RunOutcome> {
  return withTaskLock(request.repo, request.taskId, request.session, async () => {
    const dir = await claimRun(request.repo, request.taskId);
    const run = Number(path.basename(dir));
    const started = new Date().toISOString();
    const before = await snapshot(request.repo, request.contract.baseline_inputs);
    const stdout = await open(path.join(dir, "stdout.log"), "wx");
    const stderr = await open(path.join(dir, "stderr.log"), "wx");
    const abort = linkAbort(request.signal, request.validator.timeout_s * 1000);
    let child: ChildProcess | undefined;
    let watch: ChildWatch | undefined;
    let runnerError: string | null = null;
    try {
      if (!abort.signal.aborted && request.validator.cmd.length > 0) {
        child = spawn(request.validator.cmd[0]!, request.validator.cmd.slice(1), {
          cwd: request.repo,
          detached: true,
          stdio: ["ignore", stdout.fd, stderr.fd],
          env: {
            ...process.env,
            ...request.validator.env,
            CW_TASK_ID: request.taskId,
            CW_RESULT_DIR: dir,
            CW_RUN_ID: String(run),
            CW_REQUIRED_IDS: requiredIds(request.contract),
          },
        });
        watch = watchChild(child);
      } else if (request.validator.cmd.length === 0) {
        runnerError = "validator command empty";
      }
    } catch (error) {
      runnerError = error instanceof Error ? error.message : "validator failed to start";
    } finally {
      await stdout.close();
      await stderr.close();
    }
    const stop = watch ? await stopGroup(watch, abort) : { exitCode: null, signal: null };
    abort.dispose();
    const after = await snapshot(request.repo, request.contract.baseline_inputs);
    const discarded = abort.cancelled || abort.timedOut || stop.signal !== null;
    const record: RunRecord = {
      version: 1,
      run,
      started_at: started,
      ended_at: new Date().toISOString(),
      exit_code: stop.exitCode,
      term_signal: stop.signal,
      timed_out: abort.timedOut,
      cancelled: abort.cancelled,
      result_discarded: discarded,
      runner_error: runnerError,
      git: before.git,
      tree_before: before.tree,
      tree_after: after.tree,
      input_hashes_before: before.inputs,
      input_hashes_after: after.inputs,
      artifact_hashes: discarded ? {} : await artifactHashes(request.repo, dir),
    };
    await writeRunRecord(path.join(dir, "run.json"), record);
    const verdict = await judgeEvidence(request.repo, dir, request.contract, request.approvedInputHashes);
    const lastVerified = await recordVerification(request, run, record, verdict);
    return { run, dir, record, verdict, lastVerified };
  });
}

export async function claimRun(repo: string, taskId: string): Promise<string> {
  const runs = path.join(repo, ".cw", "tasks", taskId, "runs");
  await mkdir(runs, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
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
): Promise<LastVerified | null> {
  if (verdict.conclusion !== "pass" || !record.git || record.tree_after === null) return null;
  const verified: LastVerified = {
    run,
    tree: record.tree_after,
    contract_sha256: contractSha256(request.contract),
  };
  const state = await readState(request.repo, request.taskId);
  await writeState(request.repo, request.taskId, request.session, { ...state, last_verified: verified });
  return verified;
}

async function artifactHashes(repo: string, runDir: string): Promise<Record<string, string | null>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(runDir, "result.json"), "utf8"));
  } catch (error) {
    if (isNotFound(error)) return {};
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { artifacts?: unknown }).artifacts)) return {};
  const hashes: Record<string, string | null> = {};
  for (const artifact of (parsed as Pick<ResultReport, "artifacts">).artifacts ?? []) {
    if (artifact === null || typeof artifact !== "object" || typeof (artifact as { path?: unknown }).path !== "string") continue;
    const file = (artifact as { path: string }).path;
    hashes[file] = await contentSha256(repo, file);
  }
  return hashes;
}

async function snapshot(repo: string, inputs: string[]): Promise<{
  git: boolean;
  tree: string | null;
  inputs: Record<string, string | null>;
}> {
  const tree = await treeHash(repo);
  const hashes: Record<string, string | null> = {};
  for (const input of inputs) hashes[input] = await contentSha256(repo, input);
  return { git: tree.supported, tree: tree.supported ? tree.value : null, inputs: hashes };
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
    if (code !== "ESRCH") throw error;
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
