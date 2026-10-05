import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { acquireUsageLease } from "../lease.js";
import { openUsageLedger } from "../ledger.js";

it("adds the lease table on reopening a pre-lease version-1 ledger without losing snapshots", () => {
  const file = join(process.env.SPIDER_GLOBAL_ROOT!, "pre-lease-usage.db");
  const first = openUsageLedger(file);
  first.insertCounter({ ts: 1000, creditsUsed: 7, raw: {} }); first.close();
  const raw = new Database(file);
  try { raw.exec("DROP TABLE IF EXISTS leases"); } finally { raw.close(); }
  const next = openUsageLedger(file);
  try {
    const check = new Database(file);
    try { expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leases'").get()).toEqual({ name: "leases" }); }
    finally { check.close(); }
    expect(next.latestCounter()?.creditsUsed).toBe(7);
  } finally { next.close(); }
});

it.each(["name TEXT PRIMARY KEY, owner TEXT", "name TEXT PRIMARY KEY, owner TEXT, token TEXT, acquired_at INTEGER, expires_at INTEGER, next_due_at INTEGER, last_error_code TEXT, extra TEXT"])("recreates an incompatible unreleased leases table on open: %s", columns => {
  const file = join(process.env.SPIDER_GLOBAL_ROOT!, `lease-shape-${columns.length}.db`);
  const first = openUsageLedger(file); first.insertCounter({ ts: 1000, creditsUsed: 7, raw: {} }); first.close();
  const raw = new Database(file);
  try { raw.exec(`DROP TABLE leases; CREATE TABLE leases (${columns}); INSERT INTO leases(name, owner) VALUES ('counter', 'obsolete')`); }
  finally { raw.close(); }
  const next = openUsageLedger(file);
  try {
    expect(next.latestCounter()?.creditsUsed).toBe(7);
    expect(acquireUsageLease(next, "counter", "new", 1000, 120000)).toBeDefined();
    const check = new Database(file);
    try { expect(check.prepare("PRAGMA table_info(leases)").all().map(row => (row as { name: string }).name)).not.toContain("extra"); }
    finally { check.close(); }
  } finally { next.close(); }
});

it.each([
  ["wrong-type", "name TEXT PRIMARY KEY NOT NULL, owner INTEGER, token TEXT, acquired_at INTEGER, expires_at INTEGER, next_due_at INTEGER, last_error_code TEXT, notice_code TEXT, notice_at INTEGER"],
  ["missing-key", "name TEXT NOT NULL, owner TEXT, token TEXT, acquired_at INTEGER, expires_at INTEGER, next_due_at INTEGER, last_error_code TEXT, notice_code TEXT, notice_at INTEGER"],
  ["nullable-key", "name TEXT PRIMARY KEY, owner TEXT, token TEXT, acquired_at INTEGER, expires_at INTEGER, next_due_at INTEGER, last_error_code TEXT, notice_code TEXT, notice_at INTEGER"],
  ["extra-unique", "name TEXT PRIMARY KEY NOT NULL, owner TEXT UNIQUE, token TEXT, acquired_at INTEGER, expires_at INTEGER, next_due_at INTEGER, last_error_code TEXT, notice_code TEXT, notice_at INTEGER"],
])("Nit lease schema detects same-name type/key mismatch: %s", (id, columns) => {
  const file = join(process.env.SPIDER_GLOBAL_ROOT!, `round3-${id}.db`);
  const first = openUsageLedger(file); first.insertCounter({ ts: 1000, creditsUsed: 7, raw: {} }); first.close();
  const raw = new Database(file); raw.exec(`DROP TABLE leases; CREATE TABLE leases (${columns}); INSERT INTO leases(name, owner) VALUES ('counter', 'obsolete')`); raw.close();
  const next = openUsageLedger(file);
  try {
    expect(next.latestCounter()?.creditsUsed).toBe(7);
    const check = new Database(file);
    try { expect(check.prepare("SELECT count(*) c FROM leases").get()).toEqual({ c: 0 }); } finally { check.close(); }
    expect(acquireUsageLease(next, "counter", "new", 1000, 120000)).toBeDefined();
  } finally { next.close(); }
});


it("recreates an owner-blocking CHECK constraint without losing durable snapshots", () => {
  const file = join(process.env.SPIDER_GLOBAL_ROOT!, "lease-check.db");
  const first = openUsageLedger(file); first.insertCounter({ ts: 1000, creditsUsed: 7, raw: {} }); first.close();
  const db = new Database(file);
  db.exec(`DROP TABLE leases; CREATE TABLE leases (
    name TEXT PRIMARY KEY NOT NULL, owner TEXT CHECK (owner IS NULL), token TEXT,
    acquired_at INTEGER, expires_at INTEGER, next_due_at INTEGER,
    last_error_code TEXT, notice_code TEXT, notice_at INTEGER
  )`); db.close();
  const next = openUsageLedger(file);
  try {
    expect(next.latestCounter()?.creditsUsed).toBe(7);
    expect(acquireUsageLease(next, "counter", "new", 1000, 120000)).toBeDefined();
  } finally { next.close(); }
});
