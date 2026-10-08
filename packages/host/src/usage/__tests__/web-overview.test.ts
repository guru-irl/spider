import { describe, expect, it, vi } from "vitest";
import { mountOverview } from "../web/overview.js";
import { overviewFixture, sessionsFixture, envelope } from "./fixtures/redesign-contract.js";
import { PlainDocument, PlainElement, descendants, button, elements, settle } from "./fixtures/plain-dom.js";
import type { DashboardPageContext, DashboardRouteV4, OverviewDataV4 } from "../dashboard-v4-contract.js";
import type { ApiEnvelope } from "../dashboard-contract.js";
const NOW = Date.UTC(2030, 3, 15), DAY = 86400000;
function setup(get?: (path: string, params: URLSearchParams) => Promise<ApiEnvelope<unknown>>, initial = overviewFixture()) {
  const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const requests: { path: string; params: URLSearchParams; signal: AbortSignal | undefined }[] = [], routes: { route: DashboardRouteV4; replace: boolean }[] = [];
  const controller = new AbortController();
  const ctx: DashboardPageContext = { document: doc.asDocument(), root: root as unknown as HTMLElement, signal: controller.signal,
    route: { page: "overview", query: initial.range }, overview: initial.range, now: () => NOW, back() {},
    navigate(route, opts) { routes.push({ route, replace: !!opts?.replace }); },
    client: { async get<T>(path: string, params = new URLSearchParams(), signal?: AbortSignal) {
      requests.push({ path, params, signal });
      return (get ? await get(path, params) : envelope(path === "/api/sessions" ? sessionsFixture() : initial)) as ApiEnvelope<T>;
    } },
  };
  const page = mountOverview(ctx);
  return { ctx, doc, root, requests, routes, page, controller, nodes: () => descendants(root), bars: () => descendants(root).filter(n => n.getAttribute("data-bucket") !== null && n.tagName === "g") };
}
function fire(node: PlainElement | PlainDocument, type: string, props: Record<string, unknown> = {}) { const event = new Event(type, { cancelable: true }); for (const [k, v] of Object.entries(props)) Object.defineProperty(event, k, { value: v }); node.dispatchEvent(event); }
describe("Overview v4", () => {
  it("renders full-range chips, models as the legend and same-value chart tables", async () => {
    const s = setup(); await settle();
    expect(s.root.children[0]!.className).toBe("month-pace");
    expect(s.root.textContent).toContain("Daily credits"); expect(s.root.textContent).toContain("Average");
    expect(s.nodes().filter(n => n.className === "role-key")).toHaveLength(4);
    expect(s.root.textContent).toContain("Mostly worker runs"); expect(s.root.textContent).not.toContain("AIC");
    expect(s.bars()).toHaveLength(7); expect(s.nodes().find(n => n.getAttribute("data-panel") === "daily")!.textContent).toContain("4"); s.page.dispose();
  });
  it.each(["runs", "last-active"] as const)("preserves %s sort and reloads its first page for refreshed bounds", async sort => {
    let refreshes = 0;
    const s = setup(async (path, params) => {
      if (path === "/api/sessions") return envelope(sessionsFixture({ rows: [{ ...sessionsFixture().rows[0]!, name: `${sort} result`, id: "sorted-session" }] }));
      const d = overviewFixture(); d.range.from += refreshes++ * DAY; d.range.buckets = JSON.parse(params.get("buckets") ?? "[]");
      return envelope(d);
    }); await settle();
    const control = () => s.nodes().find(n => n.getAttribute("data-focus") === `session-sort-${sort}`)!;
    control().click(); await settle();
    await s.page.refresh(); await settle();
    expect(control().getAttribute("aria-pressed")).toBe("true");
    expect(s.root.textContent).toContain(`${sort} result`);
    const request = s.requests.at(-1)!;
    expect(request.path).toBe("/api/sessions"); expect(request.params.get("sort")).toBe(sort);
    expect(request.params.get("from")).toBe("1901923200000"); expect(request.params.get("range")).toBe("custom"); expect(request.params.get("offset")).toBe("0"); expect(request.params.get("limit")).toBe("10");
    fire(s.bars()[4]!, "keydown", { key: " " }); await settle();
    expect(control().getAttribute("aria-pressed")).toBe("true"); expect(s.requests.at(-1)!.params.get("buckets")).toBe("[1902182400000]"); s.page.dispose();
  });
  it("refetches Overview rather than mixing a Sessions page from another revision", async () => {
    let overviews = 0, sessionRequests = 0;
    const s = setup(async path => {
      if (path === "/api/sessions") {
        const reply = envelope(sessionsFixture({ rows: [{ ...sessionsFixture().rows[0]!, name: sessionRequests++ === 0 ? "Wrong revision row" : "Current revision row" }] }));
        reply.revision = "next-revision"; return reply;
      }
      const reply = envelope(overviewFixture()); if (overviews++ > 0) reply.revision = "next-revision"; return reply;
    }); await settle();
    s.nodes().find(n => n.getAttribute("data-focus") === "session-sort-runs")!.click(); await settle();
    expect(s.requests.filter(r => r.path === "/api/overview")).toHaveLength(2);
    expect(s.root.textContent).not.toContain("Wrong revision row"); expect(s.root.textContent).toContain("Current revision row"); s.page.dispose();
  });
  it.each([
    ["credits", 4, ["0", "2", "4"]],
    ["tokens", 26800, ["0", "10k", "20k", "30k"]],
  ] as const)("uses rounded %s ticks and labels the unit above the daily axis", async (unit, maximum, ticks) => {
    const d = overviewFixture(); d.range.unit = unit;
    d.buckets = [{ ...d.buckets[4]!, total: { ...d.buckets[4]!.total, credits: maximum, tokens: { ...d.buckets[4]!.total.tokens, total: maximum } }, models: [] }];
    const s = setup(undefined, d); await settle(); const svg = s.nodes().find(n => n.className === "daily-chart")!;
    const labels = elements(svg, "text");
    expect(labels.filter(n => n.getAttribute("text-anchor") === "end").map(n => n.textContent)).toEqual(ticks);
    const axis = labels.find(n => n.textContent === unit); expect(axis).toBeDefined(); expect(Number(axis!.getAttribute("y"))).toBeLessThan(56); s.page.dispose();
  });
  it("names the leading model alongside its share in the Top chip", async () => {
    const s = setup(); await settle(); const models = s.nodes().find(n => n.getAttribute("data-panel") === "models")!;
    expect(descendants(models).find(n => n.className === "stat-chip" && n.children[0]!.textContent === "Top")!.children[1]!.textContent).toBe("model-cedar · 50%"); s.page.dispose();
  });
  it("starts This month at local calendar midnight across a DST change", async () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      const s = setup(); await settle(); s.ctx.now = () => Date.UTC(2030, 2, 15, 16);
      button(s.root, "This month").click(); expect(s.routes.at(-1)!.route).toMatchObject({ page: "overview", query: { range: "month", from: Date.UTC(2030, 2, 1, 5), to: Date.UTC(2030, 2, 15, 16), buckets: [] } }); s.page.dispose();
    } finally { vi.unstubAllEnvs(); }
  });
  it("noncontiguous selection toggles on modifiers and Space, not plain or right click", async () => {
    const s = setup(async (_path, params) => { const data = overviewFixture(); data.range.buckets = JSON.parse(params.get("buckets") ?? "[]"); return envelope(data); }); await settle();
    let bars = s.bars(); fire(bars[4]!, "click", { button: 2, ctrlKey: true }); fire(bars[4]!, "click", { button: 0 });
    expect(s.requests).toHaveLength(1);
    fire(bars[4]!, "click", { button: 0, metaKey: true }); await settle(); bars = s.bars();
    fire(bars[6]!, "keydown", { key: "Enter", ctrlKey: true }); await settle();
    expect(s.requests.at(-1)!.params.get("buckets")).toBe(JSON.stringify([Date.UTC(2030, 3, 12), Date.UTC(2030, 3, 14)]));
    fire(s.bars()[4]!, "keydown", { key: " " }); await settle(); expect(s.requests.at(-1)!.params.get("buckets")).toBe(JSON.stringify([Date.UTC(2030, 3, 14)])); s.page.dispose();
  });
  it("arrows rove focus and Escape or click away clears selection while controls preserve it", async () => {
    const s = setup(async (_path, params) => { const d = overviewFixture(); d.range.buckets = JSON.parse(params.get("buckets") ?? "[]"); return envelope(d); }); await settle();
    fire(s.bars()[4]!, "keydown", { key: "ArrowRight" }); expect(s.doc.activeElement).toBe(s.bars()[5]);
    fire(s.bars()[5]!, "keydown", { key: " " }); await settle();
    fire(s.doc, "click", { target: button(s.root, "Tokens") }); expect(s.requests.at(-1)!.params.get("buckets")).not.toBe("[]");
    fire(s.doc, "keydown", { key: "Escape" }); await settle(); expect(s.requests.at(-1)!.params.get("buckets")).toBe("[]");
    fire(s.bars()[4]!, "keydown", { key: " " }); await settle(); fire(s.doc, "click", { target: s.root }); await settle(); expect(s.requests.at(-1)!.params.get("buckets")).toBe("[]"); s.page.dispose();
  });
  it("uses actual selected downstream DTOs, retaining full-range total and bars", async () => {
    const s = setup(async (_path, params) => {
      const d = overviewFixture(); d.range.buckets = JSON.parse(params.get("buckets") ?? "[]");
      if (d.range.buckets.length) { d.selectedTotal.credits = 2; d.models = [{ ...d.models[0]!, value: { ...d.models[0]!.value, credits: 2 } }]; d.sessions.rows = [{ ...d.sessions.rows[0]!, value: { ...d.sessions.rows[0]!.value, credits: 2 } }]; d.flow.total.credits = 2; d.flow.edges = [{ ...d.flow.edges[0]!, value: { ...d.flow.edges[0]!.value, credits: 2 }, share: 1 }]; }
      return envelope(d);
    }); await settle(); fire(s.bars()[4]!, "click", { button: 0, ctrlKey: true }); await settle();
    expect(s.nodes().find(n => n.className === "selection-chip")!.textContent).toBe("Selected 1 day · 2 credits");
    expect(s.nodes().find(n => n.getAttribute("data-panel") === "models")!.textContent).not.toContain("model-maple");
    expect(s.nodes().find(n => n.className.split(" ").includes("range-summary"))!.textContent).toContain("Total10"); expect(s.bars()).toHaveLength(7); s.page.dispose();
  });
  it("unit carries selection and range changes clear it", async () => {
    const d = overviewFixture(); d.range.buckets = [d.buckets[4]!.key]; const s = setup(undefined, d); await settle();
    button(s.root, "Tokens").click(); const unit = s.routes.at(-1)!.route; expect(unit.page === "overview" && unit.query.unit).toBe("tokens"); expect(unit.page === "overview" && unit.query.buckets).toEqual([d.buckets[4]!.key]);
    button(s.root, "24 h").click(); const range = s.routes.at(-1)!.route; expect(range.page === "overview" && range.query.buckets).toEqual([]); s.page.dispose();
  });
  it("rejects custom local ranges over 93 days without a request", async () => {
    const s = setup(); await settle(); button(s.root, "Custom").click(); const inputs = elements(s.root, "input");
    inputs[0]!.value = "2030-01-01T00:00"; inputs[1]!.value = "2030-05-01T00:00"; button(s.root, "Apply range").click();
    expect(s.root.textContent).toContain("93 days"); expect(s.requests).toHaveLength(1); s.page.dispose();
  });
  it("freezes expanded and sorted sessions to resolved custom bounds and opens real ids", async () => {
    const d = overviewFixture(), row = d.sessions.rows[0]!; d.sessions = sessionsFixture({ total: 12, nextOffset: 10, rows: Array.from({ length: 10 }, (_, i) => ({ ...row, id: `session-${i}`, name: `Session ${i}` })) });
    const s = setup(async path => envelope(path === "/api/sessions" ? sessionsFixture({ total: 12, offset: 10, rows: [{ ...row, id: "session-10" }, { ...row, id: "session-11" }] }) : d), d); await settle();
    expect(s.nodes().filter(n => n.getAttribute("data-session") !== null)).toHaveLength(10);
    button(s.root, "Show all 12").click(); await settle(); const r = s.requests.at(-1)!;
    expect(r.path).toBe("/api/sessions"); expect(r.params.get("range")).toBe("custom"); expect(r.params.get("from")).toBe(String(d.range.from)); expect(r.params.get("to")).toBe(String(d.range.to)); expect(r.params.get("offset")).toBe("10");
    expect(s.nodes().filter(n => n.getAttribute("data-session") !== null)).toHaveLength(12);
    const rowNode = s.nodes().find(n => n.getAttribute("data-session") === "session-0")!; fire(rowNode, "keydown", { key: "Enter", target: rowNode }); expect(s.routes.at(-1)!.route).toMatchObject({ page: "session", id: "session-0" }); s.page.dispose();
  });
  it("drops old expansion when refreshed selection has changed", async () => {
    let finish!: (reply: ApiEnvelope<unknown>) => void;
    const d = overviewFixture(); d.sessions.total = 12; d.sessions.nextOffset = 1;
    const s = setup(async (path, params) => { if (path === "/api/sessions") return new Promise(resolve => { finish = resolve; }); const data = structuredClone(d); data.range.buckets = JSON.parse(params.get("buckets") ?? "[]"); return envelope(data); }, d); await settle();
    button(s.root, "Show all 12").click(); await settle(); fire(s.bars()[4]!, "keydown", { key: " " }); await settle();
    finish(envelope(sessionsFixture({ rows: [{ ...d.sessions.rows[0]!, name: "Stale row" }] }))); await settle();
    expect(s.root.textContent).not.toContain("Stale row"); expect(s.requests.find(r => r.path === "/api/sessions")!.signal!.aborted).toBe(true); s.page.dispose();
  });
  it("reconciles server-pruned keys once without a request or remount loop", async () => {
    const initial = overviewFixture(); initial.range.buckets = [1, initial.buckets[4]!.key];
    const s = setup(async () => { const d = overviewFixture(); d.range.buckets = [d.buckets[4]!.key]; return envelope(d); }, initial); await settle();
    expect(s.requests).toHaveLength(1); expect(s.routes.at(-1)).toMatchObject({ replace: true, route: { query: { buckets: [Date.UTC(2030, 3, 12)] } } }); s.page.dispose();
  });
  it("labels repeated local hours with distinct offsets and selects both keys", async () => {
    const d = overviewFixture(); d.bucketSize = "hour"; d.range.tz = "America/New_York";
    d.buckets = [Date.UTC(2030, 10, 3, 5), Date.UTC(2030, 10, 3, 6)].map(key => ({ ...d.buckets[4]!, key, start: key, end: key + 3600000 })); d.range.from = d.buckets[0]!.key; d.range.to = d.buckets[1]!.end;
    const s = setup(async (_path, params) => { const data = structuredClone(d); data.range.buckets = JSON.parse(params.get("buckets") ?? "[]"); return envelope(data); }, d); await settle();
    expect(s.bars()[0]!.getAttribute("aria-label")).toContain("UTC-04:00"); expect(s.bars()[1]!.getAttribute("aria-label")).toContain("UTC-05:00");
    fire(s.bars()[0]!, "keydown", { key: " " }); await settle(); fire(s.bars()[1]!, "keydown", { key: " " }); await settle(); expect(s.requests.at(-1)!.params.get("buckets")).toBe("[1919912400000,1919916000000]"); s.page.dispose();
  });
  it("settles empty sections while retaining pace", async () => {
    const d = overviewFixture({ buckets: [], models: [], sessions: sessionsFixture({ rows: [], total: 0 }), flow: { total: overviewFixture().total, edges: [], models: [] } }); d.total.calls = 0;
    const s = setup(undefined, d); await settle(); expect(s.root.textContent).toContain("No calls in this range."); expect(s.root.textContent).not.toContain("Loading"); expect(s.root.children[0]!.className).toBe("month-pace"); s.page.dispose();
  });
  it("network errors settle and Retry fetches again; disposal ignores late data", async () => {
    let failure = true; const s = setup(async () => { if (failure) throw new Error("offline"); return envelope(overviewFixture()); }); await settle(); expect(s.root.textContent).not.toContain("Loading"); failure = false; button(s.root, "Retry").click(); await settle(); expect(s.root.textContent).toContain("Daily credits"); s.page.dispose(); expect(s.requests.at(-1)!.signal!.aborted).toBe(true);
  });
  it("keeps model colours on unselected bars and visible date labels", async () => {
    const s = setup(async (_path, params) => { const d = overviewFixture(); d.range.buckets = JSON.parse(params.get("buckets") ?? "[]"); if (d.range.buckets.length) { d.models = [d.models[0]!]; d.flow.models = d.models; } return envelope(d); }); await settle();
    expect(s.bars()[5]!.children[1]!.getAttribute("fill")).toBe("#91c7e5");
    fire(s.bars()[4]!, "keydown", { key: " " }); await settle(); expect(s.bars()[5]!.children[1]!.getAttribute("fill")).toBe("#91c7e5");
    const svg = s.nodes().find(n => n.className === "daily-chart")!;
    expect(elements(svg, "text").map(n => n.textContent)).toContain("Fri 12 APR"); s.page.dispose();
  });
  it("known full-range model colours survive a unit remount with selected-only rows", async () => {
    const s = setup(async (_path, params) => { const d = overviewFixture(); d.range.unit = params.get("unit") === "tokens" ? "tokens" : "credits"; d.range.buckets = JSON.parse(params.get("buckets") ?? "[]"); if (d.range.buckets.length) { d.models = [d.models[0]!]; d.flow.models = d.models; } return envelope(d); }); await settle();
    fire(s.bars()[4]!, "click", { button: 0, ctrlKey: true }); await settle(); const selected = s.routes.at(-1)!.route;
    s.page.dispose(); const page = mountOverview({ ...s.ctx, route: selected.page === "overview" ? { ...selected, query: { ...selected.query, unit: "tokens" } } : selected }); await settle();
    expect(s.bars()[5]!.children[1]!.getAttribute("fill")).toBe("#91c7e5"); page.dispose();
  });
  it("flow uses model colours and code-face model ids", async () => {
    const s = setup(); await settle(); const section = s.nodes().find(n => n.getAttribute("data-panel") === "flow")!;
    const paths = elements(section, "path").filter(n => n.getAttribute("stroke-width") !== null);
    expect(paths[0]!.getAttribute("stroke")).toBe("#f8785c");
    expect(elements(section, "text").find(n => n.textContent === "model-maple")!.className).toBe("numeric");
    expect(descendants(section).filter(n => n.getAttribute("data-model-node") !== null)).toHaveLength(2); s.page.dispose();
  });
  it("latest refresh wins when the client ignores aborted requests", async () => {
    let finish!: (reply: ApiEnvelope<unknown>) => void, first = true;
    const s = setup(async () => { if (first) { first = false; return new Promise(resolve => { finish = resolve; }); } const d = overviewFixture(); d.models[0]!.note = "Latest data"; return envelope(d); });
    await s.page.refresh(); finish(envelope(overviewFixture())); await settle(); expect(s.root.textContent).toContain("Latest data"); expect(s.requests[0]!.signal!.aborted).toBe(true); s.page.dispose();
  });
  it("tokens changes every page heading and tooltip except credit pace", async () => {
    const d = overviewFixture(); d.range.unit = "tokens"; const s = setup(undefined, d); await settle(); expect(s.root.textContent).toContain("Daily tokens"); expect(s.root.textContent).toContain("960"); expect(s.bars()[4]!.getAttribute("aria-label")).toContain("480 tokens"); expect(s.root.children[0]!.textContent).toContain("40"); s.page.dispose();
  });
});

it.each(["day", "hour"] as const)("labels Average and Peak in %s buckets with compact amounts and a date", async bucketSize => {
  const d = overviewFixture(); d.bucketSize = bucketSize; d.total.credits = 118400; d.buckets[4]!.total.credits = 31200;
  const s = setup(undefined, d); await settle();
  const summary = s.nodes().find(n => n.className === "range-summary summary-chips")!;
  expect(summary.children[1]!.textContent).toBe(`Average16.9k ${bucketSize === "day" ? "a day" : "an hour"}`);
  expect(summary.children[2]!.textContent).toBe(`Peak${bucketSize === "day" ? "Fri 12 APR" : "Fri 12 APR 00:00 UTC+00:00"} · 31.2k`); s.page.dispose();
});
