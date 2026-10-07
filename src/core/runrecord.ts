/**
 * 验证运行记录 `run.json` 的 schema、校验与原子写入；每个 run 目录一份，记录退出状态、标志位与前后哈希。
 *
 * The schema, validation, and atomic write of `run.json`, one file per
 * validation run inside that run's directory. The write is atomic (a unique
 * temp file plus rename), so a reader sees either the previous complete record
 * or the next one — never a torn write.
 */
import { randomUUID } from "node:crypto";
import { lstat, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { isNotFound } from "./paths.js";
import { rejectUnknown } from "./schema.js";

/** 64 个小写十六进制字符的 SHA-256 摘要。 / A 64-character lowercase hex SHA-256 digest. */
const sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
/**
 * 路径 → 内容哈希映射；`null` 表示抓取失败（文件缺失或不可读），与空哈希不同。
 *
 * Maps a path to its content hash, or to `null` when a capture failed (missing
 * or unreadable file) — `null` is never an empty digest.
 */
const hashMap = Type.Record(Type.String({ minLength: 1 }), Type.Union([sha256, Type.Null()]));

/**
 * `run.json` 的校验模式（version 1）：字段全部必填、未知字段被拒；写入前与读出后都用它把关。
 *
 * The `run.json` schema at version 1: every field is required and unknown keys
 * are rejected. Enforced on both ends — `writeRunRecord` before a write,
 * `assertRunRecord` on anything read back.
 */
export const runRecordSchema = Type.Object({
  version: Type.Literal(1),
  run: Type.Integer({ minimum: 1 }),
  started_at: Type.String({ minLength: 1 }),
  ended_at: Type.String({ minLength: 1 }),
  exit_code: Type.Union([Type.Integer(), Type.Null()]),
  term_signal: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  timed_out: Type.Boolean(),
  cancelled: Type.Boolean(),
  result_discarded: Type.Boolean(),
  runner_error: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  record_error: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  git: Type.Boolean(),
  tree_before: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  tree_after: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  input_hashes_before: hashMap,
  input_hashes_after: hashMap,
  artifact_hashes: hashMap,
}, { additionalProperties: false });

/**
 * 一次验证运行的完整记录；证据层据此判断该次运行能否支撑 `pass`，哈希漂移或结果被丢弃都会把判定推向 `undetermined`。
 *
 * One validation run's complete record. The evidence layer reads it later to
 * decide whether the run can back a `pass`: `result_discarded` and hash drift
 * push judging to `undetermined`, never to a pass.
 */
export interface RunRecord {
  version: 1;
  run: number;
  started_at: string;
  ended_at: string;
  exit_code: number | null;
  term_signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  /**
   * 该次结果不可作为证据（取消、超时或被信号终止）；判定必须退到 undetermined。
   *
   * The result must not be used as evidence (cancel, timeout, or terminating
   * signal); judging degrades to `undetermined`.
   */
  result_discarded: boolean;
  /**
   * 验证器没能跑起来（spawn 失败或命令为空）；此时 `exit_code` 为 `null`。
   *
   * Set when the validator never started (spawn failure or empty command); the
   * `exit_code` is `null` in that case.
   */
  runner_error: string | null;
  /**
   * 抓取树哈希、输入哈希或产物哈希期间的错误，多个以 `; ` 连接；`null` 表示抓取完整。
   *
   * Capture errors from tree, input, or artifact hashing, joined with `; `;
   * `null` when every capture succeeded.
   */
  record_error: string | null;
  /**
   * 工作树哈希是否可用（git 仓库）；`false` 时 `tree_before` / `tree_after` 为 `null`。
   *
   * Whether worktree hashes could be taken (a git repo); when `false`,
   * `tree_before` and `tree_after` are `null`.
   */
  git: boolean;
  /**
   * 运行开始与结束时的 git 工作树哈希；`git` 为 `false` 时两者都是 `null`。
   *
   * Git worktree tree hashes taken before and after the run; both are `null`
   * when `git` is `false`.
   */
  tree_before: string | null;
  tree_after: string | null;
  /**
   * 基线与验证器输入文件的内容哈希（运行前/运行后各一份）；两条都要与批准哈希一致，否则证据失效。
   *
   * Content hashes of the baseline and validator input files, taken before and
   * after the run; both are compared against the approved hashes, and a
   * mismatch invalidates the evidence.
   */
  input_hashes_before: Record<string, string | null>;
  input_hashes_after: Record<string, string | null>;
  /**
   * 产物文件的内容哈希；结果被丢弃时清空为空映射。
   *
   * Content hashes of the run's artifacts; emptied when the result is
   * discarded.
   */
  artifact_hashes: Record<string, string | null>;
}

/**
 * 校验未知值符合 `run.json` 模式，并断言为 `RunRecord`；不匹配直接抛错，绝不返回未经验证的数据。
 *
 * Validates an unknown value against the `run.json` schema and returns it typed
 * as a `RunRecord`. A mismatch throws `ValidationError`; unvalidated data is
 * never returned.
 */
export function assertRunRecord(value: unknown): RunRecord {
  rejectUnknown(runRecordSchema, value, "run.json");
  return value as RunRecord;
}

/**
 * 原子写入 `run.json`：先校验记录，再写目标同目录下的唯一临时文件，最后 `rename` 覆盖目标。
 *
 * Atomically writes a `run.json`: the record is validated, a unique temp file
 * is written next to the target, and the temp file is renamed over it. A
 * symlink sitting at the target path is refused before any write; a missing
 * target is fine.
 *
 * @param file - `run.json` 的目标路径 / Target path of the run record.
 * @param record - 要写入的记录 / The record to write.
 * @throws 记录不合法、目标是符号链接或 I/O 失败时 / On an invalid record, a symlinked target, or an I/O failure.
 */
export async function writeRunRecord(file: string, record: RunRecord): Promise<void> {
  rejectUnknown(runRecordSchema, record, "run.json");
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    stat = undefined;
  }
  if (stat?.isSymbolicLink()) throw new Error("run.json must not be a symlink");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`);
  await rename(temporary, file);
}
