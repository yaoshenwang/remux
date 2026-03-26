import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import { createRemuxServer, type RunningServer } from "../../src/backend/server.js";
import { FakePtyFactory } from "../harness/fakePty.js";
import { FakeSessionGateway } from "../harness/fakeTmux.js";

const silentLogger = { log: () => undefined, error: () => undefined };
const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
  version: string;
};

describe("GET /api/config", () => {
  let server: RunningServer;
  let tmpDir: string;
  const authToken = "test-token-123";

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-config-route-test-"));
  });

  afterEach(async () => {
    delete process.env.REMUX_RUNTIME_BRANCH;
    if (server) {
      await server.stop();
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  const startServer = async (): Promise<void> => {
    server = createRemuxServer(
      {
        port: 0,
        host: "127.0.0.1",
        tunnel: false,
        defaultSession: "main",
        scrollbackLines: 100,
        pollIntervalMs: 60_000,
        token: authToken,
        frontendDir: tmpDir
      },
      {
        backend: new FakeSessionGateway(["main"]),
        ptyFactory: new FakePtyFactory(),
        authService: new AuthService({ token: authToken }),
        logger: silentLogger
      }
    );
    await server.start();
  };

  const getBaseUrl = (): string => {
    const addr = server.server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  };

  test("returns build metadata for runtime verification", async () => {
    await startServer();

    const res = await fetch(`${getBaseUrl()}/api/config`);
    expect(res.status).toBe(200);

    const json = await res.json() as {
      version: string;
      gitBranch?: string;
      gitCommitSha?: string;
      gitDirty?: boolean;
      passwordRequired: boolean;
      scrollbackLines: number;
      pollIntervalMs: number;
    };

    expect(json.version).toBe(packageJson.version);
    expect(json.passwordRequired).toBe(false);
    expect(json.scrollbackLines).toBe(100);
    expect(json.pollIntervalMs).toBe(60_000);
    expect(json.gitCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof json.gitDirty).toBe("boolean");

    const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8"
    }).trim();
    const expectedBranch = currentBranch === "HEAD" ? undefined : currentBranch;
    expect(json.gitBranch).toBe(expectedBranch);
  });

  test("prefers REMUX_RUNTIME_BRANCH when provided", async () => {
    process.env.REMUX_RUNTIME_BRANCH = "dev";
    await startServer();

    const res = await fetch(`${getBaseUrl()}/api/config`);
    expect(res.status).toBe(200);

    const json = await res.json() as { gitBranch?: string };
    expect(json.gitBranch).toBe("dev");
  });
});
