/**
 * Terminal runtime hook — wires ghostty-web directly to the WebSocket.
 *
 * Data flow follows the ghostty-web demo pattern:
 *   term.onData  → ws.send(data)           // user input
 *   ws.onmessage → term.write(event.data)  // server output
 *   term.onResize → ws.send(JSON.stringify({type:'resize',...}))
 *
 * No intermediate write-buffer or local-echo-prediction layer.
 * Adapted from coder/ghostty-web demo/index.html.
 */

import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { themes } from "../themes";
import type { ToolbarHandle } from "../components/Toolbar";
import { createTerminalCore, type TerminalCore } from "../terminal/terminal-adapter";
import type { TerminalWriteChunk, TerminalWriteOptions } from "../terminal-write-buffer";
import { uploadImage } from "../upload";

declare global {
  interface Window {
    __remuxTestTerminal?: {
      focus: () => boolean;
      readBuffer: () => string;
      readGeometry: () => { cols: number; rows: number; viewportY: number } | null;
      readViewport: () => string;
      scrollToLine: (line: number) => boolean;
    };
  }
}

interface UseTerminalRuntimeOptions {
  mobileLayout: boolean;
  onSendRaw: (data: string) => void;
  onBeforeReset?: (reason: string) => void;
  onResizeSent?: (payload: { cols: number; rows: number; source: string }) => void;
  setStatusMessage: Dispatch<SetStateAction<string>>;
  terminalVisible: boolean;
  terminalSocketRef: MutableRefObject<WebSocket | null>;
  theme: "dark" | "light";
  toolbarRef: RefObject<ToolbarHandle | null>;
}

interface TerminalFitOptions {
  notify?: boolean;
  retryUntilVisible?: boolean;
}

interface UseTerminalRuntimeResult {
  copySelection: () => Promise<void>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  fitAddonRef: MutableRefObject<any | null>;
  focusTerminal: () => void;
  localEchoRef: MutableRefObject<null>;
  readTerminalGeometry: () => { cols: number; rows: number } | null;
  readTerminalBuffer: () => string;
  readTerminalViewport: () => string;
  requestTerminalFit: (options?: TerminalFitOptions) => void;
  resetTerminalBuffer: () => void;
  inspectContentRef: RefObject<HTMLDivElement | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<any | null>;
  writeToTerminal: (
    chunk: TerminalWriteChunk,
    onComplete?: () => void,
    options?: Omit<TerminalWriteOptions, "onComplete">,
  ) => void;
}

const getPreferredTerminalFontSize = (mobileLayout: boolean): number => mobileLayout ? 12 : 14;

