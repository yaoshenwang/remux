#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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

async function waitForServer(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (response.ok) {
        return;
      }
    } catch {}

    await delay(500);
  }

  throw new Error(`server did not become ready within ${timeoutMs}ms: ${url}`);
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remux-pack-smoke-"));
  const packDir = path.join(tempRoot, "pack");
  const installDir = path.join(tempRoot, "install");
  const remuxHome = path.join(tempRoot, "home");

  await fs.mkdir(packDir, { recursive: true });
  await fs.mkdir(installDir, { recursive: true });
  await fs.mkdir(remuxHome, { recursive: true });
  await fs.writeFile(path.join(installDir, "package.json"), '{"name":"remux-pack-smoke","private":true}\n');

  await exec("node", ["build.mjs"]);
  await exec("npm", ["pack", "--pack-destination", packDir]);

  const tarballName = (await fs.readdir(packDir)).find((entry) => entry.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error("npm pack did not produce a tarball");
  }

  const tarballPath = path.join(packDir, tarballName);

  await exec("npm", ["install", "--prefix", installDir, tarballPath], {
    env: {
      ...process.env,
      npm_config_loglevel: "error",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });

  const port = "28767";
  const token = "release-smoke-token";
  const binPath = path.join(
    installDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "remux.cmd" : "remux",
  );

  const child = spawn(binPath, [], {
    cwd: installDir,
    env: {
      ...process.env,
      PORT: port,
      REMUX_HOME: remuxHome,
      REMUX_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(`http://127.0.0.1:${port}/?token=${token}`, 30000);
    console.log(`PASS package smoke: ${tarballName}`);
  } finally {
    child.kill("SIGTERM");
    await delay(500);
    if (!child.killed) child.kill("SIGKILL");
  }

  if (stderr.trim()) {
    console.error(stderr.trim());
  }
}

main().catch((error) => {
  console.error(`FAIL package smoke: ${error.message}`);
  process.exitCode = 1;
});
