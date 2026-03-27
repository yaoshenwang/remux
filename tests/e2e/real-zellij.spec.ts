import { expect, test } from "@playwright/test";
import {
  canRunRealZellijE2E,
  startRealZellijE2EServer,
  type StartedRealZellijE2EServer,
  waitForActiveTab,
  waitForTabCount,
} from "./harness/real-zellij-server.js";

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
});
