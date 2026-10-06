import { expect, it } from "vitest";
import type { ApiEnvelope, UsageMeasure } from "../dashboard-contract.js";
import type { RatesData } from "../query-rates.js";
import { createDashboardClient } from "../web/client.js";
import { PlainDocument, elements, button, settle } from "./fixtures/plain-dom.js";
const period = { start: 0, end: 172800000 };
const fit = { status: "calibrated" as const, factor: 0.5, windowStart: 0, windowEnd: 86400000, coveredHours: 24, computedAic: 1000, counterDelta: 500, unpricedCalls: 0, method: "trailing-7d-ratio" as const };
function measure(): UsageMeasure { return { calls: 3, pricedCalls: 2, unpricedCalls: 1, aggregateCalls: 0,
  tokens: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, prompt: 60, total: 100, cacheWrite1h: null, reasoning: null },
  aic: 100, aicDisplay: { primaryAic: 50, publishedAic: 100, basis: "calibrated" }, aicComponents: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 }, piCost: null,
  possibleOverlap: true, possibleUndercount: false, pendingData: false, estimated: true }; }
function data(): RatesData { return { calibration: { ...fit, factor: 0.8 }, periodCalibration: fit, totals: measure(), versions: [{ id: "rates-changing", effectiveFrom: "2030-02-03T00:00:00Z", source: "https://example.invalid/<script>evil()</script>", sourceAsOf: "2030-02-04", confidence: "estimated" }],
  rates: { rows: [{ modelKey: "opaque-model", version: "rates-changing", model: "<img src=x onerror=evil()>", aliases: ["alias-one", "alias-two"], validUntil: "2031-03-04T00:00:00Z", tier: "wide tier", abovePromptTokens: 98765, usdPerMillion: { input: 0.000012, cacheRead: 0.23, cacheWrite: 4.56, output: 7.89 } }], nextCursor: "tier-next" }, storedRateVersions: ["stored-old"], storedRateVersionsTruncated: true,
  unpricedModels: { rows: [{ modelKey: "unpriced-model", providerKey: "unpriced-provider", provider: "provider <script>x</script>", model: "unknown-model", reason: "no-rate-at-time", measure: { ...measure(), aic: null, aicDisplay: { primaryAic: null, publishedAic: null, basis: "published" }, pricedCalls: 0, unpricedCalls: 3 } }], nextCursor: null },
  factorHistory: { rows: [{ day: 0, calibration: fit }, { day: 86400000, calibration: { ...fit, status: "implausible", factor: 2, windowStart: 86400000, windowEnd: 172800000, coveredHours: 25, unpricedCalls: 2 } }], nextCursor: "rates-next" }, factorHistoryEnabled: true, nextCursor: "rates-next" }; }
