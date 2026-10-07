/**
 * `/cw` 命令族：注册命令并把子命令翻译成 core 调用，再渲染结果。命令由用户发起，
 * 可做先红确认、批准冻结、状态流转、交还与升级编排；所有判断都留在 core。
 *
 * The `/cw` command family: registers the command and translates subcommands
 * into core calls, then renders the results. Commands are user-initiated and
 * may run red confirmation, approval freezing, state transitions, handback,
 * and escalation orchestration; all judgment stays in core.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderTaskView } from "../../core/approve.js";
import { readProjectConfig, tierModel } from "../../core/config.js";
import { contractSha256, readContract } from "../../core/contract.js";
import { canonicalSha256 } from "../../core/canonical.js";
import { contentSha256, validatorInputFiles } from "../../core/evidence.js";
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

/**
 * 适配层注入给命令层的状态访问器：读写当前任务槽位、登记进行中的验证句柄，并在
 * 状态写入前终止验证。命令本身不持有会话状态，升级切换等对任务槽位的改动都经由它。
 *
 * Accessors the adapter injects into the command layer: read/replace the active
 * task slot, register the in-flight validation handle, and stop it before a
 * state write. Commands hold no session state of their own.
 */
export interface CommandRegistration {
  /** 本会话接管的任务；无则 null。 / The session's managed task; null when none. */
  getTask: () => ActiveTask | null;
  /** 替换或清空任务槽位。 / Replace or clear the task slot. */
  setTask: (task: ActiveTask | null) => void;
  /** 登记/清除进行中的验证句柄。 / Set/clear the in-flight validation handle. */
  setValidation: (handle: ValidationHandle | null) => void;
  /** 终止进行中的验证并等清理完成。 / Stop it and await cleanup; idempotent. */
  stopValidation: () => Promise<void>;
}

/** 契约 `tier` 字段的合法取值。 / The legal values of a contract's `tier` field. */
const TIERS: readonly Tier[] = ["script", "change", "interface"];

/** 参数不合法时展示的 `/cw task` 用法。 / Usage shown when `/cw task` arguments are invalid. */
const USAGE = "用法：/cw task new <slug> [--tier script|change|interface] | approve [task_id] | "
  + "resume <task_id> | status [task_id] | cancel [task_id] | handback [task_id] | "
  + "escalate [--from base|current]";

/**
 * 注册 `/cw` 命令并把各子命令分发给 taskNew / taskApprove 等实现；命令由用户
 * 发起，可用命令上下文的会话操作与 UI 对话框。所有判断（先红、证据有效性、
 * 状态流转）留在 core，本模块只按顺序调用 core 并渲染结果。
 *
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

/**
 * `/cw task new <slug> [--tier script|change|interface]`：在当前仓库创建
 * `drafting` 状态的任务；task_id 为 `YYYYMMDD-<slug>`，slug 只允许小写字母、
 * 数字和连字符。
 *
 * 前置检查按序执行，任一不满足即拒绝、不留半成品：必须是 git 仓库、工作树干净
 * （忽略 `.cw/`；仅 `git add` 不算干净）、至少有一个提交（用于记录
 * `base_commit`）、且当前目录不是 linked worktree（那里记录不了可靠基线，任务
 * 只在主检出创建）。通过后按档位从 `project.toml` 选定模型写入 `state.model`
 * （M7：会话接管时采用），并落一份占位符 `contract.toml`；任务停在 `drafting`，
 * 等用户填写后走 `/cw task approve`。检查性失败经 `ctx.ui.notify` 报告后返回，
 * 其它异常冒泡到命令处理器统一报错。
 *
 * Creates the `drafting` task for `/cw task new <slug> [--tier ...]`; the task
 * id is `<today>-<slug>` (lowercase letters, digits, hyphens only). Checks run
 * in order and any failure refuses without leaving a partial task: git repo,
 * clean worktree (`.cw/` ignored; `git add` alone does not count), at least
 * one commit to record as `base_commit`, and not a linked worktree (no
 * faithful baseline could be recorded there). On success the tier's model is
 * frozen into `state.model` (M7: adopted on takeover) and a placeholder
 * `contract.toml` is written; the task stays `drafting` until the user fills
 * it in and runs `/cw task approve`. Expected refusals notify and return;
 * other errors propagate to the command handler.
 */
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

