/**
 * 交还材料：把任务现状写成 `handback.json`（结构化）与 `handback.md`（给人看）两个文件，
 * 内容包括状态与原因、最后一次验证、模型笔记、待决问题、复现命令、未运行的检查与失败指纹历史。
 *
 * 双文件是一次提交：任一写入失败就整对回滚成上一次的版本，半份材料（只有 json 或只有 md）永不落地。
 * 本模块只读 `runs/` 与 `notes.md`，不写任务状态 —— `handed_back` 迁移由调用方负责。
 *
 * Handback material: writes the current task state as `handback.json` plus
 * `handback.md`, covering the status and reason, the last verification, the
 * model's notes, open questions, a reproduction command, checks that never
 * ran, and the failure-fingerprint history.
 *
 * The two files are one commit: if either write fails the pair is rolled back,
 * so half a handback never survives. This module only reads `runs/` and
 * `notes.md` and never writes task state — the caller owns the `handed_back`
 * transition.
 */
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

/**
 * 交还原因：门禁给出的 `HandbackReason`，或会话收尾原因（验收通过、用户取消、手动交还、
 * 升级完成、升级待交接）。
 *
 * Why the task was handed back: a gate `HandbackReason`, or a session-terminal
 * one (finish, cancel, manual, escalation done, escalation pending).
 */
export type HandbackOutcome =
  | HandbackReason | "finish" | "cancelled" | "manual" | "escalated" | "escalate_pending";

/**
 * 一次交还所需的输入：任务契约、批准过的验证器配置、交还原因与要问用户的问题。
 *
 * Everything one handback needs: the contract, the approved validator config,
 * the reason, and the questions to put to the user.
 */
export interface HandbackRequest {
  contract: Contract;
  /**
   * 批准记录里的验证器配置：复现命令与环境变量取自这里。
   *
   * Approved validator configuration from `approval.json`.
   */
  validator: ValidatorConfig;
  /**
   * 决定材料里的 `reason` 字段与 markdown 的原因标签。
   *
   * Drives the `reason` field and the markdown reason label.
   */
  reason: HandbackOutcome;
  /**
   * 要问用户的问题，如 `report_blocked` 的原因与疑问。
   *
   * Questions for the user, e.g. the `report_blocked` reason and questions.
   */
  questions: readonly string[];
  /**
   * 是否已由自动验证确认通过，写进材料的 `auto_verified`。
   *
   * Whether automatic validation confirmed a pass; written to `auto_verified`.
   */
  autoVerified: boolean;
}

/**
 * 一条失败指纹记录：某次运行里某个非 pass 检查的指纹。
 *
 * One failure fingerprint: a non-pass check from one run.
 */
export interface FingerprintEntry {
  /** 运行序号（`runs/<n>`） / Run number (`runs/<n>`). */
  run: number;
  id: string;
  /** 检查结论：只有非 pass 的才进历史 / Check status; only non-pass checks are recorded. */
  status: string;
  /** 失败指纹：sha256 的 64 位十六进制 / Failure fingerprint, 64 hex digits of sha256. */
  fingerprint: string;
}

/**
 * 写进 `handback.json` 的材料结构，也是 `handback.md` 的数据源；字段经过 schema 校验，
 * 未知字段一律拒绝。
 *
 * The material written to `handback.json` and the data source for
 * `handback.md`; validated against a schema that rejects unknown fields.
 */
