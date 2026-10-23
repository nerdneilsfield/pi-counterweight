/**
 * `.cw/project.toml`（轻量版）读取测试：可选小节、默认值、未知字段拒绝与受保护路径的加载期校验。
 *
 * Lite `.cw/project.toml` tests: optional sections, defaults, unknown-field
 * rejection, and protected-path validation at load time.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { loadProjectConfig } from "../../src/core/config.ts";

// 建一个临时仓库目录并可选地写入 `.cw/project.toml`；返回仓库根。
// Temp repo dir with an optional `.cw/project.toml`; returns the repo root.
async function repoWith(projectToml: string | null): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "cw-config-"));
  if (projectToml !== null) {
    await mkdir(path.join(repo, ".cw"), { recursive: true });
    await writeFile(path.join(repo, ".cw", "project.toml"), projectToml);
  }
  return repo;
}

// 没有配置文件时返回 null（扩展保持被动），不是抛错。
// A missing config is null (the extension stays passive), not an error.
test("没有配置文件返回 null", async () => {
  const repo = await repoWith(null);
  try {
    expect(await loadProjectConfig(repo)).toBeNull();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 只有 version 的最小配置：check/explorer 为 null，其余为空列表，不启用任何行为。
// A minimal `version = 1` config: check/explorer null, empty lists, nothing armed.
test("最小配置不启用任何行为", async () => {
  const repo = await repoWith("version = 1\n");
  try {
    expect(await loadProjectConfig(repo)).toEqual({
      version: 1,
      check: null,
      protect: { paths: [] },
      models: { explorer: null, review: null, over_review: null, research: null, historian: null },
      router: null,
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 完整配置：timeout_s 缺省 600，protect 路径去掉 ./ 与结尾 /，explorer 与 observe 原样读取。
// A full config: timeout_s defaults to 600, protect paths are normalized, explorer/observe read as-is.
test("完整配置补默认值并规范化受保护路径", async () => {
  const repo = await repoWith(`version = 1

[check]
cmd = ["npm", "test"]
env = { CI = "1" }

[protect]
paths = ["./tests/", "src/generated", "vitest.config.ts"]

[models]
explorer = "gateway/cheap-model"
review = "openrouter/anthropic/claude"
over_review = "gateway/blunt"
`);
  try {
    expect(await loadProjectConfig(repo)).toEqual({
      version: 1,
      check: { cmd: ["npm", "test"], timeout_s: 600, env: { CI: "1" } },
      protect: { paths: ["tests", "src/generated", "vitest.config.ts"] },
      models: {
        explorer: "gateway/cheap-model",
        review: "openrouter/anthropic/claude",
        over_review: "gateway/blunt",
        research: null,
        historian: null,
      },
      router: null,
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 未知字段在顶层与嵌套小节都必须报错，拼错的键不能被静默忽略。
// Unknown fields are rejected at the top level and in nested sections; a typo must never be ignored.
test("未知字段被拒绝", async () => {
  const cases = [
    "version = 1\nbudget = { repairs = 3 }\n", // 旧版字段：必须报错，而不是被忽略
    "version = 1\n[check]\ncmd = [\"true\"]\nrepairs = 1\n",
    "version = 1\n[protect]\npaths = [\"tests\"]\nfreeze = true\n",
    "version = 1\n[models]\nexplorer = \"g/m\"\nextra = \"g/x\"\n",
  ];
  for (const text of cases) {
    const repo = await repoWith(text);
    try {
      await expect(loadProjectConfig(repo)).rejects.toThrow(/project\.toml/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
});

// 受保护路径在加载期校验：空路径、通配符、绝对路径、.. 与 .cw 之下全部拒绝，不给“静默失效”留口子。
// Protected paths are validated at load time: empty, glob, absolute, `..`, and `.cw` all throw.
test("非法的受保护路径在加载期被拒绝", async () => {
  for (const value of ["/etc/passwd", "../outside", "tests/*", ".cw/tasks", ".cw"]) {
    const repo = await repoWith(`version = 1\n[protect]\npaths = ["${value}"]\n`);
    try {
      await expect(loadProjectConfig(repo)).rejects.toThrow(/protect\.paths/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
  // 空字符串连 schema 都过不了（minLength），一样在加载期报错。
  const empty = await repoWith(`version = 1\n[protect]\npaths = [""]\n`);
  try {
    await expect(loadProjectConfig(empty)).rejects.toThrow(/project\.toml/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

// 其余 schema 规则：check 命令不能为空、explorer 模型必须是 provider/model、TOML 语法错误照抛。
// Remaining schema rules: a check command may not be empty, the explorer model must be
// `provider/model`, and TOML syntax errors throw.
test("其余校验规则", async () => {
  const cases = [
    "version = 1\n[check]\ncmd = []\n",
    "version = 1\n[models]\nexplorer = \"no-slash\"\n",
    "version = 1\n[check]\ncmd = [\"true\"]\ntimeout_s = 0\n",
    "version = 2\n",
  ];
  for (const text of cases) {
    const repo = await repoWith(text);
    try {
      await expect(loadProjectConfig(repo)).rejects.toThrow(/project\.toml/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
  const broken = await repoWith("version = \n");
  try {
    await expect(loadProjectConfig(broken)).rejects.toThrow(/project\.toml/);
  } finally {
    await rm(broken, { recursive: true, force: true });
  }
});
