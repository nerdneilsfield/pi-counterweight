import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { parse } from "smol-toml";
import { canonicalSha256 } from "./canonical.js";
import { assertTaskId, repoPath } from "./paths.js";
import { rejectUnknown } from "./schema.js";
import type { Contract } from "./types.js";

const idList = Type.Array(Type.String({ minLength: 1 }));
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

export async function readContract(path: string, repo: string): Promise<Contract> {
  let parsed: unknown;
  try {
    parsed = parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`contract.toml: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  rejectUnknown(contractSchema, parsed, "contract.toml");
  const raw = parsed as Omit<Contract, "non_goals" | "acceptance" | "red" | "regression" | "frozen" | "interface" | "baseline_inputs" | "approved_failures"> & Partial<Contract>;
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

export async function validateContract(contract: Contract, repo: string): Promise<void> {
  assertTaskId(contract.task_id);
  unique("acceptance", contract.acceptance);
  unique("red", contract.red);
  unique("regression", contract.regression);
  unique("frozen", contract.frozen);
  unique("interface", contract.interface);
  unique("baseline_inputs", contract.baseline_inputs);
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
  for (const item of [...contract.frozen, ...contract.interface]) await repoPath(repo, item, false);
  for (const item of contract.baseline_inputs) await repoPath(repo, item, true);
}

export function contractSha256(contract: Contract): string {
  return canonicalSha256(contract);
}

function unique(field: string, values: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`contract: duplicate ${field} ${value}`);
    seen.add(value);
  }
}
