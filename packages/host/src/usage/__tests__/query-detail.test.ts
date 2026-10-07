import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import * as selection from "../dashboard-selection.js";
import { countedUsageSql, storedSelection } from "../schema.js";
import { queryExplorer } from "../query-explorer.js";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardReader } from "../dashboard-contract.js";
import { decodeCursor, encodeCursor } from "../dashboard-selection.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

let fixture: ReturnType<typeof createDashboardFixture>;
let reader: DashboardReader;
beforeEach(() => {
  fixture = createDashboardFixture(false);
  reader = openDashboardReader(fixture.file, { instanceId: "detail-fixture", now: () => DASHBOARD_NOW,
    calibrationMode: () => "auto", serverBuild: "fixture-build" })!;
});
afterEach(() => { vi.restoreAllMocks(); reader.close(); fixture.close(); });
const priced = (aic: number) => ({ status: "priced" as const, aic,
  components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 },
  rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" as const });
const period = () => ({ start: M + 2 * D, end: M + 2 * D + 500000, filters: [] });
const api = () => import("../query-detail.js").catch(() => null);

// Breaks if detail selection loses ties, scopes before global provenance, uses
// current rather than period-end calibration, or constructs the chart from a page.
it("timeline covers all selected calls", async () => {
  const calls = Array.from({ length: 450 }, (_, i) => dashboardCall(`call-${i}`, {
    ts: M + 2 * D + Math.floor(i / 2) * 1000, sessionId: "timeline-session", runId: "timeline-run",
    actor: "subagent", project: join(process.env.HOME!, "projects", "alpha"), repo: join(process.env.HOME!, "repos", "alpha"),
    sourceFile: join(process.env.HOME!, "transcripts", "child.jsonl"),
    price: i === 449 ? { status: "unpriced", reason: "unknown-model" } : priced(i === 0 ? 0 : 2),
  }));
  fixture.ledger.apply(dashboardBatch([
    ...calls,
    dashboardCall("native-outside", { responseId: "outside-native", ts: M }),
    dashboardCall("suppressed-copy", { responseId: "outside-native", copied: true, sourceFile: "synthetic/fork.jsonl",
      sessionId: "timeline-session", runId: "timeline-run", ts: M + 2 * D }),
    dashboardCall("calibration", { ts: M, sessionId: "account-only", price: priced(999) }),
    ...Array.from({ length: 9500 }, (_, i) => dashboardCall(`noise-${i}`, { ts: M + 3 * D, sessionId: "noise-session", runId: "noise-run" })),
  ]));
  fixture.ledger.insertCounter({ ts: M, creditsUsed: 0, raw: {} });
  fixture.ledger.insertCounter({ ts: M + D, creditsUsed: 500, raw: {} });
  fixture.ledger.insertCounter({ ts: M + 8 * D, creditsUsed: 9500, raw: {} });
  const mod = await api();
  expect(mod, "Task 7 detail API must exist").not.toBeNull();
  for (const [kind, id] of [["session", "timeline-session"], ["run", "timeline-run"]] as const) {
    {
      const ctx = reader.snapshot(ctx => ctx);
      const statements: { sql: string; args: unknown[] }[] = [];
      const prepare = ctx.db.prepare.bind(ctx.db);
      const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
        const statement = prepare(sql);
        for (const method of ["get", "all"] as const) {
          const run = statement[method].bind(statement);
          vi.spyOn(statement, method).mockImplementation((...args) => { statements.push({ sql, args }); return run(...args); });
        }
        return statement;
      });
      let cursor: string | undefined;
      const pages = [];
      do {
        const before = statements.length;
        const result = reader.snapshot(ctx => mod!.queryDetail(ctx, { kind, id, slice: period(), page: { limit: 200, cursor } }));
        const request = statements.slice(before).filter(s => !s.sql.includes("call-selection-revision"));
        expect(request.length).toBeLessThanOrEqual(6);
        const counted = request.filter(s => s.sql.includes("call_key") && s.sql.includes("window AS MATERIALIZED"));
        expect(counted).toHaveLength(1);
        pages.push(result);
        cursor = result.calls.nextCursor ?? undefined;
        expect(pages.length).toBeLessThanOrEqual(3);
      } while (cursor);
      spy.mockRestore();
      expect(pages.map(page => page.calls.rows.length)).toEqual([200, 200, 50]);
      const rows = pages.flatMap(page => page.calls.rows);
      expect(new Set(rows.map(row => row.id)).size).toBe(450);
      expect(rows.every(row => row.measure.tokens.prompt === 60 && row.measure.tokens.total === 70)).toBe(true);
      expect(rows.find(row => row.measure.aic === 0)!.measure.aicDisplay.primaryAic).toBe(0);
      expect(rows.find(row => row.measure.unpricedCalls === 1)!.measure.aicDisplay.primaryAic).toBeNull();
      const first = pages[0]!;
      expect(first.calibration).toMatchObject({ status: "calibrated", factor: 0.5, windowEnd: M + D });
      expect(first.totals).toMatchObject({ calls: 450, pricedCalls: 449, unpricedCalls: 1, aggregateCalls: 0,
        aic: 896, aicDisplay: { primaryAic: 448, publishedAic: 896, basis: "calibrated" },
        tokens: { input: 4500, cacheRead: 9000, cacheWrite: 13500, output: 4500, cacheWrite1h: 2250,
          reasoning: 1800, prompt: 27000, total: 31500 } });
      expect(first.contextFillPercent).toBeNull();
      expect(first.contextFillMessage).toBe("Context fill unavailable: historical window not recorded");
      expect(first.composition).toEqual({ status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" });
      expect(first.timeline.length).toBeGreaterThan(1);
      expect(first.timeline.length).toBeLessThanOrEqual(200);
      expect(first.timeline.reduce((sum, point) => sum + point.measure.calls, 0)).toBe(450);
      expect(first.timeline.reduce((sum, point) => sum + point.measure.tokens.prompt, 0)).toBe(27000);
      expect(first.timeline.reduce((sum, point) => sum + (point.measure.aic ?? 0), 0)).toBe(896);
      expect(first.timeline.reduce((sum, point) => sum + (point.measure.aicDisplay.primaryAic ?? 0), 0)).toBe(448);
      expect(pages.slice(1).every(page => JSON.stringify(page.timeline) === JSON.stringify(first.timeline))).toBe(true);
      expect(rows[0]!.project!.label).toBe("~/projects/alpha");
      expect(rows[0]!.repo!.label).toBe("~/repos/alpha");
      expect(rows[0]!.project!.key).toMatch(/^v1_[A-Za-z0-9_-]{43}$/);
      const wire = JSON.stringify(pages);
      expect(wire).not.toContain(process.env.HOME!);
      expect(wire).not.toContain("sourceFile");
      expect(JSON.stringify(first).match(/"calibration":/g)).toHaveLength(1);
      const cursorContents = JSON.stringify(decodeCursor(first.calls.nextCursor!, "detail-calls", ctx.revision,
        { kind, id, slice: period(), limit: 200 }));
      expect(cursorContents).not.toContain(process.env.HOME!);
      expect(cursorContents).not.toContain("synthetic/");
      const callPasses = statements.filter(s => s.sql.includes("window AS MATERIALIZED"));
      const plans = callPasses.flatMap(s => prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.args));
      const details = plans.map(row => (row as { detail: string }).detail).join("\n");
      expect(details).toContain(kind === "session" ? "SEARCH c USING INDEX calls_session_read (session_id=? AND ts>? AND ts<?)" : "SEARCH c USING INDEX calls_run_detail (run_id=?)");
      const roots = prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name IN ('calls','runs_meta')").all() as { rootpage: number }[];
      for (const statement of callPasses) {
        const ops = prepare(`EXPLAIN ${statement.sql}`).all(...statement.args) as { opcode: string; p1: number; p2: number }[];
        const tableCursors = ops.filter(op => op.opcode === "OpenRead" && roots.some(root => root.rootpage === op.p2)).map(op => op.p1);
        expect(ops.some(op => op.opcode === "Rewind" && tableCursors.includes(op.p1))).toBe(false);
      }
      // Each page above independently enforces <= 6 statements, including calibration.
      // Revision reads are the reader's snapshot boundary, not detail work.
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(512 * 1024);
    }
  }
});

