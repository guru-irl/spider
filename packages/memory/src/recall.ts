import type { Db } from "@spider/db-core";
import type { MemoryCategory, MemoryScope, MemoryRecord } from "./types";
import type { Embedder } from "./embeddings/embedder";
import { knn } from "./embeddings/vectors";
import { listActive } from "./internal";
import { getMemory, searchMemoryFts } from "./store";

export interface RecallOpts {
  category?: MemoryCategory;
  limit?: number;
}

export async function recall(
  db: Db,
  scope: MemoryScope,
  query: string | undefined,
  embedder: Embedder | null,
  opts?: RecallOpts,
): Promise<MemoryRecord[]> {
  const limit = opts?.limit ?? 10;

  if (typeof query === "string" && query.length > 0) {
    if (embedder !== null) {
      const [qv] = await embedder.embed([query]);
      const hits = knn(db, qv, limit, "memory");
      const records: MemoryRecord[] = [];
      for (const hit of hits) {
        const rec = getMemory(db, scope, hit.ownerId);
        if (!rec) continue;
        if (rec.status !== "active") continue;
        if (opts?.category && rec.category !== opts.category) continue;
        records.push(rec);
      }
      if (records.length > 0) {
        return records.slice(0, limit);
      }
      // Fall back to FTS when no vectors are embedded yet.
    }
    return searchMemoryFts(db, scope, query, opts);
  }

  return listActive(db, scope, opts);
}
