# pi-counterweight

Counterweight 的 Pi 扩展工程。当前实现 M0–M7：版本命令、网关缓存探针、`project.toml` / `contract.toml` 校验、任务目录与 Git 树快照、验证器运行与验收证据判定、冻结文件保护、门禁决策与交还材料、Pi 事件适配层（门禁接线、工具注册、计量），`/cw` 命令流程与契约先红批准，以及按任务选模型、任务升级与缓存纪律。另有 M9 的 `cw observe` 观测命令与 `eval/` 评估脚手架（见下文）。

需要 Node.js `>=22.19.0`。Pi 固定为 `1.0.0`。

```sh
npm ci
npm run typecheck
npm test
npm run build
./node_modules/.bin/pi --extension ./src/adapters/pi/index.ts
```

在 Pi 中执行 `/cw-version`，预期通知为 `Counterweight: pi 1.0.0`。`npm test` 使用真实 Pi RPC 验证该命令，不需要模型凭据；缓存探针测试只访问本机伪网关。

扩展加载后，对状态为 `approved`/`running` 且登记了当前会话 ID 的任务（`.cw/tasks/<id>/state.json`）生效：

- 对内置 `edit` / `write` 修改受保护路径（契约冻结与接口文件、`.cw/project.toml`、任务账本）直接 block，提示改用 `propose_contract_change`；
- 每次 `tool_result` 后重查冻结文件，有新冲突时在该工具结果末尾追加一行事实说明，不发送额外消息，不还原文件；
- `agent_before_settle` 运行门禁：批准的验证器、验收证据三态判定、预算与修复次数，通过即结束、失败按剩余次数续跑、受阻或环境问题交还（材料在 `.cw/tasks/<id>/handback.md`）；
- `report_blocked` 与 `propose_contract_change` 两个顺序执行的工具供模型上报受阻与提议契约变更；
- 每条 assistant 消息的 usage 追加到 `.cw/tasks/<id>/meter.jsonl` 并累计 `state.tokens_used`；任务创建、批准（含确认等待时长）、每次验证起止、交还与结束也记入同一文件（`kind: "usage"` / `kind: "task"` 两类行）；
- 任务在会话中只在其接管的时刻设置一次模型（会话启动接管、批准、恢复、升级）；首轮之后适配层不再调用任何改变模型、thinking level、工具集或系统提示的 Pi 方法。

## 任务流程（/cw 命令）

```sh
/cw task new <slug> [--tier script|change|interface]  # 工作树必须干净（忽略 .cw/）
# 编辑 .cw/tasks/<id>/contract.toml 后：
/cw task approve        # 校验契约；code 任务先在原始基线上跑先红检查，需交互界面确认失败原因
/cw task status         # 查看状态、预算、最后验证与冻结冲突
/cw task resume <id>    # 把当前会话登记到任务（不重建基线）
/cw task cancel         # 取消任务（先终止在途验证）
/cw task handback       # 手动生成交还材料并结束
```

- `task new` 记录 `base_commit`，按 `--tier` 与 `project.toml` 的 `[tiers]`→`[models]` 选定任务模型（写入 `state.model`）并生成契约模板；不干净时先提交或保存改动，仅 `git add` 不算干净。在 git worktree（非主检出）中不能创建或批准任务。
- `task approve` 对 code 任务从 `base_commit` 建立隔离基线（只覆盖 `baseline_inputs`），先红项必须实际失败且其余验收/回归通过；`undetermined` 一律拒绝。确认对话框展示每个先红项的失败原因与覆盖文件；无 UI（print 模式）时拒绝批准。批准后一段 ≤40 行的任务视图会追加到会话，会话即刻采用任务模型。
- 批准后验证器配置随之冻结：修改 `project.toml` 不影响本任务，执行始终使用批准时的命令。
- 批准/恢复登记的会话才受门禁接管；`handed_back` 的任务修订契约后可重新 `task approve`（重跑先红，`base_commit` 不变）。

### 任务升级（/cw task escalate）

```sh
/cw task escalate [--from base|current]   # 默认 base
```

升级把任务交给 `strong` 模型的新会话；修复次数与已用预算不清零，也不追加预算。升级材料与计量事件只在交接真正落地后写入：切换被取消、失败或模型未能接管时，账本持锁回滚、幸存会话的模型恢复为升级前设置（无法恢复时明确报告），不留下任何宣称升级成功的材料或事件。

