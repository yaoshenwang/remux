# Remux Next 全端 AI 原生工作空间平台总规划（2026 重制版 v2.1）

**版本**：2.1
**基线**：当前 remux 主仓库 dev 分支 (v0.2.65) 实际代码审计
**日期**：2026-03-31

> 本文档基于 v2 的架构框架，反映 E01--E06 全部完成后的项目现状。v2.1 变更要点：E01--E06 标记完工、引入开源复用原则、整合 cmux 等竞品分析洞察、pnpm 迁移与 TypeScript 6.0 升级。

---

# 文档目的

v1.1 规划的战略方向正确，但其执行层严重脱离仓库现实——大量假设项目已有成熟 Rust runtime core（`apps/remuxd`、`crates/remux-*`），而实际上整个后端是纯 TypeScript + Zellij 进程。本 v2 的目标是：

1. **修正事实基线**：以 2026-03-30 dev 分支代码审计结果为唯一事实源
2. **保留战略方向**：全端、AI 原生、workspace OS 的三阶段演进不变
3. **落地执行路径**：基于真实技术栈给出可执行的里程碑、Epic 与 Checklist
4. **明确平台技术选型**：桌面端使用 Tauri，iOS 使用 SwiftUI 原生，Android 使用 Kotlin 原生

---

# 1. 当前仓库真实现状（代码审计结果）

## 1.1 技术栈事实

| 层 | 实际技术 | 说明 |
|---|---|---|
| 后端服务器 | TypeScript + Express 5 + ws | `src/backend/server-zellij.ts`，双 WebSocket 通道 |
| 终端复用器 | Zellij（外部进程） | 通过 `ZellijController` 调用 CLI，通过 `ZellijPty` node-pty 连接 |
| 前端 | React 19 + Vite 8 + xterm.js | SPA，glassmorphism 主题，移动优先布局 |
| CLI | TypeScript（yargs） | `cli-zellij.ts` 主入口，`cli-tmux-compat.ts` tmux 适配 |
| TUI 客户端 | Go + Bubbletea | `tui/` 目录，多主机连接管理 |
| 原生桥接 | Rust（仅 zellij-bridge） | `native/zellij-bridge/`，辅助桥接，非独立 runtime |
| 测试 | Vitest + Playwright | 单元测试 + 浏览器 E2E + 宽度验收 |
| 分发 | npm 包（`npx remux`） | v0.2.65，公开发布，pnpm 管理 |

**关键澄清**：

- **不存在** `apps/remuxd` Rust runtime daemon
- **不存在** `crates/remux-*` Rust crate 体系
- **不存在** `Cargo.toml` workspace 配置
- **不存在** `WorkspaceSnapshot` 或 `RuntimeSnapshot` 类型
- Rust 代码仅限于 `native/zellij-bridge/target/` 下的编译产物

## 1.2 已实现的核心能力

### 服务端

- **双 WebSocket 通道**：`/ws/terminal`（终端 I/O）+ `/ws/control`（工作空间状态与命令）
- **独立认证**：两个通道分别认证，token + 可选密码，timing-safe 比较
- **Per-client PTY**：每个浏览器客户端获得独立的 Zellij attach 进程
- **工作空间控制**：tab/pane 的 CRUD、全屏切换、inspect 抓取、session 重命名
- **终端状态追踪**：xterm-headless + SerializeAddon 实现 mosh 式状态差异，支持断线重连秒恢复
- **带宽统计**：滚动窗口采样，压缩率、RTT 测量，每 5 秒广播
- **扩展系统**：Extensions hub 集成通知、带宽、Gastown、事件监听
- **隧道提供者**：Cloudflare（公共隧道）+ DevTunnel（Entra 认证），自动检测
- **tmux 兼容适配器**：`remux-tmux` 二进制翻译 tmux 命令到 Zellij
- **ConPTY 提供者**：Windows 或无复用器平台的 fallback
- **文件上传**：剪贴板图片粘贴 + 文件选择，最大 50MB
- **Web Push**：VAPID 密钥生成 + 订阅管理（实际推送未完成）
- **事件监听**：监视 Copilot/Claude Code 的 events.jsonl 文件

### 前端

- **三视图**：Live（终端直操）、Inspect（文本抓取阅读）、Control（tab/pane 结构化控制）
- **移动优先**：触摸友好工具栏、虚拟键盘适配、ComposeBar、手势
- **WebGL 终端渲染**：xterm.js + 可选 WebGL 加速
- **本地回显预测**：按键即时回显，服务器响应对账
- **帧率限流写入**：64KB/帧上限，防卡顿
- **自动重连**：指数退避（1s→8s，最多 10 次）+ 心跳保活
- **主题**：暗色/亮色双主题，CSS 自定义属性
- **密码认证 UI**：懒加载叠加层

### Go TUI 客户端

- **多主机连接**：统一会话视图
- **双通道认证**：与 Web 客户端共享同一协议
- **会话选择器**：vi 键绑定导航
- **配置持久化**：`~/.remux/hosts.json`

## 1.3 已有但不完整的能力

| 能力 | 状态 | 说明 |
|------|------|------|
| Web Push 通知 | ✅ 已完成 (E06) | RFC 8030/8291 推送链路完整，VAPID 密钥管理、订阅持久化、推送触发均已实现 |
| Inspect 视图 | ✅ 已完成 (E02) | 完整元数据（precision/source/staleness）、分页、搜索、历史服务 |
| 协议 envelope | ✅ 已完成 (E03) | domain envelope 格式上线，向后兼容旧客户端，含 iOS/Android 模型 |
| Device Trust | ✅ 已完成 (E05) | QR 配对、设备信任存储（SQLite）、resume token (JWT)、设备管理 UI |
| Client Connection State | ✅ 已完成 (E04) | 多客户端状态透出、观察/活跃模式、连接生命周期管理 |
| ConPTY server | 提供者已实现 | 未接入 HTTP server（server-zellij.ts 硬编码 Zellij） |
| DevTunnel 认证 | Entra 标志位已设 | 中间件未完整接入 Express |
| 文件浏览器 | API 已实现 | 安全与性能审查未做 |
| 事件监听 | 文件监视 + JSONL 解析 | 无 WebSocket 通道广播到客户端（E10 范畴） |

## 1.4 WebSocket 协议现状

### Terminal 通道 (`/ws/terminal`)
```
Client → Server: { type: "auth", token, password?, cols?, rows? }
Server → Client: { type: "auth_ok" } | { type: "auth_error", reason }
Client → Server: Raw bytes（用户输入）| { type: "resize", cols, rows } | { type: "ping", timestamp }
Server → Client: Terminal output（文本或二进制帧）| { type: "pong", timestamp }
```

### Control 通道 (`/ws/control`)
```
Commands: subscribe_workspace, new_tab, close_tab, select_tab, rename_tab,
          new_pane, close_pane, toggle_fullscreen, capture_inspect, rename_session
Broadcasts: workspace_state, bandwidth_stats
```

### 工作空间数据模型
```typescript
interface WorkspaceState {
  session: string
  tabs: WorkspaceTab[]
  activeTabIndex: number
}
interface WorkspaceTab {
  index: number; name: string; active: boolean
  isFullscreen: boolean; hasBell: boolean; panes: WorkspacePane[]
}
interface WorkspacePane {
  id: string; focused: boolean; title: string
  command: string | null; cwd: string | null
  rows: number; cols: number; x: number; y: number
}
```

## 1.5 仓库目录结构

```
remux/
├── src/
│   ├── backend/
│   │   ├── auth/                  # Token + 密码认证
│   │   ├── cli-zellij.ts          # 主 CLI 入口
│   │   ├── cli-tmux-compat.ts     # tmux 兼容适配器
│   │   ├── cloudflared/           # Cloudflare 隧道
│   │   ├── events/                # Copilot 事件监听
│   │   ├── extensions.ts          # 扩展集成中心
│   │   ├── gastown/               # Gastown 工作空间检测
│   │   ├── notifications/         # Web Push 管理
│   │   ├── providers/             # 后端检测（Zellij/tmux/ConPTY）
│   │   ├── pty/                   # Zellij PTY 封装
│   │   ├── server-zellij.ts       # 主 WebSocket 服务器
│   │   ├── stats/                 # 带宽统计
│   │   ├── terminal-state/        # xterm-headless 状态追踪
│   │   ├── tunnels/               # 隧道提供者抽象
│   │   ├── util/                  # 工具函数
│   │   └── zellij-controller.ts   # Zellij CLI 命令封装
│   └── frontend/
│       ├── App.tsx                # 主应用
│       ├── components/            # UI 组件
│       ├── hooks/                 # React Hooks
│       ├── screens/               # 布局屏幕
│       ├── styles/                # CSS（2631 行）
│       └── ...                    # 渲染器、主题、上传等
├── native/
│   └── zellij-bridge/             # Rust Zellij 桥接（辅助）
├── tui/                           # Go TUI 客户端
├── tests/
│   ├── backend/                   # Vitest 后端测试
│   ├── frontend/                  # Vitest 前端测试
│   └── e2e/                       # Playwright 浏览器测试
├── docs/                          # 文档
├── package.json                   # v0.2.55
├── vite.config.ts                 # 前端构建
├── vitest.config.ts               # 测试配置
├── playwright.config.ts           # E2E 配置
├── tsconfig.json                  # 基础 TS 配置
├── tsconfig.backend.json          # 后端编译
└── tsconfig.frontend.json         # 前端编译
```

## 1.6 v1.1 规划中的事实错误清单

以下是 v1.1 中与实际不符的关键假设，本 v2 已全部修正：

| v1.1 声称 | 实际情况 | v2 处理 |
|-----------|---------|---------|
| 已有 Rust runtime core（`apps/remuxd` + `crates/remux-*`） | 不存在，后端是纯 TypeScript | 所有 "Rust Core" 任务改为 TS Server 任务 |
| `Cargo.toml` workspace 已存在 | 不存在 | 移除 Cargo 相关引用 |
| `WorkspaceSnapshot` 类型需要迁移为 `RuntimeSnapshot` | 不存在此类型 | 移除此迁移任务 |
| `Scroll` 是当前主名称需全面改名 | 前端已有 `InspectView.tsx`，部分已迁移 | 保留清理任务但缩减范围 |
| 双通道协议已有 domain-based envelope | 当前是简单 JSON 消息，无 domain 前缀 | 新增协议升级任务 |
| macOS 桌面用 SwiftUI + AppKit | 用户决定用 Tauri | 改为 Tauri |
| Windows 桌面用 WinUI 3 | 用户决定用 Tauri | 改为 Tauri |
| Linux 桌面用 GTK4 | 用户决定用 Tauri | 改为 Tauri |
| 团队规模 7~12 人 | 个人项目 | 调整执行节奏为个人可执行 |

---

# 2. 北极星目标与必赢标准

> 此章节战略方向与 v1.1 一致，但调整了对标策略与现实约束。

## 2.1 五个非谈判目标

### 目标 A：必须全端

Remux 必须有官方支持的：

- Web（当前已有，持续增强）
- macOS / Windows / Linux 桌面（Tauri）
- iOS（SwiftUI 原生）
- Android（Kotlin + Jetpack Compose 原生）
- CLI / Headless（当前已有）
- Go TUI（当前已有）

### 目标 B：终端产品力必须超过 Ghostty / Termius

不只是"能开一个远程终端"，而是：

> "Ghostty / Termius 提供的是终端或远程连接工具；
> Remux 提供的是可理解、可干预、可协作、可跨设备延续、可接入 Agent 的工作空间本身。"

### 目标 C：桌面端必须正面对标 Claude Desktop / Codex app

Tauri 桌面应用必须做到：

- 更多运行时真相（runtime truth）
- 更强跨设备连续性（desktop ↔ mobile ↔ web）
- 更强多 agent 可视化
- 更强自托管与多 runtime 兼容

### 目标 D：手机端连接必须堪比原生，至少达到 Remodex 级别

iOS / Android 原生客户端至少匹配 Remodex 已验证的能力集，并进一步叠加 Inspect/Live/Control 三层。

### 目标 E：最终界面要类 IM，但本质是 AI-native workspace OS

一等对象是 Topic、Agent、Artifact、Run、Review、Approval、Memory、Timeline、Runtime context。Message 只是入口。

## 2.2 成功定义（北极星）

> **每周被 Remux 成功观测、理解、干预并推进的有效工作空间单元数。**

## 2.3 体验底线

- 手机首次 attach 不超过 10 秒（冷启动 + 远程网络）
- 已配对设备重连不超过 3 秒（同网络质量下）
- Inspect 首屏必须比 Live 更快、更稳、更可读
- 任意 agent run 都必须可见当前状态、上下文、资源边界
- 桌面端核心流程不强迫回到纯终端
- Web 全局可用，桌面是旗舰，移动是干预旗舰

---

# 3. 总体路线：三次跃迁，一条主线

## 3.1 Phase A：Runtime Cockpit（现在到 3 个月）

**核心任务**：做实身份，打通全端骨架

- Inspect 能力从"基础抓取"升级为带元数据的真实历史服务
- 协议从简单 JSON 升级为 domain envelope 格式
- Tauri 桌面壳上线（macOS / Windows / Linux 共享代码）
- iOS SwiftUI 原生客户端 alpha
- Android Kotlin 原生客户端骨架
- Device trust / pairing / relay 打底
- Web Push 推送完整实现

**阶段成功标志**：
一个用户能从手机（iOS 原生）、桌面（Tauri）、浏览器三端访问同一个 runtime 工作空间。

## 3.2 Phase B：Agentic Workstation（3 到 9 个月）

**核心任务**：从 cockpit 变成 agent 工作站

- Tauri 桌面旗舰功能完善
- worktree / branch / diff / review / preview / Git actions
- semantic adapter 深度集成（Claude Code、Codex）
- run board、approval center、topic binding
- iOS/Android 支持 plan / steer / queue / quick review

**阶段成功标志**：
用户可以在 Tauri 桌面端驱动多 agent 并行工作，在 iPhone 上审批，不需要 Claude Desktop / Codex app。

## 3.3 Phase C：Collaboration OS（9 到 18 个月）

**核心任务**：长出类 IM 协作外壳

- Workspace / Project / Topic / Message / Artifact / Inbox / Handoff
- Multi-user presence、team permissions、audit
- Agent board、Topic board、Runtime topology 可视化

**阶段成功标志**：
团队不再需要在五个工具间切换。

## 3.4 顺序不能反的原因

1. 先做 Runtime truth
2. 再做 Native surfaces
3. 再做 Agent work layer
4. 最后收进 Collaboration shell

---

# 4. 全端客户端技术选型

## 4.1 平台技术选型（最终决定）

| 平台 | 技术栈 | 理由 |
|------|--------|------|
| Web | React 19 + Vite + xterm.js（现有） | 已成熟，继续增强 |
| macOS 桌面 | **Tauri 2** + 现有 React 前端 | 复用前端资产，系统级 API 访问 |
| Windows 桌面 | **Tauri 2** + 现有 React 前端 | 同一代码库，跨平台桌面 |
| Linux 桌面 | **Tauri 2** + 现有 React 前端 | 同一代码库，跨平台桌面 |
| iOS | **SwiftUI** + WKWebView（终端桥接） | 原生体验，推送通知，系统集成 |
| Android | **Kotlin + Jetpack Compose** + WebView（终端桥接） | 原生体验，前台服务，widgets |
| CLI | TypeScript（现有） | `npx remux`，冷启动入口 |
| Go TUI | Go + Bubbletea（现有） | 多主机终端客户端 |

## 4.2 Tauri 桌面策略

