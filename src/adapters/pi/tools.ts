/**
 * 五个只读角色工具。没配模型的角色仍注册，调用时返回错误。
 * 史官（cw_chronicle）的子进程同样只读，文档由本模块写入 `.cw/HISTORY.md`。
 * 用量记入 `.cw/meter.jsonl`；记账失败不丢已经拿到的回答。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectConfig } from "../../core/config.js";
import { writeCwFile } from "../../core/cwfile.js";
import { recordEvent, recordUsage } from "../../core/meter.js";
import { gate } from "../../core/router.js";
import { rolePromptPath, type RoleName } from "../../roles/prompts.js";
import { clampTimeoutS, MAX_TIMEOUT_S, MIN_TIMEOUT_S, nextTimeoutS, roleTimeoutMs, runRole } from "../../roles/run.js";

/**
 * 超时后给调用方的下一步：翻倍重试，封顶 1800；已经用满 1800 就别再加，该拆小输入。
 * 写在返回文本里，调用方不用记规则。
 */
function timeoutAdvice(tool: string, usedMs: number): string {
  const next = nextTimeoutS(usedMs);
  return next === null
    ? `已经用满 ${MAX_TIMEOUT_S} 秒上限，再加没有用：把输入拆小（分文件、分提交）后再调用 ${tool}。`
    : `下一档：用 timeout_s=${next} 重新调用 ${tool}（每次翻倍，上限 ${MAX_TIMEOUT_S}）。`;
}

/** 记账只需要会话 id，所以结算时的 ExtensionContext 也能用。 */
export interface SessionCtx {
  sessionManager: { getSessionId(): string };
}

export interface ToolRegistration {
  getProject: () => ProjectConfig | null;
  getRepo: () => string | null;
  /** 测试用：覆盖 pi CLI。 */
  cliPath?: string;
  /** 测试用：覆盖该角色的超时。 */
  timeoutMs?: Partial<Record<RoleName, number>>;
  /** 测试用：只压短真实等待（毫秒），申报的档位和“下一档”建议仍按调用方给的 timeout_s 算。 */
  realWaitMs?: number;
}

const ROLES: Array<{
  name: RoleName;
  tool: string;
  label: string;
  description: string;
  input: "question" | "review" | "report";
}> = [
  {
    name: "explorer",
    tool: "cw_explore",
    label: "探索代码",
    description: "把一个代码问题交给只读探索者。它只有 read 和 grep，返回带来源的结论。不做修改。",
    input: "question",
  },
  {
    name: "review",
    tool: "cw_review",
    label: "正确性审查",
    description: "把这次的要求和 diff 交给只读审查。它只报行为错误和被削弱的真实边界，不报缺测试、不提重构、不改文件。信息不够时返回 ASK 开头的问题，补充到 request 后重新调用。",
    input: "review",
  },
  {
    name: "over_review",
    tool: "cw_over_review",
    label: "过度工程审查",
    description: "把这次的要求和 diff 交给只读审查。它只报没资格留下的抽象、兜底、多余测试和防御性分支，不评对错、不改文件。信息不够时返回 ASK 开头的问题，补充到 request 后重新调用。",
    input: "review",
  },
  {
    name: "research",
    tool: "cw_research",
    label: "研究问题",
    description: "把主模型读代码仍定不下来的问题交给只读研究角色。结论在前，没读到的标未核实。不实现。",
    input: "question",
  },
  {
    name: "historian",
    tool: "cw_chronicle",
    label: "汇报给史官",
    description: "把阶段性成果汇报给史官（提交、决定、子 agent 的发现），它重写 .cw/HISTORY.md。写不下去时返回 ASK 开头的问题，由你回答后再汇报。",
    input: "report",
  },
];

const HISTORY_FILE = "HISTORY.md";

/**
 * OMP 专用的工具字段，pi 不认也不读。OMP 默认把扩展工具放进“可发现”层，模型在顶层看不到；
 * 默认审批级别是 exec，每次调用都可能弹确认。五个角色子进程都只读，只有史官的结果会写 `.cw/HISTORY.md`。
 *
 * OMP-only tool fields that pi ignores. OMP hides extension tools in a "discoverable" tier by default
 * and approves at the exec tier, so each call may prompt. The roles are read-only children; only the
 * historian's result is written to `.cw/HISTORY.md`.
 */
