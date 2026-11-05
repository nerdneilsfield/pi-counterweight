import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProjects, writeChronicleEvent } from "../../src/core/chronicle-event.ts";

let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "cw-chron-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  process.env.HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

const chronicleDir = () => path.join(home, ".agents", "chronicle");
const machineDir = (kind: "events" | "evidence") => path.join(chronicleDir(), kind, os.hostname().replace(/[^A-Za-z0-9._-]/g, "_"));
const readAll = async (kind: "events" | "evidence") =>
  Promise.all((await readdir(machineDir(kind))).map(async (name) => ({
    name, value: JSON.parse(await readFile(path.join(machineDir(kind), name), "utf8")),
  })));
const input = { host: "codex", session: "s1", turn: "t1", workspace: "/work/app", outcome: "ok" as const, evidence: { text: "检查通过" } };

describe("writeChronicleEvent", () => {
  it("writes nothing, and does not create the directory, when the chronicle does not exist", async () => {
    await writeChronicleEvent(input);
    await expect(stat(path.join(home, ".agents"))).rejects.toThrow();
  });

  it("writes an event and the evidence that points at it, in the documented shape", async () => {
    await mkdir(chronicleDir(), { recursive: true });
    await writeChronicleEvent(input);
    const [event] = await readAll("events");
    const [evidence] = await readAll("evidence");
    expect(event!.name).toBe(`${event!.value.id}.json`);
    expect(event!.value).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      machine: os.hostname(),
      agent: "codex:s1",
      workspace: "/work/app",
      outcome: "ok",
      project: null,
      turn: "t1",
    });
    expect(evidence!.value).toMatchObject({ event: event!.value.id, text: "检查通过", source: "counterweight:codex" });
    expect(evidence!.value.id).not.toBe(event!.value.id);
    expect(evidence!.value.gap).toBeUndefined();
  });

  it("never reuses an id, records a gap when there is no evidence text, and leaves no temp file", async () => {
    await mkdir(chronicleDir(), { recursive: true });
    await writeChronicleEvent({ ...input, turn: "", outcome: "unknown", evidence: { gap: "没有配置结束检查" } });
    await writeChronicleEvent({ ...input, turn: null, outcome: "cancelled", evidence: { gap: "取消" } });
    const events = await readAll("events");
    expect(new Set(events.map((e) => e.value.id)).size).toBe(2);
    expect(events.map((e) => e.value.turn)).toEqual([null, null]);
    expect(events.map((e) => e.value.outcome).sort()).toEqual(["cancelled", "unknown"]);
    const evidence = await readAll("evidence");
    expect(evidence.map((e) => e.value.gap).sort()).toEqual(["取消", "没有配置结束检查"]);
    expect(evidence.every((e) => e.value.text === undefined)).toBe(true);
    for (const kind of ["events", "evidence"] as const) {
      expect((await readdir(machineDir(kind))).filter((name) => !name.endsWith(".json"))).toEqual([]);
    }
  });

  it("maps the workspace through projects.yaml and writes null for anything else", async () => {
    await mkdir(chronicleDir(), { recursive: true });
    await writeFile(path.join(chronicleDir(), "projects.yaml"), "# mapping\n/work/app: counterweight\n/other: x\n");
    await writeChronicleEvent(input);
    await writeChronicleEvent({ ...input, workspace: "/work/unmapped" });
    const projects = (await readAll("events")).map((e) => [e.value.workspace, e.value.project]);
    expect(projects.sort()).toEqual([["/work/app", "counterweight"], ["/work/unmapped", null]]);
  });

  it("truncates long evidence and swallows write failures", async () => {
    await mkdir(chronicleDir(), { recursive: true });
    await writeChronicleEvent({ ...input, evidence: { text: "x".repeat(5_000) } });
    expect((await readAll("evidence"))[0]!.value.text).toHaveLength(2_000);
    await rm(chronicleDir(), { recursive: true });
    await mkdir(path.join(home, ".agents"), { recursive: true });
    await writeFile(chronicleDir(), "a file, not a directory");
    await expect(writeChronicleEvent(input)).resolves.toBeUndefined();
  });
});

describe("parseProjects", () => {
  it("reads simple path: id lines, quotes and comments, and skips the rest", () => {
    const parsed = parseProjects([
      "# comment",
      "/a/b: alpha",
      '"/with space/c": "beta"  # trailing',
      "'/d': gamma",
      "/e: null",
      "relative/path: nope",
      "projects:",
      "  - /list/item: nope",
      "/f:",
      "",
    ].join("\n"));
    expect([...parsed.entries()].sort()).toEqual([
      ["/a/b", "alpha"], ["/d", "gamma"], ["/e", null], ["/with space/c", "beta"],
    ]);
  });
});
