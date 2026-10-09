import { test, expect } from "@playwright/test";
import { installFixtureRoutes, expectNoBrowserErrors } from "./fixtures.js";
import { calibrationFixture, envelope } from "../__tests__/fixtures/redesign-contract.js";

const entry = "/#/calibration";
for (const [status, label] of [["calibrated", "Calibrated"], ["back-applied", "Back-applied"], ["published-only", "Published only"], ["counter-unavailable", "Counter unavailable"]] as const) {
  test(`Calibration status pill: ${label}`, async ({ page }) => {
    const errors = expectNoBrowserErrors(page), fixtures = await installFixtureRoutes(page);
    const data = calibrationFixture(); data.correction.status = status;
    fixtures.replace("/api/calibration", { status: 200, body: envelope(data) });
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(entry);
    await expect(page.locator(".correction-stats .state-pill")).toHaveText(label);
    await expect(page.locator(".correction-stats")).toContainText("12"); await expect(page.locator(".correction-stats")).toContainText("48");
    if (status === "calibrated") {
      await expect(page.locator(".state-pill.status-calibrated")).toHaveCSS("color", "rgb(143, 191, 138)");
      await expect(page.locator('.correction-axis[text-anchor="end"]')).toHaveText(["0", "5", "10", "15"]);
      await expect(page.locator(".correction-chart > title")).toHaveText("Daily published estimate and account counter, credits, UTC");
      await page.screenshot({ path: test.info().outputPath("calibration-default.png"), fullPage: true });
    }
    expect(fixtures.requests.filter(r => r.path === "/api/calibration").every(r => r.params.size === 0)).toBe(true);
    expect(errors()).toEqual([]); expect(fixtures.unexpected).toEqual([]);
  });
}

test("Calibration Chart/Table keyboard preserves zero, gaps and exact credits across refresh", async ({ page }) => {
  const errors = expectNoBrowserErrors(page), fixtures = await installFixtureRoutes(page);
  const data = calibrationFixture(); data.daily = [
    { day: Date.UTC(2030, 3, 12), publishedEstimate: 8, counterDelta: 2 },
    { day: Date.UTC(2030, 3, 13), publishedEstimate: null, counterDelta: null },
    { day: Date.UTC(2030, 3, 14), publishedEstimate: 6, counterDelta: 0 },
  ];
  fixtures.replace("/api/calibration", { status: 200, body: envelope(data) }); await page.goto(entry);
  await expect(page.locator(".counter-line")).toHaveCount(0);
  await expect(page.locator('[data-series="counter"][data-value="0"]')).toHaveCount(1);
  await expect(page.locator('[data-series="counter"][data-value]')).toHaveCount(2);
  const table = page.getByRole("button", { name: "Table", exact: true }); await table.focus(); await page.keyboard.press("Enter");
  await expect(table).toBeFocused(); await expect(page.locator(".daily-table")).toBeVisible();
  await expect(page.locator(".daily-table tbody tr").nth(1).locator(".cell-value")).toHaveText(["Sat 13 APR UTC", "unavailable", "unavailable"]);
  await expect(page.locator(".daily-table tbody tr").nth(2).locator(".cell-value")).toHaveText(["Sun 14 APR UTC", "6", "0"]);
  const before = fixtures.count("/api/calibration"); await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => fixtures.count("/api/calibration")).toBeGreaterThan(before); await expect(table).toHaveAttribute("aria-pressed", "true");
  await table.focus(); await page.keyboard.press("Shift+Tab"); await expect(page.getByRole("button", { name: "Chart", exact: true })).toBeFocused();
  await page.keyboard.press("Space"); await expect(page.locator(".correction-chart")).toBeVisible(); await expect(page.locator(".daily-table")).toBeHidden();
  expect(errors()).toEqual([]); expect(fixtures.unexpected).toEqual([]);
});

