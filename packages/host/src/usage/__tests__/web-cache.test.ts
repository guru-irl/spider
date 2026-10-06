import { expect, it, vi } from "vitest";
import type { ApiEnvelope, UsageMeasure } from "../dashboard-contract.js";
import type { CacheData } from "../query-cache.js";
import { createDashboardClient, DashboardClientError, type DashboardClient } from "../web/client.js";
import { PlainDocument, elements, button, settle } from "./fixtures/plain-dom.js";

const period = { start: 0, end: 172800000 };
const fit = { status: "calibrated" as const, factor: 0.5, windowStart: 0, windowEnd: 86400000, coveredHours: 24, computedAic: 1000, counterDelta: 500, unpricedCalls: 0, method: "trailing-7d-ratio" as const };
function measure(): UsageMeasure { return { calls: 3, pricedCalls: 2, unpricedCalls: 1, aggregateCalls: 1,
  tokens: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, prompt: 60, total: 100, reasoning: null, cacheWrite1h: 7 },
  aic: 100, aicDisplay: { primaryAic: 50, publishedAic: 100, basis: "calibrated" }, aicComponents: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 }, piCost: null,
  possibleOverlap: true, possibleUndercount: true, pendingData: true, estimated: true }; }
function data(): CacheData {
  const m = measure(); const components = (["input", "cacheRead", "cacheWrite", "output"] as const).map((tokenType, i) => ({ tokenType, tokens: [10, 20, 30, 40][i]!, aicDisplay: { primaryAic: [5, 10, 15, 20][i]!, publishedAic: [10, 20, 30, 40][i]!, basis: "calibrated" as const } }));
  const split = { cacheWrite5m: 11, cacheWrite1h: 7, knownTokens: 18, knownCalls: 2, unknownTokens: 12, unknownCalls: 1 };
  return { ingestPending: true, writeSplit: split, warmerWriteSplit: { ...split, cacheWrite5m: 1, cacheWrite1h: 2, knownTokens: 3, unknownTokens: 0, unknownCalls: 0 }, calibration: fit,
    totals: m, warmer: { ...m, tokens: { ...m.tokens, cacheWrite: 3 } }, hitRate: 1 / 3, components, warmerComponents: components,
    warmerShare: { prompt: 0.1, calls: 0.2, publishedAic: 0.3 },
    daily: { rows: [{ start: 0, end: 86400000, label: "day <img src=x onerror=evil()>", hitRate: 1 / 3, measure: m, warmer: m, components, warmerComponents: components, writeSplit: split, warmerWriteSplit: split }], nextCursor: "daily-next" },
    sessionsWithWritesNoReads: { rows: [{ sessionId: "session-1", sessionLabel: "<script>evil()</script>", projectKey: "opaque-project", projectLabel: "project <img src=x>", measure: m }, { sessionId: null, sessionLabel: "unsupported id", projectKey: null, projectLabel: null, measure: m }], nextCursor: "session-next" },
    observation: "Sessions with writes and no recorded reads", itemReuse: { status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" } };
}
function rows(root: Parameters<typeof elements>[0], caption: string) { const table = elements(root, "table").find(node => elements(node, "caption")[0]?.textContent === caption); expect(table, caption).toBeDefined(); return elements(table!, "tr").slice(1).map(row => row.children.map(cell => cell.textContent)); }
function fixture() {
  const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const requests: URL[] = [], routes: unknown[] = []; const source = data();
  const client = createDashboardClient(async input => { const url = new URL(String(input), "http://127.0.0.1"); requests.push(url); const response = structuredClone(source);
    if (url.searchParams.has("cursor")) response.sessionsWithWritesNoReads = { rows: [], nextCursor: null };
    if (url.searchParams.has("dailyCursor")) response.daily = { rows: [], nextCursor: null };
    const body: ApiEnvelope<CacheData> = { apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data: response }; return new Response(JSON.stringify(body)); });
  const controller = new AbortController();
  return { doc, root, requests, routes, source, controller, ctx: { document: doc.asDocument(), root: root as unknown as HTMLElement, client, period, filters: [{ field: "actor" as const, value: "parent" }], signal: controller.signal, navigate(route: unknown) { routes.push(route); } } };
}
it("Cache describes session observations not item reuse", async () => {
  // Breaks: calling no-read evidence item reuse, omitting unknown TTLs, or decoupling component AIC/tokens.
  const module = await import("../web/cache.js").catch(() => null);
  expect(module, "Cache mount is available").not.toBeNull();
  const f = fixture(); const view = await module!.mountCache(f.ctx); await settle();
  try {
    expect(f.requests[0]!.pathname).toBe("/api/cache"); expect(f.requests[0]!.searchParams.get("filters")).toBe('[{"field":"actor","value":"parent"}]');
    expect(f.root.textContent).toContain("Sessions with writes and no recorded reads"); expect(f.root.textContent).toContain("Provisional session observations");
    expect(f.root.textContent).toContain("Not available yet (Phase 2)"); expect(f.root.textContent).toContain("not an item-reuse claim"); expect(f.root.textContent).toContain("Pending ingestion");
    expect(rows(f.root, "Token components")[2]).toEqual(["Cache write", "15+ AIC cal", "~30+ AIC published estimate", "30 tokens"]);
    expect(rows(f.root, "Cache write split")).toEqual([["5-minute writes", "11 tokens"], ["1-hour writes", "7 tokens"], ["Unknown split", "12 tokens; 1 call"], ["Known split evidence", "18 tokens; 2 calls"]]);
    expect(rows(f.root, "Warmer cache write split")[0]).toEqual(["5-minute writes", "1 token"]);
    expect(f.root.textContent).toContain("33.33%"); expect(f.root.textContent).toContain("Possible overlap"); expect(f.root.textContent).toContain("Possible undercount");
    const chart = elements(f.root, "section").find(node => node.children.some(child => child.tagName === "H3" && child.textContent === "Daily cache hit rate"))!;
    button(chart, "Table").click(); expect(rows(chart, "Daily cache hit rate")[0]![2]).toBe("~33.33%"); expect(rows(chart, "Daily cache hit rate")[0]![3]).toContain("total 100");
    expect(elements(f.root, "script")).toHaveLength(0); expect(elements(f.root, "img")).toHaveLength(0); expect(f.root.textContent).toContain("<script>evil()</script>");
    button(f.root, "Open session: <script>evil()</script>").click(); expect(f.routes).toEqual([{ view: "session", id: "session-1", filters: f.ctx.filters }]);
    expect(elements(f.root, "button").filter(node => node.textContent.startsWith("Open session:"))).toHaveLength(1);
    expect(rows(f.root, "Sessions with writes and no recorded reads")[1]![6]).toBe("No supported session id");
    const sessions = elements(f.root, "section").find(node => node.children.some(child => child.tagName === "H2" && child.textContent === "Session observations"))!;
    button(sessions, "Next page").click(); await settle(); expect(f.requests.at(-1)!.searchParams.get("cursor")).toBe("session-next"); expect(f.requests.at(-1)!.searchParams.has("dailyCursor")).toBe(false);
    const daily = elements(f.root, "section").find(node => node.children.some(child => child.tagName === "H2" && child.textContent === "Daily cache observations"))!;
    button(daily, "Next page").click(); await settle(); expect(f.requests.at(-1)!.searchParams.get("dailyCursor")).toBe("daily-next"); expect(f.requests.at(-1)!.searchParams.get("cursor")).toBe("session-next");
    button(daily, "Previous page").click(); await settle(); expect(f.requests.at(-1)!.searchParams.has("dailyCursor")).toBe(false);
  } finally { view.dispose(); }
});

const lifecycleCases = [
  { name: "Cache", mount: async () => (await import("../web/cache.js")).mountCache, data },
  { name: "Reconciliation", mount: async () => (await import("../web/reconciliation.js")).mountReconciliation, data: () => ({ periods: { rows: [], nextCursor: null }, counterGranularityAic: 1, billingLagCaveat: "billing-lag-minutes", caveats: [] }) },
  { name: "Rates", mount: async () => (await import("../web/rates.js")).mountRates, data: () => ({ calibration: fit, periodCalibration: fit, totals: measure(), versions: [], rates: { rows: [], nextCursor: null }, storedRateVersions: [], storedRateVersionsTruncated: false, unpricedModels: { rows: [], nextCursor: null }, factorHistory: { rows: [], nextCursor: null }, factorHistoryEnabled: true, nextCursor: null }) },
];
it.each(lifecycleCases)("$name bounds refresh and cleans up on abort", async entry => {
  // Breaks: polling hidden/inactive/focused evidence, replacing focused controls, or polling after shutdown/disposal.
  vi.useFakeTimers();
  try {
    const mount = await entry.mount(), f = fixture(); let online = true;
    const client = createDashboardClient(async input => {
      f.requests.push(new URL(String(input), "http://127.0.0.1"));
      if (!online) throw new TypeError("synthetic server stopped");
      return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data: entry.data() }));
    });
    const view = await mount({ ...f.ctx, client }); await settle();
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(2);
    f.doc.visibilityState = "hidden"; await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(2);
    f.doc.visibilityState = "visible"; const formControl = f.doc.createElement("button"); elements(f.root, "table")[0]!.append(formControl); formControl.focus();
    await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(2);
    f.doc.activeElement = null; await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(120000); expect(f.requests).toHaveLength(3);
    f.doc.dispatchEvent(new Event("keydown")); await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(4);
    const refresh = button(f.root, "Refresh"); refresh.focus(); refresh.click(); await settle(); expect(f.doc.activeElement).toBe(refresh);
    online = false; refresh.click(); await settle(); expect(f.root.textContent).toContain("Run /usage again");
    const stopped = f.requests.length; f.doc.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(stopped);
    online = true; button(f.root, "Retry").click(); await settle(); f.doc.activeElement = null; await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(stopped + 2);
    f.controller.abort(); view.dispose(); const ended = f.requests.length;
    await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(ended); expect(f.root.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0); expect(f.doc.listeners.get("keydown")?.size ?? 0).toBe(0); expect(f.doc.listeners.get("pointerdown")?.size ?? 0).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("Cache chart evidence preserves primary lower bounds and missing hit rates", async () => {
  // Breaks: dropping the primary lower-bound + or converting a null prompt denominator into a zero hit rate.
  const { mountCache } = await import("../web/cache.js"), f = fixture();
  f.source.hitRate = null; f.source.daily.rows[0]!.hitRate = null;
  const view = await mountCache(f.ctx); await settle();
  try {
    const usage = elements(f.root, "section").find(node => node.children.some(child => child.tagName === "H3" && child.textContent === "Daily usage · calibrated"))!;
    expect(elements(usage, "title")[1]!.textContent).toContain("50+ AIC cal");
    expect(rows(usage, "Daily usage · calibrated")[0]![2]).toBe("50+ AIC calibrated");
    const hits = elements(f.root, "section").find(node => node.children.some(child => child.tagName === "H3" && child.textContent === "Daily cache hit rate"))!;
    expect(elements(hits, "circle")).toHaveLength(0); button(hits, "Table").click(); expect(rows(hits, "Daily cache hit rate")[0]![2]).toBe("unavailable");
    expect(f.root.textContent).toContain("Cache hit rate: unavailable");
  } finally { view.dispose(); }
});

it.each(lifecycleCases)("$name rejects late responses after refresh, abort and dispose", async entry => {
  // Breaks: trusting a slow custom client to honor abort, showing an older request after a newer one, or rendering after disposal.
  const mount = await entry.mount(), f = fixture();
  const requests: { signal: AbortSignal; resolve(at: number): void; reject(error: unknown): void }[] = [];
  const client: DashboardClient = { get<T>(_path: string, _params: URLSearchParams, signal: AbortSignal) {
    return new Promise<ApiEnvelope<T>>((resolve, reject) => requests.push({ signal, reject, resolve(at) { resolve({ apiVersion: 1, revision: "fixture:0", period, generatedAt: at, data: entry.data() as T }); } }));
  } };
  const view = await mount({ ...f.ctx, client }); await settle();
  try {
    expect(requests).toHaveLength(1); button(f.root, "Refresh").click(); expect(requests[0]!.signal.aborted).toBe(true);
    requests[1]!.resolve(2000); await settle(); expect(f.root.textContent).toContain("Updated 1970-01-01T00:00:02.000Z");
    requests[0]!.resolve(1000); await settle(); expect(f.root.textContent).not.toContain("Updated 1970-01-01T00:00:01.000Z");
    button(f.root, "Refresh").click(); f.controller.abort(); expect(requests[2]!.signal.aborted).toBe(true);
    requests[2]!.resolve(3000); await settle(); expect(f.root.children).toHaveLength(0);
  } finally { view.dispose(); }
  const g = fixture(); const other = await mount({ ...g.ctx, client }); await settle();
  other.dispose(); expect(requests[3]!.signal.aborted).toBe(true); requests[3]!.reject(new Error("private synthetic error <script>x</script>")); await settle(); expect(g.root.children).toHaveLength(0);
  const h = fixture(); h.controller.abort(); const stopped = await mount({ ...h.ctx, client }); await settle(); expect(requests).toHaveLength(4); expect(h.root.children).toHaveLength(0); stopped.dispose();
});
it.each(lifecycleCases)("$name errors stay fixed and Retry is bounded to one request", async entry => {
  // Breaks: exposing raw server messages or retrying indefinitely without a user action.
  const mount = await entry.mount(), f = fixture(); let requests = 0;
  const client: DashboardClient = { async get<T>() { requests++; if (requests === 1) throw new Error("private synthetic failure <script>x</script>"); return { apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data: entry.data() as T }; } };
  const view = await mount({ ...f.ctx, client }); await settle();
  try {
    expect(f.root.textContent).toContain("Could not load usage. Retry."); expect(f.root.textContent).not.toContain("private synthetic failure"); expect(requests).toBe(1);
    const retry = button(f.root, "Retry"); expect(retry.hidden).toBe(false); retry.focus(); retry.click(); await settle(); expect(retry.hidden).toBe(true); expect(f.doc.activeElement?.tagName).toBe("H2"); expect(f.doc.activeElement?.getAttribute("tabindex")).toBe("-1"); expect(requests).toBe(2); expect(f.root.textContent).toContain("Updated 1970-01-03T00:00:00.000Z");
  } finally { view.dispose(); }
});
it("analytical mounts plug into the existing dashboard registry", async () => {
  // Breaks: incompatible mount signatures or routing analytical mounts outside the app's disposal/slice contract.
  const { startDashboard } = await import("../web/app.js"), { mountCache } = await import("../web/cache.js"), { mountReconciliation } = await import("../web/reconciliation.js"), { mountRates } = await import("../web/rates.js");
  const f = fixture(); const client = createDashboardClient(async input => {
    const url = new URL(String(input), "http://127.0.0.1"); f.requests.push(url);
    const entry = lifecycleCases.find(item => url.pathname === `/api/${item.name.toLowerCase()}`)!;
    return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data: entry.data() }));
  });
  const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client, initialRoute: { view: "cache", period, filters: f.ctx.filters }, mounts: { cache: mountCache, reconciliation: mountReconciliation, rates: mountRates } });
  try {
    await settle(); expect(elements(f.root, "h1")[0]!.textContent).toBe("Cache");
    button(f.root, "Reconciliation").click(); await settle(); expect(elements(f.root, "h1")[0]!.textContent).toBe("Reconciliation");
    button(f.root, "Rates").click(); await settle(); expect(elements(f.root, "h1")[0]!.textContent).toBe("Rates");
    expect(f.requests.map(url => url.pathname)).toEqual(["/api/cache", "/api/reconciliation", "/api/rates"]);
    expect(f.requests.every(url => url.searchParams.get("start") === "0" && url.searchParams.get("end") === "172800000")).toBe(true);
    expect(f.requests[2]!.searchParams.get("filters")).toBe('[{"field":"actor","value":"parent"}]');
  } finally { app.dispose(); }
});

