import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import { createRemuxServer, type RunningServer } from "../../src/backend/server.js";
import { FakePtyFactory } from "../harness/fakePty.js";
import { FakeSessionGateway } from "../harness/fakeTmux.js";

const silentLogger = { log: () => undefined, error: () => undefined };

describe("GitHub auth routes", () => {
  let server: RunningServer;
  let tmpDir: string;
  let tmpHome: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const authToken = "test-token-123";

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-github-auth-route-test-"));
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-github-home-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

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
        logger: silentLogger
      }
    );
    await server.start();
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

  const getBaseUrl = (): string => {
    const addr = server.server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  };

  const authHeaders = (): HeadersInit => ({
    Authorization: `Bearer ${authToken}`,
    "Content-Type": "application/json"
  });

  test("rejects unauthenticated GitHub token storage access", async () => {
    const readRes = await fetch(`${getBaseUrl()}/api/auth/github-token`);
    expect(readRes.status).toBe(401);

    const writeRes = await fetch(`${getBaseUrl()}/api/auth/github-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ token: "gho_test" })
    });
    expect(writeRes.status).toBe(401);

    const deleteRes = await fetch(`${getBaseUrl()}/api/auth/github-token`, {
      method: "DELETE"
    });
    expect(deleteRes.status).toBe(401);
  });

  test("stores, reads, and deletes GitHub tokens for authenticated clients", async () => {
    const writeRes = await fetch(`${getBaseUrl()}/api/auth/github-token`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ token: "gho_test" })
    });
    expect(writeRes.status).toBe(200);
    expect(await writeRes.json()).toEqual({ ok: true });

    const readRes = await fetch(`${getBaseUrl()}/api/auth/github-token`, {
      headers: authHeaders()
    });
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toEqual({ token: "gho_test" });

    const deleteRes = await fetch(`${getBaseUrl()}/api/auth/github-token`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${authToken}`
      }
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });

    const secondReadRes = await fetch(`${getBaseUrl()}/api/auth/github-token`, {
      headers: {
        Authorization: `Bearer ${authToken}`
      }
    });
    expect(secondReadRes.status).toBe(200);
    expect(await secondReadRes.json()).toEqual({ token: null });
  });

  test("rejects unauthenticated GitHub device flow proxy access", async () => {
    const deviceCodeRes = await fetch(`${getBaseUrl()}/api/auth/github/device-code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ client_id: "client", scope: "public_repo" })
    });
    expect(deviceCodeRes.status).toBe(401);

    const accessTokenRes = await fetch(`${getBaseUrl()}/api/auth/github/access-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: "client",
        device_code: "device-code",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      })
    });
    expect(accessTokenRes.status).toBe(401);
  });
});