// Breaks if a covered representation is returned as priced zero or if ancestry
// without proof suppresses usage. The covering report deliberately lies outside the slice.
it("covered run explains report representation", async () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("outer-report", { actor: "subagent", runId: "outer-run", aggregate: true, sourceKind: "report", ts: M, price: priced(8) }),
    dashboardCall("covered", { actor: "aux", runId: "covered-run", ts: M + 2 * D, price: priced(32) }),
    dashboardCall("nested-report", { actor: "subagent", runId: "middle-run", aggregate: true, sourceKind: "report", ts: M + 2 * D, price: priced(64) }),
    dashboardCall("unknown", { actor: "aux", runId: "unknown-run", parentRunId: "outer-run", ts: M + 2 * D, price: priced(4) }),
    dashboardCall("aggregate", { actor: "subagent", runId: "aggregate-run", aggregate: true, sourceKind: "report", ts: M + 2 * D, price: priced(16) }),
    dashboardCall("replaced", { actor: "subagent", runId: "replaced-run", aggregate: true, sourceKind: "report", ts: M + 2 * D, price: priced(128) }),
    dashboardCall("native-replacement", { actor: "subagent", runId: "replaced-run", ts: M + 3 * D, price: priced(2) }),
    dashboardCall("unpriced", { runId: "unpriced-run", ts: M + 2 * D, price: { status: "unpriced", reason: "unknown-model" } }),
    dashboardCall("zero", { runId: "zero-run", ts: M + 2 * D, price: priced(0) }),
  ], { coverageEdges: [
    { reportRunId: "outer-run", includedRunId: "middle-run", evidence: "runs-db" },
    { reportRunId: "middle-run", includedRunId: "covered-run", evidence: "transcript" },
    { reportRunId: "outer-run", includedRunId: "unknown-run", evidence: "unknown" },
  ] }));
  const mod = await api();
  expect(mod).not.toBeNull();
  const detail = (id: string) => reader.snapshot(ctx => mod!.queryDetail(ctx, { kind: "run", id, slice: period(), page: { limit: 50 } }));
  const covered = detail("covered-run");
  expect(covered.accounting).toEqual({ status: "covered", coveringRunId: "outer-run",
    message: "Usage is included in the selected covering run report; this is not priced zero." });
  expect(covered.totals).toMatchObject({ calls: 0, aic: null, pricedCalls: 0, unpricedCalls: 0,
    aicDisplay: { primaryAic: null, publishedAic: null, basis: "published" } });
  expect(covered.timeline).toEqual([]);
  expect(covered.calls.rows).toEqual([]);
  expect(detail("middle-run").accounting).toEqual(covered.accounting);
  const unknown = detail("unknown-run");
  expect(unknown.totals).toMatchObject({ calls: 1, aic: 4, possibleOverlap: true });
  expect(unknown.accounting.status).toBe("selected");
  const aggregate = detail("aggregate-run");
  expect(aggregate.totals).toMatchObject({ calls: 1, aggregateCalls: 1, aic: 16, tokens: { prompt: 60, total: 70 } });
  expect(aggregate.accounting.status).toBe("aggregate");
  expect(aggregate.calls.rows[0]!.aggregate).toBe(true);
  const replaced = detail("replaced-run");
  expect(replaced.accounting.status).toBe("replaced");
  expect(replaced.totals.aic).toBeNull(); // Native detail outside the slice replaces the report globally.
  expect(detail("unpriced-run").totals).toMatchObject({ calls: 1, unpricedCalls: 1, aic: null });
  expect(detail("zero-run").totals).toMatchObject({ calls: 1, pricedCalls: 1, aic: 0 });
});

