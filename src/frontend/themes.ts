/**
 * Terminal theme definitions.
 *
 * Each theme provides a complete ITheme color set that ghostty-web
 * passes to both its CanvasRenderer and the WASM GhosttyTerminal.
 * Passing an explicit 16-color ANSI palette avoids ambiguity where
 * buildWasmConfig() sends 0-valued palette entries to the WASM layer.
 */

export interface TerminalTheme {
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeConfig {
  name: string;
  /** Complete terminal color palette for ghostty-web / xterm.js. */
  terminal: TerminalTheme;
  /** @deprecated Use `terminal` instead. Kept for backward compatibility. */
  xterm: { background: string; foreground: string; cursor: string };
}

// Ghostty default palette — matches ghostty-web's built-in DEFAULT_THEME
const GHOSTTY_DARK: TerminalTheme = {
  foreground: "#d4d4d4",
  background: "#1e1e1e",
  cursor: "#ffffff",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  selectionForeground: "#d4d4d4",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

// One Dark inspired — readable on white background
const GHOSTTY_LIGHT: TerminalTheme = {
  foreground: "#383a42",
  background: "#ffffff",
  cursor: "#526eff",
  cursorAccent: "#ffffff",
  selectionBackground: "#b4d5fe",
  selectionForeground: "#383a42",
  black: "#383a42",
  red: "#e45649",
  green: "#50a14f",
  yellow: "#c18401",
  blue: "#4078f2",
  magenta: "#a626a4",
  cyan: "#0184bc",
  white: "#a0a1a7",
  brightBlack: "#4f525e",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

export const themes: Record<string, ThemeConfig> = {
  dark: {
    name: "Dark",
    terminal: GHOSTTY_DARK,
    xterm: { background: GHOSTTY_DARK.background, foreground: GHOSTTY_DARK.foreground, cursor: GHOSTTY_DARK.cursor },
  },
  light: {
    name: "Light",
    terminal: GHOSTTY_LIGHT,
    xterm: { background: GHOSTTY_LIGHT.background, foreground: GHOSTTY_LIGHT.foreground, cursor: GHOSTTY_LIGHT.cursor },
  },
};