### 为什么选 Tauri 而不是三套原生

1. **现有前端资产复用**：React + Vite 前端直接嵌入，无需重写 UI
2. **跨平台一致性**：macOS / Windows / Linux 共享同一代码库
3. **系统级能力**：系统 tray、全局快捷键、通知中心、菜单栏、文件拖放
4. **Rust 后端能力**：Tauri 的 Rust 侧可以逐步承担更多本地逻辑
5. **个人项目现实**：三套原生桌面对个人开发者不现实

### Tauri 桌面必须具备的能力

1. 系统 Tray 常驻（quick attach / quick approve / status）
2. 全局热键召唤
3. 系统通知（run 完成、approval 请求、lease 丢失）
4. 菜单栏集成（macOS menu bar）
5. 文件拖放与系统剪贴板
6. 多窗口支持
7. 开机自启动（可选）
8. 后台运行（最小化到 tray 继续连接）
9. 本地数据缓存（SQLite via Tauri plugin）
10. 深链接处理（remux:// 协议）

### Tauri 版本与插件

- Tauri 2.x（稳定版）
- `@tauri-apps/plugin-notification`
- `@tauri-apps/plugin-shell`
- `@tauri-apps/plugin-clipboard-manager`
- `@tauri-apps/plugin-fs`
- `@tauri-apps/plugin-sql`（SQLite）
- `@tauri-apps/plugin-deep-link`
- `@tauri-apps/plugin-autostart`
- `@tauri-apps/plugin-global-shortcut`
- `@tauri-apps/plugin-window-state`

## 4.3 iOS 原生策略

### 技术栈

- SwiftUI（UI 框架）
- WKWebView + xterm.js（终端渲染桥接，v1）
- URLSession + NWConnection（网络层）
- Keychain（设备凭据存储）
- APNs（推送通知）
- Live Activities（实时状态）
- Camera / Photos（文件附件）
- Biometric（Face ID / Touch ID 锁定）

### 为什么不用 Tauri iOS

Tauri 2 虽然支持 iOS target，但：
- 移动端需要深度系统集成（APNs、Live Activities、Share Sheet、Shortcuts）
- SwiftUI 的移动端手势和导航体验远优于 WebView 壳
- App Store 审核对 WebView 壳应用有严格限制
- iOS 端的产品目标是"口袋里的 command center"，必须原生

### iOS v1 终端策略

允许第一版使用 WKWebView + xterm.js 作为终端渲染桥接（与 `IOS_CLIENT_CONTRACT.md` 一致），但 shell 必须是 SwiftUI 原生。长期评估原生终端渲染器。

## 4.4 Android 原生策略

### 技术栈

- Kotlin + Jetpack Compose（UI 框架）
- WebView + xterm.js（终端渲染桥接，v1）
- OkHttp + WebSocket（网络层）
- EncryptedSharedPreferences（凭据存储）
- FCM（推送通知）
- Foreground Service（后台保活）
- Widgets（快速操作）
- Share Intent（分享）
- Biometric Prompt（指纹/面部锁定）

## 4.5 CLI / Headless 保留

`npx remux` 不能消失，但职责重新定义为：

- 最快安装方式
- 本地 runtime 启动器
- Web/relay bootstrap
- 原生 apps 的配对入口
- CI / demo / headless mode

## 4.6 Go TUI 保留并增强

`tui/` 已有多主机连接能力，继续增强：

- 完善 Inspect 模式（纯文本）
- 支持 device trust / resume token
- 作为 SSH 内的轻量远程客户端

---

# 5. 产品体验蓝图

## 5.1 七个核心视图

1. **Inspect**：阅读、追赶、理解、检索、复制
2. **Live**：终端直接输入与低延迟操作
3. **Control**：session/tab/pane/worktree/agent 结构化控制
4. **Review**：diff、comment、artifact、approval、PR 状态
5. **Agents**：agent roster、run cards、budget、tool use、state
6. **Topics**：类 IM / topic timeline / artifact rail / decision view
7. **Command Center**：跨 runtime、跨 project、跨 topic 的总控台

## 5.2 Desktop Shell（Tauri 旗舰界面）

```text
+-------------------------------------------------------------+
| Top Bar: Workspace / Search / Global Commands               |
+--------+------------------------------+---------------------+
| Left   | Main Canvas                  | Right Rail          |
| Rail   | - Inspect / Live / Diff      | - Agents            |
| - Tabs | - Topic / Run / Review       | - Artifacts         |
| - Panes| - Preview / Timeline         | - Approvals         |
| - Views|                              | - Context           |
+--------+------------------------------+---------------------+
| Bottom: Command Palette / Quick Actions / Status            |
+-------------------------------------------------------------+
```

关键不是"放更多面板"，而是：

- 一个窗口串起执行、审查、上下文、Agent、审批
- 多窗口、多工作区并行
- 系统级集成（tray、notifications、global hotkey）

## 5.3 Mobile Shell（原生 Command Center）

手机端不是缩小版桌面。产品逻辑：

- 默认进入 **Now / Watchlist / Inbox**
- 第一屏看到"现在最重要的 3 件事"
- 所有高频操作两步内完成

导航：

- **Now**：当前关注的 runtime/topic/run
- **Inspect**：默认阅读界面
- **Runs**：agent runs / approvals / alerts
- **Topics**：最近 topic / handoff / inbox
- **Me**：设备、连接、信任、通知、收藏

## 5.4 Web：通用入口，不是最终旗舰

> Web 是 universal access surface；
> Desktop (Tauri) 是 flagship creation surface；
> Mobile (SwiftUI/Kotlin) 是 flagship intervention surface。

---

# 6. 架构规划

## 6.1 语言分工（基于现实）

| 层 | 主语言 | 说明 |
|---|---|---|
| 服务器核心 | TypeScript（现有） | Express + ws，继续增强 |
| 协议 schema | TypeScript + JSON Schema | 单一事实源，多端 codegen |
| Web 前端 | TypeScript + React | 现有资产，持续迭代 |
| Tauri 桌面壳 | Rust（Tauri 侧）+ TypeScript（前端） | Tauri commands 处理系统集成 |
| iOS 客户端 | Swift | SwiftUI + Combine/async-await |
| Android 客户端 | Kotlin | Jetpack Compose + Coroutines |
| Go TUI | Go | 现有，轻量增强 |
| 未来 Rust runtime（Phase B+） | Rust | 当 TS server 成为瓶颈时再评估 |

## 6.2 核心进程

### A. `remux` 服务器（TypeScript，现有）

职责：
- HTTP server + 双 WebSocket 通道
- Zellij 进程管理
- PTY 生命周期
- 终端状态追踪（xterm-headless）
- 认证与设备信任
- 扩展集成（通知、带宽、事件）
- 隧道管理
- Inspect 历史服务（新增）
- Adapter 宿主（新增）

### B. Tauri 桌面进程

职责：
- 嵌入 Web 前端
- 系统级集成（tray、通知、快捷键、文件系统）
- 本地数据缓存（SQLite）
- 深链接处理
- 多窗口管理

### C. iOS / Android 原生进程

职责：
- 原生 UI shell
- WKWebView / WebView 终端桥接
- 推送通知（APNs / FCM）
- 设备凭据管理
- 后台保活
- 系统集成

## 6.3 协议升级：domain envelope

当前简单 JSON 消息需要升级为 domain envelope 格式，为多端统一协议打基础：

```typescript
interface RemuxEnvelope<T = unknown> {
  domain: "core" | "runtime" | "terminal" | "inspect" | "device"
        | "semantic" | "agent" | "collab" | "notifications" | "admin"
  type: string
  version: 1
  requestId?: string
  emittedAt: string
  source: "server" | "client"
  payload: T
}
```

**迁移策略**：不破坏现有协议，新消息使用 envelope 格式，旧消息通过兼容层桥接。客户端通过 capabilities 协商是否使用 envelope。

## 6.4 Inspect 架构升级

当前 Inspect 只是 `capture_inspect` 命令返回一段文本。需要升级为：

### InspectDescriptor

```typescript
interface InspectDescriptor {
  scope: "pane" | "tab" | "session"
  source: "runtime_capture" | "state_tracker" | "local_cache"
  precision: "precise" | "approximate" | "partial"
  staleness: "fresh" | "stale" | "unknown"
  capturedAt: string  // ISO 8601
  paneId?: string
  tabIndex?: number
  sessionName?: string
}

interface InspectSnapshot {
  descriptor: InspectDescriptor
  items: InspectItem[]
  cursor?: string      // opaque pagination cursor
  truncated: boolean
  totalLines?: number
}

interface InspectItem {
  type: "output" | "event" | "marker"
  content: string
  lineNumber?: number
  timestamp?: string
  paneId?: string
  searchHighlights?: [number, number][]
}
```

### 实现方式

基于现有 `TerminalStateTracker`（xterm-headless）扩展：

1. **pane history**：从 xterm-headless 序列化 buffer 获取
2. **tab history**：聚合当前 tab 下所有 pane 的 capture
3. **分页**：opaque cursor 编码 + 服务端分页
4. **搜索**：在 xterm buffer 中做文本搜索
5. **元数据标注**：每次 capture 附带 descriptor

## 6.5 Writer Lease

当前不存在 writer lease 机制。Per-client PTY 架构下，每个客户端实际上都有自己的 Zellij attach 进程，因此可以并行写入同一 session。

### 简化 Writer Lease 设计

在 Per-client PTY 架构下，"writer lease" 的含义是：

- **观察模式**：客户端连接但不发送输入，减少冲突
- **活跃模式**：客户端可以发送输入
- **UI 透出**：显示当前有多少客户端连接、各自状态
- **转让**：一个客户端主动让出活跃状态

这比 v1.1 设想的"单 pane 单 writer"要简单，因为 Zellij 本身处理了多 attach 的合并。

## 6.6 Device Trust & Pairing

### 核心对象

```typescript
interface DeviceIdentity {
  deviceId: string           // UUID
  publicKey: string          // Ed25519
  displayName: string
  platform: "ios" | "android" | "macos" | "windows" | "linux" | "web"
  lastSeenAt: string
  trustLevel: "trusted" | "pending" | "revoked"
}

interface PairingSession {
  pairingSessionId: string
  token: string
  expiresAt: string
  redeemed: boolean
  redeemedBy?: string        // deviceId
}
```

### QR Pairing Payload

```json
{
  "url": "https://xxx.trycloudflare.com",
  "token": "...",
  "pairingSessionId": "...",
  "expiresAt": "...",
  "protocolVersion": 2
}
```

### 连接策略

1. QR 首次配对
2. 建立 device trust
3. 存储 resume token
4. 优先 trusted reconnect
5. Fallback 到 relay
6. 再失败要求人工恢复

## 6.7 Adapter Framework

```typescript
interface SemanticAdapter {
  id: string
  name: string
  mode: "none" | "passive" | "active"
  capabilities: string[]

  // 被动模式：从事件流推断状态
  onTerminalData?(sessionName: string, data: string): void
  onEventFile?(path: string, event: ConversationEvent): void

  // 主动模式：可以发起操作
  createRun?(params: RunParams): Promise<Run>
  steerRun?(runId: string, instruction: string): Promise<void>

  // 状态查询
  getCurrentState?(): AdapterState
}
```

初始 adapters：
- `generic-shell`：永远存在的基线
- `claude-code`：基于 events.jsonl 的被动观测 + 主动 steer
- `codex`：未来第二深度 adapter

## 6.8 存储策略

### Personal Mode（先做稳）

- **服务端**：SQLite（设备信息、pairing、inspect 缓存索引）
- **Tauri 桌面**：SQLite via Tauri plugin（本地偏好、连接历史、inspect 缓存）
- **iOS**：CoreData 或 SwiftData（设备、连接、本地缓存）
- **Android**：Room（设备、连接、本地缓存）
- **文件存储**：`~/.remux/` 下的 JSON / SQLite 文件

### Team Mode（后续）

- PostgreSQL + object storage + 事件总线（Phase C）

## 6.9 开源复用与竞品参考

### 核心原则

**优先复用成熟开源代码，不重复造轮子。** 在实现新功能前，先调研是否已有质量合格的开源方案可以直接采用或 fork 适配。仅在以下情况自行实现：(a) 无合适开源方案；(b) 集成成本高于自研；(c) 涉及核心差异化能力。

### 关键参考项目

| 项目 | 仓库 | 关注点 |
|------|------|--------|
| **cmux** | manaflow-ai/cmux (12K stars) | macOS 原生终端 + AI 集成，Ghostty 引擎，panel 架构，OSC 通知，agent-browser API |
| **Wave Terminal** | wavetermdev/waveterm | Go + Electron 架构，block 系统，AI 集成，跨平台桌面终端 |
| **Warp** | warpdotdev/warp | Rust 原生终端，block 交互范式，AI 命令搜索，协作特性 |

### 具体采用目标

1. **OSC 9/99/777 通知序列**：cmux 通过 OSC escape sequences 实现终端内事件感知。Remux 应在 xterm.js 层解析这些序列，驱动通知系统。
2. **通知分层模式**：借鉴 cmux 的四级通知策略（pane highlight → tab badge → sidebar indicator → system notification），Remux 实现对应的 Web/Tauri 分层。
3. **Panel 架构**：参考 cmux 的 TerminalPanel/BrowserPanel/MarkdownPanel 分离模式，Tauri 桌面版中规划可组合面板系统。
4. **Agent-browser API**：cmux 采用 vercel-labs/agent-browser。Remux 在 E12 中评估集成同类方案。
5. **自动更新模式**：参考 Sparkle 框架模式，Tauri 使用 tauri-plugin-updater 实现静默检查 + 用户确认。

### 明确不采用的部分

| 不采用 | 原因 |
|--------|------|
| libghostty（Zig 终端渲染引擎） | Remux 使用 xterm.js，跨平台一致性更重要 |
| Swift / AppKit UI 框架 | Remux 桌面端选择 Tauri + React |
| GPL 许可代码 | Remux 为 MIT 许可，不兼容 GPL 传染 |
| macOS-only 架构假设 | Remux 必须全端 |

---

# 7. 里程碑与开发排期

## 7.1 第 0 里程碑（第 1 周）：战略冻结与基线清理

### 必交付

- v2 规划文档落库
- Inspect 术语残留清理（`scroll` → `inspect` 在代码和 UI 中）
- 新的 docs 目录骨架
- Tauri 项目初始化（hello world 级别，能打开现有 Web UI）

### 验收

- Tauri dev 模式能打开 Remux Web UI
- 代码中产品语义的 `scroll` 主称谓不再出现

## 7.2 第 1 里程碑（第 2~4 周）：Inspect 真相 + Tauri 基础

### 必交付

- Inspect payload 补齐 descriptor（scope/source/precision/capturedAt/staleness）
- Inspect 分页 API
- Inspect 搜索 API
- 前端 Inspect 视图升级（badge、分页、搜索）
- 协议 domain envelope 基线（新消息使用，旧消息兼容）
- Tauri 系统 tray + 通知 + 全局快捷键
- Web Push 实际推送实现

### 验收

- Inspect 视图可显示 precision/source badge
- Tauri 桌面可收到系统通知
- 移动端浏览器可收到 Web Push

## 7.3 第 2 里程碑（第 5~8 周）：Device Trust + iOS Alpha

### 必交付

- QR pairing v2 payload
- Trusted reconnect / resume token
- Device registry + management UI
- iOS SwiftUI app alpha（配对页、Inspect 首屏、连接状态）
- Android Kotlin 骨架（配对页、基础连接）
- Tauri 桌面增强（多窗口、深链接、本地缓存）

