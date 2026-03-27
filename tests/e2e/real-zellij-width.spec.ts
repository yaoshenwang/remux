import { expect, test, type Page } from "@playwright/test";
import {
  canRunRealZellijE2E,
  startRealZellijE2EServer,
  waitForActiveTab,
  waitForTabCount,
} from "./harness/real-zellij-server.js";

interface RealZellijWidthSnapshot {
  approxCols: number;
  approxRows: number;
  heightFillRatio: number;
  hostFillRatio: number;
  hostHeight: number;
  hostWidth: number;
  screenHeight: number;
  screenWidth: number;
}

const readRealZellijWidthSnapshot = async (
  page: Page
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
      hostHeight,
      hostWidth,
      screenHeight,
      screenWidth,
    };
  });

  return {
    ...geometry,
    heightFillRatio: geometry.hostHeight > 0 ? geometry.screenHeight / geometry.hostHeight : 0,
    hostFillRatio: geometry.hostWidth > 0 ? geometry.screenWidth / geometry.hostWidth : 0,
  };
};

const waitForRealZellijWidthInvariant = async (
  page: Page,
  label: string
): Promise<void> => {
  const deadline = Date.now() + 7_000;
  let settled = await readRealZellijWidthSnapshot(page);

  while (Date.now() < deadline) {
    const ready =
      settled.hostWidth > 0 &&
      settled.hostHeight > 0 &&
      settled.screenWidth > 0 &&
      settled.screenHeight > 0 &&
      settled.approxCols > 1 &&
      settled.approxRows > 1 &&
      settled.hostFillRatio >= 0.9 &&
      settled.heightFillRatio >= 0.9;

    if (ready) {
      break;
    }

    await page.waitForTimeout(100);
    settled = await readRealZellijWidthSnapshot(page);
  }

  expect(settled.hostWidth).toBeGreaterThan(0);
  expect(settled.hostHeight).toBeGreaterThan(0);
  expect(settled.screenWidth).toBeGreaterThan(0);
  expect(settled.screenHeight).toBeGreaterThan(0);
  expect(settled.approxCols).toBeGreaterThan(1);
  expect(settled.approxRows).toBeGreaterThan(1);
  expect(settled.hostFillRatio, label).toBeGreaterThanOrEqual(0.9);
  expect(settled.heightFillRatio, label).toBeGreaterThanOrEqual(0.9);
};

test.describe("real zellij width browser e2e", () => {
  test.skip(!canRunRealZellijE2E(), "REAL_ZELLIJ_E2E requires zellij and a staged bridge binary");

  test("browser width stays aligned with the visible terminal host", async ({ page }) => {
    test.setTimeout(60_000);
    const server = await startRealZellijE2EServer({
      externalClientCols: 48,
      externalClientRows: 46
    });

    try {
      await server.zellij.newTab(server.sessionName);
      await waitForTabCount(server.zellij, server.sessionName, 2);
      await server.zellij.selectTab(server.sessionName, 0);
      await waitForActiveTab(server.zellij, server.sessionName, 0);

      await page.setViewportSize({ width: 1464, height: 900 });
      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
      await expect(page.locator(".stream-badge.native")).toHaveText("native bridge");

      await waitForRealZellijWidthInvariant(page, "initial real zellij width");

      await page.getByTitle("Collapse sidebar").click();
      await waitForRealZellijWidthInvariant(page, "collapsed sidebar real zellij width");

      await page.setViewportSize({ width: 960, height: 720 });
      await waitForRealZellijWidthInvariant(page, "narrow desktop real zellij width");
    } finally {
      await page.goto("about:blank");
      await server.stop();
    }
  });
});
