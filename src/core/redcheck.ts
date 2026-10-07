/**
 * 先红检查：在 `base_commit` 上建一个隔离 worktree，把当前工作树里基线验收输入的内容覆盖进去，
 * 在那里跑同一个验证器，并独立判定"修复之前基线确实是红的"。
 *
 * The red check: builds an isolated worktree at `base_commit`, overlays the
 * current worktree's acceptance-input content into it, runs the same validator
 * there, and judges independently that the baseline was still red before the
 * fix. Isolation is the point — a half-done current worktree must not be able
 * to mask a red baseline — and nothing here ever publishes `last_verified`.
 */
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentSha256, judgeEvidence, type ResultReport } from "./evidence.js";
import { commitExists, isGitRepo, treeHash, worktreeAdd, worktreePrune } from "./gitstate.js";
import { recordTaskEvent } from "./meter.js";
import { isNotFound, pathInside } from "./paths.js";
import { claimRun, runValidatorProcess } from "./runner.js";
import { writeRunRecord, type RunRecord } from "./runrecord.js";
import { withTaskLock } from "./task.js";
import type { Contract, ValidatorConfig } from "./types.js";

/**
 * 先红检查根本无法进行：验收输入无法与当前实现隔离，于是直接拒绝批准，而不是拿半成品工作树去判。
 *
 * The red check cannot run at all: the acceptance inputs cannot be isolated
 * from the current implementation, so the approval is refused instead of
 * checking on the current half-done worktree.
 */
export class CannotIsolateError extends Error {}

/**
 * 一次先红检查的输入：权威账本根、任务与会话身份、契约、验证器配置，以及作为基线的提交。
 *
 * Inputs of one red check: the authoritative ledger root, the task and session
 * identity, the contract, the validator config, and the commit the isolated
 * baseline is built from.
 */
export interface RedCheckRequest {
  repo: string;
  taskId: string;
  session: string;
  contract: Contract;
  validator: ValidatorConfig;
  baseCommit: string;
  signal?: AbortSignal;
}

/**
 * 单个先红项的失败明细：检查 id、报告给出的状态与消息，用于用户确认对话框。
 *
 * Failure detail of one red item: its check id, the status the report gave it,
 * and its message.
 */
export interface RedFailure {
  id: string;
  status: string;
  message: string;
}

/**
 * 一次先红检查的结果：账本里的 run 号与目录、运行记录、有效性判定、独立先红判定与失败明细。
 *
 * The outcome of one red check: the run number and directory in the
 * authoritative ledger, the record, the validity verdict, the independent red
 * judgment, and the per-item failure detail. Nothing here publishes
 * `last_verified`.
 */
export interface RedCheckOutcome {
  run: number;
  runDir: string;
  record: RunRecord;
  /** 本次运行与报告是否有效；false 直接拒绝批准。 / Run + report validity; false refuses the approval outright. */
  valid: boolean;
  /** 判定为无效的原因；有效时为空数组。 / Reasons it is invalid; empty when valid. */
  validityReasons: string[];
  /**
   * 在有效报告之上做出的独立先红判定（见 `judgeRedBaseline`）。
   *
   * Independent red judgment over a valid report (see `judgeRedBaseline`).
   */
  red: { ok: boolean; reasons: string[] };
  /**
   * 每个先红项的失败明细，显示在用户确认对话框里。
   *
   * Per-red-item failure detail, shown in the user confirmation dialog.
   */
  redFailures: RedFailure[];
  /** 覆盖进基线的规范验收输入文件。 / Canonical baseline input files overlaid onto the baseline. */
  baselineInputs: string[];
  /** 从当前工作树取到的输入内容哈希。 / Content hashes of the inputs as snapshotted from the current worktree. */
  inputHashes: Record<string, string>;
}

/**
 * 独立先红判定结果：`ok` 为真表示基线确实为红，且原因列表为空。
 *
 * The independent red judgment; `ok` is true only for a truly red baseline,
 * with `reasons` empty.
 */
export interface RedJudgment {
  ok: boolean;
  reasons: string[];
}

