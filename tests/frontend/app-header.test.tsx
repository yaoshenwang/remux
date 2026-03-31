// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppHeader } from "../../src/frontend/components/AppHeader.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("AppHeader", () => {
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

  test("renders tab bar and view mode toggle", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <AppHeader
          activeTabIndex={0}
          mobileLayout={false}
          onCloseTab={vi.fn()}
          onNewTab={vi.fn()}
          onRenameTab={vi.fn()}
          onSelectTab={vi.fn()}
          onSetViewMode={vi.fn()}
          onToggleDrawer={vi.fn()}
          onToggleSidebar={vi.fn()}
          sidebarCollapsed={false}
          tabs={[{
            active: true,
            hasBell: false,
            index: 0,
            isFullscreen: false,
            name: "Tab #1",
            panes: [],
          }]}
          viewMode="terminal"
        />,
      );
    });

    expect(container.querySelector("[data-testid='tab-bar']")).not.toBeNull();
    expect(container.querySelector(".tab-item")?.textContent).toContain("Tab #1");
    expect(container.querySelector(".view-mode-toggle")).not.toBeNull();
    expect(container.querySelector(".sidebar-toggle-btn")).not.toBeNull();
  });
});