### 验收

- iPhone 可通过 QR 首次连接并重连
- Android 可登录并打开 Inspect
- Tauri 桌面可作为日常使用面

## 7.4 第 3 里程碑（第 9~12 周）：Desktop 旗舰 + Mobile Command Center

### 必交付

- Tauri 桌面 Review Center alpha
- Tauri 桌面 Agent Board alpha
- iOS Command Center alpha（Live terminal、quick actions、push deep links）
- Android Inspect + push notifications
- Client connection state UI（lease badge、多客户端状态）
- Event streaming to clients（WebSocket 广播 conversation events）

### 验收

- 用户可在 Tauri 桌面发起工作，在 iPhone 上追赶和干预
- 桌面可完成 review/approve 基础流程

## 7.5 第 4 里程碑（第 13~20 周）：Agentic Workstation Beta

### 必交付

- Claude Code adapter beta
- Worktree manager
- Built-in git actions
- Review center beta
- Run board with budget/state
- Approval object model
- Topic seed model + runtime binding
- iOS/Android plan/steer/queue

### 验收

- 不依赖外部 agent app 完成主流程
- 至少两个 adapter 能同时存在

## 7.6 第 5 里程碑（第 21~36 周）：Collaboration Shell Alpha

### 必交付

- Workspace / Project / Topic
- Topic timeline
- Inbox / Catch-up / Handoff
- Artifact cards
- Team permissions alpha
- Visualization board（agent board/topic board/runtime topology）

### 验收

- Topic 打开后 60 秒能理解上下文

---

# 8. Epic 列表

> E01--E06 已于 2026-03-31 前全部完成。后续 Epic 在实现时优先调研开源方案，避免重复造轮子。

## ✅ EPIC-001 术语清理与文档治理（10 项）— 已完成

统一术语、清理残留命名、建立新文档骨架。CI 术语守卫已生效。

## ✅ EPIC-002 Inspect & History Service（16 项）— 已完成

Inspect 升级为带完整元数据的历史服务，支持 precision/source/staleness、分页与搜索。

## ✅ EPIC-003 协议升级（12 项）— 已完成

从简单 JSON 消息升级为 domain envelope 格式，向后兼容，含 iOS Swift / Android Kotlin 模型。

## ✅ EPIC-004 Client Connection State（8 项）— 已完成

多客户端状态透出、观察/活跃模式、连接生命周期管理。

## ✅ EPIC-005 Device Trust & Pairing（16 项）— 已完成

QR 配对、设备信任、resume token (JWT)、设备管理 UI。

## ✅ EPIC-006 Web Push 完整实现（6 项）— 已完成

RFC 8030/8291 推送链路完整实现，VAPID 密钥管理、订阅同步、推送触发。

## EPIC-007 Tauri Desktop Shell（20 项）

桌面旗舰应用。包含 Panel 架构（参考 cmux）、OSC 通知序列检测、通知分层、系统集成（tray/快捷键/深链接/自动更新）。

## EPIC-008 iOS Command Center（16 项）

SwiftUI 原生 iOS 客户端。核心 command center 功能，WKWebView 桥接终端渲染。

## EPIC-009 Android Command Center（14 项）

Kotlin 原生 Android 客户端。与 iOS 对等功能范围，WebView 桥接终端渲染。

## EPIC-010 Event Streaming & Adapter Platform（14 项）

把事件监听从文件监视升级为客户端可消费的实时流。含 Adapter 插件框架，首个 Adapter 对接 Claude Code。

## EPIC-011 Worktree & Review Center（16 项）

桌面级 diff/review/worktree 管理。

## EPIC-012 Agents, Runs & Approvals（16 项）

Agent 一等化、Run 对象、审批系统。评估集成 agent-browser API。

## EPIC-013 Topics & Artifacts（14 项）

类 IM 协作层核心骨架。

## EPIC-014 Search, Memory & Handoff（12 项）

检索、记忆、跨设备/跨时区交接。

## EPIC-015 Visualization Board（12 项）

Agent board、Topic board、Runtime topology。

## EPIC-016 Self-host, Packaging & Quality（14 项）

分发、自托管、测试门禁增强。

## EPIC-017 Team Mode Foundations（12 项）

多人协作基础设施。

---

# 9. 详细 Checklist

## EPIC-001 术语清理与文档治理（10 项）

- [x] **E01-001 扫描并清理前端代码中的 scroll 产品术语**。归属：TS Frontend。前置：无。执行：在 `src/frontend/` 中搜索 `scroll`（不含 xterm scrollback 等技术用途），把产品语义的 `scroll` 替换为 `inspect`，包括 CSS 类名、变量名、注释。验收：`grep -r 'scroll' src/frontend/` 结果中不再出现产品语义的 scroll（保留 xterm scrollback、CSS overflow-scroll 等技术用途）。红线：不得改动 xterm.js 的 scrollback 配置或 CSS overflow 属性。

- [x] **E01-002 扫描并清理后端代码中的 scroll 产品术语**。归属：TS Backend。前置：无。执行：在 `src/backend/` 中搜索 `scroll`（不含 scrollback buffer 技术用途），把 `capture_inspect` 相关的旧命名统一。特别关注 `server-zellij.ts` 的 `capture_inspect` 命令、`extensions.ts` 的 `getScrollback` 方法名。验收：后端 API 和内部方法名使用 inspect 而非 scroll 作为产品术语。红线：不得改动 scrollback ring buffer 的技术实现。

- [x] **E01-003 统一 API 端点命名**。归属：TS Backend。前置：E01-002。执行：把 `/api/scrollback/:session` 端点改为 `/api/inspect/:session`，保留旧端点作为兼容重定向。验收：新端点可用；旧端点 301 重定向到新端点；Go TUI 客户端仍能工作。红线：不得直接删除旧端点导致已部署客户端断裂。

- [x] **E01-004 统一测试文件与 fixture 命名**。归属：QA。前置：E01-001, E01-002。执行：把 `tests/` 中引用 scroll 产品术语的测试名、文件名改为 inspect。验收：测试文件命名与产品术语一致；所有测试通过。红线：不得同时改动测试逻辑。

- [x] **E01-005 补一份术语 ADR**。归属：Architecture。前置：E01-001。执行：新增 `docs/adr/ADR_TERMINOLOGY.md`，固定主词汇表（Inspect/Live/Control/Topic/Run/Artifact/Approval/Agent），明确禁用词（Scroll 作为产品主名）。验收：ADR 落库，可作为后续命名审查依据。红线：不得写成泛泛宣言。

- [x] **E01-006 归档旧规划文档**。归属：Docs。前置：E01-005。执行：把 `docs/ZELLIJ_FOUNDATION_PLAN.md` 和 `docs/remux-master-plan-2026-v1.1-with-checklist.md` 移到 `docs/archive/`，在文件头加"已归档"说明。验收：主 docs 目录只保留当前有效文档；归档文档仍可追溯。红线：不得物理删除任何历史文档。

- [x] **E01-007 建立新 docs 目录骨架**。归属：Docs。前置：E01-006。执行：创建 `docs/architecture/`、`docs/product/`、`docs/protocols/`、`docs/native/`、`docs/epics/`、`docs/adr/` 目录，每个目录放一个 README.md 说明用途。验收：目录结构建立；README 清晰。红线：不得把内容生成与目录创建混在同一 PR。

- [x] **E01-008 更新 README.md 产品叙事**。归属：Docs。前置：E01-005。执行：把 README 的 hero section、功能列表、技术栈描述更新为三阶段叙事（Runtime Cockpit → Agentic Workstation → Collaboration OS）。验收：README 首屏传达新定位；安装和使用流程不变。红线：不得改动 CLI 参数或启动行为。

- [x] **E01-009 更新 SPEC.md 协议文档**。归属：Docs。前置：E01-003。执行：把 `docs/SPEC.md` 中的端点列表、消息类型更新为当前实际（含 inspect 重命名）。验收：SPEC.md 与代码一致。红线：不得在 SPEC 中描述尚未实现的协议。

- [x] **E01-010 建立 CI 术语检查**。归属：DevEx。前置：E01-005。执行：在 `npm run typecheck` 后增加一个脚本，扫描 `src/` 和 `docs/`（排除 `archive/`）中的禁用产品术语。验收：在受检路径新增 `scroll` 作为产品主名会使检查失败；archive 和依赖被排除。红线：不得误伤 xterm scrollback、CSS overflow-scroll 等技术用途。


## EPIC-002 Inspect & History Service（16 项）

- [x] **E02-001 定义 InspectDescriptor 和 InspectSnapshot TypeScript 类型**。归属：Contract。前置：E01-005。执行：在 `src/backend/` 新建 `inspect/types.ts`，定义 `InspectDescriptor`（scope/source/precision/staleness/capturedAt）、`InspectSnapshot`（descriptor/items/cursor/truncated）、`InspectItem`（type/content/lineNumber/timestamp）三组类型。同时在前端建立对应类型文件。验收：后端和前端各有一份类型定义且字段名一致；类型编译通过。红线：不得在此任务实现业务逻辑。

- [x] **E02-002 定义 scope/source/precision/staleness 枚举**。归属：Contract。前置：E02-001。执行：在共享类型文件中定义四组字符串字面量联合类型，scope: `"pane" | "tab" | "session"`，source: `"runtime_capture" | "state_tracker" | "local_cache"`，precision: `"precise" | "approximate" | "partial"`，staleness: `"fresh" | "stale" | "unknown"`。验收：前后端通过同一枚举集读写；不存在 magic string。红线：不得把 unknown 值 silently 映射成 precise。

- [x] **E02-003 建立 inspect 服务模块骨架**。归属：TS Backend。前置：E02-001。执行：在 `src/backend/` 新建 `inspect/` 目录，包含 `inspect-service.ts`（类骨架）、`types.ts`（已有）、`index.ts`（导出）。InspectService 构造函数接收 `TerminalStateTracker` 引用。验收：模块可被 `server-zellij.ts` import；cargo/typecheck 通过。红线：不得实现具体查询逻辑。

- [x] **E02-004 实现 pane history 查询**。归属：TS Backend。前置：E02-003。执行：在 InspectService 中实现 `queryPaneHistory(paneId, cursor?, query?): InspectSnapshot`。从 `TerminalStateTracker` 获取指定 pane 的 xterm buffer 内容，转换为 InspectItem 数组，附带 InspectDescriptor（scope: "pane", source: "state_tracker", precision: "precise", staleness: "fresh"）。验收：给定有效 paneId 返回可分页历史；空 pane 返回空结果（非错误）。红线：不得把查询和 live terminal 通道耦合。

- [x] **E02-005 实现 tab history 聚合**。归属：TS Backend。前置：E02-004。执行：在 InspectService 中实现 `queryTabHistory(tabIndex, cursor?): InspectSnapshot`。聚合当前 tab 下所有 pane 的 capture，每个 pane 的内容作为独立段，附带 paneId 标记。验收：tab history 返回所有 pane 的分段结果；descriptor scope 为 "tab"。红线：不得伪造跨 pane 精确时序。

- [x] **E02-006 实现 opaque cursor 分页**。归属：TS Backend。前置：E02-004。执行：cursor 编码为 base64url 的 `{paneId, offset, version}` JSON，解码后用于续传。支持 `limit` 参数控制每页大小（默认 100 行，最大 1000）。验收：连续请求可正确翻页；末页 cursor 为 null；错误 cursor 返回 400。红线：不得暴露可拼凑的内部 offset。

- [x] **E02-007 实现 inspect 文本搜索**。归属：TS Backend。前置：E02-004。执行：在 pane history 查询上增加 `query` 过滤参数，在 xterm buffer 行中做子串匹配，返回匹配行及其上下各 2 行上下文。验收：给定 query 返回命中项；大小写不敏感搜索可用。红线：不得只在前端本地做搜索。

- [x] **E02-008 新增 control 通道 request_inspect 消息**。归属：TS Backend。前置：E02-004, E02-005。执行：在 control WebSocket 中新增 `request_inspect` 命令类型，支持 `{ scope: "pane"|"tab", paneId?, tabIndex?, cursor?, query?, limit? }`。返回 `inspect_snapshot` 消息。保留旧的 `capture_inspect` 命令作为兼容。验收：新命令返回 InspectSnapshot 格式；旧命令仍可用。红线：不得删除旧命令。

- [x] **E02-009 前端：Inspect 视图显示 source badge**。归属：TS Frontend。前置：E02-008。执行：在 `InspectView.tsx` 头部渲染 descriptor.source，用不同颜色 badge 显示 `runtime_capture`/`state_tracker`/`local_cache`。Badge 包含文字标签和 tooltip 解释。验收：不同 source 显示不同 badge；无 source 时显示 "unknown"。红线：不得通过颜色单独表达语义。

- [x] **E02-010 前端：Inspect 视图显示 precision badge**。归属：TS Frontend。前置：E02-008。执行：在 Inspect 视图加入 precision badge，tooltip 解释 precise/approximate/partial 含义。验收：用户一次点击可看懂可信度；badge 随 payload 更新。红线：不得默认把 unknown 当 precise。

- [x] **E02-011 前端：Inspect 视图显示 staleness/capturedAt**。归属：TS Frontend。前置：E02-008。执行：显示 capturedAt 时间戳和 staleness 状态。断线重连后显示 stale；新鲜数据刷新后回到 fresh。验收：断线状态可见 stale badge；包含绝对时间和相对时间。红线：不得只显示相对时间。

- [x] **E02-012 前端：Inspect 分页 UI**。归属：TS Frontend。前置：E02-008。执行：在 Inspect 视图底部增加"加载更多"按钮和无限滚动加载，基于 cursor 分页。显示总行数（如果 descriptor 提供）。验收：大量内容可分页加载；末页无加载按钮。红线：不得一次性加载全部历史。

- [x] **E02-013 前端：Inspect 搜索 UI**。归属：TS Frontend。前置：E02-007, E02-008。执行：在 Inspect 视图顶部增加搜索框，输入时 debounce 300ms 后发送 request_inspect with query。搜索结果高亮匹配文本。验收：搜索可返回结果并高亮；清空搜索恢复正常浏览。红线：不得阻塞 UI 主线程。

- [x] **E02-014 前端：移动端默认入口切到 Inspect**。归属：TS Frontend。前置：E02-009~E02-013。执行：在 `App.tsx` 中，当 `mobileLayout` 为 true 时，默认 `viewMode` 设为 "inspect" 而非 "terminal"。保留用户手动切换能力。验收：手机首次进入显示 Inspect；仍可一跳切到 Live。红线：不得移除用户设置默认页的能力。

- [x] **E02-015 Inspect 本地缓存策略**。归属：TS Frontend。前置：E02-008。执行：对 inspect 结果按 `sessionName/tabIndex/paneId` 分桶缓存到 localStorage（上限 5MB），附带 capturedAt 时间戳。重复打开同一 scope 先读缓存再请求最新。版本变化时旧缓存失效。验收：重复打开响应更快；缓存过期可自动清除。红线：不得把 local cache 冒充 authoritative history（source 必须标为 local_cache）。

- [x] **E02-016 补齐 inspect 端到端测试**。归属：QA。前置：E02-004~E02-015。执行：新增 Playwright 测试覆盖 pane/tab scope 切换、分页、搜索、badge 显示、重连后刷新。验收：测试在 gate 中稳定通过。红线：不得用 sleep 常量掩盖 race condition。


## EPIC-003 协议升级（12 项）

