import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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

export async function waitForServer(url, timeoutMs) {
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

export async function smokeNpmPackageSpec(
  packageSpec,
  {
    cwd = process.cwd(),
    port = "28767",
    token = "release-smoke-token",
    timeoutMs = 30000,
  } = {},
) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remux-pack-smoke-"));
  const installDir = path.join(tempRoot, "install");
  const remuxHome = path.join(tempRoot, "home");

  await fs.mkdir(installDir, { recursive: true });
  await fs.mkdir(remuxHome, { recursive: true });
  await fs.writeFile(path.join(installDir, "package.json"), '{"name":"remux-pack-smoke","private":true}\n');

  await exec("npm", ["install", "--prefix", installDir, packageSpec], {
    cwd,
    env: {
      ...process.env,
      npm_config_loglevel: "error",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });

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
    await waitForServer(`http://127.0.0.1:${port}/?token=${token}`, timeoutMs);
  } finally {
    child.kill("SIGTERM");
    await delay(500);
    if (!child.killed) child.kill("SIGKILL");
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  return { stderr };
}
