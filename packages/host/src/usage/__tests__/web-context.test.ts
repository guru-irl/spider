import { describe, expect, it, vi } from "vitest";
import type { ApiEnvelope, ContextData } from "../dashboard-contract.js";
import type { ViewRoute } from "../web/views.js";
import { createDashboardClient, DashboardClientError } from "../web/client.js";
import { PlainDocument, button, elements, settle } from "./fixtures/plain-dom.js";

const period = { start: 0, end: 172800000 };
const unavailable = { status: "unavailable" as const, phase: 2 as const, reason: "not-built" as const, message: "Not available yet (Phase 2)" as const };
const data: ContextData = { contextFillPercent: null, contextFillMessage: "Context fill unavailable: historical window not recorded", composition: unavailable, carry: unavailable, itemReuse: unavailable };
function fixture(fetcher?: typeof fetch) {
  const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const requests: string[] = [], routes: ViewRoute[] = [];
  const client = createDashboardClient(fetcher ?? (async input => {
    requests.push(String(input));
    const envelope: ApiEnvelope<ContextData> = { apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data };
    return new Response(JSON.stringify(envelope));
  }));
  const controller = new AbortController();
  return { doc, root, requests, routes, controller, ctx: { document: doc.asDocument(), root: root as unknown as HTMLElement, client, period,
    filters: [{ field: "session" as const, value: "session-fixture", kind: "id" as const }, { field: "run" as const, value: "run-fixture", kind: "id" as const }], signal: controller.signal, navigate(route: ViewRoute) { routes.push(route); } } };
}
describe("web Context", () => {
  it("Context bounds refresh and cancellation without fabricating evidence", async () => {
    // Break caught: hidden/inactive refresh, stale decoded responses after abort, or resuming automatic requests while shut down.
    vi.useFakeTimers();
    try {
      const { mountContext } = await import("../web/context.js"); let online = true, requests = 0;
      const f = fixture(async () => { requests++; if (!online) throw new TypeError("private shutdown"); return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data })); });
      const view = await mountContext(f.ctx); await settle(); expect(requests).toBe(1);
      await vi.advanceTimersByTimeAsync(60000); expect(requests).toBe(2);
      f.doc.visibilityState = "hidden"; await vi.advanceTimersByTimeAsync(60000); expect(requests).toBe(2);
      f.doc.visibilityState = "visible"; button(f.root, "Session").focus(); await vi.advanceTimersByTimeAsync(60000); expect(requests).toBe(2);
      f.doc.activeElement = null; await vi.advanceTimersByTimeAsync(120000); expect(requests).toBe(3);
      await vi.advanceTimersByTimeAsync(60000); expect(requests).toBe(3);
      f.doc.dispatchEvent(new Event("keydown")); online = false; await vi.advanceTimersByTimeAsync(60000); expect(requests).toBe(4); expect(f.root.textContent).toContain("Run /usage again");
      f.doc.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(120000); expect(requests).toBe(4);
      online = true; button(f.root, "Retry").click(); await settle(); await vi.advanceTimersByTimeAsync(60000); expect(requests).toBe(6);
      f.controller.abort(); await vi.advanceTimersByTimeAsync(60000); expect(requests).toBe(6); expect(vi.getTimerCount()).toBe(0); expect(f.doc.listeners.get("keydown")?.size ?? 0).toBe(0); view.dispose();
      let finish!: (value: Response) => void; let signal: AbortSignal | undefined;
      const pending = fixture(async (_input, init) => { signal = init?.signal as AbortSignal; return new Promise(resolve => { finish = resolve; }); });
      const pendingView = await mountContext(pending.ctx); await settle(); pending.controller.abort(); const before = pending.root.textContent;
      expect(signal?.aborted).toBe(true); finish(new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data }))); await settle(); expect(pending.root.textContent).toBe(before);
      expect(vi.getTimerCount()).toBe(0); pendingView.dispose();
      const aborted = fixture(); aborted.controller.abort(); const inactive = await mountContext(aborted.ctx); await settle(); expect(aborted.requests).toHaveLength(0); expect(vi.getTimerCount()).toBe(0); inactive.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("Context exact unavailable copy", async () => {
    // Break caught: fake composition/fill, extra measure requests, or evidence links dropping the selected slice.
    const module = await import("../web/context.js").catch(() => null);
    expect(module, "Context mount is available").not.toBeNull();
    const f = fixture(), view = await module!.mountContext(f.ctx); await settle();
    expect(elements(f.root, "h1")[0]!.textContent).toBe("Context");
    expect(f.root.textContent).toContain("Context fill unavailable: historical window not recorded");
    expect(elements(f.root, "p").filter(node => node.textContent === "Not available yet (Phase 2)")).toHaveLength(3);
    expect(f.root.textContent).toContain("tokens and primary AIC");
    expect(f.root.textContent).not.toMatch(/0%|0 AIC|0 tokens|composition estimate/i);
    expect(elements(f.root, "svg")).toHaveLength(0); expect(elements(f.root, "table")).toHaveLength(0);
    button(f.root, "Overview").click(); button(f.root, "Session").click(); button(f.root, "Run").click();
    expect(f.routes).toEqual([{ view: "overview", filters: f.ctx.filters }, { view: "session", id: "session-fixture", filters: [] }, { view: "run", id: "run-fixture", filters: [] }]);
    expect(f.requests).toHaveLength(1);
    const request = new URL(f.requests[0]!, "http://127.0.0.1"); expect(request.pathname).toBe("/api/context");
    expect(request.searchParams.get("start")).toBe("0"); expect(request.searchParams.get("end")).toBe("172800000"); expect(request.searchParams.get("filters")).toBe('[{"field":"session","value":"session-fixture","kind":"id"},{"field":"run","value":"run-fixture","kind":"id"}]');
    view.dispose();
  });
});

