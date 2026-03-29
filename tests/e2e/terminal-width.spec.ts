import { expect, test, type Page } from "@playwright/test";
import { startRuntimeV2E2EServer, type StartedRuntimeV2E2EServer } from "./harness/runtime-v2-server.js";

interface TerminalWidthSnapshot {
  appClassName: string;
  approxCols: number;
  approxRows: number;
  frontendCols: number;
  frontendRows: number;
  cellHeight: number;
  cellWidth: number;
  hostWidth: number;
  hostHeight: number;
  pixelWidthDelta: number;
  pixelHeightDelta: number;
  screenWidth: number;
  screenHeight: number;
}

const VIEWPORT_COL_TOLERANCE = 3;
const VIEWPORT_ROW_TOLERANCE = 1;
const expectAttachedStatus = async (page: Page): Promise<void> => {
  await expect.poll(() => page.evaluate(() => {
    const indicator = document.querySelector("[aria-label^='Status: ']") as HTMLElement | null;
    if (!indicator) {
      return "";
    }
    return `${indicator.className}|${indicator.getAttribute("aria-label") ?? ""}`;
  })).toContain("attached:");

  await expect.poll(() => page.evaluate(() => {
    const indicator = document.querySelector("[aria-label^='Status: ']") as HTMLElement | null;
    return indicator?.className ?? "";
  })).toContain("ok");
};

const readTerminalWidthSnapshot = async (
  page: Page,
  server: StartedRuntimeV2E2EServer
): Promise<TerminalWidthSnapshot & {
  backendCols: number;
  backendRows: number;
  resizeCount: number;
}> => {
  const geometry = await page.evaluate(() => {
    const host = document.querySelector("[data-testid='terminal-host']") as HTMLElement | null;
    const viewport = document.querySelector(".terminal-host .xterm-viewport") as HTMLElement | null;
    const screen = document.querySelector(".terminal-host .xterm-screen") as HTMLElement | null;
    const renderSurfaces = Array.from(
      document.querySelectorAll(".terminal-host .xterm-screen, .terminal-host .xterm-viewport, .terminal-host canvas")
    ) as HTMLElement[];
    const rows = document.querySelector(".terminal-host .xterm-rows") as HTMLElement | null;
    const measure = document.querySelector(".terminal-host .xterm-char-measure-element") as HTMLElement | null;
    const row = rows?.firstElementChild as HTMLElement | null;
    const rowStyle = rows ? window.getComputedStyle(rows) : null;
    const terminalGeometry = window.__remuxTestTerminal?.readGeometry() ?? null;
    const hostWidth = host?.getBoundingClientRect().width ?? 0;
    const hostHeight = host?.getBoundingClientRect().height ?? 0;
    const screenWidth = renderSurfaces.reduce((maxWidth, node) => {
      return Math.max(maxWidth, node.getBoundingClientRect().width);
    }, 0);
    const screenHeight = renderSurfaces.reduce((maxHeight, node) => {
      return Math.max(maxHeight, node.getBoundingClientRect().height);
    }, 0);
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
      frontendCols: terminalGeometry?.cols ?? 0,
      frontendRows: terminalGeometry?.rows ?? 0,
      cellHeight,
      cellWidth,
      hostWidth,
      hostHeight,
      screenWidth,
      screenHeight
    };
  });

  const latestResize = server.upstream.latestTerminal()?.sizes.at(-1);
  const backendCols = latestResize?.cols ?? 0;
  const backendRows = latestResize?.rows ?? 0;
  const resizeCount = server.upstream.latestTerminal()?.sizes.length ?? 0;

  return {
    ...geometry,
    backendCols,
    backendRows,
    pixelHeightDelta: Math.abs(geometry.screenHeight - (geometry.frontendRows * geometry.cellHeight)),
    pixelWidthDelta: Math.abs(geometry.screenWidth - (geometry.frontendCols * geometry.cellWidth)),
    resizeCount
  };
};

const waitForTerminalWidthInvariant = async (
  page: Page,
  server: StartedRuntimeV2E2EServer,
  label: string
): Promise<void> => {
  const deadline = Date.now() + 7_000;
  let settled = await readTerminalWidthSnapshot(page, server);

  while (Date.now() < deadline) {
    const backendColsMismatch = Math.abs(settled.backendCols - settled.frontendCols);
    const backendRowsMismatch = Math.abs(settled.backendRows - settled.frontendRows);
    const viewportColsMismatch = Math.abs(settled.frontendCols - settled.approxCols);
    const viewportRowsMismatch = Math.abs(settled.frontendRows - settled.approxRows);
    const ready =
      settled.hostWidth > 0 &&
      settled.hostHeight > 0 &&
      settled.screenWidth > 0 &&
      settled.screenHeight > 0 &&
      settled.backendCols > 1 &&
      settled.backendRows > 1 &&
      settled.frontendCols > 1 &&
      settled.frontendRows > 1 &&
      backendColsMismatch <= 1 &&
      backendRowsMismatch <= 1 &&
      viewportColsMismatch <= VIEWPORT_COL_TOLERANCE &&
      viewportRowsMismatch <= VIEWPORT_ROW_TOLERANCE;

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
  expect(settled.frontendCols, label).toBeGreaterThan(1);
  expect(settled.frontendRows, label).toBeGreaterThan(1);
  expect(Math.abs(settled.backendCols - settled.frontendCols), label).toBeLessThanOrEqual(1);
  expect(Math.abs(settled.backendRows - settled.frontendRows), label).toBeLessThanOrEqual(1);
  expect(Math.abs(settled.frontendCols - settled.approxCols), label).toBeLessThanOrEqual(VIEWPORT_COL_TOLERANCE);
  expect(Math.abs(settled.frontendRows - settled.approxRows), label).toBeLessThanOrEqual(VIEWPORT_ROW_TOLERANCE);
};

test.describe("terminal width invariants", () => {
  let server: StartedRuntimeV2E2EServer;

  test.beforeAll(async () => {
    server = await startRuntimeV2E2EServer();
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("does not fake a wide terminal on very narrow viewports", async ({ page }) => {
    await page.setViewportSize({ width: 150, height: 600 });
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expectAttachedStatus(page);
    await page.waitForTimeout(1_800);

    await waitForTerminalWidthInvariant(page, server, "narrow viewport");
    const resizes = server.upstream.latestTerminal()?.sizes ?? [];
    const firstNonDefaultResizeIndex = resizes.findIndex((entry) => entry.cols !== 80 || entry.rows !== 24);
    expect(firstNonDefaultResizeIndex).toBeGreaterThanOrEqual(0);
    expect(resizes.slice(firstNonDefaultResizeIndex + 1)).not.toContainEqual({ cols: 80, rows: 24 });
  });

  test("keeps backend cols aligned with visible terminal width across layout changes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expectAttachedStatus(page);

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
