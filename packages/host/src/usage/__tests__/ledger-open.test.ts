import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import Database from "better-sqlite3";
import { openDb } from "@spider/db-core";
import { openUsageLedger, type UsageLedger } from "../ledger.js";

let root: string;
let helper: string;
const children: ChildProcess[] = [];
const exits: Promise<number | null>[] = [];
const ledgers: UsageLedger[] = [];
const rawHandles: Database.Database[] = [];

beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-opening-"));
  helper = join(root, "opener.mjs");
  buildSync({
    entryPoints: [fileURLToPath(new URL("../ledger.ts", import.meta.url))],
    outfile: join(root, "ledger.mjs"), bundle: true, platform: "node", format: "esm",
    external: ["better-sqlite3", "sqlite-vec"], logLevel: "silent",
  });
  writeFileSync(helper, `
    import { openUsageLedger } from "./ledger.mjs";
    import { createRequire } from "node:module";
    const [file, mode] = process.argv.slice(2);
    if (mode === "holder") {
      const Database = createRequire(import.meta.url)("better-sqlite3");
      const db = new Database(file);
      db.exec("BEGIN IMMEDIATE");
      process.send("ready");
      process.once("message", () => setTimeout(() => {
        db.exec("ROLLBACK"); db.close(); process.disconnect();
      }, 650));
    } else {
      process.send("ready");
      process.once("message", () => {
        const start = performance.now();
        try {
          const ledger = openUsageLedger(file);
          const version = ledger.health().schemaVersion;
          ledger.close();
          process.send({ version, elapsed: performance.now() - start });
        } catch (error) {
          process.send({ error: String(error), code: error.code }); process.exitCode = 1;
        }
        process.disconnect();
      });
    }
  `);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(exits.splice(0));
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const raw of rawHandles.splice(0)) if (raw.open) raw.close();
  rmSync(root, { recursive: true, force: true });
});

function opener(file: string, mode = "open") {
  const env = { ...process.env };
  for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID"]) delete env[key];
  const child = fork(helper, [file, mode], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", data => { stderr += String(data); });
  const exit = new Promise<number | null>(resolve => { child.once("close", resolve); });
  exits.push(exit);
  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown) => { if (message === "ready") { child.off("message", onMessage); resolve(); } };
    child.on("message", onMessage);
    child.once("error", reject);
    child.once("close", code => { reject(new Error(`Opener exited before ready (${code}): ${stderr}`)); });
  });
  const result = new Promise<unknown>(resolve => {
    child.on("message", message => { if (message !== "ready") resolve(message); });
    child.once("close", code => { resolve({ error: `Opener exited (${code}): ${stderr}` }); });
  });
  return { child, ready, result, exit };
}

describe("usage ledger opening", () => {
  // Catches the WAL journal-mode switch failing before the migration busy handler.
  it.each([false, true])("retries opening and migrating until a short competing lock is released (existing WAL: %s)", async (existingWal) => {
    const file = join(root, "usage.db");
    if (existingWal) openUsageLedger(file).close();
    const holder = opener(file, "holder");
    await holder.ready;
    holder.child.send("go");
    const start = performance.now();
    const ledger = openUsageLedger(file);
    ledgers.push(ledger);
    expect(ledger.health().schemaVersion).toBe(2);
    expect(performance.now() - start).toBeLessThan(2100);
    expect(await holder.exit).toBe(0);
  });

  // Catches first-install races: every process must see the same committed v1 schema.
  it("opens the same fresh file concurrently in six node processes", async () => {
    for (let trial = 0; trial < 12; trial++) {
      const dir = join(root, String(trial));
      mkdirSync(dir);
      const group = Array.from({ length: 6 }, () => opener(join(dir, "usage.db")));
      await Promise.all(group.map(process => process.ready));
      for (const process of group) process.child.send("go");
      const results = await Promise.all(group.map(process => process.result));
      for (const result of results) {
        expect(result).toMatchObject({ version: 2 });
        expect((result as { elapsed: number }).elapsed).toBeLessThan(2100);
      }
      expect(await Promise.all(group.map(process => process.exit))).toEqual([0, 0, 0, 0, 0, 0]);
    }
  });

  // Catches unbounded synchronous startup retry when an external writer never releases.
  it("stops retrying a locked fresh file within the opening budget", () => {
    const file = join(root, "usage.db");
    const raw = new Database(file);
    rawHandles.push(raw);
    raw.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    try { expect(() => openUsageLedger(file)).toThrow(/busy|locked/i); }
    finally { raw.exec("ROLLBACK"); }
    // A small scheduling tolerance is not an extra busy-handler budget.
    expect(performance.now() - start).toBeLessThan(2100);
  });

  // N07: retrying SQLITE_ERROR would open multiple doomed handles and stall startup.
  it("fails fast without retrying a non-BUSY journal error", () => {
    const pragma = Database.prototype.pragma;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function(this: Database.Database, sql: string, options?: Database.PragmaOptions) {
      if (sql === "journal_mode = WAL") {
        rawHandles.push(this);
        throw Object.assign(new Error("fixture non-BUSY journal failure"), { code: "SQLITE_ERROR" });
      }
      return pragma.call(this, sql, options);
    });
    const start = performance.now();
    expect(() => openUsageLedger(join(root, "usage.db"))).toThrow(/fixture non-BUSY journal failure/);
    expect(performance.now() - start).toBeLessThan(500);
    expect(rawHandles).toHaveLength(1);
    expect(rawHandles[0].open).toBe(false);
  });

  // N12: a successful late open must not leave apply with the depleted open budget.
  it("retains the ordinary batch wait after a successful open near its deadline", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(1990);
    const file = join(root, "usage.db");
    let ledger: UsageLedger;
    try { ledger = openUsageLedger(file); ledgers.push(ledger); }
    finally { clock.mockRestore(); }
    const holder = new Database(file);
    rawHandles.push(holder);
    holder.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    try {
      expect(() => ledger.apply({ calls: [], runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [],
        resetSources: [], sourceErrors: [], at: 0 })).toThrow(/busy|locked/i);
      expect(performance.now() - start).toBeGreaterThanOrEqual(150);
      expect(performance.now() - start).toBeLessThan(1000);
    } finally { holder.exec("ROLLBACK"); }
  });

  // A thrown opener pragma otherwise strands a raw handle that the caller cannot close.
  it("closes a half-opened native handle when journal initialization fails", () => {
    let failed: Database.Database | undefined;
    const pragma = Database.prototype.pragma;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function(this: Database.Database, sql: string, options?: Database.PragmaOptions) {
      if (sql === "journal_mode = WAL") {
        failed = this;
        rawHandles.push(this);
        throw Object.assign(new Error("fixture journal failure"), { code: "SQLITE_ERROR" });
      }
      return pragma.call(this, sql, options);
    });
    expect(() => openDb(join(root, "usage.db"))).toThrow(/fixture journal failure/);
    expect(failed).toBeDefined();
    expect(failed!.open).toBe(false);
  });
});
