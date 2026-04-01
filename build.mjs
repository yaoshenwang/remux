/**
 * esbuild script — bundles src/ TypeScript modules into a single server.js.
 * Externalizes native/npm dependencies (node-pty, ws, ghostty-web, qrcode-terminal).
 */

import esbuild from "esbuild";

esbuild.buildSync({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "server.js",
  external: ["node-pty", "ws", "ghostty-web", "qrcode-terminal", "better-sqlite3", "web-push", "simple-git"],
  banner: { js: "#!/usr/bin/env node" },
});
