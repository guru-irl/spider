import { describe, expect, it, vi } from "vitest";
import type { ApiEnvelope, OverviewData, DashboardStatus, UsageMeasure } from "../dashboard-contract.js";
import { createDashboardClient, DashboardClientError, type DashboardClient } from "../web/client.js";
import type { ViewContext } from "../web/views.js";
import { PlainDocument, elements, button, settle, cellText } from "./fixtures/plain-dom.js";

const period = { start: 0, end: 172800000 };
const fit = { status: "calibrated" as const, factor: 0.56, windowStart: 0, windowEnd: 604800000, coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: 0, method: "trailing-7d-ratio" as const };
function measure(): UsageMeasure { return { calls: 1, pricedCalls: 1, unpricedCalls: 0, aggregateCalls: 0,
  tokens: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, prompt: 60, total: 100, reasoning: null, cacheWrite1h: null },
  aic: 1000, aicDisplay: { primaryAic: 560, publishedAic: 1000, basis: "calibrated" }, aicComponents: { input: 100, cacheRead: 200, cacheWrite: 300, output: 400 }, piCost: null,
  possibleOverlap: false, possibleUndercount: false, pendingData: false, estimated: false };
}
function overview(): OverviewData {
  const m = measure();
  const counter = { ts: 86400000, creditsUsed: 10, entitlement: 10000, remaining: 9990, resetDate: null, ageMs: 1000, availability: "available" as const, nextPollAt: null };
  return { calibration: fit, totals: m, actors: [{ label: "parent", isOther: false, measure: m }], roles: [{ label: "Other", isOther: false, measure: m }, { label: "Other", isOther: true, measure: m }],
    daily: { rows: [{ start: 0, end: 86400000, label: "1970-01-01", measure: m, actors: [{ label: "parent", isOther: false, measure: m }], roles: [{ label: "Other", isOther: false, measure: m }] }], nextCursor: null },
    comparison: { start: 0, end: 86400000, counterAic: 10, computed: m, gap: -990, ratio: 100 }, counterObservation: counter,
    pace: { projected: { aicDisplay: { primaryAic: 1120, publishedAic: 2000, basis: "calibrated" }, tokens: { ...m.tokens, total: 200, prompt: 120 }, possibleOverlap: true, possibleUndercount: false, pendingData: true }, counterAic: 20, elapsedFraction: 0.5 } };
}
function envelope<T>(data: T): ApiEnvelope<T> { return { apiVersion: 1, revision: "fixture:0", period, generatedAt: 172800000, data }; }
function status(): DashboardStatus { return { serverBuild: "fixture", schemaVersion: 2, rateVersions: ["fixture-rate"], calls: 1, sources: 5, parseErrors: 9, sourceErrors: 2,
  ingest: { role: "standby", lastIngestAt: 0, ageMs: 125000, stale: true, errorCode: null, backfill: "complete", progress: { sourcesCompleted: 5, sourcesTotal: 5 } },
  counter: { ts: 86400000, creditsUsed: 10, entitlement: 10000, remaining: 9990, resetDate: null, ageMs: 1000, availability: "available", nextPollAt: null } }; }
function fixture(data = overview(), response?: (path: string, params: URLSearchParams) => unknown) {
  const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const requests: string[] = [];
  const client = createDashboardClient(async input => {
    const url = new URL(String(input), "http://127.0.0.1:10000"); requests.push(url.pathname + url.search);
    return new Response(JSON.stringify(envelope(response ? response(url.pathname, url.searchParams) : url.pathname === "/api/status" ? status() : url.pathname === "/api/source-errors" ? { rows: [], nextCursor: null } : data)));
  });
  const controller = new AbortController();
  return { doc, root, requests, controller, ctx: { document: doc.asDocument(), root: root as unknown as HTMLElement, client, period, filters: [{ field: "actor" as const, value: "parent" }], signal: controller.signal, navigate() {} } };
}
function tableRows(root: Parameters<typeof elements>[0], caption: string): string[][] {
  const table = elements(root, "table").find(node => elements(node, "caption")[0]?.textContent === caption);
  expect(table, `table ${caption}`).toBeDefined(); return elements(table!, "tr").slice(1).map(row => row.children.map(cell => cellText(cell)));
}

function deferredFixture() {
  const f = fixture();
  const pending: { path: string; params: URLSearchParams; signal: AbortSignal; resolve(data: unknown): void }[] = [];
  const client: DashboardClient = { get<T>(path: string, params: URLSearchParams, signal: AbortSignal) {
    // This transport deliberately completes after abort, to exercise the view's own stale guards.
    return new Promise<ApiEnvelope<T>>(resolve => pending.push({ path, params, signal, resolve(data) { resolve(envelope(data as T)); } }));
  } };
  return { ...f, pending, ctx: { ...f.ctx, client } };
}
function healthPanel(root: Parameters<typeof elements>[0]) { return elements(root, "section").find(node => node.children.some(child => child.tagName === "H2" && child.textContent === "Ingestion and counter"))!; }

