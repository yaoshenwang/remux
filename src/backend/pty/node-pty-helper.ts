import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const ensureNodePtySpawnHelperExecutable = (
  logger?: Pick<Console, "log" | "error">,
  options?: {
    platform?: NodeJS.Platform;
    processPlatform?: NodeJS.Platform;
    processArch?: string;
    resolveUnixTerminalPath?: () => string;
    existsSync?: (candidate: string) => boolean;
    chmodSync?: (candidate: string, mode: number) => void;
  },
): void => {
  const platform = options?.platform ?? os.platform();
  if (platform === "win32") {
    return;
  }

  const processPlatform = options?.processPlatform ?? process.platform;
  const processArch = options?.processArch ?? process.arch;
  const resolveUnixTerminalPath = options?.resolveUnixTerminalPath ?? (() => require.resolve("node-pty/lib/unixTerminal.js"));
  const existsSync = options?.existsSync ?? fs.existsSync;
  const chmodSync = options?.chmodSync ?? fs.chmodSync;

  try {
    const unixTerminalPath = resolveUnixTerminalPath();
    const rootDir = path.resolve(path.dirname(unixTerminalPath), "..");
    const candidates = [
      path.join(rootDir, "prebuilds", `${processPlatform}-${processArch}`, "spawn-helper"),
      path.join(rootDir, "build", "Release", "spawn-helper"),
      path.join(rootDir, "build", "Debug", "spawn-helper"),
    ];

    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        continue;
      }
      chmodSync(candidate, 0o755);
      logger?.log("node-pty spawn-helper is executable", candidate);
      return;
    }
  } catch (error) {
    logger?.error("unable to ensure node-pty spawn-helper permissions", error);
  }
};
