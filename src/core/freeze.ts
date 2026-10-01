import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contractSha256 } from "./contract.js";
import { blobContent, blobHashes, diffFiles, isGitRepo, treeHash } from "./gitstate.js";
import { assertTaskId, isNotFound, relativeParts, repoPath } from "./paths.js";
import { readState, taskSubdir, updateState, withTaskLock, writeState } from "./task.js";
import type { Contract, GitValue } from "./types.js";

export interface FrozenConflict {
  path: string;
  expected: string;
  actual: string | null;
  found_at: string;
}

export interface FreezeOutcome {
  git: boolean;
  conflicts: FrozenConflict[];
  /** Repo-relative paths of the saved `.diff` files, in conflict order. */
  diffs: string[];
}

const DIFF_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

/**
 * Re-hash every `frozen_blobs` path against its approved blob hash. Conflicts
 * are appended to `state.conflicts`, the current difference is saved under
 * `.cw/tasks/<id>/conflicts/<n>.diff`, and verified evidence is invalidated.
 * The worktree is never written; conflict artifacts live under `.cw/`, which
 * the tree hash excludes, so recording a conflict cannot change the evidence
 * that future checks compute.
 *
 * Non-git repos cannot verify blob hashes: nothing is reported and no state
 * is bound (see M1 degrade rules).
 */
export async function checkFrozen(
  repo: string, taskId: string, session: string,
  frozenBlobs: Record<string, string>,
): Promise<FreezeOutcome> {
  assertTaskId(taskId);
  if (!await isGitRepo(repo)) return { git: false, conflicts: [], diffs: [] };
  return withTaskLock(repo, taskId, session, async () => {
    const foundAt = new Date().toISOString();
    const detectable: Array<{ original: string; expected: string; resolved: string }> = [];
    const broken: Array<{ original: string; expected: string; detail: string }> = [];
    for (const [original, expected] of Object.entries(frozenBlobs)) {
      let resolved: string;
      try {
        resolved = await repoPath(repo, original, false);
      } catch (error) {
        broken.push({ original, expected, detail: error instanceof Error ? error.message : "path guard rejected" });
        continue;
      }
      let stat;
      try {
        stat = await lstat(path.resolve(repo, resolved));
      } catch (error) {
        if (isNotFound(error)) {
          broken.push({ original, expected, detail: "file missing" });
          continue;
        }
        throw error;
      }
      if (!stat.isFile()) {
        broken.push({ original, expected, detail: "not a regular file" });
        continue;
      }
      detectable.push({ original, expected, resolved });
    }
    const hashes = await blobHashes(repo, detectable.map((item) => item.resolved));
    const detected: Array<{ conflict: FrozenConflict; resolved: string | null; detail: string | null }> = [];
    for (let index = 0; index < detectable.length; index++) {
      const item = detectable[index]!;
      const actual = hashes[index]!;
      if (actual === item.expected) continue;
      detected.push({
        conflict: { path: item.original, expected: item.expected, actual, found_at: foundAt },
        resolved: item.resolved,
        detail: null,
      });
    }
    for (const item of broken) {
      detected.push({
        conflict: { path: item.original, expected: item.expected, actual: null, found_at: foundAt },
        resolved: null,
        detail: item.detail,
      });
    }
    if (detected.length === 0) return { git: true, conflicts: [], diffs: [] };

    const dir = await taskSubdir(repo, taskId, "conflicts");
    let number = await nextDiffNumber(dir);
    const diffs: string[] = [];
    for (const item of detected) {
      const name = `${number}.diff`;
      await writeDiff(path.join(dir, name), repo, item);
      diffs.push(`.cw/tasks/${taskId}/conflicts/${name}`);
      number += 1;
    }
    const state = await readState(repo, taskId);
    await writeState(repo, taskId, session, {
      ...state,
      conflicts: [...state.conflicts, ...detected.map((item) => item.conflict)],
      last_verified: null,
      evidence_invalid_reason: `frozen file changed ${detected.map((item) => item.conflict.path).join(", ")}`,
    });
    return { git: true, conflicts: detected.map((item) => item.conflict), diffs };
  });
}

