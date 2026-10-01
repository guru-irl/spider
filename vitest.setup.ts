import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aroundAll } from "vitest";

// Every test file starts as a parent, even when launched by a subagent.
// Child-mode tests explicitly set their own identity and restore it locally.
for (const key of [
  "PI_SUBAGENT_CHILD", "PI_SPIDER_DB_PATH", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_SESSION_ID",
  "PI_SUBAGENT_ORCHESTRATOR_TARGET", "PI_SUBAGENT_CHILD_AGENT", "PI_SUBAGENT_CHILD_INDEX",
  "PI_SUBAGENT_FANOUT_CHILD", "PI_SUBAGENT_INTERCOM_SESSION_NAME",
]) delete process.env[key];

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
// Pi's public trust reader takes a filesystem lock. Its agent directory must be
// isolated before any test module imports Pi or resolves optional packages.
process.env.PI_CODING_AGENT_DIR = resolve(testGlobalRoot, "pi-agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

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
