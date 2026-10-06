import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import * as implementation from "../../../../../scripts/usage-dashboard-screenshot.mjs";
import { expect, test } from "vitest";
import { createDashboardBrowserPage } from "./fixtures/dashboard-browser-fixture.js";

const checkout = fileURLToPath(new URL("../../../../../", import.meta.url));

// Decode Chromium's lossless 8-bit RGB/RGBA PNG without adding a dependency.
function pixels(bytes: Buffer): { width: number; height: number; rgb(x: number, y: number): number[] } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  expect(bytes[24]).toBe(8); expect([2, 6]).toContain(bytes[25]); expect(bytes[28]).toBe(0);
  const channels = bytes[25] === 6 ? 4 : 3, stride = width * channels;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), decoded = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= channels ? decoded[index - channels]! : 0;
      const up = y ? decoded[index - stride]! : 0;
      const upperLeft = y && x >= channels ? decoded[index - stride - channels]! : 0;
      const p = left + up - upperLeft;
      const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upperLeft);
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2)
        : filter === 4 ? pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft : 0;
      decoded[index] = (raw[y * (stride + 1) + x + 1]! + predictor) & 255;
    }
  }
  return { width, height, rgb(x, y) { const start = y * stride + x * channels; return [...decoded.subarray(start, start + 3)]; } };
}

// A placeholder, broken CSP/API wiring, missing calibration bucket or blank
// capture must fail this acceptance gate. Observations come from rendered DOM.
test("packaged Overview renders chart and table at 390px and 1272px with non-blank dark screenshots", async context => {
  const reason = implementation.screenshotSkipReason();
  if (reason) { console.log(`SKIP: ${reason}`); context.skip(`SKIP: ${reason}`); return; }
  const fixture = await createDashboardBrowserPage();
  const scratch = process.env.SPIDER_USAGE_SCREENSHOT_SCRATCH || join(checkout, ".spider/scratch/usage-dashboard-tests");
  mkdirSync(scratch, { recursive: true });
  const temp = mkdtempSync(join(scratch, "visual-"));
  const out = process.env.SPIDER_USAGE_SCREENSHOT_OUT || join(checkout, ".spider/scratch/usage-dashboard-screenshots");
  const observations = [["Day 2", 12, 1000], ["Day 1", 8, 700]];
  try {
    for (const width of [390, 1272]) {
      const height = width === 390 ? 3600 : 2000;
      let pid = 0;
      let heading: { x: number; y: number; width: number; height: number };
      const png = await implementation.captureDashboard({ html: fixture.html, routes: fixture.routes, out: join(out, String(width)), scratchDir: temp,
        viewport: { width, height }, installSignalHandlers: process.env.SPIDER_USAGE_SCREENSHOT_SIGNALS === "1", verify: async page => {
          pid = page.pid;
          expect(await page.evaluate(fixture.ready)).toBe(true);
          expect(await page.evaluate("document.querySelectorAll('#usage-app').length")).toBe(1);
          expect(await page.evaluate("document.querySelector('#usage-app')?.querySelector('h1')?.textContent")).toBe("Overview");
          expect(await page.evaluate("document.querySelectorAll('main').length")).toBe(1);
          expect(await page.evaluate("Array.from(document.querySelectorAll('[role=group][aria-label=\"Chart representation\"]'), group => Array.from(group.querySelectorAll('button'), button => button.textContent))")).toEqual([["Chart", "Table"], ["Chart", "Table"]]);
          expect(await page.evaluate("Array.from(document.querySelectorAll('.chart-summary'), node => node.textContent)")).toEqual([
            "Day 2 to Day 2 · 12 AIC calibrated minimum · 12 AIC calibrated maximum",
            "Day 1 to Day 1 · 8 AIC calibrated, back-applied minimum · 8 AIC calibrated, back-applied maximum",
          ]);
          expect(await page.evaluate("Array.from(document.querySelectorAll('.notice'), node => node.textContent)")).toEqual([
            "Updated 2026-01-03T00:00:00.000Z UTC", "Health updated", "No source diagnostics recorded.",
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
          expect(await page.evaluate("Array.from(document.querySelectorAll('.chart-summary')).every(node => node.getBoundingClientRect().bottom <= innerHeight)")).toBe(true);
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
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, implementation.BROWSER_TEST_TIMEOUT_MS * 2);