- [x] **E03-001 定义 RemuxEnvelope TypeScript 类型**。归属：Contract。前置：无。执行：在 `src/backend/protocol/` 新建 `envelope.ts`，定义 `RemuxEnvelope<T>` 泛型接口（domain/type/version/requestId/emittedAt/source/payload）和 domain 字符串字面量联合类型。验收：类型编译通过；前后端可共享。红线：不得在此任务改动现有消息处理。

- [x] **E03-002 实现 envelope 序列化/反序列化工具函数**。归属：TS Backend。前置：E03-001。执行：实现 `createEnvelope(domain, type, payload)` 和 `parseEnvelope(raw)` 函数。parseEnvelope 支持旧格式 fallback（检测到无 domain 字段时包装为 `core/*` 域）。验收：新格式可正确往返序列化；旧格式可被 parse 为兼容 envelope。红线：不得破坏现有消息解析。

- [x] **E03-003 在 control 通道添加 capabilities 协商**。归属：TS Backend。前置：E03-002。执行：在 auth_ok 响应中增加 `capabilities: { envelope: boolean, inspectV2: boolean, deviceTrust: boolean }` 字段。客户端在 auth 消息中也声明自身 capabilities。验收：旧客户端不发送 capabilities 时服务器 fallback 到旧协议；新客户端可协商功能。红线：不得强制要求所有客户端升级。

- [x] **E03-004 把新的 inspect 消息切到 envelope 格式**。归属：TS Backend。前置：E03-002, E02-008。执行：`request_inspect` 和 `inspect_snapshot` 消息使用 envelope 格式（domain: "inspect"）。保留旧 `capture_inspect` 命令的原始格式。验收：新消息走 envelope；旧消息不受影响。红线：不得改动旧消息的 wire format。

- [x] **E03-005 把 workspace_state 消息切到 envelope 格式**。归属：TS Backend。前置：E03-003。执行：当客户端声明支持 envelope 时，`workspace_state` 广播使用 `{ domain: "runtime", type: "workspace_state", ... }` 格式。不支持 envelope 的客户端继续收旧格式。验收：新旧客户端同时连接时各收自己格式的消息。红线：不得在 broadcast 逻辑中引入 N*M 的序列化开销。

- [x] **E03-006 把 bandwidth_stats 消息切到 envelope 格式**。归属：TS Backend。前置：E03-003。执行：同 E03-005 逻辑，bandwidth_stats 使用 `{ domain: "admin", type: "bandwidth_stats", ... }` 格式。验收：同上。红线：同上。

- [x] **E03-007 前端适配 envelope 格式解析**。归属：TS Frontend。前置：E03-004, E03-005, E03-006。执行：在 `useZellijControl.ts` 中增加 envelope 解析层。收到消息时先尝试 parseEnvelope，如果是 envelope 格式则按 domain/type 路由，否则走旧逻辑。验收：前端可同时处理新旧格式消息。红线：不得删除旧格式处理代码。

- [x] **E03-008 建立 protocol-schemas 目录**。归属：Contract。前置：E03-001。执行：在 `docs/protocols/` 新建 `schemas/` 目录，为每个 domain 写 JSON Schema 文件（先覆盖 core、runtime、inspect、admin 四个 domain）。验收：schema 文件存在且可被 ajv 校验。红线：schema 只描述已实现的消息，不描述未来计划。

- [x] **E03-009 建立 golden payload fixtures**。归属：QA/Contract。前置：E03-008。执行：在 `tests/fixtures/protocol/` 中为每个已定义的消息类型创建 golden payload JSON 文件。包含 envelope 格式和旧格式各一份。验收：每个 fixture 可被 schema 校验通过；单元测试读取 fixture 并验证解析。红线：不得创建未实现的消息 fixture。

- [x] **E03-010 生成 Swift Codable 模型**。归属：iOS Contract。前置：E03-008。执行：基于 JSON Schema 手写（或用 quicktype 生成）Swift Codable 结构体，覆盖 core、runtime、inspect、admin domain。验收：Swift 模型可解码所有 golden payload。红线：不得自创字段。

- [x] **E03-011 生成 Kotlin data class 模型**。归属：Android Contract。前置：E03-008。执行：基于 JSON Schema 手写（或用 quicktype 生成）Kotlin data class，使用 kotlinx.serialization。验收：Kotlin 模型可解码所有 golden payload。红线：不得自创字段。

- [x] **E03-012 补齐协议兼容性集成测试**。归属：QA。前置：E03-007, E03-009。执行：Playwright E2E 测试验证：旧客户端连新服务器、新客户端连新服务器、capabilities 协商正确。验收：两种客户端模式都能正常工作。红线：不得跳过旧格式兼容测试。


## EPIC-004 Client Connection State（8 项）

- [x] **E04-001 在服务端追踪已连接客户端列表**。归属：TS Backend。前置：无。执行：在 `server-zellij.ts` 中维护一个 `connectedClients: Map<string, ClientInfo>` 结构，记录每个 control WebSocket 连接的 clientId（自动生成 UUID）、connectTime、deviceName（auth 时可选传入）、platform、lastActivityAt。验收：可通过内部 API 列出所有已连接客户端。红线：不得把 clientId 暴露为可猜测的序号。

- [x] **E04-002 广播客户端连接/断开事件**。归属：TS Backend。前置：E04-001。执行：当客户端连接或断开时，向所有已认证的 control WebSocket 广播 `clients_changed` 消息，包含当前客户端列表快照。验收：新客户端连接时，其他客户端能收到更新。红线：不得泄露客户端的 auth token。

- [x] **E04-003 在 control 通道增加 set_client_mode 命令**。归属：TS Backend。前置：E04-001。执行：客户端可发送 `{ type: "set_client_mode", mode: "active" | "observer" }` 声明自己是活跃模式还是观察模式。服务端记录并广播。验收：模式切换即时生效；默认为 active。红线：observer 模式下服务端不阻止输入（Zellij 本身处理），只是 UI 层提示。

- [x] **E04-004 前端显示已连接客户端列表**。归属：TS Frontend。前置：E04-002。执行：在 sidebar 或 status bar 显示当前连接的客户端数量和列表。每个客户端显示 deviceName/platform/mode/connectTime。验收：多设备连接时可看到完整列表。红线：不得在移动端显示过于复杂的列表。

- [x] **E04-005 前端显示 client mode badge**。归属：TS Frontend。前置：E04-003。执行：在终端视图顶部显示当前客户端的模式（Active/Observer）。提供一键切换按钮。验收：模式状态实时更新；切换有确认。红线：不得让 observer 模式完全禁用终端输入（留给用户自行决定）。

- [ ] **E04-006 Tauri 桌面显示连接状态徽章**。归属：Tauri。前置：E04-004。执行：在 Tauri 系统 tray icon 上通过 tooltip 显示当前连接数和模式。验收：tray tooltip 反映实时连接状态。红线：不得每次状态变化都弹出通知。(Tauri/原生依赖，延迟到 E07/E08)

- [ ] **E04-007 移动端显示连接状态**。归属：iOS/Android。前置：E04-002。执行：在原生 UI 的状态栏区域显示当前连接状态（connected/reconnecting/disconnected）和其他设备信息。验收：状态变化实时更新。红线：不得占据过多屏幕空间。(Tauri/原生依赖，延迟到 E07/E08)

- [x] **E04-008 补齐多客户端集成测试**。归属：QA。前置：E04-001~E04-005。执行：Playwright 测试用两个浏览器 context 同时连接，验证客户端列表广播、模式切换。验收：多客户端场景稳定通过。红线：不得靠 sleep 同步。


## EPIC-005 Device Trust & Pairing（16 项）

- [x] **E05-001 定义 DeviceIdentity 和 PairingSession 类型**。归属：Contract。前置：无。执行：在 `src/backend/auth/` 新建 `device-types.ts`，定义 DeviceIdentity（deviceId/publicKey/displayName/platform/lastSeenAt/trustLevel）和 PairingSession（pairingSessionId/token/expiresAt/redeemed/redeemedBy）。验收：类型编译通过。红线：不得把设备身份与用户 session token 混成一个对象。

- [x] **E05-002 实现设备存储层**。归属：TS Backend。前置：E05-001。执行：在 `src/backend/auth/` 新建 `device-store.ts`，使用 SQLite（`better-sqlite3` 或 `sql.js`）存储设备和配对记录到 `~/.remux/devices.db`。提供 CRUD 方法。验收：设备可持久化存储；服务器重启后记录不丢失。红线：不得把数据存在内存中。

- [x] **E05-003 实现 PairingSession 创建 API**。归属：TS Backend。前置：E05-002。执行：新增 `POST /api/pairing/create` 端点，生成 pairing session（含 token、过期时间），返回 QR payload JSON。验收：API 返回有效 payload；过期时间默认 5 分钟。红线：不得让未认证请求创建 pairing session。

- [x] **E05-004 定义 QR pairing payload v2 格式**。归属：Contract。前置：E05-003。执行：固定 QR 内容 JSON 格式：`{ url, token, pairingSessionId, expiresAt, protocolVersion: 2, serverVersion }`。写入 `docs/protocols/PAIRING_V2.md`。验收：文档与实现一致。红线：不得继续扩展无版本号的自由 JSON。

- [x] **E05-005 实现 pairing 兑付 API**。归属：TS Backend。前置：E05-003。执行：新增 `POST /api/pairing/redeem` 端点，接收 pairingSessionId + 设备公钥，校验未过期且未使用，创建 trusted device 记录，返回 resume token。验收：有效 session 可兑付；过期或重复兑付返回结构化错误。红线：不得在兑付后保留无限期有效的 pairing token。

- [x] **E05-006 实现 resume token 签发与校验**。归属：TS Backend。前置：E05-005。执行：resume token 使用 JWT（HS256，server secret），包含 deviceId 和过期时间（默认 7 天）。在 WebSocket auth 流程中增加 resume token 校验分支。验收：已配对设备可用 resume token 快速认证；过期 token 被拒绝。红线：不得签发不含 deviceId 的通用 token。

- [x] **E05-007 实现 pairing 过期清理**。归属：TS Backend。前置：E05-002。执行：服务器启动时和每小时运行一次清理，标记过期未兑付的 pairing session。验收：过期记录被标记不可用。红线：不得删除审计所需的最小记录。

- [x] **E05-008 实现设备撤销 API**。归属：TS Backend。前置：E05-002。执行：新增 `POST /api/devices/:deviceId/revoke` 端点，标记设备为 revoked 并记录时间和原因。验收：撤销后该设备的 resume token 被拒绝。红线：不得只在前端隐藏设备。

- [x] **E05-009 实现设备列表 API**。归属：TS Backend。前置：E05-002。执行：新增 `GET /api/devices` 端点，返回所有已知设备列表（含 trust level、last seen）。验收：列表包含所有设备状态。红线：不得暴露设备私钥。

- [x] **E05-010 Web UI 设备管理页面**。归属：TS Frontend。前置：E05-009, E05-008。执行：在 sidebar 中增加"设备"页面，显示已信任设备列表、最后连接时间、平台图标、撤销按钮。验收：可查看和撤销设备；当前设备有特殊标记。红线：不得在无确认情况下撤销当前设备。

- [x] **E05-011 Web UI QR 配对显示**。归属：TS Frontend。前置：E05-003。执行：在设备管理页面增加"配对新设备"按钮，点击后显示 QR 码（使用 `qrcode` 库渲染到 canvas）。验收：QR 码包含 v2 payload；5 分钟后自动过期刷新。红线：不得在 QR 中包含明文密码。

- [ ] **E05-012 iOS 实现 QR 扫码配对**。归属：iOS。前置：E05-004, E05-005。执行：在 iOS 首次启动页面使用 AVCaptureSession 扫码，解析 v2 payload，调用 redeem API，存储 resume token 到 Keychain。验收：扫码后可成功建立信任连接。红线：不得把 resume token 存在 UserDefaults。(iOS/Android 原生，延迟到 E08/E09)

- [ ] **E05-013 iOS 实现 trusted reconnect**。归属：iOS。前置：E05-006, E05-012。执行：App 启动时检查 Keychain 中的 resume token，如果有效则直接用 token 认证 WebSocket。验收：已配对设备无需重新扫码。红线：不得在 token 过期后静默失败。(iOS/Android 原生，延迟到 E08/E09)

- [ ] **E05-014 Android 实现 QR 扫码配对**。归属：Android。前置：E05-004, E05-005。执行：使用 ML Kit Barcode Scanning 扫码，解析 v2 payload，调用 redeem API，存储 resume token 到 EncryptedSharedPreferences。验收：同 iOS。红线：不得存储到明文 SharedPreferences。(iOS/Android 原生，延迟到 E08/E09)

- [ ] **E05-015 Android 实现 trusted reconnect**。归属：Android。前置：E05-006, E05-014。执行：同 iOS 逻辑。验收：已配对设备无需重新扫码。红线：同 iOS。(iOS/Android 原生，延迟到 E08/E09)

- [x] **E05-016 补齐 pairing 集成测试**。归属：QA。前置：E05-003~E05-006。执行：测试完整流程：创建 pairing → 兑付 → 获取 resume token → 用 resume token 连接 → 撤销 → 连接失败。验收：全链路测试通过。红线：不得跳过撤销后的拒绝验证。


## EPIC-006 Web Push 完整实现（6 项）

- [x] **E06-001 添加 web-push npm 依赖**。归属：TS Backend。前置：无。执行：`npm install web-push`，在 `notifications/push-sender.ts` 中封装发送函数。验收：可以向已注册的 subscription 发送实际推送消息。红线：不得改动 VAPID 密钥生成逻辑。

- [x] **E06-002 实现 bell 通知推送**。归属：TS Backend。前置：E06-001。执行：当 `TerminalNotifier` 检测到 bell 字符时，通过 web-push 向所有订阅发送推送（标题："Terminal Bell"，正文：session 名称）。验收：浏览器收到系统通知。红线：保留 5 秒冷却期。

- [x] **E06-003 实现 session exit 通知推送**。归属：TS Backend。前置：E06-001。执行：session 退出时推送通知（标题："Session Exited"，正文：session 名 + exit code）。验收：session 退出后收到推送。红线：不得在正常退出（code 0）时也推送（可配置）。

- [x] **E06-004 实现通知点击深链接**。归属：TS Frontend。前置：E06-002。执行：推送 payload 包含 URL（指向对应 session/tab），Service Worker 处理 `notificationclick` 事件打开对应页面。验收：点击通知可跳转到对应 session。红线：不得打开新标签页如果已有标签页打开。

- [x] **E06-005 前端通知设置 UI**。归属：TS Frontend。前置：E06-001。执行：在设置中增加通知开关（bell/exit 分别可控）。使用 Notification API 请求权限并注册 push subscription。验收：用户可独立控制 bell 和 exit 通知。红线：不得在用户未授权时反复弹出权限请求。

- [ ] **E06-006 Tauri 桌面通知集成**。归属：Tauri。前置：E06-002。执行：Tauri 应用使用 `@tauri-apps/plugin-notification` 接收并显示系统通知（不走 Web Push，直接从 WebSocket 事件触发）。验收：Tauri 桌面收到原生系统通知。红线：不得同时触发 Web Push 和 Tauri 通知导致重复。(Tauri 依赖，延迟到 E07)


## EPIC-007 Tauri Desktop Shell（20 项）

> 参考 wave-terminal 的 Tauri 集成模式和 cmux 的通知分层体系。优先复用 Tauri 官方插件生态。