// Breaks if session lookup scans metadata, copied observations become links,
// duplicate metadata produces duplicates, or a child transcript is labelled its reporting session.
it("session links use migrated index and correct identity", async () => {
  const runs = Array.from({ length: 450 }, (_, i) => ({
    id: `run-${String(i).padStart(3, "0")}`, dbPath: join(process.env.HOME!, "projects", "a", "project.db"),
    project: join(process.env.HOME!, "projects", "a"), repo: null,
    sessionId: i % 2 === 0 ? "reporting-session" : "nested-session", parentRunId: i % 2 ? `run-${String(i - 1).padStart(3, "0")}` : null,
    agent: "worker", role: "worker", name: i === 0 ? `review ${process.env.HOME!}/private/file` : `Run ${i}`,
    model: "fixture-model", thinking: "high", phase: "work", startedAt: M, endedAt: i % 2 === 0 ? null : M + D,
  }));
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("native-child", { actor: "subagent", sessionId: "child-transcript", runId: "run-000", ts: M + 2 * D }),
    dashboardCall("copy-child", { actor: "subagent", sessionId: "fork-transcript", runId: "run-000", copied: true,
      responseId: "child-copy", sourceFile: "synthetic/copy.jsonl", ts: M + 2 * D }),
    dashboardCall("run-report", { actor: "subagent", sessionId: "reporting-session", runId: "run-000", aggregate: true, sourceKind: "report", ts: M + 2 * D }),
  ], { runs: [...runs, ...runs.slice(0, 20).map(run => ({ ...run, dbPath: "synthetic/z-copy.db" }))] }));
  const mod = await api();
  expect(mod).not.toBeNull();
  expect(mod!.queryDetailLinks, "bounded links API must exist").toBeTypeOf("function");
  const ctx = reader.snapshot(ctx => ctx);
  const statements: { sql: string; args: unknown[] }[] = [];
  const prepare = ctx.db.prepare.bind(ctx.db);
  const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    for (const method of ["get", "all"] as const) {
      const run = statement[method].bind(statement);
      vi.spyOn(statement, method).mockImplementation((...args) => { statements.push({ sql, args }); return run(...args); });
    }
    return statement;
  });
  const pages = [];
  let cursor: string | undefined;
  do {
    const page = reader.snapshot(ctx => mod!.queryDetailLinks(ctx, { kind: "session", id: "reporting-session", slice: period(), page: { limit: 200, cursor } }));
    pages.push(page); cursor = page.nextCursor ?? undefined;
    expect(pages.length).toBeLessThanOrEqual(3);
  } while (cursor);
  spy.mockRestore();
  expect(pages.map(page => page.rows.length)).toEqual([200, 200, 50]);
  const rows = pages.flatMap(page => page.rows);
  expect(new Set(rows.map(row => row.id)).size).toBe(450);
  expect(rows.every(row => row.kind === "run" && row.relationship === "child")).toBe(true);
  expect(rows.filter(row => row.ongoing)).toHaveLength(225);
  expect(JSON.stringify(pages)).not.toContain(process.env.HOME!);
  expect(JSON.stringify(pages)).not.toContain("dbPath");
  expect(Buffer.byteLength(JSON.stringify(pages[0]))).toBeLessThanOrEqual(64 * 1024);
  expect(statements.filter(s => !s.sql.includes("call-selection-revision"))).toHaveLength(6);
  const plans = statements.filter(s => !s.sql.includes("call-selection-revision")).flatMap(s => prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.args));
  const details = plans.map(row => (row as { detail: string }).detail).join("\n");
  expect(details).toMatch(/SEARCH (?:runs_meta|r) USING (?:COVERING )?INDEX runs_meta_session \(session_id=\?\)/);
  expect(details).toMatch(/SEARCH r USING (?:COVERING )?INDEX runs_meta_parent \(parent_run_id=\?\)/);
  expect(details).not.toMatch(/SCAN (?:runs_meta|calls)\b/);
  // UNION currently emits tied labels in id order even without the window's
  // id tie-breaker. Check the executed ordinal sort, not that incidental order.
  for (const statement of statements.filter(s => s.sql.includes("linked(id)"))) {
    const ops = prepare(`EXPLAIN ${statement.sql}`).all(...statement.args) as { opcode: string; p4: string | null }[];
    expect(ops.filter(op => op.opcode === "SorterOpen").at(-1)?.p4).toBe("k(3,B,B,B)");
  }
  const runLinks = reader.snapshot(ctx => mod!.queryDetailLinks(ctx, { kind: "run", id: "run-000", slice: period(), page: { limit: 200 } }));
  expect(runLinks.rows.map(row => [row.relationship, row.kind, row.id])).toEqual([
    ["child", "run", "run-001"], ["reporting-session", "session", "reporting-session"], ["transcript-session", "session", "child-transcript"],
  ]);
  const nestedLinks = reader.snapshot(ctx => mod!.queryDetailLinks(ctx, { kind: "run", id: "run-001", slice: period(), page: { limit: 200 } }));
  expect(nestedLinks.rows.map(row => [row.relationship, row.kind, row.id])).toEqual([
    ["parent", "run", "run-000"], ["reporting-session", "session", "nested-session"],
  ]);
  const childSession = reader.snapshot(ctx => mod!.queryDetailLinks(ctx, { kind: "session", id: "child-transcript", slice: period(), page: { limit: 200 } }));
  expect(childSession.rows.map(row => [row.relationship, row.kind, row.id])).toContainEqual(["run", "run", "run-000"]);
  const detail = reader.snapshot(ctx => mod!.queryDetail(ctx, { kind: "run", id: "run-000", slice: period(), page: { limit: 200 } }));
  expect(detail.links).toEqual(runLinks);
  expect(detail.totals).toMatchObject({ calls: 2, aggregateCalls: 0, aic: 2, possibleUndercount: true });
});

