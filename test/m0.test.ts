import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";

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
    expect(result).toBe("Counterweight: pi 0.99.1");
  } finally {
    lines.close();
    child.kill("SIGTERM");
    await exited;
  }
});

test.each([4096, 0])("缓存探针发相同长前缀两次，并区分读取证据 %i", async (cached) => {
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ usage: {
      prompt_tokens: 16000, completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: bodies.length === 2 ? cached : 0 },
    } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli/probe-cache.ts"], {
      env: { PATH: process.env.PATH, CW_GATEWAY_URL: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        CW_GATEWAY_API_KEY: "fake-test-key", CW_GATEWAY_MODEL: "fake-model" },
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    expect(code).toBe(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    const payload = JSON.parse(bodies[0]);
    expect(payload.messages[0].content).toContain("record_4095");
    const reports = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(reports[0].usage.prompt_tokens).toBe(16000);
    expect(reports[2].verdict).toBe(cached > 0 ? "supported" : "unconfirmed");
    expect(output).not.toContain("fake-test-key");
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});
