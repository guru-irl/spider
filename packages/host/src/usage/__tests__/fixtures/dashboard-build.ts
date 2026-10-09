import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
/** The caller owns this synthetic checkout and removes it during teardown. */
export function prepareDashboardBuild(checkout: string): string {
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  mkdirSync(join(checkout, "packages/host/src/usage"), { recursive: true });
  cpSync(resolve("vite.dashboard.config.mjs"), join(checkout, "vite.dashboard.config.mjs"));
  for (const name of ["usage-dashboard-browser-boundary.mjs", "usage-dashboard-fixtures.mjs"]) {
    cpSync(resolve("scripts", name), join(checkout, "scripts", name));
  }
  cpSync(resolve("packages/host/src/usage/web"), join(checkout, "packages/host/src/usage/web"), { recursive: true });
  return join(checkout, "vite.dashboard.config.mjs");
}
