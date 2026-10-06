import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { request } from "node:http";
import { startUsageHttpServer } from "../server.js";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeCursor } from "../dashboard-selection.js";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardQueryContext, DashboardReader, Dimension, Slice, UsageMeasure } from "../dashboard-contract.js";
import { queryOverview, OVERVIEW_ROUTES } from "../query-overview.js";
import { querySourceErrors } from "../query-source-errors.js";
import { queryExplorer, queryFilterValues, EXPLORER_ROUTES } from "../query-explorer.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_NOW as NOW,
  DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";

let fixture: ReturnType<typeof createDashboardFixture>;
let reader: DashboardReader;
const priced = (aic: number) => ({ status: "priced" as const, aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 },
  rateVersion: "r", tier: "t", confidence: "estimated" as const });
const u = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({ input, cacheRead, cacheWrite, output });
const dims: readonly Dimension[] = ["project", "repo", "session", "actor", "role", "agent", "provider", "model",
  "requestedModel", "thinking", "run", "runName", "phase", "parentRun", "auxPurpose", "api", "day"];
beforeEach(() => {
  fixture = createDashboardFixture(false);
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("a1", { ts: M + D, project: "p1", repo: "g1", sessionId: "s1", model: "mA", requestedModel: "rq1", thinking: "high", api: "api1", responseId: "resp-a1", price: priced(2), usage: u(1, 2, 3, 4) }),
    dashboardCall("a2", { ts: M + 2 * D + 3600000, project: "p1", repo: "g2", sessionId: "s2", model: "mB", agent: "ag1", phase: "ph1", price: priced(3), usage: u(1, 1, 1, 1) }),
    dashboardCall("a3-copy", { ts: M + D, project: "p2", sessionId: "fork", model: "mA", responseId: "resp-a1", copied: true, sourceFile: "synthetic/fork.jsonl", price: priced(2), usage: u(1, 2, 3, 4) }),
    dashboardCall("a4-unpriced", { ts: M, project: "p2", sessionId: null, model: "mC", actor: "warmer", price: { status: "unpriced", reason: "unknown-model" }, usage: u(5, 0, 0, 5) }),
    dashboardCall("r1-report", { ts: M + D, project: "p2", sessionId: "s3", actor: "subagent", runId: "rr", role: "reviewer", runName: "rn1", aggregate: true, sourceKind: "report", sourceFile: "synthetic/r1.jsonl", price: priced(10), usage: u(10, 10, 10, 10) }),
    dashboardCall("d1-detail", { ts: M + D, project: "p1", sessionId: "s1", actor: "subagent", runId: "dr", role: "worker", price: priced(1), usage: u(1, 1, 1, 1) }),
    dashboardCall("r2-replaced", { ts: M + D, project: "p1", sessionId: "s1", actor: "subagent", runId: "dr", aggregate: true, sourceKind: "report", price: priced(100), usage: u(100, 0, 0, 0) }),
    dashboardCall("c1-covered", { ts: M + D, project: "p3", actor: "aux", runId: "cov", price: priced(50), usage: u(50, 0, 0, 0) }),
    dashboardCall("o1-overlap", { ts: M + 2 * D, project: "p3", actor: "aux", runId: "hint", parentRunId: "rr", auxPurpose: "title", price: priced(1), usage: u(1, 1, 1, 1) }),
    dashboardCall("n1-null", { ts: M + 2 * D + 1, project: null, repo: null, sessionId: null, provider: null, model: null, price: priced(0), usage: u(1, 1, 1, 1) }),
    dashboardCall("x-before", { ts: M - 1, project: "p1", price: priced(1000), usage: u(1000, 0, 0, 0) }),
    dashboardCall("x-end", { ts: M + 3 * D, project: "p1", price: priced(1000), usage: u(1000, 0, 0, 0) }),
    dashboardCall("lonely-copy", { ts: M + 3 * D + 5, project: "p4", responseId: "lonely", copied: true, sourceFile: "synthetic/lonely.jsonl", price: priced(7), usage: u(1, 0, 0, 0) }),
  ], {
    coverageEdges: [{ reportRunId: "rr", includedRunId: "cov", evidence: "transcript" }],
    incompleteReports: [{ path: "synthetic/r1.jsonl", runId: "rr" }],
  }));
  reader = openDashboardReader(fixture.file, { instanceId: "rv", now: () => NOW, calibrationMode: () => "off", serverBuild: "b" })!;
});
afterEach(() => { reader.close(); fixture.close(); });
function inspect<T>(read: (ctx: DashboardQueryContext) => T): T {
  let failure: unknown;
  const result = reader.snapshot(ctx => { try { return read(ctx); } catch (error) { failure = error; } });
  if (failure) throw failure;
  return result as T;
}
const S: Slice = { start: M, end: M + 3 * D, filters: [] };
const pick = (m: UsageMeasure) => ({ calls: m.calls, aic: m.aic, total: m.tokens.total, prompt: m.tokens.prompt, unpriced: m.unpricedCalls,
  overlap: m.possibleOverlap, under: m.possibleUndercount, primary: m.aicDisplay.primaryAic });

