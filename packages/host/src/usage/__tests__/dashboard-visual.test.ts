import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pixels } from "./fixtures/png-pixels.js";
import * as implementation from "../../../../../scripts/usage-dashboard-screenshot.mjs";
import { expect, test } from "vitest";
import { PlainDocument } from "./fixtures/plain-dom.js";
import { renderTable, tableRegion } from "../web/tables.js";
import { createDashboardBrowserPage } from "./fixtures/dashboard-browser-fixture.js";
import { acceptanceStates, allViewPage } from "./fixtures/all-view-browser-fixture.js";

const checkout = fileURLToPath(new URL("../../../../../", import.meta.url));
function visualRun(): { scratch: string; temp: string; clean(): void } {
  const scratch = join(process.env.SPIDER_USAGE_SCREENSHOT_SCRATCH || join(checkout, ".spider/scratch"), "usage-dashboard-visual"); mkdirSync(scratch, { recursive: true });
  const temp = mkdtempSync(join(scratch, "run-"));
  return { scratch: temp, temp, clean() { rmSync(temp, { recursive: true, force: true }); try { rmdirSync(scratch); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } } };
}

test("real browser all-view acceptance has no overflow", async context => {
  const reason = implementation.screenshotSkipReason(); if (reason) { context.skip(reason); return; }
  const base = await createDashboardBrowserPage(true), run = visualRun();
  const out = process.env.SPIDER_USAGE_ACCEPTANCE_OUT || join(checkout, ".spider/scratch/usage-dashboard-screenshots/t13f");
  const parity = new Map<string, unknown>();
  const ready = `new Promise(resolve => { const deadline = performance.now() + 5000; const check = () => {
    if (document.querySelector('h1') && __usageCompleted === __usageFetches && !document.querySelector('main').textContent.includes('Loading')) requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    else if (performance.now() > deadline) resolve(false); else requestAnimationFrame(check); }; check(); })`;
  try {
    for (const state of acceptanceStates) for (const width of [390, 1272]) {
      const fixture = allViewPage(base, state); let pid = 0;
      await implementation.captureDashboard({ html: fixture.html, routes: fixture.routes, out: join(out, state, String(width)), scratchDir: run.temp,
        viewport: { width, height: width === 390 ? 844 : 900 }, verifyTimeoutMs: 120000, verify: async page => {
          pid = page.pid;
          for (const view of ["overview", "explorer", "session", "run", "context", "cache", "reconciliation", "rates"]) {
            const id = view === "session" ? "&id=session-fixture" : view === "run" ? "&id=run-fixture" : "";
            await page.evaluate(`location.hash = ${JSON.stringify(`#view=${view}&mode=chart${id}`)}`);
            expect(await page.evaluate(ready), `${state}/${width}/${view} ready`).toBe(true);
            expect(await page.evaluate("document.querySelector('h1').textContent.toLowerCase().startsWith(" + JSON.stringify(view) + ")")).toBe(true);
            expect(await page.evaluate("document.querySelector('main').textContent.includes('This view is not included')")).toBe(false);
            expect(await page.evaluate("Array.from(document.querySelectorAll('button')).some(n => n.textContent === 'Retry' && !n.hidden)")).toBe(false);
            expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), `${state}/${width}/${view} page overflow`).toBe(true);
            if (width === 1272 && state === "calibrated" && ["explorer", "reconciliation"].includes(view)) {
              const measurements = await page.evaluate(`(() => {
              const table = caption => Array.from(document.querySelectorAll('table')).find(t => t.caption.textContent === caption);
              if (${JSON.stringify(view)} === 'reconciliation') return ['Published comparison','Calibrated comparison'].map(c => [c, Array.from(table(c).querySelectorAll('tbody tr'),r => r.getBoundingClientRect().height)]);
              const filters=document.querySelector('[aria-label="Filter values"]'), controls=filters.querySelector('input').closest('.view-actions'), pivot=document.querySelector('[aria-label="Pivot"] h2');
              return {gap:pivot.getBoundingClientRect().top-controls.getBoundingClientRect().bottom};
            })()`) as { gap: number } | [string, number[]][];
              if (view === "explorer") expect((measurements as {gap:number}).gap).toBeLessThan(40);
              else for (const [, heights] of measurements as [string, number[]][]) for (const height of heights) expect(height).toBeLessThan(150);
              if (process.env.SPIDER_USAGE_LAYOUT_OUT) appendFileSync(process.env.SPIDER_USAGE_LAYOUT_OUT, JSON.stringify({view, measurements}) + "\n");
            }
            // Save both the true viewport and the whole view for manual inspection.
            await page.evaluate("scrollTo(0,0)");
            await page.screenshot(`${view}-viewport.png`);
            await page.screenshot(`${view}-full.png`, true);
            const dataCells = "Array.from(document.querySelectorAll('main > div table tbody .cell-value'), n => n.textContent)";
            if (view === "rates") {
              const history = await page.evaluate("Array.from(document.querySelectorAll('table')).find(t=>t.caption.textContent==='Daily calibration evidence')?.querySelectorAll('tbody tr').length ?? 0");
              expect(history).toBe(state === "off" ? 0 : 2);
              if (state === "off") expect(await page.evaluate("document.querySelector('main > div').textContent.includes('Factor history disabled')")).toBe(true);
              else expect(await page.evaluate("Array.from(document.querySelectorAll('table')).find(t=>t.caption.textContent==='Daily calibration evidence').querySelector('tbody tr').textContent.includes(" + JSON.stringify(state === "unavailable" ? "uncalibrated" : "calibrated") + ")")).toBe(true);
              expect(await page.evaluate(dataCells)).toContain("synthetic-v3");
            }
            if (view === "reconciliation") {
              const comparisons = await page.evaluate(`['Published comparison','Calibrated comparison'].map(c => Array.from(document.querySelectorAll('table')).find(t=>t.caption.textContent===c).querySelector('tbody tr')).map(r=>Array.from(r.querySelectorAll('.cell-value'),c=>c.textContent))`) as string[][];
              expect(comparisons[0]![3]).toBe("20 AIC counter"); expect(comparisons[0]![4]).toBe("~4 AIC published estimate");
              expect(comparisons[1]![2]).toBe(state === "off" || state === "unavailable" ? "unavailable" : state === "back-applied" ? "~8 AIC calibrated, back-applied" : "~8 AIC calibrated");
            }
            if (!["context", "reconciliation"].includes(view)) {
              const cells = await page.evaluate(dataCells) as string[];
              expect(cells).toContain(state === "off" ? "~10 AIC est" : state === "unavailable" ? "~10 AIC ?" : state === "back-applied" ? "20 AIC calibrated, back-applied" : "20 AIC cal");
            }
            if (state === "off" || state === "unavailable") expect(await page.evaluate(dataCells)).not.toEqual(expect.arrayContaining([expect.stringMatching(/\d[\d,+]* AIC cal(?:\b|ibrated)/)]));
            // Full evidence must be identical, including the alternative chart tables.
            await page.evaluate("Array.from(document.querySelectorAll('[aria-label=\"Chart representation\"] button')).filter(b => b.textContent === 'Table').forEach(b => b.click())");
            expect(await page.evaluate(`Array.from(document.querySelectorAll('.cell-value,.calibration-evidence,.muted')).filter(n => n.getClientRects().length && /\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z/.test(n.textContent)).map(n => n.textContent)`), `${state}/${width}/${view} raw ISO evidence`).toEqual([]);
            if (view !== "context") expect(await page.evaluate("document.querySelector('main table .token-list dt, main table .token-summary') !== null")).toBe(true);
            const evidence = await page.evaluate("Array.from(document.querySelectorAll('main table'), t => [t.caption.textContent, Array.from(t.querySelectorAll('tbody tr'), r => Array.from(r.cells, c => c.querySelector('.cell-value')?.textContent ?? c.textContent))])");
            const key = `${state}/${view}`;
            if (width === 390) parity.set(key, evidence); else expect(evidence, `${key} desktop/narrow parity`).toEqual(parity.get(key));
            expect(await page.evaluate(`Array.from(document.querySelectorAll('.cell-value, .action, .chart-summary')).filter(n => n.getClientRects().length).map(n => ({ text:n.textContent, fits:n.scrollWidth <= n.clientWidth + 1 })).filter(n => !n.fits)`), `${key}/${width} clipped text`).toEqual([]);
            // Real Tab, not element.focus(): every enabled control and scroll region in DOM order.
            const controls = await page.evaluate(`(() => {
              window.__tabStops = Array.from(document.querySelectorAll('button,input,select,a[href],[tabindex]')).filter(n => n.tabIndex >= 0 && !n.disabled && n.getClientRects().length);
              window.__tabStops.forEach((n,i) => n.dataset.acceptanceTab = String(i));
              document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex');
              return __tabStops.length;
            })()`) as number;
            expect(controls).toBeGreaterThan(8);
            for (let i = 0; i < controls; i++) {
              const before = await page.evaluate(`(() => { const n=__tabStops[${i}], s=getComputedStyle(n); return [s.backgroundColor,s.color,s.textDecorationLine,s.outlineStyle,s.outlineWidth]; })()`);
              await page.pressKey("Tab");
              expect(await page.evaluate("document.activeElement.dataset.acceptanceTab"), `${key}/${width} Tab ${i}`).toBe(String(i));
              const focus = await page.evaluate("(() => { const n=document.activeElement,r=n.getBoundingClientRect(),s=getComputedStyle(n);return {tag:n.tagName,text:n.getAttribute('aria-label')??n.textContent.slice(0,80),top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right,background:s.backgroundColor,decoration:s.textDecorationLine};})()");
              expect(await page.evaluate(`(() => { const n=document.activeElement, r=n.getBoundingClientRect(), s=getComputedStyle(n); const focused=[s.backgroundColor,s.color,s.textDecorationLine,s.outlineStyle,s.outlineWidth];
                const region=n.classList.contains('table-region') && getComputedStyle(n.querySelector('caption')).backgroundColor !== 'rgba(0, 0, 0, 0)';
                const indicator=region?n.querySelector('caption').getBoundingClientRect():r;
                return n.matches(':focus-visible') && (region || JSON.stringify(focused)!==${JSON.stringify(JSON.stringify(before))}) && indicator.top>=-1 && indicator.bottom<=innerHeight+1 && r.left>=-1 && r.right<=innerWidth+1; })()`), `${key}/${width} visible focus ${i}: ${JSON.stringify(focus)}`).toBe(true);
            }
          }
        } });
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally { run.clean(); }
}, implementation.BROWSER_TEST_TIMEOUT_MS * 8);

// A placeholder, broken CSP/API wiring, missing calibration bucket or blank
// capture must fail this acceptance gate. Observations come from rendered DOM.
test("packaged Overview renders chart and table at 390px and 1272px with non-blank dark screenshots", async context => {
  const reason = implementation.screenshotSkipReason();
  if (reason) { console.log(`SKIP: ${reason}`); context.skip(`SKIP: ${reason}`); return; }
  const fixture = await createDashboardBrowserPage();
  const run = visualRun(), { temp } = run; const out = process.env.SPIDER_USAGE_SCREENSHOT_OUT || join(temp, "screenshots");
  const observations = [["Day 2", 12, 1000], ["Day 1", 8, 700]];
  try {
    for (const width of [390, 1272]) {
      const height = width === 390 ? 3600 : 2400;
      let pid = 0;
      let heading: { x: number; y: number; width: number; height: number };
      const png = await implementation.captureDashboard({ html: fixture.html, routes: fixture.routes, out: join(out, String(width)), scratchDir: temp,
        viewport: { width, height }, installSignalHandlers: process.env.SPIDER_USAGE_SCREENSHOT_SIGNALS === "1", verify: async page => {
          pid = page.pid;
          expect(await page.evaluate(fixture.ready)).toBe(true);
          expect(await page.evaluate("document.querySelectorAll('#usage-app').length")).toBe(1);
          expect(await page.evaluate("document.querySelector('#usage-app')?.querySelector('h1')?.textContent")).toBe("Overview");
          expect(await page.evaluate("document.querySelectorAll('main').length")).toBe(1);
          expect(await page.evaluate(`Array.from(document.querySelectorAll('.data-table')).every(t => {
            const heads = Array.from(t.querySelectorAll('[role=columnheader]'));
            const thead = t.querySelector('thead');
            return t.getAttribute('role') === 'table' && getComputedStyle(thead).display !== 'none' && getComputedStyle(thead).visibility !== 'hidden' &&
              Array.from(t.querySelectorAll('tbody tr')).every(row => Array.from(row.cells).every((cell, i) => cell.hasAttribute('colspan') || (cell.getAttribute('role') === 'cell' && cell.getAttribute('headers') === heads[i]?.id && document.getElementById(cell.getAttribute('headers')) === heads[i])));
          })`)).toBe(true);
          expect(await page.evaluate("document.querySelector('.period-label').textContent")).toBe("1 Jan 2026 to 3 Jan 2026, 00:00 UTC");
          expect(await page.evaluate("Array.from(document.querySelectorAll('.period-label time'), node => node.dateTime)")).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]);
          expect(await page.evaluate("Array.from(document.querySelectorAll('.data-table td')).every(cell => !getComputedStyle(cell).fontFamily.includes('Usage Code'))")).toBe(true);
          expect(await page.evaluate("Array.from(document.querySelectorAll('.numeric')).every(node => getComputedStyle(node).fontFamily.includes('Usage Code'))")).toBe(true);
          expect(await page.evaluate("document.querySelector('.data-table .token-list').querySelectorAll('dt').length")).toBe(8);
          if (width === 390) {
            expect(await page.evaluate("(() => { const table = document.querySelector('.data-table'); return Array.from(table.querySelectorAll('td')).every(cell => cell.getBoundingClientRect().width >= table.getBoundingClientRect().width - 1); })()")).toBe(true);
            expect(await page.evaluate("Array.from(document.querySelectorAll('.data-table')).filter(t => !t.closest('[hidden]')).every(t => Array.from(t.querySelectorAll('tbody td')).every(cell => cell.getBoundingClientRect().width >= t.getBoundingClientRect().width - 1))")).toBe(true);
            expect(await page.evaluate("Array.from(document.querySelectorAll('.data-table .cell-label')).filter(label => !label.closest('[hidden]')).every(label => label.getAttribute('aria-hidden') === 'true' && getComputedStyle(label).display !== 'none')")).toBe(true);
            expect(await page.evaluate("Array.from(document.querySelectorAll('.table-region')).filter(region => !region.closest('[hidden]')).every(region => region.scrollWidth <= region.clientWidth)")).toBe(true);
          }
          expect(await page.evaluate("Array.from(document.querySelectorAll('[role=group][aria-label=\"Chart representation\"]'), group => Array.from(group.querySelectorAll('button'), button => button.textContent))")).toEqual([["Chart", "Table"], ["Chart", "Table"]]);
          expect(await page.evaluate("Array.from(document.querySelectorAll('.chart-summary'), node => node.textContent)")).toEqual([
            "Day 2 · 12 AIC calibrated minimum · 12 AIC calibrated maximum",
            "Day 1 · 8 AIC calibrated, back-applied minimum · 8 AIC calibrated, back-applied maximum",
          ]);
          expect(await page.evaluate("Array.from(document.querySelectorAll('.notice'), node => node.textContent)")).toEqual([
            "Updated 3 Jan 2026, 00:00 UTC", "Health updated", "No source diagnostics recorded.",
          ]);
          expect(await page.evaluate("Array.from(document.querySelectorAll('button')).filter(button => !button.hidden && button.textContent === 'Retry').length")).toBe(0);
          // Stale test data attributes cannot substitute for real tooltip text.
          await page.evaluate("document.querySelectorAll('svg g').forEach(point => { point.dataset.label = 'stale'; point.dataset.aic = '999'; point.dataset.tokens = '999'; })");
          expect(await page.evaluate(fixture.readChart)).toEqual(observations);
          expect(await page.evaluate(fixture.toggleTable)).toBe(true);
          expect(await page.evaluate(fixture.readTable)).toEqual(observations);
          expect(await page.evaluate(fixture.toggleChart)).toBe(true);
          expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
          expect(await page.evaluate("innerWidth")).toBe(width);
          // No font-readiness wait: the optional Google stylesheet is blocked,
          // while real content renders using the existing system fallback stack.
          expect(await page.evaluate("getComputedStyle(document.body).fontFamily.includes('system-ui')")).toBe(true);
          expect(page.blockedRequests).toBeGreaterThan(0);
          await page.evaluate("new Promise(resolve => { window.scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(resolve)); })");
          const chartBottoms = await page.evaluate("Array.from(document.querySelectorAll('.chart-summary'), node => node.getBoundingClientRect().bottom)") as number[];
          expect(chartBottoms.every(bottom => bottom <= height), `chart bottoms ${chartBottoms.join(", ")} within ${height}px viewport`).toBe(true);
          heading = await page.evaluate("(() => { const r = document.querySelector('h1').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()") as typeof heading;
        } });
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(png)).toBe(true);
      const image = pixels(readFileSync(png));
      expect(image.width).toBe(width); expect(image.height).toBe(height);
      expect(image.rgb(width - 1, height - 1)).toEqual([40, 42, 54]); // #282a36
      let lightText = false;
      for (let y = Math.ceil(heading!.y); y < Math.floor(heading!.y + heading!.height); y++) {
        for (let x = Math.ceil(heading!.x); x < Math.floor(heading!.x + heading!.width); x++) {
          const [r, g, b] = image.rgb(x, y);
          if (r! > 220 && g! > 220 && b! > 220) lightText = true;
        }
      }
      expect(lightText, "Overview heading has light rendered text pixels").toBe(true);
    }
  } finally { run.clean(); }
}, implementation.BROWSER_TEST_TIMEOUT_MS * 2);

