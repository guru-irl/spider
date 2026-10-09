import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { installFixtureRoutes, expectNoBrowserErrors } from "./fixtures.js";
import { overviewFixture, sessionFixture, envelope } from "../__tests__/fixtures/redesign-contract.js";
import type { Unit } from "../dashboard-v4-contract.js";

async function openFlow(page: Page, view: "overview" | "session", unit: Unit, long = false) {
  const routes = await installFixtureRoutes(page), flow = overviewFixture().flow;
  flow.edges = flow.edges.map((e, i) => ({ ...e, value: { ...e.value, calls: 7, unpricedCalls: i ? 0 : 2 } }));
  if (long) {
    flow.models = flow.models.map(m => ({ ...m, id: `${m.id}-with-a-very-long-model-label`, value: { ...m.value, credits: 1e27, tokens: { ...m.value.tokens, total: 1e27 } } }));
    flow.edges = flow.edges.map(e => ({ ...e, model: `${e.model}-with-a-very-long-model-label`, value: { ...e.value, credits: e.role === "own" ? null : 1e27, tokens: { ...e.value.tokens, total: 1e27 } }, share: e.role === "own" ? .527 : .473 / 4 }));
    flow.total.tokens.total = flow.edges.reduce((sum, e) => sum + e.value.tokens.total, 0);
  }
  routes.replace("/api/overview", { status: 200, body: envelope(overviewFixture({ flow, range: { ...overviewFixture().range, unit } })) });
  routes.replace("/api/session/session-garden", { status: 200, body: envelope(sessionFixture({ flow })) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(view === "overview" ? `/#/?unit=${unit}` : `/#/session/session-garden?unit=${unit}&tz=UTC`);
  const svg = page.locator(".flow-svg"); await expect(svg).toBeVisible(); await svg.scrollIntoViewIfNeeded();
  return { svg, routes };
}
async function shot(page: Page, name: string) {
  if (process.env.SPIDER_FLOW_EVIDENCE) await page.locator(".flow-panel").screenshot({ path: resolve(process.env.SPIDER_FLOW_EVIDENCE, `${name}.png`) });
}
async function labelBounds(page: Page) {
  return page.locator(".flow-svg").evaluate(svg => {
    const view = (svg as SVGSVGElement).viewBox.baseVal;
    return [...svg.querySelectorAll("text")].map(text => { const b = text.getBBox(); return { text: text.textContent, left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height, width: view.width, height: view.height }; });
  });
}
test("flow Escape dismisses its detail without clearing the Overview selection or replacing focus", async ({ page }) => {
  await installFixtureRoutes(page);
  await page.route("**/api/overview?**", async route => {
    const params = new URL(route.request().url()).searchParams, data = overviewFixture();
    data.range.buckets = JSON.parse(params.get("buckets") ?? "[]");
    await route.fulfill({ json: envelope(data) });
  });
  await page.goto("/#/");
  await page.locator(".daily-chart [data-bucket]").nth(4).press("Space");
  await expect(page.locator(".selection-chip")).toBeVisible();
  const band = page.locator('.flow-svg [data-flow-role="own"]'), tooltip = page.locator(".flow-tooltip");
  await band.focus(); await expect(tooltip).toBeVisible();
  await band.press("Escape"); await expect(tooltip).toBeHidden(); await expect(band).toBeFocused();
  await expect(page.locator(".selection-chip")).toBeVisible();
});

for (const view of ["overview", "session"] as const) for (const unit of ["credits", "tokens"] as const) {
  test(`${view} ${unit} flow hover and keyboard detail highlight bands and nodes`, async ({ page }) => {
    const errors = expectNoBrowserErrors(page), { svg, routes } = await openFlow(page, view, unit);
    const band = svg.locator('[data-flow-role="own"][data-flow-model="model-cedar"]'), tooltip = svg.getByRole("tooltip");
    await expect(svg.locator("title")).toHaveCount(0);
    if (unit === "credits") await shot(page, `${view}-default`);
    await band.hover(); await expect(tooltip).toBeVisible();
    for (const text of ["Own calls to model-cedar", unit, view === "session" && unit === "tokens" ? "33.3%" : "20%", "7 calls", "2 unpriced calls"]) await expect(tooltip).toContainText(text);
    await expect(band).toHaveAttribute("opacity", "1"); await expect(svg.locator('[data-flow-role="workers"]')).toHaveAttribute("opacity", "0.16");
    expect(await tooltip.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(51, 43, 36)");
    expect(await svg.locator(".flow-value").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("15px");
    expect(await svg.evaluate(el => getComputedStyle(el).height)).toBe("630px");
    const bounds = await tooltip.boundingBox(), chart = await svg.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(chart!.x); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(chart!.x + chart!.width + 1);
    expect(bounds!.y).toBeGreaterThanOrEqual(chart!.y); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(chart!.y + chart!.height + 1);
    if (unit === "credits") await shot(page, `${view}-hover`);
    await page.mouse.move(0, 0); await expect(tooltip).toBeHidden();
    const own = svg.locator('[data-flow-node-role="own"]'); await own.focus(); await expect(tooltip).toBeVisible();
    await expect(svg.locator('[data-flow-role="own"]')).toHaveAttribute("opacity", "1"); await expect(svg.locator('[data-flow-role="reviewers"]')).toHaveAttribute("opacity", "0.16");
    await own.press("Tab"); await expect(svg.locator('[data-flow-node-role="workers"]')).toBeFocused();
    await band.focus(); await expect(tooltip).toBeVisible(); await band.press("Escape"); await expect(tooltip).toBeHidden(); await expect(band).toBeFocused();
    await expect(svg.locator('.flow-band[opacity="0.16"]')).toHaveCount(0);
    await band.press("Tab"); await expect(svg.locator('[data-flow-role="workers"]')).toBeFocused(); await expect(tooltip).toContainText("Workers to model-maple"); await expect(tooltip).not.toContainText("unpriced calls");
    const model = svg.locator('[data-flow-node-model="model-cedar"]'); await model.focus();
    await expect(svg.locator('[data-flow-role="own"]')).toHaveAttribute("opacity", "1"); await expect(svg.locator('[data-flow-role="reviewers"]')).toHaveAttribute("opacity", "1"); await expect(svg.locator('[data-flow-role="workers"]')).toHaveAttribute("opacity", "0.16");
    await model.press("Escape"); await expect(tooltip).toBeHidden(); await expect(model).toBeFocused();
    const panel = page.locator(".flow-panel"); await panel.getByRole("button", { name: "Table", exact: true }).click(); await expect(svg).toBeHidden();
    await expect(panel.getByRole("table")).toContainText("Own calls"); await expect(panel.getByRole("table")).toContainText("model-cedar");
    expect(routes.unexpected).toEqual([]); expect(errors()).toEqual([]);
  });
  test(`${view} ${unit} long values stay inside the flow at all desktop widths`, async ({ page }) => {
    const errors = expectNoBrowserErrors(page); await openFlow(page, view, unit, true);
    for (const width of [1280, 1440, 1600]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const b of await labelBounds(page)) { expect(b.left, b.text!).toBeGreaterThanOrEqual(0); expect(b.right, b.text!).toBeLessThanOrEqual(b.width); expect(b.top, b.text!).toBeGreaterThanOrEqual(0); expect(b.bottom, b.text!).toBeLessThanOrEqual(b.height); }
      if (width === 1440) await shot(page, `${view}-${unit}-long`);
    }
    expect(errors()).toEqual([]);
  });
}
