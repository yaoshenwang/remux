# Remux Next 全端 AI 原生工作空间平台总规划（2026 重制版）

**版本**：1.1（追加最小可执行单元 Checklist）  
**基线**：当前 remux 主仓库、现有 docs 与 OpenGuild 附件重制  
**日期**：2026-03-29

> 本文档的目标不是继续讨论方向，而是直接给出一份可落库、可建 issue、可开工的主规划。

# 文档目的

这不是一份“方向感很强但还要再拆三轮”的战略稿，而是一份直接面向当前 `yaoshenwang/remux` 主仓库的**产品—架构—执行一体化总规划**。  
它要解决三个问题：

1. **统一战略**：把当前仓库已经发生的 runtime 独立化、Inspect 化、移动优先化，与未来你想要的全端、原生桌面、原生移动、AI-native workspace、类 IM 协作界面，收敛成一个单一叙事。
2. **统一边界**：明确哪些旧规划仍然有效，哪些要被归档，哪些要被升级为新的主干。
3. **统一执行**：给出到模块、协议、目录、里程碑、Epic、验收标准级别的落地方案，使团队拿到就能开工。

# 先给结论

Remux 不应该继续被定义成“远程 tmux / zellij 控制器的升级版”，也不应该直接跳成“聊天软件 + AI 插件”的拼装体。  
新的唯一正确定位是：

> **Remux 是一个全端的 AI 原生工作空间操作系统。**
>
> 第一阶段，它是 terminal-first work 的 remote workspace cockpit。  
> 第二阶段，它是比 Claude Desktop / Codex app 更强的 agentic workstation。  
> 第三阶段，它演进成 Topic-first、Agent-first、Artifact-first 的类 IM 协作操作系统。

这三阶段不是三个项目，而是一条连续演进链：

- **Phase A：Runtime Cockpit** —— 做强 runtime、Inspect、移动连接、原生桌面基础。
- **Phase B：Agentic Workstation** —— 做强桌面旗舰、工作树、Diff/Review、Multi-agent、审批与自动化。
- **Phase C：Collaboration OS** —— 在已经成熟的 runtime 与 agent 能力之上，长出 Topic、Message、Artifact、Inbox、Workspace Timeline、World/Visualization，最终形成类 IM 的协作主界面。

这个顺序是必须的。  
因为如果没有 runtime 真正独立、Inspect 真正可信、移动与桌面真正像原生，那么后面的 IM 外壳只会把复杂度前置，而不会形成产品壁垒。

# 1. 当前仓库现状与为什么旧计划已经不够用

## 1.1 当前仓库已经发生的关键转向

当前主仓库的 README 与 docs 已经把 Remux 定义成 **remote workspace cockpit for terminal-first work**，核心表面是 **Inspect / Live / Control**，并且明确把 `runtime-v2` 设为默认产品路径，旧的兼容层只是临时过渡，而不再是产品叙事中心。[S1][S2]

仓库层面也已经形成了两条真实主干：

- **Rust runtime / server core**：`apps/remuxd` 与 `crates/remux-*` 已经覆盖 auth、protocol、session、pty、terminal、inspect、store、server 等核心模块。[S5][S9]
- **TypeScript product shell**：当前发行入口仍然是 npm 包与 React/Vite Web 应用，CLI、Web、测试与截图门禁都围绕它工作。[S1][S9][S10]

同时，当前 docs 已经把很多你最近重构的真实意图写出来了：

- Remux 不是 generic web SSH client，也不是 thin wrapper around multiplexer。[S1][S2]
- 核心排序是 **awareness > comprehension > intervention**，而不是“先还原一个重终端”。[S2]
- `Scroll` 必须升级为 **Inspect**，并且历史数据必须带 `scope`、`source`、`precision` 这样的真实性标签。[S2]
- 原生客户端路线在现有文档里仍然是 **iPhone-first**，并允许第一版先用 `WKWebView + xterm.js` 嵌入终端，但长期目标是可信设备连接、配对、重连、通知与多端协议。[S3][S4]
- Runtime V2 已经明确了 `Session / Tab / Pane / WriterLease / RecordingSegment / PaneHistory / TabHistory / SessionTimeline` 这套实现词汇，并通过 ADR 固定了**单 pane 单活跃 writer lease**与**先元数据、后丰富恢复**的持久化策略。[S5][S7][S8]

## 1.2 为什么仓库里的旧规划已经不够用了

旧 docs 的问题不在于“错”，而在于它们的作用域已经变窄：

1. **它们主要解释“如何把 Remux 从旧后端关系里剥出来”**，但没有回答“剥出来之后到底要长成什么超级产品”。
2. **它们对原生端的目标还偏保守**，更像“把手机端接上来”，而不是“做出比 Termius / Remodex 更强的移动产品”。
3. **它们没有把桌面旗舰当成第一等产品**，而你现在的要求已经是：桌面端必须在功能上正面对标甚至超越 Claude Desktop 与 Codex app。
4. **它们没有吸收你上传附件里关于 Topic、Multi-agent、Workspace Visualization、Artifact 化协作的长期产品观**。
5. **旧附件里的服务端技术方向以 Go/并发为主**，但你已经明确说明：本轮规划要优先尊重当前仓库现实，重点吸收其可视化、多 agent、workspace 理解，而不是机械继承那套服务拆分。

## 1.3 新的主定义

新的总定义必须同时尊重三件事：

- **尊重现有仓库现实**：runtime-v2、Inspect、Rust core、TS Web shell、设备层与 semantic adapter 思路已经成型。
- **尊重你新的产品要求**：全端、原生桌面旗舰、原生移动连接、最终类 IM 化。
- **尊重长期壁垒**：Remux 的最终护城河不是“能开一个远程终端”，而是“把运行中的工作空间、Agent、Artifact、决策、审批与协作上下文统一可视化”。

因此，新定义如下：

## 1.4 Remux 新定义

**Remux = 全端 AI 原生工作空间操作系统。**

它由三层能力组成：

| 层 | 作用 | 说明 |
|---|---|---|
| Runtime Layer | 真实运行层 | 独立 runtime、PTY、session/tab/pane、writer lease、recording、inspect、timeline |
| Agentic Work Layer | 智能执行层 | adapters、agents、skills、worktrees、review、approvals、automation、memory |
| Collaboration Layer | 协作外壳层 | topic、message、artifact、inbox、workspace timeline、visual world、team presence |

三层的优先级是：**先做稳 Runtime，再做强 Desktop/Mobile，再长出 Collaboration Shell**。

## 1.5 不做什么

新规划明确不做以下事情：

- 不再回到“兼容 tmux / zellij 行为细节”作为主路线。
- 不把浏览器 UI 当成最终桌面旗舰。
- 不把任何单一 AI runtime（例如 Codex 或 Claude Code）变成产品的唯一身份。
- 不为了“类 IM”叙事而提前做重多人协作基础设施，导致 runtime 与 native 体验失血。
- 不把 World / Pixel 视图做成早期主界面；早期优先做**真正有生产力价值的 agent board / topic board / runtime topology / timeline**。
- 不在当前阶段引入大规模服务重写，只为了满足“看起来像企业架构”的幻觉。

# 2. 北极星目标与必赢标准

## 2.1 五个非谈判目标

### 目标 A：必须全端

Remux 必须有官方支持的：

- Web
- macOS
- Windows
- Linux
- iOS（含 iPhone / iPad）
- Android
- CLI / Headless self-host entry

不是“理论可支持”，而是都在同一主仓库、同一协议、同一质量门禁之下。

### 目标 B：终端产品力必须超过 Ghostty / Termius

Ghostty 的强项是平台原生 UI、GPU 渲染、窗口 / 标签 / 分屏、快速终端与平台集成；Termius 的强项是跨端 SSH / SFTP / Mosh、凭据与主机同步、Vault、多端共享、Session logs、多人终端协作。[S10][S11]

Remux 不能只在其中某一项上比它们好，而必须给用户一种更强烈的感受：

> “Ghostty / Termius 提供的是终端或远程连接工具；  
> Remux 提供的是可理解、可干预、可协作、可跨设备延续、可接入 Agent 的工作空间本身。”

### 目标 C：桌面端必须正面对标 Claude Desktop / Codex app

Claude Desktop 已经把 visual diff review、app preview、parallel sessions with Git isolation、Dispatch from phone、connectors、computer use 等桌面级 agent 工作流做成了产品；Codex app 则已经具备 multi-project、skills、automations、worktrees、built-in Git、integrated terminal 与 cloud/local/worktree 模式。[S12][S13]

Remux 桌面旗舰不能只是“也有一个聊天框 + 终端 + diff”。  
必须做到：

- 更多运行时真相（runtime truth）
- 更强跨设备连续性（desktop ↔ mobile ↔ web）
- 更强多 agent 可视化
- 更强 topic / artifact / review 绑定
- 更强自托管与多 runtime 兼容
- 更强团队级审计与审批能力

### 目标 D：手机端连接必须堪比原生，至少达到 Remodex 级别

Remodex 已经把 iPhone 远控做到了很高水位：端到端配对、QR bootstrap、trusted reconnect、plan mode、subagents、运行中 steer、follow-up queue、推送通知、Git 操作、reasoning controls、live streaming、shared thread history。[S14]

Remux 移动端至少要做到这些；真正的目标是进一步叠加：

- Inspect / Live / Control 三层切换
- Diff mini-review
- Topic / Artifact / Approval 深链
- 运行时 topology 与 agent board
- 多 runtime / 多 adapter 支持，而非只服务一个 runtime 品牌

### 目标 E：最终界面要类 IM，但本质是 AI-native workspace OS

最终界面可以像 IM，但其内部结构不能是 Slack/Discord 的思维复刻。  
真正的一等对象应该是：

- Topic
- Agent
- Artifact
- Run
- Review
- Approval
- Memory
- Timeline
- Runtime context

Message 只是入口，不是终点。

## 2.2 对标基线与反超策略

| 对标对象 | 官方强项 | 我们必须反超的点 | Remux 对应策略 |
|---|---|---|---|
| Ghostty | 原生 UI、GPU 渲染、窗口/标签/分屏、平台集成、搜索与滚动体验。[S10] | 不能只做“另一个终端”；必须把 runtime truth、Inspect、跨设备、agent 叠加成更高维工作空间。 | 原生桌面壳 + runtime-native inspect + multi-device continuity + agent/workspace board |
| Termius | SSH/Mosh/Telnet/SFTP、多端同步、Vault、多人终端、session logs、硬件密钥。[S11] | 不能只输在连接管理；要把连接之外的“理解、审批、记忆、执行”做出来。 | 主机/运行时目录、设备信任、共享日志、inspect timeline、topic/approval/memory |
| Claude Desktop | Visual diff、app preview、computer use、PR monitoring、Dispatch、connectors、parallel sessions。[S12] | 不能是单 AI 产品的外围壳；要更强多 runtime、多 agent、跨端接力、可审计。 | Multi-agent board、runtime adapters、native review center、mobile deep handoff |
| Codex app | Multi-project、skills、automations、worktrees、built-in Git、integrated terminal、cloud/local/worktree 模式。[S13] | 不能只抄 worktree；要把 worktree 与 runtime、topic、approval、inspect 合一。 | Worktree manager + diff/review + runtime timeline + artifact/topic binding |
| Remodex | iPhone 远控、可信重连、运行中 steer、follow-up queue、subagents、git actions、live streaming。[S14] | 不能只做类似功能；要做成多 runtime、全端、可视化更强的移动主控台。 | Native mobile command center + inspect/live/control + approvals + diff + agent board |

## 2.3 成功定义（北极星）

北极星指标不是 DAU，也不是“用户发了多少条消息”，而是：

> **每周被 Remux 成功观测、理解、干预并推进的有效工作空间单元数。**

把它拆成产品可监控指标：

1. 移动端**理解当前状态时间**（Time to Understand Current State）
2. 不进入 Live 的情况下找到目标上下文的成功率
3. 从通知到完成一次审批 / 干预的时延
4. 单个工作空间可并行运行的 agent / worktree 数
5. 工作空间中可回放、可审计、可恢复的运行比例
6. Topic / Run / Artifact 绑定率
7. 从桌面发起、在移动端收尾、再回到桌面的跨端连续性成功率

## 2.4 体验底线

以下体验底线必须写进质量门禁，而不是“未来优化”：

- 手机首次 attach 不超过 10 秒（冷启动 + 远程网络）
- 已配对设备重连不超过 3 秒（同网络质量下）
- Inspect 首屏必须比 Live 更快、更稳、更可读
- 任意 agent run 都必须可见当前状态、当前上下文、当前资源边界
- 任意副作用操作都必须可审批、可取消、可追责
- 桌面端任何核心流程都不得强迫用户回到纯终端完成
- Web 必须全局可用，但桌面端必须是旗舰，不得被 Web 绑死

# 3. 总体路线：三次跃迁，一条主线

## 3.1 Phase A：Runtime Cockpit（现在到 3 个月）

这阶段的任务不是“加功能”，而是**做实身份**：

- runtime-v2 成为唯一真主干
- `Scroll` 全面升级为 `Inspect`
- history/inspect truth model 固定
- device trust / pairing / relay 打底
- iOS / Android / macOS / Windows / Linux 客户端骨架建立
- Web 从“唯一 UI”降级为“通用入口 + 最快迭代入口”
- 原生客户端拿到稳定 contract

**阶段成功标志：**  
一个用户能从手机、桌面、浏览器三端访问同一个 runtime 工作空间，并且在手机端真正读懂、在桌面端真正改动、在浏览器端真正管理。

## 3.2 Phase B：Agentic Workstation（3 到 9 个月）

这阶段让 Remux 从“远程工作空间 cockpit”变成“桌面级 agent 工作站”：

- 桌面旗舰应用上线（macOS first，Windows/Linux 紧跟）
- worktree / branch / diff / review / preview / Git actions 完整打通
- semantic adapter 从 generic shell 扩展到至少两个深度 adapter
- run log、approval、skill、automation、budget、memory 进入一等界面
- 移动端支持 plan / steer / queue / subagent / quick review

**阶段成功标志：**  
用户可以完全在 Remux 桌面端驱动多个 agent 并行工作，检查 diff、审查输出、做审批、从手机接管或收尾，而不需要把主流程让位给 Claude Desktop / Codex app。

## 3.3 Phase C：Collaboration OS（9 到 18 个月）

这阶段让 Remux 从“个人 / 小团队工作站”长成“Topic-first 协作系统”：

- Workspace / Project / Topic / Message / Artifact / Inbox / Handoff
- Topic 与 runtime、agent、artifact、review 深度绑定
- Multi-user presence、team permissions、audit、search、memory
- World / Visualization 从 agent board、topic board、runtime topology 发展到空间化视图
- 最终界面呈现类 IM 形态，但底层仍然是 AI-native workspace graph

**阶段成功标志：**  
团队可以不把“讨论在 IM、执行在 IDE、Agent 在另一个 App、审批在 GitHub、追溯在日志系统”分散到五个工具中。

## 3.4 顺序为什么不能反

如果先做 IM 再补 runtime，会出现三个灾难：

1. UI 看起来很完整，但执行面是空心的。
2. Agent 仍然只能做“聊天中的回答者”，无法成为可观测的执行成员。
3. 移动与桌面的核心护城河都被稀释。

所以路线必须是：

1. **先做 Runtime truth**
2. **再做 Native surfaces**
3. **再做 Agent work layer**
4. **最后把它们收进 Collaboration shell**

# 4. 核心域模型：三平面统一，而不是一锅炖

## 4.1 三个平面

### A. Runtime Plane（运行时平面）

负责真实执行与真实上下文：

- RuntimeInstance
- RuntimeSession
- RuntimeTab
- RuntimePane
- WriterLease
- RecordingSegment
- PaneHistory
- TabHistory
- SessionTimeline

### B. Intelligence Plane（智能平面）

负责 AI 执行与解释：

- Agent
- Skill
- ToolBinding
- Run
- RunStep
- Approval
- MemoryScope
- SemanticEvent
- Adapter
- BudgetPolicy

### C. Collaboration Plane（协作平面）

负责团队、主题、产物与追踪：

- Workspace
- Project
- Topic
- Message
- Artifact
- Review
- Decision
- Task
- InboxItem
- Handoff
- VisualizationNode

## 4.2 一个关键命名决策：把当前 runtime 的 Workspace 改名

当前 docs 中 Runtime V2 把顶层叫 `Workspace`，但未来类 IM 产品一定也会有真正的 `Workspace`（组织/团队/项目容器）。[S5]

为了避免后续语义冲突，**现在就应该决定**：

- 当前 runtime 顶层协议对象从 `WorkspaceSnapshot` 逐步迁移为 **`RuntimeSnapshot`**
- 当前 internal workspace semantics 仅在 runtime 内部保留
- 对外产品层的 `Workspace` 专门保留给协作空间语义

这是一个必须现在就做的命名清洗，否则后续 Topic / Artifact / Workspace 上线时会全线混乱。

## 4.3 统一关系模型

下面这条链，是未来 Remux 的最重要主链：

```text
Workspace
 └─ Project
     └─ Topic
         ├─ Messages
         ├─ Artifacts
         ├─ Agent Runs
         ├─ Reviews
         ├─ Approvals
         └─ Linked Runtime Context
             └─ RuntimeSession
                 └─ RuntimeTab
                     └─ RuntimePane
```

解释：

- **Topic** 是协作上下文单元。
- **RuntimeTab** 是执行上下文单元。
- 一个 Topic 可以绑定一个或多个 RuntimeTab / Run / Artifact。
- 一个 RuntimeTab 可以被挂到某个 Topic，也可以暂时游离。
- 消息不是终点，而是生成 Artifact / Run / Approval 的入口。

## 4.4 真相模型（Truth Model）

必须严格区分以下五种状态：

| 层 | 含义 | 示例 |
|---|---|---|
| Runtime Truth | runtime 实际状态 | 当前 pane 活着、writer lease 在谁手上 |
| Client View | 某个客户端当前关注状态 | 这个 iPhone 当前盯着 tab-2 |
| Inspect Truth | 已捕获可阅读历史 | 某 tab 最近 5,000 行聚合记录 |
| Semantic Inference | 基于 runtime / adapter 推导出的解释 | “这个 run 正在做 PR review” |
| Collaboration State | Topic / Artifact / Approval 等团队对象 | 当前 topic 等待审批 |

任何 UI 上的对象都必须标出它属于哪一层。  
不要再把“推断”“缓存”“本地视图”伪装成“真实状态”。

## 4.5 精度与来源标签要继续升级

当前 docs 只要求 `precise / approximate / partial`，以及 source 字段。[S2]  
新的系统要把它扩成：

- `precise`
- `approximate`
- `partial`
- `inferred`
- `stale`

以及来源：

- `runtime_recording`
- `runtime_snapshot`
- `tab_aggregator`
- `adapter_event`
- `local_cache`
- `topic_projection`
- `manual_annotation`

这样之后 IM shell 与 agent board 才不会讲假话。

## 4.6 新的一等对象

未来 UI 中的一等对象必须是：

1. Runtime
2. Topic
3. Agent
4. Run
5. Artifact
6. Review
7. Approval
8. Timeline

不是 Channel，不是 Message，不是 Pane 列表本身。

# 5. 产品体验蓝图

## 5.1 七个核心视图

未来所有端共同围绕以下七个视图构建：

1. **Inspect**：阅读、追赶、理解、检索、复制
2. **Live**：终端直接输入与低延迟操作
3. **Control**：session/tab/pane/worktree/agent 结构化控制
4. **Review**：diff、comment、artifact、approval、PR 状态
5. **Agents**：agent roster、run cards、budget、tool use、state
6. **Topics**：类 IM / topic timeline / artifact rail / decision view
7. **Command Center**：跨 runtime、跨 project、跨 topic 的总控台

## 5.2 Desktop Shell：真正的旗舰界面

桌面端必须是一个**工作空间操作台**，不是一个“聊天窗口附带终端”。

推荐默认桌面布局：

```text
┌─────────────────────────────────────────────────────────────┐
│ Top Bar: Workspace / Project / Search / Global Commands    │
├──────────────┬──────────────────────────────┬───────────────┤
│ Left Rail    │ Main Canvas                  │ Right Rail    │
│ - Projects   │ - Topic / Run / Review       │ - Agents      │
│ - Topics     │ - Inspect / Live / Diff      │ - Artifacts   │
│ - Runtimes   │ - Preview / Timeline         │ - Approvals   │
│ - Views      │                              │ - Context     │
├──────────────┴──────────────────────────────┴───────────────┤
│ Bottom Composer / Command Palette / Prompt / Quick Actions │
└─────────────────────────────────────────────────────────────┘
```

桌面端的关键不是“放更多面板”，而是做到：

- 在一个窗口里把**执行、审查、上下文、Agent、审批**串起来
- 真正支持多窗口、多工作区、多项目并行
- 不让用户在 IDE、终端、Agent App、浏览器、手机之间来回切主流程

## 5.3 Mobile Shell：一只手可用的 command center

手机端不是缩小版桌面，也不是浏览器套壳。  
它的产品逻辑应该是：

- 默认进入 **Now / Watchlist / Inbox**
- 第一屏看到“现在最重要的 3 件事”
- 所有高频操作都在两步内完成

推荐移动主导航：

- **Now**：当前关注的 runtime/topic/run
- **Inspect**：默认阅读界面
- **Runs**：agent runs / approvals / alerts
- **Topics**：最近 topic / handoff / inbox
- **Me**：设备、连接、信任、通知、收藏

移动端的关键诉求不是“完整”，而是：

- 远离电脑时知道发生了什么
- 必要时能即时干预
- 不被纯终端操作门槛困住

## 5.4 Web：通用入口，不是最终旗舰

Web 仍然必须保持很强，因为：

- 它是最快迭代入口
- 它是自托管最容易触达的面
- 它是分享、管理、调试、降级保障面

但从现在开始要明确写入产品规则：

> Web 是 universal access surface；  
> Desktop 是 flagship creation surface；  
> Mobile 是 flagship intervention surface。

也就是说：

- Web 全功能可用
- 但桌面与移动必须分别拥有“更强的原生能力包”
- 不允许因为 Web 实现快，就永远让 Web 成为最终体验上限

## 5.5 最终类 IM 形态应该长什么样

