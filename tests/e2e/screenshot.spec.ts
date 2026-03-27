import { expect, test } from "@playwright/test";
import { startRuntimeV2E2EServer, type StartedRuntimeV2E2EServer } from "./harness/runtime-v2-server.js";

let server: StartedRuntimeV2E2EServer | undefined;

test.beforeAll(async () => {
  server = await startRuntimeV2E2EServer();
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
  server.upstream.setPaneContent("pane-1", "$ remuxd running\r\n");
  await page.reload();
  await expect(page.getByTestId("terminal-host")).toBeVisible();

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
