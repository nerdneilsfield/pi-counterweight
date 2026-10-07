// cw observe：运行一条命令，把现场记录到 .cw/observations/<时间戳>/。只记录，不分析。
// 命令是 argv 数组，不经 shell 拼接；完整输出只进临时目录，仓库里保留尾部各 200 行。
/**
 * `cw observe` 独立 CLI：在指定工作目录运行一条用户命令，把现场（环境、git 状态、
 * 退出码、输出尾部）记到 `.cw/observations/<时间戳>/`；只记录，不判定。
 *
 * The `cw observe` standalone CLI: run one user command in a working directory
 * and record the scene — environment, git state, exit status, output tails —
 * under `.cw/observations/<timestamp>/`. It only records: a command that fails
 * still leaves a complete record behind.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectConfig } from "../core/config.js";
import { headCommit, repoToplevel, treeHash } from "../core/gitstate.js";
import { runValidatorProcess } from "../core/runner.js";

/** 仓库里保留的 stdout/stderr 尾部行数 / Trailing stdout/stderr lines kept in the repo. */
export const TAIL_LINES = 200;
/** 尾部窗口的字节上限（约 1 MiB）/ Byte cap on the tail window (~1 MiB). */
const TAIL_WINDOW_BYTES = 1_048_576;
/** 从文件尾向前读的块大小 / Chunk size of the backwards read. */
const READ_CHUNK_BYTES = 65_536;
/** 版本探测的硬超时，到期 SIGKILL / Hard timeout for a version probe; SIGKILL on expiry. */
const VERSION_PROBE_TIMEOUT_MS = 5_000;
/** 单个输出流的软上限，可能被一个 chunk 超出 / Soft per-stream cap; one chunk may push it over. */
const VERSION_PROBE_MAX_BYTES = 4_096;
/** 版本或错误文本入库前的字符上限 / Character cap for version or error text before it is stored. */
const VERSION_MAX_CHARS = 200;
// 观测命令本身不限时：用户命令可能合法地运行很久。父进程收到 SIGINT/SIGTERM
// 时经取消链终止整个子进程组，这是唯一的中断路径。Node setTimeout 把 >2^31-1
// 的延迟压成 1ms，因此上界取 2^31-1（约 24.8 天），即实际的"不限时"。
const NO_TIMEOUT_MS = 2_147_483_647;

/**
 * 命令行用法错误：入口把它映射为退出码 2，与命令自身的失败（1/127）区分开。
 *
 * CLI usage error; the entry point maps it to exit code 2, apart from the
 * command's own failure (1/127).
 */
export class UsageError extends Error {}

/**
 * `cw observe` 的参数解析结果；`--` 之前只认 `--note`。
 *
 * Parsed `cw observe` arguments; only `--note` is accepted before `--`.
 */
export interface ObserveArgv {
  /** `--` 之后的命令 argv，不经 shell 拼接 / The command argv after `--`, spawned without a shell. */
  command: string[];
  /** `--note` 附带的文字，缺省为 null / The `--note` text, or null when omitted. */
  note: string | null;
}

/**
 * 解析 `cw observe` 参数：`--` 之前只允许 `--note <文字>`（或 `--note=<文字>`），
 * `--` 之后整体作为命令 argv。
 *
 * Parse the `cw observe` arguments: before `--` only `--note <text>` (or
 * `--note=<text>`) is accepted, and everything after `--` is the command argv.
 * The command is never rebuilt through a shell.
 *
 * @param args - 已去掉 node 与脚本路径的 argv / The argv with node and script path stripped.
 * @returns 命令 argv 与备注 / The command argv and the note.
 * @throws UsageError - 未知参数、`--note` 缺值或缺少命令时 / On an unknown option, a valueless `--note`, or a missing command.
 */