最终形态不是 Slack 风格复制品，而是：

- 左侧是 Workspace / Project / Topic
- 中间是 Topic timeline（消息、run、artifact、decision 混合流）
- 右侧是 Runtime / Inspect / Agent / Approval / Artifact context
- 底部是 prompt/composer/command bar
- 顶部是 workspace-wide search / handoff / overview
- 可切换到 World / Graph / Agent Board / Runtime Topology 视图

也就是说，**Message 是 timeline 的一种 item，Run / Approval / Review / Artifact 也是**。  
这样才能真正做到“聊天 = 执行入口”，而不是“聊天完了去别处执行”。

## 5.6 五条核心用户旅程

### 旅程 1：从手机追赶当前 tab

1. 收到通知：某个 run 完成或需要注意
2. 点开进入对应 runtime + tab + topic
3. 默认展示 Inspect
4. 看见 precision / source / capturedAt
5. 必要时切 Live 做干预
6. 退出前将该上下文 pin 到 Watchlist

### 旅程 2：在桌面并行跑多个 agent

1. 选择 project
2. 基于不同 worktree 启动多个 run
3. 每个 run 显示 branch / diff / current tool / current file / approval state
4. 桌面中控台统一查看
5. 批量审查、批量批准或暂停

### 旅程 3：把一个 runtime 任务升级成 topic

1. 某 pane 长时间运行并产生重要结果
2. 用户一键“Create Topic from Context”
3. 系统自动挂接 inspect snapshot、run summary、相关 artifact
4. 后续消息、review、approval 全部进入该 topic

### 旅程 4：桌面发起，手机收尾

1. 在桌面发起 run 或 review
2. 离开电脑
3. 手机收到进度 / 审批 / 错误通知
4. 手机查看 inspect、做 quick review、给 approval
5. 回到桌面继续深处理

### 旅程 5：团队 handoff

1. Topic 进入 waiting/handoff
2. 系统生成 digest
3. 下一时区成员打开 Topic
4. 60 秒内理解当前状态、阻塞点、下一步、相关 runtime context
5. 直接接管 run 或切换到 Live

# 6. 全端客户端规划

## 6.1 平台策略：同一协议，不同旗舰

### 统一原则

- 所有客户端共享同一协议、同一 contract fixtures、同一 capability model。
- 允许不同平台在 UI 与系统集成上各自发力。
- 不允许“某平台只能靠品牌判断或隐藏接口工作”。

### 能力分层

| 层级 | 含义 |
|---|---|
| Common Parity | 所有端都必须有：连接、Inspect、Live、Control、Runs、Approvals、Topics 基础能力 |
| Flagship Parity | 桌面或移动旗舰必须更强：原生集成、diff/review、push、handoff、offline cache |
| Platform Advantage | 某平台专属：menu bar、Live Activities、Windows toast、Android widgets 等 |

## 6.2 Web 规划

### 定位

- 通用入口
- 自托管默认面
- 快速迭代实验面
- 管理 / 分享 / 调试面

### 技术路线

由于当前主仓库已经采用 React 19 + Vite 8 + TypeScript，并且你刚做过大重构，所以**Web 主产品面应继续沿用现有技术栈**，而不是为了“看起来更企业”切到另一套 Web 框架。[S9]

建议：

- 保留现有 React + Vite 主应用
- 逐步补入路由、状态与 design system 的清晰边界
- 若未来需要官网 / 文档 / marketing site，再单独建站，不污染主产品壳

### 必须完成的 Web 能力

- 全协议可视化调试
- 全 surfaces 可用
- Desktop / Mobile 的降级兼容面
- Team mode 管理台
- Topic / Agent / Artifact / Approval 全视图
- Storybook / screenshot regression / visual diff

## 6.3 macOS 规划（第一桌面旗舰）

### 定位

- 第一桌面旗舰
- 最强本地集成面
- 多窗口、多项目、多 agent 操作台
- 对标并超越 Claude Desktop / Codex app 的首个主战场

### 技术路线

- SwiftUI + AppKit 混合
- 本地 SQLite / CoreData 或 GRDB（二选一，推荐 GRDB）
- `remuxd` 本地 helper / daemon
- 通知中心、菜单栏、快捷键、Finder 集成、Quick Look、拖放

### v1 终端策略

- 允许第一版使用**原生壳 + 嵌入终端 surface**的方式交付
- 终端 surface 可以先复用现有 xterm 能力，但必须被 native shell 包裹
- 同时立项“native terminal renderer feasibility spike”，验证 IME、滚动、选择、GPU、性能与 accessibility

### v2 目标

- 本地终端体验达到原生级
- diff/review/preview/agent board 全部是桌面一等体验
- menu bar quick attach / quick approve / quick inspect

## 6.4 Windows 规划

### 定位

- 桌面旗舰第二优先级
- 面向 Windows 开发者与混合办公用户
- 重点是“真正可用”，而不是跟 macOS 一模一样

### 技术路线

- WinUI 3
- WebView2 作早期终端嵌入
- 本地 helper 与通知使用 Windows 原生机制
- 与 Git / PowerShell / ConPTY 相关联的本地集成能力独立封装

### 核心要求

- 任务栏通知与 Jump List
- 原生文件选择、拖放、剪贴板与系统代理
- system tray / background helper
- 桌面级 diff / review / agent board 不能缺席

## 6.5 Linux 规划

### 定位

- 开发者与自托管重度用户的重要阵地
- 必须真原生支持，而不是“理论可以运行”

### 技术路线

- GTK4 / libadwaita
- Rust 优先
- systemd user service 支持
- 本地数据缓存与 portal 集成

### 核心要求

- 本地守护进程启动与连接
- 桌面通知
- 文件拖放
- 插件 / self-host / relay 调试友好
- 不牺牲 Inspect 可读性与键盘流效率

## 6.6 iOS 规划（第一移动旗舰）

### 定位

- 第一移动旗舰
- 不只是“远程看终端”，而是“口袋里的 command center”
- 对标并超越 Remodex 与 Termius mobile 的主战场

### 技术路线

- SwiftUI
- 首版可采用 `WKWebView + xterm.js` 作为终端 rendering bridge，与当前 iOS bootstrap contract 保持一致。[S4]
- Keychain 存储配对与设备凭据
- APNs、Live Activities、Share Sheet、Camera/Photos、Biometric lock

### iOS 必须具备的产品能力

- QR pairing
- trusted reconnect
- push notifications with deep links
- Inspect first
- Live intervention
- quick approvals
- plan mode
- follow-up queue
- steer active run
- subagent invocation
- diff mini-review
- Git quick actions
- voice dictation
- photo/file attachment
- offline snapshot cache

## 6.7 Android 规划

### 定位

- 与 iOS 同级，不是补充平台
- 面向更广覆盖与重度移动用户

### 技术路线

- Kotlin + Jetpack Compose
- 终端早期可用 WebView / xterm bridge
- FCM、Foreground Service、Widgets、Share Intent、Biometric prompt

### 必须完成的能力

- 与 iOS 同级的 pairing / reconnect / notifications / Inspect / quick actions
- Android 特有的前台服务保活与通知动作
- widget 化 quick attach / quick approve / quick inspect

## 6.8 iPad 不是放大版手机

iPad 归属 iOS 体系，但产品策略单独定义：

- 双栏或三栏布局
- Split view 与 side-by-side Inspect/Live
- Apple Pencil 批注 diff / artifact
- 接键盘时接近桌面模式

## 6.9 CLI / Headless 仍然保留

`npx remux` 不能消失，因为它是最关键的冷启动入口。[S1][S9]

但它的职责要重新定义为：

- 最快安装方式
- 本地 runtime 启动器
- Web/relay bootstrap
- native apps 的配对与附着入口
- CI / demo / headless mode

它不应该再是“最终用户唯一主界面”。

# 7. 桌面旗舰能力包（超越 Claude Desktop / Codex app）

## 7.1 桌面旗舰必须有的十二个能力

1. 多 project / 多 runtime / 多 worktree 并行
2. 可视 diff / chunk-level review / inline comments
3. run board：同时看多个 agent 的状态、预算、分支、文件、工具
4. preview 面板：本地 dev server / screenshot / app preview
5. topic 绑定：把任一 run、review、artifact 挂到 topic
6. approval center：副作用操作统一审批
7. integrated terminal，但不再是唯一主视图
8. unified search：代码相关 + topic + run + artifact + inspect
9. system notifications + background tasks
10. 从手机 Dispatch / Handoff 进入桌面同一上下文
11. connector / skill / adapter 管理
12. 本地 helper + remote runtime 混合模式

## 7.2 必须比 Claude Desktop 更强的地方

Claude Desktop 的强项已经很明确：visual diff、app preview、computer use、Dispatch、parallel sessions、connectors、scheduled tasks。[S12]

Remux 桌面必须更强在：

- **更强 runtime truth**：不只是对单一 agent session 的 UI 包装，而是 session/tab/pane/run/topic 多层真相统一。
- **更强多 agent board**：不是一个 session sidebar，而是真正的 workspace-wide agent operating board。
- **更强 topic / artifact integration**：所有执行结果都能自然落到协作上下文里。
- **更强自托管 / 多 adapter**：支持 Codex、Claude Code、generic shell，未来更多 runtime。
- **更强移动接力**：移动端不是“附加功能”，而是完整 command center。

## 7.3 必须比 Codex app 更强的地方

Codex app 现在已经有 built-in Git、integrated terminal、worktrees、automations、skills、多项目并行。[S13]

Remux 桌面必须更强在：

- **runtime independence**：不是绑定 Codex 线程模型
- **terminal-native inspect**：不是只有 thread + diff
- **multi-runtime orchestration**：同一桌面同时管理多个不同 adapter / shell / runtime
- **collaboration binding**：不只是代码任务，而是 topic、review、approval、artifact 统一
- **device continuity**：桌面与手机的 handoff 是主路径，不是附带

## 7.4 Review Center 详细规格

桌面端需要一个独立的一等视图：**Review Center**

它至少包含：

- commit / branch / worktree 列表
- file tree
- unified diff / split diff
- inline comment
- accept / reject / apply patch
- compare multiple agent proposals
- attach to topic / artifact / approval
- create PR / update PR / request review
- run tests and surface result inline

## 7.5 Agent Board 详细规格

Agent Board 是桌面旗舰的另一核心：

每个 Agent Card 显示：

- agent name / avatar / adapter
- current topic / current runtime context
- current run step
- current branch / worktree
- tool in use
- budget burn
- approval needed?
- blocked reason
- last update
- deep links: inspect / live / review / topic

Board 支持：

- group by project
- group by topic
- group by state
- filter by adapter
- bulk pause / bulk retry / bulk approve

## 7.6 桌面独占系统集成

### macOS

- menu bar quick attach
- global hotkey summon
- Finder / file drag-drop
- Quick Look / Share
- Dock badge / notification actions

### Windows

- toast actions
- Jump List
- tray
- native file system watchers

### Linux

- portal-safe file access
- systemd user service
- notification action buttons
- self-host / debugging deep visibility

# 8. 手机旗舰能力包（至少达到 Remodex 级，且更进一步）

## 8.1 移动产品定位

手机端不是“远程兜底”，而是：

> **离开桌面时仍然能够维持工作空间控制权的主控端。**

它要解决的是：

- 追赶上下文
- 快速批准
- 小步干预
- 运行中 steering
- 紧急修正
- 跨时区 handoff

## 8.2 必须匹配 Remodex 的能力

Remodex 已经验证了以下能力是真实有价值的：  
端到端配对、可信重连、plan mode、subagents、运行中 steer、follow-up queue、通知、Git 操作、reasoning controls、QR bootstrap、live streaming。[S14]

Remux 移动端必须一项不少：

1. QR pairing
2. trusted reconnect
3. live terminal streaming
4. plan mode
5. subagent invocation
6. steer active run
7. queue follow-up prompts
8. quick git actions
9. push notifications
10. reasoning / effort controls
11. shared history continuity

## 8.3 必须超过 Remodex 的能力

在匹配之后，Remux 移动端要继续做这七件事：

1. **Inspect / Live / Control 三分层明确**
2. **Diff mini-review 与 inline approval**
3. **Topic / Artifact / Approval 深链接**
4. **Runtime topology 小地图**
5. **Agent board 手机视图**
6. **Watchlist / Inbox / Handoff**
7. **跨 adapter 统一体验**

## 8.4 移动端主屏信息架构

### 首页（Now）

显示：

- 当前关注的 3 个 runtime / topic / run
- 正在等待我的审批
- 最近异常 / 完成 / blockers
- 快捷入口：Inspect、Live、Approve、Pause、Retry

### Inspect 页

支持：

- current tab history
- pane filter
- search in inspect
- copy
- source / precision badges
- topic links
- artifact links

### Runs 页

- active runs
- queued runs
- blocked runs
- approvals needed
- notifications feed

### Topics 页

- my inbox
- pinned topics
- handoff digest
- recent artifacts

## 8.5 移动连接架构

移动端连接必须支持四种模式：

1. **LAN direct**
2. **Private network direct（如 Tailscale）**
3. **Public relay**
4. **Foreground fallback / manual reconnect**

规则：

- 默认优先 trusted direct path
- public relay 不是唯一主路径
- 任何时候用户都能看见当前连接路径与安全等级

## 8.6 背景能力

### iOS

- APNs
- Live Activities
- background refresh
- deep links
- Keychain + biometrics

### Android

- FCM
- foreground service
- persistent notification controls
- widgets
- share intent / quick action

## 8.7 移动可靠性验收标准

- 首次配对成功率 > 95%
- 已信任设备 3 秒内自动恢复连接
- 通知点击后 2 步内进入相关上下文
- 运行中 follow-up queue 丢失率为 0
- 弱网下 Inspect 必须优先于 Live 成功打开

# 9. Runtime、Gateway、协议与存储规划

## 9.1 总原则：Rust 继续成为核心，TypeScript 继续成为产品壳与生态层

旧附件中偏 Go 的服务端拆分在今天已经不再是最优路径。  
当前仓库既然已经有成体系的 Rust runtime / protocol / server crates，就应该继续让 **Rust 成为核心控制平面与运行时核心**；同时保留 **TypeScript 作为 Web product shell、CLI bootstrap、生态适配与快速实验层**。[S5][S9]

新的语言分工建议如下：

| 层 | 主语言 | 说明 |
|---|---|---|
| runtime core / inspect / session / lease / recording / relay core | Rust | 当前已具备基础，适合继续加深 |
| web product shell / current CLI / admin / docs demo | TypeScript | 迭代快，保留现有资产 |
| adapters / plugin host / third-party integrations | TypeScript first, Rust optional | 生态接入与快速扩展 |
| native apps | Swift / Kotlin / C# / Rust GTK | 真原生，不搞统一壳幻觉 |

## 9.2 核心进程与服务划分

### A. `remuxd`（Runtime Core）

职责：

- session/tab/pane 生命周期
- PTY 管理
- writer lease
- recording segments
- inspect snapshots
- runtime event stream
- local persistence
- local API / ws / terminal endpoints

### B. `remux-gateway`（可先由现有 TS server 承担）

职责：

- auth bootstrap
- Web app serving
- pairing bootstrap
- device trust coordination
- relay coordination
- upload routing
- native/web client handshake
- topic/agent/collab projection（早期可渐进）

### C. `remux-relay`

职责：

- public relay / self-host relay
- connection metadata relay
- optional push handoff hooks
- connection presence

### D. `remux-indexer`

职责：

- inspect chunk indexing
- topic / artifact / run indexing
- semantic retrieval
- ACL-aware search

### E. `remux-adapter-host`

职责：

- generic shell adapter
- Codex adapter
- Claude Code adapter
- future tool adapters
- adapter health / capability reports

## 9.3 协议建议：保留双通道，但补齐域

当前 draft 已经提出双 WebSocket 通道与 domain-based envelope，是正确方向。[S6]  
建议把协议演进成以下域：

- `core/*`
- `runtime/*`
- `terminal/*`
- `inspect/*`
- `device/*`
- `semantic/*`
- `agent/*`
- `collab/*`
- `notifications/*`
- `admin/*`

统一 envelope：

```ts
interface RemuxEnvelope<T = unknown> {
  domain:
    | "core"
    | "runtime"
    | "terminal"
    | "inspect"
    | "device"
    | "semantic"
    | "agent"
    | "collab"
    | "notifications"
    | "admin";
  type: string;
  version: 1;
  requestId?: string;
  emittedAt: string;
  source: "runtime" | "gateway" | "adapter" | "client";
  payload: T;
}
```

## 9.4 关键消息族

### Core

- `core/hello`
- `core/authenticate`
- `core/authenticated`
- `core/error`
- `core/capabilities`

### Runtime

- `runtime/snapshot`
- `runtime/view`
- `runtime/select_session`
- `runtime/select_tab`
- `runtime/select_pane`
- `runtime/action_result`

### Terminal

- `terminal/attach`
- `terminal/data`
- `terminal/resize`
- `terminal/lease_state`
- `terminal/closed`

### Inspect

- `inspect/request_tab_history`
- `inspect/tab_history_snapshot`
- `inspect/request_pane_history`
- `inspect/pane_history_snapshot`
- `inspect/search`
- `inspect/page`

### Device

- `device/pairing_bootstrap`
- `device/trust_state`
- `device/reconnect_resume`
- `device/push_registration`

### Semantic / Agent

- `semantic/adapter_state`
- `semantic/event`
- `agent/run_created`
- `agent/run_updated`
- `agent/approval_requested`
- `agent/approval_resolved`

### Collab

- `collab/topic_snapshot`
- `collab/message_created`
- `collab/artifact_created`
- `collab/topic_bound_to_runtime`

## 9.5 Inspect 架构要成为真正的独立服务

当前 docs 已经提出显式 `HistoryService` 的必要性，这是必须继续推进的。[S2]

建议把 Inspect/History 拆成真正独立子系统：

### 模块

- `recording_ingest`
- `pane_snapshot_assembler`
- `tab_aggregator`
- `timeline_compactor`
- `search_indexer`
- `history_pager`
- `truth_labeler`

### 必须支持的三个 scope

1. Pane History
2. Tab History
3. Workspace Timeline（后续可拓成 Topic Timeline / Project Timeline）

### 必须支持的五类元数据

- `scope`
- `source`
- `precision`
- `capturedAt`
- `staleness`

## 9.6 Writer Lease 继续坚持单活跃写入者

当前 ADR 已经把单 pane 单活跃 writer lease 写死，这是对的，不要动摇。[S7]

之后所有产品面都要以此为前提设计：

- unlimited observers
- at most one interactive writer
- explicit handoff
- visible lease state
- approvals can request lease changes
- mobile default read-only unless user explicitly takes control

这会让跨端协作与移动干预更安全。

## 9.7 存储策略：分 Personal Mode 与 Team Mode

### Personal Mode（先做稳）

- SQLite：metadata
- local file store：recording segments / snapshots / attachments
- in-process index or lightweight full-text index
- optional encrypted device state

### Team Mode（后续扩展）

- PostgreSQL：workspace/topic/artifact/approval/agent metadata
- object storage：attachments / recordings / previews
- Redis / NATS：event fanout / jobs
- search index：OpenSearch / Tantivy sidecar / Meilisearch 任选其一
- vector retrieval：pgvector or dedicated vector store

关键原则：

> 第一阶段不要因为 Team Mode 需求，把 Personal Mode 的冷启动与可自托管复杂度做爆。

## 9.8 数据表 starter list

以下表建议在总体设计里固定名称与职责：

| 表 / 集合 | 作用 |
|---|---|
| `runtime_instances` | 运行实例元数据 |
| `runtime_sessions` | session 元数据 |
| `runtime_tabs` | tab 元数据 |
| `runtime_panes` | pane 元数据 |
| `writer_leases` | 当前写入租约 |
| `recording_segments` | 追加写片段索引 |
| `inspect_snapshots` | 可直接读取的快照 |
| `devices` | 已知设备 |
| `device_pairings` | 配对关系 |
| `relay_sessions` | 中继连接态 |
| `agents` | agent profile |
| `agent_runs` | run 头信息 |
| `agent_run_steps` | run step 细节 |
| `approvals` | 审批对象 |
| `topics` | topic 主对象 |
| `messages` | 消息 |
| `artifacts` | 任务/评审/决策/文件等产物 |
| `runtime_topic_links` | runtime 与 topic 绑定 |
| `notifications` | 推送与站内通知 |
| `search_chunks` | 检索分块 |
| `handoffs` | 跨时区 / 跨设备交接记录 |

## 9.9 Device Trust / Pairing / Relay

这是移动原生感的真正基础。

### 必须有的对象

- `device_id`
- `device_keypair`
- `trusted_peer`
- `pairing_session`
- `relay_session`
- `resume_token`
- `push_token`

### 连接策略

1. QR 首次配对
2. 建立 device trust
3. 存储恢复材料
4. 优先尝试 trusted reconnect
5. 失败后 fallback 到 relay discovery
6. 再失败再要求人工恢复

### 安全等级显示

UI 必须显示当前状态：

- direct trusted
- relay trusted
- relay untrusted bootstrap
- expired trust
- password fallback
- local only

## 9.10 Adapter Framework

坚持当前 docs 的判断：**semantic integrations are adapters, not the core identity**。[S3]

### 适配器层级

- `generic-shell`：永远存在的基线
- `codex`：第一深度 adapter
- `claude-code`：第二深度 adapter
- 未来其他 adapter：Cursor/Continue/自定义 agent runtime 等

### Adapter 三种模式

- `none`
- `passive`
- `active`

### 成功标准

- 第二个深度 adapter 上线前，不宣布 adapter architecture 稳定
- 任何 adapter-specific 类型不得出现在 runtime core
- 客户端只读 capability，不读品牌 hardcode

# 10. AI 原生能力规划

## 10.1 Agent 必须是第一等成员

Agent 不是“对话框里的机器人”，而是工作空间中的真实执行者。  
它必须有：

- identity
- adapter/runtime
- capabilities
- budget
- memory scope
- approval policy
- current context
- last output
- current tool
- current branch/worktree
- current topic
- current runtime link

## 10.2 Run 必须是核心对象

Run 至少要有：

