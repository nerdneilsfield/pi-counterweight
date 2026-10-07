// 伪 `pi` CLI：供探索者测试使用。探索者运行器按
//   node fake-pi.mjs --mode json ... -- <question>
// 调用它；行为由环境变量选择：CW_FAKE_EXPLORE 定模式（默认 answer），
// CW_FAKE_EXPLORE_TEXT 给答案文本，CW_FAKE_USAGE 给用量 JSON；设置了
// CW_FAKE_ARGV_FILE 时把完整 argv 落盘，供测试钉住 CLI 契约。
//
// A fake `pi` CLI for M8 explorer tests. The explorer runner invokes:
//   node fake-pi.mjs --mode json ... -- <question>
// Behavior is selected by CW_FAKE_EXPLORE; the full argv is dumped to
// CW_FAKE_ARGV_FILE when that variable is set, so tests can pin the CLI
// contract. Usage comes from CW_FAKE_USAGE (JSON), answer text from
// CW_FAKE_EXPLORE_TEXT.
import { writeFileSync } from "node:fs";

const argvFile = process.env.CW_FAKE_ARGV_FILE;
if (argvFile) writeFileSync(argvFile, JSON.stringify(process.argv));

const mode = process.env.CW_FAKE_EXPLORE ?? "answer";
const question = process.argv[process.argv.lastIndexOf("--") + 1] ?? "";
const text = process.env.CW_FAKE_EXPLORE_TEXT ?? `结论甲 ${question ? "tests/a.py" : "x"}:1\n未找到`;
const usage = JSON.parse(process.env.CW_FAKE_USAGE ?? "null");

const emit = (assistant) => {
  process.stdout.write(`${JSON.stringify({ type: "session", id: "fake" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: assistant })}\n`);
};

const message = (stopReason, text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason,
  usage: usage ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  model: "g/explorer",
});

if (mode === "answer") {
  emit(message("stop", text));
} else if (mode === "long") {
  // 40 行长答案：供输出长度相关的断言使用。 / A 40-line answer, for output-length assertions.
  const lines = Array.from({ length: 40 }, (_, i) => `行${i + 1} tests/a.py:1`);
  emit(message("stop", lines.join("\n")));
} else if (mode === "readoutside") {
  // Real tool_execution_start events: two escapes (absolute, ..) plus an
  // in-tree read that must not trigger anything.
  process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "/etc/hosts" } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "r2", toolName: "grep", args: { pattern: "x", path: "../outside" } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "r3", toolName: "read", args: { path: "tests/a.py" } })}\n`);
  emit(message("stop", text));
} else if (mode === "readlink") {
  // 读符号链接 link.py：链接逃逸检测。 / Reads the symlink link.py: link-escape detection.
  process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "link.py" } })}\n`);
  emit(message("stop", text));
} else if (mode === "readinside") {
  // 树内两次读取（read、grep）：都不应触发逃逸告警。 / Two in-tree reads (read, grep): neither may raise an alarm.
  process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "tests/a.py" } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "r2", toolName: "grep", args: { pattern: "x" } })}\n`);
  emit(message("stop", text));
} else if (mode === "writetree") {
  // 直接往工作树里写文件：只读探索者一旦写入即判违规。 / Writes into the tree: a write by the read-only explorer is a violation.
  writeFileSync("explorer-wrote.txt", "the explorer must not write\n");
  emit(message("stop", text));
} else if (mode === "answerthenhang") {
  // Emits a complete final answer first, then hangs: a run killed after the
  // answer must still be judged failed by the runner.
  emit(message("stop", text));
  writeFileSync(process.env.CW_FAKE_PID_FILE ?? "fake-pi.pid", String(process.pid));
  setInterval(() => {}, 60_000);
} else if (mode === "hang") {
  // 记下自身 pid 后常驻不退出：用于超时与清理路径。 / Records its own pid, then never exits: the timeout path.
  writeFileSync(process.env.CW_FAKE_PID_FILE ?? "fake-pi.pid", String(process.pid));
  setInterval(() => {}, 60_000);
} else if (mode === "multimessage") {
  // 先发一条中间 message_end，再发最终答案：只认最后一条。 / An interim message_end precedes the final answer: only the last counts.
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: message("stop", "中间结论 tests/a.py:1") })}\n`);
  emit(message("stop", text));
} else if (mode === "badstop") {
  // stopReason 为 "length"：被截断的答案不算干净完成。 / stopReason "length": a truncated answer is not a clean finish.
  emit(message("length", text));
} else if (mode === "badexit") {
  // 非零退出并往 stderr 输出：runner 必须判定为失败。 / Non-zero exit plus stderr output: the runner must fail the run.
  process.stderr.write("fake pi exploded\n");
  process.exit(1);
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