it("detail routes reject invalid parameters before SQL", async () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("route-call", { ts: M + 2 * D, sessionId: "route-session" })]));
  const mod = await api();
  expect(mod!.DETAIL_ROUTES, "detail routes must be registered").toBeDefined();
  expect(mod!.DETAIL_ROUTES.map(route => route.path)).toEqual(["/api/detail", "/api/detail-links"]);
  const ctx = reader.snapshot(ctx => ctx);
  const valid = `kind=session&id=route-session&start=${period().start}&end=${period().end}`;
  for (const route of mod!.DETAIL_ROUTES) {
    for (const query of ["", "kind=session", "kind=other&id=route-session", `${valid}&id=duplicate`, `${valid}&unknown=x`,
      `${valid}&limit=201`, `${valid}&limit=0`, `${valid}&limit=1.5`, `${valid}&cursor=bad!`,
      "kind=run&id=%2Fprivate%2Fpath", "kind=run&id=x&start=1", `${valid}&filters=${encodeURIComponent(JSON.stringify([{ field: "project", value: "/private/path" }]))}`,
      `${valid}&filters=${encodeURIComponent(JSON.stringify([{ field: "model", value: "x".repeat(1025) }]))}`]) {
      const spy = vi.spyOn(ctx.db, "prepare");
      expect(() => route.handle(ctx, new URLSearchParams(query))).toThrow("invalid-query");
      expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
    }
    expect(() => route.handle(ctx, new URLSearchParams(valid.replace("route-session", "missing-session")))).toThrow("not-found");
  }
  const result = mod!.DETAIL_ROUTES[0]!.handle(ctx, new URLSearchParams(valid));
  expect(result).toMatchObject({ kind: "session", id: "route-session", totals: { calls: 1, tokens: { prompt: 60 } } });
  expect(mod!.DETAIL_ROUTES[1]!.handle(ctx, new URLSearchParams(valid))).toEqual({ rows: [], nextCursor: null });
});