it("hand totals", () => {
  inspect(ctx => {
    const all = queryExplorer(ctx, { slice: S, groupBy: ["project"], page: { limit: 200 } });
    expect(pick(all.totals)).toMatchObject({ calls: 7, aic: 17, total: 76, unpriced: 1, overlap: true, under: true });
    const byKey = Object.fromEntries(all.rows.map(r => [String(r.labels[0]), pick(r.measure)]));
    expect(byKey).toMatchObject({
      null: { calls: 1, aic: 0, total: 4, unpriced: 0, overlap: false, under: false },
      p1: { calls: 3, aic: 6, total: 18, unpriced: 0, overlap: false, under: false },
      p2: { calls: 2, aic: 10, total: 50, unpriced: 1, overlap: true, under: true },
      p3: { calls: 1, aic: 1, total: 4, unpriced: 0, overlap: true, under: false },
    });
    expect(all.rows.map(r => r.labels[0]).sort()).toEqual([null, "p1", "p2", "p3"]);
    expect(all.nextCursor).toBeNull();
    // exactly-limit page has no cursor
    expect(queryExplorer(ctx, { slice: S, groupBy: ["project"], page: { limit: 4 } }).nextCursor).toBeNull();
    const wide = { ...S, end: M + 4 * D };
    const w = queryExplorer(ctx, { slice: wide, groupBy: ["project"], page: { limit: 200 } });
    expect(w.rows.find(r => r.labels[0] === "p4")!.measure).toMatchObject({ calls: 1, aic: 7, tokens: { total: 1 } });
  });
});

it("null boundaries page correctly for every page size", () => {
  inspect(ctx => {
    for (const groupBy of [["project", "session"], ["session", "project", "model"], ["repo", "session", "requestedModel"]] as Dimension[][]) {
      const full = queryExplorer(ctx, { slice: S, groupBy, page: { limit: 200 } }).rows.map(r => JSON.stringify(r.key));
      for (const limit of [1, 2, 3]) {
        const got: string[] = []; let cursor: string | undefined; let pages = 0;
        do { expect(pages++).toBeLessThan(30); const p = queryExplorer(ctx, { slice: S, groupBy, page: { limit, cursor } }); got.push(...p.rows.map(r => JSON.stringify(r.key))); cursor = p.nextCursor ?? undefined; } while (cursor);
        expect(got, `${groupBy} ${limit}`).toEqual(full);
      }
    }
    for (const field of ["project", "session", "model", "requestedModel"] as Dimension[]) {
      const full = queryFilterValues(ctx, S, field, "", 200).rows;
      const got: unknown[] = []; let cursor: string | undefined; let pages = 0;
      do { expect(pages++).toBeLessThan(30); const p = queryFilterValues(ctx, S, field, "", 1, cursor); got.push(...p.rows); cursor = p.nextCursor ?? undefined; } while (cursor);
      expect(got, field).toEqual(full);
    }
  });
});


