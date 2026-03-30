import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createZellijServer, type RunningServer } from "../../src/backend/server-zellij.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";

const TEST_PORT = 19877;
const TOKEN = "upload-test-token";
const UPLOAD_DIR = path.join(os.tmpdir(), "remux-uploads");

let server: RunningServer;
let authService: AuthService;

// Minimal 1x1 red PNG (68 bytes).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  authService = new AuthService({ token: TOKEN });
  server = createZellijServer(
    {
      port: TEST_PORT,
      host: "127.0.0.1",
      frontendDir: path.resolve("dist"),
      zellijSession: `test-upload-${Date.now()}`,
    },
    {
      authService,
      logger: { log: () => {}, error: () => {} },
    },
  );
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

const upload = (
  opts: { token?: string; contentType?: string; body?: Buffer } = {},
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const { token: tk = TOKEN, contentType = "image/png", body = TINY_PNG } = opts;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path: "/api/upload",
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Authorization": `Bearer ${tk}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, json: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, json: { raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
};

describe("POST /api/upload", () => {
  it("uploads a PNG and returns the file path", async () => {
    const { status, json } = await upload();
    expect(status).toBe(200);
    expect(json.path).toMatch(/remux-uploads.*\.png$/);
    expect(json.size).toBe(TINY_PNG.length);
    // Verify file actually exists on disk.
    expect(fs.existsSync(json.path as string)).toBe(true);
    // Cleanup.
    fs.unlinkSync(json.path as string);
  });

  it("rejects requests with invalid token", async () => {
    const { status, json } = await upload({ token: "wrong-token" });
    expect(status).toBe(401);
    expect(json.error).toBe("invalid token");
  });

  it("rejects unsupported content types", async () => {
    const { status, json } = await upload({ contentType: "application/pdf" });
    expect(status).toBe(400);
    expect(json.error).toMatch(/unsupported/);
  });

  it("rejects empty body", async () => {
    const { status, json } = await upload({ body: Buffer.alloc(0) });
    expect(status).toBe(400);
    expect(json.error).toMatch(/empty/);
  });

  it("accepts JPEG content type", async () => {
    const { status, json } = await upload({ contentType: "image/jpeg" });
    expect(status).toBe(200);
    expect(json.path).toMatch(/\.jpg$/);
    fs.unlinkSync(json.path as string);
  });

  it("accepts WebP content type", async () => {
    const { status, json } = await upload({ contentType: "image/webp" });
    expect(status).toBe(200);
    expect(json.path).toMatch(/\.webp$/);
    fs.unlinkSync(json.path as string);
  });
});
