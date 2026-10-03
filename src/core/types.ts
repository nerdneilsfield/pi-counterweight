export const TIERS = ["script", "change", "interface"] as const;
export const DELIVERABLES = ["code", "repro", "measurement", "diagnosis"] as const;
export const TASK_STATUSES = [
  "drafting", "approved", "running", "verified", "handed_back", "cancelled",
] as const;

export type Tier = (typeof TIERS)[number];
export type Deliverable = (typeof DELIVERABLES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface ValidatorConfig {
  cmd: string[];
  timeout_s: number;
  env: Record<string, string>;
}

export interface Budget {
  tokens: number;
  wall_minutes: number;
  repairs: number;
}

export interface ProjectConfig {
  version: 1;
  validator: ValidatorConfig;
  budget: Budget;
  models: { cheap: string; medium: string; strong: string; explorer: string };
  tiers: { script: TierModel; change: TierModel; interface: TierModel };
  /** Optional `[observe]` section; `versions` names `--version` probes for `cw observe`. */
  observe: { versions: string[] };
}

export type TierModel = "cheap" | "medium" | "strong";

export interface ApprovedFailure {
  id: string;
  reason: string;
}

export interface ContractBudget {
  tokens?: number;
  wall_minutes?: number;
  repairs?: number;
}

export interface Contract {
  version: 1;
  task_id: string;
  tier: Tier;
  deliverable: Deliverable;
  goal: string;
  non_goals: string[];
  acceptance: string[];
  red: string[];
  regression: string[];
  frozen: string[];
  interface: string[];
  baseline_inputs: string[];
  approved_failures: ApprovedFailure[];
  budget?: ContractBudget;
}

export interface LastVerified {
  run: number;
  tree: string;
  contract_sha256: string;
}

export interface TaskState {
  task_id: string;
  status: TaskStatus;
  model: string;
  /** Commit recorded by `/cw task new`; the red check always uses this baseline. */
  base_commit: string | null;
  repairs_used: number;
  tokens_used: number;
  wall_started_at: string | null;
  last_verified: LastVerified | null;
  evidence_invalid_reason: string | null;
  conflicts: unknown[];
  sessions: string[];
  version: 1;
}

export interface TaskReference {
  task_id: string;
  path: string;
}

export interface LockHolder {
  pid: number;
  session: string;
  acquired_at: string;
}

export type GitValue<T> = { supported: true; value: T } | { supported: false };
