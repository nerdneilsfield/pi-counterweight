/**
 * 受保护路径测试：词法匹配，以及 `.cw/project.toml` 的默认保护。
 *
 * Protected-path tests: lexical matching, and the default protection of
 * `.cw/project.toml`.
 */
import { expect, test } from "vitest";
import { CONFIG_FILE, isProtected } from "../../src/core/protect.ts";

// 匹配规则：路径等于模式或落在模式目录之下；`.cw/project.toml` 无论配置如何都受保护。
// Matching: a path equals a pattern or lives under it; `.cw/project.toml` is always protected.
test("词法匹配：精确、目录前缀与默认配置文件", () => {
  const patterns = ["tests", "vitest.config.ts"];
  expect(isProtected("tests", patterns)).toBe(true);
  expect(isProtected("tests/a.py", patterns)).toBe(true);
  expect(isProtected("tests-deep/a.py", patterns)).toBe(false);
  expect(isProtected("src/a.ts", patterns)).toBe(false);
  expect(isProtected("vitest.config.ts", patterns)).toBe(true);
  expect(isProtected("vitest.config.ts.bak", patterns)).toBe(false);
  expect(isProtected(CONFIG_FILE, [])).toBe(true);
  expect(isProtected("other.txt", [])).toBe(false);
});
