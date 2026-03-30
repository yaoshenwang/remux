/**
 * Auto-detect the best available session backend.
 *
 * Strategy:
 * - If zellij is available → use zellij (current default)
 * - If zellij is not available but tmux is → fallback option
 * - If neither is available (Windows, or Unix without multiplexer) → ConPTY
 *
 * This module provides detection utilities. The actual server creation
 * remains in server-zellij.ts (for zellij) or can use ConPtySessionProvider
 * for platforms without a terminal multiplexer.
 */

import { execFileSync } from "node:child_process";
import os from "node:os";

export type SessionBackendKind = "zellij" | "tmux" | "conpty";

export interface DetectedBackend {
  kind: SessionBackendKind;
  binPath?: string;
}

/**
 * Detect the best available session backend for this platform.
 */
export function detectSessionBackend(
  logger?: Pick<Console, "log" | "error">,
  options?: {
    /** Force a specific backend. */
    force?: SessionBackendKind;
  }
): DetectedBackend {
  if (options?.force) {
    logger?.log(`[detect] forced ${options.force} backend`);
    return { kind: options.force };
  }

  // On Windows, zellij and tmux are almost never available natively.
  if (os.platform() === "win32") {
    logger?.log("[detect] Windows platform, using conpty backend");
    return { kind: "conpty" };
  }

  // Try zellij first.
  const zellijPath = findBinary("zellij", logger);
  if (zellijPath) {
    logger?.log(`[detect] zellij found at ${zellijPath}, using zellij backend`);
    return { kind: "zellij", binPath: zellijPath };
  }

  // Try tmux.
  const tmuxPath = findBinary("tmux", logger);
  if (tmuxPath) {
    logger?.log(`[detect] tmux found at ${tmuxPath}, using tmux backend`);
    return { kind: "tmux", binPath: tmuxPath };
  }

  // Neither available — use ConPTY.
  logger?.log("[detect] no terminal multiplexer found, using conpty backend");
  return { kind: "conpty" };
}

function findBinary(
  name: string,
  logger?: Pick<Console, "log" | "error">
): string | undefined {
  try {
    const result = execFileSync("which", [name], {
      stdio: "pipe",
      timeout: 3000,
      encoding: "utf8",
    });
    return result.trim() || undefined;
  } catch {
    logger?.log(`[detect] ${name} not found in PATH`);
    return undefined;
  }
}
