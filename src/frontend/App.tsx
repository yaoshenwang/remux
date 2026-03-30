import { Suspense, lazy, useCallback, useEffect, useRef, useState, type CSSProperties, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent } from "react";
import { Toolbar, type ToolbarHandle } from "./components/Toolbar";
import { AppHeader } from "./components/AppHeader";
import { InspectView } from "./components/InspectView";
import { ComposeBar } from "./components/ComposeBar";
import { SessionSection } from "./components/sidebar/SessionSection";
import { AppearanceSection } from "./components/sidebar/AppearanceSection";
import { AppShell } from "./screens/AppShell";
import { useViewportLayout } from "./mobile-layout";
import { useTerminalRuntime } from "./hooks/useTerminalRuntime";
import { useZellijConnection } from "./hooks/useZellijConnection";
import { useZellijControl } from "./hooks/useZellijControl";
import type { TerminalWriteChunk } from "./terminal-write-buffer";

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
  const [viewMode, setViewMode] = useState<"terminal" | "inspect">("terminal");
  const { mobileLayout, mobileLandscape, viewportHeight, viewportOffsetLeft, viewportOffsetTop } = useViewportLayout();

  // --- Theme ---
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("remux-theme");
    return stored === "light" ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("remux-theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("remux-sidebar-collapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

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
  useEffect(() => {
    if (viewMode === "inspect" && control.connected) {
      control.requestInspect(true);
    }
  }, [viewMode, control.connected]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleComposePaste = useCallback((_event: ReactClipboardEvent<HTMLInputElement>) => {}, []);

  // --- Status message auto-clear ---
  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(""), 3000);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  // --- Derived state ---
  const showPassword = connection.needsPassword || control.needsPassword;
  const isConnected = connection.status === "connected";
  const ws = control.workspace;
  const tabs = ws?.tabs ?? [];
  const activeTabIndex = ws?.activeTabIndex ?? 0;
  const sessionName = ws?.session ?? "remux";

  const terminalStatusMessage =
    connection.status === "connecting" ? "Connecting..." :
    connection.status === "authenticating" ? "Authenticating..." :
    connection.status === "disconnected" ? "Disconnected. Reconnecting..." :
    connection.status === "error" && connection.errorMessage ? connection.errorMessage :
    statusMessage || undefined;

  // --- Sidebar ---
  const sidebar = (
    <aside className={`sidebar${drawerOpen ? " drawer-open" : ""}`} data-testid="sidebar">
      <SessionSection
        sessionName={sessionName}
        onRenameSession={control.renameSession}
      />
      <AppearanceSection
        followBackendFocus={false}
        onToggleFollowBackendFocus={() => {}}
        onResetInspectFontSize={() => {}}
        onSetTheme={setTheme}
        onUpdateInspectFontSize={() => {}}
        inspectFontSize={0}
        showFollowFocus={false}
        theme={theme}
      />
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
        {/* Header with tab bar */}
        <AppHeader
          mobileLayout={mobileLayout}
          onToggleDrawer={() => setDrawerOpen((o) => !o)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
          tabs={tabs}
          activeTabIndex={activeTabIndex}
          sessionName={sessionName}
          onSelectTab={control.selectTab}
          onCloseTab={control.closeTab}
          onNewTab={() => control.newTab()}
          onRenameTab={control.renameTab}
          viewMode={viewMode}
          onSetViewMode={setViewMode}
        />

        <div className="workspace-body">
          {/* Terminal / Inspect */}
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
                    content={control.inspectContent}
                    loading={false}
                    onRefresh={() => control.requestInspect(false)}
                    onRequestFull={() => control.requestInspect(true)}
                  />
                </div>
              )}
            </div>
          </main>

          {/* Bottom rail: toolbar + compose */}
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
