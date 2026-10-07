/**
 * 冻结文件比对：把契约冻结的每个路径重新哈希，记录冲突与 `.diff`，
 * 并在工作树或契约变化时让已验证的证据失效。
 *
 * 只记录、不还原：冲突产物写在 `.cw/` 下（树哈希不计这部分），所以“记录冲突”这个动作本身
 * 不会改变后续检查算出的证据；受保护路径集合由 `isProtectedPath` 提供，供写入门禁查询。
 *
 * Frozen-file comparison: re-hashes every frozen path, records conflicts and
 * their `.diff` artifacts, and invalidates verified evidence when the worktree
 * or the contract drifts underneath it.
 *
 * Record, never restore: conflict artifacts live under `.cw/`, which the tree
 * hash excludes, so recording a conflict cannot change the evidence that
 * later checks compute. `isProtectedPath` answers the write gate.
 */
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contractSha256 } from "./contract.js";
import { blobContent, blobHashes, diffFiles, isGitRepo, treeHash } from "./gitstate.js";
import { assertTaskId, isNotFound, relativeParts, resolveInRepo } from "./paths.js";
import { readState, taskSubdir, updateState, withTaskLock, writeState } from "./task.js";
import type { Contract, GitValue } from "./types.js";

/**
 * 一条冻结文件冲突：批准时锚定的 blob 哈希与当前文件不再一致，或该路径已无法比对。
 *
 * One frozen-file conflict: the blob hash anchored at approval no longer
 * matches the file, or the path cannot be compared at all.
 */
export interface FrozenConflict {
  /** 出冲突的文件，仓库相对路径 / Conflicting file, repo-relative. */
  path: string;
  /** 批准时锚定的 git blob 哈希 / Git blob hash anchored at approval. */
  expected: string;
  /**
   * 当前 blob 哈希；`null` 表示文件缺失、非普通文件或无法哈希。
   *
   * Current blob hash; `null` when the file is missing, not a regular file,
   * or cannot be hashed.
   */
  actual: string | null;
  /**
   * 该冲突被记入 `state.conflicts` 的那次检查时间（ISO 8601）。
   *
   * ISO time of the check that recorded this conflict in `state.conflicts`.
   */
  found_at: string;
}

/**
 * 一次冻结检查的结果：本次看到的全部冲突、本次新落库的冲突，以及为后者写出的差异文件。
 *
 * Outcome of one freeze check: every conflict seen, the subset recorded by it,
 * and the `.diff` files written for that subset.
 */
export interface FreezeOutcome {
  /**
   * 工作树是否为 git 仓库；为 `false` 时本次既未比对，也未改动任何状态。
   *
   * Whether the working tree is a git repo; `false` means nothing was compared
   * and no state was touched.
   */
  git: boolean;
  /**
   * 本次发现的全部冲突，含此前已记录的。
   *
   * All conflicts detected by this call, including already-recorded ones.
   */
  conflicts: FrozenConflict[];
  /**
   * 本次新记录的冲突：此前不在 `state.conflicts` 里。
   *
   * Conflicts recorded by this call: not previously in `state.conflicts`.
   */
  newConflicts: FrozenConflict[];
  /**
   * 已保存 `.diff` 文件的仓库相对路径，顺序与本次新记录的冲突一致。
   *
   * Repo-relative paths of the saved `.diff` files, in conflict order.
   */
  diffs: string[];
}

/**
 * `.diff` 的打开标志：独占创建 + 只写 + 不跟随符号链接，冲突文件因此不会被覆盖，
 * 也不会被写到符号链接的目标上。
 *
 * Open flags for a `.diff`: create-exclusive, write-only, no-follow, so a
 * conflict file is never overwritten and never written through a symlink.
 */
const DIFF_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

/**
 * 重新哈希 `frozen_blobs` 里的每个路径，与批准哈希比对：冲突追加进 `state.conflicts`，当前差异
 * 存成 `.cw/tasks/<id>/conflicts/<n>.diff`，同时让已验证的证据失效。
 *
 * 只记录、不还原：工作树一个字节都不写。路径缺失、不可读或不是普通文件同样算冲突（`actual` 记为
 * `null`），fail-safe 方向是“宁可报冲突”。冲突按（路径 + 期望哈希 + 实际哈希）去重：已记录的旧冲突不会
 * 被每次检查重复记录、重复出 diff，只有实际哈希变了才算新冲突。
 *
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
    const hashes = await blobHashes(work, detectable.map((item) => item.resolved));
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

/**
 * 冲突的去重标识：路径 + 期望哈希 + 实际哈希（文件缺失统一记作 `<missing>`），跨次检查稳定。
 *
 * Deterministic identity of a conflict for de-duplication across checks.
 */
