import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { finalizeExplorerAnswer } from "../../src/core/explore.ts";
import { blobHash } from "../../src/core/gitstate.ts";
import { readProjectConfig } from "../../src/core/config.ts";
import { contentSha256 } from "../../src/core/evidence.ts";
import { contractSha256, readContract } from "../../src/core/contract.ts";
import { createTask, readState, updateState, type Approval } from "../../src/core/task.ts";
import { registerTools } from "../../src/adapters/pi/tools.ts";
import type { ActiveTask } from "../../src/adapters/pi/index.ts";

const fakeCli = path.join(import.meta.dirname, "../fixtures/explorer/fake-pi.mjs");
const ymd = () => {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
};
const taskId = `${ymd()}-lifetime-fix`;

type ToolExecute = (
  toolCallId: string, params: { question: string }, signal: AbortSignal | undefined,
  onUpdate: undefined, ctx: ExtensionToolContext,
) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;

interface Harness {
  task: ActiveTask;
  repo: string;
  explore: ToolExecute;
  cleanup: () => Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")}`)));
  });
}

/** Approved-task repo (m7 pattern) with the tool registered against a fake pi CLI. */
async function setup(options: {
  mode: string;
  text?: string;
  usage?: unknown;
  timeoutMs?: number;
} ): Promise<Harness> {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-m8-"));
  await git(repo, ["init"]);
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "tests", "a.py"), "base\n");
  await git(repo, ["add", "tests/a.py"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await mkdir(path.join(repo, ".cw"), { recursive: true });
  await writeFile(path.join(repo, ".cw", "project.toml"), `version = 1

[validator]
cmd = ["/bin/sh", "-c", "true"]
timeout_s = 600

[models]
cheap = "g/cheap"
medium = "g/medium"
strong = "g/strong"
explorer = "g/explorer"

[tiers]
script = "cheap"
change = "medium"
interface = "strong"
`);
  await createTask(repo, taskId, "g/medium", base);
  await writeFile(
    path.join(repo, ".cw", "tasks", taskId, "contract.toml"), `version = 1
task_id = "${taskId}"
tier = "change"
deliverable = "code"
goal = "fix lifetime issue"
acceptance = ["keep"]
red = ["keep"]
regression = []
frozen = ["tests/a.py"]
baseline_inputs = ["tests/a.py"]
`);
  const contract = await readContract(
    path.join(repo, ".cw", "tasks", taskId, "contract.toml"), repo, taskId);
  const approval: Approval = {
    version: 1,
    contract_sha256: contractSha256(contract),
    project_config_sha256: "0".repeat(64),
    validator: { cmd: ["/bin/sh", "-c", "true"], timeout_s: 600, env: {} },
    base_commit: base,
    baseline_inputs_sha256: { "tests/a.py": (await contentSha256(repo, "tests/a.py"))! },
    validator_inputs_sha256: {},
    frozen_blobs: { "tests/a.py": (await blobHash(repo, "tests/a.py")).value! },
    red_check_run: 1,
    approved_at: new Date().toISOString(),
  };
  await writeFile(
    path.join(repo, ".cw", "tasks", taskId, "approval.json"),
    `${JSON.stringify(approval, null, 2)}\n`);
  await updateState(repo, taskId, "s1", (state) => ({ ...state, status: "approved", sessions: ["s1"] }));

  const root = await realpath(repo);
  const task: ActiveTask = {
    taskId, root, ledger: root, session: "s1",
    contract, approval, project: await readProjectConfig(path.join(root, ".cw", "project.toml")),
  };

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
    setModel: async () => true,
  } as unknown as ExtensionAPI;
  registerTools(pi, {
    getTask: () => task,
    explorerCliPath: fakeCli,
    explorerTimeoutMs: options.timeoutMs,
  });
  const explore = tools.get("cw_explore")!.execute;
  const cleanup = async () => {
    for (const key of ["CW_FAKE_EXPLORE", "CW_FAKE_ARGV_FILE", "CW_FAKE_EXPLORE_TEXT", "CW_FAKE_USAGE"]) {
      delete process.env[key];
    }
    await rm(repo, { recursive: true, force: true });
  };
  return { task, repo, explore, cleanup };
}

const run = (harness: Harness, question: string, signal?: AbortSignal) =>
  harness.explore("t1", { question }, signal, undefined, {} as ExtensionToolContext)
    .then((result) => result.content[0]!.text);

