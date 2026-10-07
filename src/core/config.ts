/**
 * 读取并校验 `.cw/project.toml`，为可选字段补上默认值；解析或校验失败一律抛错，调用方拿不到半套配置。
 *
 * Reads and validates `.cw/project.toml` and fills defaults for its optional
 * fields. Parse and validation failures throw, so no caller ever sees a
 * half-validated config; `provider/model` model names are checked by the schema
 * before anything else can use them.
 */
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { parse } from "smol-toml";
import { rejectUnknown } from "./schema.js";
import type { ProjectConfig, Tier } from "./types.js";

/**
 * `provider/model` 形式的模型名：恰好一个斜杠、两侧非空、不含空白字符。
 *
 * Model names are `provider/model`: exactly one slash, non-empty on both sides,
 * no whitespace.
 */
const ModelName = Type.String({ minLength: 1, pattern: "^[^/\\s]+/[^/\\s]+$" });
/**
 * `[tiers]` 可指向的三个模型槽位；`explorer` 槽位不参与任务档位映射。
 *
 * The three model slots `[tiers]` may point at; the `explorer` slot is not a
 * valid tier target.
 */
const TierName = Type.Union([Type.Literal("cheap"), Type.Literal("medium"), Type.Literal("strong")]);

/**
 * `.cw/project.toml` 的校验模式：所有对象都禁止未知字段，拼错键名会直接报错而不是被忽略。
 *
 * The `.cw/project.toml` schema. Every nested object forbids additional
 * properties, so a misspelled key fails validation instead of being ignored.
 */
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

/**
 * 可选字段缺省时使用的默认值：验证器超时秒数与三项预算上限；`??` 回退保留显式零值，例如 `repairs: 0`。
 *
 * Defaults applied when the optional fields are omitted: the validator timeout
 * and the three budget ceilings. The `??` fallback keeps explicit falsy values
 * such as `repairs: 0`.
 */
const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_REPAIRS = 3;
const DEFAULT_TOKENS = 2_000_000;
const DEFAULT_WALL_MINUTES = 90;

/**
 * 读取并校验 `.cw/project.toml`，返回补全默认值后的 `ProjectConfig`。
 *
 * Reads and validates `.cw/project.toml`, returning a `ProjectConfig` with
 * every optional field filled in. The file is parsed as TOML, checked against
 * `projectSchema` (unknown keys are rejected), then narrowed to the config
 * shape; unreadable files and parse failures surface as one
 * `project.toml: <reason>` error.
 *
 * @param path - `.cw/project.toml` 的绝对路径 / Absolute path of `.cw/project.toml`.
 * @returns 可选字段已补齐的配置 / The config with defaults filled in.
 * @throws 文件不可读或不符合 schema 时 / When the file is unreadable or fails schema validation.
 */
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

/**
 * 任务档位 `tier` 实际运行的 `provider/model` 模型名，按 `[tiers]` → `[models]` 映射。
 *
 * The `provider/model` string a task of `tier` runs on, per `[tiers]` → `[models]`.
 */
export function tierModel(project: ProjectConfig, tier: Tier): string {
  return project.models[project.tiers[tier]];
}
