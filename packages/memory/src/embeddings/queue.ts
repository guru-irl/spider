import type { Db } from "@spider/db-core";
import { upsertVector, repairMissingVectors, repairStaleVectors, invalidOwnerSql, hasEmbeddingTable, hasEmbeddingWork, type OwnerKind } from "./vectors";
import { EMBED_DIM, type Embedder } from "./embedder";
import { abortableEmbeddingTask, markEmbedDrainAttempt, markEmbedDrained, recordEmbedDrainError } from "./drain-state";
import { acquireEmbedLease } from "./lease";
import { isEmbeddingWorkerUnavailable } from "./worker";

const isolateTransportRetries = new Set<string>();
const enqueued = new Set<(dbPath: string) => void>();
export function onEmbedEnqueued(listener: (dbPath: string) => void): () => void { enqueued.add(listener); return () => enqueued.delete(listener); }
export function enqueueEmbed(db: Db, ownerKind: OwnerKind, ownerId: string, text: string): void {
  db.prepare("INSERT INTO embed_queue (owner_kind, owner_id, text, enqueued_at, tries) VALUES (?, ?, ?, ?, 0)").run(ownerKind, ownerId, text, Date.now());
  // Queue consumers run later, so raw admission transactions finish before the wake fires.
  for (const listener of enqueued) { try { listener(db.raw.name); } catch { /* optional consumer */ } }
}

interface EmbedQueueRow { id: number; owner_kind: OwnerKind; owner_id: string; text: string; enqueued_at: number }
export function isEmbeddingBusy(error: unknown): boolean { return /^SQLITE_BUSY/.test(String((error as { code?: string })?.code)); }
function validate(vectors: Float32Array[], count: number): void {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new Error("invalid embedding output count");
  for (const vector of vectors) {
    if (!(vector instanceof Float32Array) || vector.length !== EMBED_DIM) throw new Error("invalid embedding dimension (expected 384)");
    if (!vector.every(Number.isFinite)) throw new Error("invalid embedding output: non-finite value");
  }
}

export async function drainEmbedQueue(db: Db, embedder: Embedder | null, batch = 8, opts?: { signal?: AbortSignal; missingScans?: Map<string, number> }): Promise<number> {
  if (!Number.isSafeInteger(batch) || batch <= 0 || opts?.signal?.aborted) return 0;
  batch = isolateTransportRetries.has(db.raw.name) ? 1 : Math.min(batch, 8);
  let release: (() => void) | undefined;
  const previousTimeout = db.pragma("busy_timeout");
  db.pragma("busy_timeout = 250");
  try {
    if (opts?.signal?.aborted) return 0;
    if (!hasEmbeddingTable(db, "global_memory") && !hasEmbeddingWork(db, opts?.missingScans)) return 0;
    // Serialize stale-file removal too: two processes must not both reclaim the
    // same dead holder and accidentally unlink the other's freshly created lease.
    release = db.raw.transaction(() => acquireEmbedLease(db.raw.name)).immediate();
    if (!release) return 0;
    db.raw.transaction(() => {
      repairStaleVectors(db, batch);
      if (!hasEmbeddingTable(db, "global_memory") && repairMissingVectors(db, batch, opts?.missingScans) > 0) markEmbedDrained(db);
    }).immediate();
    if (!embedder || !hasEmbeddingTable(db, "embed_queue")) return 0;
    const rows = db.prepare(`SELECT id, owner_kind, owner_id, text, enqueued_at FROM embed_queue q
      WHERE COALESCE(tries, 0) < 5 AND NOT (${invalidOwnerSql(db, "q")})
      ORDER BY COALESCE(tries, 0), enqueued_at, id LIMIT ?`).all(batch) as EmbedQueueRow[];
    if (!rows.length || opts?.signal?.aborted) return 0;
    markEmbedDrainAttempt(db);
    db.raw.transaction(() => {
      db.prepare(`UPDATE embed_queue SET tries = COALESCE(tries, 0) + 1 WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map(r => r.id));
    }).immediate();
    const refund = (unattempted: EmbedQueueRow[]) => db.raw.transaction(() => {
      const update = db.prepare("UPDATE embed_queue SET tries = MAX(0, COALESCE(tries, 0) - 1) WHERE id = ? AND text = ? AND enqueued_at = ?");
      for (const row of unattempted) update.run(row.id, row.text, row.enqueued_at);
    }).immediate();
    const results: Array<{ row: EmbedQueueRow; vector: Float32Array }> = [];
    try {
      const vectors = await abortableEmbeddingTask(embedder.embed(rows.map(r => r.text)), opts?.signal);
      validate(vectors, rows.length);
      rows.forEach((row, i) => results.push({ row, vector: vectors[i] }));
      isolateTransportRetries.delete(db.raw.name);
    } catch (error) {
      if (opts?.signal?.aborted) { refund(rows); return 0; }
      // Refund ambiguous batches, then isolate the next attempt for this DB.
      // A single-row transport failure is attributable and must consume a try.
      if (isEmbeddingWorkerUnavailable(error)) {
        isolateTransportRetries.add(db.raw.name);
        if (rows.length > 1) refund(rows);
        recordEmbedDrainError(db, error); return 0;
      }
      // One item already is an isolated attempt. Do not embed it twice.
      if (rows.length === 1) recordEmbedDrainError(db, error, `${rows[0].owner_kind}:${rows[0].owner_id}`);
      else for (const [index, row] of rows.entries()) {
        if (opts?.signal?.aborted) { refund(rows); return 0; }
        try {
          const vectors = await abortableEmbeddingTask(embedder.embed([row.text]), opts?.signal);
          validate(vectors, 1); results.push({ row, vector: vectors[0] });
          isolateTransportRetries.delete(db.raw.name);
        } catch (itemError) {
          if (opts?.signal?.aborted) { refund(rows); return 0; }
          recordEmbedDrainError(db, itemError, `${row.owner_kind}:${row.owner_id}`);
          if (isEmbeddingWorkerUnavailable(itemError)) { isolateTransportRetries.add(db.raw.name); refund(rows.slice(index + 1)); break; }
        }
      }
    }
    if (opts?.signal?.aborted) { refund(rows); return 0; }
    let drained = 0;
    db.raw.transaction(() => {
      const stillQueued = db.prepare(`SELECT 1 FROM embed_queue q WHERE id = ? AND owner_kind = ? AND owner_id = ? AND text = ? AND enqueued_at = ? AND NOT (${invalidOwnerSql(db, "q")})`);
      for (const { row, vector } of results) {
        if (!stillQueued.get(row.id, row.owner_kind, row.owner_id, row.text, row.enqueued_at)) continue;
        upsertVector(db, row.owner_kind, row.owner_id, vector, embedder.model);
        db.prepare("DELETE FROM embed_queue WHERE id = ?").run(row.id); drained++;
      }
    }).immediate();
    if (drained) markEmbedDrained(db);
    return drained;
  } catch (error) {
    if (!isEmbeddingBusy(error) && !opts?.signal?.aborted) recordEmbedDrainError(db, error);
    return 0;
  } finally { db.pragma(`busy_timeout = ${Number(previousTimeout)}`); release?.(); }
}
