import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createZellijServer, type RunningServer } from "../../src/backend/server-zellij.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import { DeviceStore } from "../../src/backend/auth/device-store.js";

const TOKEN = "pairing-flow-token";
const ORIGINAL_HOME = process.env.HOME;

describe("device trust pairing flow", () => {
  let tempHome = "";

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "remux-pairing-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
  });

  it("creates pairing sessions, redeems trusted devices, persists them across restart, and rejects revoked resume tokens", async () => {
    const { server, baseUrl } = await startServer(tempHome);

    const createResponse = await requestJson(baseUrl, "/api/pairing/create", {
      method: "POST",
      token: TOKEN,
    });
    expect(createResponse.status).toBe(200);
    expect(createResponse.json.payload).toMatchObject({
      url: `${baseUrl}/pair`,
      protocolVersion: 2,
      serverVersion: expect.stringMatching(/^0\.\d+\.\d+$/),
    });
    expect(typeof createResponse.json.payload.pairingSessionId).toBe("string");
    expect(typeof createResponse.json.payload.token).toBe("string");
    expect(typeof createResponse.json.payload.expiresAt).toBe("string");

    const redeemResponse = await requestJson(baseUrl, "/api/pairing/redeem", {
      method: "POST",
      body: {
        pairingSessionId: createResponse.json.payload.pairingSessionId,
        token: createResponse.json.payload.token,
        publicKey: "test-public-key",
        displayName: "Alice iPhone",
        platform: "ios",
      },
    });
    expect(redeemResponse.status).toBe(200);
    expect(redeemResponse.json.device).toMatchObject({
      displayName: "Alice iPhone",
      platform: "ios",
      trustLevel: "trusted",
    });
    expect(typeof redeemResponse.json.resumeToken).toBe("string");

    const firstResumeAuth = await connectControlClient(baseUrl, {
      type: "auth",
      resumeToken: redeemResponse.json.resumeToken,
    });
    expect(firstResumeAuth.type).toBe("auth_ok");

    const deviceListResponse = await requestJson(baseUrl, "/api/devices", {
      method: "GET",
      token: TOKEN,
    });
    expect(deviceListResponse.status).toBe(200);
    expect(deviceListResponse.json.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: redeemResponse.json.device.deviceId,
          displayName: "Alice iPhone",
          trustLevel: "trusted",
        }),
      ]),
    );

    await server.stop();

    const restarted = await startServer(tempHome);
    const resumedListResponse = await requestJson(restarted.baseUrl, "/api/devices", {
      method: "GET",
      token: TOKEN,
    });
    expect(resumedListResponse.status).toBe(200);
    expect(resumedListResponse.json.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: redeemResponse.json.device.deviceId,
          displayName: "Alice iPhone",
        }),
      ]),
    );

    const revokeResponse = await requestJson(
      restarted.baseUrl,
      `/api/devices/${redeemResponse.json.device.deviceId}/revoke`,
      {
        method: "POST",
        token: TOKEN,
        body: {
          reason: "lost device",
        },
      },
    );
    expect(revokeResponse.status).toBe(200);
    expect(revokeResponse.json.device.revokedAt).toBeTruthy();

    const rejectedResumeAuth = await connectControlClient(restarted.baseUrl, {
      type: "auth",
      resumeToken: redeemResponse.json.resumeToken,
    });
    expect(rejectedResumeAuth).toMatchObject({
      type: "auth_error",
      reason: "device revoked",
    });

    await restarted.server.stop();
  });

  it("marks expired pairing sessions unusable after cleanup", async () => {
    const authService = new AuthService({
      token: TOKEN,
      deviceStore: new DeviceStore({ dbPath: path.join(tempHome, "devices.db") }),
    });
    const pairing = authService.createPairingSession({ ttlMs: -1_000, baseUrl: "http://127.0.0.1:9999" });

    const cleaned = authService.cleanupExpiredPairingSessions();
    expect(cleaned).toBe(1);

    expect(() => authService.redeemPairingSession({
      pairingSessionId: pairing.payload.pairingSessionId,
      token: pairing.payload.token,
      publicKey: "expired-public-key",
      displayName: "Expired Phone",
      platform: "ios",
    })).toThrowError(/expired/i);
    authService.dispose();
  });
});

const startServer = async (tempHome: string): Promise<{ server: RunningServer; baseUrl: string }> => {
  const controller = {
    async queryWorkspaceState() {
      return {
        session: "pairing-flow",
        activeTabIndex: 0,
        tabs: [],
      };
    },
    async dumpScreen() {
      return "";
    },
    async dumpPaneScreen() {
      return "";
    },
    async newTab() {},
    async closeTab() {},
    async goToTab() {},
    async renameTab() {},
    async newPane() {},
    async closePane() {},
    async toggleFullscreen() {},
    async renameSession() {},
  };

  const server = createZellijServer(
    {
      port: 0,
      host: "127.0.0.1",
      frontendDir: path.resolve("dist"),
      zellijSession: "pairing-flow",
    },
    {
      authService: new AuthService({
        token: TOKEN,
        deviceStore: new DeviceStore({ dbPath: path.join(tempHome, "devices.db") }),
      }),
      logger: { log: () => undefined, error: () => undefined },
      createController: () => controller,
    },
  );

  await server.start();
  const address = server.server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const requestJson = async (
  baseUrl: string,
  pathname: string,
  options: {
    method: "GET" | "POST";
    token?: string;
    body?: Record<string, unknown>;
  },
): Promise<{ status: number; json: Record<string, any> }> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method,
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return {
    status: response.status,
    json: await response.json() as Record<string, any>,
  };
};

const connectControlClient = async (
  baseUrl: string,
  authMessage: Record<string, unknown>,
): Promise<Record<string, any>> => {
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/control`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for auth response"));
    }, 5_000);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", onOpen);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    const onOpen = () => {
      ws.send(JSON.stringify(authMessage));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (raw: WebSocket.RawData) => {
      const payload = JSON.parse(String(raw)) as Record<string, any>;
      if (payload.type !== "auth_ok" && payload.type !== "auth_error") {
        return;
      }
      cleanup();
      ws.close();
      resolve(payload);
    };

    ws.on("open", onOpen);
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
};
