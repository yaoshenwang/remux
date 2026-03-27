import { defineConfig } from "vitest/config";

const legacyCompatibilityTests = [
  "tests/backend/client-view-store.test.ts",
  "tests/backend/default-shell.test.ts",
  "tests/backend/env.test.ts",
  "tests/backend/extension-routes-auth.test.ts",
  "tests/backend/launch-context.test.ts",
  "tests/backend/multiplexer-types.test.ts",
  "tests/backend/node-pty-helper.test.ts",
  "tests/backend/parser.test.ts",
  "tests/backend/state-monitor.test.ts",
  "tests/backend/terminal-runtime.test.ts",
  "tests/backend/zellij-*.test.ts",
  "tests/integration/server.test.ts",
  "tests/integration/zellij-server.test.ts"
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: legacyCompatibilityTests,
    coverage: {
      provider: "v8"
    }
  }
});
