/**
 * Auto-detect the best available session backend.
 *
 * Strategy (in order):
 * 1. If forced via options → use that backend
 * 2. If zellij is available → use ZellijCliExecutor + ZellijPtyFactory
 * 3. If tmux is available → use TmuxCliExecutor + NodePtyFactory
 * 4. Fallback → ConPtySessionProvider + ConPtyFactory
 */

import { execFileSync } from "node:child_process";
import os from "node:os";
import type { SessionGateway } from "../tmux/types.js";
import type { PtyFactory } from "../pty/pty-adapter.js";
import { TmuxCliExecutor } from "../tmux/cli-executor.js";
import { NodePtyFactory } from "../pty/node-pty-adapter.js";
import { ZellijCliExecutor, ZellijPtyFactory } from "../zellij/index.js";
import {
  ConPtySessionProvider,
  ConPtyFactory,
} from "./conpty-provider.js";

export interface SessionBackend {
  gateway: SessionGateway;
  ptyFactory: PtyFactory;
  kind: "tmux" | "zellij" | "conpty";
}

/**
 * Detect the best available session backend for this platform.
 */
export function detectSessionBackend(
  logger?: Pick<Console, "log" | "error">,
  options?: {
    /** Force a specific backend. */
    force?: "tmux" | "zellij" | "conpty";
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

  if (options?.force === "zellij") {
    logger?.log("[detect] forced zellij backend");
    return createZellijBackend(logger);
  }

  // Auto-detect: zellij → tmux → conpty
  if (isZellijAvailable(logger)) {
    logger?.log("[detect] zellij found in PATH, using zellij backend");
    return createZellijBackend(logger);
  }

  if (isTmuxAvailable(logger)) {
    logger?.log("[detect] tmux found in PATH, using tmux backend");
    return createTmuxBackend(logger, options);
  }

  logger?.log("[detect] no multiplexer found, using conpty backend");
  return createConPtyBackend(logger, options);
}

function isZellijAvailable(
  logger?: Pick<Console, "log" | "error">
): boolean {
  try {
    execFileSync("zellij", ["--version"], {
      stdio: "pipe",
      timeout: 3000,
    });
    return true;
  } catch {
    logger?.log("[detect] zellij --version failed or timed out");
    return false;
  }
}

function isTmuxAvailable(
  logger?: Pick<Console, "log" | "error">
): boolean {
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

function createZellijBackend(
  logger?: Pick<Console, "log" | "error">
): SessionBackend {
  const gateway = new ZellijCliExecutor({ logger });
  const ptyFactory = new ZellijPtyFactory({ logger });
  return { gateway, ptyFactory, kind: "zellij" };
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
