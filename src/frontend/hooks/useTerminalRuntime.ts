import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { themes } from "../themes";
import { shouldUsePaneViewportCols } from "../ui-state";
import type { ServerConfig } from "../app-types";
import type { ToolbarHandle } from "../components/Toolbar";

interface UseTerminalRuntimeOptions {
  onSendRaw: (data: string) => void;
  paneViewportColsRef: MutableRefObject<number>;
  serverConfig: ServerConfig | null;
  setStatusMessage: Dispatch<SetStateAction<string>>;
  terminalSocketRef: MutableRefObject<WebSocket | null>;
  theme: "dark" | "light";
  toolbarRef: RefObject<ToolbarHandle | null>;
}

interface UseTerminalRuntimeResult {
  copySelection: () => Promise<void>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  focusTerminal: () => void;
  readTerminalBuffer: () => string;
  resetTerminalBuffer: () => void;
  scrollbackContentRef: RefObject<HTMLDivElement | null>;
  sendTerminalResize: (terminalSocketRef: MutableRefObject<WebSocket | null>) => void;
  serializeAddonRef: MutableRefObject<SerializeAddon | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
}

const isMobileDevice = (): boolean =>
  window.matchMedia("(max-width: 768px), (pointer: coarse)").matches;

const getPreferredTerminalFontSize = (): number => isMobileDevice() ? 12 : 14;

export const useTerminalRuntime = ({
  onSendRaw,
  paneViewportColsRef,
  serverConfig,
  setStatusMessage,
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

  sendRawToSocketRef.current = onSendRaw;
  setStatusMessageRef.current = setStatusMessage;

  const sendTerminalResize = useCallback((terminalSocketRef: MutableRefObject<WebSocket | null>): void => {
    const socket = terminalSocketRef.current;
    const terminal = terminalRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !terminal) {
      return;
    }
    socket.send(JSON.stringify({
      type: "resize",
      cols: terminal.cols,
      rows: terminal.rows
    }));
  }, []);

  const readTerminalBuffer = useCallback((): string => {
    const addon = serializeAddonRef.current;
    if (!addon) return "";
    return addon.serialize({ scrollback: 10000 });
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

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return;
    }

    const initialFontSize = getPreferredTerminalFontSize();
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
    terminal.attachCustomKeyEventHandler((event) => {
      const modifierKey = navigator.platform.toLowerCase().includes("mac")
        ? event.metaKey
        : event.ctrlKey;
      const key = event.key.toLowerCase();

      if (modifierKey && key === "c" && terminal.hasSelection()) {
        void copySelection();
        event.preventDefault();
        return false;
      }

      if (modifierKey && key === "v") {
        void navigator.clipboard.readText()
          .then((text) => {
            if (text) {
              sendRawToSocketRef.current(text);
              focusTerminal();
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
      fitAddon.fit();
      terminal.focus();
    });

    const disposable = terminal.onData((data) => {
      const output = toolbarRef.current?.applyModifiersAndClear(data) ?? data;
      onSendRaw(output);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;

    const fitAndNotifyResize = () => {
      const container = terminalContainerRef.current;
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      const preferredFontSize = getPreferredTerminalFontSize();
      if (terminal.options.fontSize !== preferredFontSize) {
        terminal.options.fontSize = preferredFontSize;
      }
      fitAddon.fit();
      const paneCols = paneViewportColsRef.current;
      if (
        shouldUsePaneViewportCols(serverConfig?.backendKind) &&
        paneCols > 0 &&
        terminal.cols !== paneCols
      ) {
        terminal.resize(paneCols, terminal.rows);
      }
      sendTerminalResize(terminalSocketRef);
    };

    const resizeObserver = new ResizeObserver(() => {
      fitAndNotifyResize();
    });
    resizeObserver.observe(terminalContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      disposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
    };
  }, [copySelection, focusTerminal, onSendRaw, paneViewportColsRef, sendTerminalResize, serverConfig?.backendKind, terminalSocketRef, theme, toolbarRef]);

  useEffect(() => {
    const themeConfig = themes[theme];
    if (themeConfig && terminalRef.current) {
      terminalRef.current.options.theme = themeConfig.xterm;
    }
  }, [theme]);

  useEffect(() => {
    if (shouldUsePaneViewportCols(serverConfig?.backendKind)) {
      return;
    }
    paneViewportColsRef.current = 0;
  }, [paneViewportColsRef, serverConfig?.backendKind]);

  return {
    copySelection,
    fileInputRef,
    fitAddonRef,
    focusTerminal,
    readTerminalBuffer,
    resetTerminalBuffer,
    scrollbackContentRef,
    sendTerminalResize,
    serializeAddonRef,
    terminalContainerRef,
    terminalRef
  };
};
