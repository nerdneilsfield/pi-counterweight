// cw observe：运行一条命令，把现场记录到 .cw/observations/<时间戳>/。只记录，不分析。
// 命令是 argv 数组，不经 shell 拼接；完整输出只进临时目录，仓库里保留尾部各 200 行。
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectConfig } from "../core/config.js";
import { headCommit, repoToplevel, treeHash } from "../core/gitstate.js";
import { runValidatorProcess } from "../core/runner.js";

export const TAIL_LINES = 200;
const TAIL_WINDOW_BYTES = 1_048_576;
const READ_CHUNK_BYTES = 65_536;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_BYTES = 4_096;
const VERSION_MAX_CHARS = 200;
// 观测命令本身不限时：用户命令可能合法地运行很久。父进程收到 SIGINT/SIGTERM
// 时经取消链终止整个子进程组，这是唯一的中断路径。Node setTimeout 把 >2^31-1
// 的延迟压成 1ms，因此上界取 2^31-1（约 24.8 天），即实际的"不限时"。
const NO_TIMEOUT_MS = 2_147_483_647;

export class UsageError extends Error {}

export interface ObserveArgv {
  command: string[];
  note: string | null;
}

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

export interface VersionProbe {
  command: string;
  version?: string;
  error?: string;
}

export type GitSummary =
  | { supported: false }
  | { supported: true; root: string; commit: string | null; tree: string | null };

export interface ObservationRecord {
  version: 1;
  created_at: string;
  finished_at: string;
  command: string[];
  cwd: string;
  note: string | null;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  runner_error: string | null;
  git: GitSummary;
  os: { platform: string; release: string; arch: string; node: string };
  versions: VersionProbe[];
}

/**
 * Run `command` inside `cwd` and record the scene under
 * `<cwd>/.cw/observations/<timestamp>/`. The command's exit code, signal, or
 * spawn failure never prevents the record: observation.json is written before
 * the spawn and rewritten after it, and stdout/stderr tails land next to it.
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

/** `[observe] versions` commands from `.cw/project.toml`; missing file means none. */
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

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

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

function timestampName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * Last `TAIL_LINES` lines of `source`, never more than ~1 MiB: the file is
 * read backwards in chunks until both bounds are met; content beyond the
 * window is dropped behind an explicit marker instead of being kept whole.
 * The marker is prepended after the last-`TAIL_LINES` slice, so it survives
 * whenever truncation happened — by line count or by the byte window.
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

async function writeObservationRecord(dir: string, record: ObservationRecord): Promise<void> {
  const tmp = path.join(dir, "observation.json.tmp");
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, path.join(dir, "observation.json"));
}

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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "cw observe 失败");
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
