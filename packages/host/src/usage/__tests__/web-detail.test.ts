import { describe, expect, it, vi } from "vitest";
import type { ApiEnvelope, CalibrationResult, UsageMeasure } from "../dashboard-contract.js";
import type { DetailCall, DetailData } from "../query-detail.js";
import type { ViewRoute } from "../web/views.js";
import { formatAicDisplay, formatTokens } from "../web/format.js";
import { createDashboardClient, DashboardClientError } from "../web/client.js";
import { PlainDocument, button, elements, settle } from "./fixtures/plain-dom.js";

const period = { start: 0, end: 172800000 };
const fit: CalibrationResult = { status: "calibrated", factor: 0.56, windowStart: 0, windowEnd: 604800000, coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: 0, method: "trailing-7d-ratio" };
const unavailable = { status: "unavailable" as const, phase: 2 as const, reason: "not-built" as const, message: "Not available yet (Phase 2)" as const };
function measure(): UsageMeasure {
  return { calls: 2, pricedCalls: 2, unpricedCalls: 0, aggregateCalls: 0,
    tokens: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, prompt: 60, total: 100, cacheWrite1h: null, reasoning: null },
    aic: 1000, aicDisplay: { primaryAic: 560, publishedAic: 1000, basis: "calibrated" }, aicComponents: { input: 100, cacheRead: 200, cacheWrite: 300, output: 400 },
    piCost: null, possibleOverlap: false, possibleUndercount: false, pendingData: false, estimated: false };
}
function call(id: string): DetailCall {
  return { id, ts: id === "call-1" ? 1000 : 86401000, sessionId: "session-fixture", runId: "run-fixture", project: { key: "v1_project", label: "~/fixture" }, repo: null,
    actor: "subagent", role: "worker", agent: "fixture-agent", runName: "fixture-run", phase: null, parentRunId: "parent-run", auxPurpose: null,
    provider: "fixture-provider", model: "fixture-model", requestedModel: null, thinking: "high", api: "fixture-api", latencyMs: null, aggregate: false, measure: measure() };
}
function detail(): DetailData {
  return { kind: "run", id: "run-fixture", calibration: fit, totals: measure(), timeline: [
    { start: 0, end: 86400000, label: "first interval", measure: measure() },
    { start: 86400000, end: 172800000, label: "second interval", measure: { ...measure(), aic: null, pricedCalls: 0, unpricedCalls: 2, aicDisplay: { primaryAic: null, publishedAic: null, basis: "published" } } }],
    calls: { rows: [call("call-1")], nextCursor: "calls-next" }, links: { rows: [], nextCursor: null },
    accounting: { status: "selected", coveringRunId: null, message: "Only globally selected representations are counted; unpriced calls keep unknown AIC." },
    contextFillPercent: null, contextFillMessage: "Context fill unavailable: historical window not recorded", composition: unavailable, carry: unavailable, itemReuse: unavailable };
}
function envelope<T>(data: T): ApiEnvelope<T> { return { apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data }; }
function fixture(response: (path: string, params: URLSearchParams) => Response | unknown = () => detail()) {
  const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const requests: string[] = [], routes: ViewRoute[] = [];
  const client = createDashboardClient(async input => {
    const url = new URL(String(input), "http://127.0.0.1:10000"); requests.push(url.pathname + url.search);
    const result = response(url.pathname, url.searchParams);
    return result instanceof Response ? result : new Response(JSON.stringify(envelope(result)));
  });
  const controller = new AbortController();
  return { doc, root, requests, routes, controller, ctx: { document: doc.asDocument(), root: root as unknown as HTMLElement, client, period,
    filters: [{ field: "actor" as const, value: "subagent" }], signal: controller.signal, navigate(route: ViewRoute) { routes.push(route); }, kind: "run" as const, id: "run-fixture" } };
}
function panel(root: Parameters<typeof elements>[0], heading: string) {
  const found = elements(root, "section").find(node => node.children.some(child => /^H[23]$/.test(child.tagName) && child.textContent === heading));
  expect(found, `panel ${heading}`).toBeDefined(); return found!;
}
function tableRows(root: Parameters<typeof elements>[0], caption: string): string[][] {
  const found = elements(root, "table").find(node => elements(node, "caption")[0]?.textContent === caption);
  expect(found, `table ${caption}`).toBeDefined(); return elements(found!, "tr").slice(1).map(row => row.children.map(cell => cell.children.find(n => n.className === "cell-value")?.textContent ?? cell.textContent));
}

