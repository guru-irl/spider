import { appendRunEvent, type Db } from "@spider/db-core";
import type { RunRow } from "./run-store";

/** The pi usage shape, kept local because subagents does not declare a pi-ai dependency. */
export interface UsageLike {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cacheWrite1h?: number; reasoning?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface ModelUsage { provider: string; model: string; usage: UsageLike }
export function sumUsage(items: readonly UsageLike[]): UsageLike {
  const total: UsageLike = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const usage of items) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
    for (const key of ["cacheWrite1h", "reasoning"] as const) if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
  }
  return total;
}

export function runUsage(db: Db, runId: string): ModelUsage[] {
  const grouped = new Map<string, { provider: string; model: string; items: UsageLike[] }>();
  const events = db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='spider_usage' ORDER BY id").all(runId) as Array<{ payload: string }>;
  for (const event of events) {
    let record: ModelUsage;
    try { record = JSON.parse(event.payload); } catch { continue; }
    if (!record?.provider || !record.model || !record.usage) continue;
    const key = JSON.stringify([record.provider, record.model]);
    let group = grouped.get(key);
    if (!group) { group = { provider: record.provider, model: record.model, items: [] }; grouped.set(key, group); }
    group.items.push(record.usage);
  }
  return [...grouped.values()].map(({ provider, model, items }) => ({ provider, model, usage: sumUsage(items) }));
}

/** A refused synchronous sink leaves usage retryable, including on an older host. */
export function reportRunUsage(db: Db, run: RunRow, sink: (run: RunRow, usage: ModelUsage[]) => boolean): boolean {
  if (!["done", "failed", "cancelled"].includes(run.status)) return false;
  const refused = Symbol("refused usage sink");
  try {
    return db.transaction(() => {
      // Insert before any read or session append to acquire the write lock without a
      // read-to-write upgrade. Refusal/exception rolls the marker back. Session JSONL
      // cannot share this transaction: a crash after append is recovered by the host's
      // durable note/provider/model dedup. Tool-result fallback is at-most-once: its
      // marker commits before pi persists the result, so a crash in that gap can lose it.
      const marked = db.withRetry(() => db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type)
        SELECT ?, ?, ?, 'spider_usage_reported'
        WHERE NOT EXISTS (SELECT 1 FROM run_events WHERE run_id=? AND type='spider_usage_reported')`)
        .run(run.id, run.session_id, Date.now(), run.id).changes);
      if (!marked) return false;
      if (!sink(run, runUsage(db, run.id))) throw refused;
      return true;
    })();
  } catch (error) { if (error === refused) return false; throw error; }
}
export function recordRunUsage(db: Db, runId: string, record: ModelUsage, purpose?: string): void {
  db.transaction(() => {
    // Write first so a concurrent child reporter cannot turn a read lock into a failed upgrade.
    const { totalTokens, input, output, cacheRead, cacheWrite } = record.usage;
    const changed = db.prepare("UPDATE runs SET token_count=token_count+? WHERE id=?").run(totalTokens || input + output + cacheRead + cacheWrite, runId).changes;
    if (!changed) return;
    const run = db.prepare("SELECT session_id FROM runs WHERE id=?").get(runId) as { session_id: string };
    appendRunEvent(db, { runId, sessionId: run.session_id, ts: Date.now(), type: "spider_usage",
      payload: { type: "spider_usage", ...record, ...(purpose ? { purpose } : {}) } });
  })();
}

export function warnUsage(db: Db, run: Pick<RunRow, "id" | "session_id">, error: unknown): void {
  try {
    appendRunEvent(db, { runId: run.id, sessionId: run.session_id, ts: Date.now(), type: "warning",
      summary: `Usage accounting failed: ${String(error)}` });
  } catch { /* a broken DB may also reject the diagnostic */ }
}

/** Optional accounting must never block finalization, notification or adoption. */
export function safelyReportUsage(db: Db, run: RunRow, report?: (run: RunRow) => void): void {
  try { report?.(run); } catch (error) { warnUsage(db, run, error); }
}
