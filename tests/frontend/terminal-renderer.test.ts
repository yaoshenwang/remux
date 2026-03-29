import { afterEach, describe, expect, test, vi } from "vitest";
import { canUseWebglRenderer, loadPreferredTerminalRenderer } from "../../src/frontend/terminal-renderer.js";

describe("terminal renderer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("skips WebGL when WebGL2 is unavailable", () => {
    const loadAddon = vi.fn();

    expect(canUseWebglRenderer()).toBe(false);
    expect(loadPreferredTerminalRenderer({ loadAddon }, () => ({ dispose: vi.fn() }))).toBeNull();
    expect(loadAddon).not.toHaveBeenCalled();
  });

  test("loads the WebGL addon when the browser supports WebGL2", () => {
    vi.stubGlobal("WebGL2RenderingContext", function WebGL2RenderingContext() {});

    const addon = { dispose: vi.fn() };
    const loadAddon = vi.fn();

    expect(canUseWebglRenderer()).toBe(true);
    expect(loadPreferredTerminalRenderer({ loadAddon }, () => addon)).toBe(addon);
    expect(loadAddon).toHaveBeenCalledWith(addon);
  });

  test("falls back cleanly when the WebGL addon throws during creation", () => {
    vi.stubGlobal("WebGL2RenderingContext", function WebGL2RenderingContext() {});

    const loadAddon = vi.fn();

    expect(loadPreferredTerminalRenderer(
      { loadAddon },
      () => {
        throw new Error("webgl unavailable");
      },
    )).toBeNull();
    expect(loadAddon).not.toHaveBeenCalled();
  });
});