export interface HandbackMaterial {
  task_id: string;
  status: string;
  reason: HandbackOutcome;
  auto_verified: boolean;
  generated_at: string;
  /**
   * 最近一次通过验证的锚点（run 号、树哈希、契约哈希）；未验证或已失效时为 `null`。
   *
   * Anchor of the last successful validation; `null` when there is none.
   */
  last_verified: LastVerified | null;
  /**
   * 那次验证的 `run.json` 仓库相对路径；未验证时为 `null`。
   *
   * The verifying run's `run.json`, repo-relative; `null` when there is none.
   */
  last_verified_record: string | null;
  /**
   * `notes.md` 的原文；没有笔记时为 `null`。
   *
   * Verbatim `notes.md`; `null` when the task has no notes.
   */
  notes: string | null;
  /**
   * 要人决定的问题；`freeze_conflict` 交还时每条冻结冲突也追加到这里。
   *
   * Questions a human must answer; each recorded freeze conflict is appended.
   */
  questions: string[];
  /**
   * 复现当前状态所需的环境变量与验证器命令。
   *
   * Environment variables and validator command needed to reproduce the state.
   */
  reproduce: { env: Record<string, string>; cmd: string[] };
  /**
   * 没有跑到的检查；目前只有「全量回归未运行」这一种。
   *
   * Checks that did not run; currently only an unrun full regression.
   */
  not_run_checks: string[];
  /**
   * 按运行顺序排列的非 pass 检查指纹历史。
   *
   * Fingerprints of non-pass checks, in run order.
   */
  fingerprint_history: FingerprintEntry[];
  /**
   * 从笔记里「建议的下一轮」小节抽出的正文；没有该小节时为空串。
   *
   * Verbatim body of the suggested-next-round section; "" when absent.
   */
  next_round: string;
}

/**
 * `handback.json` 的结构约束：未知字段一律拒绝，指纹必须是 64 位小写十六进制。
 *
 * 校验失败即抛错，材料一个字节都不会落盘；写入前与读回时用的是同一份 schema，坏掉的文件因此
 * 等同于不存在。
 *
 * Shape of `handback.json`: unknown fields are rejected and fingerprints must be
 * 64 lowercase hex digits. A violation throws before anything is written; the
 * read side reuses the same schema, so a corrupt file counts as absent.
 */
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

/**
 * 交还原因在 `handback.md` 里显示的中文标签。类型写成完整的
 * `Record<HandbackOutcome, string>`，所以新增原因漏配标签会在类型检查处暴露。
 *
 * Chinese labels for the reasons in `handback.md`; the full
 * `Record<HandbackOutcome, string>` type forces every reason to have one.
 */
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
 * 失败指纹：对「检查 id + 状态 + 去掉易变成分的 message」求 sha256。带 `/` 的引号片段（路径）与
 * 绝对路径跨度整体删除，十六进制只在独立成词时删除，普通单词保留；数字一律删除，id 与状态始终保留。
 * 指纹只用来在交还材料里比对“是不是同一个失败”，永不参与门禁裁决。
 *
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

/**
 * 抹掉 message 里易变的路径与数字，只留下跨运行稳定的文本骨架：宁可多删，也不能让同一处失败
 * 因为临时目录换了名字就变成两条。
 *
 * Erases volatile paths and digits from a message, leaving the skeleton that is
 * stable across runs: deleting a little too much beats splitting one failure in
 * two because a temp directory was renamed.
 */
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
 * 在权威任务目录下生成 `handback.json` 与 `handback.md`，并在最后记一条任务事件
 * （meter 行同时充当任务流事件记录）。
 *
 * 持任务锁执行：先读 runs 与笔记、校验材料 schema，然后才写文件。两个文件是一次提交，
 * 任一写入失败就把两个文件都恢复成本次调用之前的样子，绝不留下半份材料。
 * 本函数不写任务状态，`handed_back` 由调用方负责。
 *
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

/**
 * 一个交还文件在本次写入之前的状态，供回滚使用。
 *
 * Prior on-disk state of one handback file, for rollback.
 */
interface PreviousFile {
  /** 此前是否存在该文件 / Whether the file existed before this call. */
  existed: boolean;
  /**
   * 此前的内容；`null` 表示此前不是普通文件（保持原样不动）。
   *
   * null when the prior entry was not a regular file (left untouched).
   */
  content: Buffer | null;
}

/**
 * 读取一个交还文件在此次写入之前的状态：不存在、存在但不是普通文件（内容记 `null`，保持不动），
 * 或普通文件的内容。ENOENT 之外的错误原样抛出 —— 拿不到可靠的快照就不该开始写。
 *
 * Reads one handback file's prior state: absent, present but not a regular file
 * (content `null`, left untouched), or its bytes. Errors other than ENOENT
 * propagate: without a reliable snapshot the write must not start.
 */
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

/**
 * 把交还文件恢复成此次写入之前的样子：此前不存在就删掉，此前不是普通文件就不动，
 * 否则经临时文件原子替换回来。
 *
 * Restores a handback file to its pre-write state: removed if it did not exist,
 * left alone if it was not a regular file, atomically replaced otherwise.
 */
