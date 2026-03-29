import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StartedRuntimeV2GatewayTestServer } from "../harness/runtimeV2GatewayTestServer.js";
import { startRuntimeV2GatewayTestServer } from "../harness/runtimeV2GatewayTestServer.js";

describe("telemetry routes", () => {
  let server: StartedRuntimeV2GatewayTestServer;
  let tmpDir: string;
  let tmpHome: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const authToken = "test-token-telemetry";

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-telemetry-route-test-"));
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-telemetry-home-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    server = await startRuntimeV2GatewayTestServer({
      frontendDir: tmpDir,
      pollIntervalMs: 60_000,
      inspectLines: 100,
      token: authToken,
    });
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    await fs.promises.rm(tmpHome, { recursive: true, force: true });
  });

  const getBaseUrl = (): string => server.baseUrl;
  const authHeaders = (): HeadersInit => ({
    Authorization: `Bearer ${authToken}`,
  });

  const postEvents = async (): Promise<void> => {
    const res = await fetch(`${getBaseUrl()}/api/telemetry/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        events: [
          {
            session_id: "sess-1",
            seq: 1,
            ts: "2026-03-29T12:00:00.000Z",
            event_type: "click",
            page: "/",
            target: "terminal-host",
            detail: { tag: "div" },
            screenshot: null,
          },
          {
            session_id: "sess-1",
            seq: 2,
            ts: "2026-03-29T12:01:00.000Z",
            event_type: "feedback",
            page: "/",
            target: "report width drift",
            detail: { category: "bug" },
            screenshot: "/9j/4AAQSkZJRgABAQAAAQABAAD/2w==",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
  };

  test("accepts anonymous telemetry ingest but protects telemetry reads", async () => {
    await postEvents();

    const eventsRes = await fetch(`${getBaseUrl()}/api/telemetry/events`);
    expect(eventsRes.status).toBe(401);

    const sessionsRes = await fetch(`${getBaseUrl()}/api/telemetry/sessions`);
    expect(sessionsRes.status).toBe(401);

    const screenshotRes = await fetch(`${getBaseUrl()}/api/telemetry/events/2/screenshot`);
    expect(screenshotRes.status).toBe(401);
  });

  test("lists stored telemetry and serves screenshots to authenticated clients", async () => {
    await postEvents();

    const eventsRes = await fetch(`${getBaseUrl()}/api/telemetry/events?event_type=feedback`, {
      headers: authHeaders(),
    });
    expect(eventsRes.status).toBe(200);
    const events = await eventsRes.json() as Array<{
      id: number;
      session_id: string;
      event_type: string;
      target: string | null;
      detail_json: string | null;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session_id: "sess-1",
      event_type: "feedback",
      target: "report width drift",
    });
    expect(JSON.parse(events[0]!.detail_json ?? "{}")).toMatchObject({ category: "bug" });

    const sessionsRes = await fetch(`${getBaseUrl()}/api/telemetry/sessions`, {
      headers: authHeaders(),
    });
    expect(sessionsRes.status).toBe(200);
    const sessions = await sessionsRes.json() as Array<{
      session_id: string;
      event_count: number;
      error_count: number;
    }>;
    expect(sessions).toEqual([
      expect.objectContaining({
        session_id: "sess-1",
        event_count: 2,
        error_count: 0,
      }),
    ]);

    const screenshotRes = await fetch(
      `${getBaseUrl()}/api/telemetry/events/${events[0]!.id}/screenshot`,
      { headers: authHeaders() },
    );
    expect(screenshotRes.status).toBe(200);
    expect(screenshotRes.headers.get("content-type")).toBe("image/jpeg");
    expect((await screenshotRes.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
