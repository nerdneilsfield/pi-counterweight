/**
 * `.cw/repos.txt` 多仓库支持：临时目录里的真实 git 仓库 A/B、A/C、A/D，B 为主仓库。
 * 覆盖读取与归属、保护与范围、PAUSE、回合基线与 diff、结束检查；没有 repos.txt 时行为不变。
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import counterweight from "../../src/adapters/pi/index.ts";
import { changedFiles, snapshotTree, workingDiff } from "../../src/core/auto.ts";
import { ownerOf, readRepos } from "../../src/core/repos.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
const fakeCli = path.join(import.meta.dirname, "../fixtures/role/fake-pi.mjs");

let A: string, B: string, C: string, D: string;
const put = async (file: string, text: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};
const initRepo = async (dir: string) => {
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git("init", "-q");
  await put(path.join(dir, "README"), "x\n");
  await put(path.join(dir, "src/a.ts"), "1\n");
  git("add", "README", "src/a.ts");
  git("commit", "-qm", "init");
};
const listRepos = (...lines: string[]) => put(path.join(B, ".cw/repos.txt"), `${lines.join("\n")}\n`);

beforeEach(async () => {
  A = await realpath(await mkdtemp(path.join(tmpdir(), "cw-multi-")));
  [B, C, D] = ["B", "C", "D"].map((name) => path.join(A, name)) as [string, string, string];
  for (const dir of [B, C, D]) await initRepo(dir);
});
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (key.startsWith("CW_FAKE_")) delete process.env[key];
  await rm(A, { recursive: true, force: true });
});

const protectSecret = 'version = 1\n[protect]\npaths = ["secret"]\n';

interface Session {
  handlers: Map<string, Handler>;
  ctx: ExtensionContext;
  call: (tool: string, file: string) => Promise<{ block?: boolean; reason?: string } | undefined>;
  newTurn: () => Promise<unknown>;
  settle: () => Promise<{ entries: Array<{ content: string }>; continue?: boolean } | undefined>;
}

/** 在 B 上启动一个会话；`mainToml` 为 null 时 B 没有 project.toml。 */
async function session(mainToml: string | null): Promise<Session> {
  if (mainToml !== null) await put(path.join(B, ".cw/project.toml"), mainToml);
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => undefined; },
    registerTool: () => undefined,
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI;
  counterweight(pi, {}, fakeCli);
  const ctx = {
    cwd: B,
    signal: undefined,
    ui: { notify: () => undefined },
    sessionManager: {
      getSessionId: () => "s1",
      buildSessionProjection: () => ({ messages: [{ role: "user", content: "改 C" }] }),
    },
    hasUI: true,
  } as unknown as ExtensionContext;
  await handlers.get("session_start")!({}, ctx);
  return {
    handlers, ctx,
    call: (tool, file) => handlers.get("tool_call")!({ toolName: tool, input: { path: file }, toolCallId: "t" }, ctx) as never,
    newTurn: () => handlers.get("before_agent_start")!({ prompt: "改 C", systemPromptOptions: { sections: {} } }, ctx) as never,
    settle: () => handlers.get("agent_before_settle")!({ outcome: "completed", entries: [] }, ctx) as never,
  };
}

describe("readRepos and ownerOf", () => {
  it("keeps valid repos and drops .., nested, missing, non-git, main and duplicate entries", async () => {
    await mkdir(path.join(A, "plain"));
    await initRepo(path.join(B, "nested"));
    await listRepos("# comment", "", "../C", "../C", `${D}`, "..", "nested", "../missing", "../plain", ".", "../B");
    expect(await readRepos(B)).toEqual([C, D]);
  });

  it("is empty without the file", async () => {
    expect(await readRepos(B)).toEqual([]);
  });

  it("resolves symlinks and missing leaves", async () => {
    await symlink(C, path.join(B, "link"));
    await listRepos("../C");
    const extras = await readRepos(B);
    expect(await ownerOf(B, extras, path.join(B, "link/src/new/x.ts"))).toEqual({ repo: C, relative: "src/new/x.ts" });
    expect(await ownerOf(B, extras, path.join(B, "src/a.ts"))).toEqual({ repo: B, relative: "src/a.ts" });
    expect(await ownerOf(B, extras, path.join(D, "src/a.ts"))).toBeNull();
  });
});

