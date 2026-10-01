import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { Verdict } from "../../src/core/evidence.ts";
import { writeRunRecord } from "../../src/core/runrecord.ts";
import { decide, censorForbidden, CONTINUE_FORBIDDEN, type GateFailure, type GateInput } from "../../src/core/gate.ts";
import { failureFingerprint, notesSection, writeHandback } from "../../src/core/handback.ts";
import { createTask, updateState } from "../../src/core/task.ts";
import type { Contract, TaskState } from "../../src/core/types.ts";

const taskId = "20260928-lifetime-fix";

function stateOf(overrides: Partial<TaskState> = {}): TaskState {
  return {
    task_id: taskId, status: "running", model: "gateway/medium", base_commit: null,
    repairs_used: 0, tokens_used: 0, wall_started_at: null,
    last_verified: null, evidence_invalid_reason: null, conflicts: [], sessions: [], version: 1,
    ...overrides,
  };
}

function inputOf(overrides: Partial<GateInput> = {}): GateInput {
  return {
    state: stateOf(),
    deliverable: "code",
    cancelled: false,
    blockedReport: null,
    budget: { tokensExceeded: false, wallExceeded: false, repairs: 3 },
    freezeConflicts: [],
    logPath: `.cw/tasks/${taskId}/runs/1/stdout.log`,
    ...overrides,
  };
}

const conflict = {
  path: "tests/a.py", expected: "e".repeat(64), actual: "a".repeat(64), found_at: "2026-10-01T00:00:00Z",
};
const failVerdict: Verdict = { conclusion: "fail", reasons: ["fail tests/a.py::t1"] };
const failure: GateFailure = { id: "tests/a.py::t1", message: "AssertionError: expected 42" };

test("cancelled 优先于一切：即使已 blocked、超预算、有冲突、有 fail 结论", () => {
  const decision = decide(inputOf({
    cancelled: true,
    blockedReport: "需要用户选择",
    budget: { tokensExceeded: true, wallExceeded: true, repairs: 3 },
    freezeConflicts: [conflict],
    verdict: failVerdict,
  }));
  expect(decision).toEqual({ kind: "cancel" });
});

test("已调用 report_blocked：直接交还，不返回 validate", () => {
  const decision = decide(inputOf({ blockedReport: "契约第2条与现有接口冲突" }));
  expect(decision).toEqual({ kind: "handback", reason: "blocked" });
  expect(decide(inputOf({ blockedReport: "" })).kind).not.toBe("handback");
});

test("预算超限：交还，不返回 validate，且优先于 pass 结论", () => {
  expect(decide(inputOf({ budget: { tokensExceeded: true, wallExceeded: false, repairs: 3 } })))
    .toEqual({ kind: "handback", reason: "budget" });
  expect(decide(inputOf({
    budget: { tokensExceeded: false, wallExceeded: true, repairs: 3 },
    verdict: { conclusion: "pass", reasons: [] },
  }))).toEqual({ kind: "handback", reason: "budget" });
});

test("冻结冲突：交还，优先于需要验证；预算又优先于冲突", () => {
  expect(decide(inputOf({ freezeConflicts: [conflict] })))
    .toEqual({ kind: "handback", reason: "freeze_conflict" });
  expect(decide(inputOf({
    freezeConflicts: [conflict],
    budget: { tokensExceeded: true, wallExceeded: false, repairs: 3 },
  }))).toEqual({ kind: "handback", reason: "budget" });
});

test("code 任务未带结论：validate；非 code 任务：finish 且标未经自动验证", () => {
  expect(decide(inputOf({}))).toEqual({ kind: "validate" });
  expect(decide(inputOf({ deliverable: "diagnosis" })))
    .toEqual({ kind: "finish", autoVerified: false });
  expect(decide(inputOf({ deliverable: "repro", verdict: failVerdict })))
    .toEqual({ kind: "finish", autoVerified: false });
  expect(decide(inputOf({ deliverable: "diagnosis", blockedReport: "受阻" })))
    .toEqual({ kind: "handback", reason: "blocked" });
});

test("verdict=pass：finish 且自动验证通过", () => {
  expect(decide(inputOf({ verdict: { conclusion: "pass", reasons: [] } })))
    .toEqual({ kind: "finish", autoVerified: true });
});

