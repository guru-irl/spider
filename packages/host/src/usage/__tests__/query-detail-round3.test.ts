import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryDetail } from "../query-detail.js";
import type { DashboardReader } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";
let fixture: ReturnType<typeof createDashboardFixture>;
let reader: DashboardReader;
beforeEach(() => {
  fixture = createDashboardFixture(false);
  reader = openDashboardReader(fixture.file, { instanceId: "detail-round3", now: () => DASHBOARD_NOW,
    calibrationMode: () => "off", serverBuild: "fixture" })!;
});
afterEach(() => { vi.restoreAllMocks(); reader.close(); fixture.close(); });
const slice = () => ({ start: M + 2 * D, end: M + 4 * D, filters: [] });
// Omitting kind or end from the memo key returns another selection's buckets.
it("same id in session and run has separate timeline buckets on one connection", () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("sz1", { sessionId: "Z", ts: M + 2 * D }),
    dashboardCall("sz2", { sessionId: "Z", ts: M + 3 * D }),
    dashboardCall("rz1", { sessionId: "other", runId: "Z", ts: M + 2 * D + D / 2 }),
  ]));
  reader.snapshot(ctx => {
    const session = queryDetail(ctx, { kind: "session", id: "Z", slice: slice(), page: { limit: 1 } });
    const run = queryDetail(ctx, { kind: "run", id: "Z", slice: slice(), page: { limit: 1 } });
    expect(session.timeline.reduce((n, p) => n + p.measure.calls, 0)).toBe(2);
    expect(run.totals.calls).toBe(1);
    expect(run.timeline).toHaveLength(1);
    expect(run.timeline[0]!.start).toBe(M + 2 * D + D / 2);
    expect(run.timeline[0]!.measure.calls).toBe(1);
  });
});
it("same start with narrower end cannot reuse buckets outside the period", () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("e1", { sessionId: "E", ts: M + 2 * D }),
    dashboardCall("e2", { sessionId: "E", ts: M + 3 * D }),
  ]));
  reader.snapshot(ctx => {
    const wide = queryDetail(ctx, { kind: "session", id: "E", slice: slice(), page: { limit: 1 } });
    const narrow = queryDetail(ctx, { kind: "session", id: "E", slice: { ...slice(), end: M + 3 * D }, page: { limit: 1 } });
    expect(wide.timeline.reduce((n, p) => n + p.measure.calls, 0)).toBe(2);
    expect(narrow.totals.calls).toBe(1);
    expect(narrow.timeline).toHaveLength(1);
    expect(narrow.timeline[0]!.measure.calls).toBe(1);
    expect(narrow.timeline.every(p => p.end <= M + 3 * D)).toBe(true);
  });
});

// Observe the real registered SQL hash function during an active selection.
// SQL-generated synthetic ids avoid a huge ledger, while exercising the same
// cache insertion and eviction as a counted pass. Removing the cap recomputes
// zero hashes for the oldest entry; the bounded cache recomputes exactly one.
it.each([1024, 65536])("hash retention evicts at the bounded budget even with %i synthetic ids", count => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("owner-call", { ts: M + 2 * D, sessionId: "owner" })]));
  const update = vi.spyOn(Object.getPrototypeOf(createHash("sha256")), "update");
  const ctx = reader.snapshot(ctx => ctx);
  {
    const prepare = ctx.db.prepare.bind(ctx.db);
    let injected = false;
    vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
      if (!injected && sql.includes("WITH counted AS MATERIALIZED")) {
        injected = true;
        ctx.db.raw.prepare(`WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n < ?)
          SELECT dashboard_call_key('synthetic-' || n) AS key FROM ids`).all(count);
        const hashes = () => update.mock.calls.filter(args => typeof args[0] === "string" && args[0].startsWith('["call",')).length;
        const get = ctx.db.raw.prepare("SELECT dashboard_call_key(?) AS key");
        const before = hashes();
        get.get(`synthetic-${count}`);
        expect(hashes()).toBe(before); // Newest entry retained.
        get.get("synthetic-0");
        expect(hashes()).toBe(before + 1); // Oldest evicted, even at old cap.
        const long = "x".repeat(129);
        const beforeLong = hashes();
        get.get(long); get.get(long);
        expect(hashes()).toBe(beforeLong + 2); // No unbounded cached id strings.
      }
      return prepare(sql);
    });
    const result = queryDetail(ctx, { kind: "session", id: "owner", slice: slice(), page: { limit: 1 } });
    expect(result.totals.calls).toBe(1);
    expect(injected).toBe(true);
  }
});
