import { createHash } from "node:crypto";
import type { IntercomIntakeFence } from "@spider/intercom/protocol";
import { isIntercomIntakeFence } from "../../intercom/src/broker/protocol";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { assertTestConfigPath, openDb, withRetry } from "@spider/db-core";
import type { Db } from "@spider/db-core";
import type { JsonObject, StoreKey } from "@spider/db-core/roam/types";
import { storeScope } from "@spider/db-core/roam/codec";
import type { Journal, JournalOperationState, Operation } from "./contracts";
import { isMachineId } from "./machine-id";

function unsafe(): Error { return new Error("Unsafe journal path or symlink"); }

function checkOwned(stat: ReturnType<typeof fstatSync>, directory: boolean): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if ((directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.platform !== "win32" && uid !== undefined && stat.uid !== uid)) throw unsafe();
}

function makeDirectoryPrivate(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe();
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    checkOwned(stat, true);
    if (process.platform !== "win32" && (stat.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

function checkSidecar(file: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink()) throw unsafe();
  checkOwned(stat, false);
  if (process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) throw unsafe();
}

function prepareFile(file: string): void {
  if (!isAbsolute(file)) throw unsafe();
  // The shared fixture guard runs before this module creates any directories.
  assertTestConfigPath(file);
  makeDirectoryPrivate(dirname(file));
  let fd: number;
  try { fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw unsafe();
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    checkOwned(stat, false);
    if (process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
  checkSidecar(`${file}-wal`);
  checkSidecar(`${file}-shm`);
}

function withDatabase<T>(file: string, fn: (db: Db) => T): T {
  prepareFile(file);
  const db = withRetry(() => openDb(file, { fileMustExist: true, checkpointOnClose: false }));
  try {
    db.pragma("synchronous = FULL");
    return fn(db);
  } finally { db.close(); }
}

function canonical(value: unknown, visiting: Set<object> = new Set()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return JSON.stringify(value);
  if (typeof value !== "object" || visiting.has(value)) throw new Error("Invalid operation arguments or result");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("Invalid operation arguments or result");
  }
  visiting.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from(value, item => canonical(item, visiting)).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key], visiting)}`).join(",")}}`;
  } finally { visiting.delete(value); }
}

function objectJson(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operation arguments or result");
  return canonical(value);
}

function digest(operation: Operation): string {
  if (!operation || typeof operation.id !== "string" || !operation.id ||
      !isMachineId(operation.machineId) ||
      typeof operation.kind !== "string" || !operation.kind ||
      !(operation.expectedEpoch === null || Number.isSafeInteger(operation.expectedEpoch) && operation.expectedEpoch > 0)) {
    throw new Error("Invalid operation arguments");
  }
  objectJson(operation.args);
  const input = canonical({ machineId: operation.machineId, expectedEpoch: operation.expectedEpoch, kind: operation.kind, args: operation.args });
  return createHash("sha256").update(input).digest("hex");
}

function parseResult(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  objectJson(value);
  return value as JsonObject;
}

type OperationRow = { digest: string; result_json: string | null };

const artifactKinds = new Set(["export", "artifact-transfer", "artifact-pull", "sync-accept", "import", "move", "session-start"]);
export function readOnlyOperation(kind: string): boolean { return ["stores", "inventory", "cursor", "receipt", "split"].includes(kind); }
function referenceTerms(value: string): string[] { return [value, basename(value).replace(/\.ndjson$/, "")]; }
function referenceHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function resultReferences(value: unknown): string[] {
  const refs = new Set<string>();
  function visit(item: unknown): void {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (["artifact", "artifactId", "id", "file", "batchId", "exportId"].includes(key) && typeof child === "string")
        for (const term of referenceTerms(child)) refs.add(term);
      else visit(child);
    }
  }
  visit(value); return [...refs];
}
export interface ArtifactJournal extends Journal {
  /** Only the completed retirement for this departure permits discarding later bytes. */
  retiredSessionPrefix(sessionId: string, file: string, machineId: string, moveId: string, epoch: number): { size: number; sha256: string } | null;
  lookupOperation(id: string): JournalOperationState | null;
  hasArtifactReference(value: string): boolean;
  referenceCheck(): (value: string) => boolean;
  releaseArtifact(value: string): void;
  cancel(id: string): void;
  prune(now: number, retentionMs: number, retained?: (value: string) => boolean): string[];
}
type ReferenceRow = { operation_id: string; kind: string; result_json: string | null; references_json: string | null; released: number; completed_at: number | null };
function rowReferences(db: Db, row: ReferenceRow): Set<string> {
  const refs = new Set<string>(row.references_json === null ? [] : JSON.parse(row.references_json) as string[]);
  for (const action of db.prepare("SELECT result_json FROM roam_operation_actions WHERE operation_id=?").all(row.operation_id) as { result_json: string }[])
    for (const value of resultReferences(parseResult(action.result_json))) refs.add(referenceHash(value));
  if (row.result_json !== null) for (const value of resultReferences(parseResult(row.result_json))) refs.add(referenceHash(value));
  return refs;
}
export function releaseJournalArtifact(journal: Journal, value: string): void {
  (journal as Partial<ArtifactJournal>).releaseArtifact?.(value);
}

