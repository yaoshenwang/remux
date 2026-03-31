/**
 * Cloudflare Tunnel support for Remux.
 * Detects cloudflared, spawns a quick tunnel, parses the URL.
 * Adapted from cloudflare/cloudflared quick-tunnel pattern.
 */

import { spawn, execFile } from "child_process";

// ── CLI arg parsing ─────────────────────────────────────────────

/**
 * Parse tunnel-related CLI flags from argv.
 * @param {string[]} argv - process.argv or equivalent
 * @returns {{ tunnelMode: "enable" | "disable" | "auto" }}
 */
export function parseTunnelArgs(argv) {
  if (argv.includes("--no-tunnel")) return { tunnelMode: "disable" };
  if (argv.includes("--tunnel")) return { tunnelMode: "enable" };
  return { tunnelMode: "auto" };
}

// ── cloudflared detection ───────────────────────────────────────

/**
 * Check if cloudflared is available on PATH.
 * @returns {Promise<boolean>}
 */
export function isCloudflaredAvailable() {
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
 * @param {number} port - local HTTP server port
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - signal to abort the tunnel
 * @returns {Promise<{ url: string, process: import("child_process").ChildProcess }>}
 */
export function startTunnel(port, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;
    let output = "";
    const TIMEOUT_MS = 30_000;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("cloudflared tunnel URL not detected within 30s"));
      }
    }, TIMEOUT_MS);

    function handleData(data) {
      output += data.toString();
      const match = output.match(TUNNEL_URL_RE);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ url: match[0], process: child });
      }
    }

    // cloudflared logs connection info to stderr
    child.stderr.on("data", handleData);
    child.stdout.on("data", handleData);

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
        reject(new Error(`cloudflared exited with code ${code} before URL was detected`));
      }
    });

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
      }, { once: true });
    }
  });
}

/**
 * Build the full tunnel access URL, appending auth token if present.
 * @param {string} tunnelUrl - base tunnel URL
 * @param {string|null} token - auth token (TOKEN or null)
 * @param {string|null} password - auth password (PASSWORD or null)
 * @returns {string}
 */
export function buildTunnelAccessUrl(tunnelUrl, token, password) {
  // If password auth, the user logs in via the password page (no token in URL)
  if (password && !token) return tunnelUrl;
  if (token) return `${tunnelUrl}?token=${token}`;
  return tunnelUrl;
}
