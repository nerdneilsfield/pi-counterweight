/**
 * git 探针测试：树哈希把未跟踪文件算在内、排除 `.cw` 与被忽略路径、不触碰真实 index，非 git 降级。
 *
 * Git-probe tests: the tree hash includes untracked files, excludes `.cw` and
 * gitignored paths, never touches the real index, and degrades without git.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { headCommit, treeHash } from "../../src/core/gitstate.ts";

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

// 建一个带基线提交的临时仓库。
// A temp repo with one baseline commit.
async function repo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-gitstate-"));
  await git(repo, ["init"]);
  await mkdir(path.join(repo, ".cw"), { recursive: true });
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await writeFile(path.join(repo, ".gitignore"), "ignored/\n");
  await git(repo, ["add", "tracked.txt", ".gitignore"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  return repo;
}

// 树哈希口径：未跟踪文件进入；被忽略目录与 `.cw` 不进入；哈希期间真实 index/状态不变。
// Hash semantics: untracked files count, ignored and `.cw` paths never do, and the real
// index/status stay untouched.
test("树哈希包含未跟踪文件，排除忽略路径与 .cw，不触碰真实 index", async () => {
  const repoPath = await repo();
  try {
    // 哈希前后真实 index 与状态不变（在创建测试文件之前先验证这一次）。
    const statusBefore = await git(repoPath, ["status", "--porcelain"]);
    const cachedBefore = await git(repoPath, ["diff", "--cached"]);
    const before = await treeHash(repoPath);
    expect(before.supported).toBe(true);
    expect(await git(repoPath, ["status", "--porcelain"])).toBe(statusBefore);
    expect(await git(repoPath, ["diff", "--cached"])).toBe(cachedBefore);

    if (before.supported) {
      const first = before.value;

      await writeFile(path.join(repoPath, "untracked.txt"), "new\n");
      const second = await treeHash(repoPath);
      if (second.supported) expect(second.value).not.toBe(first);

      await mkdir(path.join(repoPath, "ignored"), { recursive: true });
      await writeFile(path.join(repoPath, "ignored", "x.txt"), "ignored\n");
      await writeFile(path.join(repoPath, ".cw", "notes.md"), "ledger\n");
      const third = await treeHash(repoPath);
      if (second.supported && third.supported) expect(third.value).toBe(second.value);
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

// HEAD 契约：有提交时给出提交哈希；空仓库（unborn HEAD）是 supported + null。
// HEAD contract: the commit hash when one exists; an unborn HEAD is supported with null.
test("headCommit 区分空仓库与提交", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "cw-gitstate-empty-"));
  await git(empty, ["init"]);
  const repoPath = await repo();
  try {
    const unborn = await headCommit(empty);
    expect(unborn).toEqual({ supported: true, value: null });
    const head = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    expect(await headCommit(repoPath)).toEqual({ supported: true, value: head });
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(repoPath, { recursive: true, force: true });
  }
});

// 非 git 目录：两个探针都返回 supported:false，而不是抛错。
// A non-git directory: both probes report supported:false instead of throwing.
test("非 git 目录降级为 supported:false", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-gitstate-nogit-"));
  try {
    expect((await treeHash(dir)).supported).toBe(false);
    expect((await headCommit(dir)).supported).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
