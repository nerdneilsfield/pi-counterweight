/**
 * git 探针：工作树根、HEAD 提交与工作树树哈希；仓库自己的 index 与 HEAD 永不被改动。
 *
 * Git probes: the worktree root, the HEAD commit, and a worktree tree hash,
 * read through the `git` CLI. The repository's own index and HEAD are never
 * touched, and a probe that needs git but cannot get it reports
 * `supported: false` instead of failing. Only `treeHash` writes anything at
 * all, and only into a throwaway index under the system temp directory.
 */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 需要 git 才能得到的量：非 git 工作树返回 `supported: false`，调用方必须把它当“无法判定”，而不是失败或通过。
 *
 * A value only git can provide. A non-git worktree yields `supported: false`,
 * which callers must treat as "cannot tell" — never as a failure or a pass.
 */
export type GitValue<T> = { supported: true; value: T } | { supported: false };

/**
 * 包含 `dir` 的工作树根；目录不在任何仓库内时返回 null。
 *
 * The worktree root containing `dir`, or null when git has none. Callers that
 * need "the repo this cwd belongs to" (`cw observe`) use this.
 */
export async function repoToplevel(dir: string): Promise<string | null> {
  return workTree(dir);
}

/**
 * HEAD 指向的提交哈希；仓库还没有任何提交（unborn HEAD）时仍是 `supported: true` 加 `value: null`。
 *
 * Hash of the commit HEAD points at. A repository without a commit yet (unborn
 * HEAD) still reports support, with `value: null`, so callers can tell "no
 * commit exists" apart from "git is unavailable".
 */
export async function headCommit(repo: string): Promise<GitValue<string | null>> {
  if (!await isGitRepo(repo)) return { supported: false };
  const result = await git(repo, ["rev-parse", "--verify", "HEAD"]);
  if (result.code !== 0) return { supported: true, value: null };
  return { supported: true, value: result.stdout.trim() };
}

/**
 * 当前工作树的树哈希：在临时 index 上重放“HEAD 树 → 剔除 `.cw` → `add -A` → `write-tree`”，仓库自己的 index 与 HEAD 全程不动。
 *
 * Tree hash of the current worktree, computed on a throwaway index
 * (`GIT_INDEX_FILE`): start from HEAD's tree, or an empty index when the
 * repository has no commit; drop tracked `.cw` entries; `add -A` everything
 * else; then `write-tree`. The temp directory is removed in `finally`.
 *
 * @remarks
 * 哈希口径是 git 的对象哈希（文件内容与模式），只有 mtime 变化不会改变它；`.cw/` 与被 .gitignore
 * 忽略的路径都不进入哈希。`repo` 必须是工作树根，否则判定失败、直接返回 `supported: false`。
 *
 * The hash covers content and mode only, so a bare mtime change leaves it
 * untouched; neither `.cw/` nor gitignored paths enter it. `repo` must be the
 * worktree root itself, since a subdirectory degrades to `supported: false`.
 *
 * @param repo - 工作树根 / The worktree root.
 * @returns 树哈希；非 git 时为 `supported: false` / Tree hash, or `supported: false` without git.
 * @throws git 子命令失败时抛错，并带上 stderr / When any git subcommand fails, with its stderr.
 */
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

/**
 * `repo` 是否本身就是 git 工作树根：`--show-toplevel` 与 `repo` 的 realpath 不同就返回 false，所以仓库里的子目录也得到 false。
 *
 * Whether `repo` is itself a git worktree root: the toplevel is compared with
 * the realpath of `repo`, so a subdirectory of a repository also gets false.
 */
async function isGitRepo(repo: string): Promise<boolean> {
  const root = await workTree(repo);
  if (root === null) return false;
  return await realpath(root) === await realpath(repo);
}

/**
 * `rev-parse --show-toplevel` 的结果；命令失败（目录不在任何仓库内）时返回 null，不抛错。
 *
 * The toplevel reported by `rev-parse --show-toplevel`; a failing command (the
 * directory is not inside any repository) yields null instead of throwing.
 */
async function workTree(dir: string): Promise<string | null> {
  const result = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

/**
 * 本模块里所有 git 调用的统一入口：`cwd` 固定为 `repo`，环境只留 `PATH`/`HOME`，并用 `GIT_CONFIG_COUNT=0` 屏蔽继承的配置注入；
 * 传了 `index` 就用 `GIT_INDEX_FILE` 指向临时索引。
 *
 * The single entry point for every git call in this module: `cwd` is `repo`,
 * the environment keeps only `PATH`/`HOME` with `GIT_CONFIG_COUNT=0`
 * neutralising inherited config injection, and `index` is passed on as
 * `GIT_INDEX_FILE`.
 *
 * @remarks
 * 非零退出码不抛错，由调用方判断；只有 spawn 本身失败才 reject。子进程被信号杀死时 `code` 为 null，
 * 这里统一记为 1。
 *
 * A non-zero exit code is returned rather than thrown, so callers decide what
 * it means, and only a spawn failure rejects. A child killed by a signal
 * reports `code` as 1 instead of null.
 */
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
