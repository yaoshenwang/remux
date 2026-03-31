import { Suspense, lazy, useCallback, useEffect, useRef, useState, type CSSProperties, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent } from "react";
import { Toolbar, type ToolbarHandle } from "./components/Toolbar";
import { AppHeader } from "./components/AppHeader";
import { InspectView } from "./components/InspectView";
import { ComposeBar } from "./components/ComposeBar";
import { SettingsModal } from "./components/SettingsModal";
import { AppShell } from "./screens/AppShell";
import { matchesMobileLayout, useViewportLayout } from "./mobile-layout";
import { useTerminalRuntime } from "./hooks/useTerminalRuntime";
import { useZellijConnection } from "./hooks/useZellijConnection";
import { useZellijControl } from "./hooks/useZellijControl";
import type { TerminalWriteChunk } from "./terminal-write-buffer";
import { uploadImage } from "./upload";

declare global {
  interface Window {
    __remuxDebugEvents?: Array<{ at: string; event: string; payload?: unknown }>;
    __remuxDebugState?: unknown;
  }
}

const LazyPasswordOverlay = lazy(() => import("./components/PasswordOverlay"));

export const App = () => {
  const toolbarRef = useRef<ToolbarHandle>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    localStorage.getItem("remux-sidebar-collapsed") === "true",
  );
  const [viewMode, setViewMode] = useState<"terminal" | "inspect">(() => {
    const stored = localStorage.getItem("remux-view-mode");
    if (stored === "terminal" || stored === "inspect") {
      return stored;
    }
    return matchesMobileLayout() ? "inspect" : "terminal";
  });
  const { mobileLayout, mobileLandscape, viewportHeight, viewportOffsetLeft, viewportOffsetTop } = useViewportLayout();
  const [inspectScope, setInspectScope] = useState<"pane" | "tab">("tab");
  const [inspectPaneId, setInspectPaneId] = useState<string | null>(null);
  const [inspectSearchInput, setInspectSearchInput] = useState("");
  const [debouncedInspectSearch, setDebouncedInspectSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // --- Theme ---
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("remux-theme");
    return stored === "dark" ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("remux-theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("remux-sidebar-collapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem("remux-view-mode", viewMode);
  }, [viewMode]);

  // --- Zellij control channel ---
  const control = useZellijControl();

  // --- Terminal write bridge ---
  const writeRef = useRef<(chunk: TerminalWriteChunk) => void>(() => {});

  // --- Terminal I/O connection ---
  const connection = useZellijConnection(
    useCallback((data: string | Uint8Array) => writeRef.current(data), []),
  );

  // --- Terminal runtime ---
  const terminal = useTerminalRuntime({
    mobileLayout,
    onSendRaw: connection.sendRaw,
    onResizeSent: useCallback((payload: { cols: number; rows: number }) => {
      connection.sendResize(payload.cols, payload.rows);
    }, [connection.sendResize]),
    setStatusMessage,
    terminalVisible: viewMode === "terminal" && connection.status === "connected",
    terminalSocketRef: connection.socketRef,
    theme,
    toolbarRef,
  });

  writeRef.current = terminal.writeToTerminal;

  // Focus terminal after connection.
  useEffect(() => {
    if (connection.status !== "connected") return;
    terminal.requestTerminalFit({ notify: true, retryUntilVisible: true });
    terminal.focusTerminal();
  }, [connection.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit terminal when switching back to terminal mode.
  useEffect(() => {
    if (viewMode === "terminal") {
      terminal.requestTerminalFit({ notify: true, retryUntilVisible: true });
      terminal.focusTerminal();
    }
  }, [viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Request inspect content when switching to inspect mode.
  const ws = control.workspace;
  const tabs = ws?.tabs ?? [];
  const activeTabIndex = ws?.activeTabIndex ?? 0;
  const activeTab = tabs.find((tab) => tab.index === activeTabIndex) ?? tabs[0];
  const activePaneId = activeTab?.panes.find((pane) => pane.focused)?.id ?? activeTab?.panes[0]?.id ?? null;

  useEffect(() => {
    if (!activeTab) {
      setInspectPaneId(null);
      return;
    }

    const paneIds = new Set(activeTab.panes.map((pane) => pane.id));
    setInspectPaneId((current) => current && paneIds.has(current) ? current : activePaneId);
  }, [activePaneId, activeTab]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedInspectSearch(inspectSearchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [inspectSearchInput]);

  useEffect(() => {
    if (viewMode === "inspect" && control.connected) {
      control.requestInspect({
        scope: inspectScope,
        paneId: inspectScope === "pane" ? inspectPaneId ?? undefined : undefined,
        tabIndex: inspectScope === "tab" ? activeTabIndex : undefined,
        query: debouncedInspectSearch || undefined,
      }, {
        preferCache: !debouncedInspectSearch,
      });
    }
  }, [
    activeTabIndex,
    control.connected,
    control.requestInspect,
    debouncedInspectSearch,
    inspectPaneId,
    inspectScope,
    viewMode,
  ]);

  // --- Compose bar ---
  const [composeText, setComposeText] = useState("");

  const sendCompose = useCallback(() => {
    const text = composeText.trim();
    if (!text) return;
    connection.sendRaw(text + "\r");
    setComposeText("");
    terminal.focusTerminal();
  }, [composeText, connection.sendRaw, terminal.focusTerminal]);

  const handleComposeKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendCompose();
    }
  }, [sendCompose]);

  const handleComposePaste = useCallback((event: ReactClipboardEvent<HTMLInputElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const blob = item.getAsFile();
        if (!blob) return;
        setStatusMessage("Uploading image…");
        void uploadImage(blob, item.type)
          .then((result) => {
            connection.sendRaw(result.path);
            terminal.focusTerminal();
            setStatusMessage(`Image uploaded (${Math.round(result.size / 1024)}KB)`);
          })
          .catch((err) => {
            setStatusMessage(`Upload failed: ${err instanceof Error ? err.message : "unknown"}`);
          });
        return;
      }
    }
  }, [connection, terminal]);

  // --- Status message auto-clear ---
  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(""), 3000);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  // --- Derived state ---
  const showPassword = connection.needsPassword || control.needsPassword;
  const isConnected = connection.status === "connected";
  const sessionName = ws?.session ?? "remux";
  const connectionStatus = connection.status;

  const terminalStatusMessage =
    connection.status === "connecting" ? "Connecting..." :
    connection.status === "authenticating" ? "Authenticating..." :
    connection.status === "disconnected" ? "Disconnected. Reconnecting..." :
    connection.status === "error" && connection.errorMessage ? connection.errorMessage :
    statusMessage || undefined;

  // --- Sidebar (session panel) ---
  const connectionStateLabel =
    connectionStatus === "connected" ? "Connected" :
    connectionStatus === "disconnected" ? "Reconnecting" :
    connectionStatus === "error" ? "Disconnected" :
    connectionStatus === "authenticating" ? "Authenticating" :
    "Connecting";

  const clientCount = control.connectedClients.length;
  const [clientsExpanded, setClientsExpanded] = useState(false);
  const [editingSession, setEditingSession] = useState(false);
  const sessionInputRef = useRef<HTMLInputElement>(null);

  const commitSessionRename = useCallback(() => {
    const value = sessionInputRef.current?.value.trim();
    if (value && value !== sessionName) control.renameSession(value);
    setEditingSession(false);
  }, [sessionName, control.renameSession]);

  const sidebar = (
    <aside className={`sidebar${drawerOpen ? " drawer-open" : ""}`} data-testid="sidebar">
      {/* Session section */}
      <div className="sidebar-section-label">SESSION</div>
      <div className="sidebar-session-header">
        <span className={`sidebar-status-dot status-${connectionStatus}`} />
        {editingSession ? (
          <input
            ref={sessionInputRef}
            className="sidebar-session-input"
            defaultValue={sessionName}
            autoFocus
            onBlur={commitSessionRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSessionRename();
              if (e.key === "Escape") setEditingSession(false);
            }}
          />
        ) : (
          <span
            className="sidebar-session-name"
            title="Double-click to rename"
            onDoubleClick={() => {
              setEditingSession(true);
              requestAnimationFrame(() => sessionInputRef.current?.select());
            }}
          >
            {sessionName}
          </span>
        )}
        <span className="sidebar-state-label">{connectionStateLabel}</span>
      </div>

      {/* Connected clients (collapsed by default) */}
      <button
        className="sidebar-clients-toggle"
        onClick={() => setClientsExpanded((v) => !v)}
        type="button"
      >
        <span>{`${clientCount} device${clientCount !== 1 ? "s" : ""} connected`}</span>
        <span className="collapse-chevron">{clientsExpanded ? "▾" : "▸"}</span>
      </button>

      {clientsExpanded && (
        <div className="sidebar-clients-list">
          {control.connectedClients.map((client) => (
            <div
              key={client.clientId}
              className={`sidebar-client-row${client.clientId === control.selfClientId ? " is-self" : ""}`}
            >
              <span className="sidebar-client-name">{client.deviceName}</span>
              {client.clientId === control.selfClientId && <span className="sidebar-client-you">You</span>}
              <span className="sidebar-client-meta">{client.mode}</span>
            </div>
          ))}
        </div>
      )}

      <div className="sidebar-spacer" />

      {/* Footer */}
      <div className="sidebar-footer">
        <button
          className="sidebar-settings-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          type="button"
        >
          <span className="material-symbols-outlined">settings</span>
          <span>Settings</span>
        </button>
        <div className="drawer-version" data-testid="sidebar-version">
          {connection.serverVersion ? `v${connection.serverVersion}` : ""}
          {connection.serverGitBranch ? ` · ${connection.serverGitBranch}` : ""}
          {connection.serverGitCommitSha ? ` · ${connection.serverGitCommitSha.slice(0, 7)}` : ""}
        </div>
      </div>
    </aside>
  );

  return (
    <AppShell
      drawerOpen={drawerOpen}
      mobileLandscape={mobileLandscape}
      mobileLayout={mobileLayout}
      onCloseDrawer={() => setDrawerOpen(false)}
      sidebar={sidebar}
      sidebarCollapsed={sidebarCollapsed}
      viewportHeight={viewportHeight}
      viewportOffsetLeft={viewportOffsetLeft}
      viewportOffsetTop={viewportOffsetTop}
    >
      <div className="main-content">
        <div className="workspace-frame">
          <AppHeader
            mobileLayout={mobileLayout}
            onToggleDrawer={() => setDrawerOpen((o) => !o)}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
            tabs={tabs}
            activeTabIndex={activeTabIndex}
            onSelectTab={control.selectTab}
            onCloseTab={control.closeTab}
            onNewTab={() => control.newTab()}
            onRenameTab={control.renameTab}
            viewMode={viewMode}
            onSetViewMode={setViewMode}
          />

          <div className="workspace-body">
            <section className={`workspace-surface workspace-surface--${viewMode}`}>
              <main className="terminal-wrap">
                <div className={`terminal-stage${viewMode === "inspect" ? " inspect-active" : " live-active"}`}>
                  <div className={`terminal-layer${viewMode !== "terminal" ? " is-hidden" : ""}`}>
                    <div
                      className="terminal-host"
                      ref={terminal.terminalContainerRef}
                      data-testid="terminal-host"
                      onPointerDownCapture={terminal.focusTerminal}
                      onContextMenu={(event) => event.preventDefault()}
                    >
                      {terminalStatusMessage && !showPassword && (
                        <div className="terminal-status-overlay" data-testid="terminal-status-overlay">
                          <span>{terminalStatusMessage}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  {viewMode === "inspect" && (
                    <div className="inspect-layer is-active">
                      <InspectView
                        snapshot={control.inspectSnapshot}
                        loading={control.inspectLoading}
                        error={control.inspectError}
                        scope={inspectScope}
                        selectedPaneId={inspectPaneId}
                        paneOptions={activeTab?.panes ?? []}
                        searchQuery={inspectSearchInput}
                        onRefresh={() => control.requestInspect({
                          scope: inspectScope,
                          paneId: inspectScope === "pane" ? inspectPaneId ?? undefined : undefined,
                          tabIndex: inspectScope === "tab" ? activeTabIndex : undefined,
                          query: debouncedInspectSearch || undefined,
                        }, {
                          preferCache: false,
                        })}
                        onLoadMore={control.loadMoreInspect}
                        onScopeChange={setInspectScope}
                        onPaneChange={setInspectPaneId}
                        onSearchChange={setInspectSearchInput}
                      />
                    </div>
                  )}
                </div>
              </main>
            </section>

            <input
              ref={terminal.fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setStatusMessage("Uploading file…");
                void uploadImage(file, file.type)
                  .then((result) => {
                    connection.sendRaw(result.path);
                    terminal.focusTerminal();
                    setStatusMessage(`Uploaded (${Math.round(result.size / 1024)}KB)`);
                  })
                  .catch((err) => {
                    setStatusMessage(`Upload failed: ${err instanceof Error ? err.message : "unknown"}`);
                  });
                e.target.value = "";
              }}
            />

            <div className="workspace-bottom-rail">
              <Toolbar
                ref={toolbarRef}
                sendRaw={connection.sendRaw}
                onFocusTerminal={terminal.focusTerminal}
                fileInputRef={terminal.fileInputRef}
                mobileLayout={mobileLayout}
                setStatusMessage={setStatusMessage}
                snippets={[]}
                onExecuteSnippet={() => {}}
                hidden={!isConnected}
              />

              {mobileLayout && isConnected && (
                <ComposeBar
                  composeText={composeText}
                  onChange={setComposeText}
                  onFilePaste={handleComposePaste}
                  onKeyDown={handleComposeKeyDown}
                  onSend={sendCompose}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Settings modal */}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          theme={theme}
          onSetTheme={setTheme}
          clientMode={control.clientMode}
          onToggleClientMode={() => {
            const nextMode = control.clientMode === "active" ? "observer" : "active";
            const confirmed = window.confirm(
              nextMode === "observer"
                ? "Switch this client to Observer mode?"
                : "Switch this client to Active mode?",
            );
            if (confirmed) {
              control.setClientMode(nextMode);
            }
          }}
        />
      )}

      {/* Password overlay */}
      {showPassword && (
        <Suspense fallback={null}>
          <LazyPasswordOverlay
            onChange={(v) => { connection.setPassword(v); control.setPassword(v); }}
            onSubmit={() => { connection.submitPassword(); control.submitPassword(); }}
            password={connection.password}
            passwordErrorMessage={connection.passwordErrorMessage || control.passwordErrorMessage}
          />
        </Suspense>
      )}

      {/* Error retry */}
      {connection.status === "error" && connection.errorMessage && !showPassword && (
        <div className="overlay">
          <div className="card">
            <p>{connection.errorMessage}</p>
            <button onClick={connection.retryConnection}>Retry</button>
          </div>
        </div>
      )}
    </AppShell>
  );
};