// Wrong dimension mappings preserve grand totals. These hand values pin each group's identity and measures.
it("each dimension maps to its own hand-valued groups", () => {
  const expected: Record<Dimension, readonly [string | null, number, number | null, number][]> = {
    project: [[null,1,0,4],["p1",3,6,18],["p2",2,10,50],["p3",1,1,4]],
    repo: [[null,1,0,4],["fixture-repo",4,12,58],["g1",1,2,10],["g2",1,3,4]],
    session: [[null,2,0,14],["parent-session",1,1,4],["s1",2,3,14],["s2",1,3,4],["s3",1,10,40]],
    actor: [["aux",1,1,4],["parent",3,5,18],["subagent",2,11,44],["warmer",1,null,10]],
    role: [[null,5,6,32],["reviewer",1,10,40],["worker",1,1,4]],
    agent: [[null,6,14,72],["ag1",1,3,4]],
    provider: [[null,1,0,4],["fixture-provider",6,17,72]],
    model: [[null,1,0,4],["fixture-model",3,12,48],["mA",1,2,10],["mB",1,3,4],["mC",1,null,10]],
    requestedModel: [[null,6,15,66],["rq1",1,2,10]],
    thinking: [[null,6,15,66],["high",1,2,10]],
    run: [[null,4,5,28],["dr",1,1,4],["hint",1,1,4],["rr",1,10,40]],
    runName: [[null,6,7,36],["rn1",1,10,40]],
    phase: [[null,6,14,72],["ph1",1,3,4]],
    parentRun: [[null,6,16,72],["rr",1,1,4]],
    auxPurpose: [[null,6,16,72],["title",1,1,4]],
    api: [[null,6,15,66],["api1",1,2,10]],
    day: [["2026-10-01",1,null,10],["2026-10-02",3,13,54],["2026-10-03",3,4,12]],
  };
  inspect(ctx => {
    for (const field of dims) {
      const rows = queryExplorer(ctx, { slice: S, groupBy: [field], page: { limit: 200 } }).rows;
      expect(rows.map(r => [r.labels[0], r.measure.calls, r.measure.aic, r.measure.tokens.total]).sort((a,b) => a[0] === null ? -1 : b[0] === null ? 1 : String(a[0]) < String(b[0]) ? -1 : 1), field).toEqual(expected[field]);
    }
  });
});

// A raw path or oversized stored value must never become a wire identity.
it("opaque ids keep home-relative worktree labels and bookmarked filters stable after restart", () => {
  const home = homedir();
  const paths = [join(home, "work", "repo", "one"), join(home, "work", "repo", "two")];
  fixture.ledger.apply(dashboardBatch(paths.map((project, i) => dashboardCall(`private-${i}`, { project, repo: join(home, "work", "repo") }))));
  const slice = { ...S, filters: [] };
  const first = inspect(ctx => queryFilterValues(ctx, slice, "project", "~/work", 1));
  expect(first.rows).toHaveLength(1);
  expect(first.rows[0]).toMatchObject({ id: expect.stringMatching(/^v1_[A-Za-z0-9_-]{43}$/), label: expect.stringMatching(/^~\/work\/repo\/(one|two)$/) });
  expect(first.nextCursor).not.toBeNull();
  const response = inspect(ctx => queryExplorer(ctx, { slice: { ...slice, filters: [{ kind: "id", field: "project", value: (first.rows[0] as unknown as { id: string }).id }] }, groupBy: ["project", "repo"], page: { limit: 1 } }));
  expect(response.rows[0]!.labels.every(value => value?.startsWith("~/work/repo"))).toBe(true);
  expect(response.rows[0]!.key.every(value => /^v1_[A-Za-z0-9_-]{43}$/.test(value!))).toBe(true);
  for (const payload of [first, response, JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())]) {
    expect(JSON.stringify(payload)).not.toContain(home);
    for (const path of paths) expect(JSON.stringify(payload)).not.toContain(path);
  }
  const id = (first.rows[0] as unknown as { id: string }).id;
  expect(inspect(ctx => queryExplorer(ctx, { slice: { ...slice, filters: [{ kind: "id", field: "project", value: id }] }, groupBy: ["project"], page: { limit: 1 } })).totals.calls).toBe(1);
  expect(() => inspect(ctx => queryExplorer(ctx, { slice: { ...slice, filters: [{ field: "project", value: paths[0]! }] }, groupBy: ["project"], page: { limit: 1 } }))).toThrow("invalid-query");
  const salt = readFileSync(fixture.file + ".explorer-salt");
  expect(salt).toHaveLength(32); expect(statSync(fixture.file + ".explorer-salt").mode & 0o777).toBe(0o600);
  reader.close();
  reader = openDashboardReader(fixture.file, { instanceId: "restarted", now: () => NOW, calibrationMode: () => "off", serverBuild: "b" })!;
  const again = inspect(ctx => queryFilterValues(ctx, slice, "project", "~/work", 200));
  expect(again.rows).toContainEqual(first.rows[0]);
  expect(inspect(ctx => queryExplorer(ctx, { slice: { ...slice, filters: [{ kind: "id", field: "project", value: id }] }, groupBy: ["project"], page: { limit: 1 } })).totals.calls).toBe(1);
  expect(readFileSync(fixture.file + ".explorer-salt")).toEqual(salt);
  fixture.ledger.apply(dashboardBatch([dashboardCall("outside", { project: "/srv/shared/worktree" }), dashboardCall("prefix-home", { project: home + "-other/worktree" })]));
  expect(inspect(ctx => queryFilterValues(ctx, slice, "project", "…/shared", 50)).rows).toContainEqual({ id: expect.any(String), label: "…/shared/worktree" });
  expect(inspect(ctx => queryFilterValues(ctx, slice, "project", "…/", 50)).rows).toContainEqual({ id: expect.any(String), label: "…/" + home.split("/").at(-1) + "-other/worktree" });
});

