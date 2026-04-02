/**
 * PTY Daemon — independent Node.js process that holds a PTY alive.
 * Each tab spawns one daemon. The daemon survives server restarts.
 * Communication is via a Unix domain socket using a TLV frame protocol.
 *
 * Adapted from tmux client-server model and tsm's VT tracking pattern.
 *
 * Usage: node pty-daemon.js --socket <path> --shell <shell> --cols <n> --rows <n> --cwd <dir> --tab-id <id>
 */

import net from "net";
import pty from "node-pty";
import { parseArgs } from "util";
import type { IPty } from "node-pty";

// ── TLV Frame Tags ──────────────────────────────────────────────

export const TAG_PTY_OUTPUT = 0x01;
export const TAG_CLIENT_INPUT = 0x02;
export const TAG_RESIZE = 0x03;
export const TAG_STATUS_REQ = 0x04;
export const TAG_STATUS_RES = 0x05;
export const TAG_SNAPSHOT_REQ = 0x06;
export const TAG_SNAPSHOT_RES = 0x07;
export const TAG_SCROLLBACK_REQ = 0x08;
export const TAG_SCROLLBACK_RES = 0x09;
export const TAG_SHUTDOWN = 0xff;

// ── TLV Frame Codec ─────────────────────────────────────────────

/**
 * Encode a TLV frame: [1 byte tag][4 bytes length (big-endian)][payload].
 */
export function encodeFrame(tag: number, payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = tag;
  frame.writeUInt32BE(data.length, 1);
  data.copy(frame, 5);
  return frame;
}

/**
 * TLV frame parser — accumulates data and emits complete frames.
 */
export class FrameParser {
  private buffer = Buffer.alloc(0);
  private onFrame: (tag: number, payload: Buffer) => void;

  constructor(onFrame: (tag: number, payload: Buffer) => void) {
    this.onFrame = onFrame;
  }

  feed(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 5) {
      const tag = this.buffer[0];
      const length = this.buffer.readUInt32BE(1);
      if (this.buffer.length < 5 + length) break; // incomplete frame
      const payload = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      this.onFrame(tag, payload);
    }
  }
}

// ── RingBuffer (scrollback) ─────────────────────────────────────

class RingBuffer {
  private buf: Buffer;
  private maxBytes: number;
  private writePos: number;
  private length: number;

  constructor(maxBytes = 10 * 1024 * 1024) {
    this.buf = Buffer.alloc(maxBytes);
    this.maxBytes = maxBytes;
    this.writePos = 0;
    this.length = 0;
  }

  write(data: string | Buffer): void {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    if (bytes.length >= this.maxBytes) {
      bytes.copy(this.buf, 0, bytes.length - this.maxBytes);
      this.writePos = 0;
      this.length = this.maxBytes;
      return;
    }
    const space = this.maxBytes - this.writePos;
    if (bytes.length <= space) {
      bytes.copy(this.buf, this.writePos);
    } else {
      bytes.copy(this.buf, this.writePos, 0, space);
      bytes.copy(this.buf, 0, space);
    }
    this.writePos = (this.writePos + bytes.length) % this.maxBytes;
    this.length = Math.min(this.length + bytes.length, this.maxBytes);
  }

  read(): Buffer {
    if (this.length === 0) return Buffer.alloc(0);
    if (this.length < this.maxBytes) {
      return Buffer.from(this.buf.subarray(this.writePos - this.length, this.writePos));
    }
    return Buffer.concat([
      this.buf.subarray(this.writePos),
      this.buf.subarray(0, this.writePos),
    ]);
  }
}

// ── CLI argument parsing ────────────────────────────────────────

function parseCliArgs(): {
  socket: string;
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  tabId: string;
} {
  const { values } = parseArgs({
    options: {
      socket: { type: "string" },
      shell: { type: "string" },
      cols: { type: "string" },
      rows: { type: "string" },
      cwd: { type: "string" },
      "tab-id": { type: "string" },
    },
    strict: true,
  });

  if (!values.socket || !values.shell) {
    console.error("Usage: pty-daemon --socket <path> --shell <shell> [--cols N] [--rows N] [--cwd dir] [--tab-id id]");
    process.exit(1);
  }

  return {
    socket: values.socket,
    shell: values.shell,
    cols: parseInt(values.cols || "80", 10),
    rows: parseInt(values.rows || "24", 10),
    cwd: values.cwd || process.env.HOME || "/",
    tabId: values["tab-id"] || "0",
  };
}

// ── Daemon main ─────────────────────────────────────────────────

