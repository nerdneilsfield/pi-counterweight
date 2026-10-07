/**
 * M2 里程碑测试：runValidator 与 judgeEvidence 的三态判定契约——只有 pass 才发布
 * last_verified，fail 与 undetermined 一律 fail-closed；并覆盖超时（杀整个进程组）、
 * 取消（迟到结果丢弃）、产物/验收输入哈希与验证器脚本冻结。
 *
 * M2 milestone tests for `runValidator` and `judgeEvidence`: the three-state verdict
 * contract — only `pass` publishes `last_verified`, while `fail` and `undetermined` fail
 * closed — plus timeouts (the whole process group is killed), cancellation (late results
 * are discarded), artifact / acceptance-input hashing, and validator script freezing.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { contractSha256, readContract } from "../../src/core/contract.ts";
import { recheckArtifacts } from "../../src/core/evidence.ts";
import { claimRun, runValidator } from "../../src/core/runner.ts";
import { createTask, readState } from "../../src/core/task.ts";
import type { Contract, ValidatorConfig } from "../../src/core/types.ts";

/**
 * 伪验证器脚本路径：所有用例都以 `/bin/sh <本脚本> <mode> <payload> <exit>` 驱动它，
 * mode 决定产出哪种结果或故障。
 *
 * Path of the fake validator: every case invokes it as
 * `/bin/sh <script> <mode> <payload> <exit>`, with the mode choosing which result or
 * failure it produces.
 */
const fixture = path.join(import.meta.dirname, "../fixtures/validators/fake.sh");
const taskId = "20260928-lifetime-fix";

/**
 * 构造一份合法的 protocol 1 结果报告：`checks` 是 JSON 数组字符串，`extra`（也是 JSON）
 * 覆盖基准字段，用例借此注入 artifacts / build。默认 run_id 为 "1"，各用例再用
 * `.replace('"run_id":"1"', ...)` 改成当次 run 号。
 *
 * Builds a schema-valid protocol 1 report. `checks` is a JSON array string and `extra`
 * (also JSON) overrides the base fields, letting a case inject artifacts or build. The
 * default run_id is "1", which cases rewrite to the current run number with
 * `.replace('"run_id":"1"', ...)`.
 */
function report(checks: string, extra = ""): string {
  return JSON.stringify({
    protocol: 1, run_id: "1", complete: true,
    checks: JSON.parse(checks),
    build: { required: false },
    summary: "x", logs: [],
    ...JSON.parse(extra || "{}"),
  });
}

/**
 * 基准 checks 片段：契约要求的验收 keep 与回归 reg 全通过。
 *
 * Baseline `checks` fragment: the contract-required acceptance `keep` and regression
 * `reg` checks all pass.
 */
const passChecks = `[{"id":"keep","status":"pass"},{"id":"reg","status":"pass"}]`;

/**
 * 建一个临时 git 仓库（提交 tracked.txt 与 tests/a.py）并创建任务，返回仓库根。
 * 有提交才有 tree 哈希，工作树漂移类用例依赖这一点。
 *
 * Creates a temp git repo with `tracked.txt` and `tests/a.py` committed, then the task,
 * returning the repo root. The commit matters: only a committed tree yields a tree hash,
 * which the worktree-drift cases depend on.
 */
async function gitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cw-m2-"));
  await git(root, ["init"]);
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "tests", "a.py"), "check\n");
  await git(root, ["add", "tracked.txt", "tests/a.py"]);
  await git(root, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  await createTask(root, taskId, "gateway/medium");
  return root;
}

/**
 * 写出最小 contract.toml（change / code、验收 keep、回归 reg、baseline tests/a.py），
 * `body` 作为额外 TOML 片段追加；返回解析后的契约，以及按磁盘文件算出的批准输入哈希。
 *
 * Writes a minimal contract.toml (change / code, acceptance `keep`, regression `reg`,
 * baseline input `tests/a.py`), appending `body` as extra TOML, and returns the parsed
 * contract plus the approved input hash computed from the on-disk file.
 */
