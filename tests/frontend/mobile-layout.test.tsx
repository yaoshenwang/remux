// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useViewportLayout } from "../../src/frontend/mobile-layout.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface MutableVisualViewport extends EventTarget {
  height: number;
  offsetLeft: number;
  offsetTop: number;
  width: number;
}

const createVisualViewport = (
  width: number,
  height: number,
  offsetTop: number,
  offsetLeft: number,
): MutableVisualViewport => {
  const viewport = new EventTarget() as MutableVisualViewport;
  viewport.width = width;
  viewport.height = height;
  viewport.offsetTop = offsetTop;
  viewport.offsetLeft = offsetLeft;
  return viewport;
};

const HookProbe = () => {
  const layout = useViewportLayout();
  return (
    <pre data-testid="layout-probe">{JSON.stringify(layout)}</pre>
  );
};

describe("useViewportLayout", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  let visualViewport: MutableVisualViewport;
  let mediaQueryListeners: Array<(event: MediaQueryListEvent) => void> = [];

  beforeEach(() => {
    visualViewport = createVisualViewport(390, 844, 0, 0);
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true,
      media: "(max-width: 768px)",
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaQueryListeners.push(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaQueryListeners = mediaQueryListeners.filter((entry) => entry !== listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        mediaQueryListeners.push(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        mediaQueryListeners = mediaQueryListeners.filter((entry) => entry !== listener);
      },
      dispatchEvent: () => true,
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    mediaQueryListeners = [];
    vi.restoreAllMocks();
    delete (window as Window & { visualViewport?: VisualViewport }).visualViewport;
  });

  test("tracks visual viewport offsets during keyboard-driven viewport scrolling", () => {
    act(() => {
      root?.render(<HookProbe />);
    });

    const readLayout = () => JSON.parse(
      container?.querySelector("[data-testid='layout-probe']")?.textContent ?? "{}",
    ) as {
      mobileLandscape: boolean;
      mobileLayout: boolean;
      viewportHeight: number;
      viewportOffsetLeft: number;
      viewportOffsetTop: number;
      viewportWidth: number;
    };

    expect(readLayout()).toMatchObject({
      mobileLandscape: false,
      mobileLayout: true,
      viewportHeight: 844,
      viewportOffsetLeft: 0,
      viewportOffsetTop: 0,
      viewportWidth: 390,
    });

    act(() => {
      visualViewport.height = 402;
      visualViewport.offsetTop = 118;
      visualViewport.offsetLeft = 6;
      visualViewport.dispatchEvent(new Event("scroll"));
    });

    expect(readLayout()).toMatchObject({
      viewportHeight: 402,
      viewportOffsetLeft: 6,
      viewportOffsetTop: 118,
      viewportWidth: 390,
    });
  });
});