export const useTerminalRuntime = ({
  mobileLayout,
  onSendRaw,
  onBeforeReset,
  onResizeSent,
  setStatusMessage,
  terminalVisible,
  terminalSocketRef,
  theme,
  toolbarRef,
}: UseTerminalRuntimeOptions): UseTerminalRuntimeResult => {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const inspectContentRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<any | null>(null);
  const fitAddonRef = useRef<any | null>(null);
  const terminalCoreRef = useRef<TerminalCore | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendRawToSocketRef = useRef(onSendRaw);
  const setStatusMessageRef = useRef(setStatusMessage);
  const copySelectionRef = useRef<() => Promise<void>>(async () => undefined);
  const focusTerminalRef = useRef<() => void>(() => undefined);
  const terminalVisibleRef = useRef(terminalVisible);
  // Pre-init queue: buffer writes that arrive before async terminal init completes
  const preInitQueueRef = useRef<TerminalWriteChunk[]>([]);
  const terminalReadyRef = useRef(false);

  sendRawToSocketRef.current = onSendRaw;
  setStatusMessageRef.current = setStatusMessage;
  terminalVisibleRef.current = terminalVisible;

  // ── read helpers ──────────────────────────────────────────────────

  const readTerminalBuffer = useCallback((): string => {
    const core = terminalCoreRef.current;
    if (!core) return "";
    return core.serialize({ scrollback: 10000 });
  }, []);

  const readTerminalViewport = useCallback((): string => {
    const terminal = terminalRef.current;
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + terminal.rows);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }, []);

  const readTerminalViewportGeometry = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return null;
    return { cols: terminal.cols, rows: terminal.rows, viewportY: terminal.buffer.active.viewportY };
  }, []);

  const readTerminalGeometry = useCallback((): { cols: number; rows: number } | null => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    const proposed = fitAddon?.proposeDimensions();
    if (proposed && proposed.cols >= 2 && proposed.rows >= 2) {
      return { cols: proposed.cols, rows: proposed.rows };
    }
    if (terminal && terminal.cols >= 2 && terminal.rows >= 2) {
      return { cols: terminal.cols, rows: terminal.rows };
    }
    return null;
  }, []);

  const focusTerminal = useCallback((): void => {
    terminalRef.current?.focus();
  }, []);

  const resetTerminalBuffer = useCallback((): void => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    onBeforeReset?.("terminal buffer reset");
    terminal.reset();
    const themeConfig = themes[theme];
    if (themeConfig) {
      terminal.options.theme = themeConfig.terminal;
    }
  }, [onBeforeReset, theme]);

  // ── write: direct to terminal ─────────────────────────────────────

  const writeToTerminal = useCallback((
    chunk: TerminalWriteChunk,
    onComplete?: () => void,
  ): void => {
    const terminal = terminalRef.current;
    if (terminal && terminalReadyRef.current) {
      terminal.write(chunk, onComplete);
    } else {
      // Terminal not ready yet — queue for flush after open()
      preInitQueueRef.current.push(chunk);
      onComplete?.();
    }
  }, []);

  // ── fit (simplified — delegate to FitAddon.observeResize) ────────

  const requestTerminalFit = useCallback((options: TerminalFitOptions = {}): void => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    const preferredFontSize = getPreferredTerminalFontSize(mobileLayout);
    if (terminal.options.fontSize !== preferredFontSize) {
      terminal.options.fontSize = preferredFontSize;
    }

    fitAddon.fit();
  }, [mobileLayout]);

  // ── copy ──────────────────────────────────────────────────────────

  const copySelection = useCallback(async (): Promise<void> => {
    let text = window.getSelection()?.toString() || "";
    const terminalSelection = terminalRef.current?.hasSelection()
      ? terminalRef.current.getSelection()
      : "";
    if (!text && terminalSelection) text = terminalSelection;
    if (!text) {
      const raw = readTerminalBuffer();
      text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    }
    await navigator.clipboard.writeText(text);
    setStatusMessage("Copied to clipboard");
  }, [readTerminalBuffer, setStatusMessage]);

  copySelectionRef.current = copySelection;
  focusTerminalRef.current = focusTerminal;

  // ── terminal init (runs once) ─────────────────────────────────────

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) return;

    let cancelled = false;
    let cleanupFn: (() => void) | null = null;

    void (async () => {
      const container = terminalContainerRef.current;
      if (!container) return;

      const themeConfig = themes[theme];
      const core = await createTerminalCore(container, {
        cursorBlink: true,
        scrollback: 10000,
        fontFamily: "Monaco, Menlo, 'Courier New', monospace",
        fontSize: getPreferredTerminalFontSize(mobileLayout),
        theme: themeConfig?.terminal ?? themeConfig?.xterm ?? {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          cursor: "#ffffff",
        },
      });

      if (cancelled) { core.dispose(); return; }

      const { terminal, fitAddon } = core;

      // ── Cmd+C / Cmd+V shortcuts ──
      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        const mod = navigator.platform.toLowerCase().includes("mac") ? event.metaKey : event.ctrlKey;
        const key = event.key.toLowerCase();

        if (mod && key === "c" && terminal.hasSelection()) {
          void copySelectionRef.current();
          event.preventDefault();
          return false;
        }
        if (mod && key === "v") {
          void (async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text) sendRawToSocketRef.current(text);
            } catch {
              setStatusMessageRef.current("clipboard read failed");
            }
          })();
          event.preventDefault();
          return false;
        }
        return true;
      });

      // ── open & fit (matches demo pattern) ──
      terminal.open(container);
      fitAddon.fit();
      fitAddon.observeResize();

      // Handle window resize as fallback
      const onWindowResize = () => fitAddon.fit();
      window.addEventListener("resize", onWindowResize);

      // ── resize → server (matches demo: term.onResize) ──
      const resizeDisposable = terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        const socket = terminalSocketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols, rows }));
        }
        onResizeSent?.({ cols, rows, source: "fit" });
      });

      // ── user input → server (matches demo: term.onData) ──
      const dataDisposable = terminal.onData((data: string) => {
        const output = toolbarRef.current?.applyModifiersAndClear(data) ?? data;
        if (output) {
          sendRawToSocketRef.current(output);
        }
      });

      // ── flush pre-init queue ──
      terminalReadyRef.current = true;
      if (preInitQueueRef.current.length > 0) {
        for (const queued of preInitQueueRef.current) {
          terminal.write(queued);
        }
        preInitQueueRef.current = [];
      }

      terminalCoreRef.current = core;
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Focus after everything is wired
      terminal.focus();

      cleanupFn = () => {
        window.removeEventListener("resize", onWindowResize);
        resizeDisposable.dispose();
        dataDisposable.dispose();
        core.dispose();
        terminalCoreRef.current = null;
        terminalRef.current = null;
        fitAddonRef.current = null;
        terminalReadyRef.current = false;
      };
    })();

    return () => {
      cancelled = true;
      cleanupFn?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── theme changes ──
  useEffect(() => {
    const themeConfig = themes[theme];
    if (themeConfig && terminalRef.current) {
      terminalRef.current.options.theme = themeConfig.terminal;
    }
  }, [theme]);

  // ── re-fit on layout / visibility changes ──
  useEffect(() => {
    if (!terminalVisible) return;
    requestTerminalFit({ notify: true, retryUntilVisible: true });
  }, [mobileLayout, requestTerminalFit, terminalVisible]);

  // ── e2e test API ──
  useEffect(() => {
    if (!navigator.webdriver) return;
    window.__remuxTestTerminal = {
      focus: () => { focusTerminal(); return Boolean(terminalRef.current); },
      readBuffer: () => readTerminalBuffer(),
      readGeometry: () => readTerminalViewportGeometry(),
      readViewport: () => readTerminalViewport(),
      scrollToLine: (line: number) => {
        if (!terminalRef.current) return false;
        terminalRef.current.scrollToLine(Math.max(0, line));
        return true;
      },
    };
    return () => { delete window.__remuxTestTerminal; };
  }, [focusTerminal, readTerminalBuffer, readTerminalViewport, readTerminalViewportGeometry]);

  return {
    copySelection,
    fileInputRef,
    fitAddonRef,
    focusTerminal,
    localEchoRef: useRef(null),
    readTerminalGeometry,
    readTerminalBuffer,
    readTerminalViewport,
    requestTerminalFit,
    resetTerminalBuffer,
    inspectContentRef,
    terminalContainerRef,
    terminalRef,
    writeToTerminal,
  };
};
