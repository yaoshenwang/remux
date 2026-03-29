import { expect, test, type Page } from "@playwright/test";
import { startRuntimeV2E2EServer, type StartedRuntimeV2E2EServer } from "./harness/runtime-v2-server.js";

interface TerminalWidthSnapshot {
  appClassName: string;
  frontendCols: number;
  frontendRows: number;
  hostWidth: number;
  hostHeight: number;
  pxPerCol: number;
  pxPerRow: number;
}

const MIN_REASONABLE_CELL_WIDTH_PX = 4;
const MAX_REASONABLE_CELL_WIDTH_PX = 14;
const MIN_REASONABLE_CELL_HEIGHT_PX = 8;
const MAX_REASONABLE_CELL_HEIGHT_PX = 24;
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

const readTerminalHostWidth = async (page: Page): Promise<number> => page.evaluate(() => {
  const host = document.querySelector("[data-testid='terminal-host']") as HTMLElement | null;
  return host?.getBoundingClientRect().width ?? 0;
});

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
    const terminalGeometry = window.__remuxTestTerminal?.readGeometry() ?? null;
    const hostWidth = host?.getBoundingClientRect().width ?? 0;
    const hostHeight = host?.getBoundingClientRect().height ?? 0;
    const frontendCols = terminalGeometry?.cols ?? 0;
    const frontendRows = terminalGeometry?.rows ?? 0;

    return {
      appClassName: document.querySelector(".app-shell")?.className ?? "",
      frontendCols,
      frontendRows,
      hostWidth,
      hostHeight,
      pxPerCol: frontendCols > 0 ? hostWidth / frontendCols : 0,
      pxPerRow: frontendRows > 0 ? hostHeight / frontendRows : 0
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
    resizeCount
  };
};

const waitForTerminalWidthInvariant = async (
  page: Page,
  server: StartedRuntimeV2E2EServer,
  label: string,
  options: {
    expectedPxPerCol?: number;
    pxPerColTolerance?: number;
  } = {}
): Promise<TerminalWidthSnapshot & {
  backendCols: number;
  backendRows: number;
  resizeCount: number;
}> => {
  const { expectedPxPerCol, pxPerColTolerance = 2 } = options;
  const deadline = Date.now() + 7_000;
  let settled = await readTerminalWidthSnapshot(page, server);

  while (Date.now() < deadline) {
    const backendColsMismatch = Math.abs(settled.backendCols - settled.frontendCols);
    const backendRowsMismatch = Math.abs(settled.backendRows - settled.frontendRows);
    const pxPerColMismatch = expectedPxPerCol === undefined
      ? 0
      : Math.abs(settled.pxPerCol - expectedPxPerCol);
    const ready =
      settled.hostWidth > 0 &&
      settled.hostHeight > 0 &&
      settled.backendCols > 1 &&
      settled.backendRows > 1 &&
      settled.frontendCols > 1 &&
      settled.frontendRows > 1 &&
      backendColsMismatch <= 1 &&
      backendRowsMismatch <= 1 &&
      settled.pxPerCol >= MIN_REASONABLE_CELL_WIDTH_PX &&
      settled.pxPerCol <= MAX_REASONABLE_CELL_WIDTH_PX &&
      settled.pxPerRow >= MIN_REASONABLE_CELL_HEIGHT_PX &&
      settled.pxPerRow <= MAX_REASONABLE_CELL_HEIGHT_PX &&
      pxPerColMismatch <= pxPerColTolerance;

    if (ready) {
      break;
    }

    await page.waitForTimeout(100);
    settled = await readTerminalWidthSnapshot(page, server);
  }

  expect(settled.hostWidth).toBeGreaterThan(0);
  expect(settled.hostHeight).toBeGreaterThan(0);
  expect(settled.backendCols).toBeGreaterThan(1);
  expect(settled.backendRows).toBeGreaterThan(1);
  expect(settled.frontendCols, label).toBeGreaterThan(1);
  expect(settled.frontendRows, label).toBeGreaterThan(1);
  expect(Math.abs(settled.backendCols - settled.frontendCols), label).toBeLessThanOrEqual(1);
  expect(Math.abs(settled.backendRows - settled.frontendRows), label).toBeLessThanOrEqual(1);
  expect(settled.pxPerCol, label).toBeGreaterThanOrEqual(MIN_REASONABLE_CELL_WIDTH_PX);
  expect(settled.pxPerCol, label).toBeLessThanOrEqual(MAX_REASONABLE_CELL_WIDTH_PX);
  expect(settled.pxPerRow, label).toBeGreaterThanOrEqual(MIN_REASONABLE_CELL_HEIGHT_PX);
  expect(settled.pxPerRow, label).toBeLessThanOrEqual(MAX_REASONABLE_CELL_HEIGHT_PX);
  if (expectedPxPerCol !== undefined) {
    expect(Math.abs(settled.pxPerCol - expectedPxPerCol), label).toBeLessThanOrEqual(pxPerColTolerance);
  }

  return settled;
};