describe("protection and scope across repos", () => {
  beforeEach(async () => {
    await listRepos("../C", "../D");
    await put(path.join(C, ".cw/project.toml"), protectSecret);
  });

  it("denies a protected path of C using C's own config, allows ordinary files", async () => {
    const s = await session("version = 1\n");
    const denied = await s.call("write", path.join(C, "secret/k.txt"));
    expect(denied?.block).toBe(true);
    expect(denied?.reason).toContain("C/secret/k.txt");
    expect(await s.call("write", path.join(C, "src/a.ts"))).toBeUndefined();
    expect(await s.call("write", "../C/src/new.ts")).toBeUndefined();
    expect((await s.call("write", "../C/.cw/project.toml"))?.block).toBe(true);
  });

  it("does not leak B's protect list into C", async () => {
    const s = await session(protectSecret);
    expect(await s.call("write", path.join(C, "src/secret"))).toBeUndefined();
    expect((await s.call("write", "secret/x"))?.block).toBe(true);
  });

  it("applies the minimal protection to a repo without project.toml", async () => {
    const s = await session("version = 1\n");
    expect((await s.call("write", path.join(D, ".cw/goal.md")))?.reason).toContain("D/.cw/goal.md");
    expect((await s.call("write", path.join(D, ".cw/repos.txt")))?.block).toBe(true);
    expect(await s.call("write", path.join(D, "src/a.ts"))).toBeUndefined();
    expect(await s.call("write", path.join(D, "secret/k"))).toBeUndefined();
  });

  it("uses C's scope.txt, not B's", async () => {
    await put(path.join(C, ".cw/scope.txt"), "src\n");
    const s = await session("version = 1\n");
    expect((await s.call("write", path.join(C, "lib/x.ts")))?.reason).toContain("C/lib/x.ts");
    expect(await s.call("write", path.join(C, "src/x.ts"))).toBeUndefined();
    expect(await s.call("write", path.join(D, "anything.ts"))).toBeUndefined();
    await put(path.join(B, ".cw/scope.txt"), "app\n");
    expect(await s.call("write", path.join(C, "src/x.ts"))).toBeUndefined();
    expect((await s.call("write", path.join(B, "src/x.ts")))?.reason).toContain("scope.txt");
    // Outside every repo stays denied while B's scope is active.
    expect((await s.call("write", path.join(A, "elsewhere.ts")))?.block).toBe(true);
  });

  it("judges a path through a symlink from B by C's rules", async () => {
    await symlink(C, path.join(B, "link"));
    await put(path.join(C, ".cw/scope.txt"), "src\n");
    const s = await session("version = 1\n");
    expect((await s.call("write", "link/secret/k.txt"))?.block).toBe(true);
    expect(await s.call("write", "link/src/a.ts")).toBeUndefined();
    expect((await s.call("write", "link/lib/x.ts"))?.reason).toContain("scope.txt");
  });

  it("rejects writes to .cw/repos.txt with and without project.toml", async () => {
    for (const toml of ["version = 1\n", null]) {
      const s = await session(toml);
      expect((await s.call("write", ".cw/repos.txt"))?.reason).toContain("repos.txt");
      expect(await s.call("write", "src/a.ts")).toBeUndefined();
    }
  });
});

describe("without repos.txt", () => {
  it("leaves outside paths unjudged by an extra repo, denied under a scope, and the baseline a plain tree id", async () => {
    const s = await session(protectSecret);
    expect((await s.call("write", path.join(C, "secret/k")))?.reason).toContain("不在仓库内");
    await put(path.join(B, ".cw/scope.txt"), "src\n");
    expect((await s.call("write", path.join(C, "src/x")))?.block).toBe(true);
    expect(await snapshotTree(B)).toMatch(/^[0-9a-f]{40,}$/);
  });
});

