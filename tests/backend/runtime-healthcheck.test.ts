import { execFile } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import {
  createRemuxV2GatewayServer,
  type RunningServer,
} from "../../src/backend/server-v2.js";
import { FakeRuntimeV2Server } from "../harness/fakeRuntimeV2Server.js";

const silentLogger = { log: () => undefined, error: () => undefined };
const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

const buildConfig = (token: string): RuntimeConfig => ({
  port: 0,
  host: "127.0.0.1",
  password: undefined,
  tunnel: false,
  defaultSession: "main",
  scrollbackLines: 1000,
  pollIntervalMs: 100,
  token,
  frontendDir: process.cwd(),
});

describe("runtime healthcheck script", () => {
  let upstream: FakeRuntimeV2Server;
  let server: RunningServer;
  let baseUrl: string;

  beforeEach(async () => {
    upstream = new FakeRuntimeV2Server();
    const upstreamBaseUrl = await upstream.start();
    server = createRemuxV2GatewayServer(buildConfig("test-token"), {
      authService: new AuthService({ token: "test-token" }),
      logger: silentLogger,
      upstreamBaseUrl,
    });
    await server.start();
    const address = server.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await upstream.stop();
    await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
  });

  test("verifies config, inspect, and terminal attach through the gateway", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        ["scripts/runtime-healthcheck.mjs", "--url", baseUrl, "--token", "test-token"],
        {
          cwd: process.cwd(),
          stdio: "pipe"
        }
      )
    ).resolves.toMatchObject({});
  });

  test("fails fast when auth is rejected", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        ["scripts/runtime-healthcheck.mjs", "--url", baseUrl, "--token", "wrong-token", "--timeout-ms", "1500"],
        {
          cwd: process.cwd(),
          stdio: "pipe"
        }
      )
    ).rejects.toThrow();
  });

  test("runs without a ws dependency or global WebSocket", async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-healthcheck-"));
    tempDirs.push(tempDir);

    const copiedScriptPath = path.join(tempDir, "runtime-healthcheck.mjs");
    await fs.promises.copyFile(path.join(process.cwd(), "scripts", "runtime-healthcheck.mjs"), copiedScriptPath);

    const bootstrap = `
process.argv = ${JSON.stringify([
  "node",
  copiedScriptPath,
  "--url",
  baseUrl,
  "--token",
  "test-token",
])};
delete globalThis.WebSocket;
await import(${JSON.stringify(`file://${copiedScriptPath}`)});
`;

    await expect(
      execFileAsync(process.execPath, ["--input-type=module", "-e", bootstrap], {
        cwd: tempDir,
        stdio: "pipe",
      }),
    ).resolves.toMatchObject({});
  });
});
