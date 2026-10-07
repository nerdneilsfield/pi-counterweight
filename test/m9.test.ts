/**
 * M9 测试：cw observe 现场记录（尾部行/字节窗口与截断标记、非 git 降级、版本探测、argv 解析），
 * 以及 eval 脚手架用伪 pi 跑通四条件（含先红拒绝短路）的端到端契约。
 *
 * M9 tests: `cw observe` scene recording (tail line/byte bounds and truncation marker, non-git
 * degradation, version probes, argv parsing) plus the eval scaffold end-to-end over the four
 * conditions, including the red-check-rejection short-circuit.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { runEvaluation } from "../eval/run.ts";
import { parseObserveArgv, recordObservation, UsageError } from "../src/cli/observe.ts";

// 同步执行一条 git 命令并收集 stdout；非零退出即 reject（resolve2 避开同名导入）。
// One git subprocess collecting stdout; rejects on nonzero exit (`resolve2` shadows the import).
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve2, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve2(stdout) : reject(new Error(`git ${args.join(" ")}`)));
  });
}

// 建一个含基线提交（src.txt）的临时 git 仓库，供 observe/eval 用例共用。
// Creates a temp git repo with one baseline commit (`src.txt`).
async function gitRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), prefix));
  await git(repo, ["init"]);
  await writeFile(path.join(repo, "src.txt"), "base\n");
  await git(repo, ["add", "src.txt"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  return repo;
}

// 断言恰好生成一个观测目录并返回其路径——“一次运行一条记录”的不变量。
// Asserts exactly one observation dir exists — one record per run.
async function onlyObservationDir(cwd: string): Promise<string> {
  const observations = path.join(cwd, ".cw", "observations");
  const names = await readdir(observations);
  expect(names).toHaveLength(1);
  return path.join(observations, names[0]!);
}

// 失败语义：非零退出不影响记录完整性——退出码、备注、git 绑定与两路尾部都保留。
// A failing command still records everything: exit code, note, git binding, tails.
test("observe：命令失败仍完整记录命令、备注、git 与尾部输出", async () => {
  const repo = await gitRepo("cw-m9-observe-");
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  try {
    const argv = ["/bin/sh", "-c", "printf 'out-line\\n'; printf 'err-line\\n' >&2; exit 3"];
    const { dir, record } = await recordObservation({ cwd: repo, command: argv, note: "备注一" });
    expect(record.exit_code).toBe(3);
    expect(record.runner_error).toBeNull();
    expect(record.command).toEqual(argv);
    expect(record.note).toBe("备注一");
    expect(record.cwd).toBe(await realpath(repo));
    expect(record.git.supported).toBe(true);
    if (record.git.supported) {
      expect(record.git.commit).toBe(head);
      expect(record.git.tree).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(record.os.platform.length).toBeGreaterThan(0);
    expect(record.versions).toEqual([]);
    expect(await readFile(path.join(dir, "stdout-tail.txt"), "utf8")).toBe("out-line\n");
    expect(await readFile(path.join(dir, "stderr-tail.txt"), "utf8")).toBe("err-line\n");
    expect(await readdir(dir)).toEqual(expect.arrayContaining(["observation.json"]));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 恰好保留每个流的最后 200 行（stdout o301..o500、stderr e101..e300）。
// Exactly the last 200 lines per stream are kept, and no fewer.
test("observe：尾部输出恰好 200 行", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-m9-tail-"));
  try {
    const script = [
      "i=1; while [ $i -le 500 ]; do echo \"o$i\"; i=$((i+1)); done",
      "i=1; while [ $i -le 300 ]; do echo \"e$i\" >&2; i=$((i+1)); done",
    ].join("; ");
    await recordObservation({ cwd: dir, command: ["/bin/sh", "-c", script], note: null });
    const observation = await onlyObservationDir(dir);
    const stdout = (await readFile(path.join(observation, "stdout-tail.txt"), "utf8")).split("\n")
      .filter((line) => line !== "");
    expect(stdout).toHaveLength(200);
    expect(stdout[0]).toBe("o301");
    expect(stdout[199]).toBe("o500");
    const stderr = (await readFile(path.join(observation, "stderr-tail.txt"), "utf8")).split("\n")
      .filter((line) => line !== "");
    expect(stderr).toHaveLength(200);
    expect(stderr[0]).toBe("e101");
    expect(stderr[199]).toBe("e300");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 超行数上限时截断标记必须排第一行，且不被尾部 slice 丢掉。
// The truncation marker survives the tail slice and heads the file.
test("observe：行数截断时标记保留，恰为 200 行尾部（150000 短行）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-m9-marker-"));
  try {
    const script = "awk 'BEGIN{for(i=1;i<=150000;i++) print \"o\"i}'";
    await recordObservation({ cwd: dir, command: ["/bin/sh", "-c", script], note: null });
    const observation = await onlyObservationDir(dir);
    const lines = (await readFile(path.join(observation, "stdout-tail.txt"), "utf8")).split("\n")
      .filter((line) => line !== "");
    // 150000 行远超 200 行上限：标记 + 最后 200 行，标记不得被 slice 丢掉。
    expect(lines[0]).toBe("[counterweight: 仅保留尾部 200 行]");
    expect(lines).toHaveLength(201);
    expect(lines[1]).toBe("o149801");
    expect(lines[200]).toBe("o150000");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 字节窗口 1MiB 上界：大行场景行数可少于 200，但文件与标记仍有界。
// The 1 MiB byte window bounds the file even when fewer than 200 lines fit.
test("observe：超大输出时窗口有界并注明截断", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-m9-window-"));
  try {
    // 400 行 × 8KB ≈ 3.2MB，超出 1MiB 窗口：只保留尾部 200 行且文件有界。
    const script = "i=1; while [ $i -le 400 ]; do printf 'x%.0s' $(seq 1 8000); printf \"|%s\\n\" \"$i\"; i=$((i+1)); done";
    await recordObservation({ cwd: dir, command: ["/bin/sh", "-c", script], note: null });
    const observation = await onlyObservationDir(dir);
    const target = path.join(observation, "stdout-tail.txt");
    const stat = await (await import("node:fs/promises")).stat(target);
    expect(stat.size).toBeLessThan(1_200_000);
    const lines = (await readFile(target, "utf8")).split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe("[counterweight: 仅保留尾部 200 行]");
    // 行数与字节双界限：大行场景先触达 1MiB 窗口，行数少于 200 但文件有界。
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.length).toBeLessThanOrEqual(201);
    expect(lines[lines.length - 1]!.endsWith("|400")).toBe(true);
    // 字节窗口可能从更早的行切入：首行只需是完整数据行，不必是 |1。
    // The byte window may cut earlier: line 1 need not be |1, just a whole line.
    expect(lines[1]!.endsWith("|1") || /\|\d+$/.test(lines[1]!)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 非 git 目录降级为 {supported:false}，退出码照常记录。
// A non-git cwd degrades to {supported:false}; everything else is recorded.
test("observe：非 git 仓库降级记录，不做 git 绑定", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-m9-nogit-"));
  try {
    const { record } = await recordObservation({ cwd: dir, command: ["/usr/bin/true"], note: null });
    expect(record.git).toEqual({ supported: false });
    expect(record.exit_code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 探测只取命令与版本首行；环境变量绝不进入记录（防泄密的不变量）。
// Probes keep only the command and version line; env vars never enter the record.
test("observe：[observe] versions 探测工具版本，环境变量不入记录", async () => {
  const repo = await gitRepo("cw-m9-versions-");
  try {
    await mkdir(path.join(repo, ".cw"), { recursive: true });
    await writeFile(path.join(repo, ".cw", "project.toml"), `version = 1

[validator]
cmd = ["/bin/sh", "-c", "true"]
timeout_s = 600

[models]
cheap = "g/cheap"
medium = "g/medium"
strong = "g/strong"
explorer = "g/explorer"

[tiers]
script = "cheap"
change = "medium"
interface = "strong"

[observe]
versions = ["node"]
`);
    process.env.CW_OBSERVE_SECRET = "secret-value-zzz";
    try {
      const { record } = await recordObservation({
        cwd: repo,
        command: ["/bin/sh", "-c", "exit 0"],
        note: "多词 备注",
      });
      expect(record.note).toBe("多词 备注");
      expect(record.versions).toHaveLength(1);
      expect(record.versions[0]!.command).toBe("node");
      expect(record.versions[0]!.version).toMatch(/^v\d+/);
      const text = JSON.stringify(record);
      expect(text).not.toContain("secret-value-zzz");
      expect(text).not.toContain("CW_OBSERVE_SECRET");
    } finally {
      delete process.env.CW_OBSERVE_SECRET;
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 启动失败（ENOENT）保留具体原因，exit_code 为 null；两条尾部仍写入空内容。
// A spawn failure keeps the concrete reason; empty tails are still written.
test("observe：命令不存在时 runner_error 保留具体原因而非裸退出码", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-m9-enoent-"));
  try {
    const { record } = await recordObservation({
      cwd: dir,
      command: ["/nonexistent-cw-m9-cmd"],
      note: null,
    });
    expect(record.exit_code).toBeNull();
    expect(record.runner_error).toContain("ENOENT");
    const observation = await onlyObservationDir(dir);
    expect(await readFile(path.join(observation, "stdout-tail.txt"), "utf8")).toBe("");
    expect(await readFile(path.join(observation, "stderr-tail.txt"), "utf8")).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `--` 是硬边界：其后 argv 原样保留（含 --not-a-flag），各种误用抛 UsageError。
// `--` is the hard boundary; argv after it stays verbatim, misuse throws UsageError.
test("observe：参数解析要求 -- 并原样保留 argv", () => {
  expect(parseObserveArgv(["--note", "a b", "--", "make", "test"])).toEqual({
    command: ["make", "test"],
    note: "a b",
  });
  expect(parseObserveArgv(["--note=x", "--", "run"])).toEqual({ command: ["run"], note: "x" });
  expect(parseObserveArgv(["--", "echo", "--not-a-flag"])).toEqual({ command: ["echo", "--not-a-flag"], note: null });
  expect(() => parseObserveArgv(["/bin/echo", "hi"])).toThrow(UsageError);
  expect(() => parseObserveArgv(["--wat", "--", "/bin/echo"])).toThrow(UsageError);
  expect(() => parseObserveArgv(["--note"])).toThrow(UsageError);
  expect(() => parseObserveArgv(["--"])).toThrow(UsageError);
});

/**
 * eval 用例共用的夹具：一个 git 仓库（verify.mjs + validate.sh 验证器）与一份 tasks.toml；
 * validate.sh 把 t:red 的 pass/fail 交给 CW_EVAL_RED_STATUS 控制，用于制造先红拒绝场景。
 *
 * Fixture repo + tasks.toml shared by the eval tests.
 */
