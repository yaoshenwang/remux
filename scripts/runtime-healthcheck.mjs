#!/usr/bin/env node

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";

const args = process.argv.slice(2);
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const usage = () => {
  console.error("Usage: scripts/runtime-healthcheck.mjs --url <baseUrl> --token <token> [--timeout-ms <ms>]");
};

const readArg = (name) => {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
};

const baseUrl = readArg("--url");
const token = readArg("--token");
const timeoutMs = Number(readArg("--timeout-ms") ?? "5000");

if (!baseUrl || !token) {
  usage();
  process.exit(1);
}

const withTimeout = (promise, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const toWsOrigin = (value) => {
  const url = new URL(value);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const fetchJson = (value) =>
  withTimeout(
    new Promise((resolve, reject) => {
      const url = new URL(value);
      const client = url.protocol === "https:" ? https : http;
      const request = client.request(
        url,
        {
          method: "GET",
          timeout: timeoutMs,
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => {
            resolve({
              ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
              status: response.statusCode ?? 500,
              body,
            });
          });
        },
      );
      request.on("timeout", () => {
        request.destroy(new Error(`request timed out after ${timeoutMs}ms`));
      });
      request.on("error", reject);
      request.end();
    }),
    "config fetch",
  );

const createWebSocketAccept = (key) =>
  crypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");

const encodeFrame = (payload, opcode) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let headerLength = 2;
  if (body.length >= 126 && body.length < 65536) {
    headerLength = 4;
  } else if (body.length >= 65536) {
    headerLength = 10;
  }

  const frame = Buffer.alloc(headerLength + 4 + body.length);
  frame[0] = 0x80 | opcode;

  let offset = 2;
  if (body.length < 126) {
    frame[1] = 0x80 | body.length;
  } else if (body.length < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(body.length, 2);
    offset = 4;
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(body.length), 2);
    offset = 10;
  }

  mask.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < body.length; index += 1) {
    frame[offset + index] = body[index] ^ mask[index % mask.length];
  }

  return frame;
};

const decodeFrame = (buffer) => {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const fin = (firstByte & 0x80) !== 0;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < 4) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) {
      return null;
    }
    const longLength = buffer.readBigUInt64BE(2);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("websocket frame exceeds maximum safe integer size");
    }
    payloadLength = Number(longLength);
    offset = 10;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) {
    return null;
  }

  const rawPayload = buffer.subarray(offset, offset + payloadLength);
  const payload = mask
    ? Buffer.from(rawPayload.map((byte, index) => byte ^ mask[index % mask.length]))
    : Buffer.from(rawPayload);

  return {
    fin,
    opcode,
    payload,
    remaining: buffer.subarray(offset + payloadLength),
  };
};

class SimpleWebSocket extends EventEmitter {
  static async connect(value) {
    return withTimeout(
      new Promise((resolve, reject) => {
        const socketUrl = new URL(value);
        const requestUrl = new URL(value);
        requestUrl.protocol = socketUrl.protocol === "wss:" ? "https:" : "http:";
        const client = requestUrl.protocol === "https:" ? https : http;
        const key = crypto.randomBytes(16).toString("base64");
        const request = client.request(requestUrl, {
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
          },
          timeout: timeoutMs,
        });

        let settled = false;
        const fail = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        };

        request.on("upgrade", (response, socket, head) => {
          if (settled) {
            socket.destroy();
            return;
          }

          if ((response.statusCode ?? 0) !== 101) {
            socket.destroy();
            fail(new Error(`websocket upgrade failed with status ${response.statusCode ?? 500}`));
            return;
          }

          const acceptHeader = response.headers["sec-websocket-accept"];
          if (acceptHeader !== createWebSocketAccept(key)) {
            socket.destroy();
            fail(new Error("websocket upgrade returned an invalid accept header"));
            return;
          }

          settled = true;
          const instance = new SimpleWebSocket(socket);
          if (head.length > 0) {
            instance.#ingest(head);
          }
          resolve(instance);
        });
        request.on("response", (response) => {
          response.resume();
          fail(new Error(`websocket upgrade failed with status ${response.statusCode ?? 500}`));
        });
        request.on("timeout", () => {
          request.destroy(new Error(`request timed out after ${timeoutMs}ms`));
        });
        request.on("error", fail);
        request.end();
      }),
      "websocket connect",
    );
  }

  #buffer = Buffer.alloc(0);

  #messageFragments = [];

  #fragmentOpcode = null;

  #closing = false;

  #socket;

  constructor(socket) {
    super();
    this.#socket = socket;
    this.on("error", () => undefined);
    socket.on("data", (chunk) => {
      try {
        this.#ingest(chunk);
      } catch (error) {
        this.emit("error", error);
        this.close();
      }
    });
    socket.on("error", (error) => {
      if (this.#closing && error?.code === "ECONNRESET") {
        return;
      }
      this.emit("error", error);
    });
    socket.on("close", () => {
      this.emit("close");
    });
    socket.on("end", () => {
      this.emit("close");
    });
  }

  send(payload) {
    if (!this.#socket.writable) {
      throw new Error("websocket is not writable");
    }
    this.#socket.write(encodeFrame(payload, 0x1));
  }

  close() {
    this.#closing = true;
    if (this.#socket.destroyed) {
      return;
    }
    if (this.#socket.writable) {
      this.#socket.write(encodeFrame(Buffer.alloc(0), 0x8));
    }
    this.#socket.end();
  }

  #emitMessage(opcode, payload) {
    if (opcode !== 0x1 && opcode !== 0x2) {
      return;
    }
    this.emit("message", Buffer.from(payload));
  }

  #handleFrame(frame) {
    if (frame.opcode === 0x8) {
      this.close();
      return;
    }

    if (frame.opcode === 0x9) {
      if (this.#socket.writable) {
        this.#socket.write(encodeFrame(frame.payload, 0xA));
      }
      return;
    }

    if (frame.opcode === 0xA) {
      return;
    }

    if (frame.opcode === 0x0) {
      if (this.#fragmentOpcode === null) {
        throw new Error("received websocket continuation frame without an open message");
      }
      this.#messageFragments.push(frame.payload);
      if (frame.fin) {
        const payload = Buffer.concat(this.#messageFragments);
        const opcode = this.#fragmentOpcode;
        this.#fragmentOpcode = null;
        this.#messageFragments = [];
        this.#emitMessage(opcode, payload);
      }
      return;
    }

    if (frame.fin) {
      this.#emitMessage(frame.opcode, frame.payload);
      return;
    }

    this.#fragmentOpcode = frame.opcode;
    this.#messageFragments = [frame.payload];
  }

  #ingest(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length > 0) {
      const frame = decodeFrame(this.#buffer);
      if (!frame) {
        return;
      }
      this.#buffer = frame.remaining;
      this.#handleFrame(frame);
    }
  }
}

