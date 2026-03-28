#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { AuthService } from "./auth/auth-service.js";
import type { CliArgs, RuntimeConfig } from "./config.js";
import { createRemuxServer } from "./server.js";
import {
  createRemuxV2GatewayServer,
  type RunningServer,
} from "./server-v2.js";
import { createExtensions } from "./extensions.js";
import { detectSessionBackend } from "./providers/detect.js";
import { createTunnelProvider } from "./tunnels/index.js";
import { createLogger } from "./util/file-logger.js";
import { randomToken } from "./util/random.js";
import {
  buildLaunchUrl,
  detectTmuxLaunchContext,
  type LaunchContext
} from "./launch-context.js";
import { shouldAllowLegacyFallback } from "./runtime-mode.js";
import { cleanupSocketDir } from "./zellij/socket-dir.js";

const parseCliArgs = async (): Promise<CliArgs> => {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("remux")
    .option("port", {
      alias: "p",
      type: "number",
      default: 8767,
      describe: "Local port"
    })
    .option("host", {
      type: "string",
      default: "127.0.0.1",
      describe: "Bind address (use 0.0.0.0 for LAN access)"
    })
    .option("password", {
      type: "string",
      describe: "Password for authentication (auto-generated when protection is enabled)"
    })
    .option("require-password", {
      type: "boolean",
      default: true,
      describe: "Require password authentication"
    })
    .option("tunnel", {
      type: "boolean",
      default: true,
      describe: "Start cloudflared quick tunnel"
    })
    .option("session", {
      type: "string",
      default: "main",
      describe: "Default workspace session name"
    })
    .option("scrollback", {
      type: "number",
      default: 1000,
      describe: "Default scrollback capture lines"
    })
    .option("debug-log", {
      type: "string",
      describe: "Write debug logs to a file"
    })
    .option("backend", {
      type: "string",
      choices: ["auto", "tmux", "zellij", "conpty"] as const,
      default: "auto",
      describe: "Force a legacy fallback backend"
    })
    .option("tunnel-provider", {
      type: "string",
      choices: ["auto", "devtunnel", "cloudflare"] as const,
      default: "auto",
      describe: "Tunnel provider (auto-detects devtunnel, falls back to cloudflare)"
    })
    .strict()
    .hide("backend")
    .help()
    .parseAsync();

  return {
    port: argv.port,
    host: argv.host,
    password: argv.password,
    requirePassword: argv.requirePassword,
    tunnel: argv.tunnel,
    tunnelProvider: argv.tunnelProvider as CliArgs["tunnelProvider"],
    session: argv.session,
    scrollback: argv.scrollback,
    debugLog: argv.debugLog,
    backend: argv.backend
  };
};

const printConnectionInfo = (
  localUrl: string,
  tunnelUrl: string | undefined,
  token: string,
  password?: string,
  isDevMode: boolean = false,
  launchContext?: LaunchContext | null
): void => {
  const frontendUrl = isDevMode ? `http://localhost:5173` : localUrl;
  const localWithToken = buildLaunchUrl(frontendUrl, token, launchContext);

  console.log("\n═══════════════════════════════════════");
  console.log(`Frontend: ${frontendUrl}${isDevMode ? " (Vite dev)" : ""}`);
  console.log(`Backend:  ${localUrl}`);
  console.log("═══════════════════════════════════════");
  console.log(`\nOpen this URL in your browser:\n${localWithToken}`);
  if (password) {
    console.log(`\nPassword: ${password}`);
  }

  if (tunnelUrl) {
    const tunnelWithToken = buildLaunchUrl(tunnelUrl, token, launchContext);
    console.log(`\nTunnel URL: ${tunnelWithToken}`);
    qrcode.generate(tunnelWithToken, { small: true });
    return;
  }

  qrcode.generate(localWithToken, { small: true });
  console.log("");
};

