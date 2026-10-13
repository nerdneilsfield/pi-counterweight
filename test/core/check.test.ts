/**
 * 结束检查测试：退出码判定、输出尾部（行数与字节双界限）、超时/取消的进程组终止，以及事实化渲染。
 *
 * End-check tests: exit-code verdicts, output tails (line and byte bounds),
 * process-group termination on timeout and cancel, and the facts-only report.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { checkPassed, renderCheckReport, runEndCheck, type CheckOutcome } from "../../src/core/check.ts";

// 直接构造一条检查命令配置（不经过 project.toml）。
// A check config built directly (no project.toml involved).
const check = (cmd: string[], timeout_s = 5, env: Record<string, string> = {}) => ({ cmd, timeout_s, env });

// 在临时目录里跑一次检查。
// Runs one check inside a temp directory.
async function inTempCheck(cmd: string[], timeout_s?: number, signal?: AbortSignal): Promise<CheckOutcome> {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-checkcwd-"));
  try {
    return await runEndCheck({ repo: cwd, check: check(cmd, timeout_s), signal });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// 通过：退出码 0，两条输出流都带回尾部。
// A pass: exit code 0 with both streams' tails captured.
test("通过：退出码 0 并带回输出尾部", async () => {
  const outcome = await inTempCheck([
    "/bin/sh", "-c", "printf 'all good\\n'; printf 'warn\\n' >&2",
  ]);
  expect(checkPassed(outcome)).toBe(true);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stdoutTail).toBe("all good");
  expect(outcome.stderrTail).toBe("warn");
  expect(outcome.stdoutTruncated).toBe(false);
});

// 不通过：非零退出码、失败输出与启动错误都不是通过。
// A failure: a nonzero exit code with output; a launch error never passes either.
test("不通过：非零退出码保留输出尾部", async () => {
  const outcome = await inTempCheck([
    "/bin/sh", "-c", "printf 'boom\\n'; printf 'detail\\n' >&2; exit 3",
  ]);
  expect(checkPassed(outcome)).toBe(false);
  expect(outcome.exitCode).toBe(3);
  expect(outcome.stdoutTail).toBe("boom");
  expect(outcome.stderrTail).toBe("detail");
});

// 启动失败保留具体原因（ENOENT），退出码为 null。
// A launch failure keeps its concrete reason (ENOENT) and a null exit code.
test("命令不存在时保留具体原因", async () => {
  const outcome = await inTempCheck(["/nonexistent-cw-check-cmd"]);
  expect(checkPassed(outcome)).toBe(false);
  expect(outcome.exitCode).toBeNull();
  expect(outcome.runnerError).toContain("ENOENT");
});

// 行数上限：200 行只保留最后 80 行，并标注截断。
// Line bound: 200 lines keep the last 80 and are marked truncated.
test("输出尾部按行数有界并标注截断", async () => {
  const outcome = await inTempCheck([
    "/bin/sh", "-c", "i=1; while [ $i -le 200 ]; do echo \"o$i\"; i=$((i+1)); done",
  ]);
  expect(outcome.stdoutTruncated).toBe(true);
  const lines = outcome.stdoutTail.split("\n");
  expect(lines).toHaveLength(80);
  expect(lines[0]).toBe("o121");
  expect(lines[79]).toBe("o200");
});

// 超时：整组进程被终止后才返回；派生的孙进程也不得残留。
// Timeout: the whole group is dead before the call returns; grandchildren included.
test("超时终止整个进程组", async () => {
  const marker = `sleep 30.${Date.now() % 1000}`;
  const started = Date.now();
  const outcome = await inTempCheck(["/bin/sh", "-c", `${marker} & ${marker}`], 1);
  expect(checkPassed(outcome)).toBe(false);
  expect(outcome.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(30_000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const ps = await new Promise<string>((done, reject) => {
    const child = spawn("ps", ["-eo", "args"]);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("error", reject);
    child.once("close", () => done(out));
  });
  expect(ps.includes(marker)).toBe(false);
}, 35_000);

// 取消：外部信号走同一条进程组终止路径，返回时 cancelled 为真。
// Cancel: the caller's signal terminates through the same group path and `cancelled` is true.
test("外部取消终止进程组", async () => {
  const marker = `sleep 31.${Date.now() % 1000}`;
  const controller = new AbortController();
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-checkcancel-"));
  try {
    const pending = runEndCheck({ repo: cwd, check: check(["/bin/sh", "-c", marker], 60), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const outcome = await pending;
    expect(outcome.cancelled).toBe(true);
    expect(checkPassed(outcome)).toBe(false);
    const ps = await new Promise<string>((done, reject) => {
      const child = spawn("ps", ["-eo", "args"]);
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.once("error", reject);
      child.once("close", () => done(out));
    });
    expect(ps.includes(marker)).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 35_000);

// 渲染只写事实：通过/不通过/超时/启动失败各有自己的头部，末次不通过标注“不再自动重试”。
// The report is facts only: pass/fail/timeout/launch each get their header, and a final
// failure is marked as not retried.
test("渲染只含事实", async () => {
  const failed = await inTempCheck(["/bin/sh", "-c", "printf 'boom\\n'; exit 1"]);
  const retry = renderCheckReport(failed, { command: "npm test", final: false });
  expect(retry).toContain("[counterweight] 结束检查未通过：`npm test` 退出码 1");
  expect(retry).not.toContain("不再自动重试");
  expect(retry).toContain("标准输出（尾部）：\nboom");
  expect(retry).not.toContain("建议");

  const final = renderCheckReport(failed, { command: "npm test", final: true });
  expect(final).toContain("不再自动重试");
  expect(final).not.toContain("受保护文件发生变化");

  const passed = renderCheckReport(
    { ...failed, exitCode: 0 }, { command: "npm test", final: false });
  expect(passed).toContain("结束检查通过");

  const timeout = renderCheckReport(
    { ...failed, timedOut: true }, { command: "npm test", final: false });
  expect(timeout).toContain("结束检查超时");
  expect(timeout).toContain("进程组已终止");

  const missing = renderCheckReport(
    { ...failed, runnerError: "spawn npm ENOENT" }, { command: "npm test", final: false });
  expect(missing).toContain("结束检查未能启动");
  expect(missing).toContain("spawn npm ENOENT");
});
