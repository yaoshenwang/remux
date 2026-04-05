/**
 * Launchd service management for Remux.
 * Provides install/uninstall/status for macOS background service.
 *
 * Plist goes to ~/Library/LaunchAgents/com.remux.agent.plist
 * Logs go to ~/.remux/logs/
 *
 * Inspired by Homebrew's launchd service pattern and similar projects
 * (e.g. remodex) that use launchd for daemon management.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const LABEL = "com.remux.agent";
export const PLIST_DIR = path.join(homedir(), "Library", "LaunchAgents");
export const PLIST_PATH = path.join(PLIST_DIR, `${LABEL}.plist`);
export const LOG_DIR = path.join(homedir(), ".remux", "logs");
export const SERVER_JS = path.join(__dirname, "server.js");

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate launchd plist XML content.
 */
export function generatePlist(options: {
  port?: number;
  args?: string[];
} = {}): string {
  const { port, args = [] } = options;

  const programArgs = [process.execPath, SERVER_JS, ...args];
  const programArgsXml = programArgs
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");

  // Build EnvironmentVariables section
  const envVars: Record<string, string> = {};
  if (port) envVars.PORT = String(port);
  if (process.env.REMUX_TOKEN) envVars.REMUX_TOKEN = process.env.REMUX_TOKEN;

  let envXml = "";
  if (Object.keys(envVars).length > 0) {
    const entries = Object.entries(envVars)
      .map(
        ([k, v]) =>
          `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`,
      )
      .join("\n");
    envXml = `
  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(__dirname)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(LOG_DIR, "remux.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(LOG_DIR, "remux.err"))}</string>${envXml}
</dict>
</plist>
`;
}

/**
 * Install and start the launchd service.
 */
export function installService(options: {
  port?: number;
  args?: string[];
} = {}): void {
  // Create log directory
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Unload existing service if present
  if (fs.existsSync(PLIST_PATH)) {
    try {
      execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
    } catch {
      // May fail if not loaded, that's fine
    }
  }

  // Write plist
  const xml = generatePlist(options);
  fs.writeFileSync(PLIST_PATH, xml);

  // Load service
  execSync(`launchctl load "${PLIST_PATH}"`, { stdio: "pipe" });

  console.log(`[remux] Service installed and started.`);
  console.log(`[remux]   Plist: ${PLIST_PATH}`);
  console.log(`[remux]   Logs:  ${LOG_DIR}/`);
}

/**
 * Uninstall the launchd service.
 */
export function uninstallService(): void {
  if (!fs.existsSync(PLIST_PATH)) {
    console.log(`[remux] Service is not installed.`);
    return;
  }

  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch {
    // May fail if not loaded
  }

  fs.unlinkSync(PLIST_PATH);
  console.log(`[remux] Service uninstalled.`);
}

/**
 * Check service status.
 */
export function serviceStatus(): {
  installed: boolean;
  running: boolean;
  pid?: number;
} {
  if (!fs.existsSync(PLIST_PATH)) {
    return { installed: false, running: false };
  }

  try {
    const output = execSync(`launchctl list ${LABEL}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    // Output format: "PID\tStatus\tLabel"
    // PID is a number if running, "-" if not
    const firstLine = output.trim().split("\n").pop();
    const pid = firstLine?.split("\t")[0];
    if (pid && pid !== "-" && !isNaN(Number(pid))) {
      return { installed: true, running: true, pid: Number(pid) };
    }
    return { installed: true, running: false };
  } catch {
    return { installed: true, running: false };
  }
}

/**
 * Handle `remux service <subcommand>` from argv.
 * Returns true if a service command was handled (caller should exit).
 */
export function handleServiceCommand(argv: string[]): boolean {
  // argv[0] = node, argv[1] = server.js, argv[2] = "service"
  if (argv.length < 4 || argv[2] !== "service") return false;

  const subcommand = argv[3];

  switch (subcommand) {
    case "install": {
      const opts: { port?: number; args?: string[] } = {};
      const portIdx = argv.indexOf("--port");
      if (portIdx !== -1 && argv[portIdx + 1]) {
        opts.port = Number(argv[portIdx + 1]);
      }
      // Collect extra args after install (excluding --port N)
      const extra: string[] = [];
      for (let i = 4; i < argv.length; i++) {
        if (argv[i] === "--port") {
          i++; // skip value
          continue;
        }
        extra.push(argv[i]);
      }
      if (extra.length) opts.args = extra;
      installService(opts);
      return true;
    }
    case "uninstall":
      uninstallService();
      return true;
    case "status": {
      const st = serviceStatus();
      if (!st.installed) {
        console.log("[remux] Service is not installed.");
      } else if (st.running) {
        console.log(`[remux] Service is running (PID ${st.pid}).`);
      } else {
        console.log("[remux] Service is installed but not running.");
      }
      return true;
    }
    default:
      console.error(
        `[remux] Unknown service command: ${subcommand}\n` +
          `Usage: remux service <install|uninstall|status>`,
      );
      return true;
  }
}
