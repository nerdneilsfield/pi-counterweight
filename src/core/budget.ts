/**
 * 角色的步数上限，以及轮询宿主 JSON 输出文件数步数的小工具。两个仓库里这个文件逐字节相同，不引用任何宿主。
 * 一步是一次模型请求或工具调用，以宿主能观察到的为准，各宿主自己决定怎么数。
 *
 * Per-role step limits and a small poller that counts steps in a host's JSON output file.
 * The file is byte-identical in both repositories and imports no host code.
 */
import { readFile } from "node:fs/promises";

/** 普通角色 30 步，research 80 步，planner 1 步。 */
export function stepLimit(role: string): number {
  return role === "research" ? 80 : role === "planner" ? 1 : 30;
}

export const budgetMessage = (limit: number): string => `已达 ${limit} 步上限，已终止，拆小输入后重试`;

const POLL_MS = 500;

/**
 * 每隔一会儿读一次 `file`，`count` 数出的步数超过 `limit` 就调用一次 `onExceed`，然后停。
 * `signal` 中止时也停；调用方在进程结束后调用返回的 `stop`，所以不会留下计时器。
 */
export function watchSteps(options: {
  file: string;
  limit: number;
  count: (text: string) => number;
  onExceed: () => void;
  signal?: AbortSignal;
  intervalMs?: number;
}): () => void {
  let timer: NodeJS.Timeout | undefined;
  let reading = false;
  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    options.signal?.removeEventListener("abort", stop);
  };
  if (options.signal?.aborted) return stop;
  options.signal?.addEventListener("abort", stop, { once: true });
  timer = setInterval(() => {
    if (reading) return;
    reading = true;
    readFile(options.file, "utf8")
      .then((text) => {
        if (timer !== undefined && options.count(text) > options.limit) {
          stop();
          options.onExceed();
        }
      })
      .catch(() => {})
      .finally(() => { reading = false; });
  }, options.intervalMs ?? POLL_MS);
  timer.unref();
  return stop;
}
