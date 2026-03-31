> [!WARNING]
> **ARCHIVED** — This plan was written for the pre-rewrite Zellij-based architecture (v0.2.x).
> The v0.3.0 rewrite replaced Zellij with direct shell PTY. Multi-session is now implemented
> natively in server.js. Kept for historical reference only.

# Multi-Session Support — Implementation Plan

## Context

Remux 当前是**单 session 硬编码模式**：服务启动时 `--zellij-session remux-dev` 固定一个 session，所有客户端共用。用户需要在同一个 Remux 实例中管理多个项目（每个项目一个 Zellij session），包括浏览、切换、新建、删除 session。

机器上已有 42 个 Zellij session（含活跃和已退出的），Zellij 原生支持多 session 并发。

---

## 核心设计决策

### 1. Session 切换是 per-client 的，不是全局的

每个浏览器客户端独立选择当前 session。Client A 切到 "project-beta" 时，Client B 保持在 "project-alpha" 不受影响。这与现有的 per-client PTY 模型一致——每个浏览器已经有自己独立的 `zellij attach` 进程。

### 2. `--zellij-session` 变为"默认 session"

CLI 参数不再是"唯一 session"，而是客户端连接后的初始 session。客户端可以随时切换到其他 session。

### 3. 创建 session = 切换到不存在的 session

`zellij attach <name> --create` 会自动创建不存在的 session，所以"新建"和"切换"在 Zellij 层面是同一个操作。前端可以让用户输入新名称，后端直接 attach。

---

## 后端改动

### 文件: `src/backend/zellij-controller.ts`

#### 改进 `listSessions()` 返回结构化数据

当前实现只返回 `string[]`（原始行文本）。需要解析为结构化对象：

```typescript
interface ZellijSessionInfo {
  name: string;
  createdAgo: string;     // "14h 17m 18s"
  isActive: boolean;      // 没有 (EXITED) 后缀 = active
}
```

解析 `zellij list-sessions --no-formatting` 的输出格式：
- `remux-dev [Created 14h 17m 18s ago]` → active
- `old-project [Created 4days ago] (EXITED - attach to resurrect)` → exited

#### 新增 `deleteSession(name)` 方法

```typescript
async deleteSession(name: string): Promise<void> {
  await this.runGlobal(["delete-session", name]);
}
```

注意：`delete-session` 只能删除 EXITED 状态的 session。活跃 session 需要先 `kill-session`。

#### 新增 `killSession(name)` 方法

```typescript
async killSession(name: string): Promise<void> {
  await this.runGlobal(["kill-session", name]);
}
```

#### `listSessions` 和 `deleteSession` 都是全局操作

不依赖 `this.session`，使用 `runGlobal()`（无 `-s` flag）。

---

### 文件: `src/backend/server-zellij.ts`

#### Client 状态扩展

```typescript
interface TerminalClient {
  ws: WebSocket;
  authenticated: boolean;
  pty: ZellijPty | null;
  currentSession: string;      // NEW: 该客户端当前附着的 session
}

interface ControlClient {
  ws: WebSocket;
  authenticated: boolean;
  capabilities: ProtocolCapabilities;
  clientId: string;
  connectTime: string;
  currentSession: string;      // NEW
}
```

初始值为 `config.zellijSession`（CLI 默认 session）。

#### Controller Map 替换单例

```typescript
// 之前
let controller: ZellijControllerApi | null = null;

// 之后
const controllers = new Map<string, ZellijControllerApi>();

const getController = (session: string): ZellijControllerApi => {
  let ctrl = controllers.get(session);
  if (!ctrl) {
    ctrl = new ZellijController({
      session,
      zellijBin: config.zellijBin,
      logger,
    });
    controllers.set(session, ctrl);
  }
  return ctrl;
};
```

Controller 是轻量的（无后台进程），按需创建。

#### Session list 缓存

```typescript
let sessionListCache: { data: ZellijSessionInfo[]; at: number } | null = null;
const SESSION_LIST_CACHE_MS = 2000;

const listSessions = async (): Promise<ZellijSessionInfo[]> => {
  if (sessionListCache && Date.now() - sessionListCache.at < SESSION_LIST_CACHE_MS) {
    return sessionListCache.data;
  }
  // 用任意一个 controller 实例调用 listSessions()（全局操作）
  const ctrl = getController(config.zellijSession);
  const sessions = await ctrl.listSessionsStructured();
  sessionListCache = { data: sessions, at: Date.now() };
  return sessions;
};
```

#### `broadcastWorkspaceState` 改为 session-scoped

