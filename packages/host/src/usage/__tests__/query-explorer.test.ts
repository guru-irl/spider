import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryFilterValues as filterValues } from "../query-explorer.js";
import { encodeCursor } from "../dashboard-selection.js";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardQueryContext, DashboardReader, Dimension, Slice } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_NOW as NOW,
  DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";

let fixture: ReturnType<typeof createDashboardFixture>;
let reader: DashboardReader;
beforeEach(() => {
  fixture = createDashboardFixture();
  reader = openDashboardReader(fixture.file, { instanceId: "fixture-instance", now: () => NOW,
    calibrationMode: () => "auto", serverBuild: "fixture-build" })!;
});
afterEach(() => { reader.close(); fixture.close(); });
function inspect(read: (ctx: DashboardQueryContext) => void): void {
  let failure: unknown;
  reader.snapshot(ctx => { try { read(ctx); } catch (error) { failure = error; } });
  if (failure) throw failure;
}
const slice = (): Slice => ({ start: M, end: M + 3 * D, filters: [] });
// Resolve presentation literals through the public discovery API, never calculate expected ids with production hashing.
function id(ctx: DashboardQueryContext, field: Dimension, value: string): string {
  const values = filterValues(ctx, { start: M, end: NOW, filters: [] }, field, [...value].slice(0, 160).join(""), 200);
  const found = values.rows.find(row => row.label === [...value].slice(0, 160).join(""));
  if (!found?.id) throw new Error(`missing fixture value ${field}=${value}`);
  return found.id;
}
const dimensions: readonly Dimension[] = ["project", "repo", "session", "actor", "role", "agent", "provider", "model",
  "requestedModel", "thinking", "run", "runName", "phase", "parentRun", "auxPurpose", "api", "day"];
