import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryOverview } from "../query-overview.js";
import { readMeasure } from "../dashboard-selection.js";
import type { DashboardReader } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH, DASHBOARD_NOW, DASHBOARD_DAY } from "./fixtures/dashboard-ledger.js";

let fixture: ReturnType<typeof createDashboardFixture>;
let reader: DashboardReader;
beforeEach(() => {
  fixture = createDashboardFixture();
  reader = openDashboardReader(fixture.file, { instanceId: "fixture-instance", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture-build" })!;
});
afterEach(() => { reader.close(); fixture.close(); });
const slice = () => ({ start: DASHBOARD_MONTH, end: DASHBOARD_NOW, filters: [] });

it("matches Phase 1 period selection", () => {
  fixture.ledger.apply(dashboardBatch([], { pendingReports: [{ path: "synthetic/pending.jsonl", runId: "pending-run", generation: 0, firstSeen: DASHBOARD_NOW, calls: [] }] }));
  for (const period of [slice(), { start: DASHBOARD_MONTH + 2 * DASHBOARD_DAY, end: DASHBOARD_NOW, filters: [] }]) {
    const phase1 = fixture.ledger.summarize(period.start, period.end);
    reader.snapshot(ctx => {
      const measure = readMeasure(ctx, period);
      expect(measure.aic ?? 0).toBe(phase1.aic);
      expect(measure.pricedCalls).toBe(phase1.pricedCalls);
      expect(measure.unpricedCalls).toBe(phase1.unpricedCalls);
      expect(measure.possibleOverlap).toBe(Boolean(phase1.possibleOverlap));
      expect(measure.possibleUndercount).toBe(phase1.possibleUndercount);
      expect(measure.estimated).toBe(phase1.estimated);
      expect(measure.pendingData).toBe(true);
    });
  }
  reader.snapshot(ctx => {
    expect(readMeasure(ctx, { ...slice(), filters: [{ field: "session", value: "fork-session" }] }).calls).toBe(0);
    expect(readMeasure(ctx, slice(), { runId: "covered-run" }).calls).toBe(0);
    const spy = vi.spyOn(ctx.db, "prepare");
    expect(readMeasure(ctx, slice(), { sessionId: "parent-session" }).aic).toBe(4);
    expect(spy.mock.calls.find(([sql]) => sql.includes("calls_session_read"))?.[0]).toContain("INDEXED BY calls_session_read");
    spy.mockRestore();
  });
  // Later native evidence suppresses a report globally even when the evidence is outside this slice.
  fixture.ledger.apply(dashboardBatch([dashboardCall("late-native", { actor: "subagent", runId: "report-run", ts: DASHBOARD_NOW + 1 })]));
  expect(reader.snapshot(ctx => readMeasure(ctx, slice()).aggregateCalls)).toBe(0);
  expect(reader.snapshot(ctx => readMeasure(ctx, slice()).aic)).toBe(fixture.ledger.summarize(DASHBOARD_MONTH, DASHBOARD_NOW).aic);
});

it("Overview materializes its slice once", async () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 12 }, (_, index) => dashboardCall(`role-${index}`, {
    actor: "subagent", role: `role-${index}`, price: { status: "priced", aic: index + 1,
      components: { input: index + 1, output: 0, cacheRead: 0, cacheWrite: 0 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" },
  }))));
  const api = await import("../query-overview.js").catch(() => null);
  expect(api, "Overview API must exist").not.toBeNull();
  reader.snapshot(ctx => {
    const spy = vi.spyOn(ctx.db, "prepare");
    const result = api!.queryOverview(ctx, slice());
    const queries = spy.mock.calls.map(([sql]) => sql);
    spy.mockRestore();
    expect(queries.filter(sql => sql.includes("calls_period_read"))).toHaveLength(1);
    expect(queries[0]!.match(/window AS MATERIALIZED/g)).toHaveLength(1);
    expect(queries[0]).toContain("counted AS MATERIALIZED");
    expect(queries[0]).toContain("UNION ALL");
    expect(result.totals.aic).toBe(82);
    expect(result.totals.calls).toBe(17);
    expect(result.actors.map(row => row.label)).toEqual(["parent", "subagent", "aux", "compaction", "warmer"]);
    expect(result.actors.every(row => row.isOther === false)).toBe(true);
    expect(result.daily.rows.every(day => day.actors.every(row => row.isOther === false))).toBe(true);
    expect(result.roles).toHaveLength(9);
    expect(result.roles.map(row => row.label)).toEqual(["role-11", "role-10", "role-9", "role-8", "role-7", "role-6", "role-5", "role-4", "Other"]);
    expect(result.roles.map(row => row.isOther)).toEqual([false, false, false, false, false, false, false, false, true]);
    expect(result.calibration.status).toBe("uncalibrated");
    expect(JSON.stringify(result).match(/"calibration":/g)).toHaveLength(1);
    for (const breakdown of [result.actors, result.roles]) {
      expect(breakdown.reduce((sum, row) => sum + (row.measure.aic ?? 0), 0)).toBe(result.totals.aic);
      expect(breakdown.reduce((sum, row) => sum + row.measure.tokens.total, 0)).toBe(result.totals.tokens.total);
      expect(breakdown.reduce((sum, row) => sum + row.measure.unpricedCalls, 0)).toBe(1);
      expect(breakdown.every(row => row.measure.aicDisplay.basis === "published")).toBe(true);
    }
    // Capture the actual executed SQL and inspect range access without ANALYZE.
    const plans = queries.filter(sql => sql.includes("calls_period_read")).flatMap(sql =>
      ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...[DASHBOARD_MONTH, DASHBOARD_NOW, DASHBOARD_MONTH, DASHBOARD_NOW]));
    const details = plans.map(row => (row as { detail: string }).detail);
    expect(details.join("\n")).toContain("SEARCH c USING INDEX calls_period_read (ts>? AND ts<?)");
  });
});