describe("web Overview", () => {
  it("Overview timestamps are readable time elements and markers have a plain-word key", async () => {
    // Break caught: raw ISO copy, timestamp semantics lost, or unexplained footer markers.
    const { mountOverview } = await import("../web/overview.js"), f = fixture();
    const view = await mountOverview(f.ctx);
    try {
      await settle();
      expect(f.root.textContent).toContain("Updated 3 Jan 1970, 00:00 UTC");
      expect(f.root.textContent).toContain("cal means calibrated");
      expect(f.root.textContent).toContain("? means calibration unavailable");
      expect(f.root.textContent).toContain("est means published estimate with calibration off");
      expect(elements(f.root, "time").some(node => node.getAttribute("datetime") === "1970-01-03T00:00:00.000Z")).toBe(true);
      expect(f.root.textContent).not.toContain("1970-01-01T00:00:00.000Z");
      expect(elements(f.root, "dl").length).toBeGreaterThan(0);
    } finally { view.dispose(); }
  });
  it.each([0, 1, 2])("Overview count %s pluralizes call, diagnostic and source evidence", async count => {
    const { mountOverview } = await import("../web/overview.js"), data = overview(), health = status();
    data.totals = { ...data.totals, calls: count };
    health.ingest.progress = { sourcesCompleted: count, sourcesTotal: count };
    const f = fixture(data, path => path === "/api/status" ? health : path === "/api/source-errors" ? {
      rows: Array.from({ length: count }, () => ({ sourceLabel: "source", projectLabel: "project", code: "parse-error", count: 1, lastCheckedAt: 0 })), nextCursor: null,
    } : data);
    const view = await mountOverview(f.ctx);
    try {
      await settle();
      expect.soft(tableRows(f.root, "Selected usage")[0]![4]).toBe(`${count} ${count === 1 ? "call" : "calls"}; 0 unpriced; 0 aggregate`);
      expect.soft(f.root.textContent).toContain(`Backfill: complete · ${count} of ${count} ${count === 1 ? "source" : "sources"}`);
      expect.soft(f.root.textContent).toContain(count ? `${count} source ${count === 1 ? "diagnostic" : "diagnostics"} on this page` : "No source diagnostics recorded.");
    } finally { view.dispose(); }
  });
  it("Overview diagnostics show readable codes instead of internal keys", async () => {
    const { mountOverview } = await import("../web/overview.js"), health = status();
    health.ingest.errorCode = "ingest-failed";
    const codes = [
      ["parse-error", "parse error"], ["missing-db", "missing database"],
      ["runs-db-recreated:facts-retained", "runs database recreated: facts retained"],
      ["SQLITE_BUSY", "SQLite busy"], ["SQLITE_CORRUPT", "SQLite corrupt"],
      ["ENOENT", "file or directory not found"], ["EACCES", "permission denied"],
      ["EPERM", "operation not permitted"], ["EIO", "input/output error"],
    ];
    const f = fixture(overview(), path => path === "/api/status" ? health : path === "/api/source-errors" ? {
      rows: codes.map(([code]) => ({ sourceLabel: "source", projectLabel: "project", code, count: 1, lastCheckedAt: 0 })), nextCursor: null,
    } : overview());
    const view = await mountOverview(f.ctx);
    try {
      await settle();
      expect.soft(f.root.textContent).toContain("Ingest error: ingest failed");
      expect.soft(tableRows(f.root, "Source diagnostics").map(row => row[2])).toEqual(codes.map(([, label]) => label));
    } finally { view.dispose(); }
  });
  it("filter header shows readable dimension names without changing filter values", async () => {
    const { startDashboard } = await import("../web/app.js"), f = fixture();
    const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client,
      initialRoute: { view: "rates", filters: [
        { field: "requestedModel", value: "model-key" }, { field: "runName", value: "run-key" },
        { field: "parentRun", value: "parent-key" }, { field: "auxPurpose", value: "purpose-key" },
        { field: "repo", value: "repo-key" }, { field: "api", value: "api-key" },
      ] } });
    try {
      expect(elements(f.root, "p").find(node => node.className === "slice-label")!.textContent).toBe("Selected filters: requested model = model-key; run name = run-key; parent run = parent-key; auxiliary purpose = purpose-key; repository = repo-key; API = api-key");
    } finally { app.dispose(); }
  });
  it("Clear filters hides for other errors and after a successful refresh", async () => {
    const { mountOverview } = await import("../web/overview.js"), f = fixture();
    let code: "unknown-filter-id" | "ledger-changed" | null = "ledger-changed";
    const client: DashboardClient = { async get<T>(path: string) {
      if (path === "/api/overview" && code) throw new DashboardClientError(code);
      return envelope((path === "/api/overview" ? overview() : status()) as T);
    } };
    const view = await mountOverview({ ...f.ctx, client });
    try {
      await settle(); const clear = button(f.root, "Clear filters"); expect(clear.hidden).toBe(true);
      code = "unknown-filter-id"; button(f.root, "Refresh").click(); await settle(); expect(clear.hidden).toBe(false);
      code = null; button(f.root, "Refresh").click(); expect(clear.hidden).toBe(true); await settle(); expect(clear.hidden).toBe(true);
    } finally { view.dispose(); }
  });
  it("direct mounts clear filters with navigation and keep focus on their heading", async () => {
    const { mountOverview } = await import("../web/overview.js"), f = fixture(), routes: unknown[] = [];
    const client: DashboardClient = { async get() { throw new DashboardClientError("unknown-filter-id"); } };
    const view = await mountOverview({ ...f.ctx, client, navigate(route) { routes.push(route); } });
    try {
      await settle(); const clear = button(f.root, "Clear filters"); clear.focus(); clear.click();
      expect(routes).toEqual([{ view: "overview", filters: [] }]);
      expect(f.doc.activeElement).toBe(elements(f.root, "h1")[0]);
      expect(f.root.textContent).toContain("Remove the unknown filter from the address to continue.");
    } finally { view.dispose(); }
  });

  it("routed mounts receive the id and a live rolling period across refreshes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-31T23:59:30.000Z"));
    try {
      const { startDashboard } = await import("../web/app.js"), { mountOverview } = await import("../web/overview.js");
      const f = fixture(); let context: ViewContext | undefined;
      const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client, initialRoute: { view: "session", id: "session-fixture" }, mounts: { session: async ctx => { context = ctx; return mountOverview(ctx); } } }); await settle();
      expect.soft(context!.id).toBe("session-fixture"); expect(context!.period.end).toBe(Date.parse("2030-01-31T23:59:30.000Z"));
      await vi.advanceTimersByTimeAsync(60000);
      expect(context!.period).toEqual({ start: Date.parse("2030-02-01T00:00:00.000Z"), end: Date.parse("2030-02-01T00:00:30.000Z") });
      expect(elements(f.root, "p").find(node => node.className === "period-label")!.textContent).toBe("1 Feb 2030 to 1 Feb 2030, 00:00:30 UTC");
      context!.navigate({ view: "session", id: "new-session" }); await settle(); expect(context!.id).toBe("new-session");
      const request = new URL(f.requests.filter(path => path.startsWith("/api/overview")).at(-1)!, "http://fixture");
      expect(request.searchParams.get("end")).toBe(String(Date.parse("2030-02-01T00:00:30.000Z"))); app.dispose();
    } finally { vi.useRealTimers(); }
  });
  it.each(["unknown-filter-id", "identity-unavailable", "invalid-query", "ledger-changed"])("Overview does not offer futile Retry for %s", async code => {
    const { mountOverview } = await import("../web/overview.js"); const f = fixture();
    const client = createDashboardClient(async () => new Response(JSON.stringify({ error: { code } }), { status: code === "identity-unavailable" ? 503 : code === "ledger-changed" ? 409 : 400 }));
    const view = await mountOverview({ ...f.ctx, client }); await settle();
    expect(elements(f.root, "button").filter(node => node.textContent === "Retry" && !node.hidden)).toHaveLength(0); view.dispose();
  });
  it.each(["unknown-filter-id", "identity-unavailable", "invalid-query", "ledger-changed"])("terminal %s pauses automatic refresh and suppresses source Retry", async code => {
    vi.useFakeTimers();
    try {
      const { mountOverview } = await import("../web/overview.js"), f = fixture(); let overviewRequests = 0;
      const client = createDashboardClient(async input => {
        if (String(input).startsWith("/api/status")) return new Response(JSON.stringify(envelope(status())));
        if (String(input).startsWith("/api/overview")) ++overviewRequests;
        return new Response(JSON.stringify({ error: { code } }), { status: code === "identity-unavailable" ? 503 : code === "ledger-changed" ? 409 : 400 });
      });
      const view = await mountOverview({ ...f.ctx, client }); await settle();
      expect(elements(healthPanel(f.root), "button").filter(node => node.textContent === "Retry" && !node.hidden)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60000); expect(overviewRequests).toBe(1); view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("app-level Retry keeps a rolling month and focuses Retry after a second failure", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-31T23:59:30Z"));
    try {
      const { startDashboard } = await import("../web/app.js"), f = fixture(); let context: ViewContext | undefined, attempts = 0;
      const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client, mounts: { overview: async ctx => {
        context = ctx; if (++attempts <= 2) throw new Error("offline"); return { dispose() {} };
      } } }); await settle();
      const retry = button(f.root, "Retry"); retry.focus(); retry.click(); await settle();
      const second = button(f.root, "Retry"); expect(f.doc.activeElement).toBe(second);
      second.click(); await settle(); await vi.advanceTimersByTimeAsync(60000);
      expect(context!.period).toEqual({ start: Date.parse("2030-02-01T00:00:00Z"), end: Date.parse("2030-02-01T00:00:30Z") }); app.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("unknown filters offer Clear filters in the same routed view with a rolling period", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-31T23:59:30Z"));
    try {
      const { startDashboard } = await import("../web/app.js"), { mountOverview } = await import("../web/overview.js"), f = fixture();
      const client = createDashboardClient(async () => new Response(JSON.stringify({ error: { code: "unknown-filter-id" } }), { status: 400 }));
      const contexts: ViewContext[] = [];
      const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client, initialRoute: { view: "session", id: "selected", filters: f.ctx.filters }, mounts: { session: async ctx => { contexts.push(ctx); return mountOverview(ctx); } } }); await settle();
      expect(f.root.textContent).toContain("Selected filter is no longer available. Clear filters to continue.");
      const clear = button(f.root, "Clear filters"); expect(clear.hidden).toBe(false); clear.focus(); clear.click(); await settle();
      expect(f.doc.activeElement).toBe(elements(f.root, "h1")[0]);
      expect(contexts).toHaveLength(2); expect(contexts[1]!.id).toBe("selected"); expect(contexts[1]!.filters).toEqual([]);
      await vi.advanceTimersByTimeAsync(60000);
      expect(contexts[1]!.period).toEqual({ start: Date.parse("2030-02-01T00:00:00Z"), end: Date.parse("2030-02-01T00:00:30Z") }); app.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("empty breakdowns explain their missing rows", async () => {
    const { mountOverview } = await import("../web/overview.js"), data = overview(); data.actors = []; data.roles = [];
    const f = fixture(data), view = await mountOverview(f.ctx); await settle();
    expect(tableRows(f.root, "Actors")).toEqual([["No rows for this period"]]); expect(tableRows(f.root, "Roles")).toEqual([["No rows for this period"]]); view.dispose();
  });
  it("app-level Retry focuses the heading of the newly mounted view", async () => {
    const { startDashboard } = await import("../web/app.js"), { mountOverview } = await import("../web/overview.js"); let first = true;
    const f = fixture();
    const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client, mounts: { overview: async ctx => { if (first) { first = false; throw new Error("fixture mount failed"); } return mountOverview(ctx); } } }); await settle();
    const retry = button(f.root, "Retry"); retry.focus(); retry.click(); await settle();
    const heading = elements(f.root, "h1")[0]!;
    expect(f.doc.activeElement).toBe(heading); expect(heading.getAttribute("tabindex")).toBe("-1"); app.dispose();
  });
  it("Retry transfers keyboard focus to the refreshed Overview heading", async () => {
    const { mountOverview } = await import("../web/overview.js"); let online = false;
    const f = fixture(overview(), path => { if (path === "/api/overview" && !online) throw new TypeError("offline"); return path === "/api/status" ? status() : path === "/api/source-errors" ? { rows: [], nextCursor: null } : overview(); });
    const view = await mountOverview(f.ctx); await settle();
    const retry = button(f.root, "Retry"); retry.focus(); online = true; retry.click(); await settle();
    const heading = elements(f.root, "h1")[0]!;
    expect(f.doc.activeElement).toBe(heading); expect(heading.getAttribute("tabindex")).toBe("-1");
    view.dispose();
  });
  it("source diagnostics Retry transfers focus to its refreshed panel heading", async () => {
    const { mountOverview } = await import("../web/overview.js"); let online = false;
    const f = fixture(overview(), path => { if (path === "/api/source-errors" && !online) throw new TypeError("offline"); return path === "/api/status" ? status() : path === "/api/source-errors" ? { rows: [], nextCursor: null } : overview(); });
    const view = await mountOverview(f.ctx); await settle();
    const panel = healthPanel(f.root), retry = button(panel, "Retry"); retry.focus(); online = true; retry.click(); await settle();
    const heading = elements(panel, "h2")[0]!;
    expect(f.doc.activeElement).toBe(heading); expect(heading.getAttribute("tabindex")).toBe("-1"); view.dispose();
  });
  it("auto-refresh preserves daily and source-error pages and skips focused controls", async () => {
    vi.useFakeTimers();
    try {
      const { mountOverview } = await import("../web/overview.js");
      const f = fixture(overview(), (path, params) => {
        if (path === "/api/status") return status();
        if (path === "/api/source-errors") return { rows: [{ sourceLabel: params.get("cursor") ?? "first", projectLabel: "fixture", code: "parse-error", count: 1, lastCheckedAt: 0 }], nextCursor: params.has("cursor") ? null : "error-page-2" };
        const data = overview(); data.daily.nextCursor = params.has("cursor") ? null : "daily-page-2"; data.actors[0]!.label = params.get("cursor") ?? "first"; return data;
      });
      const view = await mountOverview(f.ctx); await settle();
      button(f.root, "Next page").click(); await settle(); button(healthPanel(f.root), "Next page").click(); await settle();
      await vi.advanceTimersByTimeAsync(60000);
      expect.soft(new URL(f.requests.filter(path => path.startsWith("/api/overview")).at(-1)!, "http://fixture").searchParams.get("cursor")).toBe("daily-page-2");
      expect.soft(new URL(f.requests.filter(path => path.startsWith("/api/source-errors")).at(-1)!, "http://fixture").searchParams.get("cursor")).toBe("error-page-2");
      expect(f.requests.filter(path => path.startsWith("/api/status"))).toHaveLength(2);
      expect(f.requests.filter(path => path.startsWith("/api/source-errors"))).toHaveLength(3);
      expect.soft(tableRows(f.root, "Actors")[0]![0]).toBe("daily-page-2"); expect.soft(tableRows(f.root, "Source diagnostics")[0]![0]).toBe("error-page-2");
      const calls = () => f.requests.length;
      for (const control of [button(f.root, "Refresh"), button(f.root, "Previous page"), button(healthPanel(f.root), "Previous page")]) {
        control.focus(); f.doc.dispatchEvent(new Event("keydown")); const before = calls();
        await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(before); expect(f.doc.activeElement).toBe(control);
      }
      view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("auto-refresh pauses on refresh and daily or health paging buttons", async () => {
    vi.useFakeTimers();
    try {
      const { mountOverview } = await import("../web/overview.js"); const data = overview(); data.daily.nextCursor = "daily-next";
      const f = fixture(data, path => path === "/api/status" ? status() : path === "/api/source-errors" ? { rows: [], nextCursor: "error-next" } : data);
      const view = await mountOverview(f.ctx); await settle();
      for (const control of [button(f.root, "Refresh"), button(f.root, "Next page"), button(healthPanel(f.root), "Next page")]) {
        control.focus(); f.doc.dispatchEvent(new Event("keydown")); const before = f.requests.length;
        await vi.advanceTimersByTimeAsync(60000); expect.soft(f.requests.length).toBe(before); expect.soft(f.doc.activeElement).toBe(control);
      }
      f.doc.activeElement = f.doc.body; await vi.advanceTimersByTimeAsync(60000);
      expect(f.requests.filter(path => path.startsWith("/api/overview"))).toHaveLength(2); view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it.each(["navigation", "app disposal"])("%s aborts and disposes the mounted Overview", async mode => {
    vi.useFakeTimers();
    try {
      const { startDashboard } = await import("../web/app.js"); const f = deferredFixture();
      const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client }); await settle();
      expect(f.doc.listeners.get("keydown")?.size).toBe(2); expect(vi.getTimerCount()).toBe(2);
      if (mode === "navigation") { button(f.root, "Context").click(); await settle(); } else app.dispose();
      expect(f.pending.find(request => request.path === "/api/overview")!.signal.aborted).toBe(true);
      expect(f.pending.every(request => request.signal.aborted)).toBe(true);
      expect(f.doc.listeners.get("keydown")?.size ?? 0).toBe(mode === "navigation" ? 1 : 0); expect(vi.getTimerCount()).toBe(0);
      app.dispose();
      expect(f.doc.listeners.get("keydown")?.size ?? 0).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each(["navigation", "app disposal"])("%s releases a mounted view that does not subscribe to abort", async mode => {
    vi.useFakeTimers();
    try {
      const { startDashboard } = await import("../web/app.js"); const f = fixture(); let ticks = 0;
      const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client, mounts: { overview: async () => {
        const timer = setInterval(() => { ++ticks; }, 1000); return { dispose() { clearInterval(timer); } };
      } } }); await settle();
      await vi.advanceTimersByTimeAsync(1000); expect(ticks).toBe(1);
      if (mode === "navigation") { button(f.root, "Context").click(); await settle(); } else app.dispose();
      await vi.advanceTimersByTimeAsync(1000); expect(ticks).toBe(1); expect(vi.getTimerCount()).toBe(0); app.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("direct Overview disposal aborts the in-flight request", async () => {
    const { mountOverview } = await import("../web/overview.js"); const f = deferredFixture();
    const view = await mountOverview(f.ctx); await settle(); view.dispose();
    expect(f.pending.find(request => request.path === "/api/overview")!.signal.aborted).toBe(true);
  });
  it("already-aborted Overview mounts dispose immediately", async () => {
    vi.useFakeTimers();
    try {
      const { mountOverview } = await import("../web/overview.js"); const f = deferredFixture(); f.controller.abort();
      const view = await mountOverview(f.ctx); await settle();
      expect(f.pending).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
      expect(f.doc.listeners.get("keydown")?.size ?? 0).toBe(0); view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("stale and post-dispose Overview responses never replace newer evidence", async () => {
    const { mountOverview } = await import("../web/overview.js"); const f = deferredFixture();
    const view = await mountOverview(f.ctx); await settle(); button(f.root, "Refresh").click();
    const requests = f.pending.filter(request => request.path === "/api/overview");
    const newer = overview(); newer.actors[0]!.label = "newer"; requests[1]!.resolve(newer); await settle();
    const stale = overview(); stale.actors[0]!.label = "stale"; requests[0]!.resolve(stale); await settle();
    expect(tableRows(f.root, "Actors")[0]![0]).toBe("newer");
    button(f.root, "Refresh").click(); view.dispose(); f.pending.filter(request => request.path === "/api/overview").at(-1)!.resolve(stale); await settle();
    expect(tableRows(f.root, "Actors")[0]![0]).toBe("newer");
  });
  it("stale source-error responses never replace newer diagnostics", async () => {
    const { mountOverview } = await import("../web/overview.js"); const f = deferredFixture();
    const view = await mountOverview(f.ctx); await settle(); f.pending.find(request => request.path === "/api/status")!.resolve(status()); await settle();
    button(f.root, "Refresh").click(); f.pending.filter(request => request.path === "/api/status").at(-1)!.resolve(status()); await settle();
    const requests = f.pending.filter(request => request.path === "/api/source-errors");
    const page = (label: string) => ({ rows: [{ sourceLabel: label, projectLabel: "fixture", code: "parse-error", count: 1, lastCheckedAt: 0 }], nextCursor: null });
    requests[1]!.resolve(page("newer")); await settle(); requests[0]!.resolve(page("stale")); await settle();
    expect(tableRows(f.root, "Source diagnostics")[0]![0]).toBe("newer"); view.dispose();
  });
  it("hostile selected filters and source labels are preserved verbatim", async () => {
    const { startDashboard } = await import("../web/app.js"); const hostile = '<img src=x onerror=alert(1)>';
    const f = fixture(overview(), path => path === "/api/status" ? status() : path === "/api/source-errors" ? { rows: [{ sourceLabel: hostile, projectLabel: hostile, code: "parse-error", count: 1, lastCheckedAt: 0 }], nextCursor: null } : overview());
    const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client, initialRoute: { view: "overview", filters: [{ field: "actor", value: hostile }] } }); await settle();
    expect(elements(f.root, "p").find(node => node.className === "slice-label")!.textContent).toBe(`Selected filters: actor = ${hostile}`);
    expect(tableRows(f.root, "Source diagnostics")[0]!.slice(0, 2)).toEqual([hostile, hostile]); expect(elements(f.root, "img")).toHaveLength(0); app.dispose();
  });
  it("Overview preserves lower bounds and changing daily bases", async () => {
    const { mountOverview } = await import("../web/overview.js");
    const data = overview(); const first = data.daily.rows[0]!;
    first.measure.unpricedCalls = 1;
    const back = { ...measure(), aicDisplay: { primaryAic: 560, publishedAic: 1000, basis: "back-applied" as const } };
    const unpriced = { ...measure(), unpricedCalls: 1, pricedCalls: 0, aic: null, aicDisplay: { primaryAic: null, publishedAic: null, basis: "published" as const } };
    data.daily = { rows: [first, { ...first, start: 86400000, end: 129600000, label: "1970-01-02 early", measure: back }, { ...first, start: 129600000, end: 172800000, label: "1970-01-02 late", measure: unpriced }], nextCursor: null };
    const f = fixture(data); const view = await mountOverview(f.ctx); await settle();
    const totalChart = (basis: string) => elements(f.root, "section").find(node => node.children.some(child => child.tagName === "H3" && child.textContent === `Daily total · ${basis}`))!;
    expect(elements(totalChart("calibrated"), "title")[1]!.textContent).toContain("560+ AIC cal");
    expect(tableRows(totalChart("calibrated"), "Daily total · calibrated")[0]![2]).toBe("560+ AIC calibrated");
    expect(elements(totalChart("calibrated"), "p")[0]!.textContent).toContain("560+ AIC calibrated maximum");
    expect(elements(totalChart("calibrated, back-applied"), "title")[1]!.textContent).toContain("calibrated, back-applied");
    expect(tableRows(totalChart("calibrated, back-applied"), "Daily total · calibrated, back-applied")[0]![2]).toBe("560 AIC calibrated, back-applied");
    expect(elements(totalChart("published"), "circle")).toHaveLength(0);
    expect(elements(totalChart("published"), "title")[1]!.textContent).toContain("unpriced AIC");
    view.dispose();
  });
  it("Overview shutdown pauses until a successful user retry", async () => {
    vi.useFakeTimers();
    try {
      const { mountOverview } = await import("../web/overview.js");
      let online = false;
      const f = fixture(overview(), path => { if (!online) throw new TypeError("fixture server stopped"); return path === "/api/status" ? status() : path === "/api/source-errors" ? { rows: [], nextCursor: null } : overview(); });
      const view = await mountOverview(f.ctx); await settle();
      expect(f.root.textContent).toContain("Run /usage again");
      await vi.advanceTimersByTimeAsync(600000);
      expect(f.requests.filter(path => path.startsWith("/api/overview"))).toHaveLength(1);
      online = true; f.doc.dispatchEvent(new Event("keydown")); button(f.root, "Retry").click(); await settle();
      expect(tableRows(f.root, "Actors")[0]![1]).toBe("560 AIC cal");
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.requests.filter(path => path.startsWith("/api/overview"))).toHaveLength(3);
      view.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("browser default month advances through now without changing explicit periods", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-31T23:59:30.000Z"));
    try {
      const { startDashboard } = await import("../web/app.js"); const f = fixture();
      const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client }); await settle();
      await vi.advanceTimersByTimeAsync(60000);
      const request = new URL(f.requests.filter(path => path.startsWith("/api/overview")).at(-1)!, "http://127.0.0.1");
      expect(new Date(Number(request.searchParams.get("end"))).toISOString()).toBe("2030-02-01T00:00:30.000Z");
      expect(new Date(Number(request.searchParams.get("start"))).toISOString()).toBe("2030-02-01T00:00:00.000Z");
      app.dispose();
      const historical = fixture(); const fixed = startDashboard({ document: historical.doc.asDocument(), root: historical.root as unknown as HTMLElement, client: historical.ctx.client, initialRoute: { view: "overview", period } });
      await settle(); await vi.advanceTimersByTimeAsync(60000);
      const old = new URL(historical.requests.filter(path => path.startsWith("/api/overview")).at(-1)!, "http://127.0.0.1");
      expect(old.searchParams.get("start")).toBe("0"); expect(old.searchParams.get("end")).toBe("172800000"); fixed.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("Overview refreshes only while visible active and unfocused in evidence", async () => {
    // Break caught: background polling, abandoned-tab polling, or replacing a focused chart/table.
    vi.useFakeTimers();
    try {
      const { mountOverview } = await import("../web/overview.js");
      const f = fixture(); const view = await mountOverview(f.ctx); await settle();
      const calls = () => f.requests.filter(path => path.startsWith("/api/overview")).length;
      expect(calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(2);
      f.doc.visibilityState = "hidden"; await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(2);
      f.doc.visibilityState = "visible";
      const chart = elements(f.root, "section").find(node => node.className === "chart-panel")!;
      button(chart, "Table").focus(); await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(2);
      f.doc.activeElement = null; await vi.advanceTimersByTimeAsync(120000); expect(calls()).toBe(3); // 4 min fetch, 5 min inactive
      await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(3);
      f.doc.dispatchEvent(new Event("keydown")); await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(4);
      view.dispose(); await vi.advanceTimersByTimeAsync(60000); expect(calls()).toBe(4);
      expect(f.doc.listeners.get("keydown")?.size ?? 0).toBe(0); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("browser entry mounts Overview and preserves focused actions", async () => {
    // Break caught: an inert browser entry or navigation/refresh that steals focus or changes the selected slice.
    const module = await import("../web/app.js").catch(() => null);
    expect(module, "browser entry is available").not.toBeNull();
    const f = fixture();
    const app = module!.startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client, now: () => period.end,
      initialRoute: { view: "overview", period, filters: f.ctx.filters } });
    await settle();
    expect(elements(f.root, "nav")).toHaveLength(1); expect(elements(f.root, "h1")[0]!.textContent).toBe("Overview");
    const refresh = button(f.root, "Refresh"); refresh.focus(); refresh.click(); await settle();
    expect(f.doc.activeElement).toBe(refresh);
    button(f.root, "Context").click(); await settle();
    expect(f.root.textContent).toContain("This view is not included in this build.");
    button(f.root, "Overview").click(); await settle();
    expect(f.requests.filter(path => path.startsWith("/api/overview")).every(path => new URL(path, "http://127.0.0.1").searchParams.get("filters") === '[{"field":"actor","value":"parent"}]')).toBe(true);
    app.dispose();
  });
  it("Overview health separates ages and errors", async () => {
    // Break caught: conflating ingest/counter ages or resetting the selected usage/daily page when paging errors.
    const { mountOverview } = await import("../web/overview.js");
    const s = status();
    const f = fixture(overview(), (path, params) => path === "/api/status" ? s : path === "/api/source-errors" ? {
      rows: Array.from({ length: params.has("cursor") ? 50 : 200 }, (_, i) => ({ sourceLabel: `source-${params.has("cursor") ? 200 + i : i}.jsonl`, projectLabel: "Unknown project", code: "parse-error", count: 3, lastCheckedAt: 1000 })),
      nextCursor: params.has("cursor") ? null : "fixture-page-2",
    } : overview());
    const view = await mountOverview(f.ctx); await settle();
    expect(f.root.textContent).toContain("Ingest age: 125 s (stale)");
    expect(f.root.textContent).toContain("Counter age: 1 s (available)");
    expect(f.root.textContent).toContain("Parse errors (recorded): 9");
    expect(f.root.textContent).toContain("Source errors (current): 2");
    expect(f.root.textContent).toContain("Ingest role: standby");
    expect(tableRows(f.root, "Source diagnostics")).toHaveLength(200);
    const health = elements(f.root, "section").find(node => node.children.some(child => child.tagName === "H2" && child.textContent === "Ingestion and counter"))!;
    button(health, "Next page").click(); await settle();
    expect(tableRows(f.root, "Source diagnostics")).toHaveLength(50);
    expect(tableRows(f.root, "Source diagnostics")[0]).toEqual(["source-200.jsonl", "Unknown project", "parse error", "3", "1 Jan 1970, 00:00:01 UTC"]);
    expect(f.requests.filter(path => path.startsWith("/api/overview"))).toHaveLength(1);
    expect(f.requests.filter(path => path.startsWith("/api/source-errors"))).toEqual(["/api/source-errors?limit=200", "/api/source-errors?limit=200&cursor=fixture-page-2"]);
    for (const role of ["owner", "follower", "inactive", "standby"] as const) {
      s.ingest.role = role; button(f.root, "Refresh").click(); await settle(); expect(f.root.textContent).toContain(`Ingest role: ${role}`);
    }
    s.counter.availability = "stale"; s.counter.ageMs = 650000; s.ingest.ageMs = 1000; s.ingest.stale = false;
    button(f.root, "Refresh").click(); await settle();
    expect(f.root.textContent).toContain("Counter age: 650 s (stale)"); expect(f.root.textContent).toContain("Ingest age: 1 s (fresh)");
    view.dispose();
  });
  it("Overview pairs estimates and tokens", async () => {
    // Break caught: independent AIC/token panes, published-only primaries, misleading Other bucket or Phase 4 insights.
    const module = await import("../web/overview.js").catch(() => null);
    expect(module, "Overview mount is available").not.toBeNull();
    const f = fixture(); const view = await module!.mountOverview(f.ctx); await settle();
    expect(tableRows(f.root, "Actors")[0]).toEqual(["parent", "560 AIC cal", "~1,000 AIC published estimate", "input 10; cache read 20; cache write 30; output 40; prompt 60; total 100; cache write 1h unavailable; reasoning unavailable", "1 call; 0 unpriced; 0 aggregate"]);
    expect(tableRows(f.root, "Roles").map(row => row[0])).toEqual(["Other", "Other (remaining roles)"]);
    expect(tableRows(f.root, "Month pace")[0]!.slice(0, 3)).toEqual(["Linear month-end projection", "1,120 AIC cal", "~2,000 AIC published estimate"]);
    expect(tableRows(f.root, "Month pace")[0]![3]).toContain("total 200");
    expect(f.root.textContent).toContain("calibrated x0.56 over 7 days");
    expect(f.root.textContent).toContain("Possible overlap"); expect(f.root.textContent).toContain("Pending data");
    expect(f.root.textContent).not.toMatch(/insights|what-if|alerts/i);
    expect(f.root.textContent).toContain("counter is account-wide");
    const chart = elements(f.root, "section").find(node => elements(node, "h3")[0]?.textContent === "Daily actor · parent · calibrated");
    expect(chart).toBeDefined(); expect(elements(chart!, "title")[1]!.textContent).toContain("560 AIC calibrated");
    expect(elements(chart!, "title")[1]!.textContent).toContain("published estimate ~1,000 AIC");
    expect(elements(chart!, "title")[1]!.textContent).toContain("total 100");
    button(chart!, "Table").click(); expect(elements(chart!, "table")[0]!.parentElement!.hidden).toBe(false);
    expect(new URL(f.requests.find(path => path.startsWith("/api/overview"))!, "http://127.0.0.1").searchParams.get("filters")).toBe('[{"field":"actor","value":"parent"}]');
    view.dispose();
  });
});

it("in-place resume retains Overview chart selection, focus and page cursors; Refresh and Next still work", async () => {
  vi.useFakeTimers();
  const { mountOverview } = await import("../web/overview.js"); const data = overview(); data.daily.nextCursor = "page-2";
  const f = fixture(data); const view = await mountOverview(f.ctx);
  try {
    await settle(); const toggle = button(f.root, "Table"); toggle.click(); toggle.focus();
    const region = elements(f.root, "table").find(t => elements(t, "caption")[0]?.textContent === "Daily total · calibrated")!.parentElement!;
    const count = f.requests.length; view.suspend!(false); await vi.advanceTimersByTimeAsync(120000); expect(f.requests).toHaveLength(count);
    view.suspend!(true); expect(f.controller.signal.aborted).toBe(false); view.resume!(); view.refresh!(); await settle();
    expect(button(f.root, "Table")).toBe(toggle); expect(f.doc.activeElement).toBe(toggle); expect(region.hidden).toBe(false);
    view.suspend!(true); button(f.root, "Next page").click(); await settle();
    expect(new URL(f.requests.filter(p => p.startsWith("/api/overview")).at(-1)!, "https://fixture").searchParams.get("cursor")).toBe("page-2");
    view.suspend!(true); button(f.root, "Refresh").click(); await settle();
    expect(new URL(f.requests.filter(p => p.startsWith("/api/overview")).at(-1)!, "https://fixture").searchParams.get("cursor")).toBe("page-2");
  } finally { view.dispose(); vi.useRealTimers(); }
});
it("suspension aborts every owned Overview request without disposal or stale repaint", async () => {
  const { mountOverview } = await import("../web/overview.js"), f = deferredFixture(); const view = await mountOverview(f.ctx);
  try {
    view.suspend!(true); expect(f.pending.every(p => p.signal.aborted)).toBe(true); expect(f.controller.signal.aborted).toBe(false);
    f.pending.forEach(p => p.resolve(p.path === "/api/status" ? status() : overview())); await settle();
    expect(f.root.textContent).not.toContain("Selected period");
    view.resume!(); view.refresh!(); expect(f.pending.filter(p => !p.signal.aborted)).toHaveLength(2);
  } finally { view.dispose(); }
});
it("comparison dates append directly without serializing and reparsing ISO", async () => {
  const { mountOverview } = await import("../web/overview.js"), f = fixture();
  const parse = vi.spyOn(Date, "parse"); const view = await mountOverview(f.ctx);
  try {
    await settle();
    // Calibration's backward-compatible legend still parses its ISO; the
    // comparison must not add another start/end pair to that list.
    expect(parse.mock.calls.filter(([value]) => value === "1970-01-02T00:00:00.000Z")).toHaveLength(0);
    const table = elements(f.root, "table").find(t => elements(t, "caption")[0]?.textContent === "Account comparison")!;
    expect(elements(table, "time").map(t => t.getAttribute("datetime"))).toEqual(["1970-01-01T00:00:00.000Z", "1970-01-02T00:00:00.000Z"]);
  } finally { parse.mockRestore(); view.dispose(); }
});

it.each(["Refresh", "Next page"])("paused app runs the user's %s without remount or a redundant wake refresh", async label => {
  vi.useFakeTimers(); const { startDashboard } = await import("../web/app.js"); const data = overview(); data.daily.nextCursor = "page-2";
  const f = fixture(data); const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client, initialRoute: { view: "overview", period, filters: f.ctx.filters } });
  try {
    await settle(); const section = f.root.children[0]; const control = button(f.root, label); control.focus();
    await vi.advanceTimersByTimeAsync(300000); const count = f.requests.filter(p => p.startsWith("/api/overview")).length;
    f.doc.dispatchEvent(new Event("click")); control.click(); await settle(); await vi.advanceTimersByTimeAsync(300);
    expect(f.requests.filter(p => p.startsWith("/api/overview"))).toHaveLength(count + 1);
    expect(f.root.children[0]).toBe(section); expect(button(f.root, label)).toBe(control); expect(f.doc.activeElement).toBe(control);
    expect(new URL(f.requests.filter(p => p.startsWith("/api/overview")).at(-1)!, "https://fixture").searchParams.get("cursor")).toBe(label === "Next page" ? "page-2" : null);
  } finally { app.dispose(); vi.useRealTimers(); }
});

it("app-owned pointer activity keeps real Overview polling for twenty minutes", async () => {
  vi.useFakeTimers(); const { startDashboard } = await import("../web/app.js"); const f = fixture();
  const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client, initialRoute: { view: "overview", period } });
  try {
    await settle();
    for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(60000); f.doc.dispatchEvent(new Event("pointermove")); }
    expect(f.requests.filter(p => p.startsWith("/api/overview"))).toHaveLength(21);
  } finally { app.dispose(); vi.useRealTimers(); }
});

it("a successful key wake refresh hides Retry and focuses the section heading", async () => {
  vi.useFakeTimers(); const { startDashboard } = await import("../web/app.js"); const f = fixture(); let fail = true;
  const client: DashboardClient = { async get<T>(path: string) { if (fail && path === "/api/overview") throw new DashboardClientError("busy"); return envelope((path === "/api/status" ? status() : path === "/api/source-errors" ? { rows: [], nextCursor: null } : overview()) as T); } };
  const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client, initialRoute: { view: "overview", period } });
  try {
    await settle(); const retry = button(f.root, "Retry"); expect(retry.hidden).toBe(false); retry.focus(); await vi.advanceTimersByTimeAsync(300000);
    fail = false; f.doc.dispatchEvent(new Event("keydown")); await vi.advanceTimersByTimeAsync(300); await settle();
    expect(retry.hidden).toBe(true); expect(f.doc.activeElement).toBe(elements(f.root, "h1")[0]); expect(elements(f.root, "h1")[0]!.getAttribute("tabindex")).toBe("-1");
  } finally { app.dispose(); vi.useRealTimers(); }
});

it("paused health Next page runs its own action once, cancelling the pending wake refresh", async () => {
  vi.useFakeTimers(); const { startDashboard } = await import("../web/app.js");
  const f = fixture(overview(), path => path === "/api/status" ? status() : path === "/api/source-errors" ? { rows: [], nextCursor: "diag-2" } : overview());
  const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client: f.ctx.client, initialRoute: { view: "overview", period } });
  try {
    await settle(); const next = button(healthPanel(f.root), "Next page"); next.focus(); await vi.advanceTimersByTimeAsync(300000);
    const count = f.requests.length; f.doc.dispatchEvent(new Event("click")); next.click(); await settle(); await vi.advanceTimersByTimeAsync(300);
    expect(f.requests).toHaveLength(count + 1); expect(f.requests.at(-1)).toContain("cursor=diag-2"); expect(f.doc.activeElement).toBe(next);
  } finally { app.dispose(); vi.useRealTimers(); }
});

it("a resumed Overview cursor keeps its response period across a rolling-month boundary", async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2030, 0, 31, 23, 59)); const { startDashboard } = await import("../web/app.js"); const f = fixture();
  const requests: URLSearchParams[] = []; const data = overview(); data.daily.nextCursor = "page-2";
  const client: DashboardClient = { async get<T>(path: string, params: URLSearchParams) {
    if (path === "/api/overview") requests.push(new URLSearchParams(params));
    return { ...envelope((path === "/api/status" ? status() : path === "/api/source-errors" ? { rows: [], nextCursor: null } : data) as T), period: params.has("start") ? { start: Number(params.get("start")), end: Number(params.get("end")) } : period };
  } };
  const app = startDashboard({ document: f.doc.asDocument(), root: f.root as unknown as HTMLElement, client });
  try {
    await settle(); button(f.root, "Next page").click(); await settle(); const pin = requests.at(-1)!;
    await vi.advanceTimersByTimeAsync(300000); f.doc.dispatchEvent(new Event("keydown")); await vi.advanceTimersByTimeAsync(300); await settle();
    expect(requests.at(-1)!.get("cursor")).toBe("page-2"); expect(requests.at(-1)!.get("start")).toBe(pin.get("start")); expect(requests.at(-1)!.get("end")).toBe(pin.get("end"));
    button(f.root, "Previous page").click(); await settle(); expect(requests.at(-1)!.get("cursor")).toBeNull(); expect(requests.at(-1)!.get("start")).toBe(String(Date.UTC(2030, 1, 1)));
  } finally { app.dispose(); vi.useRealTimers(); }
});


it.each([0, 2])("successful wake with %s source errors hides health Retry and focuses its heading", async sourceErrors => {
  // Break caught: diagnostics success leaves a focused Retry visible or loses focus.
  const { mountOverview } = await import("../web/overview.js"); const f = fixture(); let fail = true;
  f.ctx.client = { async get<T>(path: string) {
    if (path === "/api/source-errors" && fail) throw new DashboardClientError("busy");
    return envelope((path === "/api/status" ? { ...status(), sourceErrors: fail ? 2 : sourceErrors, parseErrors: 0 } : path === "/api/source-errors" ? { rows: [], nextCursor: null } : overview()) as T);
  } };
  const view = await mountOverview(f.ctx);
  try {
    await settle(); const panel = healthPanel(f.root), retry = button(panel, "Retry"); expect(retry.hidden).toBe(false); retry.focus();
    fail = false; view.refresh!(); await settle(); expect(retry.hidden).toBe(true); expect(f.doc.activeElement).toBe(elements(panel, "h2")[0]);
  } finally { view.dispose(); }
});
