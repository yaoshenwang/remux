// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildGitHubIssueApiUrl } from "../../src/frontend/feedback/github.js";
import { createLazyGithubAdapter } from "../../src/frontend/feedback/github-adapter.js";

const createJsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

const sampleEvent = {
  session_id: "session-1",
  ts: "2026-03-30T10:00:00.000Z",
  page: "/workspace",
  target: "Snapfeed froze after clicking send",
  detail: {
    category: "bug",
    message: "Snapfeed froze after clicking send",
  },
};

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };
};

describe("createLazyGithubAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  test("returns immediately when authorization is missing and flushes queued feedback after auth", async () => {
    const localStorageRef = createStorage();
    const sessionStorageRef = createStorage();
    const showDeviceFlowDialog = vi.fn(async () => true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/github-token" && !init?.method) {
        return createJsonResponse({ token: null });
      }
      if (url === "/api/auth/github/device-code") {
        return createJsonResponse({
          device_code: "device-code-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          interval: 1,
        });
      }
      if (url === "/api/auth/github/access-token") {
        return createJsonResponse({ access_token: "gho_device_token" });
      }
      if (url === "/api/auth/github-token" && init?.method === "POST") {
        return createJsonResponse({ ok: true });
      }
      if (url === buildGitHubIssueApiUrl()) {
        return createJsonResponse({
          number: 123,
          html_url: "https://github.com/yaoshenwang/remux/issues/123",
        }, 201);
      }

      throw new Error(`Unexpected fetch ${url}`);
    });

    const adapter = createLazyGithubAdapter({
      authToken: "remux-auth-token",
      fetchFn: fetchMock,
      localStorageRef,
      sessionStorageRef,
      showDeviceFlowDialog,
    });

    const result = await adapter.send(sampleEvent);

    expect(result).toEqual({
      ok: true,
      deliveryId: "queued_for_authorization",
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      buildGitHubIssueApiUrl(),
      expect.anything(),
    );

    await vi.runOnlyPendingTimersAsync();

    expect(showDeviceFlowDialog).toHaveBeenCalledWith("ABCD-EFGH", "https://github.com/login/device");
    expect(localStorageRef.getItem("remux-github-token")).toBe("gho_device_token");
    expect(fetchMock).toHaveBeenCalledWith(
      buildGitHubIssueApiUrl(),
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  test("uses the cached token for immediate GitHub delivery", async () => {
    const localStorageRef = createStorage();
    const sessionStorageRef = createStorage();
    localStorageRef.setItem("remux-github-token", "gho_cached");
    const showDeviceFlowDialog = vi.fn(async () => true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === buildGitHubIssueApiUrl()) {
        return createJsonResponse({
          number: 456,
          html_url: "https://github.com/yaoshenwang/remux/issues/456",
        }, 201);
      }

      throw new Error(`Unexpected fetch ${url}`);
    });

    const adapter = createLazyGithubAdapter({
      authToken: "remux-auth-token",
      fetchFn: fetchMock,
      localStorageRef,
      sessionStorageRef,
      showDeviceFlowDialog,
    });

    const result = await adapter.send(sampleEvent);

    expect(result).toEqual({
      ok: true,
      deliveryId: "456",
      deliveryUrl: "https://github.com/yaoshenwang/remux/issues/456",
    });
    expect(showDeviceFlowDialog).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
