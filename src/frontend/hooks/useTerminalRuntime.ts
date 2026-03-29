import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { themes } from "../themes";
import type { ToolbarHandle } from "../components/Toolbar";
import { loadPreferredTerminalRenderer } from "../terminal-renderer";

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
  fitAddonRef: MutableRefObject<FitAddon | null>;
  focusTerminal: () => void;
  readTerminalGeometry: () => { cols: number; rows: number } | null;
  readTerminalBuffer: () => string;
  requestTerminalFit: (options?: TerminalFitOptions) => void;
  resetTerminalBuffer: () => void;
  scrollbackContentRef: RefObject<HTMLDivElement | null>;
  serializeAddonRef: MutableRefObject<SerializeAddon | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
}

const getPreferredTerminalFontSize = (mobileLayout: boolean): number => mobileLayout ? 12 : 14;
const TERMINAL_RESIZE_DEBOUNCE_MS = 80;

export const useTerminalRuntime = ({
  mobileLayout,
  onSendRaw,
  setStatusMessage,
  terminalVisible,
  terminalSocketRef,
  theme,
  toolbarRef
}: UseTerminalRuntimeOptions): UseTerminalRuntimeResult => {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const scrollbackContentRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendRawToSocketRef = useRef(onSendRaw);
  const setStatusMessageRef = useRef(setStatusMessage);
  const copySelectionRef = useRef<() => Promise<void>>(async () => undefined);
  const focusTerminalRef = useRef<() => void>(() => undefined);
  const fitFrameRef = useRef<number | null>(null);
  const fitRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastResizeSignatureRef = useRef("");
  const lastResizeSocketRef = useRef<WebSocket | null>(null);
  const requestTerminalFitRef = useRef<(options?: TerminalFitOptions) => void>(() => undefined);
  const terminalVisibleRef = useRef(terminalVisible);
  const rendererAddonRef = useRef<{ dispose(): void } | null>(null);

  sendRawToSocketRef.current = onSendRaw;
  setStatusMessageRef.current = setStatusMessage;
  terminalVisibleRef.current = terminalVisible;

  const clearPendingFit = useCallback((): void => {
    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
    }
    if (fitRetryTimerRef.current !== null) {
      window.clearTimeout(fitRetryTimerRef.current);
      fitRetryTimerRef.current = null;
    }
  }, []);

  const clearPendingResize = useCallback((): void => {
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
  }, []);

  const sendTerminalResizeNow = useCallback((): void => {
    const socket = terminalSocketRef.current;
    const terminal = terminalRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !terminal) {
      return;
    }
    const signature = `${terminal.cols}x${terminal.rows}`;
    if (lastResizeSocketRef.current === socket && lastResizeSignatureRef.current === signature) {
      return;
    }
    socket.send(JSON.stringify({
      type: "resize",
      cols: terminal.cols,
      rows: terminal.rows
    }));
    lastResizeSocketRef.current = socket;
    lastResizeSignatureRef.current = signature;
  }, [terminalSocketRef]);

  const scheduleTerminalResize = useCallback((): void => {
    clearPendingResize();
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      sendTerminalResizeNow();
    }, TERMINAL_RESIZE_DEBOUNCE_MS);
  }, [clearPendingResize, sendTerminalResizeNow]);

  const applyTerminalFit = useCallback((notify: boolean): boolean => {
    const container = terminalContainerRef.current;
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!container || !terminal || !fitAddon || container.clientWidth === 0 || container.clientHeight === 0) {
      return false;
    }

    const preferredFontSize = getPreferredTerminalFontSize(mobileLayout);
    if (terminal.options.fontSize !== preferredFontSize) {
      terminal.options.fontSize = preferredFontSize;
    }

    fitAddon.fit();

    if (notify) {
      // Keep the runtime terminal size aligned with the visible container.
      scheduleTerminalResize();
    }

    return true;
  }, [mobileLayout, scheduleTerminalResize]);

  const requestTerminalFit = useCallback((options: TerminalFitOptions = {}): void => {
    const { notify = true, retryUntilVisible = false } = options;
    let retriesRemaining = retryUntilVisible ? 20 : 0;

    const run = () => {
      fitFrameRef.current = null;
      const applied = applyTerminalFit(notify);
      if (applied || retriesRemaining <= 0) {
        return;
      }
      retriesRemaining -= 1;
      fitRetryTimerRef.current = window.setTimeout(() => {
        fitRetryTimerRef.current = null;
        fitFrameRef.current = window.requestAnimationFrame(run);
      }, 100);
    };

    clearPendingFit();
    fitFrameRef.current = window.requestAnimationFrame(run);
  }, [applyTerminalFit, clearPendingFit]);
  requestTerminalFitRef.current = requestTerminalFit;

  const readTerminalBuffer = useCallback((): string => {
    const addon = serializeAddonRef.current;
    if (!addon) return "";
    return addon.serialize({ scrollback: 10000 });
  }, []);

  const readTerminalViewport = useCallback((): string => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return "";
    }

    const buffer = terminal.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + terminal.rows);
    const lines: string[] = [];

    for (let index = start; index < end; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }

    return lines.join("\n");
  }, []);

  const readTerminalViewportGeometry = useCallback((): {
    cols: number;
    rows: number;
    viewportY: number;
  } | null => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return null;
    }

    return {
      cols: terminal.cols,
      rows: terminal.rows,
      viewportY: terminal.buffer.active.viewportY
    };
  }, []);

  const readTerminalGeometry = useCallback((): { cols: number; rows: number } | null => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    const proposed = fitAddon?.proposeDimensions();
    if (proposed && proposed.cols >= 2 && proposed.rows >= 2) {
      return {
        cols: proposed.cols,
        rows: proposed.rows
      };
    }
    if (terminal && terminal.cols >= 2 && terminal.rows >= 2) {
      return {
        cols: terminal.cols,
        rows: terminal.rows
      };
    }
    return null;
  }, []);

  const focusTerminal = useCallback((): void => {
    terminalRef.current?.focus();
  }, []);

  const resetTerminalBuffer = useCallback((): void => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.reset();
    const themeConfig = themes[theme];
    if (themeConfig) {
      terminal.options.theme = themeConfig.xterm;
    }
  }, [theme]);

  const copySelection = useCallback(async (): Promise<void> => {
    let text = window.getSelection()?.toString() || "";
    const terminalSelection = terminalRef.current?.hasSelection()
      ? terminalRef.current.getSelection()
      : "";
    if (!text && terminalSelection) {
      text = terminalSelection;
    }
    if (!text) {
      const raw = readTerminalBuffer();
      text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    }
    await navigator.clipboard.writeText(text);
    setStatusMessage("Copied to clipboard");
  }, [readTerminalBuffer, setStatusMessage]);
  copySelectionRef.current = copySelection;
  focusTerminalRef.current = focusTerminal;

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return;
    }

    const initialFontSize = getPreferredTerminalFontSize(mobileLayout);
    const themeConfig = themes[theme];
    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 10000,
      fontFamily: "'MesloLGS NF', 'MesloLGM NF', 'Hack Nerd Font', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'DejaVu Sans Mono Nerd Font', 'Symbols Nerd Font Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: initialFontSize,
      theme: themeConfig?.xterm ?? {
        background: "#0d1117",
        foreground: "#d1e4ff",
        cursor: "#93c5fd"
      }
    });
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(serializeAddon);
    rendererAddonRef.current = loadPreferredTerminalRenderer(terminal);
    terminal.attachCustomKeyEventHandler((event) => {
      const modifierKey = navigator.platform.toLowerCase().includes("mac")
        ? event.metaKey
        : event.ctrlKey;
      const key = event.key.toLowerCase();

      if (modifierKey && key === "c" && terminal.hasSelection()) {
        void copySelectionRef.current();
        event.preventDefault();
        return false;
      }

      if (modifierKey && key === "v") {
        void navigator.clipboard.readText()
          .then((text) => {
            if (text) {
              sendRawToSocketRef.current(text);
              focusTerminalRef.current();
            }
          })
          .catch(() => {
            setStatusMessageRef.current("clipboard read failed");
          });
        event.preventDefault();
        return false;
      }

      return true;
    });
    terminal.open(terminalContainerRef.current);
    requestAnimationFrame(() => {
      terminal.focus();
      requestTerminalFitRef.current({ notify: false, retryUntilVisible: true });
    });

    const disposable = terminal.onData((data) => {
      const output = toolbarRef.current?.applyModifiersAndClear(data) ?? data;
      sendRawToSocketRef.current(output);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;

    const resizeObserver = new ResizeObserver(() => {
      requestTerminalFitRef.current({ notify: true });
    });
    resizeObserver.observe(terminalContainerRef.current);

    const fontSet = document.fonts;
    const handleFontsChanged = () => {
      if (terminalVisibleRef.current) {
        requestTerminalFitRef.current({ notify: true, retryUntilVisible: true });
      }
    };

    void fontSet?.ready.then(() => {
      handleFontsChanged();
    });
    fontSet?.addEventListener?.("loadingdone", handleFontsChanged);

    return () => {
      clearPendingFit();
      clearPendingResize();
      resizeObserver.disconnect();
      fontSet?.removeEventListener?.("loadingdone", handleFontsChanged);
      disposable.dispose();
      rendererAddonRef.current?.dispose();
      rendererAddonRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
      lastResizeSignatureRef.current = "";
      lastResizeSocketRef.current = null;
    };
  // Terminal initialization happens once; subsequent layout changes use
  // requestTerminalFit plus the effects below instead of recreating xterm.
  }, [clearPendingFit, clearPendingResize]);

  useEffect(() => {
    const themeConfig = themes[theme];
    if (themeConfig && terminalRef.current) {
      terminalRef.current.options.theme = themeConfig.xterm;
    }
  }, [theme]);

  useEffect(() => {
    if (!terminalVisible) {
      return;
    }
    requestTerminalFit({ notify: true, retryUntilVisible: true });
  }, [mobileLayout, requestTerminalFit, terminalVisible]);

  useEffect(() => {
    if (!navigator.webdriver) {
      return;
    }

    window.__remuxTestTerminal = {
      focus: () => {
        focusTerminal();
        return Boolean(terminalRef.current);
      },
      readBuffer: () => readTerminalBuffer(),
      readGeometry: () => readTerminalViewportGeometry(),
      readViewport: () => readTerminalViewport(),
      scrollToLine: (line: number) => {
        if (!terminalRef.current) {
          return false;
        }
        terminalRef.current.scrollToLine(Math.max(0, line));
        return true;
      }
    };

    return () => {
      delete window.__remuxTestTerminal;
    };
  }, [focusTerminal, readTerminalBuffer, readTerminalViewport, readTerminalViewportGeometry]);

  return {
    copySelection,
    fileInputRef,
    fitAddonRef,
    focusTerminal,
    readTerminalGeometry,
    readTerminalBuffer,
    requestTerminalFit,
    resetTerminalBuffer,
    scrollbackContentRef,
    serializeAddonRef,
    terminalContainerRef,
    terminalRef
  };
};
