import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contractSha256 } from "./contract.js";
import { blobContent, blobHashes, diffFiles, isGitRepo, treeHash } from "./gitstate.js";
import { assertTaskId, isNotFound, relativeParts, resolveInRepo } from "./paths.js";
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
  /** All conflicts detected by this call, including already-recorded ones. */
  conflicts: FrozenConflict[];
  /** Conflicts recorded by this call: not previously in `state.conflicts`. */
  newConflicts: FrozenConflict[];
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
 * `repo` is the authoritative ledger root; `workRoot` (M7, default `repo`) is
 * the working tree the files are hashed in — they differ only for a session
 * running inside an escalation worktree. The work tree is realpathed once and
 * every path is resolved independently, so a few thousand frozen files stay
 * inside the per-call time budget. Non-git working trees cannot verify blob
 * hashes: nothing is reported and no state is bound (see M1 degrade rules).
 */
export async function checkFrozen(
  repo: string, taskId: string, session: string,
  frozenBlobs: Record<string, string>, workRoot?: string,
): Promise<FreezeOutcome> {
  assertTaskId(taskId);
  const work = workRoot ?? repo;
  if (!await isGitRepo(work)) return { git: false, conflicts: [], newConflicts: [], diffs: [] };
  return withTaskLock(repo, taskId, session, async () => {
    const foundAt = new Date().toISOString();
    const root = await realpath(work);
    const checked = await Promise.all(Object.entries(frozenBlobs).map(async ([original, expected]) => {
      try {
        const resolved = await resolveInRepo(root, original);
        const stat = await lstat(path.join(root, resolved));
        if (!stat.isFile()) {
          return { original, expected, resolved: null, detail: "not a regular file" };
        }
        return { original, expected, resolved, detail: null };
      } catch (error) {
        if (isNotFound(error)) {
          let dangling = false;
          try {
            dangling = (await lstat(path.join(root, original))).isSymbolicLink();
          } catch {
            // Already reported as missing below.
          }
          return { original, expected, resolved: null, detail: dangling ? "symlink target missing" : "file missing" };
        }
        return {
          original, expected, resolved: null,
          detail: error instanceof Error ? error.message : "path guard rejected",
        };
      }
    }));
    const detectable = checked.filter((item): item is typeof item & { resolved: string } => item.detail === null);
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
    for (const item of checked) {
      if (item.detail === null) continue;
      detected.push({
        conflict: { path: item.original, expected: item.expected, actual: null, found_at: foundAt },
        resolved: null,
        detail: item.detail,
      });
    }
    if (detected.length === 0) return { git: true, conflicts: [], newConflicts: [], diffs: [] };

    const state = await readState(repo, taskId);
    // A standing conflict (same path + expected + actual) is not re-recorded
    // on every check: no new diff, no state append, no "new conflict" report.
    // A changed actual is a new key and is always recorded.
    const recorded = new Set(
      state.conflicts.map((item) => conflictKey(item as FrozenConflict)));
    const fresh = detected.filter((item) => !recorded.has(conflictKey(item.conflict)));
    const reason = `frozen file changed ${detected.map((item) => item.conflict.path).join(", ")}`;
    if (fresh.length === 0 && state.last_verified === null && state.evidence_invalid_reason === reason) {
      return { git: true, conflicts: detected.map((item) => item.conflict), newConflicts: [], diffs: [] };
    }

    const dir = await taskSubdir(repo, taskId, "conflicts");
    const first = await nextDiffNumber(dir);
    // Rendering is the expensive part (object read plus a diff process per
    // conflict): run it concurrently, then write the numbered files in order.
    const rendered = await Promise.all(fresh.map((item) => renderDiffBody(work, item)));
    const diffs: string[] = [];
    for (let index = 0; index < fresh.length; index++) {
      const name = `${first + index}.diff`;
      const { body, detail } = rendered[index]!;
      await writeDiff(path.join(dir, name), conflictHeader(fresh[index]!, detail) + body);
      diffs.push(`.cw/tasks/${taskId}/conflicts/${name}`);
    }
    await writeState(repo, taskId, session, {
      ...state,
      conflicts: [...state.conflicts, ...fresh.map((item) => item.conflict)],
      last_verified: null,
      evidence_invalid_reason: reason,
    });
    return {
      git: true,
      conflicts: detected.map((item) => item.conflict),
      newConflicts: fresh.map((item) => item.conflict),
      diffs,
    };
  });
}

/** Deterministic identity of a conflict for de-duplication across checks. */
function conflictKey(conflict: FrozenConflict): string {
  return `${conflict.path}\0${conflict.expected}\0${conflict.actual ?? "<missing>"}`;
}

/**
 * Invalidate verified evidence when the working tree's hash differs from the
 * recorded one. `repo` is the ledger; `workRoot` (default `repo`) is the tree
 * being hashed. Non-git working trees never bind evidence, so they pass.
 */
export async function recheckTree(
  repo: string, taskId: string, session: string, workRoot?: string,
): Promise<string | null> {
  let reason: string | null = null;
  const work = workRoot ?? repo;
  await updateState(repo, taskId, session, async (state) => {
    if (state.last_verified === null) return state;
    let tree: GitValue<string>;
    try {
      tree = await treeHash(work);
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
  // M7 escalation reference: without it a worktree session loses its ledger.
  if (joined === ".cw/task.json") return true;
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

function conflictHeader(item: DetectedConflict, detail: string | null): string {
  const lines = [
    "path: " + item.conflict.path,
    "expected: " + item.conflict.expected,
    "actual: " + (item.conflict.actual ?? "missing"),
    "found_at: " + item.conflict.found_at,
  ];
  if (detail !== null) lines.push(`note: ${detail}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Body of a conflict's `.diff` file: the unified difference between the
 * approved blob and the current file, plus a note when that difference cannot
 * be rendered at all.
 */
async function renderDiffBody(
  repo: string, item: DetectedConflict,
): Promise<{ body: string; detail: string | null }> {
  if (item.resolved === null) return { body: "", detail: item.detail };
  const content = await blobContent(repo, item.conflict.expected);
  if (content === null) return { body: "", detail: "approved blob object unavailable in git" };
  return { body: await renderUnifiedDiff(repo, item.conflict.expected, content, item.resolved), detail: null };
}

async function writeDiff(file: string, content: string): Promise<void> {
  const handle = await open(file, DIFF_FLAGS);
  try {
    await handle.writeFile(content);
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
