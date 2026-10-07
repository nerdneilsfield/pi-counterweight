/**
 * M0 冒烟测试：在真实 pi 进程中以 RPC 模式加载扩展执行 `/cw-version`，再用伪网关运行缓存探针 `src/cli/probe-cache.ts`。
 *
 * M0 smoke tests. The first drives a real pi process in RPC mode with the
 * extension loaded and asserts `/cw-version` answers without any model request;
 * the second points the cache probe at a fake gateway and checks that both
 * requests carry an identical long prefix while only the reported cache usage
 * differs.
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
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

// 边界：同一长前缀连发两次，两次请求体必须逐字节相同；只有网关上报非零 cached_tokens 才判 supported，
// 报 0 则判 unconfirmed（证据不足不等于否定结论），且探针输出不得泄漏网关密钥。
// Boundary: the same long prefix is sent twice and both bodies must be byte-identical. `supported`
// requires non-zero `cached_tokens` from the gateway, while a reported 0 yields `unconfirmed`:
// missing evidence is never a negative verdict. Nor may the API key leak into the probe's output.
test.each([4096, 0])("缓存探针发相同长前缀两次，并区分读取证据 %i", async (cached) => {
  // 伪网关：记录两次原始请求体，只对第二次请求报告 cached_tokens（参数决定该值是否为 0）。
  // Fake gateway: records both raw request bodies and reports `cached_tokens` only on the second
  // request, keeping "identical bodies" and "gateway confirmed a cache read" as separate facts.
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
    // 探针按行输出 JSON 报告：前两条对应两次请求，最后一条是判定结果。
    // The probe prints one JSON report per line: the first two cover the requests, the last one
    // carries the verdict.
    const reports = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(reports[0].usage.prompt_tokens).toBe(16000);
    expect(reports[2].verdict).toBe(cached > 0 ? "supported" : "unconfirmed");
    expect(output).not.toContain("fake-test-key");
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});