- `run_id`
- `agent_id`
- `topic_id?`
- `runtime_context_id?`
- `status`
- `started_at`
- `updated_at`
- `current_step`
- `budget_spent`
- `approval_state`
- `artifacts_produced`
- `diff_summary`
- `logs_uri`
- `inspect_link`

## 10.3 Approval System

审批不是弹窗，而是对象系统。

### 需要审批的动作

- external message / comment / PR / issue write
- branch merge / force push
- secret access
- file delete / bulk file rewrite
- prod / staging environment mutations
- persistent memory writes
- team-visible artifact publishing

### 审批对象必须包含

- preview
- diff
- impacted files
- runtime context
- related topic
- requested by agent
- requested action
- rollback path
- expiry

## 10.4 Skills 与 Tools

Remux 的 skill 不应只是 prompt snippet，而应是：

- instructions
- tool set
- approval preset
- memory preset
- project bindings
- output contract
- optional UI affordance

## 10.5 Automation / Scheduled Runs

向 Codex app 和 Claude Desktop 对标，但比它们更强的点在于：

- automation 不只面向 code task，还面向 topic / artifact / runtime watch
- run 的输入输出天然挂接 topic 与 timeline
- scheduled runs 能被移动端看到、暂停、批准、复跑

## 10.6 Memory

Memory 分五层：

1. device-local session memory
2. runtime memory
3. topic memory
4. project memory
5. workspace memory

规则：

- 每层必须独立 ACL
- 每层都必须可见写入来源
- 长期记忆写入默认可审批
- search / citation 必须标来源层级

## 10.7 多 Agent 协作

多 agent 不只是在聊天里互相回复，而应支持：

- parallel runs
- dependency graph
- producer/consumer handoff
- reviewer/fixer pairing
- planner/executor split
- arbitration / conflict resolution
- shared topic / shared runtime / isolated worktree 三种协作模式

## 10.8 AI 原生但不神化 AI

产品原则必须写死：

- runtime truth 高于 semantic inference
- inspect truth 高于 agent summary
- approval 高于 autonomous side effect
- explicit capability 高于 marketing label

# 11. 类 IM 协作层规划（吸收 OpenGuild，但不机械照搬）

## 11.1 长期目标

长期来看，Remux 的主界面会越来越像 IM。  
但它不是从“聊天”起家，而是从“工作空间运行时”长出来的。  
这会让它和普通 IM 有本质差别：

- 聊天不是中心，**上下文与执行是中心**
- topic 不是线程修饰，而是主对象
- artifact / review / approval / runtime context 与 message 同级

## 11.2 Topic-first

Topic 是协作单元，不是频道里的可选标签。

Topic 首页必须展示：

- summary
- blockers
- decisions
- next actions
- linked runs
- linked artifacts
- linked runtime context
- participants / agents
- related files / PR / issue / branch

## 11.3 Message 只是 timeline item 的一种

Topic timeline 中应该混排：

- human message
- agent message
- run started / run updated / run finished
- approval requested / resolved
- review comment
- diff snapshot
- decision card
- task card
- runtime marker
- meeting summary
- handoff digest

## 11.4 Artifact-first

Artifact 一等化对象：

- Review
- Decision
- Task
- File
- PR / Issue
- Run Report
- Approval Record
- Handoff
- Meeting Summary

任何消息都能在两步内升级为 Artifact。

## 11.5 Inbox / Catch-up / Handoff

这三件东西必须从现在的 Inspect 思维自然长出来：

- **Inbox**：我相关但未处理的 topic/run/approval
- **Catch-up**：快速理解我离开期间发生了什么
- **Handoff**：跨设备、跨时间、跨成员接力

## 11.6 World / Visualization 的正确落地方式

本轮规划不建议一开始就重兵做 Pixel World。  
正确顺序应该是：

1. Agent Board
2. Topic Board
3. Runtime Topology
4. Timeline Graph
5. Presence Map
6. 再去做更空间化、更具视觉表达力的 World / Pixel 视图

也就是说，**先做生产力可视化，再做空间感可视化**。

## 11.7 Team Mode 的边界

多人协作真正上线前，必须先具备：

- identity / auth
- RBAC / policy
- audit
- topic ownership
- artifact ACL
- device trust
- adapter isolation
- run visibility boundaries

否则 Topic-first 与 Agent-first 会很快演变成权限灾难。

# 12. 仓库结构与工程策略

## 12.1 不建议立刻推倒重来，但要马上开始新骨架

当前 docs 已明确建议不要立刻为了 native roadmap 改造成巨大 monorepo，而应先稳定协议与模块边界，再扩充 multi-app layout。[S3]

这条建议仍然成立，但要升级成新的仓库结构目标：

```text
remux/
├─ apps/
│  ├─ remuxd/                 # Rust runtime core
│  ├─ web/                    # React/Vite 通用入口
│  ├─ macos/
│  ├─ ios/
│  ├─ android/
│  ├─ windows/
│  └─ linux/
├─ crates/
│  ├─ remux-auth
│  ├─ remux-core
│  ├─ remux-inspect
│  ├─ remux-observe
│  ├─ remux-protocol
│  ├─ remux-pty
│  ├─ remux-server
│  ├─ remux-session
│  ├─ remux-store
│  └─ remux-terminal
├─ packages/
│  ├─ protocol-schemas
│  ├─ sdk-ts
│  ├─ sdk-swift
│  ├─ sdk-kotlin
│  ├─ sdk-dotnet
│  └─ design-tokens
├─ services/
│  ├─ relay
│  ├─ indexer
│  └─ adapter-host
├─ docs/
│  ├─ architecture/
│  ├─ product/
│  ├─ protocols/
│  ├─ native/
│  ├─ epics/
│  └─ archive/
└─ scripts/
```

## 12.2 工程工具策略

- npm 继续存在，用于 Web、CLI bootstrap 与前端开发
- cargo workspace 继续作为 runtime/core 主干
- 原生端使用各自官方工具链
- 用 `just` / `mise` / root scripts 统一开发命令，不强行引入一套看起来很统一、实际上折腾所有平台的 monorepo 编排器

## 12.3 Contract-first 继续强化

必须建立单一事实源：

- 协议 schema
- fixture
- golden payload
- capability matrix
- native decoding tests
- screenshot baselines

任何端的实现，都不能越过它。

## 12.4 文档治理动作

上线这份新总规划后，建议立即执行：

1. 新建 `docs/product/MASTER_PLAN_2026.md`
2. 将旧规划移入 `docs/archive/legacy-roadmaps/`
3. README 改成新的三阶段叙事
4. `SPEC.md` 只保留当前 shipping contract
5. `PRODUCT_ARCHITECTURE.md` 与 `NATIVE_PLATFORM_ROADMAP_2026-03-26.md` 保留为“历史上重要但已被主规划吸收”的文档
6. 新增 `docs/protocols/`、`docs/native/`、`docs/epics/`

# 13. 里程碑与开发排期（可直接开工）

## 13.1 第 0 里程碑（第 1 周）：战略冻结与命名清洗

### 目标

让所有人从同一个产品定义出发。

### 必交付

- 本文档落库
- README 改写
- `Scroll` 全面更名为 `Inspect`
- `WorkspaceSnapshot -> RuntimeSnapshot` 迁移 ADR
- 新的 protocol domain 目录
- 新的 docs 目录骨架
- Epic 与 labels 建立

### 验收

- 新成员进入仓库，10 分钟内能说清 Remux 的三阶段叙事
- 所有人使用同一组术语：runtime/topic/run/artifact/approval/agent

## 13.2 第 1 里程碑（第 2~4 周）：Runtime 基线与 Inspect 真相

### 目标

让 runtime 真正成为唯一主干。

### 必交付

- runtime-v2 兼容边界进一步隐藏
- inspect payload 必带 precision / source / scope / capturedAt
- `HistoryService` 最小实现
- pane history 与 tab history 独立接口
- runtime truth / client view 分离强化
- writer lease UI 曝光
- recording segment metadata 持久化

### 验收

- 任意 pane/tab 切换后 Inspect 都能回到正确 scope
- reconnect 后不会再把本地缓存伪装成 authoritative history
- mobile/web/desktop 原型都能读同一份 inspect contract

## 13.3 第 2 里程碑（第 5~8 周）：Device Trust 与第一批原生客户端

### 目标

把“原生连接感”做出来。

### 必交付

- QR pairing
- trusted reconnect
- device registry
- resume token
- push registration API
- iOS app alpha
- Android skeleton
- macOS skeleton
- Windows skeleton
- Linux skeleton
- native SDK codegen 基线

### 验收

- iPhone 能通过 QR 首次连接并重连
- Android 能登录并打开 Inspect
- macOS 能 attach 同一 runtime
- 所有客户端都通过 contract decoding tests

## 13.4 第 3 里程碑（第 9~12 周）：Desktop Alpha 与 Mobile Command Center

### 目标

桌面与移动都不再是样子货。

### 必交付

- macOS Desktop Alpha
- iOS Command Center Alpha
- diff viewer alpha
- approval center alpha
- agent board alpha
- topic binding alpha
- notifications deep links
- mobile plan / steer / queue 功能
- quick git actions

### 验收

- 用户可以在桌面发起并行 run，在手机上看进展并批准
- 桌面可完成完整 review/approve/commit/push 流程
- 手机可不进入 Live 也完成大部分追赶与小步干预

## 13.5 第 4 里程碑（第 13~20 周）：Agentic Workstation Beta

### 目标

对标 Claude Desktop / Codex app 的主战场成型。

### 必交付

- worktree manager
- built-in git actions
- review center beta
- preview panel
- codex adapter beta
- claude-code adapter alpha
- automation / scheduled runs
- run budgets / approvals / memory scopes
- topic timeline with artifacts

### 验收

- 不依赖外部 agent app，也能在 Remux 内完成主流程
- 至少两个 adapter 能同时存在
- 多 run 并行时用户能清楚知道谁在做什么、下一步是什么

## 13.6 第 5 里程碑（第 21~36 周）：Collaboration Shell Alpha

### 目标

把类 IM 外壳长出来。

### 必交付

- Workspace / Project / Topic
- Topic timeline
- Inbox / Catch-up / Handoff
- Artifact cards
- Team permissions alpha
- runtime-topic binding 正式化
- search & memory beta
- visualization board（不是 pixel first，而是 board/graph first）

### 验收

- 团队可以围绕 topic 协作，而不是围绕散落的 run 或消息
- Topic 打开后 60 秒能理解上下文
- 任一 run / review / approval 都能回溯到 topic



## 13.7 首批 24 个可直接建 Issue 的任务（建议按顺序创建）

下面这批任务不是“方向性事项”，而是可以直接进入仓库建立 issue / project item / PR 的首批工作包。  
建议每个任务都带上：`area/*`、`surface/*`、`phase/*`、`priority/*` 四类标签。

### 13.7.1 第 0~4 周：必须先打穿的 12 个 issue

1. **ISSUE-001：全仓 `Scroll` -> `Inspect` 命名清洗**  
   输出：代码、UI 文案、docs、测试名统一改名。  
   完成标准：仓库内不再存在面向产品语义的 `Scroll` 主称谓。

2. **ISSUE-002：新增 `RuntimeSnapshot` 迁移 ADR**  
   输出：ADR 文档、兼容策略、迁移清单。  
   完成标准：明确旧名保留周期、wire format 是否兼容、客户端重命名计划。

3. **ISSUE-003：建立 `protocol-schemas` 单一事实源目录**  
   输出：schema 目录、版本规范、生成脚本。  
   完成标准：TS/Rust 都从同一 schema 生成或验证。

4. **ISSUE-004：`inspect` payload 补齐 `scope/source/precision/capturedAt/staleness`**  
   输出：协议字段、服务端赋值、客户端展示。  
   完成标准：任一 inspect 卡片都可显示这五项元数据。

5. **ISSUE-005：`HistoryService` 最小实现**  
   输出：pane history、tab history、分页、缓存策略。  
   完成标准：客户端可独立请求 pane / tab 历史，而不是靠临时拼装。

6. **ISSUE-006：Writer lease 状态全链路透出**  
   输出：lease 查询、切换、UI badge、只读附着。  
   完成标准：用户能明确知道当前谁在写、谁只能看。

7. **ISSUE-007：recording segment metadata 持久化**  
   输出：segment 边界、生命周期标记、恢复标记。  
   完成标准：重连/崩溃后 inspect 能诚实区分真实恢复与不可恢复段。

8. **ISSUE-008：二维码配对 v2 payload**  
   输出：pairing token、过期时间、backend kind、protocol version。  
   完成标准：手机端可一次扫码拿到连接所需最小材料。

9. **ISSUE-009：trusted reconnect / resume token**  
   输出：resume token 生命周期、失效策略、恢复流程。  
   完成标准：已信任设备断线后默认自动恢复，不要求重复扫码。

10. **ISSUE-010：原生 SDK codegen 基线**  
    输出：TS / Swift / Kotlin 解码模型与 fixture tests。  
    完成标准：同一 golden payload 在三端都能解码通过。

11. **ISSUE-011：iOS Alpha 壳工程 + Inspect 首屏**  
    输出：配对页、watchlist、Inspect 列表、状态徽章。  
    完成标准：iPhone 可在不打开 live terminal 的情况下完成追赶。

12. **ISSUE-012：macOS Alpha 壳工程 + Workspace 面板**  
    输出：侧边栏、session/tab/pane 导航、Inspect/Live 双面板。  
    完成标准：macOS 可作为可用的日常 attach 面，而不只是 demo。

### 13.7.2 第 5~12 周：把桌面和手机做成真正产品的 12 个 issue

13. **ISSUE-013：Push registration + notification deep links**  
    输出：APNs/FCM token 注册、通知类型、打开路径。  
    完成标准：approval / run finish / lease loss 均可从通知直达。

14. **ISSUE-014：iOS Live terminal bridge**  
    输出：`WKWebView + xterm` 嵌入、键盘桥、重连刷新。  
    完成标准：手机可在必要时安全接管 pane。

15. **ISSUE-015：iOS quick actions（approve / steer / queue）**  
    输出：run 操作卡、审批卡、后续提示队列。  
    完成标准：手机可完成“小步干预”而非只能查看。

16. **ISSUE-016：Android Inspect + pairing skeleton**  
    输出：二维码配对、watchlist、Inspect 首屏。  
    完成标准：Android 进入官方支持范围，不再滞后到不可验证状态。

17. **ISSUE-017：桌面 review center alpha**  
    输出：diff viewer、chunk apply/revert、review comment。  
    完成标准：至少能完成一条完整的 review -> approve/reject 流程。

18. **ISSUE-018：桌面 worktree manager alpha**  
    输出：create/switch/archive、branch 状态、run 绑定。  
    完成标准：一个项目下多 agent 并行不会互相踩工作区。

19. **ISSUE-019：run board alpha**  
    输出：run 列表、状态、预算、当前工具、当前 worktree。  
    完成标准：用户一眼看清“谁在做什么、卡在哪里、是否需要我”。

20. **ISSUE-020：approval object model**  
    输出：approval schema、preview、rollback path、expiry。  
    完成标准：审批从弹窗升级为可回溯对象。

21. **ISSUE-021：topic seed model + runtime binding**  
    输出：topic 基本表、run/runtime/topic 绑定、timeline seed。  
    完成标准：任一 run 都能升级为 topic 并保持上下文链接。

22. **ISSUE-022：artifact card primitives**  
    输出：decision/task/review/run-report 四种最小卡片。  
    完成标准：topic 不再只有消息流，而开始承载结构化产物。

23. **ISSUE-023：Codex deep adapter beta**  
    输出：adapter capability、run 事件映射、审批映射。  
    完成标准：Codex run 能进入统一 run board，而不是品牌专属分支逻辑。

24. **ISSUE-024：Claude Code adapter alpha**  
    输出：第二深度 adapter、能力矩阵、fallback 策略。  
    完成标准：证明 adapter 架构不是单品牌特例。

### 13.7.3 Issue 创建规则

每个 issue 一律要求包含：

- 背景 / Why
- 目标 / Outcome
- 非目标 / Non-goals
- 协议改动点
- 客户端影响面
- 测试要求
- 完成标准
- 回滚方案（如果是协议 / 存储 / 迁移任务）

### 13.7.4 PR 合并顺序规则

1. 先 schema / ADR  
2. 再 server/runtime  
3. 再 fixtures / tests  
4. 再 web shell  
5. 再 native clients  
6. 最后 docs/changelog

这条顺序尽量不要打破，否则你很快会再次进入“协议还没定，客户端已经各做各的”的失控状态。


# 14. Epic 列表（已拆到可执行级）

## EPIC-001 Runtime Identity Cleanup

### 目标

统一命名与主叙事。

### 任务

- `Scroll` -> `Inspect`
- `WorkspaceSnapshot` 迁移规划
- README / SPEC / docs 主叙事改写
- capability 命名审查
- adapter-specific 字段清扫

### 验收

- 产品与代码中的核心术语不再冲突
- 文档与实现命名一致

## EPIC-002 Inspect & Timeline Core

### 目标

把 Inspect 变成真正的一等能力。

### 任务

- pane history API
- tab history API
- pagination
- search in inspect
- source / precision / staleness badges
- history cache policy
- reconnect refetch policy
- workspace timeline seed model

### 验收

- Inspect 成为默认移动入口
- pane/tab/workspace 三层 scope 清晰

## EPIC-003 Runtime Persistence & Recovery

### 目标

按 ADR 做出诚实恢复语义。

### 任务

- metadata persistence
- recording segment metadata persistence
- lifecycle markers
- stopped/recoverable states
- degraded recovery UI
- crash boundary markers

### 验收

- 崩溃后能清楚显示哪些东西恢复了，哪些没有

## EPIC-004 Writer Lease UX

### 目标

让多端干预安全可见。

### 任务

- lease acquisition API
- lease transfer API
- read-only attach mode
- lease badges
- mobile explicit takeover flow
- approval-gated lease transfer（后续）

### 验收

- 不再出现 silent multi-writer confusion

## EPIC-005 Device Trust & Pairing

### 目标

做出原生连接感。

### 任务

- QR bootstrap payload v2
- device keys
- trusted reconnect
- pairing session state
- relay discovery
- local direct / relay direct fallback logic
- device management UI

### 验收

- 配对、断线、恢复链路稳定

## EPIC-006 Native SDK & Contract Fixtures

### 目标

让多端真正共用同一协议。

### 任务

- schema 目录
- TS/Swift/Kotlin/C# codegen
- golden payloads
- native decoding tests
- compatibility matrix
- fixture versioning

### 验收

- 修改协议时所有端一起红灯，而不是靠上线后发现

## EPIC-007 iOS Command Center

### 目标

第一移动旗舰上线。

### 任务

- onboarding / pairing
- watchlist / now / runs / topics
- inspect view
- live terminal
- plan mode
- follow-up queue
- steer active run
- push deep links
- biometric lock
- quick git actions
- diff mini-review

### 验收

- iPhone 不只是“能连上”，而是“能完成关键工作流”

## EPIC-008 Android Command Center

### 目标

Android 同级落地。

### 任务

- pairing
- inspect
- live
- runs
- notifications
- widgets
- foreground service
- quick actions

### 验收

- Android 不沦为功能阉割版

## EPIC-009 macOS Flagship Desktop

### 目标

第一桌面旗舰。

### 任务

- native shell
- project/sidebar/navigation
- inspect/live/review layout
- menu bar integration
- notifications
- agent board
- topic rail
- diff center
- local helper management
- handoff from phone

### 验收

- 日常主流程可直接在 Remux 桌面完成

## EPIC-010 Windows Desktop

### 目标

Windows 原生桌面可正式使用。

### 任务

- WinUI shell
- terminal embedding
- notifications
- review center
- quick attach
- helper process
- tray

### 验收

- Windows 用户不被迫回 Web

## EPIC-011 Linux Desktop

### 目标

Linux 自托管与开发者体验到位。

### 任务

- GTK shell
- systemd user service
- notifications
- inspect/live/review
- relay/self-host tooling visibility

### 验收

- Linux 作为核心用户群不被边缘化

## EPIC-012 Worktree & Review Center

### 目标

与 Codex / Claude 桌面主战场正面竞争。

### 任务

- worktree create/switch/archive
- branch operations
- diff rendering
- inline comments
- chunk apply/revert
- create PR
- compare multiple agent proposals
- attach review to topic/artifact

### 验收

- 用户能在 Remux 内完成大多数 review 流程

## EPIC-013 Adapter Platform

### 目标

多 runtime、多 AI 入口成为长期壁垒。

### 任务

- adapter registry
- adapter health
- generic shell baseline
- codex adapter beta
- claude-code adapter alpha
- capability exposure
- adapter-specific action routing
- fallback to core mode

### 验收

- 两个深度 adapter 共存且不污染 core

## EPIC-014 Agents, Runs & Approvals

### 目标

把 agent 做成第一等成员。

### 任务

- agent profiles
- run objects
- run steps
- approval objects
- run board
- budget views
- memory scopes
- artifact emission
- approval UX

### 验收

- agent 行为可见、可审、可控

## EPIC-015 Topics & Artifacts

### 目标

构建类 IM 外壳的核心骨架。

### 任务

- topic model
- topic timeline
- message model
- artifact cards
- bind run to topic
- decision/task/review cards
- inbox/catch-up seed

### 验收

- topic 打开后用户能立刻理解上下文

## EPIC-016 Search, Memory & Handoff

### 目标

把远程协作真正做成可继承。

### 任务

- search chunks
- topic memory
- project memory
- runtime inspect indexing
- handoff digest
- daily/weekly summaries
- citation UI

### 验收

- 用户能找回“上次这个 run 做到哪了，为什么这样决定”

## EPIC-017 Visualization Board

### 目标

把工作空间可视化。

### 任务

- agent board
- runtime topology board
- topic board
- timeline graph
- presence map
- world/pixel feasibility later

### 验收

- 先有生产力可视化，再谈空间化外观

## EPIC-018 Self-host, Relay & Packaging

### 目标

冷启动简单，扩展路线清晰。

### 任务

- npm bootstrap improvements
- platform binary packaging
- relay deploy recipes
- Tailscale guide
- launchd/systemd/windows service scripts
- Homebrew/winget/AppImage planning
- self-host docs

### 验收

- 从零到可用时间持续下降

## EPIC-019 Test Matrix & Quality Gates

