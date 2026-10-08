import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardQueryContext, DashboardReader, Period } from "../dashboard-contract.js";
import type { RateVersion } from "../types.js";
import { readCounterIntervals } from "../counter-intervals.js";
import { CALIBRATION_V4_ROUTES, queryCalibration } from "../query-calibration.js";
import { calibrationFallback } from "../calibration.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as S, DASHBOARD_DAY as D, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

let f: DashboardFixture, reader: DashboardReader;
const now = S + 4 * D + 12 * 3600000;
const period: Period = { start: S, end: now };
function context(rates?: readonly RateVersion[], clock = now): DashboardQueryContext {
  reader?.close();
  reader = openDashboardReader(f.file, { instanceId: "fixture", serverBuild: "fixture-build", now: () => clock, calibrationMode: () => "auto", rates })!;
  return reader.snapshot(ctx => ctx);
}
function call(id: string, ts: number, aic: number, extra: Parameters<typeof dashboardCall>[1] = {}) {
  return dashboardCall(id, { ts, price: { status: "priced", aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 },
    rateVersion: "synthetic", tier: "base", confidence: "estimated" }, ...extra });
}
function snapshot(ts: number, creditsUsed: number, extra: { accountLogin?: string; resetDate?: string } = {}) {
  f.ledger.insertCounter({ ts, creditsUsed, accountLogin: "private-account", resetDate: "2026-11-01", raw: { secret: "private-payload" }, ...extra });
}
beforeEach(() => { f = createDashboardFixture(false); });
afterEach(() => { vi.restoreAllMocks(); reader?.close(); f.close(); });

it("matched correction summary uses accepted spans rather than absolute used or whole-month calls", () => {
  f.ledger.apply(dashboardBatch([call("outside", S + 1, 9000), call("matched-a", S + D + 1, 300),
    call("matched-b", S + 2 * D + 1, 300), call("after", S + 4 * D, 7000)]));
  snapshot(S + D, 1000); snapshot(S + 2 * D, 1150); snapshot(S + 3 * D, 1300);
  const data = queryCalibration(context());
  expect(data.correction).toEqual({ factor: 0.5, publishedEstimate: 600, accountCounter: 300, coveredHours: 48, status: "calibrated" });
  expect(data.intervals).toEqual([
    { start: S + 2 * D, end: S + 3 * D, publishedEstimate: 300, counterDelta: 150, ratio: 0.5 },
    { start: S + D, end: S + 2 * D, publishedEstimate: 300, counterDelta: 150, ratio: 0.5 },
  ]);
  expect(JSON.stringify(data)).not.toMatch(/private-account|private-payload|accountLogin|raw/);
});

it("counter gaps remain null while an accepted zero delta stays numeric zero", () => {
  f.ledger.apply(dashboardBatch([call("one", S + 1, 3), call("two", S + D + 1, 7)]));
  snapshot(S + D + 1000, 100); snapshot(S + D + 2000, 100);
  const data = queryCalibration(context());
  expect(data.daily[0]).toEqual({ day: S, publishedEstimate: 3, counterDelta: null });
  expect(data.daily[1]).toEqual({ day: S + D, publishedEstimate: 0, counterDelta: 0 });
  expect(data.gaps.daysWithoutCounter).toEqual([S, S + 2 * D, S + 3 * D, S + 4 * D]);
  expect(data.intervals[0]).toMatchObject({ publishedEstimate: 0, counterDelta: 0, ratio: null });
  expect(data.correction.status).toBe("published-only");
});

it("cross-midnight intervals are assigned intact to the later UTC endpoint with matching published spans", () => {
  snapshot(S + 23 * 3600000, 10); snapshot(S + D + 3600000, 14); snapshot(S + 2 * D, 20);
  f.ledger.apply(dashboardBatch([call("before", S + 22 * 3600000, 100), call("left", S + 23.5 * 3600000, 2),
    call("right", S + D + 0.5 * 3600000, 6), call("following", S + D + 2 * 3600000, 12), call("endpoint", S + 2 * D, 99)]));
  const daily = queryCalibration(context()).daily;
  expect(daily[0]).toEqual({ day: S, publishedEstimate: 102, counterDelta: null });
  expect(daily[1]).toEqual({ day: S + D, publishedEstimate: 8, counterDelta: 4 });
  expect(daily[2]).toEqual({ day: S + 2 * D, publishedEstimate: 12, counterDelta: 6 });
});

