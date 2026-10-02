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

const fixture = path.join(import.meta.dirname, "../fixtures/validators/fake.sh");
const taskId = "20260928-lifetime-fix";

function report(checks: string, extra = ""): string {
  return JSON.stringify({
    protocol: 1, run_id: "1", complete: true,
    checks: JSON.parse(checks),
    build: { required: false },
    summary: "x", logs: [],
    ...JSON.parse(extra || "{}"),
  });
}

const passChecks = `[{"id":"keep","status":"pass"},{"id":"reg","status":"pass"}]`;

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

function validator(root: string, timeout_s: number, mode: string, payload = "", code = "0"): ValidatorConfig {
  return { cmd: ["/bin/sh", fixture, mode, payload, code], timeout_s, env: { CW_REPO: root } };
}

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

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(args.join(" "))));
  });
}
