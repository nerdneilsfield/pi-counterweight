import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { isNotFound, pathInside, relativeParts } from "./paths.js";
import { rejectUnknown, ValidationError } from "./schema.js";
import { readState, runsDir, updateState } from "./task.js";
import type { Contract } from "./types.js";
import { assertRunRecord, type RunRecord } from "./runrecord.js";

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

export interface CheckReport {
  id: string;
  status: "pass" | "fail" | "skip" | "error";
  message?: string;
}

export interface ResultReport {
  protocol: 1;
  run_id: string;
  complete: boolean;
  checks: CheckReport[];
  artifacts?: Array<{ kind: "build"; path: string; sha256: string; loaded_by: string[] }>;
  build: { required: boolean; fresh?: boolean; load_verified?: boolean };
  summary: string;
  logs: string[];
}

export type Conclusion = "pass" | "fail" | "undetermined";

export interface Verdict {
  conclusion: Conclusion;
  reasons: string[];
}

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
 * Re-hash recorded artifact files. `repo` is the ledger (run records live
 * there); `workRoot` (M7, default `repo`) is the tree the artifact files are
 * read from.
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

export async function contentSha256(repo: string, relative: string): Promise<string | null> {
  const file = await boundedFile(repo, relative);
  if (file === null) return null;
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/**
 * The elements of a validator cmd argv that reference an existing regular file
 * inside `repo` (repo-relative only; `..`, absolute paths, and symlink escapes
 * are never returned). These are the validator's script and direct inputs —
 * frozen by approval and re-checked around every validation run, because the
 * tree hash cannot see drift under `.cw/`, where the recommended script lives.
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

function duplicateId(checks: CheckReport[]): string | null {
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.id)) return check.id;
    seen.add(check.id);
  }
  return null;
}

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

function isMissing(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unreadable";
}

function undetermined(reason: string): Verdict {
  return { conclusion: "undetermined", reasons: [reason] };
}