it("route cursors freeze the first page window when end is omitted", () => {
  inspect(ctx => {
    for (const route of EXPLORER_ROUTES) {
      for (const explicitStart of [false, true]) {
        const args: Record<string, string> = route.path.endsWith("filter-values") ? { field: "project", limit: "1" } : { groupBy: "project", limit: "1" };
        const params = new URLSearchParams(args);
        if (explicitStart) params.set("start", String(M));
        const first = route.handle(ctx, params) as { rows: unknown[]; nextCursor: string };
        expect(first.nextCursor).not.toBeNull();
        params.set("cursor", first.nextCursor);
        const next = route.handle({ ...ctx, now: () => NOW + 86400000 }, params);
        expect(next).toEqual(route.handle(ctx, params));
        const decoded = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString());
        expect(decoded.window).toEqual({ start: M, end: NOW });
        params.set("end", String(NOW + 1));
        if (!explicitStart) params.set("start", String(M));
        expect(() => route.handle(ctx, params)).toThrow("invalid-query");
      }
    }
  });
});

it("cursor signatures reject edited keys and authenticate before reporting revision changes", () => {
  inspect(ctx => {
    const result = queryExplorer(ctx, { slice: S, groupBy: ["project"], page: { limit: 1 } });
    const value = JSON.parse(Buffer.from(result.nextCursor!, "base64url").toString());
    value.key = ["v1_" + "A".repeat(43)];
    const tampered = Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const revision of [ctx.revision, "other:99"]) {
      expect(() => queryExplorer({ ...ctx, revision }, { slice: S, groupBy: ["project"], page: { limit: 1, cursor: tampered } })).toThrow("invalid-query");
    }
  });
});

it("canonical filter hashes ignore filter and object-property ordering", () => {
  inspect(ctx => {
    const a = { ...S, filters: [{ field: "actor" as const, value: "parent" }, { field: "model" as const, value: "mA" }] };
    const b = { ...S, filters: [{ value: "mA", field: "model" as const }, { value: "parent", field: "actor" as const }] };
    const one = JSON.parse(Buffer.from(encodeCursor("test", ctx.revision, a, [1]), "base64url").toString());
    const two = JSON.parse(Buffer.from(encodeCursor("test", ctx.revision, b, [1]), "base64url").toString());
    expect(one.queryHash).toBe(two.queryHash);
  });
});