describe("Context fix round", () => {
  it.each(["malformed", "raw"])("%s identity filters never become detail route ids", async mode => {
    const { mountContext } = await import("../web/context.js"); const f = fixture();
    Object.assign(f.ctx, { filters: [{ field: "session", value: mode === "malformed" ? "../outside" : "session-fixture", ...(mode === "raw" ? {} : { kind: "id" }) }] });
    const view = await mountContext(f.ctx); await settle(); button(f.root, "Session").click();
    expect(f.routes[0]).toEqual({ view: "session", filters: f.ctx.filters }); view.dispose();
  });
  it("Retry moves focus to the panel heading, without stealing other focus", async () => {
    const { mountContext } = await import("../web/context.js"); let online = false;
    const f = fixture(async () => { if (!online) throw new Error("fixture"); return new Response(JSON.stringify({ apiVersion: 1, revision: "r", period, generatedAt: 1, data })); });
    const view = await mountContext(f.ctx); await settle(); const retry = button(f.root, "Retry"); retry.focus(); online = true; retry.click(); await settle();
    expect(f.doc.activeElement).toBe(elements(f.root, "h1")[0]); expect(elements(f.root, "h1")[0]!.getAttribute("tabindex")).toBe("-1");
    const refresh = button(f.root, "Refresh"); refresh.focus(); refresh.click(); await settle(); expect(f.doc.activeElement).toBe(refresh); view.dispose();
  });
});

it("Context late decoded success and error cannot write after explicit disposal", async () => {
  const { mountContext } = await import("../web/context.js");
  for (const result of ["success", "error"]) {
    const f = fixture(); let resolve!: (value: ApiEnvelope<ContextData>) => void, reject!: (error: unknown) => void, signal!: AbortSignal;
    f.ctx.client = { get<T>(_path: string, _params: URLSearchParams, requestSignal: AbortSignal): Promise<ApiEnvelope<T>> {
      signal = requestSignal; return new Promise((ok, fail) => { resolve = value => ok(value as ApiEnvelope<T>); reject = fail; });
    } };
    const view = await mountContext(f.ctx); view.dispose(); expect(signal.aborted).toBe(true); const before = f.root.textContent;
    if (result === "success") resolve({ apiVersion: 1, revision: "r", period, generatedAt: 1, data }); else reject(new Error("late failure"));
    await settle(); expect(f.root.textContent).toBe(before);
  }
});


