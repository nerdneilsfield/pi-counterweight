# pi-counterweight

Counterweight 的 Pi 扩展工程。当前实现 M0 与 M1：版本命令、网关缓存探针、`project.toml` / `contract.toml` 校验、任务目录与 Git 树快照。尚无验证器运行或验收门禁。

需要 Node.js `>=22.19.0`。Pi 固定为 `0.99.1`。

```sh
npm ci
npm run typecheck
npm test
npm run build
./node_modules/.bin/pi --extension ./src/adapters/pi/index.ts
```

在 Pi 中执行 `/cw-version`，预期通知为 `Counterweight: pi 0.99.1`。`npm test` 使用真实 Pi RPC 验证该命令，不需要模型凭据；缓存探针测试只访问本机伪网关。

探针要求显式设置 `CW_GATEWAY_URL`（完整 Chat Completions 地址）、`CW_GATEWAY_API_KEY`、`CW_GATEWAY_MODEL`，然后运行 `npm run probe-cache`。两次长请求会产生费用；只有首个请求的 prompt token 超过 2000 且第二个请求报告缓存读取时，结果才为 `supported`，否则为 `unconfirmed`。`unconfirmed` 不代表网关不支持缓存。
