// 伪 pi：供 M9 评估脚手架测试使用。把每次调用的 argv 追加到
// CW_EVAL_ARGV_FILE，行为由 CW_EVAL_FAIL_MODEL 控制：--model 值与它相同
// 时以 stopReason "error" 结束（模拟便宜模型失败），否则正常 stop。
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.CW_EVAL_ARGV_FILE) {
  appendFileSync(process.env.CW_EVAL_ARGV_FILE, `${JSON.stringify(argv)}\n`);
}
const model = argv[argv.indexOf("--model") + 1] ?? "";
const stopReason = model !== "" && model === process.env.CW_EVAL_FAIL_MODEL ? "error" : "stop";
const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 15, cost: { total: 0.01 } };
process.stdout.write(`${JSON.stringify({ type: "session", id: "fake" })}\n`);
process.stdout.write(`${JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason,
    usage,
    model,
  },
})}\n`);
