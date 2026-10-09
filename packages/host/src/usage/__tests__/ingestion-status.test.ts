import { afterEach, beforeEach, expect, it } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardQueryContext, DashboardReader } from "../dashboard-contract.js";
import type { UsageCollector } from "../protocol.js";
import { readIngestionStatus, queryStatusV4 } from "../ingestion-status.js";
import { readSourceErrorDiagnostics, sourceErrorCode, sourceErrorLabel } from "../source-error-diagnostics.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as S, DASHBOARD_DAY as D, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

let f: DashboardFixture, reader: DashboardReader;
const now = S + 3 * D + 12 * 3600000;
const ownerId = "private-collector-owner";
function context(): DashboardQueryContext {
  reader?.close();
  reader = openDashboardReader(f.file, { instanceId: "fixture", serverBuild: "fixture-build", now: () => now, calibrationMode: () => "auto" })!;
  return reader.snapshot(ctx => ({ ...ctx, viewerSessionId: "viewer-session" }));
}
function publish(collector: UsageCollector): void {
  f.ledger.apply(dashboardBatch([], { at: now - 60000, publishedSnapshot: { type: "snapshot", collector,
    health: { ...f.ledger.health(), lastIngestAt: now - 60000 },
    counter: { availability: "unavailable", role: "inactive", lastAttemptAt: null, lastSuccessAt: null,
      nextPollAt: null, snapshotAgeMs: null, errorCode: null, notice: null, latest: null },
    backfill: "complete", ingestRole: "follower", reconciliation: { windowStart: S, windowEnd: now,
      computedAIC: 0, counterAIC: null, gap: null, ratio: null, unpricedCalls: 0, estimated: false } } }));
}
beforeEach(() => { f = createDashboardFixture(false); });
afterEach(() => { reader?.close(); f.close(); });

it.each([
  ["pi", "viewer-session", "this-session"],
  ["pi", "other-session", "another-session"],
  ["pi", null, "another-session"],
  ["dashboard", null, "dashboard-server"],
] as const)("classifies a live %s collector privately (%s)", (kind, sessionId, expected) => {
  const lease = f.ledger.leases.acquire("ingest", ownerId, now, 60000)!;
  publish({ kind, sessionId, owner: ownerId });
  const ctx = context(), status = queryStatusV4(ctx);
  expect(status.collector).toBe(expected);
  expect(readIngestionStatus(ctx).collector).toBe(expected);
  expect(JSON.stringify(status)).not.toContain(ownerId);
  expect(JSON.stringify(readIngestionStatus(ctx))).not.toContain("viewer-session");
  expect(queryStatusV4({ ...ctx, viewerSessionId: undefined }).collector).toBe(kind === "pi" ? "another-session" : "dashboard-server");
  lease.release();
  expect(queryStatusV4(ctx).collector).toBe("none");
});

it("does not mistake expired, missing or superseded publication for a collector", () => {
  publish({ kind: "pi", sessionId: "viewer-session", owner: ownerId });
  expect(queryStatusV4(context()).collector).toBe("none");
  f.ledger.leases.acquire("ingest", ownerId, now - 60000, 60000);
  expect(queryStatusV4(context()).collector).toBe("none");
  f.ledger.leases.acquire("ingest", "successor", now, 60000);
  expect(queryStatusV4(context()).collector).toBe("none");
});