- [ ] **E07-001 初始化 Tauri 2 项目骨架**。归属：Tauri。前置：无。执行：在项目根目录 `src-tauri/` 下初始化 Tauri 2 项目；`tauri.conf.json` 中 `devUrl` 指向现有 Vite dev server (`http://localhost:5173`)，`frontendDist` 指向 `../dist/frontend`；参考 wave-terminal 的 Tauri 项目结构，Rust 侧保持最小化（仅 `main.rs` + `lib.rs`）。验收：`pnpm tauri dev` 启动后窗口显示现有 Remux 前端首页；`src-tauri/Cargo.toml` 中 tauri 版本 ≥ 2.0。红线：不修改现有前端代码结构；不引入 Tauri v1 API。

- [ ] **E07-002 配置 pnpm scripts 集成**。归属：Tauri。前置：E07-001。执行：在 `package.json` 添加 `tauri:dev`、`tauri:build` 脚本；`beforeDevCommand` 执行 `pnpm run dev:frontend`，`beforeBuildCommand` 执行 `pnpm run build:frontend`。验收：`pnpm tauri:dev` 一条命令完成前后端联合启动；`pnpm tauri:build` 产出安装包。红线：不影响现有 `pnpm run dev` 流程。

- [ ] **E07-003 配置窗口基础属性**。归属：Tauri。前置：E07-001。执行：设置默认窗口大小 1280×800，最小 640×480，标题 "Remux"，原生标题栏；通过 `pnpm tauri icon` 生成全平台图标集。验收：窗口启动尺寸正确；标题和图标正确显示。红线：不使用自定义无边框窗口。

- [ ] **E07-004 实现系统 Tray**。归属：Tauri。前置：E07-003。执行：使用 `tauri::tray::TrayIconBuilder` 创建系统托盘；右键菜单：Show/Hide Window、连接状态（灰色不可点击）、Quit；托盘图标根据连接状态切换。验收：托盘在 macOS 菜单栏和 Windows 系统托盘可见；Show/Hide 切换窗口显隐。红线：不在退出时残留托盘图标。

- [ ] **E07-005 实现全局快捷键**。归属：Tauri。前置：E07-004。执行：使用 `@tauri-apps/plugin-global-shortcut` 注册 `Cmd+Shift+R`（macOS）/ `Ctrl+Shift+R`（Windows/Linux）呼出/隐藏窗口。验收：后台按快捷键窗口前置；前台按快捷键窗口隐藏。红线：不劫持常用组合键。

- [ ] **E07-006 实现系统通知**。归属：Tauri。前置：E07-004、E06。执行：使用 `@tauri-apps/plugin-notification`；从 WebSocket 事件（bell、session exit、approval）触发系统通知；参考 cmux 通知策略，仅在窗口非聚焦时升级为系统通知。验收：后台收到 bell 弹系统通知；窗口聚焦时不弹系统通知。红线：不与 Web Push 重复通知。

- [ ] **E07-007 实现窗口状态持久化**。归属：Tauri。前置：E07-003。执行：使用 `@tauri-apps/plugin-window-state` 保存/恢复窗口位置、大小、最大化状态。验收：重启后窗口恢复到上次位置和大小。红线：多显示器切换时窗口不跑出屏幕。

- [ ] **E07-008 实现开机自启动**。归属：Tauri。前置：E07-004。执行：使用 `@tauri-apps/plugin-autostart`；Settings 页增加 "Launch on login" 开关。验收：启用后重启系统自动启动到 tray。红线：默认不启用。

- [ ] **E07-009 实现深链接协议处理**。归属：Tauri。前置：E07-001。执行：使用 `@tauri-apps/plugin-deep-link` 注册 `remux://` 协议；处理 `remux://connect?host=<host>&token=<token>` 自动连接。验收：浏览器点击深链接可激活 Tauri 窗口并连接。红线：不在深链接中传递密码。

- [ ] **E07-010 实现剪贴板集成**。归属：Tauri。前置：E07-001。执行：使用 `@tauri-apps/plugin-clipboard-manager`；xterm.js selection 接入系统剪贴板写入，粘贴时读取系统剪贴板写入 PTY。验收：终端选中文本可在外部粘贴；外部复制可在终端 Cmd+V 粘贴。红线：不自动读取剪贴板。

- [ ] **E07-011 实现本地 SQLite 缓存**。归属：Tauri。前置：E07-001。执行：使用 `@tauri-apps/plugin-sql`；在 `$APPDATA/remux/cache.db` 创建 SQLite 存储连接历史、session 快照缓存、偏好设置。验收：连接记录持久化；下次启动可从缓存展示。红线：不在 SQLite 中存储 token。

- [ ] **E07-012 实现多窗口支持**。归属：Tauri。前置：E07-003、E07-014。执行：使用 `WebviewWindowBuilder` 支持动态创建子窗口；不同视图可在独立窗口中打开实现 side-by-side；参考 cmux panel 架构思路。验收：可同时打开 ≥ 2 个窗口显示不同 session。红线：不为每个窗口建立独立 WebSocket 连接。

- [ ] **E07-013 实现 macOS 原生菜单栏**。归属：Tauri。前置：E07-001。执行：使用 `tauri::menu::MenuBuilder` 构建原生菜单；包含 App/Edit/View/Window/Help 标准菜单项；修复 Cmd+C/V 在 Tauri 中的已知问题。验收：macOS 菜单栏显示完整；Cmd+C/V/A 正常工作。红线：不覆盖终端内快捷键绑定。

- [ ] **E07-014 前端 Panel 抽象**。归属：TS Frontend。前置：无。执行：定义 `Panel` 接口（id/type/title/icon/render/canDetach）；重构 Live、Inspect、Control 视图实现 Panel 接口；创建 `PanelRegistry` 管理已注册 Panel 类型；此 ticket 仅做抽象，不改 UI 布局。验收：现有视图通过 PanelRegistry 注册；视觉回归测试通过。红线：不引入新 UI 框架。

- [ ] **E07-015 实现 OSC 通知序列检测**。归属：TS Backend/Frontend。前置：E02。执行：在 `terminal-notifier.ts` 中解析 OSC 9（iTerm2 兼容）、OSC 99（Kitty 通知协议）、OSC 777（rxvt-unicode 通知）序列；参考 cmux 实现思路，hook xterm.js parser 注册自定义 OSC handler；解析结果发射为 `TerminalNotificationEvent`。验收：终端执行 `printf '\e]9;Build complete\e\\'` 触发事件；三种 OSC 变体均正确解析；单元测试覆盖 edge case。红线：不修改 xterm.js 源码。

- [ ] **E07-016 实现通知分层**。归属：TS Frontend + Tauri。前置：E07-006、E07-015。执行：借鉴 cmux 四级通知分层，实现三级分层：Level 1 — tab badge（红点 + 计数）→ Level 2 — sidebar indicator（session 项高亮）→ Level 3 — system notification（窗口非聚焦时）；根据当前 UI 焦点状态决定升级路径。验收：当前 tab bell 不弹通知；其他 tab bell 显示 badge；最小化窗口 bell 弹系统通知。红线：30 秒内最多 1 条系统通知（rate limit）。

- [ ] **E07-017 编写 Agent 通知钩子文档**。归属：Docs。前置：E07-015。执行：在 `docs/agent-notifications.md` 撰写指南，提供 Claude Code、Codex、Aider 等代理的 OSC 通知 hook 配置示例；参考 cmux agent hook 文档风格。验收：文档含 ≥ 3 种代理配置示例；可复制粘贴直接使用。红线：不对第三方工具做兼容性承诺。

- [ ] **E07-018 Tauri CI 构建矩阵**。归属：CI。前置：E07-002。执行：创建 `.github/workflows/tauri-build.yml`；matrix：macOS（arm64 + x86_64）、Windows（x86_64）、Ubuntu（x86_64）；产物上传为 GitHub Release assets 或 workflow artifacts。验收：三平台 CI 构建通过；构建时间 < 15 min。红线：不在 CI 中存储签名密钥明文。

- [ ] **E07-019 Tauri 自动更新配置**。归属：Tauri。前置：E07-018。执行：启用 `tauri-plugin-updater`，endpoints 指向 GitHub Releases；参考 cmux 的 Sparkle 更新流程但使用 Tauri 原生实现；有新版本时显示非阻塞 toast。验收：发布新 Release 后客户端检测到更新并提示；更新签名校验通过。红线：不强制更新。

- [ ] **E07-020 Tauri 集成测试**。归属：QA。前置：E07-001~E07-019 中至少 5 项完成。执行：使用 `@tauri-apps/api/mocks` 在 Vitest 中编写 Tauri 集成测试；覆盖 tray、快捷键、深链接、通知、Panel 注册等场景。验收：测试覆盖 ≥ 15 个场景；`pnpm test` 全部通过。红线：mock 层不掩盖真实 API 签名变化。


## EPIC-008 iOS Command Center（22 项）

- [ ] **E08-001 初始化 Xcode 项目**。归属：iOS。前置：无。执行：在 `apps/ios/` 创建 SwiftUI iOS 项目（Remux），最低部署目标 iOS 17，Swift 6。配置 Bundle ID、App Icon、Launch Screen。验收：项目可编译并在模拟器运行空白 app。红线：不得使用 Storyboard。

- [ ] **E08-002 建立项目目录结构**。归属：iOS。前置：E08-001。执行：按功能模块组织：`Sources/Models/`（数据模型）、`Sources/Services/`（网络、认证）、`Sources/Views/`（SwiftUI 视图）、`Sources/ViewModels/`、`Sources/Terminal/`（WebView 桥接）。验收：目录结构清晰；编译通过。红线：不得把所有代码放在一个文件。

- [ ] **E08-003 实现 Swift 协议模型**。归属：iOS。前置：E03-010。执行：导入 E03-010 生成的 Swift Codable 模型（RemuxEnvelope、WorkspaceState、InspectSnapshot 等）。验收：模型可解码所有 golden payload fixture。红线：不得手写与 fixture 不一致的模型。

- [ ] **E08-004 实现 WebSocket 连接管理器**。归属：iOS。前置：E08-003。执行：使用 URLSessionWebSocketTask 实现双通道连接管理器（`RemuxConnectionManager`），支持 control 和 terminal 两个独立 WebSocket。包含认证流程、自动重连（指数退避）、心跳保活。验收：可连接到 Remux 服务器并完成认证。红线：不得在后台线程更新 UI。

- [ ] **E08-005 实现 QR 扫码配对页面**。归属：iOS。前置：E05-012。执行：SwiftUI 视图包装 AVCaptureSession + QR 检测。扫码后解析 v2 payload，调用 redeem API，存储到 Keychain。验收：扫码 → 配对 → 连接一气呵成。红线：不得在相机权限被拒时崩溃。

- [ ] **E08-006 实现 Keychain 凭据管理**。归属：iOS。前置：E08-005。执行：封装 Keychain API 存储 deviceId、resume token、server URL。支持多服务器凭据。验收：App 重启后凭据可恢复。红线：不得使用 UserDefaults 存储凭据。

- [ ] **E08-007 实现首页（Now 视图）**。归属：iOS。前置：E08-004。执行：SwiftUI 首页显示：当前连接状态、活跃 session 概览、最近操作（如果有 topic/run 则显示）。底部 Tab Bar 包含 Now/Inspect/Runs/Topics/Me。验收：连接后首页显示 session 信息。红线：未连接时显示配对引导。

- [ ] **E08-008 实现 Inspect 视图**。归属：iOS。前置：E08-004, E02-008。执行：SwiftUI 列表视图显示 InspectSnapshot 内容。顶部显示 descriptor badge（source/precision/staleness）。支持下拉刷新和上拉加载更多（cursor 分页）。验收：Inspect 内容可阅读；badge 正确显示。红线：不得在 Inspect 中嵌入终端。

- [ ] **E08-009 实现 Inspect 搜索**。归属：iOS。前置：E08-008。执行：在 Inspect 视图顶部增加搜索栏，使用 `.searchable()` 修饰符。搜索时通过 WebSocket 发送 request_inspect with query。验收：搜索结果可高亮显示。红线：不得在本地做搜索。

- [ ] **E08-010 实现 Live Terminal 视图（WKWebView 桥接）**。归属：iOS。前置：E08-004。执行：创建 `TerminalWebView` SwiftUI 视图，内嵌 WKWebView 加载一个精简版 xterm.js HTML 页面。WebView 通过 `postMessage` / `webkit.messageHandlers` 与 Swift 通信：终端数据双向传输、resize 事件。验收：可以在终端中输入命令并看到输出。红线：不得让 WebView 直接连接 WebSocket（由 Swift 层管理连接）。

- [ ] **E08-011 实现终端键盘适配**。归属：iOS。前置：E08-010。执行：处理 iOS 软键盘弹出时的布局调整。增加快捷按钮行（Esc、Tab、Ctrl、方向键）类似 Termius 的辅助键盘。验收：软键盘不遮挡终端内容；辅助键可用。红线：不得在键盘收起时留白。

- [ ] **E08-012 实现 Tab/Pane 控制**。归属：iOS。前置：E08-004。执行：在 Control 页面显示 tab 列表（可切换、新建、关闭、重命名）和 pane 布局（可新建、关闭、全屏）。验收：所有 tab/pane 操作可用。红线：不得在删除最后一个 tab 时崩溃。

- [ ] **E08-013 配置 APNs 推送**。归属：iOS。前置：E08-001。执行：在 Xcode 中启用 Push Notifications capability。创建 APNs Key（p8 格式）并配置服务端。验收：App 可注册 push token。红线：不得把 APNs key 提交到仓库。

- [ ] **E08-014 实现 push token 注册到服务器**。归属：iOS。前置：E08-013, E05-001。执行：App 获取 push token 后通过 `POST /api/devices/:deviceId/push-token` 上报到服务器。服务器存储到 device 记录。验收：服务器可查到设备的 push token。红线：不得在未获得权限时反复请求。

- [ ] **E08-015 实现推送通知接收与深链接**。归属：iOS。前置：E08-014。执行：处理 `UNUserNotificationCenterDelegate` 回调，根据 notification payload 中的 action（session/tab/run）导航到对应页面。验收：点击通知可跳转到对应视图。红线：不得在 App 前台时弹出 banner（使用 in-app 提示）。

- [ ] **E08-016 实现 Face ID / Touch ID 锁定**。归属：iOS。前置：E08-001。执行：使用 LocalAuthentication 框架在 App 前台恢复时要求生物认证。可在设置中开关。验收：启用后切回 App 需要认证。红线：认证失败不得清除数据。

- [ ] **E08-017 实现设备管理页面**。归属：iOS。前置：E05-009。执行：在 Me tab 中显示设备列表、连接历史、撤销设备。验收：可查看和管理设备。红线：同 Web UI 要求。

- [ ] **E08-018 实现连接状态指示器**。归属：iOS。前置：E08-004。执行：在导航栏显示连接状态（绿色圆点=connected、黄色=reconnecting、红色=disconnected）。断线时显示重连倒计时。验收：状态变化实时更新。红线：不得在正常连接时频繁闪烁。

- [ ] **E08-019 实现离线 Inspect 缓存**。归属：iOS。前置：E08-008。执行：使用 CoreData 或 SwiftData 缓存最近访问的 Inspect 快照。离线时显示缓存内容（标记为 stale）。验收：断网后仍可阅读最近缓存。红线：缓存大小限制 50MB。

- [ ] **E08-020 实现 Share Sheet 分享终端内容**。归属：iOS。前置：E08-008。执行：在 Inspect 视图中增加分享按钮，可把终端内容作为文本或截图分享。验收：分享到其他 App 内容正确。红线：不得分享认证信息。

