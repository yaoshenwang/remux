/**
 * Terminal adapter abstraction layer.
 *
 * Provides a thin interface over xterm.js and ghostty-web, abstracting only
 * the differences (initialization, serialization) while exposing the shared
 * Terminal instance directly — since both libraries have 95% identical APIs.
 */

export interface TerminalOptions {
  cursorBlink: boolean;
  scrollback: number;
  fontFamily: string;
  fontSize: number;
  theme: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent?: string;
    selectionBackground?: string;
    selectionForeground?: string;
    black?: string;
    red?: string;
    green?: string;
    yellow?: string;
    blue?: string;
    magenta?: string;
    cyan?: string;
    white?: string;
    brightBlack?: string;
    brightRed?: string;
    brightGreen?: string;
    brightYellow?: string;
    brightBlue?: string;
    brightMagenta?: string;
    brightCyan?: string;
    brightWhite?: string;
  };
}

/**
 * Unified terminal core returned by adapters.
 * `terminal` and `fitAddon` are the raw instances from the underlying library —
 * callers can use their shared API surface (open, write, resize, onData, etc.) directly.
 */
export interface TerminalCore {
  /** Raw Terminal instance. Both xterm and ghostty-web expose the same API shape. */
  terminal: any;
  /** FitAddon instance with fit() and proposeDimensions(). */
  fitAddon: any;
  /** Which backend is active. */
  backend: TerminalBackend;
  /** Serialize terminal buffer content as plain text. */
  serialize(opts: { scrollback: number }): string;
  /** Read a single buffer line as trimmed string. */
  lineToString(lineIndex: number): string;
  /** Clean up all resources. */
  dispose(): void;
}

export type TerminalBackend = "ghostty" | "xterm";

/** Determine preferred backend from URL param > localStorage > default. */
export function getPreferredBackend(): TerminalBackend {
  if (typeof window === "undefined") return "ghostty";

  const urlParams = new URLSearchParams(window.location.search);
  const fromUrl = urlParams.get("terminal");
  if (fromUrl === "xterm") return "xterm";
  if (fromUrl === "ghostty") return "ghostty";

  const stored = localStorage.getItem("terminalCore");
  if (stored === "xterm") return "xterm";

  return "ghostty";
}

/**
 * Create a TerminalCore instance.
 * Attempts ghostty-web first; falls back to xterm on failure.
 */
export async function createTerminalCore(
  container: HTMLDivElement,
  options: TerminalOptions,
): Promise<TerminalCore> {
  const preferred = getPreferredBackend();

  if (preferred === "ghostty") {
    try {
      const { createGhosttyCore } = await import("./ghostty-adapter");
      return await createGhosttyCore(container, options);
    } catch (err) {
      console.warn("[remux] ghostty-web failed to load, falling back to xterm:", err);
      const { createXtermCore } = await import("./xterm-adapter");
      return createXtermCore(container, options);
    }
  }

  const { createXtermCore } = await import("./xterm-adapter");
  return createXtermCore(container, options);
}
