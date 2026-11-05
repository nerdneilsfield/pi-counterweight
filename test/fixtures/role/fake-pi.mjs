// 伪 pi CLI。角色运行器这样调用：
//   node fake-pi.mjs --mode json ... -- @/path/message.md
// CW_FAKE_ARGV_FILE 落盘 argv。CW_FAKE_ROLE 选行为，默认 answer；steps 模式发 CW_FAKE_STEPS 条消息后挂起。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const argvFile = process.env.CW_FAKE_ARGV_FILE;
if (argvFile) writeFileSync(argvFile, JSON.stringify(process.argv));

const mode = process.env.CW_FAKE_ROLE ?? "answer";
const at = process.argv.find((arg) => arg.startsWith("@"));
const message = at === undefined ? "" : readFileSync(at.slice(1), "utf8");
const promptFile = process.argv[process.argv.indexOf("--system-prompt") + 1] ?? "";
const roleKey = promptFile.split("/").pop()?.replace(/\.md$/, "").replace(/-/g, "_") ?? "";
const logFile = process.env.CW_FAKE_CALLS_FILE;
if (logFile) appendFileSync(logFile, `${JSON.stringify({ role: roleKey, argv: process.argv.slice(2), message })}\n`);
const perRole = process.env[`CW_FAKE_TEXT_${roleKey.toUpperCase()}`];
const text = perRole ?? process.env.CW_FAKE_ROLE_TEXT ?? `读到了：${message.slice(0, 40)}`;
const usage = JSON.parse(process.env.CW_FAKE_USAGE ?? "null");

const assistant = {
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: mode === "nostop" ? "length" : "stop",
  usage: usage ?? { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
  model: "g/role",
};

const delay = Number(process.env.CW_FAKE_DELAY_MS ?? 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

if (mode === "steps") {
  // CW_FAKE_STEPS 条要继续调用工具的 assistant 消息，然后挂起。
  const toolTurn = { ...assistant, content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }], stopReason: "toolUse" };
  for (let i = 0; i < Number(process.env.CW_FAKE_STEPS ?? 0); i++) {
    process.stdout.write(`${JSON.stringify({ type: "message_end", message: toolTurn })}\n`);
  }
  setInterval(() => undefined, 1000);
} else if (mode === "crash") {
  process.stderr.write("loading config\nfatal: model g/gone not found\n");
  process.exit(3);
} else if (mode === "hang") {
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: assistant })}\n`);
  setInterval(() => undefined, 1000);
} else if (mode === "empty") {
  process.stdout.write(`${JSON.stringify({ type: "session" })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ type: "session", id: "fake" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: assistant })}\n`);
}