it("month comparison ends at counter timestamp", async () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("account-month", { ts: DASHBOARD_NOW - 1000, project: "other-project", price: { status: "priced", aic: 8,
      components: { input: 8, output: 0, cacheRead: 0, cacheWrite: 0 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" } }),
    dashboardCall("after-counter", { ts: DASHBOARD_NOW - 1 }),
  ]));
  const counterTs = DASHBOARD_NOW - 100;
  fixture.ledger.insertCounter({ ts: counterTs, creditsUsed: 10, entitlement: 100, remaining: 90, resetDate: "2026-11-01", accountLogin: "synthetic-account", raw: { private: "synthetic-only" } });
  fixture.db.prepare("INSERT INTO leases(name,next_due_at) VALUES ('counter',?)").run(DASHBOARD_NOW + 600000);
  const { queryOverview } = await import("../query-overview.js");
  const ctx = reader.snapshot(ctx => ctx);
  {
    const spy = vi.spyOn(ctx.db, "prepare");
    const result = queryOverview(ctx, { ...slice(), filters: [{ field: "project", value: "fixture-project" }] });
    const queries = spy.mock.calls.map(([sql]) => sql);
    spy.mockRestore();
    const args = [[DASHBOARD_MONTH, DASHBOARD_NOW, "fixture-project", DASHBOARD_MONTH, DASHBOARD_NOW], [], [DASHBOARD_MONTH, counterTs]];
    const comparisonQueries = queries.filter(sql => !sql.includes("WITH cap AS MATERIALIZED") && !sql.includes("call-selection-revision") && !sql.includes("SELECT COALESCE(MAX(rowid)") && !sql.includes("FROM counter_snapshots INDEXED"));
    const plans = comparisonQueries.map((sql, index) => ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args[index]!));
    expect(comparisonQueries).toHaveLength(3);
    // One endpoint batch; earliest discovery no longer evaluates candidate batches.
    expect(queries.filter(sql => sql.includes("WITH cap AS MATERIALIZED"))).toHaveLength(1);
    expect(plans).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024);
    expect(result.comparison).toMatchObject({ start: DASHBOARD_MONTH, end: counterTs, counterAic: 10, gap: -2, ratio: 1.2 });
    expect(result.comparison.computed!.aic).toBe(12);
    expect(result.totals.aic).toBe(5);
    expect(result.pace.counterAic).toBeGreaterThan(10);
    expect(result.pace.projected!.aicDisplay.publishedAic).toBeCloseTo(10);
    expect(result.pace.projected!.aicDisplay.primaryAic).toBeCloseTo(10);
    expect(result.pace.projected!.tokens.total).toBeGreaterThan(result.totals.tokens.total);
    expect(JSON.stringify(result)).not.toMatch(/account|synthetic-only|private/);
    const previous = queryOverview(ctx, { start: Date.UTC(2026, 8, 1), end: DASHBOARD_MONTH, filters: [] });
    expect(previous.comparison.counterAic).toBeNull();
    expect(previous.comparison.computed).toBeNull();
    expect(previous.pace.counterAic).toBeNull();
    expect(previous.pace.projected).toBeNull();
    expect(previous.counterObservation.ts).toBe(counterTs);
  }
  fixture.db.prepare("DELETE FROM counter_snapshots").run();
  fixture.ledger.insertCounter({ ts: counterTs, creditsUsed: 0, raw: {} });
  expect(reader.snapshot(ctx => queryOverview(ctx, slice()).comparison.ratio)).toBeNull();
  fixture.db.prepare("DELETE FROM counter_snapshots").run();
  fixture.ledger.insertCounter({ ts: DASHBOARD_NOW - 2000000, creditsUsed: 10, raw: {} });
  expect(reader.snapshot(ctx => queryOverview(ctx, slice()).comparison.counterAic)).toBeNull();
});