test("undetermined：交还不重试，且不消耗修复次数", () => {
  const decision = decide(inputOf({
    state: stateOf({ repairs_used: 1 }),
    verdict: { conclusion: "undetermined", reasons: ["timed out"] },
  }));
  expect(decision).toEqual({ kind: "handback", reason: "undetermined" });
  expect(decision).not.toHaveProperty("repairs_used");
});

test("fail 且次数未满：continue，次数加一，消息只含事实", () => {
  const decision = decide(inputOf({
    state: stateOf({ repairs_used: 1 }),
    verdict: failVerdict,
    failures: [failure],
  }));
  expect(decision).toEqual({
    kind: "continue",
    message: [
      "[counterweight] 验收未通过（第 2/3 次自动修复）",
      "失败项：",
      "- tests/a.py::t1: AssertionError: expected 42",
      `完整日志：.cw/tasks/${taskId}/runs/1/stdout.log`,
    ].join("\n"),
    repairs_used: 2,
  });
  for (const word of ["建议", "应该", "尝试", "下一步"]) {
    expect(decision.message).not.toContain(word);
  }
});

test("fail 且次数用尽：handback repairs_exhausted", () => {
  expect(decide(inputOf({ state: stateOf({ repairs_used: 3 }), verdict: failVerdict })))
    .toEqual({ kind: "handback", reason: "repairs_exhausted" });
  expect(decide(inputOf({
    state: stateOf({ repairs_used: 3 }),
    budget: { tokensExceeded: false, wallExceeded: false, repairs: 0 },
    verdict: failVerdict,
  }))).toEqual({ kind: "handback", reason: "repairs_exhausted" });
});

test("失败项最多 10 个，message 截断到 300 字符，无失败时退回结论原因", () => {  const long = "x".repeat(350);
  const many: GateFailure[] = Array.from({ length: 12 }, (_, index) => ({
    id: `tests/a.py::t${index}`, message: long,
  }));
  const message = (decide(inputOf({ verdict: failVerdict, failures: many })) as { message: string })
    .message;
  const items = message.split("\n").filter((line) => line.startsWith("- "));
  expect(items).toHaveLength(10);
  expect(items[0]).toBe(`- tests/a.py::t0: ${"x".repeat(300)}`);

  const fallback = decide(inputOf({
    verdict: { conclusion: "fail", reasons: ["missing tests/a.py::t1", "skip tests/a.py::t2"] },
  })) as { message: string };
  expect(fallback.message).toContain("- missing tests/a.py::t1: ");
  expect(fallback.message).toContain("- skip tests/a.py::t2: ");
});

test("continue 消息对验证器动态文本脱敏：禁词被确定性替换，不回灌建议", () => {
  const decision = decide(inputOf({
    verdict: failVerdict,
    failures: [
      { id: "tests/尝试夹具::t1", message: "断言失败：应该重试，建议先加缓存，下一步改注入" },
    ],
    logPath: `.cw/tasks/${taskId}/runs/1/下一步.log`,
  })) as { message: string };
  for (const word of CONTINUE_FORBIDDEN) expect(decision.message).not.toContain(word);
  expect(decision.message).toContain("- tests/□夹具::t1: 断言失败：□重试，□先加缓存，□改注入");
  expect(decision.message).toContain(`完整日志：.cw/tasks/${taskId}/runs/1/□.log`);

  // 结论原因路径（缺失 ID 等 harness 文本）同样脱敏。
  const fallback = decide(inputOf({
    verdict: { conclusion: "fail", reasons: ["建议人工检查 missing-x"] },
  })) as { message: string };
  expect(fallback.message).not.toContain("建议");
  expect(fallback.message).toContain("□人工检查 missing-x");

  // 先脱敏后截断：300 字符后的禁词也不会漏进消息。
  const boundary = decide(inputOf({
    verdict: failVerdict,
    failures: [{ id: "t", message: "x".repeat(300) + "建议" }],
  })) as { message: string };
  expect(boundary.message).not.toContain("建议");
  expect(boundary.message).toContain(`- t: ${"x".repeat(300)}`);
});

