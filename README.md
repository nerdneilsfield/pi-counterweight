# pi-counterweight

**Counterweight 给 AI 编程助手加一个收尾动作：回答结束前，自动运行你指定的检查；如果检查失败，把错误交回模型修一次。**

它是 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的扩展。Pi 是在终端里使用的 AI 编程助手，负责读代码、修改文件和运行命令；Counterweight 负责运行项目检查、拦截指定路径的直接写入，以及记录用量。它不能独立运行，也不提供模型账号。

例如，你让 Pi 修一个函数，在配置里指定 `npm test`。Pi 完成修改后，Counterweight 自动运行测试。测试通过就展示结果；失败则把错误输出交给 Pi，让它再处理一轮。第二次仍失败，就保留失败结果，不无限重试。

第一次使用只需配置一个检查命令。文件保护和辅助探索模型都可以以后再加。没有项目配置时，扩展不执行检查，也不拦截工具调用，但仍会把模型用量写入 `.cw/meter.jsonl`。

- [从零开始：看到第一次检查结果](#从零开始看到第一次检查结果)
- [用到自己的项目里](#用到自己的项目里)
- [设计思想](#设计思想)
- [配置参考](#配置参考)
- [常见问题](#常见问题)

## 从零开始：看到第一次检查结果

下面用一个独立练习目录演示，不需要先准备业务代码或测试框架。命令适用于 macOS / Linux 终端。当前项目以 Pi `1.0.0` 为验证版本；其他版本未测。

### 1. 准备 Node.js 和 Pi

先在终端执行：

```sh
node --version
npm --version
git --version
```

Node.js 需要 `22.19.0` 或更新版本。若提示找不到命令，先安装 [Node.js](https://nodejs.org/en/download) 和 [Git](https://git-scm.com/downloads)，重新打开终端再试。npm 随 Node.js 一起安装；Git 用于下载扩展和定位项目根目录。

安装并确认 Pi 版本：

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.0
pi --version
```

如果已经安装了 Pi `1.0.0`，跳过安装命令。

### 2. 准备本地扩展

如果你已经有这份仓库，进入仓库目录执行 `npm ci` 即可。首次下载则执行：

```sh
git clone https://github.com/nerdneilsfield/pi-counterweight.git ~/pi-counterweight
cd ~/pi-counterweight
npm ci
```

本地尚未发布的修改只存在于你的工作副本；重新克隆 GitHub 不会带上这些修改。本文描述的是当前工作副本的行为，试用尚未发布的 lite 版本时，请使用这份副本。

在扩展仓库目录运行下面这行，记住扩展的完整路径：

```sh
export CW_EXTENSION="$PWD/src/adapters/pi/index.ts"
```

后续步骤在同一个终端执行。扩展直接加载 TypeScript 源码，不需要先构建，也不要把路径改为 `dist/`。

### 3. 创建练习目录和最小配置

下面会创建 `~/counterweight-demo`。如果已有同名目录，请换一个空目录练习。

```sh
mkdir -p ~/counterweight-demo/.cw
cd ~/counterweight-demo
```

用文本编辑器在该目录创建 `.cw/project.toml`，复制以下内容并保存：

```toml
version = 1

[check]
cmd = ["node", "--check", "hello.js"]
```

`.cw` 是项目内存放配置和记录的文件夹，`project.toml` 是纯文本配置文件。`[check]` 表示结束检查；`cmd` 数组中第一项是程序名，后面每一项是一个参数。这里等价于在终端运行：

```sh
node --check hello.js
```

这条命令只检查 JavaScript 语法，不运行脚本。此时还没有 `hello.js`，手动执行会报文件不存在；下一步让 Pi 创建它。

### 4. 启动 Pi，让它完成第一个任务

确认终端仍位于 `~/counterweight-demo`，运行：

```sh
pi --extension "$CW_EXTENSION"
```

首次使用 Pi 时，在 **Pi 对话界面**输入 `/login`，选择模型提供商并按提示登录或配置 API key，再用 `/model` 选择可用模型。模型服务可能收费；Counterweight 使用你已有的 Pi 凭据。自定义网关的配置见 [Pi 官方入门文档](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/quickstart.md)。

仍在 Pi 对话界面输入：

```text
/cw-version
```

看到 `Counterweight: pi 1.0.0`，说明扩展已加载。启动时还应看到“结束检查已启用”的通知；只有版本通知而没有检查通知时，先检查配置文件的位置和内容。

然后发送任务：

```text
请创建 hello.js，让它输出 Hello, Counterweight!
```

Pi 正常结束这一轮时，扩展会运行语法检查。若生成的文件语法正确，对话里会出现包含以下内容的报告：

```text
[counterweight] 结束检查通过：`node --check hello.js` 退出码 0
```

实际报告还会带耗时。退出码是程序告诉调用者的结果：`0` 表示成功，非零表示失败。这证明检查命令执行成功，不等于脚本的所有功能都正确。

### 5. 认识失败时会发生什么

你不需要另外执行“批准”“开始任务”或“修复”命令。配置好以后，流程如下：

```text
你发任务 → Pi 工作 → 正常结束 → 运行配置的检查
                                 ├─ 成功：展示结果，结束
                                 └─ 失败：把错误交给 Pi，再处理一轮
                                           ↓
                                       再跑检查
                                           ↓
                                  展示成功或失败，结束
```

每次新的用户回合只有一次自动反馈额度。修复轮即使没有改文件，也会检查；纯问答正常结束也会检查，所以应选耗时可接受的命令。你主动中断时，扩展取消正在运行的检查，不把中断当成通过。

## 用到自己的项目里

在终端切换到你实际开发的项目根目录，也就是通常放 `package.json`、`pyproject.toml` 等文件的位置。先手动运行项目已有的测试或检查命令，确认它能正常结束，再把命令写入该项目的 `.cw/project.toml`。

| 你平时在终端运行 | 配置里的 `cmd` |
| --- | --- |
| `npm test` | `["npm", "test"]` |
| `npm run typecheck` | `["npm", "run", "typecheck"]` |
| `python -m pytest` | `["python", "-m", "pytest"]` |
| `bash scripts/check.sh` | `["bash", "scripts/check.sh"]` |

这些命令依赖你项目已有的脚本、环境和依赖，Counterweight 不会替你安装测试框架。选择会执行一次后退出的命令，不要使用持续监听文件变化的 watch 模式。`cmd` 不经过 shell；不能把 `npm test && npm run build` 当成一个程序名。需要组合多个检查时，可以放进自己的检查脚本。

比如，你希望检查类型，同时不让模型直接改测试目录：

```toml
version = 1

[check]
cmd = ["npm", "run", "typecheck"]
timeout_s = 120

[protect]
paths = ["tests"]
```

这里的 `tests` 是相对于项目根目录的路径，换成你项目实际使用的目录。保护只拦截 Pi 的 `edit` / `write` 文件修改工具：**bash 仍可修改这些文件，扩展不会阻止或事后报告这类修改。** 它适合减少误改，不是文件系统沙箱。

在该项目目录用 `pi --extension "$CW_EXTENSION"` 启动即可。修改配置后，退出并重新启动 Pi，让新配置生效。建议在项目的 `.gitignore` 中添加一行 `.cw/`，避免把本地用量记录一起提交；配置是否需要共享，可以按项目习惯单独安排。

要暂停自动检查，删除配置中的 `[check]` 小节及其字段，再重启 Pi。要同时停用检查和保护，可以将 `project.toml` 改名后重启；只要扩展仍被加载，用量仍会记录。上面的 `--extension` 只对本次启动有效，下次直接运行 `pi` 就不会通过这个参数加载扩展。

## 设计思想

### 先让模型工作，把确定的检查放在结束时

Counterweight 不要求模型先填任务表、签契约或等待批准。你直接提出任务，模型按 Pi 原有方式工作。扩展只在正常结束时运行你指定的命令，把执行结果交还给对话。

检查什么由项目决定：已有测试就跑测试，需要类型检查就跑类型检查。扩展读取退出码，不要求测试工具输出专门的协议文件，也不替项目定义“任务完成”的标准。

### 出错给一次反馈，不无限循环

编译错误、测试失败往往能帮助模型修正代码，所以第一次失败会自动反馈。但失败也可能来自环境、需求不清或模型能力不足。反复自动重试会继续消耗时间和模型费用，因此第二次检查后就展示结果，接下来由你决定是否继续。

### 用路径表达保护范围，不用内容指纹判断可信度

你明确列出不希望被直接修改的路径，扩展在 `edit` / `write` 调用时核对目标，包括符号链接指向的位置。默认扩展不计算工作树 hash，不保存保护文件的内容快照，也不以“文件没变”推断回答可信或跳过检查。

这个取舍让行为更容易预测：配置的检查每轮都执行，命中的直接写入就拒绝。代价也很明确：问答轮同样有检查开销，bash 旁路修改不会被检测。需要严格隔离时，应使用独立的系统权限或运行环境。

### 用别的模型做六件事，主模型继续写

运行 `/cw-setup`，按提示从 pi 当前可用的模型里选、填检查命令和保护路径，它替你写 `.cw/project.toml`。

六个角色都是子进程，模型各自配置，除 planner 外只读。explorer 找代码，review 只看这段改动有没有做错，over_review 只看这段改动有没有多做，research 处理主模型读代码仍定不下来的问题，historian（赛博史官）维护 `.cw/HISTORY.md`：主模型把阶段性成果用 `cw_chronicle` 汇报给它，它重写整份项目开发史，英文按 ASD-STE100，中文按新华社电讯稿体；它定不下来的事以 `ASK:` 开头发回主模型协调。planner 没有任何工具，只读会话记录，用于下面的 PAUSE。默认由主模型自己想起来调用 review、over_review 和史官；想让扩展替它做，见下面的「强制启用」。它们只报告，不拦截结束，结束仍只看检查命令的退出码。

`.cw/meter.jsonl` 记录主模型用量、检查、角色调用和 PAUSE 的用量。扩展不据此换模型。

每次用户回合，扩展还会往系统提示里加一段：少加没有当前调用方的抽象和兜底，用中文先给结论，不写防御性声明。没有项目配置时这段仍然会加。

旧的严格流程保留在 Git 标签 `v1-strict`。普通使用不需要它。

## 可选：安装为自动加载的 Pi 包

前面的 `--extension` 适合先试用本地工作副本。需要在后续会话自动加载时，可以安装 GitHub 上的版本：

```sh
pi install git:github.com/nerdneilsfield/pi-counterweight
```

这条命令获取远端版本，不包含本地未发布的修改。默认安装写入个人设置 `~/.pi/agent/settings.json`；加 `-l` 则写入当前项目的 `.pi/settings.json`，Pi 在项目信任获准后读取。包入口指向源码，无需构建。安装后重新启动 Pi，用 `/cw-version` 确认加载；此时不用再传同一扩展的 `--extension`。

## 配置参考

在仓库根创建 `.cw/project.toml`（`.cw/` 建议加入该项目的 `.gitignore`）。在子目录里启动 pi 时，扩展用 git 工作树根定位这份配置、结束检查的工作目录和 `.cw/meter.jsonl`；不是 git 仓库时用启动目录。每个小节都是可选的；未知字段会报错。配置缺失或非法时，扩展不检查、不拦截，只在非法时提示错误。assistant 用量仍会写入 `.cw/meter.jsonl`。没有配置时，系统提示里的 counterweight 段仍会写入。

从旧配置升级时，把 `[explorer] model` 改成 `[models] explorer`，删掉 `[observe]`，然后重启。留下旧字段会让整份配置加载失败，这一会话的检查和保护都不生效。

```toml
version = 1

[check]                     # 结束检查；不写这一节就不检查
cmd = ["npm", "test"]       # argv 数组，直接 spawn，不经过 shell
timeout_s = 600             # 缺省 600；到点杀掉整个进程组
env = {}                    # 额外环境变量（校验时只允许字符串值）

[protect]                   # 受保护路径；不写这一节就只保护 .cw/project.toml 本身
paths = ["tests/", "vitest.config.ts"]

[models]                    # 没写的角色，对应工具调用时返回不可用
explorer = "gateway/cheap-model"
review = "gateway/careful"
over_review = "gateway/blunt"
research = "openrouter/anthropic/claude"   # 只按第一个斜杠分 provider
historian = "gateway/cheap-model"
planner = "openrouter/strong/model"        # 无工具；要比主模型更强才有用，同款模型几乎没有收益

[timeouts]                  # 没人指定 timeout_s 时的默认（秒），范围 300–1800；没写的角色：research 1800，其余 300
# review = 600              # 自动运行（[auto]）和 PAUSE 没有调用方，只看这里
# planner = 600             # PAUSE 的 planner；超时则放行那次编辑

[auto]                      # 强制启用；不写这一节，三项都由主模型自己决定调不调用
review = false              # 每次正常结束，对工作树相对 HEAD 的改动自动跑 review 与 over_review
chronicle = false           # 每次正常结束且有改动，自动汇报给史官
pause = false               # 每个回合第一次改源码前，让 planner 出一次计划（PAUSE）

[router]                    # 审查闸门；不写这一节就不预判，review / over_review 每次都起子进程
url = "http://localhost:11434/v1/systemone"   # System One 接口：Jev 官方、Ollama（0.35+）、OpenJev 通用
model = "nimble"            # 该服务上的决策模型名
api_key_env = "TYPESAFE_API_KEY"   # 存 key 的环境变量名，不是 key 本身；本地 Ollama 不写
timeout_ms = 5000           # 缺省 5000
skip_below = 0.1            # 缺省 0.1：判“有问题”的概率不高于它就放行
audit_rate = 0.1            # 缺省 0.1：放行的里面随机抽这个比例仍去审查，用来量漏判
```

### 结束检查怎么跑

- **本轮正常结束就运行**，不看工作树有没有变化。命令的工作目录是仓库根。
- **通过**（退出码 0）：在会话里追加一行事实（命令、耗时），本轮结束。
- **不通过**：把退出码与两条输出流的尾部（各最多 80 行 / 16 KiB，超出注明截断）反馈给模型一次并继续一轮；再次失败就如实报告并结束，不再自动重试。每次用户回合给一次反馈额度。修复那一轮照样跑检查。
- **超时**：到 `timeout_s` 时对整个进程组先 SIGTERM、5 秒后 SIGKILL；按失败处理。
- **处理本身出错或超时**：如实报告「未能完成，本轮没有得到检查结论」，绝不报告通过。
- 取消（用户中断或会话关闭）不产生检查结论，并回收整个进程组。

### 受保护路径怎么保护

- 只在配置成功加载后生效。`edit`/`write` 的目标命中列表（文件本身或目录前缀）即被拒绝；`.cw/project.toml` 也在其中，模型不能通过改它关掉检查。
- 相对路径先按 pi 的口径对当前工作目录解析，再和仓库根比较。指向受保护路径的符号链接（包括目录链接下尚不存在的文件）同样被拒绝；指向仓库外的链接被拒绝；悬空符号链接 fail-closed（写入会沿链接重建无法核对的目标）。
- 仓库外的路径在已配置时一律拒绝。没有配置或配置非法时不拒绝。
- bash 和其他不经过 `edit`/`write` 的写入不拦截，结算时也不另作报告。
- 受保护路径在加载期校验：拒绝空路径、通配符、绝对路径、`..` 与 `.cw` 下的路径。

### 计量

每条 assistant 消息的 usage、结束检查、角色调用和 PAUSE 的记录都追加到 `.cw/meter.jsonl`（只增不减）。示例：

```json
{"kind":"usage","time":"…","session":"…","model":"gateway/medium-model","input":12000,"output":800,"cache_read":9000,"cache_write":0,"cost_total":0.03}
{"kind":"event","time":"…","session":"…","event":"check","detail":{"exit_code":0,"timed_out":false,"spawn_error":null,"ms":12400,"outcome":"passed"}}
```

### 强制启用

默认情况下，review、over_review 和史官只在主模型自己调用时才运行，提示里写了让它调用，但它可以不调。`[auto]` 把这三件事改成扩展触发，每一项都单独开关，且要求对应的 `[models]` 角色已配置，否则整份配置加载失败（不会等到运行时才静默不工作）。

- **`review = true`**：每次正常结束、检查定稿后，把工作树相对 `HEAD` 的 diff（含未跟踪文件名）连同本回合的用户原话交给 review 和 over_review 并行审查。两边都回 `none` 或 `ASK:` 就不打扰主模型；有发现就把原文作为结算消息交回，并续跑一轮，**每个用户回合最多一次**，续跑后的结算不再审查。结束检查要求修复时先修复，不审查。
- **`chronicle = true`**：每次正常结束且工作树有改动，自动把本回合的请求、改动文件和检查结果汇报给史官，走和 `cw_chronicle` 同一条队列。审查有发现的那一轮不汇报，等修复后再说。
- 自动运行不改变检查结论：它们的失败、超时或空回答只是不产出文字。diff 超过 80000 字符会截断并注明。

用量和事件照常写入 `.cw/meter.jsonl`。

### PAUSE：第一次改源码前先出一份计划

`pause = true` 且配了 `planner` 时：每个用户回合，agent 第一次对源码的 `edit`/`write` 会被拦下，planner 读完前面的整段调查，写一份四段式修复计划（根因、位置、做法、理由），作为拒绝理由交回；主模型可以照做，也可以说明不同意再自行重发。**每个回合只拦这一次**。

- 草稿不算：`.cw/`、`tmp/` 下的写入放行，不耗额度。受保护路径先拦，不会白白请 planner。
- **失败一律放行**：planner 超时（跟随 `[timeouts].planner`，默认 300 秒）、没有回答、读不出会话记录，这次编辑照常执行。计划是建议，不是闸门。
- bash 不拦：用 `sed -i` 之类改源码的旁路不会触发 PAUSE。
- 每次介入记一条 `pause` 事件（`planned` / `failed` / `timeout`、耗时、被拦的工具），用它判断值不值，不要凭感觉。

依据只有一篇论文：弱执行者（Qwen3-Coder-30B）加强规划者（GPT-5.6 Sol），SWE-bench 上 OpenHands 从 45.4% 升到 62.2%；规划者和执行者用同一个模型时只救回 5.4% 的失败轨迹。**没有在强主模型上测过**，所以默认关闭。planner 应该选比主模型更强的模型，否则大概率只是多花一次调用。

### 审查闸门

`[router]` 配了之后，`cw_review` 和 `cw_over_review` 在起子进程前先问决策模型一个是非题：“这次改动是否存在行为错误”（over_review 问“是否包含没有需求支撑的抽象、兜底、配置项或多余测试”），状态是传给角色的那段要求加 diff。返回的 `noul` 是“有问题”的概率：

- 不高于 `skip_below`：不起审查模型，直接返回 `none`，并注明是预判放行。
- 高于 `skip_below`：照常起审查模型。
- 放行的里面按 `audit_rate` 随机抽一部分仍去审查，抽查的结果就是漏判率的样本。

**闸门只能省调用，不能让审查少跑。** 请求失败、超时、HTTP 错误（本地 Ollama 的请求文本超过 64 KiB 会返回 413）、响应格式不对、环境变量没设，都按“不放行”处理，审查照常跑。

三个数值（`skip_below`、`audit_rate`、`timeout_ms`）的缺省值是起点，没有经过实测校准。每次闸门都写一条 `gate` 事件到 `.cw/meter.jsonl`：

```json
{"kind":"event","time":"…","session":"…","event":"gate","detail":{"role":"review","model":"nimble","p":0.03,"skipped":true,"audited":false,"error":null,"ms":180}}
```

校准方法：把 `audit_rate` 调到 1，让每次放行都去审查，再对照 `gate`（`p`）与随后 `review`/`over_review` 事件的 `result`（`none` 或 `answer`）。`p` 低而 `result` 是 `answer` 的就是漏判。`confidence` 字段没有用：Ollama 文档说明它只是概率分布的集中度，不是校准过的正确率。

## 在 OMP 和 OMO 里使用

OMP（oh-my-pi）和 OMO（底层是 pi 的分叉 senpi）的扩展加载器都能加载这个扩展。下面是它们和 Pi 的差别。

```sh
omp plugin install git:github.com/nerdneilsfield/pi-counterweight   # OMP
omo install git:github.com/nerdneilsfield/pi-counterweight          # OMO（npm 包 omo-ai）
```

`omo install` 把命令原样交给底层的 senpi 引擎，装到 `~/.omo/agent`，不会和 `~/.pi/agent` 里的 Pi 安装互通。

- **结束检查。** OMP 没有 `agent_before_settle`，改用它的 `session_stop`：失败时把摘要作为续跑上下文交回一次，报告通过通知显示，而不是写入对话记录。额度规则不变。
- **角色子进程。** OMP 的 CLI 不认 `--offline`、`--no-context-files`、`--no-prompt-templates`、`--no-themes`、`--no-approve`，所以对它用另一份参数；只读仍靠 `--tools read,grep`。从 omp 以外的方式启动的 OMP（例如单文件编译版）找不到 CLI，角色工具会返回不可用。
- **工具可见性。** OMP 默认把扩展工具放进“可发现”层、审批级别按 exec。五个工具都显式声明为顶层可见，只读角色按 read 审批，史官按 write。
- **配置校验。** OMP 把 `typebox` 换成自己的兼容层，会丢掉 `pattern`；配置校验因此改用字面量 JSON Schema。
- 已验证：OMP 18.12.6 和 senpi 2026.10.21-3 的加载器能加载本扩展，OMP 上系统提示注入和 `session_stop` 流程按预期工作。未验证：在它们里面用真实模型跑完整会话，以及 `omo install` 本身（只读了 omo-ai 5.1.44 的源码确认它转给 senpi，没实际执行）。

## 六个角色

模型名写成 `provider/model`。Pi 按第一个斜杠区分提供商，所以 `openrouter/anthropic/claude` 这种多个斜杠的名字可用。上面配置里的名字都是占位，换成你账号里真实有的模型，保存后重启。

| 工具 | 输入 | 它做什么 | 超时 |
| --- | --- | --- | --- |
| `cw_explore` | 一个问题 | 找代码。每条结论带 `路径:行号`，找不到就回 `未找到` | 300 秒 |
| `cw_review` | 这次的要求，和 diff | 只报做错的地方，包括被削弱的真实边界 | 300 秒 |
| `cw_over_review` | 这次的要求，和 diff | 只报没资格留下的抽象、兜底、多余测试、防御性分支 | 300 秒 |
| `cw_research` | 一个问题 | 结论在前。没读到的写 `未核实` | 1800 秒 |
| `cw_chronicle` | 一段阶段性汇报 | 重写 `.cw/HISTORY.md`；写不下去时返回 `ASK:` 问题，文档不动 | 300 秒 |
| （PAUSE 内部） | 调查记录 + 被拦下的编辑 | planner 写四段修复计划，无工具 | 300 秒 |

**超时由调用方定。** 每个角色工具都有一个可选参数 `timeout_s`（秒），范围 300–1800，越界会被夹住。输入小就不传，用默认 300；输入明显大（长 diff、跨很多文件）就先设长一点。超时之后，返回文本里直接给出下一档（每次翻倍：300 → 600 → 1200 → 1800），照着重试即可。已经用满 1800 还超时，说明该拆小输入，工具会这样说，不会再建议加。

没人指定 `timeout_s` 的场景（`[auto]` 自动审查、PAUSE 的 planner）读 `[timeouts]` 里按角色配的默认值，同样是 300–1800。

五个只读子进程只有 `read` 和 `grep`，不能改文件；planner（`cw_pause`，只由 PAUSE 内部触发，不是工具）用 `--no-tools`，一个工具也没有。review 不自己跑 `git diff`，diff 由主模型传入。它们不在结束时自动运行，也不决定检查是否通过。没配模型的工具仍在列表里，调用时返回不可用。用量写失败时，已经拿到的回答仍返回。

扩展不核对引用，也不限制回答行数。只读靠工具白名单，不是沙箱。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 终端提示 `pi: command not found` | 确认已安装 Pi，并重新打开终端运行 `pi --version` |
| `/cw-version` 不存在 | 在 Pi 对话里输入，而不是终端；检查启动时 `--extension` 后的路径是否指向本地源码入口 |
| 改了配置但行为没变 | 配置在会话初始化时读取。保存文件后退出并重新启动 Pi |
| 检查一直不结束 | 先手动执行同一命令，检查它是否进入 watch 模式或等待输入；设置合适的 `timeout_s` |
| 只聊天也跑测试 | 当前设计在每次正常结束时检查。可以换成更快的检查命令，或移除 `[check]` 后重启 |
| 扩展不拦截工具调用 | 没有 `.cw/project.toml`，或配置非法（会话开始时有错误通知）。检查文件与未知字段。用量仍会写入 `.cw/meter.jsonl` |
| 检查没有在某一轮运行 | 该轮不是正常结束（中断、错误），或没有配置 `[check]`。正常结束的轮次都会跑，包括工作树没有变化的轮次 |
| 模型改不了 `tests/xxx` | 受保护路径拦截。需要改就由你手动改，或调整 `[protect].paths` |
| bash 改了受保护文件但没被拦 | 设计如此：只拦 `edit`/`write`，bash 不拦截、也不在结算时报告 |
| 检查失败后模型没被反馈 | 每个失败链只反馈一次；再次失败如实报告。新的一轮用户消息会重新给一次额度 |
| 审查/汇报返回“超时，子进程组已终止” | 主模型手动调用时，照返回里的“下一档”重试（每次翻倍，上限 1800）；到 1800 还超时就拆小 diff。自动运行（`[auto]`）没有调用方，在 `[timeouts]` 里给对应角色调大，重启生效 |
| 角色工具说未配置 | `[models]` 里没有这个角色。补上 `provider/model` 后重启 |
| 配置加载失败，提示 `auto.xxx 需要 models.yyy` | 开了强制启用却没配对应模型。补上模型或关掉那一项 |
| PAUSE 没有出现 | 没开 `[auto].pause`、没配 `planner`、本回合已经拦过一次，或写入的是 `.cw/`、`tmp/` 下的草稿；用 bash 改的也不触发 |
| 升级后检查和保护都不跑了 | 配置里还留着 `[explorer]` 或 `[observe]`。未知字段会让整份配置失败。按上面的迁移改完重启 |

## 使用边界

- **同账户下不是强安全边界。** 拦截靠进程内的路径检查，不能抵抗同账户下的恶意进程或模型伪造。
- **bash 是旁路。** 只拦 `edit`/`write`；其他途径的修改不会被拦截，也不会被报告。
- **检查只按退出码判定。** 不解析测试身份、不核对产物哈希、不检查模型是否新增了 skip 或弱化测试；模型自写的测试不能当权威结论。
- **角色的只读是工具白名单。** 不是沙箱。
- **review 默认不自动运行。** 不开 `[auto].review`、主模型又不调用，就没有这份报告。开了也只报告，结束仍只看检查命令。
- **PAUSE 只拦 `edit`/`write`，且只在 SWE-bench 的弱执行者设置下有数据。** bash 旁路不触发。
- **真实模型未在本仓库测试中执行。** `npm test` 不需要模型凭据。
- **严格流程在 tag 里。** `v1-strict` 保留了契约/先红/证据/门禁的完整实现，需要时 `git switch --detach v1-strict` 查看或移植。

## 开发与验证

以下命令用于修改 Counterweight 本身，普通使用者不必在每次启动前执行：

```sh
npm ci
npm run typecheck
npm run build
npm run test:serial
```

在 macOS 上运行较长测试时，可以用 `caffeinate -i npm run test:serial` 防止空闲睡眠暂停测试进程。项目曾遇到整机睡眠导致计时器和测试一起暂停的情况。

## 反馈

问题与建议请开 [issue](../../issues)。

## License

[MIT](./LICENSE) © DengQi
