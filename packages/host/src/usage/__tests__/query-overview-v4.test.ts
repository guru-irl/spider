import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { calibrationFallback } from "../calibration.js";
import type { DashboardQueryContext, DashboardReader } from "../dashboard-contract.js";
import type { OverviewDataV4, RangeQuery } from "../dashboard-v4-contract.js";
import type { RunMeta, SessionMeta } from "../ledger.js";
import { OVERVIEW_V4_ROUTES, queryOverviewV4 } from "../query-overview-v4.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_DAY as D,
  DASHBOARD_MONTH as S, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

const H = 3_600_000;
let f: DashboardFixture, reader: DashboardReader, ctx: DashboardQueryContext, now: number;
const human = (id = "parent-session", ownerSessionId: string | null = null): SessionMeta => ({
  id, ownerSessionId, name: `Name ${id}`, nameSource: "name", nameOrder: 1, project: "synthetic",
  firstActivity: S, lastActivity: S + D,
});
const run = (id: string, sessionId: string | null, parentRunId: string | null = null): RunMeta => ({
  id, sessionId, parentRunId, dbPath: "synthetic/runs.db", project: null, repo: null,
  agent: null, role: "worker", name: id, model: null, thinking: null, phase: null,
  startedAt: S, endedAt: S + D, status: "done",
});
const call = (id: string, ts: number, credits: number, extra: Parameters<typeof dashboardCall>[1] = {}) =>
  dashboardCall(id, { ts, price: { status: "priced", aic: credits,
    components: { input: credits, cacheRead: 0, cacheWrite: 0, output: 0 },
    rateVersion: "synthetic", tier: "base", confidence: "estimated" }, ...extra });
const q = (extra: Partial<RangeQuery> = {}): RangeQuery => ({
  range: "custom", from: S, to: S + 3 * D, tz: "UTC", unit: "credits", buckets: [], ...extra,
});
function refresh() {
  reader?.close();
  reader = openDashboardReader(f.file, { instanceId: "synthetic", serverBuild: "fixture",
    now: () => now, calibrationMode: () => "auto", monthlyBudget: () => 200 })!;
  ctx = reader.snapshot(c => c);
  // Reader propagation is owned by Task 10. Task 7 consumes the context hook.
  ctx.monthlyBudget = () => 200;
}
function route(params = ""): OverviewDataV4 {
  return OVERVIEW_V4_ROUTES.find(r => r.path === "/api/overview")!.handle(ctx, new URLSearchParams(params)) as OverviewDataV4;
}
beforeEach(() => { now = S + 15 * D + 12 * H; f = createDashboardFixture(false); refresh(); });
afterEach(() => { vi.restoreAllMocks(); reader.close(); f.close(); });

it("defaults to rolling seven days and uses the inclusive 48-hour hourly threshold", () => {
  expect(route()).toMatchObject({ range: { range: "7d", from: now - 7 * D, to: now, unit: "credits", tz: "UTC" }, bucketSize: "day", sessions: { limit: 10, offset: 0 } });
  expect(route("range=24h").bucketSize).toBe("hour");
  expect(queryOverviewV4(ctx, q({ to: S + 2 * D })).bucketSize).toBe("hour");
  expect(queryOverviewV4(ctx, q({ to: S + 2 * D + 1 })).bucketSize).toBe("day");
});

it("noncontiguous selection changes only downstream measures", () => {
  f.ledger.apply(dashboardBatch([
    call("a", S + H, 2, { model: "model-a" }),
    call("b", S + D + H, 10, { model: "model-b", sessionId: "second-session" }),
    call("c", S + 2 * D + H, 3, { actor: "subagent", runId: "worker-run", role: "worker" }),
  ], { sessions: [human(), human("second-session")], runs: [run("worker-run", "parent-session")] }));
  refresh();
  const whole = queryOverviewV4(ctx, q()), selected = queryOverviewV4(ctx, q({ buckets: [S, S + 2 * D] }));
  expect(whole.total.credits).toBe(15);
  expect(selected.range.buckets).toEqual([S, S + 2 * D]);
  expect(selected.total).toEqual(whole.total);
  expect(selected.buckets).toEqual(whole.buckets);
  expect(selected.pace).toEqual(whole.pace);
  expect(selected.selectedTotal.credits).toBe(5);
  expect(selected.models.reduce((n, m) => n + (m.value.credits ?? 0), 0)).toBe(5);
  expect(selected.sessions.rows.map(r => r.id)).toEqual(["parent-session"]);
  expect(selected.flow.total).toEqual(selected.selectedTotal);
  expect(selected.flow.edges.reduce((n, e) => n + (e.value.credits ?? 0), 0)).toBe(5);
  expect(queryOverviewV4(ctx, q({ buckets: [] }))).toEqual(whole);
});

