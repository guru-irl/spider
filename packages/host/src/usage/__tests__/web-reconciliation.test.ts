import { openDashboardReader } from "../dashboard-reader.js";
import { queryReconciliation } from "../query-reconciliation.js";
import { COPILOT_RATE_VERSIONS } from "../rates.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";
import { expect, it } from "vitest";
import type { ApiEnvelope, UsageMeasure } from "../dashboard-contract.js";
import type { ReconciliationData, ReconciliationRow } from "../query-reconciliation.js";
import { createDashboardClient } from "../web/client.js";
import { PlainDocument, elements, button, settle } from "./fixtures/plain-dom.js";
const period = { start: 0, end: 172800000 };
const fit = { status: "calibrated" as const, factor: 0.5, windowStart: 0, windowEnd: 86400000, coveredHours: 24, computedAic: 1000, counterDelta: 500, unpricedCalls: 0, method: "trailing-7d-ratio" as const };
function measure(): UsageMeasure { return { calls: 1, pricedCalls: 1, unpricedCalls: 0, aggregateCalls: 0,
  tokens: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, prompt: 60, total: 100, cacheWrite1h: null, reasoning: null },
  aic: 12, aicDisplay: { primaryAic: 6, publishedAic: 12, basis: "calibrated" }, aicComponents: { input: 1, cacheRead: 2, cacheWrite: 3, output: 6 }, piCost: null,
  possibleOverlap: false, possibleUndercount: false, pendingData: false, estimated: true }; }
