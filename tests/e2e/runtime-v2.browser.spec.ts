import { expect, test, type Page } from "@playwright/test";
import { startRuntimeV2E2EServer, type StartedRuntimeV2E2EServer } from "./harness/runtime-v2-server.js";

const readTerminalText = async (page: Page): Promise<string> =>
  (await page.locator(".terminal-host .xterm-rows").textContent()) ?? "";

const focusLiveTerminal = async (page: Page): Promise<void> => {
  await page.getByTestId("terminal-host").click({ position: { x: 48, y: 48 } });
  await expect
    .poll(() => page.evaluate(
      () => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false
    ))
    .toBe(true);
};

const scrollTerminalViewportToLine = async (page: Page, lineIndex: number): Promise<void> => {
  await page.evaluate((targetLine) => window.__remuxTestTerminal?.scrollToLine(targetLine) ?? false, lineIndex);
};

const readTerminalBufferLines = async (page: Page, prefix?: string): Promise<string[]> =>
  await page.evaluate((expectedPrefix) => (
    (window.__remuxTestTerminal?.readBuffer() ?? "")
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => (
        line.length > 0
        && (!expectedPrefix || line.startsWith(expectedPrefix))
      ))
  ), prefix ?? null);

test.describe("runtime-v2 browser behavior", () => {
  let server: StartedRuntimeV2E2EServer;

  test.beforeAll(async () => {
    server = await startRuntimeV2E2EServer();
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test.afterEach(async ({ page }) => {
    if (!page.isClosed()) {
      await page.goto("about:blank").catch(() => undefined);
    }
  });

  test("renders the runtime-v2 workspace without console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    await expect(page.getByTestId("terminal-host")).toBeVisible();
    await expect(page.locator(".drawer-backend-switcher")).toHaveCount(0);
    await expect
      .poll(() => server.upstream.latestTerminal()?.sizes.length ?? 0)
      .toBeGreaterThan(0);

    await page.waitForTimeout(250);
    expect(consoleErrors).toEqual([]);
  });

  test("does not hit the removed terminal snapshot API during attach", async ({ page }) => {
    const stateRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/state/")) {
        stateRequests.push(request.url());
      }
    });

    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    expect(stateRequests).toEqual([]);
  });

  test("compose input and inspect both stay reliable through the runtime-v2 gateway", async ({ page }) => {
    server.upstream.setPaneContent("pane-1", "build running\nline 2");
    const newPaneId = server.upstream.splitActivePane();
    server.upstream.setPaneContent(newPaneId, "tests passed");

    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    await page.getByTestId("compose-input").fill("echo hi");
    await page.getByTestId("compose-input").press("Enter");

    await expect
      .poll(() => server.upstream.allTerminalWrites().join(""))
      .toContain("echo hi");

    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.getByTestId("inspect-scope-badge")).toHaveText("Tab History");
    await expect(page.getByTestId("inspect-source-badge")).toHaveText("server timeline");
    await expect(page.getByTestId("inspect-precision-badge")).toHaveText("approximate");
    await expect(page.getByTestId("inspect-pane-pane-1")).toContainText("build running");
    await expect(page.getByTestId(`inspect-pane-${newPaneId}`)).toContainText("tests passed");
  });

  test("renders binary live terminal frames in the browser xterm client", async ({ page }) => {
    const paneId = server.upstream.activePaneId();
    server.upstream.setPaneScrollback(paneId, []);
    server.upstream.setPaneContent(paneId, "binary ready\r\n");
    server.upstream.setTerminalStreamTransport("binary");

    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    await expect.poll(() => readTerminalText(page)).toContain("binary ready");

    await page.getByTestId("compose-input").fill("echo browser-binary");
    await page.getByTestId("compose-input").press("Enter");

    await expect
      .poll(() => server.upstream.latestTerminal()?.inputFrameTypes.at(-1) ?? "")
      .toBe("binary");
    await expect.poll(() => readTerminalText(page)).toContain("echo browser-binary");
  });

  test("sends direct keyboard input from the live xterm surface", async ({ page }) => {
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    await focusLiveTerminal(page);
    await page.keyboard.type("echo direct-terminal-input");
    await page.keyboard.press("Enter");

    await expect
      .poll(() => server.upstream.latestTerminal()?.inputFrameTypes.at(-1) ?? "")
      .toBe("binary");
    await expect
      .poll(() => server.upstream.allTerminalWrites().join(""))
      .toContain("echo direct-terminal-input\r");
    await expect.poll(() => readTerminalText(page)).toContain("echo direct-terminal-input");
  });

  test("keeps large live output scrollable and intact across the terminal buffer", async ({ page }) => {
    const paneId = server.upstream.activePaneId();
    const lines = Array.from(
      { length: 240 },
      (_, index) => `LIVE-LINE-${String(index + 1).padStart(4, "0")} integrity marker`
    );

    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    server.upstream.pushTerminalOutput(paneId, `${lines.join("\r\n")}\r\n`);

    await expect
      .poll(() => page.evaluate(() => window.__remuxTestTerminal?.readBuffer() ?? ""))
      .toContain(lines[0]);
    await expect
      .poll(() => page.evaluate(() => window.__remuxTestTerminal?.readBuffer() ?? ""))
      .toContain(lines.at(-1) ?? "");
    await expect.poll(() => readTerminalText(page)).toContain(lines.at(-1) ?? "");

    await scrollTerminalViewportToLine(page, 0);
    await expect.poll(() => readTerminalText(page)).toContain(lines[0]);

    await scrollTerminalViewportToLine(page, 118);
    await expect.poll(() => readTerminalText(page)).toContain(lines[120]);

    await scrollTerminalViewportToLine(page, 235);
    await expect.poll(() => readTerminalText(page)).toContain(lines.at(-1) ?? "");
    await expect.poll(() => readTerminalText(page)).toContain(lines.at(-3) ?? "");
  });

  test("restores large snapshot-backed scrollback without dropping middle rows", async ({ page }) => {
    const paneId = server.upstream.activePaneId();
    const lines = Array.from(
      { length: 120 },
      (_, index) => `RESTORE-LINE-${String(index + 1).padStart(4, "0")}`
    );
    server.upstream.setPaneContent(paneId, `${lines.join("\r\n")}\r\n`);

    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    await expect.poll(() => readTerminalBufferLines(page, "RESTORE-LINE-")).toEqual(lines);

    await page.reload();
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    await expect.poll(() => readTerminalBufferLines(page, "RESTORE-LINE-")).toEqual(lines);
  });

  test("inspect history survives a browser reconnect with server-backed scrollback", async ({ page }) => {
    server.upstream.setPaneScrollback("pane-1", [
      "compile started",
      "test suite booting",
      "history survives reconnect",
    ]);
    server.upstream.setPaneContent("pane-1", "live tail line");

    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    await page.reload();
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.getByTestId("inspect-pane-pane-1")).toContainText("compile started");
    await expect(page.getByTestId("inspect-pane-pane-1")).toContainText("history survives reconnect");
    await expect(page.getByTestId("inspect-pane-pane-1")).toContainText("live tail line");
  });

  test("keeps the live terminal stage measurable while inspect is open", async ({ page }) => {
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    const readStageMetrics = async () => page.evaluate(() => {
      const host = document.querySelector("[data-testid='terminal-host']") as HTMLElement | null;
      const rect = host?.getBoundingClientRect();
      const style = host ? window.getComputedStyle(host) : null;

      return {
        display: style?.display ?? null,
        height: rect?.height ?? 0,
        visibility: style?.visibility ?? null,
        width: rect?.width ?? 0,
      };
    });

    const liveMetrics = await readStageMetrics();
    expect(liveMetrics.width).toBeGreaterThan(0);
    expect(liveMetrics.height).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.getByRole("heading", { name: "Inspect" })).toBeVisible();

    const inspectMetrics = await readStageMetrics();
    expect(inspectMetrics.display).not.toBe("none");
    expect(inspectMetrics.visibility).not.toBe("hidden");
    expect(inspectMetrics.width).toBeGreaterThan(0);
    expect(inspectMetrics.height).toBeGreaterThan(0);
  });

  test("keeps the last live output visible while reconnecting until replay arrives", async ({ page }) => {
    const paneId = server.upstream.activePaneId();
    server.upstream.setPaneScrollback(paneId, [
      "previous build line",
      "still restoring scrollback",
    ]);
    server.upstream.setPaneContent(paneId, "live tail line");

    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    await expect.poll(() => readTerminalText(page)).toContain("live tail line");

    server.upstream.delayNextTerminalSnapshot(1_200);
    server.upstream.disconnectClients();

    await page.waitForTimeout(500);
    await expect.poll(() => readTerminalText(page)).toContain("live tail line");

    await expect.poll(() => readTerminalText(page)).toContain("previous build line");
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
  });

  test("shows a restore overlay while the live replay is resyncing", async ({ page }) => {
    const paneId = server.upstream.activePaneId();
    server.upstream.setPaneScrollback(paneId, ["restored line"]);
    server.upstream.setPaneContent(paneId, "overlay line");
    server.upstream.delayNextTerminalSnapshot(1_200);
    await page.goto(`${server.baseUrl}/?token=${server.token}`);

    await expect(page.getByTestId("terminal-status-overlay")).toContainText("live view");
    await expect.poll(() => readTerminalText(page)).toContain("overlay line");
    await expect.poll(async () => await page.getByTestId("terminal-status-overlay").count()).toBe(0);
  });

  test("shares one upstream pane across desktop and mobile viewers without shrinking to the mobile viewport", async ({ browser }) => {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const mobile = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const desktopPage = await desktop.newPage();
    const mobilePage = await mobile.newPage();
    const baselineAttachCount = server.upstream.latestTerminal()?.attachCount ?? 0;

    try {
      await desktopPage.goto(`${server.baseUrl}/?token=${server.token}`);
      await mobilePage.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(desktopPage.getByTestId("top-status-indicator")).toHaveClass(/ok/);
      await expect(mobilePage.getByTestId("top-status-indicator")).toHaveClass(/ok/);
      await expect.poll(() => (server.upstream.latestTerminal()?.attachCount ?? 0) - baselineAttachCount).toBe(1);
      await expect.poll(() => server.upstream.latestTerminal()?.sizes.at(-1)?.cols ?? 0).toBeGreaterThan(100);

      await mobilePage.getByTestId("compose-input").fill("echo multi-view");
      await mobilePage.getByTestId("compose-input").press("Enter");

      await expect
        .poll(() => server.upstream.allTerminalWrites().join(""))
        .toContain("echo multi-view");
      await expect.poll(() => readTerminalText(desktopPage)).toContain("echo multi-view");
      await expect.poll(() => readTerminalText(mobilePage)).toContain("echo multi-view");
    } finally {
      await desktop.close();
      await mobile.close();
    }
  });

  test("mobile keeps compose available in live but removes it from inspect mode", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    await expect(page.getByTestId("compose-input")).toBeVisible();
    await page.getByTestId("compose-input").fill("echo mobile");
    await page.getByTestId("compose-input").press("Enter");

    await expect
      .poll(() => server.upstream.allTerminalWrites().join(""))
      .toContain("echo mobile");

    await expect(page.getByTestId("compose-input")).toBeVisible();

    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.getByTestId("compose-input")).toHaveCount(0);
  });

  test("mobile live terminal exposes direct vertical scrolling on the xterm viewport", async ({ page }) => {
    const paneId = server.upstream.activePaneId();
    const lines = Array.from(
      { length: 240 },
      (_, index) => `MOBILE-SCROLL-${String(index + 1).padStart(4, "0")}`
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    server.upstream.pushTerminalOutput(paneId, `${lines.join("\r\n")}\r\n`);

    await expect.poll(() => readTerminalText(page)).toContain(lines.at(-1) ?? "");
    await expect
      .poll(() => page.evaluate(() => {
        const viewport = document.querySelector(".terminal-host .xterm-viewport") as HTMLElement | null;
        if (!viewport) {
          return null;
        }
        const style = window.getComputedStyle(viewport);
        return {
          overflowY: style.overflowY,
          overscrollBehaviorY: style.overscrollBehaviorY,
          touchAction: style.touchAction,
        };
      }))
      .toEqual({
        overflowY: "scroll",
        overscrollBehaviorY: "contain",
        touchAction: "pan-y",
      });
  });

  test("mobile inspect hides nonessential controls until expanded", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.getByTestId("inspect-controls-toggle")).toBeVisible();
    await expect(page.getByTestId("inspect-search-input")).toHaveCount(0);
    await expect(page.getByTestId("inspect-refresh-button")).toHaveCount(0);
    await expect(page.getByTestId("inspect-pane-filter-all")).toHaveCount(0);

    await page.getByTestId("inspect-controls-toggle").click();
    await expect(page.getByTestId("inspect-search-input")).toBeVisible();
    await expect(page.getByTestId("inspect-refresh-button")).toBeVisible();
    await expect(page.getByTestId("inspect-pane-filter-all")).toBeVisible();
  });
});