describe("baseline, diff, changed files", () => {
  it("covers C and ignores unchanged repos", async () => {
    await listRepos("../C", "../D");
    const base = (await snapshotTree(B))!;
    expect(JSON.parse(base)).toHaveProperty([C]);
    expect(await workingDiff(B, base)).toBe("");
    expect(await changedFiles(B, base)).toEqual([]);
    await put(path.join(C, "src/a.ts"), "2\n");
    await put(path.join(C, "new.ts"), "n\n");
    await put(path.join(B, "b.ts"), "b\n");
    const diff = (await workingDiff(B, base))!;
    expect(diff).toContain("# repo: C\n");
    expect(diff).toContain("a/C/src/a.ts");
    expect(diff).toContain("+n");
    expect(diff).toContain("b/b.ts");
    expect(diff).not.toContain("# repo: D");
    expect((await changedFiles(B, base)).sort()).toEqual(["C/new.ts", "C/src/a.ts", "b.ts"]);
  });

  it("skips a repo whose snapshot fails", async () => {
    await listRepos("../C");
    await rm(path.join(C, ".git"), { recursive: true });
    await writeFile(path.join(C, ".git"), "gitdir: /nonexistent/cw-test\n");
    const base = (await snapshotTree(B))!;
    expect(Object.keys(JSON.parse(base))).toEqual([B]);
    await put(path.join(B, "b.ts"), "b\n");
    expect(await changedFiles(B, base)).toEqual(["b.ts"]);
  });
});

describe("end-of-turn check across repos", () => {
  const marker = () => path.join(A, "ran");
  beforeEach(async () => {
    await listRepos("../C");
    await put(path.join(C, ".cw/project.toml"),
      `version = 1\n[check]\ncmd = ["sh", "-c", "echo ran >> ${marker()}; echo C-broke >&2; exit 1"]\ntimeout_s = 5\n`);
  });

  it("runs C's failing check once with a repair, naming the repo, only when C changed", async () => {
    const s = await session("version = 1\n");
    await s.newTurn();
    expect(await s.settle()).toBeUndefined();
    await expect(readFile(marker())).rejects.toThrow();

    await put(path.join(C, "src/a.ts"), "2\n");
    const first = await s.settle();
    expect(first?.continue).toBe(true);
    const text = first!.entries[0]!.content;
    expect(text).toContain("[repo: C]");
    expect(text).toContain("C-broke");
    const second = await s.settle();
    expect(second?.continue).toBeUndefined();
    expect(second!.entries[0]!.content).toContain("[repo: C]");
    expect((await readFile(marker(), "utf8")).trim().split("\n")).toHaveLength(2);
    const meter = (await readFile(path.join(B, ".cw/meter.jsonl"), "utf8")).split("\n").filter((l) => l.includes('"event":"check"'));
    expect(meter.map((l) => JSON.parse(l).detail.repo)).toEqual(["C", "C"]);
  });

  it("does not run C's check when no turn baseline was taken", async () => {
    const s = await session("version = 1\n");
    await put(path.join(C, "src/a.ts"), "2\n");
    expect(await s.settle()).toBeUndefined();
    await expect(readFile(marker())).rejects.toThrow();
  });

  it("shares one repair across B's and C's checks and reports both by repo name", async () => {
    const s = await session('version = 1\n[check]\ncmd = ["sh", "-c", "echo B-broke >&2; exit 1"]\ntimeout_s = 5\n');
    await s.newTurn();
    await put(path.join(C, "src/a.ts"), "2\n");
    const first = await s.settle();
    expect(first?.continue).toBe(true);
    expect(first!.entries[0]!.content).toContain("[repo: B]");
    expect(first!.entries[0]!.content).toContain("[repo: C]");
    const second = await s.settle();
    expect(second?.continue).toBeUndefined();
    expect(second!.entries[0]!.content).toContain("B-broke");
  });
});

describe("PAUSE targets", () => {
  it("counts a source edit in C and names it with the repo directory", async () => {
    await listRepos("../C");
    const callsFile = path.join(A, "calls.jsonl");
    process.env.CW_FAKE_CALLS_FILE = callsFile;
    process.env.CW_FAKE_TEXT_PLANNER = "the plan";
    const s = await session('version = 1\n[models]\nplanner = "g/planner"\n[auto]\npause = true\n');
    await s.newTurn();
    const first = await s.call("edit", path.join(C, "src/a.ts"));
    expect(first?.block).toBe(true);
    expect(first?.reason).toContain("the plan");
    expect(await readFile(callsFile, "utf8")).toContain("edit C/src/a.ts");
  });
});