### 目标

所有端都被真正纳入门禁。

### 任务

- unit + contract + integration + e2e
- reconnect chaos tests
- screenshot baselines
- native decoding tests
- protocol compatibility gate
- width/performance gates
- mobile push/reconnect tests

### 验收

- 多端一致性成为工程事实而不是愿望

## EPIC-020 Team Mode Foundations

### 目标

为类 IM 协作层与未来商业化打底。

### 任务

- auth identities
- RBAC
- policy engine
- audit log
- workspace/project/topic ACL
- enterprise config hooks
- SSO compatibility design

### 验收

- 多人协作时不会立刻陷入权限混乱

# 15. 测试、质量与发布规则

## 15.1 测试分层

### Rust Core

- unit tests
- property tests
- protocol serialization tests
- persistence tests
- lease tests
- recovery tests

### Web

- component tests
- visual regression
- browser e2e
- protocol fixture tests

### Native

- view model tests
- contract decoding tests
- critical path UI tests
- reconnect / push / offline tests

### Cross-device

- phone ↔ desktop handoff
- trusted reconnect
- approval deep link
- topic/runtime binding continuity

## 15.2 质量门禁

每个 PR 至少经过：

1. compile/typecheck
2. contract fixtures
3. protocol compat
4. unit tests
5. targeted e2e
6. screenshot review（UI 变更）
7. changelog/doc impact check

## 15.3 发行通道

- `nightly`
- `alpha`
- `beta`
- `stable`

并区分：

- runtime core release
- web app release
- native app release
- relay service release

## 15.4 性能目标

第一阶段先把指标写死，后续只能上调不能下调：

- attach latency：局域网 P50 < 300ms，P95 < 800ms；经 relay P50 < 900ms，P95 < 2s
- inspect first paint：移动端 P50 < 500ms，P95 < 1.2s
- trusted reconnect success rate：> 95%
- terminal stream steady throughput：普通编码/日志场景无肉眼级卡顿，持续输出时不出现输入丢失
- notification-to-open latency：移动端从推送点开到目标卡片 P50 < 1.5s
- diff rendering：中型 diff 首次可交互 < 800ms
- worktree spawn：本地 P50 < 2s，远端 P50 < 5s

必须每周跑基准，不允许只在出问题后测。性能指标要进入发布门禁，而不是只写在文档里。

# 16. 团队与角色配置

## 16.1 最低可推进配置（7 人）

1. 产品/创始 PM（1）
2. Rust runtime/core（2）
3. Web/TS shell（1）
4. Apple 平台（1）
5. Android（1）
6. Windows/Linux（1）

## 16.2 推荐配置（10~12 人）

1. 产品/创始 PM（1）
2. 设计（1）
3. Rust runtime/core（2）
4. Web/TS shell（2）
5. Apple 平台（2）
6. Android（1）
7. Windows/Linux（1）
8. QA / release engineer（1）
9. DevRel / docs（可兼职 1）

## 16.3 责任边界

- Rust core 负责 truth
- TS shell 负责 surface
- Native 负责 flagship experience
- Design 负责信息架构与多端一致性
- QA 负责 contract / regression / release gates

# 17. 你现在就应该拍板的 20 个决策

1. Remux 的唯一主叙事从今天起就是“全端 AI 原生工作空间操作系统”
2. runtime-v2 继续是唯一产品主干
3. `Scroll` 全面退场，统一为 `Inspect`
4. `WorkspaceSnapshot` 迁移为 `RuntimeSnapshot`
5. Rust 继续做核心，TS 继续做产品壳与生态层
6. 不做 Go-first 重写
7. 不把 Web 当最终旗舰
8. macOS 是第一桌面旗舰
9. iOS 是第一移动旗舰
10. Android / Windows / Linux 同样官方支持，但按旗帜面逐步加深
11. 第一版原生终端可嵌入，但必须有 native shell
12. 第二版必须评估并推进 native terminal renderer
13. mobile default = Inspect first
14. desktop default = command center + review center
15. adapter 仍然只是 adapter，不是产品身份
16. 第一个深度 adapter 继续是 Codex
17. 第二个深度 adapter 必须是 Claude Code
18. pixel/world 延后到 board/graph 成熟之后
19. Team Mode 在 Topic / Artifact / Approval 成熟后再重投入
20. 新 master plan 发布后，旧 docs 进入 archive，不再并列竞争主叙事

# 18. 最终建议：应该怎样理解 Remux 的终局

Remux 的终局，不是“把一个终端做得更好看”，也不是“再做一个 AI 对话 App”。

它的终局是：

- **在桌面上**：成为比 Claude Desktop / Codex app 更强的 agentic workstation
- **在手机上**：成为比 Remodex / Termius 更强的 pocket command center
- **在浏览器上**：成为任何设备可进入的 universal access surface
- **在团队协作上**：成为 Topic-first、Agent-first、Artifact-first 的类 IM 工作空间操作系统
- **在技术上**：以独立 runtime 为真相源，以 Inspect 为理解入口，以 Agent/Review/Approval 为执行层，以 Topic/Artifact/Timeline 为协作层

一句话收束：

> **Remux 的真正护城河不是终端本身，而是“运行中的工作空间”被统一观测、理解、干预、审查、审批、记忆与协作化的能力。**

只要这个方向不偏，Ghostty、Termius、Claude Desktop、Codex app、Remodex 都不会是你要复制的对象。  
它们只是你必须逐项反超的基线。

# 附录 A：建议新增文档清单

1. `docs/product/MASTER_PLAN_2026.md`
2. `docs/product/BENCHMARK_MATRIX.md`
3. `docs/architecture/RUNTIME_RENAME_AND_DOMAIN_MODEL.md`
4. `docs/architecture/DEVICE_TRUST_AND_PAIRING.md`
5. `docs/architecture/INSPECT_AND_TIMELINE.md`
6. `docs/native/IOS_PRODUCT_SPEC.md`
7. `docs/native/ANDROID_PRODUCT_SPEC.md`
8. `docs/native/MACOS_PRODUCT_SPEC.md`
9. `docs/native/WINDOWS_PRODUCT_SPEC.md`
10. `docs/native/LINUX_PRODUCT_SPEC.md`
11. `docs/epics/EPIC-001...020.md`
12. `docs/archive/legacy-roadmaps/...`

# 附录 B：事实基线与对标来源

- [S1] `yaoshenwang/remux` README：当前产品已定义为 remote workspace cockpit，核心表面为 Inspect / Live / Control，默认路径是 runtime-v2。
- [S2] `docs/PRODUCT_ARCHITECTURE.md`：强调 awareness > comprehension > intervention、Inspect 一等化、history source/precision/scope。
- [S3] `docs/NATIVE_PLATFORM_ROADMAP_2026-03-26.md`：强调 runtime-native platform、semantic adapters、iPhone first、分阶段 modularization。
- [S4] `docs/IOS_CLIENT_CONTRACT.md`：当前 iOS bootstrap contract、WKWebView+xterm、pairing/push/reconnect 方向。
- [S5] `docs/RUNTIME_V2_DOMAIN_MODEL_2026-03-27.md`：Session/Tab/Pane/WriterLease/RecordingSegment/PaneHistory/TabHistory/SessionTimeline 词汇冻结。
- [S6] `docs/RUNTIME_V2_PROTOCOL_DRAFT_2026-03-27.md`：双通道控制/终端协议与 hello/auth/inspect snapshot 草案。
- [S7] `docs/adr/ADR_RUNTIME_V2_WRITE_LEASE_POLICY.md`：单 pane 单活跃 writer lease。
- [S8] `docs/adr/ADR_RUNTIME_V2_PERSISTENCE_POLICY.md`：先元数据与 recording 边界，后做 richer restoration。
- [S9] 仓库 `Cargo.toml` 与 `package.json`：当前已形成 Rust core + TypeScript web/CLI 双主干。
- [S10] Ghostty 官方文档与官方站点：平台原生 UI、GPU 渲染、窗口/标签/分屏、平台集成、搜索与滚动能力。
- [S11] Termius 官方站点与 App Store：跨端 SSH/Mosh/Telnet/SFTP、encrypted vault、session logs、multiplayer、hardware keys、多端同步。
- [S12] Claude Code Desktop 官方文档：visual diff review、app preview、computer use、Dispatch、parallel sessions、connectors、scheduled tasks。
- [S13] OpenAI Codex app 官方文档：multi-project、skills、automations、worktrees、built-in Git、integrated terminal、cloud/local/worktree 模式。
- [S14] Remodex README：QR pairing、trusted reconnect、plan mode、subagents、follow-up queue、notifications、git actions、reasoning controls、live streaming。


# 附录 C：最小可执行单元 Checklist（319 项）

> 这一附录不是重复讲战略，而是把上面的 20 个 Epic 继续拆到可以直接派发的最小执行单元。  
> 默认规则：一项 ≈ 一个 PR，单项目标控制在 0.5~2 人日；若超出此范围，继续往下拆。  
> 关闭条件：必须同时满足“执行完成 + 验收通过 + 未踩红线”。

## C.1 使用规则

1. 每条 checklist 只允许有一个主要验收面。
2. 每条 checklist 默认只归一个主责角色。
3. 一条 checklist 不能同时承担协议重构、服务端实现、多个客户端 UI 三个面。
4. 遇到跨端需求时，先拆 contract，再拆各端实现。
5. 改 public contract 的项，必须同步改 fixtures 与 docs。
6. 改 UI 的项，必须附截图或录屏。

## C.2 执行顺序建议

1. 底座先行：EPIC-001 → 002 → 003/004 → 005 → 006
2. 全端骨架并行：007/008/009/010/011
3. 桌面主战场：012/013/014
4. 协作壳层：015/016/017/020
5. 发布与门禁全程并行：018/019

## C.3 Epic 总览

| Epic | 项数 | 建议主责 | 开始门槛 |
|---|---:|---|---|
| EPIC-001 Runtime Identity Cleanup | 15 | Docs / TS / Rust | 立即开始 |
| EPIC-002 Inspect & Timeline Core | 18 | Rust Core / TS | E01 完成后 |
| EPIC-003 Runtime Persistence & Recovery | 14 | Rust Core | E02 主要 schema 定后 |
| EPIC-004 Writer Lease UX | 10 | Rust Core / TS / Mobile | E02 control/terminal contract 定后 |
| EPIC-005 Device Trust & Pairing | 18 | Rust / Native / Relay | E04 schema 定后 |
| EPIC-006 Native SDK & Contract Fixtures | 14 | Tooling / TS / Apple / Android / Windows | E01~E05 主 contract 稳定后 |
| EPIC-007 iOS Command Center | 24 | Apple Platform | E05/E06 基线完成后 |
| EPIC-008 Android Command Center | 18 | Android | E05/E06 基线完成后 |
| EPIC-009 macOS Flagship Desktop | 18 | Apple Platform | E06 contract 稳定后 |
| EPIC-010 Windows Desktop | 14 | Windows | E06 contract 稳定后 |
| EPIC-011 Linux Desktop | 12 | Linux | E06 contract 稳定后 |
| EPIC-012 Worktree & Review Center | 18 | Rust / Git / Desktop | E09 桌面骨架可用后 |
| EPIC-013 Adapter Platform | 18 | Rust / Adapter | E06 单一事实源落地后 |
| EPIC-014 Agents, Runs & Approvals | 18 | Rust / Server / Desktop / Mobile | E13 semantic envelope 定后 |
| EPIC-015 Topics & Artifacts | 16 | Server / Desktop / Mobile | E14 基础 run/topic 绑定可用后 |
| EPIC-016 Search, Memory & Handoff | 14 | Indexer / Backend / UI | E15 详情页与索引入口可用后 |
| EPIC-017 Visualization Board | 14 | Server / Desktop / Web | E14/E15 基础对象稳定后 |
| EPIC-018 Self-host, Relay & Packaging | 14 | Release / Ops / Docs | 立即开始，与 E01 并行 |
| EPIC-019 Test Matrix & Quality Gates | 18 | QA / DevEx / Release | 立即开始，持续增强 |
| EPIC-020 Team Mode Foundations | 14 | Policy / Server / UI | E15 topic/object 基础模型稳定后 |

## C.4 详细 Checklist

### EPIC-001 Runtime Identity Cleanup（15 项）

- [ ] **E01-001 统一根 README 的首屏产品术语**。归属：Docs/TS。前置：无。执行：改仓库根 README 的 hero、功能列表、截图说明与快速开始文案，确保主表面只出现 Inspect / Live / Control。验收：README 中搜索不到 Scroll mode 作为主功能名；首屏三表面命名与当前产品定义一致。红线：不得顺手改 CLI 参数、启动流程或未计划的产品行为。
- [ ] **E01-002 统一 Web 顶部导航与空状态文案中的 Inspect 命名**。归属：TS Frontend。前置：E01-001。执行：检查顶部标签、抽屉标题、空状态、按钮文案与 tooltip，把 Scroll 全部替换为 Inspect。验收：前端可见主导航不再出现 Scroll；Inspect 入口、返回文案、空状态描述一致。红线：不得同时重做导航结构；本任务只改文案与枚举引用。
- [ ] **E01-003 建立 RuntimeSnapshot 命名迁移别名**。归属：Rust/TS Contract。前置：E01-001。执行：在共享 contract 中新增 RuntimeSnapshot 作为主名，并为旧 WorkspaceSnapshot 提供只读兼容别名。验收：新代码引用 RuntimeSnapshot；旧 fixture 仍能解码；兼容层有明确 deprecation 注释。红线：不得做破坏性协议改名且不加版本说明。
- [ ] **E01-004 迁移前端类型引用到 RuntimeSnapshot**。归属：TS Frontend。前置：E01-003。执行：把前端代码里直接引用 WorkspaceSnapshot 的 import 与类型注解切到 RuntimeSnapshot。验收：前端 typecheck 通过；新增代码不再直接引用 WorkspaceSnapshot 主名。红线：不得在同一 PR 内改动业务逻辑或状态机。
- [ ] **E01-005 迁移 Rust 服务端对外 payload 命名到 RuntimeSnapshot**。归属：Rust Core。前置：E01-003。执行：清理服务端 public DTO、serde rename、注释与 API 文档中的 WorkspaceSnapshot 主称呼。验收：服务端输出的文档与注释统一使用 RuntimeSnapshot；兼容序列化测试通过。红线：不得修改内部 domain 语义；只处理 public contract 名称。
- [ ] **E01-006 整理 capability 命名冲突清单**。归属：Product/Architecture。前置：E01-001。执行：扫描 control hello、serverCapabilities 与前端 capability 读取逻辑，列出重名、歧义与废弃字段。验收：形成 docs/architecture/CAPABILITY_NAMING_AUDIT.md；每个字段都有 keep/rename/remove 决策。红线：不得直接大改 capability 结构；本任务只产出清单与决策。
- [ ] **E01-007 清扫 adapter-specific 字段泄漏到 core payload 的位置**。归属：Rust/TS。前置：E01-006。执行：定位当前 core payload 中只对某 adapter 有意义的字段，并移到 semantic 或 diagnostics 域。验收：core payload 不再暴露明显 adapter 私有字段；相关字段有迁移注释。红线：不得删掉仍被 UI 使用的字段而不补替代来源。
- [ ] **E01-008 补一份术语 ADR**。归属：Architecture。前置：E01-001。执行：新增 ADR，固定 Runtime / Inspect / Live / Control / Topic / Run / Artifact 等主词汇。验收：ADR 合并后，可作为后续命名评审依据；文档中有禁用词列表。红线：不得写成泛泛宣言；必须给出具体允许词与禁用词。
- [ ] **E01-009 增加 CI 禁用旧主术语检查**。归属：DevEx。前置：E01-008。执行：添加脚本扫描非 archive 路径下新增代码与文档，阻止 Scroll 作为主功能名再次进入主线。验收：在受检路径新增被禁主术语会使 CI 失败；archive 与第三方依赖被白名单排除。红线：不得误伤历史快照、截图基线或用户可见兼容文案说明。
- [ ] **E01-010 迁移路由与 query 参数中的 scroll 主名**。归属：TS Frontend。前置：E01-002。执行：把前端 route、URL query、深链参数中的 scroll 主名切为 inspect，并加入兼容重定向。验收：旧链接仍可打开；新分享链接只产出 inspect 参数。红线：不得让旧链接 404 或丢失当前 tab/pane 上下文。
- [ ] **E01-011 迁移本地存储键名**。归属：TS Frontend。前置：E01-002。执行：把 localStorage / IndexedDB 中与 scroll 相关的键名迁到 inspect 命名，并写一次性迁移函数。验收：升级后用户原有偏好被自动迁移；控制台无重复写旧键日志。红线：不得在迁移失败时清空全部用户偏好。
- [ ] **E01-012 统一测试夹具与截图基线目录命名**。归属：QA/TS。前置：E01-003。执行：把 fixtures、screenshot baselines、Playwright 命名中的旧 scroll 目录与用例名改为 inspect。验收：测试目录结构中主线文件名统一为 inspect；引用路径全部修正。红线：不得同时重录无关截图基线。
- [ ] **E01-013 统一 analytics 与 telemetry 事件名**。归属：TS/Rust。前置：E01-002。执行：把事件名、span 名、日志标签中的 scroll 主词汇改为 inspect，并维护旧字段兼容映射。验收：新事件仪表板只出现 inspect 命名；旧数据查询仍可通过兼容字段取到。红线：不得破坏现有监控面板的字段解析。
- [ ] **E01-014 归档旧路线文档并加跳转说明**。归属：Docs。前置：E01-008。执行：把不再参与主叙事的旧 roadmap 移到 docs/archive，并在首页与目录加“已归档/勿并列参考”说明。验收：旧文档仍可追溯；主 docs 首页只指向新主线。红线：不得物理删除历史文档。
- [ ] **E01-015 做一次命名回归审查**。归属：Product/QA。前置：E01-001~E01-014。执行：运行全文搜索与 UI walkthrough，逐页检查剩余旧命名是否只存在于兼容说明或 archive。验收：输出审查记录；主线页面、主线协议、主线文档无遗漏旧主术语。红线：不得把“审查通过”建立在人工口头确认而无记录之上。


### EPIC-002 Inspect & Timeline Core（18 项）

- [ ] **E02-001 建立 inspect domain 模块骨架**。归属：Rust Core。前置：E01-003。执行：在 runtime core 中新增 inspect 领域模块，拆出 descriptor、snapshot、query、pagination 四个子模块。验收：cargo check 通过；inspect 模块可被 server 引用且无循环依赖。红线：不得在此任务里实现具体业务逻辑。
- [ ] **E02-002 定义 InspectDescriptor 结构**。归属：Rust/Contract。前置：E02-001。执行：定义 scope、source、precision、staleness、capturedAt、session/tab/pane 标识等字段。验收：descriptor 可序列化并有 schema/fixture；前后端共享字段名固定。红线：不得省略 truth 相关字段。
- [ ] **E02-003 定义 inspect 的 scope/source/precision/staleness 枚举**。归属：Rust/Contract。前置：E02-002。执行：在共享 contract 中落地四组枚举，禁止字符串散落在前后端。验收：前后端通过同一枚举读写；不再存在 magic string 分支。红线：不得把未知值 silently 映射成 precise 或 backend_capture。
- [ ] **E02-004 增加 request_inspect 控制消息 schema**。归属：Contract。前置：E02-002。执行：为 control channel 增加 request_inspect 请求体，支持 pane/tab/workspace、cursor、query、filters。验收：schema 生成成功；fixture 覆盖三种 scope 的最小请求。红线：不得把分页与搜索参数塞进非 inspect 域消息里。
- [ ] **E02-005 增加 inspect_snapshot 响应 schema**。归属：Contract。前置：E02-002。执行：定义 inspect_snapshot 响应，包含 descriptor、items、cursor、truncated、counts。验收：schema 生成成功；fixture 能表达 precise/approximate/partial 三种结果。红线：不得让 UI 通过隐式字段猜测真相等级。
- [ ] **E02-006 实现 pane history query service**。归属：Rust Core。前置：E02-004,E02-005。执行：实现按 paneId 查询历史的服务入口，先支持基础快照拼接与 cursor 返回。验收：给定有效 paneId 可返回可分页历史；空 pane 返回空结果而非 500。红线：不得把历史查询和 live terminal 通道耦合到同一个 handler。
- [ ] **E02-007 实现 tab history assembler v1**。归属：Rust Core。前置：E02-006。执行：把当前 tab 下多个 pane capture 与 pane topology 标记组装成 tab 级 inspect 结果。验收：tab history 默认返回 pane 分段结果；结果中包含 pane 标签与 capture 时间。红线：不得伪造跨 pane 精确时序。
- [ ] **E02-008 实现 workspace timeline seed 查询**。归属：Rust Core。前置：E02-006。执行：为 session/tab/pane 生命周期事件提供 workspace scope 的最小时间线查询。验收：workspace scope 可返回 lifecycle marker 列表；空 timeline 也有明确 descriptor。红线：不得把 message/topic 事件提前塞进 runtime timeline。
- [ ] **E02-009 定义 inspect item 类型**。归属：Contract。前置：E02-005。执行：把 inspect item 固定为 output/event/marker 三类，补齐 paneId、timestamp、searchHighlights 等可选字段。验收：前端渲染不再依赖 raw text heuristics；fixture 覆盖三类 item。红线：不得在未版本化情况下引入多套 item 形状。
- [ ] **E02-010 落地 cursor 分页协议**。归属：Rust/TS。前置：E02-004,E02-005。执行：实现 opaque cursor 编码与解码，并在 pane/tab/workspace 三个 scope 统一返回 nextCursor。验收：连续请求可正确翻页；末页 nextCursor 为空；错误 cursor 返回 400 级错误。红线：不得暴露可由客户端拼凑的内部 offset 细节。
- [ ] **E02-011 实现 inspect 端内搜索**。归属：Rust Core。前置：E02-006。执行：在 pane history 查询上增加 query 过滤，先支持纯文本搜索与高亮片段返回。验收：给定 query 可只返回命中项或命中上下文；大小写策略在文档中固定。红线：不得把搜索仅做在前端本地缓存上。
- [ ] **E02-012 在 Web 渲染 source badge**。归属：TS Frontend。前置：E02-005。执行：在 Inspect 视图头部与结果列表加入 source badge，显示 backend_capture、local_cache 等来源。验收：不同 source 能稳定显示不同 badge 文案；无 source 时显示 unknown 而非空白。红线：不得通过颜色单独表达语义而没有文字说明。
- [ ] **E02-013 在 Web 渲染 precision badge**。归属：TS Frontend。前置：E02-005。执行：在 Inspect 视图加入 precision badge，并在 tooltip 中解释 precise/approximate/partial 的含义。验收：用户能在 1 次点击内看懂当前历史可信度；badge 跟随 payload 实时更新。红线：不得默认把未知值当 precise。
- [ ] **E02-014 在 Web 渲染 staleness badge**。归属：TS Frontend。前置：E02-005。执行：在 Inspect 视图加入 freshness/staleness 标识，显示 capturedAt 与是否过期。验收：断线重连后可看到 stale 状态；新鲜数据刷新后 badge 自动回到 fresh。红线：不得只显示相对时间而无明确更新时间。
- [ ] **E02-015 把移动端默认入口切到 Inspect**。归属：Product/TS。前置：E02-006,E02-012~E02-014。执行：调整移动布局首次进入策略，优先打开当前 tab 的 Inspect，而不是 Live。验收：手机窄屏首次进入默认展示 Inspect；仍可一跳进入 Live。红线：不得移除用户手动选择默认页的设置能力。
- [ ] **E02-016 增加 inspect 本地缓存策略**。归属：TS Frontend。前置：E02-005。执行：为 inspect 结果增加按 runtimeId/tabId/scope 分桶的本地缓存，并带协议版本戳。验收：重复打开同一 tab 时能先读缓存再请求最新；版本变化时旧缓存自动失效。红线：不得把 local cache 冒充 authoritative history。
- [ ] **E02-017 实现 reconnect 后 inspect refetch 策略**。归属：TS Frontend。前置：E02-016。执行：在 socket 恢复后对当前打开的 inspect scope 自动 refetch，并显示刷新中状态。验收：网络闪断恢复后 Inspect 能自动更新且不要求手动刷新；失败有重试入口。红线：不得在断线状态下无提示地展示陈旧内容。
- [ ] **E02-018 补齐 inspect 端到端回归测试**。归属：QA。前置：E02-006~E02-017。执行：新增 e2e 覆盖 pane/tab/workspace scope 切换、分页、搜索、badge、重连刷新。验收：测试在 gate 中稳定通过；失败时能定位到具体 scope。红线：不得用 sleep 常量掩盖 race condition。