function data(): ReconciliationData {
  const row: ReconciliationRow = { start: 3600000, end: 7200000, bucketStart: 0, bucketEnd: 86400000, coverage: 1 / 24, coveredMs: 3600000, resetAnchors: 1, exclusions: { "account-change": 1 },
    counterStart: 3600000, counterEnd: 7200000, status: "partial", counterAic: 10, computed: measure(), gap: -2, ratio: 1.2, calibratedAic: 7.6, calibratedGap: 2.37, calibratedRatio: 0.763, ratioReason: null, calibration: fit };
  return { periods: { rows: [row, ...(["no-snapshot", "reset", "clock", "account-change", "missing-anchor", "counter-decrease", "invalid-counter"] as const).map((status, i) => ({ ...row, start: 86400000 + i, end: 172800000, bucketStart: 86400000 + i, bucketEnd: 172800000, coverage: 0, coveredMs: 0, resetAnchors: 0, exclusions: {}, counterStart: null, counterEnd: null, status, counterAic: null, computed: null, gap: null, ratio: null, calibratedAic: null, calibratedGap: null, calibratedRatio: null, calibration: { ...fit, status: "uncalibrated" as const, factor: null } }))], nextCursor: "pair-next" },
    counterGranularityAic: 1, billingLagCaveat: "billing-lag-minutes", caveats: ["The counter is account-wide and includes other clients.", "Hostile caveat <script>evil()</script>"] };
}
function rows(root: Parameters<typeof elements>[0], caption: string) { const table = elements(root, "table").find(node => elements(node, "caption")[0]?.textContent === caption); expect(table, caption).toBeDefined(); return elements(table!, "tr").slice(1).map(row => row.children.map(cell => cell.textContent)); }
it("Reconciliation displays matched endpoints and signed gap", async () => {
  // Breaks: using calendar endpoints as compared coverage, reversing counter-computed, or plotting missing evidence as zero.
  const module = await import("../web/reconciliation.js").catch(() => null); expect(module, "Reconciliation mount is available").not.toBeNull();
  const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root); const requests: URL[] = [];
  const client = createDashboardClient(async input => { requests.push(new URL(String(input), "http://127.0.0.1")); const body: ApiEnvelope<ReconciliationData> = { apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data: data() }; return new Response(JSON.stringify(body)); });
  const controller = new AbortController(); const ctx = { document: doc.asDocument(), root: root as unknown as HTMLElement, client, period, filters: [{ field: "actor" as const, value: "parent" }], signal: controller.signal, navigate() {} };
  const view = await module!.mountReconciliation(ctx); await settle();
  try {
    expect(requests[0]!.pathname).toBe("/api/reconciliation"); expect(requests[0]!.searchParams.has("filters")).toBe(false); expect(requests[0]!.searchParams.get("bucket")).toBe("day");
    expect(root.textContent).toContain("Selected filters do not apply");
    const published = rows(root, "Published comparison")[0]!;
    expect(published).toEqual(["1970-01-01T00:00:00.000Z to 1970-01-02T00:00:00.000Z", "1970-01-01T01:00:00.000Z to 1970-01-01T02:00:00.000Z", "Partial coverage", "10 AIC counter", "~12 AIC published estimate", "-2 AIC", "~1.20 ratio", "input 10; cache read 20; cache write 30; output 40; prompt 60; total 100; cache write 1h unavailable; reasoning unavailable"]);
    expect(rows(root, "Calibrated comparison")[0]!.slice(2, 5)).toEqual(["~8 AIC calibrated", "+2 AIC", "~0.76 ratio"]);
    const coverage = rows(root, "Snapshot coverage")[0]!; expect(coverage).toContain("~4.17%"); expect(coverage).toContain("1 h covered"); expect(coverage).toContain("1 observed reset anchor"); expect(coverage.join(" ")).toContain("Account change: 1");
    for (const word of ["No snapshot pair", "Unobserved reset", "Clock ordering anomaly", "Account change", "Missing anchor", "Counter decreased", "Invalid counter"]) expect(root.textContent).toContain(word);
    expect(root.textContent).toContain("whole AIC (1 AIC)"); expect(root.textContent).toContain("Billing lag"); expect(root.textContent).toContain("3 to 5 minutes"); expect(root.textContent).toContain("not prorated");
    const gaps = elements(root, "section").find(node => node.children.some(child => child.tagName === "H3" && child.textContent === "Published gap"))!;
    expect(elements(gaps, "circle")).toHaveLength(1); button(gaps, "Table").click(); expect(rows(gaps, "Published gap · Gap: counter minus published")[1]![2]).toBe("unavailable"); expect(rows(gaps, "Published gap · Gap: counter minus published")[0]![4]).toContain("-2 AIC");
    const calibratedChart = elements(root, "section").find(n => n.children.some(c => c.tagName === "H3" && c.textContent === "Calibrated gap"))!;
    expect(elements(calibratedChart, "circle")).toHaveLength(1);
    expect(rows(calibratedChart, "Calibrated gap · Gap: counter minus calibrated")[0]![2]).toBe("+2 AIC");
    expect(rows(calibratedChart, "Calibrated gap · Gap: counter minus calibrated")[0]![1]).toBe("1970-01-01T01:00:00.000Z to 1970-01-01T02:00:00.000Z");
    expect(rows(calibratedChart, "Calibrated gap · Gap: counter minus calibrated")[0]![4]).toContain("~0.76 ratio");
    expect(rows(calibratedChart, "Calibrated gap · Gap: counter minus calibrated")).toHaveLength(1);
    expect(rows(gaps, "Published gap · Gap: counter minus published")[0]![2]).toBe("-2 AIC");
    expect(button(root, "Daily buckets").getAttribute("aria-pressed")).toBe("true");
    expect(elements(root, "script")).toHaveLength(0); expect(root.textContent).toContain("<script>evil()</script>");
    button(root, "Next page").click(); await settle(); expect(requests.at(-1)!.searchParams.get("cursor")).toBe("pair-next");
    button(root, "Snapshot pairs").click(); await settle(); expect(requests.at(-1)!.searchParams.get("bucket")).toBe("snapshot"); expect(requests.at(-1)!.searchParams.has("cursor")).toBe(false);
    button(root, "Monthly buckets").click(); await settle(); expect(requests.at(-1)!.searchParams.get("bucket")).toBe("month"); expect(button(root, "Monthly buckets").getAttribute("aria-pressed")).toBe("true"); expect(button(root, "Daily buckets").getAttribute("aria-pressed")).toBe("false");
  } finally { view.dispose(); }
});