async function prepared(root: string, body = ""): Promise<{ contract: Contract; hashes: Record<string, string> }> {
  const file = path.join(root, "contract.toml");
  await writeFile(file, `version = 1
task_id = "${taskId}"
tier = "change"
deliverable = "code"
goal = "fix"
acceptance = ["keep"]
red = ["keep"]
regression = ["reg"]
baseline_inputs = ["tests/a.py"]
${body}`);
  const contract = await readContract(file, root);
  const hashes = { "tests/a.py": createHash("sha256").update(await readFile(path.join(root, "tests/a.py"))).digest("hex") };
  return { contract, hashes };
}

/**
 * 造一个 ValidatorConfig：以 `/bin/sh <fake.sh> <mode> <payload> <code>` 执行，
 * `timeout_s` 交给 runner 计时，CW_REPO 指向被测仓库。
 *
 * Builds a ValidatorConfig that runs `/bin/sh <fake.sh> <mode> <payload> <code>`, passes
 * `timeout_s` to the runner, and points CW_REPO at the repo under test.
 */
function validator(root: string, timeout_s: number, mode: string, payload = "", code = "0"): ValidatorConfig {
  return { cmd: ["/bin/sh", fixture, mode, payload, code], timeout_s, env: { CW_REPO: root } };
}

/**
 * 契约判定的优先级链：required 的 fail / skip / 缺 ID 都判 fail，approved_failures 里的 ID
 * 被豁免（哪怕上报 error）；报告通过但退出码非 0、或批准失败未上报才判 undetermined。
 *
 * Contract precedence: failed, skipped or missing required checks are `fail`, while ids in
 * `approved_failures` are exempt even when reported `error`; only a passing report with a
 * non-zero exit code, or an unreported approved failure, is `undetermined`.
 */
test("验收失败、缺 ID、skip、批准失败与退出码矛盾", async () => {
  const root = await gitRepo();
  const { contract, hashes } = await prepared(root, `[[approved_failures]]\nid = "legacy"\nreason = "known"\n`);
  const fail = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", report(`[{"id":"keep","status":"fail"},{"id":"reg","status":"pass"},{"id":"legacy","status":"fail"}]`)),
  });
  expect(fail.verdict).toEqual({ conclusion: "fail", reasons: ["fail keep"] });
  expect((await readState(root, taskId)).last_verified).toBeNull();

  const replaced = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", report(`[{"id":"other","status":"fail"},{"id":"reg","status":"pass"},{"id":"legacy","status":"fail"}]`).replace('"run_id":"1"', '"run_id":"2"')),
  });
  expect(replaced.verdict.conclusion).toBe("fail");
  expect(replaced.verdict.reasons.join(" ")).toContain("missing keep");

  const skipped = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", report(`[{"id":"keep","status":"skip"},{"id":"reg","status":"pass"},{"id":"legacy","status":"fail"}]`).replace('"run_id":"1"', '"run_id":"3"')),
  });
  expect(skipped.verdict).toEqual({ conclusion: "fail", reasons: ["skip keep"] });

  const known = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", report(passChecks.slice(0, -1) + `,{"id":"legacy","status":"fail"}]`).replace('"run_id":"1"', '"run_id":"4"')),
  });
  expect(known.verdict.conclusion).toBe("pass");
  expect((await readState(root, taskId)).last_verified).toMatchObject({ run: 4, contract_sha256: contractSha256(contract) });

  const contradicted = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", report(passChecks.slice(0, -1) + `,{"id":"legacy","status":"fail"}]`).replace('"run_id":"1"', '"run_id":"5"'), "1"),
  });
  expect(contradicted.verdict).toEqual({ conclusion: "undetermined", reasons: ["结果与退出码矛盾"] });

  const absent = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", report(passChecks).replace('"run_id":"1"', '"run_id":"6"')),
  });
  expect(absent.verdict.conclusion).toBe("undetermined");
  expect(absent.verdict.reasons[0]).toContain("approved failure not reported legacy");

  const exemptError = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", report(passChecks.slice(0, -1) + `,{"id":"legacy","status":"error"}]`).replace('"run_id":"1"', '"run_id":"7"')),
  });
  expect(exemptError.verdict).toEqual({ conclusion: "pass", reasons: [] });
});

