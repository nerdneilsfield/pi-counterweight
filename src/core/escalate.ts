/**
 * `--from base` 升级：在仓库旁的独立 worktree 里检出原始 `base_commit`，
 * 把已批准的验收输入原样恢复进去，并写下指向唯一权威账本目录的引用文件。
 *
 * 不重用、不覆盖：目标路径已存在就直接拒绝。当前工作树只读、账本从不复制；
 * worktree 建好之后的任何失败都会把它连同 git 元数据一起删掉，不留半个升级现场。
 *
 * `--from base` escalation: checks out the original `base_commit` in a separate
 * worktree next to the repo, restores the approved acceptance inputs into it,
 * and writes a reference to the one authoritative ledger directory.
 *
 * The current worktree is read-only and the ledger is never copied. Nothing is
 * reused or overwritten, and any failure after the worktree was created removes
 * it and its git metadata again.
 */
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { contentSha256 } from "./evidence.js";
import { commitExists, isGitRepo, worktreeAdd, worktreePrune } from "./gitstate.js";
import { isNotFound } from "./paths.js";
import { overlayInputs } from "./redcheck.js";
import { saveReference } from "./task.js";

/**
 * base 升级跑不起来：worktree 建不出来，或已批准的验收输入无法原样恢复。调用方据此向用户报告，
 * 而不是伪造一次升级。
 *
 * The base escalation cannot run: the worktree cannot be created or the
 * approved acceptance inputs cannot be restored faithfully. The caller
 * reports this instead of faking an upgrade.
 */
export class EscalateError extends Error {}

/**
 * 升级 worktree 里的账本引用文件（仓库相对路径）：指向唯一权威任务目录，可写账本本身从不复制。
 *
 * The ledger reference file inside an escalation worktree (repo-relative): it
 * points at the one authoritative task directory, and the writable ledger
 * itself is never copied.
 */
export const REFERENCE_FILE = ".cw/task.json";

/**
 * 升级 worktree 的绝对路径：与仓库目录同级，名为 `<repo名>-cw-<task_id>-esc`。
 *
 * Absolute path of the escalation worktree for `taskId` next to `repoRoot`.
 */
export function escalationWorktreePath(repoRoot: string, taskId: string): string {
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-cw-${taskId}-esc`);
}

/**
 * 准备 `--from base` 升级工作树（计划 M7）：在仓库旁建 `base_commit` 的分离 worktree，
 * 把已批准的验收输入原样恢复进去并与批准哈希核对，再写下指向唯一权威账本的引用。
 *
 * `approvedInputHashes` 取自批准记录，键是仓库相对路径；任何一项缺哈希、
 * 在当前工作树缺失或与批准版本不一致，都直接拒绝升级 —— 绝不在不同的输入上偷偷升级。
 * 当前工作树只读不写。返回 worktree 路径；会话注册与模型切换由调用方负责
 * （Pi 1.0 的命令上下文不能把会话开在别的工作目录，`newSession` 没有 `cwd`），
 * 由用户到那里启动升级后的 Pi 进程。
 *
 * Prepare the `--from base` escalation working tree, per plan M7:
 *
 * - a detached worktree of the original `base_commit` at
 *   `<repo>/../<repo名>-cw-<task_id>-esc` (never reused or overwritten);
 * - the approved acceptance inputs restored from the current worktree and
 *   verified byte-for-byte against `approval.baseline_inputs_sha256` — any
 *   drift refuses the escalation instead of silently upgrading on different
 *   inputs;
 * - a reference (`<worktree>/.cw/task.json`) to the one authoritative task
 *   directory. The writable ledger itself is never copied.
 *
 * The current worktree is only read, never written. On any failure after the
 * worktree was created, the worktree and its git metadata are removed again.
 * Returns the worktree path; session registration and the model switch are
 * the caller's job — Pi 1.0's command context cannot start a session in
 * another working directory (no `cwd` on `newSession`), so the user starts
 * the escalated Pi process there.
 *
 * @returns 新建的升级 worktree 绝对路径 / Absolute path of the new escalation worktree.
 * @throws {EscalateError} 拒绝升级时（非 git 仓库、base 提交不存在、批准哈希缺失或已漂移、
 *   worktree 已存在）；其他 I/O 与 git 错误原样抛出 / When refused; other I/O
 *   and git errors propagate unchanged.
 */
export async function prepareBaseEscalation(request: {
  repo: string;
  taskId: string;
  session: string;
  baseCommit: string;
  inputs: readonly string[];
  approvedInputHashes: Record<string, string>;
}): Promise<string> {
  if (!await isGitRepo(request.repo)) {
    throw new EscalateError("仓库不是 git 仓库，无法建立升级 worktree");
  }
  if (!await commitExists(request.repo, request.baseCommit)) {
    throw new EscalateError(`base_commit 不存在或不是提交：${request.baseCommit}`);
  }
  for (const input of request.inputs) {
    const expected = request.approvedInputHashes[input];
    if (expected === undefined) {
      throw new EscalateError(`批准记录缺少验收输入哈希，无法核对：${input}`);
    }
    const actual = await contentSha256(request.repo, input);
    if (actual === null) {
      throw new EscalateError(`批准的验收输入在当前工作树缺失，无法恢复：${input}`);
    }
    if (actual !== expected) {
      throw new EscalateError(
        `验收输入 ${input} 与批准版本不一致，拒绝升级（先解决差异或重新批准契约）`);
    }
  }
  const root = await realpath(request.repo);
  const worktree = escalationWorktreePath(root, request.taskId);
  let stat;
  try {
    stat = await lstat(worktree);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    stat = undefined;
  }
  if (stat !== undefined) {
    throw new EscalateError(`升级 worktree 已存在，不复用不覆盖：${worktree}`);
  }
  await worktreeAdd(root, worktree, request.baseCommit);
  try {
    await overlayInputs(root, worktree, [...request.inputs]);
    for (const input of request.inputs) {
      const actual = await contentSha256(worktree, input);
      if (actual !== request.approvedInputHashes[input]) {
        throw new EscalateError(`恢复后的验收输入与批准哈希不一致：${input}`);
      }
    }
    await saveReference(root, path.join(worktree, REFERENCE_FILE), request.taskId);
    return worktree;
  } catch (error) {
    await rm(worktree, { recursive: true, force: true });
    await worktreePrune(root);
    throw error;
  }
}