it("corrected totals reconcile range bars models sessions and flow across UTC days", () => {
  f.ledger.apply(dashboardBatch([call("a", S + 23 * H, 10), call("b", S + D + H, 20)], { sessions: [human()] }));
  refresh();
  ctx.calibration.atMany = ends => ends.map(end => ({ ...calibrationFallback(), status: "calibrated", factor: end < S + D ? 0.5 : 1, windowEnd: end }));
  const data = queryOverviewV4(ctx, q({ tz: "Asia/Kathmandu" }));
  expect(data.total.credits).toBe(25);
  for (const values of [data.buckets.map(b => b.total), data.models.map(m => m.value), data.sessions.rows.map(s => s.value), data.flow.edges.map(e => e.value)])
    expect(values.reduce((n, v) => n + (v.credits ?? 0), 0)).toBeCloseTo(25, 10);
  expect(data.total.tokens.total).toBe(140);
});

it("role splits reconcile and model notes name the strongest actual source", () => {
  f.ledger.apply(dashboardBatch([
    call("own", S + H, 2),
    call("worker", S + H, 6, { actor: "subagent", role: null, runId: "worker-run" }),
    call("reviewer", S + H, 1, { actor: "subagent", role: "reviewer", runId: "review-run" }),
    call("compaction", S + H, 1, { actor: "compaction", model: "compact-model" }),
  ], { sessions: [human()], runs: [run("worker-run", "parent-session"), { ...run("review-run", "parent-session"), role: "reviewer" }] }));
  refresh();
  const data = queryOverviewV4(ctx, q()), row = data.sessions.rows[0]!;
  expect(row.roles.map(r => [r.role, r.value.credits, r.runs])).toEqual([
    ["own", 2, 0], ["workers", 6, 1], ["reviewers", 1, 1], ["others", 1, 0],
  ]);
  expect(row.roles.reduce((n, r) => n + (r.value.credits ?? 0), 0)).toBe(row.value.credits);
  expect(row.roles.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1, 10);
  expect(data.models.find(m => m.id === "fixture-model")!.note).toBe("67% from worker runs");
  expect(data.models.find(m => m.id === "compact-model")!.note).toBe("100% from compaction calls");
  expect(data.flow.models).toEqual(data.models);
});

it("Tokens-mode model notes use token dominance rather than credit dominance", () => {
  f.ledger.apply(dashboardBatch([
    call("own", S + H, 9, { usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 0 } }),
    call("worker", S + H, 1, { actor: "subagent", role: "worker", runId: "worker-run",
      usage: { input: 90, cacheRead: 0, cacheWrite: 0, output: 0 } }),
  ], { sessions: [human()], runs: [run("worker-run", "parent-session")] })); refresh();
  expect(queryOverviewV4(ctx, q()).models[0]!.note).toBe("90% from own calls");
  const tokens = queryOverviewV4(ctx, q({ unit: "tokens" }));
  expect(tokens.models[0]!.note).toBe("90% from worker runs");
  expect(tokens.flow.models[0]!.note).toBe("90% from worker runs");
});

