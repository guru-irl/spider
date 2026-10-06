import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { createDashboardBrowserPage } from "./fixtures/dashboard-browser-fixture.js";

// Missing response CSP would let the acceptance test pass with scripts/styles
// that the packaged server would reject. No builder computes the expectation.
test("browser fixture serves the packaged mount with matching script and style CSP hashes", async () => {
  const page = await createDashboardBrowserPage();
  const route = page.routes?.["/"];
  expect(route, "packaged page is a synthetic-origin response").toBeDefined();
  expect(route?.body).toBe(page.html);
  const csp = route?.headers?.find(header => header.name === "Content-Security-Policy")?.value;
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("style-src-attr 'none'");
  expect(csp).not.toContain("unsafe-inline");
  for (const tag of ["script", "style"]) {
    const text = page.html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
    expect(text).toBeTruthy();
    expect(csp).toContain(`'sha256-${createHash("sha256").update(text!).digest("base64")}'`);
  }
  expect(page.html.match(/id="usage-app"/g)).toHaveLength(1);
});

test("Overview responses include both calibration bases and all initial API endpoints", async () => {
  const page = await createDashboardBrowserPage();
  expect(Object.keys(page.routes ?? {}).sort()).toEqual(["/", "/api/overview", "/api/status"]);
  const overview = JSON.parse(page.routes!["/api/overview"]!.body as string);
  expect(overview).toMatchObject({ apiVersion: 1, revision: "synthetic-v1", generatedAt: 1767398400000,
    period: { start: 1767225600000, end: 1767398400000 },
    data: { totals: { aicDisplay: { primaryAic: 20, publishedAic: 10, basis: "calibrated" }, tokens: { total: 1700 } },
      daily: { nextCursor: null, rows: [
        { label: "Day 1", measure: { aicDisplay: { primaryAic: 8, publishedAic: 4, basis: "back-applied" }, tokens: { total: 700 } } },
        { label: "Day 2", measure: { aicDisplay: { primaryAic: 12, publishedAic: 6, basis: "calibrated" }, tokens: { total: 1000 } } },
      ] } },
  });
  expect(JSON.parse(page.routes!["/api/status"]!.body as string)).toMatchObject({ apiVersion: 1, data: { parseErrors: 0, sourceErrors: 0 } });
});