### EPIC-003 Runtime Persistence & Recovery（14 项）

- [ ] **E03-001 定义 runtime 持久化目录布局**。归属：Rust Core。前置：无。执行：固定 sessions、tabs、panes、recordings、markers、devices 等持久化目录与命名规则。验收：目录布局写入文档与代码常量；不同平台路径解析一致。红线：不得使用会破坏后续迁移的临时文件命名。
- [ ] **E03-002 实现 session metadata 持久化**。归属：Rust Core。前置：E03-001。执行：把 session 基础元数据、状态与 timestamps 落盘到稳定 schema。验收：session 重启后可重新加载元数据；schema 有版本字段。红线：不得把大量瞬时 UI 状态混入持久化对象。
- [ ] **E03-003 实现 tab metadata 持久化**。归属：Rust Core。前置：E03-001。执行：把 tab 顺序、名称、activePane、zoom 状态等信息单独持久化。验收：重启后 tab 顺序与命名可恢复；缺失单 tab 文件不影响其他 tab 读取。红线：不得把 pane 录制内容内嵌进 tab metadata。
- [ ] **E03-004 实现 pane metadata 持久化**。归属：Rust Core。前置：E03-001。执行：落盘 pane 的 geometry、cwd、lifecycle state、writer lease 关联信息。验收：pane 元数据可单独加载；字段缺失时有 degrade 逻辑。红线：不得持久化敏感输入明文。
- [ ] **E03-005 实现 recording segment metadata 持久化**。归属：Rust Core。前置：E03-001。执行：为每个录制段落盘 segment id、pane id、time range、byte range、marker summary。验收：segment metadata 可索引并支持后续拼接；无须读全量字节即可列出段信息。红线：不得把录制字节和 metadata 混写成难以升级的大文件。
- [ ] **E03-006 实现 lifecycle marker 落盘**。归属：Rust Core。前置：E03-002~E03-005。执行：在 start/stop/restart/resize/exit 时写 marker，作为恢复与 inspect 的共同来源。验收：marker 可被 timeline 查询直接消费；异常退出也能补写 crash marker。红线：不得只在内存里维护 marker。
- [ ] **E03-007 实现 crash boundary marker**。归属：Rust Core。前置：E03-006。执行：在非正常退出或恢复失败时生成明确的 crash boundary 标记。验收：Inspect 与恢复 UI 都能读到 crash boundary；日志中有对应事件。红线：不得把 crash 与正常 stop 混为一类状态。
- [ ] **E03-008 把 session lifecycle state 接入 RuntimeSnapshot**。归属：Rust/Contract。前置：E03-002。执行：在对外 snapshot 中输出 starting/live/degraded/stopped/recoverable 等状态。验收：客户端能根据状态做 UI 分支；fixture 覆盖所有枚举值。红线：不得在客户端靠字符串猜测状态。
- [ ] **E03-009 实现 degraded recovery 判定器**。归属：Rust Core。前置：E03-006,E03-007。执行：根据 metadata 完整度、segment 可读性、PTY 可恢复性给出 degraded/recoverable 判定。验收：同一坏盘场景得到稳定判定；判定结果可写入 diagnostics。红线：不得把任何异常都粗暴标为 live。
- [ ] **E03-010 增加恢复摘要 API**。归属：Rust/Server。前置：E03-008,E03-009。执行：为客户端返回“恢复了什么、没恢复什么、为什么”摘要对象。验收：客户端无需解析日志即可展示恢复摘要；空问题场景返回 clean summary。红线：不得把用户必须读原始日志才能理解的内容称作恢复摘要。
- [ ] **E03-011 实现 degraded recovery UI Banner**。归属：TS Frontend。前置：E03-010。执行：在当前 runtime/session 页面展示恢复摘要 Banner，并提供查看 marker 的入口。验收：用户能一眼看到 partial restore/degraded；Banner 可展开查看细节。红线：不得在关键异常时只打控制台日志而无 UI 提示。
- [ ] **E03-012 实现恢复后的 inspect truth 降级逻辑**。归属：Rust/TS。前置：E03-009,E02-005。执行：当历史来自不完整 segment 或本地缓存时，把 precision/source 正确降级。验收：恢复后 inspect 不会错误显示 precise/backend_capture；truth badge 与实际一致。红线：不得为了“看起来完整”而伪装高精度。
- [ ] **E03-013 实现 orphaned segment 清理策略**。归属：Rust Core。前置：E03-005。执行：加入定时清理任务，只清理无 metadata 引用且超过保留期的孤儿段。验收：清理前有 dry-run 模式；正常引用中的 segment 不会被误删。红线：不得默认开启不可恢复的硬删除且无日志。
- [ ] **E03-014 补齐 crash/recovery 集成测试**。归属：QA/Rust。前置：E03-002~E03-013。执行：构造正常退出、异常退出、部分文件丢失、segment 损坏等场景，验证状态与 UI。验收：所有场景有可重复测试；恢复摘要与 truth badge 符合预期。红线：不得用人工手测替代可复现集成测试。


### EPIC-004 Writer Lease UX（10 项）

- [ ] **E04-001 定义 writer lease 对外 schema**。归属：Rust/Contract。前置：无。执行：在 contract 中固定 clientId、mode、acquiredAt、lastActivityAt、expiresAt 等字段。验收：control/terminal 两侧都能共享同一 lease 结构；fixture 覆盖 interactive/read_only。红线：不得让 lease 状态以自由文本散落。
- [ ] **E04-002 实现 acquire lease 指令**。归属：Rust Core。前置：E04-001。执行：为指定 pane 实现显式获取写入租约的命令入口。验收：空闲 pane 可成功获取 interactive lease；已占用时返回结构化冲突错误。红线：不得用隐式 attach 自动抢占现有 writer。
- [ ] **E04-003 实现 release lease 指令**。归属：Rust Core。前置：E04-001。执行：提供主动释放租约的命令，并在连接关闭时自动清理。验收：用户主动退出 Live 后 lease 会释放；断线超时后 lease 会自动回收。红线：不得产生永久悬挂 lease。
- [ ] **E04-004 实现 transfer lease 指令**。归属：Rust Core。前置：E04-002,E04-003。执行：支持显式从当前 writer 向目标客户端转移租约。验收：转移后旧客户端变为 read_only 或 detached；审计日志记录转移双方。红线：不得无记录地 silent transfer。
- [ ] **E04-005 实现 read_only attach 模式**。归属：Rust/TS。前置：E04-001。执行：允许终端 attach 时显式声明 read_only，客户端禁止发送 input 帧。验收：read_only 客户端能看流但不能写；UI 有明确只读标识。红线：不得在 read_only 模式透传快捷键输入。
- [ ] **E04-006 在 Live 头部展示 lease badge**。归属：TS Frontend。前置：E04-001。执行：在 Live header 显示当前 pane 的 lease 持有者、模式与剩余有效期。验收：用户进入 Live 即可知晓是否可写；状态变化时 badge 实时更新。红线：不得把“不可写”只靠禁用输入框表达而无原因说明。
- [ ] **E04-007 实现移动端接管确认 Sheet**。归属：iOS/Android。前置：E04-004,E04-006。执行：在手机端尝试写入被占用 pane 时弹出 takeover sheet，列出当前 writer 与后果。验收：用户二次确认前不会抢占；取消后保持只读。红线：不得一键点击输入框就直接抢占。
- [ ] **E04-008 实现 lease heartbeat 与超时配置**。归属：Rust Core。前置：E04-001。执行：增加 heartbeat 刷新与 server-side timeout，配置化 lease 过期时间。验收：活跃 writer 的 lease 不会误过期；断线 writer 在设定时间内被回收。红线：不得把 heartbeat 只放在前端定时器且无服务器兜底。
- [ ] **E04-009 增加 lease conflict 诊断事件**。归属：Rust/TS。前置：E04-002。执行：为获取冲突、转移失败、超时回收等事件写入 diagnostics/telemetry。验收：发生冲突时能在日志和 diagnostics UI 中看到明确原因。红线：不得把冲突只打印成字符串而无结构化字段。
- [ ] **E04-010 补齐多客户端 lease e2e**。归属：QA。前置：E04-002~E04-009。执行：用两到三个客户端模拟抢占、转移、只读观察、断线回收。验收：多客户端场景在 gate 中稳定通过；无 silent multi-writer。红线：不得通过跳过竞争场景来“让测试稳定”。


### EPIC-005 Device Trust & Pairing（18 项）

- [ ] **E05-001 定义 DeviceIdentity 对象**。归属：Contract。前置：无。执行：固定 deviceId、publicKey、displayName、platform、lastSeenAt、trustLevel 等字段。验收：设备对象可被 web/native/relay 共同读取；fixture 覆盖 mobile/desktop。红线：不得把设备身份与用户会话 token 混成一个对象。
- [ ] **E05-002 在客户端生成设备密钥对**。归属：iOS/Android/Desktop。前置：E05-001。执行：为原生客户端首次启动生成并持久化设备密钥对，用于后续 trusted reconnect。验收：重启应用后同一设备 key 可复用；密钥存储走系统安全存储。红线：不得把私钥明文落在可同步偏好文件。
- [ ] **E05-003 实现 PairingSession 服务端实体**。归属：Rust Core。前置：E05-001。执行：增加 pairing session 的创建、状态、过期与已兑付标记。验收：每次配对都有独立 pairingSessionId 与 expiresAt；已使用 token 不能复用。红线：不得把长期信任设备和一次性 pairing session 混用。
- [ ] **E05-004 定义 QR pairing payload v2**。归属：Contract。前置：E05-003。执行：为 QR 内容固定 url、token、pairingSessionId、expiresAt、protocolVersion 与可选 relay hints。验收：不同客户端解码结果一致；payload 过期可被明确识别。红线：不得继续扩展无版本号的自由 JSON。
- [ ] **E05-005 实现创建 pairing session 的 API**。归属：Rust/Server。前置：E05-003,E05-004。执行：提供服务器端点，用于生成可扫码的 pairing session 与对应 QR payload。验收：API 成功返回 payload 与二维码可用字段；未授权调用会被拒绝。红线：不得让未登录用户生成长期有效 pairing token。
- [ ] **E05-006 实现 redeem pairing 的 API**。归属：Rust/Server。前置：E05-003,E05-004。执行：实现客户端扫码后兑付 pairing session，换取设备级信任凭证。验收：有效 session 可成功兑付；过期或重复兑付返回结构化错误。红线：不得在兑付后继续保留无限期有效的一次性 token。
- [ ] **E05-007 实现 pairing 过期清理任务**。归属：Rust Core。前置：E05-003。执行：增加后台 job 清理过期 pairing session 与残留二维码元数据。验收：过期记录会被清理或标记不可用；统计面板可看到清理计数。红线：不得删除审计所需的最小事件记录。
- [ ] **E05-008 实现 trusted device 服务端存储**。归属：Rust Core。前置：E05-001,E05-006。执行：为已配对设备持久化 trust 记录、最近成功连接、revokedAt 与 reason。验收：设备列表可列出 trusted/revoked 状态；服务器重启后记录不丢。红线：不得把 revoked 设备静默重新激活。
- [ ] **E05-009 实现 trusted reconnect token 签发**。归属：Rust/Server。前置：E05-008。执行：在设备通过信任校验后签发短期重连 token，并绑定 device identity。验收：设备在断线重连时可用 token 快速恢复；token 有过期与用途限制。红线：不得签发不含 device 绑定的通用 bearer token。
- [ ] **E05-010 实现 trusted reconnect 校验**。归属：Rust/Server。前置：E05-009。执行：在控制与终端通道接入 trusted reconnect 校验分支。验收：已配对设备无需重新扫码即可恢复；撤销设备会被拒绝。红线：不得让撤销后的设备仅靠缓存 token 继续写入。
- [ ] **E05-011 实现 revoke device API**。归属：Rust/Server。前置：E05-008。执行：提供撤销受信设备的 API，并记录发起人、时间与原因。验收：撤销后该设备后续重连失败且 UI 可见；审计日志可追溯。红线：不得只在前端隐藏设备而不真正服务端撤销。
- [ ] **E05-012 实现 trusted device 列表 UI**。归属：Web/Desktop。前置：E05-008,E05-011。执行：在设置页增加设备列表、最后连接时间、trust 状态与 revoke 操作。验收：用户可在 2 步内完成撤销；列表能区分当前设备。红线：不得在无确认的情况下直接撤销当前正在使用的设备。
- [ ] **E05-013 定义 relay discovery 配置对象**。归属：Contract。前置：E05-004。执行：为 direct/relay/local 优先级、候选地址、transport hints 增加统一配置对象。验收：不同客户端能解析同一 discovery 配置；字段命名稳定。红线：不得把 relay 专有细节泄漏到 core runtime snapshot。
- [ ] **E05-014 实现 direct vs relay 连接选择器**。归属：iOS/Android/Desktop。前置：E05-013。执行：在客户端实现 local direct、remote direct、relay fallback 的优先级选择逻辑。验收：同一环境下连接策略可复现；失败后能有序 fallback。红线：不得并发乱试所有路径导致多重连接竞态。
- [ ] **E05-015 显示当前连接路径与安全等级**。归属：Web/Native。前置：E05-013,E05-014。执行：在连接状态区域展示 local direct / relay / trusted reconnect 与安全等级标签。验收：用户在 1 眼内看懂当前走哪条链路、是否受信。红线：不得只在调试日志显示连接路径。
- [ ] **E05-016 实现 push registration API**。归属：Rust/Server。前置：E05-008。执行：提供设备注册 push token 的端点，并与设备 identity 关联。验收：成功注册后服务器可定位设备的 push 目标；重复注册会做 upsert。红线：不得把 push token 与匿名 session 绑定。
- [ ] **E05-017 定义背景重连状态机 contract**。归属：Contract。前置：E05-009,E05-016。执行：为 native 背景重连定义 idle/backoff/recovering/reauth_required 等状态。验收：iOS/Android 可用同一状态机字段；UI 能根据状态展示正确文案。红线：不得把背景重连仅靠平台私有布尔值驱动。
- [ ] **E05-018 补齐 pairing/revoke/reconnect 集成测试**。归属：QA。前置：E05-001~E05-017。执行：覆盖扫码配对、过期、重复兑付、撤销、trusted reconnect、relay fallback。验收：关键链路都能自动回归；失败时能定位到设备层还是网络层。红线：不得只做 happy path。


### EPIC-006 Native SDK & Contract Fixtures（14 项）

- [ ] **E06-001 建立 packages/contracts 单一事实源目录**。归属：TS/Architecture。前置：无。执行：把跨端协议 schema 收敛到 packages/contracts，明确这里只有源码，不放平台手写副本。验收：仓库中只存在一个协议事实源目录；其他平台只消费生成物。红线：不得继续维护多份手写 schema 副本。
- [ ] **E06-002 按域拆分 schema 文件**。归属：TS/Architecture。前置：E06-001。执行：把 schema 按 core/runtime/terminal/inspect/device/semantic/collab 拆分为独立文件。验收：每个域有独立入口与版本注释；跨域引用关系清晰。红线：不得做成单一超大文件继续增长。
- [ ] **E06-003 导出 JSON Schema**。归属：TS Tooling。前置：E06-001,E06-002。执行：为每个域生成稳定 JSON Schema，供 native codegen 与测试夹具使用。验收：schema 目录可一键生成；生成结果可被 CI 对比。红线：不得手工编辑生成产物。
- [ ] **E06-004 生成 TypeScript 契约产物**。归属：TS Tooling。前置：E06-003。执行：基于单一事实源生成 TS 类型、运行时校验器或解码器，替代散落手写定义。验收：TS 端从生成产物 import；typecheck 通过。红线：不得同时保留旧手写类型并继续作为主入口。
- [ ] **E06-005 生成 Swift 契约产物**。归属：Apple Platform。前置：E06-003。执行：为 Swift 生成结构体、枚举与解码辅助层，供 iOS/macOS 共享。验收：Swift 产物能解码 golden payload；生成脚本可重复执行。红线：不得在 iOS 项目里手工复制 JSON key。
- [ ] **E06-006 生成 Kotlin 契约产物**。归属：Android。前置：E06-003。执行：为 Kotlin 生成 data class、enum 与序列化定义，供 Android 使用。验收：Kotlin 产物能解码 golden payload；序列化库选择固定。红线：不得让 Android 维持独立命名约定。
- [ ] **E06-007 生成 C# 契约产物**。归属：Windows。前置：E06-003。执行：为 Windows 桌面生成 C# model 与解码辅助类型。验收：Windows 端可消费 golden payload；生成流程纳入 CI。红线：不得将 Windows 作为例外继续手写协议模型。
- [ ] **E06-008 建立 golden payload 目录结构**。归属：QA/Tooling。前置：E06-001。执行：按消息族和版本建立 golden payload 目录，含 hello、workspace_snapshot、inspect_snapshot、attach 等。验收：每种关键 payload 都有最小、完整、错误案例样本。红线：不得只存 happy-path fixture。
- [ ] **E06-009 增加 fixture 版本 manifest**。归属：Tooling。前置：E06-008。执行：为 fixtures 增加 manifest，记录协议版本、文件摘要、域、兼容级别。验收：任意 payload 可追溯到版本与生成命令；manifest 变更受 CI 监控。红线：不得让 fixture 版本靠文件名猜。
- [ ] **E06-010 实现 backward compatibility 检查器**。归属：Tooling。前置：E06-003,E06-009。执行：写脚本比对新旧 schema/fixtures 的 breakage，标记兼容、软破坏、硬破坏。验收：提交协议变更时能自动提示 breakage 级别；报告可读。红线：不得在破坏性变更时无显式版本 bump。
- [ ] **E06-011 补 Swift 解码测试**。归属：Apple Platform。前置：E06-005,E06-008。执行：把 golden payload 全量喂给 Swift 解码层，确保未知枚举、可选字段都可控。验收：iOS/macOS CI 有独立 decoding test；关键消息全部覆盖。红线：不得只测一两个示例 payload。
- [ ] **E06-012 补 Kotlin 解码测试**。归属：Android。前置：E06-006,E06-008。执行：把 golden payload 全量喂给 Kotlin 解码层，验证默认值与错误处理。验收：Android CI 有 decoding test；失败能指出具体 payload 文件。红线：不得把解码异常全部吞掉。
- [ ] **E06-013 自动生成 compatibility matrix 文档**。归属：Tooling/Docs。前置：E06-009,E06-010。执行：根据 schema/fixtures 自动生成各客户端支持的协议版本矩阵。验收：docs 中有最新兼容矩阵；发布前可一眼确认各端支持情况。红线：不得手工维护一份常年过时的兼容表。
- [ ] **E06-014 把 schema/fixture 变更纳入 CI 门禁**。归属：DevEx。前置：E06-003~E06-013。执行：为 schema 变更增加 codegen、fixture、compatibility、native decode 四类检查。验收：改协议时所有端一起亮红灯；无 codegen 更新则无法合并。红线：不得允许只改一端 schema 就直接合并。


### EPIC-007 iOS Command Center（24 项）

