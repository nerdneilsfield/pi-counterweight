import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { renderTaskView } from "../../core/approve.js";
import { readProjectConfig } from "../../core/config.js";
import { contractSha256, readContract } from "../../core/contract.js";
import { canonicalSha256 } from "../../core/canonical.js";
import { contentSha256 } from "../../core/evidence.js";
import { blobHash, headCommit, isClean } from "../../core/gitstate.js";
import { writeHandback } from "../../core/handback.js";
import { CannotIsolateError, runRedCheck } from "../../core/redcheck.js";
import { assertTaskId } from "../../core/paths.js";
import {
  createTask,
  findTasksByStatus,
  readApproval,
  readState,
  updateState,
  writeApproval,
  type Approval,
} from "../../core/task.js";
import type { TaskState, Tier } from "../../core/types.js";
import { loadTask, type ActiveTask, type ValidationHandle } from "./index.js";

export interface CommandRegistration {
  getTask: () => ActiveTask | null;
  setTask: (task: ActiveTask | null) => void;
  setValidation: (handle: ValidationHandle | null) => void;
  stopValidation: () => Promise<void>;
}

const TIERS: readonly Tier[] = ["script", "change", "interface"];

const USAGE = "用法：/cw task new <slug> [--tier script|change|interface] | approve [task_id] | "
  + "resume <task_id> | status [task_id] | cancel [task_id] | handback [task_id]";

/**
 * The `/cw` command family. Commands are user-initiated: they may use the
 * command context's session operations and UI dialogs. All judgment (red
 * check, evidence validity, state transitions) stays in core; this module
 * only sequences core calls and renders results.
 */
export function registerCommands(pi: ExtensionAPI, registration: CommandRegistration): void {
  pi.registerCommand("cw", {
    description: "Counterweight 任务流程：new / approve / resume / status / cancel / handback",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter((token) => token !== "");
      try {
        if (tokens[0] !== "task") {
          ctx.ui.notify(`Counterweight: ${USAGE}`, "error");
          return;
        }
        switch (tokens[1]) {
          case "new": return await taskNew(ctx, tokens.slice(2));
          case "approve": return await taskApprove(pi, ctx, registration, tokens.slice(2));
          case "resume": return await taskResume(pi, ctx, registration, tokens[2]);
          case "status": return await taskStatus(ctx, registration, tokens[2]);
          case "cancel": return await taskCancel(ctx, registration, tokens[2]);
          case "handback": return await taskHandback(ctx, registration, tokens[2]);
          default:
            ctx.ui.notify(`Counterweight: ${USAGE}`, "error");
        }
      } catch (error) {
        ctx.ui.notify(`Counterweight: ${error instanceof Error ? error.message : "命令失败"}`, "error");
      }
    },
  });
}

// ---- /cw task new ----------------------------------------------------------

async function taskNew(ctx: ExtensionCommandContext, tokens: string[]): Promise<void> {
  const repo = ctx.cwd;
  const slug = tokens[0];
  if (slug === undefined || slug.startsWith("--")) {
    ctx.ui.notify(`Counterweight: ${USAGE}`, "error");
    return;
  }
  let tier: Tier = "change";
  for (let index = 1; index < tokens.length; index++) {
    if (tokens[index] === "--tier") {
      const value = tokens[index + 1] as Tier | undefined;
      if (value === undefined || !TIERS.includes(value)) {
        ctx.ui.notify("Counterweight: --tier 只接受 script、change 或 interface", "error");
        return;
      }
      tier = value;
      index++;
    } else {
      ctx.ui.notify(`Counterweight: 无法识别的参数 ${tokens[index]}`, "error");
      return;
    }
  }
  const now = new Date();
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const taskId = `${day}-${slug}`;
  try {
    assertTaskId(taskId);
  } catch {
    ctx.ui.notify(`Counterweight: slug 只能含小写字母、数字和连字符（得到 ${taskId}）`, "error");
    return;
  }
  const clean = await isClean(repo);
  if (!clean.supported) {
    ctx.ui.notify("Counterweight: 非 git 仓库，无法记录基线，未创建任务", "error");
    return;
  }
  if (!clean.value) {
    ctx.ui.notify(
      "Counterweight: 工作树不干净（忽略 .cw/）。请先提交或自行保存改动；仅 git add 不算干净。未创建任务。",
      "error",
    );
    return;
  }
  const head = await headCommit(repo);
  if (!head.supported || head.value === null) {
    ctx.ui.notify("Counterweight: 没有任何提交，无法记录 base_commit，未创建任务", "error");
    return;
  }
  const dir = await createTask(repo, taskId, "unassigned", head.value);
  await writeFile(path.join(dir, "contract.toml"), contractTemplate(taskId, tier));
  ctx.ui.notify(
    `Counterweight: 已创建任务 ${taskId}（drafting），base_commit ${head.value}。`
    + `请填写 .cw/tasks/${taskId}/contract.toml 后执行 /cw task approve。`,
    "info",
  );
}