/**
 * Invalidate verified evidence when the current worktree tree hash differs
 * from the recorded one. Non-git repos never bind evidence, so they pass.
 */
export async function recheckTree(repo: string, taskId: string, session: string): Promise<string | null> {
  let reason: string | null = null;
  await updateState(repo, taskId, session, async (state) => {
    if (state.last_verified === null) return state;
    let tree: GitValue<string>;
    try {
      tree = await treeHash(repo);
    } catch (error) {
      reason = `tree hash failed: ${error instanceof Error ? error.message : "unreadable"}`;
      return { ...state, last_verified: null, evidence_invalid_reason: reason };
    }
    if (!tree.supported || tree.value === state.last_verified.tree) return state;
    reason = "worktree tree changed since verification";
    return { ...state, last_verified: null, evidence_invalid_reason: reason };
  });
  return reason;
}

/** Invalidate verified evidence when the contract was changed after approval. */
export async function recheckContract(
  repo: string, taskId: string, session: string, contract: Contract,
): Promise<string | null> {
  const current = contractSha256(contract);
  let reason: string | null = null;
  await updateState(repo, taskId, session, async (state) => {
    if (state.last_verified === null || state.last_verified.contract_sha256 === current) return state;
    reason = "contract changed since verification";
    return { ...state, last_verified: null, evidence_invalid_reason: reason };
  });
  return reason;
}

/**
 * Protected paths: contract `frozen` + `interface` + `.cw/project.toml` +
 * everything under this task's directory except its `notes.md`. Callers must
 * still apply the M1 path guards; a lexically invalid path is not protected
 * here, it is rejected there.
 */
export function isProtectedPath(
  relative: string, contract: Pick<Contract, "frozen" | "interface">, taskId: string,
): boolean {
  assertTaskId(taskId);
  let parts: string[];
  try {
    parts = relativeParts(relative);
  } catch {
    return false;
  }
  const joined = parts.join("/");
  if (joined === ".cw/project.toml") return true;
  const prefix = `.cw/tasks/${taskId}/`;
  if (joined.startsWith(prefix) && joined !== `${prefix}notes.md`) return true;
  return contract.frozen.includes(joined) || contract.interface.includes(joined);
}

async function nextDiffNumber(dir: string): Promise<number> {
  const names = await readdir(dir);
  const used = names
    .map((name) => /^(\d+)\.diff$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  return (used.length === 0 ? 0 : Math.max(...used)) + 1;
}

interface DetectedConflict {
  conflict: FrozenConflict;
  resolved: string | null;
  detail: string | null;
}

async function writeDiff(file: string, repo: string, item: DetectedConflict): Promise<void> {
  const lines = [
    "path: " + item.conflict.path,
    "expected: " + item.conflict.expected,
    "actual: " + (item.conflict.actual ?? "missing"),
    "found_at: " + item.conflict.found_at,
  ];
  let detail = item.detail;
  let body = "";
  if (item.resolved !== null) {
    const content = await blobContent(repo, item.conflict.expected);
    if (content === null) {
      detail = "approved blob object unavailable in git";
    } else {
      body = await renderUnifiedDiff(repo, item.conflict.expected, content, item.resolved);
    }
  }
  if (detail !== null) lines.push(`note: ${detail}`);
  const handle = await open(file, DIFF_FLAGS);
  try {
    await handle.writeFile(`${lines.join("\n")}\n${body}`);
  } finally {
    await handle.close();
  }
}

/** Unified diff between the approved blob content and the current file on disk. */
async function renderUnifiedDiff(
  repo: string, expectedSha: string, expectedContent: Buffer, resolved: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cw-diff-"));
  try {
    const expected = path.join(directory, `expected-${expectedSha.slice(0, 12)}`);
    await writeFile(expected, expectedContent);
    return await diffFiles(repo, expected, resolved);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