it("Reconciliation distinguishes pair-fit nulls and signed whole-AIC gaps", async () => {
  // Breaks: calibrated null plotted as zero/published, fractional counter gaps, -0, or duplicate calibrated amounts.
  const { mountReconciliation } = await import("../web/reconciliation.js"), doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const source = data(); source.periods.rows = [
    { ...source.periods.rows[0]!, gap: -0.4, calibratedAic: null, calibratedGap: null, calibratedRatio: null },
    { ...source.periods.rows[0]!, gap: -2.37, calibratedAic: 7.6, calibratedGap: 2.37, calibratedRatio: 0.763 },
  ];
  const client = createDashboardClient(async () => new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: 0, data: source })));
  const view = await mountReconciliation({ document: doc.asDocument(), root: root as unknown as HTMLElement, client, period, filters: [], signal: new AbortController().signal, navigate() {} }); await settle();
  try {
    const chart = elements(root, "section").find(n => n.children.some(c => c.tagName === "H3" && c.textContent === "Calibrated gap"))!;
    expect(elements(chart, "circle")).toHaveLength(1); expect(rows(chart, "Calibrated gap · Gap: counter minus calibrated").map(r => r[2])).toEqual(["unavailable", "+2 AIC"]);
    expect(rows(root, "Published comparison").map(r => r[5])).toEqual(["0 AIC", "-2 AIC"]);
    const calibrated = rows(root, "Calibrated comparison"); expect(calibrated[0]![2]).toBe("unavailable"); expect(calibrated[1]!.slice(2, 5)).toEqual(["~8 AIC calibrated", "+2 AIC", "~0.76 ratio"]);
    expect(elements(root, "th").some(n => n.textContent === "Primary AIC (approximate)")).toBe(false);
    const caption = elements(chart, "p").find(n => n.className === "numeric chart-summary")!;
    expect(caption.textContent).toContain("Gap: counter minus calibrated"); expect(caption.textContent).toContain("+2 AIC minimum");
    expect(elements(chart, "svg")[0]!.getAttribute("aria-label")).toContain(caption.textContent);
    expect(elements(chart, "svg")[0]!.getAttribute("aria-describedby")).toBe(caption.id);
    expect(elements(chart, "title")[2]!.textContent).toContain("+2 AIC");
    const group = elements(chart, "div").find(n => n.getAttribute("role") === "group")!; expect(group.getAttribute("aria-label")).toBe("Chart representation");
    expect(button(group, "Chart").getAttribute("aria-pressed")).toBe("true"); button(group, "Table").click(); expect(button(group, "Table").getAttribute("aria-pressed")).toBe("true");
  } finally { view.dispose(); }
});

 it("Reconciliation retains calibrated lower bounds for unpriced calls", async () => {
  // Breaks: X3 dropping the calibrated amount's lower-bound marker.
  const { mountReconciliation } = await import("../web/reconciliation.js"), doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const source = data(); source.periods.rows[0]!.computed!.unpricedCalls = 1;
  const client = createDashboardClient(async () => new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: 0, data: source })));
  const view = await mountReconciliation({ document: doc.asDocument(), root: root as unknown as HTMLElement, client, period, filters: [], signal: new AbortController().signal, navigate() {} }); await settle();
  try { expect(rows(root, "Calibrated comparison")[0]![2]).toBe("~8+ AIC calibrated"); }
  finally { view.dispose(); }
});


