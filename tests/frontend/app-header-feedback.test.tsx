// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppHeader } from "../../src/frontend/components/AppHeader.js";

describe("AppHeader feedback action", () => {
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

  test("renders a feedback button that opens the feedback flow", () => {
    const onOpenFeedback = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <AppHeader
          activeTabLabel="0: Shell"
          awaitingSessionSelection={false}
          bandwidthStats={null}
          beginDrag={() => undefined}
          draggedTabKey={null}
          mobileLayout={false}
          onCloseTab={() => undefined}
          onCreateTab={() => undefined}
          onOpenFeedback={onOpenFeedback}
          onRenameTab={() => undefined}
          onReorderTabs={() => undefined}
          onSelectTab={() => undefined}
          onSetDraggedTabKey={() => undefined}
          onSetRenameTabValue={() => undefined}
          onSetRenamingTab={() => undefined}
          onSetTabDropTarget={() => undefined}
          onToggleDrawer={() => undefined}
          onToggleSidebarCollapsed={() => undefined}
          onToggleStats={() => undefined}
          onToggleViewMode={() => undefined}
          renameHandledByKeyRef={{ current: false }}
          renameTabValue=""
          sidebarCollapsed={false}
          serverConfig={null}
          supportsTabRename={false}
          tabDropTarget={null}
          tabs={[]}
          topStatus={{ kind: "ok", label: "attached: main" }}
          viewMode="terminal"
          formatBytes={(bytes) => `${bytes}B`}
        />
      );
    });

    const button = container.querySelector("[data-testid='feedback-trigger']") as HTMLButtonElement | null;
    expect(button?.textContent).toContain("Feedback");

    act(() => {
      button?.click();
    });

    expect(onOpenFeedback).toHaveBeenCalledTimes(1);
  });
});
