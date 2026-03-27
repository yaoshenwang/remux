import { expect, test, type Page } from "@playwright/test";
import {
  canRunRealZellijE2E,
  startRealZellijE2EServer,
  type StartedRealZellijE2EServer,
  waitForActiveTab,
  waitForTabCount,
} from "./harness/real-zellij-server.js";

interface RealZellijWidthSnapshot {
  approxCols: number;
  approxRows: number;
  backendCols: number;
  backendRows: number;
  cellHeight: number;
  cellWidth: number;
  hostHeight: number;
  hostWidth: number;
  pixelHeightDelta: number;
  pixelWidthDelta: number;
  screenHeight: number;
  screenWidth: number;
}

const readRealZellijWidthSnapshot = async (
  page: Page,
  server: StartedRealZellijE2EServer
): Promise<RealZellijWidthSnapshot> => {
  const geometry = await page.evaluate(() => {
    const host = document.querySelector("[data-testid='terminal-host']") as HTMLElement | null;
    const screen = document.querySelector(".terminal-host .xterm-screen") as HTMLElement | null;
    const rows = document.querySelector(".terminal-host .xterm-rows") as HTMLElement | null;
    const measure = document.querySelector(".terminal-host .xterm-char-measure-element") as HTMLElement | null;
    const row = rows?.firstElementChild as HTMLElement | null;
    const rowStyle = rows ? window.getComputedStyle(rows) : null;
    const hostWidth = host?.getBoundingClientRect().width ?? 0;
    const hostHeight = host?.getBoundingClientRect().height ?? 0;
    const screenWidth = screen?.getBoundingClientRect().width ?? 0;
    const screenHeight = screen?.getBoundingClientRect().height ?? 0;
    const measureWidth = measure?.getBoundingClientRect().width ?? 0;
    const rowHeight = row?.getBoundingClientRect().height ?? 0;
    const letterSpacing = rowStyle ? Number.parseFloat(rowStyle.letterSpacing || "0") : 0;
    const cellWidth = (measureWidth / 32) + (Number.isFinite(letterSpacing) ? letterSpacing : 0);
    const cellHeight = rowHeight;
    const approxCols = cellWidth > 0 ? Math.round(screenWidth / cellWidth) : 0;
    const approxRows = cellHeight > 0 ? Math.round(screenHeight / cellHeight) : 0;

    return {
      approxCols,
      approxRows,
      cellHeight,
      cellWidth,
      hostHeight,
      hostWidth,
      screenHeight,
      screenWidth,
    };
  });

  const tabs = await server.zellij.listTabs(server.sessionName);
  const activeTab = tabs.find((tab) => tab.active) ?? tabs[0];
  const panes = activeTab
    ? await server.zellij.listPanes(server.sessionName, activeTab.index)
    : [];
  const activePane = panes.find((pane) => pane.active) ?? panes[0];
  const backendCols = activePane?.width ?? 0;
  const backendRows = activePane?.height ?? 0;

  return {
    ...geometry,
    backendCols,
    backendRows,
    pixelHeightDelta: Math.abs(geometry.screenHeight - (backendRows * geometry.cellHeight)),
    pixelWidthDelta: Math.abs(geometry.screenWidth - (backendCols * geometry.cellWidth)),
  };
};