async function restorePrevious(file: string, previous: PreviousFile): Promise<void> {
  if (!previous.existed) {
    await rm(file, { force: true });
    return;
  }
  if (previous.content === null) return;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, previous.content);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * 汇总一份材料的全部字段：扫描 `runs/` 取最后一次有效运行（决定复现的 run 号与回归覆盖）以及
 * 非 pass 检查的指纹历史，再补上未运行的检查、冻结冲突的问题、笔记原文、复现环境与「下一轮」建议。
 *
 * Assembles one material object: scans `runs/` for the last valid run (which
 * fixes the reproduce run number and the regression coverage) and the
 * fingerprint history, then adds the not-run checks, freeze-conflict
 * questions, the raw notes, the reproduce environment, and the next-round
 * suggestion.
 */
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

/**
 * 复现时要覆盖的全部检查 id：验收 + 回归。
 *
 * Every check id a reproduction must cover: acceptance plus regression.
 */
function requiredIds(contract: Contract): string[] {
  return [...contract.acceptance, ...contract.regression];
}

/**
 * 复现所需的环境变量：先铺批准过的验证器 env，再用 `CW_TASK_ID`/`CW_RUN_ID`/`CW_RESULT_DIR`/
 * `CW_REQUIRED_IDS` 覆盖同名键（`CW_REQUIRED_IDS` 用换行连接）。没有有效运行时 run 号占位成
 * 字面量 `<run>`，由使用者替换成真实的运行号。
 *
 * Environment for a reproduction: the approved validator env first, then the
 * four `CW_*` variables overriding any keys they share. Without a valid run the
 * run number is the literal `<run>` placeholder.
 */
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

/**
 * 一次运行的摘要，供「最后一次有效运行」与失败指纹历史使用。
 *
 * Summary of one run, used for the "last valid run" pick and the fingerprint
 * history.
 */
interface RunSummary {
  run: number;
  /**
   * 能否当作“最后一次运行”的基准：run.json 完好且未被取消/丢弃，result.json 满足协议的核心有效性
   * 规则（协议 1、run_id 匹配、检查 id 唯一且形状正确）。完整的证据判定留在 evidence.ts，
   * 这里只做 handback 用得到的子集。
   *
   * Usable as the basis for "last run": run.json is intact and not
   * cancelled/discarded, and result.json satisfies the protocol's core
   * validity rules (protocol 1, run_id matches, well-shaped unique checks).
   * Full evidence-schema judgment stays in evidence.ts; this is the subset
   * handback consumes.
   */
  valid: boolean;
  /** 检查 id → 结论，用来判断回归是否跑全 / Check id to status, for regression coverage. */
  checks: Map<string, string> | null;
  /** 检查 id/结论/消息，供算指纹 / Check id, status, and message, for fingerprints. */
  messages: Array<{ id: string; status: string; message: string }>;
}

/**
 * 「这次运行不可用」的统一返回值，所有失败分支共用；字段固定、只读，不要改写这个对象。
 *
 * The shared "this run is unusable" value every failure branch returns; the
 * fields are fixed, and the object must never be mutated.
 */
const invalidRun: { valid: boolean; checks: Map<string, string> | null; messages: RunSummary["messages"] } = {
  valid: false, checks: null, messages: [],
};

/**
 * `result.json` 的核心有效性 schema：协议版本必须为 1、run_id 非空、
 * 每条检查带 id 与四种结论之一。
 * 这只是 handback 用得上的子集，完整的证据判定留在 evidence.ts。
 *
 * Core validity schema of `result.json`: protocol 1, a non-empty run_id, and
 * checks with an id and one of four statuses. This is only the subset handback
 * consumes — the full evidence judgment stays in `evidence.ts`.
 */
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

/**
 * 按运行号升序扫描 `runs/`：只认正整数目录名，逐个尽力解析，坏文件标记为不可用而不抛错；
 * 「上次运行」由调用方取运行号最大的那个有效运行。
 *
 * Best-effort pass over `runs/`, highest number first for "last valid".
 */
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