const ompHints = (tool: string) => ({ loadMode: "essential", approval: tool === "cw_chronicle" ? "write" : "read" });

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: undefined };
}

/**
 * 并发汇报排队：史官每次重写整份文档，并行会互相覆盖。模型自己调 `cw_chronicle` 和结算时自动汇报
 * 走同一条队列，所以放在模块级。
 */
let chronicleTail: Promise<unknown> = Promise.resolve();
export function queueChronicle<T>(turn: () => Promise<T>): Promise<T> {
  const next = chronicleTail.then(turn);
  chronicleTail = next.catch(() => undefined);
  return next;
}

export function registerTools(pi: ExtensionAPI, registration: ToolRegistration): void {
  for (const role of ROLES) {
    // 每个工具都带一个可选的 timeout_s：调用方按输入大小估。不传用默认，最短 300，最长 1800。
    const timeoutField = {
      timeout_s: Type.Optional(Type.Integer({
        minimum: MIN_TIMEOUT_S, maximum: MAX_TIMEOUT_S,
        description: `本次调用的超时秒数（${MIN_TIMEOUT_S}–${MAX_TIMEOUT_S}，越界会被夹住）。按输入大小估：小输入不传，用默认 ${MIN_TIMEOUT_S}；明显很大（长 diff、跨很多文件）就先设长一些。超时后返回里会给下一档（每次翻倍），照着重试；已到 ${MAX_TIMEOUT_S} 还超时就拆小输入，别再加。`,
      })),
    };
    const parameters = role.input === "question"
      ? Type.Object({ question: Type.String({ minLength: 1 }), ...timeoutField }, { additionalProperties: false })
      : role.input === "report"
      ? Type.Object({ report: Type.String({ minLength: 1 }), ...timeoutField }, { additionalProperties: false })
      : Type.Object({
          request: Type.String({ minLength: 1 }),
          diff: Type.String({ minLength: 1 }),
          ...timeoutField,
        }, { additionalProperties: false });
    pi.registerTool({
      name: role.tool,
      label: role.label,
      description: role.description,
      parameters,
      ...ompHints(role.tool),
      execute: async (_id, params, signal, _onUpdate, ctx: ExtensionToolContext) => {
        const model = registration.getProject()?.models[role.name] ?? null;
        if (model === null) {
          return text(`[counterweight] 未配置 [models].${role.name}，${role.tool} 不可用。`);
        }
        const repo = registration.getRepo();
        if (repo === null) return text(`[counterweight] 会话尚未确定仓库根，${role.tool} 不可用。`);
        const askedS = clampTimeoutS((params as { timeout_s?: unknown }).timeout_s);
        if (role.input === "report") {
          const report = (params as { report: string }).report;
          return text(await queueChronicle(() => chronicle(ctx, repo, model, report, signal, registration, askedS)));
        }
        const message = role.input === "question"
          ? (params as { question: string }).question
          : reviewMessage(params as { request: string; diff: string });
        const router = registration.getProject()?.router ?? null;
        if (router !== null && (role.name === "review" || role.name === "over_review")) {
          const verdict = await gate(router, role.name, message, signal);
          await recordEvent(repo, ctx.sessionManager.getSessionId(), "gate", {
            role: role.name, model: router.model, p: verdict.p, skipped: verdict.skip,
            audited: verdict.audited, error: verdict.error, ms: verdict.ms,
          });
          if (verdict.skip) {
            return text(`[counterweight] ${role.tool}（预判放行：${router.model} 判有问题的概率 ${verdict.p} ≤ ${router.skip_below}，未起审查模型）：\nnone`);
          }
        }
        const run = await runAndMeter(ctx, repo, role.name, role.tool, model, message, signal, registration, askedS);
        // 审查者问问题时，补充信息写进 request 再调一次；子进程是一次性的，不会记得上次。
        const asking = role.input === "review" && run.answer?.trim().startsWith("ASK:");
        return text(asking ? `${run.text}\n审查者需要补充信息：回答上面的问题，把答案写进 request，再调用 ${role.tool} 一次。` : run.text);
      },
    });
  }
}

export function reviewMessage(params: { request: string; diff: string }): string {
  return `要求：\n${params.request}\n\ndiff：\n${params.diff}\n`;
}

