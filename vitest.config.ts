import { defineConfig } from "vitest/config";

// Native better-sqlite3 addons segfault in worker_threads during teardown —
// use forks on all platforms (mirrors context-mode's proven config).
export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    maxWorkers: 3,
    teardownTimeout: 5_000,
  },
});
