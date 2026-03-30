#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { AuthService } from "./auth/auth-service.js";
import { createZellijServer, type RunningServer } from "./server-zellij.js";
import { createTunnelProvider } from "./tunnels/index.js";
import { createExtensions } from "./extensions.js";
import { createLogger } from "./util/file-logger.js";
import { randomToken } from "./util/random.js";
import { buildLaunchUrl } from "./launch-context.js";

interface CliArgs {
  port: number;
  host: string;
  password?: string;
  requirePassword: boolean;
  tunnel: boolean;
  tunnelProvider: "auto" | "devtunnel" | "cloudflare";
  zellijSession: string;
  zellijBin?: string;
  debugLog?: string;
}

const parseCliArgs = async (): Promise<CliArgs> => {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("remux")
    .option("port", {
      alias: "p",
      type: "number",
      default: 8767,
      describe: "Local port",
    })
    .option("host", {
      type: "string",
      default: "127.0.0.1",
      describe: "Bind address (use 0.0.0.0 for LAN access)",
    })
    .option("password", {
      type: "string",
      describe: "Password for authentication (auto-generated when protection is enabled)",
    })
    .option("require-password", {
      type: "boolean",
      default: true,
      describe: "Require password authentication",
    })
    .option("tunnel", {
      type: "boolean",
      default: true,
      describe: "Start cloudflared quick tunnel",
    })
    .option("tunnel-provider", {
      type: "string",
      choices: ["auto", "devtunnel", "cloudflare"] as const,
      default: "auto",
      describe: "Tunnel provider (auto-detects devtunnel, falls back to cloudflare)",
    })
    .option("zellij-session", {
      type: "string",
      default: "remux",
      describe: "Zellij session name",
    })
    .option("zellij-bin", {
      type: "string",
      describe: "Path to zellij binary (auto-detected if omitted)",
    })
    .option("debug-log", {
      type: "string",
      describe: "Write debug logs to a file",
    })
    .strict()
    .help()
    .parseAsync();

  return {
    port: argv.port,
    host: argv.host,
    password: argv.password,
    requirePassword: argv.requirePassword,
    tunnel: argv.tunnel,
    tunnelProvider: argv.tunnelProvider as CliArgs["tunnelProvider"],
    zellijSession: argv.zellijSession,
    zellijBin: argv.zellijBin,
    debugLog: argv.debugLog,
  };
};

const printConnectionInfo = (
  localUrl: string,
  tunnelUrl: string | undefined,
  token: string,
  password?: string,
  isDevMode = false,
): void => {
  const frontendUrl = isDevMode ? "http://localhost:5173" : localUrl;
  const localWithToken = buildLaunchUrl(frontendUrl, token);

  console.log("\n═══════════════════════════════════════");
  console.log(`Frontend: ${frontendUrl}${isDevMode ? " (Vite dev)" : ""}`);
  console.log(`Backend:  ${localUrl}`);
  console.log("═══════════════════════════════════════");
  console.log(`\nOpen this URL in your browser:\n${localWithToken}`);
  if (password) {
    console.log(`\nPassword: ${password}`);
  }

  if (tunnelUrl) {
    const tunnelWithToken = buildLaunchUrl(tunnelUrl, token);
    console.log(`\nTunnel URL: ${tunnelWithToken}`);
    qrcode.generate(tunnelWithToken, { small: true });
    return;
  }

  qrcode.generate(localWithToken, { small: true });
  console.log("");
};

const main = async (): Promise<void> => {
  const args = await parseCliArgs();
  const effectivePassword = args.requirePassword
    ? args.password ?? process.env.REMUX_PASSWORD ?? randomToken(16)
    : undefined;
  const useDevTunnel = args.tunnelProvider === "devtunnel" ||
    (args.tunnelProvider === "auto" && args.tunnel);
  const authService = new AuthService({
    password: effectivePassword,
    token: process.env.REMUX_TOKEN || undefined,
    trustEntraTunnel: useDevTunnel,
  });
  const debugLogPath = args.debugLog ?? process.env.REMUX_DEBUG_LOG;
  const logger = createLogger(debugLogPath);
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  // Prefer built frontend (dist/frontend) over source (src/frontend).
  // When running via tsx, cliDir=src/backend; dist/frontend is at ../../dist/frontend.
  // When running compiled, cliDir=dist/backend; dist/frontend is at ../frontend.
  const candidates = [
    path.resolve(cliDir, "../../dist/frontend"),
    path.resolve(cliDir, "../frontend"),
  ];
  const frontendDir = candidates.find((d) =>
    fs.existsSync(path.join(d, "assets")),
  ) ?? candidates[candidates.length - 1];

  const tunnelProvider = createTunnelProvider(args.tunnelProvider, logger);
  const extensions = createExtensions(logger);

  const runningServer: RunningServer = createZellijServer(
    {
      port: args.port,
      host: args.host,
      frontendDir,
      zellijSession: args.zellijSession,
      zellijBin: args.zellijBin,
    },
    { authService, logger, extensions },
  );

  await runningServer.start();
  logger.log(`Runtime mode: zellij (session=${args.zellijSession})`);

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
  );

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
    shutdownPromise = (async () => {
      tunnelProvider.stop();
      await runningServer.stop();
    })();
    try {
      await shutdownPromise;
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
};

void main();