test("失败指纹：路径 span 到分隔边界整体去除，hex 只删独立 token，id/status 区分", () => {
  const fp = (message: string) => failureFingerprint("t1", "fail", message);

  // 仅路径/数字差异 → 同指纹：末段普通词随 span 去除，不残留。
  expect(fp("missing /tmp/cw data/out put、/var/other dir/log x 4"))
    .toBe(fp("missing /tmp/zz data/out put、/var/other dir/log x 9"));
  // 引号包裹的路径含空格同样整体去除。
  expect(fp("cannot read '/tmp/my dir/out 1.txt' code 2"))
    .toBe(fp("cannot read '/var/other dir/in 2.txt' code 3"));
  expect(fp("expected 42 at /tmp/cw/report.txt line 12 hash 0xdeadbeef98"))
    .toBe(fp("expected 99 at /tmp/cw/other.txt line 99 hash 0xcafebabe77"));
  expect(fp("missing /tmp/cw data/out put")).not.toBe(fp("missing file"));

  // hex 只删独立 token：0x 前缀任意长度、独立 ≥6 位；普通词保留，边界生效。
  expect(fp("deadbeef x")).toBe(fp("cafebabe x"));
  expect(fp("hash 0xab")).toBe(fp("hash 0xcd"));
  expect(fp("failure 0x12")).toBe(fp("failure 0xcd"));
  expect(fp("failure")).not.toBe(fp("failuredeadbeef"));
  expect(fp("hash ab")).not.toBe(fp("hash cd"));
  expect(fp("hash cafe")).not.toBe(fp("hash deadbeef"));

  // 数字与路径仍去除；id 与 status 仍参与哈希。
  expect(fp("42 at /tmp/a")).toBe(fp("99 at /var/b"));
  expect(fp("same")).not.toBe(failureFingerprint("t2", "fail", "same"));
  expect(fp("same")).not.toBe(failureFingerprint("t1", "skip", "same"));
});

function contractOf(acceptance: string[], regression: string[]): Contract {
  return {
    version: 1, task_id: taskId, tier: "change", deliverable: "code", goal: "g",
    non_goals: [], acceptance, red: acceptance.slice(0, 1), regression,
    frozen: [], interface: [], baseline_inputs: [], approved_failures: [],
  };
}

function runRecord(run: number, overrides: Record<string, unknown> = {}) {
  const tree = "t".repeat(64);
  return {
    version: 1 as const, run,
    started_at: "2026-10-01T00:00:00Z", ended_at: "2026-10-01T00:01:00Z",
    exit_code: 1, term_signal: null, timed_out: false, cancelled: false,
    result_discarded: false, runner_error: null, record_error: null,
    git: true, tree_before: tree, tree_after: tree,
    input_hashes_before: {}, input_hashes_after: {}, artifact_hashes: {},
    ...overrides,
  };
}

async function taskRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cw-m4-"));
  await createTask(root, taskId, "gateway/medium");
  return root;
}

async function putRun(root: string, run: number, checks: unknown[], recordOverrides = {}): Promise<void> {
  const dir = path.join(root, ".cw", "tasks", taskId, "runs", String(run));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "result.json"), JSON.stringify({
    protocol: 1, run_id: String(run), complete: false, checks,
    build: { required: false }, summary: "s", logs: [],
  }));
  await writeRunRecord(path.join(dir, "run.json"), runRecord(run, recordOverrides));
}

const NOTES = [
  "## 已排除的方向",
  "- 怀疑缓存层，profile 显示热点在绑定层",
  "",
  "## 建议的下一轮",
  "- 先修对象生命周期的注入顺序",
  "- 再补回归",
  "",
  "## 其它",
  "- 备忘",
].join("\n");

