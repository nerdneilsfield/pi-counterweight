import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { HandbackReason } from "./gate.js";
import { assertTaskId, isNotFound } from "./paths.js";
import { rejectUnknown } from "./schema.js";
import { readState, runsDir, withTaskLock } from "./task.js";
import { recordTaskEvent } from "./meter.js";
import type { Contract, LastVerified, TaskState, ValidatorConfig } from "./types.js";
import { assertRunRecord, type RunRecord } from "./runrecord.js";

export type HandbackOutcome =
  | HandbackReason | "finish" | "cancelled" | "manual" | "escalated" | "escalate_pending";

export interface HandbackRequest {
  contract: Contract;
  /** Approved validator configuration from `approval.json`. */
  validator: ValidatorConfig;
  reason: HandbackOutcome;
  /** Questions for the user, e.g. the `report_blocked` reason and questions. */
  questions: readonly string[];
  autoVerified: boolean;
}

export interface FingerprintEntry {
  run: number;
  id: string;
  status: string;
  fingerprint: string;
}

export interface HandbackMaterial {
  task_id: string;
  status: string;
  reason: HandbackOutcome;
  auto_verified: boolean;
  generated_at: string;
  last_verified: LastVerified | null;
  last_verified_record: string | null;
  notes: string | null;
  questions: string[];
  reproduce: { env: Record<string, string>; cmd: string[] };
  not_run_checks: string[];
  fingerprint_history: FingerprintEntry[];
  next_round: string;
}

const materialSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  status: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
  auto_verified: Type.Boolean(),
  generated_at: Type.String({ minLength: 1 }),
  last_verified: Type.Union([Type.Object({
    run: Type.Integer({ minimum: 1 }),
    tree: Type.String({ minLength: 1 }),
    contract_sha256: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }), Type.Null()]),
  last_verified_record: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  questions: Type.Array(Type.String()),
  reproduce: Type.Object({
    env: Type.Record(Type.String(), Type.String()),
    cmd: Type.Array(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
  not_run_checks: Type.Array(Type.String()),
  fingerprint_history: Type.Array(Type.Object({
    run: Type.Integer({ minimum: 1 }),
    id: Type.String({ minLength: 1 }),
    status: Type.String({ minLength: 1 }),
    fingerprint: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  }, { additionalProperties: false })),
  next_round: Type.String(),
}, { additionalProperties: false });

const REASON_LABELS: Record<HandbackOutcome, string> = {
  blocked: "模型已通过 report_blocked 报告受阻",
  budget: "预算超限",
  freeze_conflict: "冻结文件冲突",
  undetermined: "验证结论无法判定（环境或验证器问题，不重试）",
  repairs_exhausted: "自动修复次数已用尽",
  finish: "验收通过，任务结束",
  cancelled: "用户取消，验收结果未发布",
  manual: "用户手动交还",
  escalated: "模型升级完成，任务已移交更强模型的新会话",
  escalate_pending: "模型升级材料已就绪，等待用户在新 worktree 手动交接（启动 Pi 并 resume）",
};

/**
 * Failure fingerprint: sha256 over check id + status + message text with
 * volatile parts removed. Quoted spans that contain a "/" and absolute path
 * spans (from the leading "/" to the next message delimiter — punctuation,
 * quote, or newline — including a plain-word final segment) are dropped
 * whole. Hexadecimal survives only as standalone tokens: 0x-prefixed of any
 * length, or word-bounded runs of 6+ hex digits; ordinary words stay.
 * Digits are always removed, id and status always stay. Fingerprints never
 * affect the gate decision; they only annotate handback material.
 */
export function failureFingerprint(id: string, status: string, message: string): string {
  return createHash("sha256").update(id + status + stripVolatile(message)).digest("hex");
}

function stripVolatile(message: string): string {
  return message
    // A quoted span containing a "/" is a path: remove it with its quotes.
    .replace(/(["'`])([^"'`\n]*)\1/g, (whole, _quote: string, inner: string) =>
      inner.includes("/") ? " " : whole)
    // An unquoted absolute path span runs from its leading "/" to the next
    // message delimiter or end of line. Its final plain word belongs to the
    // path ("/tmp/cw data/out put" is one span), so it never leaks prose.
    .replace(/\/[^"'`\n，。；、,;:)\]}]*/g, " ")
    // Hex only as standalone tokens; ordinary words like "failure" survive.
    .replace(/\b0[xX][0-9a-fA-F]+\b|\b[0-9a-fA-F]{6,}\b/g, "")
    .replace(/\d+/g, "");
}

/**
 * Generate `handback.md` and `handback.json` in the authoritative task
 * directory. Reads runs and notes for the record; never writes state — the
 * caller owns the `handed_back` transition.
 */
export async function writeHandback(
  repo: string, taskId: string, session: string, request: HandbackRequest,
): Promise<{ md: string; json: string; material: HandbackMaterial }> {
  assertTaskId(taskId);
  return withTaskLock(repo, taskId, session, async () => {
    const state = await readState(repo, taskId);
    const material = await buildMaterial(repo, taskId, state, request);
    rejectUnknown(materialSchema, material, "handback.json");
    const dir = path.dirname(await runsDir(repo, taskId));
    const jsonPath = path.join(dir, "handback.json");
    const mdPath = path.join(dir, "handback.md");
    // Two-file commit semantics: both files are this call's unit. If either
    // write fails, the pair is rolled back — a half-written handback (json
    // without md, or vice versa) must never survive, and files from an
    // earlier handback are preserved verbatim.
    const previousJson = await readPrevious(jsonPath);
    const previousMd = await readPrevious(mdPath);
    try {
      await writeTaskFile(jsonPath, `${JSON.stringify(material, null, 2)}\n`);
      await writeTaskFile(mdPath, renderMarkdown(material));
    } catch (error) {
      await restorePrevious(jsonPath, previousJson);
      await restorePrevious(mdPath, previousMd);
      throw error;
    }
    // The meter line doubles as the task-flow event record: every handback,
    // finish, cancel, manual handback, and escalation lands here.
    await recordTaskEvent(repo, taskId, session, request.reason, { auto_verified: request.autoVerified });
    return {
      md: `.cw/tasks/${taskId}/handback.md`,
      json: `.cw/tasks/${taskId}/handback.json`,
      material,
    };
  });
}

/** Prior on-disk state of one handback file, for rollback. */
interface PreviousFile {
  existed: boolean;
  /** null when the prior entry was not a regular file (left untouched). */
  content: Buffer | null;
}

async function readPrevious(file: string): Promise<PreviousFile> {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (isNotFound(error)) return { existed: false, content: null };
    throw error;
  }
  if (!stat.isFile()) return { existed: true, content: null };
  return { existed: true, content: await readFile(file) };
}

async function restorePrevious(file: string, previous: PreviousFile): Promise<void> {
  if (!previous.existed) {
    await rm(file, { force: true });
    return;
  }
  if (previous.content === null) return;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, previous.content);
  await rename(temporary, file);
}

async function buildMaterial(
  repo: string, taskId: string, state: TaskState, request: HandbackRequest,
): Promise<HandbackMaterial> {
  const runs = await scanRuns(repo, taskId);
  const valid = runs.filter((run) => run.valid);
  const last = valid.at(-1) ?? null;
  const history = valid.flatMap((run) =>
    run.messages
      .filter((check) => check.status !== "pass")
      .map((check) => ({
        run: run.run,
        id: check.id,
        status: check.status,
        fingerprint: failureFingerprint(check.id, check.status, check.message),
      }))
  );

  const regression = request.contract.regression;
  const covered = last?.checks != null
    && regression.every((id) => last.checks!.has(id));
  const notRun = regression.length > 0 && !covered ? ["全量回归未运行"] : [];

  const questions = [...request.questions];
  if (request.reason === "freeze_conflict") {
    for (const conflict of state.conflicts) questions.push(conflictDetail(conflict));
  }

  const notes = await readNotes(repo, taskId);
  const runRoot = await runsDir(repo, taskId);
  return {
    task_id: taskId,
    status: state.status,
    reason: request.reason,
    auto_verified: request.autoVerified,
    generated_at: new Date().toISOString(),
    last_verified: state.last_verified,
    last_verified_record: state.last_verified === null
      ? null
      : `.cw/tasks/${taskId}/runs/${state.last_verified.run}/run.json`,
    notes,
    questions,
    reproduce: {
      env: reproduceEnv(taskId, requiredIds(request.contract), last, runRoot, request.validator.env),
      cmd: request.validator.cmd,
    },
    not_run_checks: notRun,
    fingerprint_history: history,
    next_round: notes === null ? "" : notesSection(notes, "建议的下一轮"),
  };
}

function requiredIds(contract: Contract): string[] {
  return [...contract.acceptance, ...contract.regression];
}

function reproduceEnv(
  taskId: string, required: string[], last: RunSummary | null,
  runRoot: string, extra: Record<string, string>,
): Record<string, string> {
  const run = last === null ? "<run>" : String(last.run);
  const resultDir = last === null ? path.join(runRoot, "<run>") : path.join(runRoot, String(last.run));
  return {
    ...extra,
    CW_TASK_ID: taskId,
    CW_RUN_ID: run,
    CW_RESULT_DIR: resultDir,
    CW_REQUIRED_IDS: required.join("\n"),
  };
}

interface RunSummary {
  run: number;
  /**
   * Usable as the basis for "last run": run.json is intact and not
   * cancelled/discarded, and result.json satisfies the protocol's core
   * validity rules (protocol 1, run_id matches, well-shaped unique checks).
   * Full evidence-schema judgment stays in evidence.ts; this is the subset
   * handback consumes.
   */
  valid: boolean;
  checks: Map<string, string> | null;
  messages: Array<{ id: string; status: string; message: string }>;
}

const invalidRun: { valid: boolean; checks: Map<string, string> | null; messages: RunSummary["messages"] } = {
  valid: false, checks: null, messages: [],
};

const validResultSchema = Type.Object({
  protocol: Type.Literal(1),
  run_id: Type.String({ minLength: 1 }),
  checks: Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("pass"), Type.Literal("fail"), Type.Literal("skip"), Type.Literal("error"),
    ]),
    message: Type.Optional(Type.String()),
  })),
});

