import type { Db } from "@spider/db-core";
import type { CounterSnapshot } from "./ledger.js";

export type StoredCounter = {
  ts: number; creditsUsed: number; accountLogin: string | null; entitlement: number | null;
  remaining: number | null; resetDate: string | null;
};
export const COUNTER_COLUMNS = "ts,credits_used AS creditsUsed,account_login AS accountLogin,entitlement,remaining,reset_date AS resetDate";
export const counterSnapshot = (row: StoredCounter): CounterSnapshot => ({
  ts: row.ts, creditsUsed: row.creditsUsed, accountLogin: row.accountLogin ?? undefined,
  entitlement: row.entitlement ?? undefined, remaining: row.remaining ?? undefined,
  resetDate: row.resetDate ?? undefined, raw: {},
});

/** Match computePace's validity rule and highest-valid duplicate semantics.
 * Select typed fields only, never the raw account response. */
export function latestValidCounter(db: Db, now: number): CounterSnapshot | undefined {
  const row = db.prepare(`SELECT ${COUNTER_COLUMNS} FROM counter_snapshots INDEXED BY counter_snapshots_ts
    WHERE ts>=0 AND ts<=? AND ts=CAST(ts AS INTEGER)
      AND credits_used BETWEEN 0 AND 1.7976931348623157e308
      AND (entitlement IS NULL OR entitlement BETWEEN 0 AND 1.7976931348623157e308)
      AND (remaining IS NULL OR remaining BETWEEN 0 AND 1.7976931348623157e308)
    ORDER BY ts DESC,rowid DESC LIMIT 1`).get(now) as StoredCounter | undefined;
  return row ? counterSnapshot(row) : undefined;
}