/**
 * 证据只看本次 run 目录：预置的 run 0 旧 result.json 不能顶替本次缺失的结果；run_id 与 run
 * 号、check id 唯一性、status 枚举、git 快照任一不符都判 undetermined。
 *
 * Evidence is read only from the current run dir — a pre-seeded run 0 result cannot stand
 * in for the missing one; a run_id other than the run number, a duplicate check id, an
 * out-of-enum status, or a worktree change during validation all yield `undetermined`.
 */
test("旧结果、错误 run_id、工作树变化、空输出与非法报告", async () => {
  const root = await gitRepo();
  const { contract, hashes } = await prepared(root);
  const prior = path.join(root, ".cw", "tasks", taskId, "runs", "0");
  await mkdir(prior, { recursive: true });
  await writeFile(path.join(prior, "result.json"), report(passChecks));
  const absent = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "none"),
  });
  expect(absent.verdict).toEqual({ conclusion: "undetermined", reasons: ["result.json missing"] });
  expect(await readFile(path.join(prior, "result.json"), "utf8")).toContain("keep");

  const wrong = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", report(passChecks)),
  });
  expect(wrong.verdict.reasons[0]).toContain("run_id mismatch");

  const dirty = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "touch"),
  });
  expect(dirty.verdict).toEqual({ conclusion: "undetermined", reasons: ["worktree changed during validation"] });

  const duplicate = JSON.parse(report(`[{"id":"keep","status":"pass"},{"id":"keep","status":"pass"},{"id":"reg","status":"pass"}]`));
  duplicate.run_id = "4";
  const duplicated = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", JSON.stringify(duplicate)),
  });
  expect(duplicated.verdict.reasons[0]).toContain("duplicate check id keep");

  const illegal = JSON.parse(report(`[{"id":"keep","status":"flaky"},{"id":"reg","status":"pass"}]`));
  illegal.run_id = "5";
  const badStatus = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", JSON.stringify(illegal)),
  });
  expect(badStatus.verdict.reasons[0]).toContain("result.json invalid");
});

/**
 * 超时先 SIGTERM 再 SIGKILL 整个进程组，孙进程必须随 leader 一起死；取消则连终止途中写出的
 * 通过结果也一并丢弃。
 *
 * A timeout SIGTERMs then SIGKILLs the whole process group, so the grandchild dies with the
 * leader; a cancel discards even a passing result written while the group is being stopped.
 */
test("超时杀掉孙进程，取消丢弃迟到成功结果", async () => {
  const root = await gitRepo();
  const { contract, hashes } = await prepared(root);
  const timed = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 1, "hang"),
  });
  expect(timed.verdict.conclusion).toBe("undetermined");
  expect(timed.record.timed_out).toBe(true);
  expect(timed.record.result_discarded).toBe(true);
  const child = Number(await readFile(path.join(timed.dir, "child.pid"), "utf8"));
  expect(() => process.kill(child, 0)).toThrow();
  expect((await readState(root, taskId)).last_verified).toBeNull();

  const controller = new AbortController();
  const pending = runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "late"), signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 200);
  const late = await pending;
  expect(late.verdict).toEqual({ conclusion: "undetermined", reasons: ["cancelled"] });
  expect(late.record.result_discarded).toBe(true);
  expect(await readFile(path.join(late.dir, "result.json"), "utf8")).toContain("late");
  expect((await readState(root, taskId)).last_verified).toBeNull();
}, 20_000);

/**
 * 构建证明按内容哈希核对：报告里的 sha256 与磁盘不符判 undetermined；通过之后产物再被改写，
 * recheckArtifacts 必须让这次已验证失效。
 *
 * Build proof is checked by content hash: a reported sha256 that disagrees with disk is
 * `undetermined`, and overwriting the artifact afterwards must invalidate the published
 * verification via recheckArtifacts.
 */
