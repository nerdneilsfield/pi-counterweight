/**
 * cw observe 测试：尾部行/字节窗口与截断标记、非 git 降级、版本探测、argv 解析，以及失败命令的完整记录。
 *
 * `cw observe` tests: tail line/byte bounds and the truncation marker, non-git
 * degradation, version probes, argv parsing, and complete records for failing
 * commands.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { parseObserveArgv, recordObservation, UsageError } from "../src/cli/observe.ts";

// 同步执行一条 git 命令并收集 stdout；非零退出即 reject。
// One git subprocess collecting stdout; rejects on a nonzero exit.
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")}`)));
  });
}

// 建一个含基线提交（src.txt）的临时 git 仓库，供 observe 用例共用。
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
  const repo = await gitRepo("cw-observe-");
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
  const dir = await mkdtemp(path.join(tmpdir(), "cw-observe-tail-"));
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
  const dir = await mkdtemp(path.join(tmpdir(), "cw-observe-marker-"));
  try {
    const script = "awk 'BEGIN{for(i=1;i<=150000;i++) print \"o\"i}'";
    await recordObservation({ cwd: dir, command: ["/bin/sh", "-c", script], note: null });
    const observation = await onlyObservationDir(dir);
    const lines = (await readFile(path.join(observation, "stdout-tail.txt"), "utf8")).split("\n")
      .filter((line) => line !== "");
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
  const dir = await mkdtemp(path.join(tmpdir(), "cw-observe-window-"));
  try {
    const script = "i=1; while [ $i -le 400 ]; do printf 'x%.0s' $(seq 1 8000); printf \"|%s\\n\" \"$i\"; i=$((i+1)); done";
    await recordObservation({ cwd: dir, command: ["/bin/sh", "-c", script], note: null });
    const observation = await onlyObservationDir(dir);
    const target = path.join(observation, "stdout-tail.txt");
    const stat = await (await import("node:fs/promises")).stat(target);
    expect(stat.size).toBeLessThan(1_200_000);
    const lines = (await readFile(target, "utf8")).split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe("[counterweight: 仅保留尾部 200 行]");
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.length).toBeLessThanOrEqual(201);
    expect(lines[lines.length - 1]!.endsWith("|400")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 非 git 目录降级为 {supported:false}，退出码照常记录。
// A non-git cwd degrades to {supported:false}; everything else is recorded.
test("observe：非 git 仓库降级记录，不做 git 绑定", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-observe-nogit-"));
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
  const repo = await gitRepo("cw-observe-versions-");
  try {
    await mkdir(path.join(repo, ".cw"), { recursive: true });
    await writeFile(path.join(repo, ".cw", "project.toml"), `version = 1

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
  const dir = await mkdtemp(path.join(tmpdir(), "cw-observe-enoent-"));
  try {
    const { record } = await recordObservation({
      cwd: dir,
      command: ["/nonexistent-cw-observe-cmd"],
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
