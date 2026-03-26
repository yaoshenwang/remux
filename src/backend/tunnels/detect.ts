/**
 * Auto-detect the best available tunnel provider.
 *
 * Priority:
 * 1. Explicit --tunnel-provider flag
 * 2. devtunnel CLI available → use DevTunnel (Entra auth)
 * 3. cloudflared available → use Cloudflare
 * 4. Neither → error
 */

import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { TunnelProvider } from "./types.js";
import { DevTunnelManager } from "./devtunnel-manager.js";
import { CloudflareTunnelProvider } from "./cloudflare-provider.js";

export type TunnelProviderKind = "devtunnel" | "cloudflare" | "auto";

export function createTunnelProvider(
  kind: TunnelProviderKind = "auto",
  logger?: Pick<Console, "log" | "error">
): TunnelProvider {
  if (kind === "devtunnel") {
    logger?.log("[tunnel] using DevTunnel (forced)");
    return new DevTunnelManager({
      urlFile: defaultUrlFile(),
    });
  }

  if (kind === "cloudflare") {
    logger?.log("[tunnel] using Cloudflare (forced)");
    return new CloudflareTunnelProvider();
  }

  // Auto-detect.
  if (isAvailable("devtunnel")) {
    logger?.log("[tunnel] devtunnel found, using DevTunnel with Entra auth");
    return new DevTunnelManager({
      urlFile: defaultUrlFile(),
    });
  }

  logger?.log("[tunnel] devtunnel not found, falling back to Cloudflare");
  return new CloudflareTunnelProvider();
}

function isAvailable(binary: string): boolean {
  try {
    execFileSync(binary, ["--version"], { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function defaultUrlFile(): string {
  return path.join(os.homedir(), ".remux", "tunnel.url");
}
