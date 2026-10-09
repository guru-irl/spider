import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardQueryError, type ApiEnvelope, type DashboardQueryContext, type DashboardReader } from "../dashboard-contract.js";
import { RESPONSE_CAPS_V4, type SessionData } from "../dashboard-v4-contract.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { calibrationFallback } from "../calibration.js";
import type { CallRow, RunMeta, SessionMeta } from "../ledger.js";
import { querySession as querySessionRange, sessionPeriod, sessionRoute } from "../query-session.js";
import { sumValues, UNATTRIBUTED_SESSION_ID } from "../query-redesign-shared.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as S, DASHBOARD_DAY as D, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

let f: DashboardFixture, reader: DashboardReader, ctx: DashboardQueryContext;
const H = "parent-session", M = 60_000;
// Legacy lifetime tests explicitly ask for the whole timeline; defaults are pinned in session-feedback.test.ts.
const querySession = (ctx: DashboardQueryContext, id: string, tz: string) => querySessionRange(ctx, id, tz, { from: 0, to: 8640000000000000 });
const human = (id = H, ownerSessionId: string | null = null): SessionMeta => ({ id, ownerSessionId, name: `Name ${id}`, nameSource: "name", project: "synthetic", firstActivity: S, lastActivity: S + 1, nameOrder: 1 });
const run = (id: string, extras: Partial<RunMeta> = {}): RunMeta => ({ id, dbPath: "synthetic/runs.db", project: null, repo: null, sessionId: H, parentRunId: null, agent: null, role: "worker", name: id, model: null, thinking: null, phase: null, startedAt: null, endedAt: null, status: null, ...extras });
const call = (id: string, ts: number, credits = 1, extras: Partial<CallRow> = {}): CallRow => dashboardCall(id, { ts, price: { status: "priced", aic: credits, components: { input: 0, cacheRead: 0, cacheWrite: credits, output: 0 }, rateVersion: "synthetic", tier: "base", confidence: "estimated" }, ...extras });
function refresh() {
  reader?.close();
  reader = openDashboardReader(f.file, { instanceId: "synthetic", serverBuild: "fixture", now: () => S + 1000 * D, calibrationMode: () => "auto" })!;
  ctx = reader.snapshot(c => c);
}
function seed(calls: CallRow[], runs: RunMeta[] = [], sessions: SessionMeta[] = [human()]) {
  expect(f.ledger.apply(dashboardBatch(calls, { runs, sessions }))).toBe(true); refresh();
}
beforeEach(() => { f = createDashboardFixture(false); refresh(); });
afterEach(() => { vi.restoreAllMocks(); reader.close(); f.close(); });