/**
 * 判定一次运行是否可用：run.json 必须通过 `assertRunRecord`、未被取消或丢弃、
 * 且运行号与目录名一致；result.json 必须满足核心 schema、run_id 一致、
 * 检查 id 不重复。
 *
 * 任何一条不满足都返回共享的 `invalidRun`，绝不部分采信；坏掉的运行只会被跳过，不会让交还失败。
 *
 * Decides whether one run is usable: `run.json` must pass `assertRunRecord`,
 * the run must not be cancelled or discarded, and its number must match the
 * directory; `result.json` must satisfy the core schema, carry a matching
 * run_id, and have unique check ids.
 */
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

/**
 * 读取任务目录下 `notes.md` 的原文；文件不存在或读不到都算“没有笔记”，返回 `null`。
 *
 * Reads the task's `notes.md`; a missing or unreadable file simply means no
 * notes (`null`).
 */
async function readNotes(repo: string, taskId: string): Promise<string | null> {
  const dir = path.dirname(await runsDir(repo, taskId));
  try {
    return await readFile(path.join(dir, "notes.md"), "utf8");
  } catch {
    return null;
  }
}

/**
 * 模型当前的笔记（`notes.md`）原文，没有则为 `null`。升级视图把它当作上一个模型“未经验证”的笔记；
 * 直接读文件而不是读刚写好的交还材料，升级材料才能只在切换真正成功之后才写。
 *
 * The model's live notes (`notes.md`), or null when absent. The escalation
 * view carries these as the previous model's unverified notes; reading them
 * directly (instead of through a just-written handback material) lets the
 * escalation write its material only after the switch actually succeeded.
 */
export async function readTaskNotes(repo: string, taskId: string): Promise<string | null> {
  return readNotes(repo, taskId);
}

/**
 * 取出标题为 `title` 的那一节正文（逐字），没有该标题时返回空串；小节范围到下一个同级或更高级的
 * 标题为止，正文首尾的空行去掉。
 *
 * Verbatim body of the notes section titled `title`, or "" when absent.
 */
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

/**
 * Markdown 标题行里的标题文本；不是标题时为 `null`。
 *
 * Title text of a markdown heading line; `null` when the line is not a heading.
 */
function headingTitle(line: string): string | null {
  const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
  return match === null ? null : match[2]!;
}

/**
 * 标题层级 1–6；不是标题时返回 7，好让「同级或更高级」的比较把小节收住。
 *
 * Heading level 1-6, or 7 for a non-heading so the "same or higher level"
 * comparison terminates a section.
 */
function headingLevel(line: string): number {
  const match = /^(#{1,6})\s/.exec(line);
  return match === null ? 7 : match[1]!.length;
}

/**
 * 把一条冻结冲突记录渲染成给用户看的问题文本；记录形状不符合预期时退化成 JSON，绝不因坏数据抛错。
 *
 * Renders one frozen-conflict record as a question for the user; a record of
 * unexpected shape degrades to JSON instead of throwing.
 */
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

/**
 * 把材料渲染成 `handback.md`，小节顺序固定：状态与原因、最后一次验证、模型笔记、需要人决定的问题、
 * 复现命令、未运行的检查、失败指纹历史、建议的下一轮。
 *
 * 环境变量按 key 排序输出，命令逐个参数做 JSON 转义，空的问题/检查/指纹列表写成「（无）」，
 * 笔记与「下一轮」按原文照抄。
 *
 * Renders the material as `handback.md` with a fixed section order: status and
 * reason, last verification, model notes, questions for a human, reproduce
 * command, checks that never ran, fingerprint history, and the suggested next
 * round.
 */
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
 * 读回当前的交还材料（`handback.json`）；缺失、符号链接、解析失败或不符合 schema 一律返回 `null`。
 *
 * 按设计尽力而为：调用方（resume 装饰）只把笔记当参考信息，绝不能因为读不到材料就让命令失败。
 *
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

/**
 * 原子写一个交还文件：先写同目录临时文件再 rename；目标若是符号链接就直接拒绝，不写到链接目标上。
 *
 * Atomically writes one handback file: temp file in the same directory, then
 * rename. A symlink target is refused outright rather than written through.
 */
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
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } finally {
    // This call's temp never outlives it: a failed rename (e.g. EISDIR)
    // leaves no .tmp behind, and a successful rename makes the rm a no-op.
    await rm(temporary, { force: true });
  }
}
