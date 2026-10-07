/**
 * 共享类型词汇表：core 层与适配层共用的契约、任务状态与配置形状都在这里定义。
 *
 * Shared type vocabulary: the contract, task-state, and config shapes shared by
 * the core layer and its adapters. The module imports nothing, so it can never
 * create a dependency cycle.
 */

/**
 * 任务档位；决定任务跑在哪个模型上（经 `[tiers]` → `[models]`），在 `task new` 时定下。
 *
 * Task tiers. A tier selects the model a task runs on (`[tiers]` → `[models]`)
 * and is fixed when the task is created.
 */
export const TIERS = ["script", "change", "interface"] as const;

/**
 * 交付物类型；只有 `code` 会跑验证器与先红检查，其余类型在门禁处直接结束。
 *
 * Deliverable kinds. Only `code` runs the validator and the red check; every
 * other kind finishes at the gate without a validation run.
 */
export const DELIVERABLES = ["code", "repro", "measurement", "diagnosis"] as const;

/**
 * 任务生命周期状态；合法转移由 `task.ts` 把关，门禁只在 `approved`/`running` 时接管会话。
 *
 * Task lifecycle states. `task.ts` guards the transitions, and the gate only
 * steps in while a task is `approved` or `running`.
 */
export const TASK_STATUSES = [
  "drafting", "approved", "running", "verified", "handed_back", "cancelled",
] as const;

/** 任务档位的字面量联合 / Literal union of the task tiers. */
export type Tier = (typeof TIERS)[number];
/** 交付物类型的字面量联合 / Literal union of the deliverable kinds. */
export type Deliverable = (typeof DELIVERABLES)[number];
/** 任务状态的联合类型 / Literal union of the task statuses. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * 验证器配置：`cmd` 按 argv 直接 spawn（不经 shell），`timeout_s` 到点杀掉整个进程组，`env` 覆盖继承的环境变量。
 *
 * Validator configuration: `cmd` is spawned directly as argv (no shell),
 * `timeout_s` kills the whole process group when it elapses, and `env` overrides
 * the inherited environment.
 */
export interface ValidatorConfig {
  cmd: string[];
  timeout_s: number;
  env: Record<string, string>;
}

/**
 * 项目级预算上限（token、墙钟分钟、自动修复次数）；契约里同名字段可逐项覆盖。
 *
 * Project-level budget ceilings in tokens, wall-clock minutes, and automatic
 * repairs; a contract's `budget` overrides them field by field.
 */
export interface Budget {
  tokens: number;
  wall_minutes: number;
  repairs: number;
}

/**
 * `.cw/project.toml` 解析并补全默认值后的形状：`models` 是 provider/model 形式的模型名，`tiers` 把任务档位映射到其中的槽位。
 *
 * The shape of `.cw/project.toml` after defaults are filled in: `models` holds
 * `provider/model` names and `tiers` maps task tiers onto them. Approval records
 * the canonical hash, so any later drift makes the gate treat the task as
 * blocked instead of silently enforcing different rules.
 */
export interface ProjectConfig {
  version: 1;
  validator: ValidatorConfig;
  budget: Budget;
  models: { cheap: string; medium: string; strong: string; explorer: string };
  tiers: { script: TierModel; change: TierModel; interface: TierModel };
  /**
   * 可选 `[observe]` 段。
   *
   * Optional `[observe]` section; `versions` names `--version` probes for `cw observe`.
   */
  observe: { versions: string[] };
}

/**
 * `[models]` 里的三个档位槽位名；`[tiers]` 只能指向这三档。
 *
 * The three model slots in `[models]`; `[tiers]` can only point at these.
 */
export type TierModel = "cheap" | "medium" | "strong";

/**
 * 批准保留的失败：`id` 对应的检查允许持续失败，`reason` 是获批理由。
 *
 * An approved failure: the check `id` may keep failing, and `reason` records why
 * that was approved. Approved ids must not overlap `acceptance` and are exempt
 * from the required regression set.
 */
export interface ApprovedFailure {
  id: string;
  reason: string;
}

/** 契约级预算覆盖 / Per-contract budget overrides. */
export interface ContractBudget {
  tokens?: number;
  wall_minutes?: number;
  repairs?: number;
}

/**
 * 任务契约（`.cw/tasks/<id>/contract.toml`）：批准的对象，批准后按文本哈希锚定，改动会让已验证的证据失效。
 *
 * The task contract (`.cw/tasks/<id>/contract.toml`): what gets approved, and
 * afterwards a hashed, frozen object — editing it invalidates verified evidence.
 * The `frozen`, `interface`, and `baseline_inputs` path lists are normalized to
 * repo-relative form at parse time.
 */