```typescript
const broadcastWorkspaceState = async (session: string): Promise<void> => {
  const ctrl = getController(session);
  const state = await ctrl.queryWorkspaceState();
  // 只发给 currentSession === session 的 control clients
  for (const client of controlClients) {
    if (client.authenticated && client.currentSession === session && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(/* ... */);
    }
  }
};
```

#### 新增控制消息处理

在命令 dispatch switch 中增加：

```typescript
case "list_sessions": {
  const sessions = await listSessions();
  // 只回复请求者，不广播
  send(client, { type: "session_list", sessions });
  break;
}

case "switch_session": {
  const targetSession = msg.session as string;
  // 验证 session 名称合法性
  if (!isValidSessionName(targetSession)) {
    send(client, { type: "error", message: "invalid session name" });
    break;
  }
  // 更新 control client 的 currentSession
  client.currentSession = targetSession;
  // 通知对应的 terminal client 也切换（通过 clientId 关联）
  send(client, { type: "session_switched", session: targetSession });
  // 广播新 session 的 workspace state 给该 client
  const ctrl = getController(targetSession);
  const state = await ctrl.queryWorkspaceState();
  send(client, { type: "workspace_state", ...state });
  break;
}

case "create_session": {
  const name = msg.name as string;
  if (!isValidSessionName(name)) {
    send(client, { type: "error", message: "invalid session name" });
    break;
  }
  // zellij attach --create 会自动创建，这里只需切换
  client.currentSession = name;
  send(client, { type: "session_switched", session: name });
  const ctrl = getController(name);
  const state = await ctrl.queryWorkspaceState();
  send(client, { type: "workspace_state", ...state });
  break;
}

case "delete_session": {
  const name = msg.session as string;
  // 禁止删除自己当前 session
  if (name === client.currentSession) {
    send(client, { type: "error", message: "cannot delete current session" });
    break;
  }
  // 检查是否有其他 terminal client 正在使用
  for (const tc of terminalClients) {
    if (tc.currentSession === name) {
      send(client, { type: "error", message: "session in use by another client" });
      break;
    }
  }
  const ctrl = getController(name);
  try {
    await ctrl.killSession(name);  // 先 kill（如果活跃）
    await ctrl.deleteSession(name); // 再 delete
  } catch { /* session 可能已经 exited */ }
  controllers.delete(name);
  sessionListCache = null;
  send(client, { type: "session_deleted", session: name });
  break;
}
```

#### Terminal WebSocket 的 session 切换

当 control channel 收到 `switch_session` 后，需要让同一客户端的 terminal channel 也切换。方案：

**Terminal channel 也支持 switch 消息：**

```typescript
// terminal WebSocket 收到 JSON 消息
case "switch_session": {
  const newSession = msg.session as string;
  // 1. 杀掉旧 PTY
  if (client.pty) {
    client.pty.kill();
    client.pty = null;
  }
  // 2. 更新 client 的 currentSession
  client.currentSession = newSession;
  // 3. 创建新 PTY（使用当前终端尺寸）
  client.pty = createClientPty(client, lastCols, lastRows, newSession);
  break;
}
```

`createClientPty` 签名需要增加 session 参数：

```typescript
const createClientPty = (
  client: TerminalClient,
  cols: number,
  rows: number,
  session?: string  // 新增，默认 config.zellijSession
): ZellijPty => {
  const targetSession = session ?? config.zellijSession;
  const pty = createZellijPty({
    session: targetSession,
    zellijBin: config.zellijBin,
    cols,
    rows,
  });
  // ... 其余不变
};
```

#### Session 名称验证

```typescript
const isValidSessionName = (name: unknown): name is string =>
  typeof name === "string" &&
  name.length > 0 &&
  name.length <= 64 &&
  /^[a-zA-Z0-9_-]+$/.test(name);
```

---

## 前端改动

### 文件: `src/frontend/hooks/useZellijControl.ts`

#### 新增 session 相关类型

```typescript
interface ZellijSessionInfo {
  name: string;
  createdAgo: string;
  isActive: boolean;
}
```

#### 新增状态

```typescript
const [sessions, setSessions] = useState<ZellijSessionInfo[]>([]);
const [currentSession, setCurrentSession] = useState<string | null>(null);
```

#### 新增方法

```typescript
// 请求 session 列表
const listSessions = useCallback(() => {
  send({ type: "list_sessions" });
}, [send]);

// 切换 session（control + terminal 都需要切换）
const switchSession = useCallback((session: string) => {
  send({ type: "switch_session", session });
  // terminal channel 的切换通过 App.tsx 协调
}, [send]);

// 创建新 session
const createSession = useCallback((name: string) => {
  send({ type: "create_session", name });
}, [send]);

// 删除 session
const deleteSession = useCallback((session: string) => {
  send({ type: "delete_session", session });
}, [send]);
```

