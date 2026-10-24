/**
 * 读取并校验 `.cw/project.toml`：`[check]` 结束检查、`[protect]` 受保护路径、`[models]` 六个角色、`[timeouts]` 各角色的超时、`[auto]` 强制启用、`[router]` 审查闸门。
 * 文件和每个小节都可选。解析或校验失败一律抛错，不返回半套配置。
 * 旧的 `[explorer]`、`[observe]` 是未知字段，会让整份配置失败，检查和保护一起停。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
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
  /** 首次改源码前出一次修复计划的无工具角色；没配就不介入。 */
  planner: string | null;
}

/**
 * 各角色子进程在“调用方没传 timeout_s”时的超时，秒。没写的角色用内置默认（research 1800，其余 300）。
 * 工具调用自己传 `timeout_s`（300–1800）时以调用方为准；自动运行（[auto]）和 PAUSE 没有调用方，只看这里。
 * 到点整个进程组被终止，工具返回“超时”并给出下一档。
 */
export type RoleTimeouts = Partial<Record<keyof RoleModels, number>>;

/**
 * 哪些角色由扩展强制启用，而不是等模型自己想起来调用。每一项要求对应的 `[models]` 角色已配置，
 * 否则加载期报错。默认全为 false：不写 `[auto]` 时行为和以前完全一致。
 */
export interface AutoConfig {
  /** 每次正常结束时，对本会话的改动自动跑 review 与 over_review。 */
  review: boolean;
  /** 每次正常结束时，自动把本轮摘要交给史官。 */
  chronicle: boolean;
  /** 每个用户回合第一次改源码前，自动让 planner 出一次计划。 */
  pause: boolean;
}

/**
 * Jev 这类决策模型（System One 接口）的端点，给 cw_review / cw_over_review 当闸门。
 * `api_key_env` 是存 key 的环境变量名，本地无需鉴权的服务可不设。
 * 三个数值的默认值是起点，不是实测结论；要靠 `.cw/meter.jsonl` 里的 gate 事件校准。
 */
export interface RouterConfig {
  url: string;
  api_key_env: string | null;
  model: string;
  /** 请求超时，毫秒。 */
  timeout_ms: number;
  /** 模型判“有问题”的概率不高于它才放行（不起审查模型）。 */
  skip_below: number;
  /** 判放行后仍随机抽这个比例去跑审查，用来量漏判。 */
  audit_rate: number;
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
  /** 各角色子进程的超时（秒），没写的角色用默认。 */
  timeouts: RoleTimeouts;
  /** 强制启用哪些角色。 */
  auto: AutoConfig;
  /** 审查闸门用的决策模型；未配置为 null，review / over_review 不预判。 */
  router: RouterConfig | null;
}

/**
 * 配置的 JSON Schema，直接写字面量而不用 `Type` 构造器：OMP 把 `typebox` 换成自己的 shim，
 * shim 会丢掉 `pattern`，导致 `provider/model` 的校验静默失效。
 * `provider/model`：第一个斜杠分开两边，model 里可以再有斜杠，两侧非空，不含空白。Pi 也是按第一个斜杠切的。
 *
 * The config as a literal JSON Schema, not `Type` builders: OMP swaps `typebox` for a shim
 * that drops `pattern`, which silently disables the `provider/model` check.
 */
const ModelName = { type: "string", minLength: 1, pattern: "^[^/\\s]+/[^\\s]+$" };

const projectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: {
    version: { const: 1 },
    check: {
      type: "object",
      additionalProperties: false,
      required: ["cmd"],
      properties: {
        cmd: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        timeout_s: { type: "integer", minimum: 1 },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    protect: {
      type: "object",
      additionalProperties: false,
      required: ["paths"],
      properties: { paths: { type: "array", items: { type: "string", minLength: 1 } } },
    },
    router: {
      type: "object",
      additionalProperties: false,
      required: ["url", "model"],
      properties: {
        url: { type: "string", pattern: "^https?://[^\\s]+$" },
        api_key_env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        model: { type: "string", minLength: 1 },
        timeout_ms: { type: "integer", minimum: 1 },
        skip_below: { type: "number", minimum: 0, maximum: 1 },
        audit_rate: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    models: {
      type: "object",
      additionalProperties: false,
      properties: {
        explorer: ModelName,
        review: ModelName,
        over_review: ModelName,
        research: ModelName,
        historian: ModelName,
        planner: ModelName,
      },
    },
    timeouts: {
      type: "object",
      additionalProperties: false,
      properties: {
        explorer: { type: "integer", minimum: 300, maximum: 1800 },
        review: { type: "integer", minimum: 300, maximum: 1800 },
        over_review: { type: "integer", minimum: 300, maximum: 1800 },
        research: { type: "integer", minimum: 300, maximum: 1800 },
        historian: { type: "integer", minimum: 300, maximum: 1800 },
        planner: { type: "integer", minimum: 300, maximum: 1800 },
      },
    },
    auto: {
      type: "object",
      additionalProperties: false,
      properties: {
        review: { type: "boolean" },
        chronicle: { type: "boolean" },
        pause: { type: "boolean" },
      },
    },
  },
};

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
    router?: {
      url: string; api_key_env?: string; model: string;
      timeout_ms?: number; skip_below?: number; audit_rate?: number;
    };
    models?: {
      explorer?: string; review?: string; over_review?: string; research?: string;
      historian?: string; planner?: string;
    };
    timeouts?: RoleTimeouts;
    auto?: { review?: boolean; chronicle?: boolean; pause?: boolean };
  };
  const models = {
    explorer: value.models?.explorer ?? null,
    review: value.models?.review ?? null,
    over_review: value.models?.over_review ?? null,
    research: value.models?.research ?? null,
    historian: value.models?.historian ?? null,
    planner: value.models?.planner ?? null,
  };
  const auto = {
    review: value.auto?.review ?? false,
    chronicle: value.auto?.chronicle ?? false,
    pause: value.auto?.pause ?? false,
  };
  // 强制启用却没配模型是配置错误：加载期就说出来，不要到运行时才静默不工作。
  const missing = [
    auto.review && (models.review === null || models.over_review === null)
      ? "auto.review 需要 models.review 与 models.over_review" : null,
    auto.chronicle && models.historian === null ? "auto.chronicle 需要 models.historian" : null,
    auto.pause && models.planner === null ? "auto.pause 需要 models.planner" : null,
  ].filter((item): item is string => item !== null);
  if (missing.length > 0) throw new Error(`project.toml: ${missing.join("；")}`);
  return {
    version: 1,
    check: value.check === undefined ? null : {
      cmd: value.check.cmd,
      timeout_s: value.check.timeout_s ?? DEFAULT_TIMEOUT_S,
      env: value.check.env ?? {},
    },
    protect: { paths: (value.protect?.paths ?? []).map(normalizeProtectedPath) },
    models,
    timeouts: { ...value.timeouts },
    auto,
    router: value.router === undefined ? null : {
      url: value.router.url,
      api_key_env: value.router.api_key_env ?? null,
      model: value.router.model,
      timeout_ms: value.router.timeout_ms ?? 5000,
      skip_below: value.router.skip_below ?? 0.1,
      audit_rate: value.router.audit_rate ?? 0.1,
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
