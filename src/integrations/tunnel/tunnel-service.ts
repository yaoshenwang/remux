/**
 * Cloudflare Tunnel support for Remux.
 * Detects cloudflared, spawns a quick tunnel, parses the URL.
 * Adapted from cloudflare/cloudflared quick-tunnel pattern.
 */

import { spawn, execFile, type ChildProcess } from "child_process";

// ── CLI arg parsing ─────────────────────────────────────────────

export type TunnelMode = "enable" | "disable" | "auto";

/**
 * Parse tunnel-related CLI flags from argv.
 */
export function parseTunnelArgs(argv: string[]): { tunnelMode: TunnelMode } {
  if (argv.includes("--no-tunnel")) return { tunnelMode: "disable" };
  if (argv.includes("--tunnel")) return { tunnelMode: "enable" };
  return { tunnelMode: "auto" };
}

// ── cloudflared detection ───────────────────────────────────────

/**
 * Check if cloudflared is available on PATH.
 */
export function isCloudflaredAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("cloudflared", ["--version"], (err) => {
      resolve(!err);
    });
  });
}

// ── Tunnel lifecycle ────────────────────────────────────────────

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * Start a cloudflared quick tunnel pointing at the given local URL.
 */
export function startTunnel(
  port: number,
  options: { signal?: AbortSignal } = {},
): Promise<{ url: string; process: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let resolved = false;
    let output = "";
    const TIMEOUT_MS = 30_000;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
        reject(new Error("cloudflared tunnel URL not detected within 30s"));
      }
    }, TIMEOUT_MS);

    function handleData(data: Buffer) {
      output += data.toString();
      const match = output.match(TUNNEL_URL_RE);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        // Stop accumulating data after URL is found
        child.stderr!.removeListener("data", handleData);
        child.stdout!.removeListener("data", handleData);
        resolve({ url: match[0], process: child });
      }
    }

    // cloudflared logs connection info to stderr
    child.stderr!.on("data", handleData);
    child.stdout!.on("data", handleData);

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(
          new Error(
            `cloudflared exited with code ${code} before URL was detected`,
          ),
        );
      }
    });

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => {
          child.kill("SIGTERM");
        },
        { once: true },
      );
    }
  });
}

/**
 * Build the full tunnel access URL, appending auth token if present.
 */
export function buildTunnelAccessUrl(
  tunnelUrl: string,
  token: string | null,
  password: string | null,
): string {
  // If password auth, the user logs in via the password page (no token in URL)
  if (password && !token) return tunnelUrl;
  if (token) return `${tunnelUrl}?token=${token}`;
  return tunnelUrl;
}
