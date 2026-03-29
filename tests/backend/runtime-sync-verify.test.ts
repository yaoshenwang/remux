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

  test("does not reload a healthy shared runtime daemon", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-shared-load-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    const launchAgentsDir = path.join(tempHome, "Library", "LaunchAgents");
    const runtimeRoot = path.join(tempHome, ".remux", "runtime-worktrees");
    const sharedWorkdir = path.join(runtimeRoot, "runtime-dev");
    const launchctlLogPath = path.join(tempHome, "launchctl.log");

    await fs.promises.mkdir(fakeBinDir, { recursive: true });
    await fs.promises.mkdir(launchAgentsDir, { recursive: true });
    await fs.promises.mkdir(sharedWorkdir, { recursive: true });
    await fs.promises.writeFile(
      path.join(launchAgentsDir, "com.remux.runtime-v2-shared.plist"),
      "<plist />\n"
    );
    await fs.promises.writeFile(
      path.join(fakeBinDir, "launchctl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${launchctlLogPath}"
if [[ "$1" == "print" ]]; then
  cat <<'EOF'
working directory = ${sharedWorkdir}
environment = {
  REMUX_RUNTIME_BRANCH => dev
}
EOF
  exit 0
fi
exit 0
`,
      { mode: 0o755 }
    );
    await fs.promises.writeFile(
      path.join(fakeBinDir, "curl"),
      `#!/bin/bash
set -euo pipefail
printf '%s' '{"service":"remuxd","version":"0.2.18","protocolVersion":"2026-03-27-draft","controlWebsocketPath":"/v2/control","terminalWebsocketPath":"/v2/terminal","gitBranch":"dev","gitCommitSha":"abc123","gitDirty":false}'
`,
      { mode: 0o755 }
    );

    execFileSync(
      "bash",
      ["-c", "source scripts/runtime-lib.sh && load_shared_runtime_launchd"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          REMUX_RUNTIME_WORKTREE_ROOT: runtimeRoot
        },
        stdio: "pipe"
      }
    );

    const log = await fs.promises.readFile(launchctlLogPath, "utf8");
    expect(log).toContain(`print gui/${process.getuid?.() ?? process.getuid()}/com.remux.runtime-v2-shared`);
    expect(log).not.toContain("bootout");
    expect(log).not.toContain("bootstrap");
  });

  test("restarts a healthy shared runtime daemon when its reported sha is stale", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-shared-restart-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    const launchAgentsDir = path.join(tempHome, "Library", "LaunchAgents");
    const runtimeRoot = path.join(tempHome, ".remux", "runtime-worktrees");
    const sharedWorkdir = path.join(runtimeRoot, "runtime-dev");
    const launchctlLogPath = path.join(tempHome, "launchctl.log");
    const runtimeStatePath = path.join(tempHome, "shared-runtime-state");

    await fs.promises.mkdir(fakeBinDir, { recursive: true });
    await fs.promises.mkdir(launchAgentsDir, { recursive: true });
    await fs.promises.mkdir(sharedWorkdir, { recursive: true });
    await fs.promises.writeFile(path.join(launchAgentsDir, "com.remux.runtime-v2-shared.plist"), "<plist />\n");
    await fs.promises.writeFile(runtimeStatePath, "stale\n");
    await fs.promises.writeFile(
      path.join(fakeBinDir, "launchctl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${launchctlLogPath}"
if [[ "$1" == "print" ]]; then
  cat <<'EOF'
working directory = ${sharedWorkdir}
environment = {
  REMUX_RUNTIME_BRANCH => dev
}
EOF
  exit 0
fi
if [[ "$1" == "kickstart" ]]; then
  printf 'fresh\\n' > "${runtimeStatePath}"
fi
exit 0
`,
      { mode: 0o755 }
    );
    await fs.promises.writeFile(
      path.join(fakeBinDir, "curl"),
      `#!/bin/bash
set -euo pipefail
if [[ "$(cat "${runtimeStatePath}")" == "stale" ]]; then
  printf '%s' '{"service":"remuxd","version":"0.2.18","protocolVersion":"2026-03-27-draft","controlWebsocketPath":"/v2/control","terminalWebsocketPath":"/v2/terminal","gitBranch":"dev","gitCommitSha":"old-sha","gitDirty":false}'
else
  printf '%s' '{"service":"remuxd","version":"0.2.19","protocolVersion":"2026-03-27-draft","controlWebsocketPath":"/v2/control","terminalWebsocketPath":"/v2/terminal","gitBranch":"dev","gitCommitSha":"new-sha","gitDirty":false}'
fi
`,
      { mode: 0o755 }
    );

    expect(() =>
      execFileSync(
        "bash",
        [
          "-c",
          "source scripts/runtime-lib.sh && ensure_shared_runtime_matches_expected new-sha dev 0.2.19"
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: tempHome,
            PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
            REMUX_RUNTIME_WORKTREE_ROOT: runtimeRoot
          },
          stdio: "pipe"
        }
      )
    ).not.toThrow();

    const log = await fs.promises.readFile(launchctlLogPath, "utf8");
    expect(log).toContain(`print gui/${process.getuid?.() ?? process.getuid()}/com.remux.runtime-v2-shared`);
    expect(log).toContain(`kickstart -k gui/${process.getuid?.() ?? process.getuid()}/com.remux.runtime-v2-shared`);
    expect(log).not.toContain("bootout");
    expect(log).not.toContain("bootstrap");
  });

  test("bootstraps the shared runtime daemon when launchctl has not loaded it yet", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-shared-bootstrap-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    const launchAgentsDir = path.join(tempHome, "Library", "LaunchAgents");
    const runtimeRoot = path.join(tempHome, ".remux", "runtime-worktrees");
    const sharedWorkdir = path.join(runtimeRoot, "runtime-dev");
    const launchctlLogPath = path.join(tempHome, "launchctl.log");
    const sharedPlistPath = path.join(launchAgentsDir, "com.remux.runtime-v2-shared.plist");
    const sharedPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.remux.runtime-v2-shared</string>
  </dict>
</plist>
`;

    await fs.promises.mkdir(fakeBinDir, { recursive: true });
    await fs.promises.mkdir(launchAgentsDir, { recursive: true });
    await fs.promises.mkdir(sharedWorkdir, { recursive: true });
    await fs.promises.writeFile(sharedPlistPath, sharedPlist);
    await fs.promises.writeFile(
      path.join(fakeBinDir, "launchctl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${launchctlLogPath}"
if [[ "$1" == "print" ]]; then
  exit 113
fi
exit 0
`,
      { mode: 0o755 }
    );
    await fs.promises.writeFile(
      path.join(fakeBinDir, "curl"),
      `#!/bin/bash
set -euo pipefail
exit 7
`,
      { mode: 0o755 }
    );

    expect(() =>
      execFileSync(
        "bash",
        ["-c", "source scripts/runtime-lib.sh && load_shared_runtime_launchd"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: tempHome,
            PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
            REMUX_RUNTIME_WORKTREE_ROOT: runtimeRoot
          },
          stdio: "pipe"
        }
      )
    ).not.toThrow();

    const log = await fs.promises.readFile(launchctlLogPath, "utf8");
    expect(log).toContain(`print gui/${process.getuid?.() ?? process.getuid()}/com.remux.runtime-v2-shared`);
    expect(log).toContain(`bootout gui/${process.getuid?.() ?? process.getuid()} ${sharedPlistPath}`);
    expect(log).toContain(`bootstrap gui/${process.getuid?.() ?? process.getuid()} ${sharedPlistPath}`);
  });

  test("detects runtime launchd env drift when shared runtime variables are missing", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-env-drift-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    const runtimeRoot = path.join(tempHome, ".remux", "runtime-worktrees");
    const runtimeWorkdir = path.join(runtimeRoot, "runtime-dev");
    const launchctlLogPath = path.join(tempHome, "launchctl.log");

    await fs.promises.mkdir(fakeBinDir, { recursive: true });
    await fs.promises.mkdir(runtimeWorkdir, { recursive: true });
    await fs.promises.writeFile(
      path.join(fakeBinDir, "launchctl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${launchctlLogPath}"
if [[ "$1" == "print" ]]; then
  cat <<'EOF'
working directory = ${runtimeWorkdir}
environment = {
  REMUX_RUNTIME_BRANCH => dev
}
EOF
  exit 0
fi
exit 0
`,
      { mode: 0o755 }
    );

    expect(() =>
      execFileSync(
        "bash",
        [
          "-c",
          "source scripts/runtime-lib.sh && loaded_runtime_service_matches_expected dev"
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: tempHome,
            PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
            REMUX_RUNTIME_WORKTREE_ROOT: runtimeRoot
          },
          stdio: "pipe"
        }
      )
    ).toThrow();

    const log = await fs.promises.readFile(launchctlLogPath, "utf8");
    expect(log).toContain(`print gui/${process.getuid?.() ?? process.getuid()}/com.remux.dev`);
  });
});
