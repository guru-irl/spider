import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFixtureDashboard, cleanupFixtureDashboards } from "./fixtures/dashboard-assets.js";
let automatic: string | undefined, owned: string | undefined;
afterEach(() => {
  try {
    if (automatic) expect(existsSync(automatic), "automatic dashboard removed after test").toBe(false);
    if (owned) expect(existsSync(join(owned, "assets")), "caller-owned dashboard preserved").toBe(true);
  } finally {
    if (automatic) rmSync(automatic, { recursive: true, force: true });
    if (owned) rmSync(owned, { recursive: true, force: true });
    automatic = owned = undefined;
  }
});
describe("fixture lifecycle", () => {
afterEach(cleanupFixtureDashboards);
it("cleans an automatically allocated fixture at the end of its test", () => {
  automatic = createFixtureDashboard();
  expect(existsSync(join(automatic, "index.html"))).toBe(true);
});
it("leaves an explicitly supplied directory to its owner", () => {
  const base = resolve(".spider/scratch/usage-dashboard-assets/cleanup"); mkdirSync(base, { recursive: true });
  owned = mkdtempSync(join(base, "fixture-"));
  expect(createFixtureDashboard(undefined, owned)).toBe(owned);
});
});
