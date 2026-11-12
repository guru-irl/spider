import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DESCRIPTORS } from "./descriptors";
import { assertHlc, validUnicode } from "./hlc";
import type { BatchArtifact, BatchHeader, Entity, RecordChange, Scope, StoreKey, ValidatedBatch } from "./types";

export const HARD_BATCH_BYTES: number = 16 * 1024 * 1024;
const MAX_SKEW_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEADER_KEYS = ["protocol", "schema", "batchId", "senderMachine", "senderStream", "storeKey", "after", "through", "count"];
const RECORD_KEYS = ["seq", "changeId", "entity", "rowKey", "op", "clock", "writerSession", "writerEpoch", "schema", "body"];
const CLOCK_KEYS = ["ms", "count", "machine", "stream"];

interface BodyShape { required: readonly string[]; integers: readonly string[]; reals?: readonly string[] }
const BODY_SHAPES: Readonly<Record<Entity, BodyShape>> = {
  global_memory: { required: ["uuid", "category", "content", "scope", "status", "source", "created_at"], integers: ["created_at", "updated_at"], reals: ["confidence"] },
  memory: { required: ["uuid", "category", "content", "status", "source", "created_at"], integers: ["created_at", "updated_at"], reals: ["confidence"] },
  sessions: { required: ["id", "started_at", "origin_machine"], integers: ["started_at", "ended_at"] },
  todos: { required: ["uuid", "session_id", "seq", "text", "done", "created_at"], integers: ["seq", "done", "created_at", "updated_at"] },
  runs: { required: ["id", "session_id", "agent", "status", "child_mode", "origin_machine"], integers: ["started_at", "ended_at", "step_count", "token_count"] },
  run_events: { required: ["uuid", "session_id", "ts", "type"], integers: ["ts"] },
  session_homes: { required: ["session_id", "machine_id", "epoch", "updated_at"], integers: ["epoch", "updated_at"] },
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function nonempty(value: unknown): value is string { return validUnicode(value) && value.length > 0; }
export function isRoamUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** JSON.parse accepts duplicate keys, including differently escaped spellings. */
function assertUniqueJsonKeys(line: string): void {
  const scopes: Array<Set<string> | null> = [];
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "{") scopes.push(new Set());
    else if (character === "[") scopes.push(null);
    else if (character === "}" || character === "]") scopes.pop();
    else if (character === '"') {
      let end = index + 1;
      for (;;) {
        end = line.indexOf('"', end);
        if (end < 0) throw new Error("Invalid roaming JSON string");
        let escapes = 0;
        for (let position = end - 1; position > index && line[position] === "\\"; position--) escapes++;
        if (escapes % 2 === 0) break;
        end++;
      }
      let next = end + 1;
      while (next < line.length && /\s/.test(line[next])) next++;
      if (line[next] === ":") {
        const keys = scopes.at(-1);
        if (!keys) throw new Error("Invalid roaming JSON object");
        const name = JSON.parse(line.slice(index, end + 1)) as string;
        if (keys.has(name)) throw new Error("Duplicate roaming JSON key");
        keys.add(name);
      }
      index = end;
    }
  }
}

function safeIntegerLiteral(source: string): boolean {
  const match = /^-?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return false;
  const fraction = match[2] ?? "";
  let digits = (match[1] + fraction).replace(/^0+/, "");
  if (!digits) return true;
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent)) return false;
  const scale = exponent - fraction.length;
  if (!Number.isSafeInteger(scale)) return false;
  if (scale < 0) {
    const trailing = -scale;
    if (trailing > digits.length || /[^0]/.test(digits.slice(-trailing))) return false;
    digits = digits.slice(0, -trailing);
  } else if (scale > 0) {
    if (digits.length + scale > 16) return false;
    digits += "0".repeat(scale);
  }
  return digits.length < 16 || (digits.length === 16 && digits <= "9007199254740991");
}

