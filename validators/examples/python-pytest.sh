#!/bin/sh
# Counterweight 示例验证器（pytest）。
#
# 用法：复制到被管理项目（如 .cw/validate.sh），在 .cw/project.toml 里引用：
#   [validator]
#   cmd = ["/bin/sh", ".cw/validate.sh"]
#
# 契约 ID 约定：直接使用 pytest 的 nodeid，例如
#   acceptance = ["tests/test_binding.py::test_owner_outlives_view"]
#
# 协议：向 $CW_RESULT_DIR/result.json 写出 protocol 1 结果；checks 覆盖
# CW_REQUIRED_IDS 中全部 ID。验证总结束时必须退出 0（验证器退出码非 0 表示
# 崩溃，harness 会把结果降级为 undetermined），失败与否由 checks 状态表达。
set -eu

: "${CW_RESULT_DIR:?CW_RESULT_DIR 未设置}"
: "${CW_RUN_ID:?CW_RUN_ID 未设置}"
: "${CW_REQUIRED_IDS:?CW_REQUIRED_IDS 未设置}"

# pytest 退出码非 0 只说明有用例失败，不是验证器崩溃；输出交给下方解析。
pytest --tb=short -v >"$CW_RESULT_DIR/pytest.log" 2>&1 || true

CW_RESULT_DIR="$CW_RESULT_DIR" CW_RUN_ID="$CW_RUN_ID" CW_REQUIRED_IDS="$CW_REQUIRED_IDS" python3 - <<'PY'
import json, os, re

result_dir = os.environ["CW_RESULT_DIR"]
run_id = os.environ["CW_RUN_ID"]
required = [line for line in os.environ["CW_REQUIRED_IDS"].splitlines() if line != ""]

# pytest -v 的结果行形如：<nodeid> <OUTCOME> [ nn%]；nodeid 本身可含空格（参数化）。
line_re = re.compile(r"^(.*) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:\s+\[\s*\d+%\])?\s*$")
outcome = {"PASSED": "pass", "XPASS": "pass", "FAILED": "fail", "ERROR": "error"}

by_id: dict[str, dict] = {}
with open(os.path.join(result_dir, "pytest.log"), encoding="utf-8", errors="replace") as log:
    for line in log:
        line = line.rstrip("\n")
        match = line_re.match(line)
        if not match:
            continue
        nodeid, status = match.group(1), match.group(2)
        if nodeid in by_id:  # 重跑/重复输出时保留第一条
            continue
        by_id[nodeid] = {"id": nodeid, "status": outcome.get(status, "skip")}

checks = []
for id in required:
    if id in by_id:
        checks.append(by_id[id])
    else:
        # 工具没有报告该 ID：明确记为 error，而不是让 harness 去猜。
        checks.append({"id": id, "status": "error", "message": "pytest 输出中没有该 ID"})

failed = [c["id"] for c in checks if c["status"] == "fail"]
summary = f"pytest：{len(checks)} 项中 {len(failed)} 项失败" if failed else f"pytest：{len(checks)} 项全部通过"

with open(os.path.join(result_dir, "result.json"), "w", encoding="utf-8") as out:
    json.dump({
        "protocol": 1,
        "run_id": run_id,
        "complete": True,
        "checks": checks,
        "build": {"required": False},
        "summary": summary,
        "logs": ["pytest.log"],
    }, out, ensure_ascii=False, indent=2)
PY
