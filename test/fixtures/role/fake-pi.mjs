// 伪 pi CLI。角色运行器这样调用：
//   node fake-pi.mjs --mode json ... -- @/path/message.md
// CW_FAKE_ARGV_FILE 落盘 argv。CW_FAKE_ROLE 选行为，默认 answer。
import { readFileSync, writeFileSync } from "node:fs";

const argvFile = process.env.CW_FAKE_ARGV_FILE;
if (argvFile) writeFileSync(argvFile, JSON.stringify(process.argv));

const mode = process.env.CW_FAKE_ROLE ?? "answer";
const at = process.argv.find((arg) => arg.startsWith("@"));
const message = at === undefined ? "" : readFileSync(at.slice(1), "utf8");
const text = process.env.CW_FAKE_ROLE_TEXT ?? `读到了：${message.slice(0, 40)}`;
const usage = JSON.parse(process.env.CW_FAKE_USAGE ?? "null");

const assistant = {
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: mode === "nostop" ? "length" : "stop",
  usage: usage ?? { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
  model: "g/role",
};

if (mode === "hang") {
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: assistant })}\n`);
  setInterval(() => undefined, 1000);
} else if (mode === "empty") {
  process.stdout.write(`${JSON.stringify({ type: "session" })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ type: "session", id: "fake" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: assistant })}\n`);
}