export function parseObserveArgv(args: string[]): ObserveArgv {
  let note: string | null = null;
  let index = 0;
  while (index < args.length && args[index] !== "--") {
    const arg = args[index]!;
    if (arg === "--note") {
      const value = args[index + 1];
      if (value === undefined) throw new UsageError("cw observe: --note 需要一个值");
      note = value;
      index += 2;
      continue;
    }
    if (arg.startsWith("--note=")) {
      note = arg.slice("--note=".length);
      index += 1;
      continue;
    }
    throw new UsageError(`cw observe: 未知参数 ${arg}；用法：cw observe [--note <文字>] -- <cmd> [args...]`);
  }
  if (index >= args.length) throw new UsageError("cw observe: 需要 -- <cmd> [args...]；命令不经 shell 拼接");
  const command = args.slice(index + 1);
  if (command.length === 0) throw new UsageError("cw observe: -- 之后至少要有一个命令");
  return { command, note };
}

/**
 * 一条 `[observe] versions` 探测的结果：成功给 `version`，失败给 `error`。
 *
 * The outcome of one `[observe] versions` probe: a success carries `version`,
 * a failure carries `error`.
 */
export interface VersionProbe {
  /** 被探测的命令本身，不含 `--version` / The probed command itself, without `--version`. */
  command: string;
  /** 输出的首个非空行，已截断 / The first non-empty output line, truncated. */
  version?: string;
  /** 失败原因（超时、非零退出、无输出）/ Why the probe failed (timeout, non-zero exit, no output). */
  error?: string;
}

/**
 * 观测时的 git 状态摘要；不在仓库内（或 git 不可用）记 `supported: false`，不阻断观测。
 * `supported: true` 时 `commit`/`tree` 仍可能为 null（空仓库、HEAD 不可解析）。
 *
 * Git summary captured with the observation. Outside a repository (or when git
 * is unusable) it degrades to `supported: false` rather than failing the run;
 * with `supported: true`, `commit`/`tree` can still be null — an empty repo has
 * no HEAD to resolve.
 */
export type GitSummary =
  | { supported: false }
  | { supported: true; root: string; commit: string | null; tree: string | null };

/**
 * 一次观测的完整记录，即 `.cw/observations/<时间戳>/observation.json` 的内容。
 * 字段名与 JSON 一致（snake_case）；除版本号外全部来自实际观测，不做推断。
 *
 * The full record of one observation — the contents of
 * `.cw/observations/<timestamp>/observation.json`. Field names mirror the JSON
 * (snake_case), and everything except the schema version is measured rather
 * than inferred.
 */
export interface ObservationRecord {
  /** 记录格式版本，当前恒为 1 / Record schema version; currently always 1. */
  version: 1;
  /** 开始时间（ISO 8601，UTC），子进程启动前写入 / Start time (ISO 8601, UTC), written before the spawn. */
  created_at: string;
  /**
   * 收尾时间；初始等于 `created_at`，命令结束后重写。
   *
   * Finish time; starts as `created_at` and is rewritten once the command ends.
   */
  finished_at: string;
  /** 实际运行的 argv，原样保存 / The argv actually run, stored verbatim. */
  command: string[];
  /** 已 realpath 的工作目录 / The realpathed working directory. */
  cwd: string;
  note: string | null;
  /** 退出码；被信号终止或命令未能启动时为 null / Exit code; null when killed by a signal or never started. */
  exit_code: number | null;
  signal: string | null;
  /**
   * 因超时被终止；`cw observe` 不设超时，正常路径恒为 false。
   *
   * Terminated by timeout; `cw observe` sets no timeout, so this is false on the
   * normal path.
   */
  timed_out: boolean;
  /** 调用方取消（父进程收到 SIGINT/SIGTERM）/ Caller cancelled (the parent got SIGINT/SIGTERM). */
  cancelled: boolean;
  /**
   * 运行器自身失败的原因（命令未能启动）；正常执行时为 null。
   *
   * Why the runner itself failed to start the command; null otherwise.
   */
  runner_error: string | null;
  git: GitSummary;
  /**
   * 环境摘要：只含 OS 与 Node 版本，不含任何环境变量。
   *
   * Environment summary: OS and Node version only, never environment variables.
   */
  os: { platform: string; release: string; arch: string; node: string };
  /** 各配置工具的版本探测结果 / Version probes for the configured tools. */
  versions: VersionProbe[];
}

