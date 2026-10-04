# pi-counterweight

🧱 **Counterweight** 是 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的门禁扩展：在你的仓库里给模型的编码任务加上契约、验证器验收与预算计量，让"改完了"变成有证据的结论。

- 📋 任务有契约：目标、验收项、先红项、回归项、冻结文件，批准后不再漂移
- ✅ 结束有证据：由你的验证器判定 pass/fail，先红必须真的红过，产物哈希可核对
- 💰 过程有计量：token、验证次数、墙钟时间逐条入账，超预算或受阻即交还
- 🔍 疑问有出口：模型可调用只读探索者 `cw_explore` 与 `report_blocked`、`propose_contract_change`

## ⚠️ 先读边界

用之前请确认你能接受以下事实：

- **这不是沙箱。** 冻结文件与账本靠文件系统权限与进程内检查实现，防的是门禁下模型的越权修改与证据漂移，不能抵抗同账户下的恶意进程或模型直接伪造文件。
- **需要 Git。** `task new` / `task approve`、基线快照、冻结 blob 都要求 git 仓库；非 git 仓库只降级为报告，不宣称有基线证据。
- **code 任务的批准需要交互界面。** 先红确认对话框只在 TUI 或 RPC 模式可用；print/json 单发模式下 `/cw task approve` 对 code 任务直接拒绝。
- **只读 ≠ 隔离。** `cw_explore` 子进程只有 read/grep 两个工具，但工具白名单不构成对文件系统或扩展的安全隔离。
- **真实网关、真实模型与真实评估未在本仓库测试中执行。** `npm test` 用真实 Pi RPC 但不需要模型凭据；网关缓存探针与 `eval/` 脚手架均未在付费真实模型上跑过。

## ⬇️ Requirements

- Node.js `>=22.19.0`
- Git（任务与证据绑定）
- pi `1.0.0`（本仓库固定依赖 `@earendil-works/pi-coding-agent@1.0.0`；其他版本未测）

## 📦 Installation

扩展从本仓库的 TypeScript 源码入口加载（`src/adapters/pi/index.ts`）。不要指向 `dist/` 下的构建产物——探索者的提示词资源不随 `tsc` 复制，从 dist 加载会缺失。本包未发布到 npm。

**方式 A：克隆加载（已验证路径）**

```sh
git clone <本仓库地址> ~/pi-counterweight
cd ~/pi-counterweight
npm ci && npm run typecheck && npm test
```

> 全套测试的稳定入口是 `npm run test:serial`。并行 `npm test` 在个别性能用例上可能因 CPU/IO 竞争偶发失败，重跑即可；测试阈值未放宽。

然后在你自己的项目里启动 pi 时挂载：

```sh
cd /path/to/your-project
pi --extension ~/pi-counterweight/src/adapters/pi/index.ts
```

**方式 B：作为依赖安装到你的项目**

```sh
cd /path/to/your-project
npm install <本仓库的 git 地址或本地路径>
pi --extension node_modules/pi-counterweight/src/adapters/pi/index.ts
```

## 🚀 Quick start

1. 挂载扩展后，在 pi 里执行 `/cw-version`，预期通知：`Counterweight: pi 1.0.0`。
2. 在你的项目准备 `.cw/project.toml` 与一个可运行的验证器（下文两节）。
3. 确认工作树干净（只有 `git add` 不算，忽略 `.cw/` 本身），然后：

```sh
/cw task new fix-binding --tier change
```

按提示编辑生成的 `.cw/tasks/<id>/contract.toml`，再 `/cw task approve`。批准后门禁即接管当前会话。

## ⚙️ 配置被管理项目（.cw/project.toml）

扩展读取你项目 `.cw/` 下的 `project.toml`。`.cw/` 应加入该项目的 `.gitignore`；`project.toml` 本身可提交可不提交。示例：

```toml
version = 1

[validator]
cmd = ["/bin/sh", ".cw/validate.sh"]  # argv 数组，不经过 shell 拼接
timeout_s = 600                        # 缺省 600
env = {}                               # 验证器进程的额外环境变量

[budget]                               # 任务默认预算（契约可覆盖 repairs）
tokens = 2000000
wall_minutes = 90
repairs = 3

[models]                               # provider/model 形式，名称以 pi 的模型注册为准
cheap = "gateway/cheap-model"
medium = "gateway/medium-model"
strong = "gateway/strong-model"
explorer = "gateway/cheap-model"

[tiers]                                # 任务档位到模型的映射
script = "cheap"
change = "medium"
interface = "strong"

[observe]                              # 可选：cw observe 记录哪些 --version
versions = ["node"]
```