it("status separates ingest and counter freshness", () => {
  let now = DASHBOARD_NOW;
  let role: "owner" | "follower" | "standby" | "inactive" = "owner";
  reader.close();
  reader = openDashboardReader(fixture.file, { instanceId: "fixture-instance", now: () => now, calibrationMode: () => "auto", serverBuild: "fixture-build",
    ingestStatus: () => ({ role, lastIngestAt: DASHBOARD_NOW, backfill: "complete", errorCode: null }) })!;
  fixture.ledger.insertCounter({ ts: DASHBOARD_NOW - 600000, creditsUsed: 10, raw: {} });
  fixture.db.prepare("INSERT INTO leases(name,next_due_at) VALUES ('counter',?)").run(DASHBOARD_NOW + 600000);
  for (const next of ["owner", "follower", "standby", "inactive"] as const) {
    role = next;
    const status = reader.status();
    expect(status.ingest.role).toBe(next);
    expect(status.ingest.stale).toBe(false);
    expect(status.counter.availability).toBe("available");
    expect(status.calls).toBe(8);
    expect(status.sources).toBe(1);
    expect(status.serverBuild).toBe("fixture-build");
    expect(Object.keys(status).sort()).toEqual(["serverBuild", "schemaVersion", "rateVersions", "calls", "sources", "parseErrors", "sourceErrors", "ingest", "counter"].sort());
  }
  now += 120000;
  expect(reader.status().ingest.stale).toBe(false);
  now += 1;
  expect(reader.status().ingest.stale).toBe(true);
  expect(reader.status().counter.availability).toBe("available");
  now = DASHBOARD_NOW + 1320001;
  expect(reader.status().counter.availability).toBe("stale");
  expect(reader.status().counter.creditsUsed).toBe(10);
  fixture.db.prepare("DELETE FROM counter_snapshots").run();
  expect(reader.status().counter.availability).toBe("unavailable");
  reader.snapshot(ctx => {
    const spy = vi.spyOn(ctx.db, "prepare");
    ctx.status();
    const sql = spy.mock.calls.map(([query]) => query);
    spy.mockRestore();
    expect(sql.length).toBeLessThanOrEqual(4);
    expect(sql.join("\n")).not.toMatch(/FROM calls|counted_calls|usage_possible_overlaps/);
  });
});