/**
 * 在 `cwd` 里运行 `command`，把现场记录到 `<cwd>/.cw/observations/<时间戳>/`。
 * 退出码、信号或启动失败都不会阻止记录：observation.json 在派生之前先写一份，
 * 结束后重写；stdout/stderr 尾部文件放在它旁边。
 *
 * Run `command` inside `cwd` and record the scene under
 * `<cwd>/.cw/observations/<timestamp>/`. The command's exit code, signal, or
 * spawn failure never prevents the record: observation.json is written before
 * the spawn and rewritten after it, and stdout/stderr tails land next to it.
 *
 * @remarks
 * 有副作用：写 `<cwd>/.cw/observations/`、创建并清理系统临时目录、以独立进程组派生
 * 命令。目录名冲突时依次追加 `-1`…`-99`，同一秒的记录再多就抛错。环境变量一律不
 * 进记录，避免泄漏 secret。
 *
 * Side effects: writes under `<cwd>/.cw/observations/`, creates and removes a
 * system temp dir, and spawns the command as its own process group. Name
 * collisions append `-1`…`-99`; beyond that the call throws. Environment
 * variables are never recorded.
 *
 * @param options - 工作目录、命令 argv、备注与取消信号 / Working dir, command argv, note, abort signal.
 * @returns 记录目录与收尾后的记录 / The record directory and the finished record.
 */
