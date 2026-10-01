import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNotFound, relativeParts } from "./paths.js";
import type { GitValue } from "./types.js";

export async function isGitRepo(repo: string): Promise<boolean> {
  const root = await workTree(repo);
  if (root === null) return false;
  return await realpath(root) === await realpath(repo);
}

async function workTree(repo: string): Promise<string | null> {
  const result = await git(repo, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

export async function isClean(repo: string): Promise<GitValue<boolean>> {
  if (!await isGitRepo(repo)) return { supported: false };
  const result = await git(repo, ["status", "--porcelain", "--", ".", ":(exclude).cw"]);
  if (result.code !== 0) throw new Error(result.stderr || "git status failed");
  return { supported: true, value: result.stdout.trim() === "" };
}

export async function headCommit(repo: string): Promise<GitValue<string | null>> {
  if (!await isGitRepo(repo)) return { supported: false };
  const result = await git(repo, ["rev-parse", "--verify", "HEAD"]);
  if (result.code !== 0) return { supported: true, value: null };
  return { supported: true, value: result.stdout.trim() };
}

export async function treeHash(repo: string): Promise<GitValue<string>> {
  if (!await isGitRepo(repo)) return { supported: false };
  const directory = await mkdtemp(path.join(tmpdir(), "cw-index-"));
  try {
    const index = path.join(directory, "index");
    const head = await headCommit(repo);
    const read = await git(repo, head.supported && head.value !== null ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], index);
    if (read.code !== 0) throw new Error(read.stderr || "git read-tree failed");
    const removed = await git(repo, ["rm", "-r", "--cached", "--ignore-unmatch", "--", ".cw"], index);
    if (removed.code !== 0) throw new Error(removed.stderr || "git rm --cached .cw failed");
    const add = await git(repo, ["add", "-A", "--", ".", ":(exclude).cw"], index);
    if (add.code !== 0) throw new Error(add.stderr || "git add failed");
    const written = await git(repo, ["write-tree"], index);
    if (written.code !== 0) throw new Error(written.stderr || "git write-tree failed");
    return { supported: true, value: written.stdout.trim() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function blobHash(repo: string, file: string): Promise<GitValue<string | null>> {
  if (!await isGitRepo(repo)) return { supported: false };
  relativeParts(file);
  try {
    await lstat(path.resolve(repo, file));
  } catch (error) {
    if (isNotFound(error)) return { supported: true, value: null };
    throw error;
  }
  const result = await git(repo, ["hash-object", "--", file]);
  if (result.code !== 0) throw new Error(result.stderr || "git hash-object failed");
  return { supported: true, value: result.stdout.trim() };
}

/**
 * Batch `git hash-object`. Output order matches `files` order; callers must
 * pre-filter missing paths (hash-object fails the whole batch on one miss).
 * One spawn keeps the freeze check inside its per-call time budget.
 */
export async function blobHashes(repo: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const result = await git(repo, ["hash-object", "--", ...files]);
  if (result.code !== 0) throw new Error(result.stderr || "git hash-object failed");
  return result.stdout.split("\n").filter((line) => line !== "");
}

/** Object content as bytes; null when the object is absent from the database. */
export async function blobContent(repo: string, sha: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{40}$/.test(sha) && !/^[0-9a-f]{64}$/.test(sha)) return null;
  return new Promise<Buffer | null>((resolve, reject) => {
    const child = spawn("git", ["cat-file", "blob", sha], {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_COUNT: "0" },
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) { resolve(Buffer.concat(chunks)); return; }
      if (/Not a valid object name|Invalid object name|bad file/.test(stderr)) { resolve(null); return; }
      reject(new Error(stderr || "git cat-file failed"));
    });
  });
}

/** Unified diff of two existing files. Exit 1 means "differs" and is not an error. */
export async function diffFiles(repo: string, expected: string, actual: string): Promise<string> {
  const result = await git(repo, ["diff", "--no-index", "--", expected, actual]);
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || "git diff --no-index failed");
  return result.stdout;
}

/** Whether `sha` resolves to a commit object reachable in this repository. */
export async function commitExists(repo: string, sha: string): Promise<boolean> {
  const result = await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  return result.code === 0;
}

/**
 * Detached worktree at `commit` inside `dir`, which must not exist yet. Used
 * by the red check to run the validator against the original baseline; the
 * caller removes the directory and calls `worktreePrune` afterwards.
 */
export async function worktreeAdd(repo: string, dir: string, commit: string): Promise<void> {
  const result = await git(repo, ["worktree", "add", "--detach", dir, commit]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git worktree add failed");
}

/** Drop worktree metadata whose directory is already gone. Best effort. */
export async function worktreePrune(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}

function git(repo: string, args: string[], index?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_COUNT: "0",
        ...(index === undefined ? {} : { GIT_INDEX_FILE: index }),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
