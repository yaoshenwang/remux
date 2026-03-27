import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "node-pty";
import { AuthService } from "../../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../../src/backend/config.js";
import { createRemuxServer, type RunningServer } from "../../../src/backend/server.js";
import { ZellijCliExecutor } from "../../../src/backend/zellij/cli-executor.js";
import { ZellijPtyFactory } from "../../../src/backend/zellij/pane-io.js";

const execFileAsync = promisify(execFile);
const realZellijLogger = process.env.REAL_ZELLIJ_E2E_DEBUG === "1"
  ? console
  : { log: () => {}, error: () => {} };

const makeShortSocketDir = (prefix: string): string => {
  const baseDir = process.platform === "win32" ? os.tmpdir() : "/tmp";
  return fs.mkdtempSync(path.join(baseDir, prefix));
};

const waitForSessionReady = async (
  socketDir: string,
  sessionName: string,
  timeoutMs = 10_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync("zellij", ["list-sessions", "-n"], {
        env: {
          ...process.env,
          ZELLIJ_SOCKET_DIR: socketDir
        }
      });
      if (stdout.includes(sessionName)) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for zellij session '${sessionName}'`);
};

export const waitForTabCount = async (
  zellij: ZellijCliExecutor,
  sessionName: string,
  expectedCount: number,
  timeoutMs = 10_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tabs = await zellij.listTabs(sessionName);
    if (tabs.length >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${expectedCount} zellij tabs in '${sessionName}'`);
};

export const waitForActiveTab = async (
  zellij: ZellijCliExecutor,
  sessionName: string,
  expectedIndex: number,
  timeoutMs = 10_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tabs = await zellij.listTabs(sessionName);
    if (tabs.some((tab) => tab.index === expectedIndex && tab.active)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for zellij tab ${expectedIndex} to become active`);
};

const resolveBridgeBinary = (): string | null => {
  const packagedBinaryNames = process.platform === "win32"
    ? ["remux-zellij-bridge.exe", "zellij-bridge.exe"]
    : ["remux-zellij-bridge", "zellij-bridge"];
  const devBinaryNames = process.platform === "win32"
    ? ["zellij-bridge.exe", "remux-zellij-bridge.exe"]
    : ["zellij-bridge", "remux-zellij-bridge"];
  const candidates = [
    process.env.REMUX_ZELLIJ_BRIDGE_BIN,
    ...devBinaryNames.map((binaryName) => path.resolve(process.cwd(), "native/zellij-bridge/target/release", binaryName)),
    ...devBinaryNames.map((binaryName) => path.resolve(process.cwd(), "native/zellij-bridge/target/debug", binaryName)),
    ...packagedBinaryNames.map((binaryName) => path.resolve(process.cwd(), "dist/backend/zellij", binaryName)),
    path.resolve(process.cwd(), "dist/backend/zellij", "remux-zellij-bridge-linux-x64"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
};

export const canRunRealZellijE2E = (): boolean => {
  if (process.env.REAL_ZELLIJ_E2E !== "1") {
    return false;
  }
  const bridgeBinary = resolveBridgeBinary();
  if (!bridgeBinary) {
    return false;
  }
  const version = spawnSync("zellij", ["--version"], { encoding: "utf8" });
  return version.status === 0;
};

export interface StartedRealZellijE2EServer {
  baseUrl: string;
  token: string;
  sessionName: string;
  socketDir: string;
  zellij: ZellijCliExecutor;
  stop: () => Promise<void>;
}

export const startRealZellijE2EServer = async (options?: {
  externalClientCols?: number;
  externalClientRows?: number;
}): Promise<StartedRealZellijE2EServer> => {
  const bridgeBinary = resolveBridgeBinary();
  if (!bridgeBinary) {
    throw new Error("missing zellij bridge binary for real e2e");
  }

  const previousBridgeBinary = process.env.REMUX_ZELLIJ_BRIDGE_BIN;
  process.env.REMUX_ZELLIJ_BRIDGE_BIN = bridgeBinary;
  const restoreBridgeBinaryEnv = (): void => {
    if (previousBridgeBinary === undefined) {
      delete process.env.REMUX_ZELLIJ_BRIDGE_BIN;
      return;
    }
    process.env.REMUX_ZELLIJ_BRIDGE_BIN = previousBridgeBinary;
  };

  const socketDir = makeShortSocketDir("rmx-zj-e2e-");
  const sessionName = `e2e-${process.pid}-${Date.now()}`;
  const token = "real-zellij-e2e-token";

  const zellij = new ZellijCliExecutor({
    socketDir,
    logger: realZellijLogger
  });
  const ptyFactory = new ZellijPtyFactory({
    socketDir,
    logger: realZellijLogger,
    scrollbackLines: 200
  });
  const authService = new AuthService({ token });
  let externalClient: pty.IPty | null = null;
  const externalClientCols = options?.externalClientCols ?? 120;
  const externalClientRows = options?.externalClientRows ?? 40;
  const config: RuntimeConfig = {
    port: 0,
    host: "127.0.0.1",
    password: undefined,
    tunnel: false,
    defaultSession: sessionName,
    scrollbackLines: 1000,
    pollIntervalMs: 10_000,
    token,
    frontendDir: path.resolve(process.cwd(), "dist/frontend")
  };

  const server: RunningServer = createRemuxServer(config, {
    backend: zellij,
    ptyFactory,
    authService,
    logger: realZellijLogger
  });

  try {
    await zellij.createSession(sessionName);
    await waitForSessionReady(socketDir, sessionName);
    externalClient = pty.spawn("zellij", ["attach", sessionName], {
      name: "xterm-256color",
      cols: externalClientCols,
      rows: externalClientRows,
      cwd: process.cwd(),
      env: {
        ...process.env,
        ZELLIJ_SOCKET_DIR: socketDir
      }
    });
    await waitForActiveTab(zellij, sessionName, 0);
    await server.start();
    const address = server.server.address() as AddressInfo;

    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      token,
      sessionName,
      socketDir,
      zellij,
      stop: async () => {
        restoreBridgeBinaryEnv();
        externalClient?.kill();
        await server.stop().catch(() => {});
        await zellij.killSession(sessionName).catch(() => {});
        fs.rmSync(socketDir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    restoreBridgeBinaryEnv();
    externalClient?.kill();
    await server.stop().catch(() => {});
    await zellij.killSession(sessionName).catch(() => {});
    fs.rmSync(socketDir, { recursive: true, force: true });
    throw error;
  }
};