export async function runAndMeter(
  ctx: SessionCtx, repo: string, role: RoleName, tool: string, model: string,
  message: string, signal: AbortSignal | undefined, registration: ToolRegistration,
  askedS?: number,
): Promise<{ text: string; answer: string | null }> {
  const session = ctx.sessionManager.getSessionId();
  const started = Date.now();
  // 调用方这次要求的优先；其次是测试覆盖、[timeouts] 里用户配的，最后是内置默认。
  const configured = registration.getProject()?.timeouts[role];
  const timeoutMs = askedS !== undefined ? askedS * 1000
    : registration.timeoutMs?.[role] ?? (configured !== undefined ? configured * 1000 : roleTimeoutMs(role));
  const waitMs = registration.realWaitMs ?? timeoutMs;
  const run = await runRole({
    role,
    workRoot: repo,
    model,
    message,
    signal,
    cliPath: registration.cliPath,
    timeoutMs: waitMs,
  });
  let spent = 0;
  let meterError: string | null = null;
  for (const sample of run.usage) {
    try {
      await recordUsage(repo, {
        time: new Date().toISOString(),
        session,
        model,
        input: sample.input,
        output: sample.output,
        cache_read: sample.cacheRead,
        cache_write: sample.cacheWrite,
        cost_total: sample.costTotal,
      });
    } catch (error) {
      meterError ??= error instanceof Error ? error.message : "未知错误";
    }
    spent += sample.totalTokens > 0
      ? sample.totalTokens
      : sample.input + sample.output + sample.cacheRead + sample.cacheWrite;
  }
  const meterNote = meterError === null ? "" : `；用量未能写入计量（${meterError}）`;
  if (run.error !== null) {
    await recordEvent(repo, session, role, {
      outcome: "failed", error: run.error, tokens: spent, ms: Date.now() - started,
      timed_out: run.timedOut, cancelled: run.cancelled,
    });
    return { answer: null, text: `[counterweight] ${tool} 未返回结果（${run.error}）；本次消耗 ${spent} token${meterNote}。${run.timedOut ? timeoutAdvice(tool, timeoutMs) : ""}` };
  }
  // result 区分白跑（none）、史官提问（ask）和有内容的回答，供判断这个角色值不值得自动跑。
  const head = run.answer!.trim();
  const result = head === "none" ? "none" : head.startsWith("ASK:") ? "ask" : "answer";
  await recordEvent(repo, session, role, {
    outcome: "answered", result, tokens: spent, ms: Date.now() - started, timed_out: false,
  });
  return {
    answer: run.answer,
    text: `[counterweight] ${tool}（模型 ${model}，提示 ${rolePromptPath(role)}，消耗 ${spent} token${meterNote}）：\n${run.answer}`,
  };
}

/**
 * 把汇报连同当前文档交给史官。回答以 `ASK:` 开头就原样交还主模型，不写文件；
 * 不是以 `# ` 开头的整份文档也不写，免得一句闲话覆盖掉全部历史。
 */
export async function chronicle(
  ctx: SessionCtx, repo: string, model: string, report: string,
  signal: AbortSignal | undefined, registration: ToolRegistration, askedS?: number,
): Promise<string> {
  let current = "";
  try {
    current = await readFile(path.join(repo, ".cw", HISTORY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return `[counterweight] cw_chronicle 读不了 .cw/${HISTORY_FILE}：${error instanceof Error ? error.message : "未知错误"}`;
    }
  }
  const message = `当前文档：\n${current === "" ? "（空）" : current}\n\n汇报：\n${report}\n`;
  const { text: note, answer } = await runAndMeter(ctx, repo, "historian", "cw_chronicle", model, message, signal, registration, askedS);
  if (answer === null) return note;
  const body = answer.trim();
  if (body.startsWith("ASK:")) return `${note}\n史官需要你协调后再汇报，文档未改动。`;
  if (!body.startsWith("# ")) return `[counterweight] cw_chronicle 史官没有返回整份文档（首行不是 # 标题），文档未改动：\n${body.slice(0, 200)}`;
  try {
    await writeCwFile(repo, HISTORY_FILE, `${body}\n`);
  } catch (error) {
    return `[counterweight] cw_chronicle 写入失败：${error instanceof Error ? error.message : "未知错误"}`;
  }
  return `[counterweight] cw_chronicle 已更新 .cw/${HISTORY_FILE}。`;
}
