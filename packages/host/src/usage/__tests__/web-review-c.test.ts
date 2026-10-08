import { observeFontTransport } from "./fixtures/font-transport.js";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { PlainDocument, elements, settle } from "./fixtures/plain-dom.js";
import { createDashboardBrowserPage } from "./fixtures/dashboard-browser-fixture.js";
import { allViewPage, acceptanceStates } from "./fixtures/all-view-browser-fixture.js";
import { startDashboard } from "../web/app.js";
import { createDashboardClient, DashboardClientError, errorCopy } from "../web/client.js";
import { formatAicDisplay, periodTimes, evidenceText } from "../web/format.js";
import { chartWithTable } from "../web/charts.js";
import { createPager } from "../web/pager.js";
import { renderTable } from "../web/tables.js";
import { loadFonts } from "../web/fonts.js";
import type { ViewRoute } from "../web/views.js";

afterEach(() => vi.unstubAllGlobals());
let base: Awaited<ReturnType<typeof createDashboardBrowserPage>>;
beforeAll(async () => { base = await createDashboardBrowserPage(); });
async function fixture(view: ViewRoute["view"], state: typeof acceptanceStates[number] = "calibrated", filters: ViewRoute["filters"] = [], identifiers = false) {
  const page = allViewPage(base, state), doc = new PlainDocument();
  // Synthetic one-call evidence makes the singular visible in Detail.
  for (const path of ["/api/detail", "/api/overview", "/api/reconciliation"]) {
    const response = JSON.parse(page.routes[path]!.body as string);
    if (path === "/api/detail") { response.data.totals.calls = 1; response.data.calls.rows[0].measure.calls = 1; }
    if (path === "/api/overview") { response.data.comparison.counterAic = 10; response.data.comparison.gap = -2; response.data.comparison.ratio = 1.2; }
    if (path === "/api/reconciliation") { response.data.periods.rows[0].ratio = 1.2; }
    page.routes[path] = { ...page.routes[path]!, body: JSON.stringify(response) };
  }
  if (identifiers) {
    const change = (path: string, edit: (data: any) => void) => {
      const response = JSON.parse(page.routes[path]!.body as string); edit(response.data);
      page.routes[path] = { ...page.routes[path]!, body: JSON.stringify(response) };
    };
    change("/api/rates", d => { d.versions[0].id = "copilot-public-2026-10-04"; d.rates.rows[0].version = "copilot-public-2026-10-04"; d.rates.rows[0].model = "gpt-4o-2024-08-06"; });
    change("/api/explorer", d => { d.rows[0].labels = ["copilot-public-2026-10-04", "gpt-4o-2024-08-06"]; });
    change("/api/cache", d => { d.sessionsWithWritesNoReads.rows = [{ sessionId: "copilot-public-2026-10-04", sessionLabel: "copilot-public-2026-10-04", projectLabel: "gpt-4o-2024-08-06", measure: d.totals }]; });
    change("/api/detail", d => { d.calls.rows[0].runName = "copilot-public-2026-10-04"; d.calls.rows[0].model = "gpt-4o-2024-08-06"; });
  }
  const client = createDashboardClient(async input => new Response(page.routes[new URL(String(input), "https://dashboard.invalid").pathname]!.body as string));
  const app = startDashboard({ document: doc.asDocument(), initialRoute: { view, id: "session-fixture", filters, period: JSON.parse(page.routes["/api/overview"]!.body as string).period }, client });
  for (let i = 0; i < 30; i++) await settle();
  return { doc, app };
}

