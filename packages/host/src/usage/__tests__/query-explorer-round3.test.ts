import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { linkSync, unlinkSync } from "node:fs";
import { dashboardLabel } from "../dashboard-identities.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryExplorer, queryFilterValues } from "../query-explorer.js";
import { queryOverview } from "../query-overview.js";
import { querySourceErrors } from "../query-source-errors.js";
import type { DashboardQueryContext, DashboardReader, Dimension, Filter, Slice } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_NOW as NOW, DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";

let fixture: ReturnType<typeof createDashboardFixture>;
let reader: DashboardReader;
const S: Slice = { start: M, end: M + 15 * D, filters: [] };
const open = () => openDashboardReader(fixture.file, { instanceId: "reused-boot-name", now: () => NOW, calibrationMode: () => "off", serverBuild: "fixture" })!;
const id = (field: Dimension, value: string | null): Filter => ({ field, value, kind: "id" } as Filter);
function inspect<T>(fn: (ctx: DashboardQueryContext) => T): T {
  let error: unknown;
  const result = reader.snapshot(ctx => { try { return fn(ctx); } catch (failure) { error = failure; } });
  if (error) throw error;
  return result as T;
}
beforeEach(() => {
  fixture = createDashboardFixture(false);
  fixture.ledger.apply(dashboardBatch([dashboardCall("a", { project: "project-a", model: "alpha" }), dashboardCall("b", { project: "project-b", model: "Bravo" })]));
  reader = open();
});
afterEach(() => { reader.close(); fixture.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

// Splitting at whitespace discloses the outside-home ancestor segments.
it("path-valued labels split only on separators, including spaces inside and outside home", () => {
  const home = "/synthetic/home with spaces";
  for (const field of ["project", "repo"] as const) {
    expect(dashboardLabel(field, home + "/src/repo with spaces", home)).toBe("~/src/repo with spaces");
    expect(dashboardLabel(field, "/Volumes/Data Drive/clients/acme/repo", home)).toBe("…/acme/repo");
    expect(dashboardLabel(field, "/srv/team share/secret-client/app", home)).toBe("…/secret-client/app");
    expect(dashboardLabel(field, "C:\\team share\\clients\\acme\\repo with spaces", home)).toBe("…/acme/repo with spaces");
    expect(dashboardLabel(field, "\\\\server\\team share\\clients\\acme\\repo", home)).toBe("…/acme/repo");
  }
});

// A complete prefix set may serve narrower keystrokes, but never another window/filter/revision.
it("typeahead reuses a bounded revision cache across literal ASCII-only prefix keystrokes", () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("wild", { model: "a%_\\literal" }), dashboardCall("unicode", { model: "Örebro" }),
    dashboardCall("later", { ts: M + 20 * D, model: "later" }),
  ]));
  inspect(ctx => {
    const prepare = vi.spyOn(ctx.db, "prepare");
    const all = queryFilterValues(ctx, S, "model", "", 1);
    expect(all.nextCursor).not.toBeNull(); expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockClear();
    expect(queryFilterValues(ctx, S, "model", "AL", 200).rows.map(row => row.label)).toEqual(["alpha"]);
    expect(queryFilterValues(ctx, S, "model", "a%_\\", 200).rows.map(row => row.label)).toEqual(["a%_\\literal"]);
    expect(queryFilterValues(ctx, S, "model", "ö", 200).rows).toEqual([]);
    expect(queryFilterValues(ctx, S, "model", "Ö", 200).rows.map(row => row.label)).toEqual(["Örebro"]);
    expect(queryFilterValues(ctx, S, "model", "", 1, all.nextCursor!).rows).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(queryFilterValues(ctx, { ...S, end: M + 21 * D }, "model", "later", 200).rows.map(row => row.label)).toEqual(["later"]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(queryFilterValues(ctx, { ...S, filters: [id("project", queryFilterValues(ctx, S, "project", "project-a", 200).rows[0]!.id)] }, "model", "", 200).rows.map(row => row.label)).toEqual(["alpha"]);
    prepare.mockRestore();
  });
  fixture.db.prepare("UPDATE calls SET model='replacement' WHERE id='a'").run();
  expect(inspect(ctx => queryFilterValues(ctx, S, "model", "AL", 200)).rows).toEqual([]);
  expect(inspect(ctx => queryFilterValues(ctx, S, "model", "rep", 200)).rows[0]!.label).toBe("replacement");
});
it("typeahead cannot reuse a partial prefix set for wider or disjoint prefixes", () => {
  inspect(ctx => {
    expect(queryFilterValues(ctx, S, "model", "al", 200).rows.map(row => row.label)).toEqual(["alpha"]);
    const prepare = vi.spyOn(ctx.db, "prepare");
    expect(queryFilterValues(ctx, S, "model", "Br", 200).rows.map(row => row.label)).toEqual(["Bravo"]);
    expect(queryFilterValues(ctx, S, "model", "", 200).rows.map(row => row.label)).toEqual(["alpha", "Bravo"]);
    expect(prepare).toHaveBeenCalledTimes(2); prepare.mockRestore();
  });
});
it("typeahead evicts old windows and does not retain oversized distinct sets", () => {
  inspect(ctx => {
    queryFilterValues(ctx, S, "model", "", 200);
    for (let n = 1; n <= 33; n++) queryFilterValues(ctx, { ...S, end: S.end + n }, "model", "", 200);
    const prepare = vi.spyOn(ctx.db, "prepare");
    queryFilterValues(ctx, S, "model", "a", 200);
    expect(prepare).toHaveBeenCalledTimes(1); prepare.mockRestore();
  });
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 4097 }, (_, n) => dashboardCall(`large-${n}`, { model: `large-${String(n).padStart(4, "0")}` }))));
  inspect(ctx => {
    queryFilterValues(ctx, S, "model", "large-", 200);
    const prepare = vi.spyOn(ctx.db, "prepare");
    expect(queryFilterValues(ctx, S, "model", "large-4096", 200).rows[0]!.label).toBe("large-4096");
    expect(prepare).toHaveBeenCalledTimes(1); prepare.mockRestore();
  });
});