test("handback 生成 md/json：状态原因、验证记录、模型笔记、问题、复现命令、未运行检查、指纹历史、下一轮建议", async () => {
  const root = await taskRepo();
  await writeFile(path.join(root, ".cw", "tasks", taskId, "notes.md"), NOTES);
  await putRun(root, 1, [
    { id: "tests/a.py::t1", status: "fail", message: "AssertionError: expected 42 at /tmp/cw/r.txt" },
  ]);
  // 取消的迟到结果：不进指纹历史、不算已运行的回归、不作复现依据。
  await putRun(root, 2, [{ id: "tests/a.py::reg1", status: "pass" }], { cancelled: true });
  await updateState(root, taskId, "s", (state) => ({
    ...state,
    status: "running",
    last_verified: { run: 1, tree: "t".repeat(64), contract_sha256: "c".repeat(64) },
  }));

  const contract = contractOf(["tests/a.py::t1"], ["tests/a.py::reg1"]);
  const { md, json, material } = await writeHandback(root, taskId, "s", {
    contract,
    validator: { cmd: ["./.cw/validate.sh", "--all"], timeout_s: 600, env: { CI: "1" } },
    reason: "repairs_exhausted",
    questions: ["契约第2条：选 A 还是 B？"],
    autoVerified: true,
  });

  expect(md).toBe(`.cw/tasks/${taskId}/handback.md`);
  expect(json).toBe(`.cw/tasks/${taskId}/handback.json`);
  const markdown = await readFile(path.join(root, md), "utf8");
  const parsed = JSON.parse(await readFile(path.join(root, json), "utf8"));
  expect(parsed).toEqual(material);

  expect(material.status).toBe("running");
  expect(material.reason).toBe("repairs_exhausted");
  expect(material.auto_verified).toBe(true);
  expect(material.last_verified).toEqual({
    run: 1, tree: "t".repeat(64), contract_sha256: "c".repeat(64),
  });
  expect(material.last_verified_record).toBe(`.cw/tasks/${taskId}/runs/1/run.json`);
  expect(material.notes).toBe(NOTES);
  expect(material.questions).toEqual(["契约第2条：选 A 还是 B？"]);
  expect(material.not_run_checks).toEqual(["全量回归未运行"]);
  // run 2 已取消：复现命令与覆盖判断都回退到末次有效 run 1。
  expect(material.reproduce.env.CW_RUN_ID).toBe("1");
  expect(material.reproduce.env.CW_RESULT_DIR).toMatch(/\/runs\/1$/);
  expect(material.next_round).toBe("- 先修对象生命周期的注入顺序\n- 再补回归");
  expect(material.fingerprint_history).toEqual([
    {
      run: 1, id: "tests/a.py::t1", status: "fail",
      fingerprint: failureFingerprint("tests/a.py::t1", "fail", "AssertionError: expected 42 at /tmp/cw/r.txt"),
    },
  ]);

  expect(markdown).toContain("## 状态与原因");
  expect(markdown).toContain("- 原因：自动修复次数已用尽");
  expect(markdown).toContain("## 尝试过的方向（模型笔记，未经验证）");
  expect(markdown).toContain("怀疑缓存层");
  expect(markdown).toContain("- 契约第2条：选 A 还是 B？");
  expect(markdown).toContain('CI="1"');
  expect(markdown).toContain(`CW_TASK_ID="${taskId}"`);
  expect(markdown).toContain('"./.cw/validate.sh" "--all"');
  expect(markdown).toContain('CW_RUN_ID="1"');
  expect(markdown).toContain("- 全量回归未运行");
  expect(markdown).toContain(material.fingerprint_history[0]!.fingerprint);
  expect(markdown).toContain("- 先修对象生命周期的注入顺序");

  await rm(root, { recursive: true, force: true });
});

test("handback：回归已运行则不写全量回归未运行；无 notes 时下一轮留空；冻结冲突进入问题", async () => {
  const root = await taskRepo();
  await putRun(root, 1, [
    { id: "tests/a.py::t1", status: "fail", message: "boom" },
    { id: "tests/a.py::reg1", status: "pass" },
  ]);
  await updateState(root, taskId, "s", (state) => ({
    ...state,
    conflicts: [conflict],
  }));

  const { material } = await writeHandback(root, taskId, "s", {
    contract: contractOf(["tests/a.py::t1"], ["tests/a.py::reg1"]),
    validator: { cmd: ["./.cw/validate.sh"], timeout_s: 600, env: {} },
    reason: "freeze_conflict",
    questions: [],
    autoVerified: false,
  });

  expect(material.not_run_checks).toEqual([]);
  expect(material.notes).toBeNull();
  expect(material.next_round).toBe("");
  expect(material.questions).toEqual([
    `冻结文件冲突：${conflict.path} 期望 ${conflict.expected} 实际 ${conflict.actual}`,
  ]);
  expect(material.fingerprint_history).toHaveLength(1);

  const markdown = await readFile(path.join(root, ".cw", "tasks", taskId, "handback.md"), "utf8");
  expect(markdown).toContain("- 验证：未经自动验证");
  expect(markdown).toContain("- 原因：冻结文件冲突");

  await rm(root, { recursive: true, force: true });
});

