import { expect, it, vi } from "vitest";
import { startDashboard } from "../web/app.js";
import { hashRoute, routeHash } from "../web/navigation.js";
import { createDashboardClient, canRetry, DashboardClientError } from "../web/client.js";
import { PlainDocument, descendants, button, settle } from "./fixtures/plain-dom.js";
import { envelope, statusFixture, overviewFixture, sessionsFixture } from "./fixtures/redesign-contract.js";
import type { DashboardPageContext, DashboardPageMount } from "../dashboard-v4-contract.js";
const now = Date.UTC(2026, 9, 6, 9, 12);
function browser(doc: PlainDocument, hash = "#/") {
  const win = new EventTarget(), location = { hash }, entries = [hash], states: unknown[] = [null]; let index = 0;
  const history = { get state() { return states[index]; }, pushState(state: unknown, __: string, url: string) { location.hash = url; entries.splice(++index); states.splice(index); entries.push(url); states.push(state); }, replaceState(state: unknown, __: string, url: string) { location.hash = url; entries[index] = url; states[index] = state; }, back() { if (index) { location.hash = entries[--index]!; win.dispatchEvent(new Event("popstate")); win.dispatchEvent(new Event("hashchange")); } } };
  Object.assign(win, { location, history }); Object.defineProperty(doc, "defaultView", { value: win }); return { win, location, history, entries };
}
it("only three hash pages default to rolling seven days and reload selection", () => {
  const route = hashRoute("#/", now, "UTC"); expect(route).toEqual({ page: "overview", query: { range: "7d", from: now - 604800000, to: now, tz: "UTC", unit: "credits", buckets: [] } });
  expect(hashRoute("#/unknown", now, "UTC")).toEqual({ page: "overview", query: { range: "7d", from: now - 604800000, to: now, tz: "UTC", unit: "credits", buckets: [] } });
  expect(hashRoute("#/calibration", now, "UTC")).toEqual({ page: "calibration" });
  const selected = { page: "overview" as const, query: { range: "custom" as const, from: now - 3600000, to: now, tz: "UTC", unit: "tokens" as const, buckets: [now - 3600000] } };
  expect(hashRoute(routeHash(selected), now, "UTC")).toEqual(selected);
  expect(hashRoute("#/session/synthetic?unit=tokens&tz=UTC", now, "UTC")).toEqual({ page: "session", id: "synthetic", unit: "tokens", tz: "UTC" });
});
it.each(["%E0%A4%A", "bad%2Fid", "%00"])("unparseable id %s remains a local Session", id => {
  expect(hashRoute(`#/session/${id}`, now, "UTC")).toEqual({ page: "session", id: "", unit: "credits", tz: "UTC" });
});
it("navigation aborts old work, Back restores selection and replace never remounts", async () => {
  const doc = new PlainDocument(), win = browser(doc); const contexts: DashboardPageContext[] = [], dispose = vi.fn();
  const mount: DashboardPageMount = ctx => { contexts.push(ctx); return { refresh: async () => {}, dispose }; };
  const app = startDashboard({ document: doc.asDocument(), now: () => now, client: { get: async () => envelope(statusFixture()) as never }, mounts: { overview: mount, session: mount, calibration: mount } });
  try {
    const ctx = contexts[0]!; const selected = { ...ctx.overview, unit: "tokens" as const, buckets: [now - 1000] };
    ctx.navigate({ page: "overview", query: selected }, { replace: true }); expect(contexts).toHaveLength(1); expect(win.location.hash).toContain("tokens");
    ctx.navigate({ page: "session", id: "synthetic", unit: "tokens", tz: "UTC" }); expect(ctx.signal.aborted).toBe(true); expect(ctx.route.page).toBe("overview"); expect(dispose).toHaveBeenCalledTimes(1);
    const back = vi.spyOn(win.history, "back"), count = win.entries.length; contexts[1]!.back(); expect(back).toHaveBeenCalledOnce(); expect(win.entries).toHaveLength(count); expect(contexts[2]!.route).toEqual({ page: "overview", query: selected });
    button(doc.body, "Calibration & data").click(); expect(contexts.at(-1)!.route.page).toBe("calibration");
    expect(descendants(doc.body).some(n => n.className === "usage-rail")).toBe(false);
  } finally { app.dispose(); }
});
it("Back at a restored direct Session entry falls back to remembered Overview", () => {
  const doc = new PlainDocument(), win = browser(doc, "#/session/synthetic"), contexts: DashboardPageContext[] = [];
  const mount: DashboardPageMount = ctx => { contexts.push(ctx); return { refresh: async () => {}, dispose() {} }; };
  const app = startDashboard({ document: doc.asDocument(), client: { get: async () => envelope(statusFixture()) as never }, mounts: { overview: mount, session: mount } });
  try { const back = vi.spyOn(win.history, "back"); contexts.at(-1)!.back(); expect(back).not.toHaveBeenCalled(); expect(contexts.at(-1)!.route.page).toBe("overview"); win.history.back(); expect(contexts.at(-1)!.route.page).toBe("session"); contexts.at(-1)!.back(); expect(contexts.at(-1)!.route.page).toBe("overview"); } finally { app.dispose(); }
});
it("freshness is fresh at five minutes, stale after and refresh retains focus", async () => {
  const doc = new PlainDocument(); let ts = now - 300000;
  const app = startDashboard({ document: doc.asDocument(), now: () => now, mounts: {}, client: { get: async () => envelope(statusFixture({ lastIngestAt: ts })) as never } });
  try {
    await settle(); const freshness = descendants(doc.body).find(n => n.className === "freshness")!;
    expect(freshness.getAttribute("data-state")).toBe("fresh"); expect(freshness.textContent).toContain("Last update Tue 6 OCT");
    const refresh = button(doc.body, "Refresh"); refresh.focus(); ts--; await app.refresh();
    expect(freshness.getAttribute("data-state")).toBe("stale"); const indicator = descendants(doc.body).find(n => n.className === "freshness-indicator")!; expect(indicator.getAttribute("aria-label")).toContain(". Older than five minutes"); expect(indicator.getAttribute("title")).toBe(indicator.getAttribute("aria-label")); expect(freshness.textContent).toContain(". Older than five minutes"); expect(doc.activeElement).toBe(refresh); expect(refresh.getAttribute("aria-busy")).toBe("false");
  } finally { app.dispose(); }
});
it("out of order status is fenced, hidden tabs pause and disposal aborts", async () => {
  vi.useFakeTimers(); const doc = new PlainDocument(); const pending: { resolve: (v: never) => void; signal: AbortSignal }[] = [];
  const app = startDashboard({ document: doc.asDocument(), now: () => now, mounts: {}, client: { get: (_p, _q, signal) => new Promise(resolve => pending.push({ resolve, signal })) } });
  try {
    const refresh = app.refresh(); pending[1]!.resolve(envelope(statusFixture({ lastIngestAt: now })) as never); await refresh;
    pending[0]!.resolve(envelope(statusFixture({ lastIngestAt: 0 })) as never); await settle();
    expect(descendants(doc.body).find(n => n.className === "freshness")!.getAttribute("data-state")).toBe("fresh");
    doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(120000); expect(pending).toHaveLength(2);
    doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(60000); expect(pending).toHaveLength(3);
    app.dispose(); expect(pending[2]!.signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  } finally { app.dispose(); vi.useRealTimers(); }
});
it("invalid session renders Back only without a page mount or data request", async () => {
  const doc = new PlainDocument(), mount = vi.fn(); const paths: string[] = [];
  const app = startDashboard({ document: doc.asDocument(), initialRoute: { page: "session", id: "", unit: "credits", tz: "UTC" }, client: { get: async path => { paths.push(path); return envelope(statusFixture()) as never; } }, mounts: { session: mount } });
  try { await settle(); expect(doc.body.textContent).toContain("Session not found"); expect(button(doc.body, "Back")).toBeDefined(); expect(mount).not.toHaveBeenCalled(); expect(paths).toEqual([]); expect(descendants(doc.body).some(n => n.textContent === "Retry")).toBe(false); } finally { app.dispose(); }
});
it("typed not-found mount failure settles with Back and no Retry", () => {
  const doc = new PlainDocument(); const app = startDashboard({ document: doc.asDocument(), initialRoute: { page: "session", id: "synthetic", unit: "credits", tz: "UTC" }, client: { get: async () => envelope(statusFixture()) as never }, mounts: { session: () => { throw new DashboardClientError("not-found"); } } });
  try { expect(doc.body.textContent).toContain("Session not found"); expect(button(doc.body, "Back")).toBeDefined(); expect(descendants(doc.body).some(n => n.textContent === "Retry")).toBe(false); } finally { app.dispose(); }
});
it("starts hidden without mounting and mounts once on show", async () => {
  const doc = new PlainDocument(); doc.visibilityState = "hidden"; const mount = vi.fn(() => ({ refresh: async () => {}, dispose() {} })), get = vi.fn(async () => envelope(statusFixture()) as never);
  const app = startDashboard({ document: doc.asDocument(), client: { get }, mounts: { overview: mount } });
  try { await settle(); expect(mount).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); await settle(); expect(mount).toHaveBeenCalledOnce(); expect(get).toHaveBeenCalledOnce(); } finally { app.dispose(); }
});
it("client allows exactly v4 paths and not-found is not retryable", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope(statusFixture())))); const client = createDashboardClient(fetcher), signal = new AbortController().signal;
  for (const path of ["/api/status", "/api/overview", "/api/sessions", "/api/session/synthetic", "/api/session/%3Asynthetic", "/api/calibration"]) await client.get(path, new URLSearchParams(), signal);
  for (const path of ["/api/detail", "/api/cache", "/api/session/bad/id", "/api/session/%00"]) await expect(client.get(path, new URLSearchParams(), signal)).rejects.toMatchObject({ code: "invalid-query" });
  expect(fetcher).toHaveBeenCalledTimes(6); expect(canRetry(new DashboardClientError("not-found"))).toBe(false);
});

