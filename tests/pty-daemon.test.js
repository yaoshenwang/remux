/**
 * Tests for PTY daemon TLV protocol, frame codec, and daemon lifecycle.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn } from "child_process";
import net from "net";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.join(__dirname, "..", "pty-daemon.js");

// TLV tags (mirrored from pty-daemon.ts)
const TAG_PTY_OUTPUT = 0x01;
const TAG_CLIENT_INPUT = 0x02;
const TAG_RESIZE = 0x03;
const TAG_STATUS_REQ = 0x04;
const TAG_STATUS_RES = 0x05;
const TAG_SNAPSHOT_REQ = 0x06;
const TAG_SNAPSHOT_RES = 0x07;
const TAG_SHUTDOWN = 0xff;

function supportsNodePty() {
  try {
    const proc = pty.spawn("/bin/sh", ["-lc", "exit 0"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      env: process.env,
    });
    proc.kill();
    return true;
  } catch {
    return false;
  }
}

const describePtyLifecycle = supportsNodePty() ? describe : describe.skip;

function encodeFrame(tag, payload) {
  const data =
    typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = tag;
  frame.writeUInt32BE(data.length, 1);
  data.copy(frame, 5);
  return frame;
}

function parseFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const tag = buf[offset];
    const length = buf.readUInt32BE(offset + 1);
    if (offset + 5 + length > buf.length) break;
    const payload = buf.subarray(offset + 5, offset + 5 + length);
    frames.push({ tag, payload });
    offset += 5 + length;
  }
  return frames;
}

function waitForSocket(socketPath, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fs.existsSync(socketPath)) {
        resolve();
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error(`Socket ${socketPath} not created within ${timeout}ms`));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function connectToDaemon(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => resolve(client));
    client.on("error", reject);
  });
}

function collectFrames(client, timeout = 2000) {
  return new Promise((resolve) => {
    const chunks = [];
    const handler = (data) => chunks.push(data);
    client.on("data", handler);
    setTimeout(() => {
      client.removeListener("data", handler);
      const all = Buffer.concat(chunks);
      resolve(parseFrames(all));
    }, timeout);
  });
}

function sendAndReceive(client, frame, timeout = 2000) {
  return new Promise((resolve) => {
    const chunks = [];
    const handler = (data) => chunks.push(data);
    client.on("data", handler);
    client.write(frame);
    setTimeout(() => {
      client.removeListener("data", handler);
      const all = Buffer.concat(chunks);
      resolve(parseFrames(all));
    }, timeout);
  });
}

describe("TLV Frame Codec", () => {
  it("encodes and decodes a simple frame", () => {
    const frame = encodeFrame(TAG_PTY_OUTPUT, "hello");
    expect(frame.length).toBe(5 + 5); // 5 header + 5 payload
    expect(frame[0]).toBe(TAG_PTY_OUTPUT);
    expect(frame.readUInt32BE(1)).toBe(5);
    expect(frame.subarray(5).toString()).toBe("hello");

    const parsed = parseFrames(frame);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tag).toBe(TAG_PTY_OUTPUT);
    expect(parsed[0].payload.toString()).toBe("hello");
  });

  it("encodes empty payload", () => {
    const frame = encodeFrame(TAG_STATUS_REQ, Buffer.alloc(0));
    expect(frame.length).toBe(5);
    expect(frame.readUInt32BE(1)).toBe(0);
  });

  it("parses multiple frames in a single buffer", () => {
    const f1 = encodeFrame(TAG_PTY_OUTPUT, "first");
    const f2 = encodeFrame(TAG_CLIENT_INPUT, "second");
    const combined = Buffer.concat([f1, f2]);
    const parsed = parseFrames(combined);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].tag).toBe(TAG_PTY_OUTPUT);
    expect(parsed[1].tag).toBe(TAG_CLIENT_INPUT);
    expect(parsed[1].payload.toString()).toBe("second");
  });

  it("handles incomplete frame gracefully", () => {
    const frame = encodeFrame(TAG_PTY_OUTPUT, "hello");
    // Truncate the frame
    const partial = frame.subarray(0, 7);
    const parsed = parseFrames(partial);
    expect(parsed).toHaveLength(0);
  });
});

describePtyLifecycle("PTY Daemon Lifecycle", () => {
  let daemon;
  let socketPath;

  beforeAll(() => {
    socketPath = `/tmp/remux-test-daemon-${process.pid}-${Date.now()}.sock`;
  });

  afterEach(() => {
    if (daemon && !daemon.killed) {
      daemon.kill("SIGTERM");
      daemon = null;
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  });

  it("starts daemon and accepts connection", async () => {
    daemon = spawn(process.execPath, [
      DAEMON_SCRIPT,
      "--socket", socketPath,
      "--shell", "/bin/sh",
      "--cols", "80",
      "--rows", "24",
      "--cwd", "/tmp",
      "--tab-id", "test-1",
    ], { stdio: "pipe" });

    await waitForSocket(socketPath);
    const client = await connectToDaemon(socketPath);

    // Send a command to provoke output
    client.write(encodeFrame(TAG_CLIENT_INPUT, "echo DAEMON_ALIVE\n"));
    const frames = await collectFrames(client, 2000);

    // Should have received PTY output
    const outputText = frames
      .filter((f) => f.tag === TAG_PTY_OUTPUT)
      .map((f) => f.payload.toString())
      .join("");
    expect(outputText).toContain("DAEMON_ALIVE");

    client.end();
  }, 10000);

  it("responds to status request", async () => {
    daemon = spawn(process.execPath, [
      DAEMON_SCRIPT,
      "--socket", socketPath,
      "--shell", "/bin/sh",
      "--cols", "100",
      "--rows", "30",
      "--cwd", "/tmp",
      "--tab-id", "test-2",
    ], { stdio: "pipe" });

    await waitForSocket(socketPath);
    const client = await connectToDaemon(socketPath);
    // Wait for initial output
    await new Promise((r) => setTimeout(r, 500));

    const frames = await sendAndReceive(
      client,
      encodeFrame(TAG_STATUS_REQ, Buffer.alloc(0)),
      1500,
    );

    const statusFrame = frames.find((f) => f.tag === TAG_STATUS_RES);
    expect(statusFrame).toBeDefined();

    const status = JSON.parse(statusFrame.payload.toString());
    expect(status.alive).toBe(true);
    expect(status.tabId).toBe("test-2");
    expect(typeof status.pid).toBe("number");
    expect(status.pid).toBeGreaterThan(0);

    client.end();
  }, 10000);

  it("forwards input to PTY and receives output", async () => {
    daemon = spawn(process.execPath, [
      DAEMON_SCRIPT,
      "--socket", socketPath,
      "--shell", "/bin/sh",
      "--cols", "80",
      "--rows", "24",
      "--cwd", "/tmp",
      "--tab-id", "test-3",
    ], { stdio: "pipe" });

    await waitForSocket(socketPath);
    const client = await connectToDaemon(socketPath);
    await new Promise((r) => setTimeout(r, 500));

    // Send a command
    client.write(encodeFrame(TAG_CLIENT_INPUT, "echo REMUX_TEST_OK\n"));
    const frames = await collectFrames(client, 2000);

    // Should have received output containing our echo
    const outputText = frames
      .filter((f) => f.tag === TAG_PTY_OUTPUT)
      .map((f) => f.payload.toString())
      .join("");

    expect(outputText).toContain("REMUX_TEST_OK");

    client.end();
  }, 10000);

  it("returns scrollback on snapshot request", async () => {
    daemon = spawn(process.execPath, [
      DAEMON_SCRIPT,
      "--socket", socketPath,
      "--shell", "/bin/sh",
      "--cols", "80",
      "--rows", "24",
      "--cwd", "/tmp",
      "--tab-id", "test-4",
    ], { stdio: "pipe" });

    await waitForSocket(socketPath);
    const client = await connectToDaemon(socketPath);
    await new Promise((r) => setTimeout(r, 500));

    // Write something to terminal
    client.write(encodeFrame(TAG_CLIENT_INPUT, "echo SNAPSHOT_TEST\n"));
    await new Promise((r) => setTimeout(r, 1000));

    // Request snapshot
    const frames = await sendAndReceive(
      client,
      encodeFrame(TAG_SNAPSHOT_REQ, Buffer.alloc(0)),
      1500,
    );

    const snapshotFrame = frames.find((f) => f.tag === TAG_SNAPSHOT_RES);
    expect(snapshotFrame).toBeDefined();
    expect(snapshotFrame.payload.toString()).toContain("SNAPSHOT_TEST");

    client.end();
  }, 10000);

  it("shuts down on TAG_SHUTDOWN", async () => {
    daemon = spawn(process.execPath, [
      DAEMON_SCRIPT,
      "--socket", socketPath,
      "--shell", "/bin/sh",
      "--cols", "80",
      "--rows", "24",
      "--cwd", "/tmp",
      "--tab-id", "test-5",
    ], { stdio: "pipe" });

    await waitForSocket(socketPath);
    const client = await connectToDaemon(socketPath);
    await new Promise((r) => setTimeout(r, 500));

    // Send shutdown
    client.write(encodeFrame(TAG_SHUTDOWN, Buffer.alloc(0)));

    // Wait for daemon to exit
    await new Promise((resolve) => {
      daemon.on("exit", resolve);
      setTimeout(resolve, 3000); // timeout safety
    });

    // Socket file should be cleaned up
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(socketPath)).toBe(false);
  }, 10000);

  it("survives client disconnect (daemon stays alive)", async () => {
    daemon = spawn(process.execPath, [
      DAEMON_SCRIPT,
      "--socket", socketPath,
      "--shell", "/bin/sh",
      "--cols", "80",
      "--rows", "24",
      "--cwd", "/tmp",
      "--tab-id", "test-6",
    ], { stdio: "pipe" });

    await waitForSocket(socketPath);

    // Connect and disconnect
    const client1 = await connectToDaemon(socketPath);
    await new Promise((r) => setTimeout(r, 500));
    client1.end();
    await new Promise((r) => setTimeout(r, 500));

    // Daemon should still be alive — reconnect
    const client2 = await connectToDaemon(socketPath);
    const frames = await sendAndReceive(
      client2,
      encodeFrame(TAG_STATUS_REQ, Buffer.alloc(0)),
      1500,
    );

    const statusFrame = frames.find((f) => f.tag === TAG_STATUS_RES);
    expect(statusFrame).toBeDefined();
    const status = JSON.parse(statusFrame.payload.toString());
    expect(status.alive).toBe(true);

    client2.end();
  }, 10000);
});