- [ ] **E08-021 实现 iPad 多栏布局**。归属：iOS。前置：E08-007~E08-012。执行：使用 `NavigationSplitView` 在 iPad 上显示双栏或三栏布局。左栏 tab/pane 列表，中栏 Inspect/Live，右栏 context/agents（未来）。验收：iPad 横屏体验类似桌面。红线：不得在 iPhone 上强制多栏。

- [ ] **E08-022 补齐 iOS UI 测试**。归属：QA。前置：E08-001~E08-021。执行：使用 XCUITest 测试关键流程：配对、连接、Inspect 浏览、Live 输入、tab 切换。验收：模拟器上测试通过。红线：不得依赖真实服务器（使用 mock server）。


## EPIC-009 Android Command Center（16 项）

- [ ] **E09-001 初始化 Android 项目**。归属：Android。前置：无。执行：在 `apps/android/` 创建 Kotlin + Jetpack Compose 项目（Remux），最低 API 26（Android 8.0），目标 API 34。配置 Material 3 主题。验收：项目可编译并在模拟器运行。红线：不得使用 XML layout。

- [ ] **E09-002 建立项目模块结构**。归属：Android。前置：E09-001。执行：`data/`（模型、数据源）、`domain/`（业务逻辑）、`ui/`（Compose 视图）、`service/`（WebSocket、通知）。验收：模块分离清晰。红线：不得把网络逻辑放在 UI 层。

- [ ] **E09-003 实现 Kotlin 协议模型**。归属：Android。前置：E03-011。执行：导入 E03-011 生成的 Kotlin data class。验收：模型可解码所有 golden payload。红线：不得手写与 fixture 不一致的模型。

- [ ] **E09-004 实现 WebSocket 连接管理器**。归属：Android。前置：E09-003。执行：使用 OkHttp WebSocket 实现双通道连接（control + terminal），Kotlin Coroutines 管理生命周期。包含认证、自动重连、心跳。验收：可连接到 Remux 服务器。红线：不得在主线程做网络操作。

- [ ] **E09-005 实现 QR 扫码配对页面**。归属：Android。前置：E05-014。执行：使用 ML Kit Barcode Scanning。扫码 → 解析 → redeem → 存储到 EncryptedSharedPreferences。验收：扫码配对一气呵成。红线：不得在相机权限被拒时崩溃。

- [ ] **E09-006 实现首页（Now 视图）**。归属：Android。前置：E09-004。执行：Compose 首页显示连接状态、活跃 session 概览。底部导航包含 Now/Inspect/Runs/Topics/Me。验收：连接后首页显示 session 信息。红线：未连接时显示配对引导。

- [ ] **E09-007 实现 Inspect 视图**。归属：Android。前置：E09-004。执行：LazyColumn 显示 InspectSnapshot 内容。顶部 descriptor badge。支持分页加载。验收：Inspect 可阅读。红线：不得一次加载全部内容。

- [ ] **E09-008 实现 Live Terminal 视图（WebView 桥接）**。归属：Android。前置：E09-004。执行：使用 Android WebView 加载精简版 xterm.js HTML 页面。通过 `addJavascriptInterface` 实现双向通信。验收：终端输入输出可用。红线：WebView 不直接连 WebSocket。

- [ ] **E09-009 实现 Tab/Pane 控制**。归属：Android。前置：E09-004。执行：同 iOS E08-012。验收：所有操作可用。红线：同 iOS。

- [ ] **E09-010 配置 FCM 推送**。归属：Android。前置：E09-001。执行：集成 Firebase Cloud Messaging。注册 token 并上报到服务器。验收：App 可注册 FCM token。红线：不得把 google-services.json 提交到仓库。

- [ ] **E09-011 实现推送通知接收与深链接**。归属：Android。前置：E09-010。执行：实现 `FirebaseMessagingService`，根据 payload 中的 action 导航到对应页面。验收：点击通知可跳转。红线：不得在 App 前台时弹出 heads-up 通知（使用 in-app 提示）。

- [ ] **E09-012 实现 Foreground Service 后台保活**。归属：Android。前置：E09-004。执行：创建 Foreground Service 维持 WebSocket 连接。通知栏显示连接状态和快捷操作（Disconnect、Open）。验收：App 切到后台后连接不断。红线：不得在用户未启用时自动启动。

- [ ] **E09-013 实现 Biometric 锁定**。归属：Android。前置：E09-001。执行：使用 BiometricPrompt API 在 App 恢复前台时要求认证。可在设置中开关。验收：启用后切回 App 需要认证。红线：认证失败不得清除数据。

- [ ] **E09-014 实现设备管理页面**。归属：Android。前置：E05-009。执行：同 iOS E08-017。验收：同 iOS。红线：同 iOS。

- [ ] **E09-015 实现 Android Widget**。归属：Android。前置：E09-004。执行：创建 Glance Widget 显示当前 session 状态（名称、tab 数、连接状态）。点击打开 App。验收：Widget 更新及时。红线：Widget 不得执行复杂操作。

- [ ] **E09-016 补齐 Android UI 测试**。归属：QA。前置：E09-001~E09-015。执行：使用 Compose UI Testing 测试关键流程。验收：模拟器上测试通过。红线：不得依赖真实服务器。


## EPIC-010 Event Streaming & Adapter Platform（14 项）

- [ ] **E10-001 定义 SemanticEvent 和 AdapterState 类型**。归属：Contract。前置：无。执行：在 `src/backend/adapters/types.ts` 定义 `SemanticEvent`（type/seq/timestamp/data/adapterId）和 `AdapterState`（adapterId/name/mode/capabilities/currentState）。验收：类型编译通过。红线：不得引入 adapter-specific 字段到 core 类型。

- [ ] **E10-002 定义 SemanticAdapter 接口**。归属：Contract。前置：E10-001。执行：定义 `SemanticAdapter` 接口（id/name/mode/capabilities/onTerminalData?/onEventFile?/getCurrentState?）。验收：接口可被实现。红线：不得让接口依赖特定 adapter 的类型。

- [ ] **E10-003 实现 AdapterRegistry**。归属：TS Backend。前置：E10-002。执行：在 `src/backend/adapters/registry.ts` 实现 adapter 注册、查询、事件分发。支持注册多个 adapter 并按优先级排列。验收：可注册和查询 adapter。红线：不得限制只能注册一个 adapter。

- [ ] **E10-004 实现 generic-shell adapter**。归属：TS Backend。前置：E10-003。执行：基线 adapter，mode: "passive"，只报告 shell 基础信息（cwd、最后命令、exit code）。从 terminal data 中解析 prompt 模式推断。验收：始终可用作 fallback。红线：不得对终端数据做昂贵的解析。

- [ ] **E10-005 实现 claude-code adapter**。归属：TS Backend。前置：E10-003。执行：基于现有 `EventWatcher` 扩展。mode: "passive"，监听 `~/.copilot/session-state/` 下的 events.jsonl，解析 conversation events，转换为 SemanticEvent。报告当前 run 状态（idle/running/waiting_approval/error）。验收：Claude Code 运行时 adapter 能报告状态变化。红线：不得修改 Claude Code 的文件。

- [ ] **E10-006 在 control 通道增加 event 流**。归属：TS Backend。前置：E10-003。执行：当 adapter 产生 SemanticEvent 时，通过 control WebSocket 广播 `{ domain: "semantic", type: "event", payload: SemanticEvent }` 给所有已认证客户端（支持 envelope 的客户端）。验收：客户端可实时收到 adapter 事件。红线：不得为旧客户端发送 semantic 事件。

- [ ] **E10-007 在 control 通道增加 adapter_state 查询**。归属：TS Backend。前置：E10-003。执行：新增 `request_adapter_state` 命令，返回所有已注册 adapter 的当前状态。验收：客户端可查询 adapter 状态。红线：不得返回 adapter 内部实现细节。

- [ ] **E10-008 前端显示 adapter 状态指示器**。归属：TS Frontend。前置：E10-006, E10-007。执行：在 AppHeader 或 status bar 显示当前活跃 adapter 名称和状态图标（idle: 灰色, running: 绿色动画, waiting: 黄色, error: 红色）。验收：状态实时更新。红线：不得在无 adapter 时显示空白。

- [ ] **E10-009 前端 Run 状态卡片**。归属：TS Frontend。前置：E10-006。执行：当 claude-code adapter 报告 run 状态时，在 UI 中显示 Run 卡片（当前步骤、工具使用、时间、状态）。卡片可展开查看事件流。验收：Run 状态可追踪。红线：不得在无 adapter 事件时显示假 run。

- [ ] **E10-010 iOS 显示 adapter 状态**。归属：iOS。前置：E10-006。执行：在 Now 页面显示 adapter 状态（如果有活跃 run 则显示 run 卡片）。验收：iPhone 可看到 run 状态。红线：不得在无事件时占据过多空间。

- [ ] **E10-011 Android 显示 adapter 状态**。归属：Android。前置：E10-006。执行：同 iOS E10-010。验收：Android 可看到 run 状态。红线：同 iOS。

- [ ] **E10-012 实现 adapter 事件持久化**。归属：TS Backend。前置：E10-006。执行：把 SemanticEvent 持久化到 SQLite（`~/.remux/events.db`），支持按 adapter/time/type 查询。保留最近 7 天事件。验收：重启后事件历史可查。红线：不得无限增长。

- [ ] **E10-013 前端 Run 历史列表**。归属：TS Frontend。前置：E10-012。执行：在新的 "Runs" 视图中显示历史 run 列表（基于持久化事件）。每个 run 显示开始时间、持续时间、状态、adapter。验收：可回溯最近 run。红线：不得在列表中加载全部事件详情。

- [ ] **E10-014 补齐 adapter 集成测试**。归属：QA。前置：E10-004~E10-006。执行：Mock events.jsonl 文件变化，验证 claude-code adapter 的事件解析和 WebSocket 广播。验收：adapter 事件链路端到端通过。红线：不得依赖真实 Claude Code 进程。


## EPIC-011 Worktree & Review Center（16 项）

- [ ] **E11-001 实现 git 状态查询 API**。归属：TS Backend。前置：无。执行：新增 `GET /api/git/status` 端点，返回当前 cwd 的 git 信息（branch、status、recent commits、worktree list）。使用 `simple-git` npm 包。验收：API 返回正确 git 信息。红线：不得执行任何写操作。

- [ ] **E11-002 实现 git diff 查询 API**。归属：TS Backend。前置：E11-001。执行：新增 `GET /api/git/diff?base=main` 端点，返回 diff 内容（unified format）和变更文件列表。验收：diff 内容可解析。红线：不得返回超大 diff（限制 1MB）。

- [ ] **E11-003 实现 worktree 列表与创建 API**。归属：TS Backend。前置：E11-001。执行：新增 `GET /api/git/worktrees` 和 `POST /api/git/worktrees` 端点。创建时需指定 branch 名和路径。验收：可列出和创建 worktree。红线：不得在非 git 目录执行。

- [ ] **E11-004 前端 diff viewer 组件**。归属：TS Frontend。前置：E11-002。执行：使用 `react-diff-viewer-continued` 或自建简单 diff 渲染器，支持 unified diff 和 split diff 两种模式。syntax highlighting 使用 `highlight.js`。验收：diff 可读、可切换模式。红线：不得自己解析 diff 格式（使用 `diff` 库解析）。

- [ ] **E11-005 前端 Review Center 视图骨架**。归属：TS Frontend。前置：E11-004。执行：新增 Review 视图（可通过顶部导航切换），左栏显示变更文件列表，中间显示 diff，右栏显示 context（commit 信息、branch 状态）。验收：Review 视图可打开并显示 diff。红线：不得在首次加载时获取所有文件的 diff。

- [ ] **E11-006 前端 diff inline comment**。归属：TS Frontend。前置：E11-005。执行：在 diff 行号旁增加"+"按钮，点击可添加行级评论。评论存储在本地（Phase A 不需要服务端持久化）。验收：可在 diff 行上添加和查看评论。红线：评论丢失时不报错（本地数据）。

- [ ] **E11-007 前端 worktree manager 视图**。归属：TS Frontend。前置：E11-003。执行：在 sidebar 增加 Worktrees 区域，显示所有 worktree（branch、路径、clean/dirty 状态）。支持创建和归档 worktree。验收：worktree 列表实时更新。红线：不得提供 force delete 操作。

- [ ] **E11-008 前端 git quick actions**。归属：TS Frontend。前置：E11-001。执行：在 Review 视图底部增加快捷操作按钮：Commit、Push、Pull、Create Branch、Switch Branch。每个操作有确认对话框。验收：基本 git 操作可通过 UI 完成。红线：force push 必须有额外确认。

- [ ] **E11-009 Tauri diff/review 增强**。归属：Tauri。前置：E11-005。执行：在 Tauri 环境下，diff viewer 可通过 Tauri command 调用系统 diff 工具（如 `git difftool`）。支持拖放文件到 diff viewer。验收：Tauri 桌面 diff 体验优于浏览器。红线：不得强制要求安装外部工具。

- [ ] **E11-010 iOS diff mini-review 视图**。归属：iOS。前置：E11-002。执行：在 iOS 中实现简化版 diff viewer（只读），显示变更文件列表和 unified diff。验收：可在 iPhone 上阅读 diff。红线：不得在移动端实现 inline comment。

- [ ] **E11-011 Android diff mini-review 视图**。归属：Android。前置：E11-002。执行：同 iOS E11-010。验收：同 iOS。红线：同 iOS。

- [ ] **E11-012 实现 git webhook 事件监听**。归属：TS Backend。前置：E11-001。执行：监听 `.git/` 目录变化（fs.watch），当 HEAD、refs 变化时触发 workspace_state 刷新。验收：git 操作后 UI 自动更新。红线：不得做轮询。

- [ ] **E11-013 实现 branch 比较 API**。归属：TS Backend。前置：E11-002。执行：`GET /api/git/compare?base=main&head=feature` 返回两个分支间的 diff summary（files changed, insertions, deletions）。验收：比较结果正确。红线：不得对大仓库执行全量 diff。

- [ ] **E11-014 前端 PR 创建辅助**。归属：TS Frontend。前置：E11-005, E11-013。执行：在 Review 视图增加"Create PR"按钮，填写 title/body 后通过 `gh pr create` 命令（如果可用）或打开 GitHub URL。验收：可从 Remux 内发起 PR 创建。红线：不得在没有 `gh` CLI 时报错。

- [ ] **E11-015 Tauri worktree 快捷操作**。归属：Tauri。前置：E11-007。执行：Tauri 系统 tray 菜单增加"Switch Worktree"子菜单，列出所有 worktree。点击切换当前上下文。验收：tray 切换可用。红线：不得在无 worktree 时显示空菜单。

- [ ] **E11-016 补齐 review 集成测试**。归属：QA。前置：E11-001~E11-008。执行：在测试 fixture 中创建 git 仓库，验证 diff API、worktree 创建、Review 视图渲染。验收：测试在 gate 中稳定通过。红线：不得依赖外部 git 仓库。


## EPIC-012 Agents, Runs & Approvals（16 项）

- [ ] **E12-001 定义 Agent、Run、RunStep、Approval 数据模型**。归属：Contract。前置：E10-001。执行：在 `src/backend/agents/types.ts` 定义完整类型。Agent: id/name/adapterId/capabilities/budgetPolicy/memoryScope。Run: runId/agentId/topicId?/status/startedAt/currentStep/budgetSpent/approvalState/diffSummary。RunStep: stepId/runId/type/tool/input/output/timestamp。Approval: approvalId/runId/requestedAction/preview/diff/impactedFiles/rollbackPath/expiry/status。验收：类型编译通过；覆盖所有必要字段。红线：不得在此任务实现业务逻辑。