it("Back from a local invalid Session starts status immediately and restores content focus", async () => {
  const doc = new PlainDocument(), paths: string[] = [];
  const app = startDashboard({ document: doc.asDocument(), initialRoute: { page: "session", id: "", unit: "credits", tz: "UTC" }, mounts: {}, client: { get: async path => { paths.push(path); return envelope(statusFixture()) as never; } } });
  try { const indicator = descendants(doc.body).find(n => n.className === "freshness-indicator")!; expect(indicator.getAttribute("aria-label")).toBe("Last update unavailable"); await settle(); expect(paths).toEqual([]); const back = button(doc.body, "Back"); back.focus(); back.click(); await settle(); expect(paths).toEqual(["/api/status"]); expect(doc.activeElement).toBe(button(doc.body, "Overview")); expect(descendants(doc.body).find(n => n.className === "freshness")!.getAttribute("data-state")).not.toBe("loading"); } finally { app.dispose(); }
});
it("a Session unit change carries into the remembered Overview", () => {
  const doc = new PlainDocument(), contexts: DashboardPageContext[] = [];
  const mount: DashboardPageMount = ctx => { contexts.push(ctx); return { refresh: async () => {}, dispose() {} }; };
  const app = startDashboard({ document: doc.asDocument(), history: false, initialRoute: { page: "overview", query: { range: "7d", from: now - 604800000, to: now, tz: "UTC", unit: "credits", buckets: [] } }, now: () => now, client: { get: async () => envelope(statusFixture()) as never }, mounts: { overview: mount, session: mount } });
  try { contexts[0]!.navigate({ page: "session", id: "synthetic", unit: "credits", tz: "UTC" }); contexts[1]!.navigate({ page: "session", id: "synthetic", unit: "tokens", tz: "UTC" }, { replace: true }); contexts[1]!.back(); expect(contexts.at(-1)!.route).toEqual({ page: "overview", query: { range: "7d", from: now - 604800000, to: now, tz: "UTC", unit: "tokens", buckets: [] } }); } finally { app.dispose(); }
});
it("idle polling pauses page refresh after five minutes and activity resumes exactly once", async () => {
  vi.useFakeTimers(); const doc = new PlainDocument(), refresh = vi.fn(async () => {}), get = vi.fn(async () => envelope(statusFixture()) as never); const epoch = Date.now();
  const app = startDashboard({ document: doc.asDocument(), now: () => now + Date.now() - epoch, client: { get }, mounts: { overview: () => ({ refresh, dispose() {} }) } });
  try { await vi.advanceTimersByTimeAsync(300000); expect(refresh).toHaveBeenCalledTimes(5); await vi.advanceTimersByTimeAsync(120000); expect(refresh).toHaveBeenCalledTimes(5); expect(get).toHaveBeenCalledTimes(8); doc.dispatchEvent(new Event("pointerdown")); await settle(); expect(refresh).toHaveBeenCalledTimes(6); doc.dispatchEvent(new Event("pointerdown")); await settle(); expect(refresh).toHaveBeenCalledTimes(6); await vi.advanceTimersByTimeAsync(60000); expect(refresh).toHaveBeenCalledTimes(7); app.dispose(); doc.dispatchEvent(new Event("pointerdown")); expect(refresh).toHaveBeenCalledTimes(7); for (const kind of ["keydown", "pointerdown", "pointermove", "wheel", "input"]) { expect(doc.listeners.get(kind)?.size).toBe(0); expect(doc.listenerOptions.get(kind)).toEqual({ passive: true, capture: true }); } } finally { app.dispose(); vi.useRealTimers(); }
});
it("Retry remount transfers removed content focus to the current nav pill", () => {
  const doc = new PlainDocument(); let attempts = 0;
  const app = startDashboard({ document: doc.asDocument(), history: false, client: { get: async () => envelope(statusFixture()) as never }, mounts: { overview: ctx => { if (++attempts === 1) throw new DashboardClientError("internal"); ctx.root.textContent = "Recovered"; return { refresh: async () => {}, dispose() {} }; } } });
  try { const retry = button(doc.body, "Retry"); retry.focus(); retry.click(); expect(doc.body.textContent).toContain("Recovered"); expect(doc.activeElement).toBe(button(doc.body, "Overview")); } finally { app.dispose(); }
});
it("month preset starts at midnight in the requested zone, not the browser zone", () => {
  const route = hashRoute("#/?range=month&tz=Asia%2FKolkata", now, "UTC"); expect(route).toMatchObject({ page: "overview", query: { from: Date.UTC(2026, 8, 30, 18, 30), to: now } });
  expect(hashRoute("#/?range=month&tz=America%2FNew_York", now, "UTC")).toMatchObject({ query: { from: Date.UTC(2026, 9, 1, 4) } });
});

