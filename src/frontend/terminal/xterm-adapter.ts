/**
 * xterm.js compatibility adapter for TerminalCore.
 * Wraps the existing xterm.js initialization as a compat fallback.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalCore, TerminalOptions } from "./terminal-adapter";

function loadWebglRenderer(terminal: Terminal): { dispose(): void } | null {
  if (typeof WebGL2RenderingContext === "undefined") return null;
  try {
    const addon = new WebglAddon();
    terminal.loadAddon(addon);
    return addon;
  } catch {
    return null;
  }
}

export function createXtermCore(
  _container: HTMLDivElement,
  options: TerminalOptions,
): TerminalCore {
  const terminal = new Terminal({
    cursorBlink: options.cursorBlink,
    scrollback: options.scrollback,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    theme: options.theme,
  });

  const fitAddon = new FitAddon();
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);

  const renderer = loadWebglRenderer(terminal);

  return {
    terminal,
    fitAddon,
    backend: "xterm",
    serialize: (opts) => serializeAddon.serialize(opts),
    lineToString: (lineIndex) => {
      return terminal.buffer.active.getLine(lineIndex)?.translateToString(true) ?? "";
    },
    dispose: () => {
      renderer?.dispose();
      serializeAddon.dispose();
      fitAddon.dispose();
      terminal.dispose();
    },
  };
}
