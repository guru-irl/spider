import { createHash } from "node:crypto";
import type { Db } from "@spider/db-core";
import { COPILOT_RATE_VERSIONS } from "./rates.js";
import { priceCall, priceReportedCost } from "./price.js";
import type { RateVersion, UsageTokens } from "./types.js";

export type RepriceProgress = { state: "pending" | "running" | "complete"; processed: number; total: number; repriced: number };
type Checkpoint = RepriceProgress & { fingerprint: string; cursor: number; upper: number };
const pending = (): RepriceProgress => ({ state: "pending", processed: 0, total: 0, repriced: 0 });

/** Hash rate content and pricing policy so summary backfill runs once on upgrade. */
export function rateFingerprint(versions: readonly RateVersion[]): string {
  return createHash("sha256").update(JSON.stringify({ policy: "summary-cost-v1", versions })).digest("hex");
}

/** Owner-only writes; progress reads are safe on follower connections. */
export function createRepricer(db: Db): {
  progress(): RepriceProgress;
  pass(commitGuard: () => boolean, batchSize?: number): RepriceProgress & { changed: number };
} {
  const fingerprint = rateFingerprint(COPILOT_RATE_VERSIONS);
  const metadata = db.prepare("SELECT value FROM ledger_metadata WHERE key=?");
  const put = db.prepare("INSERT INTO ledger_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const read = (key: string) => (metadata.get(key) as { value: string } | undefined)?.value;
  const checkpoint = (): Checkpoint | undefined => {
    const value = read("reprice-progress");
    if (!value) return undefined;
    try {
      const stored = JSON.parse(value) as Checkpoint | null;
      if (!stored || stored.fingerprint !== fingerprint || !["running", "complete"].includes(stored.state)
        || ![stored.cursor, stored.upper, stored.processed, stored.total, stored.repriced].every(n => Number.isSafeInteger(n) && n >= 0)
        || stored.cursor > stored.upper || stored.processed > stored.total || stored.repriced > stored.processed) return undefined;
      return stored;
    } catch { return undefined; }
  };
  const progress = (): RepriceProgress => {
    const stored = checkpoint();
    if (!stored || stored.state === "complete" && read("reprice-rate-fingerprint") !== fingerprint) return pending();
    const { state, processed, total, repriced } = stored;
    return { state, processed, total, repriced };
  };
  const candidates = "price_status='unpriced' AND (aggregate=0 OR (aggregate=1 AND actor='compaction' AND model IS NULL))";
  const sessionProviders = db.prepare("SELECT DISTINCT raw_provider AS provider FROM calls WHERE session_id=? AND raw_provider IS NOT NULL");
  const page = db.prepare(`SELECT rowid AS rowId, provider, model, ts, input, output, aggregate,
    session_id AS sessionId, pi_cost AS piCost, cache_read AS cacheRead, cache_write AS cacheWrite, cache_write_1h AS cacheWrite1h,
    reasoning, total_tokens AS totalTokens FROM calls
    WHERE rowid > ? AND rowid <= ? AND ${candidates} ORDER BY rowid LIMIT ?`);
  const update = db.prepare(`UPDATE calls SET aic=@aic, aic_input=@input, aic_cache_read=@cacheRead,
    aic_cache_write=@cacheWrite, aic_output=@output, price_status='priced', unpriced_reason=NULL,
    rate_version=@rateVersion, tier=@tier, confidence=@confidence, provider=@provider
    WHERE rowid=@rowId AND ${candidates}`);
  return {
    progress,
    pass(commitGuard, batchSize = 2000) {
      if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10000) throw new Error("invalid reprice batch size");
      return db.raw.transaction(() => {
        if (!commitGuard()) return { ...progress(), changed: 0 };
        if (read("reprice-rate-fingerprint") === fingerprint) return { ...progress(), state: "complete" as const, changed: 0 };
        let stored = checkpoint();
        if (!stored || stored.state === "complete") {
          const { upper, total } = db.prepare(`SELECT COALESCE(MAX(rowid),0) AS upper,
            COUNT(*) AS total FROM calls WHERE ${candidates}`).get() as { upper: number; total: number };
          stored = { ...pending(), state: "running", fingerprint, cursor: 0, upper, total };
        }
        const rows = page.all(stored.cursor, stored.upper, batchSize) as (UsageTokens & {
          rowId: number; provider: string | null; model: string | null; ts: number;
          aggregate: number; sessionId: string | null; piCost: number | null;
          cacheWrite1h: number | null; reasoning: number | null; totalTokens: number | null;
        })[];
        let changed = 0;
        const evidence = new Map<string, string | null>();
        for (const row of rows) {
          const usage: UsageTokens = { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
            ...(row.cacheWrite1h === null ? {} : { cacheWrite1h: row.cacheWrite1h }),
            ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
            ...(row.totalTokens === null ? {} : { totalTokens: row.totalTokens }) };
          let provider = row.provider;
          if (row.aggregate && provider === null && row.sessionId !== null) {
            if (!evidence.has(row.sessionId)) {
              const providers = sessionProviders.all(row.sessionId) as { provider: string }[];
              evidence.set(row.sessionId, providers.length === 1 && providers[0].provider === "github-copilot" ? "github-copilot" : null);
            }
            provider = evidence.get(row.sessionId)!;
          }
          const price = row.aggregate ? priceReportedCost(provider, { total: row.piCost })
            : priceCall({ provider, id: row.model }, usage, row.ts);
          if (price.status === "priced") {
            changed += update.run({ rowId: row.rowId, provider, aic: price.aic, ...price.components,
              rateVersion: price.rateVersion, tier: price.tier, confidence: price.confidence }).changes;
          }
          stored.cursor = row.rowId;
        }
        stored.processed += rows.length; stored.repriced += changed;
        if (rows.length < batchSize || stored.processed >= stored.total) stored.state = "complete";
        // Price updates fire the existing call-selection-revision trigger, which
        // fences calibration fits, corrected values, reader snapshots and cursors.
        if (changed) db.prepare("DELETE FROM ledger_metadata WHERE key='worker-snapshot'").run();
        put.run("reprice-progress", JSON.stringify(stored));
        if (stored.state === "complete") put.run("reprice-rate-fingerprint", fingerprint);
        const { state, processed, total, repriced } = stored;
        return { state, processed, total, repriced, changed };
      }).immediate();
    },
  };
}
