/**
 * `.cw/meter.jsonl` 的追加写入：每条模型用量或 harness 事件一行；文件只增不减、仅供观察，账本不存在于 lite 版本。
 *
 * Append-only accounting into the repo's `.cw/meter.jsonl`, one JSON line per
 * model usage or harness event. The file only ever grows and is observational
 * only; the lite version keeps no other ledger.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

/**
 * 一条 assistant 消息的用量，追加到 `meter.jsonl`。
 *
 * One assistant message's usage, appended to `meter.jsonl`.
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
 * 一条 harness 事件（结束检查、探索者运行），追加到 `meter.jsonl`。
 *
 * One harness event (an end check or an explorer run), appended to `meter.jsonl`.
 */
export interface EventRecord {
  kind: "event";
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
 * 以追加句柄打开 `.cw/meter.jsonl`，写一行 JSON 后关闭；句柄在 `finally` 中关闭，错误原样上抛。
 *
 * Opens `.cw/meter.jsonl` with `APPEND_FLAGS` and writes one JSON line, always
 * closing the handle in a `finally`. The `.cw` directory is created first and
 * re-checked with `lstat`, so a symlinked `.cw` is refused instead of written
 * through; errors propagate unchanged.
 */
async function appendMeterLine(repo: string, record: UsageRecord | EventRecord): Promise<void> {
  const dir = path.join(repo, ".cw");
  await mkdir(dir, { recursive: true });
  const stat = await lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(".cw 不是目录（或被换成符号链接），拒绝写入计量");
  }
  const handle = await open(path.join(dir, "meter.jsonl"), APPEND_FLAGS, 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
  } finally {
    await handle.close();
  }
}

/**
 * 追加一条用量行（`kind` 由本函数补上）；I/O 失败照常抛出——由调用方（message_end、探索者工具）决定记账问题能否上浮。
 *
 * Append one usage line. Throws: the caller (message_end, the explorer tool)
 * decides whether accounting trouble may surface.
 */
export async function recordUsage(repo: string, record: Omit<UsageRecord, "kind">): Promise<void> {
  await appendMeterLine(repo, { ...record, kind: "usage" });
}

/**
 * 追加一条 harness 事件行。按设计是 best-effort：计量只作观察，失败的事件行永远不阻塞检查、探索或会话。
 *
 * Append one harness event. Best-effort by design: the meter is observational,
 * so a failed event line never blocks a check, an explorer run, or the session.
 */
export async function recordEvent(
  repo: string, session: string, event: string,
  detail: EventRecord["detail"] = {},
): Promise<void> {
  try {
    const record: EventRecord = {
      kind: "event", time: new Date().toISOString(), session, event, detail,
    };
    await appendMeterLine(repo, record);
  } catch {
    // Observational only.
  }
}
