import { expect, test } from "@playwright/test";
import { startRuntimeV2E2EServer, type StartedRuntimeV2E2EServer } from "./harness/runtime-v2-server.js";

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

  test("renders the runtime-v2 workspace without legacy backend switching or console errors", async ({ page }) => {
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

  test("compose input and inspect both go through the runtime-v2 gateway path", async ({ page }) => {
    server.upstream.setPaneContent("pane-1", "build running\nline 2");
    const newPaneId = server.upstream.splitActivePane();
    server.upstream.setPaneContent(newPaneId, "tests passed");

    await page.goto(`${server.baseUrl}/?token=${server.token}`);
    await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

    await page.getByTestId("compose-input").fill("echo hi");
    await page.getByTestId("compose-input").press("Enter");

    await expect
      .poll(() => server.upstream.latestTerminal()?.writes.join("") ?? "")
      .toContain("echo hi");

    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.getByTestId("inspect-scope-badge")).toHaveText("Tab History");
    await expect(page.getByTestId("inspect-source-badge")).toHaveText("server timeline");
    await expect(page.getByTestId("inspect-precision-badge")).toHaveText("approximate");
    await expect(page.getByTestId("inspect-pane-pane-1")).toContainText("build running");
    await expect(page.getByTestId(`inspect-pane-${newPaneId}`)).toContainText("tests passed");
  });
});