it("prefix matching folds ASCII case but preserves Unicode and literal wildcards", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("ascii", { role: "Prefix%_\\one" }), dashboardCall("unicode", { role: "Éclair" }), dashboardCall("lower-unicode", { role: "éclair" })]));
  inspect(ctx => {
    expect(queryFilterValues(ctx, S, "role", "prefix%_\\", 50).rows).toEqual([{ id: expect.any(String), label: "Prefix%_\\one" }]);
    expect(queryFilterValues(ctx, S, "role", "É", 50).rows).toEqual([{ id: expect.any(String), label: "Éclair" }]);
  });
});

it("oversized keys return short opaque ids and clamped labels", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("oversized", { runName: "😀".repeat(2000) })]));
  inspect(ctx => {
    const values = queryFilterValues(ctx, S, "runName", "😀", 1);
    expect(values.rows).toEqual([{ id: expect.stringMatching(/^v1_[A-Za-z0-9_-]{43}$/), label: "😀".repeat(160) }]);
    const id = (values.rows[0] as unknown as { id: string }).id;
    const row = queryExplorer(ctx, { slice: { ...S, filters: [{ kind: "id", field: "runName", value: id }] }, groupBy: ["runName"], page: { limit: 1 } }).rows[0]!;
    expect(row.key).toEqual([id]); expect(row.labels).toEqual(["😀".repeat(160)]);
  });
});

it("byte caps shorten pages with usable cursors instead of rejecting stored rows", () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 200 }, (_, i) => dashboardCall(`budget-${i}`, {
    runName: String(i).padStart(3, "0") + "😀".repeat(157), role: "😀".repeat(160), phase: "😀".repeat(160),
  }))));
  inspect(ctx => {
    for (const endpoint of ["values", "pivot"]) {
      const fetch = (cursor?: string) => endpoint === "values" ? queryFilterValues(ctx, S, "runName", "", 200, cursor)
        : queryExplorer(ctx, { slice: S, groupBy: ["runName", "role", "phase"], page: { limit: 200, cursor } });
      const first = fetch();
      expect(first.rows.length).toBeGreaterThan(0); expect(first.rows.length).toBeLessThan(200);
      expect(first.nextCursor).not.toBeNull();
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual((endpoint === "values" ? 64 : 256) * 1024 - 512);
      const all = [...first.rows]; let cursor = first.nextCursor; let pages = 0;
      while (cursor && pages++ < 20) { const page = fetch(cursor); all.push(...page.rows); cursor = page.nextCursor; }
      expect(cursor).toBeNull();
      expect(all).toHaveLength(endpoint === "values" ? 202 : 204);
      expect(new Set(all.map(row => JSON.stringify("key" in row! ? row.key : (row as { id: string }).id))).size).toBe(all.length);
    }
  });
});

it("basis overwrite preserves Overview's published guard for missing evidence", () => {
  inspect(ctx => {
    vi.spyOn(ctx.calibration, "at").mockReturnValue({ status: "calibrated", factor: null, windowStart: M, windowEnd: M + D,
      coveredHours: 24, computedAic: 1000, counterDelta: 500, unpricedCalls: 0, method: "trailing-7d-ratio" });
    const result = queryExplorer(ctx, { slice: S, groupBy: ["project"], page: { limit: 200 } });
    expect(result.totals.aicDisplay.basis).toBe("published");
  });
});

// Bookmarked Explorer ids must be usable by the other dashboard views, including after restart.
it("shared slice selection resolves opaque filters for Overview", () => {
  const home = homedir();
  fixture.ledger.apply(dashboardBatch([dashboardCall("bookmark", { project: join(home, "work", "repo"), ts: M + 1234 })]));
  const project = inspect(ctx => queryFilterValues(ctx, S, "project", "~/work", 50).rows[0]!.id!);
  const day = inspect(ctx => queryFilterValues(ctx, S, "day", "2026-10-01", 50).rows[0]!.id!);
  reader.close();
  reader = openDashboardReader(fixture.file, { instanceId: "bookmark-restart", now: () => NOW, calibrationMode: () => "off", serverBuild: "b" })!;
  inspect(ctx => {
    expect(queryOverview(ctx, { ...S, filters: [{ kind: "id", field: "project", value: project }] }).totals).toMatchObject({ calls: 1, aic: 1 });
    expect(queryOverview(ctx, { ...S, filters: [{ kind: "id", field: "project", value: project }, { kind: "id", field: "day", value: day }] }).totals.calls).toBe(1);
  });
});