const priced = (aic: number) => ({ status: "priced" as const, aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 },
  rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" as const });
async function api() {
  const module = await import("../query-explorer.js").catch(() => null);
  expect(module, "Explorer queries must be implemented").not.toBeNull();
  return module!;
}

// Breaks if any pivot uses legacy counted flags, filters before global provenance,
// sums token subsets twice, loses unpriced calls, or applies the current rather than period-end factor.
it("every attribution pivot reconciles", async () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("tuple", { project: "other-project", repo: "other-repo", sessionId: "other-session", actor: "compaction",
      role: "Unknown", agent: "worker", provider: "other-provider", model: "other-model", requestedModel: "request-model",
      thinking: "high", runId: "tuple-run", runName: "tuple-name", phase: "test", parentRunId: "parent-run",
      auxPurpose: "reflection", api: "fixture-api", ts: M + 2 * D, price: priced(2),
      usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, cacheWrite1h: 1, reasoning: 2 } }),
    dashboardCall("priced-zero", { role: "zero", price: priced(0) }),
    dashboardCall("earlier-fit", { ts: M + 4 * D, project: "evidence", price: priced(1000) }),
    dashboardCall("later-fit", { ts: M + 12 * D, project: "evidence", price: priced(1000) }),
  ]));
  // Earliest fit is 0.5, latest is 1.0. The displayed early period must back-apply 0.5.
  for (const [day, credits] of [[4, 0], [5, 500], [12, 600], [13, 1600]]) {
    fixture.ledger.insertCounter({ ts: M + day! * D, creditsUsed: credits!, raw: {} });
  }
  const { queryExplorer } = await api();
  const groups: readonly (readonly Dimension[])[] = [...dimensions.map(field => [field]), ["role", "model"], ["project", "actor", "day"]];
  inspect(ctx => {
    for (const groupBy of groups) {
      const many = vi.spyOn(ctx.calibration, "atMany");
      const at = vi.spyOn(ctx.calibration, "at");
      const prepares = vi.spyOn(ctx.db, "prepare");
      const result = queryExplorer(ctx, { slice: slice(), groupBy, page: { limit: 200 } });
      expect(many).toHaveBeenCalledTimes(1);
      expect([...many.mock.calls[0]![0]].sort((a, b) => a - b)).toEqual(groupBy.includes("day") ? [M + 2 * D - 1, M + 3 * D - 1] : [M + 3 * D - 1]);
      expect(many.mock.calls[0]![1]).toBe("auto");
      expect(at).not.toHaveBeenCalled();
      many.mockRestore(); at.mockRestore();
      const calls = prepares.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith("WITH counted AS MATERIALIZED"));
      prepares.mockRestore();
      expect(calls).toHaveLength(1);
      expect(result.calibration).toMatchObject({ status: "calibrated", factor: 0.5, windowEnd: M + 5 * D });
      expect(result.groupBy).toEqual(groupBy);
      expect(result.totals).toMatchObject({ calls: 7, pricedCalls: 6, unpricedCalls: 1, aggregateCalls: 1, aic: 6,
        tokens: { input: 61, cacheRead: 122, cacheWrite: 183, output: 64, cacheWrite1h: 31, reasoning: 26, prompt: 366, total: 430 },
        possibleOverlap: true, possibleUndercount: true,
        aicDisplay: { primaryAic: 3, publishedAic: 6, basis: "back-applied" } });
      expect(result.rows.reduce((sum, row) => sum + row.measure.calls, 0)).toBe(7);
      expect(result.rows.reduce((sum, row) => sum + (row.measure.aic ?? 0), 0)).toBe(6);
      expect(result.rows.reduce((sum, row) => sum + (row.measure.aicDisplay.primaryAic ?? 0), 0)).toBe(3);
      expect(result.rows.reduce((sum, row) => sum + row.measure.tokens.total, 0)).toBe(430);
      expect(result.rows.reduce((sum, row) => sum + row.measure.unpricedCalls, 0)).toBe(1);
      expect(result.rows.every(row => row.key.length === groupBy.length && row.labels.length === groupBy.length)).toBe(true);
      expect(result.nextCursor).toBeNull();
      expect(JSON.stringify(result).match(/"calibration":/g)).toHaveLength(1);
    }
    const roles = queryExplorer(ctx, { slice: slice(), groupBy: ["role"], page: { limit: 50 } });
    expect(roles.rows.find(row => row.key[0] === null)!.measure.calls).toBe(3);
    expect(roles.rows.find(row => row.labels[0] === "Unknown")!.measure.calls).toBe(1);
    expect(roles.rows.find(row => row.labels[0] === "zero")!.measure.aicDisplay.primaryAic).toBe(0);
    const unpriced = queryExplorer(ctx, { slice: { ...slice(), filters: [{ kind: "id", field: "actor", value: id(ctx, "actor", "warmer") }] }, groupBy: ["role"], page: { limit: 50 } });
    expect(unpriced.rows[0]!.measure.aicDisplay).toEqual({ primaryAic: null, publishedAic: null, basis: "back-applied" });
    const fork = queryExplorer(ctx, { slice: { ...slice(), filters: [{ kind: "id", field: "session", value: "fork-session" }] }, groupBy: ["session"], page: { limit: 50 } });
    expect(fork.rows).toEqual([]); expect(fork.totals.calls).toBe(0); expect(fork.totals.aic).toBeNull();
    const filtered = queryExplorer(ctx, { slice: { ...slice(), filters: [{ kind: "id", field: "role", value: id(ctx, "role", "Unknown") }, { kind: "id", field: "day", value: id(ctx, "day", "2026-10-03") }] },
      groupBy: ["model"], page: { limit: 50 } });
    expect(filtered.calibration.factor).toBe(0.5);
    expect(filtered.totals).toMatchObject({ calls: 1, aic: 2, tokens: { total: 10 } });
    expect(filtered.totals.aicDisplay.primaryAic).toBe(1);
  });
});