test("构建产物不符为无法判定，事后改动使已验证失效", async () => {
  const root = await gitRepo();
  const { contract, hashes } = await prepared(root);
  await mkdir(path.join(root, "build"));
  const artifact = path.join(root, "build", "out.bin");
  await writeFile(artifact, "fresh\n");
  const sha = createHash("sha256").update(await readFile(artifact)).digest("hex");
  const proof = {
    protocol: 1, run_id: "1", complete: true,
    checks: [{ id: "keep", status: "pass" }, { id: "reg", status: "pass" }],
    artifacts: [{ kind: "build", path: "build/out.bin", sha256: sha, loaded_by: ["keep"] }],
    build: { required: true, fresh: true, load_verified: true },
    summary: "built", logs: [],
  };
  const ok = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", JSON.stringify(proof)),
  });
  expect(ok.verdict.conclusion).toBe("pass");
  expect(ok.record.artifact_hashes["build/out.bin"]).toBe(sha);
  await writeFile(artifact, "stale\n");
  expect(await recheckArtifacts(root, taskId, "s")).toBe("artifact changed build/out.bin");
  expect((await readState(root, taskId)).last_verified).toBeNull();

  const stale = { ...proof, run_id: "2", artifacts: [{ ...proof.artifacts[0], sha256: "a".repeat(64) }] };
  const mismatch = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", JSON.stringify(stale)),
  });
  expect(mismatch.verdict.reasons[0]).toContain("artifact hash mismatch");
});

/**
 * claimRun 取现有数字 run 目录的最大值 +1，绝不复用已占用的目录；非 git 仓库即使判定通过也
 * 不发布 last_verified——没有 tree 哈希可绑定。
 *
 * claimRun takes max(numeric run dirs) + 1 and never reuses an occupied directory; a non-git
 * repo yields a `pass` verdict but publishes no `last_verified`, since there is no tree hash
 * to bind the evidence to.
 */
test("已有 run 目录不复用，非 Git 通过也不绑定", async () => {
  const root = await gitRepo();
  await mkdir(path.join(root, ".cw", "tasks", taskId, "runs"), { recursive: true });
  await mkdir(path.join(root, ".cw", "tasks", taskId, "runs", "1"));
  const resolvedRoot = await realpath(root);
  await expect(claimRun(root, taskId)).resolves.toBe(path.join(resolvedRoot, ".cw", "tasks", taskId, "runs", "2"));
  const occupied = path.join(root, ".cw", "tasks", taskId, "runs", "3");
  await mkdir(occupied);
  await expect(claimRun(root, taskId)).resolves.toBe(path.join(resolvedRoot, ".cw", "tasks", taskId, "runs", "4"));

  const plain = await mkdtemp(path.join(tmpdir(), "cw-m2-plain-"));
  await mkdir(path.join(plain, "tests"), { recursive: true });
  await writeFile(path.join(plain, "tests", "a.py"), "check\n");
  await createTask(plain, taskId, "gateway/medium");
  const { contract, hashes } = await prepared(plain);
  const outcome = await runValidator({
    repo: plain, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(plain, 30, "body", report(passChecks)),
  });
  expect(outcome.verdict.conclusion).toBe("pass");
  expect(outcome.record.git).toBe(false);
  expect((await readState(plain, taskId)).last_verified).toBeNull();
});

/**
 * 批准输入集是判定前提：验收输入哈希与批准值不符即 undetermined，本次证据不被采信。
 *
 * The approved input set is a precondition: an acceptance-input hash that disagrees with the
 * approved value is `undetermined`, and the evidence of this run is not trusted.
 */
test("验收输入哈希不符则无法判定", async () => {
  const root = await gitRepo();
  const { contract, hashes } = await prepared(root);
  hashes["tests/a.py"] = "b".repeat(64);
  const outcome = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", report(passChecks)),
  });
  expect(outcome.verdict.reasons[0]).toContain("acceptance input changed tests/a.py");
  expect((await readState(root, taskId)).last_verified).toBeNull();
});

/**
 * 哈希阶段的 IO 失败（自指 symlink 触发 ELOOP）不向上抛：写进 run.json 的 record_error、
 * 对应哈希落成 null，并判 undetermined；退出码仍保留进程的真实值。
 *
 * IO failures while hashing (a self-referential symlink loops) never propagate: they land in
 * run.json `record_error` with a null hash and an `undetermined` verdict, while the exit code
 * keeps the process's real value.
 */
