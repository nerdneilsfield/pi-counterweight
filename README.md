# pi-counterweight

Counterweight 的 Pi 扩展工程。当前实现 M0–M5：版本命令、网关缓存探针、`project.toml` / `contract.toml` 校验、任务目录与 Git 树快照、验证器运行与验收证据判定、冻结文件保护、门禁决策与交还材料，以及 Pi 事件适配层（门禁接线、工具注册、计量）。

需要 Node.js `>=22.19.0`。Pi 固定为 `0.99.1`。

```sh
npm ci
npm run typecheck
npm test
npm run build
./node_modules/.bin/pi --extension ./src/adapters/pi/index.ts
```

在 Pi 中执行 `/cw-version`，预期通知为 `Counterweight: pi 0.99.1`。`npm test` 使用真实 Pi RPC 验证该命令，不需要模型凭据；缓存探针测试只访问本机伪网关。

扩展加载后，对状态为 `approved`/`running` 且登记了当前会话 ID 的任务（`.cw/tasks/<id>/state.json`）生效：

- 对内置 `edit` / `write` 修改受保护路径（契约冻结与接口文件、`.cw/project.toml`、任务账本）直接 block，提示改用 `propose_contract_change`；
- 每次 `tool_result` 后重查冻结文件，有新冲突时在该工具结果末尾追加一行事实说明，不发送额外消息，不还原文件；
- `agent_before_settle` 运行门禁：批准的验证器、验收证据三态判定、预算与修复次数，通过即结束、失败按剩余次数续跑、受阻或环境问题交还（材料在 `.cw/tasks/<id>/handback.md`）；
- `report_blocked` 与 `propose_contract_change` 两个顺序执行的工具供模型上报受阻与提议契约变更；
- 每条 assistant 消息的 usage 追加到 `.cw/tasks/<id>/meter.jsonl` 并累计 `state.tokens_used`。

任务的批准与恢复登记命令（`/cw task …`）属于后续里程碑，尚未提供。

探针要求显式设置 `CW_GATEWAY_URL`（完整 Chat Completions 地址）、`CW_GATEWAY_API_KEY`、`CW_GATEWAY_MODEL`，然后运行 `npm run probe-cache`。两次长请求会产生费用；只有首个请求的 prompt token 超过 2000 且第二个请求报告缓存读取时，结果才为 `supported`，否则为 `unconfirmed`。`unconfirmed` 不代表网关不支持缓存。