it("daily chart windows preserve aggregate totals", async () => {
  const start = DASHBOARD_MONTH - 70 * DASHBOARD_DAY + 3600000;
  const end = DASHBOARD_MONTH - 1;
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 70 }, (_, index) => dashboardCall(`daily-${index}`, {
    ts: start + index * DASHBOARD_DAY, actor: index % 2 ? "compaction" : "parent", role: index % 3 ? "worker" : "reviewer",
  }))));
  const { queryOverview, OVERVIEW_ROUTES } = await import("../query-overview.js");
  const period = { start, end, filters: [] };
  const first = reader.snapshot(ctx => queryOverview(ctx, period));
  expect(first.daily.rows).toHaveLength(31);
  expect(first.daily.nextCursor).not.toBeNull();
  expect(first.daily.rows[0]!.start).toBe(start);
  const route = OVERVIEW_ROUTES.find(item => item.path === "/api/overview")!;
  const pages = [first];
  while (pages.at(-1)!.daily.nextCursor) {
    const cursor = pages.at(-1)!.daily.nextCursor!;
    pages.push(reader.snapshot(ctx => route.handle(ctx, new URLSearchParams({ start: String(start), end: String(end), cursor }))) as typeof first);
  }
  const days = pages.flatMap(page => page.daily.rows);
  expect(days.length).toBeLessThanOrEqual(71);
  expect(days.at(-1)!.end).toBe(end);
  expect(days.reduce((sum, point) => sum + (point.measure.aicDisplay.publishedAic ?? 0), 0)).toBe(first.totals.aic);
  expect(days.reduce((sum, point) => sum + point.measure.tokens.total, 0)).toBe(first.totals.tokens.total);
  expect(days.every(point => point.actors.reduce((sum, row) => sum + row.measure.tokens.total, 0) === point.measure.tokens.total)).toBe(true);
  expect(days.every(point => point.roles.reduce((sum, row) => sum + row.measure.tokens.total, 0) === point.measure.tokens.total)).toBe(true);
  reader.snapshot(ctx => {
    expect(() => route.handle(ctx, new URLSearchParams({ start: String(start + 1), end: String(end), cursor: first.daily.nextCursor! }))).toThrow("invalid-query");
    expect(() => route.handle({ ...ctx, revision: "changed" }, new URLSearchParams({ start: String(start), end: String(end), cursor: first.daily.nextCursor! }))).toThrow("ledger-changed");
    expect(() => queryOverview(ctx, period, NaN)).toThrow("invalid-query");
    expect(() => queryOverview(ctx, period, start - 1)).toThrow("invalid-query");
    expect(OVERVIEW_ROUTES.map(item => item.path)).toEqual(["/api/status", "/api/overview", "/api/context", "/api/source-errors"]);
    const context = OVERVIEW_ROUTES.find(item => item.path === "/api/context")!.handle(ctx, new URLSearchParams()) as import("../dashboard-contract.js").ContextData;
    expect(context.contextFillPercent).toBeNull();
    expect(context.contextFillMessage).toBe("Context fill unavailable: historical window not recorded");
    expect(context.composition).toEqual(context.carry);
    expect(context.carry).toEqual(context.itemReuse);
    expect(Object.keys(context).sort()).toEqual(["contextFillPercent", "contextFillMessage", "composition", "carry", "itemReuse"].sort());
    for (const path of ["/api/status", "/api/source-errors", "/api/overview", "/api/context"]) {
      const api = OVERVIEW_ROUTES.find(item => item.path === path)!;
      expect(() => api.handle(ctx, new URLSearchParams("unknown=1"))).toThrow("invalid-query");
      expect(() => api.handle(ctx, new URLSearchParams("limit=50&limit=50"))).toThrow("invalid-query");
    }
  });
});

it("Overview labels are bounded without losing measures", async () => {
  const role = "role-" + "😀".repeat(200);
  fixture.ledger.apply(dashboardBatch([dashboardCall("long-role", { role })]));
  const { queryOverview } = await import("../query-overview.js");
  const result = reader.snapshot(ctx => queryOverview(ctx, slice()));
  expect(result.roles.every(row => row.label === null || [...row.label].length <= 160)).toBe(true);
  expect(result.daily.rows.every(day => day.roles.every(row => row.label === null || [...row.label].length <= 160))).toBe(true);
  expect(result.roles.reduce((sum, row) => sum + (row.measure.aic ?? 0), 0)).toBe(5);
});

it("absent participant timestamp does not inherit published freshness", () => {
  reader.close();
  reader = openDashboardReader(fixture.file, { instanceId: "fixture-instance", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture-build",
    ingestStatus: () => ({ role: "standby", lastIngestAt: null, backfill: "pending", errorCode: "synthetic/path/must-not-leak" }) })!;
  const status = reader.status();
  expect(status.ingest.lastIngestAt).toBeNull();
  expect(status.ingest.ageMs).toBeNull();
  expect(status.ingest.stale).toBe(true);
  expect(status.ingest.errorCode).toBe("usage-ingest-failed");
});

it("historical comparison retains the requested period", async () => {
  const { queryOverview } = await import("../query-overview.js");
  const period = { start: Date.UTC(2026, 7, 1), end: Date.UTC(2026, 8, 1), filters: [] };
  const result = reader.snapshot(ctx => queryOverview(ctx, period));
  expect(result.comparison).toMatchObject({ start: period.start, end: period.end, computed: null, counterAic: null });
});

// These absolute counts catch exclusive-start/inclusive-end and ignored day predicates.
it("half-open slices count start and exclude end", async () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("boundary-start", { ts: DASHBOARD_MONTH }),
    dashboardCall("boundary-last", { ts: DASHBOARD_MONTH + DASHBOARD_DAY - 1 }),
    dashboardCall("boundary-end", { ts: DASHBOARD_MONTH + DASHBOARD_DAY }),
  ]));
  const period = { start: DASHBOARD_MONTH, end: DASHBOARD_MONTH + DASHBOARD_DAY, filters: [] };
  const { queryOverview } = await import("../query-overview.js");
  reader.snapshot(ctx => {
    expect(readMeasure(ctx, period)).toMatchObject({ calls: 2, aic: 2 });
    expect(queryOverview(ctx, period).totals).toMatchObject({ calls: 2, aic: 2 });
  });
});