#### 新增消息处理

```typescript
case "session_list":
  setSessions(msg.sessions as ZellijSessionInfo[]);
  break;

case "session_switched":
  setCurrentSession(msg.session as string);
  break;

case "session_deleted":
  // 刷新 session 列表
  listSessions();
  break;
```

#### Session 列表轮询

```typescript
// 连接后每 10 秒刷新一次 session 列表
useEffect(() => {
  if (!connected) return;
  listSessions(); // 首次立即请求
  const timer = setInterval(listSessions, 10_000);
  return () => clearInterval(timer);
}, [connected, listSessions]);
```

#### Return 值新增

```typescript
return {
  // ... 现有字段
  sessions,
  currentSession,
  listSessions,
  switchSession,
  createSession,
  deleteSession,
};
```

### 文件: `src/frontend/App.tsx`

#### Session 切换协调

当 control channel 切换 session 后，terminal channel 也需要切换：

```typescript
// 监听 currentSession 变化，通知 terminal channel 也切换
useEffect(() => {
  if (!control.currentSession) return;
  // 发送 switch_session 到 terminal WebSocket
  const ws = connection.socketRef.current;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "switch_session",
      session: control.currentSession,
    }));
  }
}, [control.currentSession]);
```

#### Sidebar 重写

```tsx
const sidebar = (
  <aside className={`sidebar${drawerOpen ? " drawer-open" : ""}`}>
    {/* Session list header */}
    <div className="sidebar-section-label">
      SESSIONS
      <button onClick={() => setCreatingSession(true)} title="New session">+</button>
    </div>

    {/* New session input (conditional) */}
    {creatingSession && (
      <div className="sidebar-create-session">
        <input
          autoFocus
          placeholder="Session name"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              control.createSession(e.currentTarget.value.trim());
              setCreatingSession(false);
            }
            if (e.key === "Escape") setCreatingSession(false);
          }}
        />
      </div>
    )}

    {/* Session list */}
    <div className="sidebar-session-list">
      {control.sessions
        .filter(s => s.isActive || s.name === control.currentSession)
        .map(s => (
          <button
            key={s.name}
            className={`sidebar-session-item${s.name === control.currentSession ? " active" : ""}`}
            onClick={() => control.switchSession(s.name)}
          >
            <span className={`sidebar-status-dot ${s.isActive ? "status-connected" : "status-idle"}`} />
            <span className="sidebar-session-item-name">{s.name}</span>
            {s.name !== control.currentSession && (
              <span
                className="sidebar-session-delete"
                onClick={(e) => { e.stopPropagation(); control.deleteSession(s.name); }}
                title="Delete"
              >×</span>
            )}
          </button>
        ))}
    </div>

    <div className="sidebar-spacer" />

    {/* Footer */}
    <div className="sidebar-footer">
      <button className="sidebar-settings-btn" onClick={() => setSettingsOpen(true)}>
        <span className="material-symbols-outlined">settings</span>
        <span>Settings</span>
      </button>
      <div className="drawer-version">
        v{connection.serverVersion} · {connection.serverGitBranch} · {connection.serverGitCommitSha?.slice(0,7)}
      </div>
    </div>
  </aside>
);
```

---

## UI 布局规格

### Desktop

```
┌─ Sidebar (240px) ──────┬─ Main ───────────────────────────────────┐
│ SESSIONS            [+]│ ┌─ Header ──────────────────────────────┐│
│                         │ │ ◂ │ Tab #1 │ Tab #2 │ + │  Live│Insp ││
│ ● remux-dev        ← active  │ └──────────────────────────────────────┘│
│ ● project-alpha         │                                              │
│ ○ old-project           │  Terminal (100% height)                      │
│                         │                                              │
│                         │                                              │
│                         │                                              │
│                         │                                              │
│                         │                                              │
│ ─────────────────────── │                                              │
│ ⚙ Settings              │                                              │
│ v0.2.66 · dev · d9de621 │                                              │
└─────────────────────────┴──────────────────────────────────────────────┘
```

- Session 列表：● = 活跃 session，○ = 已退出（可附着恢复）
- 当前 session 高亮（背景色区分）
- 悬停时显示 × 删除按钮（不能删除当前 session）
- [+] 按钮新建 session

### Mobile

