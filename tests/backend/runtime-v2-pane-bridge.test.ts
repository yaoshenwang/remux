import http from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { SharedRuntimeV2PaneBridge, parseSequencedBinaryFrame } from "../../src/backend/server-v2.js";

const silentLogger = {
  log: () => undefined,
  error: () => undefined,
};

const encodeBase64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/** Build a sequenced binary stream frame: [8-byte BE u64 sequence][raw PTY data]. */
const buildBinaryStreamFrame = (sequence: number, text: string): Buffer => {
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(sequence));
  return Buffer.concat([header, Buffer.from(text, "utf8")]);
};

const createBrowserSocket = (): { sent: Buffer[]; socket: WebSocket } => {
  const sent: Buffer[] = [];
  const socket = {
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    send: (payload: string | Uint8Array | Buffer) => {
      sent.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
    },
  } as unknown as WebSocket;
  return { sent, socket };
};

describe("parseSequencedBinaryFrame", () => {
  test("parses a valid sequenced binary frame", () => {
    const frame = buildBinaryStreamFrame(42, "hello");
    const result = parseSequencedBinaryFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.sequence).toBe(42);
    expect(result!.chunk.toString("utf8")).toBe("hello");
  });

  test("returns null for frames shorter than 9 bytes", () => {
    // 8-byte header only, no data
    const headerOnly = Buffer.alloc(8);
    headerOnly.writeBigUInt64BE(1n);
    expect(parseSequencedBinaryFrame(headerOnly)).toBeNull();
    // Empty buffer
    expect(parseSequencedBinaryFrame(Buffer.alloc(0))).toBeNull();
    // 7 bytes
    expect(parseSequencedBinaryFrame(Buffer.alloc(7))).toBeNull();
  });

  test("handles large sequence numbers", () => {
    const header = Buffer.alloc(8);
    header.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER));
    const frame = Buffer.concat([header, Buffer.from("x")]);
    const result = parseSequencedBinaryFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.sequence).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("SharedRuntimeV2PaneBridge", () => {
  let httpServer: http.Server;
  let runtimeWss: WebSocketServer;
  let wsUrl: string;
  let runtimeSocket: WebSocket | null;
  let attachCount: number;
  let snapshotRequestCount: number;
  let replayText: string;
  let requestSnapshotSequence: number | null;
  let delaySnapshotResponses: boolean;
  let pendingSnapshotSend: (() => void) | null;
  let bridge: SharedRuntimeV2PaneBridge | null;

  beforeEach(async () => {
    runtimeSocket = null;
    attachCount = 0;
    snapshotRequestCount = 0;
    replayText = "BASELINE-HISTORY\r\n";
    requestSnapshotSequence = null;
    delaySnapshotResponses = false;
    pendingSnapshotSend = null;
    bridge = null;
    httpServer = http.createServer();
    runtimeWss = new WebSocketServer({ server: httpServer });
    runtimeWss.on("connection", (socket) => {
      runtimeSocket = socket;
      socket.on("close", () => {
        if (runtimeSocket === socket) {
          runtimeSocket = null;
        }
      });
      socket.on("message", (raw, isBinary) => {
        if (isBinary) {
          return;
        }
        const message = JSON.parse(raw.toString("utf8")) as { type: string; size?: { cols: number; rows: number } };
        if (message.type === "attach") {
          attachCount += 1;
          socket.send(JSON.stringify({
            type: "snapshot",
            size: message.size,
            sequence: attachCount,
            content_base64: encodeBase64("VISIBLE-TAIL\r\n"),
            replay_base64: encodeBase64(replayText),
          }));
          return;
        }
        if (message.type === "request_snapshot") {
          snapshotRequestCount += 1;
          const sendSnapshot = () => {
            socket.send(JSON.stringify({
              type: "snapshot",
              size: message.size ?? { cols: 120, rows: 40 },
              sequence: requestSnapshotSequence ?? attachCount + snapshotRequestCount,
              content_base64: encodeBase64("VISIBLE-TAIL\r\n"),
              replay_base64: encodeBase64(replayText),
            }));
          };
          if (delaySnapshotResponses) {
            pendingSnapshotSend = sendSnapshot;
            return;
          }
          sendSnapshot();
        }
      });
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind websocket test server");
    }
    wsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    delete process.env.REMUX_IDLE_PANE_BRIDGE_GRACE_MS;
    await bridge?.close().catch(() => undefined);
    runtimeWss.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve) => runtimeWss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  });

  test("keeps an idle pane bridge warm long enough to replay chunks that arrive while the tab is inactive", async () => {
    const idlePaneIds: string[] = [];
    requestSnapshotSequence = 1;
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-1",
      wsUrl,
      silentLogger,
      "largest",
      (paneId) => {
        idlePaneIds.push(paneId);
      },
    );

    const firstBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-1", firstBrowser.socket, { cols: 120, rows: 40 });

    await expect.poll(() => attachCount).toBe(1);
    expect(Buffer.concat(firstBrowser.sent).toString("utf8")).toContain("BASELINE-HISTORY");

    await bridge.unsubscribe("viewer-1");
    expect(idlePaneIds).toEqual([]);
    expect(runtimeSocket?.readyState).toBe(WebSocket.OPEN);

    runtimeSocket?.send(buildBinaryStreamFrame(2, "MISSED-WHILE-INACTIVE\r\n"));

    const secondBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-2", secondBrowser.socket, { cols: 120, rows: 40 });

    expect(attachCount).toBe(1);
    await expect
      .poll(() => Buffer.concat(secondBrowser.sent).toString("utf8"))
      .toContain("BASELINE-HISTORY");
    await expect
      .poll(() => Buffer.concat(secondBrowser.sent).toString("utf8"))
      .toContain("MISSED-WHILE-INACTIVE");
  });

  test("refreshes the cached snapshot when the last viewer leaves so tab restores keep earlier active history", async () => {
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-1",
      wsUrl,
      silentLogger,
      "largest",
      () => undefined,
    );

    const firstBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-1", firstBrowser.socket, { cols: 120, rows: 40 });

    await expect.poll(() => attachCount).toBe(1);

    const earlyChunk = "ACTIVE-HISTORY-0001 ".repeat(96) + "\r\n";
    const fillerChunk = "ACTIVE-HISTORY-FILLER ".repeat(96) + "\r\n";

    replayText += earlyChunk;
    runtimeSocket?.send(buildBinaryStreamFrame(2, earlyChunk));

    for (let index = 0; index < 180; index += 1) {
      replayText += fillerChunk;
      runtimeSocket?.send(buildBinaryStreamFrame(3 + index, fillerChunk));
    }

    await bridge.unsubscribe("viewer-1");

    await expect.poll(() => snapshotRequestCount).toBe(1);

    const secondBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-2", secondBrowser.socket, { cols: 120, rows: 40 });

    await expect
      .poll(() => Buffer.concat(secondBrowser.sent).toString("utf8"))
      .toContain(earlyChunk.trim());
  });

  test("preserves streamed tail chunks when a leave-time snapshot lags behind the latest live output", async () => {
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-1",
      wsUrl,
      silentLogger,
      "largest",
      () => undefined,
    );

    replayText = Array.from({ length: 109 }, (_, index) => `${index + 1}\r\n`).join("");
    requestSnapshotSequence = 109;

    const firstBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-1", firstBrowser.socket, { cols: 120, rows: 40 });

    await expect.poll(() => attachCount).toBe(1);

    for (let line = 110; line <= 120; line += 1) {
      runtimeSocket?.send(buildBinaryStreamFrame(line, `${line}\r\n`));
    }

    await expect
      .poll(() => Buffer.concat(firstBrowser.sent).toString("utf8"))
      .toContain("120");

    await bridge.unsubscribe("viewer-1");
    await expect.poll(() => snapshotRequestCount).toBe(1);

    const secondBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-2", secondBrowser.socket, { cols: 120, rows: 40 });

    await expect
      .poll(() => Buffer.concat(secondBrowser.sent).toString("utf8"))
      .toContain("109");
    const restored = Buffer.concat(secondBrowser.sent).toString("utf8");
    expect(restored).toContain("110");
    expect(restored).toContain("120");
  });

  test("does not retire the bridge when a new subscriber arrives after idle close is queued", async () => {
    process.env.REMUX_IDLE_PANE_BRIDGE_GRACE_MS = "0";
    const idlePaneIds: string[] = [];
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-1",
      wsUrl,
      silentLogger,
      "largest",
      (paneId) => {
        idlePaneIds.push(paneId);
      },
    );

    const firstBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-1", firstBrowser.socket, { cols: 120, rows: 40 });
    await expect.poll(() => attachCount).toBe(1);

    const unsubscribePromise = bridge.unsubscribe("viewer-1");
    const secondBrowser = createBrowserSocket();
    const resubscribePromise = bridge.subscribe("viewer-2", secondBrowser.socket, { cols: 120, rows: 40 });

    await unsubscribePromise;
    await resubscribePromise;

    expect(idlePaneIds).toEqual([]);
    expect(attachCount).toBe(1);
    await expect
      .poll(() => Buffer.concat(secondBrowser.sent).toString("utf8"))
      .toContain("BASELINE-HISTORY");
  });

  test("waits for a fresh snapshot before replaying cached terminal bytes to the first viewer after a refresh", async () => {
    delaySnapshotResponses = true;
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-1",
      wsUrl,
      silentLogger,
      "largest",
      () => undefined,
    );

    const firstBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-1", firstBrowser.socket, { cols: 120, rows: 40 });

    await expect.poll(() => attachCount).toBe(1);
    expect(Buffer.concat(firstBrowser.sent).toString("utf8")).toContain("BASELINE-HISTORY");

    replayText = "FRESH-SNAPSHOT\r\n";
    runtimeSocket?.send(buildBinaryStreamFrame(2, "STALE-PARTIAL-REPAINT\r\n"));

    await bridge.unsubscribe("viewer-1");
    await expect.poll(() => snapshotRequestCount).toBe(1);

    const secondBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-2", secondBrowser.socket, { cols: 120, rows: 40 });

    const beforeFreshSnapshot = Buffer.concat(secondBrowser.sent).toString("utf8");
    expect(beforeFreshSnapshot).not.toContain("BASELINE-HISTORY");
    expect(beforeFreshSnapshot).not.toContain("STALE-PARTIAL-REPAINT");

    pendingSnapshotSend?.();
    pendingSnapshotSend = null;

    await expect
      .poll(() => Buffer.concat(secondBrowser.sent).toString("utf8"))
      .toContain("FRESH-SNAPSHOT");
    const restored = Buffer.concat(secondBrowser.sent).toString("utf8");
    expect(restored).not.toContain("BASELINE-HISTORY");
  });
});