it("ignores malformed collector metadata rather than leaking it or throwing", () => {
  f.ledger.leases.acquire("ingest", ownerId, now, 60000);
  for (const value of ["null", "{", JSON.stringify({ collector: { kind: "other", owner: ownerId } })]) {
    f.db.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('worker-snapshot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
    expect(queryStatusV4(context()).collector).toBe("none");
  }
});

it("counts globally selected calls in UTC today, not raw or future rows", () => {
  const native = dashboardCall("native", { ts: S + 3 * D, responseId: "response" });
  f.ledger.apply(dashboardBatch([native,
    dashboardCall("copy", { ts: native.ts, responseId: "response", copied: true, sourceFile: "synthetic/copy.jsonl" }),
    dashboardCall("yesterday", { ts: S + 3 * D - 1 }), dashboardCall("future", { ts: now + 1 }),
    dashboardCall("detail", { ts: now - 1, actor: "subagent", runId: "run" }),
    dashboardCall("report", { ts: now - 2, actor: "subagent", runId: "run", aggregate: true, sourceKind: "report" }),
  ], { at: now - 60000, states: [
    { path: "synthetic/one.jsonl", inode: "one", size: 10, offset: 10, mtimeMs: now, parseErrors: 2, generation: 0, prefixHash: "one" },
    { path: "synthetic/two.jsonl", inode: "two", size: 10, offset: 10, mtimeMs: now, parseErrors: 0, generation: 0, prefixHash: "two" },
  ], sourceErrors: [{ path: "synthetic/two.jsonl", code: "secret/path:bad-code" }] }));
  const ingestion = readIngestionStatus(context());
  expect(ingestion).toEqual({ collector: "none", lastIngestAt: now - 60000, filesTracked: 2, callsToday: 2, errors: 3 });
});

it("returns complete build and freshness fields with no observations", () => {
  expect(queryStatusV4(context())).toEqual({ lastIngestAt: null, collector: "none", latestCounterAt: null,
    serverBuild: "fixture-build", rateVersions: ["copilot-public-2026-10-04"] });
  f.ledger.apply(dashboardBatch([], { at: now - 60000, states: [{ path: "synthetic/a.jsonl", inode: "a", size: 0, offset: 0,
    mtimeMs: now, parseErrors: 0, generation: 0, prefixHash: "a" }] }));
  f.ledger.insertCounter({ ts: now - 1000, creditsUsed: 17, raw: { secret: "never serialize" } });
  expect(queryStatusV4(context())).toMatchObject({ lastIngestAt: now - 60000, latestCounterAt: now - 1000 });
});

it("uses the call-ingest status time when import_state is empty", () => {
  publish({ kind: "dashboard", sessionId: null, owner: ownerId });
  const ctx = context();
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM import_state").get()).toEqual({ n: 0 });
  expect(queryStatusV4(ctx).lastIngestAt).toBe(now - 60000);
  expect(readIngestionStatus(ctx).lastIngestAt).toBe(now - 60000);
});

it("preserves bounded redacted source diagnostics independently of retired routes", () => {
  f.ledger.apply(dashboardBatch([], { at: now, states: [{ path: "/synthetic/private/session.jsonl", inode: "a", size: 0, offset: 0,
    mtimeMs: now, parseErrors: 2, generation: 0, prefixHash: "a" }], sourceErrors: [
      { path: "/synthetic/private/session.jsonl", code: "unknown-aux-purpose:private-purpose" },
      { path: "C:\\private\\other.jsonl", code: "private-host:failure" },
    ] }));
  const result = readSourceErrorDiagnostics(f.db, 2);
  expect(result).toEqual({ rows: [
    { sourceLabel: "session.jsonl", projectLabel: "Unknown project", code: "parse-errors", count: 2, lastCheckedAt: now },
    { sourceLabel: "session.jsonl", projectLabel: "Unknown project", code: "unknown-aux-purpose", count: 1, lastCheckedAt: now },
  ], truncated: true });
  expect(readSourceErrorDiagnostics(f.db, 10).rows.at(-1)?.code).toBe("source-error");
  expect(sourceErrorLabel("%252Fprivate%252Fname.jsonl", "Unknown source")).toBe("name.jsonl");
  expect(sourceErrorLabel("%malformed", "Unknown source")).toBe("Unknown source");
  expect(sourceErrorCode("ENOENT")).toBe("ENOENT");
  expect(JSON.stringify(result)).not.toContain("private");
});


it("diagnostic-only import rows count as errors but not tracked files", () => {
  f.ledger.apply(dashboardBatch([], { at: now, states: [
    { path: "synthetic/tracked.jsonl", inode: "inode", size: 0, offset: 0, mtimeMs: now, parseErrors: 1, generation: 0, prefixHash: "hash" },
  ], sourceErrors: [
    { path: "metadata:session:broken", code: "metadata-invalid" },
    { path: "synthetic/missing.jsonl", code: "ENOENT" },
  ] }));
  expect(readIngestionStatus(context())).toMatchObject({ filesTracked: 1, errors: 3 });
});
