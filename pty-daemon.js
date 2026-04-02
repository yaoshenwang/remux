#!/usr/bin/env node
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/pty-daemon.ts
import net from "net";
import pty from "node-pty";
import { parseArgs } from "util";
var TAG_PTY_OUTPUT = 1;
var TAG_CLIENT_INPUT = 2;
var TAG_RESIZE = 3;
var TAG_STATUS_REQ = 4;
var TAG_STATUS_RES = 5;
var TAG_SNAPSHOT_REQ = 6;
var TAG_SNAPSHOT_RES = 7;
var TAG_SCROLLBACK_REQ = 8;
var TAG_SCROLLBACK_RES = 9;
var TAG_SHUTDOWN = 255;
function encodeFrame(tag, payload) {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = tag;
  frame.writeUInt32BE(data.length, 1);
  data.copy(frame, 5);
  return frame;
}
var FrameParser = class {
  buffer = Buffer.alloc(0);
  onFrame;
  constructor(onFrame) {
    this.onFrame = onFrame;
  }
  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 5) {
      const tag = this.buffer[0];
      const length = this.buffer.readUInt32BE(1);
      if (this.buffer.length < 5 + length) break;
      const payload = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      this.onFrame(tag, payload);
    }
  }
};
var RingBuffer = class {
  buf;
  maxBytes;
  writePos;
  length;
  constructor(maxBytes = 10 * 1024 * 1024) {
    this.buf = Buffer.alloc(maxBytes);
    this.maxBytes = maxBytes;
    this.writePos = 0;
    this.length = 0;
  }
  write(data) {
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
  read() {
    if (this.length === 0) return Buffer.alloc(0);
    if (this.length < this.maxBytes) {
      return Buffer.from(this.buf.subarray(this.writePos - this.length, this.writePos));
    }
    return Buffer.concat([
      this.buf.subarray(this.writePos),
      this.buf.subarray(0, this.writePos)
    ]);
  }
};
function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      socket: { type: "string" },
      shell: { type: "string" },
      cols: { type: "string" },
      rows: { type: "string" },
      cwd: { type: "string" },
      "tab-id": { type: "string" }
    },
    strict: true
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
    tabId: values["tab-id"] || "0"
  };
}
function main() {
  const args = parseCliArgs();
  let seq = 0;
  if (typeof process.disconnect === "function") {
    try {
      process.disconnect();
    } catch {
    }
  }
  const ptyProcess = pty.spawn(args.shell, [], {
    name: "xterm-256color",
    cols: args.cols,
    rows: args.rows,
    cwd: args.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    }
  });
  const scrollback = new RingBuffer();
  const clients = /* @__PURE__ */ new Set();
  let alive = true;
  console.log(`[pty-daemon] started: pid=${ptyProcess.pid} socket=${args.socket} tab-id=${args.tabId}`);
  ptyProcess.onData((data) => {
    seq++;
    scrollback.write(data);
    const frame = encodeFrame(TAG_PTY_OUTPUT, data);
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
      }
    }
  });
  ptyProcess.onExit(({ exitCode }) => {
    alive = false;
    console.log(`[pty-daemon] PTY exited: code=${exitCode} tab-id=${args.tabId}`);
    const exitMsg = `\r
\x1B[33mShell exited (code: ${exitCode})\x1B[0m\r
`;
    const frame = encodeFrame(TAG_PTY_OUTPUT, exitMsg);
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
      }
    }
    setTimeout(() => {
      for (const client of clients) {
        try {
          client.end();
        } catch {
        }
      }
      cleanup();
    }, 2e3);
  });
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
                Math.max(1, Math.min(rows, 200))
              );
            }
          } catch {
          }
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
            seq
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
          const data = scrollback.read();
          socket.write(encodeFrame(TAG_SCROLLBACK_RES, data));
          break;
        }
        case TAG_SHUTDOWN:
          console.log(`[pty-daemon] shutdown requested`);
          if (alive) {
            try {
              ptyProcess.kill();
            } catch {
            }
          }
          for (const c of clients) {
            try {
              c.end();
            } catch {
            }
          }
          cleanup();
          break;
      }
    });
    socket.on("data", (data) => {
      parser.feed(data);
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
  try {
    const fs = __require("fs");
    if (fs.existsSync(args.socket)) {
      fs.unlinkSync(args.socket);
    }
  } catch {
  }
  server.listen(args.socket, () => {
    console.log(`[pty-daemon] listening on ${args.socket}`);
  });
  server.on("error", (err) => {
    console.error(`[pty-daemon] server error:`, err.message);
    cleanup();
  });
  function cleanup() {
    try {
      const fs = __require("fs");
      if (fs.existsSync(args.socket)) {
        fs.unlinkSync(args.socket);
      }
    } catch {
    }
    server.close();
    process.exit(0);
  }
  process.on("SIGTERM", () => {
    console.log(`[pty-daemon] SIGTERM received`);
    if (alive) {
      try {
        ptyProcess.kill();
      } catch {
      }
    }
    cleanup();
  });
  process.on("SIGINT", () => {
  });
}
var isMainEntry = process.argv[1]?.includes("pty-daemon") || process.argv.includes("--socket");
if (isMainEntry) {
  main();
}
export {
  FrameParser,
  TAG_CLIENT_INPUT,
  TAG_PTY_OUTPUT,
  TAG_RESIZE,
  TAG_SCROLLBACK_REQ,
  TAG_SCROLLBACK_RES,
  TAG_SHUTDOWN,
  TAG_SNAPSHOT_REQ,
  TAG_SNAPSHOT_RES,
  TAG_STATUS_REQ,
  TAG_STATUS_RES,
  encodeFrame
};
