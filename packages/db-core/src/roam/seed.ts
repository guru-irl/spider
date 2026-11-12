import type { Db } from "../db";
import { DESCRIPTORS } from "./descriptors";
import { repairTodoSequenceIndex, validateRoamLayout } from "./layout";
import type { Descriptor, Entity, Scope, StoreKey } from "./types";

type SessionEntity = Extract<Entity, "sessions" | "todos" | "runs" | "run_events">;
const SESSION_ENTITIES: readonly SessionEntity[] = ["sessions", "todos", "runs", "run_events"];
const BULK_ENTITIES: readonly SessionEntity[] = ["runs", "run_events", "sessions", "todos"];
const HARD_BATCH_BYTES = 16 * 1024 * 1024;
const RECENT_CANCELLATION_MS = 10 * 60 * 1000;
const DUPLICATE = "Duplicate todo sequence for row IDs ";

export type SeedResult = { complete: boolean; through: number; retryable?: false }
  | { complete: false; through: number; retryable: true; reason: "session too busy to seed" };

class SessionTooBusy extends Error {}

interface SeedCandidate { row_key: string; bytes: number }

function projection(descriptor: Descriptor): string {
  return descriptor.columns.map(column => `'${column}', source.${column}`).join(", ");
}

function seedCandidates(db: Db, entity: SessionEntity, sessionId: string, recentSince?: number): IterableIterator<SeedCandidate> {
  const descriptor = DESCRIPTORS[entity];
  const runIsActive = (alias: string) => `(${alias}.status IN ('queued', 'running', 'paused')
    OR (${alias}.status = 'cancelled' AND (${alias}.ended_at IS NULL OR ${alias}.ended_at >= ?)))`;
  const predicate = recentSince === undefined ? ""
    : entity === "runs" ? ` AND ${runIsActive("source")}`
    : entity === "run_events" ? ` AND EXISTS (SELECT 1 FROM runs AS run
        WHERE run.id = source.run_id AND run.session_id = source.session_id AND ${runIsActive("run")})` : "";
  const params: Array<string | number> = [sessionId];
  if (recentSince !== undefined && (entity === "runs" || entity === "run_events")) params.push(recentSince);
  params.push(entity);
  return db.prepare(`SELECT source.${descriptor.key} AS row_key,
      length(CAST(json_object(${projection(descriptor)}) AS BLOB)) AS bytes
    FROM ${descriptor.table} AS source WHERE source.${descriptor.sessionColumn} = ?${predicate}
      AND NOT EXISTS (SELECT 1 FROM roam_versions AS version
        WHERE version.entity = ? AND version.row_key = source.${descriptor.key})
    ORDER BY source.rowid`).iterate(...params) as IterableIterator<SeedCandidate>;
}

function hasUnversionedRows(db: Db, sessionId: string): boolean {
  return SESSION_ENTITIES.some(entity => {
    const descriptor = DESCRIPTORS[entity];
    return Boolean(db.prepare(`SELECT 1 FROM ${descriptor.table} AS source
      WHERE source.${descriptor.sessionColumn} = ? AND NOT EXISTS (
        SELECT 1 FROM roam_versions AS version WHERE version.entity = ? AND version.row_key = source.${descriptor.key}
      ) LIMIT 1`).get(sessionId, entity));
  });
}

function checkKey(key: StoreKey, scope: Scope): void {
  const worktree = key.startsWith("worktree:") ? key.slice("worktree:".length) : "";
  const separator = worktree.lastIndexOf(":");
  if ((scope === "global" && key !== "global") ||
      (scope === "repo" && (!key.startsWith("repo:") || key.length === 5)) ||
      (scope === "worktree" && (separator < 1 || separator === worktree.length - 1))) {
    throw new Error("Invalid roaming store key for scope");
  }
}

function enableStore(db: Db, key: StoreKey): void {
  const meta = db.prepare("SELECT store_key, importing FROM roam_meta WHERE id = 1").get() as { store_key: string | null; importing: number };
  if (meta.importing !== 0) throw new Error("Cannot enable roaming capture during import");
  if (meta.store_key !== null && meta.store_key !== key) throw new Error("Roaming store key cannot change");
  db.prepare("UPDATE roam_meta SET store_key = ?, capture_enabled = 1 WHERE id = 1").run(key);
}

/** Returns an error instead of throwing so a newly diagnosed trigger drift persists. */
function checkLayout(db: Db, scope: Scope): string | null {
  let layout = validateRoamLayout(db, scope);
  if (scope === "worktree" && layout.diagnostic?.startsWith(DUPLICATE) && !layout.diagnostic.includes("; ")) {
    repairTodoSequenceIndex(db);
    layout = validateRoamLayout(db, scope);
  }
  return layout.captureSafe ? null : layout.diagnostic ?? "Store is not roamable";
}