it("malformed cursor keys fail before identity probes", async () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("key-call", { ts: M + 2 * D, sessionId: "key-session" })]));
  const mod = await api();
  const ctx = reader.snapshot(ctx => ctx);
  const query = { kind: "session" as const, id: "key-session", slice: period(), page: { limit: 50 } };
  const binding = { kind: query.kind, id: query.id, slice: query.slice, limit: 50 };
  for (const [endpoint, key] of [
    ["detail-calls", [period().start - 1, "a".repeat(64)]], ["detail-calls", [period().end, "a".repeat(64)]],
    ["detail-links", ["child", "run", "/private/path"]], ["detail-links", ["unknown", "run", "run-id"]],
  ] as const) {
    const cursor = encodeCursor(endpoint, ctx.revision, binding, key);
    const spy = vi.spyOn(ctx.db, "prepare");
    const call = endpoint === "detail-calls" ? mod!.queryDetail : mod!.queryDetailLinks;
    expect(() => call(ctx, { ...query, page: { limit: 50, cursor } })).toThrow("invalid-query");
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
  }
});

it("detail cursors bind the complete query and call content", async () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 3 }, (_, i) => dashboardCall(`cursor-${i}`, { ts: period().start + i, sessionId: "cursor-session" })), {
    runs: Array.from({ length: 3 }, (_, i) => ({ id: `cursor-run-${i}`, dbPath: "synthetic/project.db", project: null, repo: null,
      sessionId: "cursor-session", parentRunId: null, agent: null, role: null, name: null, model: null, thinking: null, phase: null, startedAt: M, endedAt: M + D })),
  }));
  const mod = await api();
  const query = { kind: "session" as const, id: "cursor-session", slice: period(), page: { limit: 1 } };
  for (const [index, call] of [mod!.queryDetail, mod!.queryDetailLinks].entries()) {
    let ctx = reader.snapshot(ctx => ctx);
    const result = call(ctx, query);
    const page = "calls" in result ? result.calls : result;
    const cursor = page.nextCursor!;
    expect(cursor).not.toBeNull();
    for (const change of [{ id: "another-session" }, { kind: "run" as const }, { slice: { ...period(), end: period().end - 1 } },
      { slice: { ...period(), filters: [{ field: "actor" as const, value: "parent" }] } }, { page: { limit: 2, cursor } }]) {
      const spy = vi.spyOn(ctx.db, "prepare");
      expect(() => call(ctx, { ...query, page: { limit: 1, cursor }, ...change })).toThrow("invalid-query");
      expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
    }
    fixture.db.prepare("INSERT INTO leases(name,owner) VALUES ('ingest','synthetic-owner') ON CONFLICT(name) DO UPDATE SET owner=excluded.owner").run();
    const next = reader.snapshot(ctx => call(ctx, { ...query, page: { limit: 1, cursor } }));
    expect(("calls" in next ? next.calls : next).rows[0]!.id).not.toBe(page.rows[0]!.id);
    fixture.ledger.apply(dashboardBatch([dashboardCall(`cursor-mutation-${index}`, { ts: period().start, sessionId: "cursor-session" })]));
    ctx = reader.snapshot(ctx => ctx);
    const spy = vi.spyOn(ctx.db, "prepare");
    expect(() => call(ctx, { ...query, page: { limit: 1, cursor } })).toThrow("ledger-changed");
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
  }
});

it("detail path filters use opaque identities", async () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("path-one", { ts: period().start, project: join(process.env.HOME!, "projects", "one"), repo: null }),
    dashboardCall("path-two", { ts: period().start + 1, project: join(process.env.HOME!, "projects", "two"), repo: join(process.env.HOME!, "repos", "two") }),
  ]));
  const mod = await api();
  const query = { kind: "session" as const, id: "parent-session", slice: period(), page: { limit: 50 } };
  const all = reader.snapshot(ctx => mod!.queryDetail(ctx, query));
  const explorer = reader.snapshot(ctx => queryExplorer(ctx, { slice: period(), groupBy: ["project", "repo"], page: { limit: 50 } }));
  const key = explorer.rows.find(row => row.labels[0] === "~/projects/one")!.key[0]!;
  expect(all.calls.rows.find(row => row.project?.label === "~/projects/one")!.project!.key).toBe(key);
  const repoKey = explorer.rows.find(row => row.labels[1] === "~/repos/two")!.key[1]!;
  const byRepo = reader.snapshot(ctx => mod!.queryDetail(ctx, { ...query, slice: { ...period(),
    filters: [{ field: "repo", kind: "id", value: repoKey }] } }));
  expect(byRepo.totals.calls).toBe(1);
  expect(byRepo.calls.rows[0]!.repo).toEqual({ key: repoKey, label: "~/repos/two" });
  const selected = reader.snapshot(ctx => mod!.queryDetail(ctx, { ...query, slice: { ...period(), filters: [{ field: "project", kind: "id", value: key }, { field: "repo", kind: "missing" }] } }));
  expect(selected.totals).toMatchObject({ calls: 1, aic: 1, tokens: { prompt: 60, total: 70 } });
  expect(selected.calls.rows).toHaveLength(1);
  expect(selected.timeline.reduce((sum, point) => sum + point.measure.calls, 0)).toBe(1);
  expect(selected.calls.rows[0]!.repo).toBeNull();
});

