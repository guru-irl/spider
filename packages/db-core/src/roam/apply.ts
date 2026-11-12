import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "../db";
import { isRoamUuid } from "./codec";
import { DESCRIPTORS } from "./descriptors";
import { compareHlc, observeHlc } from "./hlc";
import type { ApplyReceipt, Change, Descriptor, Entity, Hlc, Home, JsonObject, MachineId, RecordChange, ReplicaEffects, StoreKey, ValidatedBatch } from "./types";

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
// Match the memory package's default without making replication enforce write limits.
const DEFAULT_MEMORY_CHAR_CAP = 8000;

interface Meta {
  machine_id: string; stream_id: string; store_key: StoreKey | null; hlc_ms: number; hlc_count: number;
  importing: number; roamable: number; problem: string | null;
}
interface ClockRow { hlc_ms: number; hlc_count: number; origin_machine: string; origin_stream: string }
interface Version extends ClockRow { change_id: string; deleted: number }
interface StoredChange extends ClockRow {
  change_id: string; entity: Entity; row_key: string; op: "put" | "delete"; writer_session: string | null;
  writer_epoch: number | null; schema_version: 14; portable_json: string | null;
}
type BaseRow = { rowid: number; body: JsonObject };
type SessionHome = (sessionId: string) => Home | null | "unknown";