it("Cache separates selected, warmer, split and back-applied evidence", async () => {
  // Breaks: warmer/selected swaps, 5m/1h swaps, basis grouping, primary/published swaps, missing pending flags.
  const { mountCache } = await import("../web/cache.js"), f = fixture();
  f.source.ingestPending = false; f.source.calibration = { ...fit, unpricedCalls: 1 };
  f.source.warmer = { ...measure(), calls: 1, unpricedCalls: 0, pendingData: false, aicDisplay: { primaryAic: 9, publishedAic: 18, basis: "back-applied" } };
  f.source.warmerComponents = f.source.components.map(c => ({ ...c, tokens: 2, aicDisplay: { primaryAic: 1, publishedAic: 2, basis: "back-applied" } }));
  const day = f.source.daily.rows[0]!; day.warmer = f.source.warmer; day.warmerWriteSplit = f.source.warmerWriteSplit;
  const view = await mountCache(f.ctx); await settle();
  try {
    expect(f.root.textContent).toContain("No pending ingestion recorded");
    expect(f.root.textContent).toContain("over 1 day"); expect(f.root.textContent).toContain("1 unpriced call"); expect(f.root.textContent).toContain("trailing 7-day ratio");
    expect(elements(f.root, "span").some(n => n.className === "numeric" && n.textContent === "~33.33%")).toBe(true);
    const selected = rows(f.root, "Selected usage and warmer");
    expect(selected[0]![4]).toContain("Pending data"); expect(selected[1]![4]).not.toContain("Pending data");
    expect(selected[1]![1]).toBe("9 AIC calibrated, back-applied"); expect(selected[1]![4]).toContain("1 call;");
    expect(rows(f.root, "Warmer token components")[0]).toEqual(["Input", "1 AIC calibrated, back-applied", "~2 AIC published estimate", "2 tokens"]);
    expect(rows(f.root, "Daily cache write split").map(r => r.slice(1, 3))).toEqual([["11 tokens", "7 tokens"], ["1 token", "2 tokens"]]);
    const warmer = elements(f.root, "section").find(n => n.children.some(c => c.tagName === "H3" && c.textContent === "Daily warmer · calibrated, back-applied"))!;
    expect(warmer).toBeDefined(); expect(rows(warmer, "Daily warmer · calibrated, back-applied")[0]![2]).toBe("9 AIC calibrated, back-applied");
    expect(elements(warmer, "circle")).toHaveLength(1);
    const previous = elements(f.root, "button").filter(n => n.textContent === "Previous page");
    expect(previous.every(n => n.getAttribute("aria-disabled") === "true")).toBe(true);
    const headings = elements(f.root, "h3"); expect(headings.every(n => panel(f, "Daily cache observations").contains(n))).toBe(true);
  } finally { view.dispose(); }
});

