// chronicle 事件写到 HOME 下的 .agents；测试进程用临时 HOME，绝不碰真的 ~/.agents。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.HOME = mkdtempSync(path.join(tmpdir(), "cw-test-home-"));
