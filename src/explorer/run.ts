/**
 * 只读探索者子进程：定位 pi CLI、拼装只读 argv、解析 JSONL 事件流、汇总 token 用量，
 * 并审计 read/grep 的路径逃逸。
 *
 * The read-only explorer subprocess: locate the pi CLI, assemble the read-only
 * argv, parse the JSONL event stream, sum token usage, and audit read/grep path
 * escapes. Cancellation, a timeout, or an escaped read never yields an answer,
 * yet the usage of such a discarded run is still returned for accounting.
 */
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathInside } from "../core/paths.js";
import { runValidatorProcess } from "../core/runner.js";

/**
 * 探索者子进程的默认预算：180 秒后整组被终止。
 *
 * Plan M8: the explorer subprocess is killed after 180 seconds.
 */
export const EXPLORER_TIMEOUT_MS = 180_000;

/**
 * 探索者固定的系统提示词路径：与本模块同目录的运行时资源 `prompt.md`。
 *
 * The fixed explorer system prompt, a runtime asset next to this module.
 */
export function explorerPromptPath(): string {
  return fileURLToPath(new URL("./prompt.md", import.meta.url));
}

/**
 * 从 `from` 起逐级向上查找已安装的 pi CLI bundle
 * （`node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`），直到文件系统根；
 * 落空时回退到运行中的 pi 进程入口。托管安装（`pi install git:` / `npm:`）以
 * `--omit=dev --omit=peer` 安装依赖、不落地宿主包，检出目录附近没有物理的 pi 包，
 * 向上查找必然落空——回退是 explorer 在这种布局下仍能工作的关键。
 *
 * Locate the installed pi CLI bundle (`node_modules/@earendil-works/
 * pi-coding-agent/dist/bundle/cli.js`) by walking up from this module to the
 * filesystem root; when that misses, fall back to the running pi process entry.
 * Managed installs (`pi install git:` / `npm:`) install with `--omit=dev
 * --omit=peer`, so no host package exists near the checkout and the walk-up
 * always misses there — the fallback keeps the explorer usable.
 *
 * @param from - 起点目录，默认本模块所在目录 / Start dir; defaults to this module's own directory.
 * @returns 命中的绝对路径；都找不到时 null / Absolute path when found, else null.
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
  return piCliOfRunningProcess();
}

/**
 * 运行中 pi 进程的入口（`process.argv[1]`）解析符号链接后若指向 pi 自己的 CLI bundle，
 * 返回其真实路径；其余情况一律 null（普通 node 脚本、打包二进制、非 pi 入口都拒绝）。
 *
 * The running pi process entry (`process.argv[1]`) resolved through symlinks
 * when it points at pi's own CLI bundle, else null — ordinary node scripts,
 * compiled binaries and non-pi entries are rejected.
 */
function piCliOfRunningProcess(): string | null {
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

/**
 * 单条 assistant 消息的 token 用量；父进程按这个口径记账。
 *
 * Token usage of one assistant message, as accounted in the parent meter.
 * Counts that are missing or non-finite in the raw payload are coerced to 0,
 * and `costTotal` is null when pi reports no cost.
 */
export interface UsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number | null;
}

/**
 * 一次探索者运行的结论：失败时 `answer` 为 null、`error` 说明原因，而 `usage`
 * 无论成败都带回来记账。
 *
 * The result of one explorer run. On failure `answer` is null and `error`
 * carries the reason, while `usage` is reported either way so the tokens that
 * were already spent get accounted.
 */
