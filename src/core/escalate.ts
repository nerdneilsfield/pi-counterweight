import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { contentSha256 } from "./evidence.js";
import { commitExists, isGitRepo, worktreeAdd, worktreePrune } from "./gitstate.js";
import { isNotFound } from "./paths.js";
import { overlayInputs } from "./redcheck.js";
import { saveReference } from "./task.js";

/**
 * The base escalation cannot run: the worktree cannot be created or the
 * approved acceptance inputs cannot be restored faithfully. The caller
 * reports this instead of faking an upgrade.
 */
export class EscalateError extends Error {}

export const REFERENCE_FILE = ".cw/task.json";

/** Absolute path of the escalation worktree for `taskId` next to `repoRoot`. */
export function escalationWorktreePath(repoRoot: string, taskId: string): string {
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-cw-${taskId}-esc`);
}

/**
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
