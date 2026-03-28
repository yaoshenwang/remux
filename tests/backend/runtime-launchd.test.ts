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

describe("runtime launchd install", () => {
  test("writes runtime plists to a stable worktree root outside the checkout", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-launchd-test-"));
    tempDirs.push(tempHome);

    execFileSync("bash", ["scripts/install-launchd.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome
      },
      stdio: "pipe"
    });

    const plistPath = path.join(tempHome, "Library", "LaunchAgents", "com.remux.dev.plist");
    const plist = await fs.promises.readFile(plistPath, "utf8");

    expect(plist).toContain(path.join(tempHome, ".remux", "runtime-worktrees", "runtime-dev"));
    expect(plist).not.toContain(path.join(process.cwd(), ".worktrees", "runtime-dev"));
  });

  test("writes the resolved runtime node binary and PATH prefix into launchd plists", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-node-plist-test-"));
    tempDirs.push(tempHome);

    const runtimeNodeDir = path.join(tempHome, "toolchains", "node-lts", "bin");
    const runtimeNodeBin = path.join(runtimeNodeDir, "node");
    const cargoHome = path.join(tempHome, ".cargo");
    const cargoBinDir = path.join(cargoHome, "bin");
    const expectedPath = `${runtimeNodeDir}:${cargoBinDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
    await fs.promises.mkdir(runtimeNodeDir, { recursive: true });
    await fs.promises.writeFile(runtimeNodeBin, "#!/bin/bash\nexit 0\n", { mode: 0o755 });

    execFileSync("bash", ["scripts/install-launchd.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
        CARGO_HOME: cargoHome,
        REMUX_RUNTIME_NODE_BIN: runtimeNodeBin
      },
      stdio: "pipe"
    });

    const runtimePlistPath = path.join(tempHome, "Library", "LaunchAgents", "com.remux.dev.plist");
    const runtimePlist = await fs.promises.readFile(runtimePlistPath, "utf8");
    expect(runtimePlist).toContain(runtimeNodeBin);
    expect(runtimePlist).toContain(expectedPath);
    expect(runtimePlist).toContain("<key>REMUXD_BASE_URL</key>");
    expect(runtimePlist).toContain("<string>http://127.0.0.1:3737</string>");
    expect(runtimePlist).toContain("<key>REMUX_RUNTIME_V2_REQUIRED</key>");
    expect(runtimePlist).toContain("<string>1</string>");

    const syncPlistPath = path.join(tempHome, "Library", "LaunchAgents", "com.remux.runtime-sync.plist");
    const syncPlist = await fs.promises.readFile(syncPlistPath, "utf8");
    expect(syncPlist).toContain(expectedPath);

    const sharedRuntimePlistPath = path.join(tempHome, "Library", "LaunchAgents", "com.remux.runtime-v2-shared.plist");
    const sharedRuntimePlist = await fs.promises.readFile(sharedRuntimePlistPath, "utf8");
    expect(sharedRuntimePlist).toContain(expectedPath);
    expect(sharedRuntimePlist).toContain("<string>cargo</string>");
    expect(sharedRuntimePlist).toContain("<string>run</string>");
    expect(sharedRuntimePlist).toContain("<string>-p</string>");
    expect(sharedRuntimePlist).toContain("<string>remuxd</string>");
    expect(sharedRuntimePlist).toContain("<string>3737</string>");
  });

  test("writes the runtime sync plist against the stable dev runtime worktree", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-sync-plist-test-"));
    tempDirs.push(tempHome);

    execFileSync("bash", ["scripts/install-launchd.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome
      },
      stdio: "pipe"
    });

    const plistPath = path.join(tempHome, "Library", "LaunchAgents", "com.remux.runtime-sync.plist");
    const plist = await fs.promises.readFile(plistPath, "utf8");

    expect(plist).toContain(path.join(tempHome, ".remux", "runtime-worktrees", "runtime-dev", "scripts", "sync-runtime.sh"));
    expect(plist).toContain(path.join(tempHome, ".remux", "runtime-worktrees", "runtime-dev"));
    expect(plist).not.toContain(path.join(process.cwd(), "scripts", "sync-runtime.sh"));
    expect(plist).not.toContain(process.cwd());
  });

  test("writes a shared runtime-v2 launchd plist against the stable dev runtime worktree", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-shared-plist-test-"));
    tempDirs.push(tempHome);

    execFileSync("bash", ["scripts/install-launchd.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome
      },
      stdio: "pipe"
    });

    const plistPath = path.join(tempHome, "Library", "LaunchAgents", "com.remux.runtime-v2-shared.plist");
    const plist = await fs.promises.readFile(plistPath, "utf8");

    expect(plist).toContain(path.join(tempHome, ".remux", "runtime-worktrees", "runtime-dev"));
    expect(plist).toContain("<string>cargo</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>--manifest-path</string>");
    expect(plist).toContain("<string>Cargo.toml</string>");
    expect(plist).toContain("<string>remuxd</string>");
    expect(plist).toContain("<string>127.0.0.1</string>");
    expect(plist).toContain("<string>3737</string>");
    expect(plist).not.toContain(process.cwd());
  });

  test("restarts an already-loaded runtime with kickstart when the working directory already matches", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-restart-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    const launchAgentsDir = path.join(tempHome, "Library", "LaunchAgents");
    const runtimeRoot = path.join(tempHome, ".remux", "runtime-worktrees");
    const logPath = path.join(tempHome, "launchctl.log");
    const plistPath = path.join(launchAgentsDir, "com.remux.dev.plist");

    await fs.promises.mkdir(fakeBinDir, { recursive: true });
    await fs.promises.mkdir(launchAgentsDir, { recursive: true });
    await fs.promises.mkdir(path.join(runtimeRoot, "runtime-dev"), { recursive: true });
    await fs.promises.writeFile(plistPath, "<plist />\n");
    await fs.promises.writeFile(
      path.join(fakeBinDir, "launchctl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
if [[ "$1" == "print" ]]; then
  cat <<'EOF'
working directory = ${runtimeRoot}/runtime-dev
EOF
  exit 0
fi
exit 0
`,
      { mode: 0o755 }
    );

    execFileSync(
      "bash",
      [
        "-c",
        "source scripts/runtime-lib.sh && restart_runtime_service dev"
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
    );

    const log = await fs.promises.readFile(logPath, "utf8");
    expect(log).toContain(`print gui/${process.getuid?.() ?? process.getuid()}/com.remux.dev`);
    expect(log).toContain(`kickstart -k gui/${process.getuid?.() ?? process.getuid()}/com.remux.dev`);
    expect(log).not.toContain("bootout");
    expect(log).not.toContain("bootstrap");
  });
});
