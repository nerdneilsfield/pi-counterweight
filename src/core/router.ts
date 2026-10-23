/**
 * 审查闸门：先问 System One 决策模型（Jev、Ollama 的 nimble/tev1、OpenJev 都是同一个 `/v1/systemone` 接口）
 * “这次改动有没有问题”，概率够低就不起审查模型。任何失败（网络、超时、4xx/5xx、响应不合格式、缺 key）
 * 都当作“不放行”，让审查照常跑；闸门只能省调用，不能让审查少跑。
 *
 * Review gate: ask a System One decision model whether the change has a problem, and skip the
 * reviewer when that probability is low enough. Any failure counts as "do not skip".
 */
import type { RouterConfig } from "./config.js";

export type GateRole = "review" | "over_review";

const QUESTIONS: Record<GateRole, string> = {
  review: "这次改动是否存在行为错误：逻辑错误、被削弱的校验或错误处理、没有同步更新的调用方",
  over_review: "这次改动是否包含没有当前需求支撑的抽象、兜底分支、配置项、兼容层或多余的测试",
};

export interface GateVerdict {
  /** true：不起审查模型。 */
  skip: boolean;
  /** 模型给的“有问题”概率；请求失败时为 null。 */
  p: number | null;
  /** 判放行但被抽中审查。 */
  audited: boolean;
  error: string | null;
  ms: number;
}

export async function gate(
  router: RouterConfig, role: GateRole, state: string, signal?: AbortSignal,
  random: () => number = Math.random,
): Promise<GateVerdict> {
  const started = Date.now();
  const done = (v: Omit<GateVerdict, "ms">): GateVerdict => ({ ...v, ms: Date.now() - started });
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (router.api_key_env !== null) {
      const key = process.env[router.api_key_env];
      if (key === undefined || key === "") throw new Error(`环境变量 ${router.api_key_env} 为空`);
      headers.authorization = `Bearer ${key}`;
    }
    const timeout = AbortSignal.timeout(router.timeout_ms);
    const response = await fetch(router.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: router.model,
        state,
        questions: { problem: { type: "noul", instructions: QUESTIONS[role] } },
      }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { answers?: { problem?: { noul?: unknown } } };
    const p = payload.answers?.problem?.noul;
    if (typeof p !== "number" || !(p >= 0 && p <= 1)) throw new Error("响应里没有 0..1 的 noul");
    if (p > router.skip_below) return done({ skip: false, p, audited: false, error: null });
    const audited = random() < router.audit_rate;
    return done({ skip: !audited, p, audited, error: null });
  } catch (error) {
    return done({ skip: false, p: null, audited: false, error: error instanceof Error ? error.message : "未知错误" });
  }
}