it("typeahead does not retain a complete set above its byte ceiling", () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 3000 }, (_, n) => dashboardCall(`wide-${n}`, {
    model: String(n).padStart(4, "0") + "😀".repeat(156),
  }))));
  inspect(ctx => {
    const first = queryFilterValues(ctx, S, "model", "", 200);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(64 * 1024);
    const prepare = vi.spyOn(ctx.db, "prepare");
    expect(queryFilterValues(ctx, S, "model", "2999", 200).rows[0]!.label).toBe("2999" + "😀".repeat(156));
    expect(prepare).toHaveBeenCalledTimes(1); prepare.mockRestore();
  });
});

it("unsupported detail values are non-selectable counts and null ids never filter missing sessions", () => {
  fixture.db.prepare("UPDATE calls SET session_id=NULL WHERE id IN ('a','b')").run();
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("bad", { sessionId: "bad id", runId: "bad/id" }),
    dashboardCall("bad2", { sessionId: "/private/session", runId: "another bad id" }),
    dashboardCall("safe", { sessionId: "safe-session", runId: "safe-run" }),
    dashboardCall("copy", { sessionId: "bad id", runId: "bad/id", copied: true, responseId: "native" }),
    dashboardCall("native", { ts: M - 1, responseId: "native" }),
  ]));
  inspect(ctx => {
    for (const field of ["session", "run"] as const) {
      expect(queryFilterValues(ctx, S, field, "unsupported", 200).rows).toEqual([{ id: null, label: "unsupported id", count: 2 }]);
      expect(() => queryExplorer(ctx, { slice: { ...S, filters: [id(field, null)] }, groupBy: [field], page: { limit: 200 } })).toThrow("invalid-query");
      expect(() => queryFilterValues(ctx, { ...S, filters: [id(field, null)] }, field, "", 200)).toThrow("invalid-query");
      expect(() => queryOverview(ctx, { ...S, filters: [id(field, null)] })).toThrow("invalid-query");
      expect(queryExplorer(ctx, { slice: { ...S, filters: [{ field, kind: "missing" }] }, groupBy: [field], page: { limit: 200 } }).totals.calls).toBe(2);
    }
  });
});

