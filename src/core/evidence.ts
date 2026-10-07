/**
 * 证据判定：把一次验证落盘的 `run.json` / `result.json` 判成三态结论（pass / fail / undetermined），并核对 build 产物哈希。
 *
 * Evidence judging: turn a recorded run's `run.json` / `result.json` into a
 * three-state verdict (pass / fail / undetermined) and verify build artifact
 * hashes. The direction is fail-safe: anything uncertain (unreadable,
 * unparsable, drifted, incomplete) is `undetermined`, never a pass. Only
 * `recheckArtifacts` mutates state, invalidating evidence; everything else here
 * reads.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { isNotFound, pathInside, relativeParts } from "./paths.js";
import { rejectUnknown, ValidationError } from "./schema.js";
import { readState, runsDir, updateState } from "./task.js";
import type { Contract } from "./types.js";
import { assertRunRecord, type RunRecord } from "./runrecord.js";

/**
 * `result.json` 的协议形状（protocol 1）：验证器写、门禁读；各处都开了 `additionalProperties: false`，多写的字段与缺字段一样被拒。
 *
 * The wire shape of `result.json` (protocol 1), written by the validator and
 * read by the gate. `additionalProperties: false` throughout, so an unexpected
 * field is rejected exactly like a missing one.
 *
 * @remarks
 * 这里只管形状；必查 id 是否都被上报、build 证据是否自洽、哈希是否对得上，由 `judgeRecord` 判。
 *
 * Shape only: whether every required id is reported, the build evidence is
 * consistent, and the hashes match is decided by `judgeRecord`.
 */
const checkStatus = Type.Union([
  Type.Literal("pass"), Type.Literal("fail"), Type.Literal("skip"), Type.Literal("error"),
]);

