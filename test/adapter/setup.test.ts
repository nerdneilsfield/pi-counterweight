/**
 * `/cw-setup`：对话框的回答变成能被 loadProjectConfig 读回的 project.toml。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadProjectConfig } from "../../src/core/config.ts";
import { runSetup } from "../../src/adapters/pi/setup.ts";

test("选模型、填检查命令和保护路径后写出可读回的配置", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-setup-"));
  try {
    const picks = ["g/m1", "（不配置）", "（不配置）", "（不配置）", "o/a/b"];
    const inputs = ["npm test", "tests/, package.json"];
    const ctx = {
      modelRegistry: { getAvailable: () => [{ provider: "g", id: "m1" }, { provider: "o", id: "a/b" }] },
      ui: {
        select: async () => picks.shift(),
        input: async () => inputs.shift(),
        confirm: async () => true,
        notify: () => undefined,
      },
    } as unknown as ExtensionCommandContext;

    expect(await runSetup(ctx, repo)).toBe(true);
    const config = await loadProjectConfig(repo);
    expect(config?.check?.cmd).toEqual(["npm", "test"]);
    expect(config?.protect.paths).toEqual(["tests", "package.json"]);
    expect(config?.models).toEqual({
      explorer: "g/m1", review: null, over_review: null, research: null, historian: "o/a/b",
    });
    expect(await readFile(path.join(repo, ".cw", "project.toml"), "utf8")).toContain("version = 1");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
