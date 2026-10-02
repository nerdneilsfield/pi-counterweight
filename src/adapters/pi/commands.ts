import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderTaskView } from "../../core/approve.js";
import { readProjectConfig, tierModel } from "../../core/config.js";
import { contractSha256, readContract } from "../../core/contract.js";
import { canonicalSha256 } from "../../core/canonical.js";
import { contentSha256 } from "../../core/evidence.js";
import { EscalateError, REFERENCE_FILE, prepareBaseEscalation } from "../../core/escalate.js";
import { blobHash, headCommit, isClean, isLinkedWorktree, worktreePrune } from "../../core/gitstate.js";
import { writeHandback, readHandbackMaterial, readTaskNotes } from "../../core/handback.js";
import { recordTaskEvent } from "../../core/meter.js";
import { CannotIsolateError, runRedCheck } from "../../core/redcheck.js";
import { assertTaskId, isNotFound } from "../../core/paths.js";
import { rm } from "node:fs/promises";
import {
  createTask,
  findTasksByStatus,
  readApproval,
  readReference,
  readState,
  updateState,
  writeApproval,
  type Approval,
} from "../../core/task.js";
import type { TaskState, Tier } from "../../core/types.js";
import { applyTaskModel, loadTask, type ActiveTask, type ValidationHandle } from "./index.js";

export interface CommandRegistration {
  getTask: () => ActiveTask | null;
  setTask: (task: ActiveTask | null) => void;
  setValidation: (handle: ValidationHandle | null) => void;
  stopValidation: () => Promise<void>;
}

const TIERS: readonly Tier[] = ["script", "change", "interface"];

