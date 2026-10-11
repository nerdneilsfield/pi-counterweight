# pi-counterweight

🧱 **Counterweight** 是 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的轻量扩展：不挡开始，只在每轮结束时跑一次你配置的检查，并在模型写入你标记的保护路径时直接拦截。

装上之后，pi 收到任务就直接干活。扩展只在你的项目配置了 `.cw/project.toml` 时生效，没有配置就完全被动。

- ✅ **结束检查**：本轮结束时跑一次你配的命令，只看退出码；失败把输出尾部与事实反馈一次，再失败就如实报告结束。
- 🛡️ **受保护路径**：`edit`/`write` 对你写死的路径列表直接拦截；结算时对比内容快照，发现变化如实报告（不拦截、不还原）。
- 🔍 **只读探索者**：`cw_explore` 用便宜模型回答代码库问题，产出不超过 30 行、逐条带 `path:line` 引用。
- 📊 **计量**：每条 assistant 消息的 usage 与 harness 事件追加到 `.cw/meter.jsonl`，供你自己算成本。

> 9 月设计的完整严格流程（契约、先红检查、证据哈希、门禁、升级）已归档在 git tag **`v1-strict`**。它没有消失，只是不再是默认路径；需要时从 tag 取回。

## ⚠️ 先读边界

- **这不是沙箱。** 拦截与报告防的是模型顺手改你不想被改的文件，不是同账户下的恶意绕过。
- **拦截只覆盖 `edit`/`write`。** 模型用 bash（`sed -i` 等）改受保护文件不会被拦截，只会在结算时被如实报告。
- **「检查通过」只等于退出码 0。** 扩展不解析测试身份、不验证产物、不核对模型是否改了测试文件——它只报告事实，不宣布「已验证」。
- **只读 ≠ 隔离。** `cw_explore` 子进程只有 read/grep 两个工具，但工具白名单不构成文件系统安全隔离。

## ⬇️ Requirements

- Node.js `>=22.19.0`
- Git（决定检查是否需要跳过；非 git 仓库每次结算都跑检查）
- pi `1.0.0`（本仓库固定依赖 `@earendil-works/pi-coding-agent@1.0.0`；其他版本未测）

## 📦 Installation

扩展从本仓库的 TypeScript 源码入口加载（`src/adapters/pi/index.ts`）。不要指向 `dist/` 下的构建产物——探索者的提示词资源不随 `tsc` 复制。

**方式 A：克隆加载**

```sh
git clone <本仓库地址> ~/pi-counterweight
cd ~/pi-counterweight
npm ci && npm run typecheck && npm run test:serial
```

```sh
cd /path/to/your-project
pi --extension ~/pi-counterweight/src/adapters/pi/index.ts
```

**方式 B：作为依赖安装**

```sh
cd /path/to/your-project
npm install <本仓库的 git 地址或本地路径>
pi --extension node_modules/pi-counterweight/src/adapters/pi/index.ts
```

**方式 C：作为 pi 包安装（从 GitHub）**

```sh
pi install git:github.com/nerdneilsfield/pi-counterweight
```

包清单（`package.json` 的 `pi` 字段）把扩展指向源码入口，无需构建。安装默认写入个人设置 `~/.pi/agent/settings.json`，此后每个会话自动加载；加 `-l` 写入项目 `.pi/settings.json`（读取前需批准项目信任）。

验证加载：在 pi 里执行 `/cw-version`，预期通知 `Counterweight: pi 1.0.0`。

## ⚙️ 配置（.cw/project.toml）

在你自己的项目里创建 `.cw/project.toml`（`.cw/` 建议加入该项目的 `.gitignore`）。每个小节都是可选的；未知字段会报错，配置非法时扩展保持被动并提示错误。

```toml
version = 1

[check]                     # 结束检查；不写这一节就不检查
cmd = ["npm", "test"]       # argv 数组，直接 spawn，不经过 shell
timeout_s = 600             # 缺省 600；到点杀掉整个进程组
env = {}                    # 额外环境变量（校验时只允许字符串值）

[protect]                   # 受保护路径；不写这一节就只保护 .cw/project.toml 本身
paths = ["tests/", "vitest.config.ts"]

[explorer]                  # cw_explore 的模型；不写这一节该工具不可用
model = "gateway/cheap-model"

[observe]                   # cw observe 记录哪些工具的版本
versions = ["node"]
```

### 结束检查怎么跑

- **只在本轮正常结束、且工作树自上次检查以来有变化时运行**（树哈希判定，纯问答轮不跑）。检查命令自己写出的构建产物不会触发下一次检查——运行结束时会重新记录树哈希。
- **通过**（退出码 0）：在会话里追加一行事实（命令、耗时），本轮结束。
- **不通过**：把退出码与两条输出流的尾部（各最多 80 行 / 16 KiB，超出注明截断）反馈给模型一次并继续一轮；再次失败就如实报告并结束，不再自动重试。每次用户回合给一次反馈额度。
- **超时**：到 `timeout_s` 时对整个进程组先 SIGTERM、5 秒后 SIGKILL；按失败处理。
- **处理本身出错或超时**：如实报告「未能完成，本轮没有得到检查结论」，绝不报告通过。
- 非 git 仓库无法判定「有没有变化」，因此每次结算都会跑检查。

