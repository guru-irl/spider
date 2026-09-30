import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aroundAll } from "vitest";

// This setup file executes before each test module. Fork workers have distinct PIDs,
// so parallel files cannot share or delete one another's SQLite databases. Keep all
// test scratch inside the checkout — never under /tmp and never under the user's
// real ~/.pi/agent/spider tree.
const checkout = dirname(fileURLToPath(import.meta.url));
const testGlobalRoot = resolve(
  checkout,
  ".spider",
  "scratch",
  "vitest-global",
  String(process.pid),
);
// setupFiles runs before each test module's imports, including test scratch helpers.
// Capture only paths that do not already exist, so an old folder from PID reuse
// and folders owned by other forks are never removed by this module's teardown.
const pidScratchRoots = {
  "db-core": resolve(checkout, "packages", "db-core", ".spider", "scratch"),
  host: resolve(checkout, "packages", "host", ".spider", "scratch"),
  subagents: resolve(checkout, "packages", "subagents", ".spider", "scratch"),
  superpowers: process.env.SUPERPOWERS_TEST_SCRATCH_ROOT
    ? resolve(checkout, process.env.SUPERPOWERS_TEST_SCRATCH_ROOT)
    : resolve(checkout, "packages", "superpowers", ".spider", "scratch"),
};
const ownedPidScratch = Object.values(pidScratchRoots)
  .map((root) => resolve(root, String(process.pid)))
  .filter((dir) => !existsSync(dir));
mkdirSync(testGlobalRoot, { recursive: true });
process.env.SPIDER_TEST_FIXTURE_CHECKOUT = checkout;
process.env.SPIDER_GLOBAL_ROOT = testGlobalRoot;

// File-level afterAll hooks may throw or time out, stopping later afterAll hooks.
// This wrapper runs its finally even if the file's own teardown fails.
aroundAll(async (runSuite) => {
  try {
    await runSuite();
  } finally {
    // Test-owned DB handles must be closed by their owning tests. Keep cleanup
    // best effort so the original failure remains the reported error.
    for (const dir of [...ownedPidScratch, testGlobalRoot]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
});
