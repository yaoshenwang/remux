import { expect, test } from "@playwright/test";
import { startE2EServer, type StartedE2EServer } from "./harness/test-server.js";

test.describe("remux browser behavior", () => {
  test.describe("auto attach + drawer + terminal", () => {
    let server: StartedE2EServer;

    test.beforeAll(async () => {
      server = await startE2EServer({ sessions: ["main"], defaultSession: "main" });
    });

    test.afterAll(async () => {
      await server.stop();
    });

    test("auto-attaches and renders terminal viewport", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
      await expect(page.locator(".tab.active .tab-label")).toBeVisible();
      await expect(page.getByTestId("session-picker-overlay")).toHaveCount(0);

      await expect.poll(() => server.ptyFactory.processes.length).toBeGreaterThan(0);
      server.ptyFactory.latestProcess().emitData("hello from e2e\r\n");

      // Default is terminal mode — wait for terminal to be visible
      await expect(page.getByTestId("terminal-host")).toBeVisible();
      const hostBox = await page.getByTestId("terminal-host").boundingBox();
      expect(hostBox?.height ?? 0).toBeGreaterThan(120);

      const [screenWidth, screenHeight] = await page.evaluate(() => {
        const screen = document.querySelector(".terminal-host .xterm-screen") as HTMLElement | null;
        if (!screen) {
          return [0, 0] as const;
        }
        const rect = screen.getBoundingClientRect();
        return [rect.width, rect.height] as const;
      });

      expect(screenWidth).toBeGreaterThan(40);
      expect(screenHeight).toBeGreaterThan(40);
      await expect(page.getByTestId("top-status-indicator")).not.toHaveClass(/error/);
      await expect(page.getByTestId("compose-bar")).toBeVisible();
      await expect(page.getByTestId("compose-input")).toBeVisible();
    });

    test("loads without browser console errors", async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });

      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
      await page.waitForTimeout(250);

      expect(consoleErrors).toEqual([]);
    });

    test("compose Enter sends immediately without inserting an extra newline", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

      const process = server.ptyFactory.latestProcess();
      await page.getByTestId("compose-input").fill("echo hi");
      await page.getByTestId("compose-input").press("Enter");

      await expect.poll(() => process.writes).toContain("echo hi\r");
      expect(process.writes.filter((entry) => entry === "\r")).toHaveLength(0);
      await expect(page.getByTestId("compose-input")).toHaveValue("");
    });

    test("terminal paste works directly in terminal mode", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "clipboard permissions are only configured for chromium here");
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: server.baseUrl
      });

      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

      await page.evaluate(async () => {
        await navigator.clipboard.writeText("from-clipboard");
      });
      await page.getByTestId("terminal-host").click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");

      await expect.poll(() => server.ptyFactory.latestProcess().writes).toContain("from-clipboard");
    });

    test("sidebar is always visible on desktop and preserves section spacing", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

      // Sidebar is always visible on desktop — no toggle needed
      await expect(page.locator(".sidebar")).toBeVisible();

      const sessionGap = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="sessions-list"]');
        const last = list?.querySelector("li:last-child button") as HTMLElement | null;
        const action = document.querySelector(
          '[data-testid="new-session-button"]'
        ) as HTMLElement | null;
        if (!last || !action) {
          return -1;
        }
        return action.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
      });

      expect(sessionGap).toBeGreaterThan(2);

      // On mobile, sidebar slides in/out via toggle
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId("drawer-toggle").click();
      await expect(page.locator(".sidebar.open")).toBeVisible();
      await page.getByTestId("drawer-close").click();
      await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
    });

    test("viewport changes propagate terminal resize to the backend", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

      const process = server.ptyFactory.latestProcess();
      await expect.poll(() => process.resizes.length).toBeGreaterThan(0);
      const initialResizeCount = process.resizes.length;
      const initialResize = process.resizes.at(-1);
      expect(initialResize).toBeDefined();

      await page.setViewportSize({ width: 900, height: 700 });

      await expect.poll(() => process.resizes.length).toBeGreaterThan(initialResizeCount);
      await expect
        .poll(() => {
          const latest = process.resizes.at(-1);
          return latest ? `${latest.cols}x${latest.rows}` : "";
        })
        .not.toBe(`${initialResize!.cols}x${initialResize!.rows}`);
    });

    test("inline session close control closes the active session and reattaches to the remaining one", async ({ page }) => {
      const localServer = await startE2EServer({ sessions: ["main", "work"], defaultSession: "main" });

      try {
        await page.goto(`${localServer.baseUrl}/?token=${localServer.token}`);
        await expect(page.getByTestId("session-picker-overlay")).toBeVisible();
        await page.getByTestId("session-picker-overlay").getByRole("button", { name: "main" }).click();
        await expect(page.getByTestId("session-picker-overlay")).toHaveCount(0);

        // Sidebar is visible on desktop — no toggle needed
        await page.getByTestId("close-session-main").click();

        await expect(page.locator(".tab.active .tab-label")).toBeVisible();

        await expect(page.getByTestId("sessions-list")).toContainText("work");
        await expect(page.getByTestId("sessions-list")).not.toContainText("main");
      } finally {
        await page.goto("about:blank");
        await localServer.stop();
      }
    });

    test("drawer keeps close controls touch friendly without showing reorder chrome", async ({ page }) => {
      const localServer = await startE2EServer({ sessions: ["main", "work"], defaultSession: "main" });

      try {
        await localServer.gateway.newTab("main");
        await localServer.gateway.selectTab("main", 0);

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${localServer.baseUrl}/?token=${localServer.token}`);
        await expect(page.getByTestId("session-picker-overlay")).toBeVisible();
        await page.getByTestId("session-picker-overlay").getByRole("button", { name: "main" }).click();
        await page.getByTestId("drawer-toggle").click();

        await expect(page.getByTestId("close-session-button")).toHaveCount(0);
        await expect(page.getByTestId("close-tab-button")).toHaveCount(0);
        await expect(page.getByTestId("move-session-up-main")).toHaveCount(0);
        await expect(page.getByTestId("move-session-down-main")).toHaveCount(0);
        await expect(page.getByTestId("drag-session-main")).toHaveCount(0);

        const sessionClose = page.getByTestId("close-session-main");
        const drawerClose = page.getByTestId("drawer-close");

        await expect(sessionClose).toBeVisible();
        await expect(drawerClose).toBeVisible();

        const minimumTouchTarget = async (testId: string): Promise<void> => {
          const box = await page.getByTestId(testId).boundingBox();
          expect(box?.width ?? 0).toBeGreaterThanOrEqual(28);
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(28);
        };

        await minimumTouchTarget("close-session-main");
        await minimumTouchTarget("drawer-close");
      } finally {
        await page.goto("about:blank");
        await localServer.stop();
      }
    });

    test("quick phrases support pinned buttons, slash search, templates, and persisted ordering", async ({ page }) => {
      const localServer = await startE2EServer({ sessions: ["main", "work"], defaultSession: "main" });

      try {
        await localServer.gateway.newTab("main");
        await localServer.gateway.selectTab("main", 0);

        await page.addInitScript(() => {
          localStorage.setItem("remux-snippets", JSON.stringify([
            {
              id: "git-status",
              label: "Status",
              command: "git status",
              autoEnter: true,
              pinned: true,
              group: "Git",
              sortOrder: 0
            },
            {
              id: "ssh-host",
              label: "SSH",
              command: "ssh {{host}}",
              autoEnter: true,
              group: "Ops",
              sortOrder: 1
            }
          ]));
          localStorage.setItem("remux-workspace-order", JSON.stringify({
            sessions: ["work", "main"],
            tabsBySession: {
              main: ["1:win-1", "0:shell"]
            }
          }));
        });

        await page.goto(`${localServer.baseUrl}/?token=${localServer.token}`);
        await expect(page.getByTestId("session-picker-overlay")).toBeVisible();
        await page.getByTestId("session-picker-overlay").getByRole("button", { name: "main" }).click();
        await expect(page.getByTestId("snippet-pinned-bar")).toContainText("Status");

        await page.getByTestId("pinned-snippet-git-status").click();
        await expect.poll(() => localServer.ptyFactory.latestProcess().writes).toContain("git status\r");

        await page.getByTestId("compose-input").fill("/ssh");
        await expect(page.getByTestId("snippet-picker")).toBeVisible();
        await page.getByTestId("compose-input").press("Enter");
        await expect(page.getByTestId("snippet-template-panel")).toBeVisible();
        await page.getByPlaceholder("host").fill("prod-box");
        await page.getByRole("button", { name: "Run" }).click();
        await expect.poll(() => localServer.ptyFactory.latestProcess().writes).toContain("ssh prod-box\r");

        // Sidebar is visible on desktop — no toggle needed
        const sessionButtons = page.getByTestId("sessions-list").getByRole("button");
        await expect(sessionButtons.nth(0)).toContainText("work");
      } finally {
        await page.goto("about:blank");
        await localServer.stop();
      }
    });

    test("sessions can be manually reordered in the drawer", async ({ page }) => {
      const localServer = await startE2EServer({ sessions: ["main", "work"], defaultSession: "main" });

      try {
        await page.goto(`${localServer.baseUrl}/?token=${localServer.token}`);
        // Wait for session picker and select main
        const picker = page.getByTestId("session-picker-overlay");
        await expect(picker).toBeVisible();
        await picker.getByRole("button", { name: "main" }).click();
        await expect(picker).toHaveCount(0);
        // Wait for sidebar sessions to be populated after attach
        await expect(page.getByTestId("session-item-work")).toBeVisible();

        await page
          .getByTestId("session-item-work")
          .locator(".drawer-item-main")
          .dragTo(page.getByTestId("session-item-main").locator(".drawer-item-main"));

        const sessionButtons = page.getByTestId("sessions-list").locator("li .drawer-item-main");
        await expect(sessionButtons.nth(0)).toContainText("work");
        await expect(sessionButtons.nth(1)).toContainText("main");
      } finally {
        await page.goto("about:blank");
        await localServer.stop();
      }
    });

    // Tab reorder test removed — tabs are now in the top tab bar, not the sidebar.
  });

  test.describe("session picker", () => {
    let server: StartedE2EServer;

    test.beforeAll(async () => {
      server = await startE2EServer({ sessions: ["work", "dev"], defaultSession: "main" });
    });

    test.afterAll(async () => {
      await server.stop();
    });

    test("selecting a session from modal attaches and closes modal", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(page.getByTestId("session-picker-overlay")).toBeVisible();
      await page.getByTestId("session-picker-overlay").getByRole("button", { name: "work" }).click();

      await expect(page.getByTestId("session-picker-overlay")).toHaveCount(0);
      await expect(page.locator(".tab.active .tab-label")).toBeVisible();

      await expect
        .poll(() => server.ptyFactory.lastSpawnedSession?.startsWith("remux-client-") ?? false)
        .toBe(true);
    });

    test("shows a neutral header while waiting for session selection", async ({ page }) => {
      const localServer = await startE2EServer({
        sessions: ["main", "luguo"],
        attachedSession: "luguo",
        defaultSession: "main"
      });

      try {
        await page.goto(`${localServer.baseUrl}/?token=${localServer.token}`);

        await expect(page.getByTestId("session-picker-overlay")).toBeVisible();
        await expect(page.locator(".top-title")).toContainText("Select Session");
        await expect(page.getByTestId("top-status-indicator")).toHaveAttribute("title", "select session");
      } finally {
        await page.goto("about:blank");
        await localServer.stop();
      }
    });
  });

  test.describe("password auth", () => {
    let server: StartedE2EServer;

    test.beforeAll(async () => {
      server = await startE2EServer({
        sessions: ["main"],
        defaultSession: "main",
        password: "correct-horse"
      });
    });

    test.afterAll(async () => {
      await server.stop();
    });

    test("shows feedback for wrong password and allows retry", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(page.getByRole("heading", { name: "Password Required" })).toBeVisible();

      await page.getByPlaceholder("Enter password").fill("wrong-password");
      await page.getByRole("button", { name: "Connect" }).click();

      await expect(page.getByTestId("password-error")).toContainText("Wrong password. Try again.");
      await expect(page.getByRole("heading", { name: "Password Required" })).toBeVisible();

      await page.getByPlaceholder("Enter password").fill("correct-horse");
      await page.getByRole("button", { name: "Connect" }).click();

      await expect(page.getByRole("heading", { name: "Password Required" })).toHaveCount(0);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
      await expect(page.getByTestId("top-status-indicator")).not.toHaveClass(/error/);
    });

    test("shows feedback when saved password is wrong", async ({ page }) => {
      await page.addInitScript(() => {
        sessionStorage.setItem("remux-password", "wrong-password");
      });

      await page.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(page.getByRole("heading", { name: "Password Required" })).toBeVisible();
      await expect(page.getByTestId("password-error")).toContainText("Wrong password. Try again.");

      await page.getByPlaceholder("Enter password").fill("correct-horse");
      await page.getByRole("button", { name: "Connect" }).click();

      await expect(page.getByRole("heading", { name: "Password Required" })).toHaveCount(0);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    });
  });

  // Sticky zoom UI controls removed — sticky zoom logic is still active via localStorage.

  test.describe("session picker fallback when switch-client fails", () => {
    let server: StartedE2EServer;

    test.beforeAll(async () => {
      server = await startE2EServer({
        sessions: ["work", "dev"],
        defaultSession: "main",
        failSwitchClient: true
      });
    });

    test.afterAll(async () => {
      await server.stop();
    });

    test("clicking session still attaches", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(page.getByTestId("session-picker-overlay")).toBeVisible();
      await page.getByTestId("session-picker-overlay").getByRole("button", { name: "dev" }).click();

      await expect(page.getByTestId("session-picker-overlay")).toHaveCount(0);
      await expect(page.locator(".tab.active .tab-label")).toBeVisible();
      await expect
        .poll(() => server.ptyFactory.lastSpawnedSession?.startsWith("remux-client-") ?? false)
        .toBe(true);
    });
  });
});
