import { test, expect } from "@playwright/test";
import { installFixtureRoutes } from "./fixtures.js";
import { overviewFixture, envelope } from "../__tests__/fixtures/redesign-contract.js";

test("pace month remains unobscured at the right end in every pace state", async ({ page }) => {
  const fixtures = await installFixtureRoutes(page);
  const normal = overviewFixture().pace;
  for (const pace of [normal, { ...normal, budget: null, scale: 120 }, { ...normal, counterAvailable: false, usedSource: "pi" as const }, { ...normal, used: 110, projected: 140, overBudget: true }, { ...normal, scale: null, budget: null, allowance: null }, { ...normal, used: .01, projected: 95 }, { ...normal, used: null, projected: null }]) {
    fixtures.replace("/api/overview", { status: 200, body: envelope(overviewFixture({ pace })) });
    await page.goto("/#/");
    const label = page.locator(".pace-month-label"), track = page.locator(".pace-track");
    await expect(label).toBeVisible();
    const a = (await label.boundingBox())!, b = (await track.boundingBox())!;
    expect(a.width).toBeGreaterThan(0); expect(a.height).toBeGreaterThan(0);
    expect(b.x + b.width - a.x - a.width).toBeGreaterThanOrEqual(10);
    expect(b.x + b.width - a.x - a.width).toBeLessThanOrEqual(24);
    expect(a.y).toBeGreaterThan(b.y); expect(a.y + a.height).toBeLessThan(b.y + b.height);
    const paint = await label.evaluate(el => {
      const css = getComputedStyle(el), rect = el.getBoundingClientRect(), svg = el.closest("svg")!, last = svg.lastElementChild!;
      return { visibility: css.visibility, opacity: css.opacity, lastContains: last === el || last.contains(el), overlap: [...svg.querySelectorAll(".pace-used, .pace-here")].some(n => { const r = n.getBoundingClientRect(); return Math.min(r.right, rect.right) > Math.max(r.left, rect.left) && Math.min(r.bottom, rect.bottom) > Math.max(r.top, rect.top); }) };
    });
    expect(paint).toEqual({ visibility: "visible", opacity: "1", lastContains: true, overlap: false });
  }
});

test("daily plot fills its box and cream selection hugs bars without a second focus frame", async ({ page }) => {
  const fixtures = await installFixtureRoutes(page);
  for (const width of [1280, 1440, 1600]) {
    fixtures.replace("/api/overview", { status: 200, body: envelope(overviewFixture()) });
    await page.setViewportSize({ width, height: 1000 }); await page.goto("/#/");
    const bar = page.locator('.daily-chart [data-bucket]').nth(4); await expect(bar).toBeVisible();
    const selected = overviewFixture(); selected.range.buckets = [selected.buckets[4]!.key];
    fixtures.replace("/api/overview", { status: 200, body: envelope(selected) });
    await bar.focus(); await bar.press("Space"); await expect(bar).toHaveAttribute("aria-pressed", "true");
    const state = await bar.evaluate(el => {
      const outline = el.querySelector(".bucket-focus")!, hit = el.querySelector(".bucket-hit")!, css = getComputedStyle(outline);
      const svg = el.closest("svg")!, chart = svg.getBoundingClientRect(), unit = svg.querySelector(".daily-unit")!, unitBox = unit.getBoundingClientRect();
      return { stroke: css.stroke, outline: getComputedStyle(el).outlineStyle, unitFont: getComputedStyle(unit).fontFamily, topGap: unitBox.y - chart.y, focusHeight: Number(outline.getAttribute("height")), hitHeight: Number(hit.getAttribute("height")), selected: el.getAttribute("aria-pressed") };
    });
    expect(state.stroke).toBe("rgb(243, 234, 219)"); expect(state.outline).toBe("none");
    expect(state.unitFont).toContain("Fira Sans"); expect(state.topGap).toBeLessThan(28);
    expect(state.focusHeight).toBeLessThan(state.hitHeight); expect(state.selected).toBe("true");
    await page.getByRole("button", { name: "Tokens", exact: true }).focus();
    await expect(bar.locator(".bucket-focus")).toHaveCSS("stroke", "rgb(243, 234, 219)");
    const contrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const l = (hex: string) => hex.replace("#", "").match(/../g)!.map(n => parseInt(n, 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((s, n, i) => s + n * [.2126, .7152, .0722][i]!, 0);
      const ink = l(style.getPropertyValue("--usage-focus-ring").trim()); return ["--usage-ground", "--usage-surface"].map(t => { const bg = l(style.getPropertyValue(t).trim()); return (Math.max(ink, bg) + .05) / (Math.min(ink, bg) + .05); });
    });
    expect(contrast.every(n => n >= 3)).toBe(true);
  }
});

