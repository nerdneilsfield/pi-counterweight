/**
 * 读取并校验 `.cw/project.toml`（轻量版）：`[check]` 结束检查、`[protect]` 受保护路径、
 * `[explorer]` 探索者模型、`[observe]` 版本探测。整个文件与每个小节都是可选的——
 * 没有配置文件时扩展完全被动。解析或校验失败一律抛错，绝不返回半套配置。
 *
 * Reads and validates `.cw/project.toml` (lite): `[check]` end-of-turn check,
 * `[protect]` protected paths, `[explorer]` explorer model, `[observe]`
 * version probes. The file and every section are optional — without a config
 * the extension is fully passive. Parse and validation failures throw, so no
 * caller ever sees a half-validated config.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { parse } from "smol-toml";
import { isNotFound, relativeParts } from "./paths.js";
import { rejectUnknown } from "./schema.js";

/**
 * 结束检查配置：`cmd` 按 argv 直接 spawn（不经 shell），`timeout_s` 到点杀掉整个进程组，`env` 覆盖继承的环境变量。
 *
 * End-check configuration: `cmd` is spawned directly as argv (no shell),
 * `timeout_s` kills the whole process group when it elapses, and `env`
 * overrides the inherited environment.
 */
export interface CheckConfig {
  cmd: string[];
  timeout_s: number;
  env: Record<string, string>;
}

/**
 * `.cw/project.toml` 校验并补全默认值后的形状。
 *
 * The shape of `.cw/project.toml` after validation and default filling.
 * `check` and `explorer` are null when their section is absent.
 */
export interface ProjectConfig {
  version: 1;
  /** 结束检查；未配置时为 null，扩展在该项上完全被动。 / The end check; null when not configured. */
  check: CheckConfig | null;
  /** 受保护路径（仓库内相对路径或目录前缀）。 / Protected repo-relative paths or directory prefixes. */
  protect: { paths: string[] };
  /** 探索者模型；未配置时 `cw_explore` 不可用。 / Explorer model; `cw_explore` is unavailable without it. */
  explorer: { model: string } | null;
  /** `cw observe` 的版本探测命令 / Version probes for `cw observe`. */
  observe: { versions: string[] };
}

/**
 * `provider/model` 形式的模型名：恰好一个斜杠、两侧非空、不含空白字符。
 *
 * Model names are `provider/model`: exactly one slash, non-empty on both sides,
 * no whitespace.
 */
const ModelName = Type.String({ minLength: 1, pattern: "^[^/\\s]+/[^/\\s]+$" });

/**
 * `.cw/project.toml` 的校验模式：所有对象都禁止未知字段，拼错键名会直接报错而不是被忽略。
 *
 * The `.cw/project.toml` schema. Every nested object forbids additional
 * properties, so a misspelled key fails validation instead of being ignored.
 */
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
  explorer: Type.Optional(Type.Object({
    model: ModelName,
  }, { additionalProperties: false })),
  observe: Type.Optional(Type.Object({
    versions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

/** `[check] timeout_s` 缺省值 / Default for `[check] timeout_s`. */
const DEFAULT_TIMEOUT_S = 600;

/**
 * 读取 `repo/.cw/project.toml`；文件不存在时返回 null（扩展保持被动），存在但不可读或非法时抛错。
 *
 * Reads `repo/.cw/project.toml`: a missing file yields null (the extension
 * stays passive), while an unreadable or invalid file throws.
 *
 * @param repo - 仓库根 / Repository root.
 * @returns 补全默认值的配置，或 `null` / The config with defaults filled in, or `null`.
 * @throws 文件存在但不可读、TOML 解析失败或不符合 schema 时 / When the file exists but is unreadable, unparsable, or invalid.
 */
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

/**
 * 解析并校验 project.toml 文本；受保护路径在这里就被规范化，非法路径在加载时就失败，而不是在拦截时静默失效。
 *
 * Parses and validates project.toml text. Protected paths are normalized here,
 * so an invalid path fails at load time instead of silently disabling the
 * guard later.
 */
function parseProjectConfig(text: string): ProjectConfig {
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
    explorer?: { model: string };
    observe?: { versions?: string[] };
  };
  return {
    version: 1,
    check: value.check === undefined ? null : {
      cmd: value.check.cmd,
      timeout_s: value.check.timeout_s ?? DEFAULT_TIMEOUT_S,
      env: value.check.env ?? {},
    },
    protect: { paths: (value.protect?.paths ?? []).map(normalizeProtectedPath) },
    explorer: value.explorer ?? null,
    observe: { versions: value.observe?.versions ?? [] },
  };
}

/**
 * 规范化一条受保护路径：去掉 `./` 前缀与结尾 `/`，拒绝空路径、通配符、`..`/绝对路径与 `.cw` 下的路径。
 *
 * Normalizes one protected path: strips a `./` prefix and trailing slashes,
 * and rejects empty paths, glob wildcards, `..` or absolute paths, and
 * anything under `.cw` (the harness owns that directory).
 *
 * @throws 路径不合法时，消息以 `project.toml:` 开头 / When the path is invalid; the message starts with `project.toml:`.
 */
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
