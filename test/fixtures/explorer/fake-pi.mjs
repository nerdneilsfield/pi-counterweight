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
  const lines = Array.from({ length: 40 }, (_, i) => `行${i + 1} tests/a.py:1`);
  emit(message("stop", lines.join("\n")));
} else if (mode === "writetree") {
  writeFileSync("explorer-wrote.txt", "the explorer must not write\n");
  emit(message("stop", text));
} else if (mode === "hang") {
  writeFileSync(process.env.CW_FAKE_PID_FILE ?? "fake-pi.pid", String(process.pid));
  setInterval(() => {}, 60_000);
} else if (mode === "multimessage") {
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: message("stop", "中间结论 tests/a.py:1") })}\n`);
  emit(message("stop", text));
} else if (mode === "badstop") {
  emit(message("length", text));
} else if (mode === "badexit") {
  process.stderr.write("fake pi exploded\n");
  process.exit(1);
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
