/**
 * git 探针：读取工作树状态，并用临时 index 算出工作树树哈希，与 blob 哈希、worktree 操作放在一起。
 *
 * Git probes: read worktree state and compute a worktree tree hash through a
 * throwaway index, so the repository's own index and HEAD are never touched.
 * A probe that needs git and cannot get it reports `supported: false` instead
 * of failing, while a genuine git failure throws; `worktreeAdd` and
 * `worktreePrune` are the only functions here that change repository state.
 */
import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNotFound, relativeParts } from "./paths.js";
import type { GitValue } from "./types.js";

/**
 * `repo` 是否本身就是 git 工作树根：`--show-toplevel` 与 `repo` 的 realpath 不同就返回 false，所以仓库里的子目录也得到 false。
 *
 * Whether `repo` is itself a git worktree root: the toplevel is compared with
 * the realpath of `repo`, so a subdirectory of a repository also gets false.
 * Callers that sit somewhere inside a repository want `repoToplevel` instead.
 */
export async function isGitRepo(repo: string): Promise<boolean> {
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
async function workTree(repo: string): Promise<string | null> {
  const result = await git(repo, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

/**
 * 包含 `dir` 的工作树根；目录不在任何仓库内时返回 null。
 *
 * The worktree root containing `dir`, or null when git has none. Unlike
 * `isGitRepo` this accepts any directory inside a repository; callers that
 * need "the repo this cwd belongs to" (observe) use this.
 */
export async function repoToplevel(dir: string): Promise<string | null> {
  return workTree(dir);
}

/**
 * 工作树是否干净：`status --porcelain` 只要有输出就算脏（未跟踪文件、已暂存未提交的改动都算），`.cw/` 被排除在检查之外。
 *
 * Whether the worktree is clean: any `status --porcelain` output counts as
 * dirty, untracked files and staged-but-uncommitted edits included, while
 * `.cw/` is excluded so the ledger never blocks its own gate. A non-git
 * directory degrades to `supported: false`; git itself failing throws.
 */
export async function isClean(repo: string): Promise<GitValue<boolean>> {
  if (!await isGitRepo(repo)) return { supported: false };
  const result = await git(repo, ["status", "--porcelain", "--", ".", ":(exclude).cw"]);
  if (result.code !== 0) throw new Error(result.stderr || "git status failed");
  return { supported: true, value: result.stdout.trim() === "" };
}

/**
 * HEAD 指向的提交哈希；仓库还没有任何提交（unborn HEAD）时仍是 `supported: true` 加 `value: null`。
 *
 * Hash of the commit HEAD points at. A repository without a commit yet (unborn
 * HEAD) still reports support, with `value: null`, so callers can tell "no
 * baseline exists" apart from "git is unavailable".
 */
export async function headCommit(repo: string): Promise<GitValue<string | null>> {
  if (!await isGitRepo(repo)) return { supported: false };
  const result = await git(repo, ["rev-parse", "--verify", "HEAD"]);
  if (result.code !== 0) return { supported: true, value: null };
  return { supported: true, value: result.stdout.trim() };
}

/**
 * 当前工作树的树哈希：在临时 index 上重放"HEAD 树 → 剔除 `.cw` → `add -A` → `write-tree`"，仓库自己的 index 与 HEAD 全程不动。
 *
 * Tree hash of the current worktree, computed on a throwaway index
 * (`GIT_INDEX_FILE`): start from HEAD's tree, or an empty index when the
 * repository has no commit; drop tracked `.cw` entries; `add -A` everything
 * else; then `write-tree`. The temp directory is removed in `finally`.
 *
 * @remarks
 * 哈希口径是 git 的对象哈希（文件内容与模式），只有 mtime 变化不会改变它；`.cw/` 与被 .gitignore
 * 忽略的路径都不进入哈希，所以 `.cw/` 下的漂移要靠验证器输入核对来发现。`repo` 必须是工作树根，
 * 否则 `isGitRepo` 判定失败、直接返回 `supported: false`。
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
 * 单个文件的 git blob 哈希，与 `blobHashes` 口径一致；文件不存在时返回 `supported: true` 加 `value: null`。
 *
 * Blob hash of a single file, matching `blobHashes`. The path must be
 * repo-relative (`..` and absolute paths throw) and is `lstat`ed before git
 * runs, so a missing file becomes a null value rather than an error; approval
 * of frozen files depends on telling those two apart. Only a non-git directory
 * reports `supported: false`.
 *
 * @remarks
 * `hash-object` 不带 `-w`，只算不写：对象库里不会多出任何对象。
 *
 * `hash-object` runs without `-w`, so nothing is written to the object
 * database.
 */
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
 * 批量 `hash-object`：结果顺序与 `files` 一致，不存在的路径必须由调用方预先滤掉，因为一个缺失就会让整批失败。
 *
 * Batch `git hash-object`. Output order matches `files` order; callers must
 * pre-filter missing paths (hash-object fails the whole batch on one miss).
 * One spawn keeps the freeze check inside its per-call time budget.
 *
 * @remarks
 * 空数组直接返回空数组、不 spawn，也不预先判断是不是 git 仓库：git 失败即抛错。
 *
 * An empty input returns immediately without spawning, and there is no
 * `isGitRepo` pre-check: a git failure throws.
 */
export async function blobHashes(repo: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const result = await git(repo, ["hash-object", "--", ...files]);
  if (result.code !== 0) throw new Error(result.stderr || "git hash-object failed");
  return result.stdout.split("\n").filter((line) => line !== "");
}

/**
 * 从对象库读出 blob 的原始字节；对象不存在（`cat-file` 报无效对象名）时返回 null，其余失败抛错。
 *
 * Object content as bytes; null when the object is absent from the database.
 *
 * @remarks
 * `sha` 不是 40 或 64 位十六进制就直接返回 null、不 spawn；子进程环境只留 `PATH`/`HOME`，并用
 * `GIT_CONFIG_COUNT=0` 屏蔽继承来的 `GIT_CONFIG_*` 注入。
 *
 * A `sha` that is not 40 or 64 hex digits returns null without spawning. The
 * child sees only `PATH`/`HOME`, with `GIT_CONFIG_COUNT=0` neutralising any
 * inherited `GIT_CONFIG_*` injection.
 */
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

/**
 * 两个已存在文件的 unified diff；退出码 1 表示"有差异"而不是错误，其他非零码才抛错。
 *
 * Unified diff of two existing files. Exit 1 means "differs" and is not an error.
 */
export async function diffFiles(repo: string, expected: string, actual: string): Promise<string> {
  const result = await git(repo, ["diff", "--no-index", "--", expected, actual]);
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || "git diff --no-index failed");
  return result.stdout;
}

/**
 * `sha` 是否在本仓库中解析为一个提交对象；目录不是 git 仓库时同样得到 false，与"提交不存在"不可区分。
 *
 * Whether `sha` resolves to a commit object reachable in this repository.
 *
 * @remarks
 * 只查对象库，不额外判断是否为 git 仓库：调用方（先红检查、升级）都已先用 `isGitRepo` 把关，因此这里
 * 把"不是仓库"和"没有该提交"合并成 false 是安全的。
 *
 * Only the object database is consulted; there is no `isGitRepo` check. The
 * callers (red check, escalation) gate on it separately, so folding "not a
 * repository" into false is safe here.
 */
export async function commitExists(repo: string, sha: string): Promise<boolean> {
  const result = await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  return result.code === 0;
}

/**
 * 在 `dir` 建一个指向 `commit` 的 detached worktree；`dir` 必须尚不存在，调用方之后要删掉目录并调用 `worktreePrune`。
 *
 * Detached worktree at `commit` inside `dir`, which must not exist yet. Used
 * by the red check to run the validator against the original baseline; the
 * caller removes the directory and calls `worktreePrune` afterwards.
 *
 * @remarks
 * `--detach` 让基线不绑定任何分支；失败时带 git 的 stderr 抛出。
 *
 * `--detach` keeps the baseline off every branch; failures throw with git's
 * stderr.
 */
export async function worktreeAdd(repo: string, dir: string, commit: string): Promise<void> {
  const result = await git(repo, ["worktree", "add", "--detach", dir, commit]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git worktree add failed");
}

/**
 * 清掉目录已被删除的 worktree 元数据；尽力而为，git 报错也不抛（退出码被忽略）。
 *
 * Drop worktree metadata whose directory is already gone. Best effort.
 */
export async function worktreePrune(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}

/**
 * `repo` 是否是链接 worktree（`--git-common-dir` 与 `--git-dir` 不同），也就是不是主检出。
 *
 * Whether `repo` is a linked worktree rather than the main checkout
 * (`--git-common-dir` differs from `--git-dir`). A non-git repo reports
 * false; callers gate on git support separately.
 */
export async function isLinkedWorktree(repo: string): Promise<boolean> {
  const [common, current] = await Promise.all([
    git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(repo, ["rev-parse", "--path-format=absolute", "--git-dir"]),
  ]);
  if (common.code !== 0 || current.code !== 0) return false;
  return common.stdout.trim() !== current.stdout.trim();
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