/** Parse numeric source text before JavaScript can round it into a valid integer. */
export function parseRoamJson(text: string): unknown {
  const parse = JSON.parse as unknown as (input: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
  const result = parse(text, (key, value, context) => {
    if (typeof value === "number" && key !== "confidence" &&
        (!context?.source || !safeIntegerLiteral(context.source))) throw new Error("Invalid roaming integer literal");
    return value;
  });
  assertUniqueJsonKeys(text);
  return result;
}

export function storeScope(key: unknown): Scope {
  if (!validUnicode(key)) throw new Error("Invalid roaming store key");
  if (key === "global") return "global";
  if (typeof key === "string" && key.startsWith("repo:") && key.length > 5) return "repo";
  if (typeof key === "string" && key.startsWith("worktree:")) {
    const rest = key.slice("worktree:".length);
    const separator = rest.lastIndexOf(":");
    if (separator > 0 && separator < rest.length - 1) return "worktree";
  }
  throw new Error("Invalid roaming store key");
}

export function assertBatchHeader(value: unknown): asserts value is BatchHeader {
  if (!object(value) || !exactKeys(value, HEADER_KEYS) || value.protocol !== 1 || value.schema !== 14 ||
      !nonempty(value.batchId) || !isRoamUuid(value.senderMachine) || !isRoamUuid(value.senderStream) ||
      !nonnegative(value.after) || !nonnegative(value.through) || !nonnegative(value.count) ||
      value.through < value.after || value.through - value.after !== value.count) {
    throw new Error("Invalid roaming batch header");
  }
  storeScope(value.storeKey);
}

/** Validate an entire row projection before it can reach an apply transaction. */
export function assertRecordChange(value: unknown, key: StoreKey): asserts value is RecordChange {
  if (!object(value) || !exactKeys(value, RECORD_KEYS) || !nonnegative(value.seq) || value.seq === 0 ||
      !nonempty(value.changeId) || !nonempty(value.rowKey) || value.schema !== 14 ||
      (value.op !== "put" && value.op !== "delete") || !nonempty(value.entity) ||
      !Object.prototype.hasOwnProperty.call(DESCRIPTORS, value.entity)) {
    throw new Error("Invalid roaming record envelope");
  }
  if (!object(value.clock) || !exactKeys(value.clock, CLOCK_KEYS)) throw new Error("Invalid roaming record clock");
  assertHlc(value.clock);
  if (!isRoamUuid(value.clock.machine) || !isRoamUuid(value.clock.stream)) throw new Error("Invalid roaming origin identity");
  const entity = value.entity as Entity;
  const descriptor = DESCRIPTORS[entity];
  if (descriptor.scope !== storeScope(key)) throw new Error("Roaming record belongs to another store");
  if (descriptor.sessionColumn === null) {
    if (value.writerSession !== null || value.writerEpoch !== null) throw new Error("Invalid roaming writer");
  } else if (!nonempty(value.writerSession) || !nonnegative(value.writerEpoch) || value.writerEpoch === 0) {
    throw new Error("Invalid roaming writer");
  }
  if (value.op === "delete") {
    if (value.body !== null) throw new Error("Invalid roaming delete body");
    return;
  }
  if (!object(value.body) || !exactKeys(value.body, descriptor.columns) || value.body[descriptor.key] !== value.rowKey ||
      (descriptor.sessionColumn !== null && value.body[descriptor.sessionColumn] !== value.writerSession)) {
    throw new Error("Invalid roaming row projection or key");
  }
  const shape = BODY_SHAPES[entity];
  for (const column of descriptor.columns) {
    const field = value.body[column];
    if (field === null) {
      if (shape.required.includes(column)) throw new Error("Invalid null roaming row field");
    } else if (shape.integers.includes(column)) {
      if (typeof field !== "number" || !Number.isSafeInteger(field)) throw new Error("Invalid roaming row integer");
    } else if (shape.reals?.includes(column)) {
      if (typeof field !== "number" || !Number.isFinite(field) || (Number.isInteger(field) && !Number.isSafeInteger(field))) {
        throw new Error("Invalid roaming row number");
      }
    } else if (!validUnicode(field)) throw new Error("Invalid roaming row field");
  }
  if ((entity === "sessions" || entity === "runs") && !isRoamUuid(value.body.origin_machine)) throw new Error("Invalid roaming row origin");
  if ((entity === "global_memory" || entity === "memory") && value.body.machine_id !== null && !isRoamUuid(value.body.machine_id)) {
    throw new Error("Invalid roaming memory machine");
  }
  if (entity === "session_homes") {
    if ((value.body.epoch as number) < 1) throw new Error("Invalid roaming home epoch");
    if (value.body.machine_id === "") {
      if (value.body.epoch !== 1 || value.body.move_id !== null) throw new Error("Invalid roaming home conflict marker");
    } else if (!isRoamUuid(value.body.machine_id)) throw new Error("Invalid roaming home machine");
  }
}

function owned(stat: Stats, mode: number, kind: "file" | "directory"): void {
  if ((typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (stat.mode & 0o7777) !== mode || !(kind === "file" ? stat.isFile() : stat.isDirectory())) {
    throw new Error(`Unsafe roaming ${kind}`);
  }
}

export function privateBatchDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  owned(lstatSync(path), 0o700, "directory");
}

/** Publish under a unique name so no exporter or validator shares a write target. */
export function writePrivateBatch(directory: string, bytes: Buffer): string {
  owned(lstatSync(directory), 0o700, "directory");
  const file = join(directory, `${randomUUID()}.ndjson`);
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    owned(fstatSync(fd), 0o600, "file");
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(file);
    throw error;
  }
  closeSync(fd);
  try {
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch (error) {
    unlinkSync(file);
    throw error;
  }
  return file;
}

function readPrivateBatch(file: string, length: number): Buffer {
  owned(lstatSync(dirname(file)), 0o700, "directory");
  owned(lstatSync(file), 0o600, "file");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    owned(stat, 0o600, "file");
    if (stat.size !== length) throw new Error("Roaming batch length does not match");
    const bytes = readFileSync(fd);
    if (bytes.length !== length) throw new Error("Roaming batch length does not match");
    return bytes;
  } finally { closeSync(fd); }
}