it("day filters run against midnight data", async () => {
  const day = DASHBOARD_MONTH + 3 * DASHBOARD_DAY;
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("before-day", { ts: day - 1 }),
    dashboardCall("day-start", { ts: day }),
    dashboardCall("day-last", { ts: day + DASHBOARD_DAY - 1 }),
    dashboardCall("next-day", { ts: day + DASHBOARD_DAY }),
  ]));
  const { queryOverview } = await import("../query-overview.js");
  const period = { ...slice(), filters: [{ field: "day" as const, value: "2026-10-04" }] };
  reader.snapshot(ctx => {
    expect(readMeasure(ctx, period)).toMatchObject({ calls: 2, aic: 2 });
    const result = queryOverview(ctx, period);
    expect(result.totals).toMatchObject({ calls: 2, aic: 2 });
    expect(result.daily.rows.find(row => row.label === "2026-10-04")!.measure.calls).toBe(2);
  });
});

it("per-call uncertainty survives without pending reports", async () => {
  const { queryOverview } = await import("../query-overview.js");
  fixture.ledger.apply(dashboardBatch([dashboardCall("unfinished", { runId: "unfinished-run" })], {
    runs: [{ id: "unfinished-run", dbPath: "synthetic/runs.db", project: null, repo: null, sessionId: null,
      parentRunId: null, agent: null, role: null, name: null, model: null, thinking: null, phase: null,
      startedAt: DASHBOARD_MONTH, endedAt: null }],
  }));
  reader.snapshot(ctx => {
    for (const run of ["unfinished-run", "report-run"]) {
      const period = { ...slice(), filters: [{ field: "run" as const, value: run }] };
      expect(readMeasure(ctx, period)).toMatchObject({ calls: 1, possibleUndercount: true, pendingData: false, estimated: true });
      expect(queryOverview(ctx, period).totals).toMatchObject({ calls: 1, possibleUndercount: true, pendingData: false });
    }
  });
});

it("incomplete imports signal pending and per-call undercount", async () => {
  const sourceFile = "synthetic/incomplete.jsonl";
  fixture.ledger.apply(dashboardBatch([dashboardCall("incomplete", { sourceFile, sessionId: "incomplete-session" })], {
    states: [{ path: sourceFile, inode: "fixture-inode", size: 100, offset: 50, mtimeMs: DASHBOARD_NOW,
      parseErrors: 0, generation: 0, prefixHash: "fixture-hash" }],
  }));
  const { queryOverview } = await import("../query-overview.js");
  reader.snapshot(ctx => {
    const period = { ...slice(), filters: [{ field: "session" as const, value: "incomplete-session" }] };
    expect(readMeasure(ctx, period)).toMatchObject({ calls: 1, possibleUndercount: true, pendingData: true });
    const result = queryOverview(ctx, period);
    expect(result.totals).toMatchObject({ calls: 1, possibleUndercount: true, pendingData: true });
    expect(result.actors.find(row => row.label === "parent")!.measure.possibleUndercount).toBe(true);
  });
});