it.each([
  { reason: "ingest-pending" as const, copy: "Ingest still catching up" },
  { reason: "no-local-calls" as const, copy: "No local calls in this span; the counter may include other clients" },
])("Reconciliation explains $reason wherever it shows a ratio", async ({ reason, copy }) => {
  // Breaks: raw query ratioReason keys, no explanation, or inconsistent chart/table evidence.
  const { mountReconciliation } = await import("../web/reconciliation.js"), doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const source = data(); source.periods.rows = [{ ...source.periods.rows[0]!, ratio: null, calibratedRatio: null, ratioReason: reason }];
  const client = createDashboardClient(async () => new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: 0, data: source })));
  const view = await mountReconciliation({ document: doc.asDocument(), root: root as unknown as HTMLElement, client, period, filters: [], signal: new AbortController().signal, navigate() {} }); await settle();
  try {
    expect(rows(root, "Published comparison")[0]![6]).toBe(`unavailable · ${copy}`);
    expect(rows(root, "Calibrated comparison")[0]![4]).toBe(`unavailable · ${copy}`);
    for (const [title, basis] of [["Published gap", "published"], ["Calibrated gap", "calibrated"]]) {
      const chart = elements(root, "section").find(n => n.children.some(c => c.tagName === "H3" && c.textContent === title))!;
      expect(rows(chart, `${title} · Gap: counter minus ${basis}`)[0]![4]).toContain(copy);
    }
    expect(root.textContent).not.toContain(reason);
  } finally { view.dispose(); }
});
it("Reconciliation uses day/month bucket labels and end-snapshot labels, while tables retain spans", async () => {
  // Breaks: range labels cause A to B to C to D captions; snapshot labels use pair start instead of end.
  const { mountReconciliation } = await import("../web/reconciliation.js"), doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const source = data(); source.periods.rows = [source.periods.rows[0]!, { ...source.periods.rows[0]!, bucketStart: 86400000, bucketEnd: 172800000, counterStart: 90000000, counterEnd: 93600000 }];
  const client = createDashboardClient(async () => new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: 0, data: source })));
  const view = await mountReconciliation({ document: doc.asDocument(), root: root as unknown as HTMLElement, client, period, filters: [], signal: new AbortController().signal, navigate() {} }); await settle();
  const chart = () => elements(root, "section").find(n => n.children.some(c => c.tagName === "H3" && c.textContent === "Published gap"))!;
  const summary = () => elements(chart(), "p").find(p => p.className === "numeric chart-summary")!.textContent;
  try {
    expect(summary()).toContain("1970-01-01 to 1970-01-02 ·");
    expect(rows(chart(), "Published gap · Gap: counter minus published").map(r => r[0])).toEqual(["1970-01-01", "1970-01-02"]);
    button(root, "Monthly buckets").click(); await settle();
    expect(rows(chart(), "Published gap · Gap: counter minus published").map(r => r[0])).toEqual(["1970-01", "1970-01"]);
    button(root, "Snapshot pairs").click(); await settle();
    expect(rows(chart(), "Published gap · Gap: counter minus published").map(r => r[0])).toEqual(["1970-01-01T02:00:00.000Z", "1970-01-02T02:00:00.000Z"]);
    expect(rows(root, "Published comparison")[0]![1]).toBe("1970-01-01T01:00:00.000Z to 1970-01-01T02:00:00.000Z");
    source.periods.rows = [source.periods.rows[0]!]; button(root, "Refresh").click(); await settle();
    expect(rows(chart(), "Published gap · Gap: counter minus published")[0]![0]).toBe("1970-01-01T02:00:00.000Z");
  } finally { view.dispose(); }
});

