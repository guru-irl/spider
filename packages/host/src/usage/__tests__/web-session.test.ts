import { expect, it, vi } from "vitest";
import { mountSession } from "../web/session.js";
import { sessionStateCases, mountSessionStates } from "../web/states-session.js";
import { renderSessionRoute } from "../web/session-route.js";
import { DashboardClientError } from "../web/client.js";
import { PlainDocument, PlainElement, descendants, elements, button, settle, cellText } from "./fixtures/plain-dom.js";
import { sessionFixture, envelope, overviewFixture, fixtureStateCases } from "./fixtures/redesign-contract.js";
import type { DashboardPageContext, SessionData } from "../dashboard-v4-contract.js";
class SessionDocument extends PlainDocument {
  override createElement(tag: string): PlainElement { return tag === "strong" ? new PlainElement(this, "STRONG") : super.createElement(tag); }
}
function setup(data: SessionData = sessionFixture(), id = data.id, unit: "credits" | "tokens" = "credits") {
  const doc = new SessionDocument(), get = vi.fn(async (_path: string, _params: URLSearchParams, _signal: AbortSignal) => envelope(data)), back = vi.fn(), navigate = vi.fn();
  const controller = new AbortController();
  const ctx: DashboardPageContext = { document: doc.asDocument(), root: doc.body as unknown as HTMLElement, client: { get: get as never }, route: { page: "session", id, unit, tz: "UTC" }, signal: controller.signal, navigate, back, overview: overviewFixture().range, now: Date.now };
  return { doc, ctx, get, back, navigate, controller };
}
const runNodes = (root: Parameters<typeof descendants>[0]) => descendants(root).filter(n => n.getAttribute("data-run-id") !== null && n.tagName === "g");
function key(node: ReturnType<typeof runNodes>[number], name: string) { const event = new Event("keydown"); Object.assign(event, { key: name }); node.dispatchEvent(event); }
it("Session state examples include every mark, own-only, no-calls and fresh isolated responses", () => {
  const cases = sessionStateCases(fixtureStateCases()); expect(cases.some(c => c.name === "Session run marks")).toBe(true);
  const get = (name: string) => (cases.find(c => c.name === name)!.responses[`/api/session/${sessionFixture().id}`]!.body as { data: SessionData }).data;
  const marks = get("Session run marks"); expect(marks.runs.map(r => r.status)).toEqual(["completed", "cancelled", "failed", "running", null]);
  expect(marks.flow.edges.reduce((sum, e) => sum + e.value.credits!, 0)).toBe(marks.total.credits);
  expect(marks.runs.reduce((sum, r) => sum + r.value.credits!, 0)).toBe(marks.flow.edges.filter(e => e.role === "workers").reduce((sum, e) => sum + e.value.credits!, 0));
  const own = get("Own calls only"); expect(own.runs).toHaveLength(0); expect(own.flow.edges.every(e => e.role === "own")).toBe(true);
  const empty = get("Session without recorded calls"); expect(empty.span).toBeNull(); expect(empty.total.calls).toBe(0);
  get("Session run marks").runs[0]!.name = "Changed fixture";
  const fresh = sessionStateCases(fixtureStateCases()); expect(JSON.stringify(fresh)).not.toContain("Changed fixture");
});
it("mounted Session examples retain page-scoped styling after fixture teardown", async () => {
  const doc = new SessionDocument(); await mountSessionStates(doc.body as unknown as HTMLElement, fixtureStateCases());
  expect(doc.body.textContent).toContain("Own calls only"); expect(doc.body.textContent).toContain("Session without recorded calls");
  const headers = descendants(doc.body).filter(n => n.className === "session-header"); expect(headers.length).toBeGreaterThan(2);
  expect(headers.every(n => n.parentElement!.className.includes("session-page"))).toBe(true);
});
it("header and flow reconcile over the whole lifetime with only tz in the request", async () => {
  const s = setup(), page = mountSession(s.ctx); await page.refresh();
  expect(s.get.mock.calls[0]![0]).toBe(`/api/session/${sessionFixture().id}`);
  expect(String(s.get.mock.calls[0]![1])).toBe("tz=UTC");
  expect(s.doc.body.textContent).toContain("Garden tools"); expect(s.doc.body.textContent).toContain("garden");
  for (const label of ["Total", "Subagent runs", "Own calls", "Compaction", "Idle gaps", "Fri 12 APR 09:00 to Sun 14 APR 10:20 UTC", "Where it went"]) expect(s.doc.body.textContent).toContain(label);
  expect(descendants(s.doc.body).some(n => n.className.includes("pace"))).toBe(false);
  expect(descendants(s.doc.body).find(n => n.getAttribute("data-session-total") !== null)!.textContent).toBe("10");
  button(s.doc.body, "Back").click(); expect(s.back).toHaveBeenCalledOnce(); page.dispose();
});
it("route focus, arrow navigation and Enter pin expose all fields, Escape retains focus", () => {
  const s = setup(), select = vi.fn(), route = renderSessionRoute(s.ctx.document, sessionFixture(), "credits", select); s.doc.body.append(route as never);
  const branches = runNodes(s.doc.body); branches[0]!.focus(); branches[0]!.dispatchEvent(new Event("focus"));
  const card = descendants(s.doc.body).find(n => n.className === "route-card")!;
  expect(card.hidden).toBe(false); for (const word of ["worker", "Build garden tools", "model-maple", "high", "Credits", "Tokens", "Duration", "completed"]) expect(card.textContent).toContain(word);
  key(branches[0]!, "ArrowRight"); expect(s.doc.activeElement).toBe(branches[1]); key(branches[1]!, "Enter"); expect(select).toHaveBeenLastCalledWith("run-review");
  key(branches[1]!, "Escape"); expect(select).toHaveBeenLastCalledWith(null); expect(card.hidden).toBe(true); expect(s.doc.activeElement).toBe(branches[1]);
});
it("route has one roving Tab stop and arrows reach runs and every event type", () => {
  const s = setup(), route = renderSessionRoute(s.ctx.document, sessionFixture(), "credits", () => {}); s.doc.body.append(route as never);
  const stops = () => descendants(route as never).filter(n => n.getAttribute("tabindex") === "0");
  expect(stops()).toHaveLength(1); expect(stops()[0]!.getAttribute("data-run-id")).toBe("run-build");
  const focusables = descendants(route as never).filter(n => n.getAttribute("tabindex") !== null);
  const visited = new Set<string>();
  for (let i = 0; i < focusables.length; i++) {
    const current = stops()[0]!; current.focus(); visited.add(current.getAttribute("data-event") ?? "run");
    key(current, "ArrowRight"); expect(stops()).toHaveLength(1); expect(stops()[0]).toBe(s.doc.activeElement);
  }
  expect([...visited].sort()).toEqual(["break", "compaction", "idle", "own", "run"]);
  expect(stops()[0]!.getAttribute("data-run-id")).toBe("run-build");
  key(stops()[0]!, "End"); expect(s.doc.activeElement).not.toBe(runNodes(s.doc.body)[0]);
  key(stops()[0]!, "Home"); expect(stops()[0]!.getAttribute("data-run-id")).toBe("run-build");
});
it("route skips sub-two-pixel idle glyphs but retains every gap in its table", async () => {
  const d = sessionFixture(); d.span = { start: 0, end: 180 * 86400000 }; d.runs = []; d.compaction = [];
  d.activePeriods = [{ ...d.span }]; d.ownCallBins = [];
  d.idleGaps = Array.from({ length: 10000 }, (_, i) => ({ start: i * 600001, end: (i + 1) * 600001, cacheWriteCredits: 0 }));
  const s = setup(d), page = mountSession(s.ctx); await page.refresh();
  expect(descendants(s.doc.body).filter(n => n.getAttribute("data-event") === "idle")).toHaveLength(0);
  const table = elements(s.doc.body, "table").find(n => n.textContent.includes("Session route data"))!;
  expect(elements(table, "tr").filter(n => n.children[1] && cellText(n.children[1]) === "Idle gap")).toHaveLength(10000); page.dispose();
});
it("status mark grammar does not turn unknown evidence into completion", () => {
  const d = sessionFixture(), run = d.runs[0]!;
  d.runs = ["completed", "cancelled", "failed", "running", null].map((status, i) => ({ ...run, id: `mark-${i}`, status: status as typeof run.status, start: run.start! + i, end: status === "running" ? null : run.end }));
  const s = setup(d), route = renderSessionRoute(s.ctx.document, d, "credits", () => {});
  const marks = descendants(route as never).filter(n => n.getAttribute("data-status-mark") !== null);
  expect(marks.map(n => n.getAttribute("data-status-mark"))).toEqual(["completed", "cancelled", "failed", "running", "unavailable"]);
  expect(marks[0]!.tagName).toBe("circle");
  for (const mark of [marks[1]!, marks[2]!]) { expect(mark.tagName).toBe("path"); expect(mark.getAttribute("d")).toMatch(/l8 8m0-8-8 8/); }
  expect(marks[2]!.getAttribute("class")).toContain("danger");
  expect(marks[3]!.tagName).toBe("path"); expect(marks[3]!.getAttribute("d")).toMatch(/a4 4/);
  expect(marks[4]!.tagName).toBe("path");
  const unknown = runNodes(route as never).find(n => n.getAttribute("data-run-id") === "mark-4")!;
  expect(elements(unknown, "circle").filter(n => n.getAttribute("data-model-marker") === null)).toHaveLength(0);
});
it("idle detail shows actual duration and next call cache writes, with no labels at rest", () => {
  const d = sessionFixture(); d.idleGaps = [{ start: d.span!.start + 60000, end: d.span!.start + 61 * 60000, cacheWriteCredits: 0.5 }]; d.activePeriods = [{ ...d.span! }];
  const s = setup(d), route = renderSessionRoute(s.ctx.document, d, "credits", () => {}); s.doc.body.append(route as never);
  const gap = descendants(s.doc.body).find(n => n.getAttribute("data-event") === "idle")!;
  const card = descendants(s.doc.body).find(n => n.className === "route-card")!;
  expect(card.hidden).toBe(true); gap.focus(); gap.dispatchEvent(new Event("focus")); expect(card.textContent).toContain("1 h"); expect(card.textContent).toContain("0.5"); expect(card.textContent).toContain("Next call cache-write credits");
  expect(descendants(route as never).filter(n => n.tagName === "text").map(n => n.textContent).join(" ")).not.toContain(d.runs[0]!.name);
});
it.each([{ credits: 0.1 + 0.2, display: "0.3" }, { credits: 1234.56, display: "1.2k" }, { credits: 0, display: "0" }, { credits: null, display: "unavailable" }])(
  "idle cache-write credits use the shared credit format ($display)", async ({ credits, display }) => {
    const d = sessionFixture(); d.idleGaps = [{ start: d.span!.start + 60000, end: d.span!.start + 10 * 60000, cacheWriteCredits: credits }];
    const s = setup(d), page = mountSession(s.ctx); await page.refresh();
    const gap = descendants(s.doc.body).find(n => n.getAttribute("data-event") === "idle")!;
    gap.dispatchEvent(new Event("focus"));
    const card = descendants(s.doc.body).find(n => n.className === "route-card")!;
    expect(elements(card, "dd").at(-1)!.textContent).toBe(display);
    const table = elements(s.doc.body, "table").find(n => n.textContent.includes("Session route data"))!;
    const row = elements(table, "tr").find(n => n.children[1] && cellText(n.children[1]) === "Idle gap")!;
    expect(cellText(row.children[5]!)).toBe(`${display}Next call cache-write credits`); page.dispose();
  });
