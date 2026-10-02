import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { contentSha256 } from "../../src/core/evidence.ts";
import { EscalateError, escalationWorktreePath, prepareBaseEscalation } from "../../src/core/escalate.ts";
import { treeHash, worktreePrune } from "../../src/core/gitstate.ts";
import { createTask, readReference } from "../../src/core/task.ts";
import { writeHandback } from "../../src/core/handback.ts";
import { recordTaskEvent, recordUsage } from "../../src/core/meter.ts";

const taskId = "20260928-lifetime-fix";

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")}: ${code}`)));
  });
}

async function worktreeCount(repo: string): Promise<number> {
  return (await git(repo, ["worktree", "list", "--porcelain"]))
    .split("\n").filter((line) => line.startsWith("worktree ")).length;
}

interface Setup {
  repo: string;
  base: string;
  request: () => Parameters<typeof prepareBaseEscalation>[0];
}

async function setup(): Promise<Setup> {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-m7-"));
  await git(repo, ["init"]);
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await writeFile(path.join(repo, "tests", "a.py"), "base\n");
  await git(repo, ["add", "tracked.txt", "tests/a.py"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const inputHash = (await contentSha256(repo, "tests/a.py"))!;
  // The authoritative task directory exists in the real flow (created by
  // /cw task new); the reference must point at it.
  await mkdir(path.join(repo, ".cw", "tasks", taskId), { recursive: true });
  return {
    repo,
    base,
    request: () => ({
      repo,
      taskId,
      session: "s1",
      baseCommit: base,
      inputs: ["tests/a.py"],
      approvedInputHashes: { "tests/a.py": inputHash },
    }),
  };
}

const worktreeOf = async (repo: string) =>
  escalationWorktreePath(await realpath(repo), taskId);

const noResidue = async (repo: string) => {
  await expect(rm(await worktreeOf(repo), { recursive: true, force: true })).resolves.toBeUndefined();
  expect(await worktreeCount(repo)).toBe(1);
};

test("prepareBaseEscalation：base worktree、验收输入恢复、账本引用、原工作树不变", async () => {
  const { repo, request } = await setup();
  const treeBefore = (await treeHash(repo)).value!;
  const worktree = await prepareBaseEscalation(request());
  expect(worktree).toBe(await worktreeOf(repo));

  // The worktree is at the base commit and the input matches the approved bytes.
  expect((await git(worktree, ["rev-parse", "HEAD"])).trim()).toBe(request().baseCommit);
  expect(await readFile(path.join(worktree, "tests", "a.py"), "utf8")).toBe("base\n");
  expect(await contentSha256(worktree, "tests/a.py"))
    .toBe(request().approvedInputHashes["tests/a.py"]);

  // The reference points at the authoritative ledger; no writable copy exists.
  const reference = await readReference(path.join(worktree, ".cw", "task.json"));
  expect(reference.task_id).toBe(taskId);
  expect(reference.path).toBe(path.join(await realpath(repo), ".cw", "tasks", taskId));
  expect(await rm(path.join(worktree, ".cw", "tasks"), { recursive: true, force: true })).toBeUndefined();

  // The original worktree was only read, never written.
  expect((await treeHash(repo)).value).toBe(treeBefore);
  expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");

  expect(await worktreeCount(repo)).toBe(2);
  await rm(worktree, { recursive: true, force: true });
  await worktreePrune(repo);
  expect(await worktreeCount(repo)).toBe(1);
});

test("prepareBaseEscalation：验收输入漂移拒绝，无 worktree 残留", async () => {
  const { repo, request } = await setup();
  await writeFile(path.join(repo, "tests", "a.py"), "drifted\n");
  await expect(prepareBaseEscalation(request())).rejects.toThrow(EscalateError);
  await expect(prepareBaseEscalation(request())).rejects.toThrow(/与批准版本不一致/);
  await noResidue(repo);
});

test("prepareBaseEscalation：输入缺失、base_commit 不存在与已存在目录均拒绝", async () => {
  const { repo, base, request } = await setup();
  await rm(path.join(repo, "tests", "a.py"));
  await expect(prepareBaseEscalation(request())).rejects.toThrow(/缺失/);
  await noResidue(repo);

  await expect(prepareBaseEscalation({ ...request(), baseCommit: "0".repeat(40) }))
    .rejects.toThrow(EscalateError);
  await noResidue(repo);

  // An existing escalation directory is never reused or overwritten.
  await writeFile(await worktreeOf(repo), "occupied");
  await expect(prepareBaseEscalation({ ...request(), inputs: [], approvedInputHashes: {} }))
    .rejects.toThrow(/已存在/);
  expect(await readFile(await worktreeOf(repo), "utf8")).toBe("occupied");
});

test("writeHandback 两文件提交语义：md 失败不残留 json，旧 json 保留，无 meter 事件", async () => {
  const { repo } = await setup();
  const hbTaskId = "20260101-hbcheck";
  await createTask(repo, hbTaskId, "g/medium");
  const request = {
    contract: {
      version: 1, task_id: hbTaskId, tier: "change" as const, deliverable: "code" as const,
      goal: "g", non_goals: [], acceptance: [], red: [], regression: [], frozen: [],
      interface: [], baseline_inputs: [], approved_failures: [], budget: undefined,
    },
    validator: { cmd: ["/bin/sh", "-c", "true"], timeout_s: 600, env: {} },
    reason: "manual" as const, questions: [] as string[], autoVerified: false,
  };
  const taskDir = path.join(repo, ".cw", "tasks", hbTaskId);
  const jsonPath = path.join(taskDir, "handback.json");
  const mdPath = path.join(taskDir, "handback.md");
  const noTmp = (entries: string[]) => entries.filter((name) => name.endsWith(".tmp"));

  // Case A：md 目标是目录 → rename 失败 → 本次 json 被撤除，无事件，无 .tmp 残留。
  await mkdir(mdPath);
  await expect(writeHandback(repo, hbTaskId, "s1", request)).rejects.toThrow();
  expect(existsSync(jsonPath)).toBe(false);
  const listingA = (await readdir(taskDir)).sort();
  expect(listingA).toEqual(["handback.md", "meter.jsonl", "runs", "state.json"]);
  expect(noTmp(listingA)).toEqual([]);
  const meter = (await readFile(path.join(taskDir, "meter.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(meter.map((line) => line.event)).not.toContain("manual");

  // Case B：更早的 handback.json 在失败后被原样保留，且同样无 .tmp。
  await writeFile(jsonPath, "{\"previous\":true}\n");
  await expect(writeHandback(repo, hbTaskId, "s1", request)).rejects.toThrow();
  expect(await readFile(jsonPath, "utf8")).toBe("{\"previous\":true}\n");
  // 目录形态的 md 未被破坏。
  expect((await lstat(mdPath)).isDirectory()).toBe(true);
  expect(noTmp(await readdir(taskDir))).toEqual([]);
});

test("meter：usage 行带 kind，task 事件行可解析；事件写入失败不抛出", async () => {
  const { repo } = await setup();
  await mkdir(path.join(repo, ".cw", "tasks", taskId, "runs"), { recursive: true });
  await recordUsage(repo, taskId, {
    time: "t", session: "s1", model: "g/medium",
    input: 10, output: 2, cache_read: 3, cache_write: 1, cost_total: 0.5,
  });
  await recordTaskEvent(repo, taskId, "s1", "validation_started", { run: 1 });
  const lines = (await readFile(path.join(repo, ".cw", "tasks", taskId, "meter.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({ kind: "usage", session: "s1", input: 10, cost_total: 0.5 });
  expect(lines[1]).toMatchObject({ kind: "task", event: "validation_started", detail: { run: 1 } });

  // Best-effort: an unknown task never throws and never creates state.
  await expect(recordTaskEvent(repo, "20260101-nope", "s1", "task_created")).resolves.toBeUndefined();
});
