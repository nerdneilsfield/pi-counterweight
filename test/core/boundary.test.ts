/**
 * 架构边界测试：把 `src/core` 下每个 `.ts` 文件当纯文本扫描，断言纯逻辑层不 import 任何 pi 包（含其 scoped 命名空间）。
 *
 * Architecture boundary test. Every `src/core/*.ts` file is read as plain text
 * and asserted to be free of pi imports, scoped namespace included, so the core
 * layer stays runnable without the pi runtime. The scan is textual rather than
 * AST-based: it checks what the sources literally say, type-only imports
 * included.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("src/core 不 import 任何 pi 模块", async () => {
  const dir = join(import.meta.dirname, "../../src/core");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
  // 列目录为空或路径写错时必须直接失败，否则下面的断言会空跑通过。
  // Fail on an empty listing: a wrong path must not let the assertions pass vacuously.
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const text = await readFile(join(dir, name), "utf8");
    // 提取每条 import / export … from "…" 语句的模块说明符。
    // Pull the module specifier out of each `import` / `export … from "…"` statement.
    const imports = [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*from\s*["']([^"']+)["']/g)]
      .map((match) => match[1]!);
    // 说明符里出现 pi 包名或其 scoped 命名空间即算越界；以文件名作为断言消息，失败时能直接定位。
    // A specifier mentioning the pi package or its scoped namespace is a violation; the file name
    // is passed as the assertion message so a failure points at the offending source.
    const offenders = imports.filter((specifier) => specifier.includes("pi-coding-agent") || specifier.includes("@earendil-works"));
    expect(offenders, `${name}`).toEqual([]);
  }
});