function rows(root: Parameters<typeof elements>[0], caption: string) { const table = elements(root, "table").find(node => elements(node, "caption")[0]?.textContent === caption); expect(table, caption).toBeDefined(); return elements(table!, "tr").slice(1).map(row => row.children.map(cell => cell.textContent)); }
it("Rates renders changing metadata without constants", async () => {
  // Breaks: importing catalogue constants, repricing history, collapsing evidence gaps into factors, or applying a factor in off mode.
  const module = await import("../web/rates.js").catch(() => null); expect(module, "Rates mount is available").not.toBeNull();
  const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root); const requests: URL[] = [], routes: unknown[] = []; const source = data();
  const client = createDashboardClient(async input => { const url = new URL(String(input), "http://127.0.0.1"); requests.push(url); const body: ApiEnvelope<RatesData> = { apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data: source }; return new Response(JSON.stringify(body)); });
  const controller = new AbortController(); const ctx = { document: doc.asDocument(), root: root as unknown as HTMLElement, client, period, filters: [{ field: "actor" as const, value: "parent" }], signal: controller.signal, navigate(route: unknown) { routes.push(route); } };
  const view = await module!.mountRates(ctx); await settle();
  try {
    expect(elements(root, "h2")[0]!.textContent).toBe("Rates, unpriced evidence and calibration"); expect(requests[0]!.pathname).toBe("/api/rates"); expect(requests[0]!.searchParams.get("filters")).toBe('[{"field":"actor","value":"parent"}]');
    expect(rows(root, "Loaded rate versions")[0]).toEqual(["rates-changing", "2030-02-03T00:00:00Z", "2030-02-04", "estimated", "https://example.invalid/<script>evil()</script>"]);
    expect(rows(root, "Loaded rate tiers")[0]).toEqual(["<img src=x onerror=evil()>", "alias-one, alias-two", "rates-changing", "2031-03-04T00:00:00Z", "wide tier", "98,765 prompt tokens", "$0.000012", "$0.23", "$4.56", "$7.89"]);
    expect(rows(root, "Selected stored usage")[0]!.slice(0, 3)).toEqual(["Selected period", "50+ AIC cal", "~100+ AIC published estimate"]);
    expect(root.textContent).toContain("stored-old"); expect(root.textContent).toContain("Stored version list truncated"); expect(root.textContent).toContain("not repriced");
    expect(rows(root, "Unpriced evidence")[0]!.slice(0, 5)).toEqual(["provider <script>x</script>", "Unknown model", "No rate at call time", "unpriced AIC", "unpriced AIC"]);
    const daily = rows(root, "Daily calibration evidence"); expect(daily[0]!.slice(0, 4)).toEqual(["1970-01-01", "calibrated", "x0.5", "1970-01-01T00:00:00.000Z to 1970-01-02T00:00:00.000Z UTC"]); expect(daily[1]![2]).toBe("x2 diagnostic only (not applied)"); expect(daily[1]!.join(" ")).toContain("2 unpriced calls");
    const chart = elements(root, "section").find(node => node.children.some(child => child.tagName === "H3" && child.textContent === "Daily trailing calibration factor"))!;
    expect(elements(chart, "circle")).toHaveLength(1); button(chart, "Table").click(); expect(rows(chart, "Daily trailing calibration factor")[0]![2]).toBe("~0.5 ratio"); expect(rows(chart, "Daily trailing calibration factor")[1]![2]).toBe("unavailable"); expect(rows(chart, "Daily trailing calibration factor")[1]![4]).toContain("diagnostic only");
    expect(elements(root, "p").find(n => n.textContent.startsWith("Selected-period calibration:"))!.textContent).toContain("x0.5"); expect(elements(root, "p").find(n => n.textContent.startsWith("Selected-period calibration:"))!.textContent).not.toContain("x0.8"); expect(root.textContent).toContain("Trailing 7-day ratio"); expect(root.textContent).not.toContain("unavailable UTC"); expect(root.textContent).toContain("Current calibration"); expect(root.textContent).toContain("x0.8"); expect(root.textContent).toContain("Selected-period calibration"); expect(root.textContent).toContain("x0.5");
    expect(elements(root, "script")).toHaveLength(0); expect(elements(root, "img")).toHaveLength(0);
    button(root, "Next page").click(); await settle(); expect(requests.at(-1)!.searchParams.get("cursor")).toBe("rates-next");
    source.rates.rows = [{ ...source.rates.rows[0]!, aliases: ["new-alias"], tier: "new tier", abovePromptTokens: 123, usdPerMillion: { input: 9, cacheRead: 8, cacheWrite: 7, output: 6 } }];
    source.calibration = { ...fit, status: "off", factor: null, windowStart: null, windowEnd: null, coveredHours: 0, computedAic: 0, counterDelta: 0 }; source.periodCalibration = source.calibration; source.factorHistoryEnabled = false; source.factorHistory = { rows: [], nextCursor: null }; source.totals.aicDisplay = { primaryAic: 100, publishedAic: 100, basis: "published" };
    button(root, "Refresh").click(); await settle(); expect(rows(root, "Loaded rate tiers")[0]![1]).toBe("new-alias"); expect(rows(root, "Loaded rate tiers")[0]![6]).toBe("$9");
    expect(rows(root, "Selected stored usage")[0]!.slice(1, 3)).toEqual(["~100+ AIC est", "~100+ AIC published estimate"]); expect(root.textContent).toContain("Factor history disabled: calibration is off"); expect(elements(root, "svg")).toHaveLength(0); expect(requests.at(-1)!.searchParams.get("cursor")).toBe("rates-next"); expect(root.textContent).toContain("not calibrated (off)"); expect(root.textContent).not.toContain("computed ~0 AIC"); const current = elements(root, "p").find(n => n.textContent.startsWith("Current calibration:"))!; expect(current.textContent).toBe("Current calibration: not calibrated (off)"); expect(current.textContent).not.toContain("0 h covered"); expect(current.textContent).not.toContain("computed ~0");
  } finally { view.dispose(); }
});
