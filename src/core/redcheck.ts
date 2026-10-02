import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentSha256, judgeEvidence, type ResultReport } from "./evidence.js";
import { commitExists, isGitRepo, treeHash, worktreeAdd, worktreePrune } from "./gitstate.js";
import { isNotFound, pathInside } from "./paths.js";
import { claimRun, runValidatorProcess } from "./runner.js";
import { writeRunRecord, type RunRecord } from "./runrecord.js";
import { withTaskLock } from "./task.js";
import type { Contract, ValidatorConfig } from "./types.js";

/**
 * The red check cannot run at all: the acceptance inputs cannot be isolated
 * from the current implementation, so the approval is refused instead of
 * checking on the current half-done worktree.
 */
export class CannotIsolateError extends Error {}

export interface RedCheckRequest {
  repo: string;
  taskId: string;
  session: string;
  contract: Contract;
  validator: ValidatorConfig;
  baseCommit: string;
  signal?: AbortSignal;
}

export interface RedFailure {
  id: string;
  status: string;
  message: string;
}

export interface RedCheckOutcome {
  run: number;
  runDir: string;
  record: RunRecord;
  /** Run + report validity; false refuses the approval outright. */
  valid: boolean;
  validityReasons: string[];
  /** Independent red judgment over a valid report (see `judgeRedBaseline`). */
  red: { ok: boolean; reasons: string[] };
  /** Per-red-item failure detail, shown in the user confirmation dialog. */
  redFailures: RedFailure[];
  /** Canonical baseline input files overlaid onto the baseline. */
  baselineInputs: string[];
  /** Content hashes of the inputs as snapshotted from the current worktree. */
  inputHashes: Record<string, string>;
}

export interface RedJudgment {
  ok: boolean;
  reasons: string[];
}

/**
 * Independent red judgment over an already-valid report. Each `red` id must
 * exist exactly once with status exactly `fail`; every other acceptance id and
 * every non-exempt regression id must be `pass`. Exempt (approved-failure)
 * regression ids must appear in the report but may fail. A generic `fail`
 * verdict from the evidence judge never implies a successful red check.
 */
