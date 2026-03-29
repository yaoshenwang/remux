// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { Toolbar } from "../../src/frontend/components/Toolbar.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("Toolbar", () => {
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

  test("hides the virtual keyboard toolbar on desktop layouts", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: window.localStorage,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <Toolbar
          sendRaw={() => undefined}
          onFocusTerminal={() => undefined}
          fileInputRef={{ current: null }}
          setStatusMessage={() => undefined}
          snippets={[]}
          onExecuteSnippet={() => undefined}
          mobileLayout={false}
        />
      );
    });

    const toolbar = container.querySelector(".toolbar");
    expect(toolbar?.classList.contains("desktop-hidden")).toBe(true);
  });
});