it("Context route performs zero SELECTs", async () => {
  const { OVERVIEW_ROUTES } = await import("../query-overview.js");
  reader.snapshot(ctx => {
    const prepare = vi.spyOn(ctx.db, "prepare");
    try {
      const result = OVERVIEW_ROUTES.find(route => route.path === "/api/context")!.handle(ctx, new URLSearchParams());
      expect(prepare).not.toHaveBeenCalled();
      expect(result).toEqual({ contextFillPercent: null,
        contextFillMessage: "Context fill unavailable: historical window not recorded",
        composition: { status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" },
        carry: { status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" },
        itemReuse: { status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" } });
    } finally { prepare.mockRestore(); }
  });
});

it("current month comparison rejects pre-month counter anchors", async () => {
  reader.close();
  reader = openDashboardReader(fixture.file, { instanceId: "fixture", now: () => DASHBOARD_MONTH + 1000, calibrationMode: () => "auto", serverBuild: "fixture" })!;
  fixture.ledger.insertCounter({ ts: DASHBOARD_MONTH - 1, creditsUsed: 10, raw: {} });
  const { queryOverview } = await import("../query-overview.js");
  const result = reader.snapshot(ctx => queryOverview(ctx, { start: DASHBOARD_MONTH, end: DASHBOARD_MONTH + 1000, filters: [] }));
  expect(result.counterObservation.availability).toBe("available");
  expect(result.comparison.computed).toBeNull();
  expect(result.comparison.counterAic).toBeNull();
  expect(result.pace.counterAic).toBeNull();
});

it("current month comparison permits sixty seconds of client skew", async () => {
  fixture.ledger.insertCounter({ ts: DASHBOARD_NOW - 100000, creditsUsed: 10, raw: {} });
  const { queryOverview } = await import("../query-overview.js");
  reader.snapshot(ctx => {
    for (const skew of [0, 59999, 60000, -1000]) {
      const result = queryOverview(ctx, { ...slice(), end: DASHBOARD_NOW - skew });
      expect(result.comparison.counterAic).toBe(10);
      expect(result.comparison.computed!.aic).toBe(4);
      expect(result.pace.projected).not.toBeNull();
    }
    const expired = queryOverview(ctx, { ...slice(), end: DASHBOARD_NOW - 60001 });
    expect(expired.comparison.computed).toBeNull();
    expect(expired.comparison.counterAic).toBeNull();
    expect(expired.pace.projected).toBeNull();
    expect(queryOverview(ctx, { ...slice(), start: DASHBOARD_MONTH + 1 }).comparison.computed).toBeNull();
  });
});

it("Other role and Other bucket have distinct flags", async () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 10 }, (_, i) => dashboardCall(`other-${i}`, {
    role: i === 9 ? "Other" : `other-role-${i}`,
    price: { status: "priced", aic: i + 1, components: { input: i + 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" },
  }))));
  const { queryOverview } = await import("../query-overview.js");
  const result = reader.snapshot(ctx => queryOverview(ctx, slice()));
  expect(result.roles.filter(row => row.label === "Other").map(row => row.isOther)).toEqual([false, true]);
  expect(result.daily.rows.find(row => row.measure.calls > 0)!.roles.filter(row => row.label === "Other").map(row => row.isOther)).toEqual([false, true]);
});

const priced = (aic: number) => ({ status: "priced" as const, aic, components: { input: aic, output: 0, cacheRead: 0, cacheWrite: 0 },
  rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" as const });

it("independent power-of-two accounting hand totals", () => {
  const M = DASHBOARD_MONTH, D = DASHBOARD_DAY;
  const fixture = createDashboardFixture(false);
  const run = (id: string, endedAt: number | null) => ({ id, dbPath: "synthetic/runs.db", project: null, repo: null, sessionId: null,
    parentRunId: null, agent: null, role: null, name: null, model: null, thinking: null, phase: null, startedAt: M, endedAt });
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("a", { ts: M + 1 * D, responseId: "r1", price: priced(1) }),
    dashboardCall("a-copy", { ts: M + 1 * D, responseId: "r1", copied: true, sourceFile: "synthetic/fork.jsonl", price: priced(1) }),
    dashboardCall("b-copy", { ts: M + 2 * D, responseId: "r2", copied: true, sourceFile: "synthetic/fork.jsonl", price: priced(2) }),
    dashboardCall("b", { ts: M + 12 * D, responseId: "r2", price: priced(2) }),
    dashboardCall("orphan-copy", { ts: M + 3 * D, responseId: "r3", copied: true, sourceFile: "synthetic/fork.jsonl", price: priced(4) }),
    dashboardCall("r-report", { ts: M + 12 * D, actor: "subagent", runId: "R", aggregate: true, sourceKind: "report", sourceFile: "synthetic/r.jsonl", price: priced(8) }),
    dashboardCall("c-detail", { ts: M + 4 * D, actor: "aux", runId: "C", sourceFile: "synthetic/c.jsonl", price: priced(16) }),
    dashboardCall("s-report", { ts: M + 5 * D, actor: "subagent", runId: "S", aggregate: true, sourceKind: "report", sourceFile: "synthetic/s-parent.jsonl", price: priced(32) }),
    dashboardCall("s-detail", { ts: M + 15 * D, actor: "subagent", runId: "S", sourceFile: "synthetic/s.jsonl", price: priced(64) }),
    dashboardCall("u", { ts: M + 6 * D, actor: "warmer", price: { status: "unpriced", reason: "unknown-model" } }),
    dashboardCall("n-detail", { ts: M + 7 * D, actor: "subagent", runId: "N", sourceFile: "synthetic/n.jsonl", price: priced(128) }),
    dashboardCall("h-detail", { ts: M + 8 * D, actor: "aux", runId: "H", parentRunId: "R", sourceFile: "synthetic/h.jsonl", price: priced(256) }),
    dashboardCall("edge", { ts: M + 10 * D, responseId: "r-edge", price: priced(512) }),
  ], { runs: [run("N", null), run("R", M + 13 * D)],
    coverageEdges: [{ reportRunId: "R", includedRunId: "C", evidence: "transcript" }] }));
  const reader = openDashboardReader(fixture.file, { instanceId: "i", now: () => M + 25 * D, calibrationMode: () => "auto", serverBuild: "b" })!;
  try {
    const P = { start: M, end: M + 10 * D, filters: [] };
    const Q = { start: M + 10 * D, end: M + 20 * D, filters: [] };
    reader.snapshot(ctx => {
      const p = readMeasure(ctx, P);
      expect([p.aic, p.calls, p.pricedCalls, p.unpricedCalls, p.possibleOverlap, p.possibleUndercount, p.pendingData]).toEqual([389, 5, 4, 1, true, true, false]);
      const q = readMeasure(ctx, Q);
      expect([q.aic, q.calls, q.pricedCalls, q.aggregateCalls, q.possibleOverlap, q.possibleUndercount, q.pendingData]).toEqual([586, 4, 4, 1, true, false, false]);
      const aux = readMeasure(ctx, { ...P, filters: [{ field: "actor", value: "aux" }] });
      expect([aux.aic, aux.calls, aux.possibleOverlap]).toEqual([256, 1, true]);
      const all = queryOverview(ctx, { start: M, end: M + 20 * D, filters: [] });
      expect([all.totals.aic, all.totals.calls]).toEqual([975, 9]);
      expect(Object.fromEntries(all.actors.map(row => [row.label, row.measure.aic]))).toEqual({ parent: 519, subagent: 200, aux: 256, compaction: null, warmer: null });
      expect(all.actors.find(row => row.label === "warmer")!.measure.unpricedCalls).toBe(1);
    });
    for (const [period, aic] of [[P, 389], [Q, 586]] as const) expect(fixture.ledger.summarize(period.start, period.end).aic).toBe(aic);
    fixture.ledger.apply(dashboardBatch([], { pendingReports: [{ path: "synthetic/pending.jsonl", runId: "pending-run", generation: 0, firstSeen: M, calls: [] }] }));
    reader.snapshot(ctx => {
      const q = readMeasure(ctx, Q);
      expect([q.pendingData, q.possibleUndercount, q.aic]).toEqual([true, true, 586]);
    });
  } finally { reader.close(); fixture.close(); }
});


it("Overview evaluates calibration once including the account comparison", () => {
  fixture.ledger.insertCounter({ ts: DASHBOARD_NOW - 100, creditsUsed: 10, raw: {} });
  reader.snapshot(ctx => {
    const current = vi.spyOn(ctx.calibration, "atMany");
    try {
      const result = queryOverview(ctx, slice());
      expect(result.comparison.computed).not.toBeNull();
      expect(current).toHaveBeenCalledTimes(1);
      expect(current.mock.calls[0]![0].length).toBeLessThanOrEqual(33);
      expect(current.mock.calls[0]![0]).toContain(DASHBOARD_NOW - 1);
    } finally { current.mockRestore(); }
  });
});

it("Overview calibration is account wide", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("calibration-evidence", { ts: DASHBOARD_NOW - DASHBOARD_DAY - 1, project: "other-project", role: "calibration-role",
    price: { status: "priced", aic: 1000, components: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } })]));
  fixture.ledger.insertCounter({ ts: DASHBOARD_NOW - DASHBOARD_DAY - 1, creditsUsed: 0, raw: {} });
  fixture.ledger.insertCounter({ ts: DASHBOARD_NOW - 1, creditsUsed: 560, raw: {} });
  reader.snapshot(ctx => {
    const current = vi.spyOn(ctx.calibration, "atMany");
    const full = queryOverview(ctx, slice());
    expect(current).toHaveBeenCalledTimes(1);
    const filtered = queryOverview(ctx, { ...slice(), filters: [{ field: "project", value: "fixture-project" }] });
    expect(current).toHaveBeenCalledTimes(2); current.mockRestore();
    expect(full.calibration.factor).toBe(0.56); expect(filtered.calibration).toEqual(full.calibration);
    expect(filtered.totals).toMatchObject({ aic: 4, calls: 5, unpricedCalls: 1, tokens: { prompt: 300, total: 350 } });
    expect(filtered.totals.aicDisplay.primaryAic).toBeCloseTo(2.24);
    const measures = [full.totals, ...full.actors.map(x => x.measure), ...full.roles.map(x => x.measure),
      ...full.daily.rows.flatMap(x => [x.measure, ...x.actors.map(a => a.measure), ...x.roles.map(r => r.measure)]), full.comparison.computed!];
    for (const measure of measures) {
      expect(["calibrated", "back-applied"]).toContain(measure.aicDisplay.basis);
      expect(measure.aicDisplay.publishedAic).toBe(measure.aic);
      if (measure.aic !== null) expect(measure.aicDisplay.primaryAic).toBeCloseTo(measure.aic * 0.56);
    }
    expect(full.pace.projected!.aicDisplay.primaryAic).toBeCloseTo(full.pace.projected!.aicDisplay.publishedAic! * 0.56);
    expect(JSON.stringify(full).match(/"calibration":/g)).toHaveLength(1);
  });
});

