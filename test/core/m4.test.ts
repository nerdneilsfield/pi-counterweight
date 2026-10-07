/**
 * M4 门禁决策与交还材料验收测试：`decide` 的固定优先级（cancel > blocked > budget > freeze_conflict >
 * 非 code finish > validate > pass/undetermined/fail）、continue 消息的脱敏与截断、失败指纹的稳定性，
 * 以及 handback.md/json 的内容与「末次有效 run」选取规则；用例都在临时目录中自建任务与运行记录。
 *
 * M4 gate decisions and handback material: the fixed priority order inside
 * `decide` (cancel > blocked > budget > freeze_conflict > non-code finish >
 * validate > pass/undetermined/fail), censoring and truncation of the continue
 * message, fingerprint stability, and the contents plus last-valid-run selection
 * of `handback.md`/`handback.json`. Each case builds its own task and run
 * records under the OS temp directory.
 */
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

/**
 * TaskState fixture：默认是运行中的 code 任务，0 次修复、未验证、无冲突。
 *
 * TaskState fixture: a running task with no repairs used, no verified evidence and
 * no recorded conflicts.
 */
function stateOf(overrides: Partial<TaskState> = {}): TaskState {
  return {
    task_id: taskId, status: "running", model: "gateway/medium", base_commit: null,
    repairs_used: 0, tokens_used: 0, wall_started_at: null,
    last_verified: null, evidence_invalid_reason: null, conflicts: [], sessions: [], version: 1,
    ...overrides,
  };
}

/**
 * GateInput fixture：所有事实都取否定值且不带 verdict，用例只覆写自己要考察的那一项。
 *
 * GateInput fixture with every fact negative and no verdict, so each case
 * overrides exactly the one fact it exercises.
 */
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

/**
 * 共享 fixture：一个冻结冲突、一个 fail 结论、一条失败项；均为纯数据，可在用例间自由复用。
 *
 * Shared fixtures — one freeze conflict, one failing verdict and one failed
 * check; plain data, safe to reuse across cases.
 */
const conflict = {
  path: "tests/a.py", expected: "e".repeat(64), actual: "a".repeat(64), found_at: "2026-10-01T00:00:00Z",
};
const failVerdict: Verdict = { conclusion: "fail", reasons: ["fail tests/a.py::t1"] };
const failure: GateFailure = { id: "tests/a.py::t1", message: "AssertionError: expected 42" };

// 顺序契约首条：把所有其它触发条件同时置真，cancel 仍然独占胜出。
// Priority #1: every other trigger is set at once and cancel still wins alone.
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

// 空字符串不算报告：只有非空 blockedReport 才导致交还，否则继续按后面的分支判定。
// An empty string is not a report: only a non-empty `blockedReport` hands back.
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

// 非 code 交付物跳过验证分支：即使带 fail 结论也 finish，并标记未经自动验证；blocked 等更早分支仍然优先。
// Non-code deliverables skip validation: they finish unverified even with a
// failing verdict, while the earlier branches (blocked and above) still win.
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

// undetermined 是环境或验证器问题：交还但不重试，因此决策不携带 repairs_used 供调用方落盘。
// `undetermined` marks an environment or validator problem: hand back without
// retrying, so the decision carries no `repairs_used` for the caller to persist.
test("undetermined：交还不重试，且不消耗修复次数", () => {
  const decision = decide(inputOf({
    state: stateOf({ repairs_used: 1 }),
    verdict: { conclusion: "undetermined", reasons: ["timed out"] },
  }));
  expect(decision).toEqual({ kind: "handback", reason: "undetermined" });
  expect(decision).not.toHaveProperty("repairs_used");
});

// continue 消息格式固定——编号是「即将进行的第 used+1 次」，只含事实，禁词表断言保证不出现建议类措辞。
// The continue message is fixed-format — attempt counter `used + 1`, facts only,
// which the forbidden-word loop pins down.
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

// 用尽判定只比较 state.repairs_used 与 budget.repairs；预算为 0（无可修次数）时同样直接交还。
// Exhaustion compares `state.repairs_used` against `budget.repairs`; a zero budget also hands back.
test("fail 且次数用尽：handback repairs_exhausted", () => {
  expect(decide(inputOf({ state: stateOf({ repairs_used: 3 }), verdict: failVerdict })))
    .toEqual({ kind: "handback", reason: "repairs_exhausted" });
  expect(decide(inputOf({
    state: stateOf({ repairs_used: 3 }),
    budget: { tokensExceeded: false, wallExceeded: false, repairs: 0 },
    verdict: failVerdict,
  }))).toEqual({ kind: "handback", reason: "repairs_exhausted" });
});