it("idle route rows identify the role and label the next-call credit component in Credits", async () => {
  const s = setup(), page = mountSession(s.ctx); await page.refresh();
  const table = elements(s.doc.body, "table").find(n => n.textContent.includes("Session route data"))!;
  const row = elements(table, "tr").find(n => n.children[1] && cellText(n.children[1]) === "Idle gap")!;
  expect(cellText(row.children[2]!)).toBe("idle gap");
  expect(row.children[5]!.textContent).toContain("Next call cache-write credits");
  expect(row.children[5]!.textContent).toContain("0.1"); page.dispose();
});
it("runs table starts at twenty, sorts, expands and pins the corresponding real row", async () => {
  const d = sessionFixture(); d.runs = Array.from({ length: 24 }, (_, i) => ({ ...d.runs[0]!, id: `run-${i}`, name: `Task ${i}`, start: d.span!.start + i * 1000, value: { ...d.runs[0]!.value, credits: i } }));
  const s = setup(d), page = mountSession(s.ctx); await page.refresh();
  const rows = () => descendants(s.doc.body).filter(n => n.getAttribute("data-run-row") !== null);
  expect(rows()).toHaveLength(20); button(s.doc.body, "Show all 24").click(); expect(rows()).toHaveLength(24);
  descendants(s.doc.body).find(n => n.className === "sort" && n.textContent === "Credits")!.click(); expect(rows()[0]!.getAttribute("data-run-row")).toBe("run-23");
  button(s.doc.body, "Task 23").click(); expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
  for (const column of ["Start", "Name", "Role", "Model", "Thinking", "Credits", "Tokens", "Duration", "Status", "Calls", "Share"]) expect(elements(s.doc.body, "th").some(n => n.textContent === column)).toBe(true);
  page.dispose();
});
it("unit switching updates route and total locally, without refetching lifetime data", async () => {
  const s = setup(), page = mountSession(s.ctx); await page.refresh(); const count = s.get.mock.calls.length;
  button(s.doc.body, "Tokens").click(); expect(s.doc.body.textContent).toContain("Tokens per run");
  expect(s.navigate).toHaveBeenCalledWith({ page: "session", id: sessionFixture().id, unit: "tokens", tz: "UTC" }, { replace: true });
  expect(s.get).toHaveBeenCalledTimes(count); page.dispose();
});
it("Tokens recalculates model and flow shares from raw counts", async () => {
  const s = setup(undefined, sessionFixture().id, "tokens"), page = mountSession(s.ctx); await page.refresh();
  const models = descendants(s.doc.body).find(n => n.className === "session-models-section")!;
  expect(models.textContent).toContain("66.7%"); expect(models.textContent).toContain("33.3%");
  const flow = descendants(s.doc.body).find(n => n.className === "session-flow-section")!;
  expect(flow.textContent).toContain("33.3%"); page.dispose();
});
it("route Chart and Table preserve the identical lifetime total", async () => {
  const s = setup(), page = mountSession(s.ctx); await page.refresh(); button(s.doc.body, "Table").click();
  const routeTable = elements(s.doc.body, "table").find(n => n.textContent.includes("Session route data"))!;
  expect(routeTable.textContent).toContain("Total"); expect(routeTable.textContent).toContain("10");
  expect(routeTable.textContent).toContain("Legacy garden review");
  expect(routeTable.textContent).toContain("Own calls"); expect(routeTable.textContent).toContain("Compaction"); expect(routeTable.textContent).toContain("Idle gap"); page.dispose();
});
it("route pin expands a hidden row rather than losing the selected run", async () => {
  const d = sessionFixture(); d.runs = Array.from({ length: 24 }, (_, i) => ({ ...d.runs[0]!, id: `run-${i}`, name: `Task ${i}`, start: d.span!.start + i * 1000 }));
  const s = setup(d), page = mountSession(s.ctx); await page.refresh();
  const branch = runNodes(s.doc.body).find(n => n.getAttribute("data-run-id") === "run-23")!; key(branch, "Enter");
  const row = descendants(s.doc.body).find(n => n.getAttribute("data-run-row") === "run-23"); expect(row?.getAttribute("aria-selected")).toBe("true"); page.dispose();
});
it("metadata-only run rows pin honestly unavailable detail without inventing a branch", async () => {
  const s = setup(), page = mountSession(s.ctx); await page.refresh(); button(s.doc.body, "Legacy garden review").click();
  const card = descendants(s.doc.body).find(n => n.className === "route-card")!;
  expect(card.hidden).toBe(false); expect(card.textContent).toContain("Legacy garden review"); expect(card.textContent).toContain("unavailable");
  expect(runNodes(s.doc.body).some(n => n.getAttribute("data-run-id") === "run-legacy-review")).toBe(false); page.dispose();
});
it("lifetime refresh retains keyboard focus on the same route run", async () => {
  const s = setup(), page = mountSession(s.ctx); await page.refresh(); const first = runNodes(s.doc.body)[0]!; first.focus(); first.dispatchEvent(new Event("focus"));
  await page.refresh(); expect(s.doc.activeElement?.getAttribute("data-run-id")).toBe("run-build"); page.dispose();
});
it("route time labels reflect the entire lifetime", () => {
  const s = setup(), route = renderSessionRoute(s.ctx.document, sessionFixture(), "credits", () => {}, "UTC");
  const labels = descendants(route as never).filter(n => n.getAttribute("data-time-tick") !== null);
  expect(labels[0]!.textContent).toBe("Fri 12 APR 09:00"); expect(labels.at(-1)!.textContent).toBe("Sun 14 APR 10:20");
});
it("route time ticks reserve measured label extents and both lifetime endpoints", () => {
  const d = sessionFixture(), start = d.span!.start; d.span = { start, end: start + 1094 * 60000 }; d.runs = []; d.idleGaps = [];
  d.activePeriods = Array.from({ length: 1094 }, (_, i) => ({ start: start + i * 60000, end: start + (i + 1) * 60000 }));
  const doc = new SessionDocument(), create = doc.createElementNS.bind(doc);
  doc.createElementNS = (ns, tag) => {
    const node = create(ns, tag);
    if (tag === "text") Object.assign(node, { getComputedTextLength: () => node.textContent.length * 10 });
    return node;
  };
  const route = renderSessionRoute(doc.asDocument(), d, "credits", () => {}, "UTC");
  const labels = descendants(route as never).filter(n => n.getAttribute("data-time-tick") !== null);
  expect(labels[0]!.getAttribute("data-time-tick")).toBe(String(start));
  expect(labels.at(-1)!.getAttribute("data-time-tick")).toBe(String(d.span.end));
  let right = -Infinity;
  for (const label of labels) {
    const x = Number(label.getAttribute("x")), width = label.textContent.length * 10, anchor = label.getAttribute("text-anchor");
    const left = x - (anchor === "end" ? width : anchor === "middle" ? width / 2 : 0);
    expect(left).toBeGreaterThanOrEqual(right + 8); right = left + width;
  }
});
it("latest lifetime refresh wins even if an aborted request resolves afterwards", async () => {
  const s = setup(), pending: { resolve: (v: never) => void; signal: AbortSignal }[] = [];
  s.ctx.client.get = (_p, _q, signal) => new Promise(resolve => pending.push({ resolve, signal }));
  const page = mountSession(s.ctx), latest = page.refresh(); expect(pending[0]!.signal.aborted).toBe(true);
  pending[1]!.resolve(envelope(sessionFixture({ name: "Current session" })) as never); await latest;
  pending[0]!.resolve(envelope(sessionFixture({ name: "Old session" })) as never); await settle();
  expect(s.doc.body.textContent).toContain("Current session"); expect(s.doc.body.textContent).not.toContain("Old session"); page.dispose();
});
it("typed 404 settles with Back only, no retry or spinner", async () => {
  const s = setup(); s.ctx.client.get = async () => { throw new DashboardClientError("not-found"); };
  const page = mountSession(s.ctx); await page.refresh(); expect(s.doc.body.textContent).toBe("BackSession not found");
  expect(s.doc.body.getAttribute("aria-busy")).toBe("false"); expect(elements(s.doc.body, "button")).toHaveLength(1); page.dispose();
});
it.each(["bad/id", "%E0%A4%A", "", "a".repeat(129)])("unsupported id %s makes no request", async id => {
  const s = setup(undefined, id), page = mountSession(s.ctx); await page.refresh(); expect(s.get).not.toHaveBeenCalled(); expect(s.doc.body.textContent).toBe("BackSession not found"); page.dispose();
});
it("own-only session has a baseline and metadata-only session has one no-calls line", async () => {
  const d = sessionFixture({ runs: [], stats: { runs: 0, ownCalls: 2, compaction: 0, idleGaps: 0 } }), s = setup(d), page = mountSession(s.ctx); await page.refresh();
  expect(descendants(s.doc.body).some(n => n.className === "own-baseline")).toBe(true); expect(s.doc.body.textContent).toContain("No subagent runs"); page.dispose();
  const m = setup(sessionFixture({ span: null, runs: [], ownCallBins: [], compaction: [], idleGaps: [], activePeriods: [] })), empty = mountSession(m.ctx); await empty.refresh();
  expect(m.doc.body.textContent).toContain("Garden tools"); expect(m.doc.body.textContent.match(/No calls were recorded/g)).toHaveLength(1); expect(elements(m.doc.body, "svg").filter(n => n.className.includes("session-route"))).toHaveLength(0); empty.dispose();
});
it("recoverable error Retry settles and aborted old responses cannot paint", async () => {
  const s = setup(); let fail = true; s.ctx.client.get = async () => { if (fail) throw new DashboardClientError("internal"); return envelope(sessionFixture()) as never; };
  const page = mountSession(s.ctx); await page.refresh(); fail = false; button(s.doc.body, "Retry").click(); await settle(); expect(s.doc.body.textContent).toContain("Garden tools"); page.dispose();
  const stale = setup(); let resolve!: (value: never) => void; stale.ctx.client.get = () => new Promise(r => { resolve = r; });
  const old = mountSession(stale.ctx); stale.controller.abort(); stale.doc.body.textContent = "New page"; resolve(envelope(sessionFixture()) as never); await settle(); expect(stale.doc.body.textContent).toBe("New page"); old.dispose();
});