it("shared signed cursors preserve Overview and live source-error paging", () => {
  for (let i = 0; i < 3; i++) fixture.db.prepare("INSERT INTO import_state(path,last_ingest_at,parse_errors,generation) VALUES (?,?,?,0)").run(`synthetic/error-${i}`, NOW, 1);
  inspect(ctx => {
    const long = { ...S, end: M + 40 * D };
    const daily = queryOverview(ctx, long).daily;
    expect(daily.nextCursor).not.toBeNull();
    const params = new URLSearchParams({ start: String(long.start), end: String(long.end), cursor: daily.nextCursor! });
    expect((OVERVIEW_ROUTES[1]!.handle(ctx, params) as ReturnType<typeof queryOverview>).daily.rows).toHaveLength(9);
    const first = querySourceErrors(ctx, { limit: 1 });
    expect(querySourceErrors({ ...ctx, revision: ctx.revision + "-changed" }, { limit: 1, cursor: first.nextCursor! }).rows).toHaveLength(1);
    for (const [cursor, run] of [
      [daily.nextCursor!, (cursor: string) => OVERVIEW_ROUTES[1]!.handle(ctx, new URLSearchParams({ start: String(long.start), end: String(long.end), cursor }))],
      [first.nextCursor!, (cursor: string) => querySourceErrors(ctx, { limit: 1, cursor })],
    ] as const) {
      const payload = JSON.parse(Buffer.from(cursor, "base64url").toString());
      payload.key[0]++;
      expect(() => run(Buffer.from(JSON.stringify(payload)).toString("base64url"))).toThrow("invalid-query");
    }
  });
});


it("ids are dimension-scoped even when stored values and labels coincide", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("same-value", { role: "same", runName: "same" })]));
  inspect(ctx => {
    const role = queryFilterValues(ctx, S, "role", "same", 1).rows[0]!.id!;
    const name = queryFilterValues(ctx, S, "runName", "same", 1).rows[0]!.id;
    expect(role).not.toBe(name);
    expect(() => queryExplorer(ctx, { slice: { ...S, filters: [{ kind: "id", field: "runName", value: role }] }, groupBy: ["runName"], page: { limit: 1 } })).toThrow("unknown-filter-id");
  });
});


it("HTTP envelopes and validation use the cursor's frozen Explorer window", async () => {
  let now = NOW;
  reader.close();
  reader = openDashboardReader(fixture.file, { instanceId: "http-fixture", now: () => now, calibrationMode: () => "off", serverBuild: "b" })!;
  const secret = "synthetic-test-only-secret";
  const server = await startUsageHttpServer({ instanceId: "http-fixture", serverBuild: "b", secret, reader, routes: EXPLORER_ROUTES,
    html: "<!doctype html><title>Fixture</title>", now: () => now });
  const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end();
  });
  try {
    const minted = await get("/local/bootstrap-nonce", { Authorization: `Bearer ${secret}` });
    expect(minted.status).toBe(200);
    const boot = await get("/bootstrap?nonce=" + JSON.parse(minted.body).data.nonce);
    const cookie = boot.headers["set-cookie"]![0]!.split(";")[0]!;
    for (const explicitStart of [false, true]) for (const endpoint of ["explorer", "filter-values"]) {
      const firstEnd = now;
      const params = new URLSearchParams(endpoint === "explorer" ? "groupBy=project&limit=1" : "field=project&limit=1");
      if (explicitStart) params.set("start", String(M));
      const first = await get(`/api/${endpoint}?${params}`, { Cookie: cookie });
      expect(first.status).toBe(200);
      const value = JSON.parse(first.body); expect(value.data.nextCursor).not.toBeNull();
      params.set("cursor", value.data.nextCursor); now += 1000;
      const next = await get(`/api/${endpoint}?${params}`, { Cookie: cookie });
      expect(next.status).toBe(200);
      expect(JSON.parse(next.body).period).toEqual({ start: M, end: firstEnd });
    }
  } finally { await server.close(); }
});
