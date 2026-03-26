import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

export interface RuntimeMetadata {
  version: string;
  gitBranch?: string;
  gitCommitSha?: string;
  gitDirty?: boolean;
}

const require = createRequire(import.meta.url);

const packageJson = require("../../../package.json") as { version: string };

const runGit = (args: string[]): string | undefined => {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
};

export const readRuntimeMetadata = (): RuntimeMetadata => {
  const branchFromEnv = process.env.REMUX_RUNTIME_BRANCH?.trim();
  const branchFromGit = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const gitBranch = branchFromEnv || (branchFromGit && branchFromGit !== "HEAD" ? branchFromGit : undefined);

  const gitCommitSha = runGit(["rev-parse", "HEAD"]);
  const dirtyState = runGit(["status", "--porcelain", "--untracked-files=no"]);
  const gitDirty = dirtyState !== undefined ? dirtyState.length > 0 : undefined;

  return {
    version: packageJson.version,
    ...(gitBranch ? { gitBranch } : {}),
    ...(gitCommitSha ? { gitCommitSha } : {}),
    ...(gitDirty !== undefined ? { gitDirty } : {})
  };
};
