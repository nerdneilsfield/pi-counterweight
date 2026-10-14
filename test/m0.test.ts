/**
 * 冒烟：在真实 pi 进程里以 RPC 加载扩展，执行 `/cw-version`，不发模型请求。
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

// 契约：扩展能在真实 pi 上加载并响应 `/cw-version`，报告的版本与已安装 pi 的 VERSION 一致；子进程用临时 HOME
// 与独立 PI_CODING_AGENT_DIR、关闭全部可选加载器，因此运行封闭且不发模型请求。
// Contract: the extension loads into a real pi process and answers `/cw-version` with the
// installed pi `VERSION`; the child runs with a scratch HOME, its own `PI_CODING_AGENT_DIR` and
// every optional loader disabled, so the test stays hermetic and issues no model request.
test("真实锁定 Pi 通过 RPC 加载扩展并执行 cw-version，无模型请求", async () => {
  const home = await mkdtemp(join(tmpdir(), "cw-m0-pi-"));
  const child = spawn(process.execPath, [
    resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    "--mode", "rpc", "--offline", "--no-session", "--no-extensions",
    "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--extension", resolve("src/adapters/pi/index.ts"),
  ], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  try {
    const result = await new Promise<string>((done, reject) => {
      child.once("error", reject);
      child.once("close", () => reject(new Error(`Pi exited: ${stderr}`)));
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.type === "extension_ui_request" && message.method === "notify") done(message.message);
        if (message.type === "response" && message.success === false) reject(new Error(line));
      });
      child.stdin.write(`${JSON.stringify({ id: "version", type: "prompt", message: "/cw-version" })}\n`);
    });
    expect(result).toBe(`Counterweight: pi ${VERSION}`);
  } finally {
    lines.close();
    child.kill("SIGTERM");
    await exited;
  }
});