/**
 * 对一份已判定为有效的报告做独立的先红判定：每个 `red` 项必须恰好出现一次且状态恰为 `fail`，
 * 其余验收项与未被豁免的回归项必须 `pass`，被豁免的 regression 项必须出现但允许失败。
 *
 * Independent red judgment over an already-valid report. Each `red` id must
 * exist exactly once with status exactly `fail`; every other acceptance id and
 * every non-exempt regression id must be `pass`. Exempt (approved-failure)
 * regression ids must appear in the report but may fail. A generic `fail`
 * verdict from the evidence judge never implies a successful red check.
 *
 * @param contract - 任务契约，提供 `red`、`acceptance`、`regression`、`approved_failures` 四个集合。
 * @param result - 验证器写出的结果报告 / The result report the validator produced.
 * @returns `ok` 与去重后的原因列表；只有原因列表为空才算先红成立。
 * @remarks
 * 纯函数：不读写文件、不取锁。判定方向保守——重复 id、先红项缺失或未以失败执行、必需项未通过，
 * 都会让先红不成立。
 *
 * Pure: reads no files and takes no lock. The judgment is conservative, so
 * only an empty reason list confirms red.
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

/**
 * 按契约里 `red` 的顺序收集各先红项的失败明细，供确认对话框展示；报告里没提到的项直接跳过。
 *
 * Collects the per-red-item failure detail in the contract's `red` order for
 * the confirmation dialog, skipping red ids the report never mentioned.
 */
function collectRedFailures(contract: Contract, result: ResultReport): RedFailure[] {
  const byId = new Map(result.checks.map((check) => [check.id, check]));
  return contract.red.flatMap((id) => {
    const check = byId.get(id);
    return check === undefined ? [] : [{ id, status: check.status, message: check.message ?? "" }];
  });
}