- [ ] **E07-001 创建 iOS 工程骨架**。归属：Apple Platform。前置：E06-005。执行：建立 iPhone/iPad 通用 iOS 工程，接入基础导航、构建配置与签名占位。验收：工程可在 CI 本地编译；目录结构清晰。红线：不得把所有代码堆进单文件 Demo。
- [ ] **E07-002 落地 iOS 设计令牌**。归属：Apple Platform/Design。前置：E07-001。执行：实现颜色、字号、间距、圆角、图标映射等设计令牌，供 Now/Inspect/Runs/Topics 复用。验收：应用至少三页共用同一令牌；深浅色模式有统一表现。红线：不得在各页面硬编码样式常量。
- [ ] **E07-003 实现服务器列表页**。归属：Apple Platform。前置：E07-001。执行：做服务器列表、最近连接、删除入口与空状态。验收：用户可查看、选择、删除已保存服务器。红线：不得在此任务中实现复杂排序/过滤。
- [ ] **E07-004 实现 QR 扫码导入**。归属：Apple Platform。前置：E05-004,E07-001。执行：接入相机扫码，解析 pairing payload v2 并进入确认流程。验收：扫到合法 QR 可进入配对确认；无权限时有引导。红线：不得跳过 payload 版本校验。
- [ ] **E07-005 实现手动输入服务器表单**。归属：Apple Platform。前置：E07-001。执行：提供手动输入 URL、token、可选密码与显示名的表单。验收：用户无 QR 也能完成连接配置；字段校验明确。红线：不得把无效 URL/token 静默存档。
- [ ] **E07-006 实现 token/password 安全存储**。归属：Apple Platform。前置：E07-004,E07-005。执行：把 token、device secret、可选密码放入 Keychain，隔离于普通 UserDefaults。验收：重启应用后凭证仍可用；删除服务器时凭证同步清理。红线：不得把敏感信息落到明文 plist。
- [ ] **E07-007 实现 pairing 确认页**。归属：Apple Platform。前置：E05-006,E07-004。执行：展示服务器地址、设备名、有效期、安全等级与确认按钮。验收：用户确认前不会完成配对；过期 payload 有明显提示。红线：不得扫码后自动信任。
- [ ] **E07-008 实现 Now 首页壳层**。归属：Apple Platform。前置：E07-002。执行：搭出 Now 页的整体布局，包含当前 runtime 卡片、连接状态、最近活动区块。验收：首次进入有稳定首页；空状态与加载态完整。红线：不得把所有内容塞成单一滚动长页无分区。
- [ ] **E07-009 实现 watchlist 卡片列表**。归属：Apple Platform。前置：E07-008。执行：在 Now 页接入关注的 runtime/run/topic 列表卡片。验收：用户可看到 watchlist 并进入详情；卡片信息密度适合单手浏览。红线：不得一次实现复杂编辑排序；先只读展示。
- [ ] **E07-010 实现 Runs 列表页**。归属：Apple Platform。前置：E07-002,E14-005。执行：实现 run 列表、状态筛选与进入 run 详情的导航。验收：移动端可浏览最近 runs；状态样式清晰。红线：不得直接依赖桌面专用 view model。
- [ ] **E07-011 实现 Topics 列表页**。归属：Apple Platform。前置：E07-002,E15-005。执行：实现 topic 列表、未读/关注状态与进入 topic 详情的导航。验收：用户可在 Topics 页快速找到 handoff 与待处理主题。红线：不得把 topic 详情塞进列表单元。
- [ ] **E07-012 实现 Inspect 页面骨架**。归属：Apple Platform。前置：E07-002,E02-005。执行：完成 Inspect 页的导航栏、badge 区、历史列表容器与底部切换区。验收：页面可在无数据时正常显示；truth badge 区可复用。红线：不得先内嵌 Web 全页替代原生壳层。
- [ ] **E07-013 接入 tab history 列表渲染**。归属：Apple Platform。前置：E07-012,E02-007。执行：把 tab inspect payload 渲染为原生可滚动列表，支持 output/event/marker 三种 item。验收：长历史可顺滑浏览；不同 item 样式可区分。红线：不得把所有 item 渲染成纯单色文本块。
- [ ] **E07-014 实现 pane 过滤 Chips**。归属：Apple Platform。前置：E07-013。执行：在 Inspect 顶部加入 pane 过滤 chips，可快速切到单 pane 视角。验收：切换 pane 过滤不会丢当前滚动上下文过多；可恢复 all。红线：不得把 pane 过滤做成深层菜单。
- [ ] **E07-015 嵌入 Live 终端 WebView**。归属：Apple Platform。前置：E07-001,E05-014。执行：以 WKWebView 嵌入 xterm 终端表面，先打通 attach、input、resize。验收：iPhone 上可进入 Live 并完成基本输入；旋转后大小可同步。红线：不得在此任务里自研 terminal renderer。
- [ ] **E07-016 实现 Compose 输入条**。归属：Apple Platform。前置：E07-015。执行：为 Live 页提供独立 compose 输入条，支持发送一整行或多行命令。验收：移动键盘输入可稳定发送；对焦与发送状态清晰。红线：不得只依赖 WebView 自身输入框。
- [ ] **E07-017 实现文件上传触发器**。归属：Apple Platform。前置：E07-015。执行：接入 iOS Files 选择器，把文件上传到当前 pane 的 upload 接口。验收：可选择并上传文件；失败有可重试错误提示。红线：不得在未确认目标 pane cwd 时静默上传。
- [ ] **E07-018 实现推送 deep-link 路由**。归属：Apple Platform。前置：E05-016,E07-008。执行：让通知点击后可直达 Now/Run/Topic/Inspect 对应页面。验收：深链能恢复到目标页面和目标对象；冷启动与热启动一致。红线：不得只打开首页不定位对象。
- [ ] **E07-019 实现生物识别锁**。归属：Apple Platform。前置：E07-006。执行：增加 Face ID/Touch ID 锁，保护本地已配对设备访问。验收：开启后从后台恢复需通过生物识别或系统回退；失败文案清晰。红线：不得把锁实现成纯前端遮罩且可被绕过。
- [ ] **E07-020 实现 Plan Mode 面板**。归属：Apple Platform。前置：E14-005。执行：为正在运行的 run 提供 plan 模式视图，只显示计划、下一步、待审批动作。验收：用户可在手机上看清 agent 计划而不必读全量日志。红线：不得把 plan mode 做成另一个自由聊天页。
- [ ] **E07-021 实现 Follow-up Queue**。归属：Apple Platform。前置：E14-005,E15-013。执行：增加 follow-up queue，用于收集待你稍后处理的 run/topic/approval。验收：用户可把对象加入队列并在单独列表里处理。红线：不得把 queue 仅存在内存中。
- [ ] **E07-022 实现 Steer Active Run 操作片**。归属：Apple Platform。前置：E14-015。执行：在 run 详情中提供暂停、取消、继续、追加指导等轻量 steer 动作。验收：手机上能完成关键 run 干预；危险操作有二次确认。红线：不得把所有桌面高级操作直接照搬到手机。
- [ ] **E07-023 实现 Quick Git Actions 入口**。归属：Apple Platform。前置：E12-006,E12-014。执行：在 run/review 上下文中暴露查看 branch、切换 worktree、创建 PR 等快捷入口。验收：常见 Git 动作 2 步内可达；无权限时正确禁用。红线：不得在移动端暴露尚未接通的空按钮。
- [ ] **E07-024 实现 Diff Mini-Review 页面**。归属：Apple Platform。前置：E12-007~E12-013。执行：提供移动端轻量 diff 预览与 approve/request changes 入口。验收：用户能在手机上浏览关键 diff 与做基础 review 决策。红线：不得要求手机端承担完整桌面级 diff 编辑。


### EPIC-008 Android Command Center（18 项）

- [ ] **E08-001 创建 Android 工程骨架**。归属：Android。前置：E06-006。执行：建立 Android 应用工程、模块划分与 CI 构建脚手架。验收：工程可编译安装；目录清晰。红线：不得以单 Activity 原型长期停留。
- [ ] **E08-002 落地 Android 设计令牌**。归属：Android/Design。前置：E08-001。执行：实现颜色、文字、间距与组件样式令牌，支撑多页面复用。验收：至少三页共用令牌；暗色模式正常。红线：不得在页面里硬编码样式。
- [ ] **E08-003 实现服务器列表页**。归属：Android。前置：E08-001。执行：提供已保存服务器列表、最近连接与删除入口。验收：用户可查看和管理保存的服务器。红线：不得混入配对逻辑。
- [ ] **E08-004 实现 QR 扫码配对**。归属：Android。前置：E05-004,E08-001。执行：接入扫码并解析 pairing payload v2，进入确认流程。验收：扫码合法 payload 可进入确认页；权限缺失有提示。红线：不得跳过版本和过期校验。
- [ ] **E08-005 实现手动连接表单**。归属：Android。前置：E08-001。执行：提供 URL、token、密码与显示名表单。验收：手动配置可保存；字段校验明确。红线：不得保存明显无效配置。
- [ ] **E08-006 实现安全凭证存储**。归属：Android。前置：E08-004,E08-005。执行：使用系统安全存储保存 token 与设备 secret。验收：重启后凭证仍可用；删除配置时同步清理。红线：不得把敏感凭证落到明文 SharedPreferences。
- [ ] **E08-007 实现 Now 首页壳层**。归属：Android。前置：E08-002。执行：构建当前 runtime 状态卡、连接状态区与 watchlist 区。验收：首页可用、空状态完整。红线：不得把所有信息塞进单一 RecyclerView 无分区。
- [ ] **E08-008 实现 Runs 列表页**。归属：Android。前置：E14-005。执行：展示 runs、状态与进入详情的导航。验收：用户可浏览最近 runs。红线：不得直接照搬 Web 表格布局。
- [ ] **E08-009 实现 Topics 列表页**。归属：Android。前置：E15-005。执行：展示 topics、未读状态与进入详情的导航。验收：用户可快速找到待处理主题。红线：不得把 topic 详情与列表混页。
- [ ] **E08-010 实现 Inspect 页面骨架**。归属：Android。前置：E02-005。执行：完成 Inspect 页导航、badge 区和历史列表容器。验收：页面可渲染无数据/错误态；truth badge 可复用。红线：不得先塞整个 Web 页替代原生壳层。
- [ ] **E08-011 接入 tab history 列表**。归属：Android。前置：E08-010,E02-007。执行：把 inspect payload 渲染为原生列表，区分 output/event/marker。验收：长列表可浏览；item 类型清晰可见。红线：不得全量一次性渲染导致卡顿。
- [ ] **E08-012 嵌入 Live 终端表面**。归属：Android。前置：E05-014。执行：打通 Live attach、input、resize 与终端嵌入。验收：Android 手机上可进入 Live 完成基本输入。红线：不得在此任务中自研 renderer。
- [ ] **E08-013 实现 Compose 输入条与上传入口**。归属：Android。前置：E08-012。执行：增加独立输入条和文件选择上传动作。验收：键盘输入与上传都可完成；错误有反馈。红线：不得只依赖嵌入终端自身输入。
- [ ] **E08-014 实现通知频道与 deep link**。归属：Android。前置：E05-016。执行：建立通知频道，点击通知能直达 run/topic/inspect。验收：通知进入目标对象准确；冷启动/热启动一致。红线：不得把所有通知都跳首页。
- [ ] **E08-015 实现前台重连服务**。归属：Android。前置：E05-017。执行：使用 foreground service 管理长连接与恢复，降低后台被杀风险。验收：网络波动后重连稳定；系统限制下有合规提示。红线：不得在后台无限重试耗电无上限。
- [ ] **E08-016 实现桌面小组件/快捷动作**。归属：Android。前置：E08-007。执行：提供小组件或快捷动作，允许一键打开最近 run 或当前 runtime。验收：用户可从桌面直达关键对象。红线：不得依赖未落地的数据源。
- [ ] **E08-017 实现生物识别锁**。归属：Android。前置：E08-006。执行：为已配对设备增加生物识别锁。验收：从后台恢复需验证；失败回退文案清晰。红线：不得把锁只做成前端遮罩。
- [ ] **E08-018 补齐 Android 关键路径 UI 测试**。归属：Android QA。前置：E08-001~E08-017。执行：覆盖配对、Inspect、Live、通知 deep link、重连。验收：关键路径有自动化 UI 测试；不依赖纯手测。红线：不得用大量 sleep 让测试“看起来稳定”。


### EPIC-009 macOS Flagship Desktop（18 项）

- [ ] **E09-001 创建 macOS 原生应用骨架**。归属：Apple Platform。前置：E06-005。执行：建立 macOS 应用工程、窗口场景与构建配置。验收：可在本地和 CI 编译运行；目录结构清晰。红线：不得以 iOS Catalyst 占位后无限期搁置。
- [ ] **E09-002 实现窗口恢复与多窗口基础**。归属：Apple Platform。前置：E09-001。执行：为项目/工作空间窗口提供 state restoration 与多窗口支持。验收：重启后可恢复上次窗口布局；可同时打开多个工作空间窗口。红线：不得把所有对象强塞进单窗口。
- [ ] **E09-003 实现左侧导航与项目侧栏**。归属：Apple Platform/Design。前置：E09-001。执行：搭建桌面旗舰的 sidebar，包含 runtimes、topics、runs、reviews、agents 分组。验收：用户能从侧栏进入核心对象；选中状态稳定。红线：不得把移动端底部导航直接平移到桌面。
- [ ] **E09-004 实现 Runtime Overview 主区**。归属：Apple Platform。前置：E09-003。执行：为当前 runtime 展示 sessions/tabs/panes 概览、状态、连接路径与快速动作。验收：桌面一屏可看清当前工作空间结构。红线：不得把 overview 做成纯列表无层级。
- [ ] **E09-005 实现 Inspect 面板**。归属：Apple Platform。前置：E02-007。执行：在桌面主区实现原生 Inspect 面板，支持搜索、分页与 pane 过滤。验收：桌面能原生阅读 inspect；不是简单内嵌移动页。红线：不得跳过 source/precision/staleness badge。
- [ ] **E09-006 实现 Live 面板**。归属：Apple Platform。前置：E05-014,E04-005。执行：接入桌面 Live 面板，支持 attach、resize、lease 状态与只读模式。验收：桌面可完成基础实时干预；lease 状态可见。红线：不得在不可写状态下假装可编辑。
- [ ] **E09-007 实现 Review 面板骨架**。归属：Apple Platform。前置：E12-007。执行：在桌面主区预留 diff/review 面板区域，与 Inspect/Live 并列。验收：桌面布局支持 Inspect/Live/Review 三栏或切换模式。红线：不得把 review 作为模态弹窗长期存在。
- [ ] **E09-008 实现 Topic Rail**。归属：Apple Platform。前置：E15-005。执行：在桌面右侧或侧边增加 topic rail，用于显示当前 runtime 关联 topic/artifact。验收：用户可在 runtime 与 topic 之间快速切换。红线：不得把 topic 关联隐藏在深层菜单。
- [ ] **E09-009 实现 Agent Board 面板**。归属：Apple Platform。前置：E17-003,E14-007。执行：在桌面展示当前 agents/runs 的板式视图。验收：用户可在桌面一眼看到谁在 running/waiting/blocking。红线：不得把 board 只做成静态截图。
- [ ] **E09-010 实现 Menu Bar 常驻入口**。归属：Apple Platform。前置：E09-001。执行：提供 menu bar 图标、最近连接、快速打开当前 runtime/run。验收：用户可从菜单栏快速回到 Remux。红线：不得在 menu bar 中堆完整应用功能。
- [ ] **E09-011 实现全局搜索快捷键**。归属：Apple Platform。前置：E16-006。执行：增加 Command Palette/Quick Open，支持 runtime/topic/run/review 搜索。验收：按快捷键可全局搜索并跳转对象。红线：不得只搜索当前列表页。
- [ ] **E09-012 实现原生通知**。归属：Apple Platform。前置：E05-016。执行：接入 macOS 通知中心，支持审批、完成、错误、handoff 等事件。验收：通知点击可深链回对应对象。红线：不得所有通知都落成同一泛型消息。
- [ ] **E09-013 实现拖拽上传到当前 pane**。归属：Apple Platform。前置：E09-006。执行：支持从 Finder 拖文件到当前 pane 触发 upload。验收：拖拽上传成功；目标 pane 与 cwd 可见。红线：不得在目标 pane 不明确时静默上传。
- [ ] **E09-014 实现本地 helper 安装/管理器**。归属：Apple Platform。前置：E18-002。执行：桌面端可检查、安装、更新本地 helper 或 remuxd。验收：用户能在 App 内完成 helper 管理；状态明确。红线：不得强依赖用户手动命令行安装且无说明。
- [ ] **E09-015 实现外部编辑器打开入口**。归属：Apple Platform。前置：E12-007。执行：为 diff/file/topic 中的文件提供“在外部编辑器打开”动作。验收：点击后能把文件在系统默认或指定编辑器中打开。红线：不得在路径不安全时直接执行 shell。
- [ ] **E09-016 实现手机到桌面 handoff 接力**。归属：Apple Platform。前置：E07-018。执行：支持从 iPhone 推送或深链把当前 run/topic/runtime 接力到桌面窗口。验收：桌面接到 handoff 后定位到正确对象。红线：不得只打开首页。
- [ ] **E09-017 实现崩溃后恢复提示**。归属：Apple Platform。前置：E03-010。执行：当桌面应用上次异常退出时展示恢复对话，说明可恢复与不可恢复内容。验收：用户可选择恢复窗口与上下文；提示不打扰正常启动。红线：不得把崩溃恢复与 runtime 恢复混成一个概念。
- [ ] **E09-018 补齐 macOS Alpha 冒烟测试**。归属：Apple Platform QA。前置：E09-001~E09-017。执行：覆盖启动、连接、Inspect、Live、通知、handoff、helper 管理。验收：桌面 alpha 关键路径可自动冒烟。红线：不得完全依赖人工回归。


### EPIC-010 Windows Desktop（14 项）

- [ ] **E10-001 创建 Windows 原生应用骨架**。归属：Windows。前置：E06-007。执行：建立 WinUI 桌面工程、构建脚本与基础路由。验收：工程可编译运行；目录清晰。红线：不得以 WebView 全屏壳长期代替原生壳层。
- [ ] **E10-002 实现 Windows 导航结构**。归属：Windows。前置：E10-001。执行：完成 runtimes/topics/runs/reviews/agents 的导航骨架。验收：用户可在桌面中切换核心对象。红线：不得把移动底部栏照搬到桌面。
- [ ] **E10-003 实现 Inspect 面板**。归属：Windows。前置：E02-007。执行：在 Windows 端实现原生 Inspect 阅读面板。验收：桌面可浏览 tab history 与 badge。红线：不得省略 truth badge。
- [ ] **E10-004 实现 Live 终端控件集成**。归属：Windows。前置：E04-005,E05-014。执行：接入终端控件或嵌入方案，打通 attach、input、resize。验收：Windows 用户可进行基础实时干预。红线：不得在不可写状态下允许输入。
- [ ] **E10-005 实现 Review Center 骨架**。归属：Windows。前置：E12-007。执行：完成 Windows 端 review 页面骨架。验收：桌面可进入 diff/review 流程。红线：不得要求用户回 Web 才能看 review。
- [ ] **E10-006 实现系统托盘入口**。归属：Windows。前置：E10-001。执行：在系统托盘提供最近对象、连接状态与快速打开。验收：用户可从托盘快速回到应用。红线：不得把完整应用功能全塞到托盘菜单。
- [ ] **E10-007 实现 Toast 通知与 deep link**。归属：Windows。前置：E05-016。执行：接入系统通知，点击后直达 run/topic/inspect。验收：通知可准确定位目标对象。红线：不得全部通知都打开首页。
- [ ] **E10-008 实现 Windows Credential Manager 凭证存储**。归属：Windows。前置：E10-001。执行：把 token/device secret 存入系统凭证库。验收：凭证不会明文落盘；删除服务器时同步清理。红线：不得把敏感凭证写进普通配置文件。
- [ ] **E10-009 实现 helper 安装/卸载管理**。归属：Windows。前置：E18-002。执行：在应用内检测、安装和卸载本地 helper/service。验收：用户可在 GUI 内完成 helper 管理。红线：不得要求每次都手工管理员命令。
- [ ] **E10-010 实现自定义协议 deep link**。归属：Windows。前置：E10-001。执行：注册 remux:// 等协议，支持从通知、浏览器或移动接力打开指定对象。验收：协议打开可解析并定位对象。红线：不得注册宽泛协议导致系统冲突。
- [ ] **E10-011 实现 Jump List 快捷动作**。归属：Windows。前置：E10-001。执行：为开始菜单/任务栏添加最近 runtime 或 review 快捷入口。验收：用户可从系统入口快速打开最近对象。红线：不得列出不存在或无权限对象。
- [ ] **E10-012 实现重连状态 Banner**。归属：Windows。前置：E05-017。执行：在 Windows 桌面显示连接丢失、重连中、需要重新认证等状态。验收：网络波动时状态可见且可操作。红线：不得只在控制台输出状态。
- [ ] **E10-013 打通 MSIX 打包流程**。归属：Windows/Release。前置：E18-002。执行：建立 Windows 安装包构建、签名占位与版本注入流程。验收：CI 可产出可安装包；版本号一致。红线：不得手工改版本号。
- [ ] **E10-014 补齐 Windows 冒烟测试**。归属：Windows QA。前置：E10-001~E10-013。执行：覆盖启动、连接、Inspect、Live、通知、deep link、打包安装。验收：关键路径可自动验证。红线：不得完全依赖人工烟测。


### EPIC-011 Linux Desktop（12 项）

