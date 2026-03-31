> [!WARNING]
> **ARCHIVED** — This status report describes the ghostty-web migration within the old
> React + Vite + TypeScript architecture (v0.2.x). The v0.3.0 rewrite rebuilt from scratch
> on ghostty-web. Kept for historical reference only.

# ghostty-web 迁移状态报告

**日期**：2026-03-31
**分支**：dev (commit f953519)
**状态**：Phase 1 代码完成，渲染问题待修复

---

## 已完成

### 代码变更（已合并到 dev 并 push）

1. **Terminal Adapter 抽象层**
   - `src/frontend/terminal/terminal-adapter.ts` — TerminalCore 接口 + factory
   - `src/frontend/terminal/ghostty-adapter.ts` — ghostty-web 实现
   - `src/frontend/terminal/xterm-adapter.ts` — xterm.js compat 实现
   - 切换方式：URL `?terminal=xterm` / localStorage `terminalCore` / 默认 ghostty

2. **useTerminalRuntime 重构**
   - 移除 `@xterm/*` 直接 import，改用 `createTerminalCore()` factory
   - 异步初始化（async IIFE + cancelled flag）
   - pre-init 写入队列（解决 WASM 加载期间数据丢失）
   - 公开 API 不变，App.tsx 和所有消费者零改动

3. **构建管线**
   - `ghostty-web` v0.4.0 已加入依赖
   - `build:frontend` 脚本自动复制 `ghostty-vt.wasm` 到 dist
   - Vite 代码分割：ghostty/xterm 按需加载
   - `terminal-renderer.ts` 已删除（WebGL 逻辑移入 xterm-adapter）

4. **CSS**
   - 添加 `.terminal-host canvas` 规则
   - 保留 `.xterm` 选择器用于 compat

5. **测试**
   - 11 个新测试（adapter factory 6 + ghostty serialize 5）
   - typecheck / test / build 全部通过
   - e2e: 4 个失败均为 dev 已有问题（非迁移引入）

6. **部署**
   - runtime-dev 已更新到最新 commit
   - WASM 文件正确 serve（`/ghostty-vt.wasm` 返回 application/wasm 423KB）
   - ghostty-web DOM 确认加载（canvas + textarea 存在）

### 部署方式备忘

```bash
# 更新 runtime-dev 并重启
cd /Users/wangyaoshen/.remux/runtime-worktrees/runtime-dev
git fetch origin dev && git checkout --detach origin/dev
pnpm install --frozen-lockfile && pnpm run build
launchctl kickstart -k gui/501/com.remux.dev
```

---

## 待修复：Canvas 渲染空白

### 现象

- ghostty-web DOM 正确创建（canvas 1008x675 + textarea）
- WASM 加载成功
- WebSocket 连接正常（侧边栏显示 sessions）
- **但 canvas 内容为纯白/空白**

### 可能原因（按概率排序）

1. **主题颜色问题**：ghostty-web 的 CanvasRenderer 可能不接受 Remux 的 `{ background, foreground, cursor }` 三键对象。ghostty-web 的 ITheme 支持 16 色 ANSI + selection，可能需要更完整的主题配置才能正确渲染。

2. **首次渲染未触发**：ghostty-web 的 CanvasRenderer 使用 dirty-row 优化，`open()` 后可能需要显式 `refresh()` 或 `resize()` 来触发首次全量渲染。

3. **write() 时序**：虽然已加 pre-init 队列，但 Zellij 的初始输出可能在 WebSocket auth 握手期间就发出，pre-init 队列可能没有捕获到所有初始数据。

4. **FitAddon 兼容性**：ghostty-web 的 FitAddon 来自自己的包（不是 @xterm/addon-fit），`fit()` 可能需要 terminal 已 `open()` 且 container 可见才能工作。

### 下一步调试方向

```bash
# 1. 用 xterm fallback 确认基础功能正常
# 浏览器打开: https://remux-dev.yaoshen.wang/?token=remux-dev-token&terminal=xterm

# 2. 检查浏览器控制台是否有 ghostty-web 错误
# 打开 DevTools Console 查看

# 3. 在 ghostty-web adapter 的 createGhosttyCore 中加 console.log
# 确认 init() / new Terminal() / open() / write() 每步是否成功

# 4. 检查主题格式
# ghostty-web 可能需要完整 16 色配置而非仅 3 键

# 5. 在 open() 后手动调用 terminal.refresh() 或 fitAddon.fit()
```

---

## 文件清单

| 文件 | 状态 |
|------|------|
| `src/frontend/terminal/terminal-adapter.ts` | 新建 ✅ |
| `src/frontend/terminal/ghostty-adapter.ts` | 新建 ✅ |
| `src/frontend/terminal/xterm-adapter.ts` | 新建 ✅ |
| `src/frontend/hooks/useTerminalRuntime.ts` | 重构 ✅ |
| `src/frontend/styles/app.css` | 添加 canvas CSS ✅ |
| `src/frontend/terminal-renderer.ts` | 已删除 ✅ |
| `package.json` | 添加 ghostty-web + WASM 复制 ✅ |
| `tests/frontend/terminal-adapter.test.ts` | 新建 ✅ |
| `tests/frontend/terminal-adapter-ghostty.test.ts` | 新建 ✅ |
| `docs/remux-master-plan-2026-v3-ghostty.md` | 新建 ✅ |

---

## 架构总结

```
浏览器
  └─ Remux React UI (不变)
      └─ useTerminalRuntime (重构: adapter factory)
          ├─ ghostty-web adapter (默认)
          │   └─ await init() → new Terminal() → FitAddon → open(container)
          └─ xterm adapter (fallback: ?terminal=xterm)
              └─ new Terminal() → FitAddon + SerializeAddon + WebglAddon

Node.js 后端 (不变)
  └─ node-pty → Zellij attach → WebSocket → 浏览器
```
