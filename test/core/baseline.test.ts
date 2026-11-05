/**
 * 回合基线：改动从回合开始的树快照算起，而不是相对 HEAD。预期值都由 git 自己的行为推出。
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { changedFiles, snapshotTree, workingDiff } from "../../src/core/auto.ts";

let repo: string;

function git(...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=cw", ...args], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), text);
}

beforeEach(async () => {
  repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-base-")));
  git("init", "-q");
  await put("a.txt", "1\n");
  await put("old.txt", "one\ntwo\nthree\nfour\nfive\n");
  git("add", "a.txt", "old.txt");
  git("commit", "-qm", "base");
});

afterEach(() => rm(repo, { recursive: true, force: true }));

test("回合前就没提交的改动不算", async () => {
  await put("a.txt", "dirty before the turn\n");
  await put("new-before.txt", "x\n");
  const base = await snapshotTree(repo);
  expect(await workingDiff(repo, base)).toBe("");
  expect(await changedFiles(repo, base)).toEqual([]);
});

test("回合中提交的文件照样算", async () => {
  const base = await snapshotTree(repo);
  await put("b.txt", "made in the turn\n");
  git("add", "b.txt");
  git("commit", "-qm", "turn");
  expect(await changedFiles(repo, base)).toEqual(["b.txt"]);
  expect(await workingDiff(repo, base)).toContain("+made in the turn");
});

test("未跟踪的新文件给出内容；已经脏的文件只算回合里的那部分", async () => {
  await put("a.txt", "dirty\n");
  const base = await snapshotTree(repo);
  await put("fresh.txt", "brand new line\n");
  await put("a.txt", "dirty\nmore\n");
  const diff = (await workingDiff(repo, base))!;
  expect(diff).toContain("+brand new line");
  expect(diff).toContain("+more");
  expect(diff).not.toContain("\n-1\n");
  expect(diff).not.toContain("\n+dirty\n");
  expect(diff).not.toContain("未跟踪");
  expect((await changedFiles(repo, base)).sort()).toEqual(["a.txt", "fresh.txt"]);
});

test("改名按新路径报，中文文件名不被转义", async () => {
  const base = await snapshotTree(repo);
  await rename(path.join(repo, "old.txt"), path.join(repo, "新名字.txt"));
  await put("说明.md", "内容\n");
  expect((await changedFiles(repo, base)).sort()).toEqual(["新名字.txt", "说明.md"]);
});

test("快照不动真实索引，也不留临时索引", async () => {
  await put("a.txt", "2\n");
  await put("untracked.txt", "u\n");
  git("add", "a.txt");
  const before = await readFile(path.join(repo, ".git", "index"));
  const status = git("status", "--porcelain");
  expect(await snapshotTree(repo)).toMatch(/^[0-9a-f]{40,}$/);
  await workingDiff(repo, null);
  expect(Buffer.compare(await readFile(path.join(repo, ".git", "index")), before)).toBe(0);
  expect(git("status", "--porcelain")).toBe(status);
});

test(".cw 下的改动不算", async () => {
  const base = await snapshotTree(repo);
  await put(".cw/HISTORY.md", "# h\n");
  await put(".cw/meter.jsonl", "{}\n");
  expect(await workingDiff(repo, base)).toBe("");
  expect(await changedFiles(repo, base)).toEqual([]);
});

test("没有基线时退回 HEAD；不在仓库里没有快照，也没有 diff", async () => {
  await put("a.txt", "changed\n");
  await put("new.txt", "n\n");
  expect((await changedFiles(repo, null)).sort()).toEqual(["a.txt", "new.txt"]);
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "cw-plain-")));
  try {
    expect(await snapshotTree(outside)).toBeNull();
    expect(await workingDiff(outside, null)).toBeNull();
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