it("historical detail back-applies only the earliest fit and keeps gaps published", async () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("history", { sessionId: "history-session", ts: M - D, price: priced(100) }),
    dashboardCall("account", { sessionId: "account-session", ts: M, price: priced(1000) }),
    dashboardCall("gap", { sessionId: "history-session", ts: M + 10 * D, price: priced(20) }),
  ]));
  fixture.ledger.insertCounter({ ts: M, creditsUsed: 0, raw: {} });
  fixture.ledger.insertCounter({ ts: M + D, creditsUsed: 500, raw: {} });
  fixture.ledger.insertCounter({ ts: M + 10 * D, creditsUsed: 600, raw: {} });
  const mod = await api();
  const query = { kind: "session" as const, id: "history-session", slice: { start: M - D, end: M, filters: [] }, page: { limit: 50 } };
  const history = reader.snapshot(ctx => mod!.queryDetail(ctx, query));
  expect(history.calibration).toMatchObject({ factor: 0.5, windowEnd: M + D });
  for (const measure of [history.totals, history.calls.rows[0]!.measure, history.timeline[0]!.measure]) {
    expect(measure.aicDisplay).toEqual({ primaryAic: 50, publishedAic: 100, basis: "back-applied" });
    expect(measure.tokens).toMatchObject({ prompt: 60, total: 70 });
  }
  const gap = reader.snapshot(ctx => mod!.queryDetail(ctx, { ...query, slice: { start: M + 10 * D, end: M + 10 * D + 1, filters: [] } }));
  expect(gap.calibration.status).toBe("uncalibrated");
  expect(gap.totals.aicDisplay).toEqual({ primaryAic: 20, publishedAic: 20, basis: "published" });
  const off = reader.snapshot(ctx => mod!.queryDetail({ ...ctx, calibrationMode: "off" }, query));
  expect(off.calibration.status).toBe("off");
  expect(off.totals.aicDisplay).toEqual({ primaryAic: 100, publishedAic: 100, basis: "published" });
});


// Breaks if /200 becomes /250: this fills every one of the 200 allowed buckets.
it("dense timelines cap the whole slice at 200 buckets", async () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 1000 }, (_, i) => dashboardCall(`dense-${i}`, {
    ts: period().start + i, sessionId: "dense-session",
  }))));
  const mod = await api();
  const data = reader.snapshot(ctx => mod!.queryDetail(ctx, { kind: "session", id: "dense-session",
    slice: { start: period().start, end: period().start + 1000, filters: [] }, page: { limit: 1 } }));
  expect(data.timeline).toHaveLength(200);
  expect(data.timeline.every(bucket => bucket.measure.calls === 5)).toBe(true);
  expect(data.timeline.reduce((n, bucket) => n + bucket.measure.calls, 0)).toBe(1000);
});