describe("web Detail", () => {
  it("Session timeline pairs exact prompt tokens and recorded subset observations", async () => {
    // Break caught: omitting token types, summing subsets into prompt/total, or treating a missing subset as numeric zero.
    const { mountDetail } = await import("../web/detail.js");
    const data = detail(); data.kind = "session"; data.id = "session-fixture"; data.timeline[0]!.measure.tokens.cacheWrite1h = 0; data.timeline[0]!.measure.tokens.reasoning = 5;
    data.timeline[0]!.measure.aicDisplay.basis = "back-applied"; data.timeline[0]!.measure.unpricedCalls = 1;
    const f = fixture(() => data), view = await mountDetail({ ...f.ctx, kind: "session", id: "session-fixture" }); await settle();
    expect(elements(f.root, "h1")[0]!.textContent).toBe("Session · session-fixture");
    const timeline = panel(f.root, "Call timeline");
    for (const [name, value] of [["input", "10"], ["cache read", "20"], ["cache write", "30"], ["prompt", "60"], ["output", "40"]]) {
      const chart = panel(timeline, `Timeline ${name} tokens`); expect(tableRows(chart, `Timeline ${name} tokens`)[0]![2]).toBe(`${value} tokens`);
      expect(elements(chart, "title")[1]!.textContent).toContain(`${value} tokens`); expect(elements(chart, "title")[1]!.textContent).toContain("total 100");
    }
    for (const [name, value] of [["cache write 1h", "0"], ["reasoning", "5"]]) {
      const chart = panel(timeline, `Timeline ${name} tokens (subset)`); const rows = tableRows(chart, `Timeline ${name} tokens (subset)`);
      expect(rows[0]![2]).toBe(`${value} tokens`); expect(rows[1]![2]).toBe("unavailable"); expect(elements(chart, "circle")).toHaveLength(1);
    }
    const backApplied = panel(timeline, "Timeline AIC · calibrated, back-applied");
    const value = `${formatTokens(data.timeline[0]!.measure.aicDisplay.primaryAic!)}+ AIC calibrated, back-applied`;
    expect(tableRows(backApplied, "Timeline AIC · calibrated, back-applied")[0]![2]).toBe(value);
    expect(tableRows(backApplied, "Timeline AIC · calibrated, back-applied")[0]![4]).toContain(formatAicDisplay(data.timeline[0]!.measure.aicDisplay, 1, fit).primary);
    const caption = elements(backApplied, "p").find(n => n.className.split(" ").includes("chart-summary"))!;
    expect(caption.textContent).toBe(`first interval · ${value} minimum · ${value} maximum`);
    expect(elements(backApplied, "svg")[0]!.getAttribute("aria-label")).toBe(`Timeline AIC · calibrated, back-applied · ${caption.textContent}`);
    expect(elements(panel(timeline, "Timeline AIC · calibrated, back-applied"), "title")[1]!.textContent).toContain("calibrated, back-applied");
    expect(new URL(f.requests[0]!, "http://127.0.0.1").searchParams.get("kind")).toBe("session");
    view.dispose();
  });
  it("Detail refreshes only while visible active and unfocused and stops on shutdown", async () => {
    // Break caught: background/abandoned polling, stealing evidence focus, or continuing after shutdown/disposal.
    vi.useFakeTimers();
    try {
      const { mountDetail } = await import("../web/detail.js"); let online = true;
      const f = fixture(() => { if (!online) throw new TypeError("fixture shutdown"); return detail(); });
      const view = await mountDetail(f.ctx); await settle();
      expect(f.requests).toHaveLength(1); await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(2);
      f.doc.visibilityState = "hidden"; await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(2);
      f.doc.visibilityState = "visible"; const timeline = panel(f.root, "Call timeline"); button(timeline, "Table").focus(); await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(2);
      f.doc.activeElement = null; await vi.advanceTimersByTimeAsync(120000); expect(f.requests).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(3);
      f.doc.dispatchEvent(new Event("keydown")); online = false; await vi.advanceTimersByTimeAsync(60000);
      expect(f.root.textContent).toContain("Run /usage again"); expect(f.requests).toHaveLength(4);
      f.doc.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(120000); expect(f.requests).toHaveLength(4);
      online = true; button(f.root, "Retry").click(); await settle(); expect(f.requests).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(6);
      f.controller.abort(); const before = f.root.textContent; await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(6); expect(f.root.textContent).toBe(before);
      expect(f.doc.listeners.get("keydown")?.size ?? 0).toBe(0); expect(f.doc.listeners.get("pointerdown")?.size ?? 0).toBe(0); expect(vi.getTimerCount()).toBe(0); view.dispose();
      const aborted = fixture(); aborted.controller.abort(); const inactive = await mountDetail(aborted.ctx); await settle(); expect(aborted.requests).toHaveLength(0); expect(vi.getTimerCount()).toBe(0); inactive.dispose();
    } finally { vi.useRealTimers(); }
  });
  it.each(["calls", "relationships"])("Detail resets a changed %s cursor cleanly", async mode => {
    // Break caught: keeping stale evidence/history or replaying a 409 cursor on Retry/Refresh.
    const { mountDetail } = await import("../web/detail.js");
    const data = detail(); data.links.nextCursor = "links-next";
    let changed = false;
    const f = fixture((_path, params) => {
      if (params.has("cursor")) { changed = true; return new Response(JSON.stringify({ apiVersion: 1, error: { code: "ledger-changed", message: "private failure must not render" } }), { status: 409 }); }
      return changed ? { ...data, calls: { rows: [call("new-first-page")], nextCursor: null } } : data;
    });
    const view = await mountDetail(f.ctx); await settle();
    const page = panel(f.root, mode === "calls" ? "Calls" : "Related sessions and runs");
    button(page, "Next page").click(); await settle();
    expect(f.root.textContent).toContain("Usage changed. Refresh to start a new page."); expect(f.root.textContent).not.toContain("private failure");
    expect(elements(f.root, "table")).toHaveLength(0); expect(elements(f.root, "svg")).toHaveLength(0);
    for (const label of ["Next page", "Previous page"]) expect(elements(f.root, "button").filter(node => node.textContent === label).every(node => node.disabled)).toBe(true);
    const restart = button(f.root, "Refresh"); restart.focus(); restart.click(); await settle();
    expect(tableRows(f.root, "Recorded calls")[0]![0]).toBe("new-first-page"); expect(button(panel(f.root, "Calls"), "Previous page").disabled).toBe(true);
    expect(f.doc.activeElement).toBe(restart);
    const last = new URL(f.requests.at(-1)!, "http://127.0.0.1"); expect(last.pathname).toBe("/api/detail"); expect(last.searchParams.has("cursor")).toBe(false);
    expect(f.requests).toHaveLength(3); view.dispose();
  });
  it("Detail shows only recorded latency and subsets and keeps hostile labels inert", async () => {
    // Break caught: hiding recorded zero latency/subsets, inventing absent measures, or interpreting attribution labels as markup.
    const { mountDetail } = await import("../web/detail.js");
    const hostile = '<img src=x onerror="alert(1)"><script>bad()</script>';
    const data = detail(), first = call("call-1"), second = call("call-2");
    first.model = first.runName = first.role = first.agent = hostile; first.project = { key: "v1_project", label: hostile }; first.repo = { key: "v1_repo", label: "~/fixture-repo" };
    first.requestedModel = "fixture-request"; first.phase = "build"; first.auxPurpose = "fixture-purpose"; first.latencyMs = 0; first.aggregate = true;
    first.measure.tokens.cacheWrite1h = 0; first.measure.tokens.reasoning = 5;
    second.sessionId = second.runId = second.parentRunId = null;
    data.calls = { rows: [first, second], nextCursor: null };
    data.links = { rows: [{ kind: "run", id: "hostile-child", relationship: "child", label: hostile, ongoing: false }], nextCursor: null };
    const f = fixture(() => data); const view = await mountDetail(f.ctx); await settle();
    const calls = panel(f.root, "Calls"), rows = tableRows(calls, "Recorded calls");
    expect(rows[0]![4]!.split("; ")).toContain("cache write 1h 0"); expect(rows[0]![4]).toContain("reasoning 5");
    expect(rows[1]![4]).not.toMatch(/cache write 1h|reasoning/); expect(rows[0]!.at(-1)).toBe("0 ms"); expect(rows[1]!.at(-1)).toBe("Not recorded");
    for (const text of [hostile, "fixture-request", "build", "fixture-purpose", "fixture-provider", "fixture-api", "high", "~/fixture-repo"]) expect(rows[0]![6]).toContain(text);
    expect(rows[0]![5]).toContain("Aggregate report; per-call transcript detail unavailable");
    const lines = elements(elements(calls, "table")[0]!, "tr").slice(1);
    expect(elements(lines[1]!, "button")).toHaveLength(0);
    button(lines[0]!, "Session · session-fixture").click(); button(lines[0]!, "Run · run-fixture").click(); button(lines[0]!, "Parent run · parent-run").click();
    expect(f.routes.map(route => [route.view, route.id])).toEqual([["session", "session-fixture"], ["run", "run-fixture"], ["run", "parent-run"]]);
    button(panel(f.root, "Related sessions and runs"), `${hostile} · le-child`).click(); expect(f.routes.at(-1)?.id).toBe("hostile-child");
    expect(elements(f.root, "img")).toHaveLength(0); expect(elements(f.root, "script")).toHaveLength(0);
    for (const tag of ["section", "td", "button", "p", "svg", "circle"]) for (const node of elements(f.root, tag)) for (const [name, value] of node.attributes) {
      expect(name).not.toMatch(/^on|^style$/i); expect(value).not.toContain(hostile);
    }
    view.dispose();
  });
  it("Detail relationships page independently and unsupported ids have no action", async () => {
    // Break caught: confusing child/reporting sessions, linking unsupported ids, or reloading call/timeline evidence on link paging.
    const { mountDetail } = await import("../web/detail.js");
    const data = detail(); data.links = { rows: [
      { kind: "run", id: "parent-run", relationship: "parent", label: "parent label", ongoing: false },
      { kind: "run", id: "child-run", relationship: "child", label: "child label", ongoing: true },
      { kind: "run", id: null, relationship: "child", label: "unsupported id", ongoing: false },
      { kind: "session", id: "report-session", relationship: "reporting-session", label: "report label", ongoing: false },
      { kind: "session", id: "transcript-session", relationship: "transcript-session", label: "transcript label", ongoing: false }], nextCursor: "links-next" };
    const f = fixture((path, params) => path === "/api/detail-links" ? params.has("cursor") ? { rows: [{ kind: "run", id: "last-child", relationship: "child", label: "last child", ongoing: false }], nextCursor: null } : data.links : data);
    const view = await mountDetail(f.ctx); await settle();
    const links = panel(f.root, "Related sessions and runs"), timeline = panel(f.root, "Call timeline");
    expect(tableRows(links, "Relationships")).toEqual([["Parent run", "parent label · rent-run", "Recorded"], ["Child run", "child label · hild-run", "Ongoing"], ["Child run", "unsupported id", "Recorded"], ["Reporting session", "report label · -session", "Recorded"], ["Child transcript session", "transcript label · -session", "Recorded"]]);
    expect(elements(links, "button").map(node => node.textContent)).not.toContain("unsupported id");
    button(links, "parent label · rent-run").click(); button(links, "child label · hild-run").click(); button(links, "report label · -session").click(); button(links, "transcript label · -session").click();
    expect(f.routes).toEqual([{ view: "run", id: "parent-run", filters: f.ctx.filters }, { view: "run", id: "child-run", filters: f.ctx.filters }, { view: "session", id: "report-session", filters: f.ctx.filters }, { view: "session", id: "transcript-session", filters: f.ctx.filters }]);
    button(links, "Next page").click(); await settle(); expect(tableRows(links, "Relationships")).toEqual([["Child run", "last child · st-child", "Recorded"]]);
    expect(panel(f.root, "Call timeline")).toBe(timeline); expect(tableRows(f.root, "Recorded calls")[0]![0]).toBe("call-1");
    button(links, "Previous page").click(); await settle(); expect(tableRows(links, "Relationships")).toHaveLength(5);
    expect(f.requests.map(path => new URL(path, "http://127.0.0.1").pathname)).toEqual(["/api/detail", "/api/detail-links", "/api/detail-links"]);
    expect(new URL(f.requests[1]!, "http://127.0.0.1").searchParams.get("cursor")).toBe("links-next");
    view.dispose();
  });
  it("historical fill and composition remain unavailable", async () => {
    // Break caught: fabricated context fill/composition or accounting qualifiers separated from their measures.
    const { mountDetail } = await import("../web/detail.js");
    const data = detail(); data.totals.aggregateCalls = 1; data.totals.unpricedCalls = 1; data.totals.pricedCalls = 1;
    data.totals.possibleOverlap = true; data.totals.possibleUndercount = true; data.totals.pendingData = true;
    data.accounting = { status: "aggregate", coveringRunId: null, message: "Selected aggregate report usage is counted; per-call child transcript detail is unavailable." };
    const f = fixture(() => data); const view = await mountDetail(f.ctx); await settle();
    let selected = tableRows(f.root, "Selected usage")[0]!;
    expect(selected.slice(0, 4)).toEqual(["Selected run", formatAicDisplay(data.totals.aicDisplay, data.totals.unpricedCalls, fit).primary, formatAicDisplay(data.totals.aicDisplay, data.totals.unpricedCalls, fit).secondary, "input 10; cache read 20; cache write 30; output 40; prompt 60; total 100"]);
    expect(selected[4]).toContain("Selected aggregate report usage is counted; per-call child transcript detail is unavailable.");
    expect(selected[4]).toContain("1 aggregate"); expect(selected[4]).toContain("1 unpriced"); expect(selected[4]).toContain("lower bound");
    expect(selected[4]).toContain("Possible overlap"); expect(selected[4]).toContain("Possible undercount"); expect(selected[4]).toContain("Pending data");
    expect(f.root.textContent).toContain("Context fill unavailable: historical window not recorded");
    for (const heading of ["Composition", "Carry cost", "Item reuse"]) expect(panel(f.root, heading).textContent).toContain("Not available yet (Phase 2)");
    expect(f.root.textContent).not.toMatch(/0%|cache write 1h|reasoning|latency/i);
    data.accounting = { status: "covered", coveringRunId: "covering-run", message: "Usage is included in the selected covering run report; this is not priced zero." };
    data.totals = { ...measure(), calls: 0, pricedCalls: 0, aic: null, aicDisplay: { primaryAic: null, publishedAic: null, basis: "published" } };
    button(f.root, "Refresh").click(); await settle(); selected = tableRows(f.root, "Selected usage")[0]!;
    expect(selected[1]).toBe("AIC unavailable"); expect(selected[4]).toContain("this is not priced zero");
    button(f.root, "Covering run · covering-run").click(); expect(f.routes.at(-1)).toEqual({ view: "run", id: "covering-run", filters: f.ctx.filters });
    data.accounting = { status: "selected", coveringRunId: null, message: "Only globally selected representations are counted; unpriced calls keep unknown AIC." };
    data.totals = { ...measure(), pricedCalls: 0, unpricedCalls: 2, aic: null, aicDisplay: { primaryAic: null, publishedAic: null, basis: "published" } };
    button(f.root, "Refresh").click(); await settle(); selected = tableRows(f.root, "Selected usage")[0]!;
    expect(selected[1]).toBe("unpriced AIC"); expect(selected[4]).toContain("No priced AIC is recorded");
    data.totals = { ...measure(), aic: 0, aicDisplay: { primaryAic: 0, publishedAic: 0, basis: "calibrated" } };
    button(f.root, "Refresh").click(); await settle(); expect(tableRows(f.root, "Selected usage")[0]![1]).toBe(formatAicDisplay(data.totals.aicDisplay, 0, fit).primary);
    view.dispose();
  });
  it("timeline is independent of call pagination", async () => {
    // Break caught: rebuilding the full timeline, its table toggle or calibration from a call page response.
    const module = await import("../web/detail.js").catch(() => null);
    expect(module, "Detail mount is available").not.toBeNull();
    const first = detail();
    const f = fixture((_path, params) => params.has("cursor") ? { ...detail(), calibration: { ...fit, factor: 0.9 }, timeline: [], calls: { rows: [call("call-2")], nextCursor: null } } : first);
    const view = await module!.mountDetail(f.ctx); await settle();
    const timeline = panel(f.root, "Call timeline"), before = timeline.textContent;
    const aic = panel(timeline, "Timeline AIC · calibrated"), toggle = button(aic, "Table");
    toggle.focus(); toggle.click();
    expect(f.doc.activeElement).toBe(toggle);
    const observation = tableRows(aic, "Timeline AIC · calibrated")[0]!;
    expect(observation.slice(0, 3)).toEqual(["first interval", "1 Jan 1970 to 2 Jan 1970, 00:00 UTC", `${formatTokens(first.timeline[0]!.measure.aicDisplay.primaryAic!)} AIC calibrated`]);
    expect(observation[4]).toContain(formatAicDisplay(first.timeline[0]!.measure.aicDisplay, 0, fit).primary);
    expect(observation[4]).toContain(formatAicDisplay(first.timeline[0]!.measure.aicDisplay, 0, fit).secondary);
    expect(elements(aic, "title")[1]!.textContent).toContain("prompt 60; total 100");
    const missing = panel(timeline, "Timeline AIC · published"); expect(elements(missing, "circle")).toHaveLength(0);
    expect(tableRows(missing, "Timeline AIC · published")[0]![2]).toBe("unavailable");
    expect(tableRows(missing, "Timeline AIC · published")[0]![4]).toContain("unpriced AIC");
    const calls = panel(f.root, "Calls"), next = button(calls, "Next page"); next.focus(); next.click(); await settle();
    expect(panel(f.root, "Call timeline")).toBe(timeline);
    expect(button(aic, "Table")).toBe(toggle);
    expect(timeline.textContent).toBe(before);
    expect(f.root.textContent).toContain("calibrated x0.56 over 7 days"); expect(f.root.textContent).not.toContain("x0.9");
    expect(tableRows(calls, "Recorded calls")[0]![0]).toBe("call-2"); expect(f.doc.activeElement).toBe(next);
    button(calls, "Previous page").click(); await settle(); expect(tableRows(calls, "Recorded calls")[0]![0]).toBe("call-1");
    expect(f.requests.map(path => new URL(path, "http://127.0.0.1").searchParams.get("cursor"))).toEqual([null, "calls-next", null]);
    for (const path of f.requests) {
      const params = new URL(path, "http://127.0.0.1").searchParams;
      expect(params.get("kind")).toBe("run"); expect(params.get("id")).toBe("run-fixture"); expect(params.get("start")).toBe("0"); expect(params.get("end")).toBe("172800000");
      expect(params.get("filters")).toBe('[{"field":"actor","value":"subagent"}]'); expect(params.get("limit")).toBe("50");
    }
    view.dispose();
  });
});

