# AGENTS.md

本文件为代理在本仓库工作时的指令手册。所有规则必须严格遵守。

## 项目概述

Remux 是一个基于 ghostty-web 的跨端远程终端 workspace。当前 shipping path 是 Node.js/TypeScript gateway + browser shell，使用 node-pty 直接管理 shell PTY，并可选通过 tunnel 暴露给手机、平板或其他电脑访问。以 npm 包分发（`npx @wangyaoshen/remux`），使用 pnpm 作为包管理器。

- **GitHub**: github.com/yaoshenwang/remux
- **许可证**: GPL-3.0-or-later

### 当前权威文档

- `README.md`
- `docs/CURRENT_BASELINE.md`
- `docs/ACTIVE_DOCS_INDEX.md`
- `docs/SPEC.md`
- `docs/TESTING.md`

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

### 当前运行时约束（强制）

- 当前公开产品路径是 Node.js gateway + ghostty-web browser shell + direct shell PTY；**禁止**把 `main` / `dev` 的实现重新引回任何归档的 Zellij、React/Vite 或其他替代运行时线
- session 持久化、断线恢复、Inspect、宽度和多端一致性问题，必须在当前 Node.js + node-pty + detached PTY daemon 架构内解决
- `docs/archive/` 和 `docs/decisions/` 中已标记为 Archive 的文档只用于历史参考，不得重新当成当前实现或产品要求

## 常用命令

```bash
pnpm install
pnpm run dev
pnpm run typecheck
pnpm test
pnpm run test:e2e
pnpm run build
cd packages/RemuxKit && swift test
```

### 构建检查（强制）

合并到 `dev` 之前必须通过：

```bash
pnpm run typecheck && pnpm test && pnpm run build
```

涉及浏览器 transport、终端渲染、认证、Inspect、上传或 resize 行为的变更，还必须补跑：

```bash
pnpm run test:e2e
```

## 开发规范

### TDD 强制

非平凡的代码变更必须采用 TDD：先写测试（红）→ 实现（绿）→ 重构。

### 安全要点

- 单一 WebSocket 端点 `/ws` 必须继续先鉴权再附着或执行控制命令
- shell、PTY daemon、tunnel 与 service 相关命令使用参数数组，禁止退化为 shell 拼接字符串
- PTY / daemon 恢复、observer 输入丢弃、device trust 等当前安全语义不得被回退

### 交付流程

1. 在 feature 分支完成开发 + 自测（`pnpm run typecheck && pnpm test && pnpm run build` 全部通过；必要时补 `pnpm run test:e2e` 和 `cd packages/RemuxKit && swift test`）
2. 确认功能开发完全后，立即合并到 `dev`
3. 立刻 push 到远程 `origin/dev`，禁止只做本地合并
4. 基于远程 `dev` 对应的真实环境执行必要的实机验证
5. 验证通过后再向用户报告完成；若验证失败，继续修复并重复上述流程，禁止未合并或未推送就交付
