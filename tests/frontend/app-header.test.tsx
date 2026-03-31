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

  test("renders the workspace meta row and action row", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <AppHeader
          activeTabIndex={0}
          clientMode="active"
          connectionStateLabel="Connected"
          mobileLayout={false}
          onCloseTab={vi.fn()}
          onNewTab={vi.fn()}
          onRenameTab={vi.fn()}
          onSelectTab={vi.fn()}
          onSetViewMode={vi.fn()}
          onToggleClientMode={vi.fn()}
          onToggleDrawer={vi.fn()}
          onToggleSidebar={vi.fn()}
          sessionName="remux-dev"
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

    expect(container.querySelector(".app-header-meta")?.textContent).toContain("remux-dev");
    expect(container.querySelector(".app-header-main")).not.toBeNull();
    expect(container.querySelector(".session-eyebrow")?.textContent).toBe("Workspace");
    expect(container.querySelector(".connection-state-badge")?.textContent).toContain("Connected");
  });
});