export async function recordObservation(options: {
  cwd: string;
  command: string[];
  note: string | null;
  signal?: AbortSignal;
}): Promise<{ dir: string; record: ObservationRecord }> {
  const created = new Date();
  const cwd = await realpath(options.cwd);
  // 环境摘要只含 OS 与工具版本；环境变量一律不入记录，避免泄漏 secret。
  const versions = await probeConfiguredVersions(cwd);
  const git = await gitSummary(cwd);
  const observations = path.join(cwd, ".cw", "observations");
  await mkdir(observations, { recursive: true });
  const dir = await claimObservationDir(observations, created);
  const record: ObservationRecord = {
    version: 1,
    created_at: created.toISOString(),
    finished_at: created.toISOString(),
    command: [...options.command],
    cwd,
    note: options.note,
    exit_code: null,
    signal: null,
    timed_out: false,
    cancelled: false,
    runner_error: null,
    git,
    os: { platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version },
    versions,
  };
  await writeObservationRecord(dir, record);
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-observe-"));
  try {
    const outcome = await runValidatorProcess({
      cwd,
      cmd: options.command,
      env: { ...process.env },
      timeoutMs: NO_TIMEOUT_MS,
      stdoutPath: path.join(scratch, "stdout"),
      stderrPath: path.join(scratch, "stderr"),
      signal: options.signal,
    });
    try {
      await writeTail(path.join(scratch, "stdout"), path.join(dir, "stdout-tail.txt"));
      await writeTail(path.join(scratch, "stderr"), path.join(dir, "stderr-tail.txt"));
      record.finished_at = new Date().toISOString();
      record.exit_code = outcome.exitCode;
      record.signal = outcome.signal;
      record.timed_out = outcome.timedOut;
      record.cancelled = outcome.cancelled;
      record.runner_error = outcome.runnerError;
      await writeObservationRecord(dir, record);
      return { dir, record };
    } finally {
      // 已读完 outcome 字段：释放父信号监听，不再续挂。
      outcome.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * 采集 git 摘要：仓库根、HEAD 提交与工作树哈希；不在仓库内记 `supported: false`，
 * HEAD 或 tree 取不到时对应字段为 null。
 *
 * Collect the git summary: repo root, HEAD commit, and working-tree hash. Not
 * being in a repository yields `supported: false`; an unresolvable HEAD or tree
 * leaves the matching field null.
 */
async function gitSummary(cwd: string): Promise<GitSummary> {
  const root = await repoToplevel(cwd);
  if (root === null) return { supported: false };
  const [commit, tree] = await Promise.all([headCommit(root), treeHash(root)]);
  return {
    supported: true,
    root,
    commit: commit.supported ? commit.value : null,
    tree: tree.supported ? tree.value : null,
  };
}

/**
 * 读取 `.cw/project.toml` 里的 `[observe] versions` 命令并逐条并行探测；文件缺失即
 * 视为没有要探测的命令。
 *
 * `[observe] versions` commands from `.cw/project.toml`; missing file means none.
 */
async function probeConfiguredVersions(cwd: string): Promise<VersionProbe[]> {
  const file = path.join(cwd, ".cw", "project.toml");
  try {
    await lstat(file);
  } catch {
    return [];
  }
  const project = await readProjectConfig(file);
  return Promise.all(project.observe.versions.map((command) => probeVersion(command, cwd)));
}

/**
 * 以 `<command> --version` 探测版本：5 秒后 SIGKILL，子进程环境只保留 PATH 与 HOME。
 * 任何失败都编码进结果，promise 永不 reject；版本与错误文本都截断到 `VERSION_MAX_CHARS`。
 *
 * Probe one tool's version with `<command> --version`: SIGKILLed after 5s, and
 * the child sees only `PATH` and `HOME`. Failures are encoded in the returned
 * probe — the promise never rejects — and both version and error text are
 * truncated to `VERSION_MAX_CHARS`.
 *
 * @param command - 要探测的可执行文件 / The executable to probe.
 * @param cwd - 探测命令的工作目录 / Working directory for the probe.
 * @returns 至少填好 `version` 或 `error` 之一的结果 / A probe with `version` or `error` set.
 */
function probeVersion(command: string, cwd: string): Promise<VersionProbe> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (probe: VersionProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(probe);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ command, error: "version probe timed out" });
    }, VERSION_PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < VERSION_PROBE_MAX_BYTES) stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < VERSION_PROBE_MAX_BYTES) stderr += chunk;
    });
    child.once("error", (error: Error) => finish({ command, error: error.message }));
    child.once("close", (code) => {
      if (code === 0) {
        const line = firstLine(stdout);
        finish(line !== "" ? { command, version: line.slice(0, VERSION_MAX_CHARS) } : { command, error: "no version output" });
        return;
      }
      const detail = firstLine(stderr) || firstLine(stdout) || "no output";
      finish({ command, error: `exit ${code ?? "signal"}: ${detail}`.slice(0, VERSION_MAX_CHARS) });
    });
  });
}

/** 第一个非空行的去空白内容；没有非空行则空串 / The first non-empty line, trimmed; empty string when there is none. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/**
 * 申请一个记录目录：以 UTC 时间戳命名；名字被占就依次尝试 `-1`…`-99`，用尽后抛错。
 *
 * Claim a record directory named after the UTC timestamp, retrying with
 * `-1`…`-99` suffixes when the name is taken; running out of suffixes throws.
 */
async function claimObservationDir(observations: string, created: Date): Promise<string> {
  const base = timestampName(created);
  for (let attempt = 0; ; attempt++) {
    const name = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      await mkdir(path.join(observations, name));
      return path.join(observations, name);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (attempt >= 99) throw new Error("observations: 同一秒内的记录目录过多");
    }
  }
}

