/**
 * cw_explore（轻量版）测试：钉住子进程 CLI 参数、答案后处理（30 行上限、path:line 标注）、
 * 读路径逃逸拒答、超时/取消语义、树变化不可信标记与 token 记账。
 *
 * `cw_explore` (lite) tests: the subprocess CLI contract, answer post-processing
 * (30-line cap, `path:line` annotation), read-path escape withholding,
 * timeout/cancel semantics, tree-movement untrusted marking, and token
 * accounting into `.cw/meter.jsonl`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { loadProjectConfig, type ProjectConfig } from "../../src/core/config.ts";
import { finalizeExplorerAnswer } from "../../src/core/explore.ts";
import { registerTools } from "../../src/adapters/pi/tools.ts";
import { findPiCli } from "../../src/explorer/run.ts";

// 伪 pi CLI fixture：转存 argv，行为由 CW_FAKE_EXPLORE 选择（见该文件）。
// Fake pi CLI fixture: dumps argv; behavior selected by CW_FAKE_EXPLORE.
const fakeCli = path.join(import.meta.dirname, "../fixtures/explorer/fake-pi.mjs");

// pi 工具 execute 的最小签名；用例只断言返回给模型的文本。
// Minimal pi tool `execute` signature; the tests assert only the returned text.
type ToolExecute = (
  toolCallId: string, params: { question: string }, signal: AbortSignal | undefined,
  onUpdate: undefined, ctx: ExtensionToolContext,
) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;

/**
 * setup() 的产物：仓库根、会话上下文、注册后的 cw_explore execute 与清理函数。
 *
 * What `setup()` hands back: the repo root, the session context, the
 * registered `cw_explore.execute`, and a cleanup that unsets injected env vars.
 */
interface Harness {
  repo: string;
  ctx: ExtensionToolContext;
  explore: ToolExecute;
  cleanup: () => Promise<void>;
}

/**
 * 复用轻量布局：真实 git 仓库 + `.cw/project.toml` 的 `[explorer] model`，
 * 工具注册到伪 pi CLI。
 *
 * Lite layout: a real git repo plus `.cw/project.toml` with `[explorer] model`,
 * with the tool registered against a fake pi CLI.
 */
async function setup(options: {
  mode: string;
  text?: string;
  usage?: unknown;
  timeoutMs?: number;
  project?: string | null;
}): Promise<Harness> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-explore-")));
  await git(repo, ["init"]);
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "tests", "a.py"), "base\n");
  await git(repo, ["add", "tests/a.py"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  await mkdir(path.join(repo, ".cw"), { recursive: true });
  const toml = options.project === undefined
    ? `version = 1\n\n[explorer]\nmodel = "g/explorer"\n`
    : options.project;
  if (toml !== null) await writeFile(path.join(repo, ".cw", "project.toml"), toml);
  const project: ProjectConfig | null = toml === null ? null : await loadProjectConfig(repo);

  // 环境变量驱动伪 pi：模式、argv 落盘路径、回答文本与 usage 都由用例注入。
  // Env vars drive the fake pi: mode, argv dump path, answer text, and usage.
  const argvFile = path.join(repo, ".cw", "fake-argv.json");
  process.env.CW_FAKE_EXPLORE = options.mode;
  process.env.CW_FAKE_ARGV_FILE = argvFile;
  if (options.text !== undefined) process.env.CW_FAKE_EXPLORE_TEXT = options.text;
  if (options.usage !== undefined) process.env.CW_FAKE_USAGE = JSON.stringify(options.usage);

  const tools = new Map<string, { execute: ToolExecute }>();
  const pi = {
    on: () => () => undefined,
    registerTool: (tool: { name: string; execute: ToolExecute }) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  registerTools(pi, {
    getProject: () => project,
    explorerCliPath: fakeCli,
    explorerTimeoutMs: options.timeoutMs,
  });
  const explore = tools.get("cw_explore")!.execute;
  const ctx = {
    cwd: repo,
    sessionManager: { getSessionId: () => "s1" },
  } as unknown as ExtensionToolContext;
  // 清掉注入的进程级环境变量再删临时仓库，避免用例间相互污染。
  // Unset the injected env vars, then delete the temp repo to keep cases isolated.
  const cleanup = async () => {
    for (const key of ["CW_FAKE_EXPLORE", "CW_FAKE_ARGV_FILE", "CW_FAKE_EXPLORE_TEXT", "CW_FAKE_USAGE"]) {
      delete process.env[key];
    }
    await rm(repo, { recursive: true, force: true });
  };
  return { repo, ctx, explore, cleanup };
}

// 同步执行一条 git 命令并收集 stdout；非零退出即 reject（夹具装配用）。
// One git subprocess collecting stdout; rejects on nonzero exit (fixture plumbing).
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")}`)));
  });
}

