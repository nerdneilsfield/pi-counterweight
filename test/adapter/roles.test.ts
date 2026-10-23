/**
 * 四个角色：子进程拿到对应的提示和模型，正文走临时文件，回答和用量回到计量。
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { loadProjectConfig, type ProjectConfig } from "../../src/core/config.ts";
import { registerTools } from "../../src/adapters/pi/tools.ts";
import { rolePromptPath } from "../../src/roles/prompts.ts";
import { roleArgv } from "../../src/roles/run.ts";

const fakeCli = path.join(import.meta.dirname, "../fixtures/role/fake-pi.mjs");

type ToolExecute = (
  toolCallId: string, params: Record<string, string>, signal: AbortSignal | undefined,
  onUpdate: undefined, ctx: ExtensionToolContext,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

async function setup(): Promise<{
  repo: string;
  tools: Map<string, { execute: ToolExecute }>;
  cleanup: () => Promise<void>;
}> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-roles-")));
  await mkdir(path.join(repo, ".cw"), { recursive: true });
  await writeFile(path.join(repo, ".cw", "project.toml"), `version = 1

[models]
explorer = "g/explorer"
review = "g/review"
over_review = "openrouter/anthropic/blunt"
research = "g/research"
`);
  const project: ProjectConfig | null = await loadProjectConfig(repo);
  process.env.CW_FAKE_ROLE = "answer";
  process.env.CW_FAKE_ARGV_FILE = path.join(repo, ".cw", "fake-argv.json");
  const tools = new Map<string, { execute: ToolExecute }>();
  const pi = {
    registerTool: (tool: { name: string; execute: ToolExecute }) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  registerTools(pi, { getProject: () => project, getRepo: () => repo, cliPath: fakeCli, timeoutMs: {
    explorer: 5_000, review: 5_000, over_review: 5_000, research: 5_000,
  } });
  return {
    repo,
    tools,
    cleanup: async () => {
      delete process.env.CW_FAKE_ROLE;
      delete process.env.CW_FAKE_ARGV_FILE;
      await rm(repo, { recursive: true, force: true });
    },
  };
}

const ctx = { sessionManager: { getSessionId: () => "s1" } } as unknown as ExtensionToolContext;

test("review 和 over_review 拿到不同的提示与模型，diff 经临时文件传入", async () => {
  const { repo, tools, cleanup } = await setup();
  try {
    const review = await tools.get("cw_review")!.execute("1", {
      request: "修复绑定", diff: "@@ -1 +1 @@\n-a\n+b\n",
    }, undefined, undefined, ctx);
    const reviewArgv = JSON.parse(await readFile(path.join(repo, ".cw", "fake-argv.json"), "utf8")) as string[];
    expect(reviewArgv).toContain("--system-prompt");
    expect(reviewArgv[reviewArgv.indexOf("--system-prompt") + 1]).toBe(rolePromptPath("review"));
    expect(reviewArgv[reviewArgv.indexOf("--model") + 1]).toBe("g/review");
    expect(reviewArgv).toContain("--no-extensions");
    expect(reviewArgv).toContain("--tools");
    expect(reviewArgv[reviewArgv.indexOf("--tools") + 1]).toBe("read,grep");
    const reviewAt = reviewArgv.find((arg) => arg.startsWith("@"));
    expect(reviewAt).toBeDefined();
    expect(review.content[0]?.text).toContain("修复绑定");

    const over = await tools.get("cw_over_review")!.execute("2", {
      request: "修复绑定", diff: "@@ fallback\n",
    }, undefined, undefined, ctx);
    const overArgv = JSON.parse(await readFile(path.join(repo, ".cw", "fake-argv.json"), "utf8")) as string[];
    expect(overArgv[overArgv.indexOf("--system-prompt") + 1]).toBe(rolePromptPath("over_review"));
    expect(overArgv[overArgv.indexOf("--model") + 1]).toBe("openrouter/anthropic/blunt");
    expect(over.content[0]?.text).toContain("cw_over_review");

    const meter = await readFile(path.join(repo, ".cw", "meter.jsonl"), "utf8");
    expect(meter).toContain('"event":"review"');
    expect(meter).toContain('"event":"over_review"');
    expect(meter).toMatch(/"event":"review".*"result":"answer".*"ms":\d+/);
    expect(meter).toContain('"kind":"usage"');
  } finally {
    await cleanup();
  }
});

test("没配的角色返回不可用，不启动子进程", async () => {
  const { repo, tools, cleanup } = await setup();
  try {
    const project = await loadProjectConfig(repo);
    expect(project?.models.research).toBe("g/research");
    const bare = { ...project!, models: { ...project!.models, research: null } };
    const local = new Map<string, { execute: ToolExecute }>();
    registerTools({ registerTool: (tool: { name: string; execute: ToolExecute }) => local.set(tool.name, tool) } as unknown as ExtensionAPI, {
      getProject: () => bare, getRepo: () => repo, cliPath: fakeCli,
    });
    const result = await local.get("cw_research")!.execute("1", { question: "为什么" }, undefined, undefined, ctx);
    expect(result.content[0]?.text).toContain("未配置");
  } finally {
    await cleanup();
  }
});

test("史官：整份文档写入 HISTORY.md；ASK 和非文档回答不改文件", async () => {
  const { repo, tools, cleanup } = await setup();
  const historian = { models: { historian: "g/historian" } };
  try {
    const project = await loadProjectConfig(repo);
    const local = new Map<string, { execute: ToolExecute }>();
    registerTools({ registerTool: (tool: { name: string; execute: ToolExecute }) => local.set(tool.name, tool) } as unknown as ExtensionAPI, {
      getProject: () => ({ ...project!, models: { ...project!.models, ...historian.models } }),
      getRepo: () => repo, cliPath: fakeCli, timeoutMs: { historian: 5_000 },
    });
    const file = path.join(repo, ".cw", "HISTORY.md");
    const run = (report: string) => local.get("cw_chronicle")!.execute("1", { report }, undefined, undefined, ctx);

    process.env.CW_FAKE_ROLE_TEXT = "# 史\n\n新华社电";
    expect((await run("首次")).content[0]?.text).toContain("已更新");
    expect(await readFile(file, "utf8")).toBe("# 史\n\n新华社电\n");

    process.env.CW_FAKE_ROLE_TEXT = "ASK:\n提交日期是哪天？";
    const ask = await run("补充");
    expect(ask.content[0]?.text).toContain("提交日期是哪天");
    expect(await readFile(file, "utf8")).toBe("# 史\n\n新华社电\n");

    process.env.CW_FAKE_ROLE_TEXT = "好的，收到";
    expect((await run("闲话")).content[0]?.text).toContain("文档未改动");
    expect(await readFile(file, "utf8")).toBe("# 史\n\n新华社电\n");
    expect(tools.has("cw_chronicle")).toBe(true);
  } finally {
    delete process.env.CW_FAKE_ROLE_TEXT;
    await cleanup();
  }
});

// OMP 不认 pi 的几个开关，传了就报错退出，且 `--` 之后的 @file 会被当成文本。
// OMP rejects several pi flags and treats an @file after `--` as text.
test("子进程参数按宿主区分", () => {
  const pi = roleArgv("pi", "review", "g/m", "/t/message.md");
  expect(pi).toContain("--offline");
  expect(pi.slice(-2)).toEqual(["--", "@/t/message.md"]);

  const omp = roleArgv("omp", "review", "g/m", "/t/message.md");
  for (const flag of ["--offline", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve", "--"]) {
    expect(omp).not.toContain(flag);
  }
  expect(omp.at(-1)).toBe("@/t/message.md");
  expect(omp[omp.indexOf("--tools") + 1]).toBe("read,grep");
});

test("OMP 专用字段：工具留在顶层，只读角色按 read 审批，史官按 write", async () => {
  const seen = new Map<string, { loadMode?: string; approval?: string }>();
  registerTools({ registerTool: (tool: { name: string; loadMode?: string; approval?: string }) => seen.set(tool.name, tool) } as unknown as ExtensionAPI, {
    getProject: () => null, getRepo: () => null,
  });
  expect([...seen.values()].every((tool) => tool.loadMode === "essential")).toBe(true);
  expect(seen.get("cw_review")?.approval).toBe("read");
  expect(seen.get("cw_chronicle")?.approval).toBe("write");
});
