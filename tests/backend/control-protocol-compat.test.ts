import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Router } from "express";
import { createZellijServer, type RunningServer } from "../../src/backend/server-zellij.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import { createEnvelope } from "../../src/backend/protocol/envelope.js";
import { createMemoryDeviceStore } from "../helpers/memory-device-store.js";

const TOKEN = "protocol-compat-token";
type BufferedWebSocket = WebSocket & {
  __messageQueue: string[];
};

describe("control protocol compatibility", () => {
  let server: RunningServer;
  let baseWsUrl = "";

  beforeAll(async () => {
    const inspectLines = ["first line", "second line", "third line"];

    server = createZellijServer(
      {
        port: 0,
        host: "127.0.0.1",
        frontendDir: path.resolve("dist"),
        zellijSession: "protocol-compat",
      },
      {
        authService: new AuthService({
          token: TOKEN,
          deviceStore: createMemoryDeviceStore("control-protocol-compat") as never,
        }),
        logger: { log: () => {}, error: () => {} },
        extensions: {
          getInspectLines: (_session: string, _from: number, _count: number) => inspectLines,
          onTerminalData: () => {},
          onSessionExit: () => {},
          onSessionCreated: () => {},
          onSessionResize: () => {},
          getSnapshot: () => null,
          getGastownInfo: () => ({}),
          getBandwidthStats: () => ({}),
          dispose: () => {},
          notificationRoutes: Router(),
        } as any,
      },
    );

    await server.start();
    const address = server.server.address() as AddressInfo;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it("serves legacy and envelope clients concurrently without breaking capture_inspect", async () => {
    const legacyClient = await connectControlClient(baseWsUrl, { type: "auth", token: TOKEN });
    const envelopeClient = await connectControlClient(baseWsUrl, {
      type: "auth",
      token: TOKEN,
      capabilities: {
        envelope: true,
        inspectV2: true,
        deviceTrust: true,
      },
    });

    const legacyAuthOk = await expectMessage(legacyClient, (payload) => payload.type === "auth_ok");
    const envelopeAuthOk = await expectMessage(
      envelopeClient,
      (payload) => payload.domain === "core" && payload.type === "auth_ok",
    );

    expect(legacyAuthOk.capabilities).toEqual({
      envelope: true,
      inspectV2: true,
      deviceTrust: true,
    });
    expect(envelopeAuthOk).toMatchObject({
      domain: "core",
      type: "auth_ok",
      version: 1,
      source: "server",
      payload: {
        capabilities: {
          envelope: true,
          inspectV2: true,
          deviceTrust: true,
        },
      },
    });

    legacyClient.send(JSON.stringify({ type: "subscribe_workspace" }));

    const legacyWorkspace = await expectMessage(legacyClient, (payload) => payload.type === "workspace_state");
    expect(legacyWorkspace).toMatchObject({
      type: "workspace_state",
      session: "protocol-compat",
      activeTabIndex: 0,
    });

    const envelopeWorkspace = await expectMessage(
      envelopeClient,
      (payload) => payload.domain === "runtime" && payload.type === "workspace_state",
    );
    expect(envelopeWorkspace).toMatchObject({
      domain: "runtime",
      type: "workspace_state",
      version: 1,
      source: "server",
      payload: {
        session: "protocol-compat",
        activeTabIndex: 0,
      },
    });

    legacyClient.send(
      JSON.stringify({
        type: "request_inspect",
        scope: "pane",
        paneId: "terminal_1",
        limit: 2,
      }),
    );
    const legacyInspect = await expectMessage(legacyClient, (payload) => payload.type === "inspect_snapshot");
    expect(legacyInspect.lines).toBeInstanceOf(Array);
    expect(legacyInspect.lines.length).toBeGreaterThan(0);
    expect(legacyInspect.hasMore).toBe(false);

    envelopeClient.send(JSON.stringify(
      createEnvelope(
        "inspect",
        "request_inspect",
        {
          scope: "pane",
          paneId: "terminal_1",
          limit: 2,
        },
        {
          source: "client",
        },
      ),
    ));
    const envelopeInspect = await expectMessage(
      envelopeClient,
      (payload) => payload.domain === "inspect" && payload.type === "inspect_snapshot",
    );
    expect(envelopeInspect).toMatchObject({
      domain: "inspect",
      type: "inspect_snapshot",
      version: 1,
      source: "server",
    });
    expect(envelopeInspect.payload.lines).toBeInstanceOf(Array);
    expect(envelopeInspect.payload.lines.length).toBeGreaterThan(0);
    expect(envelopeInspect.payload.hasMore).toBe(false);

    envelopeClient.send(JSON.stringify({ type: "capture_inspect", full: true }));
    const legacyCapture = await expectMessage(
      envelopeClient,
      (payload) => payload.domain === "core" && payload.type === "inspect_content",
    );
    expect(legacyCapture).toMatchObject({
      domain: "core",
      type: "inspect_content",
      payload: {
        content: "first line\nsecond line\nthird line",
      },
    });

    legacyClient.close();
    envelopeClient.close();
  });
});

const connectControlClient = async (
  baseWsUrl: string,
  authMessage: Record<string, unknown>,
): Promise<BufferedWebSocket> => {
  const ws = new WebSocket(`${baseWsUrl}/ws/control`) as BufferedWebSocket;
  ws.__messageQueue = [];
  ws.on("message", (raw) => {
    ws.__messageQueue.push(String(raw));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify(authMessage));
  return ws;
};

const expectMessage = async (
  ws: BufferedWebSocket,
  matcher: (payload: Record<string, any>) => boolean,
): Promise<Record<string, any>> => {
  const queuedIndex = ws.__messageQueue.findIndex((raw) => {
    try {
      return matcher(JSON.parse(raw) as Record<string, any>);
    } catch {
      return false;
    }
  });
  if (queuedIndex >= 0) {
    const [queued] = ws.__messageQueue.splice(queuedIndex, 1);
    return JSON.parse(queued) as Record<string, any>;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for matching message"));
    }, 5_000);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const normalized = String(raw);
        const payload = JSON.parse(normalized) as Record<string, any>;
        if (!matcher(payload)) {
          return;
        }
        const queuedMessageIndex = ws.__messageQueue.indexOf(normalized);
        if (queuedMessageIndex >= 0) {
          ws.__messageQueue.splice(queuedMessageIndex, 1);
        }
        cleanup();
        resolve(payload);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
};
