import { afterEach, beforeEach, expect, it } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardQueryContext, DashboardReader } from "../dashboard-contract.js";
import type { RangeQuery, SessionsData, SessionsQuery } from "../dashboard-v4-contract.js";
import type { RunMeta, SessionMeta } from "../ledger.js";
import { OVERVIEW_V4_ROUTES, queryOverviewV4, querySessions } from "../query-overview-v4.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_DAY as D,
  DASHBOARD_MONTH as S, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

let f: DashboardFixture, reader: DashboardReader, ctx: DashboardQueryContext, now: number;
const human = (id: string): SessionMeta => ({ id, ownerSessionId: null, name: "Same display name",
  nameSource: "name", nameOrder: 1, project: "synthetic", firstActivity: S, lastActivity: S + D });
const run = (id: string, sessionId: string): RunMeta => ({ id, sessionId, parentRunId: null,
  dbPath: "synthetic/runs.db", project: null, repo: null, agent: null, role: "worker", name: id,
  model: null, thinking: null, phase: null, startedAt: S, endedAt: S + D, status: "done" });
const call = (id: string, sessionId: string, credits: number, extra: Parameters<typeof dashboardCall>[1] = {}) =>
  dashboardCall(id, { ts: S + D, sessionId, price: { status: "priced", aic: credits,
    components: { input: credits, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "synthetic",
    tier: "base", confidence: "estimated" }, ...extra });
const range = (extra: Partial<RangeQuery> = {}): RangeQuery => ({ range: "custom", from: S,
  to: S + 3 * D, tz: "UTC", unit: "credits", buckets: [], ...extra });
const q = (extra: Partial<SessionsQuery> = {}): SessionsQuery => ({ ...range(), sort: "credits", offset: 0, limit: 10, ...extra });
function refresh() {
  reader?.close(); reader = openDashboardReader(f.file, { instanceId: "synthetic", serverBuild: "fixture",
    now: () => now, calibrationMode: () => "off" })!;
  ctx = reader.snapshot(c => c);
}
function route(params = ""): SessionsData {
  return OVERVIEW_V4_ROUTES.find(r => r.path === "/api/sessions")!.handle(ctx, new URLSearchParams(params)) as SessionsData;
}
function seedTies() {
  const sessions = Array.from({ length: 13 }, (_, i) => human(`session-${String(12 - i).padStart(2, "0")}`));
  f.ledger.apply(dashboardBatch(sessions.map((s, i) => call(`call-${i}`, s.id, 2,
    { usage: { input: i * 100, cacheRead: 0, cacheWrite: 0, output: 0 } })), { sessions })); refresh();
}
beforeEach(() => { now = S + 3 * D; f = createDashboardFixture(false); refresh(); });
afterEach(() => { reader.close(); f.close(); });

it("Show all pages match Overview with stable id ties and credit ranking in Tokens mode", () => {
  seedTies();
  const overview = queryOverviewV4(ctx, range()), first = querySessions(ctx, q()), second = querySessions(ctx, q({ offset: 10 }));
  expect(first.rows).toEqual(overview.sessions.rows);
  expect(first).toMatchObject({ total: 13, offset: 0, limit: 10, nextOffset: 10 });
  expect(second).toMatchObject({ total: 13, offset: 10, limit: 10, nextOffset: null });
  expect([...first.rows, ...second.rows].map(r => r.id)).toEqual(Array.from({ length: 13 }, (_, i) => `session-${String(i).padStart(2, "0")}`));
  expect(new Set([...first.rows, ...second.rows].map(r => r.id)).size).toBe(13);
  expect(querySessions(ctx, q({ unit: "tokens" })).rows.map(r => r.id)).toEqual(first.rows.map(r => r.id));
  expect(queryOverviewV4(ctx, range({ unit: "tokens" })).sessions.rows.map(r => r.id)).toEqual(first.rows.map(r => r.id));
  expect(first.summary.top3Share).toBeCloseTo(3 / 13, 10);
  expect(second.summary).toEqual(first.summary);
});

it.each(["credits", "last-active", "runs"] as const)("pages cross-bucket ties by session id for %s", sort => {
  now = S + 14 * D;
  const sessions = Array.from({ length: 13 }, (_, i) => human(`session-${String(i).padStart(2, "0")}`));
  f.ledger.apply(dashboardBatch(sessions.flatMap((s, i) => [
    call(`early-${i}`, s.id, 2, { ts: S + (12 - i) * D }),
    call(`late-${i}`, s.id, 0, { ts: S + 13 * D }),
  ]), { sessions })); refresh();
  const first = querySessions(ctx, q({ to: now, sort }));
  const second = querySessions(ctx, q({ to: now, sort, offset: 10 }));
  expect(first.rows.map(row => row.id)).toEqual([
    "session-00", "session-01", "session-02", "session-03", "session-04",
    "session-05", "session-06", "session-07", "session-08", "session-09",
  ]);
  expect(second.rows.map(row => row.id)).toEqual(["session-10", "session-11", "session-12"]);
  expect(first.nextOffset).toBe(10);
  expect(second.nextOffset).toBeNull();
});

it("This month Sessions uses the counter reset month just like Overview", () => {
  now = S + 15 * D;
  f.ledger.insertCounter({ ts: now, creditsUsed: 50, accountLogin: "synthetic-account",
    resetDate: "2026-11-14", raw: {} });
  f.ledger.apply(dashboardBatch([
    call("before-reset", "old-session", 20, { ts: S + D }),
    call("at-reset", "session-a", 2, { ts: S + 13 * D }),
    call("after-reset", "session-b", 3, { ts: now - 1 }),
  ], { sessions: [human("old-session"), human("session-a"), human("session-b")] })); refresh();
  const overview = queryOverviewV4(ctx, range({ range: "month" }));
  const all = route("range=month");
  expect(overview.range).toMatchObject({ from: S + 13 * D, to: now });
  expect(all).toEqual(overview.sessions);
  expect(all.total).toBe(2);
  expect(all.rows.map(row => [row.id, row.value.credits])).toEqual([["session-b", 3], ["session-a", 2]]);
  expect(all.rows.reduce((n, row) => n + (row.value.credits ?? 0), 0)).toBe(5);
  expect(route("range=month&limit=1&offset=1").rows.map(row => row.id)).toEqual(["session-a"]);
});

it("includes the Unattributed row in the matching row count and pagination", () => {
  f.ledger.apply(dashboardBatch([
    call("own", "session-a", 1),
    call("unresolved", "missing-child", 2, { actor: "subagent", runId: "missing-run" }),
  ], { sessions: [human("session-a")] })); refresh();
  const first = querySessions(ctx, q({ limit: 1 }));
  expect(first).toMatchObject({ total: 2, nextOffset: 1 });
  expect(first.rows[0]!.id).toBe("unattributed-runs");
  expect(querySessions(ctx, q({ limit: 1, offset: 1 }))).toMatchObject({
    total: 2, nextOffset: null, rows: [{ id: "session-a" }],
  });
});

it("top-three share and run count use every matching session rather than the current page", () => {
  f.ledger.apply(dashboardBatch([
    call("a", "session-a", 8), call("b", "session-b", 6), call("c", "session-c", 4), call("d", "session-d", 2),
    call("run-a-early", "child", 0, { ts: S + 1, actor: "subagent", runId: "run-a", role: "worker" }),
    call("run-a-late", "child", 0, { ts: S + D, actor: "subagent", runId: "run-a", role: "worker" }),
    call("run-b", "child", 0, { actor: "subagent", runId: "run-b", role: "worker" }),
  ], { sessions: [human("session-a"), human("session-b"), human("session-c"), human("session-d")], runs: [run("run-a", "session-a"), run("run-b", "session-d")] })); refresh();
  const first = querySessions(ctx, q({ limit: 1 })), second = querySessions(ctx, q({ limit: 1, offset: 1 }));
  expect(first.summary).toEqual({ runs: 2, top3Share: 0.9 });
  expect(second.summary).toEqual(first.summary);
  expect(first.rows[0]!.id).toBe("session-a");
  const selected = querySessions(ctx, q({ buckets: [S] }));
  expect(selected.summary.runs).toBe(1);
  expect(selected.total).toBe(1);
});

it("sorts last activity and run count descending with stable id ties", () => {
  f.ledger.apply(dashboardBatch([
    call("a", "session-a", 5, { ts: S + 100 }), call("b", "session-b", 10, { ts: S + 200 }), call("c", "session-c", 2, { ts: S + 200 }),
    call("run-a", "child", 0, { ts: S + 100, actor: "subagent", runId: "run-a" }),
    call("run-b", "child", 0, { ts: S + 200, actor: "subagent", runId: "run-b" }),
    call("run-c", "child", 0, { ts: S + 200, actor: "subagent", runId: "run-c" }),
  ], { sessions: [human("session-c"), human("session-b"), human("session-a")],
    runs: [run("run-a", "session-a"), run("run-b", "session-c"), run("run-c", "session-c")] })); refresh();
  expect(querySessions(ctx, q({ sort: "credits" })).rows.map(r => r.id)).toEqual(["session-b", "session-a", "session-c"]);
  expect(querySessions(ctx, q({ sort: "last-active" })).rows.map(r => r.id)).toEqual(["session-b", "session-c", "session-a"]);
  expect(querySessions(ctx, q({ sort: "runs" })).rows.map(r => r.id)).toEqual(["session-c", "session-a", "session-b"]);
});

it("custom paging preserves the resolved Overview bounds unit and noncontiguous selection", () => {
  now = S + 7 * D + 12 * 3_600_000;
  seedTies();
  const overview = queryOverviewV4(ctx, range({ range: "7d", unit: "tokens", buckets: [S + D, S + 3 * D] }));
  expect(overview.range).toMatchObject({ from: now - 7 * D, to: now, unit: "tokens", buckets: [S + D, S + 3 * D] });
  now += D; refresh();
  const params = new URLSearchParams({ range: "custom", from: String(overview.range.from), to: String(overview.range.to),
    tz: overview.range.tz, unit: overview.range.unit, buckets: JSON.stringify(overview.range.buckets) });
  const first = route(params.toString()); params.set("offset", "10");
  const second = route(params.toString());
  expect(first.rows).toEqual(overview.sessions.rows);
  expect(first.total).toBe(13);
  expect(second.rows.map(r => r.id)).toEqual(["session-10", "session-11", "session-12"]);
});

it("refreshing a rolling preset recomputes pages instead of merging old revisions", () => {
  now = S + 2 * D;
  f.ledger.apply(dashboardBatch([call("old", "session-old", 5, { ts: now - D }), call("keep", "session-keep", 1, { ts: now - 1 })],
    { sessions: [human("session-old"), human("session-keep")] })); refresh();
  expect(route("range=24h&limit=1").rows[0]!.id).toBe("session-old");
  const revision = ctx.revision;
  f.ledger.apply(dashboardBatch([call("new", "session-new", 10, { ts: now })], { sessions: [human("session-new")] }));
  now += 1; refresh();
  expect(ctx.revision).not.toBe(revision);
  expect(route("range=24h&limit=1").rows[0]!.id).toBe("session-new");
  expect(route("range=24h&limit=1&offset=1").rows[0]!.id).toBe("session-keep");
});

it("Sessions defaults to ten rows and accepts optional unit and JSON buckets", () => {
  expect(route()).toMatchObject({ total: 0, offset: 0, limit: 10, nextOffset: null });
  expect(route("unit=tokens&buckets=[]&limit=200&offset=0")).toMatchObject({ limit: 200 });
  seedTies();
  expect(route(`range=custom&from=${S}&to=${S + 3 * D}&unit=tokens&buckets=[${S + D}]`).total).toBe(13);
  expect(querySessions(ctx, q({ offset: 100 }))).toMatchObject({ rows: [], total: 13, nextOffset: null });
});

it.each([
  "sort=bad", "offset=-1", "offset=1.5", "offset=1e2", "offset=9007199254740992", "offset=",
  "limit=0", "limit=201", "limit=1.5", "limit=", "limit=10&limit=20", "offset=0&offset=1",
  "range=custom&from=1", "range=custom&to=2", "range=7d&range=7d", "unit=bad", "unit=tokens&unit=credits",
  "buckets=1,2", "buckets={}", "buckets=[1.5]", "buckets=[1]", `buckets=[${S},${S}]`, "buckets=[]&buckets=[]", "filters=[]", "cursor=old",
])("rejects malformed or unknown Sessions parameters: %s", params => {
  expect(() => route(params)).toThrow("invalid-query");
});

it("rejects invalid typed pagination and bucket inputs before reading calls", () => {
  for (const extra of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 201 }, { sort: "bad" }, { buckets: [S, S] }, { buckets: [S + 1] }])
    expect(() => querySessions(ctx, q(extra as Partial<SessionsQuery>))).toThrow("invalid-query");
});

it("exports only the two exact Overview and Sessions route definitions", () => {
  expect(OVERVIEW_V4_ROUTES.map(r => r.path)).toEqual(["/api/overview", "/api/sessions"]);
  expect(route("range=24h&from=ignored&to=ignored")).toMatchObject({ limit: 10 });
});
