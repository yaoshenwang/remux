import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent } from "react";
import { Toolbar, type ToolbarHandle } from "./components/Toolbar";
import { ComposeBar } from "./components/ComposeBar";
import { useViewportLayout } from "./mobile-layout";
import { useTerminalRuntime } from "./hooks/useTerminalRuntime";
import { useZellijConnection } from "./hooks/useZellijConnection";
import type { TerminalWriteChunk } from "./terminal-write-buffer";

declare global {
  interface Window {
    __remuxDebugEvents?: Array<{
      at: string;
      event: string;
      payload?: unknown;
    }>;
    __remuxDebugState?: unknown;
  }
}

const LazyPasswordOverlay = lazy(() => import("./components/PasswordOverlay"));

export const App = () => {
  const toolbarRef = useRef<ToolbarHandle>(null);
  const [statusMessage, setStatusMessage] = useState("");
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

  // --- Terminal write bridge ---
  // useTerminalRuntime creates writeToTerminal, but useZellijConnection
  // needs a callback for incoming data.  Use an indirect ref to break the cycle.
  const writeRef = useRef<(chunk: TerminalWriteChunk) => void>(() => {});

  // --- Connection ---
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
    terminalVisible: connection.status === "connected",
    terminalSocketRef: connection.socketRef,
    theme,
    toolbarRef,
  });

  // Wire the write bridge now that terminal is available.
  writeRef.current = terminal.writeToTerminal;

  // Focus terminal and send initial fit after connection is established.
  useEffect(() => {
    if (connection.status !== "connected") return;
    terminal.requestTerminalFit({ notify: true, retryUntilVisible: true });
    terminal.focusTerminal();
  }, [connection.status]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleComposePaste = useCallback((_event: ReactClipboardEvent<HTMLInputElement>) => {
    // Default paste into input is fine.
  }, []);

  // --- Status message auto-clear ---
  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(""), 3000);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  // --- Determine what to show ---
  const showPassword = connection.needsPassword;
  const showTerminal = connection.status === "connected" || connection.status === "connecting" || connection.status === "authenticating";
  const terminalStatusMessage =
    connection.status === "connecting" ? "Connecting..." :
    connection.status === "authenticating" ? "Authenticating..." :
    connection.status === "disconnected" ? "Disconnected. Reconnecting..." :
    connection.status === "error" && connection.errorMessage ? connection.errorMessage :
    statusMessage || undefined;

  return (
    <div
      className={`app-shell${mobileLayout ? " mobile-layout" : ""}${mobileLandscape ? " mobile-landscape" : ""}`}
      style={{
        "--app-height": `${viewportHeight}px`,
        "--app-offset-left": `${viewportOffsetLeft}px`,
        "--app-offset-top": `${viewportOffsetTop}px`,
      } as React.CSSProperties}
    >
      {/* Header bar */}
      <header className="app-header" data-testid="app-header">
        <div className="app-header-left">
          <span className="app-title">Remux</span>
          <span className={`connection-dot ${connection.status === "connected" ? "online" : "offline"}`} />
        </div>
        <div className="app-header-right">
          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => t === "dark" ? "light" : "dark")}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      {/* Terminal */}
      <main className="terminal-wrap">
        <div className="terminal-stage live-active">
          <div className="terminal-layer">
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
        </div>
      </main>

      {/* Toolbar (mobile) */}
      <Toolbar
        ref={toolbarRef}
        sendRaw={connection.sendRaw}
        onFocusTerminal={terminal.focusTerminal}
        fileInputRef={terminal.fileInputRef}
        mobileLayout={mobileLayout}
        setStatusMessage={setStatusMessage}
        snippets={[]}
        onExecuteSnippet={() => {}}
        hidden={!showTerminal}
      />

      {/* Compose bar (mobile) */}
      {mobileLayout && showTerminal && (
        <ComposeBar
          composeText={composeText}
          onChange={setComposeText}
          onFilePaste={handleComposePaste}
          onKeyDown={handleComposeKeyDown}
          onSend={sendCompose}
        />
      )}

      {/* Password overlay */}
      {showPassword && (
        <Suspense fallback={null}>
          <LazyPasswordOverlay
            onChange={connection.setPassword}
            onSubmit={connection.submitPassword}
            password={connection.password}
            passwordErrorMessage={connection.passwordErrorMessage}
          />
        </Suspense>
      )}

      {/* Retry button when reconnect exhausted */}
      {connection.status === "error" && connection.errorMessage && !showPassword && (
        <div className="overlay">
          <div className="card">
            <p>{connection.errorMessage}</p>
            <button onClick={connection.retryConnection}>Retry</button>
          </div>
        </div>
      )}
    </div>
  );
};
