import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnvelope, Filter, Page, FilterValue, UsageMeasure } from "../dashboard-contract.js";
import type { ExplorerData } from "../query-explorer.js";
import { createDashboardClient, DashboardClientError, type DashboardClient } from "../web/client.js";
import { readFileSync } from "node:fs";
import type { ViewRoute } from "../web/views.js";
import { PlainDocument, PlainElement, descendants, elements, button, settle } from "./fixtures/plain-dom.js";

// Only extend structure for native form controls. This fixture does not simulate layout.
class ExplorerDocument extends PlainDocument {
  override createElement(tag: string): PlainElement {
    const node = /^(input|select|option)$/.test(tag) ? new PlainElement(this, tag.toUpperCase()) : super.createElement(tag);
    let disabled = false;
    Object.defineProperty(node, "disabled", { get: () => disabled, set: (value: boolean) => {
      disabled = value; if (value && this.activeElement === node) this.activeElement = this.body;
    } });
    return node;
  }
}
const period = { start: 0, end: 172800000 };
const filters: readonly Filter[] = [{ field: "actor", value: "opaque-parent", kind: "id" }];
const fit = { status: "calibrated" as const, factor: 0.56, windowStart: 0, windowEnd: 604800000,
  coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: 0, method: "trailing-7d-ratio" as const };
function measure(): UsageMeasure {
  return { calls: 1, pricedCalls: 1, unpricedCalls: 0, aggregateCalls: 0,
    tokens: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, prompt: 60, total: 100, reasoning: null, cacheWrite1h: null },
    aic: 1000, aicDisplay: { primaryAic: 560, publishedAic: 1000, basis: "calibrated" },
    aicComponents: { input: 100, cacheRead: 200, cacheWrite: 300, output: 400 }, piCost: null,
    possibleOverlap: false, possibleUndercount: false, pendingData: false, estimated: false };
}
function data(): ExplorerData {
  return { groupBy: ["model"], calibration: fit, totals: measure(),
    rows: [{ key: ["opaque-model"], labels: ["Model"], measure: measure() }], nextCursor: null };
}
function envelope<T>(data: T): ApiEnvelope<T> { return { apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data }; }
type Request = { path: string; params: URLSearchParams; signal: AbortSignal };
function fixture(respond: (request: Request) => unknown | Promise<unknown> = () => data(), resolveLabel?: (request: Request) => unknown | Promise<unknown>) {
  const doc = new ExplorerDocument(), root = doc.createElement("main"); doc.body.append(root);
  const requests: Request[] = [], labelRequests: Request[] = [], routes: ViewRoute[] = [], controller = new AbortController();
  const client = createDashboardClient(async (input, init) => {
    const url = new URL(String(input), "http://127.0.0.1:10000");
    const request = { path: url.pathname, params: url.searchParams, signal: init!.signal as AbortSignal };
    const labelLookup = request.params.get("limit") === "1";
    (labelLookup ? labelRequests : requests).push(request);
    const result = await (labelLookup ? (resolveLabel ?? (() => ({ rows: [{ id: "opaque-parent", label: "Parent actor" }], nextCursor: null })))(request) : respond(request));
    return result instanceof Response ? result : new Response(JSON.stringify(envelope(result)));
  });
  return { doc, root, requests, labelRequests, routes, controller, ctx: { document: doc.asDocument(), root: root as unknown as HTMLElement,
    client, period, filters, signal: controller.signal, navigate(route: ViewRoute) { routes.push(route); } } };
}
function field(root: PlainElement, label: string): PlainElement {
  const found = descendants(root).find(node => node.getAttribute("aria-label") === label);
  expect(found, `control ${label}`).toBeDefined(); return found!;
}
function input(root: PlainElement, value: string): void {
  const control = field(root, "Filter prefix"); control.value = value; control.dispatchEvent(new Event("input"));
}
async function mount(ctx: ReturnType<typeof fixture>["ctx"]) {
  const module = await import("../web/explorer.js").catch(() => null);
  expect(module, "Explorer mount is available").not.toBeNull();
  return module!.mountExplorer(ctx);
}
afterEach(() => { vi.useRealTimers(); });

function key(node: PlainElement, value: string): void {
  const event = new Event("keydown", { cancelable: true }); Object.defineProperty(event, "key", { value }); node.dispatchEvent(event);
}
function tableRows(root: PlainElement, caption: string): string[][] {
  const table = elements(root, "table").find(node => elements(node, "caption")[0]?.textContent === caption);
  expect(table, `table ${caption}`).toBeDefined();
  return elements(table!, "tr").slice(1).map(row => row.children.map(cell => cell.textContent));
}