it.each(acceptanceStates)("%s AIC chart values use the same primary basis tag as tables", async state => {
  // Breaks: chart-only tilde or long basis wording instead of cal/est/?.
  for (const view of ["overview", "explorer", "session", "run", "cache"] as const) {
    const { doc, app } = await fixture(view, state);
    try {
      const summaries = elements(doc.body, "p").filter(n => n.className === "chart-summary" && n.textContent.includes("AIC"));
      expect(summaries.length).toBeGreaterThan(0);
      const tag = state === "off" ? "est" : state === "unavailable" ? "?" : state === "back-applied" ? "cal (back-applied)" : "cal";
      for (const summary of summaries) {
        expect(summary.textContent).toContain(`AIC ${tag}`);
        expect(summary.textContent).not.toMatch(/~[\d,]+\+? AIC cal/);
      }
    } finally { app.dispose(); }
  }
});
it.each(["calibrated", "back-applied"] as const)("Reconciliation %s amounts use the shared AIC tag without tilde", async state => {
  const { doc, app } = await fixture("reconciliation", state);
  try {
    const table = elements(doc.body, "table").find(t => elements(t, "caption")[0]?.textContent === "Calibrated comparison")!;
    const cell = elements(table, "td").find(t => t.getAttribute("data-label") === "Calibrated AIC (pair fits)")!;
    expect(cell.textContent).toContain(state === "back-applied" ? "AIC cal (back-applied)" : "AIC cal");
    expect(cell.textContent).not.toContain("~");
  } finally { app.dispose(); }
});
it.each(["overview", "reconciliation"] as const)("%s uses compact ratios and signed gaps", async view => {
  const { doc, app } = await fixture(view);
  try {
    expect(doc.body.textContent).toContain("~1.2 ratio");
    expect(doc.body.textContent).not.toContain("~1.20 ratio");
    if (view === "overview") { expect(elements(doc.body, "p").find(n => n.textContent.startsWith("10 AIC counter"))!.textContent).toBe("10 AIC counter · published gap -2 AIC · published ~1.2 ratio"); expect(doc.body.textContent).toContain("published gap -2 AIC"); expect(doc.body.textContent).not.toContain("~-2 AIC"); }
  } finally { app.dispose(); }
});
it("gap chart signs include positive, negative and rounded zero consistently", () => {
  const doc = new PlainDocument();
  const chart = chartWithTable(doc.asDocument(), { title: "Gap", unit: "gap-aic", points: [-2, 16, -0.1].map(value => ({ start: 0, end: 1000, label: "Synthetic", value, tokens: null })) });
  expect(chart.textContent).toContain("-2 AIC"); expect(chart.textContent).toContain("+16 AIC"); expect(chart.textContent).not.toContain("-0 AIC");
});
it.each(["session", "run"] as const)("%s one-call evidence is singular", async view => {
  const { doc, app } = await fixture(view);
  try { expect(doc.body.textContent).toContain("1 call"); expect(doc.body.textContent).not.toContain("1 calls"); }
  finally { app.dispose(); }
});
it.each(["overview", "explorer", "session", "run", "context", "cache", "reconciliation", "rates"] as const)("%s heading order never skips a level", async view => {
  const { doc, app } = await fixture(view);
  try {
    const headings = elements(doc.body, "h1").concat(elements(doc.body, "h2"), elements(doc.body, "h3"));
    // PlainDocument traversal is independent of selector support.
    const walk = (node: typeof doc.body): number[] => node.children.flatMap(n => [/^H[1-6]$/.test(n.tagName) ? Number(n.tagName[1]) : 0, ...walk(n)]).filter(Boolean);
    const levels = walk(doc.body); expect(headings.length).toBeGreaterThan(0); expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
  } finally { app.dispose(); }
});
it.each(["overview", "session", "run", "cache", "reconciliation", "rates"] as const)("%s visible dates including charts use readable UTC labels", async view => {
  const { doc, app } = await fixture(view);
  try {
    expect(doc.body.textContent).not.toMatch(/\b2026-01(?:-\d{2})?\b/);
    expect(doc.body.textContent).toContain("Jan 2026");
    for (const time of elements(doc.body, "time")) expect(time.getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  } finally { app.dispose(); }
});
it("chart tooltips preserve free-text evidence and format the known period", () => {
  const doc = new PlainDocument();
  const chart = chartWithTable(doc.asDocument(), { title: "Factor", unit: "ratio", points: [{ start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 3), label: "2026-01-01", labelDate: "day", value: 1.2, tokens: null,
    note: "Window 2026-01-01T00:00:00.000Z to 2026-01-03T00:00:00.000Z UTC" }] });
  const tooltip = elements(chart, "title")[1]!.textContent;
  expect(tooltip).toBe("1 Jan 2026 · 1 Jan 2026 to 2 Jan 2026 · ~1.2 ratio · tokens unavailable · Window 2026-01-01T00:00:00.000Z to 2026-01-03T00:00:00.000Z UTC");
  expect(tooltip).toContain("1 Jan 2026 to 2 Jan 2026"); expect(tooltip).toContain("Window 2026-01-01T00:00:00.000Z to 2026-01-03T00:00:00.000Z UTC"); expect(tooltip).not.toContain("UTC UTC");
  expect(elements(chart, "time").every(t => t.getAttribute("datetime")?.endsWith("Z"))).toBe(true);
});
it("midnight-aligned period endpoints use symmetric dates", () => {
  const doc = new PlainDocument();
  const period = periodTimes(doc.asDocument(), Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 3), true);
  expect(period.textContent).toBe("1 Jan 2026 to 2 Jan 2026");
  expect(elements(period, "time").map(t => t.getAttribute("datetime"))).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
});
it("unavailable calibration legend does not place a period before its separator", () => {
  const dto = JSON.parse(allViewPage(base, "unavailable").routes["/api/overview"]!.body as string).data;
  expect(formatAicDisplay(dto.totals.aicDisplay, 0, dto.calibration).legend).not.toContain(". ·");
});
it("identity recovery names the salt sidecar and failure-cache window", () => {
  const copy = errorCopy(new DashboardClientError("identity-unavailable"));
  expect(copy).toContain("the ledger's explorer-salt file"); expect(copy).toContain("five seconds"); expect(copy).not.toContain("Run /usage again");
});
it("pager success announces once without a second visible success line", () => {
  const doc = new PlainDocument(), pager = createPager(doc.asDocument(), { title: "Synthetic", param: "cursor", onLoad() {} });
  pager.complete(0, true);
  const status = elements(pager.region, "p").find(n => n.getAttribute("role") === "status")!;
  expect(status.textContent).toBe("Usage updated."); expect(status.className).toContain("live-only");
  pager.busy(false); pager.complete(60_000, false); expect(status.className).toContain("live-only");
  pager.busy(true); expect(status.className).not.toContain("live-only");
  pager.fail(new DashboardClientError("busy"), true); expect(status.className).not.toContain("live-only");
});
it("Explorer remove-filter accessible name uses the human label", async () => {
  const { doc, app } = await fixture("explorer", "calibrated", [{ field: "requestedModel", kind: "missing" }]);
  try { expect(elements(doc.body, "button").find(n => n.textContent === "Remove")!.getAttribute("aria-label")).toBe("Remove filter Requested model"); }
  finally { app.dispose(); }
});
it("optional font request includes every declared local weight", async () => {
  const doc = new PlainDocument(), faces = observeFontTransport(doc); await loadFonts(doc.asDocument(), undefined, () => 1);
  expect(faces.map(face => `${face.family}:${face.weight}`)).toEqual(["Google Sans Flex:400", "Google Sans Flex:500", "Google Sans Flex:600", "Google Sans Flex:700", "Cascadia Code:400", "Cascadia Code:700"]);
  expect(elements(doc.head, "link")).toHaveLength(0);
});
it("period-independent empty tables do not imply a selected time window", () => {
  const doc = new PlainDocument();
  const table = renderTable(doc.asDocument(), { caption: "Loaded rate versions", columns: ["Version"], rows: [] });
  expect(table.textContent).toContain("No rows recorded"); expect(table.textContent).not.toContain("for this period");
});