const USAGE = "用法：/cw task new <slug> [--tier script|change|interface] | approve [task_id] | "
  + "resume <task_id> | status [task_id] | cancel [task_id] | handback [task_id] | "
  + "escalate [--from base|current]";

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
          case "escalate": return await taskEscalate(pi, ctx, registration, tokens.slice(2));
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
  // M7: the tier's model is chosen now and becomes the task's authoritative
  // model (`state.model`); sessions adopt it when they take the task on.
  if (await isLinkedWorktree(repo)) {
    ctx.ui.notify("Counterweight: 当前目录是 git worktree，不能在这里创建任务；请在主检出运行 /cw task new", "error");
    return;
  }
  let project;
  try {
    project = await readProjectConfig(path.join(repo, ".cw", "project.toml"));
  } catch (error) {
    ctx.ui.notify(`Counterweight: project.toml 不可用，无法按档位选模型，未创建任务（${
      error instanceof Error ? error.message : "unreadable"}）`, "error");
    return;
  }
  const model = tierModel(project, tier);
  const dir = await createTask(repo, taskId, model, head.value);
  await writeFile(path.join(dir, "contract.toml"), contractTemplate(taskId, tier));
  ctx.ui.notify(
    `Counterweight: 已创建任务 ${taskId}（drafting），base_commit ${head.value}，模型 ${model}。`
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
  if (await isLinkedWorktree(repo)) {
    ctx.ui.notify("Counterweight: 当前目录是 git worktree，不能在这里批准任务；请在主检出运行 /cw task approve", "error");
    return;
  }
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

  // The approval's controller stays registered in the validation slot until
  // the whole flow commits or unwinds: `/cw task cancel` and session shutdown
  // abort it in every window — red check, hashing, confirmation dialog, the
  // locked approval write — and each stage re-checks it before publishing
  // anything. `done` resolves only when the command finishes, so a cancel
  // waits for this unwind before flipping the task state.
  const controller = new AbortController();
  let releaseDone!: () => void;
  const done = new Promise<void>((resolve) => { releaseDone = resolve; });
  registration.setValidation({ controller, done });
  let confirmWaitMs = 0;
  try {
    let red: Awaited<ReturnType<typeof runRedCheck>> | null = null;
    if (contract.deliverable === "code") {
      const run = runRedCheck({
        repo, taskId, session, contract, validator, baseCommit: state.base_commit,
        signal: controller.signal,
      });
      try {
        red = await run;
      } catch (error) {
        if (error instanceof CannotIsolateError) {
          ctx.ui.notify(`Counterweight: 无法隔离验收输入与实现，拒绝批准：${error.message}`, "error");
          return;
        }
        throw error;
      }
      if (controller.signal.aborted) {
        ctx.ui.notify("Counterweight: 用户已取消，拒绝批准；未写入任何批准记录。", "warning");
        return;
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
      // The signal both dismisses the dialog natively and races the wait; the
      // original dialog value is never treated as approval once cancelled.
      // The wait duration is recorded with the approval meter event.
      const confirmStarted = Date.now();
      const redFailures = red.redFailures;
      const overlayInputs = red.baselineInputs;
      const confirmed = await confirmCancellable(controller.signal, () => ctx.ui.confirm(
        "Counterweight 先红确认",
        renderRedConfirmation(contract, redFailures, overlayInputs),
        { signal: controller.signal },
      ));
      confirmWaitMs = Date.now() - confirmStarted;
      if (controller.signal.aborted) {
        ctx.ui.notify("Counterweight: 用户已取消，拒绝批准；未写入任何批准记录。", "warning");
        return;
      }
      if (confirmed !== true) {
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
    if (controller.signal.aborted) {
      ctx.ui.notify("Counterweight: 用户已取消，拒绝批准；未写入任何批准记录。", "warning");
      return;
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
    // The lock re-checks cancellation before and after the record write, so a
    // cancel in this window leaves no approval file and no proposal
    // consumption.
    await writeApproval(repo, taskId, session, approval, contract, () => controller.signal.aborted);
    if (controller.signal.aborted) {
      // The commit landed but a cancel is already pending: the cancel command
      // (waiting on this flow) will converge the state; skip session takeover
      // and the task view.
      ctx.ui.notify("Counterweight: 批准记录已写入，但任务随即被取消；任务视图未附加。", "warning");
      return;
    }
    await recordTaskEvent(repo, taskId, session, "approved", {
      contract_sha256: approval.contract_sha256,
      red_check_run: approval.red_check_run,
      confirm_wait_ms: confirmWaitMs,
    });
    const active = await loadTask(repo, repo, taskId, session);
    registration.setTask(active);
    // M7 adoption point: the session runs the task's approved model from now.
    await applyTaskModel(pi, ctx, active);
    await appendTaskView(pi, ctx, contract, approval);
    ctx.ui.notify(`Counterweight: 任务 ${taskId} 已批准，任务视图已追加到会话。`, "info");
  } finally {
    registration.setValidation(null);
    releaseDone();
  }
}

/** The confirmation wait was cut short by cancellation, not answered by the user. */
const CONFIRM_CANCELLED = Symbol("cw-confirm-cancelled");

/**
 * Wait for the user's confirmation, cancellable via `signal`. The signal is
 * passed to the dialog (Pi 1.0 dismisses it natively) and the dialog promise
 * is additionally raced against the signal, so the approval flow unblocks even
 * when a host mode never resolves a dismissed dialog. The dialog promise is
 * drained (errors count as "not confirmed") — never an unhandled rejection —
 * and the abort listener is always removed.
 */
async function confirmCancellable(
  signal: AbortSignal, confirm: () => Promise<boolean>,
): Promise<boolean | typeof CONFIRM_CANCELLED> {
  if (signal.aborted) return CONFIRM_CANCELLED;
  let onAbort!: () => void;
  const cancelledPromise = new Promise<typeof CONFIRM_CANCELLED>((resolve) => { onAbort = () => resolve(CONFIRM_CANCELLED); });
  const listener = () => { onAbort(); };
  signal.addEventListener("abort", listener, { once: true });
  try {
    const dialog: Promise<boolean | typeof CONFIRM_CANCELLED> = confirm().catch(() => false);
    return await Promise.race([dialog, cancelledPromise]);
  } finally {
    signal.removeEventListener("abort", listener);
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

/** Append the ≤40-line task view when the session is idle; never mid-turn.
 *  `notes` (escalation resume) rides along as the previous model's unverified
 *  notes, truncated inside the same cap. */
async function appendTaskView(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, contract: Awaited<ReturnType<typeof readContract>>,
  approval: Approval, notes: string | null = null,
): Promise<void> {
  await ctx.waitForIdle();
  pi.sendMessage({
    customType: "counterweight",
    content: renderTaskView(contract, approval, notes),
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
  const ledger = await resolveTaskRepo(ctx, arg);
  if (ledger === null) return;
  const state = await readState(ledger, arg);
  if (state.status !== "approved" && state.status !== "running") {
    ctx.ui.notify(`Counterweight: 任务 ${arg} 状态为 ${state.status}，只有 approved/running 可恢复`, "error");
    return;
  }
  // Resume only registers the session: the baseline, counters, and evidence
  // record stay exactly as they are; session_start re-verifies evidence.
  await updateState(ledger, arg, session, (current) => current.sessions.includes(session)
    ? current
    : { ...current, sessions: [...current.sessions, session] });
  const task = await loadTask(repo, ledger, arg, session);
  registration.setTask(task);
  // M7 adoption point: this session now runs the task's approved model.
  await applyTaskModel(pi, ctx, task);
  // An escalated task's resumed session carries the previous model's notes
  // in its first task view (marked unverified), per plan M7 — both the
  // completed (`escalated`) and the pending manual handover
  // (`escalate_pending`) variants.
  const material = await readHandbackMaterial(ledger, arg);
  const notes = material?.reason === "escalated" || material?.reason === "escalate_pending"
    ? material.notes
    : null;
  await appendTaskView(pi, ctx, task.contract, task.approval, notes);
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
        // Inside an escalation worktree the only visible task is the
        // referenced one.
        const referenced = await referencedTaskId(repo);
        if (referenced !== null) all.push(referenced);
      }
      if (all.length === 0) {
        ctx.ui.notify("Counterweight: 没有任何任务；用 /cw task new 创建。", "info");
        return;
      }
      if (all.length > 1) {
        const lines: string[] = [];
        for (const id of all) {
          const ledger = await resolveTaskRepo(ctx, id);
          const state = await readState(ledger ?? repo, id);
          lines.push(`${id}：${state.status}`);
        }
        ctx.ui.notify(`Counterweight: 多个任务，指定 ID 查看详情：\n${lines.join("\n")}`, "info");
        return;
      }
      taskId = all[0]!;
    }
  }
  const ledger = await resolveTaskRepo(ctx, taskId);
  if (ledger === null) return;
  const state = await readState(ledger, taskId);
  const lines = [
    `任务：${taskId}`,
    `状态：${state.status}`,
    `模型：${state.model}`,
    `base_commit：${state.base_commit ?? "无"}`,
    `会话：${state.sessions.length === 0 ? "无" : state.sessions.join(", ")}`,
  ];
  try {
    const contract = await readContract(path.join(ledger, ".cw", "tasks", taskId, "contract.toml"), ledger, taskId);
    const project = await readProjectConfig(path.join(ledger, ".cw", "project.toml"));
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
    const approval = await readApproval(ledger, taskId);
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
  const ledger = await resolveTaskRepo(ctx, taskId);
  if (ledger === null) return;
  await updateState(ledger, taskId, session, (current) => current.status === "drafting"
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
  const ledger = await resolveTaskRepo(ctx, taskId);
  if (ledger === null) return;
  const state = await readState(ledger, taskId);
  if (state.status !== "approved" && state.status !== "running") {
    ctx.ui.notify(`Counterweight: 任务 ${taskId} 状态为 ${state.status}，只有 approved/running 可交还`, "error");
    return;
  }
  const contract = await readContract(path.join(ledger, ".cw", "tasks", taskId, "contract.toml"), ledger, taskId);
  const approval = await readApproval(ledger, taskId);
  const material = await writeHandback(ledger, taskId, session, {
    contract,
    validator: approval.validator,
    reason: "manual",
    questions: [],
    autoVerified: false,
  });
  await updateState(ledger, taskId, session, (current) => current.status === "approved"
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

// ---- /cw task escalate -----------------------------------------------------

const ESCALATE_USAGE = "用法：/cw task escalate [--from base|current]（默认 base）";

/**
 * Hand the task to a stronger-model session. Budget counters and repair
 * counts are never reset and the escalation allocates no extra budget.
 *
 * Failure consistency: the escalation handback material and its meter events
 * are written ONLY after the handover actually landed. A cancelled or failed
 * switch rolls the single ledger write back under the task lock and leaves no
 * material, no event, and no session/model change — nothing that would fake a
 * successful escalation. `--from base` never claims a completed escalation at
 * all: its material is `escalate_pending` (manual handover in a new worktree).
 *
 * `--from base` (default): a detached worktree of the original base_commit
 * receives the approved acceptance inputs and a reference to the one
 * authoritative ledger. Pi 1.0's command context cannot start a session in
 * another working directory (`newSession` has no `cwd`), so this command does
 * NOT start the session — it releases this session's execution right and
 * tells the user to start Pi in the new worktree and resume.
 * `--from current`: the session is actually replaced here; the new session is
 * registered on the same ledger and gets the strong model plus a task view
 * that carries the previous model's (unverified) notes.
 */
async function taskEscalate(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, registration: CommandRegistration, tokens: string[],
): Promise<void> {
  let mode: "base" | "current" = "base";
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "--from") {
      const value = tokens[index + 1];
      if (value !== "base" && value !== "current") {
        ctx.ui.notify(`Counterweight: ${ESCALATE_USAGE}`, "error");
        return;
      }
      mode = value;
      index++;
    } else {
      ctx.ui.notify(`Counterweight: ${ESCALATE_USAGE}`, "error");
      return;
    }
  }
  const repo = ctx.cwd;
  const session = ctx.sessionManager.getSessionId();
  const taskId = await pickTask(ctx, undefined, ["approved", "running"]);
  if (taskId === null) return;
  const ledger = await resolveTaskRepo(ctx, taskId);
  if (ledger === null) return;
  await registration.stopValidation();
  const oldState = await readState(ledger, taskId);
  if (oldState.status !== "approved" && oldState.status !== "running") {
    ctx.ui.notify(`Counterweight: 任务 ${taskId} 状态为 ${oldState.status}，只有 approved/running 可升级`, "error");
    return;
  }
  const contract = await readContract(path.join(ledger, ".cw", "tasks", taskId, "contract.toml"), ledger, taskId);
  const approval = await readApproval(ledger, taskId);
  const project = await readProjectConfig(path.join(ledger, ".cw", "project.toml"));
  const strong = project.models.strong;
  const released = (current: TaskState): TaskState => ({
    ...current,
    model: strong,
    sessions: current.sessions.filter((item) => item !== session),
  });

  if (mode === "base") {
    let worktree: string;
    try {
      worktree = await prepareBaseEscalation({
        repo: ledger,
        taskId,
        session,
        baseCommit: approval.base_commit,
        inputs: contract.baseline_inputs,
        approvedInputHashes: approval.baseline_inputs_sha256,
      });
    } catch (error) {
      if (error instanceof EscalateError) {
        ctx.ui.notify(`Counterweight: 无法升级（--from base）：${error.message}`, "error");
        return;
      }
      throw error;
    }
    // The ledger transition is the commitment point; the pending-handover
    // material follows it and, if it fails, everything above is rolled back —
    // a half-released task with "ready to hand over" material must not exist.
    try {
      await updateState(ledger, taskId, session, released);
    } catch (error) {
      await rm(worktree, { recursive: true, force: true });
      await worktreePrune(ledger);
      throw error;
    }
    try {
      await writeHandback(ledger, taskId, session, {
        contract,
        validator: approval.validator,
        reason: "escalate_pending",
        questions: [
          `请在升级 worktree ${worktree} 启动新的 pi 会话（加载本扩展），执行 /cw task resume ${taskId}；`
            + `任务模型已切换为 ${strong}。`,
        ],
        autoVerified: false,
      });
    } catch (error) {
      // Material failure must not leave a released task advertised as ready:
      // restore the pre-escalation state, remove the worktree, rethrow.
      await rm(worktree, { recursive: true, force: true });
      await worktreePrune(ledger);
      try {
        await updateState(ledger, taskId, session, () => oldState);
      } catch (restoreError) {
        ctx.ui.notify(`Counterweight: 升级材料生成失败且账本恢复也失败，请人工核对 .cw/tasks/${taskId}/state.json（${
          restoreError instanceof Error ? restoreError.message : "unknown"}）`, "error");
      }
      throw error;
    }
    await recordTaskEvent(ledger, taskId, session, "escalate_target", {
      mode, worktree, model: strong,
    });
    if (registration.getTask()?.taskId === taskId) registration.setTask(null);
    ctx.ui.notify(
      `Counterweight: 任务 ${taskId} 升级材料已就绪（待手动交接）。Pi 无法跨目录替你启动新会话（newSession 无 cwd 参数），`
      + `请在 ${worktree} 启动新的 pi 并执行 /cw task resume ${taskId}（模型 ${strong}）。`
      + `原工作树未改动；修复与预算计数保持不变。材料：.cw/tasks/${taskId}/handback.md`,
      "info",
    );
    return;
  }

  // --from current: the session is really replaced; the ledger keeps one
  // registered session (the new one) and the strong model. The notes for the
  // first task view are read from notes.md up front, so the handback material
  // can be written only after the switch has fully landed. The session's
  // current model is captured too: a late failure must put the surviving
  // session's model back, not leave it silently on the strong model.
  const notes = await readTaskNotes(ledger, taskId);
  const view = renderTaskView(contract, approval, notes);
  const previousTask = registration.getTask();
  const previousModel = ctx.model;
  let switched = false;
  let failure: string | null = null;
  let cancelled = false;
  let rollbackError: string | null = null;
  let modelSwitched = false;
  let modelNote: string | null = null;
  try {
    const result = await ctx.newSession({
      withSession: async (newCtx) => {
        const newSession = newCtx.sessionManager.getSessionId();
        try {
          // Fallible, non-mutating steps first: the model switch either lands
          // or the ledger is never touched.
          const split = strong.indexOf("/");
          const model = split > 0
            ? newCtx.modelRegistry?.find(strong.slice(0, split), strong.slice(split + 1))
            : undefined;
          if (model === undefined) throw new Error(`模型 ${strong} 不在模型注册表中，未切换`);
          if (typeof pi.setModel !== "function") throw new Error("宿主未提供 setModel，未切换");
          if (!(await pi.setModel(model))) {
            throw new Error(`模型 ${strong} 的 provider 未配置认证，未切换`);
          }
          modelSwitched = true;
          try {
            await updateState(ledger, taskId, newSession, (current) => {
              const next = released(current);
              return next.sessions.includes(newSession)
                ? next
                : { ...next, sessions: [...next.sessions, newSession] };
            });
            const active = await loadTask(repo, ledger, taskId, newSession);
            registration.setTask(active);
            newCtx.ui.notify(
              `Counterweight: 已切换到升级会话（任务 ${taskId}，模型 ${strong}）；`
              + `修复与预算计数保持不变。材料：.cw/tasks/${taskId}/handback.md`,
              "info",
            );
            await newCtx.sendMessage({
              customType: "counterweight",
              content: view,
              display: true,
            }, { triggerTurn: false });
            switched = true;
          } catch (error) {
            failure = error instanceof Error ? error.message : "unknown";
            // Roll the single ledger write back so state matches the
            // pre-escalation task, and put the surviving session's model
            // back; nothing else was committed.
            try {
              await updateState(ledger, taskId, newSession, () => oldState);
            } catch (restoreIssue) {
              rollbackError = restoreIssue instanceof Error ? restoreIssue.message : "unknown";
            }
            if (modelSwitched) {
              modelNote = await restorePreviousModel(pi, previousModel, strong);
            }
            registration.setTask(previousTask);
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : "unknown";
        }
      },
    });
    cancelled = result.cancelled;
  } catch (error) {
    cancelled = true;
    failure = failure ?? (error instanceof Error ? error.message : "unknown");
  }
  if (!switched) {
    const reasonText = cancelled ? "会话替换被取消" : `切换失败：${failure ?? "unknown"}`;
    const modelText = modelSwitched
      ? `；${modelNote ?? "会话模型已恢复"}`
      : "；会话模型未改动";
    const rollbackText = rollbackError === null
      ? ""
      : `；警告：账本恢复失败（${rollbackError}），请人工核对 .cw/tasks/${taskId}/state.json`;
    ctx.ui.notify(
      `Counterweight: 升级未完成（${reasonText}）；未写升级材料与计量事件，任务账本已恢复原状${modelText}${rollbackText}。`
      + `若当前会话已被替换，请用 /cw task resume ${taskId} 重新接管。`,
      "error",
    );
    return;
  }
  // The switch fully landed: only now does the escalation material (with its
  // meter event) exist, so a failed switch can never leave success artifacts.
  let materialWarning: string | null = null;
  try {
    await writeHandback(ledger, taskId, session, {
      contract,
      validator: approval.validator,
      reason: "escalated",
      questions: [],
      autoVerified: false,
    });
  } catch (error) {
    materialWarning = error instanceof Error ? error.message : "unknown";
  }
  await recordTaskEvent(ledger, taskId, session, "escalate_target", { mode, model: strong });
  if (materialWarning !== null) {
    ctx.ui.notify(
      `Counterweight: 会话已切换，但升级交还材料生成失败（${materialWarning}）；`
      + `账本与模型切换有效，请人工核对并补齐 .cw/tasks/${taskId}/handback.md。`,
      "warning",
    );
  }
}

// ---- shared helpers --------------------------------------------------------

/**
 * Put the surviving session's model back after a failed switch. Pi 1.0 keeps
 * the previous model on the context (`ctx.model`, may be undefined) and
 * `setModel` acts on the current session, so a best-effort restore is
 * available; when it cannot run, the caller says so instead of claiming the
 * pre-escalation state. Returns null on success, else a human-readable note.
 */
async function restorePreviousModel(
  pi: ExtensionAPI, previousModel: ExtensionContext["model"], strong: string,
): Promise<string | null> {
  if (previousModel === undefined || previousModel === null) {
    return `切换前会话没有已设置的模型，无法恢复；当前会话模型仍为 ${strong}`;
  }
  if (typeof pi.setModel !== "function") {
    return `宿主未提供 setModel，无法恢复；当前会话模型仍为 ${strong}`;
  }
  try {
    const restored = await pi.setModel(previousModel);
    if (!restored) {
      return `模型恢复未生效（provider 认证缺失）；当前会话模型仍为 ${strong}`;
    }
    return null;
  } catch (error) {
    return `模型恢复失败（${error instanceof Error ? error.message : "unknown"}）；当前会话模型仍为 ${strong}`;
  }
}

/** The task id a `.cw/task.json` reference points at, or null when absent. */
async function referencedTaskId(workRoot: string): Promise<string | null> {
  try {
    const reference = await readReference(path.join(workRoot, REFERENCE_FILE));
    return reference.task_id;
  } catch {
    return null;
  }
}

/**
 * The repo root whose `.cw/tasks/<taskId>/` is the authoritative ledger for
 * `taskId`: the working directory itself when it holds the task, otherwise
 * the ledger referenced by this worktree's `.cw/task.json`. Null (reported)
 * when neither resolves.
 */
async function resolveTaskRepo(ctx: ExtensionCommandContext, taskId: string): Promise<string | null> {
  assertTaskId(taskId);
  const cwd = ctx.cwd;
  let stat;
  try {
    stat = await lstat(path.join(cwd, ".cw", "tasks", taskId));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    stat = undefined;
  }
  if (stat !== undefined) {
    if (!stat.isDirectory()) {
      ctx.ui.notify(`Counterweight: .cw/tasks/${taskId} 不是目录，拒绝操作`, "error");
      return null;
    }
    return cwd;
  }
  try {
    const reference = await readReference(path.join(cwd, REFERENCE_FILE));
    if (reference.task_id !== taskId) {
      ctx.ui.notify(
        `Counterweight: 本目录的引用指向任务 ${reference.task_id}，不是 ${taskId}`, "error");
      return null;
    }
    return path.resolve(reference.path, "..", "..", "..");
  } catch (error) {
    ctx.ui.notify(`Counterweight: 找不到任务 ${taskId}（本目录没有该任务，也没有有效的 .cw/task.json 引用：${
      error instanceof Error ? error.message : "unknown"}）`, "error");
    return null;
  }
}

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
    const ledger = await resolveTaskRepo(ctx, arg);
    if (ledger === null) return null;
    let state: TaskState;
    try {
      state = await readState(ledger, arg);
    } catch (error) {
      ctx.ui.notify(`Counterweight: 任务 ${arg} 不可读（${
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
    // Escalation worktree: the referenced task is the only candidate.
    const referenced = await referencedTaskId(repo);
    if (referenced !== null) {
      const ledger = await resolveTaskRepo(ctx, referenced);
      if (ledger !== null) {
        const state = await readState(ledger, referenced);
        if (statuses.includes(state.status)) return referenced;
        ctx.ui.notify(
          `Counterweight: 任务 ${referenced} 状态为 ${state.status}，此命令需要 ${statuses.join("/")}`,
          "error",
        );
        return null;
      }
    }
    ctx.ui.notify(`Counterweight: 没有状态为 ${statuses.join("/")} 的任务`, "error");
    return null;
  }
  ctx.ui.notify(`Counterweight: 多个候选任务 ${matches.join(", ")}，请指定任务 ID`, "error");
  return null;
}