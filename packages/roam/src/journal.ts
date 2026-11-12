import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
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

/** A local operation journal. Each call closes its SQLite handle after commit. */
export function openJournal(file: string): Journal {
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
    `)).immediate();
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
        db.prepare("INSERT INTO roam_operations(operation_id, machine_id, expected_epoch, kind, digest) VALUES (?, ?, ?, ?, ?)")
          .run(operation.id, operation.machineId, operation.expectedEpoch, operation.kind, argumentsDigest);
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
        if (action === "done") db.prepare("UPDATE roam_operations SET result_json = ? WHERE operation_id = ?").run(encoded, id);
      }).immediate());
    },
    read(id) {
      return withDatabase(file, db => {
        const rows = db.prepare("SELECT action, result_json FROM roam_operation_actions WHERE operation_id = ? ORDER BY seq").all(id) as { action: string; result_json: string }[];
        return rows.map(row => ({ action: row.action, result: parseResult(row.result_json) }));
      });
    },
  };
}