/** A local operation journal. Each call closes its SQLite handle after commit. */
export function openJournal(file: string): ArtifactJournal {
  withDatabase(file, db => {
    db.raw.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS roam_operations (
        operation_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        expected_epoch INTEGER,
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS roam_operation_actions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL REFERENCES roam_operations(operation_id),
        action TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS roam_operation_actions_id ON roam_operation_actions(operation_id, seq);
      CREATE TABLE IF NOT EXISTS roam_journal_sweep (
        id INTEGER PRIMARY KEY CHECK(id=1), completed_at INTEGER NOT NULL, operation_id TEXT NOT NULL
      );
    `)).immediate();
    db.raw.transaction(() => {
      const columns = new Set((db.raw.pragma("table_info(roam_operations)") as { name: string }[]).map(row => row.name));
      for (const [name, ddl] of [["references_json", "TEXT"], ["released", "INTEGER NOT NULL DEFAULT 0"], ["completed_at", "INTEGER"]])
        if (!columns.has(name)) db.exec(`ALTER TABLE roam_operations ADD COLUMN ${name} ${ddl}`);
      db.prepare("UPDATE roam_operations SET completed_at=? WHERE result_json IS NOT NULL AND completed_at IS NULL").run(Date.now());
      db.exec("CREATE INDEX IF NOT EXISTS roam_operations_completed ON roam_operations(completed_at)");
      db.exec("CREATE INDEX IF NOT EXISTS roam_operations_retention ON roam_operations(completed_at,operation_id)");
    }).immediate();
  });
  const referenceCheck = (): ((value: string) => boolean) => withDatabase(file, db => {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='freeze_journal'").get() &&
        db.prepare("SELECT 1 FROM freeze_journal WHERE state IS NULL OR state NOT IN ('complete','aborted') LIMIT 1").get()) return () => true;
    const references = new Set<string>();
    for (const row of db.prepare("SELECT * FROM roam_operations WHERE released=0").all() as ReferenceRow[]) {
      if (!artifactKinds.has(row.kind)) continue;
      if (row.result_json === null && row.references_json === null) return () => true;
      for (const ref of rowReferences(db, row)) references.add(ref);
    }
    return value => referenceTerms(value).some(term => references.has(referenceHash(term)));
  });
  return {
    retiredSessionPrefix(sessionId, target, machineId, moveId, epoch) {
      freezeIdentity(sessionId, moveId, epoch);
      if (!isAbsolute(target) || !isMachineId(machineId)) throw new Error("Invalid retired session identity");
      return withDatabase(file, db => {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='freeze_journal'").get()) return null;
        const rows = db.prepare(`SELECT o.operation_id, o.result_json, f.move_id, f.intercom_json
          FROM freeze_journal f JOIN roam_operations o
            ON o.kind='session-freeze' AND o.expected_epoch=f.epoch AND o.machine_id=?
            AND json_extract(o.result_json,'$.sessionId')=f.session_id
            AND json_extract(o.result_json,'$.intercomGeneration')=json_extract(f.intercom_json,'$.generation')
          WHERE f.session_id=? AND f.move_id=? AND f.epoch=? AND f.state='complete'
            AND json_extract(o.result_json,'$.file')=?`).all(machineId, sessionId, moveId, epoch, target) as
          { operation_id: string; result_json: string; move_id: string; intercom_json: string }[];
        if (!rows.length) return null;
        if (rows.length !== 1) throw new Error("Ambiguous retired session prefix");
        const row = rows[0], ack = parseResult(row.result_json), fence: unknown = JSON.parse(row.intercom_json);
        if (ack.operationId !== row.operation_id || ack.sessionId !== sessionId || ack.epoch !== epoch || ack.file !== target ||
            !isIntercomIntakeFence(fence) || fence.moveId !== row.move_id || fence.address.sessionId !== sessionId ||
            fence.expectedEpoch !== epoch || fence.generation !== ack.intercomGeneration ||
            typeof ack.size !== "number" || !Number.isSafeInteger(ack.size) || ack.size <= 0 ||
            typeof ack.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ack.sha256)) throw new Error("Invalid retired session prefix");
        return { size: ack.size, sha256: ack.sha256 };
      });
    },
    begin(operation) {
      const argumentsDigest = digest(operation);
      return withDatabase(file, db => db.raw.transaction(() => {
        const row = db.prepare("SELECT digest, result_json FROM roam_operations WHERE operation_id = ?").get(operation.id) as OperationRow | undefined;
        if (row) {
          if (row.digest !== argumentsDigest) throw new Error("Operation ID already has different arguments");
          return row.result_json === null
            ? { kind: "pending" as const, result: null }
            : { kind: "done" as const, result: parseResult(row.result_json) };
        }
        const refs = resultReferences(operation.args);
        if (operation.kind === "export") refs.push(operation.id);
        db.prepare("INSERT INTO roam_operations(operation_id, machine_id, expected_epoch, kind, digest, references_json) VALUES (?, ?, ?, ?, ?, ?)")
          .run(operation.id, operation.machineId, operation.expectedEpoch, operation.kind, argumentsDigest, JSON.stringify([...new Set(refs.map(referenceHash))]));
        return { kind: "new" as const, result: null };
      }).immediate());
    },
    lookupOperation(id) {
      if (typeof id !== "string" || !id) throw new Error("Invalid operation ID");
      return withDatabase(file, db => {
        const row = db.prepare("SELECT machine_id, result_json FROM roam_operations WHERE operation_id = ?").get(id) as
          { machine_id: string; result_json: string | null } | undefined;
        if (!row) return null;
        if (!isMachineId(row.machine_id)) throw new Error("Invalid journal operation machine");
        return { machineId: row.machine_id, state: row.result_json === null ? "pending" as const : "done" as const };
      });
    },
    record(id, action, result) {
      if (typeof id !== "string" || !id || typeof action !== "string" || !action) throw new Error("Invalid journal action");
      const encoded = objectJson(result);
      withDatabase(file, db => db.raw.transaction(() => {
        const row = db.prepare("SELECT digest, result_json FROM roam_operations WHERE operation_id = ?").get(id) as OperationRow | undefined;
        if (!row) throw new Error("Operation has not begun");
        if (row.result_json !== null) {
          if (action === "done" && row.result_json === encoded) return;
          throw new Error("Operation already completed");
        }
        db.prepare("INSERT INTO roam_operation_actions(operation_id, action, result_json) VALUES (?, ?, ?)").run(id, action, encoded);
        if (action === "done") db.prepare("UPDATE roam_operations SET result_json = ?, completed_at=? WHERE operation_id = ?").run(encoded, Date.now(), id);
      }).immediate());
    },
    read(id) {
      return withDatabase(file, db => {
        const rows = db.prepare("SELECT action, result_json FROM roam_operation_actions WHERE operation_id = ? ORDER BY seq").all(id) as { action: string; result_json: string }[];
        return rows.map(row => ({ action: row.action, result: parseResult(row.result_json) }));
      });
    },
    referenceCheck,
    hasArtifactReference(value) {
      if (typeof value !== "string" || !value) throw new Error("Invalid artifact reference");
      return referenceCheck()(value);
    },
    releaseArtifact(value) {
      const terms = referenceTerms(value).map(referenceHash);
      withDatabase(file, db => db.raw.transaction(() => {
        for (const row of db.prepare("SELECT * FROM roam_operations WHERE result_json IS NOT NULL AND released=0").all() as ReferenceRow[])
          if (terms.some(term => rowReferences(db, row).has(term))) db.prepare("UPDATE roam_operations SET released=1 WHERE operation_id=?").run(row.operation_id);
      }).immediate());
    },
    cancel(id) {
      withDatabase(file, db => db.raw.transaction(() => {
        const row = db.prepare("SELECT result_json FROM roam_operations WHERE operation_id=?").get(id) as { result_json: string | null } | undefined;
        if (!row || row.result_json !== null) return;
        const result = objectJson({ cancelled: true });
        db.prepare("INSERT INTO roam_operation_actions(operation_id,action,result_json) VALUES (?,'done',?)").run(id, result);
        db.prepare("UPDATE roam_operations SET result_json=?,completed_at=?,released=1 WHERE operation_id=?").run(result, Date.now(), id);
      }).immediate());
    },
    prune(now, retentionMs, retained = () => false) {
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new Error("Invalid journal retention");
      return withDatabase(file, db => db.raw.transaction(() => {
        const removed: string[] = [];
        const cutoff = now - retentionMs;
        const progress = db.prepare("SELECT completed_at,operation_id FROM roam_journal_sweep WHERE id=1").get() as
          { completed_at: number; operation_id: string } | undefined;
        let rows = progress ? db.prepare("SELECT * FROM roam_operations WHERE completed_at <= ? AND (completed_at,operation_id) > (?,?) ORDER BY completed_at,operation_id LIMIT 256")
          .all(cutoff, progress.completed_at, progress.operation_id) as ReferenceRow[] : [];
        if (!rows.length) rows = db.prepare("SELECT * FROM roam_operations WHERE completed_at <= ? ORDER BY completed_at,operation_id LIMIT 256").all(cutoff) as ReferenceRow[];
        const last = rows.at(-1);
        if (last) db.prepare("INSERT INTO roam_journal_sweep VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET completed_at=excluded.completed_at,operation_id=excluded.operation_id")
          .run(last.completed_at, last.operation_id);
        for (const row of rows) {
          // Destruction recovery receipts remain proof for old move reconciliation and same-ID retry.
          if (row.kind === "forget-machine" || row.kind === "restore-destroyed-home") continue;
          // Retained source files need their acknowledged byte boundary on a later return.
          if (row.kind === "session-freeze" && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='freeze_journal'").get() &&
              db.prepare(`SELECT 1 FROM freeze_journal f JOIN roam_operations o
                ON json_extract(o.result_json,'$.sessionId')=f.session_id AND o.expected_epoch=f.epoch
                AND json_extract(o.result_json,'$.intercomGeneration')=json_extract(f.intercom_json,'$.generation')
                WHERE o.operation_id=? AND f.state IN ('frozen','complete')`).get(row.operation_id)) continue;
          const refs = rowReferences(db, row);
          if (artifactKinds.has(row.kind) && !row.released && refs.size) continue;
          const values = [row.operation_id, ...(row.result_json ? resultReferences(parseResult(row.result_json)) : [])];
          if (values.some(retained)) continue;
          db.prepare("DELETE FROM roam_operation_actions WHERE operation_id=?").run(row.operation_id);
          db.prepare("DELETE FROM roam_operations WHERE operation_id=?").run(row.operation_id); removed.push(row.operation_id);
        }
        return removed;
      }).immediate());
    },
  };
}

export type FreezeJournalState = "freezing" | "frozen" | "aborting" | "aborted" | "complete";
export interface FreezeProgress { sessionId: string; moveId: string; epoch: number; state: FreezeJournalState }
export interface FreezeJournal extends ArtifactJournal {
  beginFreeze(sessionId: string, moveId: string, epoch: number): FreezeProgress;
  readIntercomFence(sessionId: string, moveId: string): IntercomIntakeFence | null;
  bindIntercomFence(fence: IntercomIntakeFence): void;
  readFreeze(sessionId: string, moveId: string): FreezeProgress | null;
  readFreezeRoster(sessionId: string, moveId: string): readonly StoreKey[] | null;
  bindFreezeRoster(sessionId: string, moveId: string, epoch: number, stores: readonly StoreKey[]): void;
  advanceFreeze(sessionId: string, moveId: string, epoch: number, state: FreezeJournalState): FreezeProgress;
}

type FreezeRow = { session_id: string; move_id: string; epoch: number; state: string };
const freezeStates: readonly FreezeJournalState[] = ["freezing", "frozen", "aborting", "aborted", "complete"];
function freezeIdentity(sessionId: string, moveId: string, epoch?: number): void {
  const valid = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
  if (!valid(sessionId) || !valid(moveId) || epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 1))
    throw new Error("Invalid freeze identity");
}
function freezeProgress(row: FreezeRow): FreezeProgress {
  freezeIdentity(row.session_id, row.move_id, row.epoch);
  if (!freezeStates.includes(row.state as FreezeJournalState)) throw new Error("Invalid freeze progress");
  return { sessionId: row.session_id, moveId: row.move_id, epoch: row.epoch, state: row.state as FreezeJournalState };
}

function parseFreezeRoster(encoded: string): StoreKey[] {
  const value: unknown = JSON.parse(encoded);
  if (!Array.isArray(value) || !value.length || value.some(key => typeof key !== "string") || new Set(value).size !== value.length)
    throw new Error("Invalid freeze store roster");
  for (const key of value) storeScope(key as StoreKey);
  return [...value].sort() as StoreKey[];
}

/** This migration is separate from the operations and artifact journal migrations. */
function migrateFreezeJournal(db: Db): void {
  db.raw.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS freeze_journal (
      session_id TEXT NOT NULL,
      move_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('freezing','frozen','aborting','aborted','complete')),
      PRIMARY KEY(session_id, move_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS freeze_store_rosters (
      session_id TEXT NOT NULL, move_id TEXT NOT NULL, stores_json TEXT NOT NULL,
      PRIMARY KEY(session_id, move_id)
    )`);
    const columns = db.raw.pragma("table_info(freeze_journal)") as { name: string; type: string; pk: number }[];
    const intake = columns.find(column => column.name === "intercom_json");
    if (!intake) db.exec("ALTER TABLE freeze_journal ADD COLUMN intercom_json TEXT");
    else if (intake.type.toUpperCase() !== "TEXT" || intake.pk !== 0) throw new Error("Invalid freeze intercom layout");
    for (const [name, type, pk] of [["session_id", "TEXT", 1], ["move_id", "TEXT", 2], ["epoch", "INTEGER", 0], ["state", "TEXT", 0]] as const) {
      if (!columns.some(column => column.name === name && column.type.toUpperCase() === type && column.pk === pk))
        throw new Error("Invalid freeze journal layout");
    }
  }).immediate();
}

