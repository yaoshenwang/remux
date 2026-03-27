import express from "express";
import { describe, expect, test } from "vitest";
import { frontendFallbackRoute, isWebSocketPath } from "../../src/backend/server-v2.js";

interface RouteLayer {
  route?: { path?: string };
  match(path: string): boolean;
}

const getFallbackLayer = (): RouteLayer => {
  const app = express();
  app.get(frontendFallbackRoute, () => undefined);

  const stack = (app.router as { stack: RouteLayer[] }).stack;
  const layer = stack.find((entry) => entry.route?.path === frontendFallbackRoute);
  if (!layer) {
    throw new Error("fallback route layer not found");
  }
  return layer;
};

describe("runtime-v2 frontend fallback route", () => {
  test("matches root and deep SPA paths", () => {
    const layer = getFallbackLayer();
    expect(layer.match("/")).toBe(true);
    expect(layer.match("/session/work/window/2")).toBe(true);
  });

  test("reserves websocket paths for upgrade handling", () => {
    expect(isWebSocketPath("/ws/control")).toBe(true);
    expect(isWebSocketPath("/ws/terminal")).toBe(true);
    expect(isWebSocketPath("/api/config")).toBe(false);
    expect(isWebSocketPath("/ws")).toBe(false);
  });
});
