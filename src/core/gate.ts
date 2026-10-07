/**
 * 门禁决策：把一次结算所需的事实收敛成唯一的下一个动作；本模块只做纯计算，不读写任何状态。
 *
 * The gate decision layer: the facts of one `agent_before_settle` are reduced to
 * a single next action. Everything here is pure computation — persisting
 * `repairs_used`, producing handback material, and stopping the session all
 * belong to the caller (the pi adapter).
 */
import type { Verdict } from "./evidence.js";
import type { FrozenConflict } from "./freeze.js";
import type { Deliverable, TaskState } from "./types.js";

/**
 * 交还原因：`blocked` 模型报告阻塞、`budget` 超 token/墙钟预算、`freeze_conflict` 冻结文件被改、
 * `undetermined` 证据无法判定、`repairs_exhausted` 自动修复用尽。
 *
 * Why a task was handed back: the model reported a blocker, a budget was
 * exceeded, a frozen file changed, the evidence could not be judged, or the
 * repair budget ran out. The reason string travels into the handback material.
 */
export type HandbackReason =
  | "blocked" | "budget" | "freeze_conflict" | "undetermined" | "repairs_exhausted";

/**
 * 一次结算的结论：取消 / 跑验证 / 结束 / 带事实继续修 / 交还。
 *
 * The outcome of one settle. `finish` carries `autoVerified: true` only when the
 * validator concluded `pass`; non-code deliverables finish unverified.
 * `continue` asks the caller to persist `repairs_used` and feed `message` back
 * to the model.
 */
export type Decision =
  | { kind: "cancel" }
  | { kind: "validate" }
  | { kind: "finish"; autoVerified: boolean }
  | { kind: "continue"; message: string; repairs_used: number }
  | { kind: "handback"; reason: HandbackReason };

/**
 * 验证器报告的一条失败的必要检查。
 *
 * One failed required check, as reported by the validator result.
 */
export interface GateFailure {
  id: string;
  message: string;
}

/**
 * 一次结算的全部输入事实，由适配层在 `agent_before_settle` 时收集；`decide` 只读这些字段。
 *
 * Every fact `decide` may look at for one settle, gathered by the adapter at
 * `agent_before_settle` time. A fact that was not collected must stay
 * distinguishable from a negative fact, which is why `verdict` is optional.
 */
export interface GateInput {
  state: TaskState;
  deliverable: Deliverable;
  cancelled: boolean;
  /**
   * 模型通过 `report_blocked` 报告的原因；没有报告时为 null。
   *
   * Reason the model reported via `report_blocked`; null when it did not.
   */
  blockedReport: string | null;
  /**
   * `repairs` 是契约/项目配置批准的自动修复预算；两个布尔由调用方与预算上限比较得出。
   *
   * `repairs` is the approved repair budget from the contract/project config.
   */
  budget: { tokensExceeded: boolean; wallExceeded: boolean; repairs: number };
  /** 最近一次冻结检查发现的冲突（含已记录的）。 / Conflicts from the last frozen check, recorded ones included. */
  freezeConflicts: readonly FrozenConflict[];
  /**
   * 调用方只在本轮跑过验证后填充；缺失表示"还没验"。
   *
   * Filled by the caller only after a validation run for this settle.
   */
  verdict?: Verdict;
  /** 本轮失败的必要检查，供继续消息列表用。 / Required checks that failed this round, for the continue message. */
  failures?: readonly GateFailure[];
  /**
   * `continue` 消息里给出的完整日志路径（本轮 run 的 stdout.log）。
   *
   * Full log path reported in the `continue` message.
   */
  logPath: string;
}

/** 继续消息里最多列出的失败项数 / Maximum failed checks listed in one continue message. */
const MAX_FAILURES = 10;
/** 单条失败消息的截断长度 / Truncation length for one failure message. */
const MAX_MESSAGE = 300;

/**
 * 继续消息里绝不能出现的固定词表，即使是从验证器输出里引用的也不行；审查只做纯字符串替换，不判断文本含义。
 *
 * Fixed vocabulary the continue message must never carry, even when quoted
 * from validator output. Censoring is a pure string replace — no judgment
 * about what the text means.
 */
export const CONTINUE_FORBIDDEN = ["建议", "应该", "尝试", "下一步"] as const;

