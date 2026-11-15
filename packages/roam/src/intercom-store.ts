import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { assertTestConfigPath, openDb, openDbReadOnly, type Db } from "@spider/db-core";
import type { Home } from "@spider/db-core/roam/types";
import {
  addressKey, isMessageReceipt, isRemoteSessionInfo, isSessionAddress, isSessionEndpoint, receiptReleasesPayload, sameAddress,
  type ConsumptionEvidence, type FederationBlockers, type Message, type MessageReceipt, type SessionAddress, type SessionEndpoint,
} from "@spider/intercom/protocol";
import {
  INTERCOM_DEDUPE_MS, INTERCOM_MACHINE_BYTES, INTERCOM_MACHINE_MESSAGES, INTERCOM_ORIGIN_BYTES, INTERCOM_ORIGIN_MESSAGES,
  INTERCOM_EXCHANGE_BYTES, INTERCOM_HOP_ALLOWANCE_MS, INTERCOM_PAYLOAD_MS, INTERCOM_QUEUE_BYTES, INTERCOM_QUEUE_MESSAGES,
  type IntercomAcceptance, type IntercomEdgeState, type IntercomFrame, type IntercomIdentity, type IntercomMessageFrame, type IntercomQueue,
  type IntercomRefusal, type IntercomPairFence, type IntercomPairResume, type IntercomReceiptFrame, type IntercomReceiptInput, type IntercomState, type IntercomStore, type IntercomStoreOptions, type OutboundMessage,
  type RebindProof, type RetainedIntercom,
} from "./intercom-contracts";
import { decodeFrame, encodeFrame, isIntercomPairResume, isRebindProof, makeMessageFrame } from "./intercom-codec";
import { isMachineId } from "./machine-id";
import { createIntercomTopologyStore } from "./intercom-topology";
import { createFirstHomePairResume, isFirstHomePairResume, type FirstHomePairResume } from "./intercom-first-home";

const unsafe = () => new Error("Unsafe intercom store path or symlink");
const schemaColumns: Readonly<Record<string, readonly string[]>> = {
  intercom_hop_cursors: ["direction", "peer", "edge_epoch", "sequence"],
  intercom_hop_slots: ["direction", "peer", "edge_epoch", "sequence", "identity_key", "id", "reason", "at"],
  intercom_meta: ["id", "machine_id", "version", "last_clock", "discard_counts"],
  intercom_messages: ["id", "from_key", "to_key", "digest", "pair_sequence", "ask_id", "identity_json", "is_ask", "ask_state"],
  intercom_copies: ["direction", "id", "endpoint_json", "peer", "payload_json", "payload_bytes", "state", "unknown_outcome", "deadline_at",
    "remaining_ms", "last_clock", "ack_kind", "sent_kind", "transmitted", "readiness", "attempt", "observed_attempt", "receipt_json", "reconciliation_json", "reconciliation_attempt",
    "pending_proof_json", "pending_proof_attempt"],
  intercom_cursors: ["direction", "from_key", "to_key", "sequence"],
  intercom_receipts: ["receipt_key", "id", "peer", "frame_json", "acknowledged", "sent"],
  intercom_resumptions: ["from_key", "to_key", "peer", "edge_epoch", "resume_json"],
  intercom_edge_state: ["peer", "edge_epoch", "state_json"],
  intercom_pair_fences: ["peer", "edge_epoch", "fence_id", "fenced_at"],
  intercom_pair_approvals: ["peer", "edge_epoch", "operation_id", "graph_digest", "fence_id"],
  intercom_revocation_notices: ["id", "frame_json"],
  intercom_topology: ["id", "mode", "transition_json", "switched"],
  intercom_topology_refusals: ["id", "peer"],
  intercom_topology_audit: ["id", "transition_id", "old_next_hop", "new_next_hop", "at"],
  intercom_presence_claims: ["address_key", "machine_id", "activation", "home_epoch", "ambiguous"],
  intercom_rejections: ["peer", "id", "reason", "at"],
  intercom_notices: ["id", "kind"],
  intercom_endpoint_aliases: ["direction", "id", "endpoint_json"],
  intercom_refused_slots: ["from_key", "to_key", "sequence", "at"],
  intercom_settled_receipts: ["peer", "receipt_key"],
  intercom_receipt_positions: ['peer', 'from_key', 'to_key', 'sequence', 'receipt_key'],
  intercom_settled_watermarks: ['peer', 'from_key', 'to_key', 'sequence'],
};
const schemaKeys: Readonly<Record<string, readonly (readonly string[])[]>> = {
  intercom_hop_cursors: [["direction", "peer", "edge_epoch"]],
  intercom_hop_slots: [["direction", "peer", "edge_epoch", "sequence"]],
  intercom_endpoint_aliases: [["direction", "id", "endpoint_json"]],
  intercom_refused_slots: [["from_key", "to_key", "sequence"]],
  intercom_settled_receipts: [["peer", "receipt_key"]],
  intercom_receipt_positions: [['peer', 'from_key', 'to_key', 'sequence']],
  intercom_settled_watermarks: [['peer', 'from_key', 'to_key']],
  intercom_notices: [["id", "kind"]], intercom_presence_claims: [["address_key"]], intercom_rejections: [["peer", "id"]],
  intercom_messages: [["id"], ["from_key", "to_key", "pair_sequence"]],
  intercom_copies: [["direction", "id"]], intercom_cursors: [["direction", "from_key", "to_key"]],
  intercom_topology_refusals: [["id"]], intercom_topology_audit: [["id", "transition_id"]],
  intercom_receipts: [["receipt_key"]], intercom_resumptions: [["peer", "edge_epoch", "from_key", "to_key"]],
  intercom_edge_state: [["peer", "edge_epoch"]], intercom_pair_fences: [["peer"]], intercom_pair_approvals: [["peer"]], intercom_revocation_notices: [["id"]],
};
function validateSchema(db: Db, tables: readonly { name: string }[], version: number): void {
  const names = new Set(tables.map(row => row.name));
  const introduced = (name: string) => name.startsWith('intercom_hop_') ? 8 : ['intercom_receipt_positions', 'intercom_settled_watermarks'].includes(name) ? 7 : ["intercom_refused_slots", "intercom_settled_receipts"].includes(name) ? 6 : ["intercom_presence_claims", "intercom_rejections", "intercom_notices", "intercom_endpoint_aliases"].includes(name) ? 5 : name.startsWith("intercom_topology") ? 4 : name === "intercom_edge_state" ? 2 :
    name === "intercom_pair_fences" || name === "intercom_pair_approvals" || name === "intercom_revocation_notices" ? 3 : 1;
  if (tables.some(row => !(row.name in schemaColumns)) || Object.keys(schemaColumns).some(name => names.has(name) !== (version >= introduced(name)))) {
    throw new Error("Invalid or incomplete intercom store schema");
  }
  for (const [table, expected] of Object.entries(schemaColumns)) {
    if (!names.has(table)) continue;
    const columns = db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(table) as { name: string }[];
    if (JSON.stringify(columns.map(column => column.name)) !== JSON.stringify(table === "intercom_resumptions" && version < 8 ? expected.filter(name => name !== "edge_epoch") : version < 9 && ["intercom_meta", "intercom_refused_slots"].includes(table) ? expected.filter(name => name !== "discard_counts" && name !== "at") : expected)) throw new Error("Invalid or incomplete intercom store schema");
    const required = table === "intercom_resumptions" && version < 8 ? [["from_key", "to_key"]] : schemaKeys[table] ?? [];
    const indexes = db.prepare("SELECT name FROM pragma_index_list(?) WHERE \"unique\"=1").all(table) as { name: string }[];
    const actual = indexes.map(index => (db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name) as { name: string }[]).map(column => column.name));
    if (required.some(key => !actual.some(columnsInIndex => JSON.stringify(columnsInIndex) === JSON.stringify(key)))) {
      throw new Error("Invalid intercom store identity constraints");
    }
  }
  for (const table of ["intercom_copies", "intercom_receipts", ...(version >= 3 ? ["intercom_revocation_notices"] : []), ...(version >= 8 ? ["intercom_hop_slots"] : [])]) {
    const keys = db.prepare("SELECT \"table\",\"from\",\"to\",on_delete FROM pragma_foreign_key_list(?)").all(table) as { table: string; from: string; to: string; on_delete: string }[];
    if (!keys.some(key => key.table === "intercom_messages" && key.from === "id" && key.to === "id" && (table !== "intercom_hop_slots" || key.on_delete === "CASCADE"))) throw new Error("Invalid intercom store identity constraints");
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
      if (meta.version !== 1 && meta.version !== 2 && meta.version !== 3 && meta.version !== 4 && meta.version !== 5 && meta.version !== 6 && meta.version !== 7 && meta.version !== 8 && meta.version !== 9) throw new Error("Unsupported intercom store version");
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
// Stream keys qualify the portable sender by the machine that first accepted the message.
function streamKey(origin: string | undefined, address: SessionAddress): string { return JSON.stringify([origin ?? "", addressKey(address)]); }
function readOrigin(row: IdentityRow): string | undefined {
  const value = parseStored<IntercomIdentity & { originMachineId?: unknown }>(row.identity_json).originMachineId;
  if (value !== undefined && !isMachineId(value)) throw new Error("Invalid intercom origin metadata");
  return value;
}
function readIdentity(row: IdentityRow): IntercomIdentity {
  const { originMachineId: _origin, rejectedBy, rejectionUsed, ...identity } = parseStored<IntercomIdentity & {
    originMachineId?: unknown; rejectedBy?: unknown; rejectionUsed?: unknown;
  }>(row.identity_json);
  if (rejectedBy !== undefined && (!isMachineId(rejectedBy) || _origin !== undefined || typeof rejectionUsed !== "boolean") ||
      rejectedBy === undefined && rejectionUsed !== undefined) throw new Error("Invalid intercom rejection metadata");
  readOrigin(row);
  if (!identity || !nonempty(identity.id) || !isSessionAddress(identity.from) || !isSessionAddress(identity.to) ||
      !/^[0-9a-f]{64}$/.test(identity.digest) || !safeInteger(identity.sequence, 1) ||
      !(identity.askId === null || nonempty(identity.askId)) || identity.id !== row.id || identity.digest !== row.digest ||
      identity.sequence !== row.pair_sequence || identity.askId !== row.ask_id ||
      streamKey(typeof rejectedBy === "string" ? `rejected:${rejectedBy}:${identity.id}` : readOrigin(row), identity.from) !== row.from_key || addressKey(identity.to) !== row.to_key) throw new Error("Invalid intercom identity metadata");
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
    ...(receipt.evidence ? { evidence: cleanEvidence(receipt.evidence) } : {}), ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}) };
}
function cleanReceiptFrame(frame: IntercomReceiptInput): IntercomReceiptInput {
  return { from: { ...frame.from, address: { ...frame.from.address } }, to: { ...frame.to }, digest: frame.digest, receipt: cleanReceipt(frame.receipt),
    ...(frame.attempt !== undefined ? { attempt: frame.attempt } : {}),
    ...(frame.originMachineId !== undefined ? { originMachineId: frame.originMachineId } : {}),
    ...(frame.sequence !== undefined ? { sequence: frame.sequence } : {}) };
}
function receiptKey(frame: IntercomReceiptInput): string {
  return createHash("sha256").update(JSON.stringify([addressKey(frame.from.address), frame.from.machineId, frame.from.homeEpoch,
    frame.from.activationEpoch, addressKey(frame.to), frame.digest, frame.receipt.messageId, frame.receipt.status, frame.receipt.detail ?? null, frame.receipt.evidence ?? null, frame.attempt ?? 0])).digest("hex");
}
function receiptWithStream(row: IdentityRow, frame: IntercomReceiptInput, attempt = frame.attempt ?? 0): IntercomReceiptFrame {
  const originMachineId = readOrigin(row);
  if (!originMachineId) throw new Error('receipt-stream-unavailable');
  return { ...cleanReceiptFrame(frame), originMachineId, sequence: readIdentity(row).sequence, attempt };
}
function settledReceiptKey(frame: Pick<IntercomReceiptFrame, 'from' | 'to' | 'digest' | 'originMachineId' | 'sequence'>, messageId: string): string {
  return createHash('sha256').update(JSON.stringify([frame.originMachineId, frame.sequence, addressKey(frame.to),
    addressKey(frame.from.address), frame.from.machineId, frame.from.homeEpoch, frame.from.activationEpoch,
    frame.digest, messageId])).digest('hex');
}
function currentKind(row: CopyRow): IntercomFrame["kind"] { return row.state === "expired" || row.state === "cancelled" ? "tombstone" : "message"; }
function frameFor(row: CopyRow, at: number): IntercomFrame {
  const identity = readIdentity(row), endpoint = readEndpoint(row), originMachineId = readOrigin(row);
  if (!originMachineId) throw new Error("missing-origin");
  if (row.state === "expired" || row.state === "cancelled") return { kind: "tombstone", identity, endpoint, originMachineId, reason: row.state };
  if (row.payload_json === null) throw new Error("Intercom payload is unavailable");
  const message = parseStored<Message>(row.payload_json);
  if (row.is_ask && row.remaining_ms !== null) message.remainingMs = row.remaining_ms;
  const remainingPayloadMs = row.deadline_at - at;
  if (!safeInteger(remainingPayloadMs, 1)) throw new Error("Intercom payload expired");
  return decodeFrame(encodeFrame({ kind: "message", identity, endpoint, message, originMachineId, remainingPayloadMs }));
}