it.each(["account", "reset", "decrease", "clock", "invalid"] as const)("does not bridge excluded %s observations", reason => {
  snapshot(S + D, 10);
  snapshot(S + 2 * D, reason === "decrease" ? 5 : 20,
    reason === "account" ? { accountLogin: "another-account" } : reason === "reset" ? { resetDate: "2026-12-01" } : {});
  if (reason === "invalid") f.db.prepare("UPDATE counter_snapshots SET entitlement=-1 WHERE ts=?").run(S + 2 * D);
  if (reason === "clock") {
    f.db.prepare("DELETE FROM counter_snapshots").run();
    snapshot(S + 2 * D, 20); snapshot(S + D, 10);
  }
  expect(readCounterIntervals(context(), period)).toEqual([]);
});

it.each([[0, 1], [1, 0]] as const)("caps counter intervals at seven days (extra %i ms)", (extra, count) => {
  const end = now - D, start = end - 7 * D - extra;
  snapshot(start, 10); snapshot(end, 20);
  const intervals = readCounterIntervals(context(), { start, end });
  expect(intervals).toHaveLength(count);
  if (count) expect(intervals[0]).toEqual({ start, end, counterDelta: 10, publishedEstimate: 0, ratio: null });
});

it("highest valid duplicate wins and invalid-only evidence remains a gap", () => {
  snapshot(S + D, 10); snapshot(S + 2 * D, 12); snapshot(S + 2 * D, 500);
  f.db.prepare("UPDATE counter_snapshots SET remaining=-1 WHERE rowid=(SELECT MAX(rowid) FROM counter_snapshots)").run();
  snapshot(S + 3 * D, 13);
  expect(readCounterIntervals(context(), period).map(row => row.counterDelta)).toEqual([1, 2]);
  f.db.prepare("UPDATE counter_snapshots SET remaining=-1 WHERE ts=?").run(S + 2 * D);
  expect(readCounterIntervals(context(), period)).toEqual([]);
});

it("does not apportion a pair crossing the billing boundary or read future observations", () => {
  snapshot(S - 1000, 1); snapshot(S + 1000, 3); snapshot(now + 1, 4);
  expect(readCounterIntervals(context(), period)).toEqual([]);
});

it("retains the full billing interval list, newest first, beyond ten UI rows", () => {
  for (let i = 0; i <= 25; i++) snapshot(S + i * 3600000, i);
  expect(queryCalibration(context()).intervals).toHaveLength(25);
  expect(queryCalibration(context()).intervals[0]).toMatchObject({ start: S + 24 * 3600000, end: S + 25 * 3600000 });
});

it("billing reset, not calendar month, selects the UTC evidence period", () => {
  snapshot(S + 2 * D, 10, { resetDate: "2026-10-15" });
  const daily = queryCalibration(context()).daily;
  expect(daily[0]?.day).toBe(Date.UTC(2026, 8, 15));
  expect(daily.at(-1)?.day).toBe(S + 4 * D);
});

it("rates expose every tier in credits per million with date and preserve zero versus unavailable", () => {
  const rates: readonly RateVersion[] = [{ id: "synthetic-rates", effectiveFrom: "2026-10-01T00:00:00Z", sourceAsOf: "2026-10-02", source: "Synthetic", confidence: "estimated",
    models: [{ id: "model-cedar", aliases: [], tiers: [
      { name: "standard", abovePromptTokens: 0, usdPerMillion: { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 8 } },
      { name: "long-context", abovePromptTokens: 200000, usdPerMillion: { input: 4, cacheRead: 0.4, cacheWrite: null as unknown as number, output: 12 } },
    ] }] }];
  f.ledger.apply(dashboardBatch([call("unknown", S + 1, 0, { model: "unknown-model", price: { status: "unpriced", reason: "unknown-model" } })]));
  const data = queryCalibration(context(rates));
  expect(data.rates).toEqual([
    { model: "model-cedar", tier: "standard", abovePromptTokens: 0, input: 200, cacheRead: 20, cacheWrite: 0, output: 800, sourceDate: "2026-10-02" },
    { model: "model-cedar", tier: "long-context", abovePromptTokens: 200000, input: 400, cacheRead: 40, cacheWrite: null, output: 1200, sourceDate: "2026-10-02" },
  ]);
  expect(data.unpricedModels).toEqual([{ model: "unknown-model", reason: "unknown-model", calls: 1 }]);
});

