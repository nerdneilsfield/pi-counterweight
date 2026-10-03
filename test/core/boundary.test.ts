import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("src/core 不 import 任何 pi 模块", async () => {
  const dir = join(import.meta.dirname, "../../src/core");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const text = await readFile(join(dir, name), "utf8");
    const imports = [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*from\s*["']([^"']+)["']/g)]
      .map((match) => match[1]!);
    const offenders = imports.filter((specifier) => specifier.includes("pi-coding-agent") || specifier.includes("@earendil-works"));
    expect(offenders, `${name}`).toEqual([]);
  }
});
