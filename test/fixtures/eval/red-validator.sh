#!/bin/sh
# 先红检查用验证器：报告唯一先红项以失败结束，其余项不存在。
set -u
printf '%s\n' "{\"protocol\":1,\"run_id\":\"$CW_RUN_ID\",\"complete\":true,\"checks\":[{\"id\":\"t:red\",\"status\":\"fail\",\"message\":\"baseline red\"}],\"build\":{\"required\":false},\"summary\":\"red\",\"logs\":[]}" > "$CW_RESULT_DIR/result.json"