function contractTemplate(taskId: string, tier: Tier): string {
  return `version = 1
task_id = "${taskId}"
tier = "${tier}"                       # script | change | interface
deliverable = "code"                   # code | repro | measurement | diagnosis
goal = "TODO：一句话说明本轮目标"
non_goals = []                         # 明确不做的事
acceptance = []                        # 本轮必须满足的条件 ID（代码任务必填）
red = []                               # 必须在原始基线失败的先红项（acceptance 子集，代码任务必填）
regression = []                        # 起点通过、必须保持通过的测试
frozen = []                            # 验收测试文件，批准后模型不可修改
interface = []                         # 可选：对外边界文件
baseline_inputs = []                   # 先红时覆盖到原始基线的验收文件/夹具/验证脚本
# approved_failures = [{ id = "已知失败 ID", reason = "另开任务处理" }]
`;
}

// ---- /cw task approve ------------------------------------------------------

async function taskApprove(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, registration: CommandRegistration, tokens: string[],
): Promise<void> {
  const repo = ctx.cwd;
  const session = ctx.sessionManager.getSessionId();
  const taskId = await pickTask(ctx, tokens[0], ["drafting", "handed_back"]);
  if (taskId === null) return;
  const state = await readState(repo, taskId);
  if (state.base_commit === null) {
    ctx.ui.notify("Counterweight: 任务没有记录 base_commit，无法批准（用 /cw task new 重建任务）", "error");
    return;
  }
  // The validator configuration is snapshotted up front: the red check and
  // the recorded approval both use this snapshot, so a project.toml edit
  // mid-approval cannot change what this task runs.
  const project = await readProjectConfig(path.join(repo, ".cw", "project.toml"));
  const validator = project.validator;
  const contract = await readContract(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), repo, taskId);

  let red: Awaited<ReturnType<typeof runRedCheck>> | null = null;
  if (contract.deliverable === "code") {
    try {
      red = await trackedRedCheck(registration, {
        repo, taskId, session, contract, validator, baseCommit: state.base_commit,
      });
    } catch (error) {
      if (error instanceof CannotIsolateError) {
        ctx.ui.notify(`Counterweight: 无法隔离验收输入与实现，拒绝批准：${error.message}`, "error");
        return;
      }
      throw error;
    }
    if (!red.valid) {
      ctx.ui.notify(
        `Counterweight: 先红检查运行无效（undetermined），拒绝批准：${red.validityReasons.join("；")}`,
        "error",
      );
      return;
    }
    if (!red.red.ok) {
      ctx.ui.notify(
        `Counterweight: 先红判定未通过，拒绝批准：${red.red.reasons.join("；")}`,
        "error",
      );
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Counterweight: 当前无交互界面，无法确认先红失败原因，拒绝批准。"
        + "请在交互模式（TUI 或 RPC）下执行 /cw task approve。",
        "error",
      );
      return;
    }
    const confirmed = await ctx.ui.confirm(
      "Counterweight 先红确认",
      renderRedConfirmation(contract, red.redFailures, red.baselineInputs),
    );
    if (!confirmed) {
      ctx.ui.notify("Counterweight: 用户未确认先红失败原因与任务相符，拒绝批准；契约保持可修改。", "warning");
      return;
    }
  }

  const baselineInputs: string[] = red !== null ? red.baselineInputs : contract.baseline_inputs;
  const inputHashes: Record<string, string> = {};
  for (const input of baselineInputs) {
    const hash = red !== null ? red.inputHashes[input]! : await contentSha256(repo, input);
    if (hash === undefined || hash === null) {
      ctx.ui.notify(`Counterweight: 基线验收输入缺失，拒绝批准：${input}`, "error");
      return;
    }
    inputHashes[input] = hash;
  }
  const frozenBlobs: Record<string, string> = {};
  for (const file of contract.frozen) {
    const blob = await blobHash(repo, file);
    if (!blob.supported) {
      ctx.ui.notify("Counterweight: 非 git 仓库无法冻结文件，拒绝批准", "error");
      return;
    }
    if (blob.value === null) {
      ctx.ui.notify(`Counterweight: 冻结文件缺失，拒绝批准：${file}`, "error");
      return;
    }
    frozenBlobs[file] = blob.value;
  }
  const approval: Approval = {
    version: 1,
    contract_sha256: contractSha256(contract),
    project_config_sha256: canonicalSha256(project),
    validator,
    base_commit: state.base_commit,
    baseline_inputs_sha256: inputHashes,
    frozen_blobs: frozenBlobs,
    red_check_run: red !== null ? red.run : 0,
    approved_at: new Date().toISOString(),
  };
  await writeApproval(repo, taskId, session, approval);
  registration.setTask(await loadTask(repo, taskId, session));
  await appendTaskView(pi, ctx, contract, approval);
  ctx.ui.notify(`Counterweight: 任务 ${taskId} 已批准，任务视图已追加到会话。`, "info");
}