// Regression targets: current-page refresh, transactional pagers, live app context,
// stale/disposed requests and shared chart semantics. Transport deliberately ignores abort.
function deferredFixture() {
  const f = fixture();
  const pending: { path: string; params: URLSearchParams; signal: AbortSignal; resolve(value: ApiEnvelope<unknown>): void; reject(error: unknown): void }[] = [];
  f.ctx.client = { get<T>(path: string, params: URLSearchParams, signal: AbortSignal): Promise<ApiEnvelope<T>> {
    return new Promise((resolve, reject) => pending.push({ path, params: new URLSearchParams(params), signal, resolve: value => resolve(value as ApiEnvelope<T>), reject }));
  } };
  return { ...f, pending };
}
describe("Detail fix round", () => {
  it("uses shared recorded-subset charts with labelled table toggles and literal parity", async () => {
    const { mountDetail } = await import("../web/detail.js");
    const data = detail(); data.timeline[0]!.measure.unpricedCalls = 1;
    const f = fixture(() => data), view = await mountDetail(f.ctx); await settle();
    const chart = panel(f.root, "Timeline AIC · calibrated"), toggle = button(chart, "Table");
    expect(toggle.getAttribute("aria-controls")).toBe(elements(chart, "div").find(n => n.getAttribute("role") === "region")!.id);
    const graphic = elements(chart, "svg")[0]!, caption = elements(chart, "p").find(n => n.className.split(" ").includes("chart-summary"))!;
    expect(caption.tagName).toBe("P"); expect(caption.className).not.toContain("numeric");
    expect(caption.textContent).toContain(`${formatTokens(data.timeline[0]!.measure.aicDisplay.primaryAic!)}+ AIC calibrated maximum`);
    expect(graphic.getAttribute("aria-describedby")).toBe(caption.id);
    expect(graphic.getAttribute("aria-label")).toBe(`Timeline AIC · calibrated · ${caption.textContent}`);
    expect(elements(chart, "text")).toHaveLength(0);
    const group = elements(chart, "div").find(n => n.getAttribute("role") === "group")!;
    expect(group.getAttribute("aria-label")).toBe("Chart representation");
    expect(elements(group, "button").map(n => [n.textContent, n.getAttribute("aria-pressed")])).toEqual([["Chart", "true"], ["Table", "false"]]);
    toggle.focus(); toggle.click(); expect(toggle.textContent).toBe("Table"); expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(button(chart, "Chart").getAttribute("aria-pressed")).toBe("false"); expect(f.doc.activeElement).toBe(toggle);
    const table = elements(chart, "table")[0]!;
    expect(elements(table, "th").map(n => n.textContent)).toEqual(["Observation", "UTC period", "Value", "Tokens (subsets not additive)", "Evidence"]);
    expect(elements(chart, "title")[1]!.textContent).toBe(tableRows(chart, "Timeline AIC · calibrated")[0]!.join(" · "));
    expect(table.textContent).not.toMatch(/reasoning|cache write 1h/);
    view.dispose();
  });
  it("shows a quiet empty timeline and no approximate key for unavailable AIC", async () => {
    const { mountDetail } = await import("../web/detail.js"); const data = detail(); data.timeline = [];
    data.totals.aicDisplay = { primaryAic: null, publishedAic: null, basis: "published" };
    const f = fixture(() => data), view = await mountDetail(f.ctx); await settle();
    expect(panel(f.root, "Call timeline").textContent).toContain("No recorded calls in this period");
    expect(elements(f.root, "svg")).toHaveLength(0); expect(f.root.textContent).not.toContain("AIC is approximate; tokens are recorded."); view.dispose();
  });
  it("puts the covering action beside its measure, names pagers and uses text-faced prose", async () => {
    const { mountDetail } = await import("../web/detail.js"); const data = detail();
    data.accounting = { status: "covered", coveringRunId: "covering-run", message: "This is not priced zero." };
    const f = fixture(() => data), view = await mountDetail(f.ctx); await settle();
    expect(elements(f.root, "h1")[0]!.textContent).toBe("Run · fixture-run");
    const table = elements(f.root, "table").find(t => elements(t, "caption")[0]?.textContent === "Selected usage")!;
    const cells = elements(table, "tr")[1]!.children; expect(elements(cells[4]!, "button")[0]!.textContent).toBe("Covering run · covering-run");
    expect(cells[4]!.children.find(n => n.className === "cell-value")!.children[0]!.className).toContain("detail-prose");
    const groups = elements(f.root, "div").filter(n => n.getAttribute("role") === "group");
    expect(groups.filter(n => n.getAttribute("aria-label") === "Chart representation")).toHaveLength(7);
    expect(groups.filter(n => n.getAttribute("aria-label") !== "Chart representation").map(n => n.getAttribute("aria-label"))).toEqual(["Calls pages", "Related sessions and runs pages"]);
    view.dispose();
  });
  it("drops every session/run/parentRun filter and never turns rolling links into explicit periods", async () => {
    const { mountDetail } = await import("../web/detail.js"); const f = fixture();
    Object.assign(f.ctx, { filters: [{ field: "actor", value: "subagent" }, { field: "run", kind: "id", value: "run-fixture" }, { field: "session", kind: "id", value: "session-fixture" }, { field: "parentRun", kind: "id", value: "parent-run" }] });
    const view = await mountDetail(f.ctx); await settle(); button(f.root, "Parent run · parent-run").click();
    expect(f.routes[0]).toEqual({ view: "run", id: "parent-run", filters: [f.ctx.filters[0]] }); view.dispose();
  });
  it.each(["calls", "relationships"])("pins the server-resolved rolling window for %s cursors and Retry", async mode => {
    const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(); let end = period.end - 100;
    Object.defineProperty(f.ctx, "period", { get: () => ({ start: 0, end }) });
    const view = await mountDetail(f.ctx); const data = detail(); data.links.nextCursor = "links-next";
    f.pending[0]!.resolve(envelope(data)); await settle(); end += 5000;
    const pager = panel(f.root, mode === "calls" ? "Calls" : "Related sessions and runs"); button(pager, "Next page").click();
    expect(f.pending[1]!.params.get("end")).toBe(String(period.end));
    const page = mode === "calls" ? { ...data, calls: { rows: [call("call-2")], nextCursor: null } } : { rows: [], nextCursor: null };
    f.pending[1]!.resolve(envelope(page)); await settle(); button(pager, "Previous page").click();
    f.pending[2]!.reject(new DashboardClientError("busy")); await settle();
    button(pager, "Retry").click(); expect(f.pending[3]!.params.get("end")).toBe(String(period.end));
    expect(f.pending[3]!.params.get("cursor")).toBe(mode === "calls" ? "calls-next" : "links-next");
    f.pending[3]!.resolve(envelope(page)); await settle();
    button(f.root, "Refresh").click(); expect(f.pending[4]!.params.get("end")).toBe(String(end)); expect(f.pending[4]!.params.has("cursor")).toBe(false);
    f.pending[4]!.resolve(envelope(data)); await settle(); expect(button(pager, "Previous page").disabled).toBe(true); view.dispose();
  });
  it("automatic refresh preserves both current cursors and histories", async () => {
    vi.useFakeTimers();
    try {
      const { mountDetail } = await import("../web/detail.js"); const data = detail(); data.links.nextCursor = "links-next";
      let linkReads = 0;
      const f = fixture((path, params) => path === "/api/detail-links" ? { rows: [{ kind: "run", id: "live-child", relationship: "child", label: `links revision ${++linkReads}`, ongoing: false }], nextCursor: null } : params.has("cursor") ? { ...data, calls: { rows: [call("call-2")], nextCursor: null } } : data);
      const view = await mountDetail(f.ctx); await settle();
      const calls = panel(f.root, "Calls"), links = panel(f.root, "Related sessions and runs"); button(calls, "Next page").click(); await settle(); button(links, "Next page").click(); await settle();
      expect(f.requests).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.requests).toHaveLength(5); expect(tableRows(links, "Relationships")[0]![1]).toBe("links revision 2 · ve-child");
      const last = f.requests.slice(-2).map(p => new URL(p, "http://127.0.0.1"));
      expect(last.map(u => [u.pathname, u.searchParams.get("cursor")]).sort()).toEqual([["/api/detail", "calls-next"], ["/api/detail-links", "links-next"]]);
      expect(tableRows(calls, "Recorded calls")[0]![0]).toBe("call-2"); expect(button(calls, "Previous page").disabled).toBe(false); expect(button(links, "Previous page").disabled).toBe(false);
      button(f.root, "Refresh").click(); await settle(); expect(button(calls, "Previous page").disabled).toBe(true); expect(button(links, "Previous page").disabled).toBe(true); view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it.each(["Calls", "Related sessions and runs"])("does not refresh while the %s pager is focused", async name => {
    vi.useFakeTimers(); try {
      const { mountDetail } = await import("../web/detail.js"); const data = detail(); data.links.nextCursor = "links-next"; const f = fixture(() => data), view = await mountDetail(f.ctx); await settle();
      button(panel(f.root, name), "Next page").focus(); await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(1); view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("relationships failure neither unlocks a pending calls load nor loses independent paging", async () => {
    vi.useFakeTimers(); try {
      const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
      const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(data)); await settle();
      const calls = panel(f.root, "Calls"), links = panel(f.root, "Related sessions and runs");
      button(calls, "Next page").click(); button(links, "Next page").click(); f.pending[2]!.reject(new DashboardClientError("busy")); await settle();
      expect(button(links, "Next page").disabled).toBe(false); expect(button(calls, "Next page").disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(60000); expect(f.pending).toHaveLength(3);
      const retry = button(links, "Retry"); retry.focus(); retry.click(); expect(f.doc.activeElement).toBe(elements(f.root, "h1")[0]);
      expect(f.pending[3]!.path).toBe("/api/detail-links"); expect(f.pending[3]!.params.has("cursor")).toBe(false);
      f.pending[3]!.resolve(envelope(data.links)); f.pending[1]!.resolve(envelope({ ...data, calls: { rows: [call("call-2")], nextCursor: null } })); await settle();
      expect(tableRows(calls, "Recorded calls")[0]![0]).toBe("call-2"); view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("call-page row formatting retains the pinned slice calibration", async () => {
    const { mountDetail } = await import("../web/detail.js"); const data = detail(); const row = call("call-2"); row.measure.aicDisplay.basis = "published";
    const f = fixture((_p, params) => params.has("cursor") ? { ...data, calibration: { ...fit, status: "off" }, calls: { rows: [row], nextCursor: null } } : data);
    const view = await mountDetail(f.ctx); await settle(); button(panel(f.root, "Calls"), "Next page").click(); await settle();
    expect(tableRows(f.root, "Recorded calls")[0]![2]).toBe(formatAicDisplay(row.measure.aicDisplay, 0, fit).primary); view.dispose();
  });
  it.each([ ["abort", "success"], ["abort", "error"], ["dispose", "success"], ["dispose", "error"] ])("%s aborts both pending transports and late %s cannot write", async (mode, result) => {
    const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
    const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(data)); await settle();
    button(panel(f.root, "Calls"), "Next page").click(); button(panel(f.root, "Related sessions and runs"), "Next page").click();
    if (mode === "abort") f.controller.abort(); else view.dispose();
    expect(f.pending[1]!.signal.aborted).toBe(true); expect(f.pending[2]!.signal.aborted).toBe(true); const before = f.root.textContent;
    f.pending[1]!.reject(new DashboardClientError("busy"));
    if (result === "success") f.pending[2]!.resolve(envelope({ rows: [], nextCursor: null })); else f.pending[2]!.reject(new DashboardClientError("busy"));
    await settle(); expect(f.root.textContent).toBe(before);
    expect(f.doc.listeners.get("keydown")?.size ?? 0).toBe(0); view.dispose();
  });
  it.each(["success", "error"])("newer requests win over deferred calls and relationship %s", async result => {
    const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
    const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(data)); await settle();
    button(panel(f.root, "Calls"), "Next page").click(); button(panel(f.root, "Related sessions and runs"), "Next page").click(); button(f.root, "Refresh").click();
    expect(f.pending[1]!.signal.aborted).toBe(true); expect(f.pending[2]!.signal.aborted).toBe(true);
    f.pending[3]!.resolve(envelope({ ...data, calls: { rows: [call("newest")], nextCursor: null } })); await settle(); const before = f.root.textContent;
    f.pending[1]!.resolve(envelope(data));
    if (result === "success") f.pending[2]!.resolve(envelope({ rows: [{ kind: "run", id: "old", relationship: "child", label: "OLD", ongoing: false }], nextCursor: null })); else f.pending[2]!.reject(new DashboardClientError("busy"));
    await settle();
    expect(f.root.textContent).toBe(before); view.dispose();
  });
  it("a calls 409 aborts a pending relationships request and prevents late writes", async () => {
    const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
    const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(data)); await settle();
    button(panel(f.root, "Related sessions and runs"), "Next page").click(); button(panel(f.root, "Calls"), "Next page").click();
    f.pending[2]!.reject(new DashboardClientError("ledger-changed")); await settle(); expect(f.pending[1]!.signal.aborted).toBe(true); const before = f.root.textContent;
    f.pending[1]!.resolve(envelope(data.links)); await settle(); expect(f.root.textContent).toBe(before); view.dispose();
  });
});

describe("Detail lifecycle and fixed notices", () => {
  it("late success after direct disposal cannot replace calls or totals", async () => {
    const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), view = await mountDetail(f.ctx);
    view.dispose(); const before = f.root.textContent; expect(f.pending[0]!.signal.aborted).toBe(true);
    f.pending[0]!.resolve(envelope(detail())); await settle(); expect(f.root.textContent).toBe(before);
  });
  it("Retry on calls focuses the stable heading and Refresh preserves its button focus", async () => {
    const { mountDetail } = await import("../web/detail.js"); let failed = true;
    const f = fixture(() => failed ? new Response(JSON.stringify({ apiVersion: 1, error: { code: "busy" } }), { status: 503 }) : detail());
    const view = await mountDetail(f.ctx); await settle(); failed = false; const retry = button(f.root, "Retry"); retry.focus(); retry.click(); await settle();
    expect(f.doc.activeElement).toBe(elements(f.root, "h1")[0]); expect(elements(f.root, "h1")[0]!.getAttribute("tabindex")).toBe("-1");
    const refresh = button(f.root, "Refresh"); refresh.focus(); refresh.click(); await settle(); expect(f.doc.activeElement).toBe(refresh); view.dispose();
  });
  it.each(["invalid-query", "ledger-changed", "unknown-filter-id", "identity-unavailable"])("%s has no futile Retry or repeated automatic request", async code => {
    vi.useFakeTimers(); try {
      const { mountDetail } = await import("../web/detail.js"); const f = fixture(() => new Response(JSON.stringify({ apiVersion: 1, error: { code, message: "PRIVATE" } }), { status: code === "ledger-changed" ? 409 : 400 }));
      const view = await mountDetail(f.ctx); await settle(); expect(button(f.root, "Retry").hidden).toBe(true); expect(f.root.textContent).not.toContain("PRIVATE");
      await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(1); view.dispose();
    } finally { vi.useRealTimers(); }
  });
});

it("Selected labels and relationship destination names use the prose face", async () => {
  const { mountDetail } = await import("../web/detail.js"); const data = detail(); data.links.rows = [{ kind: "run", id: "child-run", relationship: "child", label: "child name", ongoing: false }];
  const f = fixture(() => data), view = await mountDetail(f.ctx); await settle();
  const selected = elements(f.root, "table").find(t => elements(t, "caption")[0]?.textContent === "Selected usage")!;
  const label = elements(selected, "tr")[1]!.children[0]!;
  expect(label.children.find(n => n.className === "cell-value")?.children[0]?.className ?? "").toContain("detail-prose");
  expect(button(f.root, "child name · hild-run").className).toContain("detail-prose"); view.dispose();
});

it("failed fresh loads disable old cursors and Retry refreshes all evidence", async () => {
  const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), first = detail(); first.links.nextCursor = "old-links";
  const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(first)); await settle();
  button(f.root, "Refresh").click(); f.pending[1]!.reject(new DashboardClientError("busy")); await settle();
  expect(button(panel(f.root, "Calls"), "Next page").disabled).toBe(true); expect(button(panel(f.root, "Related sessions and runs"), "Next page").disabled).toBe(true);
  button(f.root, "Retry").click(); const fresh = detail(); fresh.totals.aicDisplay.primaryAic = 900;
  f.pending[2]!.resolve(envelope(fresh)); await settle(); expect(tableRows(f.root, "Selected usage")[0]![1]).toBe(formatAicDisplay(fresh.totals.aicDisplay, 0, fit).primary); view.dispose();
});

it("page-one automatic refresh hides old cursor actions while advancing the window", async () => {
  vi.useFakeTimers(); try {
    const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), first = detail(); first.links.nextCursor = "old-links"; let end = period.end;
    Object.defineProperty(f.ctx, "period", { get: () => ({ start: 0, end }) });
    const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(first)); await settle(); end += 60000;
    await vi.advanceTimersByTimeAsync(60000); expect(f.pending[1]!.params.get("end")).toBe(String(end));
    expect(button(panel(f.root, "Related sessions and runs"), "Next page").disabled).toBe(true);
    f.pending[1]!.reject(new DashboardClientError("busy")); await settle();
    expect(button(panel(f.root, "Calls"), "Next page").disabled).toBe(true); view.dispose();
  } finally { vi.useRealTimers(); }
});


