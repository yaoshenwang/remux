import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ServerConfig } from "../../src/frontend/app-types.js";
import {
  createFrontendBuildGuard,
  deriveBuildFingerprint,
  isDynamicImportFailure,
} from "../../src/frontend/build-guard.js";

const buildConfig = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  passwordRequired: false,
  pollIntervalMs: 100,
  inspectLines: 1000,
  ...overrides,
});

class FakeStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeBrowser {
  readonly document = { visibilityState: "visible" as "visible" | "hidden" };
  readonly location = { reload: vi.fn() };
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("frontend build guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("prefers git sha over semver when deriving the build fingerprint", () => {
    expect(deriveBuildFingerprint(buildConfig({
      version: "0.2.37",
      gitCommitSha: "550e9cf0130016f3dde63443b105462a0f3d9ee5",
    }))).toBe("550e9cf0130016f3dde63443b105462a0f3d9ee5");

    expect(deriveBuildFingerprint(buildConfig({
      version: "0.2.37",
    }))).toBe("version:0.2.37");
  });

  test("recognizes stale dynamic import failures across browser variants", () => {
    expect(isDynamicImportFailure(new Error("Failed to fetch dynamically imported module"))).toBe(true);
    expect(isDynamicImportFailure({ message: "Loading chunk 42 failed." })).toBe(true);
    expect(isDynamicImportFailure("Importing a module script failed.")).toBe(true);
    expect(isDynamicImportFailure(new Error("socket closed"))).toBe(false);
  });

  test("reloads when polling detects that the deployed build changed", async () => {
    const browser = new FakeBrowser();
    const storage = new FakeStorage();
    const setStatusMessage = vi.fn();
    const fetchConfig = vi.fn(async () => buildConfig({
      version: "0.2.38",
      gitCommitSha: "new-build",
    }));

    const guard = createFrontendBuildGuard({
      browser,
      fetchConfig,
      onReload: browser.location.reload,
      onStatusMessage: setStatusMessage,
      pollIntervalMs: 1_000,
      storage,
    });

    guard.start(buildConfig({
      version: "0.2.37",
      gitCommitSha: "old-build",
    }));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchConfig).toHaveBeenCalledTimes(1);
    expect(setStatusMessage).toHaveBeenCalledWith("A newer Remux build is available. Reloading…");
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem("remux-build-reload-token")).toBe("new-build");

    guard.stop();
  });

  test("checks the current config immediately when a stale chunk load fails", async () => {
    const browser = new FakeBrowser();
    const storage = new FakeStorage();
    const fetchConfig = vi.fn(async () => buildConfig({
      version: "0.2.38",
      gitCommitSha: "new-build",
    }));

    const guard = createFrontendBuildGuard({
      browser,
      fetchConfig,
      onReload: browser.location.reload,
      onStatusMessage: vi.fn(),
      pollIntervalMs: 60_000,
      storage,
    });

    guard.start(buildConfig({
      version: "0.2.37",
      gitCommitSha: "old-build",
    }));
    browser.emit("error", {
      error: new Error("Failed to fetch dynamically imported module: /assets/BandwidthStatsModal-old.js"),
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(fetchConfig).toHaveBeenCalledTimes(1);
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem("remux-build-reload-token")).toBe("new-build");

    guard.stop();
  });

  test("falls back to a single guarded reload when chunk loading fails before the build hash changes", async () => {
    const browser = new FakeBrowser();
    const storage = new FakeStorage();
    const fetchConfig = vi.fn(async () => buildConfig({
      version: "0.2.37",
      gitCommitSha: "same-build",
    }));

    const guard = createFrontendBuildGuard({
      browser,
      fetchConfig,
      onReload: browser.location.reload,
      onStatusMessage: vi.fn(),
      pollIntervalMs: 60_000,
      storage,
    });

    guard.start(buildConfig({
      version: "0.2.37",
      gitCommitSha: "same-build",
    }));

    browser.emit("unhandledrejection", {
      reason: new Error("Failed to fetch dynamically imported module"),
    });
    await vi.advanceTimersByTimeAsync(1);

    browser.emit("unhandledrejection", {
      reason: new Error("Failed to fetch dynamically imported module"),
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(fetchConfig).toHaveBeenCalledTimes(2);
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem("remux-build-reload-token")).toBe("chunk:same-build");

    guard.stop();
  });

  test("clears the stored reload token once the target build actually loads", () => {
    const browser = new FakeBrowser();
    const storage = new FakeStorage();
    storage.setItem("remux-build-reload-token", "new-build");

    const guard = createFrontendBuildGuard({
      browser,
      fetchConfig: async () => buildConfig({ gitCommitSha: "new-build" }),
      onReload: browser.location.reload,
      onStatusMessage: vi.fn(),
      pollIntervalMs: 60_000,
      storage,
    });

    guard.start(buildConfig({
      version: "0.2.38",
      gitCommitSha: "new-build",
    }));

    expect(storage.getItem("remux-build-reload-token")).toBeNull();

    guard.stop();
  });
});