test("快照与产物哈希 IO 错误记入 run.json 并判无法判定", async () => {
  const root = await gitRepo();
  const { contract, hashes } = await prepared(root);
  const io = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    // 验证器把验收输入换成自指 symlink：after 快照哈希 ELOOP，不再裸抛。
    validator: validator(root, 30, "loopinput", report(passChecks)),
  });
  expect(io.verdict.conclusion).toBe("undetermined");
  expect(io.verdict.reasons[0]).toContain("input hash failed tests/a.py");
  expect(io.record.record_error).toContain("input hash failed tests/a.py");
  expect(io.record.input_hashes_after["tests/a.py"]).toBeNull();
  expect((await readState(root, taskId)).last_verified).toBeNull();

  await mkdir(path.join(root, "build"));
  await symlink("loop.bin", path.join(root, "build", "loop.bin"));
  const proof = {
    protocol: 1, run_id: "2", complete: true,
    checks: [{ id: "keep", status: "pass" }, { id: "reg", status: "pass" }],
    artifacts: [{ kind: "build", path: "build/loop.bin", sha256: "a".repeat(64), loaded_by: ["keep"] }],
    build: { required: true, fresh: true, load_verified: true },
    summary: "built", logs: [],
  };
  const artifact = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", JSON.stringify(proof)),
  });
  expect(artifact.verdict.conclusion).toBe("undetermined");
  expect(artifact.verdict.reasons[0]).toContain("artifact hash failed build/loop.bin");
  expect(artifact.record.record_error).toContain("artifact hash failed build/loop.bin");
  expect(artifact.record.artifact_hashes["build/loop.bin"]).toBeNull();

  for (const outcome of [io, artifact]) {
    const record = JSON.parse(await readFile(path.join(outcome.dir, "run.json"), "utf8"));
    expect(record.record_error).not.toBeNull();
    expect(record.exit_code).toBe(0);
  }
});

/**
 * `__proto__` 这类会触发原型赋值的路径必须作为自有属性写进 run.json，否则普通对象赋值会把它
 * 悄悄吞掉，recheck 再也看不到该产物变化。
 *
 * A path like `__proto__` must be recorded in run.json as an own property: a plain object
 * assignment would swallow it, and recheck could never notice the artifact changing.
 */
test("__proto__ 路径哈希必须记入 run.json 且 recheck 失效", async () => {
  const root = await gitRepo();
  await writeFile(path.join(root, "__proto__"), "artifact\n");
  const contractFile = path.join(root, "contract.toml");
  await writeFile(contractFile, `version = 1
task_id = "${taskId}"
tier = "change"
deliverable = "code"
goal = "fix"
acceptance = ["keep"]
red = ["keep"]
regression = ["reg"]
baseline_inputs = ["tests/a.py", "__proto__"]
`);
  const contract = await readContract(contractFile, root);
  const approved = Object.create(null) as Record<string, string>;
  approved["tests/a.py"] = createHash("sha256").update("check\n").digest("hex");
  approved["__proto__"] = createHash("sha256").update("artifact\n").digest("hex");
  const proof = {
    protocol: 1, run_id: "1", complete: true,
    checks: [{ id: "keep", status: "pass" }, { id: "reg", status: "pass" }],
    artifacts: [{ kind: "build", path: "__proto__", sha256: approved["__proto__"], loaded_by: ["keep"] }],
    build: { required: true, fresh: true, load_verified: true },
    summary: "built", logs: [],
  };
  const ok = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: approved,
    validator: validator(root, 30, "body", JSON.stringify(proof)),
  });
  expect(ok.verdict.conclusion).toBe("pass");
  const record = JSON.parse(await readFile(path.join(ok.dir, "run.json"), "utf8"));
  expect(Object.hasOwn(record.artifact_hashes, "__proto__")).toBe(true);
  expect(Object.hasOwn(record.input_hashes_after, "__proto__")).toBe(true);
  expect((await readState(root, taskId)).last_verified).toMatchObject({ run: 1 });

  await writeFile(path.join(root, "__proto__"), "stale\n");
  expect(await recheckArtifacts(root, taskId, "s")).toBe("artifact changed __proto__");
  expect((await readState(root, taskId)).last_verified).toBeNull();
});