- [ ] **E12-002 实现 Run 持久化层**。归属：TS Backend。前置：E12-001, E10-012。执行：在 `~/.remux/events.db` 中增加 `runs` 和 `run_steps` 表。从 adapter SemanticEvent 流中提取 run lifecycle 事件并入库。验收：run 可持久化和查询。红线：不得重复存储已有事件数据。

- [ ] **E12-003 实现 Approval 持久化层**。归属：TS Backend。前置：E12-001。执行：在 SQLite 中增加 `approvals` 表。支持创建、查询、更新状态（pending/approved/rejected/expired）。验收：approval 可 CRUD。红线：不得允许已过期 approval 被 approve。

- [ ] **E12-004 实现 Run 查询 API**。归属：TS Backend。前置：E12-002。执行：`GET /api/runs`（列表，支持过滤 status/agentId）、`GET /api/runs/:runId`（详情含 steps）。验收：API 返回完整 run 信息。红线：不得返回超过 1000 条 step。

- [ ] **E12-005 实现 Approval 查询与操作 API**。归属：TS Backend。前置：E12-003。执行：`GET /api/approvals`（列表）、`POST /api/approvals/:id/approve`、`POST /api/approvals/:id/reject`。验收：approval 生命周期可通过 API 完成。红线：不得允许未认证用户审批。

- [ ] **E12-006 在 control 通道广播 run/approval 事件**。归属：TS Backend。前置：E12-002, E12-003。执行：run 状态变化和新 approval 时广播 envelope 消息（domain: "agent"）。验收：客户端实时收到 run/approval 更新。红线：不得广播大量 step 细节（只广播 summary）。

- [ ] **E12-007 前端 Run Board 视图**。归属：TS Frontend。前置：E12-004, E12-006。执行：新增 Agents 视图，显示 Run Board：每个 run 一张卡片，显示 agent/adapter/status/current step/budget/branch/approval state。支持 group by status/adapter。验收：run board 可用；状态实时更新。红线：不得在无 run 时显示空板。

- [ ] **E12-008 前端 Run 详情面板**。归属：TS Frontend。前置：E12-007。执行：点击 run 卡片展开详情面板，显示 step timeline（tool calls、输出摘要、时间戳）、diff summary、相关 tab/pane context。验收：step timeline 可滚动浏览。红线：不得一次加载全部 step。

- [ ] **E12-009 前端 Approval Center 视图**。归属：TS Frontend。前置：E12-005, E12-006。执行：在 Agents 视图中增加 Approval 子标签。显示 pending approvals 列表，每个 approval 显示 preview/diff/action/expiry。提供 Approve/Reject 按钮。验收：可在 UI 中完成审批。红线：Approve 必须有确认步骤。

- [ ] **E12-010 前端 Run Budget 显示**。归属：TS Frontend。前置：E12-007。执行：在 run 卡片上显示 budget 消耗进度条（如果 adapter 提供 budget 信息）。验收：进度条反映真实消耗。红线：无 budget 信息时不显示（而非显示 0%）。

- [ ] **E12-011 iOS Run/Approval 视图**。归属：iOS。前置：E12-006。执行：在 Runs tab 中显示活跃 run 列表和 pending approvals。支持 approve/reject 快捷操作。验收：可在 iPhone 上审批。红线：审批按钮要足够大（touch target）。

- [ ] **E12-012 Android Run/Approval 视图**。归属：Android。前置：E12-006。执行：同 iOS E12-011。验收：同 iOS。红线：同 iOS。

- [ ] **E12-013 Tauri Run 状态通知**。归属：Tauri。前置：E12-006。执行：当 run 完成或需要 approval 时，Tauri 发送系统通知。通知点击打开 run detail 或 approval center。验收：通知可触达；点击导航正确。红线：不得在 run 正常运行时发通知。

- [ ] **E12-014 实现 approval 推送通知**。归属：TS Backend。前置：E12-003, E06-001。执行：新 approval 创建时向所有已注册的 push subscription 发送推送。验收：手机收到 approval 推送。红线：不得在 approval 已过期后仍推送。

- [ ] **E12-015 实现 run 自动清理**。归属：TS Backend。前置：E12-002。执行：超过 30 天的 run 记录自动归档（step 详情删除，保留 summary）。验收：数据库不会无限增长。红线：不得删除未完成的 run。

- [ ] **E12-016 补齐 agent/run/approval 集成测试**。归属：QA。前置：E12-001~E12-009。执行：Mock adapter 事件，验证 run 创建、step 记录、approval 生命周期、UI 显示。验收：全链路测试通过。红线：不得依赖真实 AI agent。


## EPIC-013 Topics & Artifacts（14 项）

- [ ] **E13-001 定义 Topic、Message、Artifact 数据模型**。归属：Contract。前置：E12-001。执行：Topic: topicId/title/status/createdAt/linkedRunIds/linkedRuntimeContext。Message: messageId/topicId/authorType(human|agent|system)/content/timestamp。Artifact: artifactId/topicId/type(decision|task|review|run_report|file)/title/content/metadata。验收：类型覆盖所有必要字段。红线：不得过度设计。

- [ ] **E13-002 实现 Topic 持久化层**。归属：TS Backend。前置：E13-001。执行：SQLite 表 `topics`、`messages`、`artifacts`、`topic_runtime_links`。CRUD API。验收：topic 可创建、查询、更新。红线：不得引入外部数据库依赖。

- [ ] **E13-003 实现 Topic CRUD API**。归属：TS Backend。前置：E13-002。执行：`POST /api/topics`、`GET /api/topics`、`GET /api/topics/:id`、`PUT /api/topics/:id`、`DELETE /api/topics/:id`。验收：完整 CRUD 可用。红线：不得允许删除有活跃 run 的 topic。

- [ ] **E13-004 实现 Message CRUD API**。归属：TS Backend。前置：E13-002。执行：`POST /api/topics/:id/messages`、`GET /api/topics/:id/messages`（分页）。验收：消息可创建和分页查询。红线：不得返回超过 100 条/页。

- [ ] **E13-005 实现 Artifact CRUD API**。归属：TS Backend。前置：E13-002。执行：`POST /api/topics/:id/artifacts`、`GET /api/topics/:id/artifacts`、`PUT /api/artifacts/:id`。验收：artifact 可创建和查询。红线：不得允许修改 type 字段。

- [ ] **E13-006 实现 "Create Topic from Runtime Context"**。归属：TS Backend。前置：E13-003, E02-004。执行：`POST /api/topics/from-context` 接收 sessionName/tabIndex/paneId，自动创建 topic 并关联 runtime context 和 inspect snapshot。验收：一键从终端上下文创建 topic。红线：不得复制大量终端内容到 topic。

- [ ] **E13-007 实现 Run-Topic 绑定**。归属：TS Backend。前置：E13-002, E12-002。执行：Run 创建时可选择关联 topic。Topic 详情中显示关联的 runs。验收：run 和 topic 双向可查。红线：不得强制每个 run 必须有 topic。

- [ ] **E13-008 前端 Topics 视图骨架**。归属：TS Frontend。前置：E13-003。执行：新增 Topics 视图（顶部导航新标签）。左侧 topic 列表（按最近更新排序），右侧 topic 详情。验收：可浏览 topic 列表。红线：不得在首次加载时获取所有 topic 的全部消息。

- [ ] **E13-009 前端 Topic Timeline**。归属：TS Frontend。前置：E13-004, E13-005, E13-007。执行：Topic 详情中显示混合 timeline（message + run event + artifact 卡片，按时间排序）。每种类型有不同卡片样式。验收：timeline 混排正确。红线：不得把 timeline 做成纯聊天界面。

- [ ] **E13-010 前端 Topic Composer**。归属：TS Frontend。前置：E13-004。执行：Topic 详情底部增加消息输入框，支持文本和命令（如 `/run`、`/approve`）。验收：可发送消息到 topic。红线：不得在 Phase A 实现复杂的 slash command。

- [ ] **E13-011 前端 Artifact 卡片组件**。归属：TS Frontend。前置：E13-005。执行：实现四种 artifact 卡片：Decision（结论 + 理由）、Task（状态 + 负责人）、Review（diff summary + status）、Run Report（run summary + outcome）。验收：四种卡片可渲染。红线：不得为卡片引入复杂的编辑功能。

- [ ] **E13-012 iOS Topics 视图**。归属：iOS。前置：E13-003。执行：在 Topics tab 中显示 topic 列表和详情（timeline）。支持创建新 topic 和发送消息。验收：可在 iPhone 上浏览和参与 topic。红线：不得实现 artifact 编辑。

- [ ] **E13-013 Android Topics 视图**。归属：Android。前置：E13-003。执行：同 iOS E13-012。验收：同 iOS。红线：同 iOS。

- [ ] **E13-014 补齐 topic 集成测试**。归属：QA。前置：E13-001~E13-009。执行：测试 topic CRUD、消息创建、artifact 创建、run 绑定、from-context 创建。验收：全链路通过。红线：不得跳过分页测试。


## EPIC-014 Search, Memory & Handoff（12 项）

- [ ] **E14-001 实现全文搜索索引**。归属：TS Backend。前置：E13-002, E10-012。执行：使用 SQLite FTS5 扩展为 topics、messages、artifacts、inspect 内容建立全文索引。验收：搜索可返回跨类型结果。红线：不得引入 Elasticsearch 等外部依赖。

- [ ] **E14-002 实现搜索 API**。归属：TS Backend。前置：E14-001。执行：`GET /api/search?q=keyword&type=all|topic|message|artifact|inspect` 端点。返回按相关度排序的结果（snippet + type + link）。验收：搜索返回正确结果。红线：限制每次 50 条结果。

- [ ] **E14-003 前端全局搜索 UI**。归属：TS Frontend。前置：E14-002。执行：Command Palette（Cmd/Ctrl+K）触发搜索对话框，输入即搜。结果按类型分组显示。点击结果导航到对应视图。验收：搜索响应 < 500ms。红线：不得在每次按键时发请求（debounce 200ms）。

- [ ] **E14-004 Tauri Command Palette 增强**。归属：Tauri。前置：E14-003。执行：Tauri 全局快捷键（Cmd+K / Ctrl+K）在任何页面触发 Command Palette，且支持系统级操作（switch worktree、open new window、connect to server）。验收：Command Palette 可用。红线：不得与系统快捷键冲突。

- [ ] **E14-005 定义 Memory 模型**。归属：Contract。前置：E13-001。执行：`MemoryEntry`: id/scope(device|session|topic|project|workspace)/key/value/source/createdAt/expiresAt。验收：类型覆盖五层 scope。红线：不得把 memory 做成通用 key-value store。

- [ ] **E14-006 实现 Memory 持久化层**。归属：TS Backend。前置：E14-005。执行：SQLite 表 `memory_entries`。CRUD + scope 过滤查询。验收：memory 可按 scope 存取。红线：默认保留期 90 天。

- [ ] **E14-007 实现 Memory API**。归属：TS Backend。前置：E14-006。执行：`GET /api/memory?scope=topic&scopeId=xxx`、`POST /api/memory`、`DELETE /api/memory/:id`。验收：API 可用。红线：不得允许跨 scope 覆写。

- [ ] **E14-008 实现 Handoff Digest 生成**。归属：TS Backend。前置：E13-002, E12-002。执行：`GET /api/topics/:id/handoff` 端点生成 topic 的交接摘要：最近活动、阻塞点、待办项、关键 artifact、runtime context 链接。验收：摘要可在 60 秒内理解上下文。红线：不得使用 AI 生成摘要（Phase A 用规则）。

- [ ] **E14-009 前端 Handoff 视图**。归属：TS Frontend。前置：E14-008。执行：Topic 详情中增加 "Handoff" 按钮，显示生成的摘要卡片。验收：摘要卡片可读。红线：不得在 topic 为空时显示空摘要。

- [ ] **E14-010 iOS 搜索与 Handoff**。归属：iOS。前置：E14-002, E14-008。执行：在 iOS 中实现搜索 UI（搜索栏 + 结果列表）和 topic handoff 视图。验收：可在 iPhone 上搜索和查看 handoff。红线：搜索结果不得加载全部详情。

- [ ] **E14-011 Android 搜索与 Handoff**。归属：Android。前置：E14-002, E14-008。执行：同 iOS E14-010。验收：同 iOS。红线：同 iOS。

- [ ] **E14-012 补齐搜索与 memory 集成测试**。归属：QA。前置：E14-001~E14-007。执行：测试 FTS5 索引创建、搜索结果排序、memory CRUD、handoff 生成。验收：全链路通过。红线：不得在测试中依赖特定 locale。


## EPIC-015 Visualization Board（12 项）

- [ ] **E15-001 定义 Board 视图数据模型**。归属：Contract。前置：E12-001, E13-001。执行：`BoardItem`: id/type(agent|topic|runtime)/title/status/position/metadata。`BoardLayout`: items + connections + grouping。验收：模型可表达三种 board。红线：不得引入复杂的图数据结构。

- [ ] **E15-002 实现 Agent Board API**。归属：TS Backend。前置：E15-001, E12-004。执行：`GET /api/boards/agents` 返回所有活跃 agent/run 的 BoardLayout。每个 agent card 包含 adapter/status/branch/budget/approval state。验收：API 返回可渲染数据。红线：不得返回历史 run（只返回活跃的）。

- [ ] **E15-003 实现 Runtime Topology API**。归属：TS Backend。前置：E15-001。执行：`GET /api/boards/runtime` 返回 session/tab/pane 拓扑结构，包含每个 pane 的状态、连接的客户端数、adapter 状态。验收：拓扑正确反映当前状态。红线：不得包含客户端私有信息。

- [ ] **E15-004 实现 Topic Board API**。归属：TS Backend。前置：E15-001, E13-003。执行：`GET /api/boards/topics` 返回活跃 topic 的 BoardLayout，包含 status/run count/message count/last activity。验收：API 返回可渲染数据。红线：不得返回归档 topic。

- [ ] **E15-005 前端 Agent Board 视图**。归属：TS Frontend。前置：E15-002。执行：使用 CSS Grid 或简单卡片布局渲染 Agent Board。每张卡片可点击展开详情。支持 group by status/adapter。验收：board 渲染正确。红线：不得使用 D3.js 等重库。

- [ ] **E15-006 前端 Runtime Topology 视图**。归属：TS Frontend。前置：E15-003。执行：树形或嵌套卡片布局显示 session → tab → pane 拓扑。每个 pane 显示状态图标和 adapter 标记。验收：拓扑可视化直观。红线：不得实现拖拽重排。

- [ ] **E15-007 前端 Topic Board 视图**。归属：TS Frontend。前置：E15-004。执行：看板式布局（按 status 分列：active/waiting/blocked/done）显示 topic 卡片。支持拖拽更新 status。验收：board 可交互。红线：拖拽操作需有 API 支持。

- [ ] **E15-008 前端 Board 聚合入口**。归属：TS Frontend。前置：E15-005~E15-007。执行：新增 "Board" 视图（顶部导航），提供 Agent/Runtime/Topic 三个 sub-tab。验收：三个 board 可切换浏览。红线：不得同时加载三个 board 的数据。

- [ ] **E15-009 Tauri Board 系统通知集成**。归属：Tauri。前置：E15-005。执行：Agent Board 中的 blocked/approval-needed run 触发系统通知（如果配置）。验收：blocked run 有通知。红线：不得在 run 正常运行时通知。

