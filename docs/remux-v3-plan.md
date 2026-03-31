# Remux v3 重建规划

**基线**：`server.js` — 纯 ghostty-web demo（2026-03-31 d1f0742）
**目标**：从已验证能跑的 ghostty-web 终端起步，逐步加回 Remux 产品能力
**旧代码**：`archive/dev-pre-rewrite-2026-03-31` 分支，可按需 cherry-pick

---

## 当前现状

| 层 | 技术 | 状态 |
|---|---|---|
| 服务端 | Node.js + node-pty + ws + 内嵌 HTML | ✅ 可用 |
| 终端渲染 | ghostty-web 0.4.0 (WASM) | ✅ 渲染+输入+resize 全通 |
| 前端框架 | 无（原生 HTML + JS module） | 极简，待扩展 |
| Session 管理 | 无（每 WebSocket 独立 PTY） | 待建 |
| 认证 | 无 | 待加 |
| 隧道 | 无 | 待加 |

---

## Phase 1：移动端适配 + Compose Bar

**目标**：手机/平板能正常使用终端 — 虚拟键盘弹出时布局正确，ComposeBar 提供特殊键输入。

### 1.1 移动端布局适配

- `visualViewport` API 检测键盘弹出/收起
- 终端容器高度动态调整（键盘弹出时缩小，收起时恢复）
- `fitAddon.fit()` 在每次高度变化后重算
- touch-action: pan-y 防止终端区域触摸手势冲突
- 禁止 iOS 弹性滚动（overscroll-behavior）

### 1.2 ComposeBar（虚拟键盘增强栏）

在终端区域底部添加一栏快捷键按钮，解决移动端虚拟键盘缺少的按键：

```
[ Esc ] [ Tab ] [ Ctrl ] [ ↑ ] [ ↓ ] [ ← ] [ → ] [ | ]
```

实现方式：
- 纯 HTML/CSS，不引入 React
- 点击按钮 → 通过 `term.input(escapeSequence)` 或直接 `ws.send(data)` 发送对应序列
- Ctrl 是 modifier 状态键（点击后下一次输入附加 Ctrl）
- 横屏时自动隐藏（桌面端也隐藏）
- 按钮区域不抢终端 focus

### 1.3 触摸适配

- 终端区域单击 → focus（弹出键盘）
- 长按 → 选择文本 → 复制（利用 ghostty-web 内置 SelectionManager）
- 双指缩放 → 禁止（防止页面缩放）

### Go/No-Go

- [ ] 手机竖屏：键盘弹出后终端完整可见，可输入命令
- [ ] ComposeBar：Esc、Tab、Ctrl+C、方向键 全部可用
- [ ] 桌面浏览器：ComposeBar 不出现，不干扰

---

## Phase 2：Session 管理（参考 tsm）

**目标**：支持多 session 创建/切换/持久化，多客户端可 attach 同一 session。

### 核心设计（从 tsm 学到的）

tsm 的核心洞察：**session = 独立 PTY 进程 + 状态追踪 + 多客户端广播**。

tsm 用 Go + Unix socket + per-session daemon 进程实现。Remux 适配为 Node.js + WebSocket + 单进程多 session：

```
┌─────────────────────────────────────────────┐
│           Remux Server (Node.js)            │
│                                             │
│  SessionManager                             │
│  ├─ session "main"                          │
│  │  ├─ PTY process (node-pty → $SHELL)      │
│  │  ├─ scrollback RingBuffer (10MB)         │
│  │  └─ clients: [ws1, ws2]                  │
│  ├─ session "dev"                           │
│  │  ├─ PTY process                          │
│  │  ├─ scrollback RingBuffer                │
│  │  └─ clients: [ws3]                       │
│  └─ session "logs"                          │
│     ├─ PTY process                          │
│     ├─ scrollback RingBuffer                │
│     └─ clients: []  (detached, still alive) │
│                                             │
│  HTTP: serves HTML + ghostty-web assets     │
│  WS /ws: terminal data (binary frames)      │
│  WS /control: session CRUD + tab mgmt       │
└─────────────────────────────────────────────┘
```

### 2.1 SessionManager