/** Check the whole artifact without opening or mutating a destination database. */
export async function validateBatch(
  artifact: BatchArtifact,
  expected: { storeKey: StoreKey; senderMachine: string; senderStream: string; now: number },
): Promise<ValidatedBatch> {
  if (!artifact || typeof artifact.file !== "string" || !artifact.file ||
      !nonnegative(artifact.byteLength) || artifact.byteLength === 0 || artifact.byteLength > HARD_BATCH_BYTES ||
      typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      !nonnegative(expected.now) || !nonempty(expected.senderMachine) || !nonempty(expected.senderStream)) {
    throw new Error("Invalid roaming batch manifest or size limit");
  }
  storeScope(expected.storeKey);
  assertBatchHeader(artifact.header);
  const bytes = readPrivateBatch(artifact.file, artifact.byteLength);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Roaming batch digest does not match");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("Invalid UTF-8 roaming batch"); }
  if (!text.endsWith("\n")) throw new Error("Incomplete roaming batch");
  const rows = text.slice(0, -1).split("\n");
  let header: unknown;
  try { header = parseRoamJson(rows[0]); } catch { throw new Error("Invalid roaming batch header JSON"); }
  assertBatchHeader(header);
  if (!isDeepStrictEqual(header, artifact.header) || header.storeKey !== expected.storeKey ||
      header.senderMachine !== expected.senderMachine || header.senderStream !== expected.senderStream ||
      rows.length - 1 !== header.count) {
    throw new Error("Roaming batch header or identity does not match");
  }
  const changes = new Set<string>();
  for (let index = 1; index < rows.length; index++) {
    let record: unknown;
    try { record = parseRoamJson(rows[index]); } catch { throw new Error("Invalid roaming record JSON"); }
    assertRecordChange(record, header.storeKey);
    if (record.seq !== header.after + index || changes.has(record.changeId)) throw new Error("Invalid roaming sequence or duplicate change");
    if (record.clock.ms > expected.now && record.clock.ms - expected.now > MAX_SKEW_MS) throw new Error("Remote roaming clock exceeds future skew limit");
    changes.add(record.changeId);
  }
  const file = writePrivateBatch(dirname(artifact.file), bytes);
  return Object.freeze({ file, byteLength: bytes.length, sha256: artifact.sha256, header: Object.freeze({ ...header }) }) as ValidatedBatch;
}