function conflictKey(conflict: FrozenConflict): string {
  return `${conflict.path}\0${conflict.expected}\0${conflict.actual ?? "<missing>"}`;
}

/**
 * 工作树哈希与记录的哈希不一致时，让已验证的证据失效并返回失效理由；
 * 没有可失效的证据时返回 `null`。
 *
 * 只在已有 `last_verified` 时才去算树哈希，省掉无谓的 git 调用；哈希本身算失败也同样失效
 * （理由为 `tree hash failed: ...`），fail-safe 方向是“证据不成立”，绝不悄悄保留旧证据。
 * `workRoot` 是真正被哈希的工作树，默认等于账本目录 `repo`；非 git 工作树无法绑定证据，直接放过。
 *
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

/**
 * 契约在批准之后又被改动（文本哈希变了）时，让已验证的证据失效并返回理由；
 * 没有证据或哈希未变则返回 `null`。
 *
 * Invalidate verified evidence when the contract was changed after approval.
 */
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
 * 受保护路径集合：契约的 `frozen` + `interface`、`.cw/project.toml`、升级引用 `.cw/task.json`，
 * 以及本任务目录下除 `notes.md` 之外的一切。写入门禁靠它拦住模型对这些文件的直接改动。
 *
 * 词法非法的路径在这里返回 `false`（不算受保护），它会在 M1 路径守卫那里被拒绝：“不可解析”不等于
 * “可写”，调用方拿到 `true` 也不能跳过路径守卫。
 *
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

/**
 * 下一个冲突 `.diff` 编号：现有最大编号 +1，目录为空时从 1 开始。
 *
 * Next conflict `.diff` number: one past the highest in use, or 1 in an empty
 * directory (paired with create-exclusive writes, so nothing is overwritten).
 */
async function nextDiffNumber(dir: string): Promise<number> {
  const names = await readdir(dir);
  const used = names
    .map((name) => /^(\d+)\.diff$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  return (used.length === 0 ? 0 : Math.max(...used)) + 1;
}

/**
 * 一条判定为冲突的条目：冲突事实 + 渲染 `.diff` 时还需要的解析结果。
 *
 * One conflict as detected: the conflict fact plus what rendering its `.diff`
 * still needs.
 */
interface DetectedConflict {
  conflict: FrozenConflict;
  /**
   * 解析后的绝对路径；`null` 表示该路径根本无法比对。
   *
   * Resolved absolute path, or `null` when the path cannot be compared at all.
   */
  resolved: string | null;
  /**
   * 无法比对的原因；渲染时作为 `note:` 行写进 `.diff` 头部。
   *
   * Why it could not be compared; rendered as a `note:` line in the `.diff`
   * header.
   */
  detail: string | null;
}

/**
 * 冲突 `.diff` 的头部：`path`/`expected`/`actual`/`found_at` 四行固定顺序，实际哈希缺失写 `missing`，
 * 有原因时追加一行 `note:`。
 *
 * Header of a conflict `.diff` file: the four `path`/`expected`/`actual`/
 * `found_at` lines in fixed order, `missing` for an absent actual hash, plus a
 * `note:` line when there is a reason.
 */
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
 * 冲突 `.diff` 的正文：批准 blob 与磁盘当前文件的统一差异；批准内容取不到或路径不可比对时正文为空，
 * 真实原因经 `detail` 交回，不编造差异内容。
 *
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

/**
 * 用独占标志写入一个 `.diff`：目标已存在（含符号链接）时在打开处就失败，而不是覆盖或跟随链接。
 *
 * Writes a `.diff` with create-exclusive flags: an existing target (symlink
 * included) fails at open instead of being overwritten or followed.
 */
async function writeDiff(file: string, content: string): Promise<void> {
  const handle = await open(file, DIFF_FLAGS);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

/**
 * 批准 blob 内容与磁盘当前文件的统一差异：批准内容先落成临时文件（git 只能比较文件），
 * 临时目录在 finally 里删干净，不留残留。
 *
 * Unified diff between the approved blob content and the current file on disk.
 */
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
