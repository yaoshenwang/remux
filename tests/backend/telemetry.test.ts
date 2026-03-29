import express from "express";
import { describe, expect, test, vi } from "vitest";
import { registerTelemetryRoutes } from "../../src/backend/telemetry.js";

describe("registerTelemetryRoutes", () => {
  test("falls back to a no-op ingest route when telemetry storage is unavailable", async () => {
    const app = express();
    app.use(express.json());
    const logger = { log: vi.fn(), error: vi.fn() };

    await registerTelemetryRoutes(app, logger, async () => {
      throw new Error("broken telemetry");
    });

    const server = await new Promise<import("node:http").Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind telemetry test server");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/telemetry/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          events: [{ event_type: "click" }],
        }),
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        disabled: true,
        ok: false,
      });
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
