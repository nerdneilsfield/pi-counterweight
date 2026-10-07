/**
 * 读取并校验 `contract.toml`：先核对任务身份，再检查 id 唯一与 `red ⊆ acceptance` 等交叉规则，最后把路径列表归一为仓库内相对形式。
 *
 * Reads and validates a `contract.toml`: identity check first, then per-list id
 * uniqueness, `red ⊆ acceptance`, and the `code`-deliverable red-check
 * requirement, then normalization of the `frozen`, `interface`, and
 * `baseline_inputs` path lists. Anything that fails a rule throws — a contract
 * is fully accepted or fully rejected.
 */
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { parse } from "smol-toml";
import { canonicalSha256 } from "./canonical.js";
import { assertTaskId, repoPath } from "./paths.js";
import { rejectUnknown } from "./schema.js";
import type { Contract } from "./types.js";

const idList = Type.Array(Type.String({ minLength: 1 }));
/**
 * `contract.toml` 的校验模式：所有对象禁止未知字段；列表字段可省略，读取时补成空数组。
 *
 * The `contract.toml` schema. Every object forbids unknown keys; the id-list
 * fields may be omitted and default to `[]` when read. Cross-field rules such
 * as uniqueness and `red ⊆ acceptance` cannot live here and are enforced by
 * `validateContract`.
 */