function appendSeed(db: Db, entity: Entity, descriptor: Descriptor, rowKey: string, sessionId: string | null, epoch: number | null): void {
  db.exec(`UPDATE roam_meta SET (hlc_ms, hlc_count) = (
    WITH sample(ms) AS (SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER))
    SELECT max(roam_meta.hlc_ms, sample.ms),
      CASE WHEN sample.ms > roam_meta.hlc_ms THEN 0 ELSE roam_meta.hlc_count + 1 END FROM sample
  ) WHERE id = 1`);
  db.prepare(`INSERT INTO roam_changes
    (change_id, entity, row_key, op, hlc_ms, hlc_count, origin_machine, origin_stream, writer_session, writer_epoch, schema_version, body_json)
    SELECT lower(hex(randomblob(16))), ?, source.${descriptor.key}, 'put', meta.hlc_ms, meta.hlc_count,
      meta.machine_id, meta.stream_id, ?, ?, 14, json_object(${projection(descriptor)})
    FROM ${descriptor.table} AS source CROSS JOIN roam_meta AS meta
    WHERE source.${descriptor.key} = ? AND meta.id = 1`).run(entity, sessionId, epoch, rowKey);
  db.exec(`INSERT INTO roam_versions
    SELECT entity, row_key, change_id, hlc_ms, hlc_count, origin_machine, origin_stream, 0
    FROM roam_changes WHERE seq = last_insert_rowid()`);
}

function through(db: Db): number {
  const seq = (db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM roam_changes").get() as { seq: number }).seq;
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("Roaming sequence out of range");
  return seq;
}

export function seedSession(db: Db, sessionId: string, epoch: number, key: StoreKey, limit: number): SeedResult {
  checkKey(key, "worktree");
  if (!sessionId || !Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Invalid session seed arguments");
  }
  let result: SeedResult | { error: string };
  try {
    result = db.raw.transaction(() => {
      const problem = checkLayout(db, "worktree");
      if (problem) return { error: problem } as const;
      enableStore(db, key);
      const state = db.prepare("SELECT epoch, state FROM roam_sessions WHERE session_id = ?").get(sessionId) as { epoch: number; state: string } | undefined;
      if (state && (state.epoch !== epoch || state.state !== "active")) throw new Error("Session membership is not active at the requested epoch");
      if (!state) db.prepare("INSERT INTO roam_sessions (session_id, epoch, state) VALUES (?, ?, 'active')").run(sessionId, epoch);
      const started = db.prepare("SELECT 1 FROM roam_seed_progress WHERE session_id = ? LIMIT 1").get(sessionId);
      if (!started) {
        const recentSince = Date.now() - RECENT_CANCELLATION_MS;
        let bytes = 0;
        const candidates: Array<{ entity: SessionEntity; rowKey: string }> = [];
        for (const entity of SESSION_ENTITIES) {
          for (const row of seedCandidates(db, entity, sessionId, recentSince)) {
            bytes += row.bytes;
            if (bytes > HARD_BATCH_BYTES) throw new SessionTooBusy();
            candidates.push({ entity, rowKey: row.row_key });
          }
        }
        for (const { entity, rowKey } of candidates) {
          appendSeed(db, entity, DESCRIPTORS[entity], rowKey, sessionId, epoch);
        }
        const complete = !hasUnversionedRows(db, sessionId);
        const progress = db.prepare("INSERT INTO roam_seed_progress (session_id, entity, complete) VALUES (?, ?, ?)");
        for (const entity of SESSION_ENTITIES) progress.run(sessionId, entity, complete ? 1 : 0);
        return { complete, through: through(db) } as const;
      }
      const target = Math.min(limit, HARD_BATCH_BYTES);
      let bytes = 0;
      const candidates: Array<{ entity: SessionEntity; rowKey: string }> = [];
      select: for (const entity of BULK_ENTITIES) {
        for (const row of seedCandidates(db, entity, sessionId)) {
          if (row.bytes > HARD_BATCH_BYTES) throw new Error(`Roaming row ${entity}/${row.row_key} exceeds the hard seed limit`);
          if (candidates.length > 0 && bytes + row.bytes > target) break select;
          candidates.push({ entity, rowKey: row.row_key });
          bytes += row.bytes;
          if (bytes >= target) break select;
        }
      }
      for (const { entity, rowKey } of candidates) {
        appendSeed(db, entity, DESCRIPTORS[entity], rowKey, sessionId, epoch);
      }
      const complete = !hasUnversionedRows(db, sessionId);
      db.prepare("UPDATE roam_seed_progress SET last_key = NULL, complete = ? WHERE session_id = ?")
        .run(complete ? 1 : 0, sessionId);
      return { complete, through: through(db) } as const;
    }).immediate();
  } catch (error) {
    if (error instanceof SessionTooBusy) {
      return { complete: false, through: through(db), retryable: true, reason: "session too busy to seed" };
    }
    throw error;
  }
  if ("error" in result) throw new Error(`Roaming capture is unsafe: ${result.error}`);
  return result;
}

export function enableMemoryCapture(db: Db, key: StoreKey): void {
  const scope: Scope = key === "global" ? "global" : "repo";
  checkKey(key, scope);
  const entity: Entity = scope === "global" ? "global_memory" : "memory";
  const descriptor = DESCRIPTORS[entity];
  const problem = db.raw.transaction(() => {
    const unsafe = checkLayout(db, scope);
    if (unsafe) return unsafe;
    enableStore(db, key);
    const rows = db.prepare(`SELECT source.${descriptor.key} AS row_key FROM ${descriptor.table} AS source
      WHERE NOT EXISTS (SELECT 1 FROM roam_versions AS version WHERE version.entity = ? AND version.row_key = source.${descriptor.key})
      ORDER BY source.${descriptor.key}`).all(entity) as Array<{ row_key: string }>;
    for (const row of rows) appendSeed(db, entity, descriptor, row.row_key, null, null);
    through(db);
    return null;
  }).immediate();
  if (problem) throw new Error(`Roaming capture is unsafe: ${problem}`);
}
