/**
 * 审查闸门：用本地 HTTP 服务按 System One 文档的响应形状回答，断言放行判据和失败时不放行。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import type { RouterConfig } from "../../src/core/config.ts";
import { gate } from "../../src/core/router.ts";

let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()));

async function serve(status: number, body: unknown, seen: { auth?: string; body?: unknown } = {}): Promise<RouterConfig> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      seen.auth = req.headers.authorization;
      seen.body = JSON.parse(raw);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`, api_key_env: null, model: "nimble",
    timeout_ms: 2000, skip_below: 0.1, audit_rate: 0.1,
  };
}

const answer = (noul: unknown) => ({ model: "nimble", answers: { problem: { type: "noul", noul } } });

test("概率不高于阈值放行，请求体符合 System One 形状", async () => {
  const seen: { auth?: string; body?: any } = {};
  const router = await serve(200, answer(0.02), seen);
  const verdict = await gate(router, "review", "diff", undefined, () => 0.99);
  expect(verdict).toMatchObject({ skip: true, p: 0.02, audited: false, error: null });
  expect(seen.body).toMatchObject({ model: "nimble", state: "diff", questions: { problem: { type: "noul" } } });
});

test("概率高于阈值不放行", async () => {
  const router = await serve(200, answer(0.4));
  expect(await gate(router, "over_review", "diff")).toMatchObject({ skip: false, p: 0.4 });
});

test("放行后按 audit_rate 抽查，抽中则不放行", async () => {
  const router = await serve(200, answer(0.02));
  expect(await gate(router, "review", "diff", undefined, () => 0.05)).toMatchObject({ skip: false, audited: true });
});

test("HTTP 错误、坏响应、缺 key 都不放行", async () => {
  const bad = await serve(413, { error: "too big" });
  expect(await gate(bad, "review", "diff")).toMatchObject({ skip: false, p: null, error: "HTTP 413" });
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  const garbage = await serve(200, answer("0.01"));
  expect((await gate(garbage, "review", "diff")).skip).toBe(false);
  const keyed = { ...garbage, api_key_env: "CW_TEST_MISSING_KEY" };
  expect(await gate(keyed, "review", "diff")).toMatchObject({ skip: false, error: "环境变量 CW_TEST_MISSING_KEY 为空" });
});