/** Freeze and operation progress share the same private journal file. */
export function openFreezeJournal(file: string): FreezeJournal {
  const journal = openJournal(file);
  withDatabase(file, migrateFreezeJournal);
  return {
    ...journal,
    readIntercomFence(sessionId, moveId) {
      freezeIdentity(sessionId, moveId);
      return withDatabase(file, db => {
        const row = db.prepare("SELECT epoch,intercom_json FROM freeze_journal WHERE session_id=? AND move_id=?").get(sessionId, moveId) as { epoch: number; intercom_json: string | null } | undefined;
        if (!row?.intercom_json) return null;
        const value: unknown = JSON.parse(row.intercom_json);
        if (!isIntercomIntakeFence(value) || value.address.sessionId !== sessionId || value.moveId !== moveId || value.expectedEpoch !== row.epoch)
          throw new Error("Invalid freeze intercom fence");
        return value;
      });
    },
    bindIntercomFence(fence) {
      if (!isIntercomIntakeFence(fence)) throw new Error("Invalid freeze intercom fence");
      freezeIdentity(fence.address.sessionId, fence.moveId, fence.expectedEpoch);
      withDatabase(file, db => db.raw.transaction(() => {
        const row = db.prepare("SELECT epoch,state,intercom_json FROM freeze_journal WHERE session_id=? AND move_id=?").get(fence.address.sessionId, fence.moveId) as { epoch: number; state: string; intercom_json: string | null } | undefined;
        if (!row || row.epoch !== fence.expectedEpoch) throw new Error("Freeze intercom identity changed");
        const encoded = JSON.stringify({ address: { sessionId: fence.address.sessionId, scopeId: fence.address.scopeId }, moveId: fence.moveId, expectedEpoch: fence.expectedEpoch, generation: fence.generation });
        if (row.intercom_json !== null && row.intercom_json !== encoded) throw new Error("Freeze intercom generation changed");
        if (row.intercom_json === null) {
          if (row.state !== "freezing") throw new Error("Freeze intercom fence unavailable");
          db.prepare("UPDATE freeze_journal SET intercom_json=? WHERE session_id=? AND move_id=?").run(encoded, fence.address.sessionId, fence.moveId);
        }
      }).immediate());
    },
    readFreeze(sessionId, moveId) {
      freezeIdentity(sessionId, moveId);
      return withDatabase(file, db => {
        const row = db.prepare("SELECT session_id,move_id,epoch,state FROM freeze_journal WHERE session_id=? AND move_id=?").get(sessionId, moveId) as FreezeRow | undefined;
        return row ? freezeProgress(row) : null;
      });
    },
    readFreezeRoster(sessionId, moveId) {
      freezeIdentity(sessionId, moveId);
      return withDatabase(file, db => {
        const row = db.prepare("SELECT stores_json FROM freeze_store_rosters WHERE session_id=? AND move_id=?").get(sessionId, moveId) as { stores_json: string } | undefined;
        return row ? parseFreezeRoster(row.stores_json) : null;
      });
    },
    bindFreezeRoster(sessionId, moveId, epoch, stores) {
      freezeIdentity(sessionId, moveId, epoch);
      const encoded = JSON.stringify(parseFreezeRoster(JSON.stringify(stores)));
      withDatabase(file, db => db.raw.transaction(() => {
        const row = db.prepare("SELECT session_id,move_id,epoch,state FROM freeze_journal WHERE session_id=? AND move_id=?").get(sessionId, moveId) as FreezeRow | undefined;
        if (!row || row.epoch !== epoch) throw new Error("Freeze roster identity does not match");
        const existing = db.prepare("SELECT stores_json FROM freeze_store_rosters WHERE session_id=? AND move_id=?").get(sessionId, moveId) as { stores_json: string } | undefined;
        if (existing) {
          if (JSON.stringify(parseFreezeRoster(existing.stores_json)) !== encoded) throw new Error("Freeze store roster changed");
        } else {
          if (row.state !== "freezing") throw new Error("Freeze store roster unavailable");
          db.prepare("INSERT INTO freeze_store_rosters(session_id,move_id,stores_json) VALUES (?,?,?)").run(sessionId, moveId, encoded);
        }
      }).immediate());
    },
    beginFreeze(sessionId, moveId, epoch) {
      freezeIdentity(sessionId, moveId, epoch);
      return withDatabase(file, db => db.raw.transaction(() => {
        const rows = (db.prepare("SELECT session_id,move_id,epoch,state FROM freeze_journal WHERE session_id=?").all(sessionId) as FreezeRow[]).map(freezeProgress);
        const previous = rows.find(row => row.moveId === moveId);
        if (previous) {
          if (previous.epoch !== epoch) throw new Error("Freeze epoch does not match");
          if (previous.state === "aborted") throw new Error("Freeze was cancelled");
          if (previous.state === "complete" || previous.state === "aborting") throw new Error("Freeze is no longer active");
          return previous;
        }
        if (rows.some(row => row.state !== "aborted" && row.state !== "complete")) throw new Error("Another freeze is unfinished");
        if (rows.some(row => row.epoch > epoch)) throw new Error("Stale freeze epoch");
        db.prepare("INSERT INTO freeze_journal(session_id,move_id,epoch,state) VALUES(?,?,?,'freezing')").run(sessionId, moveId, epoch);
        return { sessionId, moveId, epoch, state: "freezing" as const };
      }).immediate());
    },
    advanceFreeze(sessionId, moveId, epoch, state) {
      freezeIdentity(sessionId, moveId, epoch);
      if (!freezeStates.includes(state)) throw new Error("Invalid freeze state");
      return withDatabase(file, db => db.raw.transaction(() => {
        const row = db.prepare("SELECT session_id,move_id,epoch,state FROM freeze_journal WHERE session_id=? AND move_id=?").get(sessionId, moveId) as FreezeRow | undefined;
        if (!row) throw new Error("Freeze is unavailable");
        const current = freezeProgress(row);
        if (current.epoch !== epoch) throw new Error("Freeze epoch does not match");
        const allowed = current.state === state || current.state === "freezing" && (state === "frozen" || state === "aborting") ||
          current.state === "frozen" && (state === "aborting" || state === "complete") || current.state === "aborting" && state === "aborted";
        if (!allowed) throw new Error("Invalid freeze transition");
        if (current.state !== state) db.prepare("UPDATE freeze_journal SET state=? WHERE session_id=? AND move_id=?").run(state, sessionId, moveId);
        return { ...current, state };
      }).immediate());
    },
  };
}
