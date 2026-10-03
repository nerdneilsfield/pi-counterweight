// 评估脚手架：每个任务按四种条件各运行一次，每次从基线提交的全新 detached
// worktree 开始；输出 CSV 与打乱顺序、去掉条件标签的人工评判清单。本脚手架
// 只编排与记录，不评判、不把任何验证结论回灌给 pi。真实评估需可用的 pi 模型
// 凭据；四个条件的 pi 会话接管（/cw task resume 在 print/json 模式的分发）
// 属 M10 的实测项。
//
// 运行：npm run build 后 node dist/eval/run.js <tasks.toml> [--repeat <n>] [--out <dir>]
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { parse, stringify } from "smol-toml";
import { canonicalSha256 } from "../src/core/canonical.js";
import { contractSha256, readContract } from "../src/core/contract.js";
import { readProjectConfig } from "../src/core/config.js";
import { contentSha256 } from "../src/core/evidence.js";
import { blobHash, worktreeAdd, worktreePrune } from "../src/core/gitstate.js";
import { runRedCheck } from "../src/core/redcheck.js";
import { runValidatorProcess } from "../src/core/runner.js";
import { rejectUnknown } from "../src/core/schema.js";
import { createTask, readState, writeApproval, type Approval } from "../src/core/task.js";
import type { Tier } from "../src/core/types.js";
import { findPiCli, parseEvents } from "../src/explorer/run.js";

export const CONDITIONS = ["native", "gate", "contract", "escalate"] as const;
export type EvalCondition = (typeof CONDITIONS)[number];

const ModelName = Type.String({ minLength: 1, pattern: "^[^/\\s]+/[^/\\s]+$" });
const TierName = Type.Union([Type.Literal("cheap"), Type.Literal("medium"), Type.Literal("strong")]);
const StringList = Type.Array(Type.String({ minLength: 1 }));

