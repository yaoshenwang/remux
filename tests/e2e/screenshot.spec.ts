import { expect, test } from "@playwright/test";
import { startE2EServer, type StartedE2EServer } from "./harness/test-server.js";

let server: StartedE2EServer | undefined;

test.beforeAll(async () => {
  server = await startE2EServer({ sessions: ["main"], defaultSession: "main" });
});

test.afterAll(async () => {
  if (server) {
    await server.stop();
  }
});

test("capture UI screenshot for PR preview", async ({ page }) => {
  await page.goto(`${server.baseUrl}/?token=${server.token}`);
  await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

  // Default is terminal mode — wait for terminal to render
  await expect(page.getByTestId("terminal-host")).toBeVisible();

  // Emit some sample content so the terminal isn't blank
  await expect.poll(() => server.ptyFactory.processes.length).toBeGreaterThan(0);
  server.ptyFactory.latestProcess().emitData("$ remux running\r\n");

  // Small delay for render
  await page.waitForTimeout(500);

  await page.screenshot({
    path: "screenshots/main-view.png",
    fullPage: true
  });
});

test("capture sidebar screenshot", async ({ page }) => {
  await page.goto(`${server.baseUrl}/?token=${server.token}`);
  await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

  // Sidebar is always visible on desktop
  await expect(page.locator(".sidebar")).toBeVisible();

  await page.screenshot({
    path: "screenshots/sidebar-view.png",
    fullPage: true
  });
});