// 消息体量上限：最多 10 条失败项、每条截到 300 字符；没有 failures 时退回 verdict.reasons 当 id（消息为空）。
// Message limits: at most 10 failure items, each truncated to 300 chars; without
// `failures` the verdict's reasons are used as ids with an empty message.
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

// 脱敏是纯字符串替换，作用于 id、message 与日志路径，且先脱敏后截断——300 字符后的禁词也漏不出来。
// Censoring is a pure replace over id, message and log path, and it runs before truncation, so a
// forbidden word past the 300-char cut still cannot leak.
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

// 指纹只用于标注交还材料，不参与门禁决策；口径是 sha256(id + status + 去掉易变片段的消息)。
// Fingerprints annotate handback material only and never feed the gate: sha256
// over id, status and the message with volatile spans stripped.
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

/**
 * 最小契约 fixture：只填 handback 要读的 acceptance / regression。
 *
 * Minimal contract fixture: only `acceptance` and `regression`, the fields
 * handback reads.
 */
function contractOf(acceptance: string[], regression: string[]): Contract {
  return {
    version: 1, task_id: taskId, tier: "change", deliverable: "code", goal: "g",
    non_goals: [], acceptance, red: acceptance.slice(0, 1), regression,
    frozen: [], interface: [], baseline_inputs: [], approved_failures: [],
  };
}

/**
 * 最小 run.json fixture：默认有效（未取消、结果未丢弃，run 号自洽）；result.json 由 putRun 另写。
 *
 * Minimal run-record fixture, valid by default (not cancelled, result not
 * discarded); `result.json` is written separately by `putRun`.
 */
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

/**
 * 只建任务台账的临时目录（不建 git）：handback 只读 runs/notes/state，本组用例不需要仓库。
 *
 * Temp dir holding just the task ledger and no git repository — handback reads
 * runs, notes and state, so a repo is not needed here.
 */
async function taskRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cw-m4-"));
  await createTask(root, taskId, "gateway/medium");
  return root;
}

/**
 * 写入 runs/<n>/ 的 result.json 与 run.json；`recordOverrides` 用来构造取消、结果丢弃等无效 run。
 *
 * Writes a run's `result.json` and `run.json`; `recordOverrides` builds the
 * invalid variants (cancelled, discarded result) that must be ignored.
 */
async function putRun(root: string, run: number, checks: unknown[], recordOverrides = {}): Promise<void> {
  const dir = path.join(root, ".cw", "tasks", taskId, "runs", String(run));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "result.json"), JSON.stringify({
    protocol: 1, run_id: String(run), complete: false, checks,
    build: { required: false }, summary: "s", logs: [],
  }));
  await writeRunRecord(path.join(dir, "run.json"), runRecord(run, recordOverrides));
}

/**
 * 模型笔记 fixture：三个标题段落；handback 原样透传全文，只按标题抽取「建议的下一轮」段落。
 *
 * Model-notes fixture with three headed sections: handback passes the whole text
 * through verbatim and only extracts the "建议的下一轮" section by its heading.
 */
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

// 落盘契约：md/json 同属一次调用，返回值给出仓内相对路径，json 内容即返回的 material（已过 schema 校验）。
// Two-file contract: `handback.md` and `handback.json` belong to one call; the
// returned repo-relative paths point at files whose JSON equals the returned
// material and passes the schema check.
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

// 覆盖判定以「末次有效 run」为准：回归 id 都在其 checks 里就不写未运行；无 notes 时下一轮留空，冻结冲突转成待决问题。
// Coverage is judged against the last valid run; with no notes `next_round` stays empty and freeze
// conflicts become questions for the user.
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

// 有效性逐 run 判定：损坏 json、run_id 不符、协议号不符都让整个 run 失效，复现命令与指纹历史则回退到更早的有效 run。
// Validity is per run: broken JSON, a mismatched `run_id` or a wrong protocol
// version invalidate that run entirely, and reproduction plus fingerprint history
// fall back to an earlier valid run.
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

// 无有效 run 时用 <run> 占位符并明确标出未运行回归；last_verified_record 仍来自 state，与运行有效性无关。
// With no valid run the environment carries `<run>` placeholders and the
// regression is reported as not run; `last_verified_record` still comes from
// state and ignores run validity.
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

// 段落抽取按标题层级结束：遇同级或更高级标题即停，未知标题返回空串（不抛错），首尾空行被裁掉。
// Section extraction stops at the next heading of the same or higher level and
// returns "" for an unknown title instead of throwing; surrounding blank lines
// are trimmed.
test("notes 段落抽取：标题层级与截断", () => {
  expect(notesSection(NOTES, "建议的下一轮")).toBe("- 先修对象生命周期的注入顺序\n- 再补回归");
  expect(notesSection(NOTES, "不存在的标题")).toBe("");
  expect(notesSection("没有标题的笔记", "建议的下一轮")).toBe("");
});
