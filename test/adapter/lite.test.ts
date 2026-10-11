/**
 * 轻量适配层测试：结算检查（跳过/通过/反馈一次/如实结束）、受保护路径拦截（含别名与悬空链接）、
 * 受保护文件变化报告、usage 记账与 shutdown 回收。
 *
 * Lite adapter tests: the settle check (skip/pass/one-feedback/final report),
 * protected-path interception (aliases and dangling links included), the
 * protected-change report, usage metering, and shutdown reaping.
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
paths = ["tests"]
`;

const start = (fake: Fake) => fake.handlers.get("session_start")!({}, fake.ctx);
const settle = (fake: Fake) =>
  fake.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [] }, fake.ctx) as
    Promise<{ entries: Array<{ content: string }>; continue?: boolean } | undefined>;
const toolCall = (fake: Fake, toolName: string, input: Record<string, unknown>) =>
  fake.handlers.get("tool_call")!({ toolName, input, toolCallId: "t1" }, fake.ctx) as
    Promise<{ block?: boolean; reason?: string } | undefined>;

// 改动工作树里的一个文件，制造“自上次检查以来的变化”。
// Writes one file so the worktree differs from the last check.
const bump = (repo: string, n: number) => writeFile(path.join(repo, `bump-${n}.txt`), `${n}\n`);

// 取最后一条追加文本（检查报告）。
const lastText = (result: { entries: Array<{ content: string }> }): string =>
  result.entries[result.entries.length - 1]!.content;

// 结算检查全流程：无变化不跑；通过报一行；失败反馈一次并续跑；第二次失败如实结束。
// The whole settle flow: no change runs nothing; a pass reports one line; a failure feeds
// back once and continues; a second failure reports as-is and ends.
test("结算检查：跳过、通过、反馈一次、第二次失败如实结束", async () => {
  const repo = await repoWith(CHECK_TOML, { "tests/a.py": "base\n" });
  try {
    const fake = fakePi(repo);
    await start(fake);
    expect(fake.notifications.some((line) => line.includes("结束检查已启用"))).toBe(true);

    // 没有变化：不跑检查。
    expect(await settle(fake)).toBeUndefined();

    // 第一次失败：事实反馈 + 续跑。
    await bump(repo, 1);
    const feedback = await settle(fake);
    expect(feedback!.continue).toBe(true);
    expect(lastText(feedback!)).toContain("结束检查未通过");
    expect(lastText(feedback!)).toContain("退出码 1");

    // 修好（fixed.txt 出现）：通过，不再续跑。
    await writeFile(path.join(repo, "fixed.txt"), "ok\n");
    await bump(repo, 2);
    const passed = await settle(fake);
    expect(passed!.continue).toBeUndefined();
    expect(lastText(passed!)).toContain("结束检查通过");

    // 通过后无变化：跳过。
    expect(await settle(fake)).toBeUndefined();

    // 再次失败：第一次反馈后仍旧失败，如实报告并结束（不再重试）。
    await rm(path.join(repo, "fixed.txt"));
    await bump(repo, 3);
    const retry = await settle(fake);
    expect(retry!.continue).toBe(true);
    await bump(repo, 4);
    const final = await settle(fake);
    expect(final!.continue).toBeUndefined();
    expect(lastText(final!)).toContain("未通过");
    expect(lastText(final!)).toContain("不再自动重试");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// 受保护文件被 bash 等旁路修改：结算时如实报告一行，不拦截、不还原。
// A protected file changed outside edit/write: reported as a fact at settle, never blocked or reverted.
test("受保护文件的变化在结算时被报告", async () => {
  const repo = await repoWith(CHECK_TOML, { "tests/a.py": "base\n" });
  try {
    const fake = fakePi(repo);
    await start(fake);
    await writeFile(path.join(repo, "tests", "a.py"), "tampered\n");
    await bump(repo, 1);
    const result = await settle(fake);
    expect(lastText(result!)).toContain("受保护文件发生变化：tests/a.py");
    expect(await readFile(path.join(repo, "tests", "a.py"), "utf8")).toBe("tampered\n");
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

    // 仓库之外的路径无法核对。
    const outside = await toolCall(fake, "edit", { path: "/etc/hosts" });
    expect(outside!.block).toBe(true);
    expect(outside!.reason).toContain("不在仓库内");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// `.cw/project.toml` 是 harness 的控制面：没有配置文件时也不能被模型写入。
// `.cw/project.toml` is the harness control file: even without a config the model cannot write it.
test("没有配置文件时仍拦截 .cw/project.toml，其余读写放行", async () => {
  const repo = await repoWith(null);
  try {
    const fake = fakePi(repo);
    await start(fake);
    const blocked = await toolCall(fake, "write", { path: ".cw/project.toml" });
    expect(blocked!.block).toBe(true);
    expect(await toolCall(fake, "edit", { path: "src/app.ts" })).toBeUndefined();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);

// 没有配置：结算与写入保护完全被动，但 usage 仍然记账。
// Without a config the settle check and the write guard stay passive; usage is still metered.
test("没有配置时结算与保护完全被动", async () => {
  const repo = await repoWith(null, { "src/app.ts": "x\n" });
  try {
    const fake = fakePi(repo);
    await start(fake);
    await bump(repo, 1);
    expect(await settle(fake)).toBeUndefined();
    expect(await toolCall(fake, "edit", { path: "src/app.ts" })).toBeUndefined();
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
    await bump(repo, 1);
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
    await bump(repo, 1);
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
    await bump(repo, 1);
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
