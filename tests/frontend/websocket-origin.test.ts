import { describe, expect, test } from "vitest";
import {
  resolvePreferredWebSocketOrigin,
  type WebSocketProbeFactory,
} from "../../src/frontend/websocket-origin.js";

const makeFactory = (
  behavior: "open" | "error" | "timeout",
): WebSocketProbeFactory => {
  return (url, handlers) => {
    if (behavior === "open") {
      setTimeout(() => handlers.onOpen(), 0);
    } else if (behavior === "error") {
      setTimeout(() => handlers.onError(new Error(`unable to open ${url}`)), 0);
    }
    return {
      close: () => undefined,
    };
  };
};

describe("websocket origin selection", () => {
  test("prefers the advertised loopback origin when it accepts websocket connections", async () => {
    await expect(resolvePreferredWebSocketOrigin({
      publicOrigin: "wss://remux-dev.yaoshen.wang",
      preferredLoopbackOrigin: "ws://127.0.0.1:3457",
      probeFactory: makeFactory("open"),
      timeoutMs: 10,
    })).resolves.toBe("ws://127.0.0.1:3457");
  });

  test("falls back to the public origin when the loopback probe errors", async () => {
    await expect(resolvePreferredWebSocketOrigin({
      publicOrigin: "wss://remux-dev.yaoshen.wang",
      preferredLoopbackOrigin: "ws://127.0.0.1:3457",
      probeFactory: makeFactory("error"),
      timeoutMs: 10,
    })).resolves.toBe("wss://remux-dev.yaoshen.wang");
  });

  test("falls back to the public origin when the loopback probe times out", async () => {
    await expect(resolvePreferredWebSocketOrigin({
      publicOrigin: "wss://remux-dev.yaoshen.wang",
      preferredLoopbackOrigin: "ws://127.0.0.1:3457",
      probeFactory: makeFactory("timeout"),
      timeoutMs: 5,
    })).resolves.toBe("wss://remux-dev.yaoshen.wang");
  });
});
