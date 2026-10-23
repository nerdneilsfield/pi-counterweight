/**
 * 轻量适配层测试：结算检查（每次完成都跑、通过/反馈一次/如实结束）、受保护路径拦截
 * （含目录链接下的缺失叶子、外指链接与悬空链接）、usage 记账与 shutdown 回收。
 *
 * Lite adapter tests: the settle check (every completed turn, pass/one-feedback/
 * final report), protected-path interception (a missing leaf under a directory
 * link, an outward link, and a dangling link), usage metering, and shutdown
 * reaping.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import counterweight, { type AdapterTimeouts } from "../../src/adapters/pi/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

/**
 * 伪 ExtensionAPI 与配套的会话上下文：捕获处理器供直接调用，通知收进数组供断言。
 *
 * Fake ExtensionAPI plus session context: handlers are captured for direct
 * invocation, notifications collected for assertions.
 */
interface Fake {
  handlers: Map<string, Handler>;
  notifications: string[];
  ctx: ExtensionContext;
}

// 同步执行一条 git 命令并收集 stdout；非零退出即 reject。
// One git subprocess collecting stdout; rejects on a nonzero exit.
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")}`)));
  });
}

// 把扩展注册到伪 pi 上，并返回捕获到的处理器、通知与会话上下文。
// Registers the extension on a fake pi and returns the captured handlers, notifications, and context.
function fakePi(repo: string, overrides?: Partial<AdapterTimeouts>): Fake {
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => undefined;
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  counterweight(pi, overrides);
  const ctx = {
    cwd: repo,
    signal: undefined,
    ui: { notify: (message: string, level?: string) => { notifications.push(`${level ?? "info"}:${message}`); } },
    sessionManager: { getSessionId: () => "s1" },
    hasUI: true,
  } as unknown as ExtensionContext;
  return { handlers, notifications, ctx };
}

// 建一个带基线提交的临时 git 仓库，可选写入 `.cw/project.toml` 与任意文件。
// Temp git repo with one baseline commit, an optional `.cw/project.toml`, and extra files.
async function repoWith(toml: string | null, files: Record<string, string> = {}): Promise<string> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-lite-")));
  await git(repo, ["init"]);
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  for (const [relative, text] of Object.entries(files)) {
    const absolute = path.join(repo, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
  }
  if (toml !== null) {
    await mkdir(path.join(repo, ".cw"), { recursive: true });
    await writeFile(path.join(repo, ".cw", "project.toml"), toml);
  }
  return repo;
}

// 结束检查：`fixed.txt` 存在即通过（无输出）；配一条受保护路径。
// The end check passes when `fixed.txt` exists; one protected path is configured.
const CHECK_TOML = `version = 1

[check]
cmd = ["/bin/sh", "-c", "test -f fixed.txt"]
timeout_s = 5

[protect]
paths = ["tests", "guard file.txt"]
`;

const start = (fake: Fake) => fake.handlers.get("session_start")!({}, fake.ctx);
const settle = (fake: Fake) =>
  fake.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [] }, fake.ctx) as
    Promise<{ entries: Array<{ content: string }>; continue?: boolean } | undefined>;
const toolCall = (fake: Fake, toolName: string, input: Record<string, unknown>) =>
  fake.handlers.get("tool_call")!({ toolName, input, toolCallId: "t1" }, fake.ctx) as
    Promise<{ block?: boolean; reason?: string } | undefined>;

// 取最后一条追加文本（检查报告）。
const lastText = (result: { entries: Array<{ content: string }> }): string =>
  result.entries[result.entries.length - 1]!.content;

