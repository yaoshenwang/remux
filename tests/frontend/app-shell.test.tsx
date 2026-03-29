// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { AppShell } from "../../src/frontend/screens/AppShell.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("AppShell", () => {
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

  test("writes visual viewport metrics into CSS custom properties", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <AppShell
          drawerOpen={false}
          mobileLandscape={false}
          mobileLayout
          onCloseDrawer={() => undefined}
          sidebar={<aside>sidebar</aside>}
          sidebarCollapsed={false}
          viewportHeight={402}
          viewportOffsetLeft={6}
          viewportOffsetTop={118}
        >
          <main>content</main>
        </AppShell>
      );
    });

    const shell = container.querySelector(".app-shell") as HTMLDivElement | null;
    expect(shell).not.toBeNull();
    expect(shell?.style.getPropertyValue("--app-height")).toBe("402px");
    expect(shell?.style.getPropertyValue("--app-offset-left")).toBe("6px");
    expect(shell?.style.getPropertyValue("--app-offset-top")).toBe("118px");
  });
});
