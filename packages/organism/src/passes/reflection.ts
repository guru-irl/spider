import type { Db } from "@spider/db-core";
import type { Embedder, MemoryRecord } from "@spider/memory";
import { knn, listActive, shouldCapture } from "@spider/memory";
import type { DigestModel, DigestResult, MemoryCandidate } from "../types.js";
import { emptyResult } from "../types.js";
import { parseCandidates } from "../aux-model.js";

// Distance below which two memory embeddings count as "related" for clustering.
const CLUSTER_DISTANCE = 0.35;
// Bound the seed set to the most-recent N records to avoid O(n²) blow-up.
const MAX_SEEDS = 50;

export const REFLECTION_PROMPT: string =
  "You are given a cluster of related memory entries. Synthesize them into ONE " +
  "durable umbrella insight that generalizes across the cluster — the shared " +
  "lesson, pattern, or preference they all point at. Do not restate each entry.\n\n" +
  "Reply with ONLY a JSON object of the form " +
  '{ "memory": [ { "category": "insight", "content": "<the umbrella insight>" } ] }.';

/**
 * Cluster ACTIVE project memory by vector proximity. Pure & testable.
 *
 * Degrades to `[]` when `embedder` is null (FTS-only, no vectors) or when there
 * are fewer than `minCluster` active records. Otherwise embeds each record's
 * content, then for each seed (capped to the most-recent MAX_SEEDS) runs `knn`
 * to gather neighbours within CLUSTER_DISTANCE, greedily forming clusters of
 * size ≥ `minCluster` and deduping records already consumed by an earlier
 * cluster.
 */
export function clusterMemory(db: Db, embedder: Embedder | null, minCluster: number): MemoryRecord[][] {
  if (embedder === null) return [];

  const records = listActive(db, "project");
  if (records.length < minCluster) return [];

  const byId = new Map<string, MemoryRecord>();
  for (const r of records) byId.set(r.uuid, r);

  // knn reads persisted vectors keyed by each record's uuid, so no per-call
  // embedding is required here — we read the canonical blob from vector_map.
  const seeds = records.slice(0, MAX_SEEDS);
  const consumed = new Set<string>();
  const clusters: MemoryRecord[][] = [];

  for (const seed of seeds) {
    const seedId = seed.uuid;
    if (consumed.has(seedId)) continue;

    const query = vectorFor(db, seedId);
    if (query === null) continue;

    const hits = knn(db, query, minCluster * 4, "memory");
    const members: MemoryRecord[] = [];
    for (const hit of hits) {
      if (hit.distance > CLUSTER_DISTANCE) continue;
      if (consumed.has(hit.ownerId)) continue;
      const rec = byId.get(hit.ownerId);
      if (rec === undefined) continue;
      members.push(rec);
    }

    if (members.length < minCluster) continue;
    for (const m of members) consumed.add(m.uuid);
    clusters.push(members);
  }

  return clusters;
}

/** Read the persisted embedding blob for a memory record by its uuid. */
function vectorFor(db: Db, ownerId: string): Float32Array | null {
  // vector_map holds the canonical raw float32 blob (works even when sqlite-vec
  // is not loaded or the dim differs from the fixed vec0 table).
  try {
    const row = db
      .prepare(
        `SELECT embedding FROM vector_map
         WHERE owner_kind = 'memory' AND owner_id = ?
         LIMIT 1`
      )
      .get(ownerId) as { embedding: Buffer } | undefined;
    if (row === undefined) return null;
    const b = row.embedding;
    const f = new Float32Array(b.byteLength / 4);
    for (let i = 0; i < f.length; i++) f[i] = b.readFloatLE(i * 4);
    return f;
  } catch {
    return null;
  }
}

/**
 * Pass 5: REFLECTION / SYNTHESIS. Clusters existing ACTIVE memory by vector
 * proximity and asks the model to synthesize each dense cluster into ONE
 * umbrella `insight`. Emits guardrail-filtered `insight` memory candidates only
 * (todos/skills empty). Degrades to `emptyResult()` when `embedder` is null
 * (FTS-only) or there are no qualifying clusters. Pure aside from the injected
 * `model.complete` call.
 */
export async function reflectionPass(
  db: Db,
  embedder: Embedder | null,
  model: DigestModel,
  opts?: { minCluster?: number; onClusterError?: (e: unknown, info: { failed: number; total: number }) => void }
): Promise<DigestResult> {
  if (embedder === null) return emptyResult();

  const minCluster = opts?.minCluster ?? 3;
  const clusters = clusterMemory(db, embedder, minCluster);
  if (clusters.length === 0) return emptyResult();

  const umbrellas: MemoryCandidate[] = [];
  let failedClusters = 0;
  for (const cluster of clusters) {
    const listing = cluster.map((r, i) => `${i + 1}. [${r.category}] ${r.content}`).join("\n");
    const raw = await model.complete(REFLECTION_PROMPT, [{ role: "user", content: listing }]);
    // Strict: a malformed/non-JSON synthesis reply must never be folded in as
    // a raw-text "insight" (that was a silent response-dump bug). Skip just
    // this cluster on a malformed reply rather than discarding every other
    // cluster's synthesis for one bad completion.
    let parsed: DigestResult;
    try {
      parsed = parseCandidates(raw, { strict: true });
    } catch {
      failedClusters++;
      continue;
    }
    for (const m of parsed.memory) umbrellas.push({ category: "insight", content: m.content });
  }

  if (failedClusters > 0) {
    // Report the aggregated failure ONCE per pass (never one entry per
    // cluster) so a caller (worker.ts) can distinguish "nothing in this pass
    // genuinely succeeded" (`failed === total`) from a mixed run, WITHOUT
    // this function itself throwing — throwing here would discard the valid
    // items a mixed run already produced, and a modelCalls-diff heuristic
    // alone cannot tell success from failure (model.complete is called for
    // every cluster regardless of whether its reply parses).
    const aggregated = new Error(`${failedClusters}/${clusters.length} reflection cluster(s) failed to synthesize (malformed/non-JSON reply)`);
    opts?.onClusterError?.(aggregated, { failed: failedClusters, total: clusters.length });
  }

  return {
    ...emptyResult(),
    memory: umbrellas.filter((m) => shouldCapture("insight", m.content).capture),
  };
}
