import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StartedRuntimeV2GatewayTestServer } from "../harness/runtimeV2GatewayTestServer.js";
import { startRuntimeV2GatewayTestServer } from "../harness/runtimeV2GatewayTestServer.js";
const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
  version: string;
};

describe("GET /api/config", () => {
  let server: StartedRuntimeV2GatewayTestServer;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-config-route-test-"));
    delete process.env.REMUX_LOCAL_WS_ORIGIN;
    delete process.env.REMUX_RUNTIME_BRANCH;
  });

  afterEach(async () => {
    delete process.env.REMUX_LOCAL_WS_ORIGIN;
    delete process.env.REMUX_RUNTIME_BRANCH;
    if (server) {
      await server.stop();
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  const startServer = async (): Promise<void> => {
    server = await startRuntimeV2GatewayTestServer({
      frontendDir: tmpDir,
      pollIntervalMs: 60_000,
      inspectLines: 100,
      token: "test-token-123",
    });
  };

  const getBaseUrl = (): string => server.baseUrl;

  test("returns build metadata for runtime verification", async () => {
    await startServer();

    const res = await fetch(`${getBaseUrl()}/api/config`);
    expect(res.status).toBe(200);

    const json = await res.json() as {
      version: string;
      gitBranch?: string;
      gitCommitSha?: string;
      gitDirty?: boolean;
      passwordRequired: boolean;
      inspectLines: number;
      pollIntervalMs: number;
      localWebSocketOrigin?: string;
    };

    expect(json.version).toBe(packageJson.version);
    expect(json.passwordRequired).toBe(false);
    expect(json.inspectLines).toBe(100);
    expect(json.pollIntervalMs).toBe(60_000);
    expect(json.localWebSocketOrigin).toBeUndefined();
    expect(json.gitCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof json.gitDirty).toBe("boolean");

    const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8"
    }).trim();
    const expectedBranch = currentBranch === "HEAD" ? undefined : currentBranch;
    expect(json.gitBranch).toBe(expectedBranch);
  });

  test("prefers REMUX_RUNTIME_BRANCH when provided", async () => {
    process.env.REMUX_RUNTIME_BRANCH = "dev";
    await startServer();

    const res = await fetch(`${getBaseUrl()}/api/config`);
    expect(res.status).toBe(200);

    const json = await res.json() as { gitBranch?: string };
    expect(json.gitBranch).toBe("dev");
  });

  test("includes an advertised loopback websocket origin when configured", async () => {
    process.env.REMUX_LOCAL_WS_ORIGIN = "ws://127.0.0.1:3457";
    await startServer();

    const res = await fetch(`${getBaseUrl()}/api/config`);
    expect(res.status).toBe(200);

    const json = await res.json() as { localWebSocketOrigin?: string };
    expect(json.localWebSocketOrigin).toBe("ws://127.0.0.1:3457");
  });

  test("does not fall back to the frontend for unavailable API routes", async () => {
    await startServer();

    const res = await fetch(`${getBaseUrl()}/api/state/main`, {
      headers: {
        Authorization: "Bearer test-token-123"
      }
    });

    expect(res.status).toBe(404);
  });
});