const waitForRealZellijWidthInvariant = async (
  page: Page,
  server: StartedRealZellijE2EServer,
  label: string
): Promise<void> => {
  const deadline = Date.now() + 7_000;
  let settled = await readRealZellijWidthSnapshot(page, server);

  while (Date.now() < deadline) {
    const colsMismatch = Math.abs(settled.backendCols - settled.approxCols);
    const rowsMismatch = Math.abs(settled.backendRows - settled.approxRows);
    const widthOk = settled.pixelWidthDelta <= Math.max(settled.cellWidth * 1.5, 3);
    const heightOk = settled.pixelHeightDelta <= Math.max(settled.cellHeight * 1.5, 3);
    const ready =
      settled.hostWidth > 0 &&
      settled.hostHeight > 0 &&
      settled.screenWidth > 0 &&
      settled.screenHeight > 0 &&
      settled.backendCols > 1 &&
      settled.backendRows > 1 &&
      colsMismatch <= 1 &&
      rowsMismatch <= 1 &&
      widthOk &&
      heightOk;

    if (ready) {
      break;
    }

    await page.waitForTimeout(100);
    settled = await readRealZellijWidthSnapshot(page, server);
  }

  expect(settled.hostWidth).toBeGreaterThan(0);
  expect(settled.hostHeight).toBeGreaterThan(0);
  expect(settled.screenWidth).toBeGreaterThan(0);
  expect(settled.screenHeight).toBeGreaterThan(0);
  expect(settled.backendCols).toBeGreaterThan(1);
  expect(settled.backendRows).toBeGreaterThan(1);
  expect(Math.abs(settled.backendCols - settled.approxCols), label).toBeLessThanOrEqual(1);
  expect(Math.abs(settled.backendRows - settled.approxRows), label).toBeLessThanOrEqual(1);
  expect(settled.pixelWidthDelta, label).toBeLessThanOrEqual(Math.max(settled.cellWidth * 1.5, 3));
  expect(settled.pixelHeightDelta, label).toBeLessThanOrEqual(Math.max(settled.cellHeight * 1.5, 3));
};

test.describe("real zellij browser e2e", () => {
  test.skip(!canRunRealZellijE2E(), "REAL_ZELLIJ_E2E requires zellij and a staged bridge binary");
  let server: StartedRealZellijE2EServer;

  const captureActivePaneText = async (): Promise<string> => {
    const tabs = await server.zellij.listTabs(server.sessionName);
    const activeTab = tabs.find((tab) => tab.active) ?? tabs[0];
    if (!activeTab) {
      return "";
    }
    const panes = await server.zellij.listPanes(server.sessionName, activeTab.index);
    const activePane = panes.find((pane) => pane.active) ?? panes[0];
    if (!activePane) {
      return "";
    }
    const capture = await server.zellij.capturePane(activePane.id, { lines: 200 });
    return capture.text;
  };

  test.beforeAll(async () => {
    server = await startRealZellijE2EServer();
    await server.zellij.newTab(server.sessionName);
    await waitForTabCount(server.zellij, server.sessionName, 2);
    await server.zellij.selectTab(server.sessionName, 0);
    await waitForActiveTab(server.zellij, server.sessionName, 0);
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("shows the native bridge runtime badge without experimental copy", async ({ page }) => {
    await page.goto(`${server.baseUrl}/?token=${server.token}`);

    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    await expect(page.locator(".stream-badge.native")).toHaveText("native bridge");
    await expect(page.getByText("(experimental)")).toHaveCount(0);
  });

  test("focus sync follows an external zellij tab change", async ({ page }) => {
    await page.goto(`${server.baseUrl}/?token=${server.token}`);

    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    await expect(page.getByTestId("header-tab-button-0")).toHaveClass(/active/);

    await page.getByRole("button", { name: "Pinned to Web View" }).click();
    await expect(page.getByRole("button", { name: "Following Zellij" })).toBeVisible();

    await server.zellij.selectTab(server.sessionName, 1);
    await waitForActiveTab(server.zellij, server.sessionName, 1);

    await expect(page.getByTestId("header-tab-button-1")).toHaveClass(/active/, { timeout: 5_000 });
    await expect(page.getByTestId("header-tab-button-0")).not.toHaveClass(/active/);
  });

  test("browser width stays aligned with the real zellij pane width", async ({ page }) => {
    await page.setViewportSize({ width: 1464, height: 900 });
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    await expect(page.locator(".stream-badge.native")).toHaveText("native bridge");

    await waitForRealZellijWidthInvariant(page, server, "initial real zellij width");

    await page.getByTitle("Collapse sidebar").click();
    await waitForRealZellijWidthInvariant(page, server, "collapsed sidebar real zellij width");

    await page.setViewportSize({ width: 960, height: 720 });
    await waitForRealZellijWidthInvariant(page, server, "narrow desktop real zellij width");
  });
});
