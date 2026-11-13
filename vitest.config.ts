import { defineConfig } from "vitest/config";
import DurationSequencer from "./scripts/vitest-sequencer.js";
import { fileURLToPath } from "node:url";

// Native better-sqlite3 addons segfault in worker_threads during teardown —
// use forks on all platforms (mirrors context-mode's proven config).
export default defineConfig({
  plugins: [{
    name: "herdr-installed-shared-feed",
    resolveId(id, importer) {
      if (id === "./shared/feed.js" && importer?.includes("/packages/herdr/assets/"))
        return fileURLToPath(new URL("./packages/herdr/assets/shared/feed.js", import.meta.url));
    },
  }],
  test: {
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.herdr-global-setup.ts"],
    include: ["packages/**/src/**/*.test.ts", "scripts/__tests__/intercom-switchover.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    maxWorkers: 3,
    sequence: { sequencer: DurationSequencer },
    teardownTimeout: 15_000,
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
        "packages/host/src/usage/e2e/**",
      ],
      reporter: ["text", "text-summary", "html", "json-summary"],
      reportsDirectory: "./coverage",
      all: true,
    },
  },
});