未知字段报错；`timeout_s`、`repairs`、`tokens`、`wall_minutes`、`env` 缺省取上表默认值。

## 🏃 跑一个任务（/cw 命令）

```sh
/cw task new <slug> [--tier script|change|interface]  # 工作树必须干净（忽略 .cw/）
# 编辑 .cw/tasks/<id>/contract.toml 后：
/cw task approve        # 校验契约；code 任务先跑先红检查，需交互界面确认失败原因
/cw task status         # 查看状态、预算、最后验证与冻结冲突
/cw task resume <id>    # 把当前会话登记到任务（不重建基线；任务视图会启动首轮）
/cw task cancel         # 取消任务（先终止在途验证）
/cw task handback       # 手动生成交还材料并结束
```

- `task new` 记录 `base_commit`，按 `--tier` 与 `[tiers]`→`[models]` 选定任务模型，并生成契约模板。在 git worktree（非主检出）中不能创建或批准任务。
- `task approve` 对 code 任务从 `base_commit` 建立隔离基线（只覆盖 `baseline_inputs`），先红项必须实际失败且其余验收/回归通过；`undetermined` 一律拒绝。批准后一段 ≤40 行的任务视图追加到会话并立即启动首轮模型回合，会话即刻采用任务模型。批准同时冻结三样东西：验证器命令（此后改 `project.toml` 不影响本任务）、命令引用的仓内脚本哈希（如 `.cw/validate.sh`）、`project.toml` 快照。
- `handed_back` 的任务修订契约后可重新 `task approve`（重跑先红，`base_commit` 不变）。

**门禁接管后**（状态 `approved`/`running` 且登记了当前会话的任务）：

- 内置 `edit`/`write` 修改受保护路径（契约冻结与接口文件、`.cw/project.toml`、任务账本）直接 block，提示改用 `propose_contract_change`；每次 `tool_result` 后重查冻结文件，新冲突在工具结果末尾追加一行事实说明，不还原文件；
- `agent_before_settle` 运行批准的验证器并判定验收证据：通过即结束，失败按剩余修复次数续跑，受阻或环境问题交还（材料在 `.cw/tasks/<id>/handback.md`）。每次结算前核对批准快照：`project.toml` 与批准版本漂移（含文件不可读）即交还，验证器与预算始终按批准语义执行；验证器脚本哈希在每次验证运行前后各核对一次，漂移的运行结果作废（`undetermined`）；
- 工具 `report_blocked` 与 `propose_contract_change` 供模型上报受阻与提议契约变更；
- 每条 assistant 消息的 usage 与任务事件记入 `.cw/tasks/<id>/meter.jsonl`，累计 `state.tokens_used`；
- 任务只在接管时刻设置一次模型（会话启动接管、批准、恢复、升级），首轮之后适配层不再调用任何改变模型、thinking level、工具集或系统提示的 pi 方法。

### 任务升级（/cw task escalate）

```sh
/cw task escalate [--from base|current]   # 默认 base
```

升级把任务交给 `strong` 模型的新会话；修复次数与已用预算不清零，也不追加预算。

- `--from base`（默认）：在 `<仓库>/../<仓库名>-cw-<任务id>-esc` 建立基于原始 `base_commit` 的 worktree，只覆盖批准的验收输入（与批准哈希逐一核对）。**Pi 1.0 的命令上下文无法跨工作目录启动新会话（`newSession` 没有 `cwd` 参数）**，因此该命令不冒充升级完成：它释放原会话执行权、把 `state.model` 切到 strong、写入 `escalate_pending` 的交接材料，并提示你手动在新 worktree 启动 pi（加载本扩展）后执行 `/cw task resume <id>`。
- `--from current`：在当前工作树用 `ctx.newSession` 真正替换会话；切换成功后才写 `escalated` 材料，任一步失败即回滚原账本与模型设置。注意与 approve/resume 不同：切换后的任务视图**不会自动启动模型回合**，首轮可能需要你手动发起。
- 升级 worktree 内的会话通过受保护引用 `<worktree>/.cw/task.json` 找到同一份权威账本；`resume` 接管升级任务时，任务视图附带前一模型的笔记（标注未经验证），并像批准一样启动首轮。

## ✅ 验证器协议

验证器是普通可执行程序，由 harness 在你仓库根目录调用。环境变量：

