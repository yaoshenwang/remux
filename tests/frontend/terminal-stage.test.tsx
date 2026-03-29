// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalStage } from "../../src/frontend/components/TerminalStage.js";

describe("TerminalStage", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

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
  });

  it("focuses the terminal even when inner terminal content stops pointer bubbling", () => {
    const onFocusTerminal = vi.fn();
    const terminalContainerRef = { current: null as HTMLDivElement | null };
    const inspectContentRef = { current: null as HTMLDivElement | null };

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <TerminalStage
          activeRedlineCount={0}
          activeRedlineSummary=""
          dragOver={false}
          inspectErrorMessage=""
          inspectLineCount={1000}
          inspectLoading={false}
          inspectPaneFilter="all"
          inspectSearchQuery=""
          inspectSnapshot={null}
          mobileLayout={false}
          onInspectLoadMore={() => undefined}
          onInspectPaneFilterChange={() => undefined}
          onInspectRefresh={() => undefined}
          onInspectSearchQueryChange={() => undefined}
          onFocusTerminal={onFocusTerminal}
          onDragLeave={() => undefined}
          onDragOver={() => undefined}
          onDrop={() => undefined}
          inspectFontSize={14}
          inspectContentRef={inspectContentRef}
          terminalContainerRef={terminalContainerRef}
          viewMode="terminal"
        />
      );
    });

    const host = container.querySelector("[data-testid='terminal-host']") as HTMLDivElement | null;
    expect(host).not.toBeNull();

    const innerTerminal = document.createElement("div");
    innerTerminal.className = "xterm-screen";
    innerTerminal.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    host!.append(innerTerminal);

    const pointerEvent = typeof window.PointerEvent === "function"
      ? new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      : new window.Event("pointerdown", { bubbles: true, cancelable: true });

    act(() => {
      innerTerminal.dispatchEvent(pointerEvent);
    });

    expect(onFocusTerminal).toHaveBeenCalledTimes(1);

    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    container = null;
  });

  it("renders a runtime redline banner when active diagnostics are present", () => {
    const terminalContainerRef = { current: null as HTMLDivElement | null };
    const inspectContentRef = { current: null as HTMLDivElement | null };

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <TerminalStage
          activeRedlineCount={2}
          activeRedlineSummary="Width drift and history gap detected"
          dragOver={false}
          inspectErrorMessage=""
          inspectLineCount={1000}
          inspectLoading={false}
          inspectPaneFilter="all"
          inspectSearchQuery=""
          inspectSnapshot={null}
          mobileLayout={false}
          onInspectLoadMore={() => undefined}
          onInspectPaneFilterChange={() => undefined}
          onInspectRefresh={() => undefined}
          onInspectSearchQueryChange={() => undefined}
          onFocusTerminal={() => undefined}
          onDragLeave={() => undefined}
          onDragOver={() => undefined}
          onDrop={() => undefined}
          inspectFontSize={14}
          inspectContentRef={inspectContentRef}
          terminalContainerRef={terminalContainerRef}
          viewMode="terminal"
        />
      );
    });

    const banner = container.querySelector("[data-testid='terminal-redline-banner']");
    expect(banner?.textContent).toContain("2 redlines");
    expect(banner?.textContent).toContain("Width drift and history gap detected");
  });
});
