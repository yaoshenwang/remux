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

type RuntimeInboundMessage =
  | { kind: "text"; message: Record<string, unknown> }
  | { kind: "binary"; payload: Buffer };

const observeRuntimeSocket = (socket: WebSocket): RuntimeInboundMessage[] => {
  const messages: RuntimeInboundMessage[] = [];
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      messages.push({
        kind: "binary",
        payload: Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),
      });
      return;
    }
    messages.push({
      kind: "text",
      message: JSON.parse(raw.toString("utf8")) as Record<string, unknown>,
    });
  });
  return messages;
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

  test("deduplicates fresh snapshot requests when the first viewer returns before the leave-time refresh completes", async () => {
    delaySnapshotResponses = true;
    replayText = "FRESH-SNAPSHOT\r\n";
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

    await bridge.unsubscribe("viewer-1");
    await expect.poll(() => snapshotRequestCount).toBe(1);

    const secondBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-2", secondBrowser.socket, { cols: 120, rows: 40 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshotRequestCount).toBe(1);

    pendingSnapshotSend?.();
    pendingSnapshotSend = null;

    await expect
      .poll(() => Buffer.concat(secondBrowser.sent).toString("utf8"))
      .toContain("FRESH-SNAPSHOT");

    const restored = Buffer.concat(secondBrowser.sent).toString("utf8");
    expect(restored.match(/\u001bc/g)?.length ?? 0).toBe(1);
  });

  test("keeps upstream PTY size pinned to the resize owner when passive viewers resize", async () => {
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-1",
      wsUrl,
      silentLogger,
      "latest",
      () => undefined,
    );

    const firstBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-1", firstBrowser.socket, { cols: 120, rows: 40 });
    await expect.poll(() => attachCount).toBe(1);

    const runtimeMessages = observeRuntimeSocket(runtimeSocket!);

    const secondBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-2", secondBrowser.socket, { cols: 60, rows: 20 });
    await bridge.updateViewerSize("viewer-2", { cols: 58, rows: 18 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      runtimeMessages.filter((message) => message.kind === "text" && message.message.type === "resize"),
    ).toEqual([]);

    await bridge.updateViewerSize("viewer-1", { cols: 132, rows: 42 });

    await expect.poll(() => (
      runtimeMessages.filter((message) => message.kind === "text" && message.message.type === "resize")
    )).toHaveLength(1);

    const [resizeMessage] = runtimeMessages.filter(
      (message): message is Extract<RuntimeInboundMessage, { kind: "text" }> =>
        message.kind === "text" && message.message.type === "resize",
    );
    expect(resizeMessage.message).toMatchObject({
      type: "resize",
      size: { cols: 132, rows: 42 },
    });
  });

  test("promotes the input source to resize owner before forwarding input", async () => {
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-1",
      wsUrl,
      silentLogger,
      "latest",
      () => undefined,
    );

    const firstBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-1", firstBrowser.socket, { cols: 120, rows: 40 });
    await expect.poll(() => attachCount).toBe(1);

    const secondBrowser = createBrowserSocket();
    await bridge.subscribe("viewer-2", secondBrowser.socket, { cols: 72, rows: 22 });

    const runtimeMessages = observeRuntimeSocket(runtimeSocket!);

    bridge.write("echo promoted\r", "viewer-2");

    await expect.poll(() => runtimeMessages.length).toBeGreaterThanOrEqual(2);

    expect(runtimeMessages[0]).toEqual({
      kind: "text",
      message: {
        type: "resize",
        size: { cols: 72, rows: 22 },
      },
    });
    expect(runtimeMessages[1]).toEqual({
      kind: "binary",
      payload: Buffer.from("echo promoted\r", "utf8"),
    });

    runtimeMessages.length = 0;
    await bridge.updateViewerSize("viewer-2", { cols: 74, rows: 24 });

    await expect.poll(() => (
      runtimeMessages.filter((message) => message.kind === "text" && message.message.type === "resize")
    )).toHaveLength(1);

    const [resizeMessage] = runtimeMessages.filter(
      (message): message is Extract<RuntimeInboundMessage, { kind: "text" }> =>
        message.kind === "text" && message.message.type === "resize",
    );
    expect(resizeMessage.message).toMatchObject({
      type: "resize",
      size: { cols: 74, rows: 24 },
    });
  });

  test("intercepts DSR in stream messages and writes CPR back to runtime", async () => {
    const runtimeReceived: Buffer[] = [];
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-1",
      wsUrl,
      silentLogger,
      "largest",
      () => undefined,
    );

    const browser = createBrowserSocket();
    await bridge.subscribe("viewer-1", browser.socket, { cols: 80, rows: 24 });
    await expect.poll(() => attachCount).toBe(1);

    runtimeSocket!.on("message", (raw, isBinary) => {
      if (isBinary) {
        runtimeReceived.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      }
    });

    runtimeSocket!.send(JSON.stringify({
      type: "stream",
      sequence: 2,
      chunk_base64: encodeBase64("hello\x1b[6nworld"),
    }));

    await expect.poll(() => runtimeReceived.length).toBeGreaterThan(0);
    const cprResponse = Buffer.concat(runtimeReceived).toString("utf8");
    expect(cprResponse).toMatch(/\x1b\[\d+;\d+R/);

    const browserOutput = Buffer.concat(browser.sent).toString("utf8");
    expect(browserOutput).toContain("helloworld");
    expect(browserOutput).not.toContain("\x1b[6n");
  });

  test("intercepts DSR in binary messages and writes CPR back to runtime", async () => {
    const runtimeReceived: Buffer[] = [];
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-1",
      wsUrl,
      silentLogger,
      "largest",
      () => undefined,
    );

    const browser = createBrowserSocket();
    await bridge.subscribe("viewer-1", browser.socket, { cols: 80, rows: 24 });
    await expect.poll(() => attachCount).toBe(1);

    runtimeSocket!.on("message", (raw, isBinary) => {
      if (isBinary) {
        runtimeReceived.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      }
    });

    const binaryData = Buffer.from("prompt$ \x1b[6n", "utf8");
    runtimeSocket!.send(binaryData);

    await expect.poll(() => runtimeReceived.length).toBeGreaterThan(0);
    const cprResponse = Buffer.concat(runtimeReceived).toString("utf8");
    expect(cprResponse).toMatch(/\x1b\[\d+;\d+R/);

    const browserOutput = Buffer.concat(browser.sent).toString("utf8");
    expect(browserOutput).not.toContain("\x1b[6n");
  });

  test("fires onBell callback when terminal data contains the bell character", async () => {
    const bellPaneIds: string[] = [];
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-bell",
      wsUrl,
      silentLogger,
      "largest",
      () => undefined,
      (paneId) => {
        bellPaneIds.push(paneId);
      },
    );

    const browser = createBrowserSocket();
    await bridge.subscribe("viewer-1", browser.socket, { cols: 80, rows: 24 });
    await expect.poll(() => attachCount).toBe(1);

    runtimeSocket?.send(JSON.stringify({
      type: "stream",
      sequence: 2,
      chunk_base64: encodeBase64("hello\x07world"),
    }));

    await expect.poll(() => bellPaneIds).toEqual(["pane-bell"]);

    runtimeSocket?.send(JSON.stringify({
      type: "stream",
      sequence: 3,
      chunk_base64: encodeBase64("again\x07"),
    }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bellPaneIds).toEqual(["pane-bell"]);
  });

  test("does not fire onBell for data without bell character", async () => {
    const bellPaneIds: string[] = [];
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-no-bell",
      wsUrl,
      silentLogger,
      "largest",
      () => undefined,
      (paneId) => {
        bellPaneIds.push(paneId);
      },
    );

    const browser = createBrowserSocket();
    await bridge.subscribe("viewer-1", browser.socket, { cols: 80, rows: 24 });
    await expect.poll(() => attachCount).toBe(1);

    runtimeSocket?.send(JSON.stringify({
      type: "stream",
      sequence: 2,
      chunk_base64: encodeBase64("normal output without bell"),
    }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bellPaneIds).toEqual([]);
  });

  test("encodes snapshot and stream replay as terminal_patch frames for patch-capable viewers", async () => {
    bridge = new SharedRuntimeV2PaneBridge(
      "pane-1",
      wsUrl,
      silentLogger,
      "largest",
      () => undefined,
    );

    const patchBrowser = createBrowserSocket();
    await bridge.subscribe(
      "viewer-1",
      patchBrowser.socket,
      { cols: 120, rows: 40 },
      {
        transportMode: "patch",
        getViewRevision: () => 1,
      },
    );

    await expect.poll(() => attachCount).toBe(1);
    const snapshotFrame = JSON.parse(patchBrowser.sent[0]!.toString("utf8")) as {
      type: string;
      paneId: string;
      viewRevision: number;
      revision: number;
      baseRevision: number | null;
      reset: boolean;
      source: string;
      dataBase64: string;
    };
    expect(snapshotFrame).toMatchObject({
      type: "terminal_patch",
      paneId: "pane-1",
      viewRevision: 1,
      revision: 1,
      baseRevision: null,
      reset: true,
      source: "snapshot",
    });
    expect(Buffer.from(snapshotFrame.dataBase64, "base64").toString("utf8")).toContain("BASELINE-HISTORY");

    runtimeSocket?.send(JSON.stringify({
      type: "stream",
      sequence: 2,
      chunk_base64: encodeBase64("PATCH-LIVE\r\n"),
    }));

    await expect.poll(() => patchBrowser.sent.length).toBe(2);
    const streamFrame = JSON.parse(patchBrowser.sent[1]!.toString("utf8")) as {
      type: string;
      viewRevision: number;
      revision: number;
      baseRevision: number | null;
      reset: boolean;
      source: string;
      dataBase64: string;
    };
    expect(streamFrame).toMatchObject({
      type: "terminal_patch",
      viewRevision: 1,
      revision: 2,
      baseRevision: 1,
      reset: false,
      source: "stream",
    });
    expect(Buffer.from(streamFrame.dataBase64, "base64").toString("utf8")).toBe("PATCH-LIVE\r\n");
  });
});