/** Best-effort pass over `runs/`, highest number first for "last valid". */
async function scanRuns(repo: string, taskId: string): Promise<RunSummary[]> {
  const root = await runsDir(repo, taskId);
  const numbers = (await readdir(root))
    .map((name) => Number(name))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
  return Promise.all(numbers.map(async (run) => {
    const dir = path.join(root, String(run));
    return { run, ...(await readRun(dir, run)) };
  }));
}

async function readRun(
  dir: string, run: number,
): Promise<{ valid: boolean; checks: Map<string, string> | null; messages: RunSummary["messages"] }> {
  let record: RunRecord;
  try {
    record = assertRunRecord(JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")));
  } catch {
    return invalidRun;
  }
  if (record.cancelled || record.result_discarded || record.run !== run) return invalidRun;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(dir, "result.json"), "utf8"));
    rejectUnknown(validResultSchema, parsed, "result.json");
  } catch {
    return invalidRun;
  }
  const result = parsed as { protocol: 1; run_id: string; checks: Array<{ id: string; status: "pass" | "fail" | "skip" | "error"; message?: string }> };
  if (result.run_id !== String(run)) return invalidRun;
  const seen = new Set<string>();
  for (const check of result.checks) {
    if (seen.has(check.id)) return invalidRun;
    seen.add(check.id);
  }
  return {
    valid: true,
    checks: new Map(result.checks.map((check) => [check.id, check.status])),
    messages: result.checks.map((check) => ({
      id: check.id, status: check.status, message: check.message ?? "",
    })),
  };
}

async function readNotes(repo: string, taskId: string): Promise<string | null> {
  const dir = path.dirname(await runsDir(repo, taskId));
  try {
    return await readFile(path.join(dir, "notes.md"), "utf8");
  } catch {
    return null;
  }
}

/**
 * The model's live notes (`notes.md`), or null when absent. The escalation
 * view carries these as the previous model's unverified notes; reading them
 * directly (instead of through a just-written handback material) lets the
 * escalation write its material only after the switch actually succeeded.
 */
