/**
 * 读取并校验 `.cw/project.toml`：`[check]` 结束检查、`[protect]` 受保护路径、`[models]` 五个角色。
 * 文件和每个小节都可选。解析或校验失败一律抛错，不返回半套配置。
 * 旧的 `[explorer]`、`[observe]` 是未知字段，会让整份配置失败，检查和保护一起停。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { parse } from "smol-toml";
import { isNotFound, relativeParts } from "./paths.js";
import { rejectUnknown } from "./schema.js";

/** 结束检查：`cmd` 按 argv 直接 spawn，不经 shell。 */
export interface CheckConfig {
  cmd: string[];
  timeout_s: number;
  env: Record<string, string>;
}

export interface RoleModels {
  explorer: string | null;
  review: string | null;
  over_review: string | null;
  research: string | null;
  historian: string | null;
}

export interface ProjectConfig {
  version: 1;
  /** 结束检查；未配置时为 null。 */
  check: CheckConfig | null;
  /** 受保护路径，仓库内相对路径或目录前缀。 */
  protect: { paths: string[] };
  /**
   * 五个角色的模型。没配的为 null，对应工具调用时返回不可用。
   * 值是 `provider/model`，只按第一个斜杠分，model 里可以再有斜杠。
   */
  models: RoleModels;
}

/**
 * `provider/model`：第一个斜杠分开两边，model 里可以再有斜杠，两侧非空，不含空白。
 * Pi 也是按第一个斜杠切的。
 */
const ModelName = Type.String({ minLength: 1, pattern: "^[^/\\s]+/[^\\s]+$" });

const projectSchema = Type.Object({
  version: Type.Literal(1),
  check: Type.Optional(Type.Object({
    cmd: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    timeout_s: Type.Optional(Type.Integer({ minimum: 1 })),
    env: Type.Optional(Type.Object({}, { additionalProperties: Type.String({ minLength: 0 }) })),
  }, { additionalProperties: false })),
  protect: Type.Optional(Type.Object({
    paths: Type.Array(Type.String({ minLength: 1 })),
  }, { additionalProperties: false })),
  models: Type.Optional(Type.Object({
    explorer: Type.Optional(ModelName),
    review: Type.Optional(ModelName),
    over_review: Type.Optional(ModelName),
    research: Type.Optional(ModelName),
    historian: Type.Optional(ModelName),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const DEFAULT_TIMEOUT_S = 600;

/** 文件不存在返回 null。存在但不可读或非法时抛错。 */
export async function loadProjectConfig(repo: string): Promise<ProjectConfig | null> {
  let text: string;
  try {
    text = await readFile(path.join(repo, ".cw", "project.toml"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new Error(`project.toml: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  return parseProjectConfig(text);
}

export function parseProjectConfig(text: string): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(`project.toml: ${error instanceof Error ? error.message : "unparsable"}`);
  }
  rejectUnknown(projectSchema, parsed, "project.toml");
  const value = parsed as {
    check?: { cmd: string[]; timeout_s?: number; env?: Record<string, string> };
    protect?: { paths: string[] };
    models?: { explorer?: string; review?: string; over_review?: string; research?: string; historian?: string };
  };
  return {
    version: 1,
    check: value.check === undefined ? null : {
      cmd: value.check.cmd,
      timeout_s: value.check.timeout_s ?? DEFAULT_TIMEOUT_S,
      env: value.check.env ?? {},
    },
    protect: { paths: (value.protect?.paths ?? []).map(normalizeProtectedPath) },
    models: {
      explorer: value.models?.explorer ?? null,
      review: value.models?.review ?? null,
      over_review: value.models?.over_review ?? null,
      research: value.models?.research ?? null,
      historian: value.models?.historian ?? null,
    },
  };
}

/** 去掉 `./` 和结尾 `/`。拒绝空路径、通配符、绝对路径、`..` 和 `.cw` 下的路径。 */
function normalizeProtectedPath(value: string): string {
  let normalized = value;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized === "") throw new Error(`project.toml: protect.paths 为空路径 ${value}`);
  if (normalized.includes("*")) throw new Error(`project.toml: protect.paths 不支持通配符 ${value}`);
  try {
    relativeParts(normalized);
  } catch (error) {
    throw new Error(`project.toml: protect.paths 非法路径 ${value}（${
      error instanceof Error ? error.message : "无效"}）`);
  }
  if (normalized === ".cw" || normalized.startsWith(".cw/")) {
    throw new Error(`project.toml: protect.paths 不接受 .cw 下的路径 ${value}`);
  }
  return normalized;
}