// Breaks if LIKE treats user wildcards as syntax, paging skips ties/null, or values bypass counted selection.
it("filter values continue safely", async () => {
  const prefix = "value%_\\-";
  fixture.ledger.apply(dashboardBatch([
    ...Array.from({ length: 450 }, (_, i) => dashboardCall(`value-${i}`, { role: prefix + String(i).padStart(3, "0") })),
    dashboardCall("wildcard-decoy", { role: "valueAB-decoy" }),
    dashboardCall("unknown-role", { role: "Unknown" }),
    dashboardCall("hidden-copy", { role: "hidden-copy", copied: true, responseId: "outside-native", sourceFile: "synthetic/copy.jsonl" }),
    dashboardCall("outside-native", { role: "outside-native", responseId: "outside-native", ts: M - 1 }),
  ]));
  const module = await api();
  expect(typeof module.queryFilterValues, "Filter values API must exist").toBe("function");
  const { queryFilterValues } = module;
  const values: (string | null)[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    expect(pages++).toBeLessThan(10);
    const page = reader.snapshot(ctx => queryFilterValues(ctx, slice(), "role", prefix, 200, cursor));
    expect(page.rows.length).toBeLessThanOrEqual(200);
    values.push(...page.rows.map(row => row.label));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(values).toHaveLength(450);
  expect(new Set(values).size).toBe(450);
  expect([...values].sort()[0]).toBe(prefix + "000"); expect([...values].sort().at(-1)).toBe(prefix + "449");
  inspect(ctx => {
    const prepare = vi.spyOn(ctx.db, "prepare");
    const first = queryFilterValues(ctx, slice(), "role", "", 1);
    expect(first.rows).toEqual([{ id: null, label: null }]);
    expect(first.nextCursor).not.toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockRestore();
    expect(queryFilterValues(ctx, slice(), "role", "", 1, first.nextCursor!).rows).toHaveLength(1);
    expect(queryFilterValues(ctx, slice(), "role", "hidden", 50).rows).toEqual([]);
    expect(queryFilterValues(ctx, { ...slice(), filters: [{ kind: "id", field: "role", value: id(ctx, "role", prefix + "123") }] }, "role", prefix, 50).rows).toEqual([{ id: expect.any(String), label: prefix + "123" }]);
  });
});

// Breaks if pagination uses OFFSET, incomplete keys, labels as identities, or an incomplete query/revision binding.
it("cursor belongs to complete query and content", async () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 450 }, (_, i) => dashboardCall(`pivot-${i}`, {
    role: `role-${String(Math.floor(i / 3)).padStart(3, "0")}`, model: `model-${i % 3}`, thinking: i % 2 ? "high" : null,
  }))));
  const { queryExplorer, queryFilterValues } = await api();
  const groupBy: readonly Dimension[] = ["role", "model", "thinking"];
  const first = reader.snapshot(ctx => queryExplorer(ctx, { slice: slice(), groupBy, page: { limit: 200 } }));
  expect(first.rows).toHaveLength(200); expect(first.nextCursor).not.toBeNull();
  const rows = [...first.rows];
  let cursor = first.nextCursor;
  let pages = 0;
  while (cursor) {
    expect(pages++).toBeLessThan(10);
    const next = reader.snapshot(ctx => queryExplorer(ctx, { slice: slice(), groupBy, page: { limit: 200, cursor: cursor! } }));
    expect(next.rows.length).toBeLessThanOrEqual(200);
    expect(next.totals).toEqual(first.totals);
    rows.push(...next.rows); cursor = next.nextCursor;
  }
  expect(rows).toHaveLength(453);
  expect(new Set(rows.map(row => JSON.stringify(row.key))).size).toBe(453);
  expect(rows[0]!.labels).toEqual([null, "fixture-model", null]);
  expect(rows.some(row => JSON.stringify(row.labels) === JSON.stringify(["worker", "fixture-model", null]))).toBe(true);
  expect(rows.reduce((sum, row) => sum + row.measure.calls, 0)).toBe(455);
  expect(rows.reduce((sum, row) => sum + row.measure.tokens.total, 0)).toBe(31850);
  expect(rows.reduce((sum, row) => sum + (row.measure.aic ?? 0), 0)).toBe(454);
  const stable = reader.revision();
  fixture.db.prepare("INSERT INTO leases(name,next_due_at) VALUES ('ingest',?)").run(NOW);
  expect(reader.revision()).toBe(stable);
  expect(reader.snapshot(ctx => queryExplorer(ctx, { slice: slice(), groupBy, page: { limit: 200, cursor: first.nextCursor! } })).rows).toHaveLength(200);
  inspect(ctx => {
    const parent = id(ctx, "actor", "parent");
    const prepare = vi.spyOn(ctx.db, "prepare");
    const page = { limit: 200, cursor: first.nextCursor! };
    for (const query of [
      { slice: { ...slice(), start: M + 1 }, groupBy, page },
      { slice: { ...slice(), end: M + 3 * D - 1 }, groupBy, page },
      { slice: { ...slice(), filters: [{ kind: "id" as const, field: "actor" as const, value: parent }] }, groupBy, page },
      { slice: slice(), groupBy: ["model", "role", "thinking"] as const, page },
      { slice: slice(), groupBy, page: { ...page, limit: 199 } },
    ]) expect(() => queryExplorer(ctx, query)).toThrow("invalid-query");
    expect(prepare).not.toHaveBeenCalled(); prepare.mockRestore();
    const values = queryFilterValues(ctx, slice(), "role", "role-", 200);
    // Each role has three models, so use a smaller value page to obtain a cursor.
    expect(values.rows).toHaveLength(150);
    const valueCursor = queryFilterValues(ctx, slice(), "role", "role-", 50).nextCursor!;
    for (const run of [
      () => queryFilterValues(ctx, slice(), "model", "role-", 50, valueCursor),
      () => queryFilterValues(ctx, slice(), "role", "role-0", 50, valueCursor),
      () => queryFilterValues(ctx, slice(), "role", "role-", 51, valueCursor),
      () => queryFilterValues(ctx, { ...slice(), end: M + 2 * D }, "role", "role-", 50, valueCursor),
      () => queryFilterValues(ctx, slice(), "role", "role-", 50, first.nextCursor!),
    ]) expect(run).toThrow("invalid-query");
  });
  fixture.db.prepare("UPDATE calls SET thinking='low' WHERE id='pivot-0'").run();
  expect(() => reader.snapshot(ctx => queryExplorer(ctx, { slice: slice(), groupBy, page: { limit: 200, cursor: first.nextCursor! } }))).toThrow("ledger-changed");
});