const meterLines = async (repo: string): Promise<Array<Record<string, unknown>>> => {
  const text = await readFile(path.join(repo, ".cw", "tasks", taskId, "meter.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
};

// ---- CLI contract: the explorer subprocess gets exactly the verified flags --

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

// ---- plan acceptance: bounded output, invalid refs, timeout, tree, usage ----

test("输出超过 30 行时被截断并注明", async () => {
  const harness = await setup({ mode: "long" });
  try {
    const result = await run(harness, "q");
    const lines = result.split("\n");
    expect(lines.some((line) => line.includes("已截断"))).toBe(true);
    // The header plus exactly 30 answer lines plus the truncation note.
    const answerLines = lines.filter((line) => line.startsWith("行"));
    expect(answerLines).toHaveLength(30);
    expect(lines.indexOf(answerLines[0]!)).toBe(1);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

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
    const state = await readState(harness.repo, taskId);
    expect(state.tokens_used).toBe(12);
    const events = (await meterLines(harness.repo)).filter((line) => line.kind === "task"
      && line.event === "explore");
    expect(events.at(-1)!.detail).toMatchObject({ outcome: "failed", escaped_reads: 2 });
  } finally {
    await harness.cleanup();
  }
}, 20_000);

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

test("子进程超时被终止：整组消亡后才返回", async () => {
  const pidFile = path.join(tmpdir(), `cw-m8-pid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.CW_FAKE_PID_FILE = pidFile;
  const harness = await setup({ mode: "hang", timeoutMs: 300 });
  try {
    const started = Date.now();
    const result = await run(harness, "q");
    expect(result).toContain("超时");
    expect(result).toContain("未返回结果");
    // The fake writes its pid once it is up; the runner may only return after
    // the whole process group is gone.
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

test("外部取消（宿主信号）同样终止子进程组", async () => {
  const pidFile = path.join(tmpdir(), `cw-m8-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

test("先输出完整回答后挂起：超时判失败，回答不被接受，usage 仍记账", async () => {
  const pidFile = path.join(tmpdir(), `cw-m8-late-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    expect((await readState(harness.repo, taskId)).tokens_used).toBe(15);
  } finally {
    delete process.env.CW_FAKE_PID_FILE;
    await rm(pidFile, { force: true }).catch(() => undefined);
    await harness.cleanup();
  }
}, 30_000);

test("先输出完整回答后被取消：回答不被接受，usage 仍记账", async () => {
  const pidFile = path.join(tmpdir(), `cw-m8-late-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    expect((await readState(harness.repo, taskId)).tokens_used).toBe(8);
  } finally {
    delete process.env.CW_FAKE_PID_FILE;
    await rm(pidFile, { force: true }).catch(() => undefined);
    await harness.cleanup();
  }
}, 30_000);

test("执行前重读权威状态：非 approved/running 或本会话不再登记时拒绝且不派子进程", async () => {
  const harness = await setup({ mode: "answer", text: "结论甲 tests/a.py:1" });
  const argvFile = path.join(harness.repo, ".cw", "fake-argv.json");
  try {
    // a) another session handed the task back.
    await updateState(harness.repo, taskId, "s1", (state) => ({ ...state, status: "handed_back" }));
    let result = await run(harness, "q");
    expect(result).toContain("拒绝执行");
    expect(result).toContain("handed_back");
    expect(existsSync(argvFile)).toBe(false);

    // b) task executable again but this session was removed (cross-session takeover).
    await updateState(harness.repo, taskId, "s1", (state) => ({ ...state, status: "approved", sessions: ["s2"] }));
    result = await run(harness, "q");
    expect(result).toContain("拒绝执行");
    expect(result).toContain("不再登记");
    expect(existsSync(argvFile)).toBe(false);

    // c) cancelled outright.
    await updateState(harness.repo, taskId, "s1", (state) => ({ ...state, sessions: ["s1"], status: "cancelled" }));
    result = await run(harness, "q");
    expect(result).toContain("拒绝执行");
    expect(result).toContain("cancelled");
    expect(existsSync(argvFile)).toBe(false);

    // d) restored to the recorded executable state → the tool runs again.
    await updateState(harness.repo, taskId, "s1", (state) => ({ ...state, status: "approved", sessions: ["s1"] }));
    result = await run(harness, "q");
    expect(result).toContain("结论甲 tests/a.py:1");
    expect(existsSync(argvFile)).toBe(true);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

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

test("usage 计入父任务：meter.jsonl 逐条记录，tokens_used 累加进预算", async () => {
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
    const state = await readState(harness.repo, taskId);
    expect(state.tokens_used).toBe(131);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

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
    expect((await readState(harness.repo, taskId)).tokens_used).toBe(24);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

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
    expect((await readState(harness.repo, taskId)).tokens_used).toBe(10);
  } finally {
    await harness.cleanup();
  }
}, 20_000);

test("无受管任务时 cw_explore 不可用", async () => {
  const tools = new Map<string, { execute: ToolExecute }>();
  const pi = {
    on: () => () => undefined,
    registerTool: (tool: { name: string; execute: ToolExecute }) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    sendMessage: () => undefined,
    setModel: async () => true,
  } as unknown as ExtensionAPI;
  registerTools(pi, { getTask: () => null });
  const result = await tools.get("cw_explore")!.execute(
    "t1", { question: "q" }, undefined, undefined, {} as ExtensionToolContext);
  expect(result.content[0]!.text).toContain("没有受管任务");
});

// ---- answer post-processing unit cases --------------------------------------

test("finalizeExplorerAnswer：行数上限与截断标注", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-m8-unit-")));
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

test("finalizeExplorerAnswer：引用行号必须落在文件范围内", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-m8-unit2-")));
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

test("finalizeExplorerAnswer：缺出处的结论标注〔缺少引用〕；未找到与空行豁免", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-m8-unit3-")));
  try {
    const finalized = await finalizeExplorerAnswer("结论甲无出处\n\n未找到", repo);
    expect(finalized.text).toBe("结论甲无出处 〔缺少引用〕\n\n未找到");
    expect(finalized.missingRefs).toEqual(["结论甲无出处"]);
    expect(finalized.invalidRefs).toEqual([]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
