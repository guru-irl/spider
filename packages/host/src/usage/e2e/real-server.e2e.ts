import { test, expect } from "@playwright/test";
import { startRealUsageFixture } from "./fixtures.js";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
async function hashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(path: string): Promise<void> { for (const name of await readdir(path).catch(() => [])) { const file = join(path, name); if ((await stat(file)).isDirectory()) await walk(file); else out[file.slice(dir.length)] = createHash("sha256").update(await readFile(file)).digest("hex"); } }
  await walk(dir); return out;
}
test("real server bootstrap and one API call", async ({ page, request }) => {
  test.setTimeout(120000);
  const scratch = resolve(".spider/scratch/playwright"), roots = async () => (await readdir(scratch)).filter(n => n.startsWith("real-fixture-")).sort();
  const beforeRoots = await roots();
  const dist = resolve("dist"), before = await hashes(dist), fixture = await startRealUsageFixture();
  expect((await roots()).filter(n => !beforeRoots.includes(n))).toHaveLength(1);
  try {
    const realDist = resolve(".spider/scratch/playwright/real-dist"); expect((await stat(join(realDist, "extension.js"))).size).toBeGreaterThan(0); const html = await readFile(join(realDist, "dashboard/index.html"), "utf8"); expect(await readdir(join(realDist, "dashboard"))).not.toContain("states.html");
    const asset = html.match(/(?:src|href)="(\/assets\/[^\"]+)"/)![1]!;
    expect((await request.get(fixture.origin + "/")).status()).toBe(401); expect((await request.get(fixture.origin + asset)).status()).toBe(401);
    await page.goto(fixture.bootstrapUrl); await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
    const cookies = await page.context().cookies(fixture.origin); expect(cookies).toEqual(expect.arrayContaining([expect.objectContaining({ httpOnly: true, sameSite: "Strict" })]));
    const result = await page.evaluate(async () => { const response = await fetch("/api/status"); return { status: response.status, body: await response.json() }; });
    expect(result.status).toBe(200); expect(result.body.apiVersion).toBe(1); expect(result.body.data.serverBuild).toEqual(expect.any(String));
    expect(Object.keys(result.body.data).sort()).toEqual(["collector", "lastIngestAt", "latestCounterAt", "rateVersions", "serverBuild"]);
    expect(result.body.data).toMatchObject({ collector: "none", latestCounterAt: null, rateVersions: expect.any(Array) });
    expect((await page.request.get(fixture.origin + asset)).status()).toBe(200);
    expect((await request.get(fixture.bootstrapUrl, { maxRedirects: 0 })).status()).toBe(401);
    expect(await hashes(dist)).toEqual(before);
  } finally { await page.close(); await fixture.stop(); await fixture.stop(); expect(await roots()).toEqual(beforeRoots); expect(await hashes(dist)).toEqual(before); }
});