// Breaks if route parsing admits duplicate/unknown parameters, unsafe ranges, excessive filters/groups or oversized keys.
it("Explorer routes validate bounds before SQL", async () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 60 }, (_, i) => dashboardCall(`route-${i}`, { role: `route-${i}` }))));
  const module = await api();
  expect(module.EXPLORER_ROUTES, "Both Task 6 routes must exist").toBeDefined();
  const { EXPLORER_ROUTES, queryExplorer, queryFilterValues } = module;
  expect(EXPLORER_ROUTES.map(route => route.path)).toEqual(["/api/explorer", "/api/filter-values"]);
  const explorer = EXPLORER_ROUTES[0]!, values = EXPLORER_ROUTES[1]!;
  inspect(ctx => {
    const defaults = explorer.handle(ctx, new URLSearchParams("groupBy=role")) as import("../query-explorer.js").ExplorerData;
    expect(defaults.rows).toHaveLength(50);
    expect(defaults.totals.calls).toBe(65);
    expect(defaults.nextCursor).not.toBeNull();
    const base = { start: String(M), end: String(M + 3 * D) };
    const params = new URLSearchParams({ ...base, groupBy: "role,model", limit: "200" });
    const result = explorer.handle(ctx, params) as import("../query-explorer.js").ExplorerData;
    expect(result.groupBy).toEqual(["role", "model"]);
    expect(values.handle(ctx, new URLSearchParams({ ...base, field: "role", prefix: "route-" }))).toMatchObject({ rows: expect.any(Array) });
    const prepare = vi.spyOn(ctx.db, "prepare");
    for (const query of ["unknown=x", "groupBy=role&groupBy=model", "end=2", "groupBy=", "groupBy=role,model,actor,day",
      "groupBy=role,role", "groupBy=toString", "groupBy=model);DROP TABLE calls", "limit=0", "limit=201", "limit=2.5", "cursor=",
      "cursor=" + "x".repeat(2049), "start=0&end=" + String(367 * D), "filters=" + encodeURIComponent(JSON.stringify(Array.from({ length: 17 }, () => ({ field: "role", value: null })))),
      "filters=" + encodeURIComponent(JSON.stringify([{ field: "role", value: "x".repeat(1025) }])), "filters=[]&extra=" + "x".repeat(8193)]) {
      expect(() => explorer.handle(ctx, new URLSearchParams(query)), query).toThrow("invalid-query");
    }
    for (const query of ["", "field=bad", "field=role&field=model", "field=role&prefix=" + "x".repeat(161), "field=role&limit=201", "field=role&groupBy=model"]) {
      expect(() => values.handle(ctx, new URLSearchParams(query)), query).toThrow("invalid-query");
    }
    expect(() => queryExplorer(ctx, { slice: { ...slice(), end: NaN }, groupBy: ["model"], page: { limit: 50 } })).toThrow("invalid-query");
    expect(() => queryFilterValues(ctx, slice(), "role", "x".repeat(161), 50)).toThrow("invalid-query");
    expect(prepare).not.toHaveBeenCalled(); prepare.mockRestore();
  });
  fixture.ledger.apply(dashboardBatch([dashboardCall("long-label", { role: "😀".repeat(200) })]));
  const long = reader.snapshot(ctx => queryExplorer(ctx, { slice: { ...slice(), filters: [{ kind: "id", field: "role", value: id(ctx, "role", "😀".repeat(200)) }] },
    groupBy: ["role"], page: { limit: 1 } }));
  expect(long.rows[0]!.key).toEqual([expect.stringMatching(/^v1_[A-Za-z0-9_-]{43}$/)]);
  expect([...long.rows[0]!.labels[0]!]).toHaveLength(160);
  fixture.ledger.apply(dashboardBatch([dashboardCall("oversized-key", { role: "x".repeat(1025) })]));
  expect(reader.snapshot(ctx => queryExplorer(ctx, { slice: slice(), groupBy: ["role"], page: { limit: 200 } })).rows.length).toBeGreaterThan(0);
  expect(reader.snapshot(ctx => queryFilterValues(ctx, slice(), "role", "x", 50)).rows).toEqual([{ id: expect.any(String), label: "x".repeat(160) }]);
});

