import type { Verdict } from "./evidence.js";
import type { FrozenConflict } from "./freeze.js";
import type { Deliverable, TaskState } from "./types.js";

export type HandbackReason =
  | "blocked" | "budget" | "freeze_conflict" | "undetermined" | "repairs_exhausted";

export type Decision =
  | { kind: "cancel" }
  | { kind: "validate" }
  | { kind: "finish"; autoVerified: boolean }
  | { kind: "continue"; message: string; repairs_used: number }
  | { kind: "handback"; reason: HandbackReason };

/** One failed required check, as reported by the validator result. */
export interface GateFailure {
  id: string;
  message: string;
}

export interface GateInput {
  state: TaskState;
  deliverable: Deliverable;
  cancelled: boolean;
  /** Reason the model reported via `report_blocked`; null when it did not. */
  blockedReport: string | null;
  /** `repairs` is the approved repair budget from the contract/project config. */
  budget: { tokensExceeded: boolean; wallExceeded: boolean; repairs: number };
  freezeConflicts: readonly FrozenConflict[];
  /** Filled by the caller only after a validation run for this settle. */
  verdict?: Verdict;
  failures?: readonly GateFailure[];
  /** Full log path reported in the `continue` message. */
  logPath: string;
}

const MAX_FAILURES = 10;
const MAX_MESSAGE = 300;

/**
 * Fixed vocabulary the continue message must never carry, even when quoted
 * from validator output. Censoring is a pure string replace — no judgment
 * about what the text means.
 */
export const CONTINUE_FORBIDDEN = ["建议", "应该", "尝试", "下一步"] as const;

const forbiddenPattern = new RegExp(CONTINUE_FORBIDDEN.join("|"), "g");
const CENSOR = "□";

/** Deterministic censoring for validator-supplied dynamic fields. */
export function censorForbidden(text: string): string {
  return text.replace(forbiddenPattern, CENSOR);
}

/**
 * Gate decision for one `agent_before_settle`. Pure: reads only its input and
 * never touches state; persisting `repairs_used` and generating handback
 * material belong to the caller. The order below is the contract — earlier
 * branches win even when later ones would also apply.
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
