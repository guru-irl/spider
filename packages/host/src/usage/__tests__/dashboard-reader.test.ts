import { afterEach, expect, it, vi } from "vitest";
import * as dbCore from "@spider/db-core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@spider/db-core";
import type { DashboardQueryContext } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

let fixture: ReturnType<typeof createDashboardFixture>;
const readers: { close(): void }[] = [];
afterEach(() => { for (const reader of readers.splice(0)) reader.close(); fixture?.close(); });

it("rejects a missing calibration callback before opening a database", async () => {
  fixture = createDashboardFixture();
  const { openDashboardReader } = await import("../dashboard-reader.js");
  const opener = vi.spyOn(dbCore, "openDbReadOnly");
  try {
    // @ts-expect-error Exercise an untyped caller omitting the required callback.
    expect(() => openDashboardReader(join(fixture.root, "missing.db"), { instanceId: "fixture", now: () => DASHBOARD_NOW, serverBuild: "fixture" }))
      .toThrow("calibrationMode must be a function");
    expect(opener).not.toHaveBeenCalled();
  } finally { opener.mockRestore(); }
});

it("rejects invalid runtime modes without invoking snapshot queries", async () => {
  fixture = createDashboardFixture();
  const { openDashboardReader } = await import("../dashboard-reader.js");
  let mode: unknown = "off";
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture", now: () => DASHBOARD_NOW, serverBuild: "fixture",
    calibrationMode: () => mode as "auto" | "off" })!;
  readers.push(reader);
  const query = vi.fn((ctx: DashboardQueryContext) => ctx.calibrationMode);
  expect(reader.snapshot(query)).toBe("off");
  query.mockClear();
  for (mode of [undefined, null, "invalid"]) {
    expect(() => reader.snapshot(query)).toThrow("internal");
    expect(query).not.toHaveBeenCalled();
  }
  mode = "auto";
  expect(reader.snapshot(query)).toBe("auto");
});

