/**
 * Microsoft DevTunnel provider.
 *
 * Uses the `devtunnel` CLI to expose a local port with optional
 * Entra ID (Azure AD) authentication. DevTunnels are pre-installed
 * on Microsoft Dev Box and available via `winget install devtunnel`.
 *
 * When --allow-anonymous is NOT set, users must authenticate with
 * their Microsoft identity before accessing the tunnel URL.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TunnelProvider, TunnelResult } from "./types.js";

const execFileAsync = promisify(execFile);

const URL_REGEX = /https:\/\/[a-z0-9.-]+\.devtunnels\.ms/i;

export interface DevTunnelOptions {
  /** Allow anonymous access (no Entra auth). Default: false (Entra required). */
  allowAnonymous?: boolean;
  /** Write tunnel URL to this file for discoverability. */
  urlFile?: string;
}

export class DevTunnelManager implements TunnelProvider {
  private process?: ChildProcess;
  private tunnelId?: string;
  private readonly allowAnonymous: boolean;
  private readonly urlFile?: string;

  constructor(options?: DevTunnelOptions) {
    this.allowAnonymous = options?.allowAnonymous ?? false;
    this.urlFile = options?.urlFile;
  }

  async start(port: number): Promise<TunnelResult> {
    await this.ensureInstalled();
    await this.ensureLoggedIn();

    const args = ["host", "-p", String(port)];
    if (this.allowAnonymous) {
      args.push("--allow-anonymous");
    }

    this.process = spawn("devtunnel", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    return new Promise<TunnelResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for DevTunnel URL (30s)"));
      }, 30_000);

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        const match = text.match(URL_REGEX);
        if (!match) return;

        clearTimeout(timeout);
        const publicUrl = match[0];

        if (this.urlFile) {
          try {
            const dir = path.dirname(this.urlFile);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.urlFile, publicUrl, "utf8");
          } catch {
            // Non-fatal — just log.
          }
        }

        resolve({ publicUrl });
      };

      this.process?.stdout?.on("data", onData);
      this.process?.stderr?.on("data", onData);
      this.process?.on("exit", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(
            new Error(
              `devtunnel exited before URL was emitted (code ${code ?? -1})`
            )
          );
        }
      });
    });
  }

  stop(): void {
    if (this.process && !this.process.killed) {
      if (os.platform() === "win32") {
        // On Windows, spawn a taskkill for the process tree.
        spawn("taskkill", ["/pid", String(this.process.pid), "/t", "/f"], {
          stdio: "ignore",
        });
      } else {
        this.process.kill("SIGTERM");
      }
      this.process = undefined;
    }

    // Clean up URL file.
    if (this.urlFile) {
      try {
        fs.unlinkSync(this.urlFile);
      } catch {
        // Ignore.
      }
    }
  }

  private async ensureInstalled(): Promise<void> {
    try {
      await execFileAsync("devtunnel", ["--version"]);
    } catch {
      throw new Error(
        "devtunnel CLI not found. Install via: winget install Microsoft.devtunnel " +
          "or see https://learn.microsoft.com/azure/developer/dev-tunnels/"
      );
    }
  }

  private async ensureLoggedIn(): Promise<void> {
    try {
      const { stdout } = await execFileAsync("devtunnel", ["user", "show"]);
      if (stdout.includes("not logged in") || stdout.includes("No user")) {
        throw new Error("not logged in");
      }
    } catch {
      // Try device-code login (works headless).
      try {
        await execFileAsync("devtunnel", ["user", "login", "-d"], {
          timeout: 120_000,
        });
      } catch (loginError) {
        throw new Error(
          `DevTunnel login failed. Run 'devtunnel user login' manually. ${String(loginError)}`
        );
      }
    }
  }
}