it.each(["invalid-query", "ledger-changed", "unknown-filter-id", "identity-unavailable"])("Context %s pauses terminal automatic refresh", async code => {
  // Break caught: pausing only shutdown makes terminal requests recur every minute.
  vi.useFakeTimers(); try {
    const { mountContext } = await import("../web/context.js"); let requests = 0;
    const f = fixture(async () => { requests++; return new Response(JSON.stringify({ apiVersion: 1, error: { code, message: "PRIVATE" } }), { status: code === "ledger-changed" ? 409 : 400 }); });
    const view = await mountContext(f.ctx); await settle(); expect(button(f.root, "Retry").hidden).toBe(true); expect(f.root.textContent).not.toContain("PRIVATE");
    await vi.advanceTimersByTimeAsync(60000); expect(requests).toBe(1); view.dispose();
  } finally { vi.useRealTimers(); }
});


it.each([true, false])("Context unknown-filter copy and action reflect supplied routing (%s)", async supplied => {
  // Break caught: advertising an unavailable action, ignoring shell routing or leaving it visible during refresh.
  const { mountContext } = await import("../web/context.js"), f = fixture(), clearFilters = vi.fn();
  const pending: { resolve(value: ApiEnvelope<ContextData>): void; reject(error: unknown): void }[] = [];
  f.ctx.client = { get<T>(): Promise<ApiEnvelope<T>> { return new Promise((resolve, reject) => pending.push({ resolve: value => resolve(value as ApiEnvelope<T>), reject })); } };
  const view = await mountContext({ ...f.ctx, ...(supplied ? { clearFilters } : {}) });
  pending[0]!.reject(new DashboardClientError("unknown-filter-id")); await settle();
  expect(f.root.textContent).toContain(supplied ? "Selected filter is no longer available. Clear filters to continue." : "Selected filter is no longer available. Remove the unknown filter from the address to continue.");
  const visible = elements(f.root, "button").filter(n => n.textContent === "Clear filters" && !n.hidden);
  expect(visible).toHaveLength(supplied ? 1 : 0);
  if (supplied) { visible[0]!.click(); expect(clearFilters).toHaveBeenCalledTimes(1); expect(f.routes).toEqual([]); visible[0]!.focus(); }
  button(f.root, "Refresh").click(); expect(elements(f.root, "button").filter(n => n.textContent === "Clear filters" && !n.hidden)).toHaveLength(0);
  if (supplied) expect(f.doc.activeElement).toBe(elements(f.root, "h1")[0]);
  pending[1]!.resolve({ apiVersion: 1, revision: "fixture:0", period, generatedAt: period.end, data }); await settle();
  expect(elements(f.root, "button").filter(n => n.textContent === "Clear filters" && !n.hidden)).toHaveLength(0);
  button(f.root, "Refresh").click(); pending[2]!.reject(new DashboardClientError("invalid-query")); await settle();
  expect(elements(f.root, "button").filter(n => n.textContent === "Clear filters" && !n.hidden)).toHaveLength(0); view.dispose();
});


