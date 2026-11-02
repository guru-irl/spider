import { openDbReadOnly, type Db } from "@spider/db-core";
import { billingPeriod } from "./billing-pace.js";
import { DAY_MS } from "./dashboard-selection.js";
import { COUNTER_COLUMNS, counterSnapshot, latestValidCounter, type StoredCounter } from "./latest-valid-counter.js";
import { assertUsageSchemaVersion } from "./migrate.js";
import type { CounterSnapshot } from "./ledger.js";

/** Read the same bounded counter history as the usage dashboard, without creating a ledger. */
export function readPaceHistory(file: string, now: number): readonly CounterSnapshot[] {
  const db = openDbReadOnly(file, { busyTimeoutMs: 250 });
  if (!db) return [];
  try {
    assertUsageSchemaVersion(db);
    if (db.pragma("user_version") === 0) return [];
    return readPaceHistoryFromDb(db, now);
  } finally { db.close(); }
}

/** Same history in an existing read transaction; no endpoint bodies leave the worker. */
export function readPaceHistoryFromDb(db: Db, now: number): readonly CounterSnapshot[] {
  const latest = latestValidCounter(db, now), period = billingPeriod(now, latest);
  const start = Math.max(0, period.start - 7 * DAY_MS);
  const rows = db.prepare(`SELECT ${COUNTER_COLUMNS} FROM counter_snapshots INDEXED BY counter_snapshots_ts
    WHERE ts>=? AND ts<=? ORDER BY ts,rowid`).all(start, now) as StoredCounter[];
  return [...(latest && latest.ts < start ? [latest] : []), ...rows.map(counterSnapshot)];
}