const evalSchema = Type.Object({
  version: Type.Literal(1),
  models: Type.Object({
    cheap: ModelName,
    medium: ModelName,
    strong: ModelName,
    explorer: ModelName,
  }, { additionalProperties: false }),
  tiers: Type.Object({
    script: TierName,
    change: TierName,
    interface: TierName,
  }, { additionalProperties: false }),
  tasks: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    repo: Type.String({ minLength: 1 }),
    base_commit: Type.String({ minLength: 1 }),
    tier: Type.Union([Type.Literal("script"), Type.Literal("change"), Type.Literal("interface")]),
    model: ModelName,
    prompt: Type.String({ minLength: 1 }),
    acceptance: Type.String({ minLength: 1 }),
    judge: Type.String({ minLength: 1 }),
    verify_cmd: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    run_timeout_s: Type.Optional(Type.Integer({ minimum: 1 })),
    validator: Type.Object({
      cmd: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      timeout_s: Type.Optional(Type.Integer({ minimum: 1 })),
      env: Type.Optional(Type.Object({}, { additionalProperties: Type.String({ minLength: 0 }) })),
    }, { additionalProperties: false }),
    contract: Type.Object({
      deliverable: Type.Union([
        Type.Literal("code"), Type.Literal("repro"),
        Type.Literal("measurement"), Type.Literal("diagnosis"),
      ]),
      non_goals: Type.Optional(StringList),
      acceptance: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      red: StringList,
      regression: StringList,
      frozen: StringList,
      baseline_inputs: StringList,
    }, { additionalProperties: false }),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export interface EvalTask {
  id: string;
  repo: string;
  base_commit: string;
  tier: Tier;
  model: string;
  prompt: string;
  acceptance: string;
  judge: string;
  verify_cmd: string[];
  run_timeout_s: number;
  validator: { cmd: string[]; timeout_s: number; env: Record<string, string> };
  contract: {
    deliverable: "code" | "repro" | "measurement" | "diagnosis";
    non_goals: string[];
    acceptance: string[];
    red: string[];
    regression: string[];
    frozen: string[];
    baseline_inputs: string[];
  };
}

export type EvalTierModel = "cheap" | "medium" | "strong";

export interface EvalConfig {
  version: 1;
  models: { cheap: string; medium: string; strong: string; explorer: string };
  tiers: { script: EvalTierModel; change: EvalTierModel; interface: EvalTierModel };
  tasks: EvalTask[];
}

export async function readEvalConfig(tasksPath: string): Promise<EvalConfig> {
  let parsed: unknown;
  try {
    parsed = parse(await readFile(tasksPath, "utf8"));
  } catch (error) {
    throw new Error(`tasks toml: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  rejectUnknown(evalSchema, parsed, "tasks toml");
  const value = parsed as {
    version: 1;
    models: EvalConfig["models"];
    tiers: EvalConfig["tiers"];
    tasks: Array<{
      id: string; repo: string; base_commit: string; tier: Tier; model: string;
      prompt: string; acceptance: string; judge: string; verify_cmd: string[];
      run_timeout_s?: number;
      validator: { cmd: string[]; timeout_s?: number; env?: Record<string, string> };
      contract: EvalTask["contract"] & { non_goals?: string[] };
    }>;
  };
  return {
    version: 1,
    models: value.models,
    tiers: value.tiers,
    tasks: value.tasks.map((task) => ({
      ...task,
      run_timeout_s: task.run_timeout_s ?? 1800,
      validator: {
        cmd: task.validator.cmd,
        timeout_s: task.validator.timeout_s ?? 600,
        env: task.validator.env ?? {},
      },
      contract: { ...task.contract, non_goals: task.contract.non_goals ?? [] },
    })),
  };
}

export interface EvalRow {
  task: string;
  condition: EvalCondition;
  repeat: number;
  final_state: string;
  verdict: "pass" | "fail" | "not_run";
  wall_seconds: number;
  tokens: number;
  cache_read: number;
  cache_write: number;
  cost: number | null;
  repairs: number;
  escalated: boolean;
}

export interface EvalOptions {
  tasksPath: string;
  /** Defaults to `eval/out/<UTC timestamp>` under the current directory. */
  outDir?: string;
  repeat?: number;
  /** Test seam: pi CLI path (defaults to the pinned package's bundle). */
  piPath?: string;
  /** Test seam: Counterweight extension entry (defaults to this checkout's src). */
  extensionPath?: string;
}

export interface EvalSummary {
  outDir: string;
  rows: EvalRow[];
}

export async function runEvaluation(options: EvalOptions): Promise<EvalSummary> {
  const config = await readEvalConfig(options.tasksPath);
  const repeat = options.repeat ?? 1;
  const pi = options.piPath ?? findPiCli();
  if (pi === null) throw new Error("找不到 pi CLI（node_modules/@earendil-works/pi-coding-agent）");
  const extension = options.extensionPath ?? findCounterweightExtension();
  if (extension === null) throw new Error("找不到 Counterweight 扩展入口 src/adapters/pi/index.ts");
  const outDir = options.outDir ?? path.join("eval", "out", timestampName(new Date()));
  await mkdir(path.join(outDir, "judging"), { recursive: true });
  const rows: EvalRow[] = [];
  const entries: JudgingEntry[] = [];
  for (const task of config.tasks) {
    const repo = path.resolve(path.dirname(path.resolve(options.tasksPath)), task.repo);
    const base = await resolveCommit(repo, task.base_commit);
    for (const condition of CONDITIONS) {
      for (let r = 1; r <= repeat; r++) {
        const outcome = await runCondition({ task, config, condition, repeat: r, repo, base, pi, extension });
        rows.push(outcome.row);
        entries.push(outcome.entry);
      }
    }
  }
  await writeResultsCsv(path.join(outDir, "results.csv"), rows);
  await writeJudging(outDir, entries);
  return { outDir, rows };
}

// ---- 单条件运行 ---------------------------------------------------------------

interface ConditionInput {
  task: EvalTask;
  config: EvalConfig;
  condition: EvalCondition;
  repeat: number;
  repo: string;
  base: string;
  pi: string;
  extension: string;
}

interface Worktree {
  parent: string;
  dir: string;
}

async function runCondition(input: ConditionInput): Promise<{ row: EvalRow; entry: JudgingEntry }> {
  const started = Date.now();
  const usage = emptyUsage();
  const worktrees: Worktree[] = [];
  let finalState = "";
  let verdict: EvalRow["verdict"] = "not_run";
  let repairs = 0;
  let escalated = false;
  let diff = "";
  try {
    const runIn = async (model: string, boot: { redCheck: boolean; protectFrozen: boolean }) => {
      const worktree = await makeWorktree(input.repo, input.base);
      worktrees.push(worktree);
      const bootstrap = await bootstrapGate(worktree.dir, input, model, boot);
      if (!bootstrap.redOk) return { state: "red_check_failed", taskId: bootstrap.taskId, worktree };
      const argv = [
        "--mode", "json", "--no-session", "--offline",
        "--model", model,
        "--extension", input.extension,
        "--no-approve",
        "--", `/cw task resume ${bootstrap.taskId}`, input.task.prompt,
      ];
      const run = await runPi(worktree.dir, input.pi, argv, input.task.run_timeout_s * 1000);
      addUsage(usage, run.events);
      const failure = piFailure(run);
      if (failure !== null) return { state: failure, taskId: bootstrap.taskId, worktree };
      const state = await readState(worktree.dir, bootstrap.taskId);
      repairs = state.repairs_used;
      return { state: state.status, taskId: bootstrap.taskId, worktree };
    };

    if (input.condition === "native") {
      const worktree = await makeWorktree(input.repo, input.base);
      worktrees.push(worktree);
      const run = await runPi(worktree.dir, input.pi, [
        "--mode", "json", "--no-session", "--offline",
        "--model", input.task.model,
        "--", input.task.prompt,
      ], input.task.run_timeout_s * 1000);
      addUsage(usage, run.events);
      finalState = piFailure(run) ?? "completed";
    } else if (input.condition === "gate" || input.condition === "contract") {
      const red = input.condition === "contract";
      const attempt = await runIn(input.task.model, { redCheck: red, protectFrozen: red });
      finalState = attempt.state;
    } else {
      // 便宜模型先试；终态不是 verified 就换任务模型在全新 worktree 重来。
      const cheap = await runIn(input.config.models.cheap, { redCheck: true, protectFrozen: true });
      finalState = cheap.state;
      if (cheap.state !== "verified") {
        escalated = true;
        const strong = await runIn(input.task.model, { redCheck: true, protectFrozen: true });
        finalState = strong.state;
      }
    }

    const last = worktrees[worktrees.length - 1];
    if (last !== undefined && finalState !== "red_check_failed") {
      verdict = await runVerifier(last.dir, input.task.verify_cmd, input.task.validator.timeout_s * 1000);
      diff = await captureDiff(last.dir, input.base);
    } else if (last !== undefined) {
      diff = await captureDiff(last.dir, input.base);
    }
  } catch (error) {
    finalState = `error: ${(error instanceof Error ? error.message : "未知错误").slice(0, 200)}`;
    verdict = "not_run";
  } finally {
    for (const worktree of worktrees) await discardWorktree(input.repo, worktree);
  }
  const row: EvalRow = {
    task: input.task.id,
    condition: input.condition,
    repeat: input.repeat,
    final_state: finalState,
    verdict,
    wall_seconds: Math.round((Date.now() - started) / 100) / 10,
    tokens: usage.totalTokens,
    cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite,
    cost: usage.cost,
    repairs,
    escalated,
  };
  return {
    row,
    entry: {
      condition: input.condition,
      task: input.task.id,
      repeat: input.repeat,
      prompt: input.task.prompt,
      acceptance: input.task.acceptance,
      judge: input.task.judge,
      diff,
    },
  };
}

/** Bootstrap an approved task ledger inside a fresh baseline worktree. */
async function bootstrapGate(
  worktree: string, input: ConditionInput, model: string,
  options: { redCheck: boolean; protectFrozen: boolean },
): Promise<{ taskId: string; redOk: boolean }> {
  const taskId = `${ymd()}-${input.task.id}`;
  await createTask(worktree, taskId, model, input.base);
  const raw = {
    version: 1,
    task_id: taskId,
    tier: input.task.tier,
    deliverable: input.task.contract.deliverable,
    goal: input.task.prompt,
    non_goals: input.task.contract.non_goals,
    acceptance: input.task.contract.acceptance,
    red: input.task.contract.red,
    regression: input.task.contract.regression,
    frozen: input.task.contract.frozen,
    interface: [] as string[],
    baseline_inputs: input.task.contract.baseline_inputs,
    approved_failures: [] as string[],
  };
  await writeFile(
    path.join(worktree, ".cw", "tasks", taskId, "contract.toml"),
    `${stringify(raw)}\n`,
  );
  const projectFile = path.join(worktree, ".cw", "project.toml");
  await writeFile(projectFile, `${stringify({
    version: 1,
    validator: input.task.validator,
    models: input.config.models,
    tiers: input.config.tiers,
  })}\n`);
  const contract = await readContract(
    path.join(worktree, ".cw", "tasks", taskId, "contract.toml"), worktree, taskId);
  const project = await readProjectConfig(projectFile);
  const validator = {
    cmd: input.task.validator.cmd,
    timeout_s: input.task.validator.timeout_s,
    env: input.task.validator.env,
  };
  let red: Awaited<ReturnType<typeof runRedCheck>> | null = null;
  if (options.redCheck) {
    red = await runRedCheck({ repo: worktree, taskId, session: "eval", contract, validator, baseCommit: input.base });
    if (!red.valid || !red.red.ok) return { taskId, redOk: false };
  }
  const baselineInputs = red !== null ? red.baselineInputs : contract.baseline_inputs;
  const inputHashes: Record<string, string> = {};
  for (const file of baselineInputs) {
    const hash = red !== null ? red.inputHashes[file] : await contentSha256(worktree, file);
    if (hash === undefined || hash === null) throw new Error(`基线验收输入缺失：${file}`);
    inputHashes[file] = hash;
  }
  const frozenBlobs: Record<string, string> = {};
  if (options.protectFrozen) {
    for (const file of contract.frozen) {
      const blob = await blobHash(worktree, file);
      if (!blob.supported || blob.value === null) throw new Error(`冻结文件不可用：${file}`);
      frozenBlobs[file] = blob.value;
    }
  }
  const approval: Approval = {
    version: 1,
    contract_sha256: contractSha256(contract),
    project_config_sha256: canonicalSha256(project),
    validator,
    base_commit: input.base,
    baseline_inputs_sha256: inputHashes,
    frozen_blobs: frozenBlobs,
    red_check_run: red !== null ? red.run : 0,
    approved_at: new Date().toISOString(),
  };
  await writeApproval(worktree, taskId, "eval", approval, contract);
  return { taskId, redOk: true };
}

async function makeWorktree(repo: string, base: string): Promise<Worktree> {
  const parent = await mkdtemp(path.join(tmpdir(), "cw-eval-"));
  const dir = path.join(parent, "wt");
  await worktreeAdd(repo, dir, base);
  return { parent, dir };
}

async function discardWorktree(repo: string, worktree: Worktree): Promise<void> {
  await rm(worktree.parent, { recursive: true, force: true });
  try {
    await worktreePrune(repo);
  } catch {
    // 元数据清理失败不影响评估记录；下次 git 会自行修剪。
  }
}

// ---- 子进程 -------------------------------------------------------------------

interface PiRun {
  outcome: Awaited<ReturnType<typeof runValidatorProcess>>;
  events: ReturnType<typeof parseEvents>;
}

async function runPi(dir: string, pi: string, argv: string[], timeoutMs: number): Promise<PiRun> {
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-eval-pi-"));
  try {
    const outcome = await runValidatorProcess({
      cwd: dir,
      cmd: [process.execPath, pi, ...argv],
      env: { ...process.env },
      timeoutMs,
      stdoutPath: path.join(scratch, "stdout"),
      stderrPath: path.join(scratch, "stderr"),
    });
    let stdout = "";
    try {
      stdout = await readFile(path.join(scratch, "stdout"), "utf8");
    } catch {
      // 无输出（进程未启动等）：事件为空，final state 会标出失败原因。
    }
    return { outcome, events: parseEvents(stdout) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A hard run failure overrides the ledger state; null means pi ended cleanly. */
function piFailure(run: PiRun): string | null {
  if (run.outcome.timedOut) return "timeout";
  if (run.outcome.cancelled) return "cancelled";
  if (run.outcome.runnerError !== null) return `error: ${run.outcome.runnerError.slice(0, 200)}`;
  const stop = run.events.finalAssistant?.stopReason;
  if (stop !== "stop") return `stop:${stop ?? "none"}`;
  return null;
}

async function runVerifier(dir: string, cmd: string[], timeoutMs: number): Promise<EvalRow["verdict"]> {
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-eval-verify-"));
  try {
    const outcome = await runValidatorProcess({
      cwd: dir,
      cmd,
      env: { ...process.env },
      timeoutMs,
      stdoutPath: path.join(scratch, "stdout"),
      stderrPath: path.join(scratch, "stderr"),
    });
    if (outcome.timedOut || outcome.cancelled || outcome.runnerError !== null) return "not_run";
    return outcome.exitCode === 0 ? "pass" : "fail";
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function gitCapture(repo: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_COUNT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

async function resolveCommit(repo: string, ref: string): Promise<string> {
  const result = await gitCapture(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!result.ok) {
    throw new Error(`base_commit 无法解析：${ref}${result.stderr.trim() === "" ? "" : `（${result.stderr.trim()}）`}`);
  }
  return result.stdout.trim();
}

const DIFF_MAX_LINES = 400;

async function captureDiff(dir: string, base: string): Promise<string> {
  const status = await gitCapture(dir, ["status", "--porcelain"]);
  const diff = status.ok ? await gitCapture(dir, ["diff", base, "--"]) : { ok: false, stdout: "" };
  const text = [
    `$ git status --porcelain\n${status.stdout}`,
    `$ git diff ${base}\n${diff.stdout}`,
  ].join("\n");
  const lines = text.split("\n");
  const kept = lines.slice(0, DIFF_MAX_LINES);
  return lines.length > DIFF_MAX_LINES
    ? `${kept.join("\n")}\n（其余 ${lines.length - DIFF_MAX_LINES} 行略）`
    : text;
}

// ---- 计量 ---------------------------------------------------------------------

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number | null;
}

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null };
}

function addUsage(totals: UsageTotals, events: ReturnType<typeof parseEvents>): void {
  for (const sample of events.usage) {
    totals.input += sample.input;
    totals.output += sample.output;
    totals.cacheRead += sample.cacheRead;
    totals.cacheWrite += sample.cacheWrite;
    totals.totalTokens += sample.totalTokens;
    if (sample.costTotal !== null) totals.cost = (totals.cost ?? 0) + sample.costTotal;
  }
}

// ---- 输出 ---------------------------------------------------------------------

interface JudgingEntry {
  condition: EvalCondition;
  task: string;
  repeat: number;
  prompt: string;
  acceptance: string;
  judge: string;
  diff: string;
}

const CSV_HEADER =
  "task,condition,repeat,final_state,verdict,wall_seconds,tokens,cache_read,cache_write,cost,repairs,escalated";

function csvCell(value: string | number | boolean | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells: Array<string | number | boolean | null>): string {
  return cells.map(csvCell).join(",");
}

async function writeResultsCsv(target: string, rows: EvalRow[]): Promise<void> {
  const lines = [CSV_HEADER, ...rows.map((row) => csvLine([
    row.task, row.condition, row.repeat, row.final_state, row.verdict,
    row.wall_seconds, row.tokens, row.cache_read, row.cache_write,
    row.cost, row.repairs, row.escalated,
  ]))];
  await writeFile(target, `${lines.join("\n")}\n`);
}

/**
 * Shuffle the run list and write one entry per run without any condition
 * label; `key.csv` keeps the key → condition mapping for after the judging.
 */
async function writeJudging(outDir: string, entries: JudgingEntry[]): Promise<void> {
  const shuffled = shuffle([...entries]);
  const keyLines = ["key,task,repeat,condition"];
  const indexLines = [
    "# 人工评判清单",
    "",
    "条目已打乱且不含条件标签；评判完成后再用 `key.csv` 对照 key → 条件。",
    "",
    "| key | 任务 | 重复 |",
    "| --- | --- | --- |",
  ];
  const judgingDir = path.join(outDir, "judging");
  for (let index = 0; index < shuffled.length; index++) {
    const key = `j-${index + 1}`;
    const entry = shuffled[index]!;
    keyLines.push(csvLine([key, entry.task, entry.repeat, entry.condition]));
    indexLines.push(`| ${key} | ${entry.task} | ${entry.repeat} |`);
    await writeFile(path.join(judgingDir, `${key}.md`), renderEntry(key, entry));
  }
  await writeFile(path.join(outDir, "key.csv"), `${keyLines.join("\n")}\n`);
  await writeFile(path.join(judgingDir, "index.md"), `${indexLines.join("\n")}\n`);
}

function renderEntry(key: string, entry: JudgingEntry): string {
  return [
    `# ${key}`,
    "",
    `- 任务：${entry.task}`,
    `- 重复：${entry.repeat}`,
    "",
    "## 任务描述",
    "",
    entry.prompt,
    "",
    "## 验收说明",
    "",
    entry.acceptance,
    "",
    "## 人工评判标准",
    "",
    entry.judge,
    "",
    "## 结果 diff（截断至 400 行）",
    "",
    "```text",
    entry.diff === "" ? "（无改动）" : entry.diff,
    "```",
    "",
  ].join("\n");
}

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    const held = items[index]!;
    items[index] = items[swap]!;
    items[swap] = held;
  }
  return items;
}

function findCounterweightExtension(from: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, "src", "adapters", "pi", "index.ts");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function timestampName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function ymd(): string {
  return timestampName(new Date()).slice(0, 8);
}

// ---- CLI 入口 -----------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const usage = "用法：node dist/eval/run.js <tasks.toml> [--repeat <n>] [--out <dir>]";
  const positional: string[] = [];
  let repeat = 1;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--repeat") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1) throw new Error("--repeat 需要正整数");
      repeat = value;
      continue;
    }
    if (arg === "--out") {
      out = argv[++index];
      if (out === undefined || out === "") throw new Error("--out 需要一个目录");
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`未知参数 ${arg}；${usage}`);
    positional.push(arg);
  }
  if (positional.length !== 1) throw new Error(usage);
  const summary = await runEvaluation({ tasksPath: positional[0]!, repeat, outDir: out });
  console.log(`results: ${path.join(summary.outDir, "results.csv")}（${summary.rows.length} 行）`);
  console.log(`judging: ${path.join(summary.outDir, "judging", "index.md")}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "评估脚手架失败");
    process.exitCode = 1;
  });
}
