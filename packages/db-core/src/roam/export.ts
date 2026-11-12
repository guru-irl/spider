import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "../db";
import { assertBatchHeader, assertRecordChange, HARD_BATCH_BYTES, isRoamUuid, parseRoamJson, privateBatchDirectory, storeScope, writePrivateBatch } from "./codec";
import type { BatchArtifact, BatchHeader, Entity, ExportPolicy, JsonObject, RecordChange, StoreKey } from "./types";

interface Meta { machine_id: string; stream_id: string; store_key: StoreKey | null; roamable: number; problem: string | null }
interface ChangeRow {
  seq: number; change_id: string; entity: Entity; row_key: string; op: "put" | "delete";
  hlc_ms: number; hlc_count: number; origin_machine: string; origin_stream: string;
  writer_session: string | null; writer_epoch: number | null; schema_version: number;
  body_json: string | null; wire_json: string | null; portable_json: string | null; run_origin: string | null;
}

function parseBody(json: string | null): JsonObject | null {
  if (json === null) return null;
  try { return parseRoamJson(json) as JsonObject; }
  catch { throw new Error("Invalid roaming row JSON"); }
}

function envelope(row: ChangeRow): RecordChange {
  return {
    seq: row.seq, changeId: row.change_id, entity: row.entity, rowKey: row.row_key, op: row.op,
    clock: { ms: row.hlc_ms, count: row.hlc_count, machine: row.origin_machine, stream: row.origin_stream },
    writerSession: row.writer_session, writerEpoch: row.writer_epoch, schema: row.schema_version as 14,
    body: parseBody(row.portable_json),
  };
}

function encodedHeader(header: BatchHeader): Buffer { return Buffer.from(`${JSON.stringify(header)}\n`); }

export async function exportBatch(
  db: Db,
  request: { after: number; targetBytes: number; batchId: string },
  policy: ExportPolicy,
): Promise<BatchArtifact> {
  if (!Number.isSafeInteger(request.after) || request.after < 0 || !Number.isSafeInteger(request.targetBytes) ||
      request.targetBytes < 1 || typeof request.batchId !== "string" || !request.batchId ||
      !policy || typeof policy.encode !== "function") throw new Error("Invalid roaming export request");
  if (db.raw.inTransaction) throw new Error("Cannot export from an open transaction");
  if (!db.raw.name || db.raw.name === ":memory:") throw new Error("Roaming export requires a file-backed store");
  const target = Math.min(request.targetBytes, HARD_BATCH_BYTES);
  const snapshot = db.raw.transaction(() => {
    const meta = db.prepare("SELECT machine_id, stream_id, store_key, roamable, problem FROM roam_meta WHERE id = 1").get() as Meta | undefined;
    if (!meta || meta.store_key === null || meta.roamable !== 1 || meta.problem !== null) throw new Error("Roaming store is not ready for export");
    const scope = storeScope(meta.store_key);
    const max = (db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM roam_changes").get() as { seq: number }).seq;
    if (!Number.isSafeInteger(max) || max < 0 || request.after > max) throw new Error("Roaming export cursor is ahead of the sequence");
    if (request.after > 0 && !db.prepare("SELECT 1 FROM roam_changes WHERE seq = ?").get(request.after)) {
      throw new Error("Roaming export cursor points to a sequence gap");
    }
    let header: BatchHeader = {
      protocol: 1, schema: 14, batchId: request.batchId, senderMachine: meta.machine_id, senderStream: meta.stream_id,
      storeKey: meta.store_key, after: request.after, through: request.after, count: 0,
    };
    assertBatchHeader(header);
    if (encodedHeader(header).length > HARD_BATCH_BYTES) throw new Error("Roaming batch header exceeds the hard limit");
    const records: Buffer[] = [];
    const caches: Array<{ seq: number; json: string }> = [];
    let recordBytes = 0;
    let last = request.after;
    const runOrigin = scope === "worktree" ? `CASE WHEN entity = 'run_events' AND op = 'put' AND json_valid(body_json)
      THEN (SELECT origin_machine FROM runs WHERE runs.id = json_extract(roam_changes.body_json, '$.run_id')) ELSE NULL END` : "NULL";
    const rows = db.prepare(`SELECT seq, change_id, entity, row_key, op, hlc_ms, hlc_count, origin_machine, origin_stream,
      writer_session, writer_epoch, schema_version, body_json, wire_json, coalesce(wire_json, body_json) AS portable_json,
      ${runOrigin} AS run_origin FROM roam_changes WHERE seq > ? ORDER BY seq`).iterate(request.after) as IterableIterator<ChangeRow>;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.seq) || row.seq !== last + 1) throw new Error("Roaming change sequence has a gap");
      let record = envelope(row);
      assertRecordChange(record, meta.store_key);
      let cache: string | null = null;
      if (row.op === "put" && row.wire_json === null &&
          row.origin_machine === meta.machine_id && row.origin_stream === meta.stream_id) {
        const original = record.body!;
        const origin = record.entity === "sessions" || record.entity === "runs"
          ? original.origin_machine : row.run_origin ?? record.clock.machine;
        if (!isRoamUuid(origin)) throw new Error("Invalid roaming row origin");
        const converted = policy.encode(record.entity, structuredClone(original), origin);
        const candidate = { ...record, body: converted };
        assertRecordChange(candidate, meta.store_key);
        if (!isDeepStrictEqual(original, converted)) {
          cache = JSON.stringify(converted);
          record = candidate;
        }
      }
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      const singleton: BatchHeader = { ...header, after: row.seq - 1, through: row.seq, count: 1 };
      if (encodedHeader(singleton).length + line.length > HARD_BATCH_BYTES) {
        throw new Error(`Roaming row ${record.entity}/${record.rowKey} exceeds the hard wire limit`);
      }
      const next: BatchHeader = { ...header, through: row.seq, count: records.length + 1 };
      const size = encodedHeader(next).length + recordBytes + line.length;
      if (cache !== null) caches.push({ seq: row.seq, json: cache });
      if (records.length > 0 && (size > target || size > HARD_BATCH_BYTES)) break;
      records.push(line);
      recordBytes += line.length;
      header = next;
      last = row.seq;
      if (size >= target) break;
    }
    const update = db.prepare("UPDATE roam_changes SET wire_json = ? WHERE seq = ? AND wire_json IS NULL");
    for (const cache of caches) {
      if (update.run(cache.json, cache.seq).changes !== 1) throw new Error("Roaming wire cache changed during export");
    }
    return { header, bytes: Buffer.concat([encodedHeader(header), ...records]) };
  }).immediate();
  const directory = join(dirname(resolve(db.raw.name)), ".roam-batches");
  privateBatchDirectory(directory);
  const file = writePrivateBatch(directory, snapshot.bytes);
  return { file, byteLength: snapshot.bytes.length, sha256: createHash("sha256").update(snapshot.bytes).digest("hex"), header: snapshot.header };
}