const pagingCases = [
  { name: "Cache sessions", mount: lifecycleCases[0]!, param: "cursor", title: "Session observations", next: "session-next" },
  { name: "Cache daily", mount: lifecycleCases[0]!, param: "dailyCursor", title: "Daily cache observations", next: "daily-next" },
  { name: "Reconciliation", mount: lifecycleCases[1]!, param: "cursor", title: "Comparisons and snapshot coverage", next: "pair-next" },
  { name: "Rates", mount: lifecycleCases[2]!, param: "cursor", title: "Rates, unpriced evidence and calibration", next: "rates-next" },
];
function pagingData(entry: typeof pagingCases[number]) {
  const value = entry.mount.data() as ReturnType<typeof data> & { periods?: { nextCursor: string | null }; nextCursor?: string | null };
  if (value.periods) value.periods.nextCursor = "pair-next";
  if (entry.name === "Rates") value.nextCursor = "rates-next";
  return value;
}
function panel(f: ReturnType<typeof fixture>, title: string) { return elements(f.root, "section").find(n => n.children.some(c => c.tagName === "H2" && c.textContent === title))!; }
it.each(pagingCases)("$name pins the echoed period and refreshes the current page silently", async entry => {
  // Breaks: a rolling end on cursor requests, manual/timer resets, disabled focused controls, auto announcements, or clearing data during loads.
  vi.useFakeTimers(); const f = fixture(), mount = await entry.mount.mount(); let now = 1000;
  const pending: (() => void)[] = []; let defer = false;
  const client: DashboardClient = { get<T>(_path: string, params: URLSearchParams) {
    f.requests.push(new URL(`http://fixture.invalid/?${params}`));
    return new Promise<ApiEnvelope<T>>(resolve => { const finish = () => resolve({ apiVersion: 1, revision: "fixture:0", period: { start: 0, end: 900 }, generatedAt: now, data: pagingData(entry) as T }); if (defer) pending.push(finish); else finish(); });
  } };
  const view = await mount({ ...f.ctx, client, get period() { return { start: 0, end: now++ }; } }); await settle();
  try {
    const region = panel(f, entry.title), next = button(region, "Next page"), status = elements(region, "p").find(n => n.getAttribute("role") === "status")!;
    expect(status).toBeDefined(); const initialContent = elements(f.root, "table").map(n => n.textContent);
    defer = true; next.focus(); next.click(); expect(f.doc.activeElement).toBe(next); expect(next.disabled).toBe(false);
    expect(next.getAttribute("aria-busy")).toBe("true"); expect(next.getAttribute("aria-disabled")).toBe("true");
    next.click(); expect(f.requests).toHaveLength(2); expect(elements(f.root, "table").map(n => n.textContent)).toEqual(initialContent);
    expect(f.requests[1]!.searchParams.get("end")).toBe("900"); expect(f.requests[1]!.searchParams.get(entry.param)).toBe(entry.next);
    pending.shift()!(); await settle(); expect(f.doc.activeElement).toBe(next); expect(next.getAttribute("aria-busy")).toBe("false");
    f.doc.activeElement = null; const notice = status.textContent; await vi.advanceTimersByTimeAsync(60000);
    expect(f.requests[2]!.searchParams.get(entry.param)).toBe(entry.next); expect(f.requests[2]!.searchParams.get("end")).toBe("900"); expect(status.textContent).toBe(notice);
    pending.shift()!(); await settle(); expect(status.textContent).toBe(notice);
    button(f.root, "Refresh").click(); pending.shift()!(); await settle(); expect(f.requests[3]!.searchParams.get(entry.param)).toBe(entry.next);
    button(region, "Previous page").click(); pending.shift()!(); await settle(); expect(f.requests[4]!.searchParams.has(entry.param)).toBe(false); expect(f.requests[4]!.searchParams.get("end")).not.toBe("900");
  } finally { view.dispose(); vi.useRealTimers(); }
});
it.each(pagingCases.flatMap(entry => (["invalid-query", "ledger-changed"] as const).map(code => ({ ...entry, code }))))("$name resets a $code cursor without resending it", async entry => {
  // Breaks: Retry loops on invalid/stale cursors, missing page-1 reset, unscoped notices, failed pager restoration.
  vi.useFakeTimers(); const f = fixture(), mount = await entry.mount.mount(); let fail = true;
  const client = createDashboardClient(async input => { const url = new URL(String(input), "http://fixture.invalid"); f.requests.push(url);
    if (url.searchParams.has(entry.param) && fail) { fail = false; return new Response(JSON.stringify({ error: { code: entry.code, message: "private" } }), { status: entry.code === "invalid-query" ? 400 : 409 }); }
    return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data: pagingData(entry) }));
  });
  const view = await mount({ ...f.ctx, client }); await settle();
  try {
    const region = panel(f, entry.title); button(region, "Next page").click(); await settle();
    expect(f.requests.map(u => u.searchParams.get(entry.param))).toEqual([null, entry.next, null]);
    const status = elements(region, "p").find(n => n.getAttribute("role") === "status")!; expect(status.textContent).toContain("Showing page 1");
    expect(button(region, "Retry").hidden).toBe(true); expect(button(region, "Previous page").getAttribute("aria-disabled")).toBe("true");
    expect(button(region, "Next page").getAttribute("aria-disabled")).toBe("false");
    const notice = status.textContent; await vi.advanceTimersByTimeAsync(60000); expect(status.textContent).toBe(notice);
  } finally { view.dispose(); vi.useRealTimers(); }
});
it.each(lifecycleCases)("$name gates Retry and pauses by identity error code", async entry => {
  // Breaks: code-to-copy shutdown detection or offering Retry on impossible errors.
  vi.useFakeTimers(); const f = fixture(), mount = await entry.mount(); let code: "identity-unavailable" | "unknown-filter-id" = "identity-unavailable";
  const client: DashboardClient = { async get() { f.requests.push(new URL("http://fixture.invalid")); throw new DashboardClientError(code); } };
  const view = await mount({ ...f.ctx, client }); await settle();
  try {
    expect(elements(f.root, "button").filter(n => n.textContent === "Retry").every(n => n.hidden)).toBe(true);
    await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(1);
    code = "unknown-filter-id"; button(f.root, "Refresh").click(); await settle(); expect(f.requests).toHaveLength(2);
    expect(elements(f.root, "button").filter(n => n.textContent === "Retry").every(n => n.hidden)).toBe(true);
  } finally { view.dispose(); vi.useRealTimers(); }
});
it("Open session retains a rolling month and explicit periods through navigation", async () => {
  // Breaks: propagating the live period as an explicit route selection.
  const { startDashboard } = await import("../web/app.js"), { mountCache } = await import("../web/cache.js");
  for (const explicit of [false, true]) {
    const f = fixture(); let now = Date.UTC(2026, 9, 20); const requests: URL[] = [];
    const client = createDashboardClient(async input => { const url = new URL(String(input), "http://fixture.invalid"); requests.push(url); return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period: { start: Number(url.searchParams.get("start")), end: Number(url.searchParams.get("end")) }, generatedAt: now, data: data() })); });
    const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client, now: () => now, initialRoute: { view: "cache", ...(explicit ? { period } : {}) }, mounts: { cache: mountCache } });
    try { await settle(); button(f.root, "Open session: <script>evil()</script>").click(); await settle(); now += 3600000; button(f.root, "Cache").click(); await settle(); expect(requests.at(-1)!.searchParams.get("end")).toBe(explicit ? "172800000" : String(Date.UTC(2026, 9, 20, 1))); }
    finally { app.dispose(); }
  }
});