### 受保护路径怎么保护

- `edit`/`write` 的目标命中列表（文件本身或目录前缀）即被拒绝；`.cw/project.toml` 永远受保护，模型不能通过改它关掉检查。
- 指向受保护文件的符号链接别名同样被拒绝；悬空符号链接 fail-closed（写入会沿链接重建无法核对的目标）；仓库外的路径一律拒绝。
- 结算时用会话开始时的内容快照对比：被 bash 等旁路修改的受保护文件会追加一行「受保护文件发生变化：…」，**不拦截、不还原**。
- 受保护路径在加载期校验：拒绝空路径、通配符、绝对路径、`..` 与 `.cw` 下的路径。

### 计量

每条 assistant 消息的 usage、结束检查与探索者运行的记录都追加到 `.cw/meter.jsonl`（只增不减）。示例：

```json
{"kind":"usage","time":"…","session":"…","model":"gateway/medium-model","input":12000,"output":800,"cache_read":9000,"cache_write":0,"cost_total":0.03}
{"kind":"event","time":"…","session":"…","event":"check","detail":{"exit_code":0,"timed_out":false,"spawn_error":null,"ms":12400,"outcome":"passed"}}
```

## 🔍 cw_explore

模型可以调用 `cw_explore({ question })` 向只读探索者子代理提问：

- 子进程 pi 以配置的 `[explorer] model` 运行，只有 `read` / `grep` 两个工具，超时 180 秒；
- 每次实际执行的 read/grep 路径参数都对照工作树审计：出现越树路径（绝对路径、`..` 逃逸、外指符号链接）时，**整个回答不采信**，只返回错误；token 用量无论成败都记入 `.cw/meter.jsonl`；
- 回答 ≤30 行，每条结论须带 `仓库相对路径:行号` 引用：引用无效标〔引用无效〕，缺引用标〔缺少引用〕（`未找到` 除外）；
- 子进程修改了工作树时，回答标注不可信（改动不还原）。

## 📊 cw observe

```sh
npm run build
npm run observe -- [--note <文字>] -- <cmd> [args...]
```

在当前目录运行一条命令并把现场记录到 `./.cw/observations/<UTC时间戳>/`：

- `observation.json`：命令 argv、工作目录、`--note`、退出码、终止信号、超时/取消标记、git 仓库根/提交/树哈希（非 git 记 `supported: false`）、OS 摘要、`[observe] versions` 的 `--version` 探测结果；
- `stdout-tail.txt` / `stderr-tail.txt`：两条流尾部各 200 行（超约 1 MiB 截断并注明）。

命令失败或被 Ctrl+C 不影响记录完整性（`observation.json` 启动前先落盘、结束后更新）。环境变量不入记录。退出码镜像被观测命令（spawn 失败 127，用法错误 2）。

### 网关缓存探针（可选）

```sh
export CW_GATEWAY_URL=<完整 chat/completions 地址>
export CW_GATEWAY_API_KEY=<key>
export CW_GATEWAY_MODEL=<model>
npm run probe-cache
```

两次长请求会产生费用；只有首个请求 prompt token 超过 2000 且第二个请求报告缓存读取时结果才为 `supported`，否则为 `unconfirmed`（证据不足，不代表网关不支持）。

## 🔧 Troubleshooting

| 现象 | 原因与处理 |
| --- | --- |
| 扩展完全没动作 | 没有 `.cw/project.toml`，或配置非法（会话开始时有错误通知）。检查文件与未知字段 |
| 检查没有在某一轮运行 | 该轮工作树与上次检查相同（纯问答轮不跑）；非 git 仓库则每轮都跑 |
| 模型改不了 `tests/xxx` | 受保护路径拦截。需要改就由你手动改，或调整 `[protect].paths` |
| bash 改了受保护文件但没被拦 | 设计如此：拦不住的路径以结算时的事实报告兜底 |
| 检查失败后模型没被反馈 | 每个失败链只反馈一次；再次失败如实报告。新的一轮用户消息会重新给一次额度 |
| `cw_explore` 不可用 | 没配 `[explorer] model`。补上 `provider/model` 形式的模型名 |
| `cw observe` 退出码非 0 | 镜像被观测命令的退出码；127 是 spawn 失败，2 是用法错误 |

## 🚧 Known limitations

- **同账户下不是强安全边界。** 拦截与报告靠进程内检查与文件快照，不能抵抗同账户下的恶意进程或模型伪造。
- **bash 是旁路。** 只拦 `edit`/`write`；其他途径的修改只会在结算时被报告。
- **检查只按退出码判定。** 不解析测试身份、不核对产物哈希、不检查模型是否新增了 skip 或弱化测试；模型自写的测试不能当权威结论。
- **`cw_explore` 的只读是工具白名单。** 不是沙箱。
- **真实网关与真实模型未在本仓库测试中执行。** `npm test` 用真实 pi RPC 加载扩展但不需要模型凭据；探针未在付费真实模型上跑过。
- **严格流程在 tag 里。** `v1-strict` 保留了契约/先红/证据/门禁的完整实现，需要时 `git switch --detach v1-strict` 查看或移植。

## 💬 反馈

问题与建议请开 [issue](../../issues)。

## 📖 License

[MIT](./LICENSE) © DengQi