/**
 * 新任务的 `contract.toml` 骨架：字段全部留空，`goal` 是 TODO 占位，行内注释
 * 说明每个字段。模板只是给用户的起点，approve 之前不参与任何校验；代码交付物
 * 必须填 acceptance 与 red。
 *
 * The `contract.toml` skeleton for a new task: every field is empty, `goal` is
 * a TODO placeholder, and inline comments explain each field. It is only a
 * starting point for the user and is parsed at approval — code deliverables
 * must fill in `acceptance` and `red`.
 */
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

/**
 * `/cw task approve [task_id]`：先红 → 用户确认 → 冻结哈希 → 写批准记录 →
 * 启动首轮；只接受 `drafting`/`handed_back` 状态的任务，linked worktree 里拒绝
 * 批准（升级交接在那边用 `/cw task resume`）。
 *
 * 顺序即契约：`code` 交付物先在 `base_commit` 的隔离基线上跑先红检查，运行无效
 * （undetermined）、先红判定未过、验收输入无法隔离，或宿主无交互界面（无法让
 * 用户确认失败原因）时一律拒绝，不写任何批准记录；用户确认失败原因与任务相符
 * 后才继续（非 `code` 交付物跳过这两步）。随后一次性冻结批准口径的哈希：基线
 * 验收输入的内容哈希、验证器命令引用到的仓库文件哈希（树哈希看不到 `.cw/`
 * 内的漂移，故单独冻结）、冻结文件的 git blob 哈希；任一缺失即拒绝。记录由
 * core 的 `writeApproval` 在同一任务锁内写入并再次核对契约未变；之后记
 * `approved` 计量事件、本会话接管任务（M7：应用批准模型）、追加任务视图并触发
 * 首轮。
 *
 * @remarks
 * 整个流程在验证槽位持有一个 AbortController：`/cw task cancel` 与会话关停可在
 * 先红、哈希、确认对话框、加锁写入任一窗口中止；每个阶段发布结果前都重查取消，
 * `done` 只在命令收尾时 resolve，保证取消方等这次回卷结束再改状态。写入后立刻
 * 被取消时不接管会话、不追加视图，由取消命令收敛状态。
 *
 * Approves a task: red check → user confirmation → hash freeze → approval
 * record → first turn. Only `drafting`/`handed_back` tasks are eligible, and
 * never inside a linked worktree (escalation handover resumes there).
 *
 * The order is the contract. A `code` deliverable first runs the red check on
 * an isolated baseline of `base_commit`; an invalid run (undetermined), a
 * failed red judgment, non-isolatable acceptance inputs, or a host without an
 * interactive UI (nobody could confirm the failures) all refuse without
 * writing anything — only a user confirmation that the failures match the
 * task lets the flow continue (non-code deliverables skip both steps). Then
 * the approval's hashes are frozen in one pass: content hashes of the
 * baseline acceptance inputs, hashes of the repo files the validator command
 * references (the tree hash never sees `.cw/` drift, so they are frozen
 * explicitly), and git blob hashes of the frozen files; a missing input
 * refuses. Core's `writeApproval` writes the record under the task lock,
 * re-checking that the contract did not change. The `approved` meter event,
 * session takeover (M7: apply the approved model), the task view, and the
 * first turn follow.
 *
 * @remarks
 * A controller stays in the validation slot for the whole flow: `/cw task
 * cancel` and session shutdown can abort it during the red check, hashing,
 * the confirmation dialog, or the locked write, and every stage re-checks the
 * signal before publishing anything. `done` resolves only when the command
 * finishes, so a cancel waits for this unwind before flipping the task state.
 * A cancel landing right after the record write skips session takeover; the
 * cancel command converges the state.
 */
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
    // Freeze the validator's own repo-referenced inputs (its script, often
    // `.cw/validate.sh`): the tree hash never sees drift under `.cw/`, so each
    // later validation re-checks these contents against the approved hashes.
    const validatorInputs: Record<string, string> = {};
    for (const input of await validatorInputFiles(repo, validator.cmd)) {
      const hash = await contentSha256(repo, input);
      if (hash === null) {
        ctx.ui.notify(`Counterweight: 验证器引用的仓库文件缺失，拒绝批准：${input}`, "error");
        return;
      }
      validatorInputs[input] = hash;
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
      validator_inputs_sha256: validatorInputs,
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

/**
 * 确认等待因取消而中止的哨兵值——这不是用户作答（既非确认也非拒绝）。
 *
 * The confirmation wait was cut short by cancellation, not answered by the user.
 */
const CONFIRM_CANCELLED = Symbol("cw-confirm-cancelled");

/**
 * 等待用户确认，可经 `signal` 取消：signal 既传给对话框（pi 原生关闭它），也与
 * 对话框 promise 竞速，因此即使某宿主模式从不 resolve 被关闭的对话框，批准流程
 * 也能解锁。对话框 promise 的异常被吞掉并计为“未确认”（绝不产生 unhandled
 * rejection），abort 监听器保证移除。
 *
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

/**
 * 拼出先红确认对话框的正文：逐条列出先红项在基线（含覆盖输入）上的失败——id、
 * 状态、截断到 300 字符的失败信息，并列出将覆盖到基线的文件；拿不到失败明细时
 * 退回打印先红项 ID。纯字符串拼接——失败原因是否与任务相符，由用户判断。
 *
 * Renders the red-confirmation dialog body: each red item's baseline failure
 * (status plus message truncated to 300 chars) and the files that will be
 * overlaid onto the baseline. Falls back to the red ids when no failure
 * detail exists. Pure string assembly — whether the failures match the task
 * is the user's call.
 */
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

/**
 * 等会话空闲后追加 ≤40 行的任务视图并发起本轮的第一次 agent turn（Pi 1.0：需
 * idle 且 `triggerTurn: true` 才会开跑——approve/resume 必须真正启动任务，而
 * 不只是装饰对话记录）。`notes`（升级恢复时）作为前一模型的未验证笔记并入，
 * 截断在同一行数上限内。
 *
 * Append the ≤40-line task view when the session is idle and start the first
 * agent turn on it (Pi 1.0: idle + `triggerTurn: true` appends the message and
 * runs a new LLM turn — approve/resume must actually start the task, not just
 * decorate the transcript). `notes` (escalation resume) rides along as the
 * previous model's unverified notes, truncated inside the same cap.
 */
async function appendTaskView(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, contract: Awaited<ReturnType<typeof readContract>>,
  approval: Approval, notes: string | null = null,
): Promise<void> {
  await ctx.waitForIdle();
  pi.sendMessage({
    customType: "counterweight",
    content: renderTaskView(contract, approval, notes),
    display: true,
  }, { triggerTurn: true });
}

// ---- /cw task resume -------------------------------------------------------

/**
 * `/cw task resume <task_id>`：把当前会话登记到已有任务并启动首轮；只有
 * `approved`/`running` 可恢复。任务账本可能在引用仓库（升级 worktree 场景，
 * 经 `.cw/task.json` 解析）。
 *
 * 只登记会话，不重建基线：`base_commit`、预算计数与已记录的验证证据保持原样，
 * 证据是否仍有效由 session_start 的复查重新判定。登记后本会话接管任务并
 * （M7）应用批准模型；若存在 `escalated`/`escalate_pending` 的交还材料，前一
 * 模型的笔记会以未验证标记随首个任务视图注入。
 *
 * Resumes an existing task into this session (`approved`/`running` only) and
 * starts the first turn; the ledger may live in a referenced repo (escalation
 * worktree, resolved via `.cw/task.json`). Registration alone: the baseline,
 * counters, and recorded evidence stay exactly as they are; `session_start`
 * re-verifies evidence. The session then takes the task over, applies the
 * approved model (M7), and the task view carries the previous model's
 * unverified notes when escalated/escalate_pending handback material exists.
 */
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

/**
 * `/cw task status [task_id]`：只读汇总状态、模型、预算用量、最后一次验证、
 * 冻结冲突与批准信息，绝不写文件。
 *
 * 不给 ID 时优先用本会话接管的任务；否则列出全部可管理任务，多于一个时只列
 * ID 与状态并要求指定；升级 worktree 里本目录没有任务时，回退到 `.cw/task.json`
 * 引用指向的唯一任务。契约或 `project.toml` 读不到时预算一行降级为“未知”，
 * 不让命令失败。
 *
 * Read-only summary: state, model, budget usage, last verification, freeze
 * conflicts, and approval info; never writes. Without an id it prefers the
 * session's active task, then lists the manageable tasks (ids only when
 * ambiguous) with the referenced task as fallback inside an escalation
 * worktree. Unreadable contract/project config degrade the budget line to
 * "unknown" instead of failing the command.
 */
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

/**
 * `/cw task cancel [task_id]`：把 `drafting`/`approved`/`running` 任务置为
 * `cancelled`。
 *
 * 先终止进行中的验证——它持有任务锁，且其进程组必须在状态写入前结束；随后用
 * 状态守卫式流转写入，已变成终态（如 `verified`）的任务不会被覆盖。若被取消的
 * 正是本会话接管的任务，同时清空会话的任务槽位。
 *
 * Cancels a task whose status is drafting/approved/running. Any in-flight
 * validation is stopped first (it holds the task lock and its process group
 * must be gone before the write), and the transition is status-guarded so a
 * task that meanwhile reached a terminal state is never overwritten. The
 * session's task slot is cleared when it was managing this very task.
 */
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

/**
 * `/cw task handback [task_id]`：用户手动交还（`approved`/`running` →
 * `handed_back`），生成 `handback.md` / `handback.json` 交还材料。
 *
 * 先终止进行中的验证；材料以 `manual` 原因、无提问、未自动验证写入。状态流转
 * 有守卫（已被取消的任务不会被改写）；只有交还的恰是本会话接管的任务时才清空
 * 任务槽位——显式交还别的任务不得解除当前任务的保护。
 *
 * Manual handback of an approved/running task, writing the handback material
 * with reason `manual` (the validation is stopped first). The state
 * transition is status-guarded, and only a handback of the session's own
 * task clears its slot — explicitly handing back another task must not
 * ungate the active one.
 */
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

/** `escalate` 参数不合法时的用法提示。 / Usage hint for invalid `escalate` arguments. */
const ESCALATE_USAGE = "用法：/cw task escalate [--from base|current]（默认 base）";

/**
 * 把任务交给更强模型的新会话执行；预算计数与修复计数不重置，升级也不追加预算。
 * 失败一致性：升级交还材料与计量事件只在交接真正落地后写入；被取消或失败的切换
 * 会在任务锁内回卷这次唯一的账本写入，不留材料、不留事件、不改会话与模型——
 * 绝不能伪造一次成功的升级。`--from base` 永远不声称升级完成：它的材料是
 * `escalate_pending`（等用户在新 worktree 手动交接）。
 *
 * `--from base`（默认）：在原始 `base_commit` 的 detached worktree 中恢复批准
 * 的验收输入，并写入指向唯一权威账本的引用。pi 的命令上下文无法在别的工作目录
 * 启动会话（`newSession` 没有 `cwd`），所以本命令不启动会话——它释放本会话的
 * 执行权（`state.model` 换为强模型、移除本会话）并提示用户到新 worktree 启动
 * pi 后 resume；worktree 创建后的任一步失败都会删掉 worktree、prune 并恢复旧
 * state（恢复也失败时提示人工核对 `state.json`）。`--from current`：在这里真正
 * 替换会话，新会话登记到同一账本、获得强模型，首个任务视图携带前一模型（未验证）
 * 的笔记；切换完全落地后才写材料与事件，任一步失败则回卷账本、尽力恢复会话模型，
 * 成功提示最后发。
 *
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
  // Pi 1.0 invalidates the old command context once newSession replaces the
  // session: every notification after that point goes through the fresh
  // ReplacedSessionContext, never through the stale one.
  const notes = await readTaskNotes(ledger, taskId);
  const view = renderTaskView(contract, approval, notes);
  const previousTask = registration.getTask();
  const previousModel = ctx.model;
  let switched = false;
  let failureNotified = false;
  let failure: string | null = null;
  let cancelled = false;
  let rollbackError: string | null = null;
  let modelSwitched = false;
  let modelNote: string | null = null;
  let replacedCtx: ExtensionCommandContext | null = null;
  try {
    const result = await ctx.newSession({
      withSession: async (newCtx) => {
        replacedCtx = newCtx;
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
            await newCtx.sendMessage({
              customType: "counterweight",
              content: view,
              display: true,
            }, { triggerTurn: false });
            switched = true;
            // Success toast LAST, after every fallible step: a lost toast
            // must never roll back (or lie about) the committed switch.
            try {
              newCtx.ui.notify(
                `Counterweight: 已切换到升级会话（任务 ${taskId}，模型 ${strong}）；`
                + `修复与预算计数保持不变。材料：.cw/tasks/${taskId}/handback.md`,
                "info",
              );
            } catch { /* notification must never mask the committed switch */ }
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
            // The old command context is stale after the switch; the fresh
            // replaced context is the valid channel for this report.
            failureNotified = notifyThrough(newCtx,
              `Counterweight: 升级未完成（切换失败：${failure ?? "unknown"}）；`
              + `未写升级材料与计量事件，任务账本已恢复原状；${modelNote ?? "会话模型已恢复"}${
                rollbackError === null
                  ? ""
                  : `；警告：账本恢复失败（${rollbackError}），请人工核对 .cw/tasks/${taskId}/state.json`}。`
              + `若当前会话已被替换，请用 /cw task resume ${taskId} 重新接管。`);
          }
        } catch (error) {
          // Failed before anything was mutated (model resolution or setModel).
          failure = error instanceof Error ? error.message : "unknown";
          failureNotified = notifyThrough(newCtx,
            `Counterweight: 升级未完成（切换失败：${failure ?? "unknown"}）；`
            + "会话模型未改动，任务账本未改动。");
        }
      },
    });
    cancelled = result.cancelled;
  } catch (error) {
    // newSession rejected before any replacement: the original context is
    // still valid and is the right channel.
    cancelled = true;
    failure = failure ?? (error instanceof Error ? error.message : "unknown");
  }
  if (!switched) {
    if (!failureNotified) {
      // Only reachable when withSession never ran (replacement cancelled or
      // rejected up front), so the original context is safe to use.
      ctx.ui.notify(
        `Counterweight: 升级未完成（${cancelled ? "会话替换被取消" : `切换失败：${failure ?? "unknown"}`}）；`
        + "未写升级材料与计量事件，任务账本未改动，会话模型未改动。",
        "error",
      );
    }
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
    notifyThrough(replacedCtx ?? ctx,
      `Counterweight: 会话已切换，但升级交还材料生成失败（${materialWarning}）；`
      + `账本与模型切换有效，请人工核对并补齐 .cw/tasks/${taskId}/handback.md。`,
      "warning");
  }
}