// Breaks if permitted page/key sizes can produce an over-budget DTO, or cursor generation leaks an invalid-query error for stored data.
it("large attribution pages respect response budgets", async () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 200 }, (_, i) => dashboardCall(`large-${i}`, {
    role: String(i).padStart(3, "0") + "x".repeat(997),
  }))));
  const { queryExplorer, queryFilterValues } = await api();
  expect(reader.snapshot(ctx => queryFilterValues(ctx, slice(), "role", "", 200)).rows.length).toBeGreaterThan(0);
  expect(reader.snapshot(ctx => queryExplorer(ctx, { slice: slice(), groupBy: ["role"], page: { limit: 200 } })).rows.length).toBeGreaterThan(0);
  // A bounded smaller page preserves the full key and produces a usable cursor.
  const small = reader.snapshot(ctx => queryFilterValues(ctx, slice(), "role", "0", 10));
  expect(small.rows).toHaveLength(10); expect(small.nextCursor).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(64 * 1024);
  fixture.ledger.apply(dashboardBatch([dashboardCall("escaped-key", { agent: "\u0001".repeat(500) }), dashboardCall("escaped-next", { agent: "\u0001".repeat(500) + "z" })]));
  expect(reader.snapshot(ctx => queryFilterValues(ctx, slice(), "agent", "\u0001", 1)).rows).toEqual([{ id: expect.any(String), label: "\u0001".repeat(160) }]);
});

// Actual executed SQL on a small fixture, not timing: removing range/hint must fail this same oracle without SQL exceptions.
it("Explorer plans use bounded period access", async () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 10000 }, (_, i) => dashboardCall(`plan-${i}`, {
    ts: i < 1000 ? M + D : M - (i % 700 + 1) * D, role: `plan-${String(i).padStart(5, "0")}`,
  }))));
  const { queryExplorer, queryFilterValues } = await api();
  inspect(ctx => {
    const off = { ...ctx, calibrationMode: "off" as const };
    const prepare = vi.spyOn(ctx.db, "prepare");
    const result = queryExplorer(off, { slice: slice(), groupBy: ["role", "model", "thinking"], page: { limit: 200 } });
    const pivotSql = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockClear();
    const values = queryFilterValues(off, slice(), "role", "plan-", 200);
    const valueSql = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    expect(pivotSql).toHaveLength(1); expect(valueSql).toHaveLength(1);
    expect(result.totals).toMatchObject({ calls: 1005, pricedCalls: 1004, unpricedCalls: 1, aic: 1004, tokens: { total: 70350 } });
    expect(result.rows).toHaveLength(200); expect(values.rows).toHaveLength(200);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(values))).toBeLessThanOrEqual(64 * 1024);
    for (const [name, sql, args] of [
      ["explorer", pivotSql[0]!, [M, M + 3 * D, 201]],
      ["filter-values", valueSql[0]!, [M, M + 3 * D, "plan-%", 4097]],
    ] as const) {
      const explain = (statement: string) => ctx.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...args) as { id: number; parent: number; detail: string }[];
      const plan = explain(sql);
      const details = plan.map(row => row.detail);
      const oracle = (rows: readonly { id: number; parent: number; detail: string }[]) => {
        const window = rows.find(row => row.detail === (name === "explorer" ? "MATERIALIZE window" : "MATERIALIZE distinct_values"));
        const access = rows.filter(row => row.parent === window?.id && /^(?:SCAN|SEARCH) c(?: |$)/.test(row.detail));
        return access.length === 1 && access[0]!.detail === "SEARCH c USING INDEX calls_period_read (ts>? AND ts<?)";
      };
      expect(oracle(plan)).toBe(true);
      expect(sql).not.toMatch(/\bOFFSET\b/);
      if (name === "explorer") {
        expect(sql.match(/window AS MATERIALIZED/g)).toHaveLength(1);
        expect(sql).not.toContain("SELECT c.* FROM calls");
        expect(sql).not.toContain("c.latency_ms");
      } else {
        expect(sql).not.toContain("counted AS MATERIALIZED");
        expect(sql).not.toContain("possible_undercount");
      }
      const noRange = sql.replace("c.ts >= ? AND c.ts < ?", "? IS NOT NULL AND ? IS NOT NULL");
      const noHint = sql.replace("INDEXED BY calls_period_read", "NOT INDEXED");
      expect(noRange).not.toBe(sql); expect(noHint).not.toBe(sql);
      const rangeRows = explain(noRange), hintRows = explain(noHint);
      const rangePlan = rangeRows.map(row => row.detail), hintPlan = hintRows.map(row => row.detail);
      expect(oracle(rangeRows)).toBe(false); expect(oracle(hintRows)).toBe(false);
      if (process.env.SPIDER_T6_EXPLAIN === "1") {
        process.stdout.write(`EXPLAIN ${name}\n${details.join("\n")}\nMUTANT range\n${rangePlan.filter(line => /(?:SCAN|SEARCH) c(?: |$)/.test(line)).join("\n")}\nMUTANT hint\n${hintPlan.filter(line => /(?:SCAN|SEARCH) c(?: |$)/.test(line)).join("\n")}\n`);
      }
    }
  });
});