test.describe("terminal width invariants", () => {
  let server: StartedRuntimeV2E2EServer;

  test.beforeEach(async () => {
    server = await startRuntimeV2E2EServer();
  });

  test.afterEach(async () => {
    await server.stop();
  });

  test("does not fake a wide terminal on very narrow viewports", async ({ page }) => {
    await page.setViewportSize({ width: 150, height: 600 });
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expectAttachedStatus(page);
    await page.waitForTimeout(1_800);

    const settled = await waitForTerminalWidthInvariant(page, server, "narrow viewport");
    expect(settled.frontendCols).toBeLessThan(40);
    const resizes = server.upstream.latestTerminal()?.sizes ?? [];
    const firstNonDefaultResizeIndex = resizes.findIndex((entry) => entry.cols !== 80 || entry.rows !== 24);
    expect(firstNonDefaultResizeIndex).toBeGreaterThanOrEqual(0);
    expect(resizes.slice(firstNonDefaultResizeIndex + 1)).not.toContainEqual({ cols: 80, rows: 24 });
  });

  test("keeps backend cols aligned with visible terminal width across layout changes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expectAttachedStatus(page);

    const initial = await waitForTerminalWidthInvariant(page, server, "initial desktop");

    await page.getByTitle("Collapse sidebar").click();
    await expect.poll(() => readTerminalHostWidth(page)).toBeGreaterThan(initial.hostWidth + 100);
    const collapsed = await waitForTerminalWidthInvariant(page, server, "sidebar collapsed", {
      expectedPxPerCol: initial.pxPerCol
    });
    expect(collapsed.hostWidth).toBeGreaterThan(initial.hostWidth);
    expect(collapsed.frontendCols).toBeGreaterThan(initial.frontendCols + 8);

    await page.getByTitle("Expand sidebar").click();
    await expect.poll(() => readTerminalHostWidth(page)).toBeLessThan(collapsed.hostWidth - 100);
    const expanded = await waitForTerminalWidthInvariant(page, server, "sidebar expanded", {
      expectedPxPerCol: initial.pxPerCol
    });
    expect(expanded.hostWidth).toBeLessThan(collapsed.hostWidth);
    expect(Math.abs(expanded.frontendCols - initial.frontendCols)).toBeLessThanOrEqual(2);

    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.getByRole("heading", { name: "Inspect" })).toBeVisible();
    await page.getByRole("button", { name: "Live" }).click();
    const returned = await waitForTerminalWidthInvariant(page, server, "return from inspect", {
      expectedPxPerCol: initial.pxPerCol
    });
    expect(Math.abs(returned.frontendCols - expanded.frontendCols)).toBeLessThanOrEqual(2);

    await page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(() => readTerminalHostWidth(page)).toBeLessThan(expanded.hostWidth - 100);
    const narrowDesktop = await waitForTerminalWidthInvariant(page, server, "narrow desktop", {
      expectedPxPerCol: initial.pxPerCol
    });
    expect(narrowDesktop.hostWidth).toBeLessThan(expanded.hostWidth);
    expect(narrowDesktop.frontendCols).toBeLessThan(expanded.frontendCols - 8);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => {
      return document.querySelector(".app-shell")?.className ?? "";
    })).toContain("mobile-layout");
    await expect.poll(() => readTerminalHostWidth(page)).toBeLessThan(narrowDesktop.hostWidth - 100);
    const mobilePortrait = await waitForTerminalWidthInvariant(page, server, "mobile portrait", {
      expectedPxPerCol: initial.pxPerCol,
      pxPerColTolerance: 2.5
    });
    expect(mobilePortrait.appClassName).toContain("mobile-layout");
    expect(mobilePortrait.hostWidth).toBeLessThan(narrowDesktop.hostWidth);
    expect(mobilePortrait.frontendCols).toBeLessThan(narrowDesktop.frontendCols - 8);
  });
});
