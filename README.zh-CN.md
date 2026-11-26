<p align="center">
  <img src="docs/assets/logo.svg" alt="Foreman 标志" width="520">
</p>

**一个主会话，看住整个编码 Agent 集群。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/Simon-He95/foreman/actions/workflows/ci.yml/badge.svg)](https://github.com/Simon-He95/foreman/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/foreman-ops.svg)](https://www.npmjs.com/package/foreman-ops)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933.svg)](package.json)

你只和一个 Foreman 主会话对话。它把活分给任意多个 worker 线程，盯着完整历史，
接收每次完成通知，并根据 SQLite 账本回答“后来怎么样了”——不靠模型记忆。
worker 线程只是执行细节，你不需要逐个打开。

这不是“更好的多 agent 编排引擎”，而是套在 T3 原生委派/workflow 原语外面的
**one-session 运维层**。

![Foreman 控制面板](docs/assets/dashboard-live.png)

Foreman 补的是你和编码 Agent UI 之间的运维层：

- **一个主会话**：长存活的主会话是唯一入口，接新需求、推动队列、在一个对话里汇总整个集群。
- **所有细节都能问主会话**：完成结果、失败原因、产物和事件轨迹都在账本里；主会话按需查询，用户不需要打开每个任务 thread。
- **首启一键绑定**：未绑定主会话时，Dashboard 会检查 T3，并可一键创建/绑定主控，不需要手工拼命令。
- **持久账本**：任务、租约、attempt、事件、inbox、对话全部落 SQLite；进程重启不会忘记谁在跑。
- **租约而不是猜测**：worker 静默不等于完成；心跳丢失会重新排队或失败。
- **完成推送**：终态进入 inbox 并唤醒 leader，不用反复问“跑完没有”。
- **唯一答案**：计数和任务摘要统一由 `buildStateCard()` 生成，leader、面板、API、通知共用。
- **完成契约**：可选 token、非空 artifact、内容标记或 git diff，避免“回复了 DONE 但没干活”。
- **可选的 T3 Lineage**：子任务可以在 T3 的 Lineage 里查看，方便调试；但“一个会话”体验不依赖逐个打开 thread。

### 为什么是一个会话

一个长存活的对话就是产品本身，而不是线程列表外面套一层聊天框。主会话持续掌握所有活跃和近期任务，接收完成/失败通知，并能向账本查询某个任务的 brief、结果、错误和事件轨迹。查询发生在同一个会话里，所以只有一个地方问、一个地方答。打开 worker thread 是调试用的逃生口，不是必需流程。

示意对话：

```text
你：把这三个方向都派出去，难的那个用强模型，做完告诉我结论。
主会话：已排入队列：A（standard）、B（standard）、C（deep）。C 走强模型。

你：第二个任务为什么失败？它到底跑了什么？
主会话：我查一下账本。……失败原因是测试命令超时；它先定位到 X，再改了 Y，
        最后在 Z 上卡住。要我用当前路由重试，还是先看完整事件轨迹？
```

不需要第二个聊天窗口，不需要 thread 列表，也不需要“请打开 child thread”。

持久性在会话和账本里，而不在某个模型的上下文窗口里。每一轮都会拿到当前状态卡和
最近对话；更早的任务/对话细节按需查询。T3-backed leader 还会复用一个内部 leader
thread，而不是每轮新建。

## 它是什么

Foreman 不是另一个 Agent runtime。[T3 Code](https://t3.codes) 负责执行和
worker UI，T3 ACP provider（DimAgent、Codex、Claude 或兼容实现）提供模型和工具。
Foreman 提供控制面：排队、租约、重试、恢复、完成契约和状态汇总。

它也不是 workflow engine。T3 原生 Workflows 负责确定性流水线、定时任务、
webhook 和审批；Foreman 负责围绕它们的动态队列：新请求、优先级、模型路由、
状态，以及“到底发生了什么”的查询。两者组合，而不是重复造轮子。

### T3 原生能力 vs Foreman

T3 Code 已经提供执行底座：

- **Thread / run**：provider/model 选择、审批、diff、worktree。
- **原生委派**：父 run 活跃时，`delegate_task` 可以创建带 lineage 的 child thread。
- **原生 Workflows**：确定性的 TypeScript 流水线，支持 schedule、webhook、审批、checkpoint、重试和并发池。部分 T3 版本里它是 Labs 功能，需要到 Settings → Labs → Workflows 开启。
- **Thread UI / 移动端**：逐个查看和驱动 worker。

Foreman 刻意不重造这些原语，只补“持续到来的动态工作”所缺的运维层：

| 问题 | T3 原生 | Foreman |
| --- | --- | --- |
| 怎么派一个 agent？ | 新建 thread，或在父 run 里 `delegate_task` | 同样用 T3 执行，但前面有持久队列和优先级 |
| 怎么跑一个固定的多阶段流程？ | 原生 Workflows | 交给 T3 Workflows；Foreman 不做 workflow engine |
| 哪里看整个集群的统一对话？ | 每个 thread 各自一个对话 | 一个长存活的 master session 是唯一入口 |
| 之前那段讨论在哪？ | 去对应 thread 翻历史 | 直接问主会话；它会查 SQLite 里的持久对话历史 |
| 怎么长期跟踪临时工作？ | Thread 列表和 run 状态 | SQLite 账本：queued/running/blocked/done/failed/lost、attempt、lease |
| 崩溃或静默后怎么办？ | T3 thread 状态还在 | 心跳、租约、重试、lost 检测、thread 对账、重新附着 |
| “任务 X 到底发生了什么？” | 打开 child thread 自己读 | 直接问主会话；它查询账本后在同一会话回答 |
| 一批任务怎么选模型？ | 每个 thread 单独选 | 按难度/类别集中路由，也支持单任务覆盖 |
| 怎么确认 worker 真的完成？ | 看 thread/run | 可选完成契约：token、artifact、内容标记或 git diff |
| 真正的 UI 是什么？ | Thread/worker UI | 主会话；Dashboard 是二级运维面，worker thread 只是调试细节 |

**分工**

- 确定性、重复、带 schedule/webhook/审批的流程 → **T3 Workflows**。
- 对话里的一次性 child-agent 步骤 → **T3 `delegate_task`**。
- 持续到来的临时请求，需要统一会话、优先级、路由、恢复和“到底发生了什么” → **Foreman**。

只需要一个 thread、一个任务，或者固定流水线时，直接用 T3 就够；
当工作是一个不断变化的队列、而用户不应该被迫管理 thread 列表时，用 Foreman。

**设计规则**

1. **主会话就是产品。** 一个长存活对话是用户界面；child thread 只是执行细节，不是必访页面。
2. **账本是真相。** 状态、结果、失败和细节从 SQLite 读取，不靠模型记忆或 thread 列表重建。
3. **查询优于开 thread。** 状态卡只有摘要时，主会话向账本做有界任务查询或 `chat:` 对话查询，然后在同一个会话里回答。
4. **动态任务排队，确定性任务交给 T3。** Foreman 负责优先级、租约、重试、恢复和路由；T3 负责 agent runtime 和原生 workflows。
5. **契约是证据，不是证明。** 可以要求 token、artifact 或 diff；语义正确性仍需人判断。
6. **T3 Lineage 是可选项。** 它是调试视图，不是 one-session 体验。

所以 Foreman 既不是“再加一层编排”，也不是 T3 的替代品；它是人和 agent 集群之间的
**one-session 运维层**。完整设计原则、模块地图和非目标见 [DESIGN.md](DESIGN.md)。

```text
你 ── 一个主会话 ──> Foreman leader (rule | claude | codex | dim)
                        │  ▲
                        │  └── 任务详情查询（SQLite）
             SQLite: tasks / events / inbox / chat
                        │
             daemon: claim → lease → poll → retry → reattach
                        │
             adapter: mock | t3
                        │
              T3 Code ──> worker thread ──> Claude / Codex / Dim / ACP
                        └── 执行细节，不是用户界面

确定性 / 定时 / 审批流程 ──> T3 原生 Workflows
                 （Foreman 不重复实现这个 engine）
```

T3 可以单独使用；Foreman 也可以在 `mock` 模式下完全不依赖 T3 运行。
设计原则、非目标和模块目录见 [DESIGN.md](DESIGN.md)。

## 先选路径

| 目标 | 前置条件 | 首次耗时 | 开始 |
| --- | --- | --- | --- |
| 看账本和面板 | Node.js >= 22.5 | 约 2 分钟 | `npm install -g foreman-ops` 后 `foreman demo --duration 20` |
| 常驻 mock 控制面 | Node.js >= 22.5 | 约 3 分钟 | `foreman init --yes --adapter mock` 后 `foreman up` |
| 跑真实编码 Agent | Node + T3 Code + 已认证的 ACP provider | 10–20 分钟 | [T3 配置](#在-t3-里使用) |
| 在 T3 里和 Foreman 对话 | 真实路径 + 已注册 provider | 再加 5 分钟 | `foreman master create` |

Foreman **不包含 T3 Code，也不包含模型 provider**。T3 是执行层和 worker UI；
DimAgent、Codex、Claude 等 ACP provider 提供模型和工具。目前没有一键桌面安装包，
但 CLI 已经发布到 npm：

```bash
npm install -g foreman-ops
```

| 依赖 | 用途 | 说明 |
| --- | --- | --- |
| Node.js >= 22.5 | 全部功能 | 使用 `node:sqlite` |
| T3 Code 0.1.x | 真实 worker / T3 主控 | 独立 app/server；当前验证版本 `0.1.11` |
| ACP provider + 登录 | 真实 worker | DimAgent 是验证路径；Codex/Claude 通过 T3 配置 |
| Git 项目目录 | 真实 worker | 原生 Lineage 要求主控和任务在同一 T3 项目 |
| macOS / Linux | 已验证平台 | Windows 未验证；launchd 仅 macOS |
| 端口 `3773` / `3777` | T3 / Foreman 面板 | 冲突时自行修改 |

不安装 T3 也可以运行 mock demo 和面板；mock 任务只验证队列、租约、重试、通知和 UI，
不会改代码，也不会调用模型。

## 快速开始

要求 Node.js **>= 22.5**。真实 worker 需要 T3 和已认证的 ACP provider；demo 和 mock 模式不需要。

从 npm 安装：

```bash
npm install -g foreman-ops
foreman --help
```

需要最新 main 或参与开发时，从源码安装：

```bash
git clone https://github.com/Simon-He95/foreman.git
cd foreman
npm install
npm test
npm install -g .

# 不需要模型的完整演示
npm run demo -- --duration 20
```

### 初始化

```bash
foreman init
```

向导会以 `0600` 权限写入 `foreman.config.json`，配置项目目录、`mock|t3`
adapter、leader、provider/model、数据目录和端口，并可顺手注册 T3 provider。

非交互模式：

```bash
foreman init --yes \
  --adapter mock --leader rule \
  --project . --data-dir .foreman --port 3777
```

### 启动

```bash
foreman up
# 面板：http://127.0.0.1:3777
```

另开终端加任务：

```bash
foreman add "修掉登录页的 flaky test" \
  --brief "定位竞态并补回归测试" \
  --priority 80

foreman status
foreman ask "现在谁在跑，队列里还有什么，卡在哪？"
```

## 在 T3 里使用

T3 Code 是**独立依赖**：需要你自己安装/启动 T3、把项目加进去，并在 T3 里
登录至少一个 ACP provider。注册 Foreman provider 后必须重启 T3，新的
**Foreman (control plane)** provider 才会出现。

```bash
# 1. 确认版本、启动 T3、添加项目
npx t3@latest --version
npx t3@latest serve --no-browser --port 3773
npx t3@latest project add /path/to/your/repo

# 2. 在 T3 里登录 provider，然后配置并注册 Foreman
foreman init --adapter t3 --provider dim \
  --project /path/to/your/repo \
  --model dimcode-api-oauth/deepseek-v4.1-flash \
  --leader dim --register

# 从源码运行时，npm run t3:register-foreman 等价于注册这一步
# 只有使用 DimAgent worker 时才需要：npm run t3:register-dim

# 3. 重启 T3，再启动 Foreman
foreman up --adapter t3 --leader dim

# 4. 创建接收通知的 T3 主控线程
foreman master create --title "Foreman"
```

如果没有绑定主控，Dashboard 会显示 **first-run 面板**：检查 T3、展示默认 FC/项目，
并可以一键创建并绑定主控。

![主会话首启绑定](docs/assets/first-run.png)

然后在 T3 新建 thread，provider 选 **Foreman (control plane)**，直接说话。
这就是正常的 one-session 路径：主控读状态、建/取消/重试任务、接收完成通知，
并从账本回答任务细节。真正干活的是 worker 线程，但你不需要打开它们。
面板/CLI 仍然存在，是运维备用入口，不是主要交互方式。

已有主控线程时：

```bash
foreman master set mcp:<thread-id>
foreman master show
foreman master test
```

原生 Lineage 要求主控和任务在同一个 T3 项目；跨项目或普通 thread 会回退到
top-level worker。详见 [原生 Lineage](docs/native-lineage.md)。

## 日常使用顺序

正常运行需要**两个长期进程**，按顺序启动：

1. **T3 Code**：打开桌面 App，或运行
   `npx t3@latest serve --no-browser --port 3773`。保持它运行，worker 线程在 T3 里。
2. **Foreman**：在项目目录运行：

   ```bash
   cd /path/to/your/repo
   foreman up
   ```

   `foreman up` 是阻塞进程，包含 daemon、leader、API 和 dashboard，所以不要关掉
   这个终端；需要常驻可以用 tmux 或 `foreman service`。

之后选一个入口：

- **T3 主控（推荐）**：打开绑定的 thread（`foreman master show`）直接说话。
  首次用 `foreman master create --title "Foreman"` 创建；provider 选
  **Foreman (control plane)**。所有任务结果和细节都在这里问。
- **Dashboard / CLI（运维备用）**：打开 `http://127.0.0.1:3777`，或在另一个终端执行
  `foreman add ...` / `foreman status`。

Dashboard 是可选的。关掉 `foreman up` 后任务不会继续推进；重启后 daemon 会按
thread id reattach。关掉 T3 则 worker thread 也会消失。macOS 需要 24/7 常驻时，
用 `foreman service` 安装 launchd，并让 T3 也保持运行。

同一个 data 目录不要启动两个 `foreman up`，pid lock 会拒绝第二个实例。

## 核心概念

| 概念 | 说明 |
| --- | --- |
| Task ledger | 每个任务、attempt、租约、事件、inbox、对话都落 SQLite。 |
| Lease + heartbeat | running 任务必须持续证明存活；静默不是成功。 |
| Completion inbox | 终态批量推给 leader，不靠对话记忆轮询。 |
| State card | 有界的确定性状态卡，所有界面共用。 |
| Completion contract | 可选的 token / artifact / marker / git diff 完成证明。 |
| Project registry | `web`、`api` 等项目名映射到本地路径和 adapter。 |
| Worker mode | 本地/远程 worker 用独立可撤销 token claim 任务。 |
| Native lineage | 主控 → T3 child thread（`parentThreadId` + `subagent`）。 |

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `foreman init` | 初始化向导，写 `foreman.config.json`。 |
| `foreman up` | daemon + leader + 面板。 |
| `foreman add` / `cancel` / `retry` / `resume` | 管理任务。 |
| `foreman status` / `ask` | 状态卡 / 一轮 leader 对话。 |
| `foreman master ...` | 绑定和测试 T3 主控线程。 |
| `foreman project ...` | 管理项目注册表。 |
| `foreman worker ...` | 注册、运行、drain、revoke、安装 worker。 |
| `foreman doctor` | 检查 Node、T3、provider、数据库、端口和认证。 |
| `foreman backup` / `compact` | 在线备份 / 清理历史。 |
| `foreman service` | 生成 macOS launchd 常驻服务。 |

完整命令和 flag 见 [Commands](docs/commands.md) 与
[配置](docs/configuration.md)。

## 模型与 effort

任务可以单独指定模型和思考等级；不指定时 leader 按难度选择 fast /
standard / deep / coding 四档。你也可以在 FC 里按用途分配模型，例如“探索用
X、修复用 Y、默认用 Z”；Foreman 会按 master 持久化 `workerModelRoutes`，并把
当前主 Run 的 provider/model/effort 和路由表告诉 leader。路由始终带 provider，单次
任务可用 `modelOverride` 覆盖。需要硬锁时才使用 `forceModel` / `forceProvider`。

DimAgent 下默认：

```bash
foreman add "审查支付回调" \
  --brief "重点看并发和幂等" \
  --model dimcode-api-oauth/gpt-6.2-astra \
  --effort max
```

控制面会把每个任务的最终 target plan（provider/model、实际 reasoning
option/value、来源和 catalog revision）持久化并传给 worker，worker 不会用
另一份 T3 cache 重新猜模型。需要跨 provider 分档时使用 `modelTiers`。

切换 provider 时请显式设置 `modelFast`、`modelStrong`、`modelCoding`。
provider/model 身份和 reasoning option id 会从 T3 catalog 解析；同一个裸
model 名被多个 provider 声明时会拒绝，而不是按字符串前缀猜 provider。
`t3ReasoningOption` 只在 catalog 不可读时作为 fallback。Dashboard 新增了
**模型分工** 面板：显示当前主 Run 的
provider/model/effort/project，按 T3 catalog 快照校验路由，可为
`default` / `light` / `standard` / `deep` / `coding` 指定模型，并支持一键
“全部用当前 Run”。无效目标会在任务启动前提示。详见
[模型与 effort](docs/models-and-effort.md)。

## 文档

- [文档索引](docs/README.md)
- [快速开始](docs/quickstart.md)
- [核心概念](docs/concepts.md)
- [配置](docs/configuration.md)
- [原生 Lineage](docs/native-lineage.md)
- [模型与 effort](docs/models-and-effort.md)
- [Worker](docs/workers.md)
- [安全](docs/security.md)
- [排障](docs/troubleshooting.md)
- Recipes：[调研](docs/recipes/research.md) ·
  [修代码](docs/recipes/code-fix.md) ·
  [审查](docs/recipes/review.md) ·
  [查实时信息](docs/recipes/current-info.md)

## 安全

Foreman 是本地优先、但权限很高的软件：它能启动会改代码、联网的 Agent。

- 尽量收窄 `allowedProjectRoots`。
- 不要把面板裸奔到公网；远程访问必须加 TLS 和 bearer token。
- 远程 worker 使用独立 token，用完 revoke。
- 不要提交 `foreman.config.json`、token 或数据目录。
- leader 的动作等同于执行代码；无人值守和 destructive 路径要单独审查。

见 [SECURITY.md](SECURITY.md) 与 [安全文档](docs/security.md)。

## 状态

Foreman 目前是 **alpha**。账本、租约、重试、完成契约、mock/T3 adapter、
面板、worker 模式和原生 Lineage 均已实现并有测试覆盖；真实 T3 + DimAgent
路径已在维护者机器上端到端验证。

已知限制和路线图见 [docs/README.md](docs/README.md#status-and-limits) 和
[Issues](https://github.com/Simon-He95/foreman/issues)；版本记录见
[CHANGELOG.md](CHANGELOG.md)：

- 一个 SQLite 账本只支持一个控制面，暂无 HA
- worker 传输是 HTTP，需要自带 TLS
- 还没有预算/额度限制
- T3 完成状态仍是轮询，后续接 MCP events/webhooks
- 主控通知是 T3 里的 user 消息，不是系统通知

## 参与贡献

欢迎 Issue 和 PR。先读 [CONTRIBUTING.md](CONTRIBUTING.md)，提交前运行
`npm test`。

## License

[MIT](LICENSE) © 2026 Simon He