```typescript
interface Session {
  name: string;
  pty: IPty;
  scrollback: RingBuffer;      // 10MB, tsm pattern
  clients: Set<WebSocket>;     // attached clients
  cols: number;
  rows: number;
  createdAt: Date;
  cwd: string;
}

class SessionManager {
  create(name: string, opts?: { cols, rows, cwd, cmd }): Session
  get(name: string): Session | undefined
  delete(name: string): void
  list(): SessionInfo[]
  attach(name: string, ws: WebSocket, cols: number, rows: number): void
  detach(ws: WebSocket): void
}
```

关键行为（参考 tsm）：
- **attach 时发送 scrollback** — 新客户端连接后，先推送 scrollback 最近内容（tsm 用 ghostty-vt Snapshot，Remux 先用 scrollback 原始数据，后期升级为 VT snapshot）
- **PTY 输出广播** — `pty.onData` 同时写入 scrollback + broadcast 给所有 attached clients
- **多客户端 resize** — 取所有 attached 客户端的最小 cols/rows（tsm 做法）
- **session 独立于客户端** — 所有客户端断开后 PTY 继续运行（detached state）
- **shell 退出 → session 结束** — PTY exit 时 session 标记为 ended，通知所有客户端

### 2.2 IPC 协议（参考 tsm 二进制帧）

tsm 用 5 字节头：`[Tag:1][Len:4LE][Payload]`。Remux 通过 WebSocket，可用类似结构：

| Tag | Name | 方向 | 用途 |
|-----|------|------|------|
| 0 | Data | 双向 | 终端 I/O |
| 1 | Resize | client→server | cols + rows |
| 2 | Attach | client→server | session name + initial size |
| 3 | Detach | client→server | 断开当前 session |
| 4 | SessionList | server→client | 所有 session 信息 |
| 5 | SessionCreated | server→client | 新建确认 |
| 6 | SessionEnded | server→client | session 退出通知 |

初期可继续用 JSON 消息（兼容 demo 的 resize JSON），后期优化为二进制帧。

### 2.3 前端 Session UI

在 title-bar 区域扩展：
- Session 下拉列表（当前 session 名 + 切换）
- `+` 按钮创建新 session
- Session 状态指示（active / detached / ended）
- 从旧代码 `archive/` 分支的 sidebar 设计中 cherry-pick UI 思路

### 2.4 Tab 支持（轻量级）

tab ≠ Zellij tab。在 Remux 中：
- **tab = 同时 attach 到多个 session 的快捷入口**
- 顶部 tab bar 显示已 attach 的 session
- 点击 tab 切换当前活跃 session
- 关闭 tab ≠ 终止 session（只是 detach）

### Go/No-Go

- [ ] 创建 session、切换 session、删除 session
- [ ] 多客户端 attach 同一 session，数据同步
- [ ] session 在所有客户端断开后继续运行
- [ ] 重新 attach 时恢复 scrollback 内容
- [ ] Tab bar 切换正常

---

## Phase 3（后续）：认证 + 隧道

从 `archive/` 分支 cherry-pick：
- `auth-service.ts` — token/password 认证
- `tunnels/` — cloudflared / devtunnel
- 前端 password overlay

## Phase 4（后续）：Inspect + 高级功能

- 服务端 VT 状态追踪（用 scrollback + 后期 ghostty-vt WASM）
- Inspect 视图（终端内容搜索、历史回放）
- 通知（bell / exit 事件推送）

## Phase 5（后续）：Rust PTY Daemon

从 tsm 学到的最终形态：
- Rust daemon 替代 node-pty
- libghostty-vt native 做 VT 状态追踪 + Snapshot
- 完整的 attach/detach 恢复体验

---

## 技术决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 终端渲染 | ghostty-web (WASM) | 已验证稳定，xterm.js 弃用 |
| PTY | node-pty 直接 spawn shell | 简单直接，去除 Zellij |
| 前端框架 | 原生 HTML/JS → 按需引入 | 从 demo 起步，避免过早复杂化 |
| Session 模型 | 单进程 SessionManager | Node.js 适合，不需要 tsm 的 per-process daemon |
| IPC | WebSocket + JSON（初期）| 先跑通，后期可优化为二进制帧 |
| Scrollback | 内存 RingBuffer | tsm 验证的模式，简单高效 |
| VT 状态 | scrollback 原始数据（初期）| 后期升级为 ghostty-vt Snapshot |
| Session 持久化 | PTY 进程存活即持久 | 与 tsm 同理，进程退出 = session 结束 |
