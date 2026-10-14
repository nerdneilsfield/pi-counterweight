/**
 * 四个角色共用的只读子进程。只读靠工具白名单和关闭自动发现，不靠提示词。
 *
 * Shared read-only child for the four roles. Read-only comes from the tool
 * allowlist and the disabled discovery flags, not from the prompt.
 */
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../core/process.js";
import { rolePromptPath, type RoleName } from "./prompts.js";

/** explorer、review、over_review 的预算。research 单独更长。 */
export const ROLE_TIMEOUT_MS = 300_000;
export const RESEARCH_TIMEOUT_MS = 1_800_000;

export function roleTimeoutMs(role: RoleName): number {
  return role === "research" ? RESEARCH_TIMEOUT_MS : ROLE_TIMEOUT_MS;
}

export interface UsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number | null;
}

export interface RoleRun {
  answer: string | null;
  error: string | null;
  usage: UsageSample[];
  timedOut: boolean;
  cancelled: boolean;
}

export interface RoleRequest {
  role: RoleName;
  workRoot: string;
  /** `provider/model`，provider 与 model 用第一个斜杠分开，model 里可以再有斜杠。 */
  model: string;
  /** 交给子进程的正文。review 的 diff 写进临时文件，避免命令行长度和 `@@`。 */
  message: string;
  signal?: AbortSignal;
  cliPath?: string;
  timeoutMs?: number;
}

/**
 * 从本模块向上找 pi CLI；找不到就用当前进程入口（`pi install` 不带宿主包）。
 */
export function findPiCli(from: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  for (;;) {
    const candidate = path.join(
      dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const entry = process.argv[1];
  if (entry === undefined) return null;
  try {
    const resolved = realpathSync(entry);
    const suffix = path.join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    return resolved.endsWith(path.sep + suffix) ? resolved : null;
  } catch {
    return null;
  }
}

export async function runRole(request: RoleRequest): Promise<RoleRun> {
  const cli = request.cliPath ?? findPiCli();
  if (cli === null) {
    return { answer: null, error: "找不到 pi CLI", usage: [], timedOut: false, cancelled: false };
  }
  const slash = request.model.indexOf("/");
  if (slash <= 0 || slash === request.model.length - 1 || /\s/.test(request.model)) {
    return { answer: null, error: `模型不是 provider/model：${request.model}`, usage: [], timedOut: false, cancelled: false };
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-role-"));
  try {
    // `--` 后的 @file 会被读入。绝对路径，cwd 保持仓库根，read/grep 才能读到代码。
    const messagePath = path.join(scratch, "message.md");
    await writeFile(messagePath, request.message);
    const argv = [
      "--mode", "json",
      "--no-session",
      "--offline",
      "--model", request.model,
      "--tools", "read,grep",
      "--system-prompt", rolePromptPath(request.role),
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--", `@${messagePath}`,
    ];
    const outcome = await runProcess({
      cwd: request.workRoot,
      cmd: [process.execPath, cli, ...argv],
      env: { ...process.env },
      timeoutMs: request.timeoutMs ?? roleTimeoutMs(request.role),
      stdoutPath: path.join(scratch, "stdout.jsonl"),
      stderrPath: path.join(scratch, "stderr.log"),
      signal: request.signal,
    });
    try {
      let stdout = "";
      try {
        stdout = await readFile(path.join(scratch, "stdout.jsonl"), "utf8");
      } catch (error) {
        return { answer: null, error: `输出不可读：${textOf(error)}`, usage: [], timedOut: outcome.timedOut, cancelled: outcome.cancelled };
      }
      const events = parseEvents(stdout);
      const failure = (reason: string): RoleRun =>
        ({ answer: null, error: reason, usage: events.usage, timedOut: outcome.timedOut, cancelled: outcome.cancelled });
      if (outcome.cancelled) return failure("已被取消");
      if (outcome.timedOut) return failure("超时，子进程组已终止");
      if (events.finalAssistant === null) return failure("没有最终回答");
      if (events.finalAssistant.stopReason !== "stop") {
        return failure(`未正常结束（stop reason: ${events.finalAssistant.stopReason}）`);
      }
      if (events.finalAssistant.text.trim() === "") return failure("返回空回答");
      return { answer: events.finalAssistant.text, error: null, usage: events.usage, timedOut: false, cancelled: false };
    } finally {
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
    const record = message as { content?: unknown; usage?: unknown; stopReason?: unknown };
    const usageOf = sampleUsage(record.usage);
    if (usageOf !== null) usage.push(usageOf);
    if (typeof record.stopReason !== "string") continue;
    finalAssistant = { text: textBlocks(record.content), stopReason: record.stopReason };
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

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : "unreadable";
}