it("model notes never claim 100 percent when a second source contributes", () => {
  f.ledger.apply(dashboardBatch([
    call("own", S + H, 249),
    call("worker", S + H, 1, { actor: "subagent", role: "worker", runId: "worker-run" }),
    call("exclusive", S + H, 2, { model: "exclusive-model" }),
  ], { sessions: [human()], runs: [run("worker-run", "parent-session")] })); refresh();
  const data = queryOverviewV4(ctx, q());
  expect(data.models.find(model => model.id === "fixture-model")!.note).toBe("99% from own calls");
  expect(data.models.find(model => model.id === "exclusive-model")!.note).toBe("100% from own calls");
});

it("unpriced reasons count each canonical selected call once and preserve null prices", () => {
  const unknown = call("unknown", S + H, 0, { responseId: "unknown-response", price: { status: "unpriced", reason: "unknown-model" } });
  f.ledger.apply(dashboardBatch([
    unknown, { ...unknown, id: "copy", entryId: "copy", copied: true, sourceFile: "synthetic/fork.jsonl" },
    call("missing", S + D + H, 0, { price: { status: "unpriced", reason: "missing-attribution" } }),
    call("report", S + H, 0, { actor: "subagent", runId: "worker-run", aggregate: true, sourceKind: "report", price: { status: "unpriced", reason: "unknown-model" } }),
    call("detail", S + H, 1, { actor: "subagent", runId: "worker-run" }),
  ], { sessions: [human()], runs: [run("worker-run", "parent-session")] }));
  refresh();
  const data = queryOverviewV4(ctx, q());
  expect(data.total.calls).toBe(3);
  expect(data.total.unpricedCalls).toBe(2);
  expect(data.unpriced).toEqual([{ reason: "missing-attribution", calls: 1 }, { reason: "unknown-model", calls: 1 }]);
  const selected = queryOverviewV4(ctx, q({ buckets: [S + D] }));
  expect(selected.unpriced).toEqual([{ reason: "missing-attribution", calls: 1 }]);
  expect(selected.selectedTotal.credits).toBeNull();
  expect(selected.models[0]!.note).toBe("Mostly own calls");
});

it("direct pipeline nested and unresolved runs produce one owner and one unattributed row", () => {
  f.ledger.apply(dashboardBatch([
    call("own", S + H, 1),
    call("direct", S + H, 2, { actor: "subagent", sessionId: "child-direct", runId: "direct" }),
    call("pipeline", S + H, 3, { actor: "subagent", sessionId: "child-pipeline", runId: "pipeline" }),
    call("nested", S + H, 4, { actor: "subagent", sessionId: "child-nested", runId: "nested" }),
    call("lost-a", S + H, 5, { actor: "subagent", sessionId: "lost-child-a", runId: "lost-a" }),
    call("lost-b", S + H, 6, { actor: "subagent", sessionId: "lost-child-b", runId: "lost-b" }),
  ], { sessions: [human(), human("child-direct", "parent-session"), human("child-pipeline", "parent-session"), human("child-nested", "parent-session")],
    runs: [run("direct", "parent-session"), run("pipeline", null, "direct"), run("nested", "child-direct")] }));
  refresh();
  const data = queryOverviewV4(ctx, q());
  expect(data.sessions.rows.map(r => [r.id, r.value.credits])).toEqual([["unattributed-runs", 11], ["parent-session", 10]]);
  expect(data.sessions.summary.runs).toBe(5);
  expect(data.total.credits).toBe(21);
});

it("missing nested child moves exactly once to its human owner after v4 evidence arrives", () => {
  f.ledger.apply(dashboardBatch([call("own", S + H, 1),
    call("nested", S + H, 4, { actor: "subagent", sessionId: "missing-child", runId: "nested" })],
  { sessions: [human()], runs: [run("nested", "missing-child")] }));
  refresh();
  const before = queryOverviewV4(ctx, q());
  expect(before.sessions.rows.map(r => r.id)).toEqual(["unattributed-runs", "parent-session"]);
  f.ledger.apply(dashboardBatch([], { sessions: [human("missing-child", "parent-session")] })); refresh();
  const after = queryOverviewV4(ctx, q());
  expect(after.total).toEqual(before.total);
  expect(after.sessions.rows.map(r => [r.id, r.value.credits])).toEqual([["parent-session", 5]]);
});

