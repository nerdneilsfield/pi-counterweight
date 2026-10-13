/**
 * 注册 `cw_explore`：只读探索者工具（轻量版）。没有 report_blocked、没有 propose_contract_change——
 * 没有契约之后它们不再有意义。工具本身不做判断，只把问题交给只读子进程，把答案与用量带回来。
 *
 * Registers `cw_explore`, the read-only explorer (lite). There is no
 * report_blocked and no propose_contract_change — without a contract they no
 * longer mean anything. The tool judges nothing; it hands the question to the
 * read-only subprocess and brings back the answer and the usage.
 */
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectConfig } from "../../core/config.js";
import { finalizeExplorerAnswer } from "../../core/explore.js";
import { recordEvent, recordUsage } from "../../core/meter.js";
import { runExplorer } from "../../explorer/run.js";

/**
 * 工具注册所需的依赖：读取当前会话的配置（探索者模型），以及两个只给测试用的注入口。
 * 生产调用不传这两个口，CLI 发现与子进程预算由 `runExplorer` 使用自身默认值。
 *
 * What tool registration needs: a callback for the session's config (the
 * explorer model) plus two test seams. Production calls pass neither seam; CLI
 * discovery and the subprocess budget stay with `runExplorer`'s own defaults.
 */
export interface ToolRegistration {
  /**
   * 当前会话加载到的配置；没有配置文件或加载失败时为 null。
   *
   * The config loaded for this session, or null when there is no config file
   * or it failed to load.
   */
  getProject: () => ProjectConfig | null;
  /**
   * 本会话的仓库根（git 工作树根，或非 git 时的 cwd）。探索者、引用校验与计量都用它，
   * 不另取 `ctx.cwd`，这样子目录启动时路径仍对着仓库根。
   *
   * This session's repo root (the git worktree root, or cwd outside git). The
   * explorer, reference checks, and the meter all use it rather than `ctx.cwd`,
   * so a session started in a subdirectory still addresses the repo root.
   */
  getRepo: () => string | null;
  /**
   * 测试接缝：覆盖探索者 CLI 的发现结果。
   *
   * Test seam: overrides explorer CLI discovery.
   */
  explorerCliPath?: string;
  /**
   * 测试接缝：覆盖探索者子进程的预算。
   *
   * Test seam: overrides the explorer subprocess budget.
   */
  explorerTimeoutMs?: number;
}

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: undefined };
}

/**
 * 注册模型可见的工具。`cw_explore` 声明为 `sequential`：它读工作树并向计量文件追加记录，
 * 不能与并行的同级调用交错。
 *
 * Registers the model-facing tool. `cw_explore` is declared `sequential`: it
 * reads the worktree and appends to the meter file, so it must not interleave
 * with parallel sibling calls.
 */
export function registerTools(pi: ExtensionAPI, registration: ToolRegistration): void {
  /**
   * cw_explore：把问题交给只读探索者子进程，回答经后处理（30 行上限、`path:line` 引用校验）后
   * 返回。模型来自配置的 `[explorer] model`；没有配置就不提供这个工具的能力。token 用量无论成败
   * 都计入 `meter.jsonl`。
   *
   * cw_explore: hands the question to the read-only explorer subprocess and
   * returns the post-processed answer (30-line cap, `path:line` validation).
   * The model comes from the configured `[explorer] model`; without it the tool
   * reports that it is unavailable. Tokens are metered however the run ended.
   */
  pi.registerTool({
    name: "cw_explore",
    label: "探索者提问",
    description:
      "向只读探索者子代理提问代码库问题。探索者在子进程中运行，只有 read 与 grep 两个工具，"
      + "不能修改文件；回答有 30 行上限，逐条校验 path:line 引用。用于定位代码事实（实现位置、调用关系、现状），"
      + "不要用它做需要写入或执行的操作。token 消耗计入 .cw/meter.jsonl。",
    parameters: Type.Object({
      question: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) => {
      const model = registration.getProject()?.explorer?.model ?? null;
      if (model === null) {
        return text("[counterweight] 未配置探索者模型（.cw/project.toml 的 [explorer] model），cw_explore 不可用。");
      }
      const repo = registration.getRepo();
      if (repo === null) {
        return text("[counterweight] 会话尚未确定仓库根，cw_explore 不可用。");
      }
      return text(await runExplore(ctx, repo, model, params.question, signal, registration));
    },
  });
}

/**
 * 跑一轮探索者：回答经后处理，用量逐条记入计量。计量写失败不丢已经拿到的回答，只在文本里说明。
 *
 * One explorer round: the answer is post-processed and usage metered sample by
 * sample. A meter write failure does not discard an answer already in hand; the
 * text says so instead.
 */
async function runExplore(
  ctx: ExtensionToolContext, repo: string, model: string, question: string,
  signal: AbortSignal | undefined, registration: ToolRegistration,
): Promise<string> {
  const session = ctx.sessionManager.getSessionId();
  const run = await runExplorer({
    workRoot: repo,
    model,
    question,
    signal,
    cliPath: registration.explorerCliPath,
    timeoutMs: registration.explorerTimeoutMs,
  });

  // Usage is accounted no matter how the run ended: the tokens were spent.
  // A failed append is reported next to the answer, not by throwing it away.
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
    await recordEvent(repo, session, "explore", {
      outcome: "failed", error: run.error, tokens: spent,
      timed_out: run.timedOut, cancelled: run.cancelled,
      escaped_reads: run.escapedReads.length,
    });
    return `[counterweight] 探索者未返回结果（${run.error}）；本次消耗 ${spent} token${meterNote}。`;
  }
  const finalized = await finalizeExplorerAnswer(run.answer!, repo);
  await recordEvent(repo, session, "explore", {
    outcome: "answered",
    truncated: finalized.truncated,
    invalid_refs: finalized.invalidRefs.length,
    missing_refs: finalized.missingRefs.length,
    tokens: spent,
    timed_out: run.timedOut,
  });
  const header = `[counterweight] 探索者回答（模型 ${model}，消耗 ${spent} token${meterNote}）`;
  return `${header}：\n${finalized.text}`;
}
