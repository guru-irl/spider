import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryCache } from "../query-cache.js";
import { dashboardLabel } from "../dashboard-identities.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D, DASHBOARD_NOW as NOW, type DashboardFixture } from "./fixtures/dashboard-ledger.js";
let fixture: DashboardFixture;
let reader: NonNullable<ReturnType<typeof openDashboardReader>>;
beforeEach(() => { fixture = createDashboardFixture(false); reader = openDashboardReader(fixture.file, { instanceId: "fixture", now: () => NOW, serverBuild: "fixture", calibrationMode: () => "off" })!; });
afterEach(() => { reader.close(); fixture.close(); });
const slice = { start: M, end: M + 2 * D, filters: [] };
test("hit rate weights selected prompt tokens", () => {
  // A mean of per-call percentages, or adding token subsets, would break these literals.
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("small", { usage: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 } }),
    dashboardCall("large", { usage: { input: 700, cacheRead: 100, cacheWrite: 200, cacheWrite1h: 50, output: 20, reasoning: 5 } }),
    dashboardCall("warmer", { actor: "warmer", usage: { input: 20, cacheRead: 100, cacheWrite: 30, output: 0 } }),
    dashboardCall("other-period", { ts: M + 3 * D, usage: { input: 0, cacheRead: 999, cacheWrite: 0, output: 0 } }),
  ]));
  const ctx = reader.snapshot(ctx => ctx);
  {
    const prepared: { sql: string; args: unknown[] }[] = [];
    const original = ctx.db.prepare.bind(ctx.db);
    const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
      const statement = original(sql);
      for (const method of ["all", "get"] as const) {
        const run = statement[method].bind(statement);
        vi.spyOn(statement, method).mockImplementation((...args: unknown[]) => { prepared.push({ sql, args }); return run(...args); });
      }
      return statement;
    });
    const result = queryCache(ctx, slice, { limit: 50 }); spy.mockRestore();
    expect(result).toMatchObject({ hitRate: 290 / 1250, warmerShare: { prompt: 150 / 1250, calls: 1 / 3, publishedAic: 1 / 3 },
      totals: { calls: 3, tokens: { input: 730, cacheRead: 290, cacheWrite: 230, cacheWrite1h: 50, output: 25, reasoning: 5, prompt: 1250, total: 1275 } },
      warmer: { calls: 1, tokens: { cacheRead: 100 } }, daily: { rows: [{ hitRate: null }, { hitRate: 290 / 1250 }] } });
    expect(result.daily.rows[1]!.warmer.tokens.prompt).toBe(150);
    expect(prepared.length).toBeLessThanOrEqual(6);
    const plans = prepared.flatMap(({ sql, args }) => original(`EXPLAIN QUERY PLAN ${sql}`).all(...args)) as { id: number; parent: number; detail: string }[];
    expect(plans.some(row => /SEARCH c USING INDEX calls_period_read \(ts>\? AND ts<\?\)/.test(row.detail))).toBe(true);
    expect(plans.filter(row => /SCAN (?:calls|prior|active)\b/.test(row.detail) || (/SCAN c\b/.test(row.detail) && plans.some(parent => parent.id === row.parent && parent.detail === "MATERIALIZE window")))).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
  }
  const empty = reader.snapshot(ctx => queryCache(ctx, { start: M, end: M, filters: [] }, { limit: 50 }));
  expect(empty).toMatchObject({ hitRate: null, warmerShare: { prompt: null, calls: null, publishedAic: null }, totals: { aic: null } });
});

