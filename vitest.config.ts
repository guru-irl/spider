import { defineConfig } from "vitest/config";

// Native better-sqlite3 addons segfault in worker_threads during teardown —
// use forks on all platforms (mirrors context-mode's proven config).
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: ["packages/**/src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    maxWorkers: 3,
    teardownTimeout: 5_000,
    coverage: {
      provider: "v8",
      // Measure only shipped source, not tests/fixtures/generated output.
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/__tests__/**",
        "**/*.d.ts",
        "**/dist/**",
        "**/node_modules/**",
      ],
      reporter: ["text", "text-summary", "html", "json-summary"],
      reportsDirectory: "./coverage",
      all: true,
    },
  },
});
