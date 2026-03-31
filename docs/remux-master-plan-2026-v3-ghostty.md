# Remux 主规划 v3.1（Ghostty-Era Post-Rewrite）

**版本**：3.1
**日期**：2026-03-31
**基线**：`dev` 分支 v0.3.0（rewrite 后）代码审计
**与旧版关系**：替代 v3.0。v3.0 是 rewrite 前写的迁移计划，其中 Phase 1（ghostty-web 前端）和 Phase 3（去 Zellij）已由 rewrite 一步完成，但同时丢失了 E01-E07 的全部已完成能力。本文档基于 rewrite 后的真实代码重新规划。

---

## 0. 本文档怎么用

1. 先读第 1-4 节，理解 rewrite 发生了什么、当前实际有什么、丢失了什么。
2. 第 5 节是架构决策——决定未来方向。
3. 第 6-7 节是里程碑和详细 checklist，按顺序执行。
4. 每个 Phase 有 Go/No-Go 门槛，通过后才进入下一阶段。

---

## 1. Rewrite 发生了什么

2026-03-31，dev 分支从 v0.2.72（TypeScript + React + Vite + Zellij + xterm.js 的完整架构）重写为 v0.3.0。重写的动机是正确的（xterm.js 渲染不稳定，ghostty-web 极其稳定），但方式是激进的——基于 ghostty-web demo 从零重建，而非渐进迁移。

### 1.1 重写达成了什么

- ghostty-web 前端渲染（稳定、truecolor、Canvas）
- 去除了 Zellij 依赖（直接 shell PTY）
- 去除了 xterm.js（完全切到 ghostty-web）
- server-side ghostty-vt WASM 追踪（tsm 模式快照）
- 多 session + 多 tab 管理
- Session 持久化（JSON 文件）
- 单文件 server.js（989 行），零构建步骤
- 简洁的 VS Code 风格 UI（sidebar + tab bar + compose bar）

### 1.2 重写丢失了什么

旧 dev 完成了 7 个 Epic（E01-E07），合计 ~17,000 行代码。以下能力全部丢失：

| 能力 | 旧 Epic | 重要性 | 恢复难度 |
|------|---------|--------|----------|
| Inspect 视图（可读终端内容） | E02 | **关键** | 中 |
| 设备信任与配对（QR、Trust Level） | E05 | 高 | 高 |
| 协议 envelope（域消息格式） | E03 | 高 | 中 |
| Client 连接状态（Observer/Active） | E04 | 中 | 中 |
| Web Push 通知 | E06 | 中 | 高 |
| 完整 React + Vite + TS 前端 | — | 中 | 高 |
| Express 模块化后端 | — | 中 | 中 |
| 双 WebSocket 通道 | — | 中 | 中 |
| Tunnel 支持（Cloudflare/DevTunnel） | — | 高 | 中 |
| 主题系统（glassmorphism、亮/暗切换） | — | 中 | 低 |
| 49 个测试文件 | — | 高 | 高 |
| Tauri 桌面壳 | E07 | 低 | 高 |
| 本地回显预测 | — | 低 | 低 |
| tmux 兼容适配器 | — | 低 | 低 |
| Gastown 集成 | — | 低 | 低 |
| 事件监听（Claude Code events） | — | 低 | 低 |

旧代码完整保存在 `archive/dev-pre-rewrite-2026-03-31` 分支，可随时参考和移植。

---

## 2. 当前真实基线（v0.3.0 代码审计）

### 2.1 架构

```
┌──────────────────────────────────────────────────┐
│                   Browser                          │
│  Inline HTML/CSS/JS + ghostty-web (Canvas)         │
│  单个 WebSocket /ws（控制 + 数据复用）              │
└──────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────┐
│            server.js (单文件 Node.js)              │
│                                                    │
│  HTTP server (http 模块, 非 Express)               │
│  WebSocket server (ws 库)                          │
│  PTY 管理 (node-pty, 直接 shell)                   │
│  VT 追踪 (ghostty-vt WASM, server-side)           │
│  Session/Tab 数据模型                               │
│  持久化 (JSON file, 8s interval)                   │
│  Token 认证 (REMUX_TOKEN env var)                  │
└──────────────────────────────────────────────────┘
```