// 结算检查全流程：工作树没变也跑；通过报一行；失败反馈一次并续跑；修复轮仍检查；
// 第二次失败如实结束。
// The whole settle flow: an unchanged tree still runs the check; a pass reports
// one line; a failure feeds back once and continues; the repair round is checked
// again; a second failure reports as-is and ends.
test("结算检查：无变化也跑、通过、反馈一次、修复轮仍检查、第二次失败如实结束", async () => {
  const repo = await repoWith(CHECK_TOML, { "tests/a.py": "base\n" });
  try {
    const fake = fakePi(repo);
    await start(fake);
    expect(fake.notifications.some((line) => line.includes("结束检查已启用"))).toBe(true);

    // 第一次失败：事实反馈 + 续跑。
    const feedback = await settle(fake);
    expect(feedback!.continue).toBe(true);
    expect(lastText(feedback!)).toContain("结束检查未通过");
    expect(lastText(feedback!)).toContain("退出码 1");

    // 修复轮：工作树相对上次失败没有再改，检查照样跑，这次通过。
    await writeFile(path.join(repo, "fixed.txt"), "ok\n");
    const passed = await settle(fake);
    expect(passed!.continue).toBeUndefined();
    expect(lastText(passed!)).toContain("结束检查通过");

    // 通过后再结算一次：没有新的用户回合，工作树也没变，检查仍然执行。
    const again = await settle(fake);
    expect(again!.continue).toBeUndefined();
    expect(lastText(again!)).toContain("结束检查通过");

    // 通过不归还额度：同一用户回合里再次失败直接如实结束。
    await rm(path.join(repo, "fixed.txt"));
    const retry = await settle(fake);
    expect(retry!.continue).toBeUndefined();
    expect(lastText(retry!)).toContain("不再自动重试");

    // 新的用户回合恢复额度，并写入 counterweight 段，不碰其它段。
    const prompt = { systemPromptOptions: { sections: { addendum: "keep" } } };
    await fake.handlers.get("before_agent_start")!(prompt, fake.ctx);
    const sections = prompt.systemPromptOptions.sections as Record<string, string>;
    expect(sections.addendum).toBe("keep");
    expect(sections.counterweight).toContain("cw_review");
    await fake.handlers.get("before_agent_start")!(prompt, fake.ctx);
    expect(sections.counterweight.match(/cw_review/g)).toHaveLength(1);
    const renewed = await settle(fake);
    expect(renewed!.continue).toBe(true);
    const final = await settle(fake);
    expect(final!.continue).toBeUndefined();
    expect(lastText(final!)).toContain("未通过");
    expect(lastText(final!)).toContain("不再自动重试");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// 受保护路径拦截：目标文件、目录前缀、别名与悬空链接都被拒绝；安全的新文件放行。
// Protection: the file, its directory prefix, aliases, and dangling links are refused; a safe new file passes.
test("tool_call 拦截受保护目标", async () => {
  const repo = await repoWith(CHECK_TOML, { "tests/a.py": "base\n" });
  try {
    const fake = fakePi(repo);
    await start(fake);

    const blocked = await toolCall(fake, "edit", { path: "tests/a.py" });
    expect(blocked!.block).toBe(true);
    expect(blocked!.reason).toContain("受保护路径");

    expect(await toolCall(fake, "write", { path: "src/new.ts" })).toBeUndefined();

    // pi 写入工具会去掉 @、把 Unicode 空格折成普通空格、展开 file://，这些都命中同一个受保护文件。
    await writeFile(path.join(repo, "guard file.txt"), "secret\n");
    const atPrefixed = await toolCall(fake, "write", { path: "@guard file.txt" });
    expect(atPrefixed!.block).toBe(true);
    expect(atPrefixed!.reason).toContain("guard file.txt");
    const nbsp = await toolCall(fake, "edit", { path: "guard\u00A0file.txt" });
    expect(nbsp!.block).toBe(true);
    const fileUrl = await toolCall(fake, "write", { path: `file://${path.join(repo, "guard file.txt")}` });
    expect(fileUrl!.block).toBe(true);
    expect(await toolCall(fake, "read", { path: "tests/a.py" })).toBeUndefined();

    // 词法上在保护集合之外的别名，解析后指向受保护文件。
    await symlink("tests/a.py", path.join(repo, "alias.py"));
    const alias = await toolCall(fake, "edit", { path: "alias.py" });
    expect(alias!.block).toBe(true);
    expect(alias!.reason).toContain("指向该受保护文件");

    // 悬空别名：写入会沿链接重建无法核对的目标，fail-closed。
    await symlink("missing-target.txt", path.join(repo, "dangling.txt"));
    const dangling = await toolCall(fake, "write", { path: "dangling.txt" });
    expect(dangling!.block).toBe(true);
    expect(dangling!.reason).toContain("符号链接");

    // 目录链接下尚不存在的叶子：alias -> tests，写入 alias/new.ts 等于写入受保护的 tests/new.ts。
    await symlink("tests", path.join(repo, "alias"));
    const missingLeaf = await toolCall(fake, "write", { path: "alias/new.ts" });
    expect(missingLeaf!.block).toBe(true);
    expect(missingLeaf!.reason).toContain("tests/new.ts");

    // 指向仓库根的目录链接：缺失的中间目录与叶子都要落到受保护路径，不能拼成绝对路径后漏判。
    await symlink(".", path.join(repo, "rootlink"));
    const throughRoot = await toolCall(fake, "write", { path: "rootlink/tests/new.ts" });
    expect(throughRoot!.block).toBe(true);
    expect(throughRoot!.reason).toContain("tests/new.ts");

    // 指向仓库外的目录链接：缺失叶子不能借此逃出仓库。
    const outsideDir = await mkdtemp(path.join(tmpdir(), "cw-lite-out-"));
    try {
      await symlink(outsideDir, path.join(repo, "outlink"));
      const escaped = await toolCall(fake, "write", { path: "outlink/gone.ts" });
      expect(escaped!.block).toBe(true);
      expect(escaped!.reason).toContain("无法核对");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }

    // 仓库之外的路径无法核对。
    const outside = await toolCall(fake, "edit", { path: "/etc/hosts" });
    expect(outside!.block).toBe(true);
    expect(outside!.reason).toContain("不在仓库内");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// 没有配置：结算不跑检查，写入（含配置文件与仓库外路径）全部放行；usage 仍然记账。
// Without a config the settle check stays idle and every write passes, including
// the config file and paths outside the repo; usage is still metered.
test("没有配置时结算与保护完全被动", async () => {
  const repo = await repoWith(null, { "src/app.ts": "x\n" });
  try {
    const fake = fakePi(repo);
    await start(fake);
    expect(await settle(fake)).toBeUndefined();
    expect(await toolCall(fake, "edit", { path: "src/app.ts" })).toBeUndefined();
    expect(await toolCall(fake, "write", { path: ".cw/project.toml" })).toBeUndefined();
    expect(await toolCall(fake, "write", { path: "/etc/hosts" })).toBeUndefined();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// 配置非法：通知错误，但工具调用不受影响，也不为了拦截去创建 `.cw/project.toml`。
// An invalid config reports the error and leaves tool calls alone; it does not
// create `.cw/project.toml` just to block it.
test("配置非法时不拦截工具调用", async () => {
  const repo = await repoWith("version = 1\nunknown = true\n");
  try {
    const fake = fakePi(repo);
    await start(fake);
    expect(fake.notifications.some((line) => line.includes("配置加载失败"))).toBe(true);
    expect(await settle(fake)).toBeUndefined();
    expect(await toolCall(fake, "write", { path: ".cw/project.toml" })).toBeUndefined();
    expect(await toolCall(fake, "edit", { path: "/tmp/outside.txt" })).toBeUndefined();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// 初始化预算耗尽时，已经赋上的配置必须清掉，否则回退说了“不拦截”实际仍在拦截。
// An exhausted startup budget clears a config assigned before the fallback, so
// the "not intercepting" notice matches what tool calls actually do.
test("会话初始化超时后不保留已加载的配置", async () => {
  const repo = await repoWith(CHECK_TOML, { "tests/a.py": "base\n" });
  try {
    const fake = fakePi(repo, { sessionStartMs: 1 });
    await start(fake);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.notifications.some((line) => line.includes("未能在时限内完成"))).toBe(true);
    expect(await settle(fake)).toBeUndefined();
    expect(await toolCall(fake, "write", { path: "tests/a.py" })).toBeUndefined();
    expect(await toolCall(fake, "write", { path: ".cw/project.toml" })).toBeUndefined();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// 一次失败链只反馈一次：连续三次失败结算是继续、结束、结束。新的用户回合恢复额度。
// One feedback per failing chain: three consecutive failed settles continue,
// then end, then end. A new user turn restores the allowance.
test("连续三次失败只反馈一次，新用户回合恢复额度", async () => {
  const repo = await repoWith(CHECK_TOML);
  try {
    const fake = fakePi(repo);
    await start(fake);
    const first = await settle(fake);
    const second = await settle(fake);
    const third = await settle(fake);
    expect([first!.continue, second!.continue, third!.continue]).toEqual([true, undefined, undefined]);
    expect(lastText(third!)).toContain("不再自动重试");

    await fake.handlers.get("before_agent_start")!({ systemPromptOptions: { sections: {} } }, fake.ctx);
    const renewed = await settle(fake);
    expect(renewed!.continue).toBe(true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// 在仓库子目录启动：读根上的配置，检查在根上跑，相对路径按 cwd 解析后再和根比较。
// Starting in a repo subdirectory loads the root config, runs the check at the
// root, and resolves relative paths against cwd before comparing with the root.
test("子目录启动使用仓库根", async () => {
  const repo = await repoWith(CHECK_TOML, { "tests/a.py": "base\n", "pkg/app.ts": "x\n" });
  const sub = path.join(repo, "pkg");
  try {
    const fake = fakePi(sub);
    await start(fake);
    expect(fake.notifications.some((line) => line.includes("结束检查已启用"))).toBe(true);

    // 相对 cwd 的 app.ts 是 pkg/app.ts，不在保护集合里。
    expect(await toolCall(fake, "edit", { path: "app.ts" })).toBeUndefined();
    // 从子目录回到受保护路径，以及根上的配置文件，仍然拦截。
    const tests = await toolCall(fake, "write", { path: "../tests/a.py" });
    expect(tests!.block).toBe(true);
    expect(tests!.reason).toContain("受保护路径");
    const config = await toolCall(fake, "write", { path: "../.cw/project.toml" });
    expect(config!.block).toBe(true);

    // 检查命令 `test -f fixed.txt` 以仓库根为 cwd：根上出现该文件即通过。
    await writeFile(path.join(repo, "fixed.txt"), "ok\n");
    const result = await settle(fake);
    expect(lastText(result!)).toContain("结束检查通过");

    await fake.handlers.get("message_end")!({
      message: {
        role: "assistant", model: "g/medium",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
      },
    }, fake.ctx);
    const meter = await readFile(path.join(repo, ".cw", "meter.jsonl"), "utf8");
    expect(meter).toContain("\"kind\":\"usage\"");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// message_end：assistant 的 usage 逐条落 `.cw/meter.jsonl`。
// message_end: assistant usage lands in `.cw/meter.jsonl`.
test("usage 落 meter.jsonl", async () => {
  const repo = await repoWith(null);
  try {
    const fake = fakePi(repo);
    await start(fake);
    await fake.handlers.get("message_end")!({
      message: {
        role: "assistant", model: "g/medium",
        usage: { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, totalTokens: 17, cost: { total: 0.5 } },
      },
    }, fake.ctx);
    const lines = (await readFile(path.join(repo, ".cw", "meter.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "usage", session: "s1", model: "g/medium",
      input: 10, output: 2, cache_read: 4, cache_write: 1, cost_total: 0.5,
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// shutdown：中止在途检查，等整个进程组消亡后才返回。
// Shutdown aborts the in-flight check and returns only after the whole process group is gone.
test("shutdown 回收在途检查进程组", async () => {
  const repo = await repoWith(`version = 1

[check]
cmd = ["/bin/sh", "-c", "sleep 41.7"]
timeout_s = 60
`);
  try {
    const fake = fakePi(repo);
    await start(fake);
    const pending = settle(fake);
    // 等检查子进程真正起来（ps 里能看到标记 sleep）。
    for (let waited = 0; waited < 5_000; waited += 25) {
      const ps = await psOutput();
      if (ps.includes("sleep 41.7")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await psOutput()).toContain("sleep 41.7");
    await fake.handlers.get("session_shutdown")!({}, fake.ctx);
    expect(await pending).toBeUndefined();
    expect(await psOutput()).not.toContain("sleep 41.7");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// 检查自身超时（进程组被终止）后按失败处理：反馈一次并续跑，绝不报告通过。
// A check timing out (group terminated) is a failure: one feedback round, never a pass.
test("检查超时按失败处理", async () => {
  const repo = await repoWith(`version = 1

[check]
cmd = ["/bin/sh", "-c", "sleep 42.9"]
timeout_s = 1
`);
  try {
    const fake = fakePi(repo);
    await start(fake);
    const result = await settle(fake);
    const text = lastText(result!);
    expect(text).toContain("结束检查超时");
    expect(text).not.toContain("结束检查通过");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// 处理预算耗尽（余量设为 0）：如实报告“未能完成”，绝不报告通过。
// An exhausted handler budget (zero margin): an honest "did not finish", never a pass.
test("结算处理超时报告未能完成", async () => {
  const repo = await repoWith(`version = 1

[check]
cmd = ["/bin/sh", "-c", "sleep 43.9"]
timeout_s = 1
`);
  try {
    const fake = fakePi(repo, { checkMarginMs: 0 });
    await start(fake);
    const result = await settle(fake);
    expect(lastText(result!)).toMatch(/结束检查(超时|未能完成)/);
    expect(lastText(result!)).not.toContain("通过");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// ps 输出（-eo args），用于断言进程组残留。
// `ps` output (args only) for asserting process-group leftovers.
function psOutput(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ps", ["-eo", "args"]);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("error", reject);
    child.once("close", () => resolve(out));
  });
}

// OMP 不发 agent_before_settle，发 session_stop：失败走 additionalContext 续跑一次，再失败只通知，通过只通知。
// OMP sends session_stop instead of agent_before_settle: a failure continues once through additionalContext,
// a second failure and a pass only notify.
test("OMP 的 session_stop：失败续跑一次、再失败如实结束、通过", async () => {
  const repo = await repoWith(CHECK_TOML);
  try {
    const fake = fakePi(repo);
    await start(fake);
    const stop = () => fake.handlers.get("session_stop")!({ signal: new AbortController().signal }, fake.ctx) as
      Promise<{ continue?: boolean; additionalContext?: string } | undefined>;

    const first = await stop();
    expect(first?.continue).toBe(true);
    expect(first?.additionalContext).toContain("退出码 1");

    expect(await stop()).toBeUndefined();
    expect(fake.notifications.at(-1)).toContain("结束检查未通过");

    await fake.handlers.get("before_agent_start")!({ systemPrompt: ["base"] }, fake.ctx);
    await writeFile(path.join(repo, "fixed.txt"), "ok\n");
    expect(await stop()).toBeUndefined();
    expect(fake.notifications.at(-1)).toContain("结束检查通过");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 两种宿主的系统提示入口不同：pi 写 sections，OMP 返回追加后的 systemPrompt 数组。
// The two hosts take the prompt differently: pi writes sections, OMP returns the extended array.
test("before_agent_start：pi 写 sections，OMP 返回替换数组", async () => {
  const repo = await repoWith(null);
  try {
    const fake = fakePi(repo);
    const handler = fake.handlers.get("before_agent_start")!;
    const sections: Record<string, string> = {};
    expect(await handler({ systemPromptOptions: { sections } }, fake.ctx)).toBeUndefined();
    expect(sections.counterweight).toContain("INTJ");

    const omp = await handler({ systemPrompt: ["base"] }, fake.ctx) as { systemPrompt: string[] };
    expect(omp.systemPrompt[0]).toBe("base");
    expect(omp.systemPrompt).toHaveLength(2);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
