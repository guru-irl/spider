import type { Db } from "@spider/db-core";
import { safeReviewError } from "../review-diagnostics";
import { embeddingDiagnostic } from "./drain-state";

type VectorOperation = "insert" | "knn" | "repair";
const vectorErrors = { insert: 0, knn: 0, repair: 0, lastError: undefined as string | undefined };

/** Process-lifetime counters; persisted map/index gaps remain visible after restart. */
export function getVectorErrors(): Readonly<typeof vectorErrors> {
  return { ...vectorErrors };
}

function recordVectorError(operation: VectorOperation, error: unknown): void {
  vectorErrors[operation]++;
  vectorErrors.lastError = safeReviewError(error);
  if (vectorErrors[operation] === 1) {
    embeddingDiagnostic(`vectors ${operation}: ${vectorErrors.lastError}`);
  }
}

export function getVectorState(db: Db): { mapped: number; indexed: number; missing: number; pending: number; retried: number; dead: number } {
  const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const mapped = hasTable("vector_map") ? count("SELECT COUNT(*) AS n FROM vector_map") : 0;
  const hasVectors = hasTable("vectors");
  if (hasVectors) db.loadVec();
  const indexed = hasVectors ? count("SELECT COUNT(*) AS n FROM vectors") : 0;
  const missing = mapped ? count(`SELECT COUNT(*) AS n FROM vector_map m
    WHERE m.dim = 384${hasVectors ? " AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.rowid = m.rowid)" : ""}`) : 0;
  const queued = hasTable("embed_queue");
  return { mapped, indexed, missing,
    pending: queued ? count("SELECT COUNT(*) AS n FROM embed_queue WHERE COALESCE(tries, 0) = 0") : 0,
    retried: queued ? count("SELECT COUNT(*) AS n FROM embed_queue WHERE tries > 0 AND tries < 5") : 0,
    dead: queued ? count("SELECT COUNT(*) AS n FROM embed_queue WHERE tries >= 5") : 0 };
}

export type OwnerKind = "memory" | "content" | "session" | "run";

export interface VecHit {
  ownerKind: OwnerKind;
  ownerId: string;
  distance: number;
}