it.each(pagingCases)("$name rolls page 1 but pins cursor requests in the real app", async entry => {
  // Breaks: page 2 reads app's live period getter instead of the server-resolved page-1 window.
  const { startDashboard } = await import("../web/app.js"), mount = await entry.mount.mount(), f = fixture();
  let now = Date.UTC(2026, 9, 20), resolved = { start: Date.UTC(2026, 9, 1), end: now - 1000 };
  const client = createDashboardClient(async input => {
    const url = new URL(String(input), "http://fixture.invalid"); f.requests.push(url);
    if (url.searchParams.has(entry.param) && url.searchParams.get("end") !== String(resolved.end)) return new Response(JSON.stringify({ error: { code: "invalid-query" } }), { status: 400 });
    if (!url.searchParams.has(entry.param)) resolved = { start: Number(url.searchParams.get("start")), end: Number(url.searchParams.get("end")) - 1000 };
    return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period: resolved, generatedAt: now, data: pagingData(entry) }));
  });
  const viewName = entry.mount.name.toLowerCase() as "cache" | "rates" | "reconciliation";
  const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client, now: () => now, initialRoute: { view: viewName }, mounts: { [viewName]: mount } });
  try {
    await settle(); now += 3600000; const region = panel(f, entry.title); button(region, "Next page").click(); await settle();
    expect(f.requests).toHaveLength(2); expect(f.requests[1]!.searchParams.get("end")).toBe(String(Date.UTC(2026, 9, 20) - 1000));
    expect(f.requests[1]!.searchParams.get(entry.param)).toBe(entry.next);
    button(region, "Previous page").click(); await settle(); expect(f.requests[2]!.searchParams.get("end")).toBe(String(now));
  } finally { app.dispose(); }
});
it.each(pagingCases)("$name restores the visible page controls on a transient page error", async entry => {
  // Breaks: failed paging leaves cursor history ahead of the visible data or makes Retry request the wrong page.
  const mount = await entry.mount.mount(), f = fixture(); let first = true;
  const client = createDashboardClient(async input => {
    const url = new URL(String(input), "http://fixture.invalid"); f.requests.push(url);
    if (url.searchParams.has(entry.param) && first) { first = false; return new Response(JSON.stringify({ error: { code: "busy" } }), { status: 503 }); }
    return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: 0, data: pagingData(entry) }));
  });
  const view = await mount({ ...f.ctx, client }); await settle();
  try {
    const region = panel(f, entry.title), next = button(region, "Next page"); next.focus(); next.click(); await settle();
    expect(f.doc.activeElement).toBe(next); expect(button(region, "Previous page").getAttribute("aria-disabled")).toBe("true");
    const retry = button(region, "Retry"); expect(retry.hidden).toBe(false); retry.focus(); retry.click(); await settle();
    expect(f.requests.map(u => u.searchParams.get(entry.param))).toEqual([null, entry.next, entry.next]);
    expect(retry.hidden).toBe(true); expect(f.doc.activeElement?.textContent).toBe(entry.title);
    expect(button(region, "Previous page").getAttribute("aria-disabled")).toBe("false");
  } finally { view.dispose(); }
});