/** Read the private snapshot again so replacement after validation cannot change the import. */
function readChanges(batch: ValidatedBatch): RecordChange[] {
  const directory = lstatSync(dirname(batch.file));
  if (!directory.isDirectory() || (directory.mode & 0o7777) !== 0o700 ||
      (typeof process.getuid === "function" && directory.uid !== process.getuid())) throw new Error("Unsafe roaming batch directory");
  const fd = openSync(batch.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size !== batch.byteLength ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Unsafe roaming batch file or length");
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  if (bytes.length !== batch.byteLength || createHash("sha256").update(bytes).digest("hex") !== batch.sha256) {
    throw new Error("Roaming batch digest or length changed after validation");
  }
  const lines = bytes.toString("utf8").slice(0, -1).split("\n");
  const header = JSON.parse(lines[0]) as unknown;
  if (!isDeepStrictEqual(header, batch.header)) throw new Error("Roaming batch header changed after validation");
  return lines.slice(1).map(line => JSON.parse(line) as RecordChange);
}

function asClock(row: ClockRow): Hlc {
  return { ms: row.hlc_ms, count: row.hlc_count, machine: row.origin_machine, stream: row.origin_stream };
}

function sameEnvelope(row: StoredChange, change: Change): boolean {
  const original: Change = {
    changeId: row.change_id, entity: row.entity, rowKey: row.row_key, op: row.op,
    clock: asClock(row), writerSession: row.writer_session, writerEpoch: row.writer_epoch,
    schema: row.schema_version, body: row.portable_json === null ? null : JSON.parse(row.portable_json) as JsonObject,
  };
  return isDeepStrictEqual(JSON.parse(JSON.stringify(original)), JSON.parse(JSON.stringify(change)));
}

function baseRow(db: Db, descriptor: Descriptor, key: string): BaseRow | null {
  const selected = db.prepare(`SELECT rowid AS __roam_rowid, ${descriptor.columns.join(", ")} FROM ${descriptor.table} WHERE ${descriptor.key} = ?`)
    .get(key) as (Record<string, unknown> & { __roam_rowid: number }) | undefined;
  if (!selected) return null;
  const body: JsonObject = {};
  for (const column of descriptor.columns) body[column] = selected[column] as JsonObject[string];
  return { rowid: selected.__roam_rowid, body };
}

function checkIdentity(db: Db, change: Change, old: Version | undefined): void {
  if (!old || change.op !== "put" || change.body === null) return;
  const descriptor = DESCRIPTORS[change.entity];
  const columns = descriptor.immutable.filter(column => column !== descriptor.key);
  if (columns.length === 0) return;
  let previous = old.deleted === 0 ? baseRow(db, descriptor, change.rowKey)?.body : undefined;
  if (!previous) {
    const historical = db.prepare(`SELECT writer_session, coalesce(wire_json, body_json) AS body
      FROM roam_changes WHERE entity = ? AND row_key = ?
      ORDER BY CASE WHEN op = 'put' THEN 0 ELSE 1 END, seq LIMIT 1`)
      .get(change.entity, change.rowKey) as { writer_session: string | null; body: string | null } | undefined;
    if (historical?.writer_session !== null && historical?.writer_session !== undefined &&
        descriptor.sessionColumn !== null && historical.writer_session !== change.writerSession) {
      throw new Error(`Roaming immutable session identity changed for ${change.entity}/${change.rowKey}`);
    }
    if (historical?.body) previous = JSON.parse(historical.body) as JsonObject;
  }
  if (previous && columns.some(column => previous![column] !== change.body![column])) {
    throw new Error(`Roaming immutable identity changed for ${change.entity}/${change.rowKey}`);
  }
}

function checkHome(db: Db, change: Change, hubMachine: MachineId): void {
  if (change.clock.machine !== hubMachine) throw new Error("Roaming home change did not originate on the hub");
  if (change.op !== "put" || change.body === null) throw new Error("Roaming home cannot be deleted");
  const current = db.prepare("SELECT machine_id, epoch, move_id FROM session_homes WHERE session_id = ?")
    .get(change.rowKey) as { machine_id: string; epoch: number; move_id: string | null } | undefined;
  if (!current) return;
  const next = change.body;
  if ((next.epoch as number) < current.epoch ||
      (next.epoch === current.epoch && (next.machine_id !== current.machine_id || next.move_id !== current.move_id))) {
    throw new Error(`Roaming home epoch or owner conflicts for ${change.rowKey}`);
  }
}

function clearTodoCollision(
  db: Db, change: Change, localMachine: MachineId, effects: ReplicaEffects,
  sessionHome: SessionHome,
): void {
  if (change.entity !== "todos" || change.op !== "put" || change.body === null) return;
  const sessionId = change.body.session_id as string;
  const collision = db.prepare("SELECT uuid FROM todos WHERE session_id = ? AND seq = ? AND uuid <> ?")
    .get(sessionId, change.body.seq, change.rowKey) as { uuid: string } | undefined;
  if (!collision) return;
  const tracked = db.prepare(`SELECT 1 FROM roam_changes WHERE entity = 'todos' AND row_key = ?
    UNION ALL SELECT 1 FROM roam_versions WHERE entity = 'todos' AND row_key = ? LIMIT 1`).get(collision.uuid, collision.uuid);
  const home = tracked ? null : sessionHome(sessionId);
  const foreign = home !== null && home !== "unknown" && home.sessionId === sessionId &&
    isRoamUuid(home.machineId) && home.machineId !== localMachine;
  if (tracked || !foreign) throw new Error(`Roaming todo collision between ${collision.uuid} and ${change.rowKey}`);
  const before = baseRow(db, DESCRIPTORS.todos, collision.uuid);
  if (!before) throw new Error("Roaming todo collision disappeared");
  db.prepare("DELETE FROM todos WHERE uuid = ?").run(collision.uuid);
  effects.winning(db, before, null, { ...change, rowKey: collision.uuid, op: "delete", body: null });
}

function writeWinner(db: Db, change: Change, meta: Meta, effects: ReplicaEffects, sessionHome: SessionHome): void {
  const descriptor = DESCRIPTORS[change.entity];
  const before = baseRow(db, descriptor, change.rowKey);
  if (change.op === "delete") {
    if (before) db.prepare(`DELETE FROM ${descriptor.table} WHERE ${descriptor.key} = ?`).run(change.rowKey);
    effects.winning(db, before, null, change);
    return;
  }
  clearTodoCollision(db, change, meta.machine_id, effects, sessionHome);
  const body = change.body!;
  if (before) {
    const columns = descriptor.columns.filter(column => column !== descriptor.key);
    const clearProcess = change.entity === "runs" && body.origin_machine !== meta.machine_id
      ? ", pid = NULL, host_pid = NULL, pid_start_time = NULL, intercom_session = NULL" : "";
    db.prepare(`UPDATE ${descriptor.table} SET ${columns.map(column => `${column} = ?`).join(", ")}${clearProcess} WHERE ${descriptor.key} = ?`)
      .run(...columns.map(column => body[column]), change.rowKey);
  } else {
    db.prepare(`INSERT INTO ${descriptor.table} (${descriptor.columns.join(", ")}) VALUES (${descriptor.columns.map(() => "?").join(", ")})`)
      .run(...descriptor.columns.map(column => body[column]));
  }
  const after = baseRow(db, descriptor, change.rowKey);
  if (!after) throw new Error("Roaming row was not written");
  effects.winning(db, before, { rowid: after.rowid }, change);
}

/** Apply only validated snapshots, and return a receipt only after their transaction commits. */
export function applyBatch(
  db: Db,
  batch: ValidatedBatch,
  options: { hubMachine: MachineId; effects: ReplicaEffects; now: number; sessionHome: SessionHome },
): ApplyReceipt {
  const started = performance.now();
  if (!Number.isSafeInteger(options.now) || options.now < 0 || !isRoamUuid(options.hubMachine) ||
      typeof options.sessionHome !== "function" || typeof options.effects?.winning !== "function" || typeof options.effects?.committed !== "function") {
    throw new Error("Invalid roaming apply options");
  }
  if (db.raw.inTransaction) throw new Error("Cannot apply a roaming batch inside an open transaction");
  const changes = readChanges(batch);
  const header = batch.header;
  if (header.count === 0) throw new Error("Empty roaming batches are not imported");
  const outcome = db.raw.transaction(() => {
    const meta = db.prepare("SELECT machine_id, stream_id, store_key, hlc_ms, hlc_count, importing, roamable, problem FROM roam_meta WHERE id = 1")
      .get() as Meta | undefined;
    if (!meta || meta.store_key !== header.storeKey) throw new Error("Roaming destination store does not match this batch");
    const receipt = db.prepare("SELECT peer_stream, after_seq, through_seq, sha256 FROM roam_receipts WHERE peer_machine = ? AND batch_id = ?")
      .get(header.senderMachine, header.batchId) as { peer_stream: string; after_seq: number; through_seq: number; sha256: string } | undefined;
    if (receipt) {
      if (receipt.peer_stream !== header.senderStream || receipt.after_seq !== header.after || receipt.through_seq !== header.through || receipt.sha256 !== batch.sha256) {
        throw new Error("Roaming batch receipt conflicts with this digest or range");
      }
      return { kind: "replay" as const };
    }
    if (meta.roamable !== 1 || meta.problem !== null || meta.importing !== 0) throw new Error("Roaming destination store is not ready for this batch");
    for (const change of changes) {
      if (change.clock.ms > options.now && change.clock.ms - options.now > MAX_FUTURE_SKEW_MS) throw new Error("Remote roaming clock exceeds future skew limit");
    }
    const cursor = db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
      .get(header.senderMachine, header.senderStream) as { last_seq: number } | undefined;
    if ((cursor?.last_seq ?? 0) !== header.after) throw new Error("Roaming cursor does not match the batch sequence");
    db.prepare("UPDATE roam_meta SET importing = 1 WHERE id = 1").run();
    let local: Hlc = { ms: meta.hlc_ms, count: meta.hlc_count, machine: meta.machine_id, stream: meta.stream_id };
    let changed = false;
    let changedMemory = false;
    const findChange = db.prepare(`SELECT change_id, entity, row_key, op, hlc_ms, hlc_count, origin_machine, origin_stream,
      writer_session, writer_epoch, schema_version, coalesce(wire_json, body_json) AS portable_json
      FROM roam_changes WHERE change_id = ?`);
    const findVersion = db.prepare("SELECT change_id, hlc_ms, hlc_count, origin_machine, origin_stream, deleted FROM roam_versions WHERE entity = ? AND row_key = ?");
    const append = db.prepare(`INSERT INTO roam_changes
      (change_id, entity, row_key, op, hlc_ms, hlc_count, origin_machine, origin_stream, writer_session, writer_epoch, schema_version, body_json, wire_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
    const version = db.prepare(`INSERT INTO roam_versions
      (entity, row_key, change_id, hlc_ms, hlc_count, origin_machine, origin_stream, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity, row_key) DO UPDATE SET change_id = excluded.change_id, hlc_ms = excluded.hlc_ms,
      hlc_count = excluded.hlc_count, origin_machine = excluded.origin_machine, origin_stream = excluded.origin_stream, deleted = excluded.deleted`);
    for (const record of changes) {
      const { seq: _sequence, ...change } = record;
      const seen = findChange.get(change.changeId) as StoredChange | undefined;
      if (seen) {
        if (!sameEnvelope(seen, change)) throw new Error(`Roaming change ID ${change.changeId} has a different envelope`);
        continue;
      }
      if (change.entity === "session_homes") checkHome(db, change, options.hubMachine);
      if (change.writerSession !== null) {
        db.prepare(`INSERT INTO roam_sessions(session_id, epoch, state) VALUES (?, ?, 'retired')
          ON CONFLICT(session_id) DO NOTHING`).run(change.writerSession, change.writerEpoch);
      }
      const old = findVersion.get(change.entity, change.rowKey) as Version | undefined;
      checkIdentity(db, change, old);
      const comparison = old ? compareHlc(change.clock, asClock(old)) : 1;
      if (comparison === 0) throw new Error(`Equal roaming clocks conflict for ${change.entity}/${change.rowKey}`);
      if (change.entity === "session_homes" && old && comparison < 0) {
        const existing = baseRow(db, DESCRIPTORS.session_homes, change.rowKey);
        if (existing && (change.body!.epoch as number) > (existing.body.epoch as number)) {
          throw new Error(`Roaming home epoch conflicts with its clock for ${change.rowKey}`);
        }
      }
      local = observeHlc(local, change.clock, options.now);
      append.run(change.changeId, change.entity, change.rowKey, change.op, change.clock.ms, change.clock.count,
        change.clock.machine, change.clock.stream, change.writerSession, change.writerEpoch, change.schema,
        change.body === null ? null : JSON.stringify(change.body));
      if (comparison > 0) {
        writeWinner(db, change, meta, options.effects, options.sessionHome);
        version.run(change.entity, change.rowKey, change.changeId, change.clock.ms, change.clock.count,
          change.clock.machine, change.clock.stream, change.op === "delete" ? 1 : 0);
        changed = true;
        if (change.entity === "memory" || change.entity === "global_memory") changedMemory = true;
      }
    }
    db.prepare("UPDATE roam_meta SET importing = 0, hlc_ms = ?, hlc_count = ? WHERE id = 1").run(local.ms, local.count);
    db.prepare(`INSERT INTO roam_cursors(peer_machine, peer_stream, last_seq) VALUES (?, ?, ?)
      ON CONFLICT(peer_machine, peer_stream) DO UPDATE SET last_seq = excluded.last_seq`)
      .run(header.senderMachine, header.senderStream, header.through);
    db.prepare("INSERT INTO roam_receipts(peer_machine, batch_id, peer_stream, after_seq, through_seq, sha256, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(header.senderMachine, header.batchId, header.senderStream, header.after, header.through, batch.sha256, options.now);
    const table = header.storeKey === "global" ? "global_memory" : header.storeKey.startsWith("repo:") ? "memory" : null;
    const memoryChars = changedMemory && table
      ? (db.prepare(`SELECT coalesce(sum(length(content)), 0) AS total FROM ${table} WHERE status = 'active'`).get() as { total: number }).total : null;
    return { kind: "applied" as const, changed, memoryChars };
  }).immediate();

  if (outcome.kind === "applied") {
    if (outcome.changed) {
      try { options.effects.committed(header.storeKey); }
      catch (error) { try { console.error("Post-commit roaming effect failed", error); } catch { /* diagnostic is best effort */ } }
    }
    if (outcome.memoryChars !== null && outcome.memoryChars > DEFAULT_MEMORY_CHAR_CAP) {
      try { console.warn(`Roaming memory exceeds the default active character cap (${outcome.memoryChars} of ${DEFAULT_MEMORY_CHAR_CAP}) in ${header.storeKey}`); }
      catch { /* diagnostic is best effort */ }
    }
  }
  return { batchId: header.batchId, stream: header.senderStream, through: header.through, sha256: batch.sha256,
    applyMs: outcome.kind === "replay" ? null : performance.now() - started };
}
