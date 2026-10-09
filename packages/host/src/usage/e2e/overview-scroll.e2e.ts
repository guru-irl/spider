import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { installFixtureRoutes, expectNoBrowserErrors } from "./fixtures.js";
import { overviewFixture, sessionsFixture, envelope } from "../__tests__/fixtures/redesign-contract.js";
const shots = resolve(".spider/scratch/dash-overview/shots");
const DAY = 86400000;
async function world(page: Page) {
  await installFixtureRoutes(page);
  const seed = overviewFixture(), row = seed.sessions.rows[0]!;
  const rows = Array.from({ length: 35 }, (_, i) => ({ ...structuredClone(row), id: `scroll-${i}`, name: `Synthetic session ${i + 1}` }));
  const pages: URLSearchParams[] = [];
  await page.route("**/api/sessions?**", async route => {
    const p = new URL(route.request().url()).searchParams; pages.push(p);
    const offset = Number(p.get("offset")), limit = Number(p.get("limit"));
    await route.fulfill({ json: envelope(sessionsFixture({ total: rows.length, offset, nextOffset: offset + limit < rows.length ? offset + limit : null, rows: rows.slice(offset, offset + limit), summary: { runs: rows.length * row.runs, top3Share: 3 / rows.length } })) });
  });
  await page.route("**/api/overview?**", async route => {
    const p = new URL(route.request().url()).searchParams, d = overviewFixture();
    d.range = { ...d.range, range: p.get("range") as typeof d.range.range, from: Number(p.get("from")), to: Number(p.get("to")) };
    d.bucketSize = d.range.range === "24h" ? "hour" : "day";
    const step = d.bucketSize === "hour" ? DAY / 24 : DAY, count = Math.ceil((d.range.to - d.range.from) / step);
    d.models = Array.from({ length: 18 }, (_, i) => ({ ...structuredClone(d.models[i % 2]!), id: `model-synthetic-${i + 1}`, share: 1 / 18, note: "Mostly worker runs" }));
    d.buckets = Array.from({ length: count }, (_, i) => ({ ...structuredClone(seed.buckets[4]!), key: d.range.from + i * step, start: d.range.from + i * step, end: Math.min(d.range.to, d.range.from + (i + 1) * step), models: [{ model: d.models[i % 18]!.id, value: seed.buckets[4]!.total }] }));
    d.total = { ...d.total, credits: rows.length * 10 }; d.selectedTotal = d.total;
    d.buckets.forEach(b => { b.total = { ...b.total, credits: d.total.credits! / count }; b.models[0]!.value = b.total; });
    d.models.forEach(m => { m.value = { ...m.value, credits: d.total.credits! / 18 }; });
    d.sessions = sessionsFixture({ rows: rows.slice(0, 10), total: rows.length, nextOffset: 10, summary: { runs: rows.length * row.runs, top3Share: 3 / rows.length } });
    await route.fulfill({ json: envelope(d) });
  });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto("/#/");
  await expect(page.locator(".daily-chart")).toBeVisible(); return pages;
}
async function unscaled(page: Page) {
  await expect.poll(() => page.locator(".daily-chart").evaluate((node: SVGSVGElement) => {
    const box = node.getBoundingClientRect(), view = node.viewBox.baseVal, transform = node.getScreenCTM()!;
    return Math.abs(box.width - view.width) < 1 && Math.abs(box.height - view.height) < 1 && Math.abs(transform.a - 1) < .01 && Math.abs(transform.d - 1) < .01;
  })).toBe(true);
}
test("daily text stays CSS-sized across presets, sixty days, tall cards and desktop widths", async ({ page }) => {
  const errors = expectNoBrowserErrors(page); await world(page); await unscaled(page);
  await page.screenshot({ path: resolve(shots, "overview-7-days.png"), fullPage: true });
  for (const label of ["24 h", "7 days", "30 days", "This month"]) {
    await page.getByRole("button", { name: label, exact: true }).click(); await unscaled(page);
    for (const width of [1280, 1440, 1600]) { await page.setViewportSize({ width, height: 1000 }); await unscaled(page); }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const daily = await page.locator('[data-panel="daily"]').boundingBox(), models = await page.locator('[data-panel="models"]').boundingBox();
    expect(Math.abs(daily!.height - models!.height)).toBeLessThan(1);
    if (label === "30 days") await page.screenshot({ path: resolve(shots, "overview-30-days.png"), fullPage: true });
  }
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByLabel("From", { exact: true }).fill("2030-01-01T00:00"); await page.getByLabel("To", { exact: true }).fill("2030-03-02T00:00");
  await page.getByRole("button", { name: "Apply range", exact: true }).click(); await expect(page.locator("g[data-bucket]")).toHaveCount(60); await unscaled(page);
  await page.evaluate(() => document.styleSheets[0]!.insertRule(".overview-grid>.overview-panel{height:800px}", document.styleSheets[0]!.cssRules.length)); await unscaled(page);
  expect(errors()).toEqual([]);
});
test("models list scrolls inside an equal-height card and its table is bounded", async ({ page }) => {
  await world(page); await page.getByRole("button", { name: "30 days", exact: true }).click();
  const list = page.getByRole("region", { name: "Models list", exact: true }); await expect(list).toHaveAttribute("tabindex", "0");
  expect((await page.locator('[data-panel="models"]').boundingBox())!.height).toBe(540);
  expect(await list.evaluate(n => n.scrollHeight > n.clientHeight)).toBe(true);
  await expect(list).toHaveCSS("scrollbar-width", "auto");
  expect(await list.evaluate(n => (n as HTMLElement).offsetWidth - n.clientWidth)).toBeGreaterThanOrEqual(8);
  await list.focus(); await list.press("PageDown"); await expect.poll(() => list.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: resolve(shots, "overview-models-scrolled.png"), fullPage: true });
  await page.locator('[data-panel="models"]').getByRole("button", { name: "Table", exact: true }).click();
  const table = page.getByRole("region", { name: "Models table", exact: true }); expect(await table.evaluate(n => n.scrollHeight > n.clientHeight)).toBe(true);
});
for (const mode of ["chart", "table"]) test(`sessions ${mode} scroll paginates, keeps a sticky header and stops at the end`, async ({ page }) => {
  const requests = await world(page);
  if (mode === "table") await page.locator('[data-panel="sessions"]').getByRole("button", { name: "Table", exact: true }).click();
  const region = page.getByRole("region", { name: `Sessions ${mode}`, exact: true });
  await expect(region).toHaveAttribute("tabindex", "0"); await region.scrollIntoViewIfNeeded();
  await expect(page.locator("tr[data-session]")).toHaveCount(20);
  expect(await region.evaluate(n => n.scrollHeight > n.clientHeight)).toBe(true);
  await region.focus(); await region.press("ArrowDown"); await expect.poll(() => region.evaluate(n => n.scrollTop)).toBeGreaterThan(0); await region.press("PageDown"); await expect.poll(() => region.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
  for (const count of [30, 35]) { await region.evaluate(n => { n.scrollTop = n.scrollHeight; }); await expect.poll(() => page.locator("tr[data-session]").count()).toBeGreaterThanOrEqual(count); }
  await expect(region).toBeFocused();
  const header = region.locator("thead"); expect((await header.boundingBox())!.y).toBeCloseTo((await region.boundingBox())!.y, 0);
  const before = requests.length; await region.evaluate(n => { n.scrollTop = 0; }); await region.press("End");
  await expect(page.locator('[data-panel="sessions"] .summary-chips')).toContainText("Sessions35");
  await expect(page.getByRole("button", { name: /Show all/ })).toHaveCount(0); expect(requests.length).toBe(before);
  expect(requests.every(p => p.get("limit") === "10" && p.get("range") === "custom")).toBe(true);
  if (mode === "table") await page.screenshot({ path: resolve(shots, "overview-sessions-scrolled.png"), fullPage: true });
});
for (const [label, used, projected, danger] of [["normal", 35, 95, false], ["projected-over-budget", 35, 110, true], ["used-over-budget", 110, 110, true]] as const) test(`pace ${label} uses the budget rule`, async ({ page }) => {
  const routes = await installFixtureRoutes(page), d = overviewFixture(); Object.assign(d.pace, { used, projected, evenPace: 30, overPace: true, overBudget: used > 100 });
  routes.replace("/api/overview", { status: 200, body: envelope(d) }); await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto("/#/");
  await expect(page.locator(".month-pace")).toHaveAttribute("data-danger", String(danger));
  await expect(page.locator(".pace-fill")).toHaveCSS("fill", danger ? "rgb(248, 120, 92)" : "rgb(243, 234, 219)");
  await page.screenshot({ path: resolve(shots, `overview-pace-${label}.png`), fullPage: true });
});
