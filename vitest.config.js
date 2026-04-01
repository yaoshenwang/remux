import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 40000,
    include: ["tests/**/*.test.{js,ts}"],
    exclude: [".worktrees/**", "node_modules/**"],
  },
});
