import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

const writeRuntimeContractSource = async (
  dir: string,
  options?: {
    version?: string;
    protocolVersion?: string;
    controlWebsocketPath?: string;
    terminalWebsocketPath?: string;
  },
): Promise<void> => {
  const version = options?.version ?? "0.2.99";
  const protocolVersion = options?.protocolVersion ?? "2026-03-27-draft";
  const controlWebsocketPath = options?.controlWebsocketPath ?? "/v2/control";
  const terminalWebsocketPath = options?.terminalWebsocketPath ?? "/v2/terminal";

  await fs.promises.mkdir(path.join(dir, "crates", "remux-core", "src"), { recursive: true });
  await fs.promises.mkdir(path.join(dir, "crates", "remux-server", "src"), { recursive: true });
  await fs.promises.writeFile(path.join(dir, "package.json"), JSON.stringify({ version }, null, 2));
  await fs.promises.writeFile(
    path.join(dir, "crates", "remux-core", "src", "lib.rs"),
    `pub const RUNTIME_V2_PROTOCOL_VERSION: &str = "${protocolVersion}";\n`,
  );
  await fs.promises.writeFile(
    path.join(dir, "crates", "remux-server", "src", "lib.rs"),
    `fn build_router() {\n    Router::new()\n        .route("${controlWebsocketPath}", get(control_socket))\n        .route("${terminalWebsocketPath}", get(terminal_socket));\n}\n`,
  );
};

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

  test("reads a runtime-v2 contract from source files", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-contract-source-test-"));
    tempDirs.push(tempHome);

    const targetDir = path.join(tempHome, "runtime-source");
    await writeRuntimeContractSource(targetDir, {
      version: "0.3.10",
      protocolVersion: "2026-04-02",
      controlWebsocketPath: "/v3/control",
      terminalWebsocketPath: "/v3/terminal",
    });

    const output = execFileSync(
      "bash",
      ["-c", "source scripts/runtime-lib.sh && source_runtime_contract_json \"$TARGET_DIR\""],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TARGET_DIR: targetDir,
        },
        stdio: "pipe",
      },
    ).toString("utf8");

    expect(JSON.parse(output)).toMatchObject({
      version: "0.3.10",
      protocolVersion: "2026-04-02",
      controlWebsocketPath: "/v3/control",
      terminalWebsocketPath: "/v3/terminal",
    });
  });

  test("summarizes mismatched runtime-v2 contracts between target and gateway sources", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-contract-diff-test-"));
    tempDirs.push(tempHome);

    const targetDir = path.join(tempHome, "target");
    const gatewayDir = path.join(tempHome, "gateway");
    await writeRuntimeContractSource(targetDir, {
      protocolVersion: "2026-04-02",
      controlWebsocketPath: "/v3/control",
      terminalWebsocketPath: "/v3/terminal",
    });
    await writeRuntimeContractSource(gatewayDir, {
      protocolVersion: "2026-03-27-draft",
      controlWebsocketPath: "/v2/control",
      terminalWebsocketPath: "/v2/terminal",
    });

    const output = execFileSync(
      "bash",
      [
        "-c",
        "source scripts/runtime-lib.sh && TARGET=$(source_runtime_contract_json \"$TARGET_DIR\") && GATEWAY=$(source_runtime_contract_json \"$GATEWAY_DIR\") && runtime_contract_diff_summary \"$TARGET\" \"$GATEWAY\"",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TARGET_DIR: targetDir,
          GATEWAY_DIR: gatewayDir,
        },
        stdio: "pipe",
      },
    ).toString("utf8");

    expect(output).toContain("protocolVersion expected=2026-03-27-draft actual=2026-04-02");
    expect(output).toContain("controlWebsocketPath expected=/v2/control actual=/v3/control");
    expect(output).toContain("terminalWebsocketPath expected=/v2/terminal actual=/v3/terminal");
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
    const sharedWorkdir = path.join(runtimeRoot, "runtime-shared");
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

  test("reloads the shared runtime daemon when launchd still points at the old worktree", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-shared-migrate-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    const launchAgentsDir = path.join(tempHome, "Library", "LaunchAgents");
    const runtimeRoot = path.join(tempHome, ".remux", "runtime-worktrees");
    const staleWorkdir = path.join(runtimeRoot, "runtime-dev");
    const sharedWorkdir = path.join(runtimeRoot, "runtime-shared");
    const launchctlLogPath = path.join(tempHome, "launchctl.log");

    await fs.promises.mkdir(fakeBinDir, { recursive: true });
    await fs.promises.mkdir(launchAgentsDir, { recursive: true });
    await fs.promises.mkdir(staleWorkdir, { recursive: true });
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
working directory = ${staleWorkdir}
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

    expect(() =>
      execFileSync(
        "bash",
        ["-c", "source scripts/runtime-lib.sh && ensure_shared_runtime_running"],
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
    expect(log).toContain(`bootout gui/${process.getuid?.() ?? process.getuid()} ${path.join(launchAgentsDir, "com.remux.runtime-v2-shared.plist")}`);
    expect(log).toContain(`bootstrap gui/${process.getuid?.() ?? process.getuid()} ${path.join(launchAgentsDir, "com.remux.runtime-v2-shared.plist")}`);
  });

  test("restarts a healthy shared runtime daemon when its reported sha is stale", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-shared-restart-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    const launchAgentsDir = path.join(tempHome, "Library", "LaunchAgents");
    const runtimeRoot = path.join(tempHome, ".remux", "runtime-worktrees");
    const sharedWorkdir = path.join(runtimeRoot, "runtime-shared");
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
    const sharedWorkdir = path.join(runtimeRoot, "runtime-shared");
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

  test("does not mark the shared runtime for restart during a default dev dry-run", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-dry-run-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    const runtimeRoot = path.join(tempHome, ".remux", "runtime-worktrees");
    const runtimeNodeDir = path.join(tempHome, "toolchains", "node-lts", "bin");
    const cargoHome = path.join(tempHome, ".cargo");
    const cargoBinDir = path.join(cargoHome, "bin");
    const runtimeNodeBin = path.join(runtimeNodeDir, "node");
    const runtimeCargoBin = path.join(cargoBinDir, "cargo");
    const launchctlLogPath = path.join(tempHome, "launchctl.log");

    await fs.promises.mkdir(fakeBinDir, { recursive: true });
    await fs.promises.mkdir(path.join(runtimeRoot, "runtime-dev"), { recursive: true });
    await fs.promises.mkdir(path.join(runtimeRoot, "runtime-shared"), { recursive: true });
    await fs.promises.mkdir(runtimeNodeDir, { recursive: true });
    await fs.promises.mkdir(cargoBinDir, { recursive: true });
    await fs.promises.writeFile(runtimeNodeBin, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    await fs.promises.writeFile(runtimeCargoBin, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    execFileSync("bash", ["scripts/install-launchd.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
        REMUX_RUNTIME_WORKTREE_ROOT: runtimeRoot,
        REMUX_RUNTIME_NODE_BIN: runtimeNodeBin,
        CARGO_HOME: cargoHome
      },
      stdio: "pipe"
    });

    await fs.promises.writeFile(
      path.join(fakeBinDir, "git"),
      `#!/bin/bash
set -euo pipefail
if [[ "$*" == *"fetch origin --prune"* ]]; then
  exit 0
fi
if [[ "$*" == *"rev-parse --is-inside-work-tree"* ]]; then
  printf 'true\\n'
  exit 0
fi
if [[ "$*" == *"rev-parse HEAD"* ]]; then
  if [[ "$*" == *"runtime-shared"* ]]; then
    printf 'shared-current-sha\\n'
  else
    printf 'dev-current-sha\\n'
  fi
  exit 0
fi
if [[ "$*" == *"rev-parse origin/dev"* ]]; then
  printf 'dev-target-sha\\n'
  exit 0
fi
if [[ "$*" == *"show origin/dev:package.json"* ]]; then
  printf '%s' '{"version":"0.2.99"}'
  exit 0
fi
if [[ "$*" == *"show HEAD:package.json"* ]]; then
  printf '%s' '{"version":"0.2.98"}'
  exit 0
fi
if [[ "$*" == *"status --porcelain --untracked-files=no"* ]]; then
  exit 0
fi
if [[ "$*" == *"diff --quiet"* ]]; then
  exit 1
fi
echo "unexpected git invocation: $*" >&2
exit 1
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
    await fs.promises.writeFile(
      path.join(fakeBinDir, "launchctl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${launchctlLogPath}"
if [[ "$1" == "print" ]]; then
  if [[ "$2" == *"com.remux.dev" ]]; then
    cat <<'EOF'
working directory = ${runtimeRoot}/runtime-dev
environment = {
  REMUX_RUNTIME_BRANCH => dev
  REMUXD_BASE_URL => http://127.0.0.1:3737
  REMUX_RUNTIME_V2_REQUIRED => 1
  REMUX_LOCAL_WS_ORIGIN => ws://127.0.0.1:3457
}
EOF
    exit 0
  fi
  cat <<'EOF'
working directory = ${runtimeRoot}/runtime-shared
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

    const output = execFileSync("bash", ["scripts/sync-runtime.sh", "dev", "--dry-run"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        REMUX_RUNTIME_WORKTREE_ROOT: runtimeRoot,
        REMUX_RUNTIME_NODE_BIN: runtimeNodeBin,
        CARGO_HOME: cargoHome
      },
      stdio: "pipe"
    }).toString("utf8");

    expect(output).toContain("[sync] dry-run dev");
    expect(output).toContain("shared-v2:    false");
  });

  test("marks the shared runtime for restart when dev dry-run explicitly promotes it", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-promote-dry-run-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    const runtimeRoot = path.join(tempHome, ".remux", "runtime-worktrees");
    const runtimeNodeDir = path.join(tempHome, "toolchains", "node-lts", "bin");
    const cargoHome = path.join(tempHome, ".cargo");
    const cargoBinDir = path.join(cargoHome, "bin");
    const runtimeNodeBin = path.join(runtimeNodeDir, "node");
    const runtimeCargoBin = path.join(cargoBinDir, "cargo");
    const launchctlLogPath = path.join(tempHome, "launchctl.log");
    const sharedStatePath = path.join(tempHome, "shared-state");

    await fs.promises.mkdir(fakeBinDir, { recursive: true });
    await fs.promises.mkdir(path.join(runtimeRoot, "runtime-dev"), { recursive: true });
    await fs.promises.mkdir(path.join(runtimeRoot, "runtime-shared"), { recursive: true });
    await fs.promises.mkdir(runtimeNodeDir, { recursive: true });
    await fs.promises.mkdir(cargoBinDir, { recursive: true });
    await fs.promises.writeFile(runtimeNodeBin, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    await fs.promises.writeFile(runtimeCargoBin, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    await fs.promises.writeFile(sharedStatePath, "stale\n");
    execFileSync("bash", ["scripts/install-launchd.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
        REMUX_RUNTIME_WORKTREE_ROOT: runtimeRoot,
        REMUX_RUNTIME_NODE_BIN: runtimeNodeBin,
        CARGO_HOME: cargoHome
      },
      stdio: "pipe"
    });

    await fs.promises.writeFile(
      path.join(fakeBinDir, "git"),
      `#!/bin/bash
set -euo pipefail
if [[ "$*" == *"fetch origin --prune"* ]]; then
  exit 0
fi
if [[ "$*" == *"rev-parse --is-inside-work-tree"* ]]; then
  printf 'true\\n'
  exit 0
fi
if [[ "$*" == *"rev-parse HEAD"* ]]; then
  if [[ "$*" == *"runtime-shared"* ]]; then
    printf 'shared-current-sha\\n'
  else
    printf 'dev-current-sha\\n'
  fi
  exit 0
fi
if [[ "$*" == *"rev-parse origin/dev"* ]]; then
  printf 'dev-target-sha\\n'
  exit 0
fi
if [[ "$*" == *"show origin/dev:package.json"* ]]; then
  printf '%s' '{"version":"0.2.99"}'
  exit 0
fi
if [[ "$*" == *"show HEAD:package.json"* ]]; then
  if [[ "$*" == *"runtime-shared"* ]]; then
    printf '%s' '{"version":"0.2.98"}'
  else
    printf '%s' '{"version":"0.2.98"}'
  fi
  exit 0
fi
if [[ "$*" == *"status --porcelain --untracked-files=no"* ]]; then
  exit 0
fi
if [[ "$*" == *"diff --quiet"* ]]; then
  exit 1
fi
echo "unexpected git invocation: $*" >&2
exit 1
`,
      { mode: 0o755 }
    );
    await fs.promises.writeFile(
      path.join(fakeBinDir, "curl"),
      `#!/bin/bash
set -euo pipefail
if [[ "$*" == *"/v2/meta"* ]]; then
  if [[ "$(cat "${sharedStatePath}")" == "stale" ]]; then
    printf '%s' '{"service":"remuxd","version":"0.2.98","protocolVersion":"2026-03-27-draft","controlWebsocketPath":"/v2/control","terminalWebsocketPath":"/v2/terminal","gitBranch":"dev","gitCommitSha":"shared-current-sha","gitDirty":false}'
  else
    printf '%s' '{"service":"remuxd","version":"0.2.99","protocolVersion":"2026-03-27-draft","controlWebsocketPath":"/v2/control","terminalWebsocketPath":"/v2/terminal","gitBranch":"dev","gitCommitSha":"dev-target-sha","gitDirty":false}'
  fi
  exit 0
fi
exit 7
`,
      { mode: 0o755 }
    );
    await fs.promises.writeFile(
      path.join(fakeBinDir, "launchctl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${launchctlLogPath}"
if [[ "$1" == "print" ]]; then
  if [[ "$2" == *"com.remux.dev" ]]; then
    cat <<'EOF'
working directory = ${runtimeRoot}/runtime-dev
environment = {
  REMUX_RUNTIME_BRANCH => dev
  REMUXD_BASE_URL => http://127.0.0.1:3737
  REMUX_RUNTIME_V2_REQUIRED => 1
  REMUX_LOCAL_WS_ORIGIN => ws://127.0.0.1:3457
}
EOF
    exit 0
  fi
  cat <<'EOF'
working directory = ${runtimeRoot}/runtime-shared
environment = {
  REMUX_RUNTIME_BRANCH => dev
}
EOF
  exit 0
fi
if [[ "$1" == "kickstart" ]]; then
  printf 'fresh\\n' > "${sharedStatePath}"
fi
exit 0
`,
      { mode: 0o755 }
    );

    const output = execFileSync(
      "bash",
      ["scripts/sync-runtime.sh", "dev", "--dry-run", "--promote-shared-runtime"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          REMUX_RUNTIME_WORKTREE_ROOT: runtimeRoot,
          REMUX_RUNTIME_NODE_BIN: runtimeNodeBin,
          CARGO_HOME: cargoHome
        },
        stdio: "pipe"
      }
    ).toString("utf8");

    expect(output).toContain("[sync] dry-run dev");
    expect(output).toContain("shared-v2:    true");
  });
});