it.each(["rates", "cache", "explorer", "session"] as const)("%s keeps date-bearing identifiers verbatim", async view => {
  const { doc, app } = await fixture(view, "calibrated", [], true);
  try {
    expect(doc.body.textContent).toContain("copilot-public-2026-10-04");
    expect(doc.body.textContent).toContain("gpt-4o-2024-08-06");
    expect(elements(doc.body, "time").some(t => /2024-08-06|2026-10-04/.test(t.getAttribute("datetime") ?? ""))).toBe(false);
  } finally { app.dispose(); }
});
it("free text is never interpreted as a date", () => {
  const doc = new PlainDocument(), text = "Project 2026-10 and session 2026-10-04; model gpt-4o-2024-08-06";
  const node = evidenceText(doc.asDocument(), text);
  expect(node.textContent).toBe(text); expect(elements(node, "time")).toHaveLength(0);
});
it.each([1, 31])("%i-day half-open period displays inclusive dates with exact bounds", days => {
  const doc = new PlainDocument(), start = Date.UTC(2026, 9, 1), end = start + days * 86400000;
  const period = periodTimes(doc.asDocument(), start, end, true);
  expect(period.getAttribute("data-start")).toBe(new Date(start).toISOString());
  expect(period.getAttribute("data-end")).toBe(new Date(end).toISOString());
  expect(period.textContent).toBe(days === 1 ? "1 Oct 2026" : "1 Oct 2026 to 31 Oct 2026");
  expect(elements(period, "time").map(t => t.getAttribute("datetime"))).toEqual(days === 1 ? ["2026-10-01T00:00:00.000Z"] : ["2026-10-01T00:00:00.000Z", "2026-10-31T00:00:00.000Z"]);
  const chart = chartWithTable(doc.asDocument(), { title: "Daily", unit: "tokens", points: [{ start, end, label: "Bucket", labelDate: "day", value: 1, tokens: null }] });
  expect(elements(chart, "p").find(p => p.className === "chart-summary")!.textContent).toBe(`${period.textContent} · 1 token minimum · 1 token maximum`);
});
it.each(["overview", "explorer", "session", "run", "cache", "reconciliation", "rates"] as const)("%s uses shared dot-separated call evidence", async view => {
  const { doc, app } = await fixture(view);
  try { expect(doc.body.textContent).toMatch(/\d+ calls? · 0 unpriced · 0 aggregate/); expect(doc.body.textContent).not.toMatch(/calls?; \d+ unpriced/); }
  finally { app.dispose(); }
});

