/**
 * PAUSE 与强制启用的纯逻辑：什么算“改源码”、transcript 怎么渲染与截断、diff 怎么取、结算要做什么。
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { changedFiles, workingDiff } from "../../src/core/auto.ts";
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

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

test("workingDiff：已跟踪的改动给 diff，未跟踪只列名字，.cw 不算，非 git 为 null", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cw-auto-")));
  const plain = await realpath(await mkdtemp(path.join(tmpdir(), "cw-plain-")));
  try {
    git(repo, "init");
    await writeFile(path.join(repo, "a.txt"), "one\n");
    git(repo, "add", "a.txt");
    git(repo, "-c", "user.email=a@b.c", "-c", "user.name=cw", "commit", "-m", "base");
    expect(await workingDiff(repo)).toBe("");

    await writeFile(path.join(repo, "a.txt"), "two\n");
    await writeFile(path.join(repo, "new.txt"), "n\n");
    await mkdir(path.join(repo, ".cw"), { recursive: true });
    await writeFile(path.join(repo, ".cw", "meter.jsonl"), "{}\n");
    const diff = (await workingDiff(repo))!;
    expect(diff).toContain("-one");
    expect(diff).toContain("+two");
    expect(diff).toContain("# new.txt");
    expect(diff).not.toContain("meter.jsonl");
    expect(changedFiles(diff).sort()).toEqual(["a.txt", "new.txt"]);

    expect(await workingDiff(plain)).toBeNull();
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
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