// Exact-path fixture transport, not the production matcher (Task 10 owns it).
async function reply(id: string, search = "") {
  const route = sessionRoute(id);
  const query = new URLSearchParams(search.replace(/^\?/, ""));
  if (!query.has("from") && !query.has("to")) { query.set("from", "0"); query.set("to", "8640000000000000"); }
  search = `?${query}`;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    if (url.pathname !== route.path) { res.writeHead(404).end(); return; }
    try {
      const data = route.handle(ctx, url.searchParams) as SessionData;
      const envelope: ApiEnvelope<SessionData> = { apiVersion: 1, revision: ctx.revision, generatedAt: ctx.now(), period: { start: data.range.from, end: data.range.to }, data };
      const body = JSON.stringify(envelope);
      res.writeHead(Buffer.byteLength(body) <= RESPONSE_CAPS_V4["/api/session/<id>"] ? 200 : 413, { "content-type": "application/json" }).end(body);
    } catch (error) {
      if (!(error instanceof DashboardQueryError)) { res.writeHead(500).end(); return; }
      res.writeHead(error.code === "not-found" ? 404 : 400).end(JSON.stringify({ apiVersion: 1, error: { code: error.code, message: error.code === "not-found" ? "Session not found" : "Invalid query" } }));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}${route.path}${search}`);
    return { status: response.status, body: await response.text() };
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

it("old session includes its last call and mapped nested children, not cached activity or Overview bounds", () => {
  seed([call("first", S, 2), call("direct", S + D, 3, { actor: "subagent", runId: "direct", sessionId: "child" }), call("nested", S + 8 * D, 5, { actor: "subagent", runId: "nested", sessionId: "nested-child" }), call("last", S + 10 * D, 7)], [run("direct"), run("nested", { sessionId: "child" })], [human(), human("child", H), human("nested-child", "child")]);
  const data = querySession(ctx, H, "Asia/Kathmandu");
  expect(data.total).toMatchObject({ credits: 17, calls: 4 });
  expect(data.span).toMatchObject({ start: S, end: S + 10 * D + 1 });
  expect(data.span).toMatchObject(sessionPeriod(ctx, H)!);
  expect(data.name).toBe(`Name ${H}`); expect(data.project).toBe("synthetic");
  expect(querySession(ctx, H, "Not/AZone").total).toEqual(data.total);
});

it("header models flow and direct run totals reconcile without recursively charging descendants", () => {
  seed([call("own", S, 2), call("direct", S + 1, 3, { actor: "subagent", runId: "a", sessionId: "child", model: "model-a" }), call("nested", S + 2, 5, { actor: "subagent", runId: "b", sessionId: "child", model: "model-b" }), call("compact", S + 3, 7, { actor: "compaction" }), call("aux", S + 4, 11, { actor: "aux" }), call("warm", S + 5, 13, { actor: "warmer" })], [run("a"), run("b", { sessionId: null, parentRunId: "a", role: "reviewer" }), run("zero")], [human(), human("child", H)]);
  const data = querySession(ctx, H, "UTC");
  expect(data.total).toMatchObject({ credits: 41, calls: 6, tokens: { total: 420 } });
  expect(data.flow.total).toEqual(data.total);
  expect(sumValues(data.models.map(m => m.value))).toEqual(data.total);
  expect(sumValues(data.flow.edges.map(e => e.value))).toEqual(data.total);
  expect(data.runs.map(r => [r.id, r.value.credits])).toEqual([["a", 3], ["b", 5], ["zero", null]]);
  expect(data.runs.at(-1)).toMatchObject({ model: null, style: null, value: { calls: 0 } });
  expect(data.stats).toEqual({ runs: 3, ownCalls: 1, compaction: 1, idleGaps: 0 });
  expect(data.flow.edges.map(e => e.role)).toEqual(["own", "workers", "reviewers", "compaction", "background"]);
  expect(data.compaction).toEqual([{ ts: S + 3, value: expect.objectContaining({ credits: 7 }) }]);
});

it("canonical reports copies and covered descendants never reappear in the lifetime span or run totals", () => {
  seed([call("own", S, 2), call("native", S + 1, 3, { actor: "subagent", runId: "a", responseId: "same" }), call("copy", S + 1, 3, { copied: true, responseId: "same", sourceFile: "synthetic/copy", sessionId: "copy-session" }), call("report", S + 100 * D, 99, { actor: "subagent", runId: "a", aggregate: true, sourceKind: "report" }), call("cover", S + 2, 5, { actor: "subagent", runId: "cover", aggregate: true, sourceKind: "report" }), call("covered", S + 200 * D, 77, { actor: "subagent", runId: "covered" })], [run("a"), run("cover"), run("covered", { parentRunId: "cover" })]);
  f.ledger.apply(dashboardBatch([], { coverageEdges: [{ reportRunId: "cover", includedRunId: "covered", evidence: "transcript" }] })); refresh();
  const data = querySession(ctx, H, "UTC");
  expect(data.span).toMatchObject({ start: S, end: S + 3 });
  expect(data.total).toMatchObject({ credits: 10, calls: 3 });
  expect(data.runs.find(r => r.id === "a")!.value.credits).toBe(3);
  expect(data.runs.find(r => r.id === "covered")!.value).toMatchObject({ credits: null, calls: 0 });
});

it("statuses use metadata facts and never guess completed from an end timestamp", () => {
  const statuses = ["done", "cancelled", "failed", "queued", "running", "paused", null] as const;
  seed([call("own", S)], statuses.map((status, i) => run(`r${i}`, { status, endedAt: status === null ? S + M : null })));
  expect(querySession(ctx, H, "UTC").runs.map(r => r.status)).toEqual(["completed", "cancelled", "failed", "running", "running", "running", null]);
});

it("idle thresholds are strict, canonical order uses id, and active bins exclude auxiliary calls", () => {
  const t1 = S + 5 * M, t2 = t1 + 300001, t3 = t2 + 30 * M, t4 = t3 + 1800001;
  seed([call("a", S), call("b", t1), call("c", t2), call("d", t3), call("e", t4), call("same-z", t4, 2), call("same-a", t4, 3), call("aux", t4 + 100 * M, 17, { actor: "aux" })]);
  const data = querySession(ctx, H, "UTC");
  // Exactly 30 minutes remains dotted but does not split a period.
  expect(data.idleGaps.map(g => g.end - g.start)).toEqual([300001, 1800000, 1800001]);
  expect(data.activePeriods).toEqual([{ start: S, end: t3 + 1 }, { start: t4, end: t4 + 1 }]);
  expect(data.ownCallBins.map(b => [b.start, b.end, b.value.calls, b.value.credits])).toEqual([[S, t3 + 1, 4, 4], [t4, t4 + 1, 3, 6]]);
  expect(data.idleGaps.at(-1)!.cacheWriteCredits).toBe(1); // e sorts before same-a/same-z
  expect(data.stats.ownCalls).toBe(7);
});

it("timestamp ties select the lexically first canonical call for the next-call cache write", () => {
  seed([call("first", S), call("z-next", S + 6 * M, 1), call("a-next", S + 6 * M, 3)]);
  const data = querySession(ctx, H, "UTC");
  expect(data.idleGaps).toEqual([{ start: S, end: S + 6 * M, cacheWriteCredits: 3 }]);
  expect(data.stats.ownCalls).toBe(3);
});

it("isolated threshold fixture returns only 5 minutes plus 1 ms and 30 minutes plus 1 ms", () => {
  seed([call("a", S), call("b", S + 300000), call("c", S + 600001), call("d", S + 2400002)]);
  expect(querySession(ctx, H, "UTC").idleGaps.map(g => g.end - g.start)).toEqual([300001, 1800001]);
});

it("next canonical own-call cache write uses its total's daily correction, without clipping the last day", () => {
  seed([call("a", S + D - 400000, 10), call("b", S + D + 1, 20), call("c", S + D + 400002, 30)]);
  ctx.calibration.atMany = ends => ends.map(end => ({ ...calibrationFallback(), status: "calibrated", factor: end < S + D ? 0.5 : end < S + 2 * D ? 0.25 : 1, windowEnd: end }));
  const data = querySession(ctx, H, "UTC");
  expect(data.total.credits).toBe(17.5);
  expect(sumValues(data.ownCallBins.map(b => b.value)).credits).toBe(17.5);
  expect(data.idleGaps.map(g => g.cacheWriteCredits)).toEqual([5, 7.5]);
});

it("running and report-only rows retain unavailable times duration and model instead of fabricating chronology", () => {
  seed([call("own", S), call("report", S + 10 * D, 2, { actor: "subagent", runId: "report", aggregate: true, sourceKind: "report", model: null, thinking: null, runName: "Report only" })], [run("report", { name: "Report only" }), run("live", { status: "running", startedAt: S, model: "model-live", thinking: "high" }), run("bad-times", { startedAt: S + 2, endedAt: S + 1 })]);
  const data = querySession(ctx, H, "UTC");
  expect(data.runs.find(r => r.id === "report")).toMatchObject({ start: null, end: null, durationMs: null, status: null, model: null, thinking: null, style: null });
  expect(data.runs.find(r => r.id === "live")).toMatchObject({ start: S, end: null, durationMs: null, status: "running", model: "model-live", thinking: "high" });
  expect(data.runs.find(r => r.id === "bad-times")!.durationMs).toBeNull();
});

it("a call-only run has usage and labels but no invented execution times or status", () => {
  seed([call("only", S, 4, { actor: "subagent", sessionId: "child", runId: "call-only", runName: "Call only", role: "reviewer", thinking: "low", model: "model-review" })], [], [human(), human("child", H)]);
  expect(querySession(ctx, H, "UTC").runs).toEqual([expect.objectContaining({ id: "call-only", name: "Call only", role: "reviewer", model: "model-review", thinking: "low", start: null, end: null, durationMs: null, status: null, value: expect.objectContaining({ credits: 4 }) })]);
});

it("whole lifetime beyond 93 days includes mapped child activity beyond stale metadata", () => {
  seed([call("first", S), call("middle", S + 94 * D, 2), call("late-child", S + 400 * D, 3, { actor: "subagent", sessionId: "child", runId: "r" })], [run("r", { sessionId: "child" })], [human(), human("child", H)]);
  const data = querySession(ctx, H, "Pacific/Apia");
  expect(data.total).toMatchObject({ credits: 6, calls: 3 });
  expect(data.span).toMatchObject({ start: S, end: S + 400 * D + 1 });
  expect(data.runs[0]!.value.credits).toBe(3);
});

it("own calls without runs return baseline-only inputs and own-only flow", () => {
  seed([call("own", S, 7)]);
  const data = querySession(ctx, H, "UTC");
  expect(data.stats).toEqual({ runs: 0, ownCalls: 1, compaction: 0, idleGaps: 0 });
  expect(data.runs).toEqual([]); expect(data.idleGaps).toEqual([]);
  expect(data.ownCallBins).toHaveLength(1);
  expect(data.flow.edges.map(e => [e.role, e.value.credits])).toEqual([["own", 7]]);
});

it("known metadata-only session returns HTTP 200 with intact header and no invented activity", async () => {
  seed([]);
  const response = await reply(H, "?tz=UTC");
  expect(response.status).toBe(200);
  const { data, period } = JSON.parse(response.body) as ApiEnvelope<SessionData>;
  expect(period).toEqual({ start: 0, end: 8640000000000000 });
  expect(data).toMatchObject({ id: H, name: `Name ${H}`, project: "synthetic", span: null, stats: { runs: 0, ownCalls: 0, compaction: 0, idleGaps: 0 }, total: { credits: null, calls: 0 } });
  for (const rows of [data.runs, data.ownCallBins, data.compaction, data.idleGaps, data.activePeriods, data.models, data.flow.edges]) expect(rows).toEqual([]);
  expect(sessionPeriod(ctx, H)).toBeNull();
});

it("unknown and child-only ids are not found, while missing children roll into one unattributed identity", async () => {
  seed([call("own", S, 2), call("orphan", S + 1, 3, { actor: "subagent", sessionId: "child", runId: "orphan" })], [run("orphan", { sessionId: "child" })]);
  for (const id of ["missing", "child", "parent"]) expect(() => querySession(ctx, id, "UTC")).toThrowError(expect.objectContaining({ code: "not-found" }));
  const notFound = await reply("missing"); expect(notFound.status).toBe(404);
  expect(JSON.parse(notFound.body)).toEqual({ apiVersion: 1, error: { code: "not-found", message: "Session not found" } });
  const data = querySession(ctx, UNATTRIBUTED_SESSION_ID, "UTC");
  expect(data).toMatchObject({ id: UNATTRIBUTED_SESSION_ID, name: "Unattributed runs", project: null, span: { start: S + 1, end: S + 2 }, total: { credits: 3 } });
  expect(data.flow.total).toEqual(data.total);
  f.ledger.apply(dashboardBatch([], { sessions: [human("child", H)] })); refresh();
  expect(querySession(ctx, H, "UTC").total.credits).toBe(5);
  expect(querySession(ctx, UNATTRIBUTED_SESSION_ID, "UTC").span).toBeNull();
});

it("reserved collision never replaces the synthetic identity and cyclic or ambiguous runs remain unattributed", () => {
  seed([call("collision", S, 50, { sessionId: UNATTRIBUTED_SESSION_ID }), call("cycle", S + 1, 3, { actor: "subagent", runId: "a" }), call("duplicate", S + 2, 5, { actor: "subagent", runId: "dup" })], [run("a", { parentRunId: "b" }), run("b", { parentRunId: "a" }), run("dup"), run("dup", { sessionId: "other", dbPath: "synthetic/other.db", status: "failed" })], [human(), human(UNATTRIBUTED_SESSION_ID), human("other")]);
  const data = querySession(ctx, UNATTRIBUTED_SESSION_ID, "UTC");
  expect(data.name).toBe("Unattributed runs"); expect(data.total.credits).toBe(8);
  expect(data.runs.map(r => r.id)).toEqual(["a", "b", "dup"]);
  expect(data.runs.find(r => r.id === "dup")!.status).toBeNull();
});

it("null pricing and model ambiguity stay unavailable while priced zero stays zero", () => {
  seed([dashboardCall("unpriced", { ts: S, price: { status: "unpriced", reason: "unknown-model" }, actor: "subagent", sessionId: "child", runId: "r", model: "model-a" }), call("zero", S + 1, 0, { actor: "subagent", sessionId: "child", runId: "r", model: "model-b" })], [run("r")], [human(), human("child", H)]);
  const data = querySession(ctx, H, "UTC");
  expect(data.total).toMatchObject({ credits: 0, calls: 2, unpricedCalls: 1 });
  expect(data.runs[0]).toMatchObject({ model: null, style: null, value: { credits: 0, unpricedCalls: 1 } });
});

it("public labels redact stored paths and no private evidence reaches the wire", () => {
  seed([call("own", S)], [run("r", { name: "Task /private/secret/project/step", thinking: "mode /private/secret/project/step", model: "model-a" })], [{ ...human(), name: "Session /private/secret/project/step", project: "/private/secret/project" }]);
  const wire = JSON.stringify(querySession(ctx, H, "UTC"));
  expect(wire).not.toContain("/private/secret");
  for (const key of ["dbPath", "sourceFile", "ownerSessionId", "nextCallId", "ownCalls\":[]"]) expect(wire).not.toContain(key);
});

it("route accepts a range and tz once and rejects unsupported id syntax before lookup", async () => {
  seed([call("own", S)]);
  expect(sessionRoute(H).path).toBe(`/api/session/${H}`);
  expect((await reply(H, "?tz=Not%2FAZone")).status).toBe(200);
  expect((await reply(H, "?from=1&to=2")).status).toBe(200);
  for (const search of ["?from=1", "?from=2&to=1", "?tz=UTC&tz=UTC", "?unit=tokens"]) expect((await reply(H, search)).status).toBe(400);
  for (const id of ["../escape", "parent/session", ""]) expect(() => sessionRoute(id)).toThrowError(expect.objectContaining({ code: "invalid-query" }));
});

// Capture every executed statement and its real bindings, not a hand-picked CTE.
function traceStatements() {
  const executed: { sql: string; bindings: unknown[] }[] = [];
  const original = ctx.db.prepare.bind(ctx.db);
  vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
    const stmt = original(sql);
    for (const method of ["all", "get"] as const) {
      const execute = stmt[method].bind(stmt);
      vi.spyOn(stmt, method).mockImplementation((...bindings: unknown[]) => {
        executed.push({ sql, bindings });
        return execute(...bindings);
      });
    }
    return stmt;
  });
  return { executed, original };
}

it("every Session statement uses identity-bounded raw-call lookups including Unattributed", () => {
  seed([call("own", S), call("child", S + 2, 2, { sessionId: "child", runId: "r", actor: "subagent" }), call("run-only", S + 3, 3, { sessionId: null, runId: "r", actor: "subagent" }), call("orphan", S + 4, 4, { sessionId: null, runId: "orphan", actor: "subagent" }), call("unrelated", S + 100 * D, 99, { sessionId: "other" })], [run("r")], [human(), human("child", H), human("other")]);
  const { executed, original } = traceStatements();
  expect(querySession(ctx, H, "UTC").total.credits).toBe(6);
  expect(querySession(ctx, UNATTRIBUTED_SESSION_ID, "UTC").total.credits).toBe(4);
  expect(executed.length).toBeGreaterThan(10);
  for (const { sql, bindings } of executed) {
    const plan = original(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { id: number; parent: number; detail: string }[];
    for (const node of plan) {
      // Every physical calls read must be a SEARCH, never a full index/table scan.
      expect(node.detail, sql).not.toMatch(/SCAN .*calls_|calls_period_read|SCAN calls\b/);
      if (/^SCAN [a-z]+$/.test(node.detail)) {
        const ancestors: string[] = [];
        let parent = plan.find(p => p.id === node.parent);
        while (parent) { ancestors.push(parent.detail); parent = plan.find(p => p.id === parent!.parent); }
        // Recursive r/c aliases can sit beneath an outer report materialization.
        // The nearest materialization identifies the actual scanned relation.
        expect(ancestors.find(detail => detail.startsWith("MATERIALIZE ")) ?? "root", sql)
          .not.toMatch(/MATERIALIZE (?:raw_session_candidates|report_runs)$/);
        if (/^SCAN (?:c|d|prior)$/.test(node.detail)) expect(ancestors[0] ?? "root", sql).not.toMatch(/^CORRELATED .*SUBQUERY/);
      }
      if (/USING (?:COVERING )?INDEX calls_|sqlite_autoindex_calls_/.test(node.detail)) expect(node.detail, sql).toMatch(/^SEARCH /);
    }
  }
});

it("Session raw-call work stays fixed with 200000 unrelated calls", () => {
  seed([call("first", S), call("last", S + 180 * D), call("orphan", S + 1, 3, { sessionId: null, runId: "orphan", actor: "subagent" })], [], [human(), human("other")]);
  let visits = 0;
  ctx.db.raw.function("test_visit", (_id: string) => { visits++; return 1; });
  const original = ctx.db.prepare.bind(ctx.db);
  // Non-deterministic SQL instrumentation executes at each canonical raw candidate.
  vi.spyOn(ctx.db, "prepare").mockImplementation(sql => original(sql.replaceAll("c.selection_shadowed = 0", "test_visit(c.id) AND c.selection_shadowed = 0")));
  const measure = () => {
    visits = 0;
    expect(querySession(ctx, H, "UTC").total).toMatchObject({ calls: 2, credits: 2 });
    expect(querySession(ctx, UNATTRIBUTED_SESSION_ID, "UTC").total).toMatchObject({ calls: 1, credits: 3 });
    return visits;
  };
  const small = measure();
  // One publication avoids measuring repeated fixture ingestion work.
  f.ledger.apply(dashboardBatch(Array.from({ length: 200000 }, (_, i) => call(`unrelated-${i}`, S + i * 1000, 99, { sessionId: "other" }))));
  ctx.revision += "-unrelated"; // Force cold ownership/style caches after fixture writes.
  const large = measure();
  expect(large).toBeLessThanOrEqual(small + 20);
  expect(large).toBeLessThan(200);
  process.stdout.write(`SCOPED_WORK before=${small} after=${large} unrelated=200000\n`);
}, 120_000);

it("dictionary-only child ownership is resolved in bounded batches rather than per id", () => {
  seed(Array.from({ length: 500 }, (_, i) => call(`child-${i}`, S + i, 1, { actor: "subagent", sessionId: `missing-child-${i}`, runId: `r-${i}` })), Array.from({ length: 500 }, (_, i) => run(`r-${i}`)));
  const { executed } = traceStatements();
  const data = querySession(ctx, H, "UTC");
  expect(data.total).toMatchObject({ calls: 500, credits: 500 });
  expect(data.runs).toHaveLength(500);
  expect(executed.length).toBeLessThan(40);
  const evidence = executed.filter(row => row.sql.includes("SELECT value AS id,EXISTS"));
  expect(evidence.length).toBeLessThanOrEqual(3);
  for (const row of evidence) expect(JSON.parse(row.bindings[0] as string).length).toBeLessThanOrEqual(200);
});

it("six month payload bins 50000 own calls and compactly returns 10000+ gaps and 300 runs under the cap", async () => {
  const calls: CallRow[] = [], runs: RunMeta[] = [];
  let last = S;
  for (let p = 0; p < 250; p++) {
    let ts = S + p * 17 * 60 * M;
    for (let i = 0; i < 200; i++) {
      if (i) ts += i <= 40 ? 6 * M : 1000;
      calls.push(call(`own-${p}-${i}`, ts)); last = ts;
    }
  }
  for (let i = 0; i < 300; i++) {
    const ts = S + i * 12 * 60 * M;
    runs.push(run(`run-${String(i).padStart(3, "0")}`, { startedAt: ts, endedAt: ts + M, status: "done", model: "model-worker" }));
    calls.push(call(`worker-${i}`, ts, 2, { actor: "subagent", runId: runs[i]!.id, sessionId: `child-${i}`, model: "model-worker" }));
  }
  seed(calls, runs, [human(), ...runs.map((_, i) => human(`child-${i}`, H))]);
  const many = vi.spyOn(ctx.calibration, "atMany"), prepare = vi.spyOn(ctx.db, "prepare");
  const response = await reply(H, "?tz=America%2FNew_York");
  expect(response.status).toBe(200);
  const data = (JSON.parse(response.body) as ApiEnvelope<SessionData>).data;
  expect(last - S).toBeLessThan(183 * D); expect(last - S).toBeGreaterThan(160 * D);
  expect(data.stats).toEqual({ runs: 300, ownCalls: 50000, compaction: 0, idleGaps: 10249 });
  expect(data.ownCallBins).toHaveLength(250); expect(data.activePeriods).toHaveLength(250); expect(data.runs).toHaveLength(300);
  expect(sumValues(data.ownCallBins.map(b => b.value))).toMatchObject({ credits: 50000, calls: 50000, tokens: { total: 3500000 } });
  expect(data.total).toMatchObject({ credits: 50600, calls: 50300 });
  expect(data.flow.total).toEqual(data.total);
  expect(data.idleGaps.length).toBeGreaterThanOrEqual(10000);
  expect(data.idleGaps.every(g => Object.keys(g).sort().join(",") === "cacheWriteCredits,end,start")).toBe(true);
  expect(data).not.toHaveProperty("ownCalls");
  for (const [endpoints] of many.mock.calls) {
    expect(endpoints.length).toBeLessThanOrEqual(200);
    expect(Math.max(...endpoints) - Math.min(...endpoints)).toBeLessThanOrEqual(366 * D);
  }
  const componentReads = prepare.mock.calls.filter(([sql]) => sql.includes("c.aic_cache_write") && sql.includes("c.id IN"));
  expect(componentReads).toHaveLength(52); // ceil(10249 / 200), not one query per gap
  expect(Buffer.byteLength(response.body, "utf8")).toBeLessThanOrEqual(RESPONSE_CAPS_V4["/api/session/<id>"]);
  process.stdout.write(`LONG_SESSION calls=${data.stats.ownCalls} runs=${data.runs.length} gaps=${data.idleGaps.length} bins=${data.ownCallBins.length} bytes=${Buffer.byteLength(response.body, "utf8")} cap=${RESPONSE_CAPS_V4["/api/session/<id>"]}\n`);
}, 120_000);

it("Session timezone changes no server grouping or SQL work", () => {
  seed([call("first", S - 1), call("last", S + 2 * D + 1)]);
  const utc = traceStatements(), first = querySession(ctx, H, "UTC");
  vi.restoreAllMocks(); refresh();
  const kathmandu = traceStatements(), second = querySession(ctx, H, "Asia/Kathmandu");
  expect(second).toEqual(first);
  expect(kathmandu.executed).toEqual(utc.executed);
});

it("50000 idle gaps are binned under the full envelope cap with honest raw stats", async () => {
  seed(Array.from({ length: 50001 }, (_, i) => call(`gap-${i}`, S + Math.floor(i/2)*13*M+(i%2)*6*M, 1)));
  const response = await reply(H);
  const data = (JSON.parse(response.body) as ApiEnvelope<SessionData>).data;
  expect(response.status).toBe(200);
  expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(RESPONSE_CAPS_V4["/api/session/<id>"]);
  expect(data).toHaveProperty("detailsBinned", true);
  expect(data.stats).toMatchObject({ ownCalls: 50001, idleGaps: 50000 });
  expect(data.idleGaps.length).toBeLessThan(50000);
  expect(data.idleGaps.every(gap=>[6*M,7*M].includes(gap.end-gap.start))).toBe(true);
  expect(data.idleGaps.filter(gap=>gap.end-gap.start===7*M)).toHaveLength(25000);
  expect(data.stats.omittedIdleGaps?.count).toBe(50000-data.idleGaps.length);
  expect(data.stats.omittedIdleGaps!.count).toBeGreaterThan(0);
  expect(data.idleGaps.reduce((n, gap) => n + (gap.cacheWriteCredits ?? 0), 0)+(data.stats.omittedIdleGaps?.cacheWriteCredits??0)).toBe(50000);
  expect(sumValues(data.ownCallBins.map(bin => bin.value))).toMatchObject({ calls: 50001, credits: 50001 });
  process.stdout.write(`BINNED_GAPS raw=50000 wire=${data.idleGaps.length} bytes=${Buffer.byteLength(response.body)}\n`);
}, 120_000);

it("cap-level active periods retain exact own totals when adjacent transit bins merge", async () => {
  seed(Array.from({ length: 8000 }, (_, i) => call(`period-${i}`, S + i * 31 * M)));
  const response = await reply(H);
  const data = (JSON.parse(response.body) as ApiEnvelope<SessionData>).data;
  expect(response.status).toBe(200);
  expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(RESPONSE_CAPS_V4["/api/session/<id>"]);
  expect(data).toHaveProperty("detailsBinned", true);
  expect(data.stats).toMatchObject({ ownCalls: 8000, idleGaps: 7999 });
  expect(data.ownCallBins.length).toBeLessThan(8000);
  expect(data.activePeriods).toEqual(data.ownCallBins.map(({ start, end }) => ({ start, end })));
  expect(sumValues(data.ownCallBins.map(bin => bin.value))).toMatchObject({ calls: 8000, credits: 8000 });
}, 120_000);

it("a run-heavy response uses overflow summaries without changing raw run count or header", async () => {
  seed([call("valuable",S,100000,{actor:"subagent",runId:"run-7999",sessionId:"child"})], Array.from({ length: 8000 }, (_, i) => run(`run-${i}`, { name: "Synthetic run ".repeat(6) })),[human(),human("child",H)]);
  const response = await reply(H);
  const data = (JSON.parse(response.body) as ApiEnvelope<SessionData>).data;
  expect(response.status).toBe(200);
  expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(RESPONSE_CAPS_V4["/api/session/<id>"]);
  expect(data).toHaveProperty("detailsBinned", true);
  expect(data.stats.runs).toBe(8000);
  expect(data.runs.length).toBeLessThan(8000);
  expect(data.runs.some(row=>row.id===null && row.model===null && row.status===null)).toBe(true);
  expect(data.runs.find(row=>row.id==="run-7999")?.value.credits).toBe(100000);
  expect(data.runs.filter(row=>row.id!==null).length).toBeGreaterThan(1000);
  expect(sumValues(data.runs.map(row => row.value))).toEqual(data.total);
}, 120_000);

it("high model cardinality uses overflow model summaries while flow still reconciles", async () => {
  seed(Array.from({ length: 5000 }, (_, i) => call(`model-${i}`, S + i * 6 * M, 1, { model: `synthetic-model-${i}` })));
  const response = await reply(H);
  const data = (JSON.parse(response.body) as ApiEnvelope<SessionData>).data;
  expect(response.status).toBe(200);
  expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(RESPONSE_CAPS_V4["/api/session/<id>"]);
  expect(data).toHaveProperty("detailsBinned", true);
  expect(data.models.length).toBeLessThan(5000);
  expect(data.total).toMatchObject({ credits: 5000, calls: 5000 });
  expect(sumValues(data.models.map(row => row.value))).toEqual(data.total);
  expect(sumValues(data.flow.edges.map(row => row.value))).toEqual(data.total);
  expect(data.flow.models).toEqual(data.models);
  expect(data.flow.edges.every(edge => data.models.some(model => model.id === edge.model))).toBe(true);
}, 120_000);