it("Overview uses period-end windows, earliest back-application, and current fit", () => {
  const M = DASHBOARD_MONTH, D = DASHBOARD_DAY;
  fixture.db.exec("DELETE FROM calls");
  const pricedCall = (id: string, ts: number) => dashboardCall(id, { ts, price: priced(1000) });
  fixture.ledger.apply(dashboardBatch([pricedCall("past", M - D), ...Array.from({ length: 14 }, (_, i) => pricedCall(`fit-${i}`, M + i * D))]));
  for (let i = 0; i <= 14; i++) fixture.ledger.insertCounter({ ts: M + i * D, creditsUsed: i <= 7 ? i * 500 : 3500 + (i - 7) * 1000, raw: {} });
  const ctx = reader.snapshot(ctx => ctx);
  {
    const beforeSlice = { start: M - D, end: M, filters: [] };
    const before = queryOverview(ctx, beforeSlice);
    expect(readMeasure(ctx, beforeSlice).aicDisplay).toMatchObject({ primaryAic: 500, basis: "back-applied" });
    expect(before.totals.aicDisplay).toMatchObject({ primaryAic: 500, publishedAic: 1000, basis: "back-applied" });
    expect(before.calibration.windowEnd).toBe(M + D);
    const past = queryOverview(ctx, { start: M, end: M + 7 * D + 1, filters: [] });
    expect(past.calibration.factor).toBe(0.5); expect(past.totals.aicDisplay.basis).toBe("calibrated");
    expect(past.totals.aicDisplay.primaryAic).toBe(past.totals.aic! * 0.5);
    const current = queryOverview(ctx, { start: M + 7 * D, end: DASHBOARD_NOW, filters: [] });
    expect(current.calibration.factor).toBe(1); expect(current.totals.aicDisplay.primaryAic).toBe(current.totals.aic);
    const daily = current.daily.rows.find(day => day.start === M + 7 * D)!;
    expect(daily.measure.aicDisplay.primaryAic).toBe(daily.measure.aic! * 0.5);
    expect(current.daily.rows.at(-1)!.measure.aicDisplay.basis).toBe("calibrated");
    expect(before.daily.rows[0]!.measure.aicDisplay.basis).toBe("back-applied");
    const currentMonth = queryOverview({ ...ctx, now: () => M + 14 * D + 1000 }, { start: M, end: M + 14 * D + 1000, filters: [] });
    expect(currentMonth.calibration.factor).toBe(1);
    expect(currentMonth.comparison.computed!.aicDisplay.primaryAic).toBeCloseTo(currentMonth.comparison.computed!.aic! * (6500 / 7000));
  }
});

it("a gap after the first fit stays published even when a later fit exists", () => {
  const M = DASHBOARD_MONTH, D = DASHBOARD_DAY;
  fixture.db.exec("DELETE FROM calls");
  fixture.ledger.apply(dashboardBatch([dashboardCall("early", { ts: M, price: priced(1000) }), dashboardCall("gap-period", { ts: M + 10 * D, price: priced(1000) })]));
  for (const [day, credits] of [[0, 0], [1, 500], [10, 600], [11, 1600]]) fixture.ledger.insertCounter({ ts: M + day! * D, creditsUsed: credits!, raw: {} });
  const ctx = reader.snapshot(ctx => ctx);
  const result = queryOverview(ctx, { start: M + 10 * D, end: M + 10 * D + 1, filters: [] });
  expect(result.calibration).toMatchObject({ status: "uncalibrated", windowEnd: M + 10 * D });
  expect(result.totals.aicDisplay).toEqual({ primaryAic: 1000, publishedAic: 1000, basis: "published" });
  expect(readMeasure(ctx, { start: M + 10 * D, end: M + 10 * D + 1, filters: [] }).aicDisplay).toEqual(result.totals.aicDisplay);
});