export function f32ToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToF32(b: Buffer): Float32Array {
  const f = new Float32Array(b.byteLength / 4);
  for (let i = 0; i < f.length; i++) f[i] = b.readFloatLE(i * 4);
  return f;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function upsertVector(
  db: Db,
  ownerKind: OwnerKind,
  ownerId: string,
  vec: Float32Array,
  model: string,
): number {
  const blob = f32ToBlob(vec);
  return db.raw.transaction(() => {
    deleteOwnerVectors(db, ownerKind, ownerId);
    const info = db
      .prepare(
        "INSERT INTO vector_map (owner_kind, owner_id, model, dim, embedding) VALUES (?, ?, ?, ?, ?)",
      )
      .safeIntegers()
      .run(ownerKind, ownerId, model, vec.length, blob);
    const rowid = Number(info.lastInsertRowid);

    try {
      db.loadVec();
      // better-sqlite3 binds JS numbers as REAL; vec0 requires an INTEGER primary key.
      db.prepare("INSERT INTO vectors(rowid, embedding) VALUES (?, ?)").run(info.lastInsertRowid, blob);
    } catch (error) {
      // Keep the blob as the repair source when the optional native index fails.
      recordVectorError("insert", error);
    }

    return rowid;
  }).immediate();
}

export function hasEmbeddingTable(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Lifecycle deletions remove native rows before map rows so reused content ids are safe. */
export function deleteOwnerVectors(db: Db, kind: OwnerKind, id: string): void {
  if (!hasEmbeddingTable(db, "vector_map")) return;
  const rows = db.prepare("SELECT rowid FROM vector_map WHERE owner_kind = ? AND owner_id = ?").safeIntegers().all(kind, id) as { rowid: bigint }[];
  if (rows.length && hasEmbeddingTable(db, "vectors")) {
    db.loadVec();
    for (const row of rows) db.prepare("DELETE FROM vectors WHERE rowid = ?").run(row.rowid);
  }
  if (rows.length) db.prepare("DELETE FROM vector_map WHERE owner_kind = ? AND owner_id = ?").run(kind, id);
}

export function invalidOwnerSql(db: Db, alias: string): string {
  const predicates: string[] = [];
  if (hasEmbeddingTable(db, "memory")) predicates.push(`(${alias}.owner_kind = 'memory' AND NOT EXISTS (SELECT 1 FROM memory x WHERE x.uuid = ${alias}.owner_id AND x.status IN ('active', 'staged')))`);
  if (hasEmbeddingTable(db, "content")) predicates.push(`(${alias}.owner_kind = 'content' AND NOT EXISTS (SELECT 1 FROM content x WHERE x.id = CAST(${alias}.owner_id AS INTEGER) AND CAST(CAST(${alias}.owner_id AS INTEGER) AS TEXT) = ${alias}.owner_id))`);
  return predicates.join(" OR ") || "0";
}

/** Bounded and idempotent, including legacy global queues which have no vector recall consumer. */
export function repairStaleVectors(db: Db, batch = 8): number {
  const bound = Math.min(Math.max(batch, 1), 32);
  const global = hasEmbeddingTable(db, "global_memory");
  let repaired = 0;
  if (hasEmbeddingTable(db, "embed_queue")) {
    const rows = db.prepare(`SELECT id FROM embed_queue q WHERE ${global ? "1" : invalidOwnerSql(db, "q")} LIMIT ?`).all(bound) as { id: number }[];
    for (const row of rows) repaired += db.prepare("DELETE FROM embed_queue WHERE id = ?").run(row.id).changes;
  }
  if (hasEmbeddingTable(db, "vector_map")) {
    const rows = db.prepare(`SELECT owner_kind, owner_id FROM vector_map m WHERE ${global ? "1" : invalidOwnerSql(db, "m")} LIMIT ?`).all(bound) as { owner_kind: OwnerKind; owner_id: string }[];
    for (const row of rows) { deleteOwnerVectors(db, row.owner_kind, row.owner_id); repaired++; }
  }
  return repaired;
}

/** Read-only probe; idle parents never open a writable handle or run repair.
 * A session-owned cache skips clean legacy-gap scans until an insert fails. */
export function hasEmbeddingWork(db: Db, missingScans?: Map<string, number>): boolean {
  if (!hasEmbeddingTable(db, "vector_map")) return false;
  if (hasEmbeddingTable(db, "embed_queue") && db.prepare(`SELECT 1 FROM embed_queue q WHERE COALESCE(tries, 0) < 5 OR ${invalidOwnerSql(db, "q")} LIMIT 1`).get()) return true;
  if (db.prepare(`SELECT 1 FROM vector_map m WHERE ${invalidOwnerSql(db, "m")} LIMIT 1`).get()) return true;
  if (missingScans?.get(db.raw.name) === vectorErrors.insert) return false;
  let missing: boolean;
  if (!hasEmbeddingTable(db, "vectors")) missing = !!db.prepare("SELECT 1 FROM vector_map WHERE dim = 384 AND length(embedding) = 1536 LIMIT 1").get();
  else {
    db.loadVec();
    missing = !!db.prepare(`SELECT 1 FROM vector_map m WHERE dim = 384 AND length(embedding) = 1536 AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.rowid = m.rowid) LIMIT 1`).get();
  }
  if (!missing) missingScans?.set(db.raw.name, vectorErrors.insert);
  return missing;
}

/** Repair old best-effort inserts from their stored blobs, even without a provider.
 * SQL preserves INTEGER rowids. Bound each drain and skip unusable/different dimensions. */
export function repairMissingVectors(db: Db, batch = 32, missingScans?: Map<string, number>): number {
  if (!Number.isSafeInteger(batch) || batch <= 0 || missingScans?.get(db.raw.name) === vectorErrors.insert) return 0;
  try {
    if (!db.prepare("SELECT 1 FROM vector_map WHERE dim = 384 AND length(embedding) = 1536 LIMIT 1").get()) { missingScans?.set(db.raw.name, vectorErrors.insert); return 0; }
    db.loadVec();
    const repaired = db.prepare(`INSERT INTO vectors(rowid, embedding)
      SELECT m.rowid, m.embedding FROM vector_map m
      WHERE m.dim = 384 AND length(m.embedding) = 1536
        AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.rowid = m.rowid)
      ORDER BY m.rowid LIMIT ?`).run(Math.min(batch, 32)).changes;
    // Keep checking partially repaired gaps until one pass finds none.
    if (repaired) missingScans?.delete(db.raw.name);
    else missingScans?.set(db.raw.name, vectorErrors.insert);
    return repaired;
  } catch (error) {
    recordVectorError("repair", error);
    return 0;
  }
}

interface VectorMapRow {
  rowid: number;
  owner_kind: OwnerKind;
  owner_id: string;
  embedding: Buffer;
}

function bruteForceKnn(db: Db, query: Float32Array, k: number, ownerKind?: OwnerKind): VecHit[] {
  const sql = ownerKind
    ? "SELECT rowid, owner_kind, owner_id, embedding FROM vector_map WHERE owner_kind = ?"
    : "SELECT rowid, owner_kind, owner_id, embedding FROM vector_map";
  const rows = (ownerKind
    ? db.prepare(sql).all(ownerKind)
    : db.prepare(sql).all()) as VectorMapRow[];

  const scored = rows.map((row) => {
    const sim = cosine(query, blobToF32(row.embedding));
    return {
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      distance: 1 - sim,
      sim,
    };
  });

  scored.sort((a, b) => b.sim - a.sim);

  return scored.slice(0, k).map(({ ownerKind: ok, ownerId, distance }) => ({
    ownerKind: ok,
    ownerId,
    distance,
  }));
}

export function knn(db: Db, query: Float32Array, k: number, ownerKind?: OwnerKind): VecHit[] {
  try {
    db.loadVec();
    const blob = f32ToBlob(query);
    const sql = ownerKind
      ? `SELECT v.rowid AS rowid, v.distance AS distance, m.owner_kind AS owner_kind, m.owner_id AS owner_id
         FROM vectors v JOIN vector_map m ON m.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ? AND m.owner_kind = ?
         ORDER BY v.distance`
      : `SELECT v.rowid AS rowid, v.distance AS distance, m.owner_kind AS owner_kind, m.owner_id AS owner_id
         FROM vectors v JOIN vector_map m ON m.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`;
    const rows = (ownerKind
      ? db.prepare(sql).all(blob, k, ownerKind)
      : db.prepare(sql).all(blob, k)) as { distance: number; owner_kind: OwnerKind; owner_id: string }[];

    return rows.map((row) => ({
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      distance: row.distance,
    }));
  } catch (error) {
    recordVectorError("knn", error);
    return bruteForceKnn(db, query, k, ownerKind);
  }
}
