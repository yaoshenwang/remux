/**
 * E2E tests for Remux using Playwright.
 * Starts the server, loads the app in a real browser, and tests core flows.
 *
 * ghostty-web renders into a <canvas> so terminal content isn't readable from DOM.
 * We use the Inspect view to verify terminal output as plain text.
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

  // Collect stderr for debugging
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
        // Extra wait for WASM init to complete
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
    // Give process time to shut down gracefully
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.describe.serial("Remux E2E", () => {
  // ── 1. Page loads and shows terminal ──

  test("page loads and shows terminal", async ({ page }) => {
    await page.goto(BASE);
    await expect(page).toHaveTitle("Remux");

    // Terminal canvas should be visible (ghostty-web renders to canvas)
    const canvas = page.locator("#terminal canvas");
    await expect(canvas).toBeVisible({ timeout: 10000 });

    // Sidebar should show "main" session
    const sessionItem = page.locator(".session-item .name", { hasText: "main" });
    await expect(sessionItem).toBeVisible();
  });

  // ── 2. Live terminal interaction ──

  test("live terminal interaction via Inspect", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#terminal canvas")).toBeVisible({
      timeout: 10000,
    });

    // Wait for WebSocket to connect and terminal to be ready
    await page.waitForFunction(
      () =>
        window._remuxTerm &&
        document.querySelector("#status-dot")?.classList.contains("connected"),
      { timeout: 10000 },
    );

    // Type into the terminal — ghostty-web uses a hidden textarea for keyboard input
    const textarea = page.locator("#terminal textarea");
    await textarea.focus();
    await textarea.pressSequentially("echo e2e-test-output", { delay: 30 });
    await textarea.press("Enter");

    // Wait for shell to process the command
    await page.waitForTimeout(2000);

    // Switch to Inspect to read terminal content as text
    await page.locator("#btn-inspect").click();
    await expect(page.locator("#inspect")).toHaveClass(/visible/, {
      timeout: 5000,
    });

    // Wait for inspect data to arrive from server
    await page.waitForFunction(
      () => (window._inspectText || "").includes("e2e-test-output"),
      { timeout: 10000 },
    );

    const inspectText = await page.evaluate(() => window._inspectText);
    expect(inspectText).toContain("e2e-test-output");

    // Go back to Live
    await page.locator("#btn-live").click();
    await expect(page.locator("#terminal")).not.toHaveClass(/hidden/);
  });

  // ── 3. Inspect view ──

  test("inspect view shows content and meta", async ({ page }) => {
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

    // Click Inspect button
    await page.locator("#btn-inspect").click();
    await expect(page.locator("#inspect")).toHaveClass(/visible/, {
      timeout: 5000,
    });

    // Wait for inspect data
    await page.waitForFunction(() => !!window._inspectText, { timeout: 10000 });

    // Inspect panel should have text content
    const content = page.locator("#inspect-content");
    await expect(content).toBeVisible();

    // Meta info should contain session/tab reference
    const meta = page.locator("#inspect-meta");
    await expect(meta).toContainText("main");
    await expect(meta).toContainText("Tab");

    // Click Live to go back
    await page.locator("#btn-live").click();
    await expect(page.locator("#inspect")).not.toHaveClass(/visible/);
  });

  // ── 4. Session management ──

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

    // Listen for the prompt dialog and accept with session name
    page.on("dialog", (d) => d.accept("test-e2e-session"));

    // Click "+" to create a new session
    await page.locator("#btn-new-session").click();

    // Wait for the new session to appear in sidebar
    const newSession = page.locator(".session-item .name", {
      hasText: "test-e2e-session",
    });
    await expect(newSession).toBeVisible({ timeout: 5000 });

    // Delete the session — click the × button on its session-item
    const sessionItem = page.locator(".session-item", {
      has: page.locator('.name:text("test-e2e-session")'),
    });
    const delBtn = sessionItem.locator(".del");
    // The delete button may be hidden until hover
    await sessionItem.hover();
    await delBtn.click();

    // Expect the session to be removed
    await expect(newSession).not.toBeVisible({ timeout: 5000 });
  });

  // ── 5. Tab management ──

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

    // Count current tabs
    const tabList = page.locator("#tab-list");
    const initialCount = await tabList.locator(".tab").count();

    // Click "+" to create a new tab
    await page.locator("#btn-new-tab").click();

    // Wait for new tab to appear
    await expect(tabList.locator(".tab")).toHaveCount(initialCount + 1, { timeout: 5000 });

    // Close the last tab (click its × button)
    const lastTab = tabList.locator(".tab").last();
    await lastTab.hover();
    await lastTab.locator(".close").click({ force: true });

    // Tab count should return to initial
    await expect(tabList.locator(".tab")).toHaveCount(initialCount, { timeout: 5000 });
  });

  // ── 6. Theme toggle ──

  test("theme toggle switches dark/light", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#terminal canvas")).toBeVisible({
      timeout: 10000,
    });

    // Get initial theme
    const initialTheme = await page.getAttribute("html", "data-theme");
    expect(["dark", "light"]).toContain(initialTheme);

    // Click theme toggle
    await page.locator("#btn-theme").click();

    // Wait for theme to change (terminal recreates, so give it time)
    await page.waitForTimeout(1000);

    const newTheme = await page.getAttribute("html", "data-theme");
    expect(newTheme).not.toBe(initialTheme);
    expect(["dark", "light"]).toContain(newTheme);

    // Toggle back
    await page.locator("#btn-theme").click();
    await page.waitForTimeout(1000);

    const restoredTheme = await page.getAttribute("html", "data-theme");
    expect(restoredTheme).toBe(initialTheme);
  });

  // ── 7. Inspect search ──

  test("inspect search highlights matches", async ({ page }) => {
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

    // Switch to Inspect
    await page.locator("#btn-inspect").click();
    await expect(page.locator("#inspect")).toHaveClass(/visible/, {
      timeout: 5000,
    });

    // Wait for inspect data
    await page.waitForFunction(() => !!window._inspectText, { timeout: 10000 });

    // Type a search query that won't match anything
    const searchInput = page.locator("#inspect-search-input");
    await searchInput.fill("zzz-no-match-zzz");

    // Should show "No matches"
    const matchCount = page.locator("#inspect-match-count");
    await expect(matchCount).toHaveText("No matches");

    // Clear and search for something that exists (the shell prompt typically contains $)
    await searchInput.fill("");

    // Get the actual inspect text and search for a substring of it
    const inspectText = await page.evaluate(() => window._inspectText || "");
    // Find a short common substring to search for
    // The terminal likely has the user's home dir, shell prompt, etc.
    // Use a generic character that's almost certainly in any terminal output
    if (inspectText.length > 0) {
      // Search for first 3 printable chars from the inspect text
      const searchable = inspectText.replace(/\s+/g, " ").trim();
      const snippet = searchable.slice(0, 3);
      if (snippet.length >= 1) {
        await searchInput.fill(snippet);
        // Should show match count or highlight
        await expect(matchCount).not.toHaveText("");
        // Check for highlight marks in content
        const hasMarks = await page.evaluate(
          () =>
            document.querySelectorAll("#inspect-content mark").length > 0,
        );
        expect(hasMarks).toBe(true);
      }
    }
  });

  test("IME composition ignores viewport shrink on touch devices", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE}&debug=1`);
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
        const visualViewport = window.visualViewport;
        const viewportProto = visualViewport
          ? Object.getPrototypeOf(visualViewport)
          : null;
        const originalHeight =
          viewportProto &&
          Object.getOwnPropertyDescriptor(viewportProto, "height");
        const textarea = document.querySelector("#terminal textarea");
        const terminal = document.getElementById("terminal");
        const canvas = document.querySelector("#terminal canvas");

        if (
          !visualViewport ||
          !viewportProto ||
          !originalHeight ||
          !textarea ||
          !terminal ||
          !canvas
        ) {
          return {
            missing: {
              visualViewport: !!visualViewport,
              textarea: !!textarea,
              terminal: !!terminal,
              canvas: !!canvas,
            },
          };
        }

        const readLayout = () => ({
          bodyHeight: document.body.offsetHeight,
          bodyStyleHeight: document.body.style.height,
          terminalHeight: terminal.offsetHeight,
          canvasHeight: canvas.height,
        });

        const baseline = readLayout();

        try {
          textarea.focus();
          textarea.dispatchEvent(
            new CompositionEvent("compositionstart", {
              bubbles: true,
              data: "",
            }),
          );
          textarea.dispatchEvent(
            new CompositionEvent("compositionupdate", {
              bubbles: true,
              data: "zhong",
            }),
          );

          Object.defineProperty(viewportProto, "height", {
            configurable: true,
            get: () => 120,
          });
          visualViewport.dispatchEvent(new Event("resize"));
          await sleep(180);

          const composing = readLayout();

          textarea.dispatchEvent(
            new CompositionEvent("compositionend", {
              bubbles: true,
              data: "中文",
            }),
          );
          Object.defineProperty(viewportProto, "height", originalHeight);
          visualViewport.dispatchEvent(new Event("resize"));
          await sleep(180);

          return { baseline, composing, recovered: readLayout() };
        } finally {
          Object.defineProperty(viewportProto, "height", originalHeight);
        }
      });

      expect(snapshot.missing).toBeUndefined();
      expect(snapshot.baseline.bodyHeight).toBeGreaterThan(400);
      expect(snapshot.composing.bodyHeight).toBe(snapshot.baseline.bodyHeight);
      expect(snapshot.composing.bodyStyleHeight).toBe(
        snapshot.baseline.bodyStyleHeight,
      );
      expect(snapshot.composing.terminalHeight).toBe(
        snapshot.baseline.terminalHeight,
      );
      expect(snapshot.composing.canvasHeight).toBe(
        snapshot.baseline.canvasHeight,
      );
      expect(snapshot.recovered.bodyHeight).toBe(snapshot.baseline.bodyHeight);
      expect(snapshot.recovered.terminalHeight).toBe(
        snapshot.baseline.terminalHeight,
      );
    } finally {
      await context.close();
    }
  });

  test("desktop resize waits until composition ends before refit", async ({
    page,
  }) => {
    await page.goto(`${BASE}&debug=1`);
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
      const textarea = document.querySelector("#terminal textarea");
      const sidebar = document.getElementById("sidebar");
      const term = window._remuxTerm;

      if (!textarea || !sidebar || !term) {
        return {
          missing: {
            textarea: !!textarea,
            sidebar: !!sidebar,
            term: !!term,
          },
        };
      }

      const baseline = {
        cols: term.cols,
        rows: term.rows,
        sidebarCollapsed: sidebar.classList.contains("collapsed"),
      };

      textarea.focus();
      textarea.dispatchEvent(
        new CompositionEvent("compositionstart", {
          bubbles: true,
          data: "",
        }),
      );
      textarea.dispatchEvent(
        new CompositionEvent("compositionupdate", {
          bubbles: true,
          data: "nihon",
        }),
      );

      sidebar.classList.add("collapsed");
      await sleep(300);

      const composing = {
        cols: term.cols,
        rows: term.rows,
        sidebarCollapsed: sidebar.classList.contains("collapsed"),
      };

      textarea.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "日本語",
        }),
      );
      await sleep(400);

      const recovered = {
        cols: term.cols,
        rows: term.rows,
        sidebarCollapsed: sidebar.classList.contains("collapsed"),
      };

      sidebar.classList.remove("collapsed");
      await sleep(300);

      return { baseline, composing, recovered };
    });

    expect(snapshot.missing).toBeUndefined();
    expect(snapshot.composing.cols).toBe(snapshot.baseline.cols);
    expect(snapshot.composing.rows).toBe(snapshot.baseline.rows);
    expect(snapshot.recovered.cols).toBeGreaterThan(snapshot.baseline.cols);
    expect(snapshot.recovered.sidebarCollapsed).toBe(true);
  });
});
