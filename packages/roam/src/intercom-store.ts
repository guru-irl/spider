import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { assertTestConfigPath, openDb, openDbReadOnly, type Db } from "@spider/db-core";
import type { Home } from "@spider/db-core/roam/types";
import {
  addressKey, isMessageReceipt, isRemoteSessionInfo, isSessionAddress, isSessionEndpoint, receiptReleasesPayload, sameAddress,
  type ConsumptionEvidence, type FederationBlockers, type Message, type MessageReceipt, type SessionAddress, type SessionEndpoint,
} from "@spider/intercom/protocol";
import {
  INTERCOM_EXCHANGE_BYTES, INTERCOM_HOP_ALLOWANCE_MS, INTERCOM_PAYLOAD_MS, INTERCOM_QUEUE_BYTES, INTERCOM_QUEUE_MESSAGES,
  type IntercomAcceptance, type IntercomEdgeState, type IntercomFrame, type IntercomIdentity, type IntercomMessageFrame, type IntercomQueue,
  type IntercomPairResume, type IntercomReceiptFrame, type IntercomReceiptInput, type IntercomState, type IntercomStore, type IntercomStoreOptions, type OutboundMessage,
  type RebindProof, type RetainedIntercom,
} from "./intercom-contracts";
import { decodeFrame, encodeFrame, isIntercomPairResume, isRebindProof, makeMessageFrame } from "./intercom-codec";
import { isMachineId } from "./machine-id";

const unsafe = () => new Error("Unsafe intercom store path or symlink");
const schemaColumns: Readonly<Record<string, readonly string[]>> = {
  intercom_meta: ["id", "machine_id", "version", "last_clock"],
  intercom_messages: ["id", "from_key", "to_key", "digest", "pair_sequence", "ask_id", "identity_json", "is_ask", "ask_state"],
  intercom_copies: ["direction", "id", "endpoint_json", "peer", "payload_json", "payload_bytes", "state", "unknown_outcome", "deadline_at",
    "remaining_ms", "last_clock", "ack_kind", "sent_kind", "transmitted", "readiness", "attempt", "observed_attempt", "receipt_json", "reconciliation_json", "reconciliation_attempt",
    "pending_proof_json", "pending_proof_attempt"],
  intercom_cursors: ["direction", "from_key", "to_key", "sequence"],
  intercom_receipts: ["receipt_key", "id", "peer", "frame_json", "acknowledged", "sent"],
  intercom_resumptions: ["from_key", "to_key", "peer", "resume_json"],
  intercom_edge_state: ["peer", "edge_epoch", "state_json"],
};
const schemaKeys: Readonly<Record<string, readonly (readonly string[])[]>> = {
  intercom_messages: [["id"], ["from_key", "to_key", "pair_sequence"]],
  intercom_copies: [["direction", "id"]], intercom_cursors: [["direction", "from_key", "to_key"]],
  intercom_receipts: [["receipt_key"]], intercom_resumptions: [["from_key", "to_key"]],
  intercom_edge_state: [["peer", "edge_epoch"]],
};
function validateSchema(db: Db, tables: readonly { name: string }[], version: number): void {
  const names = new Set(tables.map(row => row.name));
  if (tables.some(row => !(row.name in schemaColumns)) || Object.keys(schemaColumns).some(name => name !== "intercom_edge_state" && !names.has(name)) ||
      (version === 2) !== names.has("intercom_edge_state")) {
    throw new Error("Invalid or incomplete intercom store schema");
  }
  for (const [table, expected] of Object.entries(schemaColumns)) {
    // Databases created by 3.6b acquire this additive table on their next open.
    if (table === "intercom_edge_state" && !names.has(table)) continue;
    const columns = db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(table) as { name: string }[];
    if (JSON.stringify(columns.map(column => column.name)) !== JSON.stringify(expected)) throw new Error("Invalid or incomplete intercom store schema");
    const required = schemaKeys[table] ?? [];
    const indexes = db.prepare("SELECT name FROM pragma_index_list(?) WHERE \"unique\"=1").all(table) as { name: string }[];
    const actual = indexes.map(index => (db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name) as { name: string }[]).map(column => column.name));
    if (required.some(key => !actual.some(columnsInIndex => JSON.stringify(columnsInIndex) === JSON.stringify(key)))) {
      throw new Error("Invalid intercom store identity constraints");
    }
  }
  for (const table of ["intercom_copies", "intercom_receipts"]) {
    const keys = db.prepare("SELECT \"table\",\"from\",\"to\" FROM pragma_foreign_key_list(?)").all(table) as { table: string; from: string; to: string }[];
    if (!keys.some(key => key.table === "intercom_messages" && key.from === "id" && key.to === "id")) throw new Error("Invalid intercom store identity constraints");
  }
}
function owned(stat: ReturnType<typeof fstatSync>): boolean {
  return process.platform === "win32" || typeof process.getuid !== "function" || stat.uid === process.getuid();
}
function prepareFile(file: string, machineId: string): void {
  if (!isAbsolute(file) || resolve(file) !== file) throw unsafe();
  assertTestConfigPath(file);
  const directory = dirname(file), root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe();
  }
  const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(dirFd);
    if (!stat.isDirectory() || !owned(stat)) throw unsafe();
  } finally { closeSync(dirFd); }
  let fd: number;
  try { fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw unsafe();
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw unsafe();
  } finally { closeSync(fd); }
  for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(sidecar); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || !owned(stat) || stat.nlink !== 1 ||
        process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) throw unsafe();
  }
  const probe = openDbReadOnly(file, { busyTimeoutMs: 1000 });
  if (!probe) throw unsafe();
  try {
    const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    if (tables.some(row => !row.name.startsWith("intercom_"))) throw new Error("Intercom store must use a separate database");
    if (tables.length && !tables.some(row => row.name === "intercom_meta")) throw new Error("Invalid intercom store metadata");
    if (tables.length) {
      const meta = probe.prepare("SELECT machine_id, version FROM intercom_meta WHERE id=1").get() as { machine_id: string; version: number } | undefined;
      if (!meta || meta.machine_id !== machineId) throw new Error("Intercom store machine identity mismatch");
      if (meta.version !== 1 && meta.version !== 2) throw new Error("Unsupported intercom store version");
      validateSchema(probe, tables, meta.version);
    }
  } finally { probe.close(); }
  if (process.platform !== "win32") {
    const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(directoryFd);
      if (!stat.isDirectory() || !owned(stat)) throw unsafe();
      if ((stat.mode & 0o7777) !== 0o700) fchmodSync(directoryFd, 0o700);
    } finally { closeSync(directoryFd); }
    const fileFd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fileFd);
      if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw unsafe();
      if ((stat.mode & 0o7777) !== 0o600) fchmodSync(fileFd, 0o600);
    } finally { closeSync(fileFd); }
  }
}

interface MetaRow { machine_id: string; version: number; last_clock: number }
interface IdentityRow {
  id: string; from_key: string; to_key: string; digest: string; pair_sequence: number; ask_id: string | null;
  identity_json: string; is_ask: number; ask_state: string;
}
interface CopyRow extends IdentityRow {
  direction: IntercomQueue; endpoint_json: string; peer: string; payload_json: string | null; payload_bytes: number;
  state: IntercomState; unknown_outcome: number; deadline_at: number; remaining_ms: number | null; last_clock: number;
  ack_kind: string | null; sent_kind: string | null; transmitted: number; readiness: string | null; attempt: number; observed_attempt: number; receipt_json: string | null;
  reconciliation_json: string | null; reconciliation_attempt: number | null; pending_proof_json: string | null; pending_proof_attempt: number | null;
}
interface ReceiptRow { peer: string; frame_json: string; receipt_key: string; acknowledged: number; sent: number }
const selectCopy = `SELECT c.*,m.from_key,m.to_key,m.digest,m.pair_sequence,m.ask_id,m.identity_json,m.is_ask,m.ask_state
  FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id`;