| 变量 | 含义 |
| --- | --- |
| `CW_TASK_ID` | 任务 ID |
| `CW_RESULT_DIR` | 本次运行的独立目录（绝对路径），结果写在这里；启动验证器前已预创建 `stdout.log` / `stderr.log`，不是空目录 |
| `CW_RUN_ID` | 本次运行编号 |
| `CW_REQUIRED_IDS` | 换行分隔的验收项 + 回归项 ID |

验证器必须在 `$CW_RESULT_DIR/result.json` 写出：

```json
{
  "protocol": 1,
  "run_id": "<与 CW_RUN_ID 相同>",
  "complete": true,
  "checks": [
    { "id": "tests/test_math.py::test_ok", "status": "pass", "message": "失败摘要（可选）" }
  ],
  "build": { "required": false },
  "summary": "一句话",
  "logs": ["相对 CW_RESULT_DIR 的日志路径"]
}
```

要点：

- `checks` 必须覆盖 `CW_REQUIRED_IDS` 的全部 ID；`status` 只能是 `pass` / `fail` / `skip` / `error`。工具没有报告的必查 ID 应显式写成 `error`，不要省略。
- 验证器**总结束时退出 0**：退出码非 0 表示验证器自身崩溃（harness 把结果降级为 `undetermined`）；用例失败与否由 `checks` 状态表达。
- 需要构建产物证据时写 `build.required = true` 并给出 `fresh`、`load_verified` 与 `artifacts`（含 sha256 与 `loaded_by`）；不需要时 `build.required = false` 且不要带其余字段。harness 会核对产物存在与哈希。
- 契约 ID 约定由你决定，两个现成起点见 `validators/examples/`：
  - `validators/examples/python-pytest.sh`：契约 ID = pytest nodeid（如 `tests/test_binding.py::test_owner_outlives_view`）；
  - `validators/examples/node-vitest.sh`：契约 ID = `<测试文件相对路径>::<vitest 全名>`（全名是套件名与用例名以空格连接）。

把示例复制进你的项目（如 `.cw/validate.sh`）后按 `project.toml` 的 `[validator]` 引用。示例不带构建产物证据，需要时再按协议补充。

## 🔍 cw_explore

模型可在任务中调用 `cw_explore({ question })` 向只读探索者子代理提问：

- 子进程 pi 只有 `read` / `grep` 两个工具，超时 180 秒；
- 每次实际执行的 read/grep 路径参数都对照工作树审计：出现越树路径（绝对路径、`..` 逃逸、外指符号链接）时，**整个回答不采信**，只返回错误；token 用量无论成败都计入任务预算；
- 回答 ≤30 行，每条结论须带 `仓库相对路径:行号` 引用：引用无效标〔引用无效〕，缺引用标〔缺少引用〕（`未找到` 除外）；
- 只读是工具白名单意义上的限制，**不是安全隔离**（见先读边界）。

## 📊 cw observe 与 eval

### cw observe

```sh
npm run build
npm run observe -- [--note <文字>] -- <cmd> [args...]
```

在当前目录运行一条命令并把现场记录到 `./.cw/observations/<UTC时间戳>/`（同一秒冲突时追加 `-n`）：

- `observation.json`：命令 argv 原样数组、工作目录、`--note`、退出码、终止信号、超时/取消标记、git 仓库根/提交/树哈希（非 git 仓库记 `supported: false`）、OS 摘要、`[observe] versions` 指定的各命令 `--version` 探测结果；
- `stdout-tail.txt` / `stderr-tail.txt`：两条流尾部各 200 行（超约 1 MiB 截断并注明，只留尾部）。

命令失败或被 Ctrl+C 都不影响记录完整性（`observation.json` 在启动前先落盘、结束后更新）。观察者只记录不分析，环境变量不入记录。退出码镜像被观测命令（spawn 失败 127，用法错误 2）。

### eval 脚手架

```sh
npm run build
cp eval/tasks.example.toml my-tasks.toml   # 按注释填写仓库、基线提交、任务与契约
node dist/eval/run.js my-tasks.toml [--repeat <n>] [--out <dir>]
```

对每个任务按四种条件各运行一次，每次都从基线提交的全新 detached worktree 开始：

1. `native`：原生 pi，不加载 Counterweight；
2. `gate`：pi + 门禁（契约来自任务文件；不运行先红检查，不冻结文件）；
3. `contract`：上一条 + 契约保护（frozen 冻结）与先红检查（先红不成立时该次运行为 `red_check_failed`）；
4. `escalate`：上一条 + `[models].cheap` 便宜模型先试，终态不是 `verified` 就换任务模型在全新 worktree 重来（`escalated = true`）。

输出（默认 `eval/out/<时间戳>/`，已 gitignore）：

