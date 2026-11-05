import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { budgetMessage, stepLimit, watchSteps } from "../../src/core/budget.ts";

const count = (text: string) => text.split("\n").filter((line) => line !== "").length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("上限：research 80，planner 1，其余 30", () => {
  expect(["explorer", "review", "over_review", "historian"].map(stepLimit)).toEqual([30, 30, 30, 30]);
  expect(stepLimit("research")).toBe(80);
  expect(stepLimit("planner")).toBe(1);
  expect(budgetMessage(30)).toBe("已达 30 步上限，已终止，拆小输入后重试");
});

test("watchSteps：超过上限才触发，只触发一次", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-budget-"));
  try {
    const file = path.join(dir, "steps.jsonl");
    await writeFile(file, "x\n".repeat(3));
    let fired = 0;
    const stop = watchSteps({ file, limit: 3, count, onExceed: () => { fired += 1; }, intervalMs: 10 });
    await sleep(80);
    expect(fired).toBe(0);
    await appendFile(file, "x\n");
    await sleep(80);
    await appendFile(file, "x\n".repeat(5));
    await sleep(80);
    expect(fired).toBe(1);
    stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchSteps：stop() 或信号中止之后不再读文件", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-budget-"));
  try {
    const file = path.join(dir, "steps.jsonl");
    await writeFile(file, "");
    let fired = 0;
    watchSteps({ file, limit: 0, count, onExceed: () => { fired += 1; }, intervalMs: 10 })();
    const own = new AbortController();
    watchSteps({ file, limit: 0, count, onExceed: () => { fired += 1; }, signal: own.signal, intervalMs: 10 });
    own.abort();
    await appendFile(file, "x\n".repeat(2));
    await sleep(100);
    expect(fired).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
