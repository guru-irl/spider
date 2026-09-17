import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll } from "vitest";

// This setup file executes before each test module. Fork workers have distinct PIDs,
// so parallel files cannot share or delete one another's SQLite databases. Keep all
// test scratch inside the checkout — never under /tmp and never under the user's
// real ~/.pi/agent/spider tree.
const testGlobalRoot = resolve(
  ".spider",
  "scratch",
  "vitest-global",
  String(process.pid),
);
mkdirSync(testGlobalRoot, { recursive: true });
process.env.SPIDER_GLOBAL_ROOT = testGlobalRoot;

afterAll(() => {
  // Every test-owned openGlobal handle must be closed by its owning test. Cleanup is
  // best effort so a failed assertion reports the original failure, not teardown IO.
  try {
    rmSync(testGlobalRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
