import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingCount, withPending } from "../../src/core/pending.ts";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "cw-pending-"));
  await mkdir(path.join(repo, ".cw"));
});
afterEach(() => rm(repo, { recursive: true, force: true }));

const write = (text: string) => writeFile(path.join(repo, ".cw/pending.md"), text);

describe("pendingCount", () => {
  it("counts only lines of the form '- YYYY-MM-DD |', not the indented detail lines", async () => {
    await write([
      "# Pending",
      "",
      "- 2026-11-05 | project | AGENTS.md | `make test` skips GPU tests",
      "  Evidence: failed twice; see tests/README.md",
      "  - 2026-11-05 | nested | x | indented, not an entry",
      "- 2026-11-06 | user | memory | prefers short answers",
      "- 2026-11-06| missing space | x | y",
      "- 2026-1-6 | short month | x | y",
      "* 2026-11-06 | star | x | y",
      "- a plain bullet",
      "- 2026-11-07 | project | BUGS.md | second\r",
      "",
    ].join("\n"));
    expect(await pendingCount(repo)).toBe(3);
  });

  it("is 0 for no file, an empty file and a file without entries", async () => {
    expect(await pendingCount(repo)).toBe(0);
    await write("");
    expect(await pendingCount(repo)).toBe(0);
    await write("# nothing yet\n");
    expect(await pendingCount(repo)).toBe(0);
  });
});

describe("withPending", () => {
  it("leaves the report alone for 0, shows its own line without a report, and joins the first line otherwise", () => {
    expect(withPending("通过", 0)).toBe("通过");
    expect(withPending(null, 0)).toBeNull();
    expect(withPending(null, 2)).toBe("[counterweight] 待批 2 条（.cw/pending.md）");
    expect(withPending("通过", 2)).toBe("通过；待批 2 条");
    expect(withPending("未通过\n输出尾部", 1)).toBe("未通过；待批 1 条\n输出尾部");
  });
});
