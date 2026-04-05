#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { smokeNpmPackageSpec } from "./lib/package-smoke.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remux-pack-smoke-"));
  const packDir = path.join(tempRoot, "pack");

  await fs.mkdir(packDir, { recursive: true });

  await exec("node", ["build.mjs"]);
  await exec("npm", ["pack", "--pack-destination", packDir]);

  const tarballName = (await fs.readdir(packDir)).find((entry) => entry.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error("npm pack did not produce a tarball");
  }

  const tarballPath = path.join(packDir, tarballName);

  await smokeNpmPackageSpec(tarballPath, { cwd: REPO_ROOT });
  console.log(`PASS package smoke: ${tarballName}`);
}

main().catch((error) => {
  console.error(`FAIL package smoke: ${error.message}`);
  process.exitCode = 1;
});