### 2.2 文件清单

| 文件 | 行数 | 说明 |
|------|------|------|
| `server.js` | 989 | 全部后端 + 内联前端 |
| `tests/server.test.js` | 275 | 集成测试 |
| `package.json` | 36 | 3 个运行依赖 |
| `vitest.config.js` | — | 测试配置 |
| `tui/` | — | Go TUI（独立，未受影响） |

### 2.3 依赖

```json
{
  "ghostty-web": "^0.4.0",
  "node-pty": "^1.1.0",
  "ws": "^8.20.0"
}
```

### 2.4 已有能力

| 能力 | 状态 | 质量 |
|------|------|------|
| ghostty-web 终端渲染 | 工作 | 稳定 |
| server-side VT 追踪 + 快照 | 工作 | 良好（truecolor SGR） |
| 多 session 管理 | 工作 | 基础 |
| 多 tab 管理 | 工作 | 基础 |
| Tab attach/detach + VT 快照恢复 | 工作 | 良好 |
| 多客户端（min-size recalc） | 工作 | 基础 |
| Token 认证 | 工作 | 最小可用 |
| Session 持久化（scrollback） | 工作 | 基础 |
| Chrome-style tab bar | 工作 | 良好 |
| Sidebar session 列表 | 工作 | 良好 |
| 移动端 compose bar | 工作 | 基础 |
| 移动端 sidebar drawer | 工作 | 良好 |
| Shell 检测（zsh/bash） | 工作 | 良好 |

### 2.5 当前架构的优势

1. **极简**——单文件，零构建步骤，`npx remux` 即跑
2. **ghostty-web 渲染稳定**——没有旧架构的 xterm.js 问题
3. **无 Zellij 依赖**——用户不需要安装额外软件
4. **VT 快照工作**——tab 切换和重连有真实的终端状态恢复

### 2.6 当前架构的问题

1. **README 完全过时**——仍然描述 Zellij + React + xterm.js 架构
2. **CLAUDE.md 部分过时**——仍然提到 Zellij 作为默认后端
3. **无 Inspect 视图**——核心产品差异化能力丢失
4. **认证过于简单**——只有 env var token，无设备信任
5. **无 tunnel 支持**——远程访问是关键用例
6. **单文件限制**——随着功能增加，server.js 将难以维护
7. **无 TypeScript**——前后端都是纯 JS，失去类型安全
8. **测试覆盖不足**——只有 1 个测试文件
9. **前端内联在 HTML 模板中**——无法测试、无法复用组件

---

## 3. 一句话产品定义

**Remux 是一个跨端的远程终端工作空间，以 ghostty-web 为渲染引擎，通过 Web 让用户从任何设备监控和控制终端会话。**

核心三个表面不变：
- **Live**：直接终端 I/O
- **Inspect**：可读的终端内容（捕获、文本选择、搜索）
- **Control**：Session/Tab 导航与操作

---

## 4. 硬决策

### 4.1 保持 node-pty（暂不引入 Rust daemon）

v3.0 计划的 Rust daemon（portable-pty + libghostty-vt native）是正确的长期方向，但**不是当前瓶颈**。当前优先级是恢复丢失的产品能力，而非重写 PTY 层。

- node-pty 当前工作稳定
- ghostty-vt WASM 在 server-side 已经够用（快照质量良好）
- Rust daemon 推迟到 Phase 4，在产品能力恢复后再考虑

### 4.2 渐进模块化（不再次大重写）

v0.3.0 的单文件方式目前可用，但随着功能增加需要拆分。策略：

- **后端**：逐步从 server.js 抽取模块（auth、session、ws handler），转为 TypeScript
- **前端**：当 UI 复杂度需要时（Inspect、Settings、Theme），才迁移到独立前端（React/Vite 或轻量方案）
- **绝不一步到位**——每次只抽取当前 Phase 需要的部分

### 4.3 单 WebSocket 通道（暂不恢复双通道）

旧架构的 `/ws/terminal` + `/ws/control` 双通道设计是合理的（终端数据和控制消息分离），但当前单 `/ws` 通道通过 JSON/raw 区分也能工作。

