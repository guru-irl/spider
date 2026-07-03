import type { Db } from "@spider/db-core";
import { upsertVector, type OwnerKind } from "./vectors";
import type { Embedder } from "./embedder";

export function enqueueEmbed(db: Db, ownerKind: OwnerKind, ownerId: string, text: string): void {
  db.prepare(
    "INSERT INTO embed_queue (owner_kind, owner_id, text, enqueued_at, tries) VALUES (?, ?, ?, ?, 0)",
  ).run(ownerKind, ownerId, text, Date.now());
}

interface EmbedQueueRow {
  id: number;
  owner_kind: OwnerKind;
  owner_id: string;
  text: string;
}

export async function drainEmbedQueue(
  db: Db,
  embedder: Embedder | null,
  batch = 32,
): Promise<number> {
  if (embedder === null) return 0;

  const rows = db
    .prepare("SELECT id, owner_kind, owner_id, text FROM embed_queue ORDER BY enqueued_at ASC LIMIT ?")
    .all(batch) as EmbedQueueRow[];

  if (rows.length === 0) return 0;

  let vecs: Float32Array[];
  try {
    vecs = await embedder.embed(rows.map((r) => r.text));
  } catch {
    const bumpTries = db.prepare("UPDATE embed_queue SET tries = tries + 1 WHERE id IN (" +
      rows.map(() => "?").join(",") + ")");
    bumpTries.run(...rows.map((r) => r.id));
    return 0;
  }

  db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      upsertVector(db, row.owner_kind, row.owner_id, vecs[i], embedder.model);
      db.prepare("DELETE FROM embed_queue WHERE id = ?").run(row.id);
    }
  })();

  return rows.length;
}

export function startEmbedWorker(
  db: Db,
  getEmbedder: () => Promise<Embedder | null>,
  opts?: { intervalMs?: number },
): () => void {
  const intervalMs = opts?.intervalMs ?? 5000;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const embedder = await getEmbedder();
      await drainEmbedQueue(db, embedder);
    } catch {
      // swallow — background worker must never crash the process
    } finally {
      inFlight = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  handle.unref?.();

  return () => clearInterval(handle);
}