- [ ] **E15-010 iOS Board 简化视图**。归属：iOS。前置：E15-002, E15-004。执行：在 Runs tab 中增加简化版 Agent Board 和 Topic 列表。每个卡片显示关键信息。验收：可在 iPhone 上浏览 board。红线：不得实现拖拽。

- [ ] **E15-011 Android Board 简化视图**。归属：Android。前置：E15-002, E15-004。执行：同 iOS E15-010。验收：同 iOS。红线：同 iOS。

- [ ] **E15-012 补齐 board 集成测试**。归属：QA。前置：E15-002~E15-008。执行：测试三个 board API 返回数据的正确性和前端渲染。验收：测试通过。红线：不得依赖真实 agent 数据。


## EPIC-016 Self-host, Packaging & Quality（14 项）

- [ ] **E16-001 Tauri 三平台 CI 构建**。归属：Release。前置：E07-017。执行：在 GitHub Actions 中增加 macOS/Windows/Linux 构建 job，每次 push 到 dev 触发 Tauri 打包。验收：三平台 artifact 可下载。红线：不得在 CI 中存储签名密钥明文。

- [ ] **E16-002 Tauri 自动更新配置**。归属：Release。前置：E16-001。执行：配置 Tauri updater 插件，使用 GitHub Releases 作为更新源。验收：Tauri 应用启动时检查更新并可一键更新。红线：不得强制更新。

- [ ] **E16-003 iOS TestFlight 分发流水线**。归属：Release。前置：E08-001。执行：在 GitHub Actions 中配置 Xcode 构建 + TestFlight 上传。使用 Apple Developer 证书和 profile。验收：push 到 dev 后 TestFlight 可收到新版本。红线：不得在 CI 中存储 p12 密码明文。

- [ ] **E16-004 Android 内部测试分发**。归属：Release。前置：E09-001。执行：在 GitHub Actions 中配置 Gradle 构建 + Firebase App Distribution 上传。验收：push 到 dev 后可收到新版本。红线：不得在 CI 中存储 keystore 明文。

- [ ] **E16-005 npm 包发布流水线增强**。归属：Release。前置：无。执行：增加 `npm run test:release`（typecheck + test + e2e + pack 验证）到 CI publish 流程。验收：发布前自动验证。红线：不得自动 publish 到 npm（需人工触发）。

- [ ] **E16-006 Docker 自托管镜像**。归属：Release。前置：无。执行：创建 `Dockerfile`，FROM node:20-slim，安装 zellij，copy dist，ENTRYPOINT node dist/backend/cli-zellij.js。验收：`docker run` 可启动 Remux。红线：不得在镜像中包含 dev 依赖。

- [ ] **E16-007 self-host 文档更新**。归属：Docs。前置：E16-006。执行：更新 `docs/SELF_HOSTED_RUNNER.md`，增加 Docker 部署、Tailscale 连接、systemd/launchd service 配置示例。验收：文档可操作。红线：不得包含过时的命令。

- [ ] **E16-008 增加 reconnect chaos 测试**。归属：QA。前置：无。执行：Playwright 测试中模拟网络断开/恢复（使用 route abort/continue），验证自动重连、Inspect 刷新、状态恢复。验收：chaos 测试稳定通过。红线：不得用 fixed timeout 判断恢复。

- [ ] **E16-009 增加 width 自动化验收测试**。归属：QA。前置：无。执行：在 Playwright E2E 中增加终端宽度验证：启动终端 → 执行 `tput cols` → 读取输出 → 与容器 CSS 宽度比较。覆盖桌面和移动宽度。验收：终端列数与容器宽度一致。红线：不得用 mock 替代真实终端检查。

- [ ] **E16-010 增加 protocol fixture 回归门禁**。归属：QA。前置：E03-009。执行：在 CI 中增加 golden payload 解码验证步骤，对所有 fixture 文件运行 TypeScript/Swift/Kotlin 解码测试。验收：协议变更时多端同时红灯。红线：不得跳过任何端的解码测试。

- [ ] **E16-011 增加截图回归基线**。归属：QA。前置：无。执行：为 Inspect 视图、Live 终端、Review Center、Agent Board 建立 Playwright screenshot baseline。验收：UI 变更时 screenshot diff 可视化审查。红线：不得在不同分辨率下混用基线。

- [ ] **E16-012 性能基准测试**。归属：QA。前置：无。执行：建立性能基准脚本，测量 attach latency（P50/P95）、inspect first paint、trusted reconnect 时间。验收：基准每周自动运行；结果保存到 `tests/perf/results/`。红线：不得在 CI 中运行（延迟不稳定，本地运行即可）。

- [ ] **E16-013 Homebrew tap 配置**。归属：Release。前置：E07-017。执行：创建 `homebrew-remux` tap 仓库，配置 macOS Tauri .dmg 的 formula。验收：`brew install --cask yaoshenwang/remux/remux` 可安装。红线：formula 不得手动维护版本号（自动从 GitHub Release 获取）。

- [ ] **E16-014 补齐发布文档**。归属：Docs。前置：E16-001~E16-013。执行：在 `docs/` 增加 `RELEASING.md`，描述各平台的发布流程、版本号规则、签名要求、回滚策略。验收：新发布人可按文档独立完成发布。红线：不得包含过时的手动步骤。


## EPIC-017 Team Mode Foundations（12 项）

- [ ] **E17-001 定义 User Identity 模型**。归属：Contract。前置：无。执行：`UserIdentity`: userId/displayName/email/avatarUrl/role(owner|admin|member|viewer)。验收：类型编译通过。红线：不得与 DeviceIdentity 混用。

- [ ] **E17-002 实现用户认证层**。归属：TS Backend。前置：E17-001。执行：在现有 token auth 之上增加可选的用户身份认证。支持本地用户（密码）和未来 SSO 扩展点。验收：可创建用户并用用户身份登录。红线：Personal Mode 下仍可用 token-only 认证。

- [ ] **E17-003 实现 RBAC 基础**。归属：TS Backend。前置：E17-001。执行：定义 Permission 枚举（read/write/admin/approve）和 Role-Permission 映射。在 API 中间件中增加权限检查。验收：不同 role 的用户看到不同操作权限。红线：不得影响 Personal Mode。

- [ ] **E17-004 实现 Workspace 模型**。归属：TS Backend。前置：E17-001。执行：`Workspace`: id/name/ownerId/members。CRUD API。Topic 和 Project 归属于 Workspace。验收：Workspace 可创建。红线：Personal Mode 默认一个隐式 workspace。

- [ ] **E17-005 实现 Project 模型**。归属：TS Backend。前置：E17-004。执行：`Project`: id/workspaceId/name/description/runtimeLinks。CRUD API。Topic 归属于 Project。验收：Project 可创建并关联到 workspace。红线：不得强制每个 topic 必须有 project。

- [ ] **E17-006 实现 Audit Log**。归属：TS Backend。前置：E17-002。执行：关键操作（认证、审批、设备管理、topic 操作）写入 `audit_log` SQLite 表。记录 userId/action/target/timestamp/details。验收：可查询审计日志。红线：不得记录敏感数据（密码、token 值）。

- [ ] **E17-007 实现 Topic ACL**。归属：TS Backend。前置：E17-003, E13-002。执行：Topic 增加 visibility（public/private）和 allowedMembers 字段。API 查询时根据当前用户过滤。验收：private topic 只对允许成员可见。红线：不得破坏 Personal Mode 下的无 ACL 行为。

- [ ] **E17-008 实现团队邀请**。归属：TS Backend。前置：E17-002。执行：`POST /api/workspace/:id/invite` 生成邀请链接（含 workspace + role）。被邀请人通过链接加入。验收：邀请链路可用。红线：邀请链接有过期时间。

- [ ] **E17-009 前端 Team 设置页面**。归属：TS Frontend。前置：E17-004, E17-002。执行：在 sidebar 增加 Team 设置页面，显示 workspace 成员、角色、邀请管理。验收：可查看和管理团队。红线：在 Personal Mode 下隐藏此页面。

- [ ] **E17-010 前端 Presence 指示器**。归属：TS Frontend。前置：E17-002. 执行：在 topic timeline 和 terminal 视图中显示其他在线用户的 avatar。验收：可看到谁在线。红线：不得暴露用户的具体操作。

- [ ] **E17-011 实现 SSO 扩展点**。归属：TS Backend。前置：E17-002。执行：定义 `AuthProvider` 接口，当前实现 `LocalAuthProvider`。预留 OAuth2/OIDC 扩展点。验收：接口定义清晰；本地认证不受影响。红线：不得在此任务实现 OAuth2。

- [ ] **E17-012 补齐 team 集成测试**。归属：QA。前置：E17-001~E17-007。执行：测试多用户场景：不同 role 的权限边界、topic ACL、audit log 记录。验收：权限测试通过。红线：不得跳过 viewer 角色的写权限拒绝测试。


---

# 10. Epic 依赖关系与执行顺序

```
Phase A (Month 1-3) — E01~E06 已完成 ✅:
  ✅ E01 术语清理
  ✅ E02 Inspect
  ✅ E03 协议升级
  ✅ E04 Client State
  ✅ E05 Device Trust
  ✅ E06 Web Push

当前执行线 (Month 4+):
  E07 Tauri Desktop ──────────────────────┐
                                          ├──→ E08 iOS
  E10 Event Streaming ──→ E12 Agents/Runs │    E09 Android
                                          │
  E11 Worktree/Review ───────────────────→┘

Phase B (Month 4-9):
  E07 Tauri Desktop ──→ E08 iOS ──→ E09 Android
  E10 Event Streaming ──→ E12 Agents/Runs ──→ E13 Topics
  E11 Worktree/Review ──────────────────────────────────→

Phase C (Month 9-18):
  E14 Search/Memory ──→ E15 Visualization ──→ E17 Team Mode
  E16 Packaging/Quality (持续并行)
```

**关键路径**：E07（Tauri Desktop）→ E08（iOS Alpha）

**已解锁的前置条件**（E01--E06 完成带来的收益）：
- E07 可直接使用 domain envelope 协议（E03）和 Device Trust（E05）
- E08/E09 可直接使用 Web Push（E06）和 Client Connection State（E04）
- E10 可直接使用协议 envelope 格式（E03）传输事件流

**可并行的独立路线**：
- E07（Tauri）立即可以开始，所有前置已满足
- E10（Event Streaming）独立于 E07，可并行
- E16（Packaging/Quality）全程并行

---

# 11. 你现在就应该拍板的 16 个决策

1. Remux 的唯一主叙事从今天起就是"全端 AI 原生工作空间操作系统"——在 cmux（macOS-only 原生终端）和 Warp（Rust 原生终端）之间，Remux 的差异化定位是 **全端 + Web-first + 远程工作空间控制**
2. **桌面旗舰使用 Tauri 2**，共享现有 React 前端资产
3. **iOS 使用 SwiftUI 原生开发**，终端渲染用 WKWebView 桥接
4. **Android 使用 Kotlin + Jetpack Compose 原生开发**，终端渲染用 WebView 桥接
5. 后端继续使用 TypeScript（Rust runtime 延后到性能成为瓶颈时评估）
6. 协议从简单 JSON 渐进升级为 domain envelope，保持向后兼容
7. Inspect 从"基础抓取"升级为带元数据的真实历史服务
8. Device Trust 基于 QR pairing + resume token + SQLite 存储
9. Web 是通用入口，Tauri Desktop 是旗舰，Mobile 是干预旗舰
10. 第一个深度 adapter 是 Claude Code（基于现有 EventWatcher）
11. Topic/Artifact 是协作层核心，不是 Message
12. Personal Mode 先做稳（SQLite），Team Mode 后续扩展
13. 不做 Go/Rust 服务端重写（当前 TS 够用）
14. pixel/world 延后到 board/graph 成熟之后
15. 旧规划进入 archive，不再并列竞争主叙事
16. **优先复用成熟开源代码，不重复造轮子**——实现新功能前先调研开源方案，仅在无合适方案或涉及核心差异化时自研

---

# 12. 成功定义与体验底线复述

## 性能目标

- attach latency：局域网 P50 < 300ms, P95 < 800ms；经 relay P50 < 900ms, P95 < 2s
- inspect first paint：移动端 P50 < 500ms, P95 < 1.2s
- trusted reconnect success rate：> 95%
- terminal stream：无肉眼级卡顿，持续输出时输入不丢失
- notification-to-open latency：移动端 P50 < 1.5s
- diff rendering：中型 diff 首次可交互 < 800ms

## 质量门禁

每个 PR 至少经过：

1. typecheck
2. unit tests (Vitest)
3. protocol fixture tests
4. e2e tests (Playwright)
5. width validation (UI 变更时)
6. screenshot review (UI 变更时)

## 发行通道

- npm：`npx remux`（现有）
- Tauri：GitHub Releases + Homebrew
- iOS：TestFlight → App Store
- Android：Firebase App Distribution → Play Store

---

# 附录 A：事实基线来源

- [S1] `package.json` v0.2.55：当前版本号、依赖列表、scripts
- [S2] `src/backend/server-zellij.ts`：Express + ws 双通道服务器
- [S3] `src/backend/zellij-controller.ts`：Zellij CLI 封装
- [S4] `src/backend/terminal-state/tracker.ts`：xterm-headless 状态追踪
- [S5] `src/backend/auth/auth-service.ts`：Token + 密码认证
- [S6] `src/backend/providers/`：Zellij/tmux/ConPTY 后端检测
- [S7] `src/frontend/App.tsx`：React SPA 主结构
- [S8] `src/frontend/hooks/useTerminalRuntime.ts`：xterm.js 终端管理
- [S9] `src/frontend/components/InspectView.tsx`：现有 Inspect 视图
- [S10] `tui/`：Go TUI 客户端
- [S11] `docs/IOS_CLIENT_CONTRACT.md`：iOS 客户端协议约定
- [S12] `docs/SPEC.md`：当前协议规格
- [S13] `tests/`：Vitest + Playwright 测试套件
- [S14] `native/zellij-bridge/`：Rust 辅助桥接（非独立 runtime）

# 附录 B：v1.1 → v2 变更摘要

| 维度 | v1.1 | v2 | v2.1 |
|------|------|-----|------|
| 后端核心 | Rust (`remuxd` + crates) | TypeScript (server-zellij.ts) | 同 v2 |
| macOS 桌面 | SwiftUI + AppKit | Tauri 2 | 同 v2 |
| Windows 桌面 | WinUI 3 | Tauri 2 | 同 v2 |
| Linux 桌面 | GTK4 + Rust | Tauri 2 | 同 v2 |
| 协议升级 | 假设已有 domain envelope | 从简单 JSON 渐进迁移 | ✅ domain envelope 已完成 (E03) |
| Writer Lease | 单 pane 单 writer | 简化版多客户端状态透出 | ✅ Client Connection State 已完成 (E04) |
| 团队规模 | 7~12 人 | 个人开发者 | 同 v2 |
| `Scroll` → `Inspect` | 全面改名 | 部分已完成 | ✅ 术语治理完成 (E01) |
| Epic 数量 | 20 | 17 | 17（E01--E06 完成，E07--E17 待执行） |
| Checklist 项数 | 319 | 278 | 已完成 68 项，剩余 210 项 |
| 包管理器 | npm | npm | **pnpm**（已迁移） |
| TypeScript | 5.x | 5.x | **6.0**（已升级） |
| 当前版本 | v0.1.x | v0.2.55 | **v0.2.65** |
| 开源复用 | 未提及 | 未提及 | **新增原则：优先复用成熟开源代码** |
| 竞品分析 | 未做 | 未做 | **新增：cmux / Wave / Warp 竞品对标** |
