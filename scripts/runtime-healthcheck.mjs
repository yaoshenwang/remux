#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import { WebSocket } from "ws";

const args = process.argv.slice(2);

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

const waitForOpen = (socket) =>
  withTimeout(
    new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    "websocket open",
  );

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
  const control = new WebSocket(`${wsOrigin}/ws/control`);
  let terminal;

  try {
    await waitForOpen(control);

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

    terminal = new WebSocket(`${wsOrigin}/ws/terminal`);
    await waitForOpen(terminal);
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