- [ ] **E11-001 创建 Linux 桌面工程骨架**。归属：Linux。前置：E06-004。执行：建立 Linux 桌面应用项目、构建脚本与基础窗口。验收：工程可在主流发行版开发环境编译运行。红线：不得把 Linux 永久当成仅靠浏览器的次级平台。
- [ ] **E11-002 实现 Linux 侧栏导航**。归属：Linux。前置：E11-001。执行：完成 runtimes/topics/runs/reviews/agents 的导航骨架。验收：用户可进入核心对象。红线：不得把桌面导航缩成单页菜单。
- [ ] **E11-003 实现原生 Inspect 面板**。归属：Linux。前置：E02-007。执行：提供原生 Inspect 阅读面板与 truth badges。验收：Linux 用户可舒适浏览 inspect。红线：不得省略 precision/source/staleness 显示。
- [ ] **E11-004 实现 Live 面板**。归属：Linux。前置：E04-005,E05-014。执行：打通终端嵌入、attach、resize 与只读模式。验收：Linux 桌面可进行基础实时干预。红线：不得在只读模式仍接收输入。
- [ ] **E11-005 实现系统通知集成**。归属：Linux。前置：E05-016。执行：接入 freedesktop 通知或 portal，支持 deep link 到对象。验收：通知可显示并跳转目标对象。红线：不得只在日志里提示通知。
- [ ] **E11-006 提供 systemd user service 模板**。归属：Linux。前置：E18-007。执行：增加 remux helper/runtime 的 systemd user service 示例与安装脚本。验收：用户可一键安装用户级服务。红线：不得默认写系统级服务且要求 root。
- [ ] **E11-007 接入 Secret Service/Keyring 凭证存储**。归属：Linux。前置：E11-001。执行：把 token/device secret 写入系统 keyring。验收：凭证不以明文保存在配置文件。红线：不得在 keyring 不可用时 silently 降级为明文。
- [ ] **E11-008 打通 AppImage 打包流程**。归属：Linux/Release。前置：E18-005。执行：建立 Linux 可分发包产物，保证普通用户可安装运行。验收：CI 可产出 AppImage 或等价发行包。红线：不得只提供源码运行方式。
- [ ] **E11-009 注册 .desktop 文件与协议处理器**。归属：Linux。前置：E11-001。执行：提供桌面入口、图标与 remux:// 协议处理。验收：系统菜单可找到应用；深链可打开目标对象。红线：不得破坏用户已有协议处理设置。
- [ ] **E11-010 实现 self-host/relay 状态页**。归属：Linux。前置：E18-009。执行：为 Linux 用户增强 relay、自托管、局域网直连状态可见性。验收：用户可在 GUI 内看清当前连接方式与服务状态。红线：不得把这类信息只留给命令行。
- [ ] **E11-011 实现崩溃日志导出**。归属：Linux。前置：E11-001。执行：提供导出日志与诊断包的入口，方便自托管与开源用户提 issue。验收：点击后能生成可分享的诊断包。红线：不得导出包含明文凭证的日志。
- [ ] **E11-012 补齐 Linux 冒烟测试**。归属：Linux QA。前置：E11-001~E11-011。执行：覆盖启动、连接、Inspect、Live、通知、打包、协议打开。验收：Linux 关键路径可自动验证。红线：不得长期用“社区自己测”替代门禁。


### EPIC-012 Worktree & Review Center（18 项）

- [ ] **E12-001 定义 Worktree 对象 schema**。归属：Contract。前置：无。执行：固定 worktreeId、repoId、branch、path、status、createdBy、attachedRunId 等字段。验收：所有客户端共享同一 worktree 结构；fixture 覆盖常见状态。红线：不得把 worktree 混成简单字符串路径。
- [ ] **E12-002 实现列出 worktrees 的 API**。归属：Rust/Server。前置：E12-001。执行：提供查询当前项目可见 worktrees 的接口，支持分页与状态过滤。验收：客户端可稳定拿到 worktree 列表；空仓库返回空数组。红线：不得在此任务中加入修改能力。
- [ ] **E12-003 实现创建 worktree 的 API**。归属：Rust/Server。前置：E12-001。执行：支持从 branch/base commit 创建 worktree，返回创建进度与结果。验收：成功时返回新 worktree；失败有结构化错误。红线：不得同步阻塞到超时无进度反馈。
- [ ] **E12-004 实现切换/附加 worktree 的 API**。归属：Rust/Server。前置：E12-001。执行：支持把当前 runtime 或 review 绑定到指定 worktree。验收：绑定后后续 review/run 可引用正确 worktreeId。红线：不得暗中切换用户主工作目录。
- [ ] **E12-005 实现归档/移除 worktree 的 API**。归属：Rust/Server。前置：E12-001。执行：提供 archive/remove 动作，区分安全归档与实际删除。验收：用户可明确看到 archive 与 delete 的区别。红线：不得在默认操作中直接物理删除。
- [ ] **E12-006 实现 branch create/switch API**。归属：Rust/Git。前置：E12-001。执行：为新 worktree 与现有 worktree 提供 branch 创建、切换、重命名能力。验收：常见 branch 操作可经 API 完成。红线：不得要求客户端拼 shell 命令。
- [ ] **E12-007 实现 diff summary API**。归属：Rust/Server。前置：E12-001。执行：返回文件级 diff 汇总、统计与状态，供 review 列表使用。验收：中型改动可快速返回 summary；空 diff 可明确显示。红线：不得把完整 patch 全塞进 summary。
- [ ] **E12-008 实现 file diff API**。归属：Rust/Server。前置：E12-007。执行：按文件返回 patch、hunks、old/new path 与 metadata。验收：客户端可按文件懒加载 diff；大文件有截断策略。红线：不得一次性返回整个仓库 patch。
- [ ] **E12-009 实现桌面 diff 渲染组件**。归属：Desktop/Web。前置：E12-008。执行：做支持语法高亮、折叠和 chunk 定位的 diff 组件。验收：用户可舒适阅读 diff；长文件性能可接受。红线：不得把 patch 纯文本直接塞进单个 textarea。
- [ ] **E12-010 定义 inline comment thread 模型**。归属：Contract。前置：E12-008。执行：为 review 注释固定 file path、line、side、threadId、author、status 等字段。验收：注释模型可支撑桌面与移动端复用。红线：不得把注释仅当自由文本列表。
- [ ] **E12-011 实现 apply/revert chunk 动作**。归属：Rust/Git。前置：E12-008。执行：支持针对单个 chunk 应用或回滚变更，供 review center 使用。验收：操作后 diff 会刷新；失败有清晰错误。红线：不得在无确认时修改工作树。
- [ ] **E12-012 实现多提案对比 view model**。归属：Desktop/Web。前置：E12-007,E14-005。执行：允许同时比较两个或多个 agent proposal 的 diff summary 与关键结果。验收：用户可在同屏对比方案；每个 proposal 有来源 run。红线：不得把不同 proposal 混成一份 diff。
- [ ] **E12-013 实现多提案对比界面**。归属：Desktop/Web。前置：E12-012。执行：为 proposals 提供并排或切换比较 UI。验收：桌面用户可完成方案比较决策。红线：不得把对比界面做成无法定位来源的无标签列表。
- [ ] **E12-014 实现 Create PR 动作桥**。归属：Rust/Adapter。前置：E12-006,E13-008。执行：定义从 review center 发起 create PR 的统一动作接口。验收：支持至少一个 adapter 或 provider 打通 PR 创建。红线：不得把 provider 私有字段硬编码进核心 review 模型。
- [ ] **E12-015 实现 review 绑定 topic 的关系**。归属：Contract/Server。前置：E15-001。执行：允许 review 对象挂在 topic 下，支持 topic 内追溯 review。验收：从 topic 进入可看到关联 review；关系可反向查询。红线：不得只在客户端本地存关系。
- [ ] **E12-016 实现 review 绑定 artifact 的关系**。归属：Contract/Server。前置：E15-004。执行：允许 review 作为 artifact 或附属 artifact 被持久化。验收：artifact 卡片可打开 review；review 也能看到所属 artifact。红线：不得产生双向关系不一致。
- [ ] **E12-017 实现移动端 mini-review 共享 view model**。归属：TS/Contract/Mobile。前置：E12-007,E12-010。执行：抽出供 iOS/Android mini-review 复用的轻量 review 数据模型。验收：移动端只拿必要字段也能完成轻 review。红线：不得把桌面全量 UI 状态直接下发到手机。
- [ ] **E12-018 补齐 review/worktree e2e**。归属：QA。前置：E12-001~E12-017。执行：覆盖创建 worktree、生成 diff、评论、apply/revert、创建 PR。验收：核心 review 流程可自动回归。红线：不得跳过 destructive 动作的回滚验证。


### EPIC-013 Adapter Platform（18 项）

- [ ] **E13-001 定义 adapter manifest schema**。归属：Contract。前置：无。执行：固定 adapter id、displayName、version、capabilities、health、modes 等字段。验收：所有 adapter 以同一 manifest 暴露；fixture 覆盖 passive/deep 模式。红线：不得让每个 adapter 自定义完全不同的 manifest。
- [ ] **E13-002 实现 adapter registry 接口**。归属：Rust Core。前置：E13-001。执行：定义 adapter 注册、发现、启停与查找接口。验收：核心可加载多个 adapter；registry 与 runtime 核心解耦。红线：不得把 adapter 逻辑写死在 runtime 主循环。
- [ ] **E13-003 实现 adapter health snapshot**。归属：Rust Core。前置：E13-002。执行：输出 adapter 当前状态、最近错误、检测结果与启停时间。验收：客户端可读到 health 状态；错误有结构化字段。红线：不得把 health 只做成布尔值。
- [ ] **E13-004 实现 generic shell passive adapter**。归属：Rust Core。前置：E13-002。执行：先做一个不写入、不控制的 passive adapter，仅从普通 shell/workspace 读取基本语义。验收：在无深度 runtime 时也能提供基础 semantic timeline。红线：不得伪装深度能力。
- [ ] **E13-005 把 adapter capabilities 接到 hello/serverCapabilities**。归属：Rust/Contract。前置：E13-001。执行：在 control hello 和能力对象中暴露 adaptersAvailable、adapterHealth、semantic capabilities。验收：各端可根据 capability 做功能开关。红线：不得让客户端靠 adapter 名称字符串猜能力。
- [ ] **E13-006 定义 semantic event envelope**。归属：Contract。前置：E13-001。执行：固定 semantic/state、semantic/event、semantic/action_result 等消息的公共包裹格式。验收：不同 adapter 产出的事件可用同一 envelope 表达。红线：不得把 adapter 私有 payload 顶到顶层污染公共域。
- [ ] **E13-007 实现 adapter event ingestion pipeline**。归属：Rust Core。前置：E13-006。执行：把 adapter 事件接入统一队列、持久化和转发链路。验收：semantic event 能进入 UI、存储和诊断；丢失率可观测。红线：不得让 adapter 直接操作 UI socket。
- [ ] **E13-008 定义 adapter-specific action routing**。归属：Rust/Contract。前置：E13-006。执行：为 create PR、approve tool call、open thread 等动作建立 adapter 路由接口。验收：核心只做路由，不关心 provider 私有细节。红线：不得把 provider 私有参数塞到 core action API。
- [ ] **E13-009 实现 fallback to core mode**。归属：TS/Desktop。前置：E13-005。执行：当 adapter 不可用或健康异常时，客户端能退回 core runtime 模式。验收：adapter 挂掉时主产品仍可用；UI 明确当前已退回 core mode。红线：不得把 adapter 故障变成全产品不可用。
- [ ] **E13-010 实现 Codex runtime detector**。归属：Adapter/Codex。前置：E13-002。执行：实现对 Codex 运行环境、目录结构或事件源的探测器。验收：能可靠判断 Codex 是否存在且版本可支持。红线：不得靠脆弱的单个进程名猜测。
- [ ] **E13-011 实现 Codex thread list mapper**。归属：Adapter/Codex。前置：E13-010。执行：把 Codex 的线程/会话结构映射成 Remux 的 semantic thread/run 视图。验收：用户可查看 Codex 线程列表与状态。红线：不得把 Codex 私有字段直接暴露给 UI。
- [ ] **E13-012 实现 Codex tool event mapper**。归属：Adapter/Codex。前置：E13-010,E13-006。执行：把 Codex 的 tool call/tool result 映射到统一 semantic event。验收：工具调用可在统一时间线中显示。红线：不得在工具事件缺失时伪造成功状态。
- [ ] **E13-013 实现 Codex approval/action bridge**。归属：Adapter/Codex。前置：E13-008,E14-011。执行：把 Codex 可审批动作接到 Remux approval 系统。验收：用户可在 Remux 内批准或拒绝指定动作。红线：不得绕过 Remux 审批直接执行。
- [ ] **E13-014 实现 Claude Code runtime detector**。归属：Adapter/Claude。前置：E13-002。执行：实现对 Claude Code 运行环境的探测器。验收：能可靠识别 Claude Code 运行时。红线：不得靠脆弱路径硬编码。
- [ ] **E13-015 实现 Claude thread/run mapper**。归属：Adapter/Claude。前置：E13-014。执行：把 Claude Code 的线程或 run 状态映射到统一 semantic 模型。验收：用户可在同一 UI 中浏览 Claude 线程/run。红线：不得让 Claude 成为 UI 的特殊硬编码分支。
- [ ] **E13-016 实现 adapter diagnostics 页**。归属：Desktop/Web。前置：E13-003。执行：在设置或诊断页展示 adapter 清单、健康状态、最近错误和 capability。验收：开发者可快速判断哪个 adapter 出问题。红线：不得把诊断数据埋在 DevTools。
- [ ] **E13-017 补 adapter fixture 测试**。归属：QA。前置：E13-006,E13-010~E13-015。执行：为 generic shell、Codex、Claude 生成独立 fixtures 和回归用例。验收：三类 adapter 都有 fixture 测试；回归可定位到 adapter 层。红线：不得只测首个 adapter。
- [ ] **E13-018 补双 adapter 共存 e2e**。归属：QA。前置：E13-002~E13-017。执行：验证在同一工作空间中两个 adapter 共存时 UI、协议、存储都不互相污染。验收：Codex 与 Claude 可共存；core mode 仍可用。红线：不得因为第二个 adapter 接入而改坏核心协议。


### EPIC-014 Agents, Runs & Approvals（18 项）

- [ ] **E14-001 定义 AgentProfile schema**。归属：Contract。前置：无。执行：固定 agentId、displayName、owner、provider、model、budgetPolicy、memoryScope、toolPolicy 等字段。验收：agent profile 可被所有客户端读取；字段有清晰释义。红线：不得把 profile 与运行时状态混为一体。
- [ ] **E14-002 定义 Run 对象 schema**。归属：Contract。前置：无。执行：固定 runId、agentId、status、startedAt、endedAt、topicId、worktreeId、costSummary 等字段。验收：run 可独立持久化与查询；fixture 覆盖 running/waiting/blocking/done。红线：不得把 run 当成消息文本附属字段。
- [ ] **E14-003 定义 RunStep 对象 schema**。归属：Contract。前置：E14-002。执行：为 run 的每一步固定 stepId、kind、status、inputRef、outputRef、startedAt、endedAt。验收：run step 可回放与排错；客户端不再靠纯文本日志猜步骤。红线：不得只保留最终结果不保留步骤边界。
- [ ] **E14-004 定义 Approval 对象 schema**。归属：Contract。前置：无。执行：固定 approvalId、subjectType、subjectId、requestedAction、status、requestedBy、resolvedBy、reason。验收：审批对象独立可查询；能挂在 run/tool/artifact 上。红线：不得把审批仅做成布尔字段。
- [ ] **E14-005 实现 run 创建与查询 API**。归属：Rust/Server。前置：E14-002。执行：提供 run 列表、详情与创建入口，先满足统一展示与追踪。验收：客户端可拉取 runs；创建新 run 有结构化响应。红线：不得要求客户端直接读 provider 私有状态。
- [ ] **E14-006 实现 run 状态机枚举与迁移规则**。归属：Rust Core。前置：E14-002。执行：固定 idle/planning/running/waiting_approval/blocked/done/error/cancelled 及合法转移。验收：非法转移会被拒绝并记录日志。红线：不得让 run 状态任意跳变。
- [ ] **E14-007 实现 run board 查询 API**。归属：Rust/Server。前置：E14-002,E14-006。执行：为 board 视图返回按状态分组的 run/agent 摘要。验收：桌面和移动端都可渲染 run board/queue。红线：不得让 board 直接自己扫全量 run。
- [ ] **E14-008 实现 budget policy 字段与聚合**。归属：Rust/Contract。前置：E14-001,E14-002。执行：把预算上限、已消耗、软硬阈值写入 profile/run，并计算聚合值。验收：用户可看到预算使用情况；阈值可触发 UI 警告。红线：不得把预算信息埋在 provider 原始日志。
- [ ] **E14-009 实现 memory scope 字段**。归属：Contract。前置：E14-001。执行：固定 agent 对 workspace/project/topic/personal memory 的可读写边界。验收：审批与权限系统可读取 memory scope。红线：不得让 memory 范围靠备注字段表达。
- [ ] **E14-010 实现 artifact emission 事件**。归属：Rust/Contract。前置：E14-002,E15-004。执行：当 run 产出 review/doc/task/decision 等结果时发出 artifact_emitted 事件。验收：Topic 与 Artifact 层可订阅此事件自动挂接。红线：不得把产出物只留在 provider 私有日志。
- [ ] **E14-011 实现审批请求 UI 组件**。归属：Desktop/Web/Mobile。前置：E14-004。执行：提供统一 approval card，展示动作、风险、目标对象、发起方和按钮。验收：同一组件可在桌面/移动复用不同密度样式。红线：不得用通用 confirm dialog 代替结构化审批。
- [ ] **E14-012 实现审批决策 API**。归属：Rust/Server。前置：E14-004。执行：提供 approve/reject/cancel 接口，并驱动对应 run/tool/adapter 后续动作。验收：审批结果可立即生效；重复决策有明确错误。红线：不得在客户端本地假更新状态。
- [ ] **E14-013 实现审批审计轨迹**。归属：Rust/Server。前置：E14-004,E20-008。执行：记录审批发起、查看、决策与超时事件。验收：审计日志可追溯谁在何时批准了什么。红线：不得只在 UI 上显示审批结果而无服务端记录。
- [ ] **E14-014 定义 automation/schedule trigger 模型**。归属：Contract。前置：E14-002。执行：为定时运行、周期 digest、批处理 run 定义 schedule 与 trigger 对象。验收：自动化运行可与手动运行共享 run 模型。红线：不得另起一套平行的任务模型。
- [ ] **E14-015 实现 run 取消 API**。归属：Rust/Server。前置：E14-002。执行：支持取消 running/planning/waiting 状态的 run，并返回取消原因。验收：用户可主动停止 run；取消后状态一致。红线：不得把 cancel 仅做 UI 标记不通知执行端。
- [ ] **E14-016 实现 run 重试 API**。归属：Rust/Server。前置：E14-002。执行：支持按最近输入与策略重新启动一个 run，并建立 predecessor/successor 关系。验收：重试后的 run 可追溯来源；原 run 记录保留。红线：不得原地覆盖旧 run。
- [ ] **E14-017 实现 run 成本聚合视图**。归属：Desktop/Web/Mobile。前置：E14-008。执行：在 run 详情与列表展示 token/cost/time 等聚合数据。验收：用户能快速判断 run 成本；空数据有明确缺失状态。红线：不得把成本埋在原始 provider 响应里。
- [ ] **E14-018 补 agents/runs/approvals 冒烟测试**。归属：QA。前置：E14-001~E14-017。执行：覆盖创建 run、状态推进、审批、取消、重试、artifact emission。验收：核心 agent/run 流程可自动回归。红线：不得只测 happy path 或纯读场景。


### EPIC-015 Topics & Artifacts（16 项）

- [ ] **E15-001 定义 Topic schema**。归属：Contract。前置：无。执行：固定 topicId、workspaceId、projectId、title、status、summary、participants、lastActivityAt 等字段。验收：topic 可独立持久化与查询。红线：不得把 topic 只当消息 thread 别名。
- [ ] **E15-002 定义 TopicStatus 枚举**。归属：Contract。前置：E15-001。执行：固定 open/needs_decision/waiting/done 等状态与合法转移。验收：各端状态颜色与行为可一致。红线：不得允许自由文本状态。
- [ ] **E15-003 定义 Message 作为 timeline item 的模型**。归属：Contract。前置：E15-001。执行：把 message 收敛为 timeline item 的一种，并保留 author、mentions、attachments、replyTo。验收：topic timeline 可混排 message/run/review/decision。红线：不得让 message 成为唯一一等对象。
- [ ] **E15-004 定义 ArtifactCard schema**。归属：Contract。前置：无。执行：固定 artifactId、kind、title、status、sourceRunId、linkedTopicId、preview 等字段。验收：artifact 卡可表达 task/doc/review/decision/file。红线：不得为每种 artifact 造完全不同的壳层模型。
- [ ] **E15-005 实现 topic 列表查询**。归属：Rust/Server。前置：E15-001。执行：提供 topic 列表接口，支持 project/status/watch 等过滤。验收：客户端可分页加载 topic；空列表返回清晰状态。红线：不得在列表接口里返回全量 timeline。
- [ ] **E15-006 实现 topic 详情查询**。归属：Rust/Server。前置：E15-001,E15-003,E15-004。执行：提供单个 topic 的摘要、timeline 首屏、关联 artifact/run。验收：进入 topic 可在 1 次请求中拿到首屏所需信息。红线：不得一次返回无上限全量历史。
- [ ] **E15-007 实现 run 绑定 topic API**。归属：Rust/Server。前置：E14-005,E15-001。执行：支持在 run 创建时指定 topicId 或事后补绑。验收：topic 内可看到关联 run；run 也能反查所属 topic。红线：不得只在客户端维护绑定关系。
- [ ] **E15-008 实现 DecisionCard 模型与渲染**。归属：Desktop/Web/Mobile。前置：E15-004。执行：为 decision artifact 提供专门的字段与卡片样式。验收：topic 中 decision 一眼可识别；可见状态与结论。红线：不得把 decision 和普通 message 混在一起。
- [ ] **E15-009 实现 TaskCard 模型与渲染**。归属：Desktop/Web/Mobile。前置：E15-004。执行：为 task artifact 提供 owner、status、dueAt、sourceMessage/sourceRun 等字段与 UI。验收：消息或 run 可转 task；task 在 topic 中可见。红线：不得先接外部任务系统再缺失本地模型。
- [ ] **E15-010 实现 ReviewCard 模型与渲染**。归属：Desktop/Web/Mobile。前置：E12-015,E15-004。执行：让 review 在 topic 中以独立 artifact card 展示。验收：从 topic 可直接打开 review；review 状态明确。红线：不得只放一个“查看 diff”文字链接。
- [ ] **E15-011 实现 artifact 附件区**。归属：Desktop/Web/Mobile。前置：E15-004。执行：为 topic 详情增加 artifact rail 或附件区，列出相关 review/doc/task/file。验收：用户可快速浏览 topic 关联物。红线：不得把 artifact 隐藏在二级标签里难以发现。
- [ ] **E15-012 实现 topic catch-up summary 插槽**。归属：Desktop/Web/Mobile。前置：E15-006,E16-008。执行：在 topic 详情顶部预留 AI catch-up 摘要区。验收：新成员进入 topic 时能先看 summary 再看 timeline。红线：不得把 catch-up 做成覆盖原始 timeline 的唯一视图。
- [ ] **E15-013 实现 Inbox 按 topic 聚合种子**。归属：Rust/Server。前置：E15-001,E14-004。执行：按 topic 聚合未读、待审批、待 review、待 follow-up 的对象。验收：用户有最小可用 inbox 聚合视图。红线：不得一开始做成复杂 IM 通知中心。
- [ ] **E15-014 实现 topic 导出 Markdown/JSON**。归属：Rust/Server。前置：E15-006。执行：支持导出 topic 的摘要、timeline、artifacts 为 Markdown/JSON。验收：用户可离线分享或归档 topic。红线：不得导出带未脱敏私密凭证。
- [ ] **E15-015 实现 topic ACL 检查点**。归属：Rust/Policy。前置：E20-005。执行：在 topic 查询、修改、导出等接口前挂载 ACL 校验。验收：无权限用户无法读取或修改 topic。红线：不得只在前端做权限隐藏。
- [ ] **E15-016 补齐 topic/artifact 冒烟测试**。归属：QA。前置：E15-001~E15-015。执行：覆盖 topic 创建/查询、绑定 run、显示 artifact、导出、ACL。验收：核心 topic 流程可自动回归。红线：不得仅凭人工探索验证。


