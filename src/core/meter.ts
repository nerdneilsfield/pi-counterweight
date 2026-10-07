/**
 * 任务目录下 `meter.jsonl` 的追加写入：每条模型用量或任务生命周期事件一行；账本（`state.json`、`runs/`）才权威，计量文件只增不减、仅供观察。
 *
 * Append-only accounting into the task directory's `meter.jsonl`, one JSON line
 * per model usage or task lifecycle event. The ledger (`state.json`, `runs/`)
 * stays authoritative: usage lines may throw, event lines are best-effort, and
 * the file is only ever appended to.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { runsDir } from "./task.js";

/**
 * 一条 assistant 消息的用量，追加到 `meter.jsonl`（M5）。
 *
 * One assistant message's usage, appended to `meter.jsonl` (M5).
 */
export interface UsageRecord {
  kind: "usage";
  time: string;
  session: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** usage 报告的费用合计；没有费用信息时为 `null`。 / Total cost reported in usage; `null` when usage carried no cost. */
  cost_total: number | null;
}

/**
 * 一条任务生命周期事件，追加到 `meter.jsonl`（M7）。
 *
 * One task lifecycle event, appended to `meter.jsonl` (M7).
 */
export interface TaskEventRecord {
  kind: "task";
  time: string;
  session: string;
  event: string;
  /** 事件专属的扁平明细，只放可直接序列化的标量。 / Event-specific flat detail; serialize-safe scalars only. */
  detail: Record<string, string | number | boolean | null>;
}

/**
 * 打开计量文件用的标志：`O_APPEND` 让并发追加不会互相覆盖，`O_NOFOLLOW` 拒绝被换成符号链接，
 * 且刻意不加 `O_TRUNC`——计量文件只增不减。
 *
 * Open flags for the meter file: `O_APPEND` keeps concurrent appends from
 * overwriting each other, `O_NOFOLLOW` rejects a symlinked `meter.jsonl`, and
 * `O_TRUNC` is deliberately absent — the file only ever grows.
 */
const APPEND_FLAGS = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;

/**
 * 以追加句柄打开任务目录下的 `meter.jsonl`，写一行 JSON 后关闭；句柄在 `finally` 中关闭，错误原样上抛。
 *
 * Opens the task directory's `meter.jsonl` with `APPEND_FLAGS` and writes one
 * JSON line, always closing the handle in a `finally`. Errors propagate
 * unchanged; `runsDir` also ensures the task's directory structure exists.
 */
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
 * 追加一条用量行（`kind` 由本函数补上）：`O_NOFOLLOW` 拒绝被换成符号链接的 `meter.jsonl`，
 * `O_APPEND` 保证并发追加不会写断一行；I/O 失败照常抛出——由调用方（message_end）决定记账问题能否上浮。
 *
 * Append one usage line. O_NOFOLLOW rejects a swapped `meter.jsonl`; O_APPEND
 * keeps concurrent appends from interleaving mid-line. Throws: the caller
 * (message_end) decides whether accounting trouble may surface.
 */
export async function recordUsage(repo: string, taskId: string, record: Omit<UsageRecord, "kind">): Promise<void> {
  await appendMeterLine(repo, taskId, { ...record, kind: "usage" });
}

/**
 * 追加一条任务生命周期事件行。按设计是 best-effort：计量只作观察，失败的事件行永远不阻塞任务创建、批准、验证、交还或升级。
 *
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