it("rolling aligned selection silently ages out and becomes full range when fully pruned", () => {
  now = S + 2 * D + H / 2;
  f.ledger.apply(dashboardBatch([call("early", S + D + 3 * H / 4, 2), call("later", S + D + 2 * H, 3), call("latest", S + 2 * D, 4)], { sessions: [human()] }));
  refresh();
  const params = `range=24h&buckets=${encodeURIComponent(JSON.stringify([S + D, S + D + 2 * H]))}`;
  expect(route(params).selectedTotal.credits).toBe(5);
  now += H; refresh();
  const aged = route(params), full = route("range=24h");
  expect(aged.range.buckets).toEqual([S + D + 2 * H]);
  expect(aged.selectedTotal.credits).toBe(3);
  expect(aged.total).toEqual(full.total);
  expect(aged.buckets).toEqual(full.buckets);
  now += 3 * H; refresh();
  const pruned = route(params);
  expect(pruned.range.buckets).toEqual([]);
  expect(pruned.selectedTotal).toEqual(pruned.total);
});

it("presets ignore supplied bounds and invalid zones fall back to UTC", () => {
  expect(route("range=24h&from=bad&to=-1&tz=Not/AZone").range).toMatchObject({ from: now - D, to: now, tz: "UTC" });
  expect(queryOverviewV4(ctx, q({ range: "7d", from: S, to: S + D })).range).toMatchObject({ from: now - 7 * D, to: now });
});

it.each([
  "range=custom", "range=custom&from=1", "range=custom&to=2", "range=custom&from=2&to=1",
  "range=custom&from=1.2&to=2", "range=custom&from=1e3&to=2000", "range=custom&from=-1&to=2",
  "range=custom&from=9007199254740992&to=9007199254740993", "range=bad", "unit=bad", "extra=x", "range=7d&range=24h", "tz=UTC&tz=UTC", "sort=credits", "offset=0",
  "buckets=", "buckets=1,2", "buckets={}", "buckets=null", "buckets=[1.5]", "buckets=[\"1\"]", "buckets=[true]", "buckets=[9007199254740992]", "buckets=[1]",
  `buckets=[${S},${S}]`,
])("rejects malformed or unknown Overview parameters: %s", params => {
  expect(() => route(params)).toThrow("invalid-query");
});

it("rolling month prunes old hourly keys when it changes to daily buckets", () => {
  now = S + 2 * D;
  f.ledger.apply(dashboardBatch([call("first-hour", S + H / 2, 2), call("second-hour", S + H + H / 2, 3),
    call("second-day", S + D + H, 4)], { sessions: [human()] })); refresh();
  const params = `range=month&buckets=[${S},${S + H}]`;
  const hourly = route(params);
  expect(hourly.bucketSize).toBe("hour");
  expect(hourly.range.buckets).toEqual([S, S + H]);
  expect(hourly.selectedTotal.credits).toBe(5);
  now += 1; refresh();
  const daily = route(params);
  expect(daily.bucketSize).toBe("day");
  expect(daily.range.buckets).toEqual([S]);
  expect(daily.selectedTotal.credits).toBe(5);
  expect(daily.total.credits).toBe(9);
});

it("accepts a 93-day custom range and rejects longer windows", () => {
  expect(route(`range=custom&from=${S}&to=${S + 93 * D}`).range.to).toBe(S + 93 * D);
  expect(() => route(`range=custom&from=${S}&to=${S + 93 * D + 1}`)).toThrow("invalid-query");
});

it("pace uses the current reset month and account counter independently of historical selection", () => {
  now = S + 15 * D;
  f.ledger.insertCounter({ ts: now, accountLogin: "synthetic-account", creditsUsed: 100, entitlement: 400,
    remaining: 300, resetDate: "2026-11-14", raw: { private: "never-return-this" } });
  refresh();
  const history = queryOverviewV4(ctx, q({ buckets: [S] })), recent = route("range=24h&unit=tokens"), month = route("range=month");
  expect(history.pace).toEqual(recent.pace);
  expect(history.pace).toMatchObject({ period: { start: Date.UTC(2026, 9, 14), end: Date.UTC(2026, 10, 14) }, used: 100, usedSource: "counter", budget: 200, allowance: 400, scale: 200 });
  expect(month.range).toMatchObject({ from: Date.UTC(2026, 9, 14), to: now });
  expect(JSON.stringify(history)).not.toContain("synthetic-account");
  expect(JSON.stringify(history)).not.toContain("never-return-this");
});

