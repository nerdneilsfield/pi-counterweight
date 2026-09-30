import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  if (path.isAbsolute(file)) throw new Error(`blob: path must be repo-relative ${file}`);
  const result = await git(repo, ["hash-object", "--", file]);
  if (result.code !== 0) {
    if (/fatal: (could not open|unable to hash)/.test(result.stderr)) return { supported: true, value: null };
    throw new Error(result.stderr || "git hash-object failed");
  }
  return { supported: true, value: result.stdout.trim() };
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