- Phase 0-2 保持单通道
- Phase 3 根据实际需求决定是否拆分

### 4.4 Inspect 是第一恢复目标

Inspect（可读终端内容）是 Remux 的核心差异化——没有 Inspect，Remux 只是另一个 web terminal。ghostty-vt WASM 的快照能力已经提供了基础。

### 4.5 从旧分支移植而非重新实现

`archive/dev-pre-rewrite-2026-03-31` 包含所有旧实现。恢复能力时：

- **优先移植**旧代码的核心逻辑，适配新的单文件架构
- **不照搬**旧的模块结构（太重），只提取有价值的算法和协议设计
- **测试也移植**——旧分支有 49 个测试文件，每个恢复的能力都应带回对应测试

### 4.6 自研边界（延续 v3.0）

不自研 VT parser / screen buffer / renderer / PTY 库 / multiplexer。

---

## 5. 技术栈

| 层 | 当前 | Phase 1-2 | Phase 3+ |
|---|---|---|---|
| 后端 | 单文件 server.js (Node.js) | server.js + 抽取的模块 (.js) | TypeScript 模块 |
| 前端渲染 | ghostty-web (内联 HTML) | ghostty-web (内联 HTML) | React + Vite (待定) |
| PTY | node-pty | node-pty | node-pty (Phase 4 考虑 Rust) |
| VT 追踪 | ghostty-vt WASM | ghostty-vt WASM | ghostty-vt WASM |
| 存储 | JSON 文件 | JSON 文件 | SQLite (Phase 3+) |
| 测试 | Vitest | Vitest + Playwright | Vitest + Playwright |
| 分发 | npm (npx remux) | npm | npm |

---

## 6. 里程碑与 Epic

### Phase 0：地基修复（1 周）

**目标**：让仓库文档和元数据与 v0.3.0 实际代码一致，清理遗留碎片，扩展测试覆盖。

**Go/No-Go**：
- README 准确描述当前架构
- CLAUDE.md Zellij 相关约束更新
- 测试覆盖当前全部 WebSocket 消息类型
- `pnpm test` 通过

| Epic | 内容 |
|------|------|
| P0-A | 文档与元数据对齐 |
| P0-B | 测试补全 |
| P0-C | 清理遗留文件 |

---

### Phase 1：恢复核心产品能力（2-3 周）

**目标**：恢复 Inspect 视图和认证系统，使 Remux 重新成为有差异化的产品而非裸 web terminal。

**Go/No-Go**：
- Inspect 视图可用（文本捕获、可读展示）
- 密码认证可选启用
- Tunnel 支持至少一种提供者
- 重连后终端状态无损恢复

| Epic | 内容 |
|------|------|
| P1-A | Inspect 视图 |
| P1-B | 认证增强 |
| P1-C | Tunnel 支持 |
| P1-D | 连接可靠性 |

---

### Phase 2：UI 打磨与体验（2-3 周）

**目标**：从"能用"到"好用"。

**Go/No-Go**：
- 主题切换工作（至少暗色/亮色）
- 移动端体验流畅
- 操作响应快（无明显延迟或闪烁）
- E2E 测试覆盖核心流程

| Epic | 内容 |
|------|------|
| P2-A | 主题与外观 |
| P2-B | 移动端优化 |
| P2-C | 交互改进 |
| P2-D | E2E 测试 |

---

### Phase 3：架构进化（3-4 周）

**目标**：当 server.js 和内联前端无法承载新增功能时，做一次有序的模块化。

**Go/No-Go**：
- 后端 TypeScript 化完成
- 前端独立（React/Vite 或等效方案）
- 协议有版本和 envelope
- 测试覆盖率 ≥ 旧分支水平

| Epic | 内容 |
|------|------|
| P3-A | 后端模块化 + TypeScript |
| P3-B | 前端独立化 |
| P3-C | 协议演进 |
| P3-D | Client 连接状态 |

---

### Phase 4：高级运行时（4-6 周）

**目标**：在稳定的模块化架构上，实现持久化和更强的多客户端能力。