it("pace falls back to corrected month and exact trailing-window totals", () => {
  now = S + 10 * D + 12 * H;
  f.ledger.apply(dashboardBatch([call("older", S + D, 7), call("before-window", now - 7 * D - 1, 100),
    call("window-start", now - 7 * D, 14), call("today", now - 1, 21), call("future", now, 1000)], { sessions: [human()] }));
  refresh();
  const data = queryOverviewV4(ctx, q());
  expect(data.pace).toMatchObject({ used: 142, usedSource: "pi", ratePerDay: 5, rateSource: "pi", counterAvailable: false });
  expect(data.pace.projected).toBe(244.5);
});

it("counter pace honors duplicate validity and does not bridge an invalid observation", () => {
  now = S + 10 * D;
  for (const [ts, creditsUsed] of [[now - 7 * D, 30], [now - 3 * D, 70], [now, 100], [now, -1]])
    f.ledger.insertCounter({ ts: ts!, accountLogin: "synthetic-account", creditsUsed: creditsUsed!, entitlement: 400, resetDate: "2026-11-01", raw: {} });
  refresh();
  expect(route().pace).toMatchObject({ used: 100, ratePerDay: 10, rateSource: "counter" });
  f.ledger.insertCounter({ ts: now - 2 * D, accountLogin: "synthetic-account", creditsUsed: -1, resetDate: "2026-11-01", raw: {} });
  refresh();
  expect(route().pace).toMatchObject({ used: 100, rateSource: "unavailable", ratePerDay: null });
});

it("empty data has honest null measures and present empty lists", () => {
  const data = route();
  expect(data.total).toMatchObject({ calls: 0, credits: null, unpricedCalls: 0, tokens: { total: 0 } });
  expect(data.selectedTotal).toEqual(data.total);
  expect(data.models).toEqual([]);
  expect(data.unpriced).toEqual([]);
  expect(data.sessions).toEqual({ rows: [], total: 0, offset: 0, limit: 10, nextOffset: null, summary: { runs: 0, top3Share: 0 } });
  expect(data.flow.edges).toEqual([]);
  expect(data.pace.used).toBeNull();
  expect(data.pace.projected).toBeNull();
});

it("uses bounded indexed canonical reads for the range and unpriced reasons", () => {
  f.ledger.apply(dashboardBatch([call("unknown", S + H, 0, { price: { status: "unpriced", reason: "unknown-model" } })], { sessions: [human()] })); refresh();
  const original = ctx.db.prepare.bind(ctx.db), plans: { sql: string; args: unknown[] }[] = [];
  vi.spyOn(ctx.db, "prepare").mockImplementation((...args: Parameters<typeof ctx.db.prepare>) => {
    const statement = original(...args);
    if (args[0].includes("calls_period_read")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...bindings: Parameters<typeof statement.all>) => {
        plans.push({ sql: args[0], args: bindings }); return all(...bindings);
      });
    }
    return statement;
  });
  queryOverviewV4(ctx, q({ buckets: [S] }));
  expect(plans.length).toBeGreaterThanOrEqual(4);
  for (const plan of plans) {
    const steps = original(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.args) as { id: number; parent: number; detail: string }[];
    const window = steps.find(step => step.detail === "MATERIALIZE window")!;
    expect(window).toBeDefined();
    // Other c aliases scan bounded materialized CTEs, not the raw calls table.
    const rawReads = steps.filter(step => step.parent === window.id && /(?:SCAN|SEARCH) c\b/.test(step.detail));
    expect(rawReads).toHaveLength(1);
    expect(rawReads[0]!.detail).toMatch(/SEARCH c USING INDEX calls_period_read.*ts>\?.*ts<\?/);
  }
});
