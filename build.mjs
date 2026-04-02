/**
 * esbuild script — bundles src/ TypeScript modules into output files.
 * Two entry points:
 *   1. server.ts → server.js (main server)
 *   2. pty-daemon.ts → pty-daemon.js (independent PTY daemon process)
 * Externalizes native/npm dependencies (node-pty, ws, ghostty-web, qrcode-terminal).
 */

import esbuild from "esbuild";

const commonOptions = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["node-pty", "ws", "ghostty-web", "qrcode-terminal", "better-sqlite3", "web-push", "simple-git"],
};

// Main server bundle
esbuild.buildSync({
  ...commonOptions,
  entryPoints: ["src/server.ts"],
  outfile: "server.js",
  banner: { js: "#!/usr/bin/env node" },
});

// PTY daemon bundle (independent process)
esbuild.buildSync({
  ...commonOptions,
  entryPoints: ["src/pty-daemon.ts"],
  outfile: "pty-daemon.js",
  banner: { js: "#!/usr/bin/env node" },
});
