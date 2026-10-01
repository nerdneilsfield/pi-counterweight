import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { runsDir } from "./task.js";

/** One assistant message's usage, appended to `meter.jsonl` (M5; task lifecycle events come with M7). */
export interface UsageRecord {
  time: string;
  session: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_total: number | null;
}

const APPEND_FLAGS = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;

/**
 * Append one usage line. O_NOFOLLOW rejects a swapped `meter.jsonl`; O_APPEND
 * keeps concurrent appends from interleaving mid-line.
 */
export async function recordUsage(repo: string, taskId: string, record: UsageRecord): Promise<void> {
  const dir = path.dirname(await runsDir(repo, taskId));
  const handle = await open(path.join(dir, "meter.jsonl"), APPEND_FLAGS, 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
  } finally {
    await handle.close();
  }
}
