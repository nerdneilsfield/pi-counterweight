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
  /** 测试用：覆盖宿主 CLI，按 pi 的参数表调用。 */
  cliPath?: string;
  timeoutMs?: number;
}

export type Host = "pi" | "omp";

/**
 * 找宿主的 CLI。先从本模块向上找 pi 的 CLI；找不到就看当前进程入口是不是 pi、OMP 或 OMO 底层的 senpi。
 * OMP 是 bun 上的 pi 分叉，入口是 `@oh-my-pi/pi-coding-agent/dist/cli.js`；编译成单文件的 OMP 没有这个入口，找不到。
 *
 * Find the host CLI: first pi's CLI above this module, then the running process entry,
 * which may be pi or OMP (a pi fork on bun, entry `@oh-my-pi/pi-coding-agent/dist/cli.js`).
 * A single-file compiled OMP has no such entry and is not found.
 */
export function findHostCli(from: string = path.dirname(fileURLToPath(import.meta.url))): { cli: string; host: Host } | null {
  let dir = from;
  for (;;) {
    const candidate = path.join(
      dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    if (existsSync(candidate)) return { cli: candidate, host: "pi" };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const entry = process.argv[1];
  if (entry === undefined) return null;
  try {
    const resolved = realpathSync(entry);
    const pi = path.join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    const omp = path.join("@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
    // OMO 启动的是 senpi，一个 pi 的分叉，参数表和 pi 一致（已用 senpi 的 CLI 核对）。
    const senpi = path.join("@code-yeongyu", "senpi", "dist", "bundle", "cli.js");
    if (resolved.endsWith(path.sep + pi) || resolved.endsWith(path.sep + senpi)) return { cli: resolved, host: "pi" };
    if (resolved.endsWith(path.sep + omp)) return { cli: resolved, host: "omp" };
    return null;
  } catch {
    return null;
  }
}

/**
 * 子进程参数。只读靠 `--tools read,grep` 和关闭自动发现。两个宿主的参数表不同：
 * OMP 没有 `--offline`、`--no-context-files`、`--no-prompt-templates`、`--no-themes`、`--no-approve`，传了就报错退出；
 * OMP 在 `--` 之后把一切当文本，所以 `@file` 要放在前面，且不用 `--`。
 *
 * Child argv. Read-only comes from `--tools read,grep` and the disabled discovery flags.
 * The two hosts accept different flags: OMP rejects `--offline`, `--no-context-files`,
 * `--no-prompt-templates`, `--no-themes` and `--no-approve`, and treats everything after
 * `--` as text, so `@file` goes first and `--` is left out.
 */
export function roleArgv(host: Host, role: RoleName, model: string, messagePath: string): string[] {
  const common = [
    "--mode", "json",
    "--no-session",
    "--model", model,
    "--tools", "read,grep",
    "--system-prompt", rolePromptPath(role),
    "--no-extensions",
    "--no-skills",
  ];
  return host === "omp"
    ? [...common, "--no-rules", "--no-title", "--no-lsp", `@${messagePath}`]
    : [...common, "--offline", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--", `@${messagePath}`];
}

export async function runRole(request: RoleRequest): Promise<RoleRun> {
  const found = request.cliPath !== undefined ? { cli: request.cliPath, host: "pi" as Host } : findHostCli();
  if (found === null) {
    return { answer: null, error: "找不到 pi 或 omp 的 CLI", usage: [], timedOut: false, cancelled: false };
  }
  const slash = request.model.indexOf("/");
  if (slash <= 0 || slash === request.model.length - 1 || /\s/.test(request.model)) {
    return { answer: null, error: `模型不是 provider/model：${request.model}`, usage: [], timedOut: false, cancelled: false };
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-role-"));
  try {
    // 绝对路径，cwd 保持仓库根，read/grep 才能读到代码。
    const messagePath = path.join(scratch, "message.md");
    await writeFile(messagePath, request.message);
    const argv = roleArgv(found.host, request.role, request.model, messagePath);
    const outcome = await runProcess({
      cwd: request.workRoot,
      cmd: [process.execPath, found.cli, ...argv],
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
