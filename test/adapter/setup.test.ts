/**
 * `/cw-setup`：对话框的回答变成能被 loadProjectConfig 读回的 project.toml。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadProjectConfig } from "../../src/core/config.ts";
import { runSetup } from "../../src/adapters/pi/setup.ts";

test("选模型、填检查命令和保护路径后写出可读回的配置", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-setup-"));
  try {
    // 六个角色：explorer、review、over_review、research、historian、planner；然后是 historian 就绪后才出现的 chronicle 开关。
    const picks = ["g/m1", "（不配置）", "（不配置）", "（不配置）", "o/a/b", "（不配置）", "是"];
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
      explorer: "g/m1", review: null, over_review: null, research: null, historian: "o/a/b", planner: null,
    });
    expect(config?.auto).toEqual({ review: false, chronicle: true, pause: false });
    expect(await readFile(path.join(repo, ".cw", "project.toml"), "utf8")).toContain("version = 1");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("重写配置时保留 [timeouts] 和 [router]，不因为没问就丢掉", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-setup-keep-"));
  try {
    await mkdir(path.join(repo, ".cw"), { recursive: true });
    await writeFile(path.join(repo, ".cw", "project.toml"), `version = 1

[models]
review = "g/r"

[timeouts]
review = 900

[router]
url = "http://localhost:1/v1/systemone"
model = "nimble"
`);
    const ctx = {
      modelRegistry: { getAvailable: () => [{ provider: "g", id: "r" }] },
      ui: {
        // 六个角色都选“保持/不配置”，两个文本框保持。
        select: async (_title: string, options: string[]) => options[0],
        input: async () => "=",
        confirm: async () => true,
        notify: () => undefined,
      },
    } as unknown as ExtensionCommandContext;
    expect(await runSetup(ctx, repo)).toBe(true);
    const config = await loadProjectConfig(repo);
    expect(config?.timeouts).toEqual({ review: 900 });
    expect(config?.router?.model).toBe("nimble");
    expect(config?.models.review).toBe("g/r");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
