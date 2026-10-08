import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { inkRows } from "./ink-rows.js";
import { resolve } from "node:path";
import { installFixtureRoutes, expectNoBrowserErrors } from "./fixtures.js";
import { fixtureStateCases, overviewFixture, sessionFixture, calibrationFixture, envelope } from "../__tests__/fixtures/redesign-contract.js";
import type { FixtureScenario } from "../__tests__/fixtures/redesign-contract.js";

const widths = [1280, 1440, 1600];
const scenarios: FixtureScenario[] = ["default", "no-data", "no-budget", "counter-unavailable", "over-pace", "stale", "unknown-session", "error", "no-budget-or-allowance"];
const routes = { overview: "#/", session: "#/session/session-garden?tz=UTC", calibration: "#/calibration" };
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.race([document.fonts.ready, new Promise<void>(done => setTimeout(done, 2000))]);
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
}
async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const directory = resolve(info.project.outputDir, "acceptance"); await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${name}.png`); await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}
async function layoutFailures(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const failures: string[] = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) failures.push("document overflows horizontally");
    for (const root of document.querySelectorAll<HTMLElement>(".state-example")) if (root.scrollWidth > root.clientWidth) failures.push(`${root.querySelector("h2")?.textContent}: example overflows`);
    for (const grid of document.querySelectorAll(".overview-grid")) {
      const boxes = [...grid.children].map(n => n.getBoundingClientRect());
      if (boxes.length === 2 && Math.abs(boxes[0]!.height - boxes[1]!.height) > 1) failures.push("Daily and Models heights differ");
    }
    for (const header of document.querySelectorAll(".topbar")) {
      const mark = header.querySelector(".web-mark")!.getBoundingClientRect(), word = header.querySelector(".wordmark")!.getBoundingClientRect();
      if (Math.abs(mark.y + mark.height / 2 - word.y - word.height / 2) > 1) failures.push("mark and wordmark are off centre");
      const bounds = header.getBoundingClientRect(), controls = [...header.querySelectorAll(".brand, .nav button, .freshness-indicator, .refresh")].map(n => n.getBoundingClientRect());
      for (let i = 0; i < controls.length; i++) {
        const a = controls[i]!;
        if (a.x < bounds.x || a.right > bounds.right || a.y < bounds.y || a.bottom > bounds.bottom) failures.push("menu control clipped");
        for (const b of controls.slice(i + 1)) if (Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) failures.push("menu controls overlap");
      }
    }
    for (const section of document.querySelectorAll("main section")) {
      const outer = getComputedStyle(section);
      if (!(parseFloat(outer.borderTopWidth) > 0 && parseFloat(outer.borderTopLeftRadius) > 0)) continue;
      for (const descendant of section.querySelectorAll("*")) {
        if (descendant.closest("button, input, select, [role=button], [role=group].segmented, .fact-chip, .stat-chip, .state-pill, .project-pill, .selection-chip, .role-key, .legend-key, [role=tooltip], .route-card, .pace-popover")) continue;
        const cs = getComputedStyle(descendant);
        if ([cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].some(n => parseFloat(n) > 0) && [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius].some(n => parseFloat(n) > 0)) failures.push(`nested section box: ${descendant.tagName}.${descendant.className}`);
      }
    }
    if (document.querySelector(".even-pace-tick, .pace-limit, [style]")) failures.push("retired ticks or inline style");
    return failures;
  });
}
async function layout(page: Page): Promise<void> { expect.soft(await layoutFailures(page)).toEqual([]); }
/** Read actual rendered text, including SVG, rather than enumerating palette tokens.
 * Backgrounds composite through ancestors. SVG fills behind a text sample participate
 * in paint order, so dark text on a pale pace/role segment is tested against that fill.
 */
async function contrast(page: Page, info: TestInfo, name: string): Promise<void> {
  const records = await page.evaluate(() => {
    type Color = [number, number, number, number];
    const color = (value: string): Color => {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
    };
    const over = (a: Color, b: Color): Color => [a[0] * a[3] + b[0] * (1 - a[3]), a[1] * a[3] + b[1] * (1 - a[3]), a[2] * a[3] + b[2] * (1 - a[3]), 1];
    const luminance = (c: Color) => c.slice(0, 3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const alpha = (node: Element) => { let opacity = 1; for (let n: Element | null = node; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity); return opacity; };
    const background = (node: Element): Color => {
      const chain: Element[] = []; for (let n: Element | null = node; n; n = n.parentElement) chain.unshift(n);
      return chain.reduce((bg, n) => over(color(getComputedStyle(n).backgroundColor), bg), [255, 255, 255, 1] as Color);
    };
    const records: { text: string; selector: string; foreground: Color; background: Color; ratio: number; required: number }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.trim(), node = walker.currentNode.parentElement;
      if (!text || !node || node.closest("script, style, title, desc, .sr-only, caption")) continue;
      const cs = getComputedStyle(node), rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || cs.visibility !== "visible" || node.closest("[hidden]") || alpha(node) === 0 || cs.clipPath.includes("inset(50%")) continue;
      const svgText = node.closest("text"), range = document.createRange(); range.selectNode(walker.currentNode);
      const sample = range.getBoundingClientRect(); if (!sample.width || !sample.height) continue;
      let bg = background(node);
      if (svgText) {
        // Shapes are siblings, not ancestors. Use SVG geometry at the text centre
        // even for content below the viewport and pointer-events:none charts.
        const svg = svgText.ownerSVGElement!, point = new DOMPoint(sample.x + sample.width / 2, sample.y + sample.height / 2);
        for (const shape of svg.querySelectorAll<SVGGeometryElement>("rect, circle, path, polygon")) {
          if (shape.compareDocumentPosition(svgText) & Node.DOCUMENT_POSITION_PRECEDING || shape.closest("defs")) continue;
          const fill = getComputedStyle(shape).fill, matrix = shape.getScreenCTM();
          if (!matrix || fill === "none" || fill.startsWith("url(")) continue;
          if (shape.isPointInFill(point.matrixTransform(matrix.inverse()))) { const c = color(fill); c[3] *= alpha(shape) * Number(getComputedStyle(shape).fillOpacity); bg = over(c, bg); }
        }
      }
      const fg = color(svgText ? cs.fill : cs.color); fg[3] *= alpha(node) * (svgText ? Number(cs.fillOpacity) : 1);
      const painted = over(fg, bg), a = luminance(painted), b = luminance(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const large = parseFloat(cs.fontSize) >= 24 || parseFloat(cs.fontSize) >= 18.67 && Number(cs.fontWeight) >= 700;
      records.push({ text, selector: `${node.tagName}.${node.getAttribute("class") ?? ""}`, foreground: painted, background: bg, ratio, required: large ? 3 : 4.5 });
    }
    return records;
  });
  expect(records.length).toBeGreaterThan(0);
  const path = info.outputPath(`${name}-contrast.json`); await writeFile(path, JSON.stringify(records, null, 2)); await info.attach(`${name} contrast`, { path, contentType: "application/json" });
  expect.soft(records.filter(r => r.ratio + .01 < r.required)).toEqual([]);
}
for (const width of widths) for (const pageName of ["overview", "session", "calibration"] as const) for (const scenario of scenarios) {
  test(`desktop ${pageName} ${scenario} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 }); const fixtures = await installFixtureRoutes(page, scenario), errors = expectNoBrowserErrors(page);
    const hash = pageName === "session" && scenario === "unknown-session" ? "#/session/unknown-session" : routes[pageName];
    await page.goto(`/${hash}`);
    const main = page.locator("main");
    if (scenario === "error") await expect(main.locator('[data-state="error"]')).toBeVisible();
    else if (pageName === "session" && scenario === "unknown-session") {
      await expect(main).toContainText("Session not found"); await expect(main.getByRole("button", { name: "Back", exact: true })).toBeVisible(); await expect(main.getByRole("button", { name: "Retry" })).toHaveCount(0);
    } else await expect(main.locator(pageName === "overview" ? ".overview-toolbar" : pageName === "session" ? ".session-header" : ".correction-section")).toBeVisible();
    await expect(main.locator('[aria-busy="true"], [data-state="loading"]')).toHaveCount(0);
    if (scenario === "stale") await expect(page.locator(".status-dot")).toHaveCSS("background-color", "rgb(155, 150, 144)");
    if (pageName !== "overview") await expect(main.locator(".month-pace")).toHaveCount(0);
    await settle(page); await capture(page, info, `${pageName}-${scenario}-${width}`); await layout(page); await contrast(page, info, `${pageName}-${scenario}-${width}`);
    if (scenario === "error") {
      const path = pageName === "session" ? "/api/session/session-garden" : `/api/${pageName}`;
      fixtures.replace(path, { status: 200, body: envelope(pageName === "overview" ? overviewFixture() : pageName === "session" ? sessionFixture() : calibrationFixture()) });
      await main.getByRole("button", { name: "Retry", exact: true }).click(); await expect(main.locator('[data-state="error"], [data-state="loading"]')).toHaveCount(0);
    }
    const expected = scenario === "error" ? "503 (Service Unavailable)" : pageName === "session" && scenario === "unknown-session" ? "404 (Not Found)" : null;
    expect(errors()).toEqual(expected ? [`Failed to load resource: the server responded with a status of ${expected}`] : []); expect(fixtures.unexpected).toEqual([]);
  });
}
for (const width of widths) test(`states gallery every component and state ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 }); const errors = expectNoBrowserErrors(page); await installFixtureRoutes(page);
  await page.goto("/states.html"); await expect(page.locator("#states-root")).toHaveAttribute("data-settled", "true");
  for (const example of fixtureStateCases()) await expect(page.locator(".state-example>h2").filter({ hasText: new RegExp(`^${example.name}$`) })).toHaveCount(1);
  for (const state of ["Overview loading", "Session loading", "Calibration loading", "Overview tables", "Session tables", "Calibration tables", "Pace popover", "Pinned run"]) await expect.soft(page.locator(".state-example>h2").filter({ hasText: state })).toHaveCount(1, { timeout: 1000 });

  const marksExample = page.locator(".state-example").filter({ has: page.getByRole("heading", { name: "Session run marks", exact: true }) });
  const marks = await marksExample.locator("[data-status-mark]").all(); expect(marks).toHaveLength(5);
  const boxes = [];
  for (const mark of marks) { await expect(mark).toBeVisible(); const box = (await mark.boundingBox())!; expect(box.width).toBeGreaterThan(0); expect(box.height).toBeGreaterThan(0); boxes.push(box); }
  for (let i = 0; i < boxes.length; i++) for (const b of boxes.slice(i + 1)) { const a = boxes[i]!; expect(Math.min(a.x + a.width, b.x + b.width) <= Math.max(a.x, b.x) || Math.min(a.y + a.height, b.y + b.height) <= Math.max(a.y, b.y)).toBe(true); }
  for (const example of await page.locator(".state-example").all()) {
    for (const bar of await example.locator(".daily-chart [data-bucket]").all()) {
      const key = await bar.getAttribute("data-bucket"), value = await bar.getAttribute("data-value"); expect(value).not.toBeNull();
      const row = example.locator(`[data-panel=daily] tbody tr`).filter({ has: page.locator(`button[data-bucket="${key}"]`) });
      await expect(row.locator("td .cell-value").last()).toHaveText(new Intl.NumberFormat("en-US", { maximumFractionDigits: 20 }).format(Number(value)));
    }
    for (const bar of await example.locator(".correction-bar").all()) {
      const day = await bar.getAttribute("data-day"), series = await bar.getAttribute("data-series"), value = await bar.getAttribute("data-value");
      const row = example.locator(".daily-table tbody tr").filter({ has: page.locator(`time[datetime="${new Date(Number(day)).toISOString()}"]`) });
      await expect(row.locator("td .cell-value").nth(series === "published" ? 1 : 2)).toHaveText(new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value)));
    }
    for (const run of await example.locator(".run-route").all()) {
      const id = await run.getAttribute("data-run-id"); const row = example.locator(`[data-run-row="${id}"]`);
      for (const [attribute, index] of [["data-credits", 5], ["data-tokens", 6]] as const) {
        const raw = await run.getAttribute(attribute); expect(raw).not.toBeNull();
        await expect(row.locator("td .cell-value").nth(index)).toHaveText(raw === "unavailable" ? raw : new Intl.NumberFormat("en-US", { maximumFractionDigits: attribute === "data-credits" ? 20 : 0 }).format(Number(raw)));
      }
    }
  }
  const pin = page.locator('.state-example').filter({ has: page.locator('h2', { hasText: "Pinned run" }) });
  await expect(pin.locator('.route-card')).toBeVisible(); await expect(pin.locator('[data-run-row="run-build"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.state-example').filter({ has: page.locator('h2', { hasText: "Pace short fill" }) }).locator('.pace-used')).toHaveAttribute("data-after", "true");
  await expect(page.locator('.state-example main [data-state="loading"]')).toHaveCount(3);
  await expect(page.locator('[data-status-mark="cancelled"], [data-status-mark="failed"], [data-status-mark="running"]')).not.toHaveCount(0);
  await settle(page); await capture(page, info, `states-gallery-${width}`); await layout(page); await contrast(page, info, `states-${width}`);
  const examples = page.locator(".state-example");
  for (let i = 0; i < await examples.count(); i++) {
    const example = examples.nth(i), name = (await example.locator("h2").first().textContent())!.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const directory = resolve(info.project.outputDir, "acceptance"); const path = resolve(directory, `state-${name}-${width}.png`); await example.screenshot({ path }); await info.attach(`state-${name}-${width}`, { path, contentType: "image/png" });
  }
  expect(errors()).toEqual([]);
});
for (const scenario of ["default", "no-budget", "counter-unavailable", "no-budget-or-allowance", "over-pace"] as const) test(`pace ring anchor and honest popover ${scenario}`, async ({ page }, info) => {
  await installFixtureRoutes(page, scenario); await page.goto("/#/"); const trigger = page.locator(".pace-trigger"); await expect(trigger).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 }); await trigger.click(); await expect(page.locator(".pace-popover")).toBeVisible();
    if (scenario !== "no-budget-or-allowance") await expect.poll(async () => { const a = await page.locator(".pace-pointer").boundingBox(), b = await page.locator(".pace-here").boundingBox(); return Math.abs(a!.x + a!.width / 2 - b!.x - b!.width / 2); }).toBeLessThanOrEqual(1);
    const box = (await page.locator(".pace-popover").boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    if (scenario === "no-budget" || scenario === "no-budget-or-allowance") { await expect(page.locator(".pace-popover")).not.toContainText("Even pace"); await expect(page.locator(".pace-popover")).toContainText("/spider config set usage.monthlyBudget <credits> --global"); }
    if (scenario === "counter-unavailable") await expect(page.locator(".pace-popover")).toContainText("Counter unavailable");
    if (scenario === "over-pace") { await expect(page.locator(".month-pace")).toHaveAttribute("data-danger", "true"); await expect(page.locator(".pace-popover")).toContainText("40 over at this pace"); }
    for (const cell of await page.locator(".pace-popover tbody td:last-child .cell-value").all()) await expect(cell).toHaveText(/^[\d,]+(\.\d)?$|^unavailable$/);
    await settle(page); await capture(page, info, `pace-${scenario}-${width}`); await contrast(page, info, `pace-${scenario}-${width}`);
    await trigger.press("Escape"); await expect(trigger).toBeFocused(); await expect(page.locator(".pace-popover")).toBeHidden(); await page.mouse.move(0, 0); await trigger.hover(); await expect(page.locator(".pace-popover")).toBeVisible();
  }
});
test("blocked-font fallback keeps every production page usable", async ({ page }, info) => {
  await installFixtureRoutes(page); let blocked = 0;
  await page.route("https://fonts.gstatic.com/**", route => { blocked++; return route.abort("blockedbyclient"); });
  for (const [name, hash] of Object.entries(routes)) {
    await page.goto(`/${hash}`); await expect(page.locator("main")).not.toContainText("Loading"); await settle(page); await layout(page); await contrast(page, info, `offline-${name}`); await capture(page, info, `offline-${name}-1280`);
    expect(await page.locator("main").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
  }
  await page.goto("/#/"); await expect(page.locator(".pace-used")).toBeVisible(); await settle(page);
  const cdp = await page.context().newCDPSession(page); await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const font = async (selector: string) => {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.length).toBeGreaterThan(0); const family = fonts[0]!.familyName.replace(/[- ]?(Regular|Bold|Medium|SemiBold)$/i, ""); expect(family).not.toMatch(/Courier|Times/i); return family;
  };
  const codeBold = await font(".pace-used"), codeRegular = await font(".model-name"); expect(codeBold).toBe(codeRegular);
  // The active nav uses medium; compare with regular sans text, then test bold sans directly.
  const samples = await page.evaluate(() => {
    const host = document.createElement("div"); host.className = "font-samples";
    for (const cls of ["text-regular", "text-bold"]) { const el = document.createElement("span"); el.className = cls; el.textContent = "Alphabet"; host.append(el); }
    const sheet = new CSSStyleSheet(); sheet.replaceSync(".text-regular {font:400 16px var(--usage-text)} .text-bold {font:700 16px var(--usage-text)}"); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; document.body.append(host); return true;
  }); expect(samples).toBe(true);
  const { root: freshRoot } = await cdp.send("DOM.getDocument"); root.nodeId = freshRoot.nodeId;
  const textRegular = await font(".text-regular"), textBold = await font(".text-bold"); expect(textBold).toBe(textRegular); await cdp.detach();
  await info.attach("platform fonts", { body: JSON.stringify({ codeRegular, codeBold, textRegular, textBold, blocked }), contentType: "application/json" });
  await info.attach("blocked font requests", { body: String(blocked), contentType: "text/plain" });
});

test("section boxes reject bordered rounded descendants, not just sections", async ({ page }) => {
  await installFixtureRoutes(page); await page.goto("/#/"); await expect(page.locator(".overview-page")).toBeVisible();
  expect(await layoutFailures(page)).toEqual([]);
});

test("Overview chips and legend follow the mock", async ({ page }) => {
  await installFixtureRoutes(page); await page.goto("/#/"); await expect(page.locator(".daily-chart")).toBeVisible();
  await expect(page.locator(".range-summary .stat-chip").nth(1)).toHaveText("Average1.4 a day");
  await expect(page.locator(".range-summary .stat-chip").nth(2)).toHaveText("PeakFri 12 APR · 4");
  await expect(page.locator(".model-row .model-marker").nth(1)).toHaveAttribute("data-shape", "diamond");
  for (const key of await page.locator(".role-key").all()) {
    const role = await key.getAttribute("data-role");
    const colors = await key.evaluate((el, r) => { const probe = document.createElement("span"); probe.className = `font-probe-${r}`; const sheet = new CSSStyleSheet(); sheet.replaceSync(`.font-probe-${r} {color:var(--usage-role-${r})}`); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; document.body.append(probe); const result = [getComputedStyle(el).borderTopColor, getComputedStyle(probe).color]; probe.remove(); return result; }, role);
    expect(colors[0]).toBe(colors[1]);
  }
});

test("Overview and Session flows span their box without an empty bottom band", async ({ page }) => {
  await installFixtureRoutes(page); await page.goto("/#/"); await expect(page.locator(".flow-svg")).toBeVisible();
  const checkFlow = async () => {
    const svg = page.locator(".flow-svg"), bounds = (await svg.boundingBox())!;
    const content = await svg.evaluate(el => { const box = (el as SVGSVGElement).getBBox(), view = (el as SVGSVGElement).viewBox.baseVal; return { left: box.x, right: box.x + box.width, bottom: box.y + box.height, width: view.width, height: view.height }; });
    expect(content.left).toBeLessThanOrEqual(60); expect(content.width - content.right).toBeLessThanOrEqual(40); expect(content.height - content.bottom).toBeLessThanOrEqual(30);
    const labels = await svg.locator("text:not(.numeric)").all(), stations = await svg.locator("rect").all();
    for (let i = 0; i < labels.length; i++) { const label = (await labels[i]!.boundingBox())!, station = (await stations[i]!.boundingBox())!; const gap = station.x - label.x - label.width; expect(gap).toBeGreaterThanOrEqual(0); expect(gap).toBeLessThanOrEqual(20); }
    const panel = (await svg.locator("xpath=ancestor::section[1]").boundingBox())!; expect(bounds.width / panel.width).toBeGreaterThan(.9);
  }; await checkFlow();
  await page.goto("/#/session/session-garden"); await expect(page.locator(".session-stats")).toBeVisible(); await checkFlow();
});

test("Session header measures pluralise and the mirrored axis uses nice steps", async ({ page }) => {
  await installFixtureRoutes(page); await page.goto("/#/session/session-garden"); await expect(page.locator(".session-stats")).toBeVisible();
  await expect(page.locator(".header-stat").nth(2)).toHaveText("Own calls2credits"); await expect(page.locator(".header-stat").nth(3)).toHaveText("Compaction2credits · 1 event"); await expect(page.locator(".header-stat").nth(4)).toHaveText("Idle gaps9min · 1 gap");
  await expect(page.locator(".session-route-section .stat-chip").last()).toHaveText("Credits per run0 to 3");
  const ticks = await page.locator('.session-route text.numeric[text-anchor="end"]:not([data-time-tick])').allTextContents(); expect(ticks).toEqual(["1", "1", "2", "2", "3", "3", "0"]);
});

test("Calibration coverage window sublines and unconnected observed counter bars", async ({ page }) => {
  await installFixtureRoutes(page); await page.goto("/#/calibration"); await expect(page.locator(".correction-stats")).toBeVisible();
  await expect(page.locator(".correction-stats .data-stat").nth(3)).toHaveText("Hours covered48of 168 hours"); await expect(page.locator(".correction-stats .data-stat").nth(4)).toHaveText("StatusCalibratedTrailing 7 days"); await expect(page.locator(".counter-line")).toHaveCount(0);
});

test("wordmark and web glyph ink centres agree within one pixel", async ({ page }, info) => {
  await installFixtureRoutes(page);
  const fixture = process.env.SPIDER_PLAYWRIGHT_WORDMARK_FONT;
  if (fixture) await page.route("https://fonts.gstatic.com/s/bebasneue/**", async route => route.fulfill({ body: await readFile(fixture), contentType: "font/woff2", headers: { "Access-Control-Allow-Origin": "*" } }));
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto("/#/"); await expect(page.locator(".overview-page")).toBeVisible();
  if (fixture) await expect.poll(() => page.evaluate(() => [...document.fonts].some(f => (["Bebas Neue", "Usage Wordmark Remote"].includes(f.family.replace(/['"]/g, ""))) && f.status === "loaded"))).toBe(true);
  await settle(page); await layout(page);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 88 } });
  const mark = inkRows(png, (await page.locator(".web-mark").boundingBox())!), word = inkRows(png, (await page.locator(".wordmark").boundingBox())!);
  await info.attach("real wordmark ink", { body: png, contentType: "image/png" }); await info.attach("ink rows", { body: JSON.stringify({ mark, word }), contentType: "application/json" });
  console.log("WORDMARK_INK", JSON.stringify({ mark, word })); expect(Math.abs(mark.centre - word.centre)).toBeLessThanOrEqual(1);
});

test("pinned run card follows its own apex and stays away from other branches", async ({ page }) => {
  await installFixtureRoutes(page); await page.goto("/#/session/session-garden"); await expect(page.locator(".session-route")).toBeVisible();
  const run = page.locator('[data-run-id="run-build"]'); await run.focus(); await run.press("Enter"); await expect(page.locator(".route-card")).toBeVisible();
  const card = (await page.locator(".route-card").boundingBox())!, chart = (await page.locator(".route-box").boundingBox())!, branch = (await run.boundingBox())!, other = (await page.locator('[data-run-id="run-review"]').boundingBox())!;
  expect(card.x).toBeGreaterThanOrEqual(chart.x); expect(card.x + card.width).toBeLessThanOrEqual(chart.x + chart.width + 1); expect(card.y).toBeGreaterThanOrEqual(chart.y); expect(card.y + card.height).toBeLessThanOrEqual(chart.y + chart.height + 1);
  expect(Math.abs(card.x - (branch.x + branch.width / 2))).toBeLessThan(350);
  expect(card.x + card.width <= other.x || card.x >= other.x + other.width || card.y + card.height <= other.y || card.y >= other.y + other.height).toBe(true);
});