/**
 * Run the red check with its validator registered in the adapter's validation
 * slot, so session shutdown and `/cw task cancel` terminate the process group
 * exactly like a gate validation.
 */
async function trackedRedCheck(
  registration: CommandRegistration,
  request: Parameters<typeof runRedCheck>[0],
): Promise<ReturnType<typeof runRedCheck>> {
  const controller = new AbortController();
  const run = runRedCheck({ ...request, signal: controller.signal });
  const handle: ValidationHandle = { controller, done: run.then(() => undefined, () => undefined) };
  registration.setValidation(handle);
  try {
    return await run;
  } finally {
    registration.setValidation(null);
  }
}

function renderRedConfirmation(
  contract: { red: string[] }, failures: Array<{ id: string; status: string; message: string }>,
  baselineInputs: string[],
): string {
  const lines = ["以下先红项在原始基线上失败，请确认失败原因与任务相符："];
  for (const failure of failures) {
    lines.push(`- ${failure.id}（${failure.status}）：${failure.message.slice(0, 300)}`);
  }
  if (failures.length === 0) lines.push(`- ${contract.red.join(", ")}`);
  lines.push("", "将覆盖到原始基线的文件（其余代码保持基线原样）：");
  for (const input of baselineInputs) lines.push(`- ${input}`);
  return lines.join("\n");
}

/** Append the ≤40-line task view when the session is idle; never mid-turn. */
async function appendTaskView(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, contract: Awaited<ReturnType<typeof readContract>>,
  approval: Approval,
): Promise<void> {
  await ctx.waitForIdle();
  pi.sendMessage({
    customType: "counterweight",
    content: renderTaskView(contract, approval),
    display: true,
  }, { triggerTurn: false });
}

// ---- /cw task resume -------------------------------------------------------

