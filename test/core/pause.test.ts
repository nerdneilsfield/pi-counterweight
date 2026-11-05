/**
 * PAUSE 与强制启用的纯逻辑：什么算“改源码”、transcript 怎么渲染与截断、结算要做什么（diff 的基线见 baseline.test.ts）。
 */
import { expect, test } from "vitest";
import { isSourceEdit, renderTranscript } from "../../src/core/pause.ts";

test(".cw、tmp 和仓库外不算改源码，其余都算", () => {
  expect(isSourceEdit("src/a.ts")).toBe(true);
  expect(isSourceEdit("README.md")).toBe(true);
  expect(isSourceEdit("tests/a.py")).toBe(true);
  expect(isSourceEdit(".cw/notes.md")).toBe(false);
  expect(isSourceEdit("tmp/repro.sh")).toBe(false);
  expect(isSourceEdit("scratch/repro.sh")).toBe(true);
  expect(isSourceEdit(null)).toBe(false);
  // 前缀必须按目录边界匹配：tmp-utils 不是草稿目录。
  expect(isSourceEdit("tmp-utils/a.ts")).toBe(true);
});

test("transcript：保留请求、调用与截断后的结果，丢思考块", () => {
  const text = renderTranscript([
    { role: "user", content: "修复绑定" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "不该出现" },
      { type: "text", text: "先看 binding.ts" },
      { type: "toolCall", name: "read", arguments: { path: "src/binding.ts" } },
    ] },
    { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(5_000) }] },
  ]);
  expect(text).toContain("[用户]\n修复绑定");
  expect(text).toContain("先看 binding.ts");
  expect(text).toContain('调用 read {"path":"src/binding.ts"}');
  expect(text).not.toContain("不该出现");
  expect(text).toContain("已截断");
  expect(text.length).toBeLessThan(2_600);
});

test("transcript 超预算时从最早处丢，并注明丢了几段", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `第${i}条${"y".repeat(100)}` }));
  const text = renderTranscript(messages, 450);
  expect(text).toContain("更早的");
  expect(text).toContain("第9条");
  expect(text).not.toContain("第0条");
});

test("超时档位：夹进 [300, 1800]，下一档翻倍并封顶，用满上限返回 null", async () => {
  const { clampTimeoutS, nextTimeoutS } = await import("../../src/roles/run.ts");
  expect(clampTimeoutS(600)).toBe(600);
  expect(clampTimeoutS(1)).toBe(300);
  expect(clampTimeoutS(99_999)).toBe(1_800);
  expect(clampTimeoutS(450.6)).toBe(451);
  for (const bad of [undefined, null, "600", NaN, Infinity]) expect(clampTimeoutS(bad)).toBeUndefined();

  expect(nextTimeoutS(300_000)).toBe(600);
  expect(nextTimeoutS(600_000)).toBe(1_200);
  expect(nextTimeoutS(1_200_000)).toBe(1_800);
  expect(nextTimeoutS(1_800_000)).toBeNull();
  expect(nextTimeoutS(2_000_000)).toBeNull();
});
