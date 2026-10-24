/**
 * 适配层的 PAUSE 与强制启用：首次改源码被拦一次并带回计划、失败一律放行、草稿不算；
 * 结算时自动审查（发现交回主模型并续跑一次）与自动汇报；默认全关时完全被动。
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import counterweight, { type AdapterTimeouts } from "../../src/adapters/pi/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
const fakeCli = path.join(import.meta.dirname, "../fixtures/role/fake-pi.mjs");

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")}`)));
  });
}

interface Setup {
  repo: string;
  handlers: Map<string, Handler>;
  ctx: ExtensionContext;
  calls: () => Promise<Array<{ role: string; argv: string[]; message: string }>>;
}

async function setup(toml: string, timeouts?: Partial<AdapterTimeouts>, realWaitMs?: number): Promise<Setup> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-auto-")));
  await git(repo, ["init"]);
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["-c", "user.email=a@b.c", "-c", "user.name=cw", "commit", "-m", "base"]);
  await mkdir(path.join(repo, ".cw"), { recursive: true });
  await writeFile(path.join(repo, ".cw", "project.toml"), toml);
  const callsFile = path.join(repo, ".cw", "calls.jsonl");
  process.env.CW_FAKE_CALLS_FILE = callsFile;
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => undefined; },
    registerTool: () => undefined,
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI;
  counterweight(pi, { ...timeouts }, fakeCli, realWaitMs);
  const ctx = {
    cwd: repo,
    signal: undefined,
    ui: { notify: () => undefined },
    sessionManager: {
      getSessionId: () => "s1",
      buildSessionProjection: () => ({ messages: [
        { role: "user", content: "修复绑定" },
        { role: "assistant", content: [{ type: "text", text: "读了 src/binding.ts，问题在释放顺序" }] },
      ] }),
    },
    hasUI: true,
  } as unknown as ExtensionContext;
  await handlers.get("session_start")!({}, ctx);
  return {
    repo, handlers, ctx,
    calls: async () => {
      try {
        const text = await readFile(callsFile, "utf8");
        return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

const MODELS = `version = 1

[models]
review = "g/review"
over_review = "g/over"
historian = "g/historian"
planner = "g/planner"
`;

const cleanup: string[] = [];
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (key.startsWith("CW_FAKE_")) delete process.env[key];
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

const edit = (s: Setup, file: string) =>
  s.handlers.get("tool_call")!({ toolName: "edit", input: { path: file }, toolCallId: "t" }, s.ctx) as
    Promise<{ block?: boolean; reason?: string } | undefined>;
const newTurn = (s: Setup, prompt = "修复绑定") =>
  s.handlers.get("before_agent_start")!({ prompt, systemPromptOptions: { sections: {} } }, s.ctx);
const settle = (s: Setup) =>
  s.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [] }, s.ctx) as
    Promise<{ entries: Array<{ content: string }>; continue?: boolean } | undefined>;

test("PAUSE：首次改源码拦一次并带回计划；planner 无工具且看到调查；第二次放行", async () => {
  const s = await setup(`${MODELS}\n[auto]\npause = true\n`);
  cleanup.push(s.repo);
  process.env.CW_FAKE_TEXT_PLANNER = "根因：释放顺序\n位置：src/binding.ts";
  await newTurn(s);

  const first = await edit(s, "src/binding.ts");
  expect(first!.block).toBe(true);
  expect(first!.reason).toContain("根因：释放顺序");
  expect(first!.reason).toContain("不会再出现");

  const [call] = await s.calls();
  expect(call!.role).toBe("planner");
  expect(call!.argv).toContain("--no-tools");
  expect(call!.argv).not.toContain("read,grep");
  expect(call!.message).toContain("修复绑定");
  expect(call!.message).toContain("问题在释放顺序");
  expect(call!.message).toContain("edit src/binding.ts");

  expect(await edit(s, "src/binding.ts")).toBeUndefined();
  expect((await s.calls()).length).toBe(1);
  const meter = await readFile(path.join(s.repo, ".cw", "meter.jsonl"), "utf8");
  expect(meter).toMatch(/"event":"pause".*"outcome":"planned"/);
});

test("PAUSE：新用户回合恢复一次；草稿路径不算也不耗额度", async () => {
  const s = await setup(`${MODELS}\n[auto]\npause = true\n`);
  cleanup.push(s.repo);
  await newTurn(s);
  expect(await edit(s, ".cw/notes.md")).toBeUndefined();
  expect(await edit(s, "tmp/repro.sh")).toBeUndefined();
  expect((await s.calls()).length).toBe(0);

  expect((await edit(s, "src/a.ts"))!.block).toBe(true);
  expect(await edit(s, "src/b.ts")).toBeUndefined();
  await newTurn(s, "下一个任务");
  expect((await edit(s, "src/c.ts"))!.block).toBe(true);
});

test("PAUSE：planner 失败或超时一律放行这次编辑，且不再重试", async () => {
  const s = await setup(`${MODELS}\n[auto]\npause = true\n`, { pauseMs: 400 });
  cleanup.push(s.repo);
  process.env.CW_FAKE_ROLE = "empty";
  await newTurn(s);
  expect(await edit(s, "src/a.ts")).toBeUndefined();
  expect(await edit(s, "src/b.ts")).toBeUndefined();
  expect((await s.calls()).length).toBe(1);
  expect(await readFile(path.join(s.repo, ".cw", "meter.jsonl"), "utf8")).toMatch(/"event":"pause".*"outcome":"failed"/);
});

test("PAUSE：受保护路径先拦，不浪费 planner；没开 pause 时完全被动", async () => {
  const guarded = await setup(`${MODELS}\n[protect]\npaths = ["tests"]\n\n[auto]\npause = true\n`);
  cleanup.push(guarded.repo);
  await newTurn(guarded);
  const blocked = await edit(guarded, "tests/a.py");
  expect(blocked!.reason).toContain("受保护路径");
  expect((await guarded.calls()).length).toBe(0);
  expect((await edit(guarded, "src/a.ts"))!.reason).toContain("planner");

  const off = await setup(MODELS);
  cleanup.push(off.repo);
  await newTurn(off);
  expect(await edit(off, "src/a.ts")).toBeUndefined();
  expect((await off.calls()).length).toBe(0);
});

test("自动审查：发现交回主模型并续跑一次；续跑后的结算照样审查，但不再续跑", async () => {
  const s = await setup(`${MODELS}\n[auto]\nreview = true\n`);
  cleanup.push(s.repo);
  await writeFile(path.join(s.repo, "tracked.txt"), "changed\n");
  process.env.CW_FAKE_TEXT_REVIEW = "WRONG `a.ts:f`\n期望：x\n实际：y";
  process.env.CW_FAKE_TEXT_OVER_REVIEW = "none";
  await newTurn(s);

  const first = await settle(s);
  expect(first!.continue).toBe(true);
  expect(first!.entries.at(-1)!.content).toContain("WRONG `a.ts:f`");
  const roles = (await s.calls()).map((call) => call.role).sort();
  expect(roles).toEqual(["over_review", "review"]);
  const reviewCall = (await s.calls()).find((call) => call.role === "review")!;
  expect(reviewCall.message).toContain("修复绑定");
  expect(reviewCall.message).toContain("+changed");

  // 额度只限制续跑次数：最终 diff 仍被审查，发现作为事实附上，不再打断主模型。
  const second = await settle(s);
  expect(second?.continue).toBeUndefined();
  expect((await s.calls()).length).toBe(4);
  expect(second!.entries.at(-1)!.content).toContain("不再续跑");
});

test("自动审查：两边都说 none 或 ASK 就不打扰主模型；没有改动不审查", async () => {
  const s = await setup(`${MODELS}\n[auto]\nreview = true\n`);
  cleanup.push(s.repo);
  process.env.CW_FAKE_TEXT_REVIEW = "none";
  process.env.CW_FAKE_TEXT_OVER_REVIEW = "ASK:\n要解决什么？";
  await newTurn(s);
  expect(await settle(s)).toBeUndefined();
  expect((await s.calls()).length).toBe(0);

  await writeFile(path.join(s.repo, "tracked.txt"), "changed\n");
  expect(await settle(s)).toBeUndefined();
  expect((await s.calls()).length).toBe(2);
});

test("自动汇报：有改动才汇报，带请求与文件，写入 HISTORY.md", async () => {
  const s = await setup(`${MODELS}\n[auto]\nchronicle = true\n`);
  cleanup.push(s.repo);
  process.env.CW_FAKE_TEXT_HISTORIAN = "# 史\n\n新华社电";
  await newTurn(s, "把绑定修好");
  await settle(s);
  expect((await s.calls()).length).toBe(0);

  await writeFile(path.join(s.repo, "tracked.txt"), "changed\n");
  await settle(s);
  const [call] = await s.calls();
  expect(call!.role).toBe("historian");
  expect(call!.message).toContain("把绑定修好");
  expect(call!.message).toContain("tracked.txt");
  expect(await readFile(path.join(s.repo, ".cw", "HISTORY.md"), "utf8")).toBe("# 史\n\n新华社电\n");
});

test("审查有发现的那一轮不汇报；它的失败不影响结束检查的结论", async () => {
  const s = await setup(`${MODELS}
[check]
cmd = ["/bin/sh", "-c", "true"]
timeout_s = 5

[auto]
review = true
chronicle = true
`);
  cleanup.push(s.repo);
  await writeFile(path.join(s.repo, "tracked.txt"), "changed\n");
  process.env.CW_FAKE_TEXT_REVIEW = "WRONG `a:f`\n期望：x\n实际：y";
  await newTurn(s);
  const result = await settle(s);
  expect(result!.entries.map((entry) => entry.content).join("\n")).toContain("结束检查");
  expect(result!.continue).toBe(true);
  expect((await s.calls()).some((call) => call.role === "historian")).toBe(false);

  process.env.CW_FAKE_ROLE = "empty";
  const s2 = await setup(`${MODELS}
[check]
cmd = ["/bin/sh", "-c", "true"]
timeout_s = 5

[auto]
review = true
`);
  cleanup.push(s2.repo);
  await writeFile(path.join(s2.repo, "tracked.txt"), "changed\n");
  await newTurn(s2);
  const passed = await settle(s2);
  expect(passed!.entries.map((entry) => entry.content).join("\n")).toContain("结束检查");
  expect(passed!.continue).toBeUndefined();
});

test("提示按 [auto] 裁剪：强制启用的角色不再叫主模型自己调用", async () => {
  const sections = async (toml: string): Promise<string> => {
    const s = await setup(toml);
    cleanup.push(s.repo);
    const options = { sections: {} as Record<string, string> };
    await s.handlers.get("before_agent_start")!({ prompt: "x", systemPromptOptions: options }, s.ctx);
    return options.sections.counterweight!;
  };
  // 默认：叫主模型自己调；强制后：不再叫。用“call cw_xxx”这个指令词判断，不绑定整句。
  const tellsToCallReview = (text: string) => /call cw_review/.test(text);
  const tellsToReportChronicle = (text: string) => /report it to cw_chronicle/.test(text);

  const plain = await sections(MODELS);
  expect(tellsToCallReview(plain)).toBe(true);
  expect(tellsToReportChronicle(plain)).toBe(true);

  const forced = await sections(`${MODELS}\n[auto]\nreview = true\nchronicle = true\n`);
  expect(tellsToCallReview(forced)).toBe(false);
  expect(tellsToReportChronicle(forced)).toBe(false);

  const half = await sections(`${MODELS}\n[auto]\nreview = true\n`);
  expect(tellsToCallReview(half)).toBe(false);
  expect(tellsToReportChronicle(half)).toBe(true);
});

test("[timeouts] 到达角色子进程：配 300 秒的 review 挂住时，在真实等待到点后被终止并记 timed_out", async () => {
  // 配置值是合法的 300 秒；realWaitMs 只把真实等待压到 1 秒，让测试能在秒级结束。
  const s = await setup(`${MODELS}\n[timeouts]\nreview = 300\nover_review = 300\n\n[auto]\nreview = true\n`, undefined, 1_000);
  cleanup.push(s.repo);
  await writeFile(path.join(s.repo, "tracked.txt"), "changed\n");
  process.env.CW_FAKE_ROLE = "hang";
  await newTurn(s);
  const started = Date.now();
  const result = await settle(s);
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(result?.continue).toBeUndefined();
  const meter = await readFile(path.join(s.repo, ".cw", "meter.jsonl"), "utf8");
  expect(meter).toMatch(/"event":"review".*"outcome":"failed".*"timed_out":true/);
}, 30_000);

test("没配 [timeouts] 时用内置默认", async () => {
  const { roleTimeoutMs } = await import("../../src/roles/run.ts");
  expect(roleTimeoutMs("review")).toBe(300_000);
  expect(roleTimeoutMs("planner")).toBe(300_000);
  expect(roleTimeoutMs("research")).toBe(1_800_000);
});

test("外层预算跟随角色超时：配得比外层默认余量长的审查不会被外层先掐掉", async () => {
  // review 配 1800 秒（合法上限），假审查 2 秒后才回答。外层预算由 1800 秒推出，远大于 2 秒；
  // 若外层预算是固定的短值，这里会在审查回答之前被掐断。
  const s = await setup(`${MODELS}
[check]
cmd = ["/bin/sh", "-c", "true"]
timeout_s = 5

[timeouts]
review = 1800
over_review = 1800

[auto]
review = true
`, { checkMarginMs: 0 });
  cleanup.push(s.repo);
  await writeFile(path.join(s.repo, "tracked.txt"), "changed\n");
  process.env.CW_FAKE_DELAY_MS = "2000";
  process.env.CW_FAKE_TEXT_REVIEW = "WRONG `a:f`\n期望：x\n实际：y";
  process.env.CW_FAKE_TEXT_OVER_REVIEW = "none";
  await newTurn(s);
  const result = await settle(s);
  expect(result?.continue).toBe(true);
  expect(result!.entries.at(-1)!.content).toContain("WRONG `a:f`");
}, 30_000);
