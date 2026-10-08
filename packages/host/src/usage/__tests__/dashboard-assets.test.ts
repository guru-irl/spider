import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDashboardAssets } from "../dashboard-assets.js";
const roots: string[] = [];
export function fixtureAssets(): string {
  const scratch = resolve(".spider/scratch/usage-dashboard-assets/assets"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "fixture-")); roots.push(root); mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), '<!doctype html><link rel="stylesheet" href="/assets/app-12345678.css"><div id="usage-app"></div><script type="module" src="/assets/app-12345678.js"></script>');
  writeFileSync(join(root, "assets/app-12345678.js"), 'console.log("synthetic");');
  writeFileSync(join(root, "assets/app-12345678.css"), 'body{color:white}');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("loads exact routes with external content types and authenticated cache policy", async () => {
  const assets = await loadDashboardAssets(fixtureAssets());
  expect([...assets.keys()].sort()).toEqual(["/", "/assets/app-12345678.css", "/assets/app-12345678.js"]);
  expect(assets.get("/")!.cacheControl).toBe("no-store");
  expect(assets.get("/assets/app-12345678.js")!.contentType).toBe("text/javascript; charset=utf-8");
  expect(assets.get("/assets/app-12345678.css")!.cacheControl).toBe("public, max-age=31536000, immutable");
});
it.each(["index.html", "assets/app-12345678.js", "assets/app-12345678.css"])("missing %s is a typed path-free failure", async file => {
  const root = fixtureAssets(); rmSync(join(root, file));
  await expect(loadDashboardAssets(root)).rejects.toMatchObject({ code: "usage-dashboard-missing", message: "usage-dashboard-missing" });
});
it("missing HTML references fail rather than shipping a partial app", async () => {
  const root = fixtureAssets(); writeFileSync(join(root, "index.html"), '<script src="/assets/missing-12345678.js"></script>');
  await expect(loadDashboardAssets(root)).rejects.toMatchObject({ code: "usage-dashboard-missing" });
});
it.each(["states.html", "extra.bin", "assets/app-12345678.js.map", "assets/nested/file.js"])("rejects unexpected %s", async file => {
  const root = fixtureAssets(); mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), "synthetic");
  await expect(loadDashboardAssets(root)).rejects.toMatchObject({ code: "usage-dashboard-invalid" });
});
it.each([
  '<link href="/assets/app-12345678.css"><script src="/assets/app-12345678.js">alert(1)</script>',
  '<link href=/assets/app-12345678.css><script src=/assets/app-12345678.js></script>',
  '<link href="/assets/app-12345678.js"><script src="/assets/app-12345678.css"></script>',
])("rejects invalid external entry HTML: %s", async html => {
  const root = fixtureAssets(); writeFileSync(join(root, "index.html"), html);
  await expect(loadDashboardAssets(root)).rejects.toMatchObject({ code: "usage-dashboard-invalid" });
});
it("rejects symlinks, inline code and payloads above 512 KiB", async () => {
  const root = fixtureAssets(); writeFileSync(join(root, "assets/app-12345678.js"), "x".repeat(512 * 1024));
  await expect(loadDashboardAssets(root)).rejects.toMatchObject({ code: "usage-dashboard-invalid" });
  writeFileSync(join(root, "assets/app-12345678.js"), "x");
  writeFileSync(join(root, "index.html"), '<script>alert(1)</script>');
  await expect(loadDashboardAssets(root)).rejects.toMatchObject({ code: "usage-dashboard-invalid" });
  rmSync(join(root, "assets/app-12345678.css")); symlinkSync(join(root, "assets/app-12345678.js"), join(root, "assets/app-12345678.css"));
  await expect(loadDashboardAssets(root)).rejects.toMatchObject({ code: "usage-dashboard-invalid" });
});
