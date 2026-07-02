import type { Db } from "@spider/db-core";

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
  const info = db
    .prepare(
      "INSERT INTO vector_map (owner_kind, owner_id, model, dim, embedding) VALUES (?, ?, ?, ?, ?)",
    )
    .run(ownerKind, ownerId, model, vec.length, blob);
  const rowid = Number(info.lastInsertRowid);

  try {
    db.loadVec();
    db.prepare("INSERT INTO vectors(rowid, embedding) VALUES (?, ?)").run(rowid, blob);
  } catch {
    // best-effort: sqlite-vec absent or dim mismatch (vec0 table is fixed at 384 dims)
  }

  return rowid;
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
  } catch {
    return bruteForceKnn(db, query, k, ownerKind);
  }
}
