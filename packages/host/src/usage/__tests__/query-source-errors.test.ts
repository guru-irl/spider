import { afterEach, expect, it, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

let fixture: ReturnType<typeof createDashboardFixture>;
afterEach(() => fixture?.close());

it("source errors page kinds through a single rowid scan without a temp sort", async () => {
  fixture = createDashboardFixture(false);
  fixture.ledger.apply(dashboardBatch([], {
    states: ["synthetic/a.jsonl", "synthetic/b.jsonl"].map(path => ({ path, inode: "fixture", size: 10, offset: 10,
      mtimeMs: DASHBOARD_NOW, parseErrors: 3, generation: 0, prefixHash: "fixture" })),
    sourceErrors: [{ path: "synthetic/a.jsonl", code: "EIO" }],
  }));
  const { querySourceErrors } = await import("../query-source-errors.js");
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture" })!;
  try {
    reader.snapshot(ctx => {
      const original = ctx.db.prepare.bind(ctx.db);
      const plans: string[] = [];
      const prepare = vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
        const statement = original(sql);
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          plans.push(...(original(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(row => row.detail));
          return all(...args);
        });
        return statement;
      });
      try {
        const first = querySourceErrors(ctx, { limit: 1 });
        const second = querySourceErrors(ctx, { limit: 1, cursor: first.nextCursor! });
        const third = querySourceErrors(ctx, { limit: 1, cursor: second.nextCursor! });
        expect([first.rows[0]!.code, second.rows[0]!.code, third.rows[0]!.code]).toEqual(["parse-errors", "EIO", "parse-errors"]);
        expect(third.nextCursor).toBeNull();
        expect(plans.join("\n")).not.toContain("TEMP B-TREE");
        expect(plans.filter(detail => detail.includes("SEARCH import_state USING INTEGER PRIMARY KEY"))).toHaveLength(3);
      } finally { prepare.mockRestore(); }
    });
  } finally { reader.close(); }
});

it("source errors are bounded and path-redacted", async () => {
  fixture = createDashboardFixture(false);
  const paths = Array.from({ length: 225 }, (_, index) => `/synthetic-private/deep/source-${index}.jsonl`);
  fixture.ledger.apply(dashboardBatch([dashboardCall("error-project", { sourceFile: paths[0]!, project: "C:\\synthetic-private\\project-name" })], {
    states: paths.map((path, index) => ({ path, inode: "fixture-inode", size: 100, offset: 100, mtimeMs: DASHBOARD_NOW,
      parseErrors: index + 1, generation: 0, prefixHash: "fixture-hash" })),
    sourceErrors: paths.map(path => ({ path, code: "EACCES", checkedPaths: ["/checked-private/fallback.jsonl"] })),
  }));
  const api = await import("../query-source-errors.js").catch(() => null);
  expect(api, "redacted source errors API must exist").not.toBeNull();
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture-instance", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture-build" })!;
  try {
    let cursor: string | undefined;
    const rows = [];
    do {
      const page = reader.snapshot(ctx => {
        const spy = vi.spyOn(ctx.db, "prepare");
        const result = api!.querySourceErrors(ctx, { limit: 50, cursor });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]![0]).toContain("INDEXED BY calls_source_run");
        spy.mockRestore();
        return result;
      });
      expect(page.rows.length).toBeLessThanOrEqual(50);
      rows.push(...page.rows);
      expect(JSON.stringify(page)).not.toMatch(/synthetic-private|checked-private|%2[fF]|%5[cC]|source_error_paths/);
      if (page.nextCursor) {
        expect(Buffer.from(page.nextCursor, "base64url").toString()).not.toMatch(/source-\d|synthetic-private|checked-private/);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(rows).toHaveLength(450);
    expect(new Set(rows.map(row => `${row.sourceLabel}:${row.code}`)).size).toBe(450);
    expect(rows.find(row => row.sourceLabel === "source-0.jsonl")!.projectLabel).toBe("project-name");
    expect(rows.filter(row => row.code === "EACCES").every(row => row.count === 1)).toBe(true);
    expect(rows.filter(row => row.code === "parse-errors").map(row => row.count)).toEqual(Array.from({ length: 225 }, (_, i) => i + 1));
    expect(rows.every(row => row.lastCheckedAt === DASHBOARD_NOW)).toBe(true);
    expect(Object.keys(rows[0]!).sort()).toEqual(["sourceLabel", "projectLabel", "code", "count", "lastCheckedAt"].sort());
    const diagnostics = api!.readSourceErrorDiagnostics(fixture.db, 20);
    expect(diagnostics.rows).toHaveLength(20);
    expect(diagnostics.truncated).toBe(true);
    reader.snapshot(ctx => {
      expect(() => api!.querySourceErrors(ctx, { limit: 201 })).toThrow("invalid-query");
      expect(() => api!.querySourceErrors(ctx, { limit: 50, cursor: "x".repeat(2049) })).toThrow("invalid-query");
      const page = api!.querySourceErrors(ctx, { limit: 50 });
      expect(() => api!.querySourceErrors(ctx, { limit: 51, cursor: page.nextCursor! })).toThrow("invalid-query");
      const changed = { ...ctx, instanceId: "different-instance" };
      expect(() => api!.querySourceErrors(changed, { limit: 50, cursor: page.nextCursor! })).toThrow("ledger-changed");
    });
    fixture.db.prepare("UPDATE import_state SET source_error_code=? WHERE path=?").run("synthetic/private/hostile-code", paths[1]);
    const hostile = api!.readSourceErrorDiagnostics(fixture.db, 200);
    expect(hostile.rows.find(row => row.sourceLabel === "source-1.jsonl" && row.code !== "parse-errors")!.code).toBe("source-error");
    expect(JSON.stringify(hostile)).not.toContain("hostile-code");
    fixture.db.prepare("UPDATE import_state SET path=?, source_error_code=? WHERE path=?")
      .run("%2Fencoded-private%2F" + "x".repeat(200) + ".jsonl", "unknown-aux-purpose:/private/path:7", paths[0]);
    const redacted = api!.readSourceErrorDiagnostics(fixture.db, 200);
    expect(redacted.rows[0]!.sourceLabel).toBe("x".repeat(160));
    fixture.db.prepare("UPDATE import_state SET path=? WHERE path=?").run("synthetic/control-\u0001name.jsonl", paths[2]);
    expect(api!.readSourceErrorDiagnostics(fixture.db, 200).rows.find(row => row.code === "parse-errors" && row.count === 3)!.sourceLabel).toBe("control-name.jsonl");
    expect(JSON.stringify(redacted)).not.toMatch(/encoded-private|private\/path|%2F/);
  } finally { reader.close(); }
});