it.each(["calibrated", "back-applied", "mixed"] as const)("Reconciliation splits %s gap points by their own basis", async kind => {
  // Breaks: back-applied points are mislabelled, combined with calibrated points, or omitted.
  const { mountReconciliation } = await import("../web/reconciliation.js"), doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const source = data(), row = source.periods.rows[0]!;
  const back: ReconciliationRow = { ...row, bucketStart: 86400000, computed: { ...measure(), aicDisplay: { primaryAic: 6, publishedAic: 12, basis: "back-applied" } }, calibratedGap: -4 };
  source.periods.rows = kind === "mixed" ? [row, back] : [kind === "calibrated" ? row : back];
  const client = createDashboardClient(async () => new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: 0, data: source })));
  const view = await mountReconciliation({ document: doc.asDocument(), root: root as unknown as HTMLElement, client, period, filters: [], signal: new AbortController().signal, navigate() {} }); await settle();
  try {
    const captions = elements(root, "caption").map(n => n.textContent);
    const wants = kind === "mixed" ? ["calibrated", "back-applied"] : [kind];
    for (const basis of wants) {
      const title = basis === "calibrated" ? "Calibrated gap" : "Calibrated gap · calibrated, back-applied";
      const chart = elements(root, "section").find(n => n.children.some(c => c.tagName === "H3" && c.textContent === title))!;
      expect(chart).toBeDefined();
      const caption = `${title} · Gap: counter minus ${basis}`;
      expect(rows(chart, caption).map(r => r[2])).toEqual([basis === "calibrated" ? "+2 AIC" : "-4 AIC"]);
      expect(elements(chart, "th")[2]!.textContent).toBe(`Gap: counter minus ${basis}`);
      expect(elements(chart, "svg")[0]!.getAttribute("aria-label")).toContain(`Gap: counter minus ${basis}`);
    }
    expect(captions.filter(c => c.startsWith("Calibrated gap"))).toHaveLength(wants.length);
    expect(rows(root, "Calibrated comparison").map(r => r[2])).toEqual(wants.map(b => b === "calibrated" ? "~8 AIC calibrated" : "~8 AIC calibrated, back-applied"));
  } finally { view.dispose(); }
});
it("snapshot gaps without matched endpoints use the row's end time", async () => {
  // Breaks: D10 falls back to the start instead of the observation end.
  const { mountReconciliation } = await import("../web/reconciliation.js"), doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const source = data(); source.periods.rows = [{ ...source.periods.rows[0]!, counterEnd: null }];
  const client = createDashboardClient(async () => new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: 0, data: source })));
  const view = await mountReconciliation({ document: doc.asDocument(), root: root as unknown as HTMLElement, client, period, filters: [], signal: new AbortController().signal, navigate() {} }); await settle();
  try {
    button(root, "Snapshot pairs").click(); await settle();
    expect(rows(root, "Published gap · Gap: counter minus published")[0]![0]).toBe("1970-01-01T02:00:00.000Z");
  } finally { view.dispose(); }
});

it("early history without a calibration window labels E16 back-applied query amounts", async () => {
  // Breaks: real query back-applied amounts are plotted as calibrated or labelled calibrated in the comparison.
  const fixture = createDashboardFixture(false);
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture", now: () => M + 40 * D, serverBuild: "fixture", rates: COPILOT_RATE_VERSIONS, calibrationMode: () => "auto" })!;
  let view: { dispose(): void } | undefined;
  try {
    const snap = (ts: number, credits: number) => fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(ts, "synthetic-seat", credits, 10000, 10000 - credits, "2026-11-01", "{}");
    fixture.ledger.apply(dashboardBatch([dashboardCall("bp", { ts: M + 1, price: { status: "priced", aic: 1000, components: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" } })]));
    snap(M, 0); snap(M + D, 500); snap(M + 2 * D, 520);
    fixture.ledger.apply(dashboardBatch([dashboardCall("bp2", { ts: M + D + 1, price: { status: "priced", aic: 10, components: { input: 10, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" } })]));
    const selected = { start: M, end: M + 3 * D };
    const source = reader.snapshot(ctx => queryReconciliation(ctx, selected, { bucket: "day", limit: 50 }));
    expect(source.periods.rows[0]!.computed!.aicDisplay.basis).toBe("back-applied");
    expect(source.periods.rows[0]!.calibratedAic).toBe(500); expect(source.periods.rows[0]!.calibratedGap).toBe(0);
    const { mountReconciliation } = await import("../web/reconciliation.js"), doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
    const client = createDashboardClient(async () => new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period: selected, generatedAt: 0, data: source })));
    view = await mountReconciliation({ document: doc.asDocument(), root: root as unknown as HTMLElement, client, period: selected, filters: [], signal: new AbortController().signal, navigate() {} }); await settle();
    expect(rows(root, "Calibrated comparison")[0]![2]).toBe("~500 AIC calibrated, back-applied");
    expect(rows(root, "Calibrated gap · calibrated, back-applied · Gap: counter minus back-applied")[0]![2]).toBe("0 AIC");
  } finally { view?.dispose(); reader.close(); fixture.close(); }
});
