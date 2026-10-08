import { expect, test } from "@playwright/test";
import { installFixtureRoutes, expectNoBrowserErrors } from "./fixtures.js";
import { sessionFixture, overviewFixture, envelope } from "../__tests__/fixtures/redesign-contract.js";
import { routeHash } from "../web/navigation.js";

test("transit hover, pin and Escape retain focus and select the runs row", async ({ page }) => {
  const errors = expectNoBrowserErrors(page), routes = await installFixtureRoutes(page);
  await page.goto("/#/session/session-garden?unit=credits&tz=UTC");
  const branch = page.locator('.run-route[data-run-id="run-build"]'), card = page.locator(".route-card");
  await expect(branch).toBeVisible(); await branch.locator('[data-model-marker]').hover(); await expect(card).toBeVisible();
  for (const text of ["Build garden tools", "worker", "model-maple", "high", "Credits", "Tokens", "Duration", "completed"]) await expect(card).toContainText(text);
  await expect(page.locator('.run-route[data-run-id="run-review"]')).toHaveClass(/is-dim/);
  await branch.locator('[data-model-marker]').click(); await expect(page.locator('[data-run-row="run-build"]')).toHaveAttribute("aria-selected", "true");
  await branch.press("Escape"); await expect(branch).toBeFocused(); await expect(card).toBeHidden();
  await expect(page.locator('[data-run-row="run-build"]')).toHaveAttribute("aria-selected", "false");
  expect(routes.unexpected).toEqual([]); expect(errors()).toEqual([]);
});
test("transit keyboard arrows, Tab and Enter activate real routes and rows", async ({ page }) => {
  await installFixtureRoutes(page); await page.goto("/#/session/session-garden?unit=credits&tz=UTC");
  const first = page.locator('.run-route[data-run-id="run-build"]'), second = page.locator('.run-route[data-run-id="run-review"]');
  await first.focus(); await first.press("ArrowRight"); await expect(second).toBeFocused(); await second.press("Enter");
  await expect(page.locator('[data-run-row="run-review"]')).toHaveAttribute("aria-selected", "true");
  await second.press("Escape"); await expect(second).toBeFocused();
  await expect(page.locator('svg.session-route [tabindex="0"]')).toHaveCount(1);
  await second.press("ArrowRight"); await expect(page.locator('[data-event="own"]').first()).toBeFocused();
  await page.keyboard.press("End"); await expect(page.locator('[data-event="idle"]').last()).toBeFocused();
  await page.keyboard.press("Home"); await expect(first).toBeFocused();
  await first.press("Tab"); await expect(page.locator('[data-run-row="run-build"]')).toBeFocused();
  const row = page.locator('[data-run-row="run-build"]'); await row.focus(); await row.press("Enter"); await expect(row).toHaveAttribute("aria-selected", "true");
  await row.press("ArrowDown"); await expect(page.locator('[data-run-row="run-review"]')).toBeFocused();
});
test("runs Show all and sortable columns preserve the route data", async ({ page }) => {
  const routes = await installFixtureRoutes(page), data = sessionFixture();
  data.runs = Array.from({ length: 25 }, (_, i) => ({ ...data.runs[0]!, id: `run-${i}`, name: `Task ${i}`, start: data.span!.start + i * 1000, value: { ...data.runs[0]!.value, credits: i } }));
  routes.replace(`/api/session/${data.id}`, { status: 200, body: envelope(data) });
  await page.goto("/#/session/session-garden?unit=credits&tz=UTC"); await expect(page.locator("[data-run-row]")).toHaveCount(20);
  await page.getByRole("button", { name: "Show all 25", exact: true }).press("Enter"); await expect(page.locator("[data-run-row]")).toHaveCount(25);
  await page.locator('.runs-table th').getByRole("button", { name: "Credits", exact: true }).click();
  await expect(page.locator("[data-run-row]").first()).toHaveAttribute("data-run-row", "run-24");
  expect(routes.count(`/api/session/${data.id}`)).toBe(1);
});
test("session Chart Table and Tokens operate by keyboard without extra lifetime requests", async ({ page }) => {
  const routes = await installFixtureRoutes(page); await page.goto("/#/session/session-garden?unit=credits&tz=UTC");
  const route = page.locator(".session-route-section"); await expect(route.locator("svg.session-route")).toBeVisible();
  await route.getByRole("button", { name: "Table", exact: true }).press("Space");
  await expect(route.getByRole("table")).toBeVisible(); await expect(route.getByRole("table")).toContainText("Total");
  await expect(route.getByRole("table")).toContainText("10"); await expect(route.getByRole("table")).toContainText("Legacy garden review");
  await page.locator('.session-header').getByRole("button", { name: "Tokens", exact: true }).press("Enter");
  await route.getByRole("button", { name: "Chart", exact: true }).click(); await expect(route).toContainText("Tokens per run");
  expect(routes.count(`/api/session/${sessionFixture().id}`)).toBe(1);
});
test("Back restores the remembered Overview range, unit and selection", async ({ page }) => {
  const routes = await installFixtureRoutes(page);
  const query = { range: "custom" as const, from: 1000, to: 4000, tz: "UTC", unit: "tokens" as const, buckets: [1000, 3000] };
  // A registered Overview legitimately reconciles its hash to the server echo.
  routes.replace("/api/overview", { status: 200, body: envelope(overviewFixture({ range: query }), { start: 1000, end: 4000 }) });
  await page.goto("/#/session/session-garden?unit=credits&tz=UTC");
  const overview = routeHash({ page: "overview", query });
  await page.evaluate(hash => { location.hash = hash; }, overview); await expect(page.locator('nav button').first()).toHaveAttribute("aria-current", "page");
  await page.evaluate(() => { location.hash = "#/session/session-garden?unit=tokens&tz=UTC"; });
  await expect(page.locator('.session-header')).toBeVisible(); const requestStart = routes.requests.length;
  await page.getByRole("button", { name: "Back", exact: true }).press("Enter");
  await expect.poll(() => page.evaluate(() => ({ path: location.hash.split("?")[0], query: Object.fromEntries(new URLSearchParams(location.hash.split("?")[1])) }))).toEqual({
    path: "#/", query: { range: "custom", from: "1000", to: "4000", tz: "UTC", unit: "tokens", buckets: "[1000,3000]" },
  });
  await expect(page.locator('nav button').first()).toHaveAttribute("aria-current", "page");
  await expect(page.locator('.overview-page')).toBeVisible();
  {
    await expect.poll(() => routes.requests.slice(requestStart).filter(r => r.path === "/api/overview").length).toBeGreaterThan(0);
    const request = routes.requests.slice(requestStart).find(r => r.path === "/api/overview")!;
    expect(Object.fromEntries(request.params)).toEqual({ range: "custom", from: "1000", to: "4000", tz: "UTC", unit: "tokens", buckets: "[1000,3000]" });
  }
});
test("idle breaks stay fixed width and resize preserves branch focus after Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const routes = await installFixtureRoutes(page), d = sessionFixture();
  d.idleGaps = [{ start: d.span!.start + 60000, end: d.span!.start + 61 * 60000, cacheWriteCredits: 0.5 }]; d.activePeriods = [{ ...d.span! }];
  routes.replace(`/api/session/${d.id}`, { status: 200, body: envelope(d) }); await page.goto("/#/session/session-garden?unit=credits&tz=UTC");
  const gap = page.locator('[data-event="idle"]'); await gap.focus(); await expect(page.locator('.route-card')).toContainText("1 h"); await expect(page.locator('.route-card')).toContainText("0.5");
  const breakWidth = () => page.locator('[data-event="break"] .route-hit').first().evaluate(line => {
    const node = line as SVGGraphicsElement, scale = node.getScreenCTM()!;
    return (Number(node.getAttribute("x2")) - Number(node.getAttribute("x1"))) * Math.hypot(scale.a, scale.b);
  });
  expect(await breakWidth()).toBeCloseTo(28, 0);
  const branch = page.locator('.run-route').first(); await branch.focus(); await branch.press("Escape"); await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(breakWidth).toBeCloseTo(28, 0);
  await expect(branch).toBeFocused(); await expect(page.locator('.route-card')).toBeHidden();
  await gap.focus(); await expect(gap).toHaveAttribute("tabindex", "0");
  const beforeResize = await page.locator('svg.session-route').getAttribute("width");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.locator('svg.session-route').getAttribute("width")).not.toBe(beforeResize);
  await expect(gap).toBeFocused(); await expect(gap).toHaveAttribute("tabindex", "0");
  await expect(page.locator('.route-card')).toContainText("Next call cache-write credits");
});
test("many idle breaks scroll instead of shrinking their fixed width", async ({ page }) => {
  const routes = await installFixtureRoutes(page), d = sessionFixture(), start = d.span!.start, hour = 3600000;
  d.span = { start, end: start + 101 * hour };
  d.activePeriods = Array.from({ length: 102 }, (_, i) => ({ start: start + i * hour, end: start + i * hour + 60000 }));
  d.idleGaps = []; routes.replace(`/api/session/${d.id}`, { status: 200, body: envelope(d) });
  await page.goto("/#/session/session-garden?unit=credits&tz=UTC");
  const line = page.locator('[data-event="break"] .route-hit').first(); await expect(line).toHaveCount(1);
  await expect.poll(() => line.evaluate(el => {
    const n = el as SVGGraphicsElement, scale = n.getScreenCTM()!;
    return (Number(n.getAttribute("x2")) - Number(n.getAttribute("x1"))) * Math.hypot(scale.a, scale.b);
  })).toBeCloseTo(28, 0);
  expect(await page.locator('.route-box').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
});
test("metadata-only and own-only sessions render honest empty sections", async ({ page }) => {
  const routes = await installFixtureRoutes(page), d = sessionFixture();
  d.runs = []; d.stats.runs = 0; routes.replace(`/api/session/${d.id}`, { status: 200, body: envelope(d) });
  await page.goto("/#/session/session-garden?unit=credits&tz=UTC"); await expect(page.locator('svg.session-route')).toBeVisible(); await expect(page.locator('.own-baseline')).toHaveCount(1); await expect(page.locator('.run-route')).toHaveCount(0); await expect(page.locator('.session-runs-section')).toContainText("No subagent runs");
  d.span = null; routes.replace(`/api/session/${d.id}`, { status: 200, body: envelope(d) }); await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator('main')).toContainText("No calls were recorded."); await expect(page.locator('.session-header')).toBeVisible(); await expect(page.locator('.session-route-section')).toHaveCount(0);
});
test("desktop Session layout and offline fonts remain usable", async ({ page }, testInfo) => {
  const routes = await installFixtureRoutes(page), errors = expectNoBrowserErrors(page);
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto("/#/session/session-garden?unit=credits&tz=UTC");
    await expect(page.locator('.session-models-section')).toBeVisible();
    expect(await page.locator('main>section section').count()).toBe(0);
    expect(await page.evaluate(() => document.querySelectorAll('[style]').length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const ticks = await page.locator('[data-time-tick]').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.left).toBeGreaterThanOrEqual(ticks[i - 1]!.right + 8);
    await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: testInfo.outputPath(`session-${width}.png`), fullPage: true });
  }
  expect(routes.unexpected).toEqual([]); expect(errors()).toEqual([]);
});
test("dense route time labels do not collide with anchored endpoints", async ({ page }) => {
  const routes = await installFixtureRoutes(page), d = sessionFixture(), start = d.span!.start;
  d.span = { start, end: start + 1094 * 60000 }; d.runs = []; d.idleGaps = [];
  d.activePeriods = Array.from({ length: 1094 }, (_, i) => ({ start: start + i * 60000, end: start + (i + 1) * 60000 }));
  routes.replace(`/api/session/${d.id}`, { status: 200, body: envelope(d) });
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/#/session/session-garden?unit=credits&tz=UTC");
  await expect(page.locator('[data-time-tick]').first()).toHaveAttribute("data-time-tick", String(start));
  await expect(page.locator('[data-time-tick]').last()).toHaveAttribute("data-time-tick", String(d.span.end));
  const ticks = await page.locator('[data-time-tick]').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
  for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.left).toBeGreaterThanOrEqual(ticks[i - 1]!.right + 8);
});
test("session not found has only Back and settles without retry or a spinner", async ({ page }) => {
  const errors = expectNoBrowserErrors(page); await installFixtureRoutes(page, "unknown-session");
  await page.goto("/?scenario=unknown-session#/session/unknown-session?unit=credits&tz=UTC");
  await expect(page.locator("main")).toContainText("Session not found"); await expect(page.locator('main button')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible(); await expect(page.locator('main')).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  expect(errors()).toEqual(["Failed to load resource: the server responded with a status of 404 (Not Found)"]);
});
test("late aborted lifetime response cannot repaint a different session", async ({ page }) => {
  const routes = await installFixtureRoutes(page), next = sessionFixture({ id: "session-next", name: "Next garden session" });
  routes.replace(`/api/session/${next.id}`, { status: 200, body: envelope(next) });
  let release!: () => void, observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { observed = resolve; });
  let finished!: () => void; const settled = new Promise<void>(resolve => { finished = resolve; });
  await page.route("**/api/session/session-garden?*", async route => {
    observed(); await gate;
    try { await route.fulfill({ json: envelope(sessionFixture({ name: "Old garden session" })) }); } catch { /* The browser already aborted the obsolete fetch. */ }
    finally { finished(); }
  });
  await page.goto("/#/session/session-garden?unit=credits&tz=UTC"); await requested; await expect(page.locator('main')).toContainText("Loading session");
  await page.evaluate(() => { location.hash = "#/session/session-next?unit=credits&tz=UTC"; });
  await expect(page.locator('h1')).toHaveText("Next garden session"); release(); await settled;
  await expect(page.locator('h1')).toHaveText("Next garden session"); await expect(page.locator('main')).not.toContainText("Old garden session");
});
test("invalid ids stay local and navigation clears an old card", async ({ page }) => {
  const routes = await installFixtureRoutes(page); await page.goto("/#/session/bad%2Fid?unit=credits&tz=UTC");
  await expect(page.locator("main")).toContainText("Session not found"); expect(routes.requests.filter(r => r.path.startsWith("/api/session/"))).toHaveLength(0);
  await page.goto("/#/session/session-garden?unit=credits&tz=UTC"); await page.locator('.run-route').first().focus(); await expect(page.locator('.route-card')).toBeVisible();
  for (const id of ["bad%2Fid", "%E0%A4%A"]) {
    const requests = routes.requests.length;
    await page.evaluate(value => { location.hash = `#/session/${value}`; }, id);
    await expect(page.locator('main')).toContainText("Session not found"); expect(routes.requests).toHaveLength(requests);
    await expect(page.locator('.route-card')).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Calibration & data", exact: true }).click(); await expect(page.locator('.route-card')).toHaveCount(0);
});


test("refresh keeps an Escape-dismissed focused route card closed", async ({ page }) => {
  await installFixtureRoutes(page); await page.goto("/#/session/session-garden");
  const run = page.locator('[data-run-id="run-build"]'); await run.focus(); await run.press("Escape"); await expect(page.locator(".route-card")).toBeHidden();
  await page.evaluate(() => (document.querySelector(".refresh") as HTMLButtonElement).click());
  await expect(run).toBeFocused(); await expect(page.locator(".route-card")).toBeHidden();
});