test("fork-copy reads do not defeat no-read observation", () => {
  const write = (id: string, sessionId: string) => dashboardCall(id, { sessionId, usage: { input: 10, cacheRead: 0, cacheWrite: 30, output: 0 } });
  fixture.ledger.apply(dashboardBatch([
    write("write-copy", "copy-session"),
    dashboardCall("original-read", { responseId: "same-read", sessionId: "original-session", ts: M + 3 * D }),
    dashboardCall("copied-read", { responseId: "same-read", copied: true, sourceFile: "synthetic/fork.jsonl", sessionId: "copy-session" }),
    dashboardCall("unique-copy-read", { responseId: "unique-copy", copied: true, sessionId: "copy-session", ts: M + 3 * D }),
    write("write-native", "native-session"),
    dashboardCall("lifetime-read", { sessionId: "native-session", ts: M + 3 * D }),
    write("write-replaced", "replaced-session"),
    dashboardCall("replaced-read", { sessionId: "replaced-session", actor: "subagent", aggregate: true, sourceKind: "report", runId: "replaced" }),
    dashboardCall("native-no-read", { sessionId: "different-session", actor: "subagent", runId: "replaced", usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 } }),
    write("ongoing-write", "ongoing-session"),
    ...Array.from({ length: 450 }, (_, i) => write(`paged-${i}`, `/synthetic/private/session-${i}`)),
  ], { states: [{ path: "synthetic/parent.jsonl", inode: "fixture", size: 100, offset: 90, generation: 0, mtimeMs: NOW, prefixHash: "fixture", parseErrors: 0 }] }));
  const seen: string[] = []; let cursor: string | undefined;
  const ctx = reader.snapshot(ctx => ctx);
  do {
    const result = queryCache(ctx, slice, { limit: 200, cursor });
    expect(result.sessionsWithWritesNoReads.rows.length).toBeLessThanOrEqual(200);
    expect(result.totals).toMatchObject({ calls: 455, aic: 455, tokens: { input: 4541, cacheRead: 0, cacheWrite: 13620, prompt: 18161, total: 18161 } });
    for (const row of result.sessionsWithWritesNoReads.rows) {
      seen.push(row.sessionLabel); expect(row).not.toHaveProperty("provisional");
      expect(result.ingestPending).toBe(true);
      expect(row.measure.tokens.cacheRead).toBe(0);
      if (row.sessionLabel === "unsupported id") expect(row.sessionId).toBeNull();
      else expect(row.sessionId).toBe(row.sessionLabel);
    }
    cursor = result.sessionsWithWritesNoReads.nextCursor ?? undefined;
    if (cursor) expect(Buffer.from(cursor, "base64url").toString()).not.toContain("/synthetic/private");
  } while (cursor);
  expect(seen).toHaveLength(453); expect(seen.filter(label => label === "unsupported id")).toHaveLength(450);
  expect(seen).toContain("copy-session"); expect(seen).toContain("replaced-session"); expect(seen).not.toContain("native-session");
  expect(() => queryCache(ctx, slice, { limit: 201 })).toThrow("invalid-query");
  const first = queryCache(ctx, slice, { limit: 1 });
  const next = first.sessionsWithWritesNoReads.nextCursor!;
  expect(() => queryCache(ctx, { ...slice, filters: [{ field: "actor", value: "aux" }] }, { limit: 1, cursor: next })).toThrow("invalid-query");
  fixture.ledger.apply(dashboardBatch([write("changed", "new-session")]));
  const changedCtx = reader.snapshot(ctx => ctx);
  expect(() => queryCache(changedCtx, slice, { limit: 1, cursor: next })).toThrow("ledger-changed");
});

