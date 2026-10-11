/**
 * 受保护路径测试：词法匹配、快照对比（修改/新增/删除）、符号链接跳过与 `.cw/project.toml` 的默认保护。
 *
 * Protected-path tests: lexical matching, snapshot comparison (modified,
 * created, deleted), symlink skipping, and the default protection of
 * `.cw/project.toml`.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { CONFIG_FILE, changedProtected, isProtected, snapshotProtected } from "../../src/core/protect.ts";

// 建一个含 `.cw/project.toml` 与 `tests/a.py` 的临时目录（不要求 git）。
// Temp dir with `.cw/project.toml` and `tests/a.py` (git not required).
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cw-protect-"));
  await mkdir(path.join(root, ".cw"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, ".cw", "project.toml"), "version = 1\n");
  await writeFile(path.join(root, "tests", "a.py"), "base\n");
  return root;
}

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

// 快照对比：修改、删除与新增各算一处变化；未变化的文件不出现在结果里。
// Snapshot comparison: modify, delete, and create each count; untouched files stay out.
test("快照对比列出修改、删除与新增", async () => {
  const root = await fixture();
  try {
    const patterns = ["tests"];
    const snapshot = await snapshotProtected(root, patterns);
    // 配置文件也在快照里（默认保护），所以是两条。
    expect([...snapshot.keys()].sort()).toEqual([".cw/project.toml", "tests/a.py"]);
    expect(await changedProtected(root, patterns, snapshot)).toEqual([]);

    await writeFile(path.join(root, "tests", "a.py"), "changed\n");
    await writeFile(path.join(root, "tests", "b.py"), "new\n");
    await writeFile(path.join(root, ".cw", "project.toml"), "version = 1\n# edited\n");
    expect(await changedProtected(root, patterns, snapshot)).toEqual([
      ".cw/project.toml", "tests/a.py", "tests/b.py",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 删除受保护文件同样是变化；快照中不存在的目录/文件不报错。
// Deleting a protected file is a change; missing patterns never throw.
test("删除文件算变化，缺失路径安静跳过", async () => {
  const root = await fixture();
  try {
    const snapshot = await snapshotProtected(root, ["tests", "missing-dir"]);
    await rm(path.join(root, "tests", "a.py"));
    expect(await changedProtected(root, ["tests", "missing-dir"], snapshot)).toEqual(["tests/a.py"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 目录遍历中的符号链接一律跳过：链到仓外不读取，链到受保护文件也不进快照。
// Symlinks inside a walked directory are skipped whole: no reading through them, no snapshot entry.
test("符号链接不进入快照", async () => {
  const root = await fixture();
  try {
    await symlink("/etc/hosts", path.join(root, "tests", "link.py"));
    const snapshot = await snapshotProtected(root, ["tests"]);
    expect([...snapshot.keys()].sort()).toEqual([".cw/project.toml", "tests/a.py"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