test("handback：最高 run 无效时回退到末次有效 run，run_id 不符与协议不符同样无效", async () => {
  const root = await taskRepo();
  await putRun(root, 1, [
    { id: "tests/a.py::t1", status: "fail", message: "boom" },
    { id: "tests/a.py::reg1", status: "pass" },
  ]);
  const dir = path.join(root, ".cw", "tasks", taskId, "runs");
  // run 2：result.json 损坏。
  await mkdir(path.join(dir, "2"), { recursive: true });
  await writeRunRecord(path.join(dir, "2", "run.json"), runRecord(2));
  await writeFile(path.join(dir, "2", "result.json"), "{not json");
  // run 3：形状合法但 run_id 不匹配。
  await putRun(root, 3, [{ id: "tests/a.py::t1", status: "pass" }]);
  await writeFile(path.join(dir, "3", "result.json"), JSON.stringify({
    protocol: 1, run_id: "9", checks: [{ id: "tests/a.py::t1", status: "pass" }],
    build: { required: false }, summary: "s", logs: [],
  }));
  // run 4：协议号不对。
  await putRun(root, 4, []);
  await writeFile(path.join(dir, "4", "result.json"), JSON.stringify({
    protocol: 2, run_id: "4", checks: [], build: { required: false }, summary: "s", logs: [],
  }));

  const { material } = await writeHandback(root, taskId, "s", {
    contract: contractOf(["tests/a.py::t1"], ["tests/a.py::reg1"]),
    validator: { cmd: ["./.cw/validate.sh"], timeout_s: 600, env: {} },
    reason: "undetermined",
    questions: [],
    autoVerified: false,
  });

  expect(material.reproduce.env.CW_RUN_ID).toBe("1");
  expect(material.reproduce.env.CW_RESULT_DIR).toMatch(/\/runs\/1$/);
  expect(material.not_run_checks).toEqual([]);
  expect(material.fingerprint_history.map((entry) => entry.run)).toEqual([1]);

  await rm(root, { recursive: true, force: true });
});

test("handback：没有任何有效运行时明确未运行并使用占位符", async () => {
  const root = await taskRepo();
  const dir = path.join(root, ".cw", "tasks", taskId, "runs", "1");
  await mkdir(dir, { recursive: true });
  await writeRunRecord(path.join(dir, "run.json"), runRecord(1, { cancelled: true }));
  await writeFile(path.join(dir, "result.json"), JSON.stringify({ checks: [] }));
  await updateState(root, taskId, "s", (state) => ({
    ...state,
    last_verified: { run: 1, tree: "t".repeat(64), contract_sha256: "c".repeat(64) },
  }));

  const { material } = await writeHandback(root, taskId, "s", {
    contract: contractOf(["tests/a.py::t1"], ["tests/a.py::reg1"]),
    validator: { cmd: ["./.cw/validate.sh"], timeout_s: 600, env: {} },
    reason: "budget",
    questions: [],
    autoVerified: false,
  });

  expect(material.reproduce.env.CW_RUN_ID).toBe("<run>");
  expect(material.reproduce.env.CW_RESULT_DIR).toContain("<run>");
  expect(material.not_run_checks).toEqual(["全量回归未运行"]);
  expect(material.fingerprint_history).toEqual([]);
  // 记录路径是 state 事实，不受运行有效性影响。
  expect(material.last_verified_record).toBe(`.cw/tasks/${taskId}/runs/1/run.json`);

  await rm(root, { recursive: true, force: true });
});

test("notes 段落抽取：标题层级与截断", () => {
  expect(notesSection(NOTES, "建议的下一轮")).toBe("- 先修对象生命周期的注入顺序\n- 再补回归");
  expect(notesSection(NOTES, "不存在的标题")).toBe("");
  expect(notesSection("没有标题的笔记", "建议的下一轮")).toBe("");
});
