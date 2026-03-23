/**
 * Auto-detect whether to use tmux or the built-in ConPTY session provider.
 *
 * Strategy:
 * - If tmux is available in PATH → use TmuxCliExecutor + NodePtyFactory (existing behavior)
 * - If tmux is not available (Windows, or Unix without tmux) → use ConPtySessionProvider + ConPtyFactory
 */

import { execFileSync } from "node:child_process";
import os from "node:os";
import type { TmuxGateway } from "../tmux/types.js";
import type { PtyFactory } from "../pty/pty-adapter.js";
import { TmuxCliExecutor } from "../tmux/cli-executor.js";
import { NodePtyFactory } from "../pty/node-pty-adapter.js";
import {
  ConPtySessionProvider,
  ConPtyFactory,
} from "./conpty-provider.js";

export interface SessionBackend {
  gateway: TmuxGateway;
  ptyFactory: PtyFactory;
  /** "tmux" or "conpty" */
  kind: "tmux" | "conpty";
}

/**
 * Detect the best available session backend for this platform.
 */
export function detectSessionBackend(
  logger?: Pick<Console, "log" | "error">,
  options?: {
    /** Force a specific backend. */
    force?: "tmux" | "conpty";
    /** tmux socket name (-L flag). */
    socketName?: string;
    /** tmux socket path (-S flag). */
    socketPath?: string;
    /** Scrollback lines for ConPTY provider. */
    scrollbackLines?: number;
  }
): SessionBackend {
  if (options?.force === "conpty") {
    logger?.log("[detect] forced conpty backend");
    return createConPtyBackend(logger, options);
  }

  if (options?.force === "tmux") {
    logger?.log("[detect] forced tmux backend");
    return createTmuxBackend(logger, options);
  }

  // Auto-detect: try tmux first.
  if (isTmuxAvailable(logger)) {
    logger?.log("[detect] tmux found in PATH, using tmux backend");
    return createTmuxBackend(logger, options);
  }

  logger?.log("[detect] tmux not found, using conpty backend");
  return createConPtyBackend(logger, options);
}

function isTmuxAvailable(
  logger?: Pick<Console, "log" | "error">
): boolean {
  // On Windows, tmux is almost never available natively.
  if (os.platform() === "win32") {
    return false;
  }

  try {
    execFileSync("tmux", ["-V"], {
      stdio: "pipe",
      timeout: 3000,
    });
    return true;
  } catch {
    logger?.log("[detect] tmux -V failed or timed out");
    return false;
  }
}

function createTmuxBackend(
  logger?: Pick<Console, "log" | "error">,
  options?: { socketName?: string; socketPath?: string }
): SessionBackend {
  const gateway = new TmuxCliExecutor({
    socketName: options?.socketName,
    socketPath: options?.socketPath,
    logger,
  });
  const ptyFactory = new NodePtyFactory(logger);
  return { gateway, ptyFactory, kind: "tmux" };
}

function createConPtyBackend(
  logger?: Pick<Console, "log" | "error">,
  options?: { scrollbackLines?: number }
): SessionBackend {
  const provider = new ConPtySessionProvider(logger, {
    scrollbackLines: options?.scrollbackLines,
  });
  const ptyFactory = new ConPtyFactory(provider, logger);
  return { gateway: provider, ptyFactory, kind: "conpty" };
}