test("Calibration intervals Show more is keyboard reachable and expands newest-first from ten", async ({ page }) => {
  const errors = expectNoBrowserErrors(page), fixtures = await installFixtureRoutes(page);
  const data = calibrationFixture(); data.intervals = Array.from({ length: 23 }, (_, i) => ({ start: Date.UTC(2030, 3, 1, i), end: Date.UTC(2030, 3, 1, i + 1), counterDelta: i, publishedEstimate: i * 2, ratio: i ? 0.5 : null }));
  fixtures.replace("/api/calibration", { status: 200, body: envelope(data) }); await page.goto(entry);
  const rows = page.locator(".intervals-table tbody tr"), more = page.locator(".intervals-more");
  await expect(rows).toHaveCount(10); await expect(rows.first()).toContainText("Mon 1 APR 22:00 UTC");
  await page.locator(".intervals-table").locator("..").focus(); await page.keyboard.press("Tab"); await expect(more).toBeFocused();
  await page.keyboard.press("Enter"); await expect(rows).toHaveCount(20); await expect(more).toBeFocused(); await expect(more).toHaveAttribute("aria-expanded", "true");
  const before = fixtures.count("/api/calibration"); await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => fixtures.count("/api/calibration")).toBeGreaterThan(before); await expect(rows).toHaveCount(20);
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await more.focus(); await page.keyboard.press("Space"); await expect(rows).toHaveCount(23); await expect(more).toBeDisabled(); await expect(more).toBeFocused();
  await expect(more).toHaveText("All 23 shown");
  await expect(rows.last().locator(".cell-value")).toHaveText(["Mon 1 APR 00:00 UTC", "Mon 1 APR 01:00 UTC", "0", "0", "unavailable"]);
  expect(errors()).toEqual([]);
});

test("Calibration rates and ingestion show tiers, zeros, sources, redacted errors and gaps", async ({ page }) => {
  const errors = expectNoBrowserErrors(page), fixtures = await installFixtureRoutes(page);
  const data = calibrationFixture(); data.rates = [data.rates[0]!, { ...data.rates[0]!, tier: "long", abovePromptTokens: 200000, input: 0, cacheRead: null }];
  data.unpricedModels = [{ model: "model-unlisted", calls: 3, reason: "No published rate" }]; data.gaps.unpricedCalls = 3; data.gaps.compactionWithoutModel = 2; data.ingestion.collector = "another-session";
  fixtures.replace("/api/calibration", { status: 200, body: envelope(data) }); await page.goto(entry);
  await expect(page.locator(".rates-table tbody tr").nth(1).locator(".cell-value")).toHaveText(["model-cedar", "long", "200,000", "0", "unavailable", "3", "8", "2030-04-01"]);
  await expect(page.locator(".rates-section")).toContainText("per 1M tokens"); await expect(page.locator(".unpriced-models")).toContainText("3 calls");
  await expect(page.locator(".ingestion-stats")).toContainText("Another pi session"); await expect(page.locator(".ingestion-stats")).toContainText("Sun 14 APR 23:59 UTC");
  await expect(page.locator(".errors-list")).toContainText("archive/session"); await expect(page.locator(".errors-list")).toContainText("parse-error");
  await expect(page.locator(".gaps-stats")).toContainText("Compaction without model2"); await expect(page.locator(".counter-gap-days")).toContainText("Fri 12 APR UTC");
  await expect(page.locator("section section, .pace-bar, [style]")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("calibration-rates-ingestion.png"), fullPage: true });
  expect(errors()).toEqual([]); expect(fixtures.unexpected).toEqual([]);
});

test("Calibration stale data retains UTC last-update label and grey freshness", async ({ page }) => {
  const fixtures = await installFixtureRoutes(page, "stale"); await page.goto("/?scenario=stale#/calibration");
  await expect(page.locator(".correction-stats .state-pill")).toHaveText("Calibrated");
  await expect(page.locator(".freshness")).toHaveAttribute("data-state", "stale");
  await expect(page.locator(".status-dot")).toHaveCSS("background-color", "rgb(155, 150, 144)");
  await page.locator(".freshness-indicator").focus(); await expect(page.locator(".freshness-tooltip")).toBeVisible(); await expect(page.locator(".freshness-tooltip")).toContainText("Last update");
  await expect(page.locator(".ingestion-stats")).toContainText("UTC"); expect(fixtures.unexpected).toEqual([]);
});

test("Calibration counter unavailable retains published evidence and unavailable matched totals", async ({ page }) => {
  await installFixtureRoutes(page, "counter-unavailable"); await page.goto("/?scenario=counter-unavailable#/calibration");
  await expect(page.locator(".correction-stats .state-pill")).toHaveText("Counter unavailable");
  await expect(page.locator(".correction-stats")).toContainText("unavailable"); await expect(page.locator(".correction-chart")).toBeVisible();
  await expect(page.locator('[data-series="counter"][data-value]')).toHaveCount(0);
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.locator(".daily-table tbody tr").first().locator(".cell-value")).toHaveText(["Fri 12 APR UTC", "8", "unavailable"]);
});