it.each(["credits", "tokens"] as const)("header measures use %s and singular counts", async unit => {
  const s = setup(sessionFixture(), undefined, unit), page = mountSession(s.ctx); await page.refresh();
  const stats = descendants(s.doc.body).find(n => n.className === "session-stats")!;
  expect(stats.children[2]!.textContent).toBe(unit === "credits" ? "Own calls2credits" : "Own calls320tokens");
  expect(stats.children[3]!.textContent).toBe(unit === "credits" ? "Compaction2credits · 1 event" : "Compaction160tokens · 1 event");
  expect(stats.children[4]!.textContent).toBe("Idle gaps9min · 1 gap");
  const summary = descendants(s.doc.body).find(n => n.className === "session-route-section")!;
  expect(summary.textContent).toContain(`${unit === "credits" ? "Credits" : "Tokens"} per run0 to ${unit === "credits" ? "3" : "300"}`); page.dispose();
});
it("Session route rounds mirrored ticks upward to nice steps", () => {
  const s = setup(); const route = renderSessionRoute(s.ctx.document, sessionFixture(), "credits", () => {});
  const ticks = descendants(route as never).filter(n => n.tagName === "text" && n.getAttribute("text-anchor") === "end" && n.getAttribute("data-time-tick") === null);
  expect(ticks.map(n => n.textContent)).toEqual(["1", "1", "2", "2", "3", "3", "0"]);
});