### EPIC-016 Search, Memory & Handoff（14 项）

- [ ] **E16-001 定义 SearchChunk schema**。归属：Contract。前置：无。执行：固定 chunkId、sourceType、sourceId、text、highlights、permissions、capturedAt。验收：搜索结果可统一表达 inspect/topic/artifact 来源。红线：不得为每个来源返回完全不同结构。
- [ ] **E16-002 实现 inspect transcript 索引任务**。归属：Rust/Indexer。前置：E02-006,E16-001。执行：把 pane/tab inspect 内容切片后写入搜索索引。验收：Inspect 内容可被统一搜索；增量更新可工作。红线：不得只索引当前视口文本。
- [ ] **E16-003 定义 TopicMemory schema**。归属：Contract。前置：无。执行：固定 memoryId、scope=topic、summary、facts、citations、updatedBy、updatedAt。验收：topic memory 可独立展示与更新。红线：不得把 topic memory 写成无来源摘要。
- [ ] **E16-004 定义 ProjectMemory schema**。归属：Contract。前置：无。执行：固定 project 级 memory 的事实、决策、常用资源与 citations 结构。验收：project memory 与 topic memory 可区分。红线：不得把所有记忆都压成 workspace 级。
- [ ] **E16-005 定义 MemoryCitation schema**。归属：Contract。前置：E16-003,E16-004。执行：给 memory 中的事实加 sourceType、sourceId、span/anchor。验收：任意 memory 条目都可追到来源。红线：不得允许无来源事实进入长期记忆。
- [ ] **E16-006 实现 unified search API**。归属：Rust/Indexer。前置：E16-001,E16-002。执行：提供跨 inspect/topic/artifact/run 的统一搜索入口，支持 scope 和权限过滤。验收：用户一次搜索可得到多域结果并按组返回。红线：不得绕过权限过滤返回命中摘要。
- [ ] **E16-007 实现搜索结果分组 UI**。归属：Desktop/Web/Mobile。前置：E16-006。执行：在前端按 Runtime/Topic/Artifact/Run 分组显示搜索结果。验收：用户可在一屏理解命中来源分布。红线：不得把所有结果混成单一列表。
- [ ] **E16-008 实现 handoff digest 生成器**。归属：Backend/AI。前置：E15-001,E14-002。执行：为 topic/run/runtime 生成时区 handoff 摘要，突出当前状态、阻塞与下一步。验收：用户一醒来可在 60 秒内理解交接上下文。红线：不得生成无来源、不可追溯的 handoff。
- [ ] **E16-009 实现 daily digest 生成器**。归属：Backend/AI。前置：E16-008。执行：按用户关注的 topic/run/project 生成每日摘要。验收：用户可收到每天最小摘要；对象链接可直达。红线：不得把 digest 当作全量事件 dump。
- [ ] **E16-010 实现 weekly digest 生成器**。归属：Backend/AI。前置：E16-008。执行：按项目与团队维度生成周摘要。验收：周摘要可概括进展、阻塞、主要决策。红线：不得缺失引用与来源对象。
- [ ] **E16-011 实现 timezone-aware handoff 计划器**。归属：Backend。前置：E16-008。执行：根据用户时区与工作时间计算 handoff 生成与发送窗口。验收：跨时区用户在合适时间收到 handoff。红线：不得所有人用同一固定 UTC 时间发送。
- [ ] **E16-012 实现 citation UI 组件**。归属：Desktop/Web/Mobile。前置：E16-005。执行：在 summary/memory/digest 中把引用做成可点击回到原对象的组件。验收：用户能从摘要跳回原始 run/topic/inspect 段落。红线：不得只显示“据某处所说”而无链接。
- [ ] **E16-013 给 memory 写入挂审批规则**。归属：Policy/Backend。前置：E14-004,E16-003。执行：把写入长期 memory 的动作纳入审批或策略规则。验收：高风险记忆写入不会无审查落库。红线：不得允许 agent 自行写长期组织记忆无记录。
- [ ] **E16-014 补齐 search/memory/handoff 测试**。归属：QA。前置：E16-001~E16-013。执行：覆盖索引、搜索、权限过滤、digest、citation、memory 写审批。验收：核心协作继承链路可自动回归。红线：不得只验证生成成功而不验证来源可回跳。


### EPIC-017 Visualization Board（14 项）

- [ ] **E17-001 定义 BoardNode schema**。归属：Contract。前置：无。执行：固定 nodeId、kind、title、status、position、counts、linkedObject。验收：board 上不同对象可共用统一节点模型。红线：不得每块板子各用一套 node 结构。
- [ ] **E17-002 定义 BoardEdge schema**。归属：Contract。前置：E17-001。执行：固定 edgeId、from、to、kind、label、weight。验收：board 关系可统一表达 topic-run、run-artifact、runtime-pane 等。红线：不得靠前端临时拼关系。
- [ ] **E17-003 实现 agent board 查询**。归属：Rust/Server。前置：E14-007,E17-001。执行：按 agents/runs 状态返回 board node/edge 数据。验收：桌面可渲染 agent board；状态和计数正确。红线：不得把 agent board 直接扫全量原始 run。
- [ ] **E17-004 实现 runtime topology 查询**。归属：Rust/Server。前置：E02-008,E17-001。执行：返回 session/tab/pane 层级与连接状态的拓扑数据。验收：可视化展示当前 runtime 结构。红线：不得把 topology 只输出为自由文本。
- [ ] **E17-005 实现 topic board 查询**。归属：Rust/Server。前置：E15-006,E17-001。执行：返回 topic 与关联 run/artifact/decision/task 的关系图数据。验收：用户可从 topic 进入 board 视角。红线：不得遗漏对象类型标签。
- [ ] **E17-006 实现 timeline graph seed 查询**。归属：Rust/Server。前置：E02-008,E17-001。执行：为后续 timeline graph 提供最小节点/边数据源。验收：graph 可展示事件序列与关键节点。红线：不得在第一版就追求全量历史图。
- [ ] **E17-007 定义 presence 状态模型**。归属：Contract。前置：无。执行：固定 human/agent 的 online/focus/idle/busy/waiting 等 presence 字段。验收：presence 可在 board 与列表视图共享。红线：不得把 presence 只做成颜色点。
- [ ] **E17-008 实现 Agent Board UI**。归属：Desktop/Web。前置：E17-003。执行：渲染 agent board，支持状态分组、卡片与快速动作。验收：用户能一眼看清哪些 agent 在跑、卡住或等审批。红线：不得做成静态图不支持交互。
- [ ] **E17-009 实现 Runtime Topology UI**。归属：Desktop/Web。前置：E17-004。执行：渲染 session-tab-pane 拓扑视图，支持点击跳转到对应对象。验收：拓扑视图可成为 Inspect/Live 的辅助入口。红线：不得只做导出 PNG。
- [ ] **E17-010 实现 Topic Board UI**。归属：Desktop/Web。前置：E17-005。执行：渲染 topic-run-artifact 关系图。验收：topic 上下文可视化可用且可点击。红线：不得让标签重叠到无法读。
- [ ] **E17-011 实现 hover/drill-down 卡片**。归属：Desktop/Web。前置：E17-008~E17-010。执行：对 board 节点提供 hover 卡片与 drill-down 到详情页。验收：用户可从 board 快速跳到具体对象。红线：不得只做 hover 无法点击定位。
- [ ] **E17-012 实现 board 内过滤与搜索**。归属：Desktop/Web。前置：E17-008~E17-010。执行：支持按状态、类型、owner 搜索和过滤节点。验收：大图景下仍可快速缩小范围。红线：不得把过滤实现成重载整页刷新。
- [ ] **E17-013 实现大图性能保护**。归属：Desktop/Web。前置：E17-008~E17-012。执行：为节点数过多场景加聚合、虚拟化或分层加载。验收：中大型图不会因一次渲染卡死。红线：不得让首个大图就把桌面拖死。
- [ ] **E17-014 补齐 board 截图回归测试**。归属：QA。前置：E17-008~E17-013。执行：为 agent/runtime/topic 三块 board 建立截图与交互回归。验收：UI 改动后可快速发现布局退化。红线：不得频繁重录基线掩盖问题。


### EPIC-018 Self-host, Relay & Packaging（14 项）

- [ ] **E18-001 优化 npx remux 启动输出**。归属：CLI/TS。前置：无。执行：让 CLI 启动输出更明确显示本地 URL、relay URL、token、QR 与安全提示。验收：首次启动时用户知道下一步怎么连。红线：不得输出冗长噪音遮住关键连接信息。
- [ ] **E18-002 建立跨平台二进制打包清单**。归属：Release。前置：无。执行：为 macOS/Windows/Linux/iOS helper/Android helper 列出产物、命名、版本注入规则。验收：打包清单文档化且纳入 CI。红线：不得每个平台各自发明版本规则。
- [ ] **E18-003 实现 Homebrew formula 自动更新**。归属：Release。前置：E18-002。执行：为 macOS CLI/runtime 产物自动生成或更新 Homebrew formula。验收：新版本发布后 brew 可安装。红线：不得手工改 formula 导致版本漂移。
- [ ] **E18-004 实现 winget manifest 自动更新**。归属：Release。前置：E18-002。执行：为 Windows 产物生成 winget manifest。验收：Windows 用户可通过 winget 安装。红线：不得只提供 zip 手工下载。
- [ ] **E18-005 实现 AppImage 构建配方**。归属：Release。前置：E18-002。执行：为 Linux 桌面建立 AppImage 打包脚本。验收：Linux 用户可直接下载运行。红线：不得只支持源码安装。
- [ ] **E18-006 提供 launchd 服务脚本**。归属：Ops/macOS。前置：E18-002。执行：为 macOS 自托管用户提供 launchd 安装、卸载与日志说明。验收：用户可把 remuxd 作为用户服务运行。红线：不得默认以 root 服务安装。
- [ ] **E18-007 提供 systemd user 服务脚本**。归属：Ops/Linux。前置：E18-002。执行：为 Linux 提供 systemd --user 服务模板与安装命令。验收：用户可一键启动和开机自启。红线：不得强依赖系统级 root 权限。
- [ ] **E18-008 提供 Windows 服务脚本**。归属：Ops/Windows。前置：E18-002。执行：为 Windows 自托管提供 service 安装/卸载脚本。验收：用户可把 runtime/helper 作为服务运行。红线：不得要求手工注册服务且无文档。
- [ ] **E18-009 提供 relay 部署 Compose 示例**。归属：Ops。前置：E05-013。执行：给 remux-relay 提供 docker-compose 或等价部署样例。验收：用户可参考样例快速部署 relay。红线：不得只给伪代码级文档。
- [ ] **E18-010 编写 Tailscale 接入指南**。归属：Docs/Ops。前置：E18-009。执行：为用户写一份使用 Tailscale 直连/替代 relay 的指南。验收：文档可直接照做；优缺点说明清楚。红线：不得写成与当前产品不兼容的旧流程。
- [ ] **E18-011 编写 self-host 快速开始文档**。归属：Docs。前置：E18-001~E18-010。执行：给首次自托管用户提供从安装到手机接入的最短路径文档。验收：新用户 15 分钟内可完成冷启动。红线：不得把关键步骤分散在多个老文档。
- [ ] **E18-012 编写备份/恢复文档**。归属：Docs/Ops。前置：E03-001。执行：说明 metadata、recordings、devices 的备份范围与恢复步骤。验收：用户可安全备份与恢复 runtime 数据。红线：不得遗漏 sensitive data 处理说明。
- [ ] **E18-013 维护版本兼容矩阵文档**。归属：Docs/Release。前置：E06-013,E18-002。执行：把 runtime/web/native/relay 版本兼容关系发布在一处。验收：用户和开发者都能查到兼容组合。红线：不得让版本矩阵过期超过一个发布周期。
- [ ] **E18-014 补齐 packaging/self-host 冒烟测试**。归属：QA/Ops。前置：E18-001~E18-013。执行：对安装、启动、二维码连接、relay、自托管恢复进行冒烟验证。验收：发布前可验证交付链路完整。红线：不得只测开发机本地源码运行。


### EPIC-019 Test Matrix & Quality Gates（18 项）

- [ ] **E19-001 建立协议 contract CI lane**。归属：DevEx/QA。前置：E06-014。执行：把 schema、fixtures、compatibility 和生成物校验单独做成 CI job。验收：协议改动会独立失败并给出明确报告。红线：不得把协议回归埋在大杂烩脚本里。
- [ ] **E19-002 为 Rust 单测设最低覆盖门槛**。归属：Rust QA。前置：无。执行：对 core crates 设覆盖阈值或关键模块白名单。验收：关键 crate 覆盖率可见且逐步提升。红线：不得为过线而写无意义测试。
- [ ] **E19-003 建立 Web 组件截图回归 lane**。归属：TS QA。前置：无。执行：对 Inspect、badges、board、review 等关键组件建立截图基线。验收：UI 变更时可自动比较视觉差异。红线：不得把截图 lane 当成可长期跳过的可选项。
- [ ] **E19-004 把 width gate 设为必过检查**。归属：QA。前置：无。执行：把终端宽度与布局一致性检查纳入 merge gate。验收：改终端/布局代码时 width gate 必跑。红线：不得因为偶发失败就整体移除 width gate。
- [ ] **E19-005 实现 reconnect chaos harness**。归属：QA/Infra。前置：E05-017。执行：模拟抖动、断网、延迟、重连顺序错乱，验证 Inspect/Live/lease 行为。验收：能自动复现断线重连场景并判断结果。红线：不得把 chaos test 简化成单次断开重连 happy path。
- [ ] **E19-006 实现 device trust 集成测试组**。归属：QA。前置：E05-018。执行：把 pairing、trusted reconnect、revoke、push registration 放入统一测试组。验收：设备层关键链路可自动回归。红线：不得只测扫码成功。
- [ ] **E19-007 建立 native decode 测试 lane**。归属：QA。前置：E06-011,E06-012。执行：把 Swift/Kotlin/C# decode 测试接入 CI。验收：协议变更会同步校验原生客户端。红线：不得把 native 解码测试留在本地手跑。
- [ ] **E19-008 建立 iOS 关键路径 UI 测试**。归属：Apple QA。前置：E07-024。执行：覆盖配对、Now、Inspect、Live、通知 deep link。验收：iOS 核心路径在 nightly 至少跑一次。红线：不得所有 UI 测试都跳过真网络/假服务器契约。
- [ ] **E19-009 建立 Android 关键路径 UI 测试**。归属：Android QA。前置：E08-018。执行：覆盖配对、Now、Inspect、Live、通知 deep link。验收：Android 核心路径在 nightly 至少跑一次。红线：不得长期缺席移动自动化。
- [ ] **E19-010 建立桌面端 smoke 聚合任务**。归属：Desktop QA。前置：E09-018,E10-014,E11-012。执行：在 CI 中聚合 macOS/Windows/Linux 的最小冒烟套件。验收：三桌面端都有基本启动与连接验证。红线：不得只跑 macOS。
- [ ] **E19-011 建立 relay path e2e**。归属：QA/Ops。前置：E18-009。执行：让 e2e 覆盖经 relay 的 Inspect/Live/通知路径。验收：relay 路径不再是发布前盲区。红线：不得只测局域网直连。
- [ ] **E19-012 建立性能基准任务**。归属：Perf。前置：无。执行：每周定时跑 attach latency、inspect first paint、diff render、reconnect 成功率基准。验收：性能趋势可见且可回溯。红线：不得只在出现投诉后才测性能。
- [ ] **E19-013 实现 npm pack / installer dry-run 校验**。归属：Release QA。前置：E18-002。执行：在 release gate 增加 npm 包、安装包和主要分发物的 dry-run 校验。验收：发布前能发现缺文件、错版本、脚本失效。红线：不得把打包验证留到用户下载后。
- [ ] **E19-014 实现 changelog 影响检查**。归属：DevEx。前置：无。执行：要求影响 public behavior 的 PR 必须更新 changelog 或 release notes fragment。验收：没有变更说明的用户可见改动无法合并。红线：不得让 changelog 成为发布最后一天手工补。
- [ ] **E19-015 实现 docs 影响检查**。归属：DevEx/Docs。前置：无。执行：要求协议、CLI、UI 可见变更附带 docs impact 标记。验收：PR 中能看出是否需要更新文档。红线：不得合并后再“以后补文档”。
- [ ] **E19-016 实现 flaky 测试隔离与恢复流程**。归属：QA/DevEx。前置：无。执行：建立 flaky 标记、隔离池与恢复 SLA。验收：不稳定测试不会无限污染主 gate；恢复责任清晰。红线：不得用永久 skip 取代修复。
- [ ] **E19-017 固化 release checklist 模板**。归属：Release。前置：E19-013~E19-015。执行：把稳定版发布前必做的测试、文档、打包、回滚确认写成模板。验收：每次发布按单执行；责任人明确。红线：不得依赖口头发布流程。
- [ ] **E19-018 建立 nightly/alpha/beta/stable 晋级工作流**。归属：Release。前置：E19-017。执行：定义发布通道、晋级条件、回滚条件与自动化流程。验收：发布不再只靠手工复制产物；可按通道晋级。红线：不得 stable 与 nightly 共享同一无差别流程。


### EPIC-020 Team Mode Foundations（14 项）

- [ ] **E20-001 定义 WorkspaceIdentity schema**。归属：Contract。前置：无。执行：固定 workspaceId、name、owner、plan、visibility 等团队空间基础字段。验收：多人模式有独立工作空间对象。红线：不得继续借用单机 runtime 对象充当团队空间。
- [ ] **E20-002 定义 ProjectIdentity schema**。归属：Contract。前置：E20-001。执行：固定 projectId、workspaceId、name、slug、visibility、defaultPolicies。验收：project 能作为 topic/run/artifact 的归属边界。红线：不得把 project 简化成自由标签。
- [ ] **E20-003 定义 Membership schema**。归属：Contract。前置：E20-001。执行：为 user/agent/app 在 workspace/project 中的 membership 固定角色与状态。验收：成员关系可独立查询；human/agent/app 统一表达。红线：不得每个对象各自维护一套成员结构。
- [ ] **E20-004 定义 RBAC 角色枚举**。归属：Contract/Policy。前置：E20-003。执行：固定 owner/admin/member/guest/agent/app 等基础角色与默认能力。验收：权限系统有统一角色基础。红线：不得以自由文本角色驱动权限判断。
- [ ] **E20-005 实现 topic ACL 校验**。归属：Policy/Server。前置：E20-001~E20-004。执行：在 topic 读写、导出、评论、挂 artifact 时执行 ACL 检查。验收：无权用户无法越权访问 topic。红线：不得只在 UI 隐藏按钮。
- [ ] **E20-006 实现 artifact ACL 校验**。归属：Policy/Server。前置：E20-001~E20-004。执行：在 artifact 查看、评论、下载、外发动作前执行 ACL 检查。验收：敏感 artifact 访问受控。红线：不得因为 artifact 来源于 run 就跳过权限检查。
- [ ] **E20-007 实现 approval policy hook**。归属：Policy/Server。前置：E14-004,E20-004。执行：在审批发起前根据角色、对象类型、风险级别套用策略。验收：高风险操作可被强制审批或禁止。红线：不得让审批规则散落在各 adapter 中。
- [ ] **E20-008 定义 AuditLog schema**。归属：Contract。前置：无。执行：固定 auditId、actor、action、objectType、objectId、result、timestamp、metadata。验收：审计事件结构统一。红线：不得只记录自由文本。
- [ ] **E20-009 实现审计事件写入器**。归属：Server。前置：E20-008。执行：为关键对象读写、审批、撤销设备、权限变更写审计日志。验收：关键动作均有服务端审计记录。红线：不得依赖客户端上报补审计。
- [ ] **E20-010 实现 Audit 查询界面**。归属：Desktop/Web。前置：E20-008,E20-009。执行：提供按 actor/action/object/time 查询审计的最小页面。验收：管理员可自助排查关键操作。红线：不得让审计只能在数据库里查。
- [ ] **E20-011 写一份 SSO 兼容设计说明**。归属：Architecture。前置：E20-001。执行：明确未来接入 SSO/OIDC/SAML 时的身份边界与 token 交换点。验收：团队模式未来接企业认证有路径。红线：不得现在就引入庞大企业集成实现。
- [ ] **E20-012 预留 enterprise config hooks**。归属：Server。前置：E20-001,E20-004。执行：在配置层预留策略、branding、retention、domain allowlist 等钩子。验收：未来企业版扩展不必重构核心模型。红线：不得现在就实现大量未验证企业功能。
- [ ] **E20-013 实现 admin revoke member 动作**。归属：Server/UI。前置：E20-003,E20-004。执行：支持管理员撤销成员或 agent 对 workspace/project 的访问。验收：撤销后权限即时生效并产生日志。红线：不得只从 UI 列表移除而不更新服务端策略。
- [ ] **E20-014 补齐多用户权限回归测试**。归属：QA。前置：E20-001~E20-013。执行：覆盖 human/agent/app、owner/admin/member/guest 的主要访问矩阵。验收：权限边界自动可测。红线：不得只测 owner happy path。