// These tests use the committed capture tool and its private-profile teardown.
test("Edge retains focus, scroll and Chart/Table through hide/show and five-minute idle/key wake", async context => {
  const reason = implementation.screenshotSkipReason(); if (reason) { context.skip(reason); return; }
  const fixture = await createDashboardBrowserPage(true);
  const run = visualRun(), { scratch, temp } = run;
  try {
    for (const width of [390, 1024]) {
      await implementation.captureDashboard({ html: fixture.html, routes: fixture.routes, out: join(scratch, String(width)), scratchDir: temp, viewport: { width, height: 900 }, verify: async page => {
        expect(await page.evaluate(fixture.ready)).toBe(true);
        await page.evaluate("Array.from(document.querySelectorAll('.overview > .view-actions')[1].querySelectorAll('button')).find(b => b.textContent === 'Next page').click()");
        expect(await page.evaluate(`new Promise(resolve => { const deadline = performance.now() + 3000; const check = () => { if (__usageCompleted === 3) requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); else if (performance.now() > deadline) resolve(false); else requestAnimationFrame(check); }; check(); })`)).toBe(true);
        const before = await page.evaluate(`new Promise(resolve => {
          window.nodes = Array.from(document.querySelectorAll('main, .overview, .table-region, .data-table, .chart-panel')); window.pages = Array.from(document.querySelectorAll('.overview > .view-actions')[1].querySelectorAll('button')); window.kept = document.querySelector('.chart-panel'); window.toggle = Array.from(kept.querySelectorAll('button')).find(b => b.textContent === 'Table'); toggle.click(); toggle.focus();
          window.scrollTo(0, toggle.getBoundingClientRect().top + scrollY - 200);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve([scrollY, __usageFetches])));
        })`) as number[];
        const state = `nodes.every((node, i) => node === document.querySelectorAll('main, .overview, .table-region, .data-table, .chart-panel')[i]) && pages.every(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true') && document.activeElement === toggle && document.querySelector('.chart-panel') === kept && toggle.getAttribute('aria-pressed') === 'true' && !kept.querySelector('.table-region').hidden && scrollY === ${before[0]}`;
        expect(await page.evaluate(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); __usageClock.advance(120000); ${state}`)).toBe(true);
        expect(await page.evaluate("__usageFetches")).toBe(before[1]);
        expect(await page.evaluate(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); __usageClock.advance(300); ${state}`)).toBe(true);
        expect(await page.evaluate("__usageFetches")).toBe(before[1]);
        // Five minutes hidden aborts owned work but keeps all DOM state.
        expect(await page.evaluate(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); __usageClock.advance(300000); ${state}`)).toBe(true);
        await page.evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); __usageClock.advance(300)");
        await page.evaluate(`new Promise(resolve => { const deadline = performance.now() + 3000; const check = () => { if (__usageCompleted === ${before[1]! + 2}) requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); else if (performance.now() > deadline) resolve(false); else requestAnimationFrame(check); }; check(); })`).then(result => expect(result).toBe(true));
        expect(await page.evaluate(state)).toBe(true); expect(await page.evaluate("__usageFetches")).toBe(before[1]! + 2);
        expect(await page.evaluate(`__usageClock.advance(300000); ${state}`)).toBe(true);
        await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); __usageClock.advance(299)");
        expect(await page.evaluate("__usageFetches")).toBe(before[1]! + 2);
        await page.evaluate("__usageClock.advance(1)");
        expect(await page.evaluate(`new Promise(resolve => { const deadline = performance.now() + 3000; const check = () => { if (__usageCompleted === ${before[1]! + 4}) requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); else if (performance.now() > deadline) resolve(false); else requestAnimationFrame(check); }; check(); })`)).toBe(true);
        expect(await page.evaluate(state)).toBe(true); expect(await page.evaluate("__usageFetches")).toBe(before[1]! + 4);
      } });
    }
  } finally { run.clean(); }
}, implementation.BROWSER_TEST_TIMEOUT_MS * 2);

test("Edge ten-column Rates-tier fixture scrolls at 390px, 1024px and 1272px without squeezed or clipped text", async context => {
  const reason = implementation.screenshotSkipReason(); if (reason) { context.skip(reason); return; }
  const fixture = await createDashboardBrowserPage();
  const doc = new PlainDocument();
  const heads = ["Model", "Aliases", "Version", "Valid until (exclusive)", "Tier", "Above prompt tokens", "Input USD / million", "Cache read USD / million", "Cache write USD / million", "Output USD / million"];
  const region = tableRegion(doc.asDocument(), renderTable(doc.asDocument(), { caption: "Loaded rate tiers", columns: heads, rows: [["sample-model", "alias", "v1", "1 Jan 2026, 00:00 UTC", "1", "123,456", "123.45", "123.45", "123.45", "123.45"]] }));
  const serialize = (node: import("./fixtures/plain-dom.js").PlainElement): string => `<${node.tagName.toLowerCase()} ${[...node.attributes].map(([k, v]) => `${k}="${v}"`).join(" ")}>${node.children.length ? node.children.map(serialize).join("") : node.textContent}</${node.tagName.toLowerCase()}>`;
  const markup = serialize(region as unknown as import("./fixtures/plain-dom.js").PlainElement).replaceAll("usage-table-", "density-usage-table-");
  const sibling = tableRegion(doc.asDocument(), renderTable(doc.asDocument(), { caption: "Sibling view", columns: ["First", "Second", "Third", "Fourth", "Fifth"], rows: [["one", "two", "three", "four", "five"]] }));
  const siblingMarkup = serialize(sibling as unknown as import("./fixtures/plain-dom.js").PlainElement).replaceAll("usage-table-", "density-usage-table-");
  const run = visualRun(), { scratch, temp } = run;
  try {
    for (const width of [1024, 1272, 390]) {
      await implementation.captureDashboard({ html: fixture.html, routes: fixture.routes, out: join(scratch, String(width)), scratchDir: temp, viewport: { width, height: 1200 }, verify: async page => {
        expect(await page.evaluate(fixture.ready)).toBe(true);
        await page.evaluate(`document.querySelector('.overview').insertAdjacentHTML('beforeend', '<div class="overview-evidence density-fixture">' + ${JSON.stringify(markup)} + '</div>'); document.querySelector('.density-fixture').prepend(document.querySelector('.health-panel')); document.querySelector('.wide-table-region').scrollIntoView()`);
        expect(await page.evaluate(`(() => { const region = document.querySelector('.wide-table-region'), t = region.querySelector('table'), row = t.querySelector('tbody tr');
          return getComputedStyle(row).display === 'table-row' && region.scrollWidth > region.clientWidth &&
            Array.from(t.querySelectorAll('th, td')).every(cell => cell.getBoundingClientRect().width - parseFloat(getComputedStyle(cell).paddingLeft) - parseFloat(getComputedStyle(cell).paddingRight) >= 72 && cell.scrollWidth <= cell.clientWidth) &&
            getComputedStyle(region.querySelector('.scroll-cue')).display !== 'none' && region.querySelector('.scroll-cue').getBoundingClientRect().width <= region.clientWidth &&
            document.documentElement.scrollWidth <= innerWidth;
        })()`)).toBe(true);
        expect(await page.evaluate(`(() => { const region = document.querySelector('.wide-table-region'), caption = region.querySelector('caption'), cue = region.querySelector('.scroll-cue');
          return region.getAttribute('tabindex') === '0' && region.getAttribute('role') === 'region' && document.getElementById(region.getAttribute('aria-labelledby')) === caption && caption.textContent === 'Loaded rate tiers' &&
            document.getElementById(region.getAttribute('aria-describedby')) === cue && cue.textContent.trim().length > 0 &&
            new Set(Array.from(document.querySelectorAll('[id]'), node => node.id)).size === document.querySelectorAll('[id]').length &&
            region.getBoundingClientRect().top - document.querySelector('.health-panel').getBoundingClientRect().bottom >= 12;
        })()`)).toBe(true);
        await page.evaluate("document.querySelector('.wide-table-region').scrollLeft = document.querySelector('.wide-table-region').scrollWidth");
        expect(await page.evaluate("Math.abs(document.querySelector('.scroll-cue').getBoundingClientRect().left - document.querySelector('.wide-table-region').getBoundingClientRect().left) < 1")).toBe(true);
        if (width !== 390) expect(await page.evaluate("Array.from(document.querySelectorAll('.data-table .cell-label')).every(label => getComputedStyle(label).display === 'none')")).toBe(true);
        // A five-column consumer outside Overview must have equal column widths.
        await page.evaluate(`document.querySelector('.usage-main').insertAdjacentHTML('beforeend', '<div class="overview-evidence sibling-fixture">' + ${JSON.stringify(siblingMarkup)} + '</div>'); document.querySelector('.sibling-fixture').prepend(document.querySelector('.overview'))`);
        expect(await page.evaluate(`(() => { const cells = Array.from(document.querySelectorAll('.sibling-fixture > .table-region tbody td')); return cells.length === 5 && cells.every(cell => Math.abs(cell.getBoundingClientRect().width - cells[0].getBoundingClientRect().width) < 1); })()`)).toBe(true);
        // The token-column allocation is scoped, not a fourth-column global rule.
        expect(await page.evaluate(`(() => { const cells = document.querySelector('.wide-table tbody tr').cells; return cells[3].getBoundingClientRect().width / document.querySelector('.wide-table').getBoundingClientRect().width < .2; })()`)).toBe(true);
      } });
    }
  } finally { run.clean(); }
}, implementation.BROWSER_TEST_TIMEOUT_MS * 3);


test("Edge Explorer retains independent per-basis chart choices after Refresh and rail navigation", async context => {
  const reason = implementation.screenshotSkipReason(); if (reason) { context.skip(reason); return; }
  const fixture = allViewPage(await createDashboardBrowserPage(true), "calibrated"), run = visualRun();
  const route = fixture.routes["/api/explorer"]!;
  const data = JSON.parse(route.body as string);
  data.data.rows.push({ ...data.data.rows[0], key: ["v1_other"], labels: ["Other model"], measure: { ...data.data.totals, aicDisplay: { ...data.data.totals.aicDisplay, basis: "back-applied" } } });
  route.body = JSON.stringify(data);
  const ready = `new Promise(resolve => { const until=performance.now()+5000; const check=()=>{ if (__usageCompleted===__usageFetches && document.querySelectorAll('.usage-explorer .chart-panel').length===2) requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))); else if(performance.now()>until) resolve(false); else requestAnimationFrame(check); }; check(); })`;
  const modes = "Array.from(document.querySelectorAll('.usage-explorer .chart-panel'),p=>p.querySelectorAll('[aria-label=\"Chart representation\"] button')[1].getAttribute('aria-pressed'))";
  try { await implementation.captureDashboard({ html: fixture.html, routes: fixture.routes, out: join(run.temp, "retention"), scratchDir: run.temp, viewport: { width: 1272, height: 900 }, verify: async page => {
    await page.evaluate("location.hash='#view=explorer'"); expect(await page.evaluate(ready)).toBe(true);
    await page.evaluate("document.querySelector('.usage-explorer .chart-panel [aria-label=\"Chart representation\"] button:last-child').click()");
    expect(await page.evaluate(modes)).toEqual(["true", "false"]);
    await page.evaluate("Array.from(document.querySelectorAll('.usage-explorer button')).find(b=>b.textContent==='Refresh').click()"); expect(await page.evaluate(ready)).toBe(true); expect(await page.evaluate(modes)).toEqual(["true", "false"]);
    await page.evaluate("Array.from(document.querySelectorAll('.usage-rail button')).find(b=>b.textContent==='Cache').click()");
    expect(await page.evaluate(`new Promise(resolve=>{const until=performance.now()+5000;const check=()=>{if(document.querySelector('h1')?.textContent==='Cache' && __usageCompleted===__usageFetches) requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)));else if(performance.now()>until)resolve(false);else requestAnimationFrame(check);};check();})`)).toBe(true);
    await page.evaluate("Array.from(document.querySelectorAll('.usage-rail button')).find(b=>b.textContent==='Explorer').click()"); expect(await page.evaluate(ready)).toBe(true); expect(await page.evaluate(modes)).toEqual(["true", "false"]);
    await page.evaluate("document.querySelector('.usage-explorer input').value='Syn'; document.querySelector('.usage-explorer input').dispatchEvent(new Event('input',{bubbles:true})); __usageClock.advance(300)");
    expect(await page.evaluate(`new Promise(resolve=>{const until=performance.now()+5000;const check=()=>{if(__usageCompleted===__usageFetches && document.querySelector('[aria-label="Filter values"]').textContent.includes('Choose a value'))resolve(true);else if(performance.now()>until)resolve(false);else requestAnimationFrame(check);};check();})`)).toBe(true);
    expect(await page.evaluate("document.querySelector('[aria-label=\"Filter values pages\"]').hidden")).toBe(true);
    expect(await page.evaluate("Array.from(document.querySelectorAll('[aria-label=\"Filter values\"] .notice'),p=>p.hidden||p.textContent.length>0).every(Boolean)")).toBe(true);
  } }); } finally { run.clean(); }
}, implementation.BROWSER_TEST_TIMEOUT_MS);

test("Edge Detail Recorded calls stay compact at 1272px",async context=>{
 const reason=implementation.screenshotSkipReason();if(reason){context.skip(reason);return;}
 const run=visualRun(),fixture=allViewPage(await createDashboardBrowserPage(true),"calibrated");
 const measurements: {view:string;heights:number[]}[]=[];
 try {await implementation.captureDashboard({html:fixture.html,routes:fixture.routes,out:join(run.temp,"detail"),scratchDir:run.temp,viewport:{width:1272,height:900},verify:async page=>{
 for(const view of ["session","run"]) {
 await page.evaluate(`location.hash=${JSON.stringify("#view=")}+${JSON.stringify(view)}+"&id="+${JSON.stringify(view)}+"-fixture"`);
 expect(await page.evaluate(`new Promise(resolve=>{const end=performance.now()+5000;const check=()=>{if(document.querySelector('.detail-calls table')&&__usageCompleted===__usageFetches)requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)));else if(performance.now()>end)resolve(false);else requestAnimationFrame(check);};check();})`)).toBe(true);
 const heights=await page.evaluate("Array.from(document.querySelector('.detail-calls table').querySelectorAll('tbody tr'),r=>r.getBoundingClientRect().height)") as number[];
 measurements.push({view,heights});
 }
 }});
 if(process.env.SPIDER_USAGE_LAYOUT_OUT)appendFileSync(process.env.SPIDER_USAGE_LAYOUT_OUT,JSON.stringify({detail:measurements})+"\n");
 for(const {heights} of measurements){expect(heights.length).toBeGreaterThan(0);for(const height of heights)expect(height).toBeLessThan(150);}
 }finally{run.clean();}
}, implementation.BROWSER_TEST_TIMEOUT_MS * 2);