describe("Detail final round", () => {
  it.each(["id", "missing", "raw", "implicit"] as const)("navigation removes %s identity filters, including the parent destination", async kind => {
    // Break caught: carrying identity-conflicting filters into another detail.
    const { mountDetail } = await import("../web/detail.js"); const f = fixture();
    f.ctx.id = "other-run";
    Object.assign(f.ctx, { filters: [f.ctx.filters[0], ...(["session", "run", "parentRun"] as const).map(field => ({ field, value: kind === "missing" ? null : "old-identity", ...(kind === "implicit" ? {} : { kind }) }))] });
    const view = await mountDetail(f.ctx); await settle();
    for (const label of ["Session · session-fixture", "Run · run-fixture", "Parent run · parent-run"]) button(f.root, label).click();
    expect(f.routes.map(route => route.filters)).toEqual([[f.ctx.filters[0]], [f.ctx.filters[0]], [f.ctx.filters[0]]]); view.dispose();
  });
  it("a relationships 409 cancels pending calls and rejects late evidence", async () => {
    // Break caught: a links-only 409 cancellation leaves calls able to repopulate evidence.
    const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
    const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(data)); await settle();
    button(panel(f.root, "Calls"), "Next page").click(); button(panel(f.root, "Related sessions and runs"), "Next page").click();
    f.pending[2]!.reject(new DashboardClientError("ledger-changed")); await settle(); expect(f.pending[1]!.signal.aborted).toBe(true);
    const before = f.root.textContent; f.pending[1]!.resolve(envelope(data)); await settle(); expect(f.root.textContent).toBe(before);
    expect(elements(f.root, "table")).toHaveLength(0); view.dispose();
  });
  it("calls recover their own buttons after a transient page failure", async () => {
    // Break caught: the calls-side failed branch does not restore pager controls.
    const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), data = detail();
    const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(data)); await settle(); const calls = panel(f.root, "Calls");
    button(calls, "Next page").click(); f.pending[1]!.resolve(envelope({ ...data, calls: { rows: [call("page-two")], nextCursor: "page-three" } })); await settle();
    button(calls, "Next page").click(); f.pending[2]!.reject(new DashboardClientError("busy")); await settle();
    expect(button(calls, "Next page").disabled).toBe(false); expect(button(calls, "Previous page").disabled).toBe(false);
    expect(tableRows(calls, "Recorded calls")[0]![0]).toBe("page-two"); view.dispose();
  });
  it.each(["calls", "relationships"])("stale %s finally cannot unlock a newer pending load for the timer", async mode => {
    // Break caught: unconditional finally lets the timer abort a newer user load.
    vi.useFakeTimers(); try {
      const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
      const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(data)); await settle();
      const pager = panel(f.root, mode === "calls" ? "Calls" : "Related sessions and runs"); button(pager, "Next page").click();
      if (mode === "calls") button(f.root, "Refresh").click();
      else {
        button(f.root, "Refresh").click(); f.pending[2]!.resolve(envelope(data)); await settle(); button(pager, "Next page").click();
      }
      const newer = f.pending.at(-1)!; f.pending[1]!.reject(new DashboardClientError("busy")); await settle(); const before = f.root.textContent;
      await vi.advanceTimersByTimeAsync(60000); expect(f.pending).toHaveLength(mode === "calls" ? 3 : 4);
      expect(newer.signal.aborted).toBe(false); expect(f.root.textContent).toBe(before); view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("automatic refresh does not take focused Retry after a busy failure", async () => {
    // Break caught: removing the controls focus guard lets hideRetry steal focus.
    vi.useFakeTimers(); try {
      const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), view = await mountDetail(f.ctx);
      f.pending[0]!.reject(new DashboardClientError("busy")); await settle(); const retry = button(f.root, "Retry"); retry.focus();
      await vi.advanceTimersByTimeAsync(60000); expect(f.pending).toHaveLength(1); expect(f.doc.activeElement).toBe(retry);
      const refresh = button(f.root, "Refresh"); refresh.focus(); await vi.advanceTimersByTimeAsync(60000);
      expect(f.pending).toHaveLength(1); expect(f.doc.activeElement).toBe(refresh); view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it.each(["calls", "relationships"])("%s owns its status and Retry through the other pager's success", async mode => {
    // Break caught: a shared message/retry or paused flag hides another pager's failure.
    vi.useFakeTimers(); try {
      const { mountDetail } = await import("../web/detail.js"); const f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
      const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(data)); await settle();
      const calls = panel(f.root, "Calls"), links = panel(f.root, "Related sessions and runs");
      button(calls, "Next page").click(); button(links, "Next page").click();
      const failedIndex = mode === "calls" ? 1 : 2, successfulIndex = mode === "calls" ? 2 : 1;
      f.pending[failedIndex]!.reject(new DashboardClientError("busy")); await settle();
      const failedPager = mode === "calls" ? calls : links, otherPager = mode === "calls" ? links : calls;
      const status = elements(failedPager, "p").find(n => n.getAttribute("role") === "status")!;
      expect(status).toBeDefined(); const errorText = status.textContent;
      f.pending[successfulIndex]!.resolve(envelope(mode === "calls" ? data.links : data)); await settle();
      expect(status.textContent).toBe(errorText); expect(button(failedPager, "Retry").hidden).toBe(false); expect(button(otherPager, "Retry").hidden).toBe(true);
      button(failedPager, "Retry").click(); expect(f.pending[3]!.path).toBe(mode === "calls" ? "/api/detail" : "/api/detail-links");
      f.pending[3]!.reject(new DashboardClientError("invalid-query")); await settle();
      button(otherPager, "Next page").click(); f.pending[4]!.resolve(envelope(mode === "calls" ? data.links : data)); await settle();
      const before = status.textContent; await vi.advanceTimersByTimeAsync(60000); expect(f.pending).toHaveLength(5); expect(status.textContent).toBe(before); view.dispose();
    } finally { vi.useRealTimers(); }
  });
});


describe("Detail alignment", () => {
  it.each(["calls", "relationships"])("offers routed Clear filters for %s errors only until refresh starts", async source => {
    // Break caught: context-free copy, fabricated routing, stale actions or clearing the wrong pager.
    const { mountDetail } = await import("../web/detail.js");
    const f = deferredFixture(), clearFilters = vi.fn(), view = await mountDetail({ ...f.ctx, clearFilters });
    const initial = detail(); initial.links.nextCursor = "links-next";
    f.pending[0]!.resolve(envelope(initial)); await settle();
    const pager = panel(f.root, source === "calls" ? "Calls" : "Related sessions and runs");
    button(pager, "Next page").click(); f.pending[1]!.reject(new DashboardClientError("unknown-filter-id")); await settle();
    expect(pager.textContent).toContain("Selected filter is no longer available. Clear filters to continue.");
    const clear = button(pager, "Clear filters"); expect(clear.hidden).toBe(false); clear.click();
    expect(clearFilters).toHaveBeenCalledTimes(1); expect(f.routes).toEqual([]);
    clear.focus(); button(f.root, "Refresh").click(); expect(clear.hidden).toBe(true);
    expect(f.doc.activeElement).toBe(elements(f.root, "h1")[0]);
    f.pending[2]!.resolve(envelope(initial)); await settle(); expect(clear.hidden).toBe(true);
    button(pager, "Next page").click(); f.pending[3]!.reject(new DashboardClientError("invalid-query")); await settle();
    expect(clear.hidden).toBe(true); view.dispose();
  });
  it("without a clear action tells the user to remove the unknown filter from the address", async () => {
    const { mountDetail } = await import("../web/detail.js"), f = deferredFixture(), view = await mountDetail(f.ctx);
    f.pending[0]!.reject(new DashboardClientError("unknown-filter-id")); await settle();
    expect(f.root.textContent).toContain("Selected filter is no longer available. Remove the unknown filter from the address to continue.");
    expect(elements(f.root, "button").filter(n => n.textContent === "Clear filters" && !n.hidden)).toHaveLength(0); view.dispose();
  });
  it("empty call and relationship pages use spanning no-rows cells", async () => {
    const { mountDetail } = await import("../web/detail.js"), data = detail(); data.calls.rows = [];
    const f = fixture(() => data), view = await mountDetail(f.ctx); await settle();
    for (const [caption, columns] of [["Recorded calls", 7], ["Relationships", 3]] as const) {
      const table = elements(f.root, "table").find(n => elements(n, "caption")[0]?.textContent === caption)!;
      const rows = elements(table, "tbody")[0]!.children; expect(rows).toHaveLength(1);
      expect(rows[0]!.children).toHaveLength(1); expect(rows[0]!.children[0]!.textContent).toBe("No rows for this period");
      expect(rows[0]!.children[0]!.getAttribute("colspan")).toBe(String(columns));
    }
    for (const control of elements(f.root, "button")) expect(control.className).toContain("action");
    view.dispose();
  });
});


describe("Detail final round 2", () => {
  it.each(["calls", "relationships"])("%s keeps its Clear filters action through the other pager's load and failure", async source => {
    // Break caught: shared Clear filters hides an action still requested by the other pager's notice.
    const { mountDetail } = await import("../web/detail.js"), f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
    let clears = 0;
    const view = await mountDetail({ ...f.ctx, clearFilters: () => { clears++; } });
    try {
      f.pending[0]!.resolve(envelope(data)); await settle();
      const owner = panel(f.root, source === "calls" ? "Calls" : "Related sessions and runs");
      const other = panel(f.root, source === "calls" ? "Related sessions and runs" : "Calls");
      button(owner, "Next page").click(); f.pending[1]!.reject(new DashboardClientError("unknown-filter-id")); await settle();
      const status = elements(owner, "p").find(n => n.getAttribute("role") === "status")!;
      const notice = status.textContent, clear = button(owner, "Clear filters");
      expect(notice).toBe("Selected filter is no longer available. Clear filters to continue."); expect(clear.hidden).toBe(false);
      button(other, "Next page").click(); expect(clear.hidden).toBe(false); expect(status.textContent).toBe(notice);
      f.pending[2]!.reject(new DashboardClientError("busy")); await settle();
      expect(clear.hidden).toBe(false); expect(status.textContent).toBe(notice); expect(button(other, "Clear filters").hidden).toBe(true);
      clear.click(); expect(clears).toBe(1);
      // A second unknown filter exposes two independent controls; restarting one hides only its own.
      button(other, "Retry").click(); f.pending[3]!.reject(new DashboardClientError("unknown-filter-id")); await settle();
      const otherClear = button(other, "Clear filters"); expect(otherClear.hidden).toBe(false);
      button(owner, "Next page").click(); expect(clear.hidden).toBe(true); expect(otherClear.hidden).toBe(false);
      if (source === "relationships") expect(elements(owner, "p").find(n => n.getAttribute("role") === "status")!.textContent).toBe("Loading relationships");
      f.pending[4]!.reject(new DashboardClientError("busy")); await settle(); expect(otherClear.hidden).toBe(false);
    } finally { view.dispose(); }
  });
  it("relationships on page one retain transient error, rows and Retry through calls automatic refresh", async () => {
    // Break caught: not setting linksFailed overwrites the independent relationships error and rows.
    vi.useFakeTimers();
    try {
      const { mountDetail } = await import("../web/detail.js"), f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
      data.links.rows = [{ kind: "run", id: "child", relationship: "child", label: "original child", ongoing: false }];
      const view = await mountDetail(f.ctx);
      try {
        f.pending[0]!.resolve(envelope(data)); await settle(); const links = panel(f.root, "Related sessions and runs");
        button(links, "Next page").click();
        const status = elements(links, "p").find(n => n.getAttribute("role") === "status")!;
        expect(status.textContent).toBe("Loading relationships");
        f.pending[1]!.reject(new DashboardClientError("busy")); await settle(); const notice = status.textContent;
        expect(button(links, "Previous page").disabled).toBe(true); expect(button(links, "Retry").hidden).toBe(false);
        await vi.advanceTimersByTimeAsync(60000); expect(f.pending).toHaveLength(3); expect(f.pending[2]!.path).toBe("/api/detail");
        f.pending[2]!.resolve(envelope({ ...data, links: { rows: [], nextCursor: null } })); await settle();
        expect(status.textContent).toBe(notice); expect(button(links, "Retry").hidden).toBe(false);
        expect(tableRows(links, "Relationships")[0]![1]).toBe("original child · child");
      } finally { view.dispose(); }
    } finally { vi.useRealTimers(); }
  });
  it("a relationships ledger change hides an earlier calls Retry", async () => {
    // Break caught: the links 409 branch only hides its own Retry after invalidating both pagers.
    const { mountDetail } = await import("../web/detail.js"), f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
    const view = await mountDetail(f.ctx);
    try {
      f.pending[0]!.resolve(envelope(data)); await settle(); const calls = panel(f.root, "Calls"), links = panel(f.root, "Related sessions and runs");
      button(calls, "Next page").click(); f.pending[1]!.reject(new DashboardClientError("busy")); await settle(); expect(button(calls, "Retry").hidden).toBe(false);
      button(links, "Next page").click(); f.pending[2]!.reject(new DashboardClientError("ledger-changed")); await settle();
      expect(button(calls, "Retry").hidden).toBe(true); expect(button(links, "Retry").hidden).toBe(true); expect(elements(f.root, "table")).toHaveLength(0);
    } finally { view.dispose(); }
  });
  it.each(["session", "run"] as const)("a link to the same %s keeps all filters, but the same id in a different kind drops identity filters", async kind => {
    // Break caught: clearing filters on same-identity navigation, or comparing ids without their kind.
    const { mountDetail } = await import("../web/detail.js"), f = fixture(), id = `${kind}-fixture`;
    Object.assign(f.ctx, { filters: [f.ctx.filters[0], { field: "session", kind: "raw", value: "session-fixture" }, { field: "run", kind: "id", value: "run-fixture" }, { field: "parentRun", kind: "missing", value: null }] });
    const view = await mountDetail({ ...f.ctx, kind, id });
    try {
      await settle(); button(f.root, `${kind === "session" ? "Session" : "Run"} · ${id}`).click();
      expect(f.routes[0]).toEqual({ view: kind, id, filters: f.ctx.filters });
    } finally { view.dispose(); }
    const other = fixture(() => { const data = detail(); data.calls.rows[0]!.sessionId = data.calls.rows[0]!.runId = id; return data; });
    Object.assign(other.ctx, { filters: f.ctx.filters });
    const otherView = await mountDetail({ ...other.ctx, kind, id });
    try {
      await settle(); button(other.root, `${kind === "session" ? "Run" : "Session"} · ${id}`).click();
      expect(other.routes[0]!.filters).toEqual([f.ctx.filters[0]]);
    } finally { otherView.dispose(); }
  });
});


describe("Task 13 Detail alignment", () => {
  it("uses readable semantic dates, numeric runs, compact tokens and wide scroll cues", async () => {
    // Breaks: raw ISO cells, whole-cell number face, packed token strings, unexplained markers.
    const { mountDetail } = await import("../web/detail.js"), f = fixture(), view = await mountDetail(f.ctx); await settle();
    const calls = elements(f.root, "table").find(t => elements(t, "caption")[0]?.textContent === "Recorded calls")!;
    const selected = elements(f.root, "table").find(t => elements(t, "caption")[0]?.textContent === "Selected usage")!;
    expect(calls.className).toContain("wide-table"); expect(selected.className).not.toContain("wide-table");
    expect(elements(calls.parentElement!, "p").some(n => n.className === "scroll-cue" && n.textContent.length > 0)).toBe(true);
    const time = elements(calls, "time")[0]!; expect(time?.getAttribute("datetime")).toBe("1970-01-01T00:00:01.000Z"); expect(time?.textContent).toBe("1 Jan 1970, 00:00:01 UTC");
    const status = elements(panel(f.root, "Calls"), "p").find(n => n.getAttribute("role") === "status")!;
    expect(elements(status, "time")[0]?.getAttribute("datetime")).toBe("1970-01-03T00:00:00.000Z");
    expect(elements(status, "time")[0]?.textContent).toBe("3 Jan 1970, 00:00 UTC");
    expect(elements(f.root, "time").some(n => n.getAttribute("datetime") === "1970-01-08T00:00:00.000Z")).toBe(true);
    for (const table of [calls, selected]) {
      expect(elements(table, "dl").filter(n => n.className === "token-list")).toHaveLength(1);
      const numeric = elements(table, "span").filter(n => n.className === "numeric"); expect(numeric.some(n => n.textContent === "560")).toBe(true);
      expect(numeric.every(n => /^[~+\-]?\d[\d,.]*\+?$/.test(n.textContent))).toBe(true);
    }
    expect(f.root.textContent).toContain("cal means calibrated"); expect(f.root.textContent).toContain("? means calibration unavailable"); expect(f.root.textContent).toContain("est means published estimate with calibration off.");
    expect(elements(f.root, "svg").filter(n => n.getAttribute("role") === "img").every(n => n.getAttribute("height") === "96")).toBe(true); view.dispose();
  });
  it("wake keeps both pages, retained chart/table DOM and focus while refreshing observations", async () => {
    // Breaks: remount/replacement/reset, omitted relationships refresh, focused evidence blocking wake.
    vi.useFakeTimers(); try {
      const { mountDetail } = await import("../web/detail.js"), data = detail(); data.links.nextCursor = "links-next";
      let revision = 0;
      const f = fixture((path, params) => path === "/api/detail-links" ? { rows: [{kind: "run", id: "child", relationship: "child", label: `child ${revision}`, ongoing: false}], nextCursor: null }
        : {...data, calls: {rows: [call(params.has("cursor") ? `page-two-${revision}` : "call-1")], nextCursor: params.has("cursor") ? null : "calls-next"}});
      const started = vi.fn(), view = await mountDetail({...f.ctx, requestStarted: started, idleMs: () => 0}); await settle();
      const calls = panel(f.root, "Calls"), links = panel(f.root, "Related sessions and runs");
      button(calls, "Next page").click(); await settle(); button(links, "Next page").click(); await settle();
      const timeline = panel(f.root, "Call timeline"), chart = panel(timeline, "Timeline AIC · calibrated"), toggle = button(chart, "Table"); toggle.click(); toggle.focus();
      const table = elements(chart, "table")[0], region = table!.parentElement;
      const callsTable = elements(calls, "table")[0], callsRegion = callsTable!.parentElement, linksTable = elements(links, "table")[0];
      expect(view.suspend).toBeTypeOf("function"); view.suspend!(false); expect(vi.getTimerCount()).toBe(0);
      const count = f.requests.length; await vi.advanceTimersByTimeAsync(120000); expect(f.requests).toHaveLength(count);
      revision = 1; view.resume!(); view.resume!(); expect(vi.getTimerCount()).toBe(1); view.refresh!(); await settle();
      expect(f.requests).toHaveLength(count + 2); expect(started).toHaveBeenCalledTimes(count + 2);
      expect(f.requests.slice(-2).map(r => new URL(r, "http://fixture").searchParams.get("cursor")).sort()).toEqual(["calls-next", "links-next"]);
      expect(tableRows(calls, "Recorded calls")[0]![0]).toBe("page-two-1"); expect(tableRows(links, "Relationships")[0]![1]).toBe("child 1 · child");
      expect(panel(f.root, "Call timeline")).toBe(timeline); expect(elements(chart, "table")[0]).toBe(table); expect(table!.parentElement).toBe(region);
      expect(button(chart, "Table")).toBe(toggle); expect(toggle.getAttribute("aria-pressed")).toBe("true"); expect(f.doc.activeElement).toBe(toggle);
      expect(elements(calls, "table")[0]).toBe(callsTable); expect(callsTable!.parentElement).toBe(callsRegion); expect(elements(links, "table")[0]).toBe(linksTable);
      expect(button(calls, "Previous page").disabled).toBe(false); expect(button(links, "Previous page").disabled).toBe(false);
      view.dispose(); view.resume!(); view.refresh!(); expect(vi.getTimerCount()).toBe(0); expect(f.requests).toHaveLength(count + 2);
    } finally { vi.useRealTimers(); }
  });
  it("aborting suspension fences both transports without aborting the lifetime signal", async () => {
    // Breaks: forgotten fetch abort, stale success/catch/finally, lost committed cursors.
    vi.useFakeTimers(); try {
      const { mountDetail } = await import("../web/detail.js"), f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
      const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(data)); await settle();
      button(panel(f.root, "Calls"), "Next page").click(); button(panel(f.root, "Related sessions and runs"), "Next page").click();
      expect(view.suspend).toBeTypeOf("function"); view.suspend!(false); expect(f.pending[1]!.signal.aborted).toBe(false);
      view.suspend!(true); expect(f.pending[1]!.signal.aborted).toBe(true); expect(f.pending[2]!.signal.aborted).toBe(true); expect(f.ctx.signal.aborted).toBe(false);
      const before = f.root.textContent; f.pending[1]!.resolve(envelope({...data, timeline: [], calls: {rows:[call("late")], nextCursor:null}})); f.pending[2]!.reject(new DashboardClientError("busy")); await settle(); expect(f.root.textContent).toBe(before);
      view.resume!(); view.refresh!(); f.pending[3]!.resolve(envelope(data)); await settle(); expect(tableRows(f.root, "Recorded calls")[0]![0]).toBe("call-1");
      button(panel(f.root, "Calls"), "Next page").click(); expect(f.pending.at(-1)!.params.get("cursor")).toBe("calls-next"); view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it.each(["calls", "relationships"])("successful wake hides focused %s Retry at success and focuses its heading", async lane => {
    const { mountDetail } = await import("../web/detail.js"), f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
    const view = await mountDetail(f.ctx); f.pending[0]!.resolve(envelope(data)); await settle();
    const owner = panel(f.root, lane === "calls" ? "Calls" : "Related sessions and runs"); button(owner, "Next page").click(); f.pending[1]!.reject(new DashboardClientError("busy")); await settle();
    const retry = button(owner, "Retry"); retry.focus(); expect(view.refresh).toBeTypeOf("function"); view.refresh!();
    expect(retry.hidden).toBe(false); expect(f.doc.activeElement).toBe(retry);
    for (const pending of f.pending.slice(2)) pending.resolve(envelope(pending.path === "/api/detail-links" ? data.links : data)); await settle();
    expect(retry.hidden).toBe(true); expect(f.doc.activeElement).toBe(elements(owner, "h2")[0]); expect(elements(owner, "h2")[0]!.getAttribute("tabindex")).toBe("-1"); view.dispose();
  });
  it("shared app activity keeps standalone polling alive beyond five minutes", async () => {
    vi.useFakeTimers(); try {
      const { mountDetail } = await import("../web/detail.js"), f = fixture(), view = await mountDetail({...f.ctx, idleMs: () => 0}); await settle();
      await vi.advanceTimersByTimeAsync(1200000); expect(f.requests).toHaveLength(21); view.dispose();
    } finally { vi.useRealTimers(); }
  });
});


describe("Detail alignment fix round", () => {
  it("published estimates and recorded zero latency retain the number face without styling units", async () => {
    // Breaks: R8/R16 render amounts as prose rather than numeric runs.
    const { mountDetail } = await import("../web/detail.js"), data = detail(); data.calls.rows[0]!.latencyMs = 0;
    const f = fixture(() => data), view = await mountDetail(f.ctx);
    try {
      await settle();
      for (const caption of ["Selected usage", "Recorded calls"]) {
        const table = elements(f.root, "table").find(t => elements(t, "caption")[0]?.textContent === caption)!;
        const cells = elements(table, "tbody")[0]!.children[0]!.children;
        expect(elements(cells[caption === "Selected usage" ? 2 : 3]!, "span").filter(n => n.className === "numeric").map(n => n.textContent)).toEqual(["~1,000"]);
        if (caption === "Recorded calls") {
          expect(elements(cells[7]!, "span").filter(n => n.className === "numeric").map(n => n.textContent)).toEqual(["0"]);
          expect(cells[7]!.textContent).toContain("0 ms");
        }
      }
    } finally { view.dispose(); }
  });
  it("omits the marker key when primary AIC is unavailable", async () => {
    // Breaks: R22 adds a misleading cal/?/est key to unavailable AIC.
    const { mountDetail } = await import("../web/detail.js"), data = detail();
    data.totals.aicDisplay = { primaryAic: null, publishedAic: null, basis: "published" };
    const f = fixture(() => data), view = await mountDetail(f.ctx);
    try { await settle(); expect(f.root.textContent).not.toContain("cal means"); expect(f.root.textContent).not.toContain("? means"); expect(f.root.textContent).not.toContain("est means"); }
    finally { view.dispose(); }
  });
  it("aborted in-flight relationships clear loading on wake and allow the next poll", async () => {
    // Breaks: R4 leaves linksLoading set after fencing an uncommitted page.
    vi.useFakeTimers();
    const { mountDetail } = await import("../web/detail.js"), f = deferredFixture(), data = detail(); data.links.nextCursor = "links-next";
    const view = await mountDetail({ ...f.ctx, idleMs: () => 0 });
    try {
      f.pending[0]!.resolve(envelope(data)); await settle(); const links = panel(f.root, "Related sessions and runs");
      button(links, "Next page").click(); expect(f.pending[1]!.path).toBe("/api/detail-links");
      view.suspend!(true); expect(f.pending[1]!.signal.aborted).toBe(true);
      f.pending[1]!.reject(new DOMException("Aborted", "AbortError")); await settle();
      view.resume!(); view.refresh!(); expect(f.pending[2]!.path).toBe("/api/detail");
      f.pending[2]!.resolve(envelope(data)); await settle();
      expect(elements(links, "p").find(n => n.getAttribute("role") === "status")!.textContent).toBe("Relationships updated");
      f.doc.activeElement = null; await vi.advanceTimersByTimeAsync(60000);
      expect(f.pending).toHaveLength(4); expect(f.pending[3]!.path).toBe("/api/detail");
      f.pending[3]!.resolve(envelope(data)); await settle();
    } finally { view.dispose(); vi.useRealTimers(); }
  });
  it("wake refresh does not abort or replace a calls request already in flight", async () => {
    // Breaks: absent !loading guard restarts the transport during initial load or later refresh.
    const { mountDetail } = await import("../web/detail.js"), f = deferredFixture(), view = await mountDetail(f.ctx);
    try {
      view.refresh!(); expect(f.pending).toHaveLength(1); expect(f.pending[0]!.signal.aborted).toBe(false);
      f.pending[0]!.resolve(envelope(detail())); await settle();
      view.refresh!(); view.refresh!(); expect(f.pending).toHaveLength(2); expect(f.pending[1]!.signal.aborted).toBe(false);
      f.pending[1]!.resolve(envelope(detail())); await settle(); expect(f.root.textContent).toContain("Updated 3 Jan 1970");
    } finally { view.dispose(); }
  });
});
