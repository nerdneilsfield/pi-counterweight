import { randomUUID } from "node:crypto";
import { lstat, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { isNotFound } from "./paths.js";
import { rejectUnknown } from "./schema.js";

const sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const hashMap = Type.Record(Type.String({ minLength: 1 }), Type.Union([sha256, Type.Null()]));

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

export interface RunRecord {
  version: 1;
  run: number;
  started_at: string;
  ended_at: string;
  exit_code: number | null;
  term_signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  result_discarded: boolean;
  runner_error: string | null;
  record_error: string | null;
  git: boolean;
  tree_before: string | null;
  tree_after: string | null;
  input_hashes_before: Record<string, string | null>;
  input_hashes_after: Record<string, string | null>;
  artifact_hashes: Record<string, string | null>;
}

export function assertRunRecord(value: unknown): RunRecord {
  rejectUnknown(runRecordSchema, value, "run.json");
  return value as RunRecord;
}

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