it("readonly opener never creates or upgrades", async () => {
  fixture = createDashboardFixture();
  const api = await import("../dashboard-reader.js").catch(() => null);
  expect(api, "reader API must exist").not.toBeNull();
  const options = { calibrationMode: () => "auto" as const, instanceId: "fixture-instance", now: () => DASHBOARD_NOW, serverBuild: "fixture-build" };
  const missing = join(fixture.root, "missing.db");
  expect(api!.openDashboardReader(missing, options)).toBeUndefined();
  expect(existsSync(missing)).toBe(false);
  const junk = join(fixture.root, "junk.db");
  writeFileSync(junk, "synthetic junk, not SQLite");
  expect(() => api!.openDashboardReader(junk, options)).toThrow("unsupported-schema");
  expect(readFileSync(junk, "utf8")).toBe("synthetic junk, not SQLite");
  const empty = join(fixture.root, "empty.db");
  writeFileSync(empty, "");
  expect(() => api!.openDashboardReader(empty, options)).toThrow("unsupported-schema");
  expect(readFileSync(empty)).toHaveLength(0);
  expect(() => api!.openDashboardReader(fixture.root, options)).toThrow("ledger-unavailable");
  const v1File = join(fixture.root, "v1.db");
  const v1 = openDb(v1File);
  v1.exec(readFileSync(new URL("./fixtures/usage-v1.sql", import.meta.url), "utf8"));
  const before = v1.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
  const old = api!.openDashboardReader(v1File, options)!;
  readers.push(old);
  expect(() => old.revision()).toThrow("ledger-unavailable");
  expect(() => old.snapshot(() => 42)).toThrow("ledger-unavailable");
  expect(v1.pragma("user_version")).toBe(1);
  expect(v1.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
  v1.pragma("user_version=99");
  expect(() => api!.openDashboardReader(v1File, options)).toThrow("unsupported-schema");
  expect(v1.pragma("user_version")).toBe(99);
  v1.close();
  const current = api!.openDashboardReader(fixture.file, options)!;
  readers.push(current);
  current.snapshot(ctx => {
    expect(ctx.db.pragma("query_only")).toBe(1);
    expect(() => ctx.db.prepare("DELETE FROM calls").run()).toThrow();
  });
});

it.each([
  ["SQLITE_NOTADB", "unsupported-schema"], ["SQLITE_CORRUPT", "unsupported-schema"],
  ["SQLITE_CANTOPEN", "ledger-unavailable"], ["SQLITE_IOERR", "ledger-unavailable"], ["SQLITE_BUSY", "busy"],
])("open maps %s to a fixed %s error", async (code, expected) => {
  const { openDashboardReader } = await import("../dashboard-reader.js");
  const opener = vi.spyOn(dbCore, "openDbReadOnly").mockImplementationOnce(() => { throw Object.assign(new Error("synthetic private error"), { code }); });
  try {
    expect(() => openDashboardReader("synthetic.db", { instanceId: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture" })).toThrow(expected);
  } finally { opener.mockRestore(); }
});

it("first pragma failure closes its handle and maps corrupt errors", async () => {
  fixture = createDashboardFixture();
  const { openDashboardReader } = await import("../dashboard-reader.js");
  const db = dbCore.openDbReadOnly(fixture.file)!;
  const closed = vi.spyOn(db, "close");
  const pragma = vi.spyOn(db, "pragma").mockImplementationOnce(() => { throw Object.assign(new Error("synthetic corrupt"), { code: "SQLITE_CORRUPT" }); });
  const opener = vi.spyOn(dbCore, "openDbReadOnly").mockReturnValueOnce(db);
  try {
    expect(() => openDashboardReader(fixture.file, { instanceId: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture" })).toThrow("unsupported-schema");
    expect(closed).toHaveBeenCalledOnce();
  } finally { opener.mockRestore(); pragma.mockRestore(); closed.mockRestore(); }
});

it("standalone status reads all tables in a deferred transaction", async () => {
  fixture = createDashboardFixture();
  const { openDashboardReader } = await import("../dashboard-reader.js");
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture" })!;
  readers.push(reader);
  const db = reader.snapshot(ctx => ctx.db);
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
    expect(db.raw.inTransaction).toBe(true);
    return prepare(sql);
  });
  try { expect(reader.status().schemaVersion).toBe(3); } finally { spy.mockRestore(); }
});

it("status refreshes schema version after a writable migration", async () => {
  fixture = createDashboardFixture();
  const file = join(fixture.root, "migration.db");
  const v1 = openDb(file);
  try { v1.exec(readFileSync(new URL("./fixtures/usage-v1.sql", import.meta.url), "utf8")); } finally { v1.close(); }
  const { openDashboardReader } = await import("../dashboard-reader.js");
  const reader = openDashboardReader(file, { instanceId: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture" })!;
  readers.push(reader);
  expect(reader.status().schemaVersion).toBe(1);
  const { openUsageLedger } = await import("../ledger.js");
  const migrated = openUsageLedger(file);
  migrated.close();
  expect(reader.status().schemaVersion).toBe(3);
  expect(reader.snapshot(ctx => ctx.status().schemaVersion)).toBe(3);
});

it("reader generations retain the launcher owner prefix and invalidate old cursors", async () => {
  // A generation appended before the owner separator makes a healthy server fail readiness.
  fixture = createDashboardFixture();
  const { openDashboardReader } = await import("../dashboard-reader.js");
  const { encodeCursor, decodeCursor } = await import("../dashboard-selection.js");
  const options = { instanceId: "fixture-owner", now: () => DASHBOARD_NOW,
    calibrationMode: () => "off" as const, serverBuild: "fixture-build" };
  const first = openDashboardReader(fixture.file, options)!;
  readers.push(first);
  const revision = first.revision();
  expect(revision.startsWith("fixture-owner:")).toBe(true);
  const cursor = encodeCursor("fixture-endpoint", revision, {}, ["fixture-key"]);
  expect(decodeCursor(cursor, "fixture-endpoint", revision, {})).toEqual(["fixture-key"]);
  const firstInstance = first.snapshot(ctx => ctx.instanceId);
  readers.pop(); first.close();
  const reopened = openDashboardReader(fixture.file, options)!;
  readers.push(reopened);
  expect(reopened.revision().startsWith("fixture-owner:")).toBe(true);
  expect(reopened.snapshot(ctx => ctx.instanceId)).not.toBe(firstInstance);
  expect(reopened.revision()).not.toBe(revision);
  expect(() => decodeCursor(cursor, "fixture-endpoint", reopened.revision(), {})).toThrow("ledger-changed");
});

it("snapshot revision tracks only call content", async () => {
  fixture = createDashboardFixture();
  const { openDashboardReader } = await import("../dashboard-reader.js");
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture-instance", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture-build" })!;
  readers.push(reader);
  const revision = reader.revision();
  fixture.db.prepare("INSERT INTO leases(name,owner,token) VALUES ('ingest','fixture-owner','fixture-token')").run();
  fixture.db.prepare("UPDATE ledger_metadata SET value=value WHERE key='worker-snapshot'").run();
  fixture.ledger.insertCounter({ ts: DASHBOARD_NOW, creditsUsed: 10, raw: {} });
  expect(reader.revision()).toBe(revision);
  reader.snapshot(ctx => {
    expect(ctx.db.raw.inTransaction).toBe(true);
    expect(ctx.revision).toBe(revision);
    const before = ctx.db.prepare("SELECT calls FROM ledger_totals").get();
    fixture.ledger.apply(dashboardBatch([dashboardCall("new-content")]));
    expect(ctx.db.prepare("SELECT calls FROM ledger_totals").get()).toEqual(before);
    expect(reader.revision()).toBe(revision);
  });
  expect(reader.revision()).not.toBe(revision);
  reader.snapshot(ctx => {
    expect(ctx.revision).toBe(reader.revision());
    expect(ctx.db.prepare("SELECT id FROM calls WHERE id='new-content'").get()).toEqual({ id: "new-content" });
  });
  expect(fixture.db.raw.inTransaction).toBe(false);
  expect(() => reader.snapshot(() => { throw new Error("fixture-failure"); })).toThrow("internal");
  reader.snapshot(ctx => expect(ctx.db.raw.inTransaction).toBe(true));
});


it.each([
  ["SQLITE_BUSY", "busy"], ["SQLITE_BUSY_RECOVERY", "busy"],
  ["SQLITE_LOCKED", "busy"], ["SQLITE_LOCKED_SHAREDCACHE", "busy"],
  ["SQLITE_CORRUPT", "unsupported-schema"], ["SQLITE_CORRUPT_INDEX", "unsupported-schema"],
  ["SQLITE_NOTADB", "unsupported-schema"], ["SQLITE_IOERR", "ledger-unavailable"],
  ["SQLITE_IOERR_READ", "ledger-unavailable"], ["SQLITE_CANTOPEN", "ledger-unavailable"],
  ["SQLITE_CANTOPEN_ISDIR", "ledger-unavailable"], ["SQLITE_ERROR", "internal"],
  [undefined, "internal"],
])("runtime entry points map %s to %s without private text", async (code, expected) => {
  fixture = createDashboardFixture(false);
  const { openDashboardReader } = await import("../dashboard-reader.js");
  const { DashboardQueryError } = await import("../dashboard-contract.js");
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto", serverBuild: "fixture" })!;
  readers.push(reader);
  const db = reader.snapshot(ctx => ctx.db);
  // Revision owns a prepared statement, so inject at SQLite's transaction/statement boundary.
  for (const invoke of [() => reader.revision(), () => reader.status(), () => reader.snapshot(() => 42)]) {
    const error = Object.assign(new Error("synthetic private SQLite text"), { code });
    const statement = db.raw.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'");
    const prototype = Object.getPrototypeOf(statement) as typeof statement;
    const failGet = vi.spyOn(prototype, "get").mockImplementation(() => { throw error; });
    const failAll = vi.spyOn(prototype, "all").mockImplementation(() => { throw error; });
    try {
      let thrown: unknown;
      try { invoke(); } catch (caught) { thrown = caught; }
      expect(thrown).toBeInstanceOf(DashboardQueryError);
      expect(thrown).toMatchObject({ code: expected, message: expected });
      expect(String(thrown)).not.toContain("private");
      expect(db.raw.inTransaction).toBe(false);
    } finally { failGet.mockRestore(); failAll.mockRestore(); }
  }
  const fixed = new DashboardQueryError("invalid-query");
  expect(() => reader.snapshot(() => { throw fixed; })).toThrow(fixed);
});