it.each(["overview", "explorer", "session", "run", "context", "cache", "reconciliation", "rates"] as const)("%s header uses the same inclusive calendar span as chart summaries", async view => {
  const { doc, app } = await fixture(view);
  try {
    const header = elements(doc.body, "p").find(p => p.className === "period-label")!;
    expect(header.textContent).toBe("1 Jan 2026 to 2 Jan 2026");
    expect(elements(header, "time").map(t => t.getAttribute("datetime"))).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    for (const chart of elements(doc.body, "section").filter(n => n.className === "chart-panel")) {
      const summary = elements(chart, "p").find(p => p.className === "chart-summary")!;
      const summaryBounds = elements(summary, "time");
      for (const t of summaryBounds) expect(t.getAttribute("datetime")).toMatch(/^2026-01-0[12]T/);
      if (summaryBounds.length) expect(summary.textContent).toContain("1 Jan 2026 to 2 Jan 2026");
    }
    if (view === "reconciliation") {
      const table = elements(doc.body, "table").find(t => elements(t, "caption")[0]?.textContent === "Published comparison")!;
      const buckets = elements(table, "td").filter(t => t.getAttribute("data-label") === "UTC bucket");
      expect(buckets.map(t => t.children.find(n => n.className === "cell-value")!.textContent)).toEqual(["1 Jan 2026", "2 Jan 2026"]);
      expect(elements(buckets[0]!, "time").map(t => t.getAttribute("datetime"))).toEqual(["2026-01-01T00:00:00.000Z"]);
    }
  } finally { app.dispose(); }
});


it("midnight snapshot endpoints keep both instants in Reconciliation tables and charts", async () => {
  // Breaks: using inclusive calendar display for matched snapshot instants.
  const { doc, app } = await fixture("reconciliation");
  try {
    const table = elements(doc.body, "table").find(t => elements(t, "caption")[0]?.textContent === "Published comparison")!;
    const matched = elements(table, "td").find(t => t.getAttribute("data-label") === "Matched endpoints UTC")!;
    expect(matched.children.find(n => n.className === "cell-value")!.textContent).toBe("1 Jan 2026, 00:00 UTC to 2 Jan 2026, 00:00 UTC");
    expect(elements(matched, "time").map(t => t.getAttribute("datetime"))).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    elements(doc.body, "button").find(b => b.textContent === "Snapshot pairs")!.click(); await settle(); await settle();
    const chart = elements(doc.body, "section").find(n => n.children.some(c => c.tagName === "H3" && c.textContent === "Published gap"))!;
    const periods = elements(chart, "td").filter(t => t.getAttribute("data-label") === "UTC period");
    expect(periods[0]!.children.find(n => n.className === "cell-value")!.textContent).toBe("1 Jan 2026, 00:00 UTC to 2 Jan 2026, 00:00 UTC");
    expect(elements(chart, "p").find(p => p.className === "chart-summary")!.textContent).toBe("Gap: counter minus published · 1 Jan 2026, 00:00 UTC to 3 Jan 2026, 00:00 UTC · +14 AIC minimum · +16 AIC maximum");
  } finally { app.dispose(); }
});
it.each(["overview", "explorer", "session", "run", "cache", "rates"] as const)("%s keeps midnight evidence-window endpoints with time", async view => {
  // Breaks: shortening actual calibration evidence windows as if they were day buckets.
  const { doc, app } = await fixture(view);
  try {
    expect(doc.body.textContent).toContain("2 Jan 2026, 00:00 UTC to 3 Jan 2026, 00:00 UTC");
    const nodes = elements(doc.body, "time").filter(t => t.textContent === "3 Jan 2026, 00:00 UTC");
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) expect(node.getAttribute("datetime")).toBe("2026-01-03T00:00:00.000Z");
  } finally { app.dispose(); }
});
it.each(["calibrated", "back-applied"] as const)("Reconciliation %s ratio chart evidence has exactly one unit label", async state => {
  const { doc, app } = await fixture("reconciliation", state);
  try {
    const title = state === "back-applied" ? "Calibrated gap · calibrated, back-applied" : "Calibrated gap";
    const chart = elements(doc.body, "section").find(n => n.children.some(c => c.tagName === "H3" && c.textContent === title))!;
    const cell = elements(chart, "td").find(t => t.getAttribute("data-label") === "Evidence")!;
    expect(cell.children.find(n => n.className === "cell-value")!.textContent).toBe("Compared · coverage ~100% · matched 1 Jan 2026, 00:00 UTC to 2 Jan 2026, 00:00 UTC · signed gap +12 AIC · ~0.4 ratio · 1 call · 0 unpriced · 0 aggregate");
  } finally { app.dispose(); }
});