// These specifically kill the two non-equivalent survivors in re-review 2.
it("id dictionaries resolve independently in two windows of one revision", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("later", { ts: M + 20 * D, project: "later-project" })]));
  inspect(ctx => {
    const later: Slice = { start: M + 16 * D, end: M + 21 * D, filters: [] };
    const a = queryFilterValues(ctx, S, "project", "project-a", 200).rows[0]!.id!;
    const b = queryFilterValues(ctx, later, "project", "later-project", 200).rows[0]!.id!;
    const filtered = (slice: Slice, value: string) => queryExplorer(ctx, { slice: { ...slice, filters: [id("project", value)] }, groupBy: ["project"], page: { limit: 200 } });
    expect(filtered(S, a).totals.calls).toBe(1);
    expect(filtered(later, b).totals.calls).toBe(1);
    expect(() => filtered(later, a)).toThrow("unknown-filter-id");
    expect(() => filtered(S, b)).toThrow("unknown-filter-id");
  });
});
it("Explorer rejects an id-shaped filter without explicit kind id", () => {
  inspect(ctx => {
    const value = queryFilterValues(ctx, S, "project", "project-a", 200).rows[0]!.id!;
    const prepare = vi.spyOn(ctx.db, "prepare");
    expect(() => queryExplorer(ctx, { slice: { ...S, filters: [{ field: "project", value }] }, groupBy: ["model"], page: { limit: 200 } })).toThrow("invalid-query");
    expect(prepare).not.toHaveBeenCalled(); prepare.mockRestore();
  });
});
it("cold id-filtered requests stay within the revised SELECT caps", () => {
  const keys = inspect(ctx => ({ project: queryFilterValues(ctx, S, "project", "project-a", 200).rows[0]!.id!, model: queryFilterValues(ctx, S, "model", "alpha", 200).rows[0]!.id! }));
  inspect(ctx => {
    const prepare = vi.spyOn(ctx.db, "prepare");
    const slice = { ...S, filters: [id("project", keys.project), id("model", keys.model)] };
    expect(queryFilterValues(ctx, slice, "model", "", 200).rows[0]!.label).toBe("alpha");
    expect(prepare).toHaveBeenCalledTimes(2); prepare.mockRestore();
  });
  reader.close(); reader = open();
  inspect(ctx => {
    const prepare = vi.spyOn(ctx.db, "prepare");
    expect(queryExplorer(ctx, { slice: { ...S, filters: [id("project", keys.project), id("model", keys.model), id("project", keys.project)] }, groupBy: ["model"], page: { limit: 200 } }).totals.calls).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(3); prepare.mockRestore();
  });
});
it("identity failure is cached for five seconds and stray-temp recovery preserves ids", () => {
  const salt = fixture.file + ".explorer-salt", temporary = salt + ".stray";
  const first = inspect(ctx => queryFilterValues(ctx, S, "project", "project-a", 200)).rows[0]!.id;
  reader.close(); reader = open(); linkSync(salt, temporary);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(100000);
  const values = () => inspect(ctx => queryFilterValues(ctx, S, "project", "project-a", 200));
  expect(values).toThrow("identity-unavailable");
  unlinkSync(temporary);
  expect(values).toThrow("identity-unavailable");
  vi.setSystemTime(104999); expect(values).toThrow("identity-unavailable");
  vi.setSystemTime(105000); expect(values().rows[0]!.id).toBe(first);
});
it("reader boots get a fresh instance even when the caller reuses its instance name", () => {
  for (let n = 0; n < 3; n++) fixture.db.prepare("INSERT INTO import_state(path,last_ingest_at,parse_errors,generation) VALUES (?,?,?,0)").run(`synthetic/error-${n}`, NOW, 1);
  const old = inspect(ctx => ({ instance: ctx.instanceId, explorer: queryExplorer(ctx, { slice: S, groupBy: ["project"], page: { limit: 1 } }).nextCursor!, values: queryFilterValues(ctx, S, "project", "", 1).nextCursor!, errors: querySourceErrors(ctx, { limit: 1 }).nextCursor! }));
  reader.close(); reader = open();
  inspect(ctx => {
    expect(ctx.instanceId).not.toBe(old.instance);
    // Mint first, so this also catches the old same-instance MAC mismatch returning 400.
    queryExplorer(ctx, { slice: S, groupBy: ["project"], page: { limit: 1 } });
    expect(() => queryExplorer(ctx, { slice: S, groupBy: ["project"], page: { limit: 1, cursor: old.explorer } })).toThrow("ledger-changed");
    expect(() => queryFilterValues(ctx, S, "project", "", 1, old.values)).toThrow("ledger-changed");
    expect(() => querySourceErrors(ctx, { limit: 1, cursor: old.errors })).toThrow("ledger-changed");
  });
});