// Breaks when Detail uses a different identity scheme, hashes unsupported ids,
// exposes absolute paths or fails to redact common free-text path contexts.
it("Explorer keys round-trip to Detail and unsupported ids still count without a key", async () => {
  const home = join(fixture.root, "home with spaces");
  mkdirSync(home);
  process.env.HOME = home;
  const outside = join(fixture.root, "outside home", "external project");
  const fields = { role: `--cwd=${home}/Private Docs/work`, agent: `[${home}/secret]`,
    runName: `\`${home}/secret\``, phase: `a,${home}/secret`, auxPurpose: "\\\\server\\share\\secret",
    model: `file://${home}/secret`, requestedModel: "cwd=C:\\private\\secret", thinking: `path:${home}/secret` };
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("round-trip", { ts: period().start, sessionId: "stored:session", runId: "stored:run",
      project: join(home, "projects", "alpha beta"), repo: outside, ...fields }),
    dashboardCall("unsupported", { ts: period().start + 1, sessionId: join(home, "sessions", "bad"),
      runId: join(outside, "run"), parentRunId: join(home, "parent"), project: outside, repo: join(home, "repo space", "alpha") }),
  ]));
  const mod = await api();
  for (const [field, id] of [["session", "stored:session"], ["run", "stored:run"]] as const) {
    const explorer = reader.snapshot(ctx => queryExplorer(ctx, { slice: period(), groupBy: [field], page: { limit: 50 } }));
    expect(explorer.totals.calls).toBe(2);
    expect(explorer.rows.find(row => row.labels[0] === "unsupported id")).toMatchObject({ key: [null], measure: { calls: 1 } });
    const key = explorer.rows.find(row => row.labels[0] === id)!.key[0]!;
    expect(key).toBe(id);
    const detail = reader.snapshot(ctx => mod!.queryDetail(ctx, { kind: field, id: key, slice: period(), page: { limit: 50 } }));
    expect(detail.id).toBe(key);
    expect(detail.totals.calls).toBe(1);
    expect(detail.calls.rows[0]).toMatchObject({ sessionId: "stored:session", runId: "stored:run",
      project: { label: "~/projects/alpha beta" }, repo: { label: "…/outside home/external project" } });
    const wire = JSON.stringify([explorer, detail]);
    for (const absolute of [home, outside, fixture.root, "\\\\server\\share", "C:\\private"]) {
      expect(wire).not.toContain(JSON.stringify(absolute).slice(1, -1));
    }
    expect(detail.calls.rows[0]!.model).toMatch(/^file:/);
    const ctx = reader.snapshot(ctx => ctx);
    const spy = vi.spyOn(ctx.db, "prepare");
    for (const bad of [join(home, "bad"), "with space", "a".repeat(129), "id\n"]) {
      expect(() => mod!.queryDetail(ctx, { kind: field, id: bad, slice: period(), page: { limit: 50 } })).toThrow("invalid-query");
    }
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
  }
  // A supported owner can display unsupported run/session observations, but never offers a dead drill-in key.
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("unsupported-run", { ts: period().start + 2, sessionId: "owner", runId: join(outside, "run") }),
    dashboardCall("unsupported-session", { ts: period().start + 3, sessionId: join(home, "session"), runId: "owner-run" }),
  ]));
  const detail = reader.snapshot(ctx => mod!.queryDetail(ctx, { kind: "session", id: "owner", slice: period(), page: { limit: 1 } }));
  expect(detail.totals.calls).toBe(1);
  expect(detail.calls.rows[0]!.runId).toBeNull();
  expect(detail.links.rows).toMatchObject([{ id: null, label: "unsupported id" }]);
  const run = reader.snapshot(ctx => mod!.queryDetail(ctx, { kind: "run", id: "owner-run", slice: period(), page: { limit: 1 } }));
  expect(run.calls.rows[0]!.sessionId).toBeNull();
  expect(run.links.rows).toMatchObject([{ id: null, label: "unsupported id" }]);
  expect(JSON.stringify([detail, run])).not.toContain(fixture.root);
});

// Breaks when labels prefer the last metadata copy, the clamp expands, or copied
// session observations become owner-run links. Metadata names deliberately differ.
it("links choose first metadata, clamp labels and ignore session copies", async () => {
  const metadata = { id: "named-run", dbPath: "synthetic/a.db", project: null, repo: null,
    sessionId: "reporter", parentRunId: null, agent: null, role: null, name: "😀".repeat(200),
    model: null, thinking: null, phase: null, startedAt: M, endedAt: M + D };
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("copy-link", { ts: period().start, sessionId: "copy-session", runId: "copy-run", copied: true }),
    dashboardCall("clamped", { ts: period().start, sessionId: "labels", runId: "named-run", role: "r".repeat(200) }),
  ], { runs: [metadata, { ...metadata, dbPath: "synthetic/z.db", name: "wrong metadata", endedAt: null }] }));
  const mod = await api();
  const copy = reader.snapshot(ctx => mod!.queryDetailLinks(ctx, { kind: "session", id: "copy-session", slice: period(), page: { limit: 50 } }));
  expect(copy).toEqual({ rows: [], nextCursor: null });
  const links = reader.snapshot(ctx => mod!.queryDetailLinks(ctx, { kind: "session", id: "reporter", slice: period(), page: { limit: 50 } }));
  expect(links.rows).toEqual([{ kind: "run", id: "named-run", relationship: "child", label: "😀".repeat(160), ongoing: false }]);
  const detail = reader.snapshot(ctx => mod!.queryDetail(ctx, { kind: "session", id: "labels", slice: period(), page: { limit: 50 } }));
  expect(detail.calls.rows[0]!.role).toBe("r".repeat(160));
});