/**
 * 对原始基线执行契约先红检查：在 `baseCommit` 处建一个 detached worktree，只把当前工作树的
 * `baseline_inputs` 内容覆盖进去，在那里运行验证器，并把这次运行记进权威任务账本。
 *
 * Contract red check against the original baseline: a detached worktree at
 * `baseCommit` receives the current worktree's `baseline_inputs` content and
 * nothing else, the validator runs there, and the run is recorded in the
 * authoritative task ledger. The current worktree is never touched and never
 * publishes `last_verified`. Every path cleans up the baseline directory and
 * the worktree metadata; a validator that times out or is aborted has its
 * whole process group terminated before this promise settles.
 *
 * @param request - 本次先红检查的输入：任务与会话身份、作为基线的提交、契约、验证器与取消信号。
 * @returns 账本里的 run 号与目录、运行记录、有效性判定、独立先红判定与先红失败明细。
 * @throws CannotIsolateError - 契约 task_id 与任务不符、仓库不是 git 仓库、`base_commit` 不存在，
 * 或某个基线验收输入在当前工作树里缺失时抛出；这些情况都拒绝批准，而不是勉强就地检查。
 * @remarks
 * 之所以要隔离：当前工作树通常已经改到一半，直接在它上面判"修复前是否为红"会被未完成的改动掩盖。
 * 基线 worktree 里只有提交时的代码，再叠上当前工作树的验收输入，判定才落在同一份验收标准上。
 * 前置校验（git 仓库、提交存在、输入可读）在取锁之前完成，取锁之后才占 run 号并运行验证器。
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
    await recordTaskEvent(request.repo, request.taskId, request.session, "validation_started", { run });
    const root = await mkdtemp(path.join(tmpdir(), "cw-red-"));
    const baseline = path.join(root, "baseline");
    try {
      await worktreeAdd(request.repo, baseline, request.baseCommit);
      await overlayInputs(request.repo, baseline, inputs);
      const before = await snapshotBaseline(baseline, inputs, wanted);
      const processRun = runValidatorProcess({
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
      try {
        const outcome = await processRun;
        const after = await snapshotBaseline(baseline, inputs, wanted);
        let record: RunRecord = {
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
        let valid = verdict.conclusion !== "undetermined";
        let validityReasons: string[] = valid ? [] : verdict.reasons;
        if (valid && outcome.cancelled) {
          // The cancel landed after the validator exited but before this
          // run could become the basis of an approval: discard it.
          record = { ...record, cancelled: true, result_discarded: true };
          await writeRunRecord(path.join(runDir, "run.json"), record);
          valid = false;
          validityReasons = ["cancelled"];
        }
        const result = await readResult(runDir);
        const red = valid && result !== null
          ? judgeRedBaseline(request.contract, result)
          : { ok: false, reasons: [] };
        await recordTaskEvent(request.repo, request.taskId, request.session, "validation_finished", {
          run,
          conclusion: valid ? (red.ok ? "red-confirmed" : "red-refused") : "undetermined",
        });
        return {
          run,
          runDir,
          record,
          valid,
          validityReasons,
          red,
          redFailures: result === null ? [] : collectRedFailures(request.contract, result),
          baselineInputs: [...inputs],
          inputHashes: Object.fromEntries(wanted),
        };
      } finally {
        (await processRun).dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      // The baseline directory is gone; drop the worktree metadata entry.
      await worktreePrune(request.repo);
    }
  });
}

/**
 * 把每个输入在当前工作树里的内容复制进隔离基线；所有目标路径与每一级祖先都在写入之前校验完毕。
 *
 * Copy the current worktree content of every input into the baseline. All
 * targets and every ancestor component are validated BEFORE anything is
 * written: a symlinked ancestor (pointing anywhere, in or out of the
 * baseline), a non-directory ancestor, an escaping path, or a non-file target
 * rejects the whole overlay — no partial writes leave the baseline, not even
 * when the approval is refused afterwards. Shared with the M7 escalation,
 * which restores the same approved inputs into the escalation worktree.
 *
 * @param repo - 读取输入内容的源工作树 / Source worktree the content is read from.
 * @param baseline - 接收覆盖的隔离基线目录 / Isolated baseline directory that receives the overlay.
 * @param inputs - 仓库相对路径的验收输入 / Repo-relative acceptance inputs.
 * @throws CannotIsolateError - 任一路径落在符号链接、非目录祖先、解析后逃出基线的路径或非普通文件上时抛出。
 * @remarks
 * 先整轮校验、再统一写入：拒绝时基线保持原样，避免半截覆盖被当成真基线继续判定。这同时是一条信任
 * 边界——符号链接祖先无论指向基线内外都拒绝，防止写入落到隔离目录之外。
 */
export async function overlayInputs(repo: string, baseline: string, inputs: string[]): Promise<void> {
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

/**
 * 给隔离基线拍一次快照：git tree 哈希加上每个输入的 sha256，并逐项与覆盖前的期望哈希比对。
 *
 * Snapshots the isolated baseline: the git tree hash plus a sha256 per input,
 * each compared against the hash taken from the current worktree. Problems are
 * collected into `error` instead of thrown, so the run record is still written
 * and the evidence rules get to judge the mismatch.
 *
 * @param baseline - 要快照的隔离基线目录 / Isolated baseline directory being snapshotted.
 * @param inputs - 本次覆盖的验收输入 / Acceptance inputs that were overlaid.
 * @param wanted - 覆盖前从当前工作树取到的期望内容哈希 / Expected hashes taken from the current worktree.
 * @returns 快照时间、树哈希、逐输入的哈希与汇总错误 / Snapshot time, tree hash, per-input hashes, and errors.
 */
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

/**
 * 读并解析 run 目录里的 `result.json`；缺失或内容不是合法 JSON 时返回 null，降级方式交给调用方。
 *
 * Reads and parses `result.json` from the run directory; returns null when it
 * is missing or not valid JSON, leaving the degradation to the caller.
 */
async function readResult(runDir: string): Promise<ResultReport | null> {
  try {
    return JSON.parse(await readFile(path.join(runDir, "result.json"), "utf8")) as ResultReport;
  } catch {
    return null;
  }
}
