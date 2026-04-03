/**
 * E2E tests for Remux emergency-mode web client.
 * Read-only terminal display + compose input + session/tab management.
 */

import { test, expect } from "@playwright/test";
import { spawn } from "child_process";

const PORT = 29876;
const TOKEN = "e2e-test-token";
const BASE = `http://localhost:${PORT}/?token=${TOKEN}`;

let server;

test.beforeAll(async () => {
  server = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      REMUX_TOKEN: TOKEN,
      REMUX_INSTANCE_ID: "e2e-test",
    },
    stdio: "pipe",
    cwd: process.cwd(),
  });

  server.stderr.on("data", (d) => {
    const msg = d.toString();
    if (msg.includes("Error") || msg.includes("error")) {
      console.error("[server stderr]", msg);
    }
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Server start timeout (15s)")),
      15000,
    );
    server.stdout.on("data", (d) => {
      if (d.toString().includes("Remux running")) {
        clearTimeout(timeout);
        setTimeout(resolve, 3000);
      }
    });
    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
});

test.afterAll(async () => {
  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.describe.serial("Remux E2E", () => {
  // ── 1. Page loads and shows terminal + compose input ──

  test("page loads and shows terminal with compose input", async ({ page }) => {
    await page.goto(BASE);
    await expect(page).toHaveTitle("Remux");

    // Terminal canvas should be visible
    const canvas = page.locator("#terminal canvas");
    await expect(canvas).toBeVisible({ timeout: 10000 });

    // Sidebar should show "main" session
    const sessionItem = page.locator(".session-item .name", { hasText: "main" });
    await expect(sessionItem).toBeVisible();

    // Compose input should be visible (emergency mode)
    await expect(page.locator("#cmd-input")).toBeVisible();
    await expect(page.locator("#btn-send")).toBeVisible();
    await expect(page.locator("#btn-preset-toggle")).toBeVisible();

    // Old features should NOT be present
    await expect(page.locator("#btn-inspect")).toHaveCount(0);
    await expect(page.locator("#btn-workspace")).toHaveCount(0);
    await expect(page.locator("#devices-section")).toHaveCount(0);
    await expect(page.locator("#btn-role")).toHaveCount(0);
  });

  // ── 2. Compose input sends commands ──

  test("compose input sends command to terminal", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#terminal canvas")).toBeVisible({
      timeout: 10000,
    });

    await page.waitForFunction(
      () =>
        window._remuxTerm &&
        document.querySelector("#status-dot")?.classList.contains("connected"),
      { timeout: 10000 },
    );

    // Type a command in compose input
    const cmdInput = page.locator("#cmd-input");
    await cmdInput.fill("echo e2e-compose-test");

    // Click Send
    await page.locator("#btn-send").click();

    // Input should be cleared after send
    await expect(cmdInput).toHaveValue("");

    // Wait for terminal to process (we can't read canvas, but verify no crash)
    await page.waitForTimeout(2000);

    // Terminal should still be visible
    await expect(page.locator("#terminal canvas")).toBeVisible();
  });

  // ── 3. Compose input sends on Enter key ──

  test("compose input sends on Enter", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#terminal canvas")).toBeVisible({
      timeout: 10000,
    });

    await page.waitForFunction(
      () =>
        window._remuxTerm &&
        document.querySelector("#status-dot")?.classList.contains("connected"),
      { timeout: 10000 },
    );

    const cmdInput = page.locator("#cmd-input");
    await cmdInput.fill("echo enter-test");
    await cmdInput.press("Enter");

    await expect(cmdInput).toHaveValue("");
  });

  // ── 4. Preset quick keys toggle ──

  test("preset bar toggles on button click", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#terminal canvas")).toBeVisible({
      timeout: 10000,
    });

    // Preset bar should be hidden by default
    await expect(page.locator("#preset-bar")).not.toHaveClass(/visible/);

    // Click toggle button
    await page.locator("#btn-preset-toggle").click();
    await expect(page.locator("#preset-bar")).toHaveClass(/visible/);

    // Click again to hide
    await page.locator("#btn-preset-toggle").click();
    await expect(page.locator("#preset-bar")).not.toHaveClass(/visible/);
  });

  // ── 5. Session management ──

  test("create and delete session", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#terminal canvas")).toBeVisible({
      timeout: 10000,
    });
    await page.waitForFunction(
      () =>
        window._remuxTerm &&
        document.querySelector("#status-dot")?.classList.contains("connected"),
      { timeout: 10000 },
    );

    await page.locator("#btn-new-session").click();
    await page.locator("#new-session-input").fill("test-e2e-session");
    await page.locator("#btn-create-session").click();

    const newSession = page.locator(".session-item .name", {
      hasText: "test-e2e-session",
    });
    await expect(newSession).toBeVisible({ timeout: 5000 });

    const sessionItem = page.locator(".session-item", {
      has: page.locator('.name:text("test-e2e-session")'),
    });
    const delBtn = sessionItem.locator(".del");
    await sessionItem.hover();
    await delBtn.click();

    await expect(newSession).not.toBeVisible({ timeout: 5000 });
  });

  // ── 6. Tab management ──

  test("create and close tab", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#terminal canvas")).toBeVisible({
      timeout: 10000,
    });
    await page.waitForFunction(
      () =>
        window._remuxTerm &&
        document.querySelector("#status-dot")?.classList.contains("connected"),
      { timeout: 10000 },
    );

    const tabList = page.locator("#tab-list");
    const initialCount = await tabList.locator(".tab").count();

    await page.locator("#btn-new-tab").click();

    await expect(tabList.locator(".tab")).toHaveCount(initialCount + 1, { timeout: 5000 });

    const lastTab = tabList.locator(".tab").last();
    await lastTab.hover();
    await lastTab.locator(".close").click({ force: true });

    await expect(tabList.locator(".tab")).toHaveCount(initialCount, { timeout: 5000 });
  });

  // ── 7. Theme toggle ──

  test("theme toggle switches dark/light", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#terminal canvas")).toBeVisible({
      timeout: 10000,
    });

    const initialTheme = await page.getAttribute("html", "data-theme");
    expect(["dark", "light"]).toContain(initialTheme);

    await page.locator("#btn-theme").click();
    await page.waitForTimeout(1000);

    const newTheme = await page.getAttribute("html", "data-theme");
    expect(newTheme).not.toBe(initialTheme);
    expect(["dark", "light"]).toContain(newTheme);

    await page.locator("#btn-theme").click();
    await page.waitForTimeout(1000);

    const restoredTheme = await page.getAttribute("html", "data-theme");
    expect(restoredTheme).toBe(initialTheme);
  });

  // ── 8. Mobile compose input visible ──

  test("mobile view shows compose input and preset toggle", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 664 },
    });
    const page = await context.newPage();

    try {
      await page.goto(BASE);
      await expect(page.locator("#terminal canvas")).toBeVisible({
        timeout: 10000,
      });
      await page.waitForFunction(
        () =>
          window._remuxTerm &&
          document.querySelector("#status-dot")?.classList.contains("connected"),
        { timeout: 10000 },
      );

      // Compose input should be visible
      await expect(page.locator("#cmd-input")).toBeVisible();
      await expect(page.locator("#btn-send")).toBeVisible();
      await expect(page.locator("#btn-preset-toggle")).toBeVisible();

      // Old features should NOT be present
      await expect(page.locator("#btn-role")).toHaveCount(0);
      await expect(page.locator("#devices-section")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // ── 9. Preset keys send sequences ──

  test("preset quick keys send sequences", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#terminal canvas")).toBeVisible({
      timeout: 10000,
    });
    await page.waitForFunction(
      () =>
        window._remuxTerm &&
        document.querySelector("#status-dot")?.classList.contains("connected"),
      { timeout: 10000 },
    );

    // Open preset bar
    await page.locator("#btn-preset-toggle").click();
    await expect(page.locator("#preset-bar")).toHaveClass(/visible/);

    // Click Ctrl+C — should not crash
    await page.locator('[data-seq="ctrl-c"]').click();
    await page.waitForTimeout(500);

    // Terminal should still be visible
    await expect(page.locator("#terminal canvas")).toBeVisible();

    // Click up arrow
    await page.locator('[data-seq="up"]').click();
    await page.waitForTimeout(500);
    await expect(page.locator("#terminal canvas")).toBeVisible();
  });

  // ── 10. Desktop viewport resize refit ──

  test("desktop resize triggers terminal refit", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#terminal canvas")).toBeVisible({
      timeout: 10000,
    });
    await page.waitForFunction(
      () =>
        window._remuxTerm &&
        document.querySelector("#status-dot")?.classList.contains("connected"),
      { timeout: 10000 },
    );

    const snapshot = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const sidebar = document.getElementById("sidebar");
      const term = window._remuxTerm;

      if (!sidebar || !term) {
        return { missing: { sidebar: !!sidebar, term: !!term } };
      }

      const baseline = { cols: term.cols, rows: term.rows };

      // Toggle sidebar to trigger resize
      sidebar.classList.add("collapsed");
      await sleep(400);

      const after = { cols: term.cols, rows: term.rows };

      sidebar.classList.remove("collapsed");
      await sleep(400);

      return { baseline, after };
    });

    expect(snapshot.missing).toBeUndefined();
    // After collapsing sidebar, terminal should have more columns
    expect(snapshot.after.cols).toBeGreaterThan(snapshot.baseline.cols);
  });
});