/**
 * 验证器 cmd 引用的仓库脚本按批准哈希冻结：内容漂移或批准哈希缺失都 fail-closed 判
 * undetermined，且不发布验证。
 *
 * A repo script referenced by the validator cmd is frozen by its approved hash: drift, or a
 * missing approved hash, fails closed to `undetermined` without publishing verification.
 */
test("验证器引用的仓库脚本按批准哈希冻结：漂移判无法判定", async () => {
  const root = await gitRepo();
  const { contract, hashes } = await prepared(root);
  // 仓库内相对验证脚本（不进 tree 哈希排除的 .cw 之外也成立；此处用普通路径）。
  const script = "valscript.sh";
  const scriptBody = `#!/bin/sh
cat > "$CW_RESULT_DIR/result.json" <<EOF
{"protocol":1,"run_id":"$CW_RUN_ID","complete":true,"checks":[{"id":"keep","status":"pass"},{"id":"reg","status":"pass"}],"build":{"required":false},"summary":"x","logs":[]}
EOF
`;
  const writeScript = (body: string) => writeFile(path.join(root, script), body);
  await writeScript(scriptBody);
  const approvedScript = createHash("sha256").update(scriptBody).digest("hex");
  const validator = (extra: Record<string, string> = {}): ValidatorConfig => ({
    cmd: ["/bin/sh", script], timeout_s: 30, env: { CW_REPO: root },
    ...extra,
  });

  // 批准哈希与内容一致：通过。
  const ok = await runValidator({
    repo: root, taskId, session: "s", contract,
    approvedInputHashes: hashes, approvedValidatorInputs: { [script]: approvedScript },
    validator: validator(),
  });
  expect(ok.verdict.conclusion).toBe("pass");
  expect((await readState(root, taskId)).last_verified).toMatchObject({ run: 1 });

  // 脚本在批准后被修改（before 快照即不一致）：无法判定，本次不发布验证。
  await writeScript(`${scriptBody}# drifted\n`);
  const drifted = await runValidator({
    repo: root, taskId, session: "s", contract,
    approvedInputHashes: hashes, approvedValidatorInputs: { [script]: approvedScript },
    validator: validator(),
  });
  expect(drifted.verdict.conclusion).toBe("undetermined");
  expect(drifted.verdict.reasons[0]).toContain("validator input changed valscript.sh");
  expect(drifted.record.input_hashes_before[script]).not.toBe(approvedScript);
  expect(drifted.lastVerified).toBeNull();
  await writeScript(scriptBody);

  // 未冻结（批准哈希缺失）：fail-closed，同判无法判定。
  const unfrozen = await runValidator({
    repo: root, taskId, session: "s", contract,
    approvedInputHashes: hashes, approvedValidatorInputs: {},
    validator: validator(),
  });
  expect(unfrozen.verdict.conclusion).toBe("undetermined");
  expect(unfrozen.verdict.reasons[0]).toBe("approved input set mismatch");
}, 20_000);

/**
 * 取消覆盖发布全程：结果已在磁盘上通过，abort 仍落在退出后的快照/判定/发布阶段，也必须丢弃
 * 该结果并保证 last_verified 不被写下。
 *
 * Cancellation covers the whole publication path: even with a passing result already on disk,
 * an abort landing after the validator exited (snapshot / judge / publish) must discard it and
 * leave `last_verified` unwritten.
 */
test("取消覆盖发布全程：判定阶段取消不写已验证", async () => {
  const root = await gitRepo();
  const { contract, hashes } = await prepared(root);
  const controller = new AbortController();
  const pending = runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    // 验证器先写出可通过的 result.json，再留 marker 随即退出；abort 落在退出后的
    // 快照/判定/发布阶段，证明迟到取消会丢弃本可通过的结果。
    validator: validator(root, 30, "passmark", report(passChecks)),
    signal: controller.signal,
  });
  const marker = path.join(root, ".cw", "tasks", taskId, "runs", "1", "marker");
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error("validator never wrote marker");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  const outcome = await pending;
  expect(outcome.verdict).toEqual({ conclusion: "undetermined", reasons: ["cancelled"] });
  expect(outcome.record.cancelled).toBe(true);
  expect(outcome.record.result_discarded).toBe(true);
  expect(outcome.lastVerified).toBeNull();
  expect((await readState(root, taskId)).last_verified).toBeNull();
}, 20_000);

