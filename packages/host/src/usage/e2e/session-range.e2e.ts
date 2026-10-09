import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { installFixtureRoutes, expectNoBrowserErrors } from "./fixtures.js";
import { envelope, sessionFixture, sessionSpan } from "../__tests__/fixtures/redesign-contract.js";
import type { SessionData, SessionRange, Value } from "../dashboard-v4-contract.js";

const DAY = 86400000, FEB = Date.UTC(2030, 1, 1), APR = Date.UTC(2030, 3, 1), MAY = Date.UTC(2030, 4, 1), JUL = Date.UTC(2030, 6, 1), AUG = Date.UTC(2030, 7, 1);
const value = (credits: number, calls: number): Value => ({ credits, calls, unpricedCalls: 0, tokens: { input: calls * 100, cacheRead: 0, cacheWrite: 0, output: calls * 20, cacheWrite1h: null, reasoning: null, prompt: calls * 100, total: calls * 120 } });
function fixture(range: SessionRange, old: boolean): SessionData {
  const d = sessionFixture(), runAt = APR + 12 * DAY + 10 * 3600000;
  const candidates = [FEB + 10 * DAY, APR + 11 * DAY, APR + 13 * DAY, JUL + 18 * DAY];
  const own = candidates.filter(ts => ts >= range.from && ts < range.to);
  const runs = !old && runAt >= range.from && runAt < range.to ? Array.from({ length: 26 }, (_, i) => ({ ...d.runs[0]!, id: `synthetic-run-${i}`, name: `Synthetic task ${i + 1}`, role: ["worker", "implementer", "reviewer", "scout", "planner"][i % 5]!, roleGroup: (["workers", "workers", "reviewers", "others", "others"] as const)[i % 5]!, model: "model-synthetic", style: d.models[0]!.style, start: runAt + i * 1000, end: runAt + 20 * 60000 + i * 1000, value: value(3, 1) })) : [];
  const total = value(own.length * 2 + runs.length * 3, own.length + runs.length);
  const edges = (["own", "workers", "reviewers", "scouts", "other-runs"] as const).map(role => {
    const count = role === "own" ? own.length : runs.filter(run => role === "scouts" ? run.role === "scout" : role === "other-runs" ? run.role === "planner" : run.roleGroup === role).length;
    const amount = value(count * (role === "own" ? 2 : 3), count);
    return { role, model: "model-synthetic", value: amount, share: total.credits! > 0 ? amount.credits! / total.credits! : 0 };
  }).filter(edge => edge.value.calls > 0);
  return sessionFixture({ span: sessionSpan(FEB + 10 * DAY, JUL + 18 * DAY + 1), range, billingMonth: old ? { from: Date.UTC(2030, 9, 1), to: Date.UTC(2030, 10, 1) } : { from: APR, to: MAY }, total, runs,
    stats: { runs: runs.length, ownCalls: own.length, compaction: 0, idleGaps: 0 }, compaction: [], idleGaps: [],
    ownCallBins: own.map(ts => ({ start: ts, end: ts + 1, value: value(2, 1) })), activePeriods: own.map(ts => ({ start: ts, end: ts + 1 })),
    models: total.calls ? [{ ...d.models[0]!, id: "model-synthetic", value: total, share: 1 }] : [],
    flow: { total, models: total.calls ? [{ ...d.models[0]!, id: "model-synthetic", value: total, share: 1 }] : [], edges },
  });
}
async function world(page: Page, old = false) {
  const routes = await installFixtureRoutes(page), requests: URLSearchParams[] = [];
  await page.clock.install({ time: Date.UTC(2030, old ? 9 : 3, 15, 12) });
  await page.route("**/api/session/session-garden?*", async route => {
    const params = new URL(route.request().url()).searchParams; requests.push(params);
    const range = params.has("from") ? { from: Number(params.get("from")), to: Number(params.get("to")) } : old ? { from: JUL, to: AUG } : { from: APR, to: MAY };
    await route.fulfill({ json: envelope(fixture(range, old), { start: range.from, end: range.to }) });
  });
  return { routes, requests };
}
async function shot(page: Page, name: string) {
  if (!process.env.SPIDER_SESSION_EVIDENCE) return;
  const directory = resolve(process.env.SPIDER_SESSION_EVIDENCE); await mkdir(directory, { recursive: true });
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: resolve(directory, name), fullPage: true });
}

