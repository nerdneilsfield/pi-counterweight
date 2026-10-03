import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runValidatorProcess } from "../core/runner.js";

/** Plan M8: the explorer subprocess is killed after 180 seconds. */
export const EXPLORER_TIMEOUT_MS = 180_000;

/** The fixed explorer system prompt, a runtime asset next to this module. */
export function explorerPromptPath(): string {
  return fileURLToPath(new URL("./prompt.md", import.meta.url));
}

/**
 * Locate the pinned pi CLI bundle (`bin.pi` → `dist/bundle/cli.js`) by walking
 * up from this module to the nearest `node_modules/@earendil-works/
 * pi-coding-agent`. Returns null when the package is not installed there.
 */
export function findPiCli(from: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  for (;;) {
    const candidate = path.join(
      dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Token usage of one assistant message, as accounted in the parent meter. */
export interface UsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number | null;
}

export interface ExplorerRun {
  /** Final assistant text, only when the run ended with `stopReason === "stop"`. */
  answer: string | null;
  /** null on failure; `error` carries the reason then. */
  error: string | null;
  /** One entry per assistant `message_end`; recorded even on failure. */
  usage: UsageSample[];
  timedOut: boolean;
  cancelled: boolean;
}

export interface ExplorerRequest {
  /** Working tree the explorer reads; also the subprocess cwd. */
  workRoot: string;
  /** `provider/model` from `project.toml` `[models] explorer`. */
  model: string;
  question: string;
  signal?: AbortSignal;
  /** Test seam: overrides CLI discovery (defaults to `findPiCli`). */
  cliPath?: string;
  /** Test seam: overrides the 180 s budget. */
  timeoutMs?: number;
}

/**
 * CLI facts verified against the installed `@earendil-works/pi-coding-agent
 * @1.0.0` dist (see docs/cw/pi-api-notes.md, M8 section):
 *
 * - `--mode json` runs single-shot and emits one JSON event per stdout line;
 *   the final answer arrives as `{"type":"message_end","message":{…assistant}}`
 *   with `content` blocks, `usage`, and `stopReason`.
 * - `--tools read,grep` is an allowlist that replaces the whole enabled set,
 *   applying to built-in, extension, and custom tools alike.
 * - `--system-prompt <path>` reads the file when the path exists.
 * - `--model provider/id` resolves the provider prefix.
 * - `--no-extensions --no-skills --no-prompt-templates --no-themes
 *   --no-context-files` shut down every auto-discovery surface, so nothing
 *   beyond the allowlist can register tools; `--no-approve` skips
 *   project-local trust so project files cannot add any.
 * - `--no-session` keeps the run ephemeral; `--offline` only skips startup
 *   network operations, not the model call.
 * - `--` puts the question into the positional messages verbatim.
 *
 * The allowlist plus the disabled discovery surfaces is the tool-layer
 * read-only enforcement — the system prompt never carries that guarantee.
 */
export async function runExplorer(request: ExplorerRequest): Promise<ExplorerRun> {
  const cli = request.cliPath ?? findPiCli();
  if (cli === null) {
    return { answer: null, error: "找不到 pi CLI（node_modules/@earendil-works/pi-coding-agent）", usage: [], timedOut: false, cancelled: false };
  }
  if (!request.model.includes("/")) {
    return { answer: null, error: `explorer 模型不是 provider/model 形式：${request.model}`, usage: [], timedOut: false, cancelled: false };
  }
  const argv = [
    "--mode", "json",
    "--no-session",
    "--offline",
    "--model", request.model,
    "--tools", "read,grep",
    "--system-prompt", explorerPromptPath(),
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--", request.question,
  ];
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-explorer-"));
  try {
    const outcome = await runValidatorProcess({
      cwd: request.workRoot,
      cmd: [process.execPath, cli, ...argv],
      env: { ...process.env },
      timeoutMs: request.timeoutMs ?? EXPLORER_TIMEOUT_MS,
      stdoutPath: path.join(scratch, "stdout.jsonl"),
      stderrPath: path.join(scratch, "stderr.log"),
      signal: request.signal,
    });
    try {
      let stdout = "";
      try {
        stdout = await readFile(path.join(scratch, "stdout.jsonl"), "utf8");
      } catch (error) {
        return { answer: null, error: `探索者输出不可读：${message(error)}`, usage: [], timedOut: outcome.timedOut, cancelled: outcome.cancelled };
      }
      const events = parseEvents(stdout);
      // Post-run verdict discipline mirrors the runner's discard order: a run
      // that was cancelled or timed out is a failure even when the subprocess
      // managed to emit a final answer before hanging — the answer of a killed
      // run is never accepted. Its usage is still returned for accounting.
      const failure = (reason: string): ExplorerRun =>
        ({ answer: null, error: reason, usage: events.usage, timedOut: outcome.timedOut, cancelled: outcome.cancelled });
      if (outcome.cancelled) return failure("已被取消");
      if (outcome.timedOut) return failure("超时，子进程组已终止");
      if (events.finalAssistant === null) return failure("没有最终回答");
      const assistant = events.finalAssistant;
      if (assistant.stopReason !== "stop") {
        return failure(`探索者未正常结束（stop reason: ${assistant.stopReason}）`);
      }
      if (assistant.text.trim() === "") return failure("探索者返回空回答");
      return { answer: assistant.text, error: null, usage: events.usage, timedOut: outcome.timedOut, cancelled: outcome.cancelled };
    } finally {
      // 判定与记账已读取完毕：释放父信号监听（进程组终止语义不变）。
      outcome.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface ParsedEvents {
  finalAssistant: { text: string; stopReason: string } | null;
  usage: UsageSample[];
}

export type { ParsedEvents };

/**
 * Parse the JSONL event stream. Unparseable lines (e.g. the leading session
 * header) are skipped; the last assistant `message_end` is the final answer,
 * and usage is summed across every assistant `message_end` — an agentic run
 * emits one per turn. Shared with the M9 evaluation scaffold.
 */
export function parseEvents(stdout: string): ParsedEvents {
  const usage: UsageSample[] = [];
  let finalAssistant: ParsedEvents["finalAssistant"] = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    if ((event as { type?: unknown }).type !== "message_end") continue;
    const message = (event as { message?: unknown }).message;
    if (message === null || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const record = message as {
      content?: unknown;
      usage?: unknown;
      stopReason?: unknown;
    };
    const usageOf = sampleUsage(record.usage);
    if (usageOf !== null) usage.push(usageOf);
    if (typeof record.stopReason !== "string") continue;
    const text = textBlocks(record.content);
    finalAssistant = { text, stopReason: record.stopReason };
  }
  return { finalAssistant, usage };
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: unknown } =>
      block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text")
    .map((block) => typeof block.text === "string" ? block.text : "")
    .filter((text) => text !== "")
    .join("\n");
}

function sampleUsage(value: unknown): UsageSample | null {
  if (value === null || typeof value !== "object") return null;
  const usage = value as {
    input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown;
    totalTokens?: unknown; cost?: unknown;
  };
  const cost = usage.cost !== null && typeof usage.cost === "object"
    ? (usage.cost as { total?: unknown }).total
    : undefined;
  const number = (field: unknown): number => typeof field === "number" && Number.isFinite(field) ? field : 0;
  return {
    input: number(usage.input),
    output: number(usage.output),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    totalTokens: number(usage.totalTokens),
    costTotal: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unreadable";
}