it("Explorer published fallbacks preserve tokens and zero evidence", async () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("zero", { role: "zero", price: priced(0) })]));
  const { queryExplorer } = await api();
  inspect(ctx => {
    for (const mode of ["auto", "off"] as const) {
      const result = queryExplorer({ ...ctx, calibrationMode: mode }, { slice: slice(), groupBy: ["actor"], page: { limit: 50 } });
      expect(result.calibration.status).toBe(mode === "off" ? "off" : "uncalibrated");
      expect(result.totals).toMatchObject({ aic: 4, calls: 6, unpricedCalls: 1, tokens: { total: 420 },
        aicDisplay: { primaryAic: 4, publishedAic: 4, basis: "published" } });
    }
    const before = queryExplorer(ctx, { slice: { ...slice(), start: M, end: M }, groupBy: ["model"], page: { limit: 50 } });
    expect(before.rows).toEqual([]); expect(before.totals.aicDisplay.primaryAic).toBeNull();
  });
  fixture.ledger.apply(dashboardBatch([dashboardCall("implausible-evidence", { ts: NOW - D - 1, price: priced(1000) })]));
  fixture.ledger.insertCounter({ ts: NOW - D - 1, creditsUsed: 0, raw: {} });
  fixture.ledger.insertCounter({ ts: NOW - 1, creditsUsed: 1, raw: {} });
  const fallback = reader.snapshot(ctx => queryExplorer(ctx, { slice: { start: M, end: NOW, filters: [{ kind: "id", field: "role", value: id(ctx, "role", "zero") }] },
    groupBy: ["role"], page: { limit: 50 } }));
  expect(fallback.calibration.status).toBe("implausible");
  expect(fallback.totals.aicDisplay).toEqual({ primaryAic: 0, publishedAic: 0, basis: "published" });
});

// Breaks if each member is validated but a multi-level cursor can exceed the full attribution-key bound.
it("cursor key bounds reject before SQL", async () => {
  const { queryExplorer, queryFilterValues } = await api();
  inspect(ctx => {
    const groupBy: readonly Dimension[] = ["role", "model", "thinking"];
    const identity = { slice: slice(), groupBy, limit: 50 };
    const cursor = encodeCursor("explorer", ctx.revision, identity, ["a".repeat(350), "b".repeat(350), "c".repeat(350)]);
    const prepare = vi.spyOn(ctx.db, "prepare");
    expect(() => queryExplorer(ctx, { slice: slice(), groupBy, page: { limit: 50, cursor } })).toThrow("invalid-query");
    for (const key of [[1, "model", null], [null], [null, "model", {}]]) {
      const raw = Buffer.from(JSON.stringify({ version: 1, endpoint: "explorer", revision: ctx.revision,
        queryHash: JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).queryHash, key })).toString("base64url");
      expect(() => queryExplorer(ctx, { slice: slice(), groupBy, page: { limit: 50, cursor: raw } })).toThrow("invalid-query");
    }
    expect(() => queryFilterValues(ctx, slice(), "role", "", 50, "not_a_cursor")).toThrow("invalid-query");
    expect(prepare).not.toHaveBeenCalled(); prepare.mockRestore();
  });
});
