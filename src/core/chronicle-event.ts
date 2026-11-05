/**
 * 回合结束时往 chronicle 目录写一条事件和一条证据，格式见 skills 仓库 steward-board 的 chronicle-layout.md。
 * 默认目录 `~/.agents/chronicle`，目录不存在就什么也不写，不自动创建。文件先写临时文件再改名；任何失败都被吞掉，不影响主流程。
 * `projects.yaml` 的格式没有规定，只认简单的 `绝对路径: 项目id` 行，认不出就写 `project: null`。
 * 两个仓库里这个文件逐字节相同，不引用任何宿主。
 *
 * Writes one event and one evidence file per finished turn into the chronicle directory, which is never created here.
 * Byte-identical in both repositories.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ChronicleOutcome = "ok" | "failed" | "cancelled" | "unknown";

export interface ChronicleInput {
  host: string;
  session: string;
  /** 宿主的回合 id；没有为 null。 */
  turn: string | null;
  /** 工作目录的绝对路径。 */
  workspace: string;
  outcome: ChronicleOutcome;
  /** 检查报告的短文本，或者拿不到证据的原因。 */
  evidence: { text: string } | { gap: string };
}

const EVIDENCE_CAP = 2_000;

/** 只认 `绝对路径: id` 这样的行（路径和 id 可加引号，`#` 起注释）；认不出的行跳过。 */
export function parseProjects(text: string): Map<string, string | null> {
  const projects = new Map<string, string | null>();
  for (const line of text.split("\n")) {
    const match = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s#'"][^#]*?))\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#'"]\S*))\s*(?:#.*)?$/.exec(line);
    if (match === null) continue;
    const key = match[1] ?? match[2] ?? match[3]!;
    const id = match[4] ?? match[5] ?? match[6]!;
    if (!path.isAbsolute(key)) continue;
    projects.set(path.resolve(key), id === "" || id === "null" || id === "~" ? null : id);
  }
  return projects;
}

async function projectOf(dir: string, workspace: string): Promise<string | null> {
  try {
    return parseProjects(await readFile(path.join(dir, "projects.yaml"), "utf8")).get(path.resolve(workspace)) ?? null;
  } catch {
    return null;
  }
}

async function writeJson(dir: string, id: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${id}.json`);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temp, target);
}

/** 失败不抛。chronicle 目录不存在时什么也不写。 */
export async function writeChronicleEvent(input: ChronicleInput): Promise<void> {
  try {
    const root = path.join(os.homedir(), ".agents", "chronicle");
    if (!(await stat(root)).isDirectory()) return;
    const hostname = os.hostname();
    const machine = hostname.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
    const time = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const eventId = randomUUID();
    const evidence = "text" in input.evidence
      ? { text: input.evidence.text.slice(0, EVIDENCE_CAP) }
      : { gap: input.evidence.gap };
    // 先写证据再写事件：看到事件的人一定能找到它的证据。
    const evidenceId = randomUUID();
    await writeJson(path.join(root, "evidence", machine), evidenceId, {
      id: evidenceId, event: eventId, time, source: `counterweight:${input.host}`, ...evidence,
    });
    await writeJson(path.join(root, "events", machine), eventId, {
      id: eventId,
      time,
      machine: hostname,
      agent: `${input.host}:${input.session}`,
      workspace: input.workspace,
      outcome: input.outcome,
      project: await projectOf(root, input.workspace),
      turn: input.turn === "" ? null : input.turn,
    });
  } catch {
    // The chronicle is observational only.
  }
}