test("cache component AIC stays paired with counted token types", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("components", { ts: M + 1, usage: { input: 10, cacheRead: 20, cacheWrite: 30, cacheWrite1h: 5, output: 40, reasoning: 2 },
    price: { status: "priced", aic: 1000, components: { input: 100, cacheRead: 200, cacheWrite: 300, output: 400 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" } })]));
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M, "synthetic-seat", 0, 10000, 10000, "reset", "{}");
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M + D, "synthetic-seat", 500, 10000, 9500, "reset", "{}");
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "auto";
  const data = queryCache(ctx, slice, { limit: 50 });
  expect(data.components).toEqual([
    { tokenType: "input", tokens: 10, aicDisplay: { primaryAic: 50, publishedAic: 100, basis: "calibrated" } },
    { tokenType: "cacheRead", tokens: 20, aicDisplay: { primaryAic: 100, publishedAic: 200, basis: "calibrated" } },
    { tokenType: "cacheWrite", tokens: 30, aicDisplay: { primaryAic: 150, publishedAic: 300, basis: "calibrated" } },
    { tokenType: "output", tokens: 40, aicDisplay: { primaryAic: 200, publishedAic: 400, basis: "calibrated" } },
  ]);
  expect(data.totals).toMatchObject({ tokens: { prompt: 60, total: 100, cacheWrite1h: 5, reasoning: 2 }, aic: 1000, aicDisplay: { primaryAic: 500, publishedAic: 1000 } });
  expect(data.daily.rows[0]!.components.map(row => row.aicDisplay.basis)).toEqual(["back-applied", "back-applied", "back-applied", "back-applied"]);
});

test("cache project labels use normalized home or redacted suffixes", () => {
  const home = process.env.HOME!;
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("home-path", { sessionId: "home.session_:x-0", project: `${home}/team/../team/project`, usage: { input: 1, cacheRead: 0, cacheWrite: 1, output: 0 } }),
    dashboardCall("other-home", { sessionId: "other-session", project: `${home}-another/team/project`, usage: { input: 1, cacheRead: 0, cacheWrite: 1, output: 0 } }),
    dashboardCall("windows", { sessionId: "x".repeat(128), project: "C:\\private\\team\\project", usage: { input: 1, cacheRead: 0, cacheWrite: 1, output: 0 } }),
    dashboardCall("relative", { sessionId: "relative-session", project: "../team/project", usage: { input: 1, cacheRead: 0, cacheWrite: 1, output: 0 } }),
  ]));
  const result = reader.snapshot(ctx => queryCache(ctx, slice, { limit: 50 }));
  expect(result.sessionsWithWritesNoReads.rows[0]!.sessionId).toBe("home.session_:x-0");
  expect(result.sessionsWithWritesNoReads.rows[2]!.sessionId).toBe("x".repeat(128));
  expect(result.sessionsWithWritesNoReads.rows.map(row => row.projectLabel)).toEqual(["~/team/project", "…/team/project", "…/team/project", "…/team/project"]);
  expect(dashboardLabel("model", "note=[/private/team/project],file:/private/team/project")).toBe("note=[…/team/project],file:…/team/project");
  expect(dashboardLabel("model", "path=C:\\private\\team\\project")).toBe("path=…/team/project");
  expect(dashboardLabel("model", "\\\\server\\share\\team\\project")).toBe("…/team/project");
});

// Losing NULL TTL evidence or assuming 5m = total - 1h overstates known writes.
test("cache explicitly separates known TTL writes from unknown splits", () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("known", { usage: { input: 0, cacheRead: 0, cacheWrite: 30, cacheWrite1h: 9, output: 0 } }),
    dashboardCall("unknown", { usage: { input: 0, cacheRead: 0, cacheWrite: 49, output: 0 } }),
  ]));
  const result = reader.snapshot(ctx => queryCache(ctx, slice, { limit: 50 }));
  expect(result.writeSplit).toEqual({ cacheWrite5m: 21, cacheWrite1h: 9, knownTokens: 30, knownCalls: 1, unknownTokens: 49, unknownCalls: 1 });
  expect(result.daily.rows[1]!.writeSplit).toEqual(result.writeSplit);
  expect(result.ingestPending).toBe(false);
});

test("cache day pages stop at 31 and no-read candidate pages exclude native reads before limiting", () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("read", { ts: M + 1, sessionId: "read-session" }),
    dashboardCall("write", { ts: M + 2, sessionId: "write-session", usage: { input: 1, cacheRead: 0, cacheWrite: 1, output: 0 } }),
  ]));
  const ctx = reader.snapshot(ctx => ctx);
  const first = queryCache(ctx, { start: M, end: M + 40 * D, filters: [] }, { limit: 1 });
  expect(first.daily.rows).toHaveLength(31); expect(first.daily.rows.at(-1)!.end).toBe(M + 31 * D);
  expect(first.sessionsWithWritesNoReads.rows.map(row => row.sessionId)).toEqual(["write-session"]);
});

// Filtering unknownCalls to nonzero writes hides missing TTL evidence.
test("unknown TTL call count includes missing fields even on zero-write calls", () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("no-write-missing-ttl", { actor: "warmer", usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 } }),
    dashboardCall("writes-missing-ttl", { actor: "warmer", usage: { input: 1, cacheRead: 0, cacheWrite: 49, output: 0 } }),
    dashboardCall("no-write-known-ttl", { actor: "warmer", usage: { input: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 } }),
  ]));
  const result = reader.snapshot(ctx => queryCache(ctx, slice, { limit: 50 }));
  const want = { cacheWrite5m: 0, cacheWrite1h: 0, knownTokens: 0, knownCalls: 1, unknownTokens: 49, unknownCalls: 2 };
  expect(result.writeSplit).toEqual(want); expect(result.warmerWriteSplit).toEqual(want);
  expect(result.daily.rows[1]!.writeSplit).toEqual(want); expect(result.daily.rows[1]!.warmerWriteSplit).toEqual(want);
});