const resultSchema = Type.Object({
  protocol: Type.Literal(1),
  run_id: Type.String({ minLength: 1 }),
  complete: Type.Boolean(),
  checks: Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    status: checkStatus,
    message: Type.Optional(Type.String()),
  }, { additionalProperties: false })),
  artifacts: Type.Optional(Type.Array(Type.Object({
    kind: Type.Literal("build"),
    path: Type.String({ minLength: 1 }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    loaded_by: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }, { additionalProperties: false }))),
  build: Type.Object({
    required: Type.Boolean(),
    fresh: Type.Optional(Type.Boolean()),
    load_verified: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  summary: Type.String(),
  logs: Type.Array(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

/**
 * 验证器上报的单条检查结果；`id` 会先查重，再与契约里的 acceptance / red / regression id 对照。
 *
 * One check as reported by the validator. Ids are deduplicated first, then
 * matched against the contract's acceptance, red, and regression lists.
 *
 * @remarks
 * 门禁对必查 id 的处理方向按状态分岔：`error` 是"无法判定"，而 `skip` 与 `fail` 都直接判失败：跳过必查项不算通过。
 *
 * The gate treats required ids differently by status: `error` is undetermined,
 * while `skip` and `fail` both count as a failure; skipping a required check is
 * never a pass.
 */
export interface CheckReport {
  id: string;
  /**
   * `error` 归为"无法判定"；必查项上的 `skip` 与 `fail` 一样算失败。
   *
   * `error` is undetermined; on a required id, `skip` fails just like `fail`.
   */
  status: "pass" | "fail" | "skip" | "error";
  message?: string;
}

/**
 * `result.json` 解析后的结果：要通过需要 `complete === true`、每个必查 id 都被上报，且 build 证据自洽。
 *
 * `result.json` after parsing. A pass needs `complete === true`, a report for
 * every required check id, and self-consistent build evidence.
 *
 * @remarks
 * 只有 `artifacts` 可选；`kind` 固定为 `build`、`sha256` 必须是 64 位十六进制，且每个产物的 `loaded_by`
 * 都必须是本次上报过的检查 id。
 *
 * Only `artifacts` is optional; its `kind` is always `build`, `sha256` is 64 hex
 * digits, and every id in `loaded_by` must be a check id reported in the same
 * result.
 */
export interface ResultReport {
  protocol: 1;
  run_id: string;
  /**
   * 必须为 true 才可能通过；为 false 不是失败，而是"无法判定"。
   *
   * Must be true to pass at all; false is undetermined, not a failure.
   */
  complete: boolean;
  checks: CheckReport[];
  artifacts?: Array<{ kind: "build"; path: string; sha256: string; loaded_by: string[] }>;
  build: { required: boolean; fresh?: boolean; load_verified?: boolean };
  summary: string;
  logs: string[];
}

/**
 * 三态结论：只有 `pass` 能把一次验证固化成证据，`fail` 与 `undetermined` 都阻止任务通过。
 *
 * Three-state conclusion: only `pass` can turn a run into evidence, while both
 * `fail` and `undetermined` keep the task from passing.
 */
export type Conclusion = "pass" | "fail" | "undetermined";

/**
 * 一次裁定：结论加上面向用户的原因列表；`pass` 时 `reasons` 为空。
 *
 * A judgement: the conclusion plus user-facing reasons. `reasons` is empty only
 * for `pass`.
 */
export interface Verdict {
  conclusion: Conclusion;
  reasons: string[];
}

/**
 * 从 run 目录读出 `run.json` 与 `result.json` 来裁定；所有读取失败都变成 `undetermined`，本函数不抛错。
 *
 * Judge a recorded run from its directory: read `run.json` and `result.json`,
 * then hand the text to `judgeRecord`. Every read failure becomes
 * `undetermined`; nothing here throws, so a gate that cannot read its evidence
 * refuses to pass instead of crashing.
 *
 * @param repo - 复算 build 产物哈希的仓库根 / Repository root for artifact hashing.
 * @param runDir - 本次 run 的目录，含 `run.json` 与 `result.json` / Run directory holding both files.
 * @param contract - 被验证的任务契约 / The contract under validation.
 * @param approvedInputHashes - 批准时固化的输入哈希表 / Input hashes frozen at approval.
 * @param expectedInputs - 期望被哈希的输入路径，默认取契约的 `baseline_inputs` / Paths expected to be hashed.
 * @returns 三态裁定 / The three-state verdict.
 *
 * @remarks
 * `result_discarded` 的 run 按"没有结果"处理（`resultText = null`），根本不读 `result.json`：被丢弃的
 * 结果无论如何都不能成为通过证据。
 *
 * 调用方通常把契约的 `baseline_inputs` 与验证器输入合并后作为 `expectedInputs` 传入；除读文件之外的
 * 判断全在 `judgeRecord`。
 *
 * A run flagged `result_discarded` is judged with `resultText = null` and its
 * `result.json` is never read, so a discarded result can never become passing
 * evidence.
 *
 * Callers normally merge the contract's `baseline_inputs` with the validator's
 * own repo inputs into `expectedInputs`; everything beyond the reads is decided
 * by `judgeRecord`.
 */
export async function judgeEvidence(
  repo: string,
  runDir: string,
  contract: Contract,
  approvedInputHashes: Record<string, string>,
  expectedInputs: readonly string[] = contract.baseline_inputs,
): Promise<Verdict> {
  let record: RunRecord;
  try {
    record = assertRunRecord(JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")));
  } catch (error) {
    return undetermined(`run.json unreadable: ${errorMessage(error)}`);
  }
  if (record.result_discarded) return judgeRecord(repo, record, null, contract, approvedInputHashes, expectedInputs);
  let text: string;
  try {
    text = await readFile(path.join(runDir, "result.json"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return undetermined("result.json missing");
    return undetermined(`result.json unreadable: ${errorMessage(error)}`);
  }
  return judgeRecord(repo, record, text, contract, approvedInputHashes, expectedInputs);
}

/**
 * 按固定顺序裁定一次已落盘的 run：进程事实 → 结果能否解析 → build 证据 → 工作树是否漂移 → 输入哈希 → 契约与检查集合。
 *
 * Judge an already-recorded run in a fixed order: process facts, then result
 * parseability, build proof, worktree drift, input hashes, and finally the
 * contract and check sets. Earlier branches win, and the function is fail-safe:
 * every state it cannot vouch for becomes `undetermined`.
 *
 * @param repo - 复算 build 产物哈希的仓库根 / Repository root for artifact hashing.
 * @param record - 已落盘的 run 记录 / The recorded run metadata.
 * @param resultText - `result.json` 原文；null 表示没有结果 / Raw `result.json`; null when absent.
 * @returns 三态裁定 / The three-state verdict.
 *
 * @remarks
 * 只有三种情况判 `fail`：必查 id 没被上报、被 `skip`、或被报 `fail`。其余一切异常（取消、超时、信号、
 * runner 或记录错误、schema 不合、run_id 不符、build 证据不成立、树在验证期间变化、输入哈希漂移、
 * `complete !== true`、检查全过但退出码非 0）都是 `undetermined`，绝不判通过。
 *
 * 只读：不写任务状态，唯一副作用是按仓库内路径复算产物哈希。
 *
 * Only three situations yield `fail`: a required id is not reported at all, is
 * reported as `skip`, or is reported as `fail`. Everything else that is off
 * (cancellation, timeout, signal, runner or record errors, schema violations,
 * run_id mismatch, unusable build proof, the tree moving during the run, input
 * hash drift, `complete !== true`, checks green but a non-zero exit code) is
 * `undetermined`, never a pass.
 *
 * Read-only: no state is written; the only side effect is re-hashing artifacts
 * from the working tree.
 */
export async function judgeRecord(
  repo: string,
  record: RunRecord,
  resultText: string | null,
  contract: Contract,
  approvedInputHashes: Record<string, string>,
  expectedInputs: readonly string[] = contract.baseline_inputs,
): Promise<Verdict> {
  if (record.cancelled) return undetermined("cancelled");
  if (record.timed_out) return undetermined("timed out");
  if (record.term_signal !== null) return undetermined(`terminated by signal ${record.term_signal}`);
  if (record.runner_error !== null) return undetermined(record.runner_error);
  if (record.record_error !== null) return undetermined(record.record_error);
  if (resultText === null) return undetermined("result.json missing");

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
    rejectUnknown(resultSchema, parsed, "result.json");
  } catch (error) {
    const detail = error instanceof ValidationError ? error.issues.join("; ") : error instanceof Error ? error.message : "unreadable";
    return undetermined(`result.json invalid: ${detail}`);
  }
  const result = parsed as ResultReport;
  const duplicate = duplicateId(result.checks);
  if (duplicate) return undetermined(`duplicate check id ${duplicate}`);
  if (result.run_id !== String(record.run)) return undetermined(`run_id mismatch ${result.run_id}`);
  const proof = await buildProof(repo, result);
  if (proof) return undetermined(proof);

  if (record.git) {
    if (record.tree_before === null || record.tree_after === null) return undetermined("git tree missing");
    if (record.tree_before !== record.tree_after) return undetermined("worktree changed during validation");
  }
  const input = inputMismatch(expectedInputs, approvedInputHashes, record,
    expectedInputs.filter((file) => !new Set(contract.baseline_inputs).has(file)));
  if (input) return undetermined(input);
  if (result.complete !== true) return undetermined("complete is not true");

  const approved = new Set(contract.approved_failures.map((item) => item.id));
  const overlap = contract.acceptance.find((id) => approved.has(id));
  if (overlap) return undetermined(`approved failure covers acceptance ${overlap}`);
  const required = [...contract.acceptance, ...contract.regression.filter((id) => !approved.has(id))];
  const byId = new Map(result.checks.map((check) => [check.id, check.status]));
  const missingRequired = required.filter((id) => !byId.has(id)).map((id) => `missing ${id}`);
  if (missingRequired.length > 0) return { conclusion: "fail", reasons: missingRequired };
  const missingApproved = [...approved].filter((id) => !byId.has(id)).map((id) => `approved failure not reported ${id}`);
  if (missingApproved.length > 0) return undetermined(missingApproved.join("; "));

  const errors = required.filter((id) => byId.get(id) === "error");
  if (errors.length > 0) return undetermined(errors.map((id) => `error ${id}`).join("; "));
  const skipped = required.filter((id) => byId.get(id) === "skip");
  if (skipped.length > 0) return { conclusion: "fail", reasons: skipped.map((id) => `skip ${id}`) };
  const failed = required.filter((id) => byId.get(id) === "fail");
  if (failed.length > 0) return { conclusion: "fail", reasons: failed.map((id) => `fail ${id}`) };
  if (record.exit_code !== 0) return undetermined("结果与退出码矛盾");
  return { conclusion: "pass", reasons: [] };
}

/**
 * 复算最近一次已验证 run 记录的 build 产物哈希；产物缺失、读不到或哈希不符都作废证据，返回失效原因，仍然有效时为 null。
 *
 * Re-hash recorded artifact files. `repo` is the ledger (run records live
 * there); `workRoot` (M7, default `repo`) is the tree the artifact files are
 * read from.
 *
 * @remarks
 * 通过 `updateState` 在任务锁内完成，读与作废是原子的：作废会清空 `last_verified` 并把原因写进
 * `evidence_invalid_reason`，返回值就是该字段。会话恢复任务时由适配层调用。
 *
 * 返回的是任务当前记录的原因，不一定是本次算出来的：`last_verified` 已为 null、或本次核对通过时，旧原因
 * 不会被清掉。
 *
 * The check runs inside the task lock through `updateState`, so reading and
 * invalidating are atomic: invalidating clears `last_verified` and writes the
 * reason into `evidence_invalid_reason`, which is also the return value. The
 * adapter calls this when a session resumes a task.
 *
 * What comes back is the task's current reason, not necessarily one found by
 * this call: an older reason survives when `last_verified` is already null or
 * when everything re-hashes cleanly.
 */
export async function recheckArtifacts(
  repo: string, taskId: string, session: string, workRoot?: string,
): Promise<string | null> {
  const work = workRoot ?? repo;
  return updateState(repo, taskId, session, async (state) => {
    if (state.last_verified === null) return state;
    // runsDir re-applies the authority walk and rejects symlinked run roots,
    // so a swapped `runs` entry cannot redirect recheck outside the task dir.
    const runDir = path.join(await runsDir(repo, taskId), String(state.last_verified.run));
    let record: RunRecord;
    try {
      record = assertRunRecord(JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")));
    } catch (error) {
      return { ...state, last_verified: null, evidence_invalid_reason: `run record unreadable: ${errorMessage(error)}` };
    }
    for (const [file, expected] of Object.entries(record.artifact_hashes)) {
      let actual: string | null;
      try {
        actual = await contentSha256(work, file);
      } catch (error) {
        return { ...state, last_verified: null, evidence_invalid_reason: `artifact unreadable ${file}: ${errorMessage(error)}` };
      }
      if (actual !== expected) {
        const reason = `artifact changed ${file}`;
        return { ...state, last_verified: null, evidence_invalid_reason: reason };
      }
    }
    return state;
  }).then((state) => state.evidence_invalid_reason);
}

/**
 * 仓库内相对路径的文件内容 sha256（原始字节，不带 git 对象头、不经任何过滤器）；路径不是仓库内的既有常规文件时返回 null。
 *
 * SHA-256 of a repo-relative file's bytes: raw content, no git object header
 * and no attribute filters. A path that is not an existing regular file inside
 * the repository yields null; genuine I/O failures still throw.
 *
 * @remarks
 * 这是基线输入、验证器输入与 build 产物共用的哈希口径（和 git blob 哈希不是一回事），也是 `.cw/` 下
 * 漂移唯一能被看见的途径：树哈希看不到那里。
 *
 * The hash flavour shared by baseline inputs, validator inputs, and build
 * artifacts (a git blob hash is a different thing), and the only way drift
 * under `.cw/` can be seen at all: the tree hash cannot look there.
 */
export async function contentSha256(repo: string, relative: string): Promise<string | null> {
  const file = await boundedFile(repo, relative);
  if (file === null) return null;
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/**
 * 从验证器 argv 里挑出指向仓库内既有常规文件的元素；去重、保留首次出现的顺序，其余元素（可执行文件、参数、长 payload）一律跳过。
 *
 * The elements of a validator cmd argv that reference an existing regular file
 * inside `repo` (repo-relative only; `..`, absolute paths, and symlink escapes
 * are never returned). These are the validator's script and direct inputs —
 * frozen by approval and re-checked around every validation run, because the
 * tree hash cannot see drift under `.cw/`, where the recommended script lives.
 *
 * @remarks
 * 判定方式就是试着按仓库内路径算内容哈希，算不出来（路径非法、越界、非常规文件，乃至抛错）就跳过：
 * argv 元素本来就可以是任意字符串。返回值一定是仓库内相对路径。
 *
 * An element qualifies only if it hashes as a repo-relative regular file;
 * anything else is skipped, errors included, since argv elements are arbitrary
 * strings. Every returned path lies inside the repository.
 */
export async function validatorInputFiles(repo: string, cmd: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const element of cmd) {
    if (seen.has(element)) continue;
    seen.add(element);
    try {
      // Only elements that resolve to an existing regular file inside the
      // repo are frozen inputs; anything else (executables, flags, report
      // payloads) is not a path probe result and is skipped, errors included.
      if (await contentSha256(repo, element) !== null) found.push(element);
    } catch {
      // Not a usable repo path (e.g. a long payload string): skip.
    }
  }
  return found;
}

/**
 * 核对 build 证据是否自洽：不自洽时返回面向用户的原因，自洽时返回 null。
 *
 * Whether the result's build evidence is self-consistent: returns a user-facing
 * reason when it is not, null when it is.
 *
 * @remarks
 * `build.required` 为 false 时要求 `fresh`、`load_verified`、`artifacts` 一个都不出现，写了反而可疑；
 * 为 true 时要求两者都是 true、至少一个产物，每个产物的 `loaded_by` 都必须是本次上报过的检查 id，且
 * 按仓库内路径复算的 sha256 与上报值完全一致（产物被改写即判不成立）。
 *
 * With `build.required` false, none of `fresh`, `load_verified`, or `artifacts`
 * may appear. With it true, both flags must be true and at least one artifact
 * must exist; every `loaded_by` id must be a check id reported in this run, and
 * the re-hashed sha256 must equal the reported one exactly. Artifacts are hashed
 * against the repository as it is now, so a rewritten artifact fails here.
 */
async function buildProof(repo: string, result: ResultReport): Promise<string | null> {
  const artifacts = result.artifacts ?? [];
  if (!result.build.required) {
    if (result.build.fresh !== undefined || result.build.load_verified !== undefined || artifacts.length > 0) {
      return "build not required but proof fields present";
    }
    return null;
  }
  if (result.build.fresh !== true || result.build.load_verified !== true) return "build proof incomplete";
  if (artifacts.length === 0) return "build artifact missing";
  const reported = new Set(result.checks.map((check) => check.id));
  for (const artifact of artifacts) {
    const unknown = artifact.loaded_by.filter((id) => !reported.has(id));
    if (unknown.length > 0) return `loaded_by unknown check ${unknown.join(", ")}`;
    let actual: string | null;
    try {
      actual = await contentSha256(repo, artifact.path);
    } catch (error) {
      return `artifact unreadable ${artifact.path}: ${errorMessage(error)}`;
    }
    if (actual === null) return `artifact missing ${artifact.path}`;
    if (actual !== artifact.sha256) return `artifact hash mismatch ${artifact.path}`;
  }
  return null;
}

/**
 * 核对输入哈希：批准集合必须与期望集合完全一致，每个期望文件在验证前后的哈希都必须等于批准值，多出来的哈希键直接作废。
 *
 * Input-hash check: the approved key set must equal the expected set exactly,
 * every expected file must hash to its approved value both before and after the
 * run, and a recorded hash for a file outside the expected set is an error.
 * Returns the first reason found, or null.
 *
 * @remarks
 * 漂移按来源分开报：`validatorFiles`（期望集合里不属于契约 `baseline_inputs` 的那些）算验证器输入变化，
 * 其余算验收输入变化，用户据此知道该去看脚本还是看验收用例。
 *
 * Drift is labelled by origin: entries listed in `validatorFiles` (the part of
 * the expected set that is not a contract baseline input) are reported as
 * validator inputs, the rest as acceptance inputs, so the message points at the
 * right kind of drift.
 */
function inputMismatch(
  expected: readonly string[], approved: Record<string, string>, record: RunRecord,
  validatorFiles: readonly string[],
): string | null {
  const approvedKeys = Object.keys(approved).sort();
  if (approvedKeys.join("\0") !== [...expected].sort().join("\0")) return "approved input set mismatch";
  const changed: string[] = [];
  for (const file of expected) {
    const want = approved[file];
    if (record.input_hashes_before[file] !== want || record.input_hashes_after[file] !== want) changed.push(file);
  }
  const extra = [...new Set([...Object.keys(record.input_hashes_before), ...Object.keys(record.input_hashes_after)])]
    .filter((file) => !expected.includes(file));
  if (extra.length > 0) return `unexpected input hash ${extra.join(", ")}`;
  if (changed.length === 0) return null;
  const validatorSet = new Set(validatorFiles);
  return changed
    .map((file) => validatorSet.has(file) ? `validator input changed ${file}` : `acceptance input changed ${file}`)
    .join("; ");
}

/**
 * 重复的检查 id 会让"id → 状态"映射悄悄丢掉前一条，所以重复即拒；返回重复到的 id，没有则返回 null。
 *
 * A duplicate check id would silently drop the earlier entry in the id→status
 * map, so duplicates are refused; returns the repeated id, or null.
 */
function duplicateId(checks: CheckReport[]): string | null {
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.id)) return check.id;
    seen.add(check.id);
  }
  return null;
}

/**
 * 把仓库内相对路径逐段解析成一个确定在仓库内的既有常规文件；路径非法、越过仓库、缺失或不是常规文件，都返回 null。
 *
 * Resolve a repo-relative path, segment by segment, to an existing regular file
 * that is provably inside `repo`. An illegal path, an escape, a missing
 * segment, or a non-file all yield null.
 *
 * @remarks
 * 符号链接段会被 realpath 并按仓库根复查，逃出仓库即拒，所以返回值是实际命中的绝对路径而不是词法拼接
 * 结果。ENOENT 与 ENOTDIR 都算"不存在"（中间一段是普通文件时是 ENOTDIR），其他 IO 错误照常抛出。
 *
 * Symlink segments are realpathed and re-checked against the repository root, so
 * an escape is refused and the return value is the path actually landed on, not
 * a lexical join. ENOENT and ENOTDIR both count as missing (ENOTDIR when an
 * intermediate segment is a plain file); other I/O errors propagate.
 */
async function boundedFile(repo: string, relative: string): Promise<string | null> {
  let parts: string[];
  try {
    parts = relativeParts(relative);
  } catch {
    return null;
  }
  const root = await realpath(repo);
  let cursor = root;
  for (const part of parts) {
    const next = path.join(cursor, part);
    let stat;
    try {
      stat = await lstat(next);
    } catch (error) {
      // ENOTDIR: an intermediate segment is a plain file (e.g. tests/a.py/sub.bin).
      if (!isMissing(error)) throw error;
      return null;
    }
    if (stat.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(next);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      if (!pathInside(root, target)) return null;
      cursor = target;
    } else {
      cursor = next;
    }
  }
  let final;
  try {
    final = await lstat(cursor);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return null;
  }
  return final.isFile() ? cursor : null;
}

/**
 * ENOENT 与 ENOTDIR 都算"不存在"（中间路径段是普通文件时是 ENOTDIR）；其他错误不吞。
 *
 * Treats both ENOENT and ENOTDIR as "missing" (the latter when an intermediate
 * segment is a plain file) and swallows nothing else.
 */
function isMissing(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * 抛出物的错误信息文本；不是 Error 的（例如字符串）统一写成 `unreadable`。
 *
 * Message of an unknown thrown value; anything that is not an `Error` becomes
 * `unreadable`.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unreadable";
}

/**
 * 构造 `undetermined` 裁定；这是本模块"判不了"的唯一出口，可疑情况一律走这里，不走 `pass`。
 *
 * Builds an `undetermined` verdict, the module's only "cannot tell" exit:
 * anything suspicious belongs here rather than in a pass.
 */
function undetermined(reason: string): Verdict {
  return { conclusion: "undetermined", reasons: [reason] };
}
