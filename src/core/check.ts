/**
 * 结束检查：项目配置里的一条命令，在本轮结束（`agent_before_settle`）时跑一次，只看退出码。
 * 失败把输出尾部与事实发回模型一次；再失败就如实报告并结束。没有协议文件、没有哈希、不绑证据。
 *
 * The end check: one command from the project config, run once when the agent
 * turn settles. Only the exit code decides. A failure is fed back to the model
 * once with the output tails and the facts; a second failure is reported as-is
 * and the turn ends. No protocol file, no hashes, no evidence binding.
 */
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CheckConfig } from "./config.js";
import { runProcess, type ProcessRun } from "./process.js";

/** 每条输出流保留的尾部行数上限 / Maximum trailing lines kept per stream. */
export const TAIL_LINES = 80;
/** 每条输出流尾部窗口的字节上限 / Byte cap on each stream's tail window. */
const TAIL_BYTES = 16 * 1024;

/**
 * 一次结束检查的事实：退出码、超时/取消标志、启动错误、耗时与两条输出流的尾部。
 *
 * The facts of one end check: exit code, timeout/cancel flags, launch error,
 * duration, and the tails of both output streams.
 */
export interface CheckOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  runnerError: string | null;
  durationMs: number;
  stdoutTail: string;
  stdoutTruncated: boolean;
  stderrTail: string;
  stderrTruncated: boolean;
}

/**
 * 跑一次结束检查：命令在仓库根、完整继承父环境（外加配置的 `env`），stdout/stderr 落系统临时目录，
 * 读回有界尾部后即删。
 *
 * Runs one end check: the command starts in the repository root with the parent
 * environment (plus the configured `env`), stdout/stderr go to a system temp
 * directory, and only a bounded tail is read back before the directory is
 * removed.
 *
 * @param request - 仓库根、检查配置与可选的取消信号 / Repo root, check config, and an optional cancel signal.
 * @returns 本次检查的事实；进程组在返回前一定已被回收 / The check's facts; the process group is reclaimed before this resolves.
 */
export async function runEndCheck(request: {
  repo: string;
  check: CheckConfig;
  signal?: AbortSignal;
}): Promise<CheckOutcome> {
  const directory = await mkdtemp(path.join(tmpdir(), "cw-check-"));
  const stdoutPath = path.join(directory, "stdout.log");
  const stderrPath = path.join(directory, "stderr.log");
  const started = Date.now();
  let run: ProcessRun | null = null;
  try {
    run = await runProcess({
      cwd: request.repo,
      cmd: request.check.cmd,
      env: { ...process.env, ...request.check.env },
      timeoutMs: request.check.timeout_s * 1000,
      stdoutPath,
      stderrPath,
      signal: request.signal,
    });
    const stdout = await readTail(stdoutPath);
    const stderr = await readTail(stderrPath);
    return {
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      cancelled: run.cancelled,
      runnerError: run.runnerError,
      durationMs: Date.now() - started,
      stdoutTail: stdout.text,
      stdoutTruncated: stdout.truncated,
      stderrTail: stderr.text,
      stderrTruncated: stderr.truncated,
    };
  } finally {
    run?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * 检查是否通过：进程正常退出、退出码为 0；超时、取消、启动失败一律不算通过。
 *
 * Whether the check passed: the process exited normally with code 0. A
 * timeout, a cancel, or a launch failure never counts as a pass.
 */
export function checkPassed(outcome: CheckOutcome): boolean {
  return outcome.runnerError === null && !outcome.timedOut && !outcome.cancelled && outcome.exitCode === 0;
}

/**
 * 把一次检查渲染成只含事实的一段文本：命令、退出码（或超时/信号/启动失败）、耗时、两条输出流的
 * 有界尾部。不写建议、不猜原因。
 *
 * Renders one check as a facts-only block: the command, the exit code (or the
 * timeout/signal/launch failure), the duration, and bounded tails of both
 * streams. No advice, no guessed cause.
 *
 * @param outcome - 本次检查的事实 / The check's facts.
 * @param options - 命令原文、是否最后一次自动检查。
 * @returns 供会话追加的文本 / The text to append to the session.
 */
export function renderCheckReport(outcome: CheckOutcome, options: {
  command: string;
  final: boolean;
}): string {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  const lines: string[] = [];
  if (outcome.runnerError !== null) {
    lines.push(`[counterweight] 结束检查未能启动：\`${options.command}\`（${outcome.runnerError}）`);
  } else if (outcome.timedOut) {
    lines.push(`[counterweight] 结束检查超时（${seconds}s），进程组已终止：\`${options.command}\``);
  } else if (outcome.signal !== null) {
    lines.push(`[counterweight] 结束检查被信号 ${outcome.signal} 终止：\`${options.command}\``);
  } else if (outcome.exitCode === 0) {
    lines.push(`[counterweight] 结束检查通过：\`${options.command}\` 退出码 0（${seconds}s）`);
  } else {
    lines.push(`[counterweight] 结束检查未通过：\`${options.command}\` 退出码 ${outcome.exitCode}（${seconds}s）`
      + (options.final ? "；不再自动重试" : ""));
  }
  appendTail(lines, "标准输出", outcome.stdoutTail, outcome.stdoutTruncated);
  appendTail(lines, "标准错误", outcome.stderrTail, outcome.stderrTruncated);
  return lines.join("\n");
}

/**
 * 追加上一条有内容输出流的尾部块；空输出不产生任何行。
 *
 * Appends one non-empty stream's tail block; an empty stream adds no lines.
 */
function appendTail(lines: string[], label: string, text: string, truncated: boolean): void {
  if (text === "") return;
  lines.push(`${label}（尾部${truncated ? "，已截断" : ""}）：`);
  lines.push(text);
}

/**
 * 从文件尾部读回有界内容：最多 `TAIL_BYTES` 字节与 `TAIL_LINES` 行；字节窗口切进一行时丢掉首个不完整行。
 *
 * Reads a bounded tail of a file: at most `TAIL_BYTES` bytes and `TAIL_LINES`
 * lines, dropping the first partial line when the byte window cut into one.
 * An unreadable file yields an empty tail.
 */
async function readTail(file: string): Promise<{ text: string; truncated: boolean }> {
  let chunk: Buffer;
  let cut = false;
  try {
    const handle = await open(file, "r");
    try {
      const size = (await handle.stat()).size;
      const readSize = Math.min(size, TAIL_BYTES);
      chunk = Buffer.alloc(readSize);
      await handle.read(chunk, 0, readSize, size - readSize);
      cut = size > readSize;
    } finally {
      await handle.close();
    }
  } catch {
    return { text: "", truncated: false };
  }
  const lines = chunk.toString("utf8").split("\n");
  if (cut && lines.length > 0) lines.shift();
  // 输出以换行结尾时最后一个元素是空串；它不占行数。
  // A trailing newline leaves one empty element; it does not count as a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const truncatedLines = lines.length > TAIL_LINES;
  const kept = truncatedLines ? lines.slice(lines.length - TAIL_LINES) : lines;
  return { text: kept.join("\n").replace(/\s+$/, ""), truncated: cut || truncatedLines };
}