async function taskResume(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, registration: CommandRegistration, arg: string | undefined,
): Promise<void> {
  if (arg === undefined) {
    ctx.ui.notify(`Counterweight: ${USAGE}`, "error");
    return;
  }
  const repo = ctx.cwd;
  const session = ctx.sessionManager.getSessionId();
  const state = await readState(repo, arg);
  if (state.status !== "approved" && state.status !== "running") {
    ctx.ui.notify(`Counterweight: 任务 ${arg} 状态为 ${state.status}，只有 approved/running 可恢复`, "error");
    return;
  }
  // Resume only registers the session: the baseline, counters, and evidence
  // record stay exactly as they are; session_start re-verifies evidence.
  await updateState(repo, arg, session, (current) => current.sessions.includes(session)
    ? current
    : { ...current, sessions: [...current.sessions, session] });
  const task = await loadTask(repo, arg, session);
  registration.setTask(task);
  await appendTaskView(pi, ctx, task.contract, task.approval);
  ctx.ui.notify(`Counterweight: 会话已登记到任务 ${arg}；未重建基线。`, "info");
}

// ---- /cw task status -------------------------------------------------------

async function taskStatus(
  ctx: ExtensionCommandContext, registration: CommandRegistration, arg: string | undefined,
): Promise<void> {
  const repo = ctx.cwd;
  let taskId = arg;
  if (taskId === undefined) {
    const active = registration.getTask();
    if (active !== null) {
      taskId = active.taskId;
    } else {
      const all = await findTasksByStatus(repo, [
        "drafting", "approved", "running", "verified", "handed_back", "cancelled",
      ]);
      if (all.length === 0) {
        ctx.ui.notify("Counterweight: 没有任何任务；用 /cw task new 创建。", "info");
        return;
      }
      if (all.length > 1) {
        const lines: string[] = [];
        for (const id of all) {
          const state = await readState(repo, id);
          lines.push(`${id}：${state.status}`);
        }
        ctx.ui.notify(`Counterweight: 多个任务，指定 ID 查看详情：\n${lines.join("\n")}`, "info");
        return;
      }
      taskId = all[0]!;
    }
  }
  const state = await readState(repo, taskId);
  const lines = [
    `任务：${taskId}`,
    `状态：${state.status}`,
    `模型：${state.model}`,
    `base_commit：${state.base_commit ?? "无"}`,
    `会话：${state.sessions.length === 0 ? "无" : state.sessions.join(", ")}`,
  ];
  try {
    const contract = await readContract(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), repo, taskId);
    const project = await readProjectConfig(path.join(repo, ".cw", "project.toml"));
    const tokensBudget = contract.budget?.tokens ?? project.budget.tokens;
    const wallMinutes = contract.budget?.wall_minutes ?? project.budget.wall_minutes;
    const repairs = contract.budget?.repairs ?? project.budget.repairs;
    const wallUsed = state.wall_started_at === null
      ? 0
      : Math.floor((Date.now() - Date.parse(state.wall_started_at)) / 60_000);
    lines.push(
      `预算：修复 ${state.repairs_used}/${repairs} 次，token ${state.tokens_used}/${tokensBudget}，墙钟 ${wallUsed}/${wallMinutes} 分钟`,
    );
    lines.push(`验收项：${contract.acceptance.length} 项（先红 ${contract.red.length} 项）`);
  } catch {
    lines.push("预算：未知（契约或 project.toml 不可读）");
  }
  lines.push(state.last_verified === null
    ? `最后验证：无${state.evidence_invalid_reason === null ? "" : `（证据失效：${state.evidence_invalid_reason}）`}`
    : `最后验证：run ${state.last_verified.run}，tree ${state.last_verified.tree.slice(0, 12)}${
      state.evidence_invalid_reason === null ? "" : `（证据失效：${state.evidence_invalid_reason}）`}`);
  const conflicts = state.conflicts as Array<{ path?: unknown }>;
  lines.push(`冻结冲突：${state.conflicts.length} 处${
    state.conflicts.length === 0 ? "" : `（${conflicts.map((item) => String(item?.path ?? "?")).join(", ")}）`}`);
  try {
    const approval = await readApproval(repo, taskId);
    lines.push(`批准：${approval.approved_at}，先红 run ${approval.red_check_run}`);
  } catch {
    lines.push("批准：未批准");
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

// ---- /cw task cancel -------------------------------------------------------

async function taskCancel(
  ctx: ExtensionCommandContext, registration: CommandRegistration, arg: string | undefined,
): Promise<void> {
  const repo = ctx.cwd;
  const session = ctx.sessionManager.getSessionId();
  const taskId = await pickTask(ctx, arg, ["drafting", "approved", "running"]);
  if (taskId === null) return;
  // Abort any in-flight validation first: it holds the task lock, and its
  // process group must be gone before the status write.
  await registration.stopValidation();
  await updateState(repo, taskId, session, (current) => current.status === "drafting"
    || current.status === "approved" || current.status === "running"
    ? { ...current, status: "cancelled" }
    : current);
  const active = registration.getTask();
  if (active !== null && active.taskId === taskId) registration.setTask(null);
  ctx.ui.notify(`Counterweight: 任务 ${taskId} 已取消。`, "info");
}

// ---- /cw task handback -----------------------------------------------------

async function taskHandback(
  ctx: ExtensionCommandContext, registration: CommandRegistration, arg: string | undefined,
): Promise<void> {
  const repo = ctx.cwd;
  const session = ctx.sessionManager.getSessionId();
  const taskId = await pickTask(ctx, arg, ["approved", "running"]);
  if (taskId === null) return;
  await registration.stopValidation();
  const state = await readState(repo, taskId);
  if (state.status !== "approved" && state.status !== "running") {
    ctx.ui.notify(`Counterweight: 任务 ${taskId} 状态为 ${state.status}，只有 approved/running 可交还`, "error");
    return;
  }
  const contract = await readContract(path.join(repo, ".cw", "tasks", taskId, "contract.toml"), repo, taskId);
  const approval = await readApproval(repo, taskId);
  const material = await writeHandback(repo, taskId, session, {
    contract,
    validator: approval.validator,
    reason: "manual",
    questions: [],
    autoVerified: false,
  });
  await updateState(repo, taskId, session, (current) => current.status === "approved"
    || current.status === "running"
    ? { ...current, status: "handed_back" }
    : current);
  // Only drop the session's protection when the handed-back task is the one
  // this session manages; an explicit other-task handback must not ungate the
  // active task.
  const active = registration.getTask();
  if (active !== null && active.taskId === taskId) registration.setTask(null);
  ctx.ui.notify(`Counterweight: 任务 ${taskId} 已手动交还。材料：${material.md}`, "info");
}

// ---- shared helpers --------------------------------------------------------

/**
 * Resolve the task a command operates on: explicit id (status-checked), or
 * the session's active task, or the unique task in the requested states.
 * Ambiguity and absence are reported, never guessed.
 */
async function pickTask(
  ctx: ExtensionCommandContext, arg: string | undefined, statuses: TaskState["status"][],
): Promise<string | null> {
  const repo = ctx.cwd;
  if (arg !== undefined) {
    let state: TaskState;
    try {
      assertTaskId(arg);
      state = await readState(repo, arg);
    } catch (error) {
      ctx.ui.notify(`Counterweight: 任务 ${arg} 不存在或不可读（${
        error instanceof Error ? error.message : "unknown"}）`, "error");
      return null;
    }
    if (!statuses.includes(state.status)) {
      ctx.ui.notify(
        `Counterweight: 任务 ${arg} 状态为 ${state.status}，此命令需要 ${statuses.join("/")}`,
        "error",
      );
      return null;
    }
    return arg;
  }
  const matches = await findTasksByStatus(repo, statuses);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    ctx.ui.notify(`Counterweight: 没有状态为 ${statuses.join("/")} 的任务`, "error");
    return null;
  }
  ctx.ui.notify(`Counterweight: 多个候选任务 ${matches.join(", ")}，请指定任务 ID`, "error");
  return null;
}