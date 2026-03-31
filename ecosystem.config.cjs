// PM2 ecosystem config for Remux runtime instances.
// Usage: pm2 start ecosystem.config.cjs
// Both instances share the same codebase but run from separate worktrees
// so main and dev can be deployed independently.

const HOME = require("os").homedir();
const RUNTIME_BASE = `${HOME}/.remux/runtime-worktrees`;

module.exports = {
  apps: [
    {
      name: "remux-main",
      cwd: `${RUNTIME_BASE}/runtime-main`,
      script: "dist/backend/cli-zellij.js",
      args: "--host 0.0.0.0 --port 3456 --zellij-session remux-main --no-tunnel --no-require-password",
      interpreter: "node",
      env: {
        REMUX_TOKEN: "remux-main-token",
        REMUX_RUNTIME_BRANCH: "main",
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 5000,
    },
    {
      name: "remux-dev",
      cwd: `${RUNTIME_BASE}/runtime-dev`,
      script: "dist/backend/cli-zellij.js",
      args: "--host 0.0.0.0 --port 3457 --zellij-session remux-dev --no-tunnel --no-require-password",
      interpreter: "node",
      env: {
        REMUX_TOKEN: "remux-dev-token",
        REMUX_RUNTIME_BRANCH: "dev",
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 5000,
    },
  ],
};