- `results.csv`：每次运行一行，列 `task, condition, repeat, final_state, verdict, wall_seconds, tokens, cache_read, cache_write, cost, repairs, escalated`；`verdict` 来自任务 `verify_cmd` 独立验证（结果不回灌）；token/缓存/费用取自 pi `--mode json` 事件 usage 求和；
- `judging/index.md` 与 `judging/j-<n>.md`：打乱顺序、**不含条件标签**的人工评判清单；
- `key.csv`：key → 条件映射，供评判完成后揭晓对照。

门禁条件会在被评估仓库的 worktree 里自动写入 `.cw/project.toml` 与任务账本（任务 id 为 `<UTC日期>-<id>`），并以 `/cw task resume` 作为第一条消息登记会话。**此脚手架只用伪任务自测过，尚未在真实模型上执行。**

### 网关缓存探针（可选）

```sh
export CW_GATEWAY_URL=<完整 chat/completions 地址>
export CW_GATEWAY_API_KEY=<key>
export CW_GATEWAY_MODEL=<model>
npm run probe-cache
```

两次长请求会产生费用；只有首个请求 prompt token 超过 2000 且第二个请求报告缓存读取时结果才为 `supported`，否则为 `unconfirmed`。`unconfirmed` 不代表网关不支持缓存。

## 🔧 Troubleshooting

| 现象 | 原因与处理 |
| --- | --- |
| `task new` / `task approve` 报工作树不干净 | 先提交或保存改动；仅 `git add` 不算干净。`.cw/` 应在 `.gitignore` 里 |
| 在 git worktree 里无法创建/批准任务 | 设计如此：请在主检出运行 `/cw task new` / `/cw task approve` |
| `task approve` 提示无 UI 被拒 | code 任务需要先红确认对话框；在 TUI 或 RPC 交互模式执行。print/json 单发模式只可批准非 code 交付物（`repro`/`measurement`/`diagnosis`） |
| `undetermined` 被拒绝 | 先红或验收结果不确定一律不放行；检查验证器退出码（崩溃即 `undetermined`）与 `result.json` 完整性 |
| 模型未被切换/未设置模型 | `state.model` 必须是 `provider/model` 形式、在 pi 模型注册表中、且 provider 已配置认证；三者缺一即跳过并通知 |
| 门禁似乎没接管 | 只有 `approved`/`running` 且登记了当前会话 ID 的任务才生效；换会话用 `/cw task resume <id>` |
| 冻结文件被改但没还原 | 设计如此：门禁只 block 与追加事实说明，不还原文件；你自己决定回滚 |
| 探针结果 `unconfirmed` | 证据不足，不判定网关能力；确认 URL 是完整 chat/completions 地址、prompt 足够长 |
| escalate `--from base` 后没有"自动升级" | Pi 1.0 限制：请手动在升级 worktree 启动 pi（加载本扩展）并执行 `/cw task resume <id>` |
| `cw observe` 退出码非 0 | 镜像被观测命令的退出码；127 是 spawn 失败，2 是用法错误 |

## 🚧 Known limitations

- **同账户下不是强安全边界。** 冻结文件、任务账本与验证器协议依赖文件系统权限与进程内互斥，不能抵抗同账户下的恶意进程或模型伪造（例如直接改写 `.cw/` 下未被保护检查覆盖的文件）。它防的是门禁下模型的越权修改与证据漂移，不是沙箱。
- **非 git 仓库不绑定证据。** `task new`/`approve`、树快照、冻结 blob 都要求 git；非 git 仓库只降级为报告（`supported: false`），不宣称有基线证据。
- **无 UI 模式不能批准 code 契约。** print/json 单发模式下 `/cw task approve` 对 code 任务因无法弹先红确认对话框而拒绝；交互模式指 TUI 或 RPC。非 code 交付物（`repro`/`measurement`/`diagnosis`）不需要确认对话框，print 模式可批准。
- **探针结论保守。** `unconfirmed` 只说明证据不足，不判定网关能力；费用字段依赖模型价格元数据，未配置价格时的零值不是真实账单。
- **工具白名单不是沙箱。** 探索者的 `--tools read,grep` 不等于对任意扩展、同账户文件操作的安全隔离。
- **评估与探针未在真实模型上执行。** `eval/` 与缓存探针未经付费真实模型验证；费用数字来自价格元数据推算，不是账单。

## 💬 反馈

问题与建议请开 [issue](../../issues)。欢迎对验证器协议、契约字段与门禁行为提出使用中的实际摩擦。

## 📖 License

[MIT](./LICENSE) © DengQi