const main = async (): Promise<void> => {
  const args = await parseCliArgs();
  const effectivePassword = args.requirePassword ? args.password ?? randomToken(16) : undefined;
  const authService = new AuthService({
    password: effectivePassword,
    token: process.env.REMUX_TOKEN || undefined,
  });
  const debugLogPath = args.debugLog ?? process.env.REMUX_DEBUG_LOG;
  const logger = createLogger(debugLogPath);
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDir = path.resolve(cliDir, "../frontend");

  const tunnelProvider = createTunnelProvider(args.tunnelProvider, logger);

  const config: RuntimeConfig = {
    port: args.port,
    host: args.host,
    password: effectivePassword,
    tunnel: args.tunnel,
    defaultSession: args.session,
    scrollbackLines: args.scrollback,
    pollIntervalMs: 2_500,
    token: authService.token,
    frontendDir
  };
  let launchContext: LaunchContext | null = null;
  let extensions: ReturnType<typeof createExtensions> | null = null;
  let runningServer: RunningServer | null = null;
  const allowLegacyFallback = shouldAllowLegacyFallback(process.env);

  if (process.env.REMUX_RUNTIME_V2 !== "0") {
    const candidate = createRemuxV2GatewayServer(config, {
      authService,
      logger,
    });
    try {
      await candidate.start();
      runningServer = candidate;
      logger.log("Runtime mode: runtime-v2");
    } catch (error) {
      await candidate.stop().catch(() => undefined);
      if (!allowLegacyFallback) {
        throw error;
      }
      logger.error(`runtime-v2 startup failed, falling back to legacy backend: ${String(error)}`);
    }
  }

  if (!runningServer) {
    extensions = createExtensions(logger);
    const forceBackend = args.backend !== "auto"
      ? (args.backend as "tmux" | "zellij" | "conpty")
      : undefined;
    const backend = detectSessionBackend(logger, {
      force: forceBackend,
      socketName: process.env.REMUX_SOCKET_NAME,
      socketPath: process.env.REMUX_SOCKET_PATH,
      socketDir: process.env.REMUX_ZELLIJ_SOCKET_DIR,
      scrollbackLines: args.scrollback,
    });
    logger.log(`Session backend: ${backend.kind}`);

    const legacyConfig: RuntimeConfig = {
      ...config,
      pollIntervalMs: backend.kind === "zellij" ? 10_000 : 2_500,
    };
    launchContext = detectTmuxLaunchContext({ backendKind: backend.kind });
    runningServer = createRemuxServer(legacyConfig, {
      backend: backend.gateway,
      ptyFactory: backend.ptyFactory,
      authService,
      logger,
      extensions,
      onSwitchBackend: (kind) => {
        try {
          const newBackend = detectSessionBackend(logger, {
            force: kind,
            socketName: process.env.REMUX_SOCKET_NAME,
            socketPath: process.env.REMUX_SOCKET_PATH,
            socketDir: process.env.REMUX_ZELLIJ_SOCKET_DIR,
            scrollbackLines: args.scrollback,
          });
          return {
            backend: newBackend.gateway,
            ptyFactory: newBackend.ptyFactory,
          };
        } catch {
          return null;
        }
      }
    });
    await runningServer.start();
  }

  if (debugLogPath) {
    logger.log(`Debug log file: ${path.resolve(debugLogPath)}`);
  }

  // Check if running in dev mode (set by npm run dev:backend)
  const isDevMode = process.env.VITE_DEV_MODE === "1";

  let tunnelUrl: string | undefined;
  if (args.tunnel && !isDevMode) {
    try {
      const tunnel = await tunnelProvider.start(args.port);
      tunnelUrl = tunnel.publicUrl;
    } catch (error) {
      console.error(`Unable to start tunnel: ${String(error)}`);
    }
  }

  printConnectionInfo(
    `http://localhost:${args.port}`,
    tunnelUrl,
    authService.token,
    effectivePassword,
    isDevMode,
    launchContext
  );

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }

    shutdownPromise = (async () => {
      tunnelProvider.stop();
      extensions?.dispose();
      await runningServer?.stop();
      cleanupSocketDir();
    })();

    try {
      await shutdownPromise;
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
};

void main();