- `--from base`（默认）：在 `<仓库>/../<仓库名>-cw-<任务id>-esc` 建立基于原始 `base_commit` 的 worktree，只覆盖批准的验收输入（与批准哈希逐一核对，不一致即拒绝并清理），并写入指向唯一权威账本的引用 `<worktree>/.cw/task.json`。**Pi 1.0 的命令上下文无法跨工作目录启动新会话（`newSession` 没有 `cwd` 参数）**，因此该命令不冒充升级完成：它释放原会话的执行权、把 `state.model` 切到 strong，写入原因 `escalate_pending` 的交接材料（明确待手动交接），并提示你手动在新 worktree 启动 Pi（加载本扩展）后执行 `/cw task resume <id>`。原工作树代码不变，可写账本不复制。
- `--from current`：在当前工作树用 `ctx.newSession` 真正替换会话；先落模型、再提交账本、最后追加视图，任一步失败即恢复原账本。切换成功后才写原因 `escalated` 的材料；新会话登记进同一账本、采用 strong 模型，任务视图连同"前一模型的笔记，未经验证"一并追加。
- 升级 worktree 内的会话通过 `.cw/task.json` 引用找到同一份权威账本；该引用是受保护路径，模型不可直接写入。未登记的会话不会自动接管；`resume` 接管升级任务时，任务视图附带前一模型的笔记（标注未经验证）。

探针要求显式设置 `CW_GATEWAY_URL`（完整 Chat Completions 地址）、`CW_GATEWAY_API_KEY`、`CW_GATEWAY_MODEL`，然后运行 `npm run probe-cache`。两次长请求会产生费用；只有首个请求的 prompt token 超过 2000 且第二个请求报告缓存读取时，结果才为 `supported`，否则为 `unconfirmed`。`unconfirmed` 不代表网关不支持缓存。

## 观测命令（cw observe）

```sh
npm run build
npm run observe -- [--note <文字>] -- <cmd> [args...]
```

在当前目录运行一条命令，并把现场记录到 `./.cw/observations/<UTC时间戳>/`（同一秒冲突时追加 `-n`）：

- `observation.json`：命令 argv 原样数组（不经 shell 拼接）、工作目录、`--note` 备注、退出码、终止信号、超时/取消标记、git 仓库根/提交/树哈希（非 git 仓库记 `supported: false`，不绑定）、OS 摘要、以及 `.cw/project.toml` 可选 `[observe] versions = ["node", ...]` 指定的各命令 `--version` 探测结果；
- `stdout-tail.txt` / `stderr-tail.txt`：两条流的尾部各 200 行（总量超约 1 MiB 时截断并注明，只保留尾部）。

命令失败、被 Ctrl+C（SIGINT/SIGTERM 会终止整个子进程组）都不影响记录完整性：`observation.json` 在命令启动前先落盘、结束后更新。观察者只记录，不做任何分析；环境摘要只含 OS 与工具版本，环境变量不入记录。observe 自身的退出码镜像被观测命令的退出码（spawn 失败为 127，用法错误为 2）。

## 评估脚手架（eval/）

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

- `results.csv`：每次运行一行，列为 `task, condition, repeat, final_state, verdict, wall_seconds, tokens, cache_read, cache_write, cost, repairs, escalated`。`final_state` 取 pi 结束原因或门禁账本状态；`verdict` 来自任务 `verify_cmd` 独立验证（结果不回灌）；token/缓存/费用取自 pi `--mode json` 事件的 usage 求和；
- `judging/index.md` 与 `judging/j-<n>.md`：打乱顺序、**不含条件标签**的人工评判清单（任务描述、验收说明、评判标准、结果 diff 截 400 行）；
- `key.csv`：key → 条件映射，供评判完成后揭晓对照，不与清单一起阅读。

门禁条件会在被评估仓库的 worktree 里自动写入 `.cw/project.toml` 与任务账本（任务 id 为 `<UTC日期>-<id>`），并以 `/cw task resume` 作为第一条消息登记会话。此脚手架只用伪任务自测过，尚未在真实模型上执行；`/cw task resume` 在 print/json 模式下的命令分发属待实测项。