export interface Contract {
  version: 1;
  task_id: string;
  tier: Tier;
  deliverable: Deliverable;
  goal: string;
  non_goals: string[];
  /** 必须通过的检查 id；`red` 必须是它的子集。 / Required check ids; `red` must be a subset. */
  acceptance: string[];
  /** 先红检查 id：修复前预期失败。 / Check ids expected to fail before the fix. */
  red: string[];
  /** 不得回退的检查 id；批准失败可豁免。 / Check ids that must not regress; approved failures are exempt. */
  regression: string[];
  /** 冻结文件，批准时锚定 git blob 哈希。 / Frozen files, anchored as git blob hashes at approval. */
  frozen: string[];
  /** 接口文件：受保护，不得直接编辑。 / Interface files: protected from direct edits. */
  interface: string[];
  /** 基线输入，每次验证前后重新哈希。 / Baseline inputs, re-hashed around every validation run. */
  baseline_inputs: string[];
  /** 批准保留的失败检查。 / Approved failures that may keep failing. */
  approved_failures: ApprovedFailure[];
  /** 本任务的预算覆盖，缺项继承项目配置。 / Per-task budget overrides; missing fields inherit. */
  budget?: ContractBudget;
}

/**
 * 最近一次通过验证的证据锚点：run 号、工作树哈希、当时的契约哈希。
 *
 * Evidence anchor of the last successful validation: the run number, the
 * worktree tree hash, and the contract hash at that moment. Any later drift
 * clears it (see `freeze.ts`), and the gate then treats the evidence as absent.
 */
export interface LastVerified {
  run: number;
  tree: string;
  contract_sha256: string;
}

/**
 * 任务账本（`.cw/tasks/<id>/state.json`）：门禁与 CLI 读取的唯一权威状态，每次修改都在任务锁内完成。
 *
 * The task ledger (`.cw/tasks/<id>/state.json`): the single authority the gate
 * and the CLI read. Every mutation happens under the task lock in `task.ts`.
 */
export interface TaskState {
  task_id: string;
  status: TaskStatus;
  model: string;
  /**
   * `task new` 记录的提交；先红检查始终以它为基线。
   *
   * Commit recorded by `/cw task new`; the red check always uses this baseline.
   */
  base_commit: string | null;
  /** 已用自动修复次数，与预算的 `repairs` 比较。 / Repairs spent so far, against the budget. */
  repairs_used: number;
  /** 累计 token 消耗，与预算上限比较。 / Accumulated token spend, compared with the budget ceiling. */
  tokens_used: number;
  /**
   * 首次进入 running 的 ISO 时间，墙钟预算从这里起算；任务未开始时为 null。
   *
   * ISO time when the task first started running; the wall-clock budget counts
   * from here, and it stays null until then.
   */
  wall_started_at: string | null;
  /** 最近一次通过验证的锚点；失效后为 null。 / Anchor of the last successful validation; null once invalidated. */
  last_verified: LastVerified | null;
  /**
   * 证据失效原因（树/契约/产物漂移、取消等）；证据仍有效时为 null。
   *
   * Why the evidence was invalidated (tree, contract, or artifact drift,
   * cancellation); null while it still stands.
   */
  evidence_invalid_reason: string | null;
  /**
   * 冻结冲突记录，形状由 `freeze.ts` 定义；这里用 `unknown` 保持词表模块零依赖。
   *
   * Frozen-conflict records owned by `freeze.ts`; typed `unknown` so this
   * vocabulary module stays dependency-free.
   */
  conflicts: unknown[];
  /** 登记到本任务的会话 id。 / Session ids registered to this task. */
  sessions: string[];
  version: 1;
}

/**
 * 指向权威任务目录的指针，写下它的位置（如升级 worktree）据此找到账本；读取时会 realpath 并校验任务目录身份。
 *
 * A pointer to the authority task directory, written where a session runs (an
 * escalation worktree, for example). On read the path is realpathed and its
 * authority re-checked, so a forged file cannot redirect the ledger.
 */
export interface TaskReference {
  task_id: string;
  path: string;
}

/**
 * 任务锁的持有者记录；用来报出"谁占着锁"，并避免回收仍存活进程的锁。
 *
 * Identity of a task-lock holder: reported when the lock is contended, and used
 * to avoid reclaiming a lock whose process is still alive.
 */
export interface LockHolder {
  pid: number;
  session: string;
  acquired_at: string;
}

/**
 * 需要 git 才能得到的量：非 git 工作树返回 `supported: false`，调用方必须把它当"无法判定"，而不是失败或通过。
 *
 * A value only git can provide. A non-git worktree yields `supported: false`,
 * which callers must treat as "cannot tell" — never as a failure or a pass.
 */
export type GitValue<T> = { supported: true; value: T } | { supported: false };