it("single-kind sources page completely at limit one across call ingest", async () => {
  fixture = createDashboardFixture(false);
  fixture.ledger.apply(dashboardBatch([], {
    states: ["a", "b", "c", "d"].map(name => ({ path: `synthetic/${name}.jsonl`, inode: "fixture", size: 10, offset: 10,
      mtimeMs: DASHBOARD_NOW, parseErrors: 1, generation: 0, prefixHash: "fixture" })),
  }));
  const { querySourceErrors, readSourceErrorDiagnostics } = await import("../query-source-errors.js");
  const { encodeCursor } = await import("../dashboard-selection.js");
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture" })!;
  const other = openDashboardReader(fixture.file, { instanceId: "other", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture" })!;
  try {
    const first = reader.snapshot(ctx => querySourceErrors(ctx, { limit: 1 }));
    expect(first.nextCursor).not.toBeNull();
    expect(() => other.snapshot(ctx => querySourceErrors(ctx, { limit: 1, cursor: first.nextCursor! }))).toThrow("ledger-changed");
    const before = reader.revision();
    fixture.ledger.apply(dashboardBatch([dashboardCall("between-pages")]));
    expect(reader.revision()).not.toBe(before);
    const rows = [...first.rows];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = reader.snapshot(ctx => querySourceErrors(ctx, { limit: 1, cursor: cursor! }));
      rows.push(...page.rows);
      cursor = page.nextCursor;
    }
    expect(rows.map(row => row.sourceLabel)).toEqual(["a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl"]);
    expect(new Set(rows.map(row => row.sourceLabel)).size).toBe(4);
    expect(readSourceErrorDiagnostics(fixture.db, 4)).toMatchObject({ truncated: false, rows: expect.any(Array) });
    expect(readSourceErrorDiagnostics(fixture.db, 4).rows).toHaveLength(4);
    reader.snapshot(ctx => {
      const cursor = encodeCursor("source-errors", `${ctx.instanceId}:source-errors`, { limit: 1 }, [1, 2]);
      expect(() => querySourceErrors(ctx, { limit: 1, cursor })).toThrow("invalid-query");
    });
  } finally { other.close(); reader.close(); }
});
