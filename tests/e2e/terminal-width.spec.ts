import { expect, test, type Page } from "@playwright/test";
import { startE2EServer, type StartedE2EServer } from "./harness/test-server.js";

interface TerminalWidthSnapshot {
  appClassName: string;
  approxCols: number;
  approxRows: number;
  cellHeight: number;
  cellWidth: number;
  hostWidth: number;
  hostHeight: number;
  pixelWidthDelta: number;
  pixelHeightDelta: number;
  screenWidth: number;
  screenHeight: number;
}

const readTerminalWidthSnapshot = async (
  page: Page,
  server: StartedE2EServer
): Promise<TerminalWidthSnapshot & {
  backendCols: number;
  backendRows: number;
  resizeCount: number;
}> => {
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
      appClassName: document.querySelector(".app-shell")?.className ?? "",
      approxCols,
      approxRows,
      cellHeight,
      cellWidth,
      hostWidth,
      hostHeight,
      screenWidth,
      screenHeight
    };
  });

  const latestResize = server.ptyFactory.latestProcess().resizes.at(-1);
  const backendCols = latestResize?.cols ?? 0;
  const backendRows = latestResize?.rows ?? 0;

  return {
    ...geometry,
    backendCols,
    backendRows,
    pixelHeightDelta: Math.abs(geometry.screenHeight - (backendRows * geometry.cellHeight)),
    pixelWidthDelta: Math.abs(geometry.screenWidth - (backendCols * geometry.cellWidth)),
    resizeCount: server.ptyFactory.latestProcess().resizes.length
  };
};

const waitForTerminalWidthInvariant = async (
  page: Page,
  server: StartedE2EServer,
  label: string
): Promise<void> => {
  const deadline = Date.now() + 7_000;
  let settled = await readTerminalWidthSnapshot(page, server);

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
    settled = await readTerminalWidthSnapshot(page, server);
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

test.describe("terminal width invariants", () => {
  let server: StartedE2EServer;

  test.beforeAll(async () => {
    server = await startE2EServer({ sessions: ["main"], defaultSession: "main" });
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("does not fake a wide terminal on very narrow viewports", async ({ page }) => {
    await page.setViewportSize({ width: 150, height: 600 });
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    await page.waitForTimeout(1_800);

    await waitForTerminalWidthInvariant(page, server, "narrow viewport");
    const resizes = server.ptyFactory.latestProcess().resizes;
    const firstNonDefaultResizeIndex = resizes.findIndex((entry) => entry.cols !== 80 || entry.rows !== 24);
    expect(firstNonDefaultResizeIndex).toBeGreaterThanOrEqual(0);
    expect(resizes.slice(firstNonDefaultResizeIndex + 1)).not.toContainEqual({ cols: 80, rows: 24 });
  });

  test("keeps backend cols aligned with visible terminal width across layout changes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    await waitForTerminalWidthInvariant(page, server, "initial desktop");

    await page.getByTitle("Collapse sidebar").click();
    await waitForTerminalWidthInvariant(page, server, "sidebar collapsed");

    await page.getByTitle("Expand sidebar").click();
    await waitForTerminalWidthInvariant(page, server, "sidebar expanded");

    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.getByRole("heading", { name: "Inspect" })).toBeVisible();
    await page.getByRole("button", { name: "Live" }).click();
    await waitForTerminalWidthInvariant(page, server, "return from inspect");

    await page.setViewportSize({ width: 900, height: 700 });
    await waitForTerminalWidthInvariant(page, server, "narrow desktop");

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForTerminalWidthInvariant(page, server, "mobile portrait");
  });
});
