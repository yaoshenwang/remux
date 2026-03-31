import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { themes } from "../themes";
import type { ToolbarHandle } from "../components/Toolbar";
import { createTerminalCore, type TerminalCore } from "../terminal/terminal-adapter";
import {
  createTerminalWriteBuffer,
  type TerminalWriteBuffer,
  type TerminalWriteChunk,
  type TerminalWriteOptions,
} from "../terminal-write-buffer";
import { LocalEchoPrediction } from "../local-echo-prediction";
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
  localEchoRef: MutableRefObject<LocalEchoPrediction | null>;
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
const TERMINAL_RESIZE_DEBOUNCE_MS = 80;

export const useTerminalRuntime = ({
  mobileLayout,
  onSendRaw,
  onBeforeReset,
  onResizeSent,
  setStatusMessage,
  terminalVisible,
  terminalSocketRef,
  theme,
  toolbarRef
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
  const fitFrameRef = useRef<number | null>(null);
  const fitRetryTimerRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const lastResizeSignatureRef = useRef("");
  const lastResizeSocketRef = useRef<WebSocket | null>(null);
  const requestTerminalFitRef = useRef<(options?: TerminalFitOptions) => void>(() => undefined);
  const terminalVisibleRef = useRef(terminalVisible);
  const terminalWriteBufferRef = useRef<TerminalWriteBuffer | null>(null);
  const localEchoRef = useRef<LocalEchoPrediction | null>(null);
  // Pre-init queue: buffer writes that arrive before async terminal init completes
  const preInitQueueRef = useRef<TerminalWriteChunk[]>([]);

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
    onResizeSent?.({
      cols: terminal.cols,
      rows: terminal.rows,
      source: "fit",
    });
    lastResizeSocketRef.current = socket;
    lastResizeSignatureRef.current = signature;
  }, [onResizeSent, terminalSocketRef]);

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
    const core = terminalCoreRef.current;
    if (!core) return "";
    return core.serialize({ scrollback: 10000 });
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
    onBeforeReset?.("terminal buffer reset");
    terminalWriteBufferRef.current?.clear();
    terminal.reset();
    const themeConfig = themes[theme];
    if (themeConfig) {
      terminal.options.theme = themeConfig.terminal;
    }
  }, [onBeforeReset, theme]);

  /** Enqueue a chunk to the write buffer, or buffer it pre-init. */
  const enqueueOrBuffer = useCallback((
    chunk: TerminalWriteChunk,
    options: TerminalWriteOptions = {},
  ): void => {
    if (terminalWriteBufferRef.current) {
      terminalWriteBufferRef.current.enqueue(chunk, options);
    } else {
      // Terminal not yet initialized — queue for later flush
      preInitQueueRef.current.push(chunk);
      options.onComplete?.();
    }
  }, []);

  const writeToTerminal = useCallback((
    chunk: TerminalWriteChunk,
    onComplete?: () => void,
    options: Omit<TerminalWriteOptions, "onComplete"> = {},
  ): void => {
    const echo = localEchoRef.current;
    const complete = (): void => {
      onComplete?.();
    };
    if (echo && typeof chunk === "string") {
      echo.detectAlternateScreen(chunk);
      const reconciled = echo.reconcileServerOutput(chunk);
      if (reconciled) {
        enqueueOrBuffer(reconciled, { ...options, onComplete: complete });
        return;
      }
      complete();
      return;
    }
    if (echo && chunk instanceof Uint8Array) {
      if (echo.pending.length === 0) {
        echo.detectAlternateScreenBinary(chunk);
        enqueueOrBuffer(chunk, { ...options, onComplete: complete });
        return;
      }
      const text = new TextDecoder().decode(chunk);
      echo.detectAlternateScreen(text);
      const reconciled = echo.reconcileServerOutput(text);
      if (reconciled) {
        enqueueOrBuffer(reconciled, { ...options, onComplete: complete });
        return;
      }
      complete();
      return;
    }
    enqueueOrBuffer(chunk, { ...options, onComplete: complete });
  }, [enqueueOrBuffer]);

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

    let cancelled = false;
    let cleanupFn: (() => void) | null = null;

    void (async () => {
      const container = terminalContainerRef.current;
      if (!container) return;

      const initialFontSize = getPreferredTerminalFontSize(mobileLayout);
      const themeConfig = themes[theme];
      const core = await createTerminalCore(container, {
        cursorBlink: true,
        scrollback: 10000,
        fontFamily: "'MesloLGS NF', 'MesloLGM NF', 'Hack Nerd Font', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'DejaVu Sans Mono Nerd Font', 'Symbols Nerd Font Mono', Menlo, Monaco, 'Courier New', monospace",
        fontSize: initialFontSize,
        theme: themeConfig?.terminal ?? themeConfig?.xterm ?? {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          cursor: "#ffffff"
        },
      });

      if (cancelled) {
        core.dispose();
        return;
      }

      const { terminal } = core;
      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
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
          void (async () => {
            try {
              if (typeof navigator.clipboard.read === "function") {
                const items = await navigator.clipboard.read();
                for (const item of items) {
                  if (item.types.includes("text/plain")) {
                    const blob = await item.getType("text/plain");
                    const text = await blob.text();
                    if (text) {
                      sendRawToSocketRef.current(text);
                      focusTerminalRef.current();
                      return;
                    }
                  }
                }
                for (const item of items) {
                  const imageType = item.types.find((t: string) => t.startsWith("image/"));
                  if (imageType) {
                    const blob = await item.getType(imageType);
                    setStatusMessageRef.current("Uploading image…");
                    const result = await uploadImage(blob, imageType);
                    sendRawToSocketRef.current(result.path);
                    focusTerminalRef.current();
                    const sizeKB = Math.round(result.size / 1024);
                    setStatusMessageRef.current(`Image uploaded (${sizeKB}KB)`);
                    return;
                  }
                }
              } else {
                const text = await navigator.clipboard.readText();
                if (text) {
                  sendRawToSocketRef.current(text);
                  focusTerminalRef.current();
                }
              }
            } catch (err) {
              setStatusMessageRef.current(
                err instanceof Error && err.message !== "clipboard read failed"
                  ? err.message
                  : "clipboard read failed",
              );
            }
          })();
          event.preventDefault();
          return false;
        }

        return true;
      });
      terminal.open(container);
      terminalWriteBufferRef.current = createTerminalWriteBuffer((chunk, onWritten) => {
        terminal.write(chunk, onWritten);
      });
      // Flush any data that arrived before terminal was ready
      if (preInitQueueRef.current.length > 0) {
        for (const queued of preInitQueueRef.current) {
          terminalWriteBufferRef.current.enqueue(queued, {});
        }
        preInitQueueRef.current = [];
      }
      localEchoRef.current = new LocalEchoPrediction({
        writeToTerminal: (data: string) => terminal.write(data),
      });
      requestAnimationFrame(() => {
        terminal.focus();
        requestTerminalFitRef.current({ notify: false, retryUntilVisible: true });
      });

      const disposable = terminal.onData((data: string) => {
        const output = toolbarRef.current?.applyModifiersAndClear(data) ?? data;
        if (output) {
          localEchoRef.current?.predictInput(output);
          sendRawToSocketRef.current(output);
        }
      });

      terminalCoreRef.current = core;
      terminalRef.current = terminal;
      fitAddonRef.current = core.fitAddon;

      const resizeObserver = new ResizeObserver(() => {
        requestTerminalFitRef.current({ notify: true });
      });
      resizeObserver.observe(container);

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

      cleanupFn = () => {
        clearPendingFit();
        clearPendingResize();
        resizeObserver.disconnect();
        fontSet?.removeEventListener?.("loadingdone", handleFontsChanged);
        disposable.dispose();
        localEchoRef.current?.reset();
        localEchoRef.current = null;
        terminalWriteBufferRef.current?.clear();
        terminalWriteBufferRef.current = null;
        core.dispose();
        terminalCoreRef.current = null;
        terminalRef.current = null;
        fitAddonRef.current = null;
        lastResizeSignatureRef.current = "";
        lastResizeSocketRef.current = null;
      };
    })();

    return () => {
      cancelled = true;
      if (cleanupFn) {
        cleanupFn();
      } else {
        // Async init hasn't completed yet — cleanup will happen in the cancelled check
        clearPendingFit();
        clearPendingResize();
      }
    };
  // Terminal initialization happens once; subsequent layout changes use
  // requestTerminalFit plus the effects below instead of recreating the terminal.
  }, [clearPendingFit, clearPendingResize]);

  useEffect(() => {
    const themeConfig = themes[theme];
    if (themeConfig && terminalRef.current) {
      terminalRef.current.options.theme = themeConfig.terminal;
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
    localEchoRef,
    readTerminalGeometry,
    readTerminalBuffer,
    readTerminalViewport,
    requestTerminalFit,
    resetTerminalBuffer,
    inspectContentRef,
    terminalContainerRef,
    terminalRef,
    writeToTerminal
  };
};