it("rates list only the version in force now and omit expired models", () => {
  const current: RateVersion = { id: "current", effectiveFrom: "2026-10-05T12:00:00Z", sourceAsOf: "2026-10-05",
    source: "Synthetic", confidence: "estimated", models: [
      { id: "model-cedar", aliases: [], tiers: [
        { name: "standard", abovePromptTokens: 0, usdPerMillion: { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 8 } },
        { name: "long-context", abovePromptTokens: 200000, usdPerMillion: { input: 4, cacheRead: 0.4, cacheWrite: 0, output: 12 } },
      ] },
      { id: "expired", aliases: [], validUntil: "2026-10-05T12:00:00Z", tiers: [
        { name: "standard", abovePromptTokens: 0, usdPerMillion: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
      ] },
    ] };
  const old = { ...current, id: "old", effectiveFrom: "2026-10-01T00:00:00Z", sourceAsOf: "2026-10-01" };
  const future = { ...current, id: "future", effectiveFrom: "2026-10-06T00:00:00Z", sourceAsOf: "2026-10-06" };
  const expected = [
    { model: "model-cedar", tier: "standard", abovePromptTokens: 0, input: 200, cacheRead: 20, cacheWrite: 0, output: 800, sourceDate: "2026-10-05" },
    { model: "model-cedar", tier: "long-context", abovePromptTokens: 200000, input: 400, cacheRead: 40, cacheWrite: 0, output: 1200, sourceDate: "2026-10-05" },
  ];
  // Two effective versions, deliberately newest first. Future publication must not win either.
  expect(queryCalibration(context([current, old])).rates).toEqual(expected);
  expect(queryCalibration(context([old, future, current])).rates).toEqual(expected);
  expect(queryCalibration(context([future])).rates).toEqual([]);
});

it("unknown stored unpriced reasons use the same unavailable allowlist fallback as Overview", () => {
  f.ledger.apply(dashboardBatch([call("unknown-reason", S + 1, 0, { price: { status: "unpriced", reason: "unknown-model" } })]));
  // Emulate a future schema or damaged row without weakening the production CHECK.
  f.db.exec("PRAGMA ignore_check_constraints=ON");
  f.db.prepare("UPDATE calls SET unpriced_reason='private/unknown-reason'").run();
  const data = queryCalibration(context());
  expect(data.unpricedModels).toEqual([{ model: "fixture-model", reason: "unavailable", calls: 1 }]);
  expect(JSON.stringify(data)).not.toContain("private");
});

it("unpriced and missing-model compaction diagnostics use canonical selected calls", () => {
  const missing = call("missing", S + 1, 0, { actor: "compaction", model: null, responseId: "missing-response", price: { status: "unpriced", reason: "missing-attribution" } });
  f.ledger.apply(dashboardBatch([missing, { ...missing, id: "copy", entryId: "copy", sourceFile: "synthetic/copy", copied: true },
    call("unknown", S + 2, 0, { model: "unknown", price: { status: "unpriced", reason: "unknown-model" } }),
    call("priced-compaction", S + 3, 2, { actor: "compaction" }), call("old", S - 1, 0, { model: null, actor: "compaction", price: { status: "unpriced", reason: "missing-attribution" } }),
  ]));
  const data = queryCalibration(context());
  expect(data.gaps).toMatchObject({ unpricedCalls: 2, compactionWithoutModel: 1 });
  expect(data.unpricedModels).toEqual([{ model: null, calls: 1, reason: "missing-attribution" }, { model: "unknown", calls: 1, reason: "unknown-model" }]);
});

it("published-only and unavailable correction keep complete nullable shape", () => {
  const ctx = context(), empty = queryCalibration(ctx);
  expect(empty.correction).toEqual({ factor: null, publishedEstimate: null, accountCounter: null, coveredHours: 0, status: "counter-unavailable" });
  expect(empty.intervals).toEqual([]);
  expect(empty.daily.every(row => row.counterDelta === null && row.publishedEstimate === null)).toBe(true);
  snapshot(S + D, 10);
  expect(queryCalibration(context()).correction.status).toBe("published-only");
  expect(queryCalibration({ ...context(), calibrationMode: "off" }).correction.factor).toBeNull();
});

it("back-applies the earliest real fit at a past-dated half-open endpoint", () => {
  const end = now - D, start = end - D;
  f.ledger.apply(dashboardBatch([call("evidence", start + 1, 600)]));
  snapshot(start, 10); snapshot(end, 310);
  const ctx = context(undefined, end);
  expect(ctx.calibration.at(end - 1, "auto").status).toBe("uncalibrated");
  expect(ctx.calibration.earliest("auto")).toMatchObject({ factor: 0.5, windowEnd: end });
  expect(queryCalibration(ctx).correction).toEqual({ factor: 0.5, status: "back-applied", publishedEstimate: 600, accountCounter: 300, coveredHours: 24 });
  // Once the clock passes the anchor, the same real evidence is a direct fit.
  expect(queryCalibration(context(undefined, end + 1)).correction.status).toBe("calibrated");
});

it("the correction header uses the same now-minus-one endpoint as corrected credits", () => {
  f.ledger.apply(dashboardBatch([call("first", now - 2 * D + 1, 600), call("second", now - D + 1, 600)]));
  snapshot(now - 2 * D, 10); snapshot(now - D, 310); snapshot(now, 1210);
  const ctx = context();
  expect(ctx.calibration.at(now, "auto").factor).toBe(1);
  expect(queryCalibration(ctx).correction).toMatchObject({ factor: 0.5, status: "calibrated" });
});

it("last accepted unavailable factors follow engine evidence without changing matched sums", () => {
  f.ledger.apply(dashboardBatch([call("evidence", S + D + 1, 600)]));
  snapshot(S + D, 10); snapshot(S + 2 * D, 310);
  const unavailable = context(), status = unavailable.status();
  unavailable.status = () => ({ ...status, counter: { ...status.counter, availability: "unavailable" } });
  unavailable.calibration.at = () => calibrationFallback();
  expect(queryCalibration(unavailable).correction).toMatchObject({ factor: 0.5, status: "counter-unavailable", publishedEstimate: 600, accountCounter: 300 });
});

it("invalid snapshot timestamps cannot make outage fallback fail", () => {
  snapshot(S + D + 0.5, 10);
  const data = queryCalibration(context());
  expect(data.correction).toMatchObject({ factor: null, status: "counter-unavailable" });
  expect(data.intervals).toEqual([]);
});

it("serializes ingestion errors only as bounded labels and safe codes", () => {
  f.ledger.apply(dashboardBatch([], { at: now - 60000, states: [{ path: "/synthetic/private/session.jsonl", inode: "fixture", size: 0, offset: 0,
    mtimeMs: now, parseErrors: 2, generation: 0, prefixHash: "fixture" }], sourceErrors: [{ path: "/synthetic/private/session.jsonl", code: "private-path:error" }] }));
  const data = queryCalibration(context());
  expect(data.ingestion.errors).toBe(3);
  expect(data.errors).toEqual([
    { pathLabel: "session.jsonl", code: "parse-errors", count: 2, lastCheckedAt: now - 60000 },
    { pathLabel: "session.jsonl", code: "source-error", count: 1, lastCheckedAt: now - 60000 },
  ]);
  expect(JSON.stringify(data)).not.toContain("private");
});

it("status and calibration routes reject parameters and have exact paths", () => {
  expect(CALIBRATION_V4_ROUTES.map(route => route.path)).toEqual(["/api/status", "/api/calibration"]);
  for (const route of CALIBRATION_V4_ROUTES) {
    expect(() => route.handle(context(), new URLSearchParams("private=1"))).toThrow("invalid-query");
    expect(route.handle(context(), new URLSearchParams())).toBeDefined();
  }
});

it("snapshot and selected-call queries use bounded read indexes and never read raw payloads", () => {
  snapshot(S + D, 10); snapshot(S + 2 * D, 15);
  f.ledger.apply(dashboardBatch([call("evidence", S + D + 1, 10)]));
  const ctx = context(), captured: { sql: string; args: unknown[] }[] = [];
  // Earliest-fit discovery is the existing engine's paged history operation,
  // covered in calibration.test.ts. Inspect this lane's reads separately.
  ctx.calibration.earliest(ctx.calibrationMode);
  const prepare = ctx.db.prepare.bind(ctx.db);
  vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    for (const method of ["all", "get"] as const) {
      const original = statement[method].bind(statement);
      vi.spyOn(statement, method).mockImplementation((...args: unknown[]) => {
        captured.push({ sql, args }); return original(...args as never[]);
      });
    }
    return statement;
  });
  queryCalibration(ctx);
  const queries = captured.filter(({ sql }) => sql.includes("counter_snapshots_ts") || sql.includes("calls_period_read"));
  expect(queries.length).toBeGreaterThan(0);
  for (const { sql, args } of queries) {
    const rows = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args as never[]) as { detail: string }[];
    const plans = rows.map(row => row.detail).join("\n");
    expect(plans, sql).not.toMatch(/SCAN (?:calls|counter_snapshots)\b/);
    for (const index of ["calls_period_read", "counter_snapshots_ts"] as const) {
      if (!sql.includes(index)) continue;
      const reads = rows.filter(row => row.detail.includes(index));
      expect(reads.length, sql).toBeGreaterThan(0);
      for (const { detail } of reads) {
        expect(detail, sql).toMatch(index === "calls_period_read"
          ? /SEARCH \w+ USING (?:COVERING )?INDEX calls_period_read \(ts>\? AND ts<\?\)/
          : /SEARCH .*counter_snapshots_ts \(ts[<=>]/);
      }
    }
    expect(sql).not.toMatch(/\braw\b|SELECT \*/i);
  }
});

it("latest counter reset selects calibration evidence after a reset, including duplicate timestamps", () => {
  snapshot(S - D, 20, { resetDate: "2026-10-15" });
  snapshot(S + D, 1, { resetDate: "2026-10-15" });
  snapshot(S + D, 2, { resetDate: "2026-11-01" });
  const data = queryCalibration(context());
  expect(data.daily[0]?.day).toBe(S);
  expect(data.daily.at(-1)?.day).toBe(S + 4 * D);
});
