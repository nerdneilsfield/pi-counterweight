import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { runsDir } from "./task.js";

/** One assistant message's usage, appended to `meter.jsonl` (M5). */
export interface UsageRecord {
  kind: "usage";
  time: string;
  session: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_total: number | null;
}

/** One task lifecycle event, appended to `meter.jsonl` (M7). */
export interface TaskEventRecord {
  kind: "task";
  time: string;
  session: string;
  event: string;
  detail: Record<string, string | number | boolean | null>;
}

const APPEND_FLAGS = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;

async function appendMeterLine(repo: string, taskId: string, record: UsageRecord | TaskEventRecord): Promise<void> {
  const dir = path.dirname(await runsDir(repo, taskId));
  const handle = await open(path.join(dir, "meter.jsonl"), APPEND_FLAGS, 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
  } finally {
    await handle.close();
  }
}

/**
 * Append one usage line. O_NOFOLLOW rejects a swapped `meter.jsonl`; O_APPEND
 * keeps concurrent appends from interleaving mid-line. Throws: the caller
 * (message_end) decides whether accounting trouble may surface.
 */
export async function recordUsage(repo: string, taskId: string, record: Omit<UsageRecord, "kind">): Promise<void> {
  await appendMeterLine(repo, taskId, { ...record, kind: "usage" });
}

/**
 * Append one task lifecycle event. Best-effort by design: the meter is
 * observational, so a failed event line never blocks task creation, approval,
 * validation, handback, or escalation.
 */
export async function recordTaskEvent(
  repo: string, taskId: string, session: string, event: string,
  detail: TaskEventRecord["detail"] = {},
): Promise<void> {
  try {
    const record: TaskEventRecord = {
      kind: "task", time: new Date().toISOString(), session, event, detail,
    };
    await appendMeterLine(repo, taskId, record);
  } catch {
    // Observational only; the ledger (state.json, runs/) stays authoritative.
  }
}
