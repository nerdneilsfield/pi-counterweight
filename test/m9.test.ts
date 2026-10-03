import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { runEvaluation } from "../eval/run.ts";
import { parseObserveArgv, recordObservation, UsageError } from "../src/cli/observe.ts";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve2, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve2(stdout) : reject(new Error(`git ${args.join(" ")}`)));
  });
}

async function gitRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), prefix));
  await git(repo, ["init"]);
  await writeFile(path.join(repo, "src.txt"), "base\n");
  await git(repo, ["add", "src.txt"]);
  await git(repo, ["-c", "user.email=cw@example.com", "-c", "user.name=cw", "commit", "-m", "base"]);
  return repo;
}

async function onlyObservationDir(cwd: string): Promise<string> {
  const observations = path.join(cwd, ".cw", "observations");
  const names = await readdir(observations);
  expect(names).toHaveLength(1);
  return path.join(observations, names[0]!);
}

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
    expect(lines[1]!.endsWith("|1") || /\|\d+$/.test(lines[1]!)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("eval：伪 pi 跑通四条件，CSV 行数正确，评判清单不含条件标签", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cw-m9-eval-"));
  const repo = path.join(workspace, "repo");
  await mkdir(repo);
  await git(repo, ["init"]);
  await writeFile(path.join(repo, "verify.mjs"), "process.exit(0);\n");
  await writeFile(path.join(repo, "validate.sh"),
    "#!/bin/sh\n" +
    "printf '%s\\n' '{\"protocol\":1,\"run_id\":\"'\"$CW_RUN_ID\"'\",\"complete\":true," +
    "\"checks\":[{\"id\":\"t:red\",\"status\":\"fail\",\"message\":\"baseline red\"}],\"build\":{\"required\":false}," +
    "\"summary\":\"red\",\"logs\":[]}' > \"$CW_RESULT_DIR/result.json\"\n");
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
  const argvLog = path.join(workspace, "argv.jsonl");
  process.env.CW_EVAL_ARGV_FILE = argvLog;
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
    for (const argv of argvLines.slice(1)) {
      expect(argv.includes("--extension")).toBe(true);
      expect(argv[argv.indexOf("--extension") + 1]).toBe(extension);
      expect(argv[argv.lastIndexOf("--") + 1]).toBe("/cw task resume 20261003-demo");
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
    expect(index).toContain("j-1");
    const keyCsv = await readFile(path.join(outDir, "key.csv"), "utf8");
    const keyLines = keyCsv.trimEnd().split("\n");
    expect(keyLines[0]).toBe("key,task,repeat,condition");
    expect(keyLines).toHaveLength(5);
    expect(keyLines.slice(1).map((line) => line.split(",")[3]!).sort()).toEqual(
      ["contract", "escalate", "gate", "native"]);
    const worktrees = (await git(repo, ["worktree", "list", "--porcelain"])).trim().split("\n\n");
    expect(worktrees).toHaveLength(1);
  } finally {
    delete process.env.CW_EVAL_ARGV_FILE;
    delete process.env.CW_EVAL_FAIL_MODEL;
    await rm(workspace, { recursive: true, force: true });
  }
});