| Epic | 内容 |
|------|------|
| P4-A | Rust PTY daemon（可选） |
| P4-B | Session 持久化增强 |
| P4-C | 设备信任与配对 |
| P4-D | Web Push 通知 |

---

### Phase 5：AI Workspace（6+ 周）

**目标**：在稳定的终端基础上恢复 AI-native workspace 主线。

| Epic | 内容 |
|------|------|
| P5-A | Topics / Runs / Approvals |
| P5-B | Search / Memory / Handoff |
| P5-C | Shell Integration |

---

## 7. 详细 Checklist

---

### P0-A：文档与元数据对齐（5 项）

> 目标：仓库文档准确反映 v0.3.0 现实，消除对使用者的误导。

* **P0-A-01 重写 README.md**。删除 Zellij、xterm.js、React、Express、双 WebSocket 通道等过时内容。准确描述：ghostty-web 渲染、node-pty 直接 shell、单 WebSocket、token 认证、session/tab 管理。更新 Quick Start（不再需要 Zellij）、CLI 参数、Tech Stack。验收：README 每一句话与 server.js 实际代码一致。

* **P0-A-02 更新 CLAUDE.md**。修改 Zellij 相关约束：当前后端是 node-pty 直接 shell + ghostty-web，不是 Zellij。更新常用命令（当前只有 `pnpm test`，无 `dev:backend` 等）。更新安全要点（当前是单 WebSocket 通道）。验收：CLAUDE.md 不包含与 v0.3.0 矛盾的约束。

* **P0-A-03 更新 package.json scripts**。当前只有 `start`、`dev`、`test`。添加缺失的 scripts 或删除 CLAUDE.md 中提到但不存在的 scripts。验收：`pnpm run` 列出的所有 script 可执行。

* **P0-A-04 标注旧文档为归档**。`docs/multi-session-plan.md`（基于 Zellij）、`docs/ghostty-web-migration-status.md`（基于旧 React 架构）——在文件头部加 `> [!WARNING] ARCHIVED` 标注。验收：不会被误当成当前计划。

* **P0-A-05 清理根目录临时文件**。`live-delete-check.yml`、`verify-*.yml`、`tmp-session-snapshot.yml` 等调试产物不应在仓库跟踪中。验收：`git status` 无多余 untracked 文件。

---

### P0-B：测试补全（4 项）

> 目标：当前 server.js 的所有功能路径都有测试覆盖。

* **P0-B-01 补测 session CRUD**。新建 session、删除 session、删除最后一个 session 的边界行为。验收：覆盖 `createSession`、`deleteSession`。

* **P0-B-02 补测 tab 生命周期**。新建 tab、关闭 tab、关闭 active tab 切换行为、shell 退出后的 ended 状态。验收：覆盖 `createTab`、`close_tab` 消息。

* **P0-B-03 补测多客户端行为**。两个 WebSocket 连接同时 attach 同一 tab 时的 min-size recalc；一个断开后另一个不受影响。验收：覆盖 `recalcTabSize`、`detachFromTab`。

* **P0-B-04 补测 VT 快照恢复**。attach 到有历史输出的 tab 时，收到 VT 快照（包含 ESC 序列）。验收：`snapshot()` 输出包含 `\x1b[` 序列和正确的光标定位。

---

### P0-C：清理遗留文件（2 项）

* **P0-C-01 清理 `.playwright-cli/` 日志**。仅保留配置文件，删除历史 console log 和 snapshot yaml。验收：目录内无 console-*.log。