function main(): void {
  const args = parseCliArgs();

  // Sequence counter for durable stream (Step 4)
  let seq = 0;

  // Detach from parent process if possible (survive server restarts)
  if (typeof process.disconnect === "function") {
    try { process.disconnect(); } catch { /* already disconnected */ }
  }

  // Create PTY
  const ptyProcess: IPty = pty.spawn(args.shell, [], {
    name: "xterm-256color",
    cols: args.cols,
    rows: args.rows,
    cwd: args.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  });

  const scrollback = new RingBuffer();
  const clients = new Set<net.Socket>();
  let alive = true;

  console.log(`[pty-daemon] started: pid=${ptyProcess.pid} socket=${args.socket} tab-id=${args.tabId}`);

  // ── PTY output → broadcast to all clients + scrollback ──

  ptyProcess.onData((data: string) => {
    seq++;
    scrollback.write(data);
    const frame = encodeFrame(TAG_PTY_OUTPUT, data);
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        // Client write error — will be cleaned up on close
      }
    }
  });

  // ── PTY exit ──

  ptyProcess.onExit(({ exitCode }) => {
    alive = false;
    console.log(`[pty-daemon] PTY exited: code=${exitCode} tab-id=${args.tabId}`);

    // Notify all clients
    const exitMsg = `\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`;
    const frame = encodeFrame(TAG_PTY_OUTPUT, exitMsg);
    for (const client of clients) {
      try { client.write(frame); } catch { /* ignore */ }
    }

    // Wait briefly for clients to disconnect, then clean up
    setTimeout(() => {
      for (const client of clients) {
        try { client.end(); } catch { /* ignore */ }
      }
      cleanup();
    }, 2000);
  });

  // ── Unix socket server ──

  const server = net.createServer((socket) => {
    clients.add(socket);
    console.log(`[pty-daemon] client connected (total: ${clients.size})`);

    const parser = new FrameParser((tag, payload) => {
      switch (tag) {
        case TAG_CLIENT_INPUT:
          if (alive) {
            ptyProcess.write(payload.toString("utf8"));
          }
          break;

        case TAG_RESIZE: {
          try {
            const { cols, rows } = JSON.parse(payload.toString("utf8"));
            if (alive && cols > 0 && rows > 0) {
              ptyProcess.resize(
                Math.max(1, Math.min(cols, 500)),
                Math.max(1, Math.min(rows, 200)),
              );
            }
          } catch { /* invalid resize payload */ }
          break;
        }

        case TAG_STATUS_REQ: {
          const status = JSON.stringify({
            pid: ptyProcess.pid,
            cols: args.cols,
            rows: args.rows,
            alive,
            cwd: args.cwd,
            tabId: args.tabId,
            seq,
          });
          socket.write(encodeFrame(TAG_STATUS_RES, status));
          break;
        }

        case TAG_SNAPSHOT_REQ: {
          const data = scrollback.read();
          socket.write(encodeFrame(TAG_SNAPSHOT_RES, data));
          break;
        }

        case TAG_SCROLLBACK_REQ: {
          // Return full scrollback (future: support since-seq filtering)
          const data = scrollback.read();
          socket.write(encodeFrame(TAG_SCROLLBACK_RES, data));
          break;
        }

        case TAG_SHUTDOWN:
          console.log(`[pty-daemon] shutdown requested`);
          if (alive) {
            try { ptyProcess.kill(); } catch { /* already dead */ }
          }
          // Close all clients and clean up
          for (const c of clients) {
            try { c.end(); } catch { /* ignore */ }
          }
          cleanup();
          break;
      }
    });

    socket.on("data", (data) => {
      parser.feed(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    socket.on("close", () => {
      clients.delete(socket);
      console.log(`[pty-daemon] client disconnected (total: ${clients.size})`);
    });

    socket.on("error", (err) => {
      console.error(`[pty-daemon] client socket error:`, err.message);
      clients.delete(socket);
    });
  });

  // Clean up stale socket file before listening
  try {
    const fs = require("fs");
    if (fs.existsSync(args.socket)) {
      fs.unlinkSync(args.socket);
    }
  } catch { /* ignore */ }

  server.listen(args.socket, () => {
    console.log(`[pty-daemon] listening on ${args.socket}`);
  });

  server.on("error", (err) => {
    console.error(`[pty-daemon] server error:`, err.message);
    cleanup();
  });

  // ── Cleanup ──

  function cleanup(): void {
    try {
      const fs = require("fs");
      if (fs.existsSync(args.socket)) {
        fs.unlinkSync(args.socket);
      }
    } catch { /* ignore */ }
    server.close();
    process.exit(0);
  }

  // ── Signal handling ──

  process.on("SIGTERM", () => {
    console.log(`[pty-daemon] SIGTERM received`);
    if (alive) {
      try { ptyProcess.kill(); } catch { /* already dead */ }
    }
    cleanup();
  });

  process.on("SIGINT", () => {
    // Ignore SIGINT in daemon — only respond to SIGTERM or explicit shutdown
  });
}

// Run only when executed as the main entry point (not when imported).
// When esbuild bundles this file as pty-daemon.js, it becomes the main module.
// When imported by session.ts (for encodeFrame/FrameParser), we skip main().
//
// Detection: if process.argv[1] contains "pty-daemon" or if CLI args include --socket,
// this is being run as the daemon entry point.
const isMainEntry = process.argv[1]?.includes("pty-daemon") ||
  process.argv.includes("--socket");
if (isMainEntry) {
  main();
}