// A SQL UNION ALL regression blocks synchronously, so Vitest's own timeout cannot
// bound it. Execute only the recursive query in a child and kill it after 5 s.
it("cycles terminate and never list a run as its own child or parent", async () => {
  const run = (id: string, parentRunId: string) => ({ id, parentRunId, dbPath: "synthetic/cycles.db", project: null, repo: null,
    sessionId: "cycle-owner", agent: null, role: null, name: id, model: null, thinking: null, phase: null, startedAt: M, endedAt: M + D });
  fixture.ledger.apply(dashboardBatch([], { runs: [run("cycle-a", "cycle-b"), run("cycle-b", "cycle-a"), run("self", "self")] }));
  const bundle = join(fixture.root, "cycle-probe.mjs");
  const readerFile = fileURLToPath(new URL("../dashboard-reader.ts", import.meta.url));
  const detailFile = fileURLToPath(new URL("../query-detail.ts", import.meta.url));
  await build({ stdin: { contents: `
    import { openDashboardReader } from ${JSON.stringify(readerFile)};
    import { queryDetailLinks } from ${JSON.stringify(detailFile)};
    const reader = openDashboardReader(process.argv[2], { instanceId: 'cycle', now: () => ${DASHBOARD_NOW},
      calibrationMode: () => 'off', serverBuild: 'fixture' });
    try {
      const results = ['cycle-a','cycle-b','self'].map(id => {
        const rows = []; let cursor;
        do {
          const page = reader.snapshot(ctx => queryDetailLinks(ctx, {kind:'run',id,
            slice: {start:${period().start},end:${period().end},filters:[]},page:{limit:1,cursor}}));
          rows.push(...page.rows); cursor = page.nextCursor ?? undefined;
          if (rows.length > 6) throw new Error('links failed to finish');
        } while (cursor);
        return rows;
      });
      console.log(JSON.stringify(results));
    } finally { reader.close(); }
  `, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", packages: "external",
    alias: { "@spider/db-core": createRequire(import.meta.url).resolve("@spider/db-core") }, outfile: bundle });
  const { stdout } = await promisify(execFile)(process.execPath, [bundle, fixture.file], { timeout: 5000, killSignal: "SIGKILL" });
  const [a, b, self] = JSON.parse(stdout);
  expect(a.map((row: { id: string; relationship: string }) => [row.relationship, row.id])).toEqual([
    ["child", "cycle-b"], ["parent", "cycle-b"], ["reporting-session", "cycle-owner"],
  ]);
  expect(b.map((row: { id: string; relationship: string }) => [row.relationship, row.id])).toEqual([
    ["child", "cycle-a"], ["parent", "cycle-a"], ["reporting-session", "cycle-owner"],
  ]);
  expect(self.map((row: { id: string; relationship: string }) => [row.relationship, row.id])).toEqual([["reporting-session", "cycle-owner"]]);
});

// Re-registration invalidates SQLite prepared statements. Observe registration
// on the real connection across detail and links pages, not a fake SQL helper.
it("detail SQL helpers register once per connection", async () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("register", { ts: period().start })]));
  const mod = await api();
  const ctx = reader.snapshot(ctx => ctx);
  const spy = vi.spyOn(ctx.db.raw, "function");
  const query = { kind: "session" as const, id: "parent-session", slice: period(), page: { limit: 50 } };
  mod!.queryDetail(ctx, query);
  const registered = spy.mock.calls.length;
  expect(registered).toBeGreaterThan(0);
  mod!.queryDetail(ctx, query);
  mod!.queryDetailLinks(ctx, query);
  expect(spy.mock.calls).toHaveLength(registered);
});

// Proves the extracted projector is the same calibration/back-application path
// as readMeasure, with independent hand-computed expected AIC and token totals.
it("shared measure projector agrees with readMeasure for historical data", async () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("projection-history", { sessionId: "projection", ts: M - D, price: priced(100) }),
    dashboardCall("projection-account", { sessionId: "account", ts: M, price: priced(1000) }),
  ]));
  fixture.ledger.insertCounter({ ts: M, creditsUsed: 0, raw: {} });
  fixture.ledger.insertCounter({ ts: M + D, creditsUsed: 500, raw: {} });
  const slice = { start: M - D, end: M, filters: [] };
  const ctx = reader.snapshot(ctx => ctx);
  const resolve = selection.resolveMeasure;
  expect(resolve, "shared measure resolver must exist").toBeTypeOf("function");
  const resolved = resolve!(ctx, slice);
  const row = ctx.db.prepare(`SELECT ${selection.measureColumns} FROM (${countedUsageSql("c.session_id=?",
    selection.measureSelectionProjection, undefined, storedSelection(ctx.db))})`)
    .get("projection") as selection.MeasureRow;
  const measure = resolved.measure(row);
  expect(measure).toEqual(selection.readMeasure(ctx, slice, { sessionId: "projection" }));
  expect(measure).toMatchObject({ calls: 1, aicDisplay: { primaryAic: 50, publishedAic: 100, basis: "back-applied" },
    tokens: { prompt: 60, total: 70 } });
  expect(resolved.calibration.factor).toBe(0.5);
});