* **P0-C-02 清理 native/android/**。如果不再使用，gitignore 或删除。验收：`git status` 干净。

---

### P1-A：Inspect 视图（5 项）

> 目标：恢复 Remux 的核心差异化能力——可读的终端内容捕获。利用现有 ghostty-vt WASM 快照。

* **P1-A-01 定义 Inspect 数据格式**。Inspect 是 VT 快照的文本化展示：纯文本（去 ESC 序列）+ 元数据（时间戳、session/tab 信息、行列数）。参考旧分支 `feat/inspect-e02` 的 InspectService 设计，但适配当前架构。验收：有清晰的 Inspect 数据 schema。

* **P1-A-02 后端 Inspect 消息**。在 WebSocket 消息处理中添加 `{ type: "inspect" }` 请求。后端调用 tab 的 `vt.snapshot()` 生成快照，同时生成纯文本版本（strip ANSI），返回 `{ type: "inspect_result", text, ansi, meta }`。验收：WebSocket 可请求并接收 Inspect 数据。

* **P1-A-03 前端 Inspect 视图**。在内联 HTML 中添加 Inspect 面板（替代终端区域显示），展示纯文本终端内容。支持文本选择、复制。有 Live/Inspect 切换按钮。验收：用户可以在 Live 和 Inspect 之间切换，Inspect 文本可选择复制。

* **P1-A-04 Inspect 自动刷新**。Inspect 视图打开时，定期（2-5s）请求最新快照。切回 Live 时停止请求。验收：Inspect 内容随终端变化自动更新。

* **P1-A-05 Inspect 单测**。测试纯文本提取（strip ANSI）、Inspect 请求-响应流程。验收：`pnpm test` 覆盖 Inspect 路径。

---

### P1-B：认证增强（4 项）

> 目标：从单纯 env var token 升级到可用的认证系统。参考旧分支 `feat/e05-device-trust-pairing` 但做简化版。

* **P1-B-01 密码认证**。支持 `--password` 参数或 `REMUX_PASSWORD` 环境变量。首次访问时显示密码输入页面（替代 403 纯文本）。验证通过后设置 session cookie 或 URL token。验收：密码保护可开启/关闭，错误密码显示重试，正确密码进入主页。

* **P1-B-02 自动生成 token**。启动时如果没有设置 `REMUX_TOKEN`，自动生成随机 token 并打印到控制台（含 URL）。验收：`npx remux` 启动后打印可直接点击的 URL。

* **P1-B-03 QR 码输出**。启动时在终端输出访问 URL 的 QR 码（使用 `qrcode-terminal` 或内联生成），方便手机扫码。验收：终端显示可扫描的 QR 码。

* **P1-B-04 认证测试**。测试无 token 拒绝、有 token 接受、密码流程。验收：`pnpm test` 通过。

---

### P1-C：Tunnel 支持（3 项）

> 目标：让 Remux 可以从外部网络访问。参考旧分支的 tunnel 实现。

* **P1-C-01 Cloudflare Tunnel 检测与启动**。检测 `cloudflared` 是否可用，自动启动 quick tunnel（`cloudflared tunnel --url localhost:PORT`）。解析输出获取公开 URL。验收：有 cloudflared 时自动获得公开 HTTPS URL。

* **P1-C-02 Tunnel URL 展示**。启动信息中显示 tunnel URL + 对应 QR 码。验收：控制台打印 tunnel URL。

* **P1-C-03 Tunnel 开关**。`--tunnel` / `--no-tunnel` CLI 参数控制。默认：有 cloudflared 时自动开启。验收：可控。

---

### P1-D：连接可靠性（3 项）

> 目标：断线重连后的体验顺滑。

* **P1-D-01 客户端自动重连**。当前已有 2s 重连（`ws.onclose`），增加指数退避（2s → 4s → 8s → 16s → 30s max）。重连成功后恢复到之前的 session/tab。验收：网络断开恢复后自动回到之前状态。

* **P1-D-02 心跳与超时**。服务端每 30s 发 ping，客户端超时 45s 未收到则重连。验收：空闲连接不会被中间件/代理断开。

* **P1-D-03 连接状态指示改进**。当前 sidebar footer 有状态点（connecting/connected/disconnected），增加重连倒计时显示。验收：用户知道何时会重连。

---

### P2-A：主题与外观（4 项）

> 目标：从硬编码暗色主题升级到可切换的主题系统。

* **P2-A-01 定义主题 schema**。`{ background, foreground, cursor, selection, ansi: [0..15], ui: { sidebar, tabbar, border } }`。内置 2 个主题：Dark（当前）、Light。验收：主题 schema 文档化。

* **P2-A-02 主题切换 UI**。在 sidebar footer 或 tab bar 添加主题切换按钮。切换时同时更新 CSS 变量和 ghostty-web Terminal 的 theme 配置。验收：一键切换暗色/亮色。

* **P2-A-03 ghostty-web 主题映射**。Remux 主题 token → ghostty-web Terminal theme option。确保终端区域和 UI 区域颜色协调。验收：终端颜色随主题切换同步变化。

* **P2-A-04 主题持久化**。选择保存到 localStorage。验收：刷新页面后主题保持。

---

### P2-B：移动端优化（3 项）

* **P2-B-01 虚拟键盘适配**。iOS/Android 键盘弹出时正确收缩终端区域。当前用 visualViewport 处理，验证在 iOS Safari 和 Android Chrome 上的表现。验收：键盘弹出/收起无布局断裂。

* **P2-B-02 Compose bar 增强**。添加更多快捷键（Ctrl+C、Ctrl+D、Ctrl+Z、PgUp、PgDn、Home、End）。长按 Ctrl 按钮进入持续模式。验收：常用操作可在移动端快速触发。

* **P2-B-03 触摸手势**。左滑打开 sidebar、pinch-to-zoom 终端字号（如 ghostty-web 支持）。验收：基础手势可用。

---

### P2-C：交互改进（4 项）

* **P2-C-01 Tab 重命名**。双击 tab title 进入编辑模式。通过控制消息发送到后端保存。验收：可重命名 tab。

* **P2-C-02 Tab 拖拽排序**。拖拽 tab 改变顺序。验收：tab 顺序可调整。

* **P2-C-03 复制/粘贴改进**。Ctrl+Shift+C / Ctrl+Shift+V（桌面）、长按选择（移动端）。检查 ghostty-web 原生支持情况。验收：桌面和移动端各有可用的复制粘贴路径。

* **P2-C-04 终端搜索**。Ctrl+F 搜索当前终端内容（利用 VT 快照的文本版本）。高亮匹配。验收：基础搜索可用。

---

### P2-D：E2E 测试（3 项）

> 目标：用 Playwright 覆盖核心用户流程。

* **P2-D-01 E2E 基础设施**。Playwright 配置、test fixture（自动启动 server）、截图对比基线。验收：`pnpm run test:e2e` 可执行。

* **P2-D-02 核心流程 E2E**。打开页面 → 终端可见 → 输入命令 → 看到输出 → 创建新 tab → 切换 tab → 创建 session → 切换 session → 删除 session。验收：核心 CRUD 流程自动化。

* **P2-D-03 Inspect E2E**。切换到 Inspect → 看到终端文本 → 文本可选择 → 切回 Live。验收：Inspect 流程自动化。

---

### P3-A：后端模块化 + TypeScript（5 项）

> 目标：server.js 拆分为可维护的 TypeScript 模块。保持单入口 `server.ts` → 编译为 `server.js`。

* **P3-A-01 配置 TypeScript 构建**。`tsconfig.backend.json`、esbuild 或 tsc 编译为单文件 `server.js`。验收：`pnpm run build` 生成与当前等价的 server.js。

* **P3-A-02 抽取 session 管理模块**。`src/session.ts`：Session/Tab 模型、CRUD、RingBuffer、attach/detach。验收：单测覆盖。

* **P3-A-03 抽取 VT 追踪模块**。`src/vt-tracker.ts`：ghostty-vt WASM 初始化、createVtTerminal、snapshot。验收：单测覆盖。

* **P3-A-04 抽取认证模块**。`src/auth.ts`：token 验证、密码验证、session cookie。验收：单测覆盖。

* **P3-A-05 抽取 WebSocket handler**。`src/ws-handler.ts`：消息路由、控制消息处理、终端 I/O 转发。验收：集成测试通过。

---

### P3-B：前端独立化（4 项）

> 目标：当内联 HTML 无法承载 Inspect + Settings + Theme + 复杂交互时，迁移到独立前端。

* **P3-B-01 评估迁移时机**。如果 Phase 1-2 的 Inspect/Theme/Search 在内联 HTML 中实现良好且可维护，推迟此步骤。如果内联模板已超过 ~500 行 JS 或难以维护，则执行。验收：有明确的 Go/No-Go 决定。

* **P3-B-02 React + Vite 脚手架**。`src/frontend/`，开发时 Vite dev server + HMR，构建时输出到 `dist/`。后端 serve `dist/` 下的静态文件。验收：`pnpm run dev` 启动前后端。

* **P3-B-03 迁移现有 UI**。将内联 HTML 中的 sidebar、tab bar、terminal container、compose bar、Inspect 拆为 React 组件。验收：功能不回退。

* **P3-B-04 ghostty-web React 封装**。`<GhosttyTerminal>` 组件，处理 lifecycle、resize、theme。参考旧分支的 terminal adapter 设计但简化。验收：终端组件可复用。

---

### P3-C：协议演进（3 项）

> 目标：为多客户端、版本兼容打基础。参考旧分支 `feat/e03-protocol-upgrade` 的 envelope 设计。

* **P3-C-01 消息 envelope**。所有 JSON 消息包裹在 `{ v: 1, domain: "control"|"inspect"|"session", type: "...", payload: {...} }` 格式中。兼容当前裸消息（v: 0 或无 v 字段）。验收：旧客户端仍可工作。

* **P3-C-02 消息类型注册**。TypeScript 中定义所有消息类型的 discriminated union，消除 `try { JSON.parse } catch` 模式。验收：类型安全的消息路由。

* **P3-C-03 双通道评估**。评估是否需要拆分为 `/ws/terminal`（二进制 PTY 数据）+ `/ws/control`（JSON 控制消息）。如果当前单通道的 JSON 检测（`msg.startsWith("{")`) 成为瓶颈或错误源，则拆分。验收：有明确决定。

---

### P3-D：Client 连接状态（3 项）

> 目标：恢复多客户端感知。参考旧分支 `feat/e04-client-connection-state`。

* **P3-D-01 Client ID 与状态**。每个 WebSocket 连接分配 clientId，追踪 active/observer 状态。Active client 可输入，observer 只读。验收：两个客户端 attach 同一 tab，第二个默认 observer。

* **P3-D-02 Client 列表广播**。Inspect/Control 可以看到当前有哪些客户端连接。验收：前端显示连接客户端数量。

* **P3-D-03 主动权转交**。Observer 可请求成为 active，active 可释放。验收：两个浏览器可以交替控制。

---

### P4-A：Rust PTY Daemon（可选，6 项）

> 目标：如果 node-pty 的限制成为实际问题（原生 addon 编译、Windows 兼容、进程生命周期），用 Rust daemon 替代。

**评估条件**（只有满足以下至少一项才启动）：
- node-pty prebuilds 在目标平台持续失败
- 需要 daemon 进程独立于 Node.js 的生命周期（session 持久化需求）
- libghostty-vt native FFI 比 WASM 显著提升性能

* **P4-A-01 – P4-A-06**：与 v3.0 的 P2-A 相同（Rust crate 骨架、portable-pty、IPC 协议、stdio/socket 模式、进程管理、Node.js 对接），此处不重复。

---

### P4-B：Session 持久化增强（3 项）

> 目标：Session 在 server 重启后完整恢复（不仅是 scrollback 文本，还包括运行中的进程状态）。

* **P4-B-01 Daemon 独立生命周期**。如果走 Rust daemon 路径：daemon 进程不随 Node.js 退出。如果保持 node-pty：考虑 session checkpoint 机制（类似 tmux resurrect）。验收：重启 Node.js 后 session 可恢复。

* **P4-B-02 Scrollback 持久化改进**。当前 JSON 文件保存 scrollback 文本（截断 200KB）。改用 SQLite WAL 存储完整 scrollback + 结构化元数据。验收：重启后 scrollback 完整。

* **P4-B-03 Reattach 流程**。Server 重启后，检测已有 daemon/session 信息，自动恢复。客户端重连后看到之前的终端内容。验收：无感知重启。

---

### P4-C：设备信任与配对（4 项）

> 目标：恢复完整的设备管理能力。参考旧分支 `feat/e05-device-trust-pairing`。

* **P4-C-01 设备注册**。首次连接的浏览器注册为设备（device fingerprint + user-assigned name）。验收：设备列表可见。

* **P4-C-02 信任级别**。Trusted / Untrusted / Blocked。Untrusted 设备只读，Trusted 可控制。验收：权限分级生效。

* **P4-C-03 QR 配对**。Trusted 设备可以生成一次性配对 QR 码，新设备扫码后自动获得 Trusted 状态。验收：QR 配对流程端到端工作。

* **P4-C-04 设备撤销**。可以从任意 Trusted 设备撤销其他设备的信任。验收：撤销后该设备降级为 Untrusted。

---

### P4-D：Web Push 通知（3 项）

> 目标：恢复终端事件的推送通知。参考旧分支 `feat/e06-web-push-complete`。

* **P4-D-01 VAPID 密钥与订阅**。服务端生成 VAPID 密钥，客户端请求 Push 订阅并持久化。验收：订阅注册成功。

* **P4-D-02 通知触发**。shell 退出、长时间无活动后有输出等事件触发推送。验收：手机收到通知。

* **P4-D-03 通知设置 UI**。前端设置面板控制通知开关和触发条件。验收：可配置。

---

### P5-A：Topics / Runs / Approvals（6 项）

与 v3.0 相同，不重复。核心是将终端活动组织为可搜索、可审批的结构化对象。

---

### P5-B：Search / Memory / Handoff（5 项）

与 v3.0 相同，不重复。核心是统一 FTS 搜索和 handoff bundle。

---

### P5-C：Shell Integration（4 项）

与 v3.0 相同，不重复。核心是命令边界检测和 command card 自动生成。

---

## 8. 工程红线

1. **禁止再次大重写**。从 v0.3.0 渐进进化，不再丢弃已有能力。
2. **每个 PR 合并前**：`pnpm test && pnpm run build`（有 build script 后）。
3. **合并到 dev 前必须跑 e2e**（有 e2e 后）。
4. **恢复能力时必须带回对应测试**。不允许恢复功能但没有测试。
5. **旧分支是参考源**。`archive/dev-pre-rewrite-2026-03-31` 是移植来源，不是合并目标。
6. **安全要点**：PTY 命令使用参数数组；认证改动需审计；token 不写入日志。
7. **单文件期间（Phase 0-2）**：server.js 变更要谨慎，每次改动控制在可 review 的范围内。

---

## 9. 与 v3.0 的对照

| v3.0 计划 | 实际发生 | v3.1 调整 |
|-----------|---------|----------|
| Phase 1: ghostty-web 渐进迁移 | rewrite 一步完成 | 已完成，不再需要 |
| Phase 2: Rust PTY daemon | 未开始 | 推迟到 Phase 4（可选） |
| Phase 3: 去 Zellij 化 | rewrite 一步完成 | 已完成，不再需要 |
| Phase 4: session 管理 | 基础版已有 | 增强版在 Phase 4 |
| Phase 5: AI workspace | 未开始 | 保持在 Phase 5 |
| Terminal Adapter 抽象 | rewrite 丢弃 | Phase 3-B 如需要时恢复 |
| 旧 E01-E07 能力 | 全部丢失 | Phase 1-4 逐步恢复 |

---

## 10. 研究依据

### ghostty-web 现状（v0.4.0）

- 在当前 server.js 中验证：渲染稳定、truecolor 工作、Canvas 性能好
- server-side WASM 快照可用（viewport cells → VT 序列）
- FitAddon + observeResize 工作
- 已知限制：搜索、选择等 addon 生态不如 xterm.js 丰富

### node-pty 现状

- 当前工作稳定
- macOS arm64 prebuilds 可用
- 已知问题：Windows 需要 VS Build Tools，Linux 需要编译工具链
- 如果 prebuilds 覆盖不足，考虑 Rust daemon 路径

### 旧分支代码质量

`archive/dev-pre-rewrite-2026-03-31` 包含 ~17,000 行已测试的 TypeScript 代码。关键可移植模块：
- `src/backend/auth/` — 完整的认证系统
- `src/backend/server-zellij.ts` — WebSocket 消息路由模式（去掉 Zellij 部分后仍有参考价值）
- `src/backend/protocol/` — envelope 设计
- `src/frontend/hooks/` — state 管理模式
- `tests/` — 49 个测试文件的测试策略和 fixture