function parseStored<T>(value: string): T {
  try { return JSON.parse(value) as T; } catch { throw new Error("Invalid intercom store JSON"); }
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function safeInteger(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && Number(value) >= min; }
function readIdentity(row: IdentityRow): IntercomIdentity {
  const identity = parseStored<IntercomIdentity>(row.identity_json);
  if (!identity || !nonempty(identity.id) || !isSessionAddress(identity.from) || !isSessionAddress(identity.to) ||
      !/^[0-9a-f]{64}$/.test(identity.digest) || !safeInteger(identity.sequence, 1) ||
      !(identity.askId === null || nonempty(identity.askId)) || identity.id !== row.id || identity.digest !== row.digest ||
      identity.sequence !== row.pair_sequence || identity.askId !== row.ask_id ||
      addressKey(identity.from) !== row.from_key || addressKey(identity.to) !== row.to_key) throw new Error("Invalid intercom identity metadata");
  return identity;
}
function readEndpoint(row: CopyRow): SessionEndpoint {
  const endpoint = parseStored<SessionEndpoint>(row.endpoint_json);
  if (!isSessionEndpoint(endpoint) || !isMachineId(endpoint.machineId) || !sameAddress(endpoint.address, readIdentity(row).to)) {
    throw new Error("Invalid intercom endpoint metadata");
  }
  return endpoint;
}
function sameEndpoint(a: SessionEndpoint, b: SessionEndpoint): boolean {
  return sameAddress(a.address, b.address) && a.machineId === b.machineId && a.homeEpoch === b.homeEpoch && a.activationEpoch === b.activationEpoch;
}
function sameIdentity(a: IntercomIdentity, b: IntercomIdentity): boolean {
  return a.id === b.id && sameAddress(a.from, b.from) && sameAddress(a.to, b.to) && a.digest === b.digest &&
    a.sequence === b.sequence && a.askId === b.askId;
}
function validateResume(input: { cursor: IntercomPairResume; owner: Home | null }, frame: IntercomFrame): IntercomPairResume {
  const resume = input.cursor;
  if (!isIntercomPairResume(resume) || !sameAddress(resume.from, frame.identity.from) || !sameAddress(resume.to, frame.identity.to) ||
      !sameEndpoint(resume.endpoint, frame.endpoint)) throw new Error("Intercom pair resume proof mismatch");
  const expected = resume.proof.owner, owner = input.owner;
  if (expected === null ? owner !== null : !owner || owner.sessionId !== expected.sessionId || owner.machineId !== expected.machineId ||
      owner.epoch !== expected.epoch || owner.moveId !== expected.moveId || owner.updatedAt !== expected.updatedAt) {
    throw new Error("Intercom authoritative home proof mismatch");
  }
  return resume;
}
function plus(now: number, duration: number): number {
  const value = now + duration;
  if (!safeInteger(value)) throw new Error("Intercom clock overflow");
  return value;
}
function cleanEvidence(evidence: ConsumptionEvidence): ConsumptionEvidence {
  if (evidence.kind === "entry") return { kind: "entry", entryId: evidence.entryId, sessionId: evidence.sessionId, activationEpoch: evidence.activationEpoch };
  if (evidence.kind === "waiter") return { kind: "waiter", entryId: evidence.entryId, sessionId: evidence.sessionId, activationEpoch: evidence.activationEpoch, askId: evidence.askId };
  return { kind: "absence", sessionId: evidence.sessionId, activationEpoch: evidence.activationEpoch, excludedGeneration: evidence.excludedGeneration, complete: true };
}
function cleanReceipt(receipt: MessageReceipt): MessageReceipt {
  return { messageId: receipt.messageId, status: receipt.status, timestamp: receipt.timestamp,
    ...(receipt.evidence ? { evidence: cleanEvidence(receipt.evidence) } : {}) };
}
function cleanReceiptFrame(frame: IntercomReceiptInput): IntercomReceiptInput {
  return { from: { ...frame.from, address: { ...frame.from.address } }, to: { ...frame.to }, digest: frame.digest, receipt: cleanReceipt(frame.receipt),
    ...(frame.attempt !== undefined ? { attempt: frame.attempt } : {}) };
}
function receiptKey(frame: IntercomReceiptInput): string {
  return createHash("sha256").update(JSON.stringify([addressKey(frame.from.address), frame.from.machineId, frame.from.homeEpoch,
    frame.from.activationEpoch, addressKey(frame.to), frame.digest, frame.receipt.messageId, frame.receipt.status, frame.receipt.evidence ?? null, frame.attempt ?? 0])).digest("hex");
}
function currentKind(row: CopyRow): IntercomFrame["kind"] { return row.state === "expired" || row.state === "cancelled" ? "tombstone" : "message"; }
function frameFor(row: CopyRow, at: number): IntercomFrame {
  const identity = readIdentity(row), endpoint = readEndpoint(row);
  if (row.state === "expired" || row.state === "cancelled") return { kind: "tombstone", identity, endpoint, reason: row.state };
  if (row.payload_json === null) throw new Error("Intercom payload is unavailable");
  const message = parseStored<Message>(row.payload_json);
  if (row.is_ask && row.remaining_ms !== null) message.remainingMs = row.remaining_ms;
  const remainingPayloadMs = row.deadline_at - at;
  if (!safeInteger(remainingPayloadMs, 1)) throw new Error("Intercom payload expired");
  return decodeFrame(encodeFrame({ kind: "message", identity, endpoint, message, remainingPayloadMs }));
}

/** A machine-local store. The caller authenticates peers and supplies authoritative host proofs. */
export function openIntercomStore(options: IntercomStoreOptions): IntercomStore {
  if (!isMachineId(options.machineId) || !options.clock || typeof options.clock.now !== "function") throw new Error("Invalid intercom machine identity or clock");
  const queueMessages = options.limits?.queueMessages ?? INTERCOM_QUEUE_MESSAGES;
  const queueBytes = options.limits?.queueBytes ?? INTERCOM_QUEUE_BYTES;
  if (!safeInteger(queueMessages, 1) || queueMessages > INTERCOM_QUEUE_MESSAGES || !safeInteger(queueBytes, 1) || queueBytes > INTERCOM_QUEUE_BYTES) {
    throw new Error("Invalid intercom queue limits");
  }
  const now = (): number => {
    const value = options.clock.now();
    if (!safeInteger(value)) throw new Error("Invalid intercom clock");
    return value;
  };
  const firstNow = now();
  prepareFile(options.file, options.machineId);
  const db = openDb(options.file, { fileMustExist: true, checkpointOnClose: false, busyTimeoutMs: 1000 });
  let closed = false, checkpointPending = false;
  const checkpoint = (): void => {
    const result = db.raw.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
    if (result.some(row => row.busy !== 0)) throw new Error("Intercom WAL checkpoint busy");
    checkpointPending = false;
  };
  const checkpointDeletion = (): void => { checkpointPending = true; checkpoint(); };
  const ensureCheckpoint = (): void => { if (checkpointPending) checkpoint(); };
  try {
    db.pragma("synchronous = FULL");
    db.pragma("secure_delete = ON");
    db.raw.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS intercom_meta (
          id INTEGER PRIMARY KEY CHECK(id=1), machine_id TEXT NOT NULL, version INTEGER NOT NULL, last_clock INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intercom_messages (
          id TEXT PRIMARY KEY, from_key TEXT NOT NULL, to_key TEXT NOT NULL, digest TEXT NOT NULL,
          pair_sequence INTEGER NOT NULL, ask_id TEXT, identity_json TEXT NOT NULL,
          is_ask INTEGER NOT NULL, ask_state TEXT NOT NULL,
          UNIQUE(from_key,to_key,pair_sequence)
        );
        CREATE TABLE IF NOT EXISTS intercom_copies (
          direction TEXT NOT NULL, id TEXT NOT NULL REFERENCES intercom_messages(id), endpoint_json TEXT NOT NULL,
          peer TEXT NOT NULL, payload_json TEXT, payload_bytes INTEGER NOT NULL, state TEXT NOT NULL,
          unknown_outcome INTEGER NOT NULL DEFAULT 0, deadline_at INTEGER NOT NULL, remaining_ms INTEGER,
          last_clock INTEGER NOT NULL, ack_kind TEXT, sent_kind TEXT, transmitted INTEGER NOT NULL DEFAULT 0,
          readiness TEXT, attempt INTEGER NOT NULL DEFAULT 0, observed_attempt INTEGER NOT NULL DEFAULT 0,
          receipt_json TEXT, reconciliation_json TEXT, reconciliation_attempt INTEGER,
          pending_proof_json TEXT, pending_proof_attempt INTEGER, PRIMARY KEY(direction,id)
        );
        CREATE TABLE IF NOT EXISTS intercom_cursors (
          direction TEXT NOT NULL, from_key TEXT NOT NULL, to_key TEXT NOT NULL, sequence INTEGER NOT NULL,
          PRIMARY KEY(direction,from_key,to_key)
        );
        CREATE TABLE IF NOT EXISTS intercom_receipts (
          receipt_key TEXT PRIMARY KEY, id TEXT NOT NULL REFERENCES intercom_messages(id), peer TEXT NOT NULL,
          frame_json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS intercom_resumptions (
          from_key TEXT NOT NULL, to_key TEXT NOT NULL, peer TEXT NOT NULL, resume_json TEXT NOT NULL,
          PRIMARY KEY(from_key,to_key)
        );
        CREATE TABLE IF NOT EXISTS intercom_edge_state (
          peer TEXT NOT NULL, edge_epoch TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(peer,edge_epoch)
        );
        CREATE INDEX IF NOT EXISTS intercom_copy_peer ON intercom_copies(direction,peer,state);
        CREATE INDEX IF NOT EXISTS intercom_message_pair ON intercom_messages(from_key,to_key,pair_sequence);
        CREATE INDEX IF NOT EXISTS intercom_receipt_peer ON intercom_receipts(peer,acknowledged);
      `);
      db.prepare("INSERT OR IGNORE INTO intercom_meta(id,machine_id,version,last_clock) VALUES(1,?,2,?)").run(options.machineId, firstNow);
      const meta = db.prepare("SELECT machine_id,version,last_clock FROM intercom_meta WHERE id=1").get() as MetaRow;
      if (!meta || meta.machine_id !== options.machineId) throw new Error("Intercom store machine identity mismatch");
      if (meta.version !== 1 && meta.version !== 2 || !safeInteger(meta.last_clock)) throw new Error("Unsupported intercom store version");
      if (meta.version === 1) db.prepare("UPDATE intercom_meta SET version=2 WHERE id=1").run();
    }).immediate();
    checkpoint();
  } catch (error) { db.close(); throw error; }

  const copy = (direction: IntercomQueue, id: string): CopyRow | undefined =>
    db.prepare(`${selectCopy} WHERE c.direction=? AND c.id=?`).get(direction, id) as CopyRow | undefined;
  const identityRow = (id: string): IdentityRow | undefined =>
    db.prepare("SELECT * FROM intercom_messages WHERE id=?").get(id) as IdentityRow | undefined;
  const cursor = (direction: IntercomQueue, identity: IntercomIdentity): number => {
    const row = db.prepare("SELECT sequence FROM intercom_cursors WHERE direction=? AND from_key=? AND to_key=?")
      .get(direction, addressKey(identity.from), addressKey(identity.to)) as { sequence: number } | undefined;
    return row?.sequence ?? 0;
  };
  const writeCursor = (direction: IntercomQueue, identity: IntercomIdentity): void => {
    db.prepare(`INSERT INTO intercom_cursors(direction,from_key,to_key,sequence) VALUES(?,?,?,?)
      ON CONFLICT(direction,from_key,to_key) DO UPDATE SET sequence=excluded.sequence`)
      .run(direction, addressKey(identity.from), addressKey(identity.to), identity.sequence);
  };
  const acceptance = (): Extract<import("@spider/intercom/protocol").AcceptanceEvidence, { durable: true }> =>
    ({ accepted: true, durable: true, location: `intercom:${options.machineId}` });
  const accepted = (kind: "accepted" | "duplicate", identity: IntercomIdentity, row?: CopyRow): IntercomAcceptance => ({
    kind, identity, acceptance: acceptance(), ...(row?.receipt_json ? { receipt: parseStored<MessageReceipt>(row.receipt_json) } : {}),
  });
  const room = (to: SessionAddress, bytes: number): boolean => {
    const row = db.prepare(`SELECT count(*) AS count,coalesce(sum(c.payload_bytes),0) AS bytes
      FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id WHERE m.to_key=? AND c.payload_json IS NOT NULL`)
      .get(addressKey(to)) as { count: number; bytes: number };
    return row.count < queueMessages && row.bytes + bytes <= queueBytes;
  };
  const saveReceipt = (row: CopyRow, frame: IntercomReceiptInput): void => {
    const clean: IntercomReceiptFrame = { ...cleanReceiptFrame(frame), attempt: frame.attempt ?? row.attempt }, key = receiptKey(clean);
    db.prepare("INSERT OR IGNORE INTO intercom_receipts(receipt_key,id,peer,frame_json) VALUES(?,?,?,?)")
      .run(key, row.id, row.peer, JSON.stringify(clean));
  };
  const expireRow = (row: CopyRow, at: number): boolean => {
    if (row.payload_json === null || row.state === "injected" || row.state === "matched_waiter" || row.state === "expired") return false;
    const identity = readIdentity(row), endpoint = readEndpoint(row);
    const uncertain = row.unknown_outcome === 1 || row.state === "unknown" || row.direction === "outbound" && row.transmitted === 1;
    const expired: MessageReceipt = { messageId: identity.id, status: "expired", timestamp: at };
    db.prepare("UPDATE intercom_copies SET state='expired',payload_json=NULL,payload_bytes=0,unknown_outcome=?,receipt_json=? WHERE direction=? AND id=?")
      .run(uncertain ? 1 : 0, JSON.stringify(expired), row.direction, row.id);
    if (row.is_ask) db.prepare("UPDATE intercom_messages SET ask_state='expired' WHERE id=? AND ask_state='open'").run(row.id);
    if (row.direction === "inbound") saveReceipt(row, { from: endpoint, to: identity.from, digest: identity.digest, receipt: expired });
    return true;
  };
  const cancelRow = (row: CopyRow, at: number): void => {
    if (["injected", "matched_waiter", "answered", "expired", "cancelled"].includes(row.state)) return;
    const cancellation: MessageReceipt = { messageId: row.id, status: "cancelled", timestamp: at };
    db.prepare("UPDATE intercom_copies SET state='cancelled',unknown_outcome=?,receipt_json=? WHERE direction=? AND id=?")
      .run(row.unknown_outcome || row.transmitted || row.state === "unknown" ? 1 : 0, JSON.stringify(cancellation), row.direction, row.id);
    if (row.is_ask) db.prepare("UPDATE intercom_messages SET ask_state='cancelled' WHERE id=? AND ask_state='open'").run(row.id);
    if (row.direction === "inbound") saveReceipt(row, { from: readEndpoint(row), to: readIdentity(row).from, digest: row.digest, receipt: cancellation });
  };
  const expire = (): Array<{ queue: IntercomQueue; id: string }> => {
    ensureCheckpoint();
    const at = now();
    let deleted = false;
    const expired = db.raw.transaction(() => {
      const meta = db.prepare("SELECT machine_id,version,last_clock FROM intercom_meta WHERE id=1").get() as MetaRow;
      if (!meta || !safeInteger(meta.last_clock)) throw new Error("Invalid intercom clock metadata");
      const rolledBack = at < meta.last_clock;
      if (at !== meta.last_clock) db.prepare("UPDATE intercom_meta SET last_clock=? WHERE id=1").run(at);
      const result: Array<{ queue: IntercomQueue; id: string }> = [];
      const rows = db.prepare(`${selectCopy} WHERE (c.deadline_at<=? OR ?=1)
        AND (c.payload_json IS NOT NULL OR (m.is_ask=1 AND m.ask_state='open'))`).all(at, rolledBack ? 1 : 0) as CopyRow[];
      for (const row of rows) {
        if (row.is_ask) db.prepare("UPDATE intercom_messages SET ask_state='expired' WHERE id=? AND ask_state='open'").run(row.id);
        if (expireRow(row, at)) { deleted = true; result.push({ queue: row.direction, id: row.id }); }
      }
      return result;
    }).immediate();
    if (deleted) checkpointDeletion();
    return expired;
  };
  const insertIdentity = (identity: IntercomIdentity, isAsk: boolean, tombstone?: "expired" | "cancelled"): void => {
    const known = identityRow(identity.id);
    if (known) {
      if (!sameIdentity(readIdentity(known), identity)) throw new Error("Intercom message ID or digest conflict");
      return;
    }
    const collision = db.prepare("SELECT id FROM intercom_messages WHERE from_key=? AND to_key=? AND pair_sequence=?")
      .get(addressKey(identity.from), addressKey(identity.to), identity.sequence) as { id: string } | undefined;
    if (collision) throw new Error("Intercom pair sequence conflict");
    db.prepare(`INSERT INTO intercom_messages(id,from_key,to_key,digest,pair_sequence,ask_id,identity_json,is_ask,ask_state)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(identity.id, addressKey(identity.from), addressKey(identity.to), identity.digest, identity.sequence,
        identity.askId, JSON.stringify(identity), isAsk ? 1 : 0, isAsk ? tombstone ?? "open" : "none");
  };
  const insertCopy = (direction: IntercomQueue, frame: IntercomFrame, peer: string, at: number): void => {
    const message = frame.kind === "message" ? frame.message : null;
    const lifetime = frame.kind === "message" ? frame.remainingPayloadMs : INTERCOM_PAYLOAD_MS;
    const remaining = message?.expectsReply ? Math.min(message.remainingMs!, lifetime) : null;
    const deadline = plus(at, remaining ?? lifetime);
    const bytes = message ? encodeFrame(frame).byteLength : 0;
    db.prepare(`INSERT INTO intercom_copies(direction,id,endpoint_json,peer,payload_json,payload_bytes,state,deadline_at,remaining_ms,last_clock)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(direction, frame.identity.id, JSON.stringify(frame.endpoint), peer, message ? JSON.stringify(message) : null,
        bytes, frame.kind === "message" ? "queued" : frame.reason, deadline, remaining, at);
  };
  const tighten = (row: CopyRow, frame: IntercomMessageFrame, at: number): void => {
    if (row.payload_json === null || !["queued", "unknown"].includes(row.state)) return;
    let remaining = row.remaining_ms, deadline = Math.min(row.deadline_at, plus(at, frame.remainingPayloadMs));
    if (row.is_ask && remaining !== null && frame.message.remainingMs !== undefined) {
      remaining = Math.max(0, Math.min(remaining - Math.max(0, at - row.last_clock), frame.message.remainingMs));
      deadline = Math.min(deadline, plus(at, remaining));
    }
    db.prepare("UPDATE intercom_copies SET remaining_ms=?,last_clock=?,deadline_at=? WHERE direction=? AND id=?")
      .run(remaining, at, deadline, row.direction, row.id);
  };
  const validReceipt = (row: CopyRow, frame: IntercomReceiptInput): void => {
    const identity = readIdentity(row), endpoint = readEndpoint(row);
    if (!frame || !isSessionEndpoint(frame.from) || !sameEndpoint(frame.from, endpoint) || !isSessionAddress(frame.to) || !sameAddress(frame.to, identity.from)) {
      throw new Error("Intercom receipt route mismatch");
    }
    if (frame.digest !== identity.digest || !isMessageReceipt(frame.receipt) || frame.receipt.messageId !== identity.id || !safeInteger(frame.receipt.timestamp) ||
        frame.attempt !== undefined && !safeInteger(frame.attempt)) {
      throw new Error("Intercom receipt identity or digest mismatch");
    }
    const evidence = frame.receipt.evidence;
    if (evidence && (evidence.sessionId !== identity.to.sessionId || evidence.activationEpoch !== endpoint.activationEpoch)) {
      throw new Error("Intercom receipt evidence owner mismatch");
    }
    if (frame.receipt.status === "matched_waiter" && (!evidence || evidence.kind !== "waiter" || identity.askId === null || identity.askId === identity.id || evidence.askId !== identity.askId)) {
      throw new Error("Intercom waiter evidence ask mismatch");
    }
    if (frame.receipt.status === "injected" && (!evidence || evidence.kind !== "entry" || !receiptReleasesPayload(frame.receipt))) {
      throw new Error("Intercom injection evidence missing");
    }
    if (frame.receipt.status === "not_injected" && (!evidence || evidence.kind !== "absence" || evidence.excludedGeneration !== endpoint.activationEpoch || evidence.complete !== true)) {
      throw new Error("Intercom absence proof mismatch");
    }
    if (Buffer.byteLength(JSON.stringify(cleanReceiptFrame({ ...frame, attempt: frame.attempt ?? row.attempt })), "utf8") + 1 > INTERCOM_EXCHANGE_BYTES - 1024) {
      throw new Error("Intercom receipt size limit exceeded");
    }
  };
  const setReceipt = (row: CopyRow, rawFrame: IntercomReceiptInput): boolean => {
    validReceipt(row, rawFrame);
    const frame = cleanReceiptFrame(rawFrame), receipt = frame.receipt;
    const consumed = row.state === "injected" || row.state === "matched_waiter";
    if (consumed) {
      if (receipt.status === "injected" || receipt.status === "matched_waiter") {
        const previous = row.receipt_json ? parseStored<MessageReceipt>(row.receipt_json) : null;
        if (!previous || previous.status !== receipt.status || JSON.stringify(previous.evidence) !== JSON.stringify(receipt.evidence)) {
          throw new Error("Conflicting intercom consumption evidence");
        }
        return false;
      }
      if (!row.unknown_outcome || receipt.status !== "unknown" && receipt.status !== "not_injected") return false;
    }
    if (receipt.status === "unknown" || receipt.status === "not_injected") {
      const localOwner = row.direction === "inbound" && readEndpoint(row).machineId === options.machineId;
      const attempt = frame.attempt ?? (localOwner ? row.attempt : null);
      if (attempt === null) throw new Error("Intercom receipt attempt required");
      if (!safeInteger(row.observed_attempt) || localOwner && attempt !== row.attempt) throw new Error("Intercom receipt attempt mismatch");
      if (attempt < row.observed_attempt || row.reconciliation_attempt !== null && attempt <= row.reconciliation_attempt) return false;
      if (attempt > row.observed_attempt) db.prepare("UPDATE intercom_copies SET observed_attempt=? WHERE direction=? AND id=?")
        .run(attempt, row.direction, row.id);
      if (receipt.status === "not_injected") db.prepare("UPDATE intercom_copies SET pending_proof_json=?,pending_proof_attempt=? WHERE direction=? AND id=?")
        .run(JSON.stringify(receipt), attempt, row.direction, row.id);
    }
    if (consumed && (receipt.status === "unknown" || receipt.status === "not_injected")) {
      if (row.direction === "inbound") saveReceipt(row, frame);
      return false;
    }
    if ((row.state === "expired" || row.state === "cancelled") && receipt.status !== "injected" && receipt.status !== "matched_waiter" &&
        !(row.state === "cancelled" && receipt.status === "expired")) {
      if (receipt.status === "unknown" || receipt.status === "not_injected") {
        db.prepare("UPDATE intercom_copies SET unknown_outcome=1 WHERE direction=? AND id=?").run(row.direction, row.id);
        if (row.direction === "inbound") saveReceipt(row, frame);
      }
      return false;
    }
    let state: IntercomState = row.state, unknown = row.unknown_outcome, release = false;
    if (receipt.status === "injected" || receipt.status === "matched_waiter") {
      if (!receiptReleasesPayload(receipt)) throw new Error("Intercom consumption evidence missing");
      const localOwner = row.direction === "inbound" && readEndpoint(row).machineId === options.machineId;
      const attempt = frame.attempt ?? (localOwner ? row.attempt : null);
      if (row.unknown_outcome && attempt === null) throw new Error("Intercom consumption receipt attempt required");
      if (attempt !== null && attempt > row.observed_attempt) db.prepare("UPDATE intercom_copies SET observed_attempt=? WHERE direction=? AND id=?")
        .run(attempt, row.direction, row.id);
      state = receipt.status; unknown = row.unknown_outcome && attempt !== null && attempt < row.observed_attempt ? 1 : 0;
      release = row.payload_json !== null;
    } else if (receipt.status === "expired") {
      state = "expired"; release = row.payload_json !== null;
    } else if (receipt.status === "unknown" || receipt.status === "not_injected") {
      if (row.state !== "expired" && row.state !== "cancelled" && row.state !== "answered") state = "unknown";
      unknown = 1;
    } else if (receipt.status === "cancelled") {
      state = "cancelled";
      if (row.transmitted || row.unknown_outcome) unknown = 1;
    }
    db.prepare(`UPDATE intercom_copies SET state=?,unknown_outcome=?,receipt_json=?,
      payload_json=CASE WHEN ?=1 THEN NULL ELSE payload_json END,payload_bytes=CASE WHEN ?=1 THEN 0 ELSE payload_bytes END
      WHERE direction=? AND id=?`).run(state, unknown, JSON.stringify(receipt), release ? 1 : 0, release ? 1 : 0, row.direction, row.id);
    if ((receipt.status === "injected" || receipt.status === "matched_waiter") && !unknown) {
      db.prepare("UPDATE intercom_copies SET pending_proof_json=NULL,pending_proof_attempt=NULL WHERE direction=? AND id=?").run(row.direction, row.id);
    }
    if ((receipt.status === "expired" || receipt.status === "cancelled") && row.is_ask) {
      db.prepare("UPDATE intercom_messages SET ask_state=? WHERE id=? AND ask_state='open'").run(receipt.status, row.id);
    }
    if (receipt.status === "matched_waiter" && row.ask_id !== null) {
      const settled = db.prepare("UPDATE intercom_messages SET ask_state='settled' WHERE id=? AND from_key=? AND to_key=? AND ask_state='open'")
        .run(row.ask_id, addressKey(frame.from.address), addressKey(frame.to));
      if (settled.changes) db.prepare("UPDATE intercom_copies SET state='answered' WHERE id=? AND state IN ('queued','unknown','not_injected')")
        .run(row.ask_id);
    }
    if (row.direction === "inbound") saveReceipt(row, frame);
    return release;
  };

  const pending = ((input: { kind: "outbound"; peer: string; hopBudgetMs: number; maxBytes?: number; skipIds?: readonly string[] } | { kind: "inbound"; address: SessionAddress } | { kind: "receipts"; peer: string; maxBytes?: number }) => {
    ensureCheckpoint();
    if (input.kind === "receipts") {
      if (!isMachineId(input.peer) || input.maxBytes !== undefined && (!safeInteger(input.maxBytes) || input.maxBytes > INTERCOM_EXCHANGE_BYTES - 1024)) throw new Error("Invalid intercom peer or receipt budget");
      const budget = input.maxBytes ?? INTERCOM_EXCHANGE_BYTES - 1024;
      return db.raw.transaction(() => {
        const rows = db.prepare("SELECT receipt_key,frame_json FROM intercom_receipts WHERE peer=? AND acknowledged=0 ORDER BY rowid LIMIT 1024")
          .all(input.peer) as { receipt_key: string; frame_json: string }[];
        const frames: IntercomReceiptFrame[] = []; let bytes = 2;
        for (const row of rows) {
          const size = Buffer.byteLength(row.frame_json, "utf8") + 1;
          if (size > INTERCOM_EXCHANGE_BYTES - 1024) throw new Error("Intercom receipt size limit exceeded");
          if (bytes + size > budget) break;
          bytes += size; frames.push(parseStored<IntercomReceiptFrame>(row.frame_json));
          db.prepare("UPDATE intercom_receipts SET sent=1 WHERE receipt_key=?").run(row.receipt_key);
        }
        return frames;
      }).immediate();
    }
    expire();
    if (input.kind === "inbound") {
      if (!isSessionAddress(input.address)) throw new Error("Invalid intercom address");
      const rows = db.prepare(`${selectCopy} WHERE c.direction='inbound' AND m.to_key=? AND c.state='queued' AND c.payload_json IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM intercom_copies p JOIN intercom_messages q ON p.id=q.id
          WHERE p.direction='inbound' AND q.from_key=m.from_key AND q.to_key=m.to_key
            AND q.pair_sequence<m.pair_sequence AND p.state='queued' AND p.payload_json IS NOT NULL)
        ORDER BY m.from_key,m.pair_sequence`).all(addressKey(input.address)) as CopyRow[];
      return rows.filter(row => readEndpoint(row).machineId === options.machineId).map(readIdentity);
    }
    if (!isMachineId(input.peer) || !safeInteger(input.hopBudgetMs, 1) ||
        input.maxBytes !== undefined && (!safeInteger(input.maxBytes) || input.maxBytes > INTERCOM_EXCHANGE_BYTES - 1024) ||
        input.skipIds !== undefined && (!Array.isArray(input.skipIds) || !input.skipIds.every(nonempty))) throw new Error("Invalid intercom handoff budget or peer");
    const budget = input.maxBytes ?? INTERCOM_EXCHANGE_BYTES - 1024, skipped = new Set(input.skipIds ?? []);
    const at = now(); let deleted = false;
    const result = db.raw.transaction(() => {
      const rows = db.prepare(`${selectCopy} WHERE c.direction='outbound' AND c.peer=? AND (
        (c.state='queued' AND c.payload_json IS NOT NULL AND coalesce(c.ack_kind,'')!='message') OR
        (c.state IN ('expired','cancelled') AND coalesce(c.ack_kind,'')!='tombstone'))
        ORDER BY m.from_key,m.to_key,m.pair_sequence LIMIT 1024`).all(input.peer) as CopyRow[];
      const frames: IntercomFrame[] = [], blocked = new Set<string>(); let bytes = 0;
      for (const row of rows) {
        const pair = JSON.stringify([row.from_key, row.to_key]);
        if (blocked.has(pair)) continue;
        if (skipped.has(row.id)) { blocked.add(pair); continue; }
        let next = row, expires = false;
        if (row.state === "queued") {
          const lifetime = row.deadline_at - at - input.hopBudgetMs - INTERCOM_HOP_ALLOWANCE_MS;
          const elapsed = at < row.last_clock ? row.remaining_ms ?? 0 : at - row.last_clock;
          const remaining = row.is_ask && row.remaining_ms !== null ? row.remaining_ms - elapsed - input.hopBudgetMs - INTERCOM_HOP_ALLOWANCE_MS : null;
          if (lifetime <= 0 || remaining !== null && remaining <= 0) { next = { ...row, state: "expired" }; expires = true; }
          else next = { ...row, deadline_at: at + lifetime, remaining_ms: remaining, last_clock: at };
        }
        const frame = frameFor(next, at), size = encodeFrame(frame).byteLength + 1;
        if (bytes + size > budget) break;
        if (expires) { if (expireRow(row, at)) deleted = true; }
        else if (next !== row && row.is_ask) db.prepare("UPDATE intercom_copies SET remaining_ms=?,last_clock=?,deadline_at=? WHERE direction='outbound' AND id=?")
          .run(next.remaining_ms, at, next.deadline_at, row.id);
        bytes += size; frames.push(frame);
        db.prepare("UPDATE intercom_copies SET sent_kind=?,transmitted=CASE WHEN ?='message' THEN 1 ELSE transmitted END WHERE direction='outbound' AND id=?")
          .run(frame.kind, frame.kind, row.id);
      }
      return frames;
    }).immediate();
    if (deleted) checkpointDeletion();
    return result;
  }) as IntercomStore["pending"];

  const edgeKey = (peer: string, edgeEpoch: string): void => {
    if (!isMachineId(peer) || peer === options.machineId || !nonempty(edgeEpoch) || edgeEpoch.length > 256) throw new Error("Invalid intercom edge");
  };
  const validEdge = (value: unknown, peer: string, edgeEpoch: string): value is IntercomEdgeState => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const state = value as IntercomEdgeState;
    const fields = ["peer", "edgeEpoch", "outbound", "inbound", "status", "outageSince", "reason", "lastSuccess", "failures", "roster"];
    if (Object.keys(state).length !== fields.length || !fields.every(key => Object.hasOwn(state, key)) || state.peer !== peer || state.edgeEpoch !== edgeEpoch) return false;
    const counter = (item: unknown): item is { poll: number; push: number } => !!item && typeof item === "object" && !Array.isArray(item) &&
      Object.keys(item).length === 2 && safeInteger((item as { poll: unknown }).poll) && safeInteger((item as { push: unknown }).push);
    return counter(state.outbound) && counter(state.inbound) && ["unknown", "live", "recovering", "down"].includes(state.status) &&
      (state.outageSince === null || safeInteger(state.outageSince)) && (state.lastSuccess === null || safeInteger(state.lastSuccess)) &&
      (state.reason === null || typeof state.reason === "string" && /^[a-z0-9_-]{1,64}$/.test(state.reason)) && safeInteger(state.failures) &&
      Array.isArray(state.roster) && state.roster.every(entry => isRemoteSessionInfo(entry) && isMachineId(entry.machineId)) &&
      Buffer.byteLength(JSON.stringify(state)) <= INTERCOM_EXCHANGE_BYTES;
  };
  const edgeState = (peer: string, edgeEpoch: string): IntercomEdgeState => {
    edgeKey(peer, edgeEpoch);
    const row = db.prepare("SELECT state_json FROM intercom_edge_state WHERE peer=? AND edge_epoch=?").get(peer, edgeEpoch) as { state_json: string } | undefined;
    if (!row) return { peer, edgeEpoch, outbound: { poll: 0, push: 0 }, inbound: { poll: 0, push: 0 }, status: "unknown",
      outageSince: null, reason: null, lastSuccess: null, failures: 0, roster: [] };
    const state = parseStored<unknown>(row.state_json);
    if (!validEdge(state, peer, edgeEpoch)) throw new Error("Invalid intercom edge metadata");
    return state;
  };

  const store: IntercomStore = {
    edgeState,
    updateEdgeState(peer, edgeEpoch, change): IntercomEdgeState {
      edgeKey(peer, edgeEpoch);
      if (typeof change !== "function") throw new Error("Invalid intercom edge update");
      return db.raw.transaction(() => {
        const before = edgeState(peer, edgeEpoch), candidate = change(JSON.parse(JSON.stringify(before)) as IntercomEdgeState);
        if (!validEdge(candidate, peer, edgeEpoch) || candidate.outbound.poll < before.outbound.poll || candidate.outbound.push < before.outbound.push ||
            candidate.inbound.poll < before.inbound.poll || candidate.inbound.push < before.inbound.push) throw new Error("Invalid intercom edge update");
        db.prepare(`INSERT INTO intercom_edge_state(peer,edge_epoch,state_json) VALUES(?,?,?)
          ON CONFLICT(peer,edge_epoch) DO UPDATE SET state_json=excluded.state_json`).run(peer, edgeEpoch, JSON.stringify(candidate));
        return candidate;
      }).immediate();
    },
    acceptOutbound(input: OutboundMessage): IntercomAcceptance {
      if (!isMachineId(input.nextHop)) throw new Error("Invalid intercom peer");
      expire(); const at = now();
      let candidate: IntercomMessageFrame | IntercomFrame;
      try {
        candidate = "frame" in input ? decodeFrame(encodeFrame(input.frame))
          : makeMessageFrame({ from: input.from, endpoint: input.endpoint, sequence: 1, message: input.message });
        encodeFrame(candidate);
      } catch (error) {
        if (error instanceof Error && /size limit/.test(error.message)) return { kind: "refused", reason: "message-too-large" };
        throw error;
      }
      let deleted = false;
      const result = db.raw.transaction(() => {
        const known = identityRow(candidate.identity.id);
        if (known && !sameIdentity({ ...candidate.identity, sequence: known.pair_sequence }, readIdentity(known))) throw new Error("Intercom message ID or digest conflict");
        if (known && "frame" in input && !sameIdentity(candidate.identity, readIdentity(known))) throw new Error("Intercom message ID or sequence conflict");
        const prior = copy("outbound", candidate.identity.id);
        if (prior) {
          if (!sameEndpoint(readEndpoint(prior), candidate.endpoint) || prior.peer !== input.nextHop) throw new Error("Intercom message ID route conflict");
          if (candidate.kind === "message") tighten(prior, candidate, at);
          else if ("frame" in input) {
            const inbound = copy("inbound", candidate.identity.id);
            if (!inbound || !sameIdentity(readIdentity(inbound), candidate.identity) || !sameEndpoint(readEndpoint(inbound), candidate.endpoint)) {
              throw new Error("Intercom relay requires accepted inbox evidence");
            }
            if (candidate.reason === "cancelled") cancelRow(prior, at);
            else if (!["injected", "matched_waiter", "answered", "expired"].includes(prior.state)) deleted = expireRow(prior, at) || deleted;
          }
          return accepted("duplicate", readIdentity(prior), copy("outbound", candidate.identity.id));
        }
        if ("frame" in input) {
          const inbound = copy("inbound", candidate.identity.id);
          if (!inbound || !sameIdentity(readIdentity(inbound), candidate.identity) || !sameEndpoint(readEndpoint(inbound), candidate.endpoint)) {
            throw new Error("Intercom relay requires accepted inbox evidence");
          }
          if ((inbound.state === "expired" || inbound.state === "cancelled") && candidate.kind === "message") throw new Error("Intercom relay message is settled");
          if (candidate.kind === "message") {
            const lifetime = Math.min(candidate.remainingPayloadMs, inbound.deadline_at - at);
            if (lifetime <= 0) throw new Error("Intercom relay message expired");
            let message = candidate.message;
            if (inbound.is_ask && inbound.remaining_ms !== null && message.remainingMs !== undefined) {
              const remaining = Math.min(message.remainingMs, inbound.remaining_ms - Math.max(0, at - inbound.last_clock), lifetime);
              if (remaining <= 0) throw new Error("Intercom relay ask expired");
              message = { ...message, remainingMs: remaining };
            }
            candidate = { ...candidate, remainingPayloadMs: lifetime, message };
          }
        } else if (known) throw new Error("Intercom message ID already belongs to an inbox");
        const previous = db.prepare(`${selectCopy} WHERE c.direction='outbound' AND m.from_key=? AND m.to_key=?
          ORDER BY m.pair_sequence DESC LIMIT 1`).get(addressKey(candidate.identity.from), addressKey(candidate.identity.to)) as CopyRow | undefined;
        if (previous && !sameEndpoint(readEndpoint(previous), candidate.endpoint)) {
          const saved = db.prepare("SELECT peer,resume_json FROM intercom_resumptions WHERE from_key=? AND to_key=?")
            .get(addressKey(candidate.identity.from), addressKey(candidate.identity.to)) as { peer: string; resume_json: string } | undefined;
          const resume: unknown = saved ? parseStored<unknown>(saved.resume_json) : null;
          if (!saved || saved.peer !== input.nextHop || !isIntercomPairResume(resume) || !sameEndpoint(resume.endpoint, candidate.endpoint)) {
            throw new Error("Intercom route requires authoritative rebind proof");
          }
        }
        const seq = "frame" in input ? candidate.identity.sequence : cursor("outbound", candidate.identity) + 1;
        if (!safeInteger(seq, 1) || seq !== cursor("outbound", candidate.identity) + 1) throw new Error("Intercom outbound sequence gap");
        if (!("frame" in input)) candidate = makeMessageFrame({ from: input.from, endpoint: input.endpoint, sequence: seq, message: input.message });
        const bytes = candidate.kind === "message" ? encodeFrame(candidate).byteLength : 0;
        if (candidate.kind === "message" && !room(candidate.identity.to, bytes)) return { kind: "refused", reason: "queue-full" } as const;
        insertIdentity(candidate.identity, candidate.kind === "message" ? candidate.message.expectsReply === true : candidate.identity.askId === candidate.identity.id,
          candidate.kind === "tombstone" ? candidate.reason : undefined);
        insertCopy("outbound", candidate, input.nextHop, at); writeCursor("outbound", candidate.identity);
        return accepted("accepted", candidate.identity);
      }).immediate();
      if (deleted) checkpointDeletion();
      return result;
    },
    acceptInbound(input): IntercomAcceptance {
      if (!isMachineId(input.peer)) throw new Error("Invalid intercom peer");
      expire(); const at = now();
      let frame: IntercomFrame;
      try { frame = decodeFrame(encodeFrame(input.frame)); } catch (error) {
        if (error instanceof Error && /size limit/.test(error.message)) return { kind: "refused", reason: "message-too-large" };
        throw error;
      }
      let deleted = false;
      const result = db.raw.transaction(() => {
        const known = identityRow(frame.identity.id);
        if (known && !sameIdentity(readIdentity(known), frame.identity)) throw new Error("Intercom message ID or digest conflict");
        let prior = copy("inbound", frame.identity.id);
        if (prior) {
          const oldEndpoint = readEndpoint(prior);
          if (prior.peer !== input.peer || !sameEndpoint(oldEndpoint, frame.endpoint)) {
            if (!input.resume || sameEndpoint(oldEndpoint, frame.endpoint)) throw new Error("Intercom inbox route mismatch");
            validateResume(input.resume, frame);
            if (prior.state !== "queued" || prior.unknown_outcome || prior.payload_json === null) throw new Error("Intercom inbox rebind lacks non-injection proof");
            if (prior.readiness !== null) {
              const priorReceipt = prior.reconciliation_json ? parseStored<MessageReceipt>(prior.reconciliation_json) : null;
              const evidence = priorReceipt?.evidence;
              if (!priorReceipt || !isMessageReceipt(priorReceipt) || priorReceipt.status !== "not_injected" || evidence?.kind !== "absence" ||
                  evidence.sessionId !== oldEndpoint.address.sessionId || evidence.activationEpoch !== oldEndpoint.activationEpoch ||
                  evidence.excludedGeneration !== oldEndpoint.activationEpoch || evidence.complete !== true) {
                throw new Error("Intercom inbox rebind lacks old-generation exclusion");
              }
            }
            if (db.prepare("SELECT 1 FROM intercom_receipts WHERE id=? AND acknowledged=0 LIMIT 1").get(prior.id)) {
              throw new Error("Intercom inbox rebind has unobserved receipts");
            }
            db.prepare(`UPDATE intercom_copies SET endpoint_json=?,peer=?,readiness=NULL,attempt=0,observed_attempt=0,
              receipt_json=NULL,reconciliation_attempt=NULL,pending_proof_json=NULL,pending_proof_attempt=NULL WHERE direction='inbound' AND id=?`)
              .run(JSON.stringify(frame.endpoint), input.peer, prior.id);
            prior = copy("inbound", frame.identity.id)!;
          }
          if (frame.kind === "message") tighten(prior, frame, at);
          else if (prior.state !== "injected" && prior.state !== "matched_waiter" && prior.state !== "expired") {
            if (frame.reason === "expired") deleted = expireRow(prior, at) || deleted;
            else if (prior.state !== "cancelled") {
              const cancellation: MessageReceipt = { messageId: prior.id, status: "cancelled", timestamp: at };
              db.prepare("UPDATE intercom_copies SET state='cancelled',unknown_outcome=?,receipt_json=? WHERE direction='inbound' AND id=?")
                .run(prior.unknown_outcome || prior.state === "unknown" ? 1 : 0, JSON.stringify(cancellation), prior.id);
              if (prior.is_ask) db.prepare("UPDATE intercom_messages SET ask_state='cancelled' WHERE id=? AND ask_state='open'").run(prior.id);
              saveReceipt(prior, { from: readEndpoint(prior), to: frame.identity.from, digest: frame.identity.digest, receipt: cancellation });
            }
          }
          return accepted("duplicate", frame.identity, copy("inbound", frame.identity.id));
        }
        const previous = cursor("inbound", frame.identity);
        if (frame.identity.sequence !== previous + 1) {
          if (!input.resume) throw new Error("Intercom inbound sequence gap");
          const resume = validateResume(input.resume, frame);
          if (resume.through !== frame.identity.sequence - 1 || resume.through < previous) throw new Error("Intercom inbound sequence gap");
          const unfinished = db.prepare(`SELECT 1 FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id
            WHERE c.direction='inbound' AND m.from_key=? AND m.to_key=? AND
              (c.unknown_outcome=1 OR c.state IN ('queued','unknown','not_injected')) LIMIT 1`)
            .get(addressKey(resume.from), addressKey(resume.to));
          const unobserved = db.prepare(`SELECT 1 FROM intercom_receipts r JOIN intercom_messages m ON m.id=r.id
            WHERE r.acknowledged=0 AND m.from_key=? AND m.to_key=? LIMIT 1`)
            .get(addressKey(resume.from), addressKey(resume.to));
          if (unfinished || unobserved) throw new Error("Intercom pair resume has unresolved evidence");
        }
        const bytes = frame.kind === "message" ? encodeFrame(frame).byteLength : 0;
        if (frame.kind === "message" && !room(frame.identity.to, bytes)) return { kind: "refused", reason: "queue-full" } as const;
        insertIdentity(frame.identity, frame.kind === "message" ? frame.message.expectsReply === true : frame.identity.askId === frame.identity.id,
          frame.kind === "tombstone" ? frame.reason : undefined);
        insertCopy("inbound", frame, input.peer, at); writeCursor("inbound", frame.identity);
        if (frame.kind === "tombstone") {
          const received = copy("inbound", frame.identity.id)!;
          const terminal: MessageReceipt = { messageId: frame.identity.id, status: frame.reason, timestamp: at };
          db.prepare("UPDATE intercom_copies SET receipt_json=? WHERE direction='inbound' AND id=?").run(JSON.stringify(terminal), frame.identity.id);
          saveReceipt(received, { from: frame.endpoint, to: frame.identity.from, digest: frame.identity.digest, receipt: terminal });
        }
        return accepted("accepted", frame.identity);
      }).immediate();
      if (deleted) checkpointDeletion();
      return result;
    },
    outboundResumptions(peer): readonly IntercomPairResume[] {
      ensureCheckpoint();
      if (!isMachineId(peer)) throw new Error("Invalid intercom peer");
      return (db.prepare("SELECT resume_json FROM intercom_resumptions WHERE peer=? ORDER BY from_key,to_key").all(peer) as { resume_json: string }[])
        .map(row => {
          const value: unknown = parseStored<unknown>(row.resume_json);
          if (!isIntercomPairResume(value)) throw new Error("Invalid intercom pair resume metadata");
          return value;
        });
    },
    pending,
    acknowledge(input): void {
      ensureCheckpoint();
      if (!isMachineId(input.peer) || !input.identity || !nonempty(input.identity.id) || (input.kind !== "message" && input.kind !== "tombstone")) throw new Error("Invalid intercom acknowledgement");
      db.raw.transaction(() => {
        const row = copy("outbound", input.identity.id);
        if (!row || !sameIdentity(readIdentity(row), input.identity)) throw new Error("Intercom acknowledgement identity mismatch");
        if (row.peer !== input.peer) throw new Error("Intercom acknowledgement peer mismatch");
        if (currentKind(row) !== input.kind) return;
        if (row.sent_kind !== input.kind) throw new Error("Intercom acknowledgement has no matching handoff");
        db.prepare("UPDATE intercom_copies SET ack_kind=? WHERE direction='outbound' AND id=?").run(input.kind, row.id);
      }).immediate();
    },
    acknowledgeReceipt(input): void {
      ensureCheckpoint();
      if (!isMachineId(input.peer)) throw new Error("Invalid intercom peer");
      const row = copy("inbound", input.frame.receipt.messageId);
      if (!row || row.peer !== input.peer) throw new Error("Intercom receipt peer mismatch");
      validReceipt(row, input.frame);
      const key = receiptKey(cleanReceiptFrame(input.frame));
      const receiptRow = db.prepare("SELECT peer,frame_json,receipt_key,acknowledged,sent FROM intercom_receipts WHERE receipt_key=?").get(key) as ReceiptRow | undefined;
      if (!receiptRow || receiptRow.peer !== input.peer || !receiptRow.sent) throw new Error("Intercom receipt acknowledgement has no matching handoff");
      db.prepare("UPDATE intercom_receipts SET acknowledged=1 WHERE receipt_key=?").run(key);
    },
    beginDispatch(input): IntercomMessageFrame {
      if (!nonempty(input.id) || !nonempty(input.readiness) || !isSessionEndpoint(input.endpoint)) throw new Error("Invalid intercom dispatch");
      expire(); const at = now();
      return db.raw.transaction(() => {
        let row = copy("inbound", input.id);
        if (!row || row.state !== "queued" || row.payload_json === null || row.unknown_outcome) throw new Error("Intercom dispatch is not ready");
        if (readEndpoint(row).machineId !== options.machineId || !sameEndpoint(readEndpoint(row), input.endpoint)) throw new Error("Intercom dispatch endpoint or machine mismatch");
        if (row.readiness === input.readiness) throw new Error("Intercom retry needs a new readiness transition");
        const blocking = db.prepare(`${selectCopy} WHERE c.direction='inbound' AND m.from_key=? AND m.to_key=?
          AND m.pair_sequence<? AND c.state='queued' AND c.payload_json IS NOT NULL LIMIT 1`)
          .get(row.from_key, row.to_key, row.pair_sequence) as CopyRow | undefined;
        if (blocking) throw new Error("Intercom dispatch sequence blocked");
        if (row.is_ask && row.remaining_ms !== null) {
          const remaining = Math.min(row.remaining_ms - Math.max(0, at - row.last_clock), row.deadline_at - at);
          if (remaining <= 0) throw new Error("Intercom ask expired before dispatch");
          db.prepare("UPDATE intercom_copies SET remaining_ms=?,last_clock=? WHERE direction='inbound' AND id=?").run(remaining, at, row.id);
          row = { ...row, remaining_ms: remaining, last_clock: at };
        }
        const frame = frameFor(row, at);
        if (frame.kind !== "message") throw new Error("Intercom payload is not dispatchable");
        if (!safeInteger(row.attempt) || row.attempt === Number.MAX_SAFE_INTEGER) throw new Error("Intercom dispatch attempt overflow");
        db.prepare("UPDATE intercom_copies SET state='unknown',unknown_outcome=1,readiness=?,attempt=?,observed_attempt=? WHERE direction='inbound' AND id=?")
          .run(input.readiness, row.attempt + 1, row.attempt + 1, input.id);
        return frame;
      }).immediate();
    },
    settleReceipt(input): void {
      ensureCheckpoint();
      if (!isMachineId(input.peer)) throw new Error("Invalid intercom receipt peer");
      let deleted = false;
      db.raw.transaction(() => {
        const row = copy(input.queue, input.frame.receipt.messageId);
        if (!row || row.peer !== input.peer) throw new Error("Intercom receipt peer or route mismatch");
        deleted = setReceipt(row, input.frame);
      }).immediate();
      if (deleted) checkpointDeletion();
    },
    resolveUnknown(input): void {
      if (!nonempty(input.id) || !/^[0-9a-f]{64}$/.test(input.digest)) throw new Error("Invalid intercom recovery identity");
      expire();
      const row = copy(input.queue, input.id);
      if (!row || row.digest !== input.digest) throw new Error("Intercom recovery identity or digest mismatch");
      validReceipt(row, input.proof);
      const receipt = input.proof.receipt;
      if (receipt.status === "injected" || receipt.status === "matched_waiter") {
        store.settleReceipt({ queue: input.queue, peer: row.peer, frame: input.proof }); return;
      }
      if (receipt.status !== "not_injected" || receipt.evidence?.kind !== "absence" || receipt.evidence.complete !== true ||
          receipt.evidence.excludedGeneration !== readEndpoint(row).activationEpoch) throw new Error("Intercom absence proof required");
      db.raw.transaction(() => {
        const current = copy(input.queue, input.id);
        if (!current || current.digest !== input.digest) throw new Error("Intercom recovery identity mismatch");
        validReceipt(current, input.proof);
        const consumed = current.state === "injected" || current.state === "matched_waiter";
        if (consumed && !current.unknown_outcome) throw new Error("Intercom delivery already settled with consumption evidence");
        const localOwner = input.queue === "inbound" && readEndpoint(current).machineId === options.machineId;
        if (!safeInteger(current.observed_attempt) || !safeInteger(current.attempt)) throw new Error("Invalid intercom attempt metadata");
        const attempt = input.proof.attempt ?? (localOwner ? current.attempt : null);
        if (attempt === null) throw new Error("Intercom absence proof attempt required");
        if (attempt < current.observed_attempt || current.reconciliation_attempt !== null && attempt <= current.reconciliation_attempt) {
          throw new Error("Stale intercom absence proof attempt");
        }
        if (localOwner && attempt !== current.attempt) throw new Error("Intercom absence proof attempt mismatch");
        if (!current.unknown_outcome && !current.transmitted && current.state !== "unknown") throw new Error("Intercom dispatch has no uncertain outcome");
        const state = consumed || current.state === "expired" || current.state === "cancelled" ? current.state
          : current.is_ask && current.ask_state === "settled" ? "answered" : "queued";
        const evidence = JSON.stringify(cleanReceipt(receipt));
        const prior = consumed || state === "expired" || state === "cancelled" ? current.receipt_json : evidence;
        db.prepare("UPDATE intercom_copies SET state=?,unknown_outcome=0,transmitted=0,ack_kind=NULL,sent_kind=NULL,receipt_json=?,reconciliation_json=?,reconciliation_attempt=?,observed_attempt=?,pending_proof_json=NULL,pending_proof_attempt=NULL WHERE direction=? AND id=?")
          .run(state, prior, evidence, attempt, attempt, input.queue, input.id);
        if (input.queue === "inbound") saveReceipt(current, input.proof);
      }).immediate();
    },
    cancel(input): void {
      ensureCheckpoint();
      if (!isSessionAddress(input.from) || !isSessionAddress(input.to)) throw new Error("Invalid intercom cancellation route");
      const at = now();
      db.raw.transaction(() => {
        const row = copy(input.queue, input.id);
        if (!row || !sameAddress(readIdentity(row).from, input.from) || !sameAddress(readIdentity(row).to, input.to)) throw new Error("Intercom cancellation route mismatch");
        cancelRow(row, at);
      }).immediate();
    },
    expire,
    nextExpiry(): number | null {
      ensureCheckpoint();
      const row = db.prepare(`SELECT min(c.deadline_at) AS deadline FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id
        WHERE c.payload_json IS NOT NULL OR (m.is_ask=1 AND m.ask_state='open')`).get() as { deadline: number | null };
      if (row.deadline !== null && !safeInteger(row.deadline)) throw new Error("Invalid intercom deadline metadata");
      return row.deadline;
    },
    hasPending(peer): boolean {
      if (!isMachineId(peer)) throw new Error("Invalid intercom peer");
      expire();
      const row = db.prepare(`SELECT EXISTS(SELECT 1 FROM intercom_copies WHERE direction='outbound' AND peer=? AND
        ((state='queued' AND payload_json IS NOT NULL AND coalesce(ack_kind,'')!='message') OR
         (state IN ('expired','cancelled') AND coalesce(ack_kind,'')!='tombstone'))) OR
        EXISTS(SELECT 1 FROM intercom_receipts WHERE peer=? AND acknowledged=0) AS pending`).get(peer, peer) as { pending: number };
      return row.pending === 1;
    },
    openAsks(peer): readonly RetainedIntercom[] {
      if (!isMachineId(peer)) throw new Error("Invalid intercom peer");
      expire();
      const rows = db.prepare(`SELECT c.id FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id
        WHERE c.direction='outbound' AND c.peer=? AND m.is_ask=1 AND m.ask_state='open' ORDER BY c.id`).all(peer) as { id: string }[];
      return rows.map(row => store.retained("outbound", row.id)).filter((row): row is RetainedIntercom => row !== null);
    },
    expiredOutbounds(peer) {
      if (!isMachineId(peer)) throw new Error("Invalid intercom peer");
      const rows = db.prepare(`${selectCopy} WHERE c.direction='outbound' AND c.peer=? AND c.state='expired'
        AND NOT EXISTS (SELECT 1 FROM intercom_copies i WHERE i.direction='inbound' AND i.id=c.id) ORDER BY c.id`).all(peer) as CopyRow[];
      return rows.map(row => ({ identity: readIdentity(row), outcomeKnown: row.unknown_outcome === 0 }));
    },
    inspectBlockers(address): FederationBlockers {
      ensureCheckpoint();
      if (!isSessionAddress(address)) throw new Error("Invalid intercom address");
      const key = addressKey(address);
      const rows = db.prepare(`${selectCopy} WHERE m.from_key=? OR m.to_key=? ORDER BY m.from_key,m.to_key,m.pair_sequence,c.direction`).all(key, key) as CopyRow[];
      const asks = new Map<string, FederationBlockers["asks"][number]>(), pendingIds = new Set<string>(), unknownIds = new Set<string>(), receiptIds = new Set<string>();
      for (const row of rows) {
        const identity = readIdentity(row);
        if (row.is_ask && row.ask_state === "open") asks.set(row.id, { id: row.id, from: identity.from, to: identity.to });
        if (row.state === "queued" && row.payload_json !== null && (row.direction === "inbound" || row.ack_kind !== "message")) pendingIds.add(row.id);
        if (row.unknown_outcome) unknownIds.add(row.id);
        if (row.direction === "outbound" && row.state === "queued" && row.ack_kind === "message") receiptIds.add(row.id);
      }
      const receipts = db.prepare(`SELECT DISTINCT r.id FROM intercom_receipts r JOIN intercom_messages m ON m.id=r.id
        WHERE r.acknowledged=0 AND (m.from_key=? OR m.to_key=?) ORDER BY r.id`).all(key, key) as { id: string }[];
      for (const row of receipts) receiptIds.add(row.id);
      return { asks: [...asks.values()], pendingDispatch: [...pendingIds], unknownOutcomes: [...unknownIds], unobservedReceipts: [...receiptIds] };
    },
    rebindUndispatched(address: SessionAddress, endpoint: SessionEndpoint, proof: RebindProof): number {
      ensureCheckpoint();
      if (!isSessionAddress(address) || !isSessionEndpoint(endpoint) || !isMachineId(endpoint.machineId) || !sameAddress(address, endpoint.address) ||
          !isRebindProof(proof, address, endpoint)) throw new Error("Invalid intercom rebind proof");
      const at = now();
      return db.raw.transaction(() => {
        const all = db.prepare(`${selectCopy} WHERE m.to_key=?`).all(addressKey(address)) as CopyRow[];
        if (all.some(row => row.unknown_outcome || row.state === "unknown")) throw new Error("Unknown intercom dispatch blocks rebind");
        const rows = all.filter(row => row.direction === "outbound");
        if (rows.some(row => row.state === "queued" && row.payload_json === null)) throw new Error("Invalid intercom queue metadata");
        const candidates = rows.filter(row => row.state === "queued" ||
          (row.state === "expired" || row.state === "cancelled") && row.ack_kind !== "tombstone");
        for (const row of candidates) {
          if (!sameEndpoint(readEndpoint(row), proof.exclusion.owner)) throw new Error("Intercom excluded generation proof mismatch");
          if (row.transmitted || row.ack_kind === "message") throw new Error("Intercom dispatch lacks proof of non-injection");
          encodeFrame(frameFor({ ...row, endpoint_json: JSON.stringify(endpoint), deadline_at: plus(at, INTERCOM_PAYLOAD_MS) }, at));
        }
        const pairs = new Map<string, { identity: IntercomIdentity; last: number; firstPending: number | null }>();
        for (const row of rows) {
          const current = pairs.get(row.from_key), identity = readIdentity(row);
          const pendingSequence = candidates.includes(row) ? row.pair_sequence : null;
          if (!current) pairs.set(row.from_key, { identity, last: row.pair_sequence, firstPending: pendingSequence });
          else {
            current.last = Math.max(current.last, row.pair_sequence);
            if (pendingSequence !== null) current.firstPending = current.firstPending === null ? pendingSequence : Math.min(current.firstPending, pendingSequence);
          }
        }
        for (const { identity, last, firstPending } of pairs.values()) {
          const resume: IntercomPairResume = { from: identity.from, to: identity.to, through: firstPending === null ? last : firstPending - 1, endpoint, proof };
          if (Buffer.byteLength(JSON.stringify(resume), "utf8") + 1 > INTERCOM_EXCHANGE_BYTES - 1024) throw new Error("Intercom resume size limit exceeded");
          db.prepare(`INSERT INTO intercom_resumptions(from_key,to_key,peer,resume_json) VALUES(?,?,?,?)
            ON CONFLICT(from_key,to_key) DO UPDATE SET peer=excluded.peer,resume_json=excluded.resume_json`)
            .run(addressKey(identity.from), addressKey(identity.to), proof.nextHop, JSON.stringify(resume));
        }
        for (const row of candidates) db.prepare("UPDATE intercom_copies SET endpoint_json=?,peer=?,ack_kind=NULL,sent_kind=NULL,reconciliation_attempt=NULL,observed_attempt=0 WHERE direction='outbound' AND id=?")
          .run(JSON.stringify(endpoint), proof.nextHop, row.id);
        return candidates.length;
      }).immediate();
    },
    retained(queue: IntercomQueue, id: string): RetainedIntercom | null {
      ensureCheckpoint();
      const row = copy(queue, id);
      if (!row) return null;
      const identity = readIdentity(row), endpoint = readEndpoint(row);
      if (!safeInteger(row.observed_attempt)) throw new Error("Invalid intercom attempt metadata");
      let pendingProof: IntercomReceiptFrame | undefined;
      if (row.pending_proof_json) {
        if (!safeInteger(row.pending_proof_attempt)) throw new Error("Invalid intercom absence proof attempt");
        pendingProof = { from: endpoint, to: identity.from, digest: identity.digest,
          receipt: parseStored<MessageReceipt>(row.pending_proof_json), attempt: row.pending_proof_attempt };
      }
      return { identity, endpoint, peer: row.peer, state: row.state, payloadRetained: row.payload_json !== null,
        linkAcknowledged: row.ack_kind === currentKind(row), latestAttempt: row.observed_attempt,
        ...(row.reconciliation_json ? { reconciliation: parseStored<MessageReceipt>(row.reconciliation_json) } : {}),
        ...(pendingProof ? { pendingProof } : {}) };
    },
    close(): void {
      if (closed) return;
      checkpoint(); db.close(); closed = true;
    },
  };
  return store;
}