export function judgeRedBaseline(contract: Contract, result: ResultReport): RedJudgment {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const check of result.checks) {
    if (seen.has(check.id)) reasons.push(`报告存在重复 ID ${check.id}`);
    seen.add(check.id);
  }
  const byId = new Map(result.checks.map((check) => [check.id, check]));
  const approved = new Set(contract.approved_failures.map((item) => item.id));
  const red = new Set(contract.red);
  for (const id of contract.red) {
    const check = byId.get(id);
    if (check === undefined) {
      reasons.push(`先红项缺失 ${id}`);
      continue;
    }
    if (check.status !== "fail") reasons.push(`先红项未以失败执行 ${id}（${check.status}）`);
  }
  for (const id of contract.acceptance) {
    if (red.has(id)) continue;
    const check = byId.get(id);
    if (check === undefined || check.status !== "pass") {
      reasons.push(`非先红验收项未通过 ${id}（${check?.status ?? "缺失"}）`);
    }
  }
  for (const id of contract.regression) {
    if (approved.has(id)) continue;
    const check = byId.get(id);
    if (check === undefined || check.status !== "pass") {
      reasons.push(`回归项未通过 ${id}（${check?.status ?? "缺失"}）`);
    }
  }
  for (const id of approved) {
    if (!byId.has(id)) reasons.push(`存量失败未在报告中出现 ${id}`);
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function collectRedFailures(contract: Contract, result: ResultReport): RedFailure[] {
  const byId = new Map(result.checks.map((check) => [check.id, check]));
  return contract.red.flatMap((id) => {
    const check = byId.get(id);
    return check === undefined ? [] : [{ id, status: check.status, message: check.message ?? "" }];
  });
}

/**
 * Contract red check against the original baseline: a detached worktree at
 * `baseCommit` receives the current worktree's `baseline_inputs` content and
 * nothing else, the validator runs there, and the run is recorded in the
 * authoritative task ledger. The current worktree is never touched and never
 * publishes `last_verified`. Every path cleans up the baseline directory and
 * the worktree metadata; a validator that times out or is aborted has its
 * whole process group terminated before this promise settles.
 */
export async function runRedCheck(request: RedCheckRequest): Promise<RedCheckOutcome> {
  if (request.contract.task_id !== request.taskId) {
    throw new CannotIsolateError(`contract: task_id mismatch ${request.contract.task_id} ≠ ${request.taskId}`);
  }
  if (!await isGitRepo(request.repo)) {
    throw new CannotIsolateError("仓库不是 git 仓库，无法从 base_commit 建立隔离基线");
  }
  if (!await commitExists(request.repo, request.baseCommit)) {
    throw new CannotIsolateError(`base_commit 不存在或不是提交：${request.baseCommit}`);
  }
  const inputs = request.contract.baseline_inputs;
  const wanted = new Map<string, string>();
  for (const input of inputs) {
    const hash = await contentSha256(request.repo, input);
    if (hash === null) {
      throw new CannotIsolateError(`基线验收输入在当前工作树缺失，无法隔离：${input}`);
    }
    wanted.set(input, hash);
  }
  return withTaskLock(request.repo, request.taskId, request.session, async () => {
    const runDir = await claimRun(request.repo, request.taskId);
    const run = Number(path.basename(runDir));
    const root = await mkdtemp(path.join(tmpdir(), "cw-red-"));
    const baseline = path.join(root, "baseline");
    try {
      await worktreeAdd(request.repo, baseline, request.baseCommit);
      await overlayInputs(request.repo, baseline, inputs);
      const before = await snapshotBaseline(baseline, inputs, wanted);
      const outcome = await runValidatorProcess({
        cwd: baseline,
        cmd: request.validator.cmd,
        env: {
          ...process.env,
          ...request.validator.env,
          CW_TASK_ID: request.taskId,
          CW_RESULT_DIR: runDir,
          CW_RUN_ID: String(run),
          CW_REQUIRED_IDS: [...request.contract.acceptance, ...request.contract.regression].join("\n"),
        },
        timeoutMs: request.validator.timeout_s * 1000,
        stdoutPath: path.join(runDir, "stdout.log"),
        stderrPath: path.join(runDir, "stderr.log"),
        signal: request.signal,
      });
      const after = await snapshotBaseline(baseline, inputs, wanted);
      const record: RunRecord = {
        version: 1,
        run,
        started_at: before.time,
        ended_at: new Date().toISOString(),
        exit_code: outcome.exitCode,
        term_signal: outcome.signal,
        timed_out: outcome.timedOut,
        cancelled: outcome.cancelled,
        result_discarded: outcome.cancelled || outcome.timedOut || outcome.signal !== null,
        runner_error: outcome.runnerError,
        record_error: [before.error, after.error].filter((item) => item !== null).join("; ") || null,
        git: true,
        tree_before: before.tree,
        tree_after: after.tree,
        input_hashes_before: before.hashes,
        input_hashes_after: after.hashes,
        artifact_hashes: Object.create(null) as Record<string, string | null>,
      };
      await writeRunRecord(path.join(runDir, "run.json"), record);
      // Validity first: judged by the ordinary evidence rules against the
      // baseline directory (its tree, its artifact paths). Any undetermined
      // reason refuses the approval.
      const verdict = await judgeEvidence(baseline, runDir, request.contract, Object.fromEntries(wanted));
      const valid = verdict.conclusion !== "undetermined";
      const result = await readResult(runDir);
      const red = valid && result !== null
        ? judgeRedBaseline(request.contract, result)
        : { ok: false, reasons: [] };
      return {
        run,
        runDir,
        record,
        valid,
        validityReasons: valid ? [] : verdict.reasons,
        red,
        redFailures: result === null ? [] : collectRedFailures(request.contract, result),
        baselineInputs: [...inputs],
        inputHashes: Object.fromEntries(wanted),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
      // The baseline directory is gone; drop the worktree metadata entry.
      await worktreePrune(request.repo);
    }
  });
}

/**
 * Copy the current worktree content of every input into the baseline. All
 * targets and every ancestor component are validated BEFORE anything is
 * written: a symlinked ancestor (pointing anywhere, in or out of the
 * baseline), a non-directory ancestor, an escaping path, or a non-file target
 * rejects the whole overlay — no partial writes leave the baseline, not even
 * when the approval is refused afterwards.
 */
async function overlayInputs(repo: string, baseline: string, inputs: string[]): Promise<void> {
  const root = await realpath(baseline);
  for (const input of inputs) {
    const parts = input.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = path.join(baseline, ...parts.slice(0, index));
      let stat;
      try {
        stat = await lstat(prefix);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        continue; // Missing segment: created below (dirs) or written (target).
      }
      const walked = parts.slice(0, index).join("/");
      if (stat.isSymbolicLink()) {
        throw new CannotIsolateError(`隔离基线中存在符号链接路径，拒绝覆盖：${input}（${walked}）`);
      }
      if (index === parts.length) {
        if (!stat.isFile()) {
          throw new CannotIsolateError(`基线中同名路径不是普通文件，无法覆盖：${input}`);
        }
      } else if (!stat.isDirectory()) {
        throw new CannotIsolateError(`基线中祖先不是目录，无法覆盖：${input}（${walked}）`);
      }
      if (!pathInside(root, await realpath(prefix))) {
        throw new CannotIsolateError(`基线输入解析后逃逸隔离目录：${input}（${walked}）`);
      }
    }
  }
  for (const input of inputs) {
    const target = path.join(baseline, input);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(repo, input)));
  }
}

async function snapshotBaseline(
  baseline: string, inputs: string[], wanted: Map<string, string>,
): Promise<{ time: string; tree: string | null; hashes: Record<string, string | null>; error: string | null }> {
  const errors: string[] = [];
  let tree: string | null = null;
  try {
    const value = await treeHash(baseline);
    if (!value.supported) throw new Error("隔离基线不是 git 仓库");
    tree = value.value;
  } catch (cause) {
    errors.push(`隔离基线树哈希失败：${cause instanceof Error ? cause.message : "unreadable"}`);
  }
  const hashes: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const input of inputs) {
    const actual = await contentSha256(baseline, input);
    hashes[input] = actual;
    if (actual !== wanted.get(input)) {
      errors.push(`覆盖后内容与当前工作树快照不一致：${input}`);
    }
  }
  return { time: new Date().toISOString(), tree, hashes, error: errors.join("; ") || null };
}

async function readResult(runDir: string): Promise<ResultReport | null> {
  try {
    return JSON.parse(await readFile(path.join(runDir, "result.json"), "utf8")) as ResultReport;
  } catch {
    return null;
  }
}
