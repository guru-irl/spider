import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openUsageLedger } from "../ledger.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { sessionRoute } from "../query-session.js";
import { dashboardBatch, dashboardCall } from "../__tests__/fixtures/dashboard-ledger.js";
import { envelope } from "../__tests__/fixtures/redesign-contract.js";
import type { SessionData } from "../dashboard-v4-contract.js";
import { installFixtureRoutes, expectNoBrowserErrors } from "./fixtures.js";

async function shot(page: Page, tz: string, state: string) {
  if (!process.env.SPIDER_SESSION_EVIDENCE) return;
  const directory = resolve(process.env.SPIDER_SESSION_EVIDENCE); await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `session-${tz.replaceAll("/", "-").toLowerCase()}-${state}-1440.png`), fullPage: true });
}

for (const [tz, from, to, picked] of [
  ["Asia/Kolkata", "2030-03-31T18:30:00Z", "2030-04-30T18:30:00Z", "2030-04-12T18:30:00Z"],
  ["America/Los_Angeles", "2030-04-01T07:00:00Z", "2030-05-01T07:00:00Z", "2030-04-13T07:00:00Z"],
] as const) test(`local billing dates and calendar selection agree in ${tz}`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const root = await mkdtemp(join(process.env.TMPDIR!, "session-zone-")), file = join(root, "fixture.db");
  const ledger = openUsageLedger(file), now = Date.UTC(2030, 3, 15, 12);
  ledger.apply(dashboardBatch(["2030-03-01T12:00:00Z", "2030-04-13T12:00:00Z", "2030-04-30T12:00:00Z", "2030-06-01T12:00:00Z"].map((ts, i) => dashboardCall(`zone-${i}`, { ts: Date.parse(ts) }))));
  const reader = openDashboardReader(file, { instanceId: "synthetic", serverBuild: "fixture", now: () => now, calibrationMode: () => "off" })!;
  try {
    const errors = expectNoBrowserErrors(page); await installFixtureRoutes(page); await page.clock.install({ time: now });
    await page.route("**/api/session/parent-session?*", async route => {
      const params = new URL(route.request().url()).searchParams;
      const data = reader.snapshot(ctx => sessionRoute("parent-session").handle(ctx, params)) as SessionData;
      await route.fulfill({ json: envelope(data, { start: data.range.from, end: data.range.to }) });
    });
    await page.goto(`/#/session/parent-session?tz=${encodeURIComponent(tz)}`);
    const first = page.locator('[data-range-field="from"]'), last = page.locator('[data-range-field="to"]');
    await expect(first).toHaveText("From Mon 1 APR"); await expect(last).toHaveText("To Tue 30 APR");
    await expect(page).toHaveURL(new RegExp(`from=${Date.parse(from)}&to=${Date.parse(to)}`));
    await expect(page.locator("[data-time-tick]").first()).toHaveAttribute("data-time-tick", String(Date.UTC(2030, 3, 13, 12)));
    await shot(page, tz, "billing");
    await last.click(); await expect(page.locator('[aria-selected="true"] button')).toHaveAttribute("data-date", "2030-04-30");
    await expect(page.locator('[data-date="2030-04-30"]')).toHaveAttribute("aria-label", "Tue 30 APR");
    await page.keyboard.press("Escape"); await expect(page.locator(".range-calendar")).toHaveCount(0); await expect(last).toBeFocused();
    await first.click(); await page.locator('[data-date="2030-04-13"]').click();
    await expect(first).toHaveText("From Sat 13 APR"); await expect(page).toHaveURL(new RegExp(`from=${Date.parse(picked)}&to=${Date.parse(to)}`));
    await page.getByRole("button", { name: "This month", exact: true }).click();
    await expect(first).toHaveText("From Mon 1 APR"); await expect(last).toHaveText("To Tue 30 APR");
    expect(errors()).toEqual([]);
  } finally { reader.close(); ledger.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [tz, from, to, fromLabel, toLabel] of [
  ["Asia/Kolkata", "2030-04-30T18:30:00Z", "2030-05-31T18:30:00Z", "From Wed 1 MAY", "To Fri 31 MAY"],
  ["America/Los_Angeles", "2030-04-01T07:00:00Z", "2030-05-01T07:00:00Z", "From Mon 1 APR", "To Tue 30 APR"],
] as const) test(`last-active local month is chosen on the server in ${tz}`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const root = await mkdtemp(join(process.env.TMPDIR!, "session-zone-")), file = join(root, "fixture.db"), ledger = openUsageLedger(file);
  const now = Date.UTC(2030, 5, 15, 12); ledger.apply(dashboardBatch([dashboardCall("last-local", { ts: Date.parse("2030-05-01T00:30:00Z") })]));
  const reader = openDashboardReader(file, { instanceId: "synthetic", serverBuild: "fixture", now: () => now, calibrationMode: () => "off" })!;
  try {
    await installFixtureRoutes(page); await page.clock.install({ time: now });
    await page.route("**/api/session/parent-session?*", async route => {
      const data = reader.snapshot(ctx => sessionRoute("parent-session").handle(ctx, new URL(route.request().url()).searchParams)) as SessionData;
      await route.fulfill({ json: envelope(data, { start: data.range.from, end: data.range.to }) });
    });
    await page.goto(`/#/session/parent-session?tz=${encodeURIComponent(tz)}`);
    await expect(page.locator('[data-range-field="from"]')).toHaveText(fromLabel); await expect(page.locator('[data-range-field="to"]')).toHaveText(toLabel);
    await expect(page).toHaveURL(new RegExp(`from=${Date.parse(from)}&to=${Date.parse(to)}`));
    await expect(page.locator("[data-session-total]")).toHaveText("1");
    await shot(page, tz, "fallback");
  } finally { reader.close(); ledger.close(); await rm(root, { recursive: true, force: true }); }
});
