import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openUsageLedger, openUsageLedgerReadOnly, type UsageLedger } from "../ledger.js";

const roots: string[] = [], ledgers: UsageLedger[] = [], handles: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const handle of handles.splice(0)) if (handle.open) handle.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  mkdirSync(process.env.SPIDER_GLOBAL_ROOT!, { recursive: true });
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "readonly-open-")); roots.push(root);
  const file = join(root, "usage.db");
  openUsageLedger(file).close();
  return file;
}

it.each(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"])("read-only opening retries %s schema reads without becoming a writer", code => {
  const file = fixture(), pragma = Database.prototype.pragma;
  let failures = 2;
  vi.spyOn(Database.prototype, "pragma").mockImplementation(function(this: Database.Database, sql: string, options?: Database.PragmaOptions) {
    if (this.name === file && !handles.includes(this)) handles.push(this);
    if (this.name === file && sql === "user_version" && failures > 0) {
      failures--;
      throw Object.assign(new Error("fixture cold-open contention"), { code });
    }
    return pragma.call(this, sql, options);
  });
  const reader = openUsageLedgerReadOnly(file)!; ledgers.push(reader);
  expect(reader.health(0).calls).toBe(0);
  expect(failures).toBe(0);
  expect(handles).toHaveLength(3);
  expect(handles.every(handle => handle.readonly)).toBe(true);
  expect(handles.slice(0, -1).every(handle => !handle.open)).toBe(true);
});

it("a late successful read-only open restores the ordinary query busy handler", () => {
  const file = fixture(), pragma = Database.prototype.pragma;
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(1950);
  vi.spyOn(Database.prototype, "pragma").mockImplementation(function(this: Database.Database, sql: string, options?: Database.PragmaOptions) {
    if (this.name === file && !handles.includes(this)) handles.push(this);
    return pragma.call(this, sql, options);
  });
  const reader = openUsageLedgerReadOnly(file)!; ledgers.push(reader);
  expect(reader.health(0).calls).toBe(0);
  // Startup consumes its own budget, not the connection's later query budget.
  expect(handles[0].pragma("busy_timeout", { simple: true })).toBe(250);
});

it("read-only opening stops at the existing opening budget and closes the failed handle", () => {
  const file = fixture(), pragma = Database.prototype.pragma;
  const busy = Object.assign(new Error("fixture persistent contention"), { code: "SQLITE_BUSY" });
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(2000);
  vi.spyOn(Database.prototype, "pragma").mockImplementation(function(this: Database.Database, sql: string, options?: Database.PragmaOptions) {
    if (this.name === file && sql === "user_version") { handles.push(this); throw busy; }
    return pragma.call(this, sql, options);
  });
  expect(() => openUsageLedgerReadOnly(file)).toThrow(busy);
  expect(handles).toHaveLength(1);
  expect(handles[0].open).toBe(false);
});

it("read-only opening fails immediately on non-BUSY schema errors and closes its handle", () => {
  const file = fixture(), pragma = Database.prototype.pragma;
  vi.spyOn(Database.prototype, "pragma").mockImplementation(function(this: Database.Database, sql: string, options?: Database.PragmaOptions) {
    if (this.name === file && sql === "user_version") {
      handles.push(this);
      throw Object.assign(new Error("fixture invalid schema read"), { code: "SQLITE_ERROR" });
    }
    return pragma.call(this, sql, options);
  });
  expect(() => openUsageLedgerReadOnly(file)).toThrow("fixture invalid schema read");
  expect(handles).toHaveLength(1);
  expect(handles[0].open).toBe(false);
});