it("direct-entry Session Back preserves the initial Tokens unit", () => {
  const doc = new PlainDocument(); browser(doc, "#/session/synthetic?unit=tokens&tz=UTC"); const contexts: DashboardPageContext[] = [];
  const mount: DashboardPageMount = ctx => { contexts.push(ctx); return { refresh: async () => {}, dispose() {} }; };
  const app = startDashboard({ document: doc.asDocument(), now: () => now, client: { get: async () => envelope(statusFixture()) as never }, mounts: { overview: mount, session: mount } });
  try { contexts[0]!.back(); expect(contexts.at(-1)!.route).toMatchObject({ page: "overview", query: { unit: "tokens", range: "7d" } }); } finally { app.dispose(); }
});

it.each(["credits", "runs"] as const)("one sixty-second refresh preserves expanded %s sessions and the pace popover", async sort => {
  vi.useFakeTimers(); const doc = new PlainDocument(), d = overviewFixture(), row = d.sessions.rows[0]!;
  const all = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(row), id: `session-${i}`, name: `Session ${i}` }));
  d.sessions = sessionsFixture({ rows: all.slice(0, 10), total: 12, nextOffset: 10 });
  const requests: URLSearchParams[] = [];
  const app = startDashboard({ document: doc.asDocument(), now: () => now, initialRoute: { page: "overview", query: d.range }, client: { async get<T>(path: string, params: URLSearchParams) {
    if (path === "/api/sessions") { requests.push(params); const offset = Number(params.get("offset")), limit = Number(params.get("limit")); return envelope(sessionsFixture({ rows: all.slice(offset, offset + limit), total: 12, nextOffset: offset + limit < 12 ? offset + limit : null })) as never; }
    return envelope(path === "/api/status" ? statusFixture() : d) as never;
  } } });
  try {
    await settle();
    if (sort === "runs") { descendants(doc.body).find(n => n.getAttribute("data-focus") === "session-sort-runs")!.click(); await settle(); }
    button(doc.body, "Show all 12").click(); await settle();
    expect(descendants(doc.body).filter(n => n.hasAttribute("data-session"))).toHaveLength(12);
    const trigger = descendants(doc.body).find(n => n.className === "pace-trigger")!; trigger.dispatchEvent(new Event("pointerenter"));
    expect(descendants(doc.body).find(n => n.className === "pace-popover")!.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(descendants(doc.body).filter(n => n.hasAttribute("data-session"))).toHaveLength(12);
    expect(requests.at(-1)!.get("offset")).toBe("0"); expect(requests.at(-1)!.get("limit")).toBe("100");
    expect(requests.at(-1)!.get("sort")).toBe(sort);
    expect(descendants(doc.body).find(n => n.className === "pace-popover")!.hidden).toBe(false);
  } finally { app.dispose(); vi.useRealTimers(); }
});

it("Session pages mark Overview current, including direct and invalid entries", () => {
  for (const id of ["synthetic", ""]) {
    const doc = new PlainDocument(), app = startDashboard({ document: doc.asDocument(), initialRoute: { page: "session", id, unit: "credits", tz: "UTC" }, mounts: {}, client: { get: async () => envelope(statusFixture()) as never } });
    try { expect(button(doc.body, "Overview").getAttribute("aria-current")).toBe("page"); expect(button(doc.body, "Calibration & data").hasAttribute("aria-current")).toBe(false); } finally { app.dispose(); }
  }
});