export async function readTaskNotes(repo: string, taskId: string): Promise<string | null> {
  return readNotes(repo, taskId);
}

/** Verbatim body of the notes section titled `title`, or "" when absent. */
export function notesSection(notes: string, title: string): string {
  const lines = notes.split("\n");
  const start = lines.findIndex((line) => headingTitle(line) === title);
  if (start === -1) return "";
  const level = headingLevel(lines[start]!);
  const end = lines.findIndex((line, index) =>
    index > start && headingTitle(line) !== null && headingLevel(line) <= level);
  const body = lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
  return body.replace(/^\n+|\n+$/g, "");
}

function headingTitle(line: string): string | null {
  const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
  return match === null ? null : match[2]!;
}

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s/.exec(line);
  return match === null ? 7 : match[1]!.length;
}

function conflictDetail(conflict: unknown): string {
  if (typeof conflict === "object" && conflict !== null) {
    const value = conflict as Record<string, unknown>;
    if (typeof value.path === "string") {
      return `冻结文件冲突：${value.path} 期望 ${String(value.expected)} 实际 ${
        value.actual === null || value.actual === undefined ? "缺失" : String(value.actual)
      }`;
    }
  }
  return `冻结文件冲突：${JSON.stringify(conflict)}`;
}

function renderMarkdown(material: HandbackMaterial): string {
  const lines: string[] = [
    `# Counterweight 交还材料 — ${material.task_id}`,
    "",
    `生成时间：${material.generated_at}`,
    "",
    "## 状态与原因",
    "",
    `- 状态：${material.status}`,
    `- 原因：${REASON_LABELS[material.reason as HandbackOutcome] ?? material.reason}`,
    `- 验证：${material.auto_verified ? "自动验证通过" : "未经自动验证"}`,
    "",
    "## 最后一次验证",
    "",
  ];
  if (material.last_verified === null) {
    lines.push("未验证。");
  } else {
    lines.push(
      `- 记录：\`.cw/tasks/${material.task_id}/runs/${material.last_verified.run}/run.json\``,
      `- 树哈希：\`${material.last_verified.tree}\``,
    );
  }
  lines.push("", "## 尝试过的方向（模型笔记，未经验证）", "");
  lines.push(material.notes === null || material.notes === "" ? "（无）" : material.notes);
  lines.push("", "## 需要人决定的问题", "");
  lines.push(material.questions.length === 0
    ? "（无）"
    : material.questions.map((question) => `- ${question}`).join("\n"));
  lines.push("", "## 复现当前状态的命令", "", "```");
  for (const key of Object.keys(material.reproduce.env).sort()) {
    lines.push(`${key}=${JSON.stringify(material.reproduce.env[key])}`);
  }
  lines.push(material.reproduce.cmd.map((part) => JSON.stringify(part)).join(" "));
  lines.push("```", "", "## 未运行的检查", "");
  lines.push(material.not_run_checks.length === 0
    ? "（无）"
    : material.not_run_checks.map((check) => `- ${check}`).join("\n"));
  lines.push("", "## 失败指纹历史", "");
  lines.push(material.fingerprint_history.length === 0
    ? "（无）"
    : material.fingerprint_history.map((entry) =>
        `- run ${entry.run} \`${entry.fingerprint}\` ${entry.id}（${entry.status}）`
      ).join("\n"));
  lines.push("", "## 建议的下一轮任务", "", material.next_round, "");
  return lines.join("\n");
}

/**
 * The task's current handback material, or null when absent or unreadable.
 * Best-effort by design: consumers (resume decoration) treat notes as
 * informational context and must not fail the command over them.
 */
export async function readHandbackMaterial(repo: string, taskId: string): Promise<HandbackMaterial | null> {
  try {
    const dir = path.dirname(await runsDir(repo, taskId));
    const file = path.join(dir, "handback.json");
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    rejectUnknown(materialSchema, parsed, "handback.json");
    return parsed as HandbackMaterial;
  } catch {
    return null;
  }
}

async function writeTaskFile(file: string, content: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    stat = undefined;
  }
  if (stat?.isSymbolicLink()) throw new Error(`${path.basename(file)} must not be a symlink`);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}