test("session identities share a text baseline with project pills in every row", async ({ page }) => {
  const fixtures = await installFixtureRoutes(page), d = overviewFixture(), row = d.sessions.rows[0]!;
  d.sessions.rows = Array.from({ length: 10 }, (_, i) => ({ ...structuredClone(row), name: `Garden session ${i + 1}`, id: `garden-${i}` }));
  fixtures.replace("/api/overview", { status: 200, body: envelope(d) }); await page.goto("/#/");
  await expect(page.locator(".sessions-table:visible tbody tr")).toHaveCount(10);
  const gaps = await page.locator(".session-identity:visible").evaluateAll(nodes => nodes.map(n => {
    const name = n.querySelector(".session-name")!, pill = n.querySelector(".project-pill")!;
    const sheet = new CSSStyleSheet(); sheet.replaceSync(".baseline-probe{display:inline-block;width:0;height:0;vertical-align:baseline}"); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    const baseline = (node: Element) => { const probe = document.createElement("span"); probe.className = "baseline-probe"; node.append(probe); const y = probe.getBoundingClientRect().y; probe.remove(); return y; };
    return Math.abs(baseline(name) - baseline(pill));
  }));
  expect(gaps.every(n => n <= .5)).toBe(true);
});

test("initial daily geometry is CSS sized before any resize callback or frame", async ({ page }) => {
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  });
  await installFixtureRoutes(page); await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto("/#/");
  const chart = page.locator(".daily-chart"); await expect(chart).toBeVisible();
  const geometry = await chart.evaluate((n: SVGSVGElement) => {
    const box = n.getBoundingClientRect(), unit = n.querySelector(".daily-unit")!.getBoundingClientRect();
    return { width: Math.abs(n.viewBox.baseVal.width - box.width), height: Math.abs(n.viewBox.baseVal.height - box.height), topGap: unit.y - box.y };
  });
  expect(geometry.width).toBeLessThan(1); expect(geometry.height).toBeLessThan(1); expect(geometry.topGap).toBeLessThan(28);
});

test("resize redraw keeps the selected daily bar node and keyboard focus", async ({ page }) => {
  const routes = await installFixtureRoutes(page), d = overviewFixture();
  d.range.buckets = [d.buckets[4]!.key]; routes.replace("/api/overview", { status: 200, body: envelope(d) });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto("/#/");
  const bar = page.locator('.daily-chart [data-bucket]').nth(4); await bar.focus();
  const original = await bar.elementHandle();
  for (const width of [1280, 1600, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.locator(".daily-chart").evaluate((n: SVGSVGElement) => Math.abs(n.viewBox.baseVal.width - n.getBoundingClientRect().width))).toBeLessThan(1);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await original!.evaluate(n => n.isConnected && n === document.activeElement)).toBe(true);
    await expect(bar).toBeFocused(); await expect(bar).toHaveAttribute("aria-pressed", "true");
    await expect(bar.locator(".bucket-focus")).toHaveCSS("stroke", "rgb(243, 234, 219)");
  }
});
