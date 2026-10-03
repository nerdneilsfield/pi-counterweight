#!/bin/sh
# Counterweight 示例验证器（vitest）。
#
# 用法：复制到被管理项目（如 .cw/validate.sh），在 .cw/project.toml 里引用：
#   [validator]
#   cmd = ["/bin/sh", ".cw/validate.sh"]
#
# 契约 ID 约定：<测试文件相对路径>::<vitest 全名>，全名是套件名与用例名以
# 空格连接（vitest JSON 报告的 fullName），例如
#   acceptance = ["tests/math.test.ts::math add works"]
# 同名用例在两个文件中出现时，文件路径前缀保证 ID 唯一。
#
# 协议：向 $CW_RESULT_DIR/result.json 写出 protocol 1 结果；checks 覆盖
# CW_REQUIRED_IDS 中全部 ID。验证总结束时必须退出 0（验证器退出码非 0 表示
# 崩溃，harness 会把结果降级为 undetermined），失败与否由 checks 状态表达。
set -eu

: "${CW_RESULT_DIR:?CW_RESULT_DIR 未设置}"
: "${CW_RUN_ID:?CW_RUN_ID 未设置}"
: "${CW_REQUIRED_IDS:?CW_REQUIRED_IDS 未设置}"

# vitest 退出码非 0 只说明有用例失败，不是验证器崩溃；报告交给下方解析。
npx vitest run --reporter=json --outputFile="$CW_RESULT_DIR/vitest.json" \
  >"$CW_RESULT_DIR/vitest.stdout.log" 2>&1 || true

CW_RESULT_DIR="$CW_RESULT_DIR" CW_RUN_ID="$CW_RUN_ID" CW_REQUIRED_IDS="$CW_REQUIRED_IDS" node - <<'JS'
const fs = require("node:fs");
const path = require("node:path");

const resultDir = process.env.CW_RESULT_DIR;
const runId = process.env.CW_RUN_ID;
const required = process.env.CW_REQUIRED_IDS.split("\n").filter((line) => line !== "");

const statusMap = { passed: "pass", failed: "fail" };
const checks = [];
for (const file of JSON.parse(fs.readFileSync(path.join(resultDir, "vitest.json"), "utf8")).testResults ?? []) {
  const relative = path.relative(process.cwd(), file.name).split(path.sep).join("/");
  for (const test of file.assertionResults ?? []) {
    checks.push({
      id: `${relative}::${test.fullName}`,
      status: statusMap[test.status] ?? "skip",
      ...(test.failureMessages?.length > 0
        ? { message: String(test.failureMessages[0]).slice(0, 300) }
        : {}),
    });
  }
}

const byId = new Map(checks.map((check) => [check.id, check]));
const resolved = required.map((id) => byId.get(id)
  ?? { id, status: "error", message: "vitest 报告中没有该 ID" });
const failed = resolved.filter((check) => check.status === "fail");
const summary = failed.length > 0
  ? `vitest：${resolved.length} 项中 ${failed.length} 项失败`
  : `vitest：${resolved.length} 项全部通过`;

fs.writeFileSync(path.join(resultDir, "result.json"), JSON.stringify({
  protocol: 1,
  run_id: runId,
  complete: true,
  checks: resolved,
  build: { required: false },
  summary,
  logs: ["vitest.json", "vitest.stdout.log"],
}, null, 2));
JS