const contractSchema = Type.Object({
  version: Type.Literal(1),
  task_id: Type.String({ minLength: 1 }),
  tier: Type.Union([Type.Literal("script"), Type.Literal("change"), Type.Literal("interface")]),
  deliverable: Type.Union([
    Type.Literal("code"), Type.Literal("repro"), Type.Literal("measurement"), Type.Literal("diagnosis"),
  ]),
  goal: Type.String({ minLength: 1 }),
  non_goals: Type.Optional(idList),
  acceptance: Type.Optional(idList),
  red: Type.Optional(idList),
  regression: Type.Optional(idList),
  frozen: Type.Optional(idList),
  interface: Type.Optional(idList),
  baseline_inputs: Type.Optional(idList),
  approved_failures: Type.Optional(Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }))),
  budget: Type.Optional(Type.Object({
    tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    wall_minutes: Type.Optional(Type.Integer({ minimum: 1 })),
    repairs: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

/**
 * 读取并校验某个任务的契约，返回归一化后的 `Contract`。
 *
 * Reads and validates one task's contract. When `expectedTaskId` is given, the
 * file's `task_id` must equal it, so a contract belonging to another task can
 * never be judged or approved under this task's directory. Missing list fields
 * default to `[]`, then `validateContract` verifies the cross-field rules and
 * normalizes the path lists on the returned object.
 *
 * @param path - `contract.toml` 的绝对路径 / Absolute path of the contract file.
 * @param repo - 仓库根，用于路径归一与逃逸拦截 / Repository root, used to normalize paths and block escapes.
 * @param expectedTaskId - 期望的 `task_id`；省略即跳过身份核对 / The expected task id; omit to skip the identity check.
 * @returns 交叉规则通过、路径已归一的契约 / The contract with rules satisfied and paths normalized.
 * @throws 文件不可读、schema 失败、`task_id` 不匹配或交叉规则不满足时 / On an unreadable
 * file, a schema failure, a `task_id` mismatch, or a cross-field violation.
 */
export async function readContract(path: string, repo: string, expectedTaskId?: string): Promise<Contract> {
  let parsed: unknown;
  try {
    parsed = parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`contract.toml: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  rejectUnknown(contractSchema, parsed, "contract.toml");
  const raw = parsed as Omit<Contract, "non_goals" | "acceptance" | "red" | "regression" | "frozen" | "interface" | "baseline_inputs" | "approved_failures"> & Partial<Contract>;
  // Approval identity boundary: a contract claiming another task's id must
  // never be judged or approved under this task's directory.
  if (expectedTaskId !== undefined && raw.task_id !== expectedTaskId) {
    throw new Error(`contract.toml: task_id mismatch ${raw.task_id} ≠ ${expectedTaskId}`);
  }
  const contract: Contract = {
    version: 1,
    task_id: raw.task_id,
    tier: raw.tier,
    deliverable: raw.deliverable,
    goal: raw.goal,
    non_goals: raw.non_goals ?? [],
    acceptance: raw.acceptance ?? [],
    red: raw.red ?? [],
    regression: raw.regression ?? [],
    frozen: raw.frozen ?? [],
    interface: raw.interface ?? [],
    baseline_inputs: raw.baseline_inputs ?? [],
    approved_failures: raw.approved_failures ?? [],
    ...(raw.budget === undefined ? {} : { budget: raw.budget }),
  };
  await validateContract(contract, repo);
  return contract;
}

/**
 * 校验契约的交叉规则，并**就地**把 `frozen`、`interface`、`baseline_inputs` 替换为归一后的仓库内相对路径；调用方必须传入自己拥有的对象。
 *
 * Cross-checks the contract's invariants and replaces its `frozen`,
 * `interface`, and `baseline_inputs` arrays with repo-relative paths in place.
 * Enforced rules: `task_id` is a real dated id; ids are unique per list;
 * approved failures must not overlap `acceptance`; `red ⊆ acceptance`; a `code`
 * deliverable needs non-empty `acceptance` and `red`. Only `baseline_inputs`
 * may point under `.cw`, and no list may reference the `.cw/tasks` ledger.
 *
 * @param contract - 待校验的契约，路径列表会被替换 / The contract to check; its path lists are replaced.
 * @param repo - 仓库根 / Repository root.
 * @throws 任一规则被违反或路径非法时 / When a rule is violated or a path is rejected.
 */
export async function validateContract(contract: Contract, repo: string): Promise<void> {
  assertTaskId(contract.task_id);
  unique("acceptance", contract.acceptance);
  unique("red", contract.red);
  unique("regression", contract.regression);
  unique("approved_failures", contract.approved_failures.map((item) => item.id));
  const approved = new Set(contract.approved_failures.map((item) => item.id));
  const overlap = contract.acceptance.find((id) => approved.has(id));
  if (overlap) throw new Error(`contract: acceptance overlaps approved failure ${overlap}`);
  const acceptance = new Set(contract.acceptance);
  const outside = contract.red.find((id) => !acceptance.has(id));
  if (outside) throw new Error(`contract: red is not a subset of acceptance ${outside}`);
  if (contract.deliverable === "code" && (contract.acceptance.length === 0 || contract.red.length === 0)) {
    throw new Error("contract: code deliverable requires non-empty acceptance and red");
  }
  contract.frozen = await canonicalize(repo, contract.frozen, false);
  contract.interface = await canonicalize(repo, contract.interface, false);
  contract.baseline_inputs = await canonicalize(repo, contract.baseline_inputs, true);
  unique("frozen", contract.frozen);
  unique("interface", contract.interface);
  unique("baseline_inputs", contract.baseline_inputs);
}

/**
 * 逐条经 `repoPath` 把路径归一为仓库内相对形式；任何一条非法（`..`、绝对路径、逃逸的符号链接等）都会让整份契约被拒。
 *
 * Normalizes each value through the `repoPath` guardrail; one illegal path
 * rejects the whole contract. `allowCwScript` permits `.cw` paths and is used
 * for baseline inputs only.
 */
async function canonicalize(repo: string, values: string[], allowCwScript: boolean): Promise<string[]> {
  const resolved: string[] = [];
  for (const value of values) resolved.push(await repoPath(repo, value, allowCwScript));
  return resolved;
}

/**
 * 契约的规范哈希：先按键排序再序列化，取 SHA-256；字段书写顺序不影响结果，任何语义改动都会改变摘要。
 *
 * The contract's canonical hash: keys are sorted before serialization, so the
 * digest is independent of field order and any semantic edit changes it.
 * Approval records this value and drift checks compare against it.
 *
 * @param contract - 待哈希的契约 / The contract to hash.
 * @returns 64 字符的小写十六进制摘要 / A 64-character lowercase hex digest.
 */
export function contractSha256(contract: Contract): string {
  return canonicalSha256(contract);
}

/**
 * 列表内部不允许重复 id，发现重复即抛错；`field` 只用于错误消息。
 *
 * Rejects duplicate ids within one list; `field` only names the list in the
 * error message.
 */
function unique(field: string, values: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`contract: duplicate ${field} ${value}`);
    seen.add(value);
  }
}
