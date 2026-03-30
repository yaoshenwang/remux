# AGENTS.md

本文件为代理在本仓库工作时的指令手册。所有规则必须严格遵守。

## 项目概述

Remux 是一个基于 Web 的远程 Zellij 工作区控制台，通过 tunnel 让用户从手机、平板或其他电脑监控和控制终端会话。以 npm 包分发（`npx remux`）。

- **GitHub**: github.com/yaoshenwang/remux
- **许可证**: MIT

## 沟通语言

所有与用户的交流必须使用中文。代码注释和 commit message 使用英文。

## 分支纪律（强制）

- 维护 `main`（生产）和 `dev`（开发）两个长期分支
- **禁止直接在 `main` 或 `dev` 上修改代码**
- 所有开发工作从 `dev` 创建 feature 分支，使用 `git worktree` 隔离开发
- 完成后合并回 `dev`，`dev` 定期合并到 `main` 发布
- 凡是通过 `git worktree` 或新分支完成的功能、修复、维护更新，在确认开发完成后，**必须直接合并到 `dev` 并 push 到远程 `origin/dev`，随后再进行实机或真实环境验证**
- **禁止只在本地合并而不推送远程后交付**
- **禁止停留在 feature 分支未合并到 `dev` 就向用户声称完成或交付**
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

### Zellij Backend 约束（强制）

- `zellij` 是当前公开产品路径与唯一默认后端，**禁止**把 public `main` / `dev` 服务重新引回 `runtime-v2`、`remuxd` 或任何旧 runtime
- session 持久化、断线恢复、Inspect、宽度和多端一致性问题，必须在当前 Node.js + node-pty + Zellij 架构内解决
- 对 `https://remux.yaoshen.wang` 和 `https://remux-dev.yaoshen.wang` 的修复，目标是两者在需要时附着到同一套机器级 Zellij 会话真相，而不是各自维护独立易失 workspace
- 仓库中的 `runtime-v2` 文档只属于归档资料，不得再把它当成当前实现或产品要求

## 常用命令

```bash
npm run dev
npm run dev:backend
npm run dev:frontend
npm run build
npm run typecheck
npm test
npm run test:watch
npm run test:e2e
```

### 构建检查（强制）

合并到 `dev` 之前必须通过：

```bash
npm run typecheck && npm test && npm run build
```

### 宽度专项验收（强制）

每次改动合并并推送到远程 `dev` 后的实际测试里，必须执行一次真实网页宽度专项检查，且不得用 fake harness 截图代替：

1. 打开实际可访问的网页环境，进入真实终端视图，至少覆盖一个桌面宽窗口场景。
2. 检查首屏恢复内容和后续 live output 的展示宽度，确认终端内容宽度与可见 terminal 容器宽度一致。
3. 禁止出现以下任一情况：终端内容只占一半宽度、长行在半宽处提前折行、首屏恢复内容与当前窗口宽度不一致、xterm/PTY 列数明显小于实际容器宽度。
4. 发现任何宽度异常时，禁止声称完成，必须继续修复并重新执行“合并到 `dev` + push 远程 + 真实网页宽度复测”的完整流程。

## 开发规范

### TDD 强制

非平凡的代码变更必须采用 TDD：先写测试（红）→ 实现（绿）→ 重构。

### 安全要点

- 两个 WebSocket 端点独立认证，修改 `server-zellij.ts` 或 `auth-service.ts` 时必须保持此特性
- zellij 与 shell 相关命令使用参数数组，禁止退化为 shell 拼接字符串
- PTY 路径中的 session 名称必须继续保持安全转义

### 交付流程

1. 在 feature 分支完成开发 + 自测（`npm run typecheck && npm test && npm run build` 全部通过）
2. 确认功能开发完全后，立即合并到 `dev`
3. 立刻 push 到远程 `origin/dev`，禁止只做本地合并
4. 基于远程 `dev` 对应的真实环境执行实机验证与真实网页宽度专项检查
5. 验证通过后再向用户报告完成；若验证失败，继续修复并重复上述流程，禁止未合并或未推送就交付
