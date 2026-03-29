import { WebglAddon } from "@xterm/addon-webgl";

interface TerminalAddonLike {
  dispose(): void;
}

interface TerminalLike {
  loadAddon(addon: TerminalAddonLike): void;
}

export const canUseWebglRenderer = (): boolean =>
  typeof WebGL2RenderingContext !== "undefined";

export const loadPreferredTerminalRenderer = (
  terminal: TerminalLike,
  createWebglAddon: () => TerminalAddonLike = () => new WebglAddon(),
): TerminalAddonLike | null => {
  if (!canUseWebglRenderer()) {
    return null;
  }

  try {
    const addon = createWebglAddon();
    terminal.loadAddon(addon);
    return addon;
  } catch {
    return null;
  }
};