const waitForJsonMessage = (socket, matcher, label) =>
  withTimeout(
    new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        try {
          const payload = JSON.parse(raw.toString("utf8"));
          if (matcher && !matcher(payload)) {
            return;
          }
          socket.off("message", onMessage);
          socket.off("error", onError);
          resolve(payload);
        } catch (error) {
          socket.off("message", onMessage);
          socket.off("error", onError);
          reject(error);
        }
      };
      const onError = (error) => {
        socket.off("message", onMessage);
        socket.off("error", onError);
        reject(error);
      };
      socket.on("message", onMessage);
      socket.on("error", onError);
    }),
    label,
  );

const waitForTerminalFrame = (socket) =>
  withTimeout(
    new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        socket.off("message", onMessage);
        socket.off("error", onError);
        resolve(raw);
      };
      const onError = (error) => {
        socket.off("message", onMessage);
        socket.off("error", onError);
        reject(error);
      };
      socket.on("message", onMessage);
      socket.on("error", onError);
    }),
    "terminal frame",
  );

const main = async () => {
  const configResponse = await fetchJson(new URL("/api/config", baseUrl));
  if (!configResponse.ok) {
    throw new Error(`config request failed with status ${configResponse.status}`);
  }

  const wsOrigin = toWsOrigin(baseUrl);
  const control = await SimpleWebSocket.connect(`${wsOrigin}/ws/control`);
  let terminal;

  try {
    const authOkPromise = waitForJsonMessage(control, (message) => message.type === "auth_ok", "auth_ok");
    const attachedPromise = waitForJsonMessage(control, (message) => message.type === "attached", "attached");
    const workspacePromise = waitForJsonMessage(
      control,
      (message) => message.type === "workspace_state",
      "workspace_state",
    );

    control.send(JSON.stringify({ type: "auth", token }));

    const authOk = await authOkPromise;
    const attached = await attachedPromise;
    const workspace = await workspacePromise;
    const sessionName =
      attached.session ??
      workspace?.clientView?.sessionName ??
      workspace?.workspace?.sessions?.[0]?.name ??
      "main";
    const tabIndex = workspace?.clientView?.tabIndex ?? 0;

    control.send(
      JSON.stringify({
        type: "capture_tab_history",
        session: sessionName,
        tabIndex,
        lines: 32,
      }),
    );
    await waitForJsonMessage(control, (message) => message.type === "tab_history", "tab_history");

    terminal = await SimpleWebSocket.connect(`${wsOrigin}/ws/terminal`);
    const initialFramePromise = waitForTerminalFrame(terminal);
    terminal.send(
      JSON.stringify({
        type: "auth",
        token,
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }),
    );

    const frame = await initialFramePromise;
    if (!frame || frame.length === 0) {
      throw new Error("terminal did not return an initial frame");
    }

    console.log(`[health] ok ${baseUrl}`);
  } finally {
    control.close();
    terminal?.close();
  }
};

main().catch((error) => {
  console.error(`[health] failed ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