describe("web Explorer", () => {
  it("Explorer plugs into the supplied view registry", async () => {
    // Break caught: exporting an inert entry that cannot mount and navigate through the shared app.
    const module = await import("../web/explorer.js"); const { startDashboard } = await import("../web/app.js");
    const f = fixture();
    const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client,
      initialRoute: { view: "explorer", period, filters }, mounts: module.EXPLORER_MOUNTS }); await settle();
    expect(f.root.textContent).not.toContain("This view is not included in this build.");
    expect(tableRows(f.root, "Selected usage")[0]!.slice(0, 2)).toEqual(["560 AIC cal", "~1,000 AIC published estimate"]);
    expect(f.requests[0]!.params.get("filters")).toBe('[{"field":"actor","value":"opaque-parent","kind":"id"}]');
    button(f.root, "Clear filters").click(); await settle();
    expect(f.requests.at(-1)!.params.get("filters")).toBe("[]"); expect(f.requests.at(-1)!.params.get("end")).toBe("172800000");
    app.dispose(); expect(f.doc.listeners.get("keydown")?.size ?? 0).toBe(0);
  });
  it("Explorer controls use labelled borderless theme surfaces", async () => {
    // Breaks caught: native controls outside the borderless type system, or a chart missing its image semantics.
    const f = fixture(() => ({ ...data(), rows: [{ key: ["opaque-model"], labels: ["W".repeat(160)], measure: measure() }] }));
    const view = await mount(f.ctx); await settle();
    expect(elements(f.root, "text")[0]!.textContent).toBe("W".repeat(24) + "…");
    expect(elements(f.root, "title")[1]!.textContent).toContain("W".repeat(160));
    expect(elements(f.root, "label").map(node => node.children[0]!.textContent)).toEqual(["Filter field", "Filter prefix", "Group by 1", "Group by 2", "Group by 3"]);
    const css = readFileSync(new URL("../web/theme.css", import.meta.url), "utf8");
    const explorerCss = css.split("/* Explorer */")[1];
    expect(explorerCss).toContain("border: 0"); expect(explorerCss).toContain("font: inherit");
    expect(explorerCss).toContain("max-width: 100%"); expect(explorerCss).not.toContain("appearance: none");
    expect(elements(f.root, "svg")[0]!.getAttribute("viewBox")).toBeNull();
    expect(explorerCss).toContain("font-size: 12px");
    expect(elements(f.root, "svg")[0]!.getAttribute("role")).toBe("img");
    expect(elements(f.root, "g")[0]!.getAttribute("role")).toBeNull();
    view.dispose(); f.root.replaceChildren(); const again = await mount(f.ctx); await settle();
    again.dispose();
  });
  it("unpriced pivots never invent a zero axis", async () => {
    // Break caught: null AIC being used as a priced zero in chart bounds or secondary amounts.
    const m = { ...measure(), pricedCalls: 0, unpricedCalls: 1, aic: null,
      aicDisplay: { primaryAic: null, publishedAic: null, basis: "published" as const } };
    const f = fixture(() => ({ ...data(), totals: m, rows: [{ key: ["unpriced"], labels: ["Unpriced model"], measure: m }] }));
    const view = await mount(f.ctx); await settle();
    expect(elements(f.root, "circle")).toHaveLength(0);
    expect(elements(f.root, "p").find(n => n.className === "numeric chart-summary")!.textContent).toBe("No recorded values in this period");
    expect(tableRows(f.root, "Pivot rows · published")[0]!.slice(1, 3)).toEqual(["unpriced AIC", "unpriced AIC"]);
    view.dispose();
  });
  it("Explorer refreshes only while visible active and unfocused", async () => {
    // Breaks caught: background or abandoned-tab refreshes, focus loss, and requests surviving disposal.
    vi.useFakeTimers();
    let online = true;
    const f = fixture(() => { if (!online) throw new TypeError("fixture offline"); return data(); });
    const view = await mount(f.ctx); await settle();
    const calls = () => f.requests.filter(r => r.path === "/api/explorer").length;
    expect(calls()).toBe(1); await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(2);
    const chartToggle = button(f.root, "Table"); chartToggle.focus();
    await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(2); expect(f.doc.activeElement).toBe(chartToggle);
    f.doc.activeElement = null; f.doc.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(2);
    f.doc.visibilityState = "visible"; await vi.advanceTimersByTimeAsync(120000); expect(calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(3);
    f.doc.dispatchEvent(new Event("keydown")); await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(4);
    const refresh = button(f.root, "Refresh"); refresh.focus(); online = false; refresh.click(); await settle();
    expect(f.root.textContent).toContain("Run /usage again"); await vi.advanceTimersByTimeAsync(600000); expect(calls()).toBe(5);
    online = true; const panel = field(f.root, "Pivot"); button(panel, "Retry").click(); await settle(); expect(calls()).toBe(6);
    f.doc.activeElement = null; await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(7);
    input(f.root, "cancelled"); f.controller.abort(); await vi.advanceTimersByTimeAsync(60000);
    expect(calls()).toBe(7); expect(vi.getTimerCount()).toBe(0);
    expect(f.doc.listeners.get("keydown")?.size ?? 0).toBe(0); expect(f.doc.listeners.get("pointerdown")?.size ?? 0).toBe(0);
    view.dispose();
  });
  it("filter values page without changing the pivot", async () => {
    // Breaks caught: dropping typeahead continuation, mixing its cursor with pivot paging, or retaining a field's results.
    vi.useFakeTimers();
    let releasePage!: (value: Page<FilterValue>) => void;
    const f = fixture(request => {
      if (request.path === "/api/explorer") return { ...data(), nextCursor: "pivot-cursor" };
      if (request.params.has("cursor")) return new Promise<Page<FilterValue>>(resolve => { releasePage = resolve; });
      return { rows: [{ id: "first-value", label: request.params.get("field") === "run" ? "Run value" : "First value" }], nextCursor: "values-cursor" };
    });
    const view = await mount(f.ctx); await settle(); input(f.root, "prefix"); await vi.advanceTimersByTimeAsync(300);
    const panel = field(f.root, "Filter values"), next = button(panel, "Next page"), back = button(panel, "Previous page");
    expect(f.root.textContent).toContain("First value"); expect(back.getAttribute("aria-disabled")).toBe("true"); next.click(); await settle();
    const values = f.requests.filter(r => r.path === "/api/filter-values"); expect(values).toHaveLength(2);
    expect(values[1]!.params.get("cursor")).toBe("values-cursor"); expect(values[1]!.params.get("prefix")).toBe("prefix");
    expect(values[1]!.params.get("field")).toBe("model"); expect(f.requests.filter(r => r.path === "/api/explorer")).toHaveLength(1);
    const chooseField = field(f.root, "Filter field"); chooseField.value = "run"; chooseField.dispatchEvent(new Event("change"));
    expect(values[1]!.signal.aborted).toBe(true); expect(f.root.textContent).not.toContain("First value"); expect(next.getAttribute("aria-disabled")).toBe("true"); expect(back.getAttribute("aria-disabled")).toBe("true");
    releasePage({ rows: [{ id: "stale", label: "Stale model value" }], nextCursor: null }); await settle();
    expect(f.root.textContent).not.toContain("Stale model value"); await vi.advanceTimersByTimeAsync(300);
    expect(f.root.textContent).toContain("Run value"); expect(f.requests.at(-1)!.params.has("cursor")).toBe(false);
    button(panel, "Run value").click(); button(panel, "Add filter").click();
    expect(f.routes.at(-1)!.filters?.at(-1)).toEqual({ field: "run", value: "first-value", kind: "id" });
    view.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it("keyset paging resets cleanly after a restart", async () => {
    // Breaks caught: using OFFSET, changing the cursor's slice, or retaining the old page after 409.
    let restarted = false, finishReset!: (value: ExplorerData) => void;
    const f = fixture(request => {
      const cursor = request.params.get("cursor");
      if (cursor === "cursor-2") { restarted = true; return new Response(JSON.stringify({ apiVersion: 1, error: { code: "ledger-changed", message: "ledger-changed" } }), { status: 409 }); }
      if (restarted) return new Promise<ExplorerData>(resolve => { finishReset = resolve; });
      return { ...data(), rows: [{ key: [cursor ? "second-key" : "first-key"], labels: [cursor ? "Second page" : "First page"], measure: measure() }], nextCursor: cursor ? "cursor-2" : "cursor-1" };
    });
    const view = await mount(f.ctx); await settle();
    expect(f.root.textContent).toContain("First page");
    const panel = field(f.root, "Pivot"), next = button(panel, "Next page"), back = button(panel, "Previous page");
    expect(back.getAttribute("aria-disabled")).toBe("true"); next.focus(); next.click(); await settle();
    expect(f.root.textContent).toContain("Second page"); expect(f.doc.activeElement).toBe(next); expect(back.getAttribute("aria-disabled")).toBe("false");
    back.click(); await settle(); expect(f.root.textContent).toContain("First page"); expect(back.getAttribute("aria-disabled")).toBe("true");
    f.ctx.period = { start: 100, end: 200 }; // paging must retain the first request's resolved window.
    next.click(); await settle(); next.click(); await settle();
    expect(f.root.textContent).toContain("Page link no longer valid. Showing page 1.");
    expect(f.root.textContent).toContain("Second page"); // Retain evidence while reset is busy.
    expect(next.getAttribute("aria-disabled")).toBe("true"); expect(back.getAttribute("aria-disabled")).toBe("true");
    finishReset({ ...data(), rows: [{ key: ["new-first"], labels: ["First page after restart"], measure: measure() }], nextCursor: "new-cursor" }); await settle();
    expect(f.root.textContent).toContain("First page after restart"); expect(f.root.textContent).toContain("Page link no longer valid. Showing page 1.");
    expect(back.getAttribute("aria-disabled")).toBe("true"); expect(next.getAttribute("aria-disabled")).toBe("false");
    expect(f.requests.map(r => r.params.get("cursor"))).toEqual([null, "cursor-1", null, "cursor-1", "cursor-2", null]);
    for (const request of f.requests) {
      expect(request.params.has("offset")).toBe(false);
      expect(request.params.get("start")).toBe("0"); expect(request.params.get("end")).toBe("172800000");
      expect(request.params.get("groupBy")).toBe("model"); expect(request.params.get("filters")).toBe('[{"field":"actor","value":"opaque-parent","kind":"id"}]');
    }
    view.dispose();
  });
  it("pivot cells drill into exact tuples", async () => {
    // Breaks caught: filtering by displayed labels, conflating null/Unknown, or re-aggregating chart measures.
    const hostile = '<script>attack()</script>';
    const f = fixture(request => request.params.get("groupBy") === "role,model,run" ? {
      ...data(), groupBy: ["role", "model", "run"], rows: [
        { key: ["opaque-unknown", null, "safe-run"], labels: ["Unknown", null, hostile], measure: { ...measure(), unpricedCalls: 1, aggregateCalls: 1, possibleOverlap: true, pendingData: true } },
        { key: [null, "opaque-model", "other-run"], labels: [null, "Model", "Other"], measure: { ...measure(), aic: 0, aicDisplay: { primaryAic: 0, publishedAic: 0, basis: "published" } } },
        { key: ["other-role", "opaque-model", null], labels: ["worker", "Model", "unsupported id"], measure: { ...measure(), pricedCalls: 0, unpricedCalls: 1, aic: null, aicDisplay: { primaryAic: null, publishedAic: null, basis: "published" } } },
      ],
    } : data());
    const view = await mount(f.ctx); await settle();
    vi.useFakeTimers();
    for (const [label, value] of [["Group by 1", "role"], ["Group by 2", "model"], ["Group by 3", "run"]]) {
      const control = field(f.root, label!); control.value = value!; control.dispatchEvent(new Event("change")); await settle();
    }
    await vi.advanceTimersByTimeAsync(300);
    const request = f.requests.filter(r => r.path === "/api/explorer").at(-1)!;
    expect(request.params.get("groupBy")).toBe("role,model,run"); expect(request.params.get("limit")).toBe("50");
    expect(request.params.get("filters")).toBe('[{"field":"actor","value":"opaque-parent","kind":"id"}]');
    const rows = tableRows(f.root, "Pivot rows · calibrated");
    expect(rows[0]).toEqual(["Unknown", "No value", hostile, "560+ AIC cal", "~1,000+ AIC published estimate",
      "input 10; cache read 20; cache write 30; output 40; prompt 60; total 100; cache write 1h unavailable; reasoning unavailable",
      "1 call; 1 unpriced; 1 aggregate · Possible overlap · Pending data"]);
    const chart = elements(f.root, "section").find(node => node.children.some(child => child.tagName === "H3" && child.textContent === "Pivot rows · calibrated"))!;
    expect(elements(chart, "circle")).toHaveLength(1);
    const title = elements(chart, "title")[1]!.textContent;
    expect(title).toContain("Unknown · No value · " + hostile); expect(title).toContain("560+ AIC cal"); expect(title).toContain("~1,000+ AIC published estimate");
    expect(title).toContain("input 10; cache read 20; cache write 30; output 40; prompt 60; total 100");
    expect(f.root.textContent).toContain("calibrated x0.56 over 7 days");
    const toggle = button(chart, "Table"); toggle.focus(); toggle.click();
    expect(f.doc.activeElement).toBe(toggle); expect(toggle.textContent).toBe("Table"); expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const tuple = [
      { field: "actor", value: "opaque-parent", kind: "id" }, { field: "role", value: "opaque-unknown", kind: "id" },
      { field: "model", kind: "missing" }, { field: "run", value: "safe-run", kind: "id" },
    ];
    const nullCell = button(chart, "No value"); nullCell.focus(); key(nullCell, "Enter");
    expect(f.routes).toHaveLength(0); nullCell.click();
    expect(f.routes[0]).toEqual({ view: "explorer", filters: tuple });
    key(elements(chart, "g")[0]!, " "); expect(f.routes).toHaveLength(1);
    const published = elements(f.root, "section").find(node => node.children.some(child => child.tagName === "H3" && child.textContent === "Pivot rows · published"))!;
    expect(tableRows(published, "Pivot rows · published")[0]!.slice(3, 5)).toEqual(["~0 AIC ?", "~0 AIC published estimate"]);
    expect(tableRows(published, "Pivot rows · published")[1]!.slice(3, 5)).toEqual(["unpriced AIC", "unpriced AIC"]);
    expect(elements(published, "circle")).toHaveLength(1); // priced zero is plotted; null is not.
    const unsupported = elements(published, "tr").at(-1)!;
    expect(elements(unsupported, "button")).toHaveLength(0); // no exact tuple exists for this count.
    expect(elements(f.root, "script")).toHaveLength(0);
    const clear = button(f.root, "Clear filters"); clear.click(); expect(f.routes.at(-1)).toEqual({ view: "explorer", filters: [] });
    view.dispose();
  });
  it("typeahead debounces twenty characters", async () => {
    // Breaks caught: per-key fetches, late responses replacing newer results, or sending a label as an id.
    vi.useFakeTimers();
    let releaseOld!: (value: Page<FilterValue>) => void;
    const hostile = '<img src=x onerror="attack()">';
    const f = fixture(request => {
      if (request.path === "/api/explorer") return data();
      if (request.params.get("prefix") === "abcdefghijklmnopqrst") return new Promise<Page<FilterValue>>(resolve => { releaseOld = resolve; });
      return { rows: [{ id: "not-a-shape-to-infer", label: hostile }, { id: null, label: "unsupported id", count: 7 }, { id: null, label: null }], nextCursor: null };
    });
    const view = await mount(f.ctx); await settle();
    for (let i = 1; i <= 20; i++) { input(f.root, "abcdefghijklmnopqrst".slice(0, i)); await vi.advanceTimersByTimeAsync(10); }
    expect(f.requests.filter(r => r.path === "/api/filter-values")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(289);
    expect(f.requests.filter(r => r.path === "/api/filter-values")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const old = f.requests.filter(r => r.path === "/api/filter-values"); expect(old).toHaveLength(1);
    expect(old[0]!.params.get("prefix")).toBe("abcdefghijklmnopqrst");
    expect(old[0]!.params.get("field")).toBe("model");
    expect(old[0]!.params.get("filters")).toBe('[{"field":"actor","value":"opaque-parent","kind":"id"}]');
    expect(old[0]!.params.get("start")).toBe("0"); expect(old[0]!.params.get("end")).toBe("172800000");
    input(f.root, "fresh"); expect(old[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(300); await settle();
    expect(f.root.textContent).toContain(hostile); expect(f.root.textContent).toContain("7 with unsupported ids");
    expect(elements(f.root, "button").some(node => node.textContent.includes("unsupported id"))).toBe(false);
    expect(elements(f.root, "button").some(node => node.textContent === "No value")).toBe(true);
    releaseOld({ rows: [{ id: "stale-id", label: "Stale result" }], nextCursor: null }); await settle();
    expect(f.root.textContent).not.toContain("Stale result");
    button(f.root, hostile).click(); button(f.root, "Add filter").click();
    expect(f.routes).toEqual([{ view: "explorer", filters: [
      { field: "actor", value: "opaque-parent", kind: "id" }, { field: "model", value: "not-a-shape-to-infer", kind: "id" },
    ] }]);
    expect(elements(f.root, "img")).toHaveLength(0);
    for (const node of descendants(f.root)) expect([...node.attributes.keys()].some(key => key === "style" || /^on/i.test(key))).toBe(false);
    input(f.root, "disposed"); view.dispose(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests.filter(r => r.path === "/api/filter-values")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Fix-round regressions. Each case names the missing guard or observable interaction it catches.
describe("Explorer fix round", () => {
  it.each([false, true])("drill preserves rolling versus explicit period and focuses the new heading (%s)", async explicit => {
    vi.useFakeTimers(); let now = Date.UTC(2026, 9, 2);
    const f = fixture(); const { startDashboard } = await import("../web/app.js");
    const { EXPLORER_MOUNTS } = await import("../web/explorer.js");
    const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client,
      now: () => now, initialRoute: { view: "explorer", ...(explicit ? { period } : {}) }, mounts: EXPLORER_MOUNTS }); await settle();
    button(f.root, "Table").click();
    const cell = button(f.root, "Model"); cell.focus(); cell.click(); await settle();
    expect(button(f.root, "Table").getAttribute("aria-pressed")).toBe("true");
    expect(descendants(f.root).find(n => n.getAttribute("role") === "region" && n.textContent.includes("Pivot rows"))!.hidden).toBe(false);
    expect(f.doc.activeElement?.tagName).toBe("H1"); expect(f.doc.activeElement?.getAttribute("tabindex")).toBe("-1");
    now += 300000; button(f.root, "Refresh").click(); await settle();
    expect(f.requests.filter(r => r.path === "/api/explorer").at(-1)!.params.get("end")).toBe(String(explicit ? 172800000 : now));
    app.dispose();
  });
  it("deduplicates tuples and Add filter without consuming the cap", async () => {
    vi.useFakeTimers(); const f = fixture(r => r.path === "/api/explorer" ? data() : { rows: [{ id: "opaque-model", label: "Model" }], nextCursor: null });
    f.ctx.filters = [{ field: "model", value: "opaque-model", kind: "id" }];
    const view = await mount(f.ctx); await settle(); button(f.root, "Model").click();
    expect(f.routes[0]!.filters).toEqual([{ field: "model", value: "opaque-model", kind: "id" }]);
    input(f.root, "Model"); await vi.advanceTimersByTimeAsync(300); button(field(f.root, "Filter values"), "Model").click(); button(f.root, "Add filter").click();
    expect(f.routes.at(-1)!.filters).toEqual([{ field: "model", value: "opaque-model", kind: "id" }]); view.dispose();
  });
  it.each(["invalid-query", "ledger-changed"] as const)("resets both invalid pagers, scopes notices and clears them on the next success (%s)", async code => {
    vi.useFakeTimers(); const f = fixture(r => {
      if (r.params.has("cursor")) return new Response(JSON.stringify({ apiVersion: 1, error: { code, message: "unsafe" } }), { status: code === "invalid-query" ? 400 : 409 });
      return r.path === "/api/explorer" ? { ...data(), nextCursor: "pivot-bad" } : { rows: [{ id: "value", label: "Value" }], nextCursor: "values-bad" };
    });
    const view = await mount(f.ctx); await settle(); const pivot = field(f.root, "Pivot"), values = field(f.root, "Filter values");
    button(pivot, "Next page").click(); await settle();
    expect(pivot.textContent).toContain("Page link no longer valid");
    expect(values.textContent).not.toContain("Showing page 1");
    button(pivot, "Refresh").click(); await settle();
    input(f.root, "V"); await vi.advanceTimersByTimeAsync(300); button(values, "Next page").click(); await settle();
    expect(pivot.textContent).not.toContain("Page link no longer valid"); expect(pivot.textContent).not.toContain("Showing page 1");
    expect(values.textContent).toContain("Page link no longer valid");
    expect(f.requests.filter(r => r.params.has("cursor")).map(r => r.params.get("cursor"))).toEqual(["pivot-bad", "values-bad"]);
    button(pivot, "Refresh").click(); await settle(); input(f.root, "Va"); await vi.advanceTimersByTimeAsync(300);
    expect(pivot.textContent).not.toContain("Showing page 1"); expect(values.textContent).not.toContain("Showing page 1");
    view.dispose();
  });
  it("pins each pager to the server-resolved window while rolling time advances", async () => {
    vi.useFakeTimers(); let end = 100;
    const f = fixture(); f.ctx.filters = []; Object.defineProperty(f.ctx, "period", { get: () => ({ start: 0, end }) });
    const sent: Request[] = [];
    f.ctx.client = { async get<T>(path: string, params: URLSearchParams, signal: AbortSignal) {
      sent.push({ path, params, signal });
      if (params.has("cursor") && params.get("end") !== "150") throw new DashboardClientError("invalid-query");
      const d = path === "/api/explorer" ? { ...data(), nextCursor: params.has("cursor") ? null : "pivot-page" } : { rows: [{ id: "a", label: "A" }], nextCursor: params.has("cursor") ? null : "search-page" };
      return { ...envelope(d), period: { start: 0, end: 150 } } as ApiEnvelope<T>;
    } };
    const view = await mount(f.ctx); await settle(); end = 200;
    button(field(f.root, "Pivot"), "Next page").click(); await settle();
    input(f.root, "A"); await vi.advanceTimersByTimeAsync(300); end = 300;
    button(field(f.root, "Filter values"), "Next page").click(); await settle();
    expect(sent.filter(r => r.params.has("cursor")).map(r => r.params.get("end"))).toEqual(["150", "150"]);
    expect(field(f.root, "Filter values").textContent).toContain("Choose a value");
    button(f.root, "Refresh").click(); await settle(); expect(sent.at(-1)!.params.get("end")).toBe("300");
    view.dispose();
  });
  it("keeps focused pagers focusable and guards repeated clicks while busy", async () => {
    let release!: (d: ExplorerData) => void;
    const f = fixture(r => r.params.has("cursor") ? new Promise<ExplorerData>(resolve => { release = resolve; }) : { ...data(), nextCursor: "next" });
    const view = await mount(f.ctx); await settle(); const panel = field(f.root, "Pivot"), next = button(panel, "Next page");
    next.focus(); next.click(); await settle(); expect(next.disabled).toBe(false); expect(f.doc.activeElement).toBe(next);
    expect(next.getAttribute("aria-disabled")).toBe("true"); expect(panel.getAttribute("aria-busy")).toBeNull();
    expect(descendants(panel).filter(n => n.getAttribute("aria-busy") === "true")).toHaveLength(1);
    next.click(); expect(f.requests).toHaveLength(2); expect(f.root.textContent).toContain("Model");
    release({ ...data(), nextCursor: null }); await settle(); expect(f.doc.activeElement).toBe(next); expect(panel.getAttribute("aria-busy")).toBeNull();
    expect(descendants(panel).some(n => n.getAttribute("aria-busy") === "true")).toBe(false);
    view.dispose();
  });
  it("automatic refresh retains the cursor, typeahead choice, old evidence and quiet live region", async () => {
    vi.useFakeTimers(); let release!: (d: ExplorerData) => void, defer = false;
    const f = fixture(r => r.path === "/api/filter-values" ? { rows: [{ id: "selected", label: "Selected value" }], nextCursor: null }
      : defer ? new Promise<ExplorerData>(resolve => { release = resolve; }) : { ...data(), nextCursor: "second" });
    const view = await mount(f.ctx); await settle(); button(field(f.root, "Pivot"), "Next page").click(); await settle();
    input(f.root, "Selected"); await vi.advanceTimersByTimeAsync(300); button(f.root, "Selected value").click();
    const notice = descendants(field(f.root, "Pivot")).filter(n => n.getAttribute("aria-live") === "polite").map(n => n.textContent);
    f.doc.activeElement = f.doc.body; defer = true; await vi.advanceTimersByTimeAsync(59700);
    expect(f.requests.at(-1)!.params.get("cursor")).toBe("second"); expect(f.root.textContent).toContain("Model");
    expect(f.root.textContent).toContain("Selected value"); expect(button(f.root, "Add filter").disabled).toBe(false);
    expect(descendants(field(f.root, "Pivot")).filter(n => n.getAttribute("aria-live") === "polite").map(n => n.textContent)).toEqual(notice);
    release({ ...data(), rows: [{ key: ["new"], labels: ["New value"], measure: measure() }], nextCursor: null }); await settle();
    expect(f.root.textContent).toContain("New value"); expect(descendants(field(f.root, "Pivot")).filter(n => n.getAttribute("aria-live") === "polite").map(n => n.textContent)).toEqual(notice);
    view.dispose();
  });
  it("sequence guards reject late transports that ignore abort and stale detached choices", async () => {
    vi.useFakeTimers(); const f = fixture(); f.ctx.filters = []; const pending: { request: Request; resolve(d: ApiEnvelope<unknown>): void }[] = [];
    f.ctx.client = { get<T>(path: string, params: URLSearchParams, signal: AbortSignal) { return new Promise<ApiEnvelope<T>>(resolve => {
      pending.push({ request: { path, params, signal }, resolve: resolve as (d: ApiEnvelope<unknown>) => void });
    }); } };
    const view = await mount(f.ctx); pending[0]!.resolve(envelope(data())); await settle();
    input(f.root, "old"); await vi.advanceTimersByTimeAsync(300); const oldSearch = pending.at(-1)!;
    input(f.root, "fresh"); await vi.advanceTimersByTimeAsync(300); pending.at(-1)!.resolve(envelope({ rows: [{ id: "fresh", label: "Fresh" }], nextCursor: null })); await settle();
    const staleChoice = button(f.root, "Fresh");
    oldSearch.resolve(envelope({ rows: [{ id: "old", label: "Stale search" }], nextCursor: null })); await settle(); expect(f.root.textContent).not.toContain("Stale search");
    input(f.root, "newest"); staleChoice.click(); expect(button(f.root, "Add filter").disabled).toBe(true);
    button(f.root, "Refresh").click(); const oldPivot = pending.at(-1)!;
    button(f.root, "Refresh").click(); expect(oldPivot.request.signal.aborted).toBe(true);
    pending.at(-1)!.resolve(envelope({ ...data(), rows: [{ key: ["fresh"], labels: ["Fresh pivot"], measure: measure() }] })); await settle();
    oldPivot.resolve(envelope({ ...data(), rows: [{ key: ["old"], labels: ["Stale pivot"], measure: measure() }] })); await settle();
    expect(f.root.textContent).not.toContain("Stale pivot"); expect(f.root.textContent).toContain("Fresh pivot"); view.dispose();
  });
  it("debounces regrouping, rejects duplicate groups and discards the old cursor", async () => {
    vi.useFakeTimers(); const f = fixture(() => ({ ...data(), nextCursor: "old-model-cursor" })); const view = await mount(f.ctx); await settle();
    button(field(f.root, "Pivot"), "Next page").click(); await settle();
    for (const value of ["role", "agent", "runName"]) { const group = field(f.root, "Group by 1"); group.value = value; group.dispatchEvent(new Event("change")); await vi.advanceTimersByTimeAsync(10); }
    expect(f.requests).toHaveLength(2); expect(vi.getTimerCount()).toBe(2); await vi.advanceTimersByTimeAsync(290);
    expect(f.requests).toHaveLength(3); expect(f.requests.at(-1)!.params.get("groupBy")).toBe("runName"); expect(f.requests.at(-1)!.params.has("cursor")).toBe(false);
    const second = field(f.root, "Group by 2"); second.value = "runName"; second.dispatchEvent(new Event("change")); await vi.advanceTimersByTimeAsync(300);
    expect(f.requests).toHaveLength(3); expect(f.root.textContent).toContain("different groups"); view.dispose();
  });
  it("cancels old debounce timers and clamps astral prefixes by code points", async () => {
    vi.useFakeTimers(); const f = fixture(r => r.path === "/api/explorer" ? data() : { rows: [], nextCursor: null }); const view = await mount(f.ctx); await settle();
    input(f.root, "old"); input(f.root, "😀".repeat(161)); expect(vi.getTimerCount()).toBe(2);
    expect(field(f.root, "Filter prefix").getAttribute("maxlength")).toBeNull(); await vi.advanceTimersByTimeAsync(300);
    expect(f.requests.at(-1)!.params.get("prefix")).toBe("😀".repeat(160)); expect(field(f.root, "Filter prefix").value).toBe("😀".repeat(160)); view.dispose();
  });
  it("enforces all three filter caps, even stale Add controls", async () => {
    vi.useFakeTimers(); const f = fixture(r => r.path === "/api/explorer" ? data() : { rows: [{ id: "extra", label: "Extra" }], nextCursor: null });
    f.ctx.filters = Array.from({ length: 16 }, (_, i) => ({ field: "actor" as const, value: `actor-${i}`, kind: "id" as const }));
    const view = await mount(f.ctx); await settle();
    expect(elements(f.root, "g")[0]!.getAttribute("role")).toBeNull();
    expect(elements(f.root, "table").at(-1) && elements(elements(f.root, "table").at(-1)!, "button")).toHaveLength(0);
    input(f.root, "Extra"); await vi.advanceTimersByTimeAsync(300); button(f.root, "Extra").click(); expect(button(f.root, "Add filter").disabled).toBe(true);
    button(f.root, "Add filter").dispatchEvent(new Event("click")); expect(f.routes).toHaveLength(0); view.dispose();
  });
  it("renders back-applied primaries, friendly dimensions, singular counts and named regions", async () => {
    const m = { ...measure(), aicDisplay: { ...measure().aicDisplay, basis: "back-applied" as const } };
    const f = fixture(() => ({ ...data(), groupBy: ["requestedModel"], totals: m, rows: [{ key: ["model-id"], labels: ["Model"], measure: m }] })); const view = await mount(f.ctx); await settle();
    expect(tableRows(f.root, "Pivot rows · calibrated, back-applied")[0]![1]).toBe("560 AIC calibrated, back-applied");
    expect(elements(f.root, "th").some(n => n.textContent === "Requested model")).toBe(true);
    expect(elements(f.root, "option").some(n => n.textContent === "Auxiliary purpose")).toBe(true);
    expect(f.root.textContent).toContain("1 pivot row on this page"); expect(f.root.textContent).toContain("1 call;");
    const regions = descendants(f.root).filter(n => n.getAttribute("role") === "region");
    expect(new Set(regions.map(n => n.getAttribute("aria-labelledby"))).size).toBe(regions.length); view.dispose();
  });
});

describe("Explorer saved filters", () => {
  it("resolves saved labels, removes one pill and keeps other filters", async () => {
    const f = fixture(r => r.path === "/api/filter-values" ? { rows: [{ id: "opaque-parent", label: "Parent actor" }], nextCursor: null } : data());
    const view = await mount(f.ctx); await settle();
    expect(field(f.root, "Active filters").textContent).toContain("Actor = Parent actor");
    field(f.root, "Remove filter actor").click(); expect(f.routes.at(-1)).toEqual({ view: "explorer", filters: [] }); view.dispose();
  });
  it("removes only invalid saved ids and preserves valid filters without an impossible Retry", async () => {
    const respond = (r: Request) => {
      const selection = JSON.parse(r.params.get("filters")!) as Filter[];
      if (selection.some(filter => filter.value === "bad-id")) return new Response(JSON.stringify({ apiVersion: 1, error: { code: "unknown-filter-id", message: "private" } }), { status: 400 });
      return r.path === "/api/filter-values" ? { rows: [{ id: "good-id", label: "Good model" }], nextCursor: null } : data();
    };
    const f = fixture(respond, respond);
    f.ctx.filters = [{ field: "actor", value: "bad-id", kind: "id" }, { field: "model", value: "good-id", kind: "id" }];
    const view = await mount(f.ctx); await settle();
    expect(f.routes.at(-1)?.filters).toEqual([{ field: "model", value: "good-id", kind: "id" }]);
    expect(f.root.textContent).toContain("A saved filter no longer matches any data and was removed");
    expect(button(field(f.root, "Pivot"), "Retry").hidden).toBe(true);
    view.dispose(); f.root.replaceChildren(); f.ctx.filters = f.routes.at(-1)!.filters!;
    const remounted = await mount(f.ctx); await settle(); expect(f.root.textContent).toContain("A saved filter no longer matches any data and was removed"); remounted.dispose();
  });
  it("does not retry or automatically repeat identity-unavailable", async () => {
    vi.useFakeTimers(); const f = fixture(() => new Response(JSON.stringify({ apiVersion: 1, error: { code: "identity-unavailable", message: "private" } }), { status: 503 }));
    const view = await mount(f.ctx); await settle(); expect(f.root.textContent).toContain("Usage identity unavailable");
    expect(button(field(f.root, "Pivot"), "Retry").hidden).toBe(true);
    const count = f.requests.length; await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(count); view.dispose();
  });
});

describe("Explorer subsequent page notices", () => {
  it("clears each reset notice on its next successful cursor page", async () => {
    vi.useFakeTimers(); const reset = new Set<string>();
    const f = fixture(r => {
      if (r.params.get("cursor") === "bad") {
        reset.add(r.path); return new Response(JSON.stringify({ apiVersion: 1, error: { code: "ledger-changed", message: "unsafe" } }), { status: 409 });
      }
      const nextCursor = r.params.has("cursor") ? null : reset.has(r.path) ? "good" : "bad";
      return r.path === "/api/explorer" ? { ...data(), nextCursor } : { rows: [{ id: "a", label: "A" }], nextCursor };
    });
    const view = await mount(f.ctx); await settle(); const pivot = field(f.root, "Pivot"), values = field(f.root, "Filter values");
    button(pivot, "Next page").click(); await settle(); expect(pivot.textContent).toContain("Showing page 1");
    button(pivot, "Next page").click(); await settle(); expect(pivot.textContent).not.toContain("Showing page 1");
    input(f.root, "A"); await vi.advanceTimersByTimeAsync(300); button(values, "Next page").click(); await settle(); expect(values.textContent).toContain("Showing page 1");
    button(values, "Next page").click(); await settle(); expect(values.textContent).not.toContain("Showing page 1"); view.dispose();
  });
});

describe("Explorer quiet automatic recovery", () => {
  it("does not announce an automatic cursor reset", async () => {
    vi.useFakeTimers(); let changed = false;
    const f = fixture(r => {
      if (changed && r.params.has("cursor")) return new Response(JSON.stringify({ apiVersion: 1, error: { code: "ledger-changed", message: "unsafe" } }), { status: 409 });
      return { ...data(), nextCursor: "second" };
    });
    const view = await mount(f.ctx); await settle(); const panel = field(f.root, "Pivot"); button(panel, "Next page").click(); await settle();
    const announcements = () => descendants(panel).filter(n => n.getAttribute("aria-live") === "polite").map(n => n.textContent);
    const before = announcements(); changed = true; f.doc.activeElement = f.doc.body; await vi.advanceTimersByTimeAsync(60000);
    expect(f.requests.map(r => r.params.get("cursor"))).toEqual([null, "second", "second", null]);
    expect(announcements()).toEqual(before); view.dispose();
  });
});

describe("Explorer explicit missing selections", () => {
  it("selects Unknown in typeahead as missing and leaves unsafe ids inert", async () => {
    vi.useFakeTimers();
    const f = fixture(r => r.path === "/api/explorer" ? data() : { rows: [
      { id: null, label: null }, { id: null, label: "unsupported id", count: 7 }, { id: "real-unknown", label: "Unknown" },
    ], nextCursor: null });
    const view = await mount(f.ctx); await settle(); input(f.root, ""); await vi.advanceTimersByTimeAsync(300);
    const panel = field(f.root, "Filter values");
    const unknown = descendants(panel).find(n => n.getAttribute("aria-label") === "No value (missing)");
    expect(unknown).toBeDefined(); expect(unknown!.textContent).toBe("No value"); unknown!.click(); button(panel, "Add filter").click();
    expect(f.routes.at(-1)!.filters).toEqual([{ field: "actor", value: "opaque-parent", kind: "id" }, { field: "model", kind: "missing" }]);
    expect(panel.textContent).toContain("7 with unsupported ids");
    expect(elements(panel, "button").some(n => n.textContent.includes("unsupported"))).toBe(false);
    elements(panel, "button").filter(n => n.textContent === "Unknown").at(-1)!.click(); button(panel, "Add filter").click();
    expect(f.routes.at(-1)!.filters?.at(-1)).toEqual({ field: "model", value: "real-unknown", kind: "id" }); view.dispose();
  });
  it("sends missing without raw null, deduplicates it and offers individual pill removal", async () => {
    const f = fixture(() => ({ ...data(), rows: [{ key: [null], labels: [null], measure: measure() }] }));
    // Current snapshot's shared Filter type predates the controller's new wire shape.
    f.ctx.filters = [{ field: "model", kind: "missing" }, { field: "actor", value: "opaque-parent", kind: "id" }] as unknown as Filter[];
    const view = await mount(f.ctx); await settle();
    expect(f.requests[0]!.params.get("filters")).toBe('[{"field":"model","kind":"missing"},{"field":"actor","value":"opaque-parent","kind":"id"}]');
    expect(field(f.root, "Active filters").textContent).toContain("Model = No value");
    button(f.root, "No value").click(); expect(f.routes.at(-1)!.filters).toHaveLength(2);
    field(f.root, "Remove filter model").click();
    expect(f.routes.at(-1)!.filters).toEqual([{ field: "actor", value: "opaque-parent", kind: "id" }]); view.dispose();
  });
  it("migrates an old bookmarked raw-null selection to the missing wire shape", async () => {
    const f = fixture(); f.ctx.filters = [{ field: "model", value: null, kind: "raw" }] as unknown as Filter[];
    const view = await mount(f.ctx); await settle(); expect(f.requests[0]!.params.get("filters")).toBe('[{"field":"model","kind":"missing"}]');
    expect(field(f.root, "Active filters").textContent).toContain("Model = No value"); view.dispose();
  });
});

describe("Explorer fix round 2", () => {
  it("keeps SVG marks inert while table cells still drill", async () => {
    // Break caught: reintroducing invisible interactive chart stops or click handlers.
    const f = fixture(); const view = await mount(f.ctx); await settle();
    for (const mark of elements(f.root, "g")) {
      expect(mark.getAttribute("aria-hidden")).toBe("true"); expect(mark.getAttribute("tabindex")).toBeNull();
      expect(mark.getAttribute("role")).toBeNull(); expect(mark.listeners.get("click")?.size ?? 0).toBe(0);
      mark.click(); key(mark, "Enter"); key(mark, " ");
    }
    expect(f.routes).toHaveLength(0); button(f.root, "Model").click(); expect(f.routes).toHaveLength(1); view.dispose();
  });
  it("uses the current rolling period for automatic page 1 refresh, typeahead and regroup, but pins page 2", async () => {
    // Breaks caught: frozen refresh/search/regroup, or rolling a cursor's pinned period.
    vi.useFakeTimers(); let now = Date.UTC(2026, 9, 2);
    const f = fixture(r => {
      const d = r.path === "/api/explorer" ? { ...data(), nextCursor: "page2" } : { rows: [{ id: "a", label: "A" }], nextCursor: "values2" };
      return new Response(JSON.stringify({ ...envelope(d), period: { start: Number(r.params.get("start")), end: Number(r.params.get("end")) } }));
    });
    const { startDashboard } = await import("../web/app.js"), { EXPLORER_MOUNTS } = await import("../web/explorer.js");
    const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client,
      now: () => now, initialRoute: { view: "explorer" }, mounts: EXPLORER_MOUNTS }); await settle();
    button(f.root, "Model").click(); await settle(); now += 60000; f.doc.activeElement = f.doc.body;
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.requests.filter(r => r.path === "/api/explorer").at(-1)!.params.get("end")).toBe(String(now));
    const pinned = now; button(field(f.root, "Pivot"), "Next page").click(); await settle(); now += 60000;
    await vi.advanceTimersByTimeAsync(60000);
    const autoPage2 = f.requests.filter(r => r.path === "/api/explorer").at(-1)!;
    expect(autoPage2.params.get("cursor")).toBe("page2"); expect(autoPage2.params.get("end")).toBe(String(pinned));
    input(f.root, "A"); await vi.advanceTimersByTimeAsync(300);
    expect(f.requests.filter(r => r.path === "/api/filter-values").at(-1)!.params.get("end")).toBe(String(now));
    const valuesPinned = now; now += 60000; button(field(f.root, "Filter values"), "Next page").click(); await settle();
    expect(f.requests.filter(r => r.path === "/api/filter-values").at(-1)!.params.get("end")).toBe(String(valuesPinned));
    const group = field(f.root, "Group by 1"); group.value = "role"; group.dispatchEvent(new Event("change")); await vi.advanceTimersByTimeAsync(300);
    const regroup = f.requests.filter(r => r.path === "/api/explorer").at(-1)!;
    expect(regroup.params.has("cursor")).toBe(false); expect(regroup.params.get("end")).toBe(String(now)); app.dispose();
  });
  it("distinguishes missing from real Unknown in every surface, including the shared header", async () => {
    // Break caught: conflating SQL NULL with a stored label, or printing undefined in the shell.
    vi.useFakeTimers(); const f = fixture(r => r.path === "/api/explorer" ? { ...data(), rows: [
      { key: [null], labels: [null], measure: measure() }, { key: ["real-unknown"], labels: ["Unknown"], measure: measure() },
    ] } : { rows: [{ id: null, label: null }, { id: "real-unknown", label: "Unknown" }], nextCursor: null });
    const { startDashboard } = await import("../web/app.js"), { EXPLORER_MOUNTS } = await import("../web/explorer.js");
    const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client,
      initialRoute: { view: "explorer", period, filters: [{ field: "model", kind: "missing" }, { field: "model", kind: "id", value: "real-unknown" }] as unknown as Filter[] }, mounts: EXPLORER_MOUNTS }); await settle();
    const header = elements(f.root, "header")[0]!; expect(header.textContent).toContain("model: No value"); expect(header.textContent).not.toContain("undefined");
    const missingHeader = field(header, "No value (missing)"); expect(missingHeader.className).toContain("missing-value");
    const pills = field(f.root, "Active filters"); expect(pills.textContent).toContain("Model = No value"); expect(pills.textContent).toContain("Model = Unknown");
    expect(field(pills, "No value (missing)").className).toContain("missing-value");
    const remove = field(pills, "Remove filter model"); expect(remove.textContent).toBe("Remove"); expect(remove.className).toContain("filter-remove");
    expect(tableRows(f.root, "Pivot rows · calibrated").map(r => r[0])).toEqual(["No value", "Unknown"]);
    expect(button(f.root, "No value").getAttribute("aria-label")).toBe("Drill into model: No value");
    const pivotLabel = elements(f.root, "text").find(n => n.textContent === "No value")!;
    expect(pivotLabel.getAttribute("aria-label")).toBe("No value (missing)"); expect(pivotLabel.className).toContain("missing-value");
    input(f.root, ""); await vi.advanceTimersByTimeAsync(300); const values = field(f.root, "Filter values");
    const missing = button(values, "No value"), real = button(values, "Unknown");
    expect(missing.getAttribute("aria-label")).toBe("No value (missing)"); expect(missing.className).toContain("missing-value");
    expect(real.getAttribute("aria-label")).not.toBe("No value (missing)");
    const css = readFileSync(new URL("../web/theme.css", import.meta.url), "utf8");
    expect(css).toContain("\n.missing-value { color: var(--text-secondary);");
    expect(css).toContain(".usage-explorer .pivot-chart .missing-value { fill: var(--text-secondary);");
    expect(css).toContain(".usage-explorer .pivot-chart .pivot-label { font-family: var(--text-face);");
    expect(css).toMatch(/\.usage-explorer \.filter-pill \{[^}]*background: var\(--surface\)/);
    expect(css).toContain(".usage-explorer .filter-pill .filter-remove { background: var(--raised);");
    app.dispose();
  });
  it.each(["Pivot", "Filter values"])("keeps Retry focus on repeated failure and moves it to a heading on success (%s)", async panelName => {
    // Breaks caught: hiding a focused Retry and dropping focus to BODY in either outcome.
    vi.useFakeTimers(); let failing = true;
    const f = fixture(r => {
      if ((panelName === "Pivot") === (r.path === "/api/explorer") && failing) throw new DashboardClientError("busy");
      return r.path === "/api/explorer" ? data() : { rows: [{ id: "a", label: "A" }], nextCursor: null };
    });
    const view = await mount(f.ctx); await settle(); if (panelName === "Filter values") { input(f.root, "A"); await vi.advanceTimersByTimeAsync(300); }
    const panel = field(f.root, panelName), retry = button(panel, "Retry"); retry.focus(); retry.click(); await settle();
    expect(retry.hidden).toBe(false); expect(f.doc.activeElement).toBe(retry);
    failing = false; retry.click(); await settle(); expect(retry.hidden).toBe(true);
    expect(["H1", "H2"]).toContain(f.doc.activeElement?.tagName); expect(f.doc.activeElement?.getAttribute("tabindex")).toBe("-1"); view.dispose();
  });
  it("continues pivot automatic refresh after a non-retryable filter-values error", async () => {
    // Break caught: the search invalid-query error setting the pivot's stopped flag.
    vi.useFakeTimers(); const f = fixture(r => r.path === "/api/explorer" ? data() : new Response(JSON.stringify({ apiVersion: 1, error: { code: "invalid-query", message: "unsafe" } }), { status: 400 }));
    const view = await mount(f.ctx); await settle(); input(f.root, "A"); await vi.advanceTimersByTimeAsync(300);
    expect(button(field(f.root, "Filter values"), "Retry").hidden).toBe(true); f.doc.activeElement = f.doc.body;
    await vi.advanceTimersByTimeAsync(179700); expect(f.requests.filter(r => r.path === "/api/explorer")).toHaveLength(4); view.dispose();
  });
  it("aborts pending saved-label transports on disposal", async () => {
    // Break caught: disposal forgetting the independent label controller.
    let release!: (d: unknown) => void;
    const f = fixture(() => data(), () => new Promise(resolve => { release = resolve; }));
    const view = await mount(f.ctx); await settle(); expect(f.labelRequests).toHaveLength(1); view.dispose();
    expect(f.labelRequests[0]!.signal.aborted).toBe(true); release({ rows: [{ id: "opaque-parent", label: "Late" }], nextCursor: null }); await settle();
    expect(field(f.root, "Active filters").textContent).not.toContain("Late");
  });
  it("deduplicates saved filters before requests and pill rendering", async () => {
    // Break caught: mount sending duplicate bookmarked filters even if navigate dedupes later.
    const f = fixture(); f.ctx.filters = [...filters, ...filters]; const view = await mount(f.ctx); await settle();
    expect(JSON.parse(f.requests[0]!.params.get("filters")!)).toHaveLength(1);
    expect(descendants(field(f.root, "Active filters")).filter(n => n.className === "filter-pill")).toHaveLength(1); view.dispose();
  });
  it("positions dots from primary AIC, not row order or published estimates", async () => {
    // Break caught: fixed x or a secondary AIC being used to position categorical dots.
    const f = fixture(() => ({ ...data(), rows: [0, 140, 560].map((value, i) => ({ key: [String(i)], labels: [String(i)], measure: { ...measure(), aicDisplay: { primaryAic: value, publishedAic: 1000, basis: "calibrated" } } })) }));
    const view = await mount(f.ctx); await settle(); expect(elements(f.root, "circle").map(n => n.getAttribute("cx"))).toEqual(["55%", "65%", "95%"]);
    expect(tableRows(f.root, "Pivot rows · calibrated").map(r => r[1])).toEqual(["0 AIC cal", "140 AIC cal", "560 AIC cal"]); view.dispose();
  });
  it("revalidates cached labels when the server invalidates an id", async () => {
    // Break caught: force=true being ignored after a typeahead has populated the label cache.
    vi.useFakeTimers(); let invalid = false;
    const f = fixture(r => r.path === "/api/explorer" ? data() : { rows: [{ id: "selected", label: "Selected" }], nextCursor: null }, () => {
      if (invalid) throw new DashboardClientError("unknown-filter-id"); return { rows: [{ id: "opaque-parent", label: "Parent" }], nextCursor: null };
    });
    let view = await mount(f.ctx); await settle(); input(f.root, "S"); await vi.advanceTimersByTimeAsync(300); button(f.root, "Selected").click(); button(f.root, "Add filter").click();
    view.dispose(); f.root.replaceChildren(); f.ctx.filters = f.routes.at(-1)!.filters!; invalid = true;
    f.ctx.client = { async get<T>(path: string, params: URLSearchParams) {
      if (path === "/api/explorer" || JSON.parse(params.get("filters")!).some((x: Filter) => x.value === "selected")) throw new DashboardClientError("unknown-filter-id");
      return envelope({ rows: [{ id: "opaque-parent", label: "Parent" }], nextCursor: null }) as ApiEnvelope<T>;
    } };
    view = await mount(f.ctx); await settle(); expect(f.routes.at(-1)!.filters).toEqual(filters); view.dispose();
  });
  it("does not accept an unrelated label lookup row", async () => {
    // Break caught: resolving to rows[0] instead of matching the opaque selection id.
    const f = fixture(() => data(), () => ({ rows: [{ id: "other", label: "Wrong label" }], nextCursor: null }));
    const view = await mount(f.ctx); await settle(); expect(field(f.root, "Active filters").textContent).not.toContain("Wrong label");
    expect(field(f.root, "Active filters").textContent).toContain("label unavailable"); view.dispose();
  });
  it("does not navigate from detached controls after disposal", async () => {
    // Break caught: removing navigate's disposed guard.
    const f = fixture(); const view = await mount(f.ctx); await settle(); const clear = button(f.root, "Clear filters"), cell = button(f.root, "Model");
    view.dispose(); clear.click(); cell.click(); field(f.root, "Remove filter actor").click(); expect(f.routes).toHaveLength(0);
  });
  it("drops malformed saved filters with a removal notice, not an impossible Refresh", async () => {
    // Break caught: passing malformed bookmarks to the server and asking the user to refresh them.
    const f = fixture(); f.ctx.filters = [filters[0]!, { field: "model", kind: "raw", value: "old-label" }, { field: "no-such-field", kind: "missing" }, { field: "model", kind: "id" }, { field: "model", kind: "id", value: null }] as unknown as Filter[];
    const view = await mount(f.ctx); await settle(); expect(f.routes.at(-1)!.filters).toEqual(filters);
    expect(f.root.textContent).toContain("Saved filter removed"); expect(f.root.textContent).not.toContain("Refresh to start");
    expect(button(field(f.root, "Pivot"), "Retry").hidden).toBe(true); view.dispose();
  });
  it("caches unresolvable labels per revision even while the rolling period advances", async () => {
    // Break caught: repeating unavailable lookups as end advances, or caching them across revisions forever.
    let revision = "fixture:0";
    const f = fixture(r => new Response(JSON.stringify({ ...envelope(data()), revision, period: { start: Number(r.params.get("start")), end: Number(r.params.get("end")) } })), () => ({ rows: [], nextCursor: null }));
    const view = await mount(f.ctx); await settle(); expect(f.labelRequests).toHaveLength(1);
    button(f.root, "Refresh").click(); await settle(); expect(f.labelRequests).toHaveLength(1);
    revision = "fixture:1"; button(f.root, "Refresh").click(); await settle(); expect(f.labelRequests).toHaveLength(2);
    f.ctx.period = { start: 1, end: 200 }; button(f.root, "Refresh").click(); await settle(); expect(f.labelRequests).toHaveLength(2); view.dispose();
  });
  it.each(["Pivot", "Filter values"])("restores the displayed page position after failed Next, and Retry retries the failed page (%s)", async panelName => {
    // Break caught: advancing history after failure, so Back reloads an already displayed page.
    vi.useFakeTimers(); let fail = true;
    const f = fixture(r => {
      if ((panelName === "Pivot") === (r.path === "/api/explorer") && r.params.has("cursor") && fail) throw new DashboardClientError("busy");
      return r.path === "/api/explorer" ? { ...data(), nextCursor: r.params.has("cursor") ? null : "second" } : { rows: [{ id: "a", label: "A" }], nextCursor: r.params.has("cursor") ? null : "second" };
    });
    const view = await mount(f.ctx); await settle(); if (panelName === "Filter values") { input(f.root, "A"); await vi.advanceTimersByTimeAsync(300); }
    const panel = field(f.root, panelName); button(panel, "Next page").click(); await settle();
    expect(button(panel, "Previous page").getAttribute("aria-disabled")).toBe("true");
    expect(panel.textContent).toContain(panelName === "Pivot" ? "Model" : "A"); const count = f.requests.length; button(panel, "Previous page").click(); await settle(); expect(f.requests).toHaveLength(count);
    fail = false; button(panel, "Retry").click(); await settle(); expect(f.requests.at(-1)!.params.get("cursor")).toBe("second");
    expect(button(panel, "Previous page").getAttribute("aria-disabled")).toBe("false"); view.dispose();
  });
  it("counts the cap after deduplication for rendered cells, drill actions and Add", async () => {
    // Break caught: counting duplicate existing or tuple filters before allowing navigation.
    vi.useFakeTimers(); const f = fixture(r => r.path === "/api/explorer" ? data() : { rows: [{ id: "opaque-model", label: "Model" }], nextCursor: null });
    f.ctx.filters = [...Array.from({ length: 15 }, (_, i) => ({ field: "actor" as const, kind: "id" as const, value: `a${i}` })), { field: "model", kind: "id", value: "opaque-model" }];
    f.ctx.filters = [...f.ctx.filters, ...f.ctx.filters]; const view = await mount(f.ctx); await settle();
    button(f.root, "Model").click(); expect(f.routes.at(-1)!.filters).toHaveLength(16);
    input(f.root, "Model"); await vi.advanceTimersByTimeAsync(300); button(field(f.root, "Filter values"), "Model").click();
    expect(button(f.root, "Add filter").disabled).toBe(false); button(f.root, "Add filter").click(); expect(f.routes).toHaveLength(2); expect(f.routes.at(-1)!.filters).toHaveLength(16); view.dispose();
  });
});


describe("Explorer round 2 lifecycle boundaries", () => {
  it("does not steal external focus on a navigation remount", async () => {
    // Break caught: state.focus ignoring a control outside the remounted view.
    const f = fixture(); let view = await mount(f.ctx); await settle(); button(f.root, "Clear filters").click();
    view.dispose(); f.root.replaceChildren(); const outside = f.doc.createElement("button"); f.doc.body.append(outside); outside.focus();
    view = await mount(f.ctx); await settle(); expect(f.doc.activeElement).toBe(outside); view.dispose();
  });
  it("uses pivot labels for saved opaque ids without extra lookups", async () => {
    // Break caught: discarding exact labels already present in the pivot response.
    const f = fixture(() => data(), () => ({ rows: [], nextCursor: null })); f.ctx.filters = [{ field: "model", kind: "id", value: "opaque-model" }];
    const view = await mount(f.ctx); await settle(); expect(field(f.root, "Active filters").textContent).toContain("Model = Model");
    expect(f.labelRequests).toHaveLength(0); view.dispose();
  });
  it.each(["identity-unavailable", "unauthorized", "server-unavailable"] as const)("lets the pivot decide its own refresh policy after a terminal search failure (%s)", async code => {
    // Break caught: a filter-values failure stopping a still-successful independent pivot.
    vi.useFakeTimers(); const f = fixture(r => { if (r.path === "/api/filter-values") throw new DashboardClientError(code); return data(); });
    const view = await mount(f.ctx); await settle(); input(f.root, "A"); await vi.advanceTimersByTimeAsync(300); f.doc.activeElement = f.doc.body;
    await vi.advanceTimersByTimeAsync(120000); expect(f.requests.filter(r => r.path === "/api/explorer")).toHaveLength(3); view.dispose();
  });
});


describe("Explorer alignment", () => {
  it("uses idempotent Chart and Table pills with accessible wrapping extrema", async () => {
    // Breaks caught: legacy toggle, SVG summary, first-tie lower bound, or invented zero minimum.
    const lower = { ...measure(), unpricedCalls: 1 };
    const low = { ...measure(), aicDisplay: { ...measure().aicDisplay, primaryAic: 100 } };
    const f = fixture(() => ({ ...data(), rows: [
      { key: ["low"], labels: ["Low"], measure: low },
      { key: ["low-plus"], labels: ["Low plus"], measure: { ...low, unpricedCalls: 1 } },
      { key: ["high"], labels: ["High"], measure: measure() },
      { key: ["high-plus"], labels: ["High plus"], measure: lower },
    ] }));
    const view = await mount(f.ctx); await settle();
    const group = field(f.root, "Chart representation"); expect(group.getAttribute("role")).toBe("group");
    const chart = button(group, "Chart"), table = button(group, "Table");
    const graphic = descendants(f.root).find(n => n.id === chart.getAttribute("aria-controls"))!;
    const region = descendants(f.root).find(n => n.id === table.getAttribute("aria-controls"))!;
    expect(graphic.hidden).toBe(false); expect(region.hidden).toBe(true);
    expect(chart.getAttribute("aria-pressed")).toBe("true"); expect(table.getAttribute("aria-pressed")).toBe("false");
    table.focus(); table.click(); table.click();
    expect(f.doc.activeElement).toBe(table); expect(region.hidden).toBe(false); expect(graphic.hidden).toBe(true);
    expect(chart.getAttribute("aria-pressed")).toBe("false"); expect(table.getAttribute("aria-pressed")).toBe("true");
    chart.focus(); chart.click(); chart.click();
    expect(f.doc.activeElement).toBe(chart); expect(region.hidden).toBe(true); expect(graphic.hidden).toBe(false);
    expect(chart.getAttribute("aria-pressed")).toBe("true"); expect(table.getAttribute("aria-pressed")).toBe("false");
    const caption = elements(graphic, "p")[0]!;
    expect(caption.className).toBe("numeric chart-summary");
    expect(caption.textContent).toBe("Low to High plus · 100+ AIC calibrated minimum · 560+ AIC calibrated maximum");
    const svg = elements(graphic, "svg")[0]!;
    expect(caption.id).not.toBe("");
    expect(svg.getAttribute("aria-describedby")).toBe(caption.id);
    expect(svg.getAttribute("aria-label")).toBe("Pivot rows · calibrated · " + caption.textContent);
    expect(elements(svg, "text").map(n => n.textContent)).toEqual(["Low", "Low plus", "High", "High plus"]);
    const css = readFileSync(new URL("../web/theme.css", import.meta.url), "utf8");
    expect(css.split("/* Explorer */")[1]).not.toContain('.usage-explorer .action[aria-disabled="true"]');
    view.dispose();
  });
  it("keeps nonfinite observations unavailable instead of plotting or captioning them", async () => {
    // Break caught: a malformed numeric observation contaminating the extrema or dot positions.
    const f = fixture(); f.ctx.filters = [];
    f.ctx.client = { async get<T>() {
      return envelope({ ...data(), rows: [Infinity, NaN].map((value, i) => ({ key: [String(i)], labels: [String(i)],
        measure: { ...measure(), aicDisplay: { ...measure().aicDisplay, primaryAic: value } } })) }) as ApiEnvelope<T>;
    } };
    const view = await mount(f.ctx); await settle();
    expect(elements(f.root, "circle")).toHaveLength(0);
    expect(elements(f.root, "p").find(n => n.className === "numeric chart-summary")!.textContent).toBe("No recorded values in this period");
    view.dispose();
  });
  it("uses the shared empty-row copy", async () => {
    const f = fixture(() => ({ ...data(), rows: [] })); const view = await mount(f.ctx); await settle();
    expect(f.root.textContent).toContain("No rows for this period");
    expect(f.root.textContent).not.toContain("No recorded usage in this slice");
    view.dispose();
  });
  it.each(["Pivot", "Filter values"])("offers actionable unknown-filter copy and clears the mounted context (%s)", async panelName => {
    vi.useFakeTimers();
    const f = fixture(r => (panelName === "Pivot") === (r.path === "/api/explorer")
      ? new Response(JSON.stringify({ apiVersion: 1, error: { code: "unknown-filter-id", message: "private" } }), { status: 400 })
      : r.path === "/api/explorer" ? data() : { rows: [], nextCursor: null });
    const clearFilters = vi.fn(); const view = await mount({ ...f.ctx, clearFilters } as typeof f.ctx); await settle();
    if (panelName === "Filter values") { input(f.root, "A"); await vi.advanceTimersByTimeAsync(300); }
    expect(field(f.root, panelName).textContent).toContain("Selected filter is no longer available. Clear filters to continue.");
    expect(f.root.textContent).not.toContain("Remove the unknown filter from the address");
    button(f.root, "Clear filters").click(); expect(clearFilters).toHaveBeenCalledOnce(); expect(f.routes).toHaveLength(0);
    view.dispose();
  });
});


describe("Explorer final round", () => {
  it.each([
    ["calibrated", "Low to High · 100 AIC calibrated minimum · 560 AIC calibrated maximum"],
    ["back-applied", "Low to High · 100 AIC calibrated, back-applied minimum · 560 AIC calibrated, back-applied maximum"],
    ["published", "Low to High · ~100 AIC published estimate minimum · ~560 AIC published estimate maximum"],
  ] as const)("captions priced extrema with their basis and no false lower bounds (%s)", async (basis, want) => {
    // Breaks caught: unconditional +, losing back-applied/published qualifiers, or empty description ids.
    const f = fixture(() => ({ ...data(), rows: [100, 560].map((value, i) => ({
      key: [String(i)], labels: [i ? "High" : "Low"],
      measure: { ...measure(), aicDisplay: { primaryAic: value, publishedAic: value, basis } },
    })) }));
    const view = await mount(f.ctx); await settle();
    const caption = elements(f.root, "p").find(n => n.className === "numeric chart-summary")!;
    const svg = elements(f.root, "svg")[0]!;
    expect(caption.textContent).toBe(want); expect(caption.textContent).not.toContain("+");
    expect(caption.id).not.toBe(""); expect(svg.getAttribute("aria-describedby")).toBe(caption.id);
    view.dispose();
  });
  it.each(["Pivot", "Filter values"])("focuses the pager status after Retry recovers page 1 for either 400 or 409 (%s)", async panelName => {
    // Break caught: recursion forgetting that the now-hidden Retry owned focus.
    vi.useFakeTimers(); let failure = "busy";
    const f = fixture(r => {
      if ((panelName === "Pivot") === (r.path === "/api/explorer") && r.params.has("cursor")) {
        throw new DashboardClientError(failure as "busy" | "ledger-changed" | "invalid-query");
      }
      return r.path === "/api/explorer" ? { ...data(), nextCursor: "page2" } : { rows: [{ id: "a", label: "A" }], nextCursor: "page2" };
    });
    const view = await mount(f.ctx); await settle();
    if (panelName === "Filter values") { input(f.root, "A"); await vi.advanceTimersByTimeAsync(300); }
    const panel = field(f.root, panelName), retry = button(panel, "Retry");
    for (const code of ["ledger-changed", "invalid-query"]) {
      failure = "busy"; button(panel, "Next page").click(); await settle();
      retry.focus(); failure = code; retry.click(); await settle();
      const notice = descendants(panel).find(n => n.textContent === "Page link no longer valid. Showing page 1.")!;
      expect(notice).toBeDefined(); expect(notice.getAttribute("tabindex")).toBe("-1");
      expect(f.doc.activeElement).toBe(notice); expect(retry.hidden).toBe(true);
    }
    view.dispose();
  });
  it.each(["Pivot", "Filter values"])("focuses the error message when a repeated failure hides Retry (%s)", async panelName => {
    // Break caught: attempting to focus a hidden Retry, leaving focus on BODY.
    vi.useFakeTimers(); let terminal = false;
    const f = fixture(r => {
      if ((panelName === "Pivot") === (r.path === "/api/explorer")) throw new DashboardClientError(terminal ? "identity-unavailable" : "busy");
      return r.path === "/api/explorer" ? data() : { rows: [], nextCursor: null };
    });
    const view = await mount(f.ctx); await settle();
    if (panelName === "Filter values") { input(f.root, "A"); await vi.advanceTimersByTimeAsync(300); }
    const panel = field(f.root, panelName), retry = button(panel, "Retry"); retry.focus(); terminal = true; retry.click(); await settle();
    const message = descendants(panel).find(n => n.getAttribute("aria-live") === "polite" && n.textContent.includes("Usage identity unavailable"))!;
    expect(retry.hidden).toBe(true); expect(message.getAttribute("tabindex")).toBe("-1");
    expect(f.doc.activeElement).toBe(message); view.dispose();
  });
  it("names each tuple drill by its field and displayed value, including missing cells", async () => {
    // Break caught: missing cells hiding the drill action or normal cells omitting their dimension.
    const f = fixture(() => ({ ...data(), groupBy: ["model", "role"], rows: [
      { key: [null, "worker-id"], labels: [null, "worker"], measure: measure() },
      { key: [null, null], labels: [null, "unsupported id"], measure: measure() },
    ] }));
    const view = await mount(f.ctx); await settle(); const table = elements(f.root, "table").at(-1)!;
    const missing = button(table, "No value"), worker = button(table, "worker");
    expect(missing.getAttribute("aria-label")).toBe("Drill into model: No value");
    expect(worker.getAttribute("aria-label")).toBe("Drill into role: worker");
    missing.click(); worker.click(); expect(f.routes[0]!.filters).toEqual(f.routes[1]!.filters);
    expect(f.routes[0]!.filters?.slice(-2)).toEqual([{ field: "model", kind: "missing" }, { field: "role", kind: "id", value: "worker-id" }]);
    const inert = elements(table, "tr").at(-1)!; expect(elements(inert, "button")).toHaveLength(0);
    expect(field(inert, "No value (missing)").tagName).toBe("SPAN"); view.dispose();
  });
  it("renders a legacy raw-null bookmark as missing in the real app header", async () => {
    // Break caught: deleting the raw-null branch while Explorer still normalizes legacy routes.
    const f = fixture(); const { startDashboard } = await import("../web/app.js"), { EXPLORER_MOUNTS } = await import("../web/explorer.js");
    const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client,
      initialRoute: { view: "explorer", period, filters: [{ field: "model", kind: "raw", value: null }] as unknown as Filter[] }, mounts: EXPLORER_MOUNTS });
    await settle(); const header = elements(f.root, "header")[0]!;
    expect(header.textContent).toContain("Selected filters: model: No value");
    expect(field(header, "No value (missing)").className).toContain("missing-value");
    expect(f.requests[0]!.params.get("filters")).toBe('[{"field":"model","kind":"missing"}]'); app.dispose();
  });
  it("keeps missing drill cells secondary despite the table action color override", async () => {
    // Break caught: removing the more-specific missing-cell color, leaving inherited primary text.
    const f = fixture(() => ({ ...data(), rows: [{ key: [null], labels: [null], measure: measure() }] }));
    const view = await mount(f.ctx); await settle(); expect(button(f.root, "No value").className).toContain("missing-value");
    const css = readFileSync(new URL("../web/theme.css", import.meta.url), "utf8");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const missing = rules.find(rule => rule[1]!.trim() === ".usage-explorer .data-table .action.missing-value");
    expect(missing?.[2]).toMatch(/color:\s*var\(--text-secondary\)/); view.dispose();
  });
  it("disables an empty Clear filters action without remounting", async () => {
    // Break caught: allowing an empty clear to remount the view, or omitting accessible disabled state.
    const f = fixture(); f.ctx.filters = []; const view = await mount(f.ctx); await settle();
    const clear = button(f.root, "Clear filters"); expect(clear.disabled).toBe(true);
    clear.click(); expect(f.routes).toHaveLength(0); view.dispose();
  });
  it("exposes aria-disabled for Clear filters with no filters", async () => {
    // Break caught: exposing an empty clear action as available to assistive technology.
    const f = fixture(); f.ctx.filters = []; const view = await mount(f.ctx); await settle();
    expect(button(f.root, "Clear filters").getAttribute("aria-disabled")).toBe("true"); view.dispose();
  });
  it("runs a forced label recheck after the running background lookup completes", async () => {
    // Break caught: returning the pending non-forced pass and skipping validation of its cached label.
    let finishLookup!: (value: unknown) => void; let invalid = false, lookups = 0;
    const f = fixture(() => { if (invalid) throw new DashboardClientError("unknown-filter-id"); return data(); }, () => {
      if (++lookups === 1) return new Promise(resolve => { finishLookup = resolve; });
      throw new DashboardClientError("unknown-filter-id");
    });
    const view = await mount(f.ctx); await settle(); expect(f.labelRequests).toHaveLength(1);
    invalid = true; button(f.root, "Refresh").click(); await settle();
    expect(f.labelRequests).toHaveLength(1); expect(f.routes).toHaveLength(0);
    finishLookup({ rows: [{ id: "opaque-parent", label: "Cached parent" }], nextCursor: null }); await settle();
    expect(f.labelRequests).toHaveLength(2); await settle(); expect(f.routes.at(-1)?.filters).toEqual([]);
    expect(f.root.textContent).toContain("A saved filter no longer matches any data and was removed"); view.dispose();
  });
});
