import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { AuthService } from "../../../src/backend/auth/auth-service.js";
import { DeviceStore } from "../../../src/backend/auth/device-store.js";
import { createZellijServer, type RunningServer } from "../../../src/backend/server-zellij.js";
import { createExtensions } from "../../../src/backend/extensions.js";

export interface ZellijE2EServerOptions {
  password?: string;
}

export interface StartedZellijE2EServer {
  baseUrl: string;
  token: string;
  stop: () => Promise<void>;
}

const silentLogger = {
  log: () => undefined,
  error: () => undefined,
};

export const startZellijE2EServer = async (
  options: ZellijE2EServerOptions = {},
): Promise<StartedZellijE2EServer> => {
  const token = "e2e-test-token";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remux-e2e-"));
  const authService = new AuthService({
    password: options.password,
    token,
    deviceStore: new DeviceStore({ dbPath: path.join(tempDir, "devices.db") }),
  });
  const extensions = createExtensions(silentLogger);

  const server: RunningServer = createZellijServer(
    {
      port: 0,
      host: "127.0.0.1",
      frontendDir: path.resolve(process.cwd(), "dist/frontend"),
      zellijSession: `remux-e2e-${Date.now()}`,
    },
    {
      authService,
      logger: silentLogger,
      extensions,
    },
  );

  await server.start();
  const address = server.server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    stop: async () => {
      server.server.closeAllConnections?.();
      server.server.closeIdleConnections?.();
      await Promise.race([
        server.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      extensions.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
};
