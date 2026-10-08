import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const roots: string[] = [];
export function cleanupFixtureDashboards(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
/** Automatic roots are removed after each test. Explicit directories remain caller-owned. */
export function createFixtureDashboard(html = "<!doctype html><title>Fixture</title>", directory?: string): string {
  const scratch = resolve(".spider/scratch/usage-dashboard-assets/http-fixtures");
  mkdirSync(scratch, { recursive: true });
  const root = directory ?? mkdtempSync(join(scratch, "assets-"));
  if (!directory) roots.push(root);
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), html + '<link rel="stylesheet" href="/assets/fixture-12345678.css"><script type="module" src="/assets/fixture-12345678.js"></script>');
  writeFileSync(join(root, "assets/fixture-12345678.js"), "void 0;");
  writeFileSync(join(root, "assets/fixture-12345678.css"), "body{color:white}");
  return root;
}