/** A machine-local store. The caller authenticates peers and supplies authoritative host proofs. */
export function openIntercomStore(options: IntercomStoreOptions): IntercomStore {
  if (!isMachineId(options.machineId) || !options.clock || typeof options.clock.now !== "function") throw new Error("Invalid intercom machine identity or clock");
  const queueMessages = options.limits?.queueMessages ?? INTERCOM_QUEUE_MESSAGES;
  const queueBytes = options.limits?.queueBytes ?? INTERCOM_QUEUE_BYTES;
  if (!safeInteger(queueMessages, 1) || queueMessages > INTERCOM_QUEUE_MESSAGES || !safeInteger(queueBytes, 1) || queueBytes > INTERCOM_QUEUE_BYTES) {
    throw new Error("Invalid intercom queue limits");
  }
  let highWater = 0, lastReading: number | undefined, rollbackPending = false;
  const caps = { originMessages: INTERCOM_ORIGIN_MESSAGES, originBytes: INTERCOM_ORIGIN_BYTES, machineMessages: INTERCOM_MACHINE_MESSAGES, machineBytes: INTERCOM_MACHINE_BYTES };
  for (const key of Object.keys(caps) as Array<keyof typeof caps>) {
    const value = options.limits?.[key];
    if (value !== undefined) { if (!safeInteger(value, 1) || value > caps[key]) throw new Error("Invalid intercom queue limits"); caps[key] = value; }
  }
  const now = (): number => {
    const value = options.clock.now();
    if (!safeInteger(value)) throw new Error("Invalid intercom clock");
    if (lastReading === undefined) highWater = value;
    else {
      if (value < lastReading) rollbackPending = true;
      highWater = plus(highWater, Math.max(0, value - lastReading));
    }
    lastReading = value;
    return highWater;
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
  const ensureCheckpoint = (): void => { if (checkpointPending && !db.raw.inTransaction) checkpoint(); };
  const checkpointDeletion = (): void => { checkpointPending = true; ensureCheckpoint(); };
  try {
    db.pragma("synchronous = FULL");
    db.pragma("secure_delete = ON");
    db.raw.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS intercom_hop_cursors (
          direction TEXT NOT NULL, peer TEXT NOT NULL, edge_epoch TEXT NOT NULL, sequence INTEGER NOT NULL,
          PRIMARY KEY(direction,peer,edge_epoch)
        );
        CREATE TABLE IF NOT EXISTS intercom_hop_slots (
          direction TEXT NOT NULL, peer TEXT NOT NULL, edge_epoch TEXT NOT NULL, sequence INTEGER NOT NULL,
          identity_key TEXT NOT NULL, id TEXT REFERENCES intercom_messages(id) ON DELETE CASCADE, reason TEXT, at INTEGER NOT NULL,
          PRIMARY KEY(direction,peer,edge_epoch,sequence), UNIQUE(direction,peer,edge_epoch,id)
        );
        CREATE TABLE IF NOT EXISTS intercom_meta (
          id INTEGER PRIMARY KEY CHECK(id=1), machine_id TEXT NOT NULL, version INTEGER NOT NULL, last_clock INTEGER NOT NULL, discard_counts TEXT NOT NULL DEFAULT '{}'
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
        CREATE TABLE IF NOT EXISTS intercom_settled_receipts (
          peer TEXT NOT NULL, receipt_key TEXT NOT NULL, PRIMARY KEY(peer,receipt_key)
        );
        CREATE TABLE IF NOT EXISTS intercom_refused_slots (
          from_key TEXT NOT NULL, to_key TEXT NOT NULL, sequence INTEGER NOT NULL, at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(from_key,to_key,sequence)
        );
        CREATE TABLE IF NOT EXISTS intercom_receipt_positions (
          peer TEXT NOT NULL, from_key TEXT NOT NULL, to_key TEXT NOT NULL, sequence INTEGER NOT NULL, receipt_key TEXT NOT NULL,
          PRIMARY KEY(peer,from_key,to_key,sequence)
        );
        CREATE TABLE IF NOT EXISTS intercom_settled_watermarks (
          peer TEXT NOT NULL, from_key TEXT NOT NULL, to_key TEXT NOT NULL, sequence INTEGER NOT NULL,
          PRIMARY KEY(peer,from_key,to_key)
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
          from_key TEXT NOT NULL, to_key TEXT NOT NULL, peer TEXT NOT NULL, edge_epoch TEXT NOT NULL DEFAULT 'local', resume_json TEXT NOT NULL,
          PRIMARY KEY(peer,edge_epoch,from_key,to_key)
        );
        CREATE TABLE IF NOT EXISTS intercom_edge_state (
          peer TEXT NOT NULL, edge_epoch TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(peer,edge_epoch)
        );
        CREATE TABLE IF NOT EXISTS intercom_pair_fences (
          peer TEXT PRIMARY KEY, edge_epoch TEXT NOT NULL, fence_id TEXT NOT NULL, fenced_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intercom_pair_approvals (
          peer TEXT PRIMARY KEY, edge_epoch TEXT NOT NULL, operation_id TEXT NOT NULL, graph_digest TEXT NOT NULL, fence_id TEXT
        );
        CREATE TABLE IF NOT EXISTS intercom_revocation_notices (
          id TEXT PRIMARY KEY REFERENCES intercom_messages(id), frame_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intercom_topology (
          id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, transition_json TEXT, switched TEXT
        );
        CREATE TABLE IF NOT EXISTS intercom_topology_refusals (
          id TEXT PRIMARY KEY REFERENCES intercom_messages(id), peer TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intercom_topology_audit (
          id TEXT NOT NULL REFERENCES intercom_messages(id), transition_id TEXT NOT NULL,
          old_next_hop TEXT NOT NULL, new_next_hop TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(id,transition_id)
        );
        CREATE TABLE IF NOT EXISTS intercom_presence_claims (
          address_key TEXT PRIMARY KEY, machine_id TEXT NOT NULL, activation TEXT NOT NULL, home_epoch INTEGER, ambiguous INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS intercom_rejections (
          peer TEXT NOT NULL, id TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(peer,id)
        );
        CREATE TABLE IF NOT EXISTS intercom_notices (id TEXT NOT NULL REFERENCES intercom_messages(id),kind TEXT NOT NULL,PRIMARY KEY(id,kind));
        CREATE INDEX IF NOT EXISTS intercom_message_recipient ON intercom_messages(to_key);
        CREATE TABLE IF NOT EXISTS intercom_endpoint_aliases (
          direction TEXT NOT NULL, id TEXT NOT NULL, endpoint_json TEXT NOT NULL,
          PRIMARY KEY(direction,id,endpoint_json), FOREIGN KEY(direction,id) REFERENCES intercom_copies(direction,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS intercom_copy_expiry ON intercom_copies(deadline_at,state);
        CREATE INDEX IF NOT EXISTS intercom_message_origin ON intercom_messages(json_extract(identity_json,'$.originMachineId'));
        CREATE INDEX IF NOT EXISTS intercom_copy_peer ON intercom_copies(direction,peer,state);
        CREATE INDEX IF NOT EXISTS intercom_message_pair ON intercom_messages(from_key,to_key,pair_sequence);
        CREATE INDEX IF NOT EXISTS intercom_receipt_peer ON intercom_receipts(peer,acknowledged);
      `);
      db.prepare("INSERT OR IGNORE INTO intercom_meta(id,machine_id,version,last_clock) VALUES(1,?,4,?)").run(options.machineId, firstNow);
      const meta = db.prepare("SELECT machine_id,version,last_clock FROM intercom_meta WHERE id=1").get() as MetaRow;
      if (!meta || meta.machine_id !== options.machineId) throw new Error("Intercom store machine identity mismatch");
      if (meta.version !== 1 && meta.version !== 2 && meta.version !== 3 && meta.version !== 4 && meta.version !== 5 && meta.version !== 6 && meta.version !== 7 && meta.version !== 8 && meta.version !== 9 || !safeInteger(meta.last_clock)) throw new Error("Unsupported intercom store version");
      rollbackPending ||= firstNow < meta.last_clock;
      highWater = Math.max(highWater, meta.last_clock);
      if (meta.version < 9) {
        const metaColumns = db.prepare("SELECT name FROM pragma_table_info('intercom_meta')").all() as { name: string }[];
        if (!metaColumns.some(column => column.name === 'discard_counts')) db.exec("ALTER TABLE intercom_meta ADD COLUMN discard_counts TEXT NOT NULL DEFAULT '{}'");
        const refusalColumns = db.prepare("SELECT name FROM pragma_table_info('intercom_refused_slots')").all() as { name: string }[];
        if (!refusalColumns.some(column => column.name === 'at')) {
          db.exec('ALTER TABLE intercom_refused_slots ADD COLUMN at INTEGER NOT NULL DEFAULT 0');
          // The creation time is unknown; conservatively start legacy retention now.
          db.prepare('UPDATE intercom_refused_slots SET at=?').run(highWater);
        }
        for (const table of ['intercom_receipts', 'intercom_revocation_notices']) {
          for (const entry of db.prepare(`SELECT id,frame_json FROM ${table}`).all() as { id: string; frame_json: string }[]) {
            const original = db.prepare('SELECT * FROM intercom_messages WHERE id=?').get(entry.id) as IdentityRow | undefined;
            if (!original) throw new Error('receipt-stream-unavailable');
            if (readOrigin(original)) continue;
            const discarded = db.prepare(`DELETE FROM ${table} WHERE id=? AND frame_json=?`).run(entry.id, entry.frame_json).changes;
            const category = table === 'intercom_receipts' ? 'origin-less-receipts' : 'origin-less-revocation-notices';
            const key = `$."${category}"`;
            db.prepare('UPDATE intercom_meta SET discard_counts=json_set(discard_counts,?,coalesce(json_extract(discard_counts,?),0)+?) WHERE id=1').run(key, key, discarded);
          }
        }
      }
      if (meta.version < 5) {
        db.prepare(`UPDATE intercom_messages SET identity_json=json_set(identity_json,'$.rejectedBy',
          (SELECT c.peer FROM intercom_copies c WHERE c.id=intercom_messages.id AND c.direction='inbound'),'$.rejectionUsed',json('false'))
          WHERE json_extract(identity_json,'$.originMachineId') IS NULL AND EXISTS (SELECT 1 FROM intercom_copies c
            WHERE c.id=intercom_messages.id AND c.direction='inbound' AND json_extract(c.receipt_json,'$.detail')='missing-origin')`).run();
        db.prepare(`UPDATE intercom_cursors SET from_key=json_array(coalesce((SELECT json_extract(m.identity_json,'$.originMachineId')
          FROM intercom_messages m WHERE m.from_key=intercom_cursors.from_key AND m.to_key=intercom_cursors.to_key
          ORDER BY m.pair_sequence DESC LIMIT 1),''),from_key)`).run();
        db.prepare(`UPDATE intercom_resumptions SET from_key=json_array(coalesce((SELECT json_extract(m.identity_json,'$.originMachineId')
          FROM intercom_messages m WHERE m.from_key=intercom_resumptions.from_key AND m.to_key=intercom_resumptions.to_key
          ORDER BY m.pair_sequence DESC LIMIT 1),''),from_key)`).run();
        db.prepare(`UPDATE intercom_messages SET from_key=json_array(CASE WHEN json_extract(identity_json,'$.rejectedBy') IS NOT NULL
          THEN 'rejected:'||json_extract(identity_json,'$.rejectedBy')||':'||id ELSE coalesce(json_extract(identity_json,'$.originMachineId'),'') END,from_key)`).run();
        db.prepare(`INSERT INTO intercom_cursors(direction,from_key,to_key,sequence)
          SELECT c.direction,m.from_key,m.to_key,max(m.pair_sequence) FROM intercom_messages m JOIN intercom_copies c ON c.id=m.id
          WHERE json_extract(m.identity_json,'$.originMachineId') IS NOT NULL GROUP BY c.direction,m.from_key,m.to_key
          ON CONFLICT(direction,from_key,to_key) DO UPDATE SET sequence=max(sequence,excluded.sequence)`).run();
        db.prepare("UPDATE intercom_meta SET version=5 WHERE id=1").run();
      }
      if (meta.version < 6) {
        const settled = db.prepare(`${selectCopy} WHERE c.direction='outbound' AND c.state IN ('injected','matched_waiter') AND c.receipt_json IS NOT NULL`).all() as CopyRow[];
        for (const row of settled) {
          const identity = readIdentity(row), endpoint = readEndpoint(row), receipt = parseStored<MessageReceipt>(row.receipt_json!);
          if (!isMessageReceipt(receipt) || !receiptReleasesPayload(receipt) || receipt.messageId !== identity.id || !safeInteger(row.observed_attempt)) {
            throw new Error("Invalid intercom settled receipt metadata");
          }
          db.prepare("INSERT OR IGNORE INTO intercom_settled_receipts(peer,receipt_key) VALUES(?,?)").run(row.peer,
            receiptKey({ from: endpoint, to: identity.from, digest: identity.digest, attempt: row.observed_attempt, receipt }));
        }
        db.prepare("UPDATE intercom_meta SET version=6 WHERE id=1").run();
      }
      if (meta.version < 7) {
        for (const table of ['intercom_receipts', 'intercom_revocation_notices']) {
          for (const entry of db.prepare(`SELECT id,frame_json FROM ${table}`).all() as { id: string; frame_json: string }[]) {
            const original = db.prepare('SELECT * FROM intercom_messages WHERE id=?').get(entry.id) as IdentityRow | undefined;
            if (!original) throw new Error('receipt-stream-unavailable');
            const frame = receiptWithStream(original, parseStored<IntercomReceiptInput>(entry.frame_json));
            db.prepare(`UPDATE ${table} SET frame_json=? WHERE id=? AND frame_json=?`).run(JSON.stringify(frame), entry.id, entry.frame_json);
          }
        }
        // Undeployed v6 hashes have no stream metadata; rebuild bounded evidence from retained identities.
        db.prepare('DELETE FROM intercom_settled_receipts').run();
        db.prepare(`INSERT OR IGNORE INTO intercom_settled_watermarks(peer,from_key,to_key,sequence)
          SELECT c.peer,m.from_key,m.to_key,0 FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id WHERE c.direction='outbound'`).run();
        db.prepare('UPDATE intercom_meta SET version=7 WHERE id=1').run();
      }
      if (meta.version < 8) {
        const columns = db.prepare("SELECT name FROM pragma_table_info('intercom_resumptions')").all() as { name: string }[];
        if (!columns.some(column => column.name === "edge_epoch")) {
          db.exec(`ALTER TABLE intercom_resumptions RENAME TO intercom_legacy_resumptions;
            CREATE TABLE intercom_resumptions (from_key TEXT NOT NULL,to_key TEXT NOT NULL,peer TEXT NOT NULL,
              edge_epoch TEXT NOT NULL DEFAULT 'local',resume_json TEXT NOT NULL,PRIMARY KEY(peer,edge_epoch,from_key,to_key));
            INSERT INTO intercom_resumptions(from_key,to_key,peer,edge_epoch,resume_json)
              SELECT from_key,to_key,peer,'unscoped',resume_json FROM intercom_legacy_resumptions;
            DROP TABLE intercom_legacy_resumptions;`);
        }
        db.prepare('UPDATE intercom_meta SET version=8 WHERE id=1').run();
      }
      if (meta.version < 9) {
        // Also repair retained evidence after an interrupted deployed schema-7 rebuild.
        for (const row of db.prepare(`${selectCopy} WHERE c.direction='outbound'`).all() as CopyRow[]) rememberSettled(row);
        db.prepare('UPDATE intercom_meta SET version=9 WHERE id=1').run();
      }
    }).immediate();
    checkpoint();
  } catch (error) { db.close(); throw error; }

  const topology = createIntercomTopologyStore(db, options.machineId, options.mode ?? "hub-only", now);
  const copy = (direction: IntercomQueue, id: string): CopyRow | undefined =>
    db.prepare(`${selectCopy} WHERE c.direction=? AND c.id=?`).get(direction, id) as CopyRow | undefined;
  const identityRow = (id: string): IdentityRow | undefined =>
    db.prepare("SELECT * FROM intercom_messages WHERE id=?").get(id) as IdentityRow | undefined;
  const cursor = (direction: IntercomQueue, identity: IntercomIdentity, origin: string | undefined): number => {
    const row = db.prepare("SELECT sequence FROM intercom_cursors WHERE direction=? AND from_key=? AND to_key=?")
      .get(direction, streamKey(origin, identity.from), addressKey(identity.to)) as { sequence: number } | undefined;
    return row?.sequence ?? 0;
  };
  const writeCursor = (direction: IntercomQueue, identity: IntercomIdentity, origin: string | undefined): void => {
    db.prepare(`INSERT INTO intercom_cursors(direction,from_key,to_key,sequence) VALUES(?,?,?,?)
      ON CONFLICT(direction,from_key,to_key) DO UPDATE SET sequence=max(sequence,excluded.sequence)`)
      .run(direction, streamKey(origin, identity.from), addressKey(identity.to), identity.sequence);
    if (direction === "inbound") db.prepare("DELETE FROM intercom_refused_slots WHERE from_key=? AND to_key=? AND sequence<=?")
      .run(streamKey(origin, identity.from), addressKey(identity.to), identity.sequence);
    else refreshWatermarks(streamKey(origin, identity.from), addressKey(identity.to));
  };
  function refreshWatermarks(from: string, to: string): void {
    const top = db.prepare("SELECT sequence FROM intercom_cursors WHERE direction='outbound' AND from_key=? AND to_key=?").get(from, to) as { sequence: number } | undefined;
    if (!top) return;
    const pending = db.prepare(`${selectCopy} WHERE c.direction='outbound' AND m.from_key=? AND m.to_key=?
      AND (c.state NOT IN ('injected','matched_waiter','answered','expired','cancelled') OR c.unknown_outcome=1)
      ORDER BY m.pair_sequence LIMIT 1`).get(from, to) as CopyRow | undefined;
    const through = pending ? pending.pair_sequence - 1 : top.sequence;
    db.prepare('UPDATE intercom_settled_watermarks SET sequence=max(sequence,?) WHERE from_key=? AND to_key=?').run(through, from, to);
    for (const entry of db.prepare(`SELECT p.peer,p.receipt_key FROM intercom_receipt_positions p
      JOIN intercom_settled_watermarks w ON w.peer=p.peer AND w.from_key=p.from_key AND w.to_key=p.to_key
      WHERE p.from_key=? AND p.to_key=? AND p.sequence<=w.sequence`).all(from, to) as { peer: string; receipt_key: string }[]) {
      db.prepare('DELETE FROM intercom_settled_receipts WHERE peer=? AND receipt_key=?').run(entry.peer, entry.receipt_key);
    }
    db.prepare(`DELETE FROM intercom_receipt_positions WHERE from_key=? AND to_key=? AND sequence<=
      (SELECT sequence FROM intercom_settled_watermarks w WHERE w.peer=intercom_receipt_positions.peer AND w.from_key=? AND w.to_key=?)`).run(from, to, from, to);
  }
  function rememberSettled(row: CopyRow | undefined): void {
    if (!row || row.direction !== 'outbound' || row.unknown_outcome || !['injected', 'matched_waiter', 'answered', 'expired', 'cancelled'].includes(row.state)) return;
    const identity = readIdentity(row), originMachineId = readOrigin(row);
    if (!originMachineId) return;
    const from = streamKey(originMachineId, identity.from), to = addressKey(identity.to);
    db.prepare('INSERT OR IGNORE INTO intercom_settled_watermarks(peer,from_key,to_key,sequence) VALUES(?,?,?,0)').run(row.peer, from, to);
    const watermark = db.prepare('SELECT sequence FROM intercom_settled_watermarks WHERE peer=? AND from_key=? AND to_key=?').get(row.peer, from, to) as { sequence: number };
    if (identity.sequence > watermark.sequence) {
      const key = settledReceiptKey({ from: readEndpoint(row), to: identity.from, digest: identity.digest, originMachineId, sequence: identity.sequence }, identity.id);
      const prior = db.prepare('SELECT receipt_key FROM intercom_receipt_positions WHERE peer=? AND from_key=? AND to_key=? AND sequence=?').get(row.peer, from, to, identity.sequence) as { receipt_key: string } | undefined;
      if (prior && prior.receipt_key !== key) db.prepare('DELETE FROM intercom_settled_receipts WHERE peer=? AND receipt_key=?').run(row.peer, prior.receipt_key);
      db.prepare('INSERT OR IGNORE INTO intercom_settled_receipts(peer,receipt_key) VALUES(?,?)').run(row.peer, key);
      db.prepare(`INSERT INTO intercom_receipt_positions(peer,from_key,to_key,sequence,receipt_key) VALUES(?,?,?,?,?)
        ON CONFLICT(peer,from_key,to_key,sequence) DO UPDATE SET receipt_key=excluded.receipt_key`).run(row.peer, from, to, identity.sequence, key);
    }
    refreshWatermarks(from, to);
  }
  const acceptance = (): Extract<import("@spider/intercom/protocol").AcceptanceEvidence, { durable: true }> =>
    ({ accepted: true, durable: true, location: `intercom:${options.machineId}` });
  const accepted = (kind: "accepted" | "duplicate", identity: IntercomIdentity, row?: CopyRow): IntercomAcceptance => ({
    kind, identity, acceptance: acceptance(), ...(row?.receipt_json ? { receipt: parseStored<MessageReceipt>(row.receipt_json) } : {}),
  });
  const room = (to: SessionAddress, bytes: number, origin: string, id: string): boolean => {
    const row = db.prepare(`SELECT count(*) AS count,coalesce(sum(c.payload_bytes),0) AS bytes
      FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id WHERE m.to_key=? AND c.payload_json IS NOT NULL`)
      .get(addressKey(to)) as { count: number; bytes: number };
    if (row.count >= queueMessages || row.bytes + bytes > queueBytes) return false;
    const originUsage = db.prepare(`SELECT count(DISTINCT m.id) AS count,coalesce(sum(c.payload_bytes),0) AS bytes
      FROM intercom_messages m JOIN intercom_copies c ON c.id=m.id WHERE coalesce(json_extract(m.identity_json,'$.originMachineId'),'')=?`).get(origin) as { count: number; bytes: number };
    const machineUsage = db.prepare(`SELECT count(DISTINCT m.id) AS count,coalesce(sum(c.payload_bytes),0) AS bytes
      FROM intercom_messages m JOIN intercom_copies c ON c.id=m.id`).get() as { count: number; bytes: number };
    const additional = identityRow(id) ? 0 : 1;
    return originUsage.count + additional <= caps.originMessages && originUsage.bytes + bytes <= caps.originBytes &&
      machineUsage.count + additional <= caps.machineMessages && machineUsage.bytes + bytes <= caps.machineBytes;
  };
  const saveReceipt = (row: CopyRow, frame: IntercomReceiptInput): void => {
    const clean = receiptWithStream(row, frame, frame.attempt ?? row.attempt), key = receiptKey(clean);
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
    else rememberSettled(copy('outbound', row.id));
    return true;
  };
  const cancelRow = (row: CopyRow, at: number): void => {
    if (["injected", "matched_waiter", "answered", "expired", "cancelled"].includes(row.state)) return;
    const cancellation: MessageReceipt = { messageId: row.id, status: "cancelled", timestamp: at };
    db.prepare("UPDATE intercom_copies SET state='cancelled',unknown_outcome=?,receipt_json=? WHERE direction=? AND id=?")
      .run(row.unknown_outcome || row.transmitted || row.state === "unknown" ? 1 : 0, JSON.stringify(cancellation), row.direction, row.id);
    if (row.is_ask) db.prepare("UPDATE intercom_messages SET ask_state='cancelled' WHERE id=? AND ask_state='open'").run(row.id);
    if (row.direction === "inbound") saveReceipt(row, { from: readEndpoint(row), to: readIdentity(row).from, digest: row.digest, receipt: cancellation });
    else rememberSettled(copy('outbound', row.id));
  };
  const expire = (): Array<{ queue: IntercomQueue; id: string }> => {
    ensureCheckpoint();
    const at = now();
    let deleted = false;
    const expired = db.raw.transaction(() => {
      const meta = db.prepare("SELECT machine_id,version,last_clock FROM intercom_meta WHERE id=1").get() as MetaRow;
      if (!meta || !safeInteger(meta.last_clock)) throw new Error("Invalid intercom clock metadata");
      // A rollback supplies no elapsed-time proof for an undelivered ask.
      const rolledBack = rollbackPending;
      if (at > meta.last_clock) db.prepare("UPDATE intercom_meta SET last_clock=? WHERE id=1").run(at);
      const result: Array<{ queue: IntercomQueue; id: string }> = [];
      const rows = db.prepare(`${selectCopy} WHERE (c.deadline_at<=? OR (?=1 AND m.is_ask=1 AND m.ask_state='open'))
        AND c.payload_json IS NOT NULL`).all(at, rolledBack ? 1 : 0) as CopyRow[];
      for (const row of rows) {
        if (row.is_ask) db.prepare("UPDATE intercom_messages SET ask_state='expired' WHERE id=? AND ask_state='open'").run(row.id);
        if (expireRow(row, at)) { deleted = true; result.push({ queue: row.direction, id: row.id }); }
      }
      const terminal = db.prepare(`SELECT m.id FROM intercom_messages m WHERE
        NOT (json_extract(m.identity_json,'$.rejectedBy') IS NOT NULL AND coalesce(json_extract(m.identity_json,'$.rejectionUsed'),0)=0) AND
        NOT EXISTS (SELECT 1 FROM intercom_copies c WHERE c.id=m.id AND (c.payload_json IS NOT NULL OR c.deadline_at>? OR
          c.state NOT IN ('injected','matched_waiter','answered','expired','cancelled') OR
          c.direction='outbound' AND c.state IN ('expired','cancelled') AND coalesce(c.ack_kind,'')!='tombstone'
            AND NOT EXISTS (SELECT 1 FROM intercom_pair_fences f WHERE f.peer=c.peer)))
        AND NOT EXISTS (SELECT 1 FROM intercom_receipts r WHERE r.id=m.id AND r.acknowledged=0
          AND NOT EXISTS (SELECT 1 FROM intercom_pair_fences f WHERE f.peer=r.peer))
        AND NOT EXISTS (SELECT 1 FROM intercom_revocation_notices n WHERE n.id=m.id)
        AND NOT EXISTS (SELECT 1 FROM intercom_copies c WHERE c.id=m.id AND c.direction='outbound' AND c.state='expired'
          AND NOT EXISTS (SELECT 1 FROM intercom_copies i WHERE i.id=c.id AND i.direction='inbound')
          AND NOT EXISTS (SELECT 1 FROM intercom_notices n WHERE n.id=c.id AND n.kind='expiry'))`).all(at - INTERCOM_DEDUPE_MS) as { id: string }[];
      const prunedStreams = new Map<string, [string, string]>();
      for (const { id } of terminal) {
        const original = identityRow(id);
        if (original) prunedStreams.set(JSON.stringify([original.from_key, original.to_key]), [original.from_key, original.to_key]);
        for (const table of ["intercom_notices", "intercom_receipts", "intercom_topology_refusals", "intercom_topology_audit", "intercom_copies", "intercom_messages"]) {
          db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
        }
        deleted = true;
      }
      for (const [from, to] of prunedStreams.values()) refreshWatermarks(from, to);
      db.prepare('DELETE FROM intercom_refused_slots WHERE at<?').run(at - 2 * INTERCOM_PAYLOAD_MS);
      db.prepare('DELETE FROM intercom_hop_slots WHERE reason IS NOT NULL AND at<?').run(at - 2 * INTERCOM_PAYLOAD_MS);
      db.prepare("DELETE FROM intercom_rejections WHERE at<?").run(at - 2 * INTERCOM_PAYLOAD_MS);
      db.prepare(`DELETE FROM intercom_resumptions WHERE json_extract(resume_json,'$.reason')='first-home-adoption'
        AND NOT EXISTS (SELECT 1 FROM intercom_messages m WHERE m.from_key=intercom_resumptions.from_key AND m.to_key=intercom_resumptions.to_key)`).run();
      return result;
    }).immediate();
    rollbackPending = false;
    if (deleted) checkpointDeletion();
    return expired;
  };
  const insertIdentity = (identity: IntercomIdentity, isAsk: boolean, tombstone?: "expired" | "cancelled", originMachineId?: string, rejectedBy?: string): void => {
    const originKey = rejectedBy ? `rejected:${rejectedBy}:${identity.id}` : originMachineId;
    const known = identityRow(identity.id);
    if (known) {
      if (!sameIdentity(readIdentity(known), identity)) throw new Error("Intercom message ID or digest conflict");
      const origin = readOrigin(known);
      if (origin && originMachineId && origin !== originMachineId) throw new Error("Intercom origin conflict");
      if (!origin && originMachineId) db.prepare("UPDATE intercom_messages SET identity_json=? WHERE id=?")
        .run(JSON.stringify({ ...identity, originMachineId }), identity.id);
      return;
    }
    const collision = db.prepare("SELECT id FROM intercom_messages WHERE from_key=? AND to_key=? AND pair_sequence=?")
      .get(streamKey(originKey, identity.from), addressKey(identity.to), identity.sequence) as { id: string } | undefined;
    if (collision) throw new Error("Intercom pair sequence conflict");
    db.prepare(`INSERT INTO intercom_messages(id,from_key,to_key,digest,pair_sequence,ask_id,identity_json,is_ask,ask_state)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(identity.id, streamKey(originKey, identity.from), addressKey(identity.to), identity.digest, identity.sequence,
        identity.askId, JSON.stringify({ ...identity, ...(originMachineId ? { originMachineId } : {}), ...(rejectedBy ? { rejectedBy, rejectionUsed: false } : {}) }), isAsk ? 1 : 0, isAsk ? tombstone ?? "open" : "none");
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
    if (direction === 'outbound') db.prepare('INSERT OR IGNORE INTO intercom_settled_watermarks(peer,from_key,to_key,sequence) VALUES(?,?,?,0)').run(peer, streamKey(frame.originMachineId, frame.identity.from), addressKey(frame.identity.to));
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
    if (frame && (frame.originMachineId !== undefined && frame.originMachineId !== readOrigin(row) ||
        frame.sequence !== undefined && frame.sequence !== identity.sequence)) throw new Error('receipt-stream-mismatch');
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
      const settled = db.prepare("UPDATE intercom_messages SET ask_state='settled' WHERE id=? AND json_extract(from_key,'$[1]')=? AND to_key=? AND ask_state='open'")
        .run(row.ask_id, addressKey(frame.from.address), addressKey(frame.to));
      if (settled.changes) db.prepare("UPDATE intercom_copies SET state='answered' WHERE id=? AND state IN ('queued','unknown','not_injected')")
        .run(row.ask_id);
    }
    if (row.direction === "inbound") saveReceipt(row, frame);
    return release;
  };

  const hopIdentity = (identity: IntercomIdentity, origin?: string): string => createHash("sha256")
    .update(JSON.stringify([origin ?? "", identity.id, identity.digest, identity.sequence, addressKey(identity.from), addressKey(identity.to), identity.askId])).digest("hex");
  const hopCursor = (direction: IntercomQueue, peer: string, edgeEpoch: string): number | undefined => {
    const row = db.prepare("SELECT sequence FROM intercom_hop_cursors WHERE direction=? AND peer=? AND edge_epoch=?")
      .get(direction, peer, edgeEpoch) as { sequence: number } | undefined;
    return row?.sequence;
  };
  const inspectHop: IntercomStore["inspectHop"] = input => {
    edgeKey(input.peer, input.edgeEpoch);
    if (!safeInteger(input.sequence, 1)) throw new Error("hop-sequence-invalid");
    const through = hopCursor("inbound", input.peer, input.edgeEpoch);
    if (through === undefined) throw new Error("hop-stream-unstarted");
    const slot = db.prepare("SELECT identity_key,reason FROM intercom_hop_slots WHERE direction='inbound' AND peer=? AND edge_epoch=? AND sequence=?")
      .get(input.peer, input.edgeEpoch, input.sequence) as { identity_key: string; reason: IntercomRefusal["reason"] | null } | undefined;
    if (slot && slot.identity_key !== hopIdentity(input.identity, input.origin)) throw new Error("hop-slot-mismatch");
    if (slot?.reason) return { kind: "refused", reason: slot.reason };
    if (input.sequence <= through) return { kind: "duplicate" };
    if (input.sequence !== through + 1) throw new Error("hop-sequence-gap");
    return { kind: "next" };
  };
  const saveHop = (direction: IntercomQueue, peer: string, edgeEpoch: string, sequence: number,
    identity: IntercomIdentity, origin: string | undefined, reason: IntercomRefusal["reason"] | null = null): void => {
    db.prepare("INSERT OR IGNORE INTO intercom_hop_slots(direction,peer,edge_epoch,sequence,identity_key,id,reason,at) VALUES(?,?,?,?,?,?,?,?)")
      .run(direction, peer, edgeEpoch, sequence, hopIdentity(identity, origin), reason ? null : identity.id, reason, now());
    db.prepare(`INSERT INTO intercom_hop_cursors(direction,peer,edge_epoch,sequence) VALUES(?,?,?,?)
      ON CONFLICT(direction,peer,edge_epoch) DO UPDATE SET sequence=max(sequence,excluded.sequence)`).run(direction, peer, edgeEpoch, sequence);
    // Old covered refusals are transport duplicates with no message outcome effect.
    db.prepare("DELETE FROM intercom_hop_slots WHERE direction=? AND peer=? AND edge_epoch=? AND reason IS NOT NULL AND sequence<=?")
      .run(direction, peer, edgeEpoch, sequence - queueMessages);
  };
  const outboundHop = (peer: string, edgeEpoch: string, identity: IntercomIdentity, origin: string): number => {
    edgeKey(peer, edgeEpoch);
    const prior = db.prepare("SELECT sequence,identity_key FROM intercom_hop_slots WHERE direction='outbound' AND peer=? AND edge_epoch=? AND id=?")
      .get(peer, edgeEpoch, identity.id) as { sequence: number; identity_key: string } | undefined;
    if (prior) {
      if (prior.identity_key !== hopIdentity(identity, origin)) throw new Error("hop-slot-mismatch");
      return prior.sequence;
    }
    const sequence = (hopCursor("outbound", peer, edgeEpoch) ?? 0) + 1;
    if (!safeInteger(sequence, 1)) throw new Error("hop-sequence-overflow");
    saveHop("outbound", peer, edgeEpoch, sequence, identity, origin);
    return sequence;
  };
  const pending = ((input: { kind: "outbound"; peer: string; edgeEpoch?: string; hopBudgetMs: number; maxBytes?: number; skipIds?: readonly string[] } | { kind: "inbound"; address: SessionAddress } | { kind: "receipts"; peer: string; maxBytes?: number }) => {
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
      const rows = db.prepare(`${selectCopy} WHERE c.direction='outbound' AND c.peer=?
        AND (?='hub-only' OR json_extract(c.endpoint_json,'$.machineId')=c.peer) AND (
        (c.state='queued' AND c.payload_json IS NOT NULL AND coalesce(c.ack_kind,'')!='message') OR
        (c.state IN ('expired','cancelled') AND coalesce(c.ack_kind,'')!='tombstone'))
        ORDER BY coalesce((SELECT h.sequence FROM intercom_hop_slots h WHERE h.direction='outbound' AND h.peer=? AND h.edge_epoch=? AND h.id=m.id),9223372036854775807),
        m.from_key,m.to_key,m.pair_sequence LIMIT 1024`).all(input.peer, topology.topology().mode, input.peer, input.edgeEpoch ?? "local") as CopyRow[];
      const frames: IntercomFrame[] = [], blocked = new Set<string>(); let bytes = 0;
      for (const row of rows) {
        const pair = JSON.stringify([row.from_key, row.to_key]);
        if (blocked.has(pair)) continue;
        if (skipped.has(row.id)) { blocked.add(pair); continue; }
        let next = row, expires = false;
        if (row.state === "queued") {
          const lifetime = row.deadline_at - at - input.hopBudgetMs - INTERCOM_HOP_ALLOWANCE_MS;
          const elapsed = Math.max(0, at - row.last_clock);
          const remaining = row.is_ask && row.remaining_ms !== null ? row.remaining_ms - elapsed - input.hopBudgetMs - INTERCOM_HOP_ALLOWANCE_MS : null;
          if (lifetime <= 0 || remaining !== null && remaining <= 0) { next = { ...row, state: "expired" }; expires = true; }
          else next = { ...row, deadline_at: at + lifetime, remaining_ms: remaining, last_clock: at };
        }
        const plain = frameFor(next, at);
        const frame = input.edgeEpoch ? { ...plain, hopSequence: outboundHop(input.peer, input.edgeEpoch, plain.identity, plain.originMachineId) } : plain;
        const size = encodeFrame(frame).byteLength + 1;
        if (bytes + size > budget) break;
        if (expires) { if (expireRow(row, at)) deleted = true; }
        else if (next !== row && row.is_ask) db.prepare("UPDATE intercom_copies SET remaining_ms=?,last_clock=?,deadline_at=? WHERE direction='outbound' AND id=?")
          .run(next.remaining_ms, at, next.deadline_at, row.id);
        bytes += size; frames.push(frame);
        db.prepare("UPDATE intercom_copies SET sent_kind=?,transmitted=CASE WHEN ?='message' THEN 1 ELSE transmitted END WHERE direction='outbound' AND id=?")
          .run(frame.kind, frame.kind, row.id);
      }
      return frames.sort((a, b) => (a.hopSequence ?? 0) - (b.hopSequence ?? 0));
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

  const pairFence = (peer: string): IntercomPairFence | null => {
    edgeKey(peer, "fence");
    const row = db.prepare("SELECT peer,edge_epoch,fence_id,fenced_at FROM intercom_pair_fences WHERE peer=?").get(peer) as
      { peer: string; edge_epoch: string; fence_id: string; fenced_at: number } | undefined;
    if (!row) return null;
    edgeKey(row.peer, row.edge_epoch);
    if (row.peer !== peer || !isMachineId(row.fence_id) || !safeInteger(row.fenced_at)) throw new Error("Invalid intercom fence metadata");
    return { peer: row.peer, edgeEpoch: row.edge_epoch, fenceId: row.fence_id, fencedAt: row.fenced_at };
  };

  const aliasEndpoint = (row: CopyRow): void => {
    db.prepare("INSERT OR IGNORE INTO intercom_endpoint_aliases(direction,id,endpoint_json) VALUES(?,?,?)").run(row.direction, row.id, row.endpoint_json);
    // Preserve the original sender endpoint and the 15 most recent local rebinds.
    db.prepare(`DELETE FROM intercom_endpoint_aliases WHERE direction=? AND id=? AND rowid NOT IN (
      SELECT rowid FROM intercom_endpoint_aliases WHERE direction=? AND id=? ORDER BY rowid DESC LIMIT 15)
      AND rowid<>(SELECT min(rowid) FROM intercom_endpoint_aliases WHERE direction=? AND id=?)`).run(row.direction,row.id,row.direction,row.id,row.direction,row.id);
  };
  const knownEndpoint = (row: CopyRow, endpoint: SessionEndpoint): boolean =>
    (db.prepare("SELECT endpoint_json FROM intercom_endpoint_aliases WHERE direction=? AND id=?").all(row.direction,row.id) as { endpoint_json: string }[])
      .some(alias => sameEndpoint(parseStored<SessionEndpoint>(alias.endpoint_json), endpoint));
  const store: IntercomStore = {
    ...topology,
    openHop(peer, edgeEpoch) {
      edgeKey(peer, edgeEpoch);
      db.prepare("INSERT OR IGNORE INTO intercom_hop_cursors(direction,peer,edge_epoch,sequence) VALUES('inbound',?,?,0)").run(peer, edgeEpoch);
    },
    inspectHop,
    hopPosition(queue, peer, edgeEpoch, identity) {
      const original = identityRow(identity.id);
      if (!original || !sameIdentity(identity, readIdentity(original))) return undefined;
      const row = db.prepare("SELECT sequence FROM intercom_hop_slots WHERE direction=? AND peer=? AND edge_epoch=? AND identity_key=?")
        .get(queue, peer, edgeEpoch, hopIdentity(identity, readOrigin(original))) as { sequence: number } | undefined;
      return row?.sequence;
    },
    rejectHop(input) {
      db.raw.transaction(() => {
        const status = inspectHop(input);
        if (status.kind !== "next") return;
        saveHop("inbound", input.peer, input.edgeEpoch, input.sequence, input.identity, input.origin, input.reason);
        store.recordRejection(input.peer, input.identity.id, input.reason);
      }).immediate();
    },
    presenceOwner(address) {
      const row = db.prepare("SELECT machine_id,activation,ambiguous FROM intercom_presence_claims WHERE address_key=?").get(addressKey(address)) as
        { machine_id: string; activation: string; ambiguous: number } | undefined;
      return row ? { machineId: row.machine_id, activation: row.activation, ambiguous: row.ambiguous === 1 } : null;
    },
    claimPresence(entry, { knownMachines, assigned, competing }) {
      return db.raw.transaction(() => {
        const key = addressKey(entry.address);
        const prior = db.prepare("SELECT machine_id,activation,home_epoch,ambiguous FROM intercom_presence_claims WHERE address_key=?").get(key) as
          { machine_id: string; activation: string; home_epoch: number | null; ambiguous: number } | undefined;
        if (assigned) {
          db.prepare(`INSERT INTO intercom_presence_claims(address_key,machine_id,activation,home_epoch,ambiguous) VALUES(?,?,?,?,0)
            ON CONFLICT(address_key) DO UPDATE SET machine_id=excluded.machine_id,activation=excluded.activation,home_epoch=excluded.home_epoch,ambiguous=0`)
            .run(key, entry.machineId, entry.activationEpoch, entry.homeEpoch);
          return true;
        }
        const past = db.prepare(`SELECT json_extract(p.value,'$.machineId') AS machine FROM intercom_edge_state e,
          json_each(e.state_json,'$.roster') p WHERE json_extract(p.value,'$.address.sessionId')=?
          AND json_extract(p.value,'$.address.scopeId') IS ?`).all(entry.address.sessionId, entry.address.scopeId) as { machine: string }[];
        const conflict = [...knownMachines, ...past.map(row => row.machine)].find(machine => machine !== entry.machineId);
        const ambiguous = competing || !!conflict || !!prior && (prior.machine_id !== entry.machineId || prior.ambiguous === 1 || prior.home_epoch !== null);
        if (!prior) db.prepare("INSERT INTO intercom_presence_claims(address_key,machine_id,activation,home_epoch,ambiguous) VALUES(?,?,?,NULL,?)")
          .run(key, conflict ?? entry.machineId, entry.activationEpoch, ambiguous ? 1 : 0);
        else if (ambiguous) db.prepare("UPDATE intercom_presence_claims SET ambiguous=1 WHERE address_key=?").run(key);
        return !ambiguous;
      }).immediate();
    },
    recordRejection(peer, id, reason) {
      if (!isMachineId(peer) || !nonempty(id) || !/^[a-z0-9-]{1,64}$/.test(reason)) throw new Error("Invalid intercom rejection");
      db.prepare(`INSERT INTO intercom_rejections(peer,id,reason,at) VALUES(?,?,?,?)
        ON CONFLICT(peer,id) DO UPDATE SET reason=excluded.reason`).run(peer, reason, reason, now());
    },
    rejectionDiagnostics() {
      return (db.prepare("SELECT peer,reason,min(at) AS since FROM intercom_rejections GROUP BY peer,reason ORDER BY peer,reason").all() as
        { peer: string; reason: string; since: number }[]).map(row => ({ ...row, status: "blocked", reason: `intercom-${row.reason}` }));
    },
    pairFence,
    fencePair(peer, edgeEpoch, fenceId) {
      edgeKey(peer, edgeEpoch);
      if (fenceId !== undefined && !isMachineId(fenceId)) throw new Error("Invalid intercom fence generation");
      return db.raw.transaction(() => {
        const existing = pairFence(peer);
        if (existing) return { fence: existing, upstream: [] };
        const fence = { peer, edgeEpoch, fenceId: fenceId ?? randomUUID(), fencedAt: now() };
        db.prepare("INSERT INTO intercom_pair_fences(peer,edge_epoch,fence_id,fenced_at) VALUES(?,?,?,?)").run(peer, edgeEpoch, fence.fenceId, fence.fencedAt);
        const ids = db.prepare("SELECT DISTINCT id FROM intercom_copies WHERE peer=? ORDER BY id").all(peer) as { id: string }[];
        const upstream = new Set<string>();
        for (const { id } of ids) {
          const outbound = copy("outbound", id), inbound = copy("inbound", id), source = outbound ?? inbound;
          if (!source) continue;
          const active = [outbound, inbound].some(row => row && ["queued", "unknown", "not_injected"].includes(row.state));
          if (!active && !(source.is_ask && source.ask_state === "open")) continue;
          const identity = readIdentity(source), endpoint = readEndpoint(source);
          const receipt: MessageReceipt = { messageId: id, status: "cancelled", timestamp: fence.fencedAt, detail: "peer-revoked" };
          const frame = receiptWithStream(source, { from: endpoint, to: identity.from, digest: identity.digest, receipt }, source.observed_attempt);
          for (const row of [outbound, inbound]) {
            if (!row || !["queued", "unknown", "not_injected"].includes(row.state)) continue;
            db.prepare("UPDATE intercom_copies SET state='cancelled',unknown_outcome=?,receipt_json=? WHERE direction=? AND id=?")
              .run(row.unknown_outcome || row.transmitted || row.state === "unknown" ? 1 : 0, JSON.stringify(receipt), row.direction, id);
          }
          if (source.is_ask) db.prepare("UPDATE intercom_messages SET ask_state='cancelled' WHERE id=? AND ask_state='open'").run(id);
          if (inbound) { saveReceipt(inbound, frame); upstream.add(inbound.peer); }
          else if (outbound) db.prepare("INSERT OR IGNORE INTO intercom_revocation_notices(id,frame_json) VALUES(?,?)").run(id, JSON.stringify(frame));
          if (outbound && outbound.peer !== peer) upstream.add(outbound.peer);
        }
        return { fence, upstream: [...upstream] };
      }).immediate();
    },
    approvePair(peer, approval) {
      edgeKey(peer, approval?.edgeEpoch);
      if (!approval || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(approval.operationId) || !/^[0-9a-f]{64}$/.test(approval.graphDigest) ||
          !(approval.expectedFenceId === null || isMachineId(approval.expectedFenceId))) throw new Error("Invalid intercom approval");
      return db.raw.transaction(() => {
        const fence = pairFence(peer);
        const prior = db.prepare("SELECT edge_epoch,operation_id,graph_digest,fence_id FROM intercom_pair_approvals WHERE peer=?").get(peer) as
          { edge_epoch: string; operation_id: string; graph_digest: string; fence_id: string | null } | undefined;
        const identical = !!prior && prior.edge_epoch === approval.edgeEpoch && prior.operation_id === approval.operationId &&
          prior.graph_digest === approval.graphDigest && prior.fence_id === approval.expectedFenceId;
        if (prior?.operation_id === approval.operationId && !identical) throw new Error("fresh-peer-consent-required");
        if (fence) {
          if (fence.fenceId !== approval.expectedFenceId || fence.edgeEpoch === approval.edgeEpoch) throw new Error("fresh-peer-consent-required");
          db.prepare("DELETE FROM intercom_pair_fences WHERE peer=? AND fence_id=?").run(peer, fence.fenceId);
        } else if (approval.expectedFenceId !== null && !identical) throw new Error("fresh-peer-consent-required");
        if (!identical) db.prepare(`INSERT INTO intercom_pair_approvals(peer,edge_epoch,operation_id,graph_digest,fence_id) VALUES(?,?,?,?,?)
          ON CONFLICT(peer) DO UPDATE SET edge_epoch=excluded.edge_epoch,operation_id=excluded.operation_id,graph_digest=excluded.graph_digest,fence_id=excluded.fence_id`)
          .run(peer, approval.edgeEpoch, approval.operationId, approval.graphDigest, approval.expectedFenceId);
        return !identical;
      }).immediate();
    },
    pendingRevocationNotices() {
      const rows = db.prepare("SELECT id,frame_json FROM intercom_revocation_notices ORDER BY id").all() as { id: string; frame_json: string }[];
      return rows.map(({ id, frame_json }) => {
        const frame = parseStored<IntercomReceiptFrame>(frame_json), row = copy("outbound", id);
        if (!row || frame.receipt?.detail !== "peer-revoked" || frame.receipt.status !== "cancelled") throw new Error("Invalid intercom revocation notice");
        validReceipt(row, frame);
        return frame;
      });
    },
    acknowledgeRevocationNotice(frame) {
      const row = db.prepare("SELECT frame_json FROM intercom_revocation_notices WHERE id=?").get(frame.receipt.messageId) as { frame_json: string } | undefined;
      if (!row || JSON.stringify(parseStored<IntercomReceiptFrame>(row.frame_json)) !== JSON.stringify(frame)) throw new Error("Invalid intercom revocation notice acknowledgement");
      db.prepare("DELETE FROM intercom_revocation_notices WHERE id=?").run(frame.receipt.messageId);
    },
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
    acceptLocal(input): IntercomAcceptance {
      if (input.endpoint.machineId !== options.machineId) throw new Error("Intercom local endpoint mismatch");
      expire();
      const rollback = new Error("Intercom local acceptance refused");
      let refusal: Extract<IntercomAcceptance, { kind: "refused" }> | undefined;
      try {
        return db.raw.transaction(() => {
          const outbound = store.acceptOutbound({ ...input, nextHop: options.machineId });
          if (outbound.kind !== "accepted") return outbound;
          const row = copy("outbound", input.message.id)!;
          const inbox = store.acceptInbound({ peer: options.machineId, frame: frameFor(row, now()) });
          if (inbox.kind === "refused") { refusal = inbox; throw rollback; }
          db.prepare("UPDATE intercom_copies SET sent_kind='message',ack_kind='message',transmitted=1 WHERE direction='outbound' AND id=?").run(input.message.id);
          return outbound;
        }).immediate();
      } catch (error) { if (error === rollback && refusal) return refusal; throw error; }
      finally { ensureCheckpoint(); }
    },
    acceptOutbound(input: OutboundMessage): IntercomAcceptance {
      if (!isMachineId(input.nextHop)) throw new Error("Invalid intercom peer");
      expire(); const at = now();
      let candidate: IntercomMessageFrame | IntercomFrame;
      try {
        candidate = "frame" in input ? decodeFrame(encodeFrame(input.frame))
          : makeMessageFrame({ from: input.from, endpoint: input.endpoint, sequence: 1, message: input.message, originMachineId: options.machineId });
        encodeFrame(candidate);
      } catch (error) {
        if (error instanceof Error && /size limit/.test(error.message)) return { kind: "refused", reason: "message-too-large" };
        throw error;
      }
      let deleted = false;
      const result = db.raw.transaction(() => {
        const known = identityRow(candidate.identity.id);
        const knownOrigin = known ? readOrigin(known) : undefined;
        if (knownOrigin && candidate.originMachineId !== knownOrigin) throw new Error("Intercom origin conflict");
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
          ORDER BY m.pair_sequence DESC LIMIT 1`).get(streamKey(candidate.originMachineId, candidate.identity.from), addressKey(candidate.identity.to)) as CopyRow | undefined;
        let continuity: FirstHomePairResume | undefined;
        if (previous && !sameEndpoint(readEndpoint(previous), candidate.endpoint)) {
          continuity = createFirstHomePairResume(candidate.identity.from, readEndpoint(previous), candidate.endpoint,
            input.firstHomePresence, previous.pair_sequence, at);
          if (!continuity) {
            const saved = db.prepare("SELECT peer,resume_json FROM intercom_resumptions WHERE from_key=? AND to_key=? AND peer=? AND edge_epoch=?")
              .get(streamKey(candidate.originMachineId, candidate.identity.from), addressKey(candidate.identity.to), input.nextHop, input.edgeEpoch ?? "local") as { peer: string; resume_json: string } | undefined;
            const resume: unknown = saved ? parseStored<unknown>(saved.resume_json) : null;
            if (!saved || saved.peer !== input.nextHop || !isIntercomPairResume(resume) || !sameEndpoint(resume.endpoint, candidate.endpoint)) {
              throw new Error("Intercom route requires authoritative rebind proof");
            }
          }
        }
        const seq = "frame" in input ? candidate.identity.sequence : cursor("outbound", candidate.identity, candidate.originMachineId) + 1;
        if (!safeInteger(seq, 1) || !("frame" in input && input.edgeEpoch) && seq !== cursor("outbound", candidate.identity, candidate.originMachineId) + 1) throw new Error("Intercom outbound sequence gap");
        if (!("frame" in input)) candidate = makeMessageFrame({ from: input.from, endpoint: input.endpoint, sequence: seq, message: input.message, originMachineId: options.machineId });
        const bytes = candidate.kind === "message" ? encodeFrame(candidate).byteLength : 0;
        // Bound sparse proofs when an unknown earlier slot stalls the settled watermark.
        const settled = db.prepare('SELECT coalesce(max(sequence),0) AS sequence FROM intercom_settled_watermarks WHERE from_key=? AND to_key=?')
          .get(streamKey(candidate.originMachineId, candidate.identity.from), addressKey(candidate.identity.to)) as { sequence: number };
        if (cursor('outbound', candidate.identity, candidate.originMachineId) - settled.sequence >= queueMessages) return { kind: 'refused', reason: 'queue-full' } as const;
        if (!room(candidate.identity.to, bytes, candidate.originMachineId, candidate.identity.id)) return { kind: "refused", reason: "queue-full" } as const;
        if (continuity) {
          db.prepare(`INSERT INTO intercom_resumptions(from_key,to_key,peer,edge_epoch,resume_json) VALUES(?,?,?,?,?)
            ON CONFLICT(peer,edge_epoch,from_key,to_key) DO UPDATE SET resume_json=excluded.resume_json`)
            .run(streamKey(candidate.originMachineId, candidate.identity.from), addressKey(candidate.identity.to), input.nextHop, input.edgeEpoch ?? "local", JSON.stringify(continuity));
        }
        insertIdentity(candidate.identity, candidate.kind === "message" ? candidate.message.expectsReply === true : candidate.identity.askId === candidate.identity.id,
          candidate.kind === "tombstone" ? candidate.reason : undefined, candidate.originMachineId);
        insertCopy("outbound", candidate, input.nextHop, at); writeCursor("outbound", candidate.identity, candidate.originMachineId);
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
      const rollback = new Error("Intercom relay admission refused");
      let forwardRefusal: Extract<IntercomAcceptance, { kind: "refused" }> | undefined;
      let result: IntercomAcceptance;
      try { result = db.raw.transaction(() => {
        if (input.hop) {
          const status = inspectHop({ peer: input.peer, edgeEpoch: input.hop.edgeEpoch, sequence: input.hop.sequence, identity: frame.identity, origin: frame.originMachineId });
          if (status.kind === "refused" || status.kind === "duplicate" && !identityRow(frame.identity.id)) return accepted("duplicate", frame.identity);
        }
        const admit = (): IntercomAcceptance => {
        const known = identityRow(frame.identity.id);
        if (known && readOrigin(known) && readOrigin(known) !== frame.originMachineId) throw new Error("Intercom origin conflict");
        if (known && !sameIdentity(readIdentity(known), frame.identity)) throw new Error("Intercom message ID or digest conflict");
        let prior = copy("inbound", frame.identity.id);
        const mode = topology.topology();
        if (!prior && frame.endpoint.machineId !== options.machineId && (mode.transition !== null || mode.mode === "peers")) {
          return { kind: "refused" as const, reason: "intercom-topology-changing" as const };
        }
        if (prior) {
          const oldEndpoint = readEndpoint(prior);
          if (prior.peer !== input.peer || !sameEndpoint(oldEndpoint, frame.endpoint) && !knownEndpoint(prior, frame.endpoint)) {
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
        if (db.prepare("SELECT 1 FROM intercom_refused_slots WHERE from_key=? AND to_key=? AND sequence=?")
          .get(streamKey(frame.originMachineId, frame.identity.from), addressKey(frame.identity.to), frame.identity.sequence)) {
          return accepted("duplicate", frame.identity);
        }
        const previous = cursor("inbound", frame.identity, frame.originMachineId);
        if (!input.hop && !known && frame.identity.sequence <= previous) return accepted("duplicate", frame.identity);
        if (!input.hop && frame.identity.sequence !== previous + 1) {
          const rejected = db.prepare(`SELECT m.id,m.pair_sequence FROM intercom_messages m JOIN intercom_copies c ON c.id=m.id
            WHERE c.direction='inbound' AND c.peer=? AND json_extract(m.identity_json,'$.rejectedBy')=?
            AND coalesce(json_extract(m.identity_json,'$.rejectionUsed'),0)=0
            AND json_extract(m.identity_json,'$.from.sessionId')=? AND json_extract(m.identity_json,'$.from.scopeId') IS ?
            AND m.to_key=? AND m.pair_sequence>? AND m.pair_sequence<?`).all(input.peer, input.peer,
              frame.identity.from.sessionId, frame.identity.from.scopeId, addressKey(frame.identity.to), previous, frame.identity.sequence) as { id: string; pair_sequence: number }[];
          const slots = db.prepare("SELECT sequence FROM intercom_refused_slots WHERE from_key=? AND to_key=? AND sequence>? AND sequence<?")
            .all(streamKey(frame.originMachineId, frame.identity.from), addressKey(frame.identity.to), previous, frame.identity.sequence) as { sequence: number }[];
          if (new Set([...rejected.map(row => row.pair_sequence), ...slots.map(row => row.sequence)]).size === frame.identity.sequence - previous - 1) {
            // Advance only proven rejected slots, never an accepted message or an inferred frame origin.
            for (const row of rejected) db.prepare("UPDATE intercom_messages SET identity_json=json_set(identity_json,'$.rejectionUsed',json('true')) WHERE id=?").run(row.id);
            writeCursor("inbound", { ...frame.identity, sequence: frame.identity.sequence - 1 }, frame.originMachineId);
          } else {
          if (!input.resume) throw new Error("Intercom inbound sequence gap");
          const resume = validateResume(input.resume, frame);
          if (resume.through !== frame.identity.sequence - 1 || resume.through < previous) throw new Error("Intercom inbound sequence gap");
          const unfinished = db.prepare(`SELECT 1 FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id
            WHERE c.direction='inbound' AND m.from_key=? AND m.to_key=? AND
              (c.unknown_outcome=1 OR c.state IN ('queued','unknown','not_injected')) LIMIT 1`)
            .get(streamKey(frame.originMachineId, resume.from), addressKey(resume.to));
          const unobserved = db.prepare(`SELECT 1 FROM intercom_receipts r JOIN intercom_messages m ON m.id=r.id
            WHERE r.acknowledged=0 AND m.from_key=? AND m.to_key=? LIMIT 1`)
            .get(streamKey(frame.originMachineId, resume.from), addressKey(resume.to));
          if (unfinished || unobserved) throw new Error("Intercom pair resume has unresolved evidence");
          }
        }
        const bytes = frame.kind === "message" ? encodeFrame(frame).byteLength : 0;
        if (!room(frame.identity.to, bytes, frame.originMachineId, frame.identity.id)) return { kind: "refused", reason: "queue-full" } as const;
        insertIdentity(frame.identity, frame.kind === "message" ? frame.message.expectsReply === true : frame.identity.askId === frame.identity.id,
          frame.kind === "tombstone" ? frame.reason : undefined, frame.originMachineId);
        insertCopy("inbound", frame, input.peer, at); writeCursor("inbound", frame.identity, frame.originMachineId);
        if (frame.kind === "tombstone") {
          const received = copy("inbound", frame.identity.id)!;
          const terminal: MessageReceipt = { messageId: frame.identity.id, status: frame.reason, timestamp: at };
          db.prepare("UPDATE intercom_copies SET receipt_json=? WHERE direction='inbound' AND id=?").run(JSON.stringify(terminal), frame.identity.id);
          saveReceipt(received, { from: frame.endpoint, to: frame.identity.from, digest: frame.identity.digest, receipt: terminal });
        }
        return accepted("accepted", frame.identity);
        };
        const outcome = admit();
        if (outcome.kind === "refused" && outcome.reason === "intercom-topology-changing" && input.hop) {
          saveHop("inbound", input.peer, input.hop.edgeEpoch, input.hop.sequence, frame.identity, frame.originMachineId, outcome.reason);
        }
        if (outcome.kind !== "refused") {
          const retained = copy("inbound", frame.identity.id);
          if (input.forward && retained) {
            const forwarded = store.acceptOutbound({ frame: { ...frame, endpoint: readEndpoint(retained) }, nextHop: input.forward.peer,
              edgeEpoch: input.forward.edgeEpoch, firstHomePresence: input.forward.firstHomePresence });
            if (forwarded.kind === "refused") { forwardRefusal = forwarded; throw rollback; }
          }
          if (input.hop) saveHop("inbound", input.peer, input.hop.edgeEpoch, input.hop.sequence, frame.identity, frame.originMachineId);
        }
        return outcome;
      }).immediate(); } catch (error) { if (error === rollback && forwardRefusal) return forwardRefusal; throw error; }
      if (deleted) checkpointDeletion();
      return result;
    },
    rejectFrame({ peer, origin, identity, reason }): void {
      ensureCheckpoint();
      if (!isMachineId(peer) || !isMachineId(origin) || !identity || !isSessionAddress(identity.from) || !isSessionAddress(identity.to) ||
          !safeInteger(identity.sequence, 1) || !nonempty(identity.id) || !["sender-unauthorized", "store-rejected", "peer-revoked"].includes(reason)) {
        throw new Error("Invalid intercom rejection");
      }
      db.raw.transaction(() => {
        const through = cursor("inbound", identity, origin);
        const count = (db.prepare("SELECT count(*) AS n FROM intercom_refused_slots").get() as { n: number }).n;
        if (identity.sequence > through && identity.sequence - through <= queueMessages && count < caps.machineMessages) {
          db.prepare("INSERT OR IGNORE INTO intercom_refused_slots(from_key,to_key,sequence,at) VALUES(?,?,?,?)")
            .run(streamKey(origin, identity.from), addressKey(identity.to), identity.sequence, now());
        }
        store.recordRejection(peer, identity.id, reason);
      }).immediate();
    },
    rejectMissingOrigin(input): void {
      ensureCheckpoint();
      const { peer, frame } = input, { identity, endpoint } = frame;
      if (!isMachineId(peer) || !identity || !nonempty(identity.id) || !isSessionAddress(identity.from) || !isSessionAddress(identity.to) ||
          identity.from.scopeId !== identity.to.scopeId || sameAddress(identity.from, identity.to) || !/^[0-9a-f]{64}$/.test(identity.digest) ||
          !safeInteger(identity.sequence, 1) || !(identity.askId === null || nonempty(identity.askId)) ||
          !isSessionEndpoint(endpoint) || !isMachineId(endpoint.machineId) || !sameAddress(endpoint.address, identity.to)) throw new Error("Invalid intercom rejection");
      const at = now();
      db.raw.transaction(() => {
        const existing = copy("inbound", identity.id);
        if (existing) {
          if (existing.peer !== peer || !sameIdentity(readIdentity(existing), identity) || !sameEndpoint(readEndpoint(existing), endpoint)) throw new Error("Intercom rejection conflict");
          return;
        }
        if (!room(identity.to, 0, "", identity.id)) throw new Error("Intercom rejection quota reached");
        insertIdentity(identity, identity.askId === identity.id, "cancelled", undefined, peer);
        const receipt: MessageReceipt = { messageId: identity.id, status: "cancelled", timestamp: at, detail: "missing-origin" };
        db.prepare(`INSERT INTO intercom_copies(direction,id,endpoint_json,peer,payload_json,payload_bytes,state,deadline_at,remaining_ms,last_clock,receipt_json)
          VALUES('inbound',?,?,?,?,0,'cancelled',?,NULL,?,?)`).run(identity.id, JSON.stringify(endpoint), peer, null,
          plus(at, INTERCOM_PAYLOAD_MS), at, JSON.stringify(receipt));
        // No original origin exists for this rejected frame. Its transport refusal is the acknowledgement.
      }).immediate();
    },
    outboundResumptions(peer, edgeEpoch = "local"): readonly IntercomPairResume[] {
      ensureCheckpoint();
      if (!isMachineId(peer)) throw new Error("Invalid intercom peer");
      return (db.prepare("SELECT resume_json FROM intercom_resumptions WHERE peer=? AND edge_epoch=? ORDER BY from_key,to_key").all(peer, edgeEpoch) as { resume_json: string }[])
        .flatMap(row => {
          const value: unknown = parseStored<unknown>(row.resume_json);
          if (isFirstHomePairResume(value)) return [];
          if (!isIntercomPairResume(value)) throw new Error("Invalid intercom pair resume metadata");
          return [value];
        });
    },
    pending,
    acknowledge(input): void {
      ensureCheckpoint();
      if (input.edgeEpoch) {
        edgeKey(input.peer, input.edgeEpoch);
        const sequence = input.hopSequence ?? 0;
        if (!safeInteger(sequence, 1)) throw new Error('hop-ack-mismatch');
        const slot = db.prepare("SELECT identity_key FROM intercom_hop_slots WHERE direction='outbound' AND peer=? AND edge_epoch=? AND sequence=?")
          .get(input.peer, input.edgeEpoch, sequence) as { identity_key: string } | undefined;
        const original = identityRow(input.identity.id);
        if (!original && !slot && sequence <= (hopCursor('outbound', input.peer, input.edgeEpoch) ?? 0)) return;
        if (!slot || !original || slot.identity_key !== hopIdentity(input.identity, readOrigin(original))) throw new Error("hop-ack-mismatch");
      }
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
    retryKnownNotSent(input): void {
      expire();
      db.raw.transaction(() => {
        const row = copy("inbound", input.id);
        if (!row || row.state !== "unknown" || !row.unknown_outcome || row.payload_json === null ||
            !sameEndpoint(readEndpoint(row), input.endpoint) || row.observed_attempt !== input.attempt) {
          throw new Error("Intercom not-sent proof does not match dispatch");
        }
        db.prepare("UPDATE intercom_copies SET state='queued',unknown_outcome=0,readiness=NULL WHERE direction='inbound' AND id=?").run(row.id);
      }).immediate();
    },
    followConsumption(input): void {
      db.raw.transaction(() => {
        const row = copy(input.queue, input.frame.receipt.messageId), endpoint = input.frame.from;
        if (!row || row.peer !== input.peer || !receiptReleasesPayload(input.frame.receipt) ||
            !["injected", "matched_waiter"].includes(input.frame.receipt.status) || ["injected", "matched_waiter"].includes(row.state)) {
          throw new Error("Intercom consumption rebind requires physical evidence");
        }
        const old = readEndpoint(row);
        if (!sameAddress(old.address, endpoint.address) || old.machineId !== endpoint.machineId || old.activationEpoch === endpoint.activationEpoch ||
            old.homeEpoch !== endpoint.homeEpoch && !(old.homeEpoch === null && endpoint.homeEpoch !== null)) throw new Error("Intercom consumption rebind route mismatch");
        validReceipt({ ...row, endpoint_json: JSON.stringify(endpoint) }, input.frame);
        aliasEndpoint(row);
        db.prepare("UPDATE intercom_copies SET endpoint_json=? WHERE direction=? AND id=?").run(JSON.stringify(endpoint), input.queue, row.id);
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
        if (input.queue === 'outbound') rememberSettled(copy('outbound', row.id));
      }).immediate();
      if (deleted) checkpointDeletion();
    },
    isSettledReceipt({ peer, frame }): boolean {
      ensureCheckpoint();
      const original = identityRow(frame.receipt.messageId);
      if (original && (readOrigin(original) !== frame.originMachineId || readIdentity(original).sequence !== frame.sequence)) throw new Error('receipt-stream-mismatch');
      const live = copy('outbound', frame.receipt.messageId);
      if (live) {
        if (live.peer !== peer || !['injected', 'matched_waiter', 'answered'].includes(live.state)) return false;
        validReceipt(live, frame);
      }
      const from = streamKey(frame.originMachineId, frame.to), to = addressKey(frame.from.address);
      const watermark = db.prepare('SELECT sequence FROM intercom_settled_watermarks WHERE peer=? AND from_key=? AND to_key=?').get(peer, from, to) as { sequence: number } | undefined;
      // A covered slot is only a transport duplicate; never reapply its claimed outcome.
      if (watermark && frame.sequence <= watermark.sequence) return true;
      if (live) return false;
      const position = db.prepare('SELECT receipt_key FROM intercom_receipt_positions WHERE peer=? AND from_key=? AND to_key=? AND sequence=?').get(peer, from, to, frame.sequence) as { receipt_key: string } | undefined;
      return !!position && position.receipt_key === settledReceiptKey(frame, frame.receipt.messageId);
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
        else rememberSettled(copy('outbound', input.id));
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
        WHERE c.payload_json IS NOT NULL`).get() as { deadline: number | null };
      if (row.deadline !== null && !safeInteger(row.deadline)) throw new Error("Invalid intercom deadline metadata");
      return row.deadline;
    },
    hasPending(peer): boolean {
      if (!isMachineId(peer)) throw new Error("Invalid intercom peer");
      expire();
      const row = db.prepare(`SELECT EXISTS(SELECT 1 FROM intercom_copies WHERE direction='outbound' AND peer=?
        AND (?='hub-only' OR json_extract(endpoint_json,'$.machineId')=peer) AND
        ((state='queued' AND payload_json IS NOT NULL AND coalesce(ack_kind,'')!='message') OR
         (state IN ('expired','cancelled') AND coalesce(ack_kind,'')!='tombstone'))) OR
        EXISTS(SELECT 1 FROM intercom_receipts WHERE peer=? AND acknowledged=0) AS pending`).get(peer, topology.topology().mode, peer) as { pending: number };
      return row.pending === 1;
    },
    openAsks(peer): readonly RetainedIntercom[] {
      if (!isMachineId(peer)) throw new Error("Invalid intercom peer");
      expire();
      const rows = db.prepare(`SELECT c.id FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id
        WHERE c.direction='outbound' AND c.peer=? AND m.is_ask=1 AND m.ask_state='open' ORDER BY c.id`).all(peer) as { id: string }[];
      return rows.map(row => store.retained("outbound", row.id)).filter((row): row is RetainedIntercom => row !== null);
    },
    hasGenerationReferences(sessionId, generation) {
      return !!db.prepare(`SELECT 1 FROM intercom_copies WHERE json_extract(endpoint_json,'$.address.sessionId')=?
        AND json_extract(endpoint_json,'$.activationEpoch')=? LIMIT 1`).get(sessionId, generation);
    },
    noticeReported(id, kind) { return !!db.prepare("SELECT 1 FROM intercom_notices WHERE id=? AND kind=?").get(id, kind); },
    markNoticeReported(id, kind) { db.prepare("INSERT OR IGNORE INTO intercom_notices(id,kind) VALUES(?,?)").run(id, kind); },
    expiredOutbounds(peer) {
      if (!isMachineId(peer)) throw new Error("Invalid intercom peer");
      const rows = db.prepare(`${selectCopy} WHERE c.direction='outbound' AND c.peer=? AND c.state='expired'
        AND NOT EXISTS (SELECT 1 FROM intercom_notices n WHERE n.id=c.id AND n.kind='expiry')
        AND NOT EXISTS (SELECT 1 FROM intercom_copies i WHERE i.direction='inbound' AND i.id=c.id) ORDER BY c.id`).all(peer) as CopyRow[];
      return rows.map(row => ({ identity: readIdentity(row), outcomeKnown: row.unknown_outcome === 0 }));
    },
    inspectBlockers(address): FederationBlockers {
      ensureCheckpoint();
      if (!isSessionAddress(address)) throw new Error("Invalid intercom address");
      const key = addressKey(address);
      const rows = db.prepare(`${selectCopy} WHERE json_extract(m.from_key,'$[1]')=? OR m.to_key=? ORDER BY m.from_key,m.to_key,m.pair_sequence,c.direction`).all(key, key) as CopyRow[];
      const asks = new Map<string, FederationBlockers["asks"][number]>(), pendingIds = new Set<string>(), unknownIds = new Set<string>(), receiptIds = new Set<string>();
      for (const row of rows) {
        const identity = readIdentity(row);
        if (row.is_ask && row.ask_state === "open") asks.set(row.id, { id: row.id, from: identity.from, to: identity.to });
        if (row.state === "queued" && row.payload_json !== null && (row.direction === "inbound" || row.ack_kind !== "message")) pendingIds.add(row.id);
        if (row.unknown_outcome) unknownIds.add(row.id);
        if (row.direction === "outbound" && row.state === "queued" && row.ack_kind === "message") receiptIds.add(row.id);
      }
      const receipts = db.prepare(`SELECT DISTINCT r.id FROM intercom_receipts r JOIN intercom_messages m ON m.id=r.id
        WHERE r.acknowledged=0 AND (json_extract(m.from_key,'$[1]')=? OR m.to_key=?) ORDER BY r.id`).all(key, key) as { id: string }[];
      for (const row of receipts) receiptIds.add(row.id);
      return { asks: [...asks.values()], pendingDispatch: [...pendingIds], unknownOutcomes: [...unknownIds], unobservedReceipts: [...receiptIds] };
    },
    rebindInboundAfterAbsence(id: string, endpoint: SessionEndpoint): void {
      ensureCheckpoint();
      if (!nonempty(id) || !isSessionEndpoint(endpoint) || !isMachineId(endpoint.machineId)) throw new Error("Invalid intercom local rebind");
      db.raw.transaction(() => {
        const incoming = copy("inbound", id);
        if (!incoming || incoming.state !== "queued" || incoming.unknown_outcome || incoming.payload_json === null) throw new Error("Intercom rebind lacks absence proof");
        const previous = readEndpoint(incoming), receipt = incoming.reconciliation_json ? parseStored<MessageReceipt>(incoming.reconciliation_json) : null;
        const neverDispatched = incoming.readiness === null;
        const absent = receipt?.status === "not_injected" && receipt.evidence?.kind === "absence" &&
          receipt.evidence.sessionId === previous.address.sessionId && receipt.evidence.activationEpoch === previous.activationEpoch &&
          receipt.evidence.excludedGeneration === previous.activationEpoch && receipt.evidence.complete === true;
        if (!sameAddress(previous.address, endpoint.address) || previous.machineId !== endpoint.machineId ||
            previous.homeEpoch !== endpoint.homeEpoch && !(previous.homeEpoch === null && endpoint.homeEpoch !== null) ||
            previous.activationEpoch === endpoint.activationEpoch || !neverDispatched && !absent) throw new Error("Intercom rebind lacks absence proof");
        const outbound = copy("outbound", id);
        if (endpoint.machineId !== options.machineId && (!outbound || outbound.peer === options.machineId || !sameEndpoint(readEndpoint(outbound), endpoint))) {
          throw new Error("Intercom relay route lacks rebind proof");
        }
        if (outbound && outbound.peer === options.machineId) {
          const proof = outbound.reconciliation_json ? parseStored<MessageReceipt>(outbound.reconciliation_json) : null;
          if (outbound.state !== "queued" || outbound.unknown_outcome || !sameEndpoint(readEndpoint(outbound), previous) ||
              !neverDispatched && (proof?.status !== "not_injected" || proof.evidence?.kind !== "absence" || proof.evidence.excludedGeneration !== previous.activationEpoch)) {
            throw new Error("Intercom local source lacks absence proof");
          }
          db.prepare(`UPDATE intercom_copies SET endpoint_json=?,ack_kind='message',sent_kind='message',transmitted=1,readiness=NULL,
            attempt=0,observed_attempt=0,reconciliation_json=NULL,reconciliation_attempt=NULL,pending_proof_json=NULL,pending_proof_attempt=NULL
            WHERE direction='outbound' AND id=?`).run(JSON.stringify(endpoint), id);
        }
        aliasEndpoint(incoming);
        db.prepare(`UPDATE intercom_copies SET endpoint_json=?,readiness=NULL,attempt=0,observed_attempt=0,reconciliation_json=NULL,
          reconciliation_attempt=NULL,pending_proof_json=NULL,pending_proof_attempt=NULL WHERE direction='inbound' AND id=?`).run(JSON.stringify(endpoint), id);
      }).immediate();
    },
    rebindUndispatched(address: SessionAddress, endpoint: SessionEndpoint, proof: RebindProof, edgeEpoch = "local"): number {
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
        const pairs = new Map<string, { identity: IntercomIdentity; origin: string | undefined; last: number; firstPending: number | null }>();
        for (const row of rows) {
          const current = pairs.get(row.from_key), identity = readIdentity(row);
          const pendingSequence = candidates.includes(row) ? row.pair_sequence : null;
          if (!current) pairs.set(row.from_key, { identity, origin: readOrigin(row), last: row.pair_sequence, firstPending: pendingSequence });
          else {
            current.last = Math.max(current.last, row.pair_sequence);
            if (pendingSequence !== null) current.firstPending = current.firstPending === null ? pendingSequence : Math.min(current.firstPending, pendingSequence);
          }
        }
        for (const { identity, origin, last, firstPending } of pairs.values()) {
          const resume: IntercomPairResume = { from: identity.from, to: identity.to, through: firstPending === null ? last : firstPending - 1, endpoint, proof };
          if (Buffer.byteLength(JSON.stringify(resume), "utf8") + 1 > INTERCOM_EXCHANGE_BYTES - 1024) throw new Error("Intercom resume size limit exceeded");
          db.prepare(`INSERT INTO intercom_resumptions(from_key,to_key,peer,edge_epoch,resume_json) VALUES(?,?,?,?,?)
            ON CONFLICT(peer,edge_epoch,from_key,to_key) DO UPDATE SET resume_json=excluded.resume_json`)
            .run(streamKey(origin, identity.from), addressKey(identity.to), proof.nextHop, edgeEpoch, JSON.stringify(resume));
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
        pendingProof = receiptWithStream(row, { from: endpoint, to: identity.from, digest: identity.digest,
          receipt: parseStored<MessageReceipt>(row.pending_proof_json) }, row.pending_proof_attempt);
      }
      const originMachineId = readOrigin(row);
      const receipt = row.receipt_json ? parseStored<MessageReceipt>(row.receipt_json) : null;
      return { identity, endpoint, peer: row.peer, ...(originMachineId ? { originMachineId } : {}), state: row.state, payloadRetained: row.payload_json !== null,
        ...(receipt?.detail ? { failureReason: receipt.detail } : {}), linkAcknowledged: row.ack_kind === currentKind(row), latestAttempt: row.observed_attempt,
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
