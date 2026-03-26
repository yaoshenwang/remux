import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("runtime sync verification", () => {
  test("uses a stable sync lock outside the checkout", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-lock-test-"));
    tempDirs.push(tempHome);

    const output = execFileSync(
      "bash",
      ["-c", "source scripts/runtime-lib.sh && printf '%s' \"$SYNC_LOCK_DIR\""],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome
        },
        stdio: "pipe"
      }
    ).toString("utf8");

    expect(output).toBe(path.join(tempHome, ".remux", "runtime-sync.lock"));
    expect(output).not.toContain(process.cwd());
  });

  test("resolves the first executable runtime node from configured candidates", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-node-resolve-test-"));
    tempDirs.push(tempHome);

    const runtimeNodeDir = path.join(tempHome, "toolchains", "node-lts", "bin");
    const runtimeNodeBin = path.join(runtimeNodeDir, "node");
    const missingNodeBin = path.join(tempHome, "missing", "bin", "node");

    await fs.promises.mkdir(runtimeNodeDir, { recursive: true });
    await fs.promises.writeFile(runtimeNodeBin, "#!/bin/bash\nexit 0\n", { mode: 0o755 });

    const output = execFileSync("bash", ["-c", "source scripts/runtime-lib.sh && resolve_runtime_node_bin"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
        REMUX_RUNTIME_NODE_SEARCH_PATHS: `${missingNodeBin}:${runtimeNodeBin}`
      },
      stdio: "pipe"
    }).toString("utf8");

    expect(output.trim()).toBe(runtimeNodeBin);
  });

  test("installs runtime dependencies with dev packages even in production-like environments", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-install-test-"));
    tempDirs.push(tempHome);

    const runtimeNodeDir = path.join(tempHome, "toolchains", "node-lts", "bin");
    const runtimeDir = path.join(tempHome, "runtime-dir");
    const npmLogPath = path.join(tempHome, "npm.log");
    const runtimeNodeBin = path.join(runtimeNodeDir, "node");
    const runtimeNpmBin = path.join(runtimeNodeDir, "npm");
    await fs.promises.mkdir(runtimeNodeDir, { recursive: true });
    await fs.promises.mkdir(runtimeDir, { recursive: true });
    await fs.promises.writeFile(runtimeNodeBin, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    await fs.promises.writeFile(
      runtimeNpmBin,
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${npmLogPath}"
printf 'node=%s\\n' "$(command -v node)" >> "${npmLogPath}"
`,
      { mode: 0o755 }
    );

    execFileSync(
      "bash",
      [
        "-c",
        "source scripts/runtime-lib.sh && install_runtime_dependencies \"$TARGET_DIR\""
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          NODE_ENV: "production",
          REMUX_RUNTIME_NODE_SEARCH_PATHS: runtimeNodeBin,
          TARGET_DIR: runtimeDir
        },
        stdio: "pipe"
      }
    );

    await expect(fs.promises.readFile(npmLogPath, "utf8")).resolves.toContain("ci --include=dev");
    await expect(fs.promises.readFile(npmLogPath, "utf8")).resolves.toContain(`node=${runtimeNodeBin}`);
  });

  test("accepts legacy config payloads that only expose version", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-verify-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    await fs.promises.mkdir(fakeBinDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(fakeBinDir, "curl"),
      `#!/bin/bash
set -euo pipefail
printf '%s' '{"version":"0.1.48","passwordRequired":false}'
`,
      { mode: 0o755 }
    );

    const command = [
      "source scripts/runtime-lib.sh",
      "wait_for_runtime_api main deadbeef main 0.1.48",
      "verify_public_runtime main deadbeef main 0.1.48"
    ].join(" && ");

    expect(() =>
      execFileSync("bash", ["-c", command], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`
        },
        stdio: "pipe"
      })
    ).not.toThrow();
  });
});
