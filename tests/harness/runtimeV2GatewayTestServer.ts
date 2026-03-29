import type { AddressInfo } from "node:net";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import {
  createRemuxV2GatewayServer,
  type RunningServer,
} from "../../src/backend/server-v2.js";
import {
  FakeRuntimeV2Server,
  type FakeRuntimeV2ServerOptions,
} from "./fakeRuntimeV2Server.js";

const silentLogger = { log: () => undefined, error: () => undefined };

export interface StartedRuntimeV2GatewayTestServer {
  baseUrl: string;
  baseWsUrl: string;
  server: RunningServer;
  stop(): Promise<void>;
  token: string;
  upstream: FakeRuntimeV2Server;
}

export const startRuntimeV2GatewayTestServer = async (
  options?: {
    frontendDir?: string;
    password?: string;
    pollIntervalMs?: number;
    inspectLines?: number;
    token?: string;
    upstreamOptions?: FakeRuntimeV2ServerOptions;
  },
): Promise<StartedRuntimeV2GatewayTestServer> => {
  const token = options?.token ?? "test-token";
  const upstream = new FakeRuntimeV2Server(options?.upstreamOptions);
  const upstreamBaseUrl = await upstream.start();
  const config: RuntimeConfig = {
    port: 0,
    host: "127.0.0.1",
    password: options?.password,
    tunnel: false,
    defaultSession: "main",
    inspectLines: options?.inspectLines ?? 1000,
    pollIntervalMs: options?.pollIntervalMs ?? 100,
    token,
    frontendDir: options?.frontendDir ?? process.cwd(),
  };

  const server = createRemuxV2GatewayServer(config, {
    authService: new AuthService({ password: options?.password, token }),
    logger: silentLogger,
    upstreamBaseUrl,
  });
  await server.start();
  const address = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    baseWsUrl: `ws://127.0.0.1:${address.port}`,
    server,
    stop: async () => {
      await server.stop();
      await upstream.stop();
    },
    token,
    upstream,
  };
};
