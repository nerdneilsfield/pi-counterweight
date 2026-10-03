import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { parse } from "smol-toml";
import { rejectUnknown } from "./schema.js";
import type { ProjectConfig, Tier } from "./types.js";

const ModelName = Type.String({ minLength: 1, pattern: "^[^/\\s]+/[^/\\s]+$" });
const TierName = Type.Union([Type.Literal("cheap"), Type.Literal("medium"), Type.Literal("strong")]);

const projectSchema = Type.Object({
  version: Type.Literal(1),
  validator: Type.Object({
    cmd: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    timeout_s: Type.Optional(Type.Integer({ minimum: 1 })),
    env: Type.Optional(Type.Object({}, { additionalProperties: Type.String({ minLength: 0 }) })),
  }, { additionalProperties: false }),
  budget: Type.Optional(Type.Object({
    tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    wall_minutes: Type.Optional(Type.Integer({ minimum: 1 })),
    repairs: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false })),
  models: Type.Object({
    cheap: ModelName,
    medium: ModelName,
    strong: ModelName,
    explorer: ModelName,
  }, { additionalProperties: false }),
  tiers: Type.Object({
    script: TierName,
    change: TierName,
    interface: TierName,
  }, { additionalProperties: false }),
  observe: Type.Optional(Type.Object({
    versions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_REPAIRS = 3;
const DEFAULT_TOKENS = 2_000_000;
const DEFAULT_WALL_MINUTES = 90;

export async function readProjectConfig(path: string): Promise<ProjectConfig> {
  let parsed: unknown;
  try {
    parsed = parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`project.toml: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  rejectUnknown(projectSchema, parsed, "project.toml");
  const value = parsed as {
    validator: { cmd: string[]; timeout_s?: number; env?: Record<string, string> };
    budget?: { tokens?: number; wall_minutes?: number; repairs?: number };
    models: ProjectConfig["models"];
    tiers: ProjectConfig["tiers"];
    observe?: { versions?: string[] };
  };
  return {
    version: 1,
    validator: {
      cmd: value.validator.cmd,
      timeout_s: value.validator.timeout_s ?? DEFAULT_TIMEOUT_S,
      env: value.validator.env ?? {},
    },
    budget: {
      tokens: value.budget?.tokens ?? DEFAULT_TOKENS,
      wall_minutes: value.budget?.wall_minutes ?? DEFAULT_WALL_MINUTES,
      repairs: value.budget?.repairs ?? DEFAULT_REPAIRS,
    },
    models: value.models,
    tiers: value.tiers,
    observe: { versions: value.observe?.versions ?? [] },
  };
}

/** The `provider/model` string a task of `tier` runs on, per `[tiers]` → `[models]`. */
export function tierModel(project: ProjectConfig, tier: Tier): string {
  return project.models[project.tiers[tier]];
}