export interface ExplorerRun {
  /**
   * 最终 assistant 文本，仅当运行以 `stopReason === "stop"` 正常结束时有值。
   *
   * Final assistant text, only when the run ended with `stopReason === "stop"`.
   */
  answer: string | null;
  /**
   * 运行失败时 `answer` 为 null，原因由本字段携带；成功时为 null。
   *
   * null on failure; `error` carries the reason then.
   */
  error: string | null;
  /**
   * 每条 assistant `message_end` 一条样本；被判失败的运行也照样保留。
   *
   * One entry per assistant `message_end`; recorded even on failure.
   */
  usage: UsageSample[];
  /** 到达本次运行的时间预算后被终止 / Killed once the run's time budget elapsed. */
  timedOut: boolean;
  /** 调用方取消；结果一律作废 / The caller aborted; the result is discarded. */
  cancelled: boolean;
  /**
   * 解析到工作树之外的 read/grep 路径参数（绝对路径、`..` 逃逸，或仓库内指向外部的
   * 符号链接）。非空表示回答读到了宿主无法担保的内容，整条回答被扣下。
   *
   * Read/grep path arguments that resolved outside the working tree (absolute
   * paths, `..` escapes, or in-repo symlinks pointing out). Non-empty means
   * the answer read material the harness cannot vouch for and is withheld.
   */
  escapedReads: string[];
}

/**
 * 发起一次探索者运行所需的输入；`cliPath` 与 `timeoutMs` 是测试注入点。
 *
 * Everything one explorer run needs to start; `cliPath` and `timeoutMs` exist
 * as test seams only.
 */
export interface ExplorerRequest {
  /**
   * 探索者读取的工作树；同时是子进程 cwd，也是读路径审计的基准。
   *
   * Working tree the explorer reads; also the subprocess cwd.
   */
  workRoot: string;
  /**
   * `provider/model` 形式，取自 `project.toml` 的 `[models] explorer`；缺 `/` 直接判失败。
   *
   * `provider/model` from `project.toml` `[models] explorer`.
   */
  model: string;
  /**
   * 要探索的问题，作为 `--` 之后的位置参数原样传给 pi。
   *
   * The question handed to pi verbatim as the positional message after `--`.
   */
  question: string;
  /**
   * 调用方取消信号：中止即终止整个子进程组，结果一律作废。
   *
   * Caller's abort signal; aborting kills the process group and discards the run.
   */
  signal?: AbortSignal;
  /**
   * 测试用：覆盖 CLI 定位（默认 `findPiCli`）。
   *
   * Test seam: overrides CLI discovery (defaults to `findPiCli`).
   */
  cliPath?: string;
  /**
   * 测试用：覆盖 180 秒预算。
   *
   * Test seam: overrides the 180 s budget.
   */
  timeoutMs?: number;
}

/**
 * 运行一次只读探索者：拼装 pi 的单发只读 argv，在 `workRoot` 下执行并解析事件流，
 * 给出结论；取消、超时、读路径逃逸都会扣下回答，但用量照常带回记账。
 *
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
 *
 * @remarks
 * 有副作用：派生独立进程组、写系统临时目录并在返回前删除、返回前 dispose 父信号监听。
 * 子进程层面的失败都编码进 `error`，只有宿主 I/O 失败（如临时目录创建）才抛出。
 * 判定顺序即契约：取消 → 超时 → 读路径逃逸 → 无最终回答 → 非 `stop` 结束 → 空回答；
 * 前一项命中就轮不到后一项，且被终止的运行即使已吐出一段回答也不采纳。
 *
 * Side effects: spawns the CLI as its own process group, uses a system temp dir
 * it removes on the way out, and disposes the parent-signal listener before
 * returning. Subprocess-level failures are encoded in `error`; only host I/O
 * failures throw. The check order is the contract — cancel, timeout, escaped
 * reads, missing answer, non-`stop` stop reason, empty answer — and the first
 * hit wins, so a killed run never gets its answer accepted.
 *
 * @param request - 本次运行的输入与测试注入点 / This run's inputs, including the test seams.
 */