/**
 * claimRun 对 runs 根做防逃逸检查：symlink 与普通文件都拒绝，且失败时不会经链接目标在仓库
 * 之外留下任何写入。
 *
 * claimRun guards the runs root against escapes: a symlink or a plain file is rejected, and the
 * failed attempt writes nothing outside the repo through the link target.
 */
test("runs 目录拒绝 symlink、普通文件与越界写入", async () => {
  const root = await gitRepo();
  const runs = path.join(root, ".cw", "tasks", taskId, "runs");
  // M7 起 createTask 即记录 task_created 计量事件，runs 目录随之存在；
  // 本测试针对 claimRun 的守卫，先移除再放置异常形态。
  await rm(runs, { recursive: true, force: true });
  const outside = await mkdtemp(path.join(tmpdir(), "cw-m2-out-"));
  await symlink(outside, runs);
  await expect(claimRun(root, taskId)).rejects.toThrow(/runs must not be a symlink/);
  await expect(readdir(outside)).resolves.toEqual([]);
  await rm(runs);
  await writeFile(runs, "not a directory");
  await expect(claimRun(root, taskId)).rejects.toThrow(/runs must be a directory/);
  await rm(runs);
  const resolvedRoot = await realpath(root);
  await expect(claimRun(root, taskId)).resolves.toBe(path.join(resolvedRoot, ".cw", "tasks", taskId, "runs", "1"));
});

/**
 * 证据形状错误一律 undetermined 且 run.json 照常保留：loaded_by 指向未知 check、result.json
 * 是目录、产物路径的父级是普通文件都走这条路径。
 *
 * Malformed evidence always yields `undetermined` while the run.json record is kept: an
 * artifact `loaded_by` an unknown check id, a result.json that is a directory, and an artifact
 * path whose parent is a plain file all take this path.
 */
test("loaded_by 未知 ID 与 result.json 形状错误均为无法判定且保留 run 记录", async () => {
  const root = await gitRepo();
  const { contract, hashes } = await prepared(root);
  await mkdir(path.join(root, "build"));
  const artifact = path.join(root, "build", "out.bin");
  await writeFile(artifact, "fresh\n");
  const sha = createHash("sha256").update(await readFile(artifact)).digest("hex");
  const proof = {
    protocol: 1, run_id: "1", complete: true,
    checks: [{ id: "keep", status: "pass" }, { id: "reg", status: "pass" }],
    artifacts: [{ kind: "build", path: "build/out.bin", sha256: sha, loaded_by: ["ghost"] }],
    build: { required: true, fresh: true, load_verified: true },
    summary: "built", logs: [],
  };
  const ghost = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", JSON.stringify(proof)),
  });
  expect(ghost.verdict.conclusion).toBe("undetermined");
  expect(ghost.verdict.reasons[0]).toContain("loaded_by unknown check ghost");

  const dirResult = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "dirmkdir"),
  });
  expect(dirResult.verdict.conclusion).toBe("undetermined");
  expect(dirResult.verdict.reasons[0]).toContain("result.json unreadable");
  const record = JSON.parse(await readFile(path.join(dirResult.dir, "run.json"), "utf8"));
  expect(record.run).toBe(2);

  const nested = { ...proof, run_id: "3", artifacts: [{ ...proof.artifacts[0], path: "tests/a.py/nested.bin", loaded_by: ["keep"] }] };
  const midFile = await runValidator({
    repo: root, taskId, session: "s", contract, approvedInputHashes: hashes,
    validator: validator(root, 30, "body", JSON.stringify(nested)),
  });
  expect(midFile.verdict.conclusion).toBe("undetermined");
  expect(midFile.verdict.reasons[0]).toContain("artifact missing tests/a.py/nested.bin");
});

/**
 * 夹具专用 git 包装：退出码非 0 即 reject（错误信息是命令行），仓库搭建失败立刻暴露。
 *
 * Fixture-only git wrapper: a non-zero exit rejects with the argv, so a broken repo setup
 * surfaces immediately instead of failing somewhere downstream.
 */
function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(args.join(" "))));
  });
}