test("Session evidence writes screenshots only when requested", async ({ page }) => {
  await world(page); await page.goto("/#/session/session-garden?tz=UTC"); await expect(page.locator(".session-header")).toBeVisible();
  const directory = await mkdtemp(resolve(process.env.TMPDIR!, "session-evidence-")), name = `session-evidence-${process.pid}.png`, previous = process.env.SPIDER_SESSION_EVIDENCE;
  const find = async (directory: string): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) found.push(...await find(path)); else if (entry.name === name) found.push(path);
    }
    return found;
  };
  try {
    delete process.env.SPIDER_SESSION_EVIDENCE; await shot(page, name);
    expect(await find(resolve(".spider/scratch"))).toEqual([]);
    process.env.SPIDER_SESSION_EVIDENCE = directory; await shot(page, name);
    expect((await stat(resolve(directory, name))).size).toBeGreaterThan(0);
  } finally {
    if (previous === undefined) delete process.env.SPIDER_SESSION_EVIDENCE; else process.env.SPIDER_SESSION_EVIDENCE = previous;
    for (const file of await find(resolve(".spider/scratch"))) await rm(file);
    await rm(directory, { recursive: true, force: true });
  }
});

test("multi-month default, role agents and sticky scrolling runs table", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); const errors = expectNoBrowserErrors(page), w = await world(page);
  await page.goto("/#/session/session-garden?unit=credits&tz=UTC");
  await expect(page.getByRole("button", { name: "From Mon 1 APR", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "To Tue 30 APR", exact: true })).toBeVisible();
  expect(w.requests[0]!.has("from")).toBe(false);
  await expect(page.getByRole("button", { name: "This month", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await page.getByRole("button", { name: "This month", exact: true }).evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  const hash = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split("?")[1])));
  expect(hash).toMatchObject({ from: String(APR), to: String(MAY) });
  await expect(page.locator("[data-run-row]")).toHaveCount(26);
  await expect(page.locator("[data-time-tick]").first()).toHaveAttribute("data-time-tick", String(APR + 11 * DAY));
  await expect(page.locator(".session-route-section .stat-chip").filter({ hasText: "Span" })).toHaveText("Span48 h 0 min");
  for (const agent of ["worker", "implementer", "reviewer", "scout", "planner"]) await expect(page.locator(".runs-table .run-role").filter({ hasText: new RegExp(`^${agent}$`) }).first()).toBeVisible();
  const scroll = page.getByRole("region", { name: "Subagent runs", exact: true });
  await expect(scroll).toHaveAttribute("tabindex", "0");
  expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(page.getByRole("button", { name: /Show all/ })).toHaveCount(0);
  await shot(page, "session-default-1440.png");
  await scroll.focus(); await scroll.press("End");
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  const header = scroll.locator("thead");
  expect(await header.evaluate(el => getComputedStyle(el).position)).toBe("sticky");
  await scroll.locator("th").getByRole("button", { name: "Credits", exact: true }).press("Enter");
  await expect(scroll.locator('th[aria-sort="descending"]')).toHaveCount(1);
  expect(w.routes.unexpected).toEqual([]); expect(errors()).toEqual([]);
});
test("last-active month default never opens an old session on empty current-month activity", async ({ page }) => {
  const w = await world(page, true); await page.goto("/#/session/session-garden?tz=UTC");
  await expect(page.getByRole("button", { name: "From Mon 1 JUL", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "To Wed 31 JUL", exact: true })).toBeVisible();
  await expect(page.locator("[data-session-total]")).toHaveText("2");
  expect(w.requests[0]!.has("from")).toBe(false);
  await expect(page.getByRole("button", { name: "This month", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "This month", exact: true }).click();
  await expect(page.locator(".session-range-empty")).toContainText("No activity in this range.");
  await expect(page.getByRole("button", { name: "This month", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-range-field="from"]')).toHaveText("From Tue 1 OCT");
  expect(Object.fromEntries(w.requests.at(-1)!)).toMatchObject({ from: String(Date.UTC(2030, 9, 1)), to: String(Date.UTC(2030, 10, 1)) });
});
test("mouse dates, keyboard dates, hash reload and back preserve the applied range", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); const errors = expectNoBrowserErrors(page), w = await world(page);
  await page.goto("/#/session/session-garden?tz=UTC");
  await expect(page.locator(".range-calendar")).toHaveCount(0);
  const from = page.locator('[data-range-field="from"]'); await from.click();
  const calendar = page.getByRole("dialog", { name: "Choose From date", exact: true }); await expect(calendar).toBeVisible();
  await expect(calendar.locator('[aria-current="date"]')).toHaveAttribute("data-date", "2030-04-15");
  await expect(calendar).toContainText("UTC"); await shot(page, "session-calendar-1440.png");
  await calendar.locator('[data-date="2030-04-13"]').click();
  await expect(from).toHaveText("From Sat 13 APR"); await expect(from).toBeFocused();
  await expect(page.locator(".range-calendar")).toHaveCount(0);
  const to = page.locator('[data-range-field="to"]'); await to.press("Enter");
  await page.getByRole("dialog").locator('[data-date="2030-04-13"]').click();
  await expect(to).toHaveText("To Sat 13 APR"); await expect(to).toBeFocused();
  await expect(page.locator("[data-session-total]")).toHaveText("78"); await shot(page, "session-narrowed-1440.png");
  const narrowed = await page.evaluate(() => location.hash); expect(narrowed).toContain(`from=${APR + 12 * DAY}&to=${APR + 13 * DAY}`);
  await to.press("Enter"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
  await expect(to).toHaveText("To Sun 14 APR"); await expect(to).toBeFocused();
  await page.goBack(); await expect(to).toHaveText("To Sat 13 APR");
  await from.press("Enter"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("Enter");
  await expect(from).toHaveText("From Fri 12 APR"); await expect(from).toBeFocused();
  await from.press("Enter"); await page.keyboard.press("Escape"); await expect(from).toBeFocused(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goBack(); await expect(from).toHaveText("From Sat 13 APR"); await expect(to).toHaveText("To Sat 13 APR");
  await page.reload(); await expect(page.locator("[data-session-total]")).toHaveText("78");
  expect(Object.fromEntries(w.requests.at(-1)!)).toMatchObject({ from: String(APR + 12 * DAY), to: String(APR + 13 * DAY) });
  expect(errors()).toEqual([]);
});
test("calendar bounds, month keyboard movement and empty-range Whole session recovery", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await world(page); await page.goto("/#/session/session-garden?tz=UTC");
  const from = page.locator('[data-range-field="from"]'); await from.click();
  await page.getByRole("button", { name: "Previous month", exact: true }).click(); await page.getByRole("button", { name: "Previous month", exact: true }).click();
  await expect(page.locator('[data-date="2030-02-10"]')).toBeDisabled(); await expect(page.locator('[data-date="2030-02-11"]')).toBeEnabled();
  await expect(page.getByRole("button", { name: "Previous month", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(from).toBeFocused();
  await from.click(); await page.getByRole("button", { name: "Next month", exact: true }).click(); await page.getByRole("button", { name: "Next month", exact: true }).click();
  await page.locator('[data-date="2030-06-15"]').click();
  await expect(page.locator(".session-range-empty")).toContainText("No activity in this range.");
  await expect(page.locator(".session-route-section")).toHaveCount(0); await shot(page, "session-empty-range-1440.png");
  await page.locator(".session-range-empty").getByRole("button", { name: "Whole session", exact: true }).press("Enter");
  await expect(page.locator("[data-session-total]")).toHaveText("86");
  await expect(from).toHaveText("From Mon 11 FEB");
});