it.each(pagingCases)("$name does not announce automatic errors or cursor recovery", async entry => {
  // Breaks: timer writes to live status, clearing evidence on error, or resending a bad automatic-refresh cursor.
  vi.useFakeTimers(); const f = fixture(), mount = await entry.mount.mount(); let error: "busy" | "ledger-changed" | undefined;
  const client = createDashboardClient(async input => {
    const url = new URL(String(input), "http://fixture.invalid"); f.requests.push(url);
    if (error) { const code = error; error = undefined; return new Response(JSON.stringify({ error: { code } }), { status: code === "busy" ? 503 : 409 }); }
    return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: Date.now(), data: pagingData(entry) }));
  });
  const view = await mount({ ...f.ctx, client }); await settle();
  try {
    const region = panel(f, entry.title); button(region, "Next page").click(); await settle();
    const statuses = elements(f.root, "p").filter(n => n.getAttribute("role") === "status"); const tableText = elements(f.root, "table").map(n => n.textContent);
    expect(statuses.map(n => n.textContent)).toEqual(entry.name === "Cache sessions" ? ["", "Usage updated."] : entry.name === "Cache daily" ? ["Usage updated.", ""] : ["Usage updated."]);
    error = "busy"; await vi.advanceTimersByTimeAsync(60000); expect(statuses.map(n => n.textContent)).toEqual(statuses.map(() => ""));
    expect(elements(f.root, "table").map(n => n.textContent)).toEqual(tableText);
    const lanePanels = elements(f.root, "section").filter(n => n.children.some(c => c.tagName === "H2"));
    expect(lanePanels.map(p => button(p, "Retry").hidden)).toEqual(lanePanels.map((_, i) => i !== 0));
    for (const p of lanePanels) expect(p.children[3]!.textContent).toContain("temporarily unavailable");
    error = "ledger-changed"; await vi.advanceTimersByTimeAsync(60000); expect(statuses.map(n => n.textContent)).toEqual(statuses.map(() => ""));
    expect(f.requests.at(-2)!.searchParams.get(entry.param)).toBe(entry.next); expect(f.requests.at(-1)!.searchParams.has(entry.param)).toBe(false);
    expect(region.textContent).toContain("Showing page 1"); expect(button(region, "Retry").hidden).toBe(true);
  } finally { view.dispose(); vi.useRealTimers(); }
});

