import { expect, test } from "@playwright/test";
import { startE2EServer } from "./harness/test-server.js";

test.describe("inspect mode", () => {
  test("assembles current tab history from backend pane captures", async ({ page }) => {
    const server = await startE2EServer({ sessions: ["main"], defaultSession: "main" });

    try {
      const [initialPane] = await server.gateway.listPanes("main", 0);
      await server.gateway.splitPane(initialPane!.id, "right");
      const panes = await server.gateway.listPanes("main", 0);
      server.gateway.setPaneCapture(panes[0]!.id, "left pane output\nline 2");
      server.gateway.setPaneCapture(panes[1]!.id, "\u001b[31mright pane error\u001b[0m");

      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

      await page.getByRole("button", { name: "Inspect" }).click();

      await expect.poll(
        () => server.gateway.calls.filter((entry) => entry.startsWith("capturePane:")).length
      ).toBe(2);

      await expect(page.getByTestId("inspect-scope-badge")).toHaveText("Tab History");
      await expect(page.getByTestId("inspect-source-badge")).toHaveText("server timeline");
      await expect(page.getByTestId("inspect-precision-badge")).toHaveText("precise");
      await expect(page.getByTestId(`inspect-pane-${panes[0]!.id}`)).toContainText("left pane output");
      await expect(page.getByTestId(`inspect-pane-${panes[1]!.id}`)).toContainText("right pane error");
      await expect(page.getByTestId("inspect-events")).toContainText("Pane added");
    } finally {
      await page.goto("about:blank");
      await server.stop();
    }
  });

  test("supports pane filtering, search, refresh, and loading more history", async ({ page }) => {
    const server = await startE2EServer({ sessions: ["main"], defaultSession: "main" });

    try {
      const [initialPane] = await server.gateway.listPanes("main", 0);
      await server.gateway.splitPane(initialPane!.id, "right");
      const panes = await server.gateway.listPanes("main", 0);
      server.gateway.setPaneCapture(panes[0]!.id, "left compile ok");
      server.gateway.setPaneCapture(panes[1]!.id, "right fatal error");

      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

      await page.getByRole("button", { name: "Inspect" }).click();
      await expect(page.getByTestId(`inspect-pane-${panes[0]!.id}`)).toContainText("left compile ok");
      await expect(page.getByTestId(`inspect-pane-${panes[1]!.id}`)).toContainText("right fatal error");
      await expect(page.getByTestId("inspect-line-count-badge")).toHaveText("1000 lines");
      await expect(page.getByTestId("inspect-source-badge")).toHaveText("server timeline");

      await page.getByTestId(`inspect-pane-filter-${panes[1]!.id}`).click();
      await expect(page.getByTestId(`inspect-pane-${panes[0]!.id}`)).toHaveCount(0);
      await expect(page.getByTestId(`inspect-pane-${panes[1]!.id}`)).toContainText("right fatal error");

      await page.getByTestId("inspect-search-input").fill("fatal");
      await expect(page.getByTestId(`inspect-pane-${panes[1]!.id}`)).toContainText("right fatal error");

      server.gateway.setPaneCapture(panes[1]!.id, "right fatal error refreshed");
      await page.getByTestId("inspect-refresh-button").click();
      await expect(page.getByTestId(`inspect-pane-${panes[1]!.id}`)).toContainText("right fatal error refreshed");

      await page.getByTestId("inspect-load-more-button").click();
      await expect(page.getByTestId("inspect-line-count-badge")).toHaveText("2000 lines");
      await expect.poll(
        () => server.gateway.calls.filter((entry) => entry === `capturePane:${panes[0]!.id}:2000`).length
      ).toBeGreaterThan(0);
      await expect.poll(
        () => server.gateway.calls.filter((entry) => entry === `capturePane:${panes[1]!.id}:2000`).length
      ).toBeGreaterThan(0);
    } finally {
      await page.goto("about:blank");
      await server.stop();
    }
  });
});
