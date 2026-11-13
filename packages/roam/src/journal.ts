import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { assertTestConfigPath, openDb, withRetry } from "@spider/db-core";
import type { Db } from "@spider/db-core";
import type { JsonObject } from "@spider/db-core/roam/types";
import type { Journal, Operation } from "./contracts";
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
