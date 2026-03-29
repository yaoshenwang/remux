// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppHeader } from "../../src/frontend/components/AppHeader.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("AppHeader mobile interactions", () => {
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

  test("keeps a mobile tab tap dedicated to selection instead of long-press rename arming", () => {
    vi.useFakeTimers();
    const onSelectTab = vi.fn();
    const onSetRenamingTab = vi.fn();

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <AppHeader
          activeTabLabel="1: Main"
          awaitingSessionSelection={false}
          bandwidthStats={null}
          beginDrag={() => undefined}
          draggedTabKey={null}
          mobileLayout
          onCloseTab={() => undefined}
          onCreateTab={() => undefined}
          onRenameTab={() => undefined}
          onReorderTabs={() => undefined}
          onSelectTab={onSelectTab}
          onSetDraggedTabKey={() => undefined}
          onSetRenameTabValue={() => undefined}
          onSetRenamingTab={onSetRenamingTab}
          onSetTabDropTarget={() => undefined}
          onToggleDrawer={() => undefined}
          onToggleSidebarCollapsed={() => undefined}
          onToggleStats={() => undefined}
          onToggleViewMode={() => undefined}
          renameHandledByKeyRef={{ current: false }}
          renameTabValue=""
          sidebarCollapsed={false}
          serverConfig={null}
          supportsTabRename
          tabDropTarget={null}
          tabs={[
            {
              canClose: true,
              index: 1,
              isActive: true,
              isRenaming: false,
              key: "tab-1",
              label: "1: Main",
              name: "Main",
            },
          ]}
          topStatus={{ kind: "ok", label: "connected" }}
          viewMode="terminal"
          formatBytes={(bytes) => `${bytes}B`}
        />
      );
    });

    const tabButton = container.querySelector("[data-testid='header-tab-button-1']") as HTMLButtonElement | null;
    expect(tabButton).not.toBeNull();

    act(() => {
      tabButton?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      vi.advanceTimersByTime(500);
      tabButton?.click();
    });

    expect(onSelectTab).toHaveBeenCalledWith(1);
    expect(onSetRenamingTab).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