export async function runExplorer(request: ExplorerRequest): Promise<ExplorerRun> {
  const cli = request.cliPath ?? findPiCli();
  if (cli === null) {
    return { answer: null, error: "找不到 pi CLI（node_modules/@earendil-works/pi-coding-agent）", usage: [], timedOut: false, cancelled: false, escapedReads: [] };
  }
  if (!request.model.includes("/")) {
    return { answer: null, error: `explorer 模型不是 provider/model 形式：${request.model}`, usage: [], timedOut: false, cancelled: false, escapedReads: [] };
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
        return { answer: null, error: `探索者输出不可读：${message(error)}`, usage: [], timedOut: outcome.timedOut, cancelled: outcome.cancelled, escapedReads: [] };
      }
      const events = parseEvents(stdout);
      // Post-run verdict discipline mirrors the runner's discard order: a run
      // that was cancelled or timed out is a failure even when the subprocess
      // managed to emit a final answer before hanging — the answer of a killed
      // run is never accepted. Its usage is still returned for accounting.
      const failure = (reason: string): ExplorerRun =>
        ({ answer: null, error: reason, usage: events.usage, timedOut: outcome.timedOut, cancelled: outcome.cancelled, escapedReads: [] });
      if (outcome.cancelled) return failure("已被取消");
      if (outcome.timedOut) return failure("超时，子进程组已终止");
      // The allowlist confines which tools run, not which paths they accept:
      // every read/grep path argument is audited against the working tree and
      // an escape (absolute path, `..`, or a symlink pointing out) withholds
      // the whole answer.
      const escapedReads = await readEscapes(request.workRoot, events.toolCalls);
      if (escapedReads.length > 0) {
        return { answer: null, error: `读取了工作树之外的路径：${escapedReads.join("、")}`, usage: events.usage, timedOut: outcome.timedOut, cancelled: outcome.cancelled, escapedReads };
      }
      if (events.finalAssistant === null) return failure("没有最终回答");
      const assistant = events.finalAssistant;
      if (assistant.stopReason !== "stop") {
        return failure(`探索者未正常结束（stop reason: ${assistant.stopReason}）`);
      }
      if (assistant.text.trim() === "") return failure("探索者返回空回答");
      return { answer: assistant.text, error: null, usage: events.usage, timedOut: outcome.timedOut, cancelled: outcome.cancelled, escapedReads };
    } finally {
      // 判定与记账已读取完毕：释放父信号监听（进程组终止语义不变）。
      outcome.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * 一次运行的 JSONL 解析结果：回答可能缺席，用量与工具调用照常收集。
 *
 * What one run's JSONL stream yielded: the answer may be missing while usage
 * and tool calls are collected all the same.
 */
interface ParsedEvents {
  /**
   * 最后一个带字符串 `stopReason` 的 assistant `message_end`；一个都没有时为 null。
   *
   * The last assistant `message_end` carrying a string `stopReason`, else null.
   */
  finalAssistant: { text: string; stopReason: string } | null;
  /**
   * 每条 assistant `message_end` 一条样本，累加由调用方负责。
   *
   * One sample per assistant `message_end`; summing is the caller's job.
   */
  usage: UsageSample[];
  /**
   * 子进程上报的 `tool_execution_start`，按出现顺序。
   *
   * `tool_execution_start` calls reported by the subprocess, in order.
   */
  toolCalls: Array<{ toolName: string; args: unknown }>;
}

export type { ParsedEvents };

/**
 * 解析 JSONL 事件流：无法解析的行（如开头的 session header）跳过；最后一条
 * assistant `message_end` 即最终回答，用量逐条收集（agentic 运行每轮一条，累加由
 * 调用方负责），每条 `tool_execution_start` 都保留给读路径审计。
 *
 * Parse the JSONL event stream. Unparseable lines (e.g. the leading session
 * header) are skipped; the last assistant `message_end` is the final answer,
 * usage is summed across every assistant `message_end` — an agentic run
 * emits one per turn — and every `tool_execution_start` is kept for the
 * read-path audit. Shared with the M9 evaluation scaffold.
 *
 * @remarks 纯函数：只解析传入的文本，不访问文件系统或状态 / Pure: reads only the given text.
 * @param stdout - 子进程的完整 stdout / The subprocess's entire stdout.
 * @returns 最终回答、用量样本与工具调用 / Final answer, usage samples, and tool calls.
 */
export function parseEvents(stdout: string): ParsedEvents {
  const usage: UsageSample[] = [];
  const toolCalls: ParsedEvents["toolCalls"] = [];
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
    if ((event as { type?: unknown }).type === "tool_execution_start") {
      const record = event as { toolName?: unknown; args?: unknown };
      if (typeof record.toolName === "string") {
        toolCalls.push({ toolName: record.toolName, args: record.args });
      }
      continue;
    }
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
  return { finalAssistant, usage, toolCalls };
}

/**
 * 挑出一次运行中 `read`/`grep` 解析到 `root` 之外的路径参数：树外的绝对路径、相对
 * `..` 逃逸，以及仓库内指向外部的符号链接。
 *
 * The read paths of an explorer run that resolve outside `root`: absolute
 * paths outside the tree, relative `..` escapes, and in-repo symlinks whose
 * target escapes. Missing targets never read anything and are not escapes;
 * the audit is fail-closed over what actually executed.
 *
 * @param root - 已 realpath 的工作树根 / The realpathed working-tree root.
 * @param toolCalls - 本次运行上报的工具调用 / Tool calls reported by the run.
 * @returns 逃逸的路径参数，按调用顺序（可能重复）/ The escaping arguments in call order (duplicates possible).
 */
async function readEscapes(
  root: string, toolCalls: ParsedEvents["toolCalls"],
): Promise<string[]> {
  const escaped: string[] = [];
  for (const call of toolCalls) {
    if (call.toolName !== "read" && call.toolName !== "grep") continue;
    const value = (call.args as { path?: unknown } | null)?.path;
    if (typeof value !== "string" || value === "") continue;
    try {
      await assertReadInside(root, value);
    } catch (error) {
      escaped.push(error instanceof Error && error.message !== "" ? `${value}（${error.message}）` : value);
    }
  }
  return escaped;
}

/**
 * 校验一个 read/grep 路径参数没有跑出 `root`：先做字符串判定，再用 realpath 判定
 * 符号链接；目标不存在直接放行——不存在的目标读不到任何东西。
 *
 * Verify that one read/grep path argument stays inside `root`: a lexical check
 * first, then a realpath check for symlinks. A missing target passes because
 * nothing could have been read from it.
 *
 * @param root - 已 realpath 的工作树根 / The realpathed working-tree root.
 * @param raw - 子进程上报的原始路径参数 / The raw path argument from the subprocess.
 * @throws 参数（含经符号链接解析后）落在工作树之外时 / When the argument resolves outside `root`.
 */
async function assertReadInside(root: string, raw: string): Promise<void> {
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  const relative = path.relative(root, absolute);
  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error("路径在工作树之外");
  }
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return; // Missing target: nothing was read.
  }
  if (!pathInside(root, real)) throw new Error("符号链接指向工作树之外");
}

/**
 * 拼接 assistant 消息 `content` 里的文本块，用换行连接；非文本块与非数组一律忽略。
 *
 * Join the text blocks of an assistant message's `content` with newlines,
 * ignoring anything that is not a text block.
 */
function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: unknown } =>
      block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text")
    .map((block) => typeof block.text === "string" ? block.text : "")
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * 把 pi 原始 usage 对象规整成 `UsageSample`：缺失或非有限数的计数取 0，成本缺失取
 * null，于是记账不会因字段形状异常而失败。
 *
 * Coerce a raw pi usage object into a `UsageSample`: missing or non-finite
 * counts become 0 and a missing cost becomes null, so accounting never fails
 * on an unexpected payload shape.
 */
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

/**
 * 取错误的可读文本；非 `Error` 值回落到 `"unreadable"`。
 *
 * Readable error text; anything that is not an `Error` becomes `"unreadable"`.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : "unreadable";
}
