import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RuntimeConfig } from "../../src/backend/config.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

class FakeChildProcess extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public exitCode: number | null = null;
  public readonly kill = vi.fn(() => {
    this.exitCode = 0;
    this.emit("exit", 0);
    return true;
  });
}

const buildConfig = (token: string): RuntimeConfig => ({
  port: 0,
  host: "127.0.0.1",
  password: undefined,
  tunnel: false,
  defaultSession: "main",
  scrollbackLines: 1000,
  pollIntervalMs: 100,
  token,
  frontendDir: process.cwd(),
});

describe("runtime-v2 startup fallback safety", () => {
  const tempHomes: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    while (tempHomes.length > 0) {
      const entry = tempHomes.pop();
      if (entry) {
        fs.rmSync(entry, { recursive: true, force: true });
      }
    }
  });

  test("rejects cleanly when remuxd cannot be spawned", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "remux-home-"));
    tempHomes.push(tempHome);
    vi.stubEnv("HOME", tempHome);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("remuxd not ready")));

    const child = new FakeChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("error", Object.assign(new Error("spawn cargo ENOENT"), { code: "ENOENT" }));
      });
      return child;
    });

    const { createRemuxV2GatewayServer } = await import("../../src/backend/server-v2.js");
    const server = createRemuxV2GatewayServer(buildConfig("test-token"), {
      logger: { log: vi.fn(), error: vi.fn() },
    });

    await expect(server.start()).rejects.toThrow(/spawn cargo ENOENT|failed to start remuxd/i);
  });
});