const forbiddenPattern = new RegExp(CONTINUE_FORBIDDEN.join("|"), "g");
const CENSOR = "□";

/**
 * 对验证器提供的动态字段做确定性遮蔽：命中的词一律替换成 `□`，同一输入永远得到同一输出。
 *
 * Deterministic censoring for validator-supplied dynamic fields.
 */
export function censorForbidden(text: string): string {
  return text.replace(forbiddenPattern, CENSOR);
}

/**
 * 门禁决策：读入一次结算所需的事实，返回下一步动作；纯函数，不读写状态。
 *
 * 持久化 `repairs_used`、生成交还材料都由调用方负责。下面的分支顺序就是契约：靠前的分支先赢，即使后面的分支也成立。
 *
 * Gate decision for one `agent_before_settle`. Pure: reads only its input and
 * never touches state; persisting `repairs_used` and generating handback
 * material belong to the caller. The order below is the contract — earlier
 * branches win even when later ones would also apply.
 *
 * @param input - 一次结算的全部事实 / All facts gathered for a single settle.
 * @returns 下一步动作，由调用方落盘并执行 / The next action; the caller persists and executes it.
 * @remarks
 * 优先级：cancel > blocked > budget > freeze_conflict > 非 code 直接 finish > validate >
 * pass 结束 > undetermined 交还 > 未耗尽修复预算则 continue，否则 repairs_exhausted。
 * `undetermined` 绝不判通过。
 *
 * Priority: cancel > blocked > budget > freeze_conflict > non-code finish > validate >
 * pass finishes > undetermined hands back > continue while repairs remain, else
 * repairs_exhausted. `undetermined` never counts as a pass.
 */
export function decide(input: GateInput): Decision {
  if (input.cancelled) return { kind: "cancel" };
  if (input.blockedReport !== null && input.blockedReport.length > 0) {
    return { kind: "handback", reason: "blocked" };
  }
  if (input.budget.tokensExceeded || input.budget.wallExceeded) {
    return { kind: "handback", reason: "budget" };
  }
  if (input.freezeConflicts.length > 0) return { kind: "handback", reason: "freeze_conflict" };
  if (input.deliverable !== "code") return { kind: "finish", autoVerified: false };
  if (input.verdict === undefined) return { kind: "validate" };

  const verdict = input.verdict;
  if (verdict.conclusion === "pass") return { kind: "finish", autoVerified: true };
  if (verdict.conclusion === "undetermined") return { kind: "handback", reason: "undetermined" };

  const used = input.state.repairs_used;
  if (used < input.budget.repairs) {
    return {
      kind: "continue",
      message: continueMessage(input, used + 1),
      repairs_used: used + 1,
    };
  }
  return { kind: "handback", reason: "repairs_exhausted" };
}

/**
 * 只给事实：哪些必要检查失败（最多十条、消息截断）、以及完整日志路径；不写建议、猜测或"下一步"字样。
 *
 * 修复循环必须在模型拿不到更多事实时结束；`attempt` 是即将进行的第几次自动修复。
 *
 * Facts only: which required checks failed, at most ten, messages truncated,
 * plus the log path. No advice, speculation, or next-step wording — the fix
 * loop must end when the model runs out of facts.
 */
function continueMessage(input: GateInput, attempt: number): string {
  const lines = [
    `[counterweight] 验收未通过（第 ${attempt}/${input.budget.repairs} 次自动修复）`,
    "失败项：",
    ...failureItems(input).map((item) =>
      `- ${censorForbidden(item.id)}: ${truncate(censorForbidden(item.message), MAX_MESSAGE)}`),
    `完整日志：${censorForbidden(input.logPath)}`,
  ];
  return lines.join("\n");
}

/**
 * 选出要列出的失败项：优先用验证器报告的 `failures`，没有时退回 verdict 的 `reasons`（此时没有消息文本）；两者都截到 `MAX_FAILURES`。
 *
 * The failures to list: the validator-reported `failures` when present, else the
 * verdict's `reasons` with empty messages. Both are capped at `MAX_FAILURES`.
 */
function failureItems(input: GateInput): GateFailure[] {
  if (input.failures !== undefined && input.failures.length > 0) {
    return input.failures.slice(0, MAX_FAILURES);
  }
  return (input.verdict?.reasons ?? [])
    .slice(0, MAX_FAILURES)
    .map((reason) => ({ id: reason, message: "" }));
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