async function evalWorkspace(prefix: string): Promise<{ workspace: string; repo: string; tasksPath: string }> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(workspace, "repo");
  await mkdir(repo);
  await git(repo, ["init"]);
  await writeFile(path.join(repo, "verify.mjs"), "process.exit(0);\n");
  await writeFile(path.join(repo, "validate.sh"), `#!/bin/sh
status=fail
[ "\$CW_EVAL_RED_STATUS" = "pass" ] && status=pass
printf '%s\\n' '{"protocol":1,"run_id":"'"$CW_RUN_ID"'","complete":true,"checks":[{"id":"t:red","status":"'"$status"'","message":"baseline red"}],"build":{"required":false},"summary":"red","logs":[]}' > "$CW_RESULT_DIR/result.json"
`);
  await git(repo, ["add", "verify.mjs", "validate.sh"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  const tasksPath = path.join(workspace, "tasks.toml");
  await writeFile(tasksPath, `version = 1

[models]
cheap = "fake/cheap"
medium = "fake/medium"
strong = "fake/strong"
explorer = "fake/explorer"

[tiers]
script = "cheap"
change = "medium"
interface = "strong"

[[tasks]]
id = "demo"
repo = "${repo}"
base_commit = "HEAD"
tier = "change"
model = "fake/strong"
prompt = "修复问题并保持改动最小"
acceptance = "verify.mjs 退出码为零"
judge = "改动完整且没有多余内容"
verify_cmd = ["node", "verify.mjs"]
run_timeout_s = 60

[tasks.validator]
cmd = ["/bin/sh", "validate.sh"]
timeout_s = 60

[tasks.contract]
deliverable = "code"
acceptance = ["t:red"]
red = ["t:red"]
regression = []
frozen = []
baseline_inputs = []
`);
  return { workspace, repo, tasksPath };
}

// results.csv 去掉表头后的数据行，供按列断言用。
// Data rows of results.csv with the header stripped.
async function readRows(outDir: string): Promise<string[][]> {
  const lines = (await readFile(path.join(outDir, "results.csv"), "utf8")).trimEnd().split("\n");
  return lines.slice(1).map((line) => line.split(","));
}

// 四条件端到端：CSV/argv/评判清单/key 的行数与取值、无孤儿进程、worktree 无残留。
// Four conditions end to end: CSV, argv, judging/key outputs, and no leftovers.
test("eval：伪 pi 跑通四条件，CSV 行数正确，评判清单不含条件标签", async () => {
  const { workspace, repo, tasksPath } = await evalWorkspace("cw-m9-eval-");
  const argvLog = path.join(workspace, "argv.jsonl");
  process.env.CW_EVAL_ARGV_FILE = argvLog;
  // 强制便宜模型失败，逼出 escalate 条件的升级（tokens 30 = 便宜 + 强模型两次运行）。
  // Forces the cheap-model failure that the `escalate` condition must remedy.
  process.env.CW_EVAL_FAIL_MODEL = "fake/cheap";
  const outDir = path.join(workspace, "out");
  try {
    const summary = await runEvaluation({
      tasksPath,
      outDir,
      piPath: resolve("test/fixtures/eval/fake-pi.mjs"),
    });
    expect(summary.rows).toHaveLength(4);
    const csv = await readFile(path.join(outDir, "results.csv"), "utf8");
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(
      "task,condition,repeat,final_state,verdict,wall_seconds,tokens,cache_read,cache_write,cost,repairs,escalated");
    const rows = lines.slice(1).map((line) => line.split(","));
    expect(rows.map((row) => row[1])).toEqual(["native", "gate", "contract", "escalate"]);
    expect(rows.every((row) => row[2] === "1")).toBe(true);
    const byCondition = new Map(rows.map((row) => [row[1]!, row]));
    expect(byCondition.get("native")![3]).toBe("completed");
    expect(byCondition.get("gate")![3]).toBe("approved");
    expect(byCondition.get("contract")![3]).toBe("approved");
    expect(byCondition.get("escalate")![3]).toBe("approved");
    for (const row of rows) {
      expect(row[4]).toBe("pass");
      expect(Number(row[5])).toBeGreaterThan(0);
      expect(row[10]).toBe("0");
    }
    expect(byCondition.get("native")![6]).toBe("15");
    expect(byCondition.get("gate")![6]).toBe("15");
    expect(byCondition.get("contract")![6]).toBe("15");
    expect(byCondition.get("escalate")![6]).toBe("30");
    expect(byCondition.get("escalate")![11]).toBe("true");
    expect(byCondition.get("native")![11]).toBe("false");
    expect(byCondition.get("gate")![11]).toBe("false");
    expect(byCondition.get("contract")![11]).toBe("false");

    const argvLines = (await readFile(argvLog, "utf8")).trimEnd().split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(argvLines).toHaveLength(5);
    const extension = resolve("src/adapters/pi/index.ts");
    expect(argvLines[0]!.includes("--extension")).toBe(false);
    // 任务 id 前缀取 eval 生成时的 UTC 日期（与 eval/run.ts 的 ymd() 同源）。
    const utcYmd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    for (const argv of argvLines.slice(1)) {
      expect(argv.includes("--extension")).toBe(true);
      expect(argv[argv.indexOf("--extension") + 1]).toBe(extension);
      expect(argv[argv.lastIndexOf("--") + 1]).toBe(`/cw task resume ${utcYmd}-demo`);
    }
    expect(argvLines[3]![argvLines[3]!.indexOf("--model") + 1]).toBe("fake/cheap");
    expect(argvLines[4]![argvLines[4]!.indexOf("--model") + 1]).toBe("fake/strong");

    const judgingDir = path.join(outDir, "judging");
    const entries = (await readdir(judgingDir)).sort();
    expect(entries).toEqual(["index.md", "j-1.md", "j-2.md", "j-3.md", "j-4.md"]);
    const index = await readFile(path.join(judgingDir, "index.md"), "utf8");
    let all = index;
    for (const entry of entries.filter((name) => name.endsWith(".md"))) {
      all += await readFile(path.join(judgingDir, entry), "utf8");
    }
    for (const label of ["native", "gate", "contract", "escalate"]) {
      expect(all).not.toContain(label);
    }
    // .cw/ 是 harness 状态（native 没有、门禁条件有），出现即可反推条件。
    expect(all).not.toContain(".cw/");
    expect(index).toContain("j-1");
    const keyCsv = await readFile(path.join(outDir, "key.csv"), "utf8");
    const keyLines = keyCsv.trimEnd().split("\n");
    expect(keyLines[0]).toBe("key,task,repeat,condition");
    expect(keyLines).toHaveLength(5);
    expect(keyLines.slice(1).map((line) => line.split(",")[3]!).sort()).toEqual(
      ["contract", "escalate", "gate", "native"]);
    const worktrees = (await git(repo, ["worktree", "list", "--porcelain"])).trim().split("\n\n");
    expect(worktrees).toHaveLength(1);
    // 无孤儿：评估结束（含红检/验证/清理路径）后不应残留任何伪 pi 进程。
    const ps = await new Promise<string>((done, reject) => {
      const child = spawn("ps", ["-eo", "args"]);
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.once("error", reject);
      child.once("close", () => done(out));
    });
    expect(ps.includes("fixtures/eval/fake-pi")).toBe(false);
  } finally {
    delete process.env.CW_EVAL_ARGV_FILE;
    delete process.env.CW_EVAL_FAIL_MODEL;
    await rm(workspace, { recursive: true, force: true });
  }
});

// 先红拒绝短路：该终态不判 pass、不跑验证、不计升级，也不启动强模型。
// Red-check rejection short-circuits: no verdict, no escalation, no strong model.
test("eval：先红拒绝时 contract/escalate 为 red_check_failed，不计升级不启动强模型", async () => {
  const { workspace, tasksPath } = await evalWorkspace("cw-m9-red-");
  const argvLog = path.join(workspace, "argv.jsonl");
  process.env.CW_EVAL_ARGV_FILE = argvLog;
  process.env.CW_EVAL_RED_STATUS = "pass"; // 先红项在基线通过 → 先红检查拒绝
  const outDir = path.join(workspace, "out");
  try {
    const summary = await runEvaluation({
      tasksPath,
      outDir,
      piPath: resolve("test/fixtures/eval/fake-pi.mjs"),
    });
    expect(summary.rows).toHaveLength(4);
    const rows = await readRows(outDir);
    const byCondition = new Map(rows.map((row) => [row[1]!, row]));
    expect(byCondition.get("native")![3]).toBe("completed");
    expect(byCondition.get("gate")![3]).toBe("approved");
    expect(byCondition.get("contract")![3]).toBe("red_check_failed");
    expect(byCondition.get("escalate")![3]).toBe("red_check_failed");
    expect(byCondition.get("contract")![4]).toBe("not_run");
    expect(byCondition.get("escalate")![4]).toBe("not_run");
    expect(byCondition.get("native")![4]).toBe("pass");
    expect(byCondition.get("gate")![4]).toBe("pass");
    // contract 与 escalate 的 cheap/strong 都没有进入模型执行：仅 native+gate 两次 pi。
    const argvLines = (await readFile(argvLog, "utf8")).trimEnd().split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(argvLines).toHaveLength(2);
    for (const argv of argvLines) {
      expect(argv[argv.indexOf("--model") + 1]).toBe("fake/strong");
    }
    expect(argvLines[0]!.includes("--extension")).toBe(false);
    expect(argvLines[1]!.includes("--extension")).toBe(true);
    expect(byCondition.get("escalate")![11]).toBe("false");
    expect(byCondition.get("escalate")![6]).toBe("0");
    expect(byCondition.get("escalate")![9]).toBe("");
  } finally {
    delete process.env.CW_EVAL_ARGV_FILE;
    delete process.env.CW_EVAL_RED_STATUS;
    await rm(workspace, { recursive: true, force: true });
  }
});
