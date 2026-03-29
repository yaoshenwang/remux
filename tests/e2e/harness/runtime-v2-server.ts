import path from "node:path";
import type { AddressInfo } from "node:net";
import { AuthService } from "../../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../../src/backend/config.js";
import { createRemuxV2GatewayServer, type RunningServer } from "../../../src/backend/server-v2.js";
import { FakeRuntimeV2Server } from "../../harness/fakeRuntimeV2Server.js";

export interface RuntimeV2E2EServerOptions {
  password?: string;
  terminalSizePolicy?: "largest" | "smallest" | "latest";
}

export interface StartedRuntimeV2E2EServer {
  baseUrl: string;
  token: string;
  upstream: FakeRuntimeV2Server;
  stop: () => Promise<void>;
}

const silentLogger = {
  log: () => undefined,
  error: () => undefined,
};

export const startRuntimeV2E2EServer = async (
  options: RuntimeV2E2EServerOptions = {},
): Promise<StartedRuntimeV2E2EServer> => {
  const previousIdleBridgeGraceMs = process.env.REMUX_IDLE_PANE_BRIDGE_GRACE_MS;
  const previousTerminalSizePolicy = process.env.REMUX_TERMINAL_SIZE_POLICY;
  process.env.REMUX_IDLE_PANE_BRIDGE_GRACE_MS = "0";
  if (options.terminalSizePolicy) {
    process.env.REMUX_TERMINAL_SIZE_POLICY = options.terminalSizePolicy;
  } else {
    delete process.env.REMUX_TERMINAL_SIZE_POLICY;
  }
  const token = "runtime-v2-e2e-token";
  const upstream = new FakeRuntimeV2Server();
  const upstreamBaseUrl = await upstream.start();
  const authService = new AuthService({ password: options.password, token });

  const config: RuntimeConfig = {
    port: 0,
    host: "127.0.0.1",
    password: options.password,
    tunnel: false,
    defaultSession: "main",
    scrollbackLines: 1000,
    pollIntervalMs: 100,
    token,
    frontendDir: path.resolve(process.cwd(), "dist/frontend"),
  };

  const server: RunningServer = createRemuxV2GatewayServer(config, {
    authService,
    logger: silentLogger,
    upstreamBaseUrl,
  });

  await server.start();
  const address = server.server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    upstream,
    stop: async () => {
      server.server.closeAllConnections?.();
      server.server.closeIdleConnections?.();
      await Promise.race([
        server.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      await upstream.stop().catch(() => undefined);
      if (previousIdleBridgeGraceMs === undefined) {
        delete process.env.REMUX_IDLE_PANE_BRIDGE_GRACE_MS;
      } else {
        process.env.REMUX_IDLE_PANE_BRIDGE_GRACE_MS = previousIdleBridgeGraceMs;
      }
      if (previousTerminalSizePolicy === undefined) {
        delete process.env.REMUX_TERMINAL_SIZE_POLICY;
      } else {
        process.env.REMUX_TERMINAL_SIZE_POLICY = previousTerminalSizePolicy;
      }
    },
  };
};
