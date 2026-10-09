import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountOverview } from "../web/overview.js";
import { overviewFixture, sessionsFixture, envelope } from "./fixtures/redesign-contract.js";
import { PlainDocument, PlainElement, descendants, button, elements, settle, cellText } from "./fixtures/plain-dom.js";
import type { DashboardPageContext, DashboardRouteV4, OverviewDataV4 } from "../dashboard-v4-contract.js";
import type { ApiEnvelope } from "../dashboard-contract.js";
const NOW = Date.UTC(2030, 3, 15), DAY = 86400000;
const intersections: { callback: IntersectionObserverCallback; root: Element | Document | null | undefined; targets: Element[]; disconnected: boolean }[] = [];
beforeEach(() => {
  intersections.length = 0;
  vi.stubGlobal("IntersectionObserver", class {
    record: typeof intersections[number];
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) { this.record = { callback, root: options.root, targets: [], disconnected: false }; intersections.push(this.record); }
    observe(target: Element) { this.record.targets.push(target); }
    disconnect() { this.record.disconnected = true; }
  });
});
afterEach(() => vi.unstubAllGlobals());
function nearEnd() {
  const observer = intersections.findLast(o => !o.disconnected && o.targets.length && !(o.root as unknown as PlainElement)?.hidden);
  expect(observer, "a live sessions sentinel observer").toBeDefined();
  observer!.callback([{ isIntersecting: true, target: observer!.targets[0]! } as IntersectionObserverEntry], {} as IntersectionObserver);
}
function setup(get?: (path: string, params: URLSearchParams) => Promise<ApiEnvelope<unknown>>, initial = overviewFixture(), prepare?: (doc: PlainDocument) => void) {
  const doc = new PlainDocument(); prepare?.(doc); const root = doc.createElement("main"); doc.body.append(root);
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
    ["credits", 4, ["0", "1", "2", "3", "4"]],
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
  it("freezes paginated and sorted sessions to resolved custom bounds and opens real ids", async () => {
    const d = overviewFixture(), row = d.sessions.rows[0]!; d.sessions = sessionsFixture({ total: 12, nextOffset: 10, rows: Array.from({ length: 10 }, (_, i) => ({ ...row, id: `session-${i}`, name: `Session ${i}` })) });
    const s = setup(async path => envelope(path === "/api/sessions" ? sessionsFixture({ total: 12, offset: 10, rows: [{ ...row, id: "session-10" }, { ...row, id: "session-11" }] }) : d), d); await settle();
    expect(s.nodes().filter(n => n.getAttribute("data-session") !== null)).toHaveLength(10);
    nearEnd(); await settle(); const r = s.requests.at(-1)!;
    expect(r.path).toBe("/api/sessions"); expect(r.params.get("range")).toBe("custom"); expect(r.params.get("from")).toBe(String(d.range.from)); expect(r.params.get("to")).toBe(String(d.range.to)); expect(r.params.get("offset")).toBe("10");
    expect(s.nodes().filter(n => n.getAttribute("data-session") !== null)).toHaveLength(12);
    const rowNode = s.nodes().find(n => n.getAttribute("data-session") === "session-0")!; elements(rowNode, "button")[0]!.click(); expect(s.routes.at(-1)!.route).toMatchObject({ page: "session", id: "session-0" }); s.page.dispose();
  });
  it("drops old expansion when refreshed selection has changed", async () => {
    let finish!: (reply: ApiEnvelope<unknown>) => void;
    const d = overviewFixture(); d.sessions.total = 12; d.sessions.nextOffset = 1;
    const s = setup(async (path, params) => { if (path === "/api/sessions") return new Promise(resolve => { finish = resolve; }); const data = structuredClone(d); data.range.buckets = JSON.parse(params.get("buckets") ?? "[]"); return envelope(data); }, d); await settle();
    nearEnd(); await settle(); fire(s.bars()[4]!, "keydown", { key: " " }); await settle();
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
    const paths = elements(section, "path").filter(n => n.hasAttribute("data-flow-role"));
    expect(paths[0]!.getAttribute("fill")).toBe("#f8785c");
    expect(elements(section, "text").find(n => n.textContent === "model-maple")!.className.split(" ")).toContain("numeric");
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

it("24-hour data has an Hourly credits heading", async () => {
  const d = overviewFixture(); d.bucketSize = "hour"; d.range.range = "24h";
  const s = setup(undefined, d); await settle();
  expect(elements(s.root, "h2").map(n => n.textContent)).toContain("Hourly credits"); s.page.dispose();
});
it("clicking toolbar padding preserves the selected buckets", async () => {
  const d = overviewFixture(); d.range.buckets = [d.buckets[4]!.key];
  const s = setup(undefined, d); await settle();
  fire(s.doc, "click", { target: s.nodes().find(n => n.hasAttribute("data-controls"))! }); await settle();
  expect(s.requests).toHaveLength(1); expect(s.root.textContent).toContain("Selected 1 day"); s.page.dispose();
});
it("session name buttons are the only open controls and role focus roves within and between rows", async () => {
  const d = overviewFixture(), first = d.sessions.rows[0]!;
  d.sessions.rows = [first, { ...structuredClone(first), id: "second-session", name: "Second session" }];
  const s = setup(undefined, d); await settle();
  const rows = s.nodes().filter(n => n.hasAttribute("data-session"));
  expect(rows.every(n => !n.hasAttribute("tabindex"))).toBe(true);
  const names = rows.map(n => elements(n, "button")[0]!);
  names[0]!.focus(); fire(names[0]!, "keydown", { key: "ArrowDown" }); expect(s.doc.activeElement).toBe(names[1]);
  fire(names[1]!, "keydown", { key: "ArrowUp" }); expect(s.doc.activeElement).toBe(names[0]);
  const segments = rows.map(n => descendants(n).filter(n => n.className === "role-segment"));
  expect(segments.map(list => list.filter(n => n.getAttribute("tabindex") === "0").length)).toEqual([1, 1]);
  fire(segments[0]![0]!, "keydown", { key: "ArrowRight" }); expect(s.doc.activeElement).toBe(segments[0]![1]);
  expect(segments[0]!.map(n => n.getAttribute("tabindex"))).toEqual(segments[0]!.map((_, i) => i === 1 ? "0" : "-1"));
  fire(segments[0]![1]!, "keydown", { key: "ArrowDown" }); expect(s.doc.activeElement).toBe(segments[1]![1]);
  fire(segments[1]![1]!, "keydown", { key: "ArrowUp" }); expect(s.doc.activeElement).toBe(segments[0]![1]);
  names[0]!.click(); expect(s.routes.at(-1)!.route).toMatchObject({ page: "session", id: first.id }); s.page.dispose();
});
it("a preserved sort never flashes credits-ranked rows while its refreshed page is pending", async () => {
  let release!: (value: ApiEnvelope<unknown>) => void, delayed = false;
  const d = overviewFixture(), sorted = sessionsFixture({ rows: [{ ...d.sessions.rows[0]!, name: "Sorted result" }] });
  const s = setup(async path => path === "/api/sessions" ? delayed ? new Promise(resolve => { release = resolve; }) : envelope(sorted) : envelope(d));
  await settle(); s.nodes().find(n => n.getAttribute("data-focus") === "session-sort-runs")!.click(); await settle();
  delayed = true; const refresh = s.page.refresh(); await settle();
  expect(s.nodes().find(n => n.getAttribute("data-panel") === "sessions")!.textContent).toContain("Sorted result");
  release(envelope(sorted)); await refresh; s.page.dispose();
});

it("role breakdown keeps a roving stop when refreshed roles shrink", async () => {
  const d = overviewFixture(), s = setup(undefined, d); await settle();
  const roles = () => s.nodes().filter(n => n.className === "role-segment");
  fire(roles()[0]!, "keydown", { key: "End" });
  d.sessions.rows[0]!.roles = d.sessions.rows[0]!.roles.slice(0, 1);
  await s.page.refresh();
  expect(roles()).toHaveLength(1); expect(roles()[0]!.getAttribute("tabindex")).toBe("0"); s.page.dispose();
});

it("sessions expose cost-first rank and share in both representations", async () => {
  const d = overviewFixture(), row = d.sessions.rows[0]!;
  d.sessions.rows = [row, { ...structuredClone(row), id: "second", name: "Second", value: { ...row.value, credits: 2 } }];
  const s = setup(undefined, d); await settle();
  const section = s.nodes().find(n => n.getAttribute("data-panel") === "sessions")!;
  const tables = elements(section, "table");
  for (const table of tables) {
    expect(elements(table, "th").map(n => n.textContent)).toEqual(["Rank", "Session", "Credits", "Share", "Breakdown", "Last active", "Runs"]);
    const rows = elements(table, "tbody")[0]!.children;
    expect(rows.map(r => cellText(r.children[0]!))).toEqual(["1", "2"]);
    expect(rows.map(r => cellText(r.children[3]!))).toEqual(["100%", "20%"]);
    expect(elements(table, "th")[2]!.getAttribute("aria-sort")).toBe("descending");
    expect(elements(elements(table, "th")[2]!, "svg")).toHaveLength(1);
    expect(rows[0]!.children[1]!.textContent).toContain("garden");
  }
  button(section, "Table").click(); expect(button(section, "Table").getAttribute("aria-pressed")).toBe("true"); s.page.dispose();
});
it("capture-scale daily ticks fit the peak and selected outline hugs the stack", async () => {
  const d = overviewFixture(); d.buckets = [d.buckets[4]!]; d.range.buckets = [d.buckets[0]!.key];
  d.buckets[0]!.total.credits = 31200; d.buckets[0]!.models[0]!.value.credits = 31200;
  const s = setup(undefined, d); await settle(); const svg = s.nodes().find(n => n.className === "daily-chart")!;
  expect(elements(svg, "text").filter(n => n.getAttribute("text-anchor") === "end").map(n => n.textContent)).toEqual(["0", "10k", "20k", "30k", "40k"]);
  expect(elements(svg, "text").find(n => n.textContent === "credits")!.className).not.toContain("numeric");
  const rects = elements(s.bars()[0]!, "rect"), bar = rects[1]!, outline = rects.at(-1)!;
  expect(Number(outline.getAttribute("y"))).toBeCloseTo(Number(bar.getAttribute("y")) - 3, 8);
  expect(Number(outline.getAttribute("height"))).toBeCloseTo(Number(bar.getAttribute("height")) + 6, 8);
  s.page.dispose();
});

it("sessions and model representations expose labelled keyboard scroll regions without Show all", async () => {
  const d = overviewFixture(); d.sessions.nextOffset = 1; d.sessions.total = 20;
  const s = setup(undefined, d); await settle();
  for (const label of ["Models list", "Models table", "Sessions chart", "Sessions table"]) {
    const region = s.nodes().find(n => n.getAttribute("aria-label") === label)!;
    expect(region, label).toBeDefined(); expect(region.getAttribute("tabindex")).toBe("0");
  }
  expect(s.root.textContent).not.toContain("Show all");
  expect(intersections.filter(o => !o.disconnected)).toHaveLength(2);
  s.page.dispose(); expect(intersections.every(o => o.disconnected)).toBe(true);
});
it("loads only one next page in flight, appends ranks, preserves total and stops at the end", async () => {
  const d = overviewFixture(), row = d.sessions.rows[0]!;
  d.sessions = sessionsFixture({ total: 30, nextOffset: 10, rows: Array.from({ length: 10 }, (_, i) => ({ ...row, id: `paged-${i}` })) });
  let finish!: (reply: ApiEnvelope<unknown>) => void;
  const s = setup(async path => path === "/api/sessions" ? new Promise(resolve => { finish = resolve; }) : envelope(d), d); await settle();
  const scroll = s.nodes().find(n => n.getAttribute("aria-label") === "Sessions chart")!;
  const unaffected = s.root.children.filter(n => !n.hasAttribute("data-panel") || n.getAttribute("data-panel") !== "sessions");
  Object.assign(scroll, { scrollTop: 240 }); scroll.focus();
  nearEnd(); nearEnd(); await settle();
  expect(s.requests.filter(r => r.path === "/api/sessions")).toHaveLength(1);
  expect(s.requests.at(-1)!.params.get("limit")).toBe("50");
  finish(envelope(sessionsFixture({ total: 30, offset: 10, nextOffset: 20, rows: Array.from({ length: 10 }, (_, i) => ({ ...row, id: `paged-${i + 10}` })) }))); await settle();
  expect(s.nodes().filter(n => n.hasAttribute("data-session"))).toHaveLength(20);
  const unchanged = s.root.children.filter(n => n.getAttribute("data-panel") !== "sessions");
  unaffected.forEach((node, index) => expect(unchanged[index]).toBe(node));
  const replacement = s.nodes().find(n => n.getAttribute("aria-label") === "Sessions chart")!;
  expect((replacement as unknown as HTMLElement).scrollTop).toBe(240); expect(s.doc.activeElement).toBe(replacement);
  nearEnd(); await settle(); expect(s.requests.at(-1)!.params.get("offset")).toBe("20");
  finish(envelope(sessionsFixture({ total: 30, offset: 20, nextOffset: null, rows: Array.from({ length: 10 }, (_, i) => ({ ...row, id: `paged-${i + 20}` })) }))); await settle();
  const rows = s.nodes().filter(n => n.hasAttribute("data-session")); expect(rows).toHaveLength(30); expect(cellText(rows[29]!.children[0]!)).toBe("30");
  expect(s.nodes().find(n => n.className === "stat-chip" && n.children[0]?.textContent === "Sessions")!.textContent).toBe("Sessions30");
  expect(intersections.every(o => o.disconnected)).toBe(true); s.page.dispose();
});
it("a late sessions page after disposal cannot repaint", async () => {
  const d = overviewFixture(); d.sessions.nextOffset = 1;
  let finish!: (reply: ApiEnvelope<unknown>) => void;
  const s = setup(async path => path === "/api/sessions" ? new Promise(resolve => { finish = resolve; }) : envelope(d), d); await settle();
  nearEnd(); await settle(); s.page.dispose();
  finish(envelope(sessionsFixture({ rows: [{ ...d.sessions.rows[0]!, name: "Late sessions page" }] }))); await settle();
  expect(s.root.textContent).not.toContain("Late sessions page"); expect(s.requests.at(-1)!.signal!.aborted).toBe(true);
});

it("daily chart releases its observer, resize listener and pending frame on repaint and disposal", async () => {
  const observers: { target?: Element; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    record = { target: undefined as Element | undefined, disconnect: vi.fn() };
    constructor() { observers.push(this.record); }
    observe(target: Element) { this.record.target = target; }
    disconnect() { this.record.disconnect(); }
  });
  const view = new EventTarget(); let frame = 0;
  const add = vi.spyOn(view, "addEventListener"), remove = vi.spyOn(view, "removeEventListener");
  const request = vi.fn(() => ++frame), cancel = vi.fn();
  Object.assign(view, { requestAnimationFrame: request, cancelAnimationFrame: cancel });
  const s = setup(undefined, overviewFixture(), doc => {
    Object.defineProperty(doc, "defaultView", { value: view });
    const create = doc.createElementNS.bind(doc);
    vi.spyOn(doc, "createElementNS").mockImplementation((ns, tag) => {
      const node = create(ns, tag);
      if (tag === "svg") Object.defineProperty(node, "getBoundingClientRect", { value: () => ({ width: 0, height: 0 }) });
      return node;
    });
  });
  try {
    await settle();
    const first = observers.find(o => (o.target as unknown as PlainElement)?.className === "daily-chart")!;
    expect(first).toBeDefined(); expect(request).toHaveBeenCalledOnce();
    // Pace registers first; the daily listener is the last resize registration.
    const dailyResize = add.mock.calls.filter(([kind]) => kind === "resize").at(-1)![1];
    await s.page.refresh();
    expect(first.disconnect).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith("resize", dailyResize);
    expect(cancel).toHaveBeenCalledWith(1);
    const latest = observers.findLast(o => (o.target as unknown as PlainElement)?.className === "daily-chart")!;
    const latestResize = add.mock.calls.filter(([kind]) => kind === "resize").at(-1)![1];
    expect(latest).not.toBe(first); expect(request).toHaveBeenCalledTimes(2);
    s.page.dispose();
    expect(latest.disconnect).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith("resize", latestResize);
    expect(cancel).toHaveBeenCalledWith(2);
  } finally { s.page.dispose(); }
});