it("Cache keeps fractional evidence-window days plural", async () => {
  // Breaks: singularizing the trailing 1 in 1.1 days instead of only an exact one-day span.
  const { mountCache } = await import("../web/cache.js"), f = fixture(); f.source.calibration = { ...fit, windowEnd: 95040000 };
  const view = await mountCache(f.ctx); await settle();
  try { expect(f.root.textContent).toContain("over 1.1 days"); }
  finally { view.dispose(); }
});


it.each(pagingCases)("$name uses a refreshed page-1 pin for the next cursor", async entry => {
  // Breaks: N25 keeps the first response's pin forever after a fresh page-1 refresh.
  const f = fixture(), mount = await entry.mount.mount(); let end = 1000;
  const client = createDashboardClient(async input => {
    const url = new URL(String(input), "http://fixture.invalid"); f.requests.push(url);
    return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period: { start: 0, end }, generatedAt: end, data: pagingData(entry) }));
  });
  const view = await mount({ ...f.ctx, client }); await settle();
  try {
    end = 2000; button(f.root, "Refresh").click(); await settle();
    button(panel(f, entry.title), "Next page").click(); await settle();
    expect(f.requests).toHaveLength(3); expect(f.requests[2]!.searchParams.get(entry.param)).toBe(entry.next); expect(f.requests[2]!.searchParams.get("end")).toBe("2000");
  } finally { view.dispose(); }
});
it.each(lifecycleCases)("$name empty tables use only the shared empty message", async entry => {
  // Breaks: E1-E4 add redundant view-specific empty messages beside 5b's table row.
  const f = fixture(), mount = await entry.mount(); const empty = entry.data();
  if (entry.name === "Cache") { const cache = empty as CacheData; cache.daily.rows = []; cache.sessionsWithWritesNoReads.rows = []; }
  const client = createDashboardClient(async () => new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: 0, data: empty })));
  const view = await mount({ ...f.ctx, client }); await settle();
  try {
    expect(f.root.textContent).not.toContain("No matching session observations on this page.");
    expect(f.root.textContent).not.toContain("No snapshot-pair observations on this page.");
    expect(f.root.textContent).not.toContain("No unpriced model evidence on this page.");
    expect(f.root.textContent).not.toContain("No daily calibration evidence on this page.");
    const captions = entry.name === "Cache" ? ["Sessions with writes and no recorded reads", "Daily cache write split"] : entry.name === "Reconciliation" ? ["Published comparison", "Calibrated comparison", "Snapshot coverage"] : ["Unpriced evidence", "Daily calibration evidence"];
    for (const caption of captions) expect(rows(f.root, caption)).toEqual([["No rows for this period"]]);
  } finally { view.dispose(); }
});