test("Calibration no-data has one settled line per section and no empty SVG", async ({ page }) => {
  await installFixtureRoutes(page, "no-data"); await page.goto("/?scenario=no-data#/calibration");
  await expect(page.getByRole("heading", { name: "Calibration & data", exact: true })).toBeVisible(); await expect(page.locator("main section")).toHaveCount(3);
  await expect(page.locator("main svg, main table")).toHaveCount(0); await expect(page.locator('main [data-state="empty"]')).toHaveCount(3); await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
});

test("Calibration uses the shell chip grammar without changing its legend", async ({ page }) => {
  const errors = expectNoBrowserErrors(page); await installFixtureRoutes(page); await page.goto(entry);
  const unit = page.locator(".rates-section .stat-chip"), summary = page.locator(".correction-section .summary-chips .stat-chip").first();
  await expect(unit).toHaveCSS("padding", "7px 12px"); await expect(unit).toHaveCSS("gap", "10px"); await expect(unit).toHaveCSS("min-height", "36px");
  await expect(summary).toHaveCSS("padding", "5px 10px"); await expect(summary).toHaveCSS("gap", "7px"); await expect(summary).toHaveCSS("min-height", "30px");
  await expect(page.locator(".counter-legend .legend-key").first()).toHaveCSS("padding", "6px 10px");
  expect(errors()).toEqual([]);
});
for (const [code, status] of [["unauthorized", 401], ["server-unavailable", 0], ["busy", 503]] as const) {
  test(`Calibration ${code} shows only the recovery action that can work`, async ({ page }) => {
    const fixtures = await installFixtureRoutes(page);
    if (status === 0) await page.route("**/api/calibration", route => route.abort("connectionrefused"));
    else fixtures.replace("/api/calibration", { status, body: { apiVersion: 1, error: { code, message: "Fixture error" } } });
    await page.goto(entry);
    const region = page.locator(".calibration-page"), retry = region.getByRole("button", { name: "Retry", exact: true });
    await expect(region).toHaveAttribute("aria-busy", "false"); await expect(region.locator('[data-state="error"]')).toHaveCount(1);
    await expect(region.locator('[data-state="error"]')).toHaveText(code === "busy" ? "Usage is temporarily unavailable. Retry." : "Run /usage again");
    await expect(retry).toHaveCount(code === "busy" ? 1 : 0);
    if (code === "busy") {
      fixtures.replace("/api/calibration", { status: 200, body: envelope(calibrationFixture()) }); await retry.click();
      await expect(region.locator(".correction-stats")).toBeVisible(); await expect(retry).toHaveCount(0);
    }
    expect(fixtures.unexpected).toEqual([]);
  });
}

test("Calibration Retry settles and nav pill never accepts a late response", async ({ page }) => {
  const errors = expectNoBrowserErrors(page), resourceErrors: { path: string; text: string }[] = [];
  page.on("console", message => {
    if (message.type() === "error" && message.location().url.startsWith("http://127.0.0.1")) resourceErrors.push({ path: new URL(message.location().url).pathname, text: message.text() });
  });
  const fixtures = await installFixtureRoutes(page, "error"); await page.goto("/?scenario=error#/calibration");
  const region = page.locator(".calibration-page"), retry = region.getByRole("button", { name: "Retry", exact: true });
  await expect(region.locator('[data-state="error"]')).toHaveCount(1); await expect(retry).toBeVisible();
  fixtures.replace("/api/calibration", { status: 200, body: envelope(calibrationFixture()) }); await retry.focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".correction-stats")).toBeVisible(); await expect(retry).toHaveCount(0);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/calibration", async route => { await held; try { await route.fulfill({ json: envelope(calibrationFixture()) }); } catch { /* Navigation aborted this request. */ } });
  const pending = page.waitForRequest("**/api/calibration"); await page.getByRole("button", { name: "Refresh", exact: true }).click(); await pending;
  await page.getByRole("button", { name: "Overview", exact: true }).click(); release(); await expect(page.locator(".correction-stats")).toHaveCount(0);
  await page.unroute("**/api/calibration"); await page.getByRole("button", { name: "Calibration & data", exact: true }).click();
  await expect(page.locator(".correction-stats")).toBeVisible(); await expect(page).toHaveURL(/#\/calibration$/);
  // Returning to Overview uses its independent fixture response.
  const expected503 = "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
  expect(resourceErrors.filter(e => e.path === "/api/calibration").map(e => e.text)).toEqual([expected503]);
  expect(resourceErrors.every(e => ["/api/calibration", "/api/overview"].includes(e.path) && e.text === expected503)).toBe(true);
  expect(errors()).toEqual(resourceErrors.map(e => e.text)); expect(fixtures.unexpected).toEqual([]);
});
