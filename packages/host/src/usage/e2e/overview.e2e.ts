import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { installFixtureRoutes, expectNoBrowserErrors } from "./fixtures.js";
import { overviewFixture, sessionsFixture, envelope } from "../__tests__/fixtures/redesign-contract.js";
import type { OverviewDataV4 } from "../dashboard-v4-contract.js";
const url = "/#/";
const modifier = process.platform === "darwin" ? "Meta" : "Control";
async function interactive(page: import("@playwright/test").Page, change?: (data: OverviewDataV4, params: URLSearchParams) => void) {
  const routes = await installFixtureRoutes(page);
  await page.route("**/api/overview?**", async route => {
    const params = new URL(route.request().url()).searchParams;
    const data = overviewFixture(); data.range.unit = params.get("unit") === "tokens" ? "tokens" : "credits"; data.range.buckets = JSON.parse(params.get("buckets") ?? "[]");
    change?.(data, params); await route.fulfill({ json: envelope(data) });
  });
  await page.goto(url); await expect(page.getByRole("heading", { name: "Daily credits", exact: true })).toBeVisible(); return routes;
}
test("pace hover/focus anchors to ring, clamps on resize and Escape keeps focus", async ({ page }) => {
  const errors = expectNoBrowserErrors(page); await installFixtureRoutes(page); await page.goto(url);
  await expect(page.getByRole("heading", { name: "Daily credits", exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(".spider/scratch/playwright/shots/overview-default.png"), fullPage: true });
  const trigger = page.locator(".pace-trigger"), popover = page.locator(".pace-popover"); await trigger.focus(); await expect(popover).toBeVisible();
  const pointer = page.locator(".pace-pointer"), ring = page.locator(".pace-here");
  for (const width of [1440, 1180]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(async () => { const a = await pointer.boundingBox(), b = await ring.boundingBox(); return Math.abs(a!.x + a!.width / 2 - b!.x - b!.width / 2); }).toBeLessThan(2);
    const box = await popover.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
  await expect(popover).toContainText("Even pace"); await trigger.press("Escape"); await expect(popover).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.hover(); await expect(popover).toBeVisible(); await expect(page.locator(".even-pace-tick, .pace-limit")).toHaveCount(0); await page.screenshot({ path: resolve(".spider/scratch/playwright/shots/overview-pace.png") }); expect(errors()).toEqual([]);
});
for (const automatic of [false, true]) test(`Sessions sort survives ${automatic ? "automatic" : "manual"} refresh while expansion resets`, async ({ page }) => {
  await page.clock.install();
  const routes = await installFixtureRoutes(page), d = overviewFixture(), row = d.sessions.rows[0]!;
  d.sessions.total = 12; d.sessions.nextOffset = 1;
  routes.replace("/api/overview", { status: 200, body: envelope(d) });
  await page.route("**/api/sessions?**", async route => {
    const p = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: envelope(sessionsFixture({ total: 12, nextOffset: p.get("limit") === "100" ? null : 1, rows: [{ ...row, id: "sorted", name: `${p.get("sort")} first page` }] })) });
  });
  await page.goto(url); const runs = page.locator('[data-focus="session-sort-runs"]');
  await runs.click(); await expect(page.locator("tr[data-session]")).toContainText(["runs first page"]);
  await page.getByRole("button", { name: "Show all 12", exact: true }).click(); await expect(page.getByRole("button", { name: "Show all 12", exact: true })).toHaveCount(0);
  {
    const request = page.waitForRequest(r => r.url().includes("/api/sessions?"), { timeout: 5000 });
    if (automatic) await page.clock.fastForward(60000); else await page.getByRole("button", { name: "Refresh", exact: true }).click();
    const params = new URL((await request).url()).searchParams;
    expect(params.get("sort")).toBe("runs"); expect(params.get("offset")).toBe("0"); expect(params.get("limit")).toBe("10");
    await expect(runs).toHaveAttribute("aria-pressed", "true"); await expect(page.locator("tr[data-session]")).toContainText(["runs first page"]);
    await expect(page.getByRole("button", { name: "Show all 12", exact: true })).toBeVisible();
  }
  expect(routes.unexpected).toEqual([]);
});
test("pace Escape closes details without clearing selected buckets", async ({ page }) => {
  await interactive(page); await page.locator("g[data-bucket]").nth(4).press("Space"); await expect(page.locator(".selection-chip")).toContainText("Selected 1 day");
  const trigger = page.locator(".pace-trigger"); await trigger.focus(); await expect(page.locator(".pace-popover")).toBeVisible(); await trigger.press("Escape");
  await expect(page.locator(".overview-page")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".selection-chip")).toContainText("Selected 1 day"); await expect(page.locator(".pace-popover")).toBeHidden(); await expect(trigger).toBeFocused();
});
test("pace ring and pointer stay inset at both scale ends after resize", async ({ page }) => {
  const routes = await installFixtureRoutes(page);
  for (const used of [0, 120]) {
    const d = overviewFixture(); d.pace.used = used; d.pace.projected = 250; routes.replace("/api/overview", { status: 200, body: envelope(d) });
    await page.goto(url); await page.locator(".pace-trigger").focus();
    for (const width of [1440, 1180]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => {
        const track = document.querySelector(".pace-track")!.getBoundingClientRect(), ring = document.querySelector(".pace-here")!.getBoundingClientRect(), pointer = document.querySelector(".pace-pointer")!.getBoundingClientRect();
        return ring.left >= track.left + 1 && ring.right <= track.right - 1 && Math.abs(pointer.left + pointer.width / 2 - ring.left - ring.width / 2) < 2;
      })).toBe(true);
    }
  }
});
test("Overview chips use the shared shell treatment", async ({ page }) => {
  await interactive(page);
  const matches = await page.evaluate(() => {
    const summary = document.createElement("div"); summary.className = "summary-chips";
    const chip = document.createElement("span"); chip.className = "stat-chip"; const label = document.createElement("span"); label.textContent = "Reference"; const value = document.createElement("strong"); value.className = "mono"; value.textContent = "1"; chip.append(label, value); summary.append(chip); document.body.append(summary);
    const props = ["padding", "minHeight", "gap", "borderRadius", "fontSize"] as const;
    const reference = getComputedStyle(chip), referenceValue = getComputedStyle(value);
    const result = Array.from(document.querySelectorAll(".overview-page .stat-chip")).every(n => {
      const actual = getComputedStyle(n), actualValue = getComputedStyle(n.children[1]!);
      return props.every(p => actual[p] === reference[p]) && actualValue.color === referenceValue.color;
    }); summary.remove(); return result;
  }); expect(matches).toBe(true);
});
test("Overview generic class styles do not leak outside the page", async ({ page }) => {
  await interactive(page);
  const leaks = await page.evaluate(() => {
    const probes: [string, string][] = [["span", "rank"], ["span", "model-name"], ["span", "project-pill"], ["button", "session-name"], ["span", "role-key"], ["tr", "data-session"]];
    const props = ["color", "fontSize", "borderRadius", "padding", "minHeight", "cursor", "fontWeight"] as const;
    return probes.filter(([tag, name]) => {
      const n = document.createElement(tag); n.textContent = "Probe"; document.body.append(n);
      const before = props.map(p => getComputedStyle(n)[p]);
      if (name === "data-session") n.setAttribute(name, "probe"); else n.className = name;
      const changed = props.some((p, i) => getComputedStyle(n)[p] !== before[i]); n.remove(); return changed;
    }).map(([, name]) => name);
  }); expect(leaks).toEqual([]);
});
test("noncontiguous modifier selection uses real selected totals and reconciles URL", async ({ page }) => {
  await interactive(page, d => { if (d.range.buckets.length) { d.selectedTotal.credits = 2; d.models = [{ ...d.models[0]!, value: { ...d.models[0]!.value, credits: 2 } }]; d.sessions.rows = [{ ...d.sessions.rows[0]!, value: { ...d.sessions.rows[0]!.value, credits: 2 } }]; d.flow.edges = [{ ...d.flow.edges[0]!, value: { ...d.flow.edges[0]!.value, credits: 2 }, share: 1 }]; d.flow.models = d.models; d.flow.total = d.selectedTotal; } });
  const bars = page.locator("g[data-bucket]"); await bars.nth(4).click(); await expect(page.locator(".selection-chip")).toHaveCount(0);
  await bars.nth(4).click({ modifiers: [modifier] }); await bars.nth(6).click({ modifiers: [modifier] }); await expect(page.locator(".selection-chip")).toHaveText("Selected 2 days · 2 credits");
  expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("buckets")).toBe("[1902182400000,1902355200000]");
  await expect(page.locator('[data-panel="models"]')).not.toContainText("model-maple"); await expect(page.locator(".range-summary")).toContainText("Total10");
  await page.locator('[data-panel="daily"]').getByRole("button", { name: "Table", exact: true }).click(); await expect(page.locator(".selection-chip")).toBeVisible();
  await page.getByRole("heading", { name: "Models", exact: true }).click(); await expect(page.locator(".selection-chip")).toHaveCount(0);
});
test("arrow focus, modified Enter, Space, Escape and right click are distinct", async ({ page }) => {
  await interactive(page); const bars = page.locator("g[data-bucket]"); await bars.nth(4).focus(); await bars.nth(4).press("ArrowRight"); await expect(bars.nth(5)).toBeFocused();
  await bars.nth(5).press(`${modifier}+Enter`); await expect(page.locator(".selection-chip")).toContainText("Selected 1 day"); await expect(bars.nth(5)).toBeFocused();
  await bars.nth(6).click({ button: "right", modifiers: [modifier] }); await expect(page.locator(".selection-chip")).toContainText("Selected 1 day");
  await bars.nth(6).press("Space"); await expect(page.locator(".selection-chip")).toContainText("Selected 2 days"); await bars.nth(6).press("Escape"); await expect(page.locator(".selection-chip")).toHaveCount(0);
});
test("unit changes all panels while pace stays credits and chart choices persist", async ({ page }) => {
  const errors = expectNoBrowserErrors(page); await interactive(page);
  await page.locator('[data-panel="daily"]').getByRole("button", { name: "Table", exact: true }).click(); await page.getByRole("button", { name: "Tokens", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Daily tokens", exact: true })).toBeVisible(); await expect(page.locator('[data-panel="daily"] table')).toBeVisible();
  await expect(page.locator('[data-panel="models"]')).toContainText("960"); await page.locator(".pace-trigger").focus(); await expect(page.locator(".pace-popover")).toContainText("40");
  await page.getByRole("button", { name: "Refresh", exact: true }).click(); await expect(page.locator('[data-panel="daily"] table')).toBeVisible(); expect(errors()).toEqual([]);
});
test("sessions expands using frozen bounds, sorts and navigates by click or Enter", async ({ page }) => {
  const routes = await installFixtureRoutes(page); const data = overviewFixture(), row = data.sessions.rows[0]!;
  data.sessions = sessionsFixture({ total: 12, nextOffset: 10, rows: Array.from({ length: 10 }, (_, i) => ({ ...row, id: `session-${i}`, name: `Garden ${i}` })) });
  routes.replace("/api/overview", { status: 200, body: envelope(data) }); routes.replace("/api/sessions", { status: 200, body: envelope(sessionsFixture({ total: 12, offset: 10, rows: [{ ...row, id: "session-10" }, { ...row, id: "session-11" }] })) });
  await page.goto(url); await expect(page.locator("tr[data-session]")).toHaveCount(10); await page.getByRole("button", { name: "Show all 12", exact: true }).click(); await expect(page.locator("tr[data-session]")).toHaveCount(12); await expect(page.locator('tr[data-session="session-10"]')).toBeFocused();
  const request = routes.requests.find(r => r.path === "/api/sessions")!; expect(request.params.get("range")).toBe("custom"); expect(request.params.get("from")).toBe("1901836800000"); expect(request.params.get("to")).toBe("1902441600000");
  const segment = page.locator('.role-segment').first(); await segment.focus(); await expect(page.locator('.role-tooltip').first()).toBeVisible(); await expect(page.locator('.role-tooltip').first()).toContainText("tokens");
  await page.locator('tr[data-session="session-0"]').press("Enter"); await expect(page).toHaveURL(/#\/session\/session-0/);
  await page.getByRole("button", { name: "Overview", exact: true }).click(); await page.locator('tr[data-session="session-1"]').click(); await expect(page).toHaveURL(/#\/session\/session-1/);
  await page.getByRole("button", { name: "Overview", exact: true }).click(); routes.replace("/api/sessions", { status: 200, body: envelope(sessionsFixture({ total: 12, rows: [{ ...row, id: "session-9", name: "Last active result" }] })) });
  await page.getByRole("button", { name: "Last active", exact: true }).click(); await expect(page.locator("tr[data-session]")).toContainText(["Last active result"]); expect(routes.requests.at(-1)!.params.get("sort")).toBe("last-active");
});
test("server pruning replaces hash and reload requests only surviving selection", async ({ page }) => {
  const routes = await installFixtureRoutes(page), data = overviewFixture(); data.range.buckets = [data.buckets[4]!.key]; routes.replace("/api/overview", { status: 200, body: envelope(data) });
  await page.goto(url + "#/?range=7d&unit=credits&buckets=%5B1%2C1902182400000%5D"); await expect(page.locator(".selection-chip")).toBeVisible();
  expect(routes.count("/api/overview")).toBe(1); expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("buckets")).toBe("[1902182400000]");
  await page.reload(); await expect(page.locator(".selection-chip")).toBeVisible(); expect(routes.requests.filter(r => r.path === "/api/overview").at(-1)!.params.get("buckets")).toBe("[1902182400000]");
});
test("custom ranges over 93 days show local validation without fetching", async ({ page }) => {
  const routes = await installFixtureRoutes(page); await page.goto(url); await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByLabel("From", { exact: true }).fill("2030-01-01T00:00"); await page.getByLabel("To", { exact: true }).fill("2030-05-01T00:00"); await page.getByRole("button", { name: "Apply range", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("93 days"); expect(routes.count("/api/overview")).toBe(1);
});
for (const scenario of ["no-data", "no-budget", "counter-unavailable", "over-pace", "no-budget-or-allowance"] as const) test(`Overview ${scenario} state settles honestly`, async ({ page }) => {
  await installFixtureRoutes(page, scenario); await page.goto(`/?scenario=${scenario}#/`); await expect(page.locator(".pace-trigger")).toBeVisible(); await page.locator(".pace-trigger").focus(); await expect(page.locator(".pace-popover")).toBeVisible();
  if (scenario === "no-data") { await expect(page.locator('[data-panel="daily"]')).toContainText("No calls in this range."); await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0); }
  if (scenario === "no-budget") { await expect(page.locator(".pace-popover")).not.toContainText("Even pace"); await expect(page.locator(".pace-popover")).toContainText("/spider config set usage.monthlyBudget <credits> --global"); }
  if (scenario === "counter-unavailable") await expect(page.locator(".pace-popover")).toContainText("Counter unavailable");
  if (scenario === "over-pace") await expect(page.locator(".month-pace")).toHaveAttribute("data-danger", "true");
  if (scenario === "no-budget-or-allowance") { await expect(page.locator(".pace-fill")).toHaveAttribute("width", "0"); await expect(page.locator(".pace-here, .pace-projection")).toHaveCount(0); }
  await page.screenshot({ path: resolve(`.spider/scratch/playwright/shots/overview-${scenario}.png`), fullPage: true });
});
test("recoverable Overview error settles and Retry recovers", async ({ page }) => {
  const routes = await installFixtureRoutes(page, "error"); await page.goto("/?scenario=error#/"); await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible(); routes.replace("/api/overview", { status: 200, body: envelope(overviewFixture()) }); await page.getByRole("button", { name: "Retry", exact: true }).click(); await expect(page.getByRole("heading", { name: "Daily credits", exact: true })).toBeVisible();
});

test("daily table selection, session controls and focus survive refresh", async ({ page }) => {
  await interactive(page); const daily = page.locator('[data-panel="daily"]');
  await daily.getByRole("button", { name: "Table", exact: true }).click();
  await daily.getByRole("button", { name: "Fri 12 APR", exact: true }).click(); await expect(page.locator(".selection-chip")).toContainText("Selected 1 day");
  await page.getByRole("button", { name: "Refresh", exact: true }).click(); await expect(daily.locator("table")).toBeVisible(); await expect(page).toHaveURL(/buckets=%5B1902182400000%5D/); await expect(page.locator(".selection-chip")).toContainText("Selected 1 day");
  await page.locator('[data-panel="sessions"]').getByRole("button", { name: "Table", exact: true }).click();
  const row = page.locator('tr[data-session-table="session-garden"]'); await row.focus();
  // Keep row focus during a page refresh, not just the Chart/Table control focus.
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('.refresh')!.click()); await expect(row).toBeFocused();
  const name = row.getByRole("button", { name: "Garden tools", exact: true }); await name.focus(); await page.evaluate(() => document.querySelector<HTMLButtonElement>('.refresh')!.click()); await expect(name).toBeFocused();
  await page.getByRole("heading", { name: "Sessions", exact: true }).click(); await expect(page.locator(".selection-chip")).toHaveCount(0);
});
test("repeated fall-back hours retain distinct keyboard selections", async ({ page }) => {
  const routes = await installFixtureRoutes(page); const d = overviewFixture(); d.range.tz = "America/New_York"; d.bucketSize = "hour";
  d.buckets = [1919912400000, 1919916000000].map(key => ({ ...d.buckets[4]!, key, start: key, end: key + 3600000 }));
  await page.route("**/api/overview?**", async route => { const data = structuredClone(d); data.range.buckets = JSON.parse(new URL(route.request().url()).searchParams.get("buckets") ?? "[]"); await route.fulfill({ json: envelope(data) }); });
  await page.goto(url); const bars = page.locator('g[data-bucket]'); await expect(bars.nth(0)).toHaveAttribute("aria-label", /UTC-04:00/); await expect(bars.nth(1)).toHaveAttribute("aria-label", /UTC-05:00/);
  await bars.nth(0).focus(); await bars.nth(0).press("Space"); await bars.nth(0).press("ArrowRight"); await bars.nth(1).press("Space");
  await expect(page.locator(".selection-chip")).toContainText("Selected 2 hours");
  expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("buckets")).toBe("[1919912400000,1919916000000]"); expect(routes.unexpected).toEqual([]);
});
