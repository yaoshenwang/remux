# Remux Integration Guide

This document specifies all modifications needed to convert remux into a Remux macOS client.
Apply these changes after submodules are initialized and the project compiles.

## New Files (already created)

| File | Purpose |
|------|---------|
| `Sources/Remux/RemuxSessionManager.swift` | Control WebSocket connection, auth, state sync |
| `Sources/Remux/ConnectionView.swift` | Server URL + Token input UI |
| `Sources/Remux/RemuxTabBridge.swift` | Bridges server state ↔ TabManager |
| `Bridge/main.swift` | remux-bridge executable (stdin/stdout ↔ WebSocket) |

## Integration Points

### 1. remuxApp.swift — Add RemuxSessionManager as app-level state

**Location:** `struct remuxApp: App` (line 137)

```swift
// ADD: after @StateObject private var tabManager
@StateObject private var sessionManager = RemuxSessionManager()
@StateObject private var tabBridge: RemuxTabBridge

// MODIFY init():
init() {
    // ... existing code ...
    _tabManager = StateObject(wrappedValue: TabManager())
    let sm = RemuxSessionManager()
    _sessionManager = StateObject(wrappedValue: sm)
    _tabBridge = StateObject(wrappedValue: RemuxTabBridge(sessionManager: sm))
}
```

**Location:** `var body: some Scene` (around line 330)

```swift
// WRAP ContentView with connection check:
if sessionManager.status == .connected {
    ContentView(...)
        .environmentObject(sessionManager)
        .environmentObject(tabBridge)
} else {
    ConnectionView(sessionManager: sessionManager)
}
```

### 2. TabManager.swift — Route tab operations through RemuxTabBridge

**Location:** `addWorkspace()` (line 1225)

Add a check: if RemuxTabBridge is connected, route through server instead of local creation:

```swift
// Before creating local workspace, check if we should go through Remux
if let bridge = remuxTabBridge {
    Task {
        let tabId = try await bridge.requestNewTab()
        // Tab will be materialized when server state update arrives
    }
    return // Don't create local workspace
}
// ... existing local workspace creation code ...
```

**Location:** Close workspace

```swift
// Before closing locally, notify server
if let bridge = remuxTabBridge, let tabId = bridge.workspaceIdToTabId[workspace.id] {
    bridge.requestCloseTab(workspaceId: workspace.id)
    return // Wait for server state update to remove
}
```

### 3. GhosttyTerminalView.swift — Use bridge command for remote tabs

**Location:** `createSurface()` (line 3692+)

When a workspace is backed by Remux, the `initialCommand` and `environmentVariables` on
`RemuxSurfaceConfigTemplate` will already contain the bridge path and REMUX_* env vars.
No changes needed here — the plumbing happens in RemuxTabBridge.materializeTab() which
sets `initialTerminalCommand` and `initialTerminalEnvironment` when calling
`TabManager.makeWorkspaceForCreation()`.

### 4. Workspace.swift — Pass bridge config through

**Location:** `RemuxSurfaceConfigTemplate` (line 10)

No structural changes needed. The existing `command` and `environmentVariables` fields
already support custom commands and env vars. RemuxTabBridge sets these when creating
workspaces.

### 5. ContentView.swift — Sidebar driven by server state

**Location:** Sidebar tab list (around line 2376)

Add `@EnvironmentObject var sessionManager: RemuxSessionManager` and display
connection status indicator. Tab list continues to read from `tabManager.tabs`
which is populated by RemuxTabBridge.

### 6. AppDelegate.swift — Wire up bridge callbacks

**Location:** `applicationDidFinishLaunching`

```swift
// Wire RemuxTabBridge to TabManager
tabBridge.createWorkspace = { [weak self] tabId, title, bridgePath, bridgeEnv in
    guard let tabManager = self?.tabManager else { return nil }
    let workspace = tabManager.addWorkspace(
        title: title,
        initialTerminalCommand: bridgePath,
        initialTerminalEnvironment: bridgeEnv
    )
    return workspace.id
}
tabBridge.removeWorkspace = { [weak self] workspaceId in
    self?.tabManager.removeTab(id: workspaceId)
}
tabBridge.selectWorkspace = { [weak self] workspaceId in
    self?.tabManager.selectedTabId = workspaceId
}
```

## Files to Remove (Phase 4)

### Delete entirely
- `daemon/remote/` — Go SSH daemon (replaced by Remux WebSocket)
- `Sources/PostHogAnalytics.swift` — Analytics
- `Sources/SentryHelper.swift` — Crash reporting (or replace with own)

### Remove sections from
- `Sources/Workspace.swift`:
  - `WorkspaceRemoteSessionController` (~line 3238+)
  - `WorkspaceRemoteDaemonRPCClient` (~line 1048)
  - `WorkspaceRemoteProxyBroker` (~line 2456)
  - `WorkspaceRemoteCLIRelayServer` (~line 2705)
  - `RemoteLoopbackHTTPRequestRewriter` (~line 1588)
- `Sources/GhosttyTerminalView.swift`:
  - SSH-related environment variables
- `Sources/AppDelegate.swift`:
  - Sentry initialization
  - PostHog initialization
  - SSH session detection

### Remove imports
- `import Sentry` from AppDelegate.swift
- PostHog SDK references

## Branding Changes (Phase 5)

| Item | From | To |
|------|------|----|
| App name | remux / GhosttyTabs | Remux |
| Bundle ID | com.remuxterm.remux | com.remux.macos |
| Socket path | ~/.remux/socket | ~/.remux/socket |
| CLI name | remux | remux |
| Env prefix | REMUX_* | REMUX_* |
| Config dir | ~/.remux/ | ~/.remux/ |
| Xcode project | GhosttyTabs.xcodeproj | Remux.xcodeproj |

### Files to update for branding
- `Sources/SocketControlSettings.swift` — socket path
- `Sources/RemuxConfig.swift` — config directory
- `GhosttyTabs.xcodeproj/project.pbxproj` — bundle ID, product name
- `Package.swift` — package and target names
- `CLI/remux.swift` — CLI binary name
- All `REMUX_*` environment variable references
- Notification names (`com.remuxterm.*` → `com.remux.*`)