// 直接调用 cw_explore.execute，返回给模型看的文本（toolCallId 固定为 t1）。
// Invoke `cw_explore.execute` directly and return the model-facing text.
const run = (harness: Harness, question: string, signal?: AbortSignal) =>
  harness.explore("t1", { question }, signal, undefined, harness.ctx)
    .then((result) => result.content[0]!.text);

// 读 `.cw/meter.jsonl` 并逐行解析；调用方须保证计量文件已存在（至少跑过一轮）。
// Parses `.cw/meter.jsonl` line by line; callers must have run at least once.
const meterLines = async (repo: string): Promise<Array<Record<string, unknown>>> => {
  const text = await readFile(path.join(repo, ".cw", "meter.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
};

// findPiCli 的定位契约：本地安装优先；落空时回退到运行中的 pi 进程入口——argv[1] 解析符号
// 链接后必须落在 pi 的 CLI bundle 上，其它入口一律拒绝。托管安装不落地宿主包，回退即此路。
// findPiCli's lookup contract: an installed pi package wins; otherwise the running pi process
// entry is used — argv[1] must resolve (through symlinks) to the pi CLI bundle.
test("findPiCli：本地安装优先，落空时回退到运行中的 pi 入口", async () => {
  const bundle = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  expect(findPiCli()).toBe(bundle);

  const outside = await mkdtemp(path.join(tmpdir(), "cw-findpi-"));
  const original = process.argv[1];
  try {
    process.argv[1] = bundle;
    expect(findPiCli(outside)).toBe(bundle);
    const link = path.join(outside, "pi");
    await symlink(bundle, link);
    process.argv[1] = link;
    expect(findPiCli(outside)).toBe(bundle);
    process.argv[1] = path.resolve("package.json");
    expect(findPiCli(outside)).toBeNull();
  } finally {
    process.argv[1] = original;
    await rm(outside, { recursive: true, force: true });
  }
});

// 钉死子进程 argv（含顺序）与系统提示文件的存在性；任何漂移都必须失败。
// Pins the subprocess argv (order included) and the prompt file's existence.
test("探索者子进程使用核实的 CLI 参数：JSON 模式、read/grep 白名单、固定提示、禁自动加载", async () => {
  const harness = await setup({ mode: "answer", text: "结论甲 tests/a.py:1" });
  try {
    const result = await run(harness, "入口在哪里");
    expect(result).toContain("结论甲 tests/a.py:1");
    const argv = JSON.parse(await readFile(path.join(harness.repo, ".cw", "fake-argv.json"), "utf8")) as string[];
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe(fakeCli);
    expect(argv.slice(2)).toEqual([
      "--mode", "json",
      "--no-session",
      "--offline",
      "--model", "g/explorer",
      "--tools", "read,grep",
      "--system-prompt", expect.any(String),
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--", "入口在哪里",
    ]);
    const promptFlag = argv.indexOf("--system-prompt");
    expect(existsSync(argv[promptFlag + 1]!)).toBe(true);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

// 30 行上限是硬契约：截断必须显式注明，先放弃尾部再标注，绝不静默丢弃。
// The 30-line cap is hard; the cut keeps the first 30 lines and is always annotated.
test("输出超过 30 行时被截断并注明", async () => {
  const harness = await setup({ mode: "long" });
  try {
    const result = await run(harness, "q");
    const lines = result.split("\n");
    expect(lines.some((line) => line.includes("已截断"))).toBe(true);
    const answerLines = lines.filter((line) => line.startsWith("行"));
    expect(answerLines).toHaveLength(30);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

// 引用校验四类失败（缺文件/越界/../逃逸/.cw 台账）与缺出处都就地标注，原文不删。
// Invalid refs and ref-less lines get annotated in place; the text is never dropped.
test("无效引用被标注〔引用无效〕，缺出处的结论被标注〔缺少引用〕，均不删除内容", async () => {
  const answer = [
    "结论甲 tests/a.py:1",
    "结论乙 missing-dir/missing.py:3",
    "结论丙 tests/a.py:999",
    "结论丁 ../outside.py:1",
    "结论戊 .cw/tasks/x.toml:1",
    "结论己没有出处",
    "比例 3:1 不是引用",
  ].join("\n");
  const harness = await setup({ mode: "answer", text: answer });
  try {
    const result = await run(harness, "q");
    expect(result).toContain("结论甲 tests/a.py:1\n");
    expect(result).not.toContain("结论甲 tests/a.py:1 〔引用无效〕");
    expect(result).toContain("结论乙 missing-dir/missing.py:3 〔引用无效〕");
    expect(result).toContain("结论丙 tests/a.py:999 〔引用无效〕");
    expect(result).toContain("结论丁 ../outside.py:1 〔引用无效〕");
    expect(result).toContain("结论戊 .cw/tasks/x.toml:1 〔引用无效〕");
    expect(result).toContain("结论己没有出处 〔缺少引用〕");
    expect(result).toContain("比例 3:1 不是引用 〔缺少引用〕");
    expect(result.match(/〔引用无效〕/g)).toHaveLength(4);
    expect(result.match(/〔缺少引用〕/g)).toHaveLength(2);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

// 逃逸读 fail-closed：整条回答作废（树内读混入也不行），但 token 与失败事件仍记账。
// Escaped reads fail closed: the whole answer is withheld, usage still metered.
test("探索者读取工作树之外的路径：回答不予采信，usage 仍记账", async () => {
  const harness = await setup({
    mode: "readoutside",
    text: "结论甲 /etc/hosts:1",
    usage: { input: 9, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
  });
  try {
    const result = await run(harness, "q");
    expect(result).toContain("未返回结果");
    expect(result).toContain("读取了工作树之外的路径");
    expect(result).toContain("/etc/hosts");
    expect(result).toContain("../outside");
    expect(result).not.toContain("结论甲");
    const usage = (await meterLines(harness.repo)).filter((line) => line.kind === "usage");
    expect(usage).toHaveLength(1);
    const events = (await meterLines(harness.repo)).filter((line) => line.kind === "event"
      && line.event === "explore");
    expect(events.at(-1)!.detail).toMatchObject({ outcome: "failed", escaped_reads: 2 });
  } finally {
    await harness.cleanup();
  }
}, 20_000);

// 词法上仍在树内的符号链接出口同样按逃逸处理（realpath 复核）。
// An in-repo symlink whose target escapes is still an escape (realpath re-check).
test("仓内符号链接指向仓外同样是读路径逃逸", async () => {
  const harness = await setup({
    mode: "readlink",
    text: "结论甲 link.py:1",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  });
  try {
    await symlink("/etc/hosts", path.join(harness.repo, "link.py"));
    const result = await run(harness, "q");
    expect(result).toContain("未返回结果");
    expect(result).toContain("符号链接指向工作树之外");
    expect(result).toContain("link.py");
    expect(result).not.toContain("结论甲");
  } finally {
    await rm(path.join(harness.repo, "link.py"), { force: true });
    await harness.cleanup();
  }
}, 20_000);

// 反向对照：树内读（以及无 path 的 grep）不触发任何拒答路径。
// Control case: in-tree reads (and grep without a path) withhold nothing.
test("读取全部落在工作树内：回答照常返回", async () => {
  const harness = await setup({ mode: "readinside", text: "结论甲 tests/a.py:1" });
  try {
    const result = await run(harness, "q");
    expect(result).toContain("结论甲 tests/a.py:1");
    expect(result).not.toContain("未返回结果");
  } finally {
    await harness.cleanup();
  }
}, 20_000);

// 超时语义：runner 返回时整个子进程组已消亡（伪 pi 记录 pid 供复核）。
// Timeout: the runner returns only after the whole process group is gone.
test("子进程超时被终止：整组消亡后才返回", async () => {
  const pidFile = path.join(tmpdir(), `cw-explore-pid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.CW_FAKE_PID_FILE = pidFile;
  const harness = await setup({ mode: "hang", timeoutMs: 300 });
  try {
    const started = Date.now();
    const result = await run(harness, "q");
    expect(result).toContain("超时");
    expect(result).toContain("未返回结果");
    for (let waited = 0; !existsSync(pidFile) && waited < 5_000; waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(Date.now() - started).toBeLessThan(30_000);
  } finally {
    delete process.env.CW_FAKE_PID_FILE;
    await rm(pidFile, { force: true }).catch(() => undefined);
    await harness.cleanup();
  }
}, 30_000);

// 宿主 AbortSignal 走同一条进程组终止路径，终止后才返回“已被取消”。
// Host cancellation kills through the same process-group path before returning.
test("外部取消（宿主信号）同样终止子进程组", async () => {
  const pidFile = path.join(tmpdir(), `cw-explore-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.CW_FAKE_PID_FILE = pidFile;
  const harness = await setup({ mode: "hang", timeoutMs: 60_000 });
  try {
    const controller = new AbortController();
    const pending = run(harness, "q", controller.signal);
    for (let waited = 0; !existsSync(pidFile) && waited < 5_000; waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    controller.abort();
    const result = await pending;
    expect(result).toContain("已被取消");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    delete process.env.CW_FAKE_PID_FILE;
    await rm(pidFile, { force: true }).catch(() => undefined);
    await harness.cleanup();
  }
}, 30_000);

// 先给完整回答再挂起：被杀死的运行永不采信其回答，usage 仍全额记账。
// Answer-then-hang: a killed run never has its answer accepted; usage is metered.
test("先输出完整回答后挂起：超时判失败，回答不被接受，usage 仍记账", async () => {
  const pidFile = path.join(tmpdir(), `cw-explore-late-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.CW_FAKE_PID_FILE = pidFile;
  const harness = await setup({
    mode: "answerthenhang",
    timeoutMs: 300,
    text: "结论甲 tests/a.py:1",
    usage: { input: 11, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  });
  try {
    const result = await run(harness, "q");
    expect(result).toContain("未返回结果");
    expect(result).toContain("超时");
    expect(result).not.toContain("结论甲");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    const usageLines = (await meterLines(harness.repo)).filter((line) => line.kind === "usage");
    expect(usageLines).toHaveLength(1);
  } finally {
    delete process.env.CW_FAKE_PID_FILE;
    await rm(pidFile, { force: true }).catch(() => undefined);
    await harness.cleanup();
  }
}, 30_000);

// 先输出完整回答后被取消：回答丢弃、子进程已死、usage 仍记账。
// Same as above on the cancel path: answer dropped, usage still metered.
test("先输出完整回答后被取消：回答不被接受，usage 仍记账", async () => {
  const pidFile = path.join(tmpdir(), `cw-explore-late-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.CW_FAKE_PID_FILE = pidFile;
  const harness = await setup({
    mode: "answerthenhang",
    timeoutMs: 60_000,
    text: "结论甲 tests/a.py:1",
    usage: { input: 6, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 8 },
  });
  try {
    const controller = new AbortController();
    const pending = run(harness, "q", controller.signal);
    for (let waited = 0; !existsSync(pidFile) && waited < 5_000; waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    controller.abort();
    const result = await pending;
    expect(result).toContain("未返回结果");
    expect(result).toContain("已被取消");
    expect(result).not.toContain("结论甲");
    const usageLines = (await meterLines(harness.repo)).filter((line) => line.kind === "usage");
    expect(usageLines).toHaveLength(1);
  } finally {
    delete process.env.CW_FAKE_PID_FILE;
    await rm(pidFile, { force: true }).catch(() => undefined);
    await harness.cleanup();
  }
}, 30_000);

// 树哈希在运行期间移动 → 头部标注“不可信”；探索者的写入留在原地不还原。
// A moved tree hash marks the answer untrusted; the explorer's writes stay in place.
test("子进程修改文件树时结果被标注为不可信，且改动不被还原", async () => {
  const harness = await setup({ mode: "writetree", text: "结论甲 tests/a.py:1" });
  try {
    const result = await run(harness, "q");
    expect(result).toContain("仓库树发生变化");
    expect(result).toContain("不可信");
    expect(result).toContain("结论甲 tests/a.py:1");
    expect(existsSync(path.join(harness.repo, "explorer-wrote.txt"))).toBe(true);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

// usage 全字段落 `.cw/meter.jsonl`。
// Usage lands in `.cw/meter.jsonl` field by field.
test("usage 逐条记入 meter.jsonl", async () => {
  const harness = await setup({
    mode: "answer",
    text: "结论甲 tests/a.py:1",
    usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 6, totalTokens: 131, cost: { total: 0.01 } },
  });
  try {
    await run(harness, "q");
    const usageLines = (await meterLines(harness.repo)).filter((line) => line.kind === "usage");
    expect(usageLines).toHaveLength(1);
    expect(usageLines[0]).toMatchObject({
      session: "s1", model: "g/explorer",
      input: 100, output: 20, cache_read: 5, cache_write: 6, cost_total: 0.01,
    });
  } finally {
    await harness.cleanup();
  }
}, 20_000);

// 每条 assistant message_end 各记一条 usage 并求和。
// One usage line per assistant message_end, summed across turns.
test("多轮 assistant 消息的 usage 逐条记账并求和", async () => {
  const harness = await setup({
    mode: "multimessage",
    text: "最终结论 tests/a.py:1",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
  });
  try {
    const result = await run(harness, "q");
    expect(result).toContain("最终结论 tests/a.py:1");
    expect(result).toContain("消耗 24 token");
    const usageLines = (await meterLines(harness.repo)).filter((line) => line.kind === "usage");
    expect(usageLines).toHaveLength(2);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

// stop reason 非 stop 判失败：半截回答不采信，已花的 token 照常落账。
// A non-stop stopReason is a failure: no answer returned, tokens still charged.
test("失败运行同样记账：stop reason 异常时不返回回答但 usage 落账", async () => {
  const harness = await setup({
    mode: "badstop",
    text: "半截回答",
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
  });
  try {
    const result = await run(harness, "q");
    expect(result).toContain("未返回结果");
    expect(result).toContain("stop reason: length");
    const usageLines = (await meterLines(harness.repo)).filter((line) => line.kind === "usage");
    expect(usageLines).toHaveLength(1);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

// 未配置 `[explorer] model` 时工具直接说明不可用，不触探索者子进程。
// Without `[explorer] model` the tool reports unavailability and never spawns the explorer.
test("未配置探索者模型时 cw_explore 不可用", async () => {
  const harness = await setup({ mode: "answer", text: "x", project: "version = 1\n" });
  try {
    const result = await run(harness, "q");
    expect(result).toContain("未配置探索者模型");
    expect(existsSync(path.join(harness.repo, ".cw", "fake-argv.json"))).toBe(false);
  } finally {
    await harness.cleanup();
  }
});

// ---- answer post-processing unit cases --------------------------------------

// 单元用例：31 行只保留前 30 行 + 1 行截断注记，边界行号精确。
// Unit: 31 lines keep exactly the first 30 plus one truncation note.
test("finalizeExplorerAnswer：行数上限与截断标注", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-explore-unit-")));
  try {
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "tests", "a.py"), "one\ntwo\nthree\n");
    const long = Array.from({ length: 31 }, (_, i) => `行${i + 1}`).join("\n");
    const finalized = await finalizeExplorerAnswer(long, repo);
    expect(finalized.truncated).toBe(true);
    expect(finalized.text.split("\n")).toHaveLength(31);
    expect(finalized.text.split("\n").at(-1)).toContain("已截断");
    expect(finalized.text).toContain("行30");
    expect(finalized.text).not.toContain("行31");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 单元用例：行号须落在文件行数内，空文件视为 0 行；全文精确匹配证明不改原文。
// Unit: line numbers must be in range; an empty file has zero lines.
test("finalizeExplorerAnswer：引用行号必须落在文件范围内", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-explore-unit2-")));
  try {
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "tests", "a.py"), "one\ntwo\n");
    await writeFile(path.join(repo, "tests", "empty.txt"), "");
    const finalized = await finalizeExplorerAnswer(
      "甲 tests/a.py:2\n乙 tests/a.py:3\n丙 tests/empty.txt:1\n未找到", repo);
    expect(finalized.text)
      .toBe("甲 tests/a.py:2\n乙 tests/a.py:3 〔引用无效〕\n丙 tests/empty.txt:1 〔引用无效〕\n未找到");
    expect(finalized.invalidRefs).toEqual(["tests/a.py:3", "tests/empty.txt:1"]);
    expect(finalized.missingRefs).toEqual([]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 单元用例：缺引用标注；空行与裸“未找到”豁免（它们是合法回答形态）。
// Unit: missing-ref annotation; blank lines and the bare `未找到` are exempt.
test("finalizeExplorerAnswer：缺出处的结论标注〔缺少引用〕；未找到与空行豁免", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-explore-unit3-")));
  try {
    const finalized = await finalizeExplorerAnswer("结论甲无出处\n\n未找到", repo);
    expect(finalized.text).toBe("结论甲无出处 〔缺少引用〕\n\n未找到");
    expect(finalized.missingRefs).toEqual(["结论甲无出处"]);
    expect(finalized.invalidRefs).toEqual([]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
