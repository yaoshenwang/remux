# AGENTS.md

本文件为代理在本仓库工作时的指令手册。所有规则必须严格遵守。

## 项目概述

Remux 是一个基于 Web 的远程 tmux / zellij 客户端，通过 cloudflared 隧道让用户从手机、平板或其他电脑监控和控制终端会话。以 npm 包分发（`npx remux`）。

- **GitHub**: github.com/yaoshenwang/remux
- **许可证**: MIT

## 沟通语言

所有与用户的交流必须使用中文。代码注释和 commit message 使用英文。

## 分支纪律（强制）

- 维护 `main`（生产）和 `dev`（开发）两个长期分支
- **禁止直接在 `main` 或 `dev` 上修改代码**
- 所有开发工作从 `dev` 创建 feature 分支，使用 `git worktree` 隔离开发
- 完成后合并回 `dev`，`dev` 定期合并到 `main` 发布
- **禁止直接 push 到 main**

### 分支命名规范

| 类型 | 格式 | 示例 |
|------|------|------|
| 功能 | `feat/<简短描述>` | `feat/websocket-reconnect` |
| 修复 | `fix/<简短描述>` | `fix/resize-debounce` |
| 维护 | `chore/<简短描述>` | `chore/remove-unused-deps` |
| 更新 | `update/<简短描述>` | `update/bump-dependencies` |

### Worktree 路径

`.worktrees/<分支短名>`，例如 `.worktrees/websocket-reconnect`

### 版本管理

- 遵循 SemVer。AI 仅可自行 bump patch 版本
- Minor/Major 版本变更需用户明确批准
- 每次 feature 合并到 `dev` 后 bump patch

### Runtime V2 约束（强制）

- `runtime-v2` 是当前公开产品路径，**禁止**为了 session 持久化问题把 public `main` / `dev` 服务回退到 legacy `tmux` / `zellij` / `conpty` backend
- 持久化问题必须在 `runtime-v2` 架构内解决，可以借鉴 tmux / zellij 的 server-client、daemon、socket、state store 原理，但不能把公开运行路径切回 legacy backend
- 对 `https://remux.yaoshen.wang` 和 `https://remux-dev.yaoshen.wang` 的修复，目标是两者共享同一套机器级 runtime-v2 会话真相，而不是各自维护独立易失 workspace

## 常用命令

```bash
npm run dev
npm run dev:backend
npm run dev:frontend
npm run build
npm run typecheck
npm test
npm run test:watch
npm run test:smoke
npm run test:e2e
```

### 构建检查（强制）

合并到 `dev` 之前必须通过：

```bash
npm run typecheck && npm test && npm run build
```

### 宽度专项验收（强制）

每次 `dev` 分支提交后的实际测试里，必须执行一次真实网页宽度专项检查，且不得用 fake harness 截图代替：

1. 打开实际可访问的网页环境，进入真实终端视图，至少覆盖一个桌面宽窗口场景。
2. 检查首屏恢复内容和后续 live output 的展示宽度，确认终端内容宽度与可见 terminal 容器宽度一致。
3. 禁止出现以下任一情况：终端内容只占一半宽度、长行在半宽处提前折行、首屏恢复内容与当前窗口宽度不一致、xterm/PTY 列数明显小于实际容器宽度。
4. 发现任何宽度异常时，禁止声称完成、禁止合并到 `dev`、禁止推送远程，必须先修复再复测。

## 开发规范

### TDD 强制

非平凡的代码变更必须采用 TDD：先写测试（红）→ 实现（绿）→ 重构。

### 安全要点

- 两个 WebSocket 端点独立认证，修改 `server.ts` 或 `auth-service.ts` 时必须保持此特性
- tmux/zellij 命令使用参数数组，禁止退化为 shell 拼接字符串
- PTY 路径中的 session 名称必须继续保持安全转义

### 交付流程

1. 在 feature 分支完成开发 + 自测（`npm run typecheck && npm test && npm run build` 全部通过）
2. 执行真实网页宽度专项检查，确认不存在任何半宽或错宽展示
3. 合并到 `dev`，push 到远程
4. 向用户报告完成
