import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createRemuxServer, type RunningServer, type ServerDependencies } from "../../src/backend/server.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import { FakeSessionGateway } from "../harness/fakeTmux.js";
import { FakePtyFactory } from "../harness/fakePty.js";

const silentLogger = { log: () => {}, error: () => {} };

const buildExtensionsStub = (): NonNullable<ServerDependencies["extensions"]> => ({
  notificationRoutes: express.Router(),
  onSessionCreated: () => {},
  onTerminalData: () => {},
  onSessionExit: () => {},
  onSessionResize: () => {},
  getSnapshot: () => ({
    content: "snapshot",
    cursor: { row: 0, col: 0 },
    size: { cols: 80, rows: 24 },
    seq: 1,
    timestamp: new Date(0).toISOString()
  }),
  getDiff: () => null,
  getScrollback: () => ["line 1"],
  getGastownInfo: () => ({}),
  gastownDetected: false,
  getEventWatcher: () => {
    throw new Error("not implemented in test");
  },
  recordRawBytes: () => {},
  recordCompressedBytes: () => {},
  setRtt: () => {},
  getBandwidthStats: () => ({
    rawBytesPerSec: 0,
    compressedBytesPerSec: 0,
    savedPercent: 0,
    fullSnapshotsSent: 0,
    diffUpdatesSent: 0,
    avgChangedRowsPerDiff: 0,
    totalRawBytes: 0,
    totalCompressedBytes: 0,
    totalSavedBytes: 0,
    rttMs: null,
    protocol: "ws"
  }),
  dispose: () => {}
});

describe("extension HTTP route auth", () => {
  let server: RunningServer;
  let tmpDir: string;
  const authToken = "test-token-123";

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-extension-auth-test-"));
    await fs.promises.writeFile(path.join(tmpDir, "demo.txt"), "demo");

    server = createRemuxServer(
      {
        port: 0,
        host: "127.0.0.1",
        tunnel: false,
        defaultSession: "main",
        scrollbackLines: 100,
        pollIntervalMs: 60_000,
        token: authToken,
        frontendDir: tmpDir
      },
      {
        backend: new FakeSessionGateway(["main"]),
        ptyFactory: new FakePtyFactory(),
        authService: new AuthService({ token: authToken }),
        logger: silentLogger,
        extensions: buildExtensionsStub()
      }
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  const getBaseUrl = (): string => {
    const addr = server.server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  };

  test("rejects unauthenticated file browser access", async () => {
    const res = await fetch(`${getBaseUrl()}/api/files`);
    expect(res.status).toBe(401);
  });

  test("rejects unauthenticated terminal state access", async () => {
    const res = await fetch(`${getBaseUrl()}/api/state/main`);
    expect(res.status).toBe(401);
  });

  test("allows authenticated extension route access", async () => {
    const res = await fetch(`${getBaseUrl()}/api/state/main`, {
      headers: {
        Authorization: `Bearer ${authToken}`
      }
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { content: string };
    expect(json.content).toBe("snapshot");
  });
});