// ---- shared helpers --------------------------------------------------------

/**
 * 通过给定上下文发通知，并吞掉通道异常：丢一条通知绝不允许掩盖要报告的错误，
 * 也不允许在命令处理器里再抛异常。返回是否送达（调用方可忽略）。
 *
 * Notify through the given context, swallowing a broken channel: a lost
 * notification must never mask the reported failure or throw a second
 * exception through the command handler. Returns whether it landed.
 */
function notifyThrough(
  target: { ui: { notify: (message: string, type?: "error" | "info" | "warning") => void } },
  message: string,
  type: "error" | "warning" | "info" = "error",
): boolean {
  try {
    target.ui.notify(message, type);
    return true;
  } catch {
    return false;
  }
}

/**
 * 切换失败后把幸存会话的模型放回。pi 在上下文上保留切换前的模型（`ctx.model`，
 * 可能为 undefined），而 `setModel` 作用于当前会话，因此可以做尽力而为的恢复；
 * 恢复不了就如实返回一句说明，而不是声称回到了升级前状态。成功返回 null，否则
 * 返回人类可读的说明。
 *
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

/**
 * `.cw/task.json` 引用指向的任务 ID；没有引用（或引用不可读）时返回 null。
 *
 * The task id a `.cw/task.json` reference points at, or null when absent.
 */
async function referencedTaskId(workRoot: string): Promise<string | null> {
  try {
    const reference = await readReference(path.join(workRoot, REFERENCE_FILE));
    return reference.task_id;
  } catch {
    return null;
  }
}

/**
 * `taskId` 的权威账本所在仓库根：当前目录持有该任务时就是当前目录，否则取本
 * worktree 的 `.cw/task.json` 引用所指的账本（引用须指向同一任务）。两者都无法
 * 解析时返回 null 并已通知；任务路径存在但不是目录时也拒绝（防路径劫持）。
 *
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
 * 决定命令要操作的任务：给了显式 ID 就按其状态校验；否则取所请求状态集合中唯一
 * 的一个。没有匹配时回退到 `.cw/task.json` 引用的任务（升级 worktree 里唯一可见
 * 的候选）。歧义（多个候选）与缺失都报错返回 null，绝不猜测。
 *
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