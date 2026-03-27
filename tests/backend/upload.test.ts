import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StartedRuntimeV2GatewayTestServer } from "../harness/runtimeV2GatewayTestServer.js";
import { startRuntimeV2GatewayTestServer } from "../harness/runtimeV2GatewayTestServer.js";

describe("POST /api/upload", () => {
  let server: StartedRuntimeV2GatewayTestServer;
  let tmpDir: string;
  let authToken: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-upload-test-"));
    authToken = "test-token-123";
    server = await startRuntimeV2GatewayTestServer({
      frontendDir: tmpDir,
      pollIntervalMs: 60_000,
      scrollbackLines: 100,
      token: authToken,
    });
  });

  afterEach(async () => {
    await server.stop();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  const getBaseUrl = (): string => server.baseUrl;

  test("rejects unauthenticated request", async () => {
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": "test.txt"
      },
      body: Buffer.from("hello")
    });
    expect(res.status).toBe(401);
  });

  test("rejects missing filename", async () => {
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${authToken}`
      },
      body: Buffer.from("hello")
    });
    expect(res.status).toBe(400);
  });

  test("uploads file to pane CWD", async () => {
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${authToken}`,
        "X-Filename": "test.txt",
        "X-Pane-Cwd": tmpDir
      },
      body: Buffer.from("hello world")
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; path: string; filename: string };
    expect(json.ok).toBe(true);
    expect(json.filename).toBe("test.txt");

    const content = await fs.promises.readFile(json.path, "utf8");
    expect(content).toBe("hello world");
  });

  test("sanitizes path traversal in filename", async () => {
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${authToken}`,
        "X-Filename": "../../etc/passwd",
        "X-Pane-Cwd": tmpDir
      },
      body: Buffer.from("malicious")
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; path: string; filename: string };
    expect(json.ok).toBe(true);
    // Should not contain path traversal
    expect(json.filename).not.toContain("..");
    expect(json.filename).not.toContain("/");
    // File should be in tmpDir, not escaped
    expect(json.path.startsWith(tmpDir)).toBe(true);
  });

  test("avoids overwriting existing files", async () => {
    // Create an existing file
    await fs.promises.writeFile(path.join(tmpDir, "dup.txt"), "original");

    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${authToken}`,
        "X-Filename": "dup.txt",
        "X-Pane-Cwd": tmpDir
      },
      body: Buffer.from("new content")
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; path: string; filename: string };
    expect(json.ok).toBe(true);
    // Should have a different filename
    expect(json.filename).not.toBe("dup.txt");
    expect(json.filename).toContain("dup.txt");

    // Original should be untouched
    const original = await fs.promises.readFile(path.join(tmpDir, "dup.txt"), "utf8");
    expect(original).toBe("original");
  });
});