```
┌─ Header ─────────────────────────────┐
│ ☰ │ Tab #1 │ Tab #2 │ + │ Live│Insp │
├──────────────────────────────────────┤
│                                       │
│            Terminal (100%)            │
│                                       │
├──────────────────────────────────────┤
│ Toolbar                               │
│ [Compose command]              [Send] │
└──────────────────────────────────────┘

☰ → Drawer:
┌──────────────────┐
│ SESSIONS      [+]│
│ ● remux-dev  ←    │
│ ● project-alpha   │
│ ○ old-project     │
│                    │
│ ⚙ Settings        │
│ v0.2.66           │
└──────────────────┘
```

---

## Session 切换完整流程

用户点击 sidebar 中的 "project-alpha"：

```
1. Frontend: control.switchSession("project-alpha")
   → 发送 { type: "switch_session", session: "project-alpha" } 到 /ws/control

2. Backend (control channel):
   → 更新 client.currentSession = "project-alpha"
   → 获取/创建 controller("project-alpha")
   → 查询 workspace state
   → 回复 { type: "session_switched", session: "project-alpha" }
   → 回复 { type: "workspace_state", session: "project-alpha", tabs: [...], activeTabIndex: 0 }

3. Frontend (useZellijControl):
   → 收到 session_switched → setCurrentSession("project-alpha")
   → 收到 workspace_state → setWorkspace(newState)
   → Header tab bar 更新为 project-alpha 的 tabs

4. Frontend (App.tsx, useEffect on currentSession):
   → 发送 { type: "switch_session", session: "project-alpha" } 到 /ws/terminal

5. Backend (terminal channel):
   → client.pty.kill() — 杀掉 remux-dev 的 attach 进程
   → client.pty = createClientPty(client, cols, rows, "project-alpha")
   → 新 PTY 运行: zellij attach project-alpha --create
   → 终端输出开始流向前端

6. Frontend (terminal):
   → xterm.js 清屏 + 接收新 session 的终端输出
   → 用户看到 project-alpha 的终端内容
```

**耗时预估：** ~200-500ms（PTY kill + 新 PTY spawn + Zellij attach）

---

## 错误处理

| 场景 | 处理 |
|------|------|
| session 名不合法（特殊字符） | 服务端返回 `{ type: "error" }`，前端提示 |
| 删除当前 session | 服务端拒绝，返回错误 |
| 删除其他客户端正在用的 session | 服务端拒绝，返回错误 |
| 切换到不存在的 session | `--create` 自动创建，正常流程 |
| Zellij 进程异常 | PTY onExit 触发，前端显示 disconnected 状态 |
| 网络断开重连后 | 重新 attach 到 `currentSession`，不丢失 session 选择 |

---

## 向后兼容

- `--zellij-session` CLI 参数保留，含义从"唯一 session"变为"默认 session"
- 不发送 session 消息的旧客户端始终使用默认 session
- 现有 launchd 配置无需修改
- 协议消息是新增的，不修改现有消息格式

---

## 关键文件清单

| 文件 | 改动 |
|------|------|
| `src/backend/zellij-controller.ts` | 新增 `listSessionsStructured()`、`deleteSession()`、`killSession()` |
| `src/backend/server-zellij.ts` | Controller Map、per-client session 状态、4 个新消息、session-scoped broadcast、terminal switch |
| `src/backend/protocol/envelope.ts` | 无改动（现有 envelope 足够） |
| `src/frontend/hooks/useZellijControl.ts` | 新增 sessions 状态、4 个 action、消息处理、轮询 |
| `src/frontend/App.tsx` | Sidebar session 列表、切换协调（control → terminal） |
| `src/frontend/styles/app.css` | sidebar-session-list、sidebar-session-item 等样式 |
| `tests/` | 后端 controller 测试、前端 hook 测试 |

---

## 测试策略

1. **单元测试**：`listSessionsStructured()` 解析测试、`isValidSessionName()` 验证测试
2. **集成测试**：session 切换时 PTY 生命周期（kill old → create new）
3. **E2E 测试**：打开页面 → 侧边栏显示 session 列表 → 新建 session → 切换 → 终端内容变化 → 删除
4. **兼容性测试**：旧客户端（不发 session 消息）仍能正常工作
5. **多客户端测试**：两个浏览器窗口分别切换到不同 session，互不干扰

---

## 实现顺序建议

1. **Phase 1 — 后端 session CRUD**：controller 新方法 + 控制消息处理 + 单元测试
2. **Phase 2 — Terminal session 切换**：terminal channel switch 消息 + PTY 生命周期
3. **Phase 3 — 前端 hook 和 UI**：useZellijControl 扩展 + sidebar session 列表 + 样式
4. **Phase 4 — 端到端验证**：E2E 测试 + 实机验证