/** UTC 时间戳目录名 `YYYYMMDDTHHMMSSZ` / UTC timestamp directory name, `YYYYMMDDTHHMMSSZ`. */
function timestampName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * 取 `source` 的最后 `TAIL_LINES` 行，且不超出约 1 MiB：从文件尾按块向前读，直到
 * 读完、行数够或到达字节上限之一；窗口之外的内容不保留，改为一条显式标记。
 *
 * Last `TAIL_LINES` lines of `source`, never more than ~1 MiB: the file is
 * read backwards in chunks until both bounds are met; content beyond the
 * window is dropped behind an explicit marker instead of being kept whole.
 * The marker is prepended after the last-`TAIL_LINES` slice, so it survives
 * whenever truncation happened — by line count or by the byte window.
 *
 * @remarks
 * 未读到文件头时首个（不完整的）行会被丢弃；标记插在切片之后，所以无论按行数还是
 * 按字节截断都会留下。只做文件 I/O：读 `source`、写 `target`。
 *
 * @param source - 运行器写下的完整输出文件 / The full output file written by the runner.
 * @param target - 仓库内的尾部文件，UTF-8 写入 / Destination tail file inside the repo, written as UTF-8.
 */
async function writeTail(source: string, target: string): Promise<void> {
  const handle = await open(source, "r");
  try {
    const size = (await handle.stat()).size;
    let collected = Buffer.alloc(0);
    let position = size;
    let newlines = 0;
    while (position > 0 && newlines <= TAIL_LINES && collected.length <= TAIL_WINDOW_BYTES) {
      const length = Math.min(READ_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      collected = Buffer.concat([chunk, collected]);
      for (const byte of chunk) {
        if (byte === 0x0a) newlines++;
      }
    }
    const parts = collected.toString("utf8").split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    let tail = parts;
    if (position > 0) {
      // 未读到文件头：首个不完整行丢弃；截断标记加在切片之后，不会被丢掉。
      tail = tail.slice(1).slice(-TAIL_LINES);
      tail = [`[counterweight: 仅保留尾部 ${TAIL_LINES} 行]`, ...tail];
    } else {
      tail = tail.slice(-TAIL_LINES);
    }
    await writeFile(target, tail.length === 0 ? "" : `${tail.join("\n")}\n`);
  } finally {
    await handle.close();
  }
}

/**
 * 原子地写 observation.json：先写同目录的 `.tmp` 再 rename，读者不会看到半截 JSON。
 *
 * Write observation.json atomically: a `.tmp` sibling is renamed into place, so
 * a reader never sees a half-written JSON document.
 */
async function writeObservationRecord(dir: string, record: ObservationRecord): Promise<void> {
  const tmp = path.join(dir, "observation.json.tmp");
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, path.join(dir, "observation.json"));
}

/**
 * CLI 入口：解析参数、把 SIGINT/SIGTERM 接到取消链上、记录，并在 stdout 打印记录目录。
 * 退出码沿用命令自身的（被信号终止或没有退出码时为 1），运行器自身失败为 127。
 *
 * CLI entry: parse the arguments, wire SIGINT/SIGTERM into the cancel chain,
 * record, and print the record directory on stdout. The exit code mirrors the
 * command's own status (1 when it was signalled or has none), or 127 when the
 * runner itself failed.
 *
 * @param argv - 进程参数，已去掉 node 与脚本路径 / Process argv with node and the script path stripped.
 */
async function main(argv: string[]): Promise<void> {
  const { command, note } = parseObserveArgv(argv);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const { dir, record } = await recordObservation({
      cwd: process.cwd(),
      command,
      note,
      signal: controller.signal,
    });
    console.log(`observation: ${dir}`);
    if (record.runner_error !== null) {
      console.error(record.runner_error);
      process.exitCode = 127;
    } else {
      process.exitCode = record.exit_code ?? 1;
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

// 仅当本文件作为脚本直接运行时才走 main；被 import（测试/复用）时保持静默。
// 用法错误（UsageError）在此处映射为退出码 2。
// Run main only when this file is the executed script; importing it stays inert.
// A usage error is mapped to exit code 2 in this catch.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "cw observe 失败");
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