describe("Task 13 Context alignment", () => {
  it("pauses timers and aborts/fences owned requests, then updates in place without losing focus", async () => {
    vi.useFakeTimers(); try {
      const { mountContext } = await import("../web/context.js"), f = fixture();
      const pending: {signal: AbortSignal; resolve(value: ApiEnvelope<ContextData>): void; reject(error: unknown): void}[] = [];
      f.ctx.client = {get<T>(_path: string, _params: URLSearchParams, signal: AbortSignal): Promise<ApiEnvelope<T>> {return new Promise((resolve,reject) => pending.push({signal,resolve: value => resolve(value as ApiEnvelope<T>),reject}));}};
      const started = vi.fn(), view = await mountContext({...f.ctx, requestStarted: started, idleMs: () => 0});
      expect(view.suspend).toBeTypeOf("function"); view.suspend!(false); expect(pending[0]!.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
      view.suspend!(true); expect(pending[0]!.signal.aborted).toBe(true); expect(f.ctx.signal.aborted).toBe(false); const before = f.root.textContent;
      pending[0]!.resolve({apiVersion:1,revision:"r",period,generatedAt:period.end,data}); await settle(); expect(f.root.textContent).toBe(before);
      view.resume!(); view.resume!(); view.refresh!(); expect(pending).toHaveLength(2); pending[1]!.resolve({apiVersion:1,revision:"r",period,generatedAt:period.end,data}); await settle();
      const paragraph = elements(f.root,"p").find(n => n.textContent === data.contextFillMessage)!, link = button(f.root,"Session"); link.focus();
      view.suspend!(false); view.resume!(); view.refresh!(); pending[2]!.resolve({apiVersion:1,revision:"r2",period,generatedAt:period.end + 1000,data}); await settle();
      expect(elements(f.root,"p").find(n => n.textContent === data.contextFillMessage)).toBe(paragraph); expect(f.doc.activeElement).toBe(link);
      expect(elements(f.root,"time")[0]!.getAttribute("datetime")).toBe("1970-01-03T00:00:01.000Z"); expect(elements(f.root,"time")[0]!.textContent).toBe("3 Jan 1970, 00:00:01 UTC");
      expect(started).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(1); view.dispose(); view.resume!(); view.refresh!(); expect(pending).toHaveLength(3); expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
  });
  it("successful wake hides focused Retry only at success and focuses the section heading", async () => {
    const { mountContext } = await import("../web/context.js"), f = fixture(); let online = false;
    f.ctx.client = createDashboardClient(async () => {if (!online) throw new Error("fixture"); return new Response(JSON.stringify({apiVersion:1,revision:"r",period,generatedAt:period.end,data}));});
    const view = await mountContext(f.ctx); await settle(); const retry = button(f.root,"Retry"); retry.focus(); online = true;
    expect(view.refresh).toBeTypeOf("function"); view.refresh!(); expect(retry.hidden).toBe(false); expect(f.doc.activeElement).toBe(retry); await settle();
    expect(retry.hidden).toBe(true); expect(f.doc.activeElement).toBe(elements(f.root,"h1")[0]); view.dispose();
  });
  it("uses app activity for ongoing polling and notifies the app about owned actions", async () => {
    vi.useFakeTimers(); try {
      const {mountContext} = await import("../web/context.js"), f=fixture(), started=vi.fn(), view=await mountContext({...f.ctx,idleMs:()=>0,requestStarted:started}); await settle();
      await vi.advanceTimersByTimeAsync(1200000); expect(f.requests).toHaveLength(21); expect(started).toHaveBeenCalledTimes(21); view.dispose();
    } finally {vi.useRealTimers();}
  });
});


it("Context wake refresh leaves an in-flight request intact and refreshes after completion", async () => {
  // Breaks: missing !loading guard aborts and duplicates the current request.
  const { mountContext } = await import("../web/context.js"), f = fixture();
  const pending: { signal: AbortSignal; resolve(value: ApiEnvelope<ContextData>): void }[] = [];
  f.ctx.client = { get<T>(_path: string, _params: URLSearchParams, signal: AbortSignal): Promise<ApiEnvelope<T>> {
    return new Promise(resolve => pending.push({ signal, resolve: value => resolve(value as ApiEnvelope<T>) }));
  } };
  const view = await mountContext(f.ctx), response: ApiEnvelope<ContextData> = { apiVersion: 1, revision: "r", period, generatedAt: period.end, data };
  try {
    view.refresh!(); expect(pending).toHaveLength(1); expect(pending[0]!.signal.aborted).toBe(false);
    pending[0]!.resolve(response); await settle(); view.refresh!(); view.refresh!();
    expect(pending).toHaveLength(2); expect(pending[1]!.signal.aborted).toBe(false);
    pending[1]!.resolve(response); await settle(); expect(f.root.textContent).toContain("Updated 3 Jan 1970");
  } finally { view.dispose(); }
});
