import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { applyBatch } from "@spider/db-core/roam/apply";
import { assertBatchHeader, assertRecordChange, HARD_BATCH_BYTES, parseRoamJson, storeScope, validateBatch } from "@spider/db-core/roam/codec";
import { validUnicode } from "@spider/db-core/roam/hlc";
import { exportBatch } from "@spider/db-core/roam/export";
import { enableMemoryCapture } from "@spider/db-core/roam/seed";
import type { ApplyReceipt, BatchArtifact, BatchHeader, Home, JsonObject, StoreKey } from "@spider/db-core/roam/types";
import type { AgentPorts, ArtifactManifest, Limits, Operation, Outcome } from "./contracts";
import { createManifestPages, handleArtifactRequest, stageArtifact } from "./artifacts";
import { isMachineId } from "./machine-id";
import { acquireTransferLease, artifactId, defaultStagingRoot, hash, manifestDigest, openOutgoingStaging, openStaging, readPrivate, sourceChunk, StagingFullError } from "./staging";
import type { StagingStore } from "./staging";

type ImportRequest = { kind: "import"; key: StoreKey; sourceMachine: string; transferId: string;
  artifact: string; sha256: string; header: BatchHeader };
type ExportRequest = { kind: "export"; key: StoreKey; after: number; targetBytes: number; batchId: string };
type AssembleRequest = { kind: "assemble"; sourceMachine: string; transferId: string; artifact: string; sha256: string };
type Request = { kind: "inventory"; key: StoreKey } | { kind: "enable-capture"; key: StoreKey } | ImportRequest | ExportRequest | AssembleRequest
  | { kind: "split"; artifact: string; digest: string; head: string; pageBytes: number; index: number }
  | { kind: "cursor"; key: StoreKey; sourceMachine: string; stream: string }
  | { kind: "receipt"; key: StoreKey; sourceMachine: string; batchId: string };
type Store = ReturnType<AgentPorts["openStore"]>;
type ReceiptRow = { peer_stream: string; after_seq: number; through_seq: number; sha256: string };
class PendingOperation extends Error {}

function outcome(code: 0 | 1 | 2 | 3, reason: string, operationId: string, value: JsonObject | null = null): Outcome<JsonObject> {
  return { code, reason, operationId, home: null, epoch: null, repairCommand: null, value };
}
function storeKey(value: unknown): StoreKey {
  storeScope(value);
  return value as StoreKey;
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function fields(args: JsonObject, names: readonly string[]): void {
  if (Object.keys(args).length !== names.length || names.some(name => !(name in args))) throw new Error("Invalid agent arguments");
}
function enrolledSource(machine: unknown, ports: AgentPorts): machine is string {
  return isMachineId(machine) && machine !== ports.config.machineId &&
    (ports.config.role === "box" ? machine === ports.config.hubMachineId : ports.config.peers.some(peer => peer.machineId === machine));
}
function parseRequest(operation: Operation, ports: AgentPorts): Request {
  if (!operation || typeof operation !== "object" || !operation.args || typeof operation.args !== "object" || Array.isArray(operation.args) ||
      operation.machineId !== ports.config.machineId || !isMachineId(operation.machineId) || operation.expectedEpoch !== null) {
    throw new Error("Invalid agent operation");
  }
  artifactId(operation.id);
  const args = operation.args;
  if (operation.kind === "inventory" || operation.kind === "enable-capture") {
    fields(args, ["storeKey"]);
    const key = storeKey(args.storeKey);
    if (operation.kind === "enable-capture" && storeScope(key) === "worktree") throw new Error("Invalid memory store");
    return { kind: operation.kind, key };
  }
  if (operation.kind === "export") {
    fields(args, ["storeKey", "after", "targetBytes", "batchId"]);
    if (typeof args.after !== "number" || !Number.isSafeInteger(args.after) || args.after < 0 ||
        typeof args.targetBytes !== "number" || !Number.isSafeInteger(args.targetBytes) || args.targetBytes < 1 ||
        args.targetBytes > ports.config.limits.hardBatchBytes || !validUnicode(args.batchId) || !args.batchId) {
      throw new Error("Invalid export request");
    }
    return { kind: "export", key: storeKey(args.storeKey), after: args.after, targetBytes: args.targetBytes, batchId: args.batchId };
  }
  if (operation.kind === "split") {
    fields(args, ["artifactId", "manifestDigest", "head", "pageBytes", "index"]);
    if (typeof args.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(args.manifestDigest) ||
        typeof args.head !== "string" || !/^[a-f0-9]{64}$/.test(args.head) ||
        typeof args.pageBytes !== "number" || !Number.isSafeInteger(args.pageBytes) || args.pageBytes < 1 ||
        args.pageBytes > pageLimits(ports.config.limits).manifestBytes ||
        typeof args.index !== "number" || !Number.isSafeInteger(args.index) || args.index < 0) throw new Error("Invalid manifest page request");
    return { kind: "split", artifact: artifactId(args.artifactId), digest: args.manifestDigest,
      head: args.head, pageBytes: args.pageBytes, index: args.index };
  }
  if (operation.kind === "assemble") {
    fields(args, ["sourceMachine", "transferId", "artifactId", "sha256"]);
    if (!enrolledSource(args.sourceMachine, ports) || typeof args.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.sha256)) {
      throw new Error("Invalid assembly request");
    }
    return { kind: "assemble", sourceMachine: args.sourceMachine, transferId: artifactId(args.transferId),
      artifact: artifactId(args.artifactId), sha256: args.sha256 };
  }
  if (operation.kind === "cursor") {
    fields(args, ["storeKey", "sourceMachine", "stream"]);
    if (!enrolledSource(args.sourceMachine, ports) || !isMachineId(args.stream)) throw new Error("Invalid cursor identity");
    return { kind: "cursor", key: storeKey(args.storeKey), sourceMachine: args.sourceMachine, stream: args.stream };
  }
  if (operation.kind === "receipt") {
    fields(args, ["storeKey", "sourceMachine", "batchId"]);
    if (!enrolledSource(args.sourceMachine, ports) || !validUnicode(args.batchId) || !args.batchId) throw new Error("Invalid receipt identity");
    return { kind: "receipt", key: storeKey(args.storeKey), sourceMachine: args.sourceMachine, batchId: args.batchId };
  }
  if (operation.kind === "import") {
    fields(args, ["storeKey", "sourceMachine", "transferId", "artifactId", "sha256", "header"]);
    const key = storeKey(args.storeKey);
    if (!enrolledSource(args.sourceMachine, ports) || typeof args.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.sha256)) {
      throw new Error("Invalid import identity or digest");
    }
    assertBatchHeader(args.header);
    if (args.header.storeKey !== key || args.header.senderMachine !== args.sourceMachine || args.header.count === 0) {
      throw new Error("Invalid import header");
    }
    return { kind: "import", key, sourceMachine: args.sourceMachine, transferId: artifactId(args.transferId),
      artifact: artifactId(args.artifactId), sha256: args.sha256, header: args.header };
  }
  throw new Error("Invalid agent operation kind");
}
function openStore(ports: AgentPorts, key: StoreKey, allowUnassigned = false): Store {
  const store = ports.openStore(key);
  if (Number(store.db.pragma("user_version")) !== 14) throw new Error("Unsupported store schema");
  const meta = store.db.prepare("SELECT machine_id, store_key FROM roam_meta WHERE id = 1")
    .get() as { machine_id: string; store_key: string | null } | undefined;
  if (!meta || meta.machine_id !== ports.config.machineId ||
      (meta.store_key !== key && !(allowUnassigned && meta.store_key === null))) throw new Error("Store identity does not match");
  return store;
}
function inventory(ports: AgentPorts, key: StoreKey): JsonObject {
  const { db } = openStore(ports, key);
  const meta = db.prepare("SELECT machine_id, stream_id, capture_enabled, roamable FROM roam_meta WHERE id = 1")
    .get() as { machine_id: string; stream_id: string; capture_enabled: number; roamable: number };
  const through = (db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM roam_changes").get() as { seq: number }).seq;
  if (!isMachineId(meta.stream_id) || !Number.isSafeInteger(through) || through < 0) throw new Error("Invalid store inventory");
  return { protocol: 1, schema: 14, machineId: meta.machine_id, storeKey: key, stream: meta.stream_id,
    through, captureEnabled: meta.capture_enabled === 1, roamable: meta.roamable === 1 };
}
function receiptRow(db: Store["db"], machine: string, batchId: string): ReceiptRow | undefined {
  const row = db.prepare("SELECT peer_stream, after_seq, through_seq, sha256 FROM roam_receipts WHERE peer_machine = ? AND batch_id = ?")
    .get(machine, batchId) as ReceiptRow | undefined;
  if (!row) return undefined;
  const cursor = db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
    .get(machine, row.peer_stream) as { last_seq: number } | undefined;
  if (!isMachineId(row.peer_stream) || !Number.isSafeInteger(row.after_seq) || !Number.isSafeInteger(row.through_seq) ||
      row.after_seq < 0 || row.through_seq <= row.after_seq || !/^[a-f0-9]{64}$/.test(row.sha256) ||
      !cursor || !Number.isSafeInteger(cursor.last_seq) || cursor.last_seq < row.through_seq) {
    throw new Error("Durable receipt has no committed cursor");
  }
  return row;
}
function receipt(db: Store["db"], request: ImportRequest): ApplyReceipt | null {
  const row = receiptRow(db, request.sourceMachine, request.header.batchId);
  if (!row) return null;
  if (row.peer_stream !== request.header.senderStream || row.after_seq !== request.header.after ||
      row.through_seq !== request.header.through || row.sha256 !== request.sha256) throw new Error("Conflicting durable batch receipt");
  return { batchId: request.header.batchId, stream: row.peer_stream, through: row.through_seq, sha256: row.sha256, applyMs: null };
}
function receiptValue(value: ApplyReceipt): JsonObject {
  return { batchId: value.batchId, stream: value.stream, through: value.through, sha256: value.sha256, applyMs: value.applyMs };
}
function successBound(operation: Operation, request: Request, ports: AgentPorts): JsonObject | null {
  if (request.kind === "enable-capture") return { storeKey: request.key, enabled: true };
  if (request.kind === "assemble") return { artifactId: request.artifact, sha256: request.sha256, byteLength: Number.MAX_SAFE_INTEGER };
  if (request.kind === "import") return { batchId: request.header.batchId, stream: request.header.senderStream,
    through: request.header.through, sha256: request.sha256, applyMs: Number.MAX_VALUE };
  if (request.kind !== "export") return null;
  const max = Number.MAX_SAFE_INTEGER, digest = "f".repeat(64);
  return { header: { protocol: 1, schema: 14, batchId: request.batchId, senderMachine: ports.config.machineId,
    senderStream: ports.config.machineId, storeKey: request.key, after: request.after, through: max, count: max },
    artifact: { id: operation.id, kind: "batch", byteLength: max, sha256: digest, manifestDigest: digest,
      head: digest, pageBytes: max, pageCount: max } };
}
function sessionHome(ports: AgentPorts, id: string): Home | null | "unknown" {
  try {
    const { db } = openStore(ports, "global");
    const row = db.prepare("SELECT machine_id, epoch, move_id, updated_at FROM session_homes WHERE session_id = ?")
      .get(id) as { machine_id: string; epoch: number; move_id: string | null; updated_at: number } | undefined;
    if (!row || row.machine_id === "") return null;
    return { sessionId: id, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at };
  } catch { return "unknown"; }
}
function pageLimits(limits: Limits): Limits {
  const envelope = outcome(0, "complete", "x".repeat(128), { page: null });
  const overhead = Buffer.byteLength(JSON.stringify(envelope)) - Buffer.byteLength("null");
  const available = limits.replyBytes - overhead;
  if (!Number.isSafeInteger(available) || available <= 0) throw new Error("Reply limit is too small for a manifest page");
  return { ...limits, manifestBytes: Math.min(limits.manifestBytes, available) };
}
function snapshot(result: JsonObject, request: ExportRequest, store: Store, ports: AgentPorts): BatchArtifact {
  if (typeof result.file !== "string" || typeof result.byteLength !== "number" || !Number.isSafeInteger(result.byteLength) ||
      result.byteLength < 1 || typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.sha256)) {
    throw new Error("Invalid saved export snapshot");
  }
  assertBatchHeader(result.header);
  const header = result.header;
  const directory = join(dirname(resolve(store.db.raw.name)), ".roam-batches");
  if (dirname(resolve(result.file)) !== directory ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ndjson$/.test(basename(result.file)) ||
      header.storeKey !== request.key || header.batchId !== request.batchId || header.after !== request.after ||
      header.senderMachine !== ports.config.machineId) throw new Error("Conflicting saved export snapshot");
  return { file: result.file, byteLength: result.byteLength, sha256: result.sha256, header };
}
function outgoingManifest(ports: AgentPorts, id: string): ArtifactManifest | null {
  if (!existsSync(join(ports.root, "outgoing", "quota.db"))) return null;
  const staging = openOutgoingStaging(ports.root, ports.config.limits, false);
  try { return staging.inspect(id).current; } finally { staging.close(); }
}
function verifyOutgoing(ports: AgentPorts, manifest: ArtifactManifest): void {
  for (const chunk of manifest.chunks) {
    const bytes = readPrivate(sourceChunk(ports.root, manifest.id, chunk.index, chunk.sha256), chunk.rawLength);
    if (bytes.length !== chunk.rawLength || hash(bytes) !== chunk.sha256) throw new Error("Corrupt outgoing artifact");
  }
}
async function exportValue(operation: Operation, request: ExportRequest, ports: AgentPorts): Promise<JsonObject> {
  const store = openStore(ports, request.key);
  let saved = ports.journal.read(operation.id).find(action => action.action === "export-snapshot");
  if (!saved) {
    const batch = await exportBatch(store.db, { after: request.after, targetBytes: request.targetBytes, batchId: request.batchId }, store.policy);
    try {
      ports.journal.record(operation.id, "export-snapshot", { file: batch.file, byteLength: batch.byteLength,
        sha256: batch.sha256, header: { ...batch.header } });
    } catch { throw new PendingOperation("Export snapshot is pending reconciliation"); }
    saved = ports.journal.read(operation.id).find(action => action.action === "export-snapshot");
  }
  if (!saved) throw new Error("Export snapshot was not recorded");
  const batch = snapshot(saved.result, request, store, ports);
  if (batch.byteLength > ports.config.limits.hardBatchBytes) {
    if (batch.header.count === 1) {
      const bytes = readPrivate(batch.file, HARD_BATCH_BYTES);
      if (bytes.length !== batch.byteLength || hash(bytes) !== batch.sha256) throw new Error("Export snapshot changed");
      const line = bytes.toString("utf8").split("\n")[1];
      const record = parseRoamJson(line);
      assertRecordChange(record, request.key);
      throw new Error(`Roaming row ${record.entity}/${record.rowKey} exceeds the configured batch limit`);
    }
    throw new Error("Export exceeds the configured batch limit");
  }
  if (batch.header.count === 0) return { header: { ...batch.header }, artifact: null };
  let manifest = outgoingManifest(ports, operation.id);
  if (manifest) {
    if (manifest.kind !== "batch" || manifest.byteLength !== batch.byteLength || manifest.sha256 !== batch.sha256) {
      throw new Error("Conflicting outgoing export artifact");
    }
    verifyOutgoing(ports, manifest);
  } else {
    const bytes = readPrivate(batch.file, ports.config.limits.hardBatchBytes);
    if (bytes.length !== batch.byteLength || hash(bytes) !== batch.sha256) throw new Error("Export snapshot changed");
    manifest = await stageArtifact(batch.file, "batch", ports.config.limits, { root: ports.root, artifactId: operation.id });
    if (manifest.byteLength !== batch.byteLength || manifest.sha256 !== batch.sha256) throw new Error("Export snapshot changed during staging");
  }
  const limits = pageLimits(ports.config.limits);
  const pages = createManifestPages(manifest, limits);
  return { header: { ...batch.header }, artifact: { id: manifest.id, kind: manifest.kind, byteLength: manifest.byteLength,
    sha256: manifest.sha256, manifestDigest: manifestDigest(manifest), head: pages.head,
    pageBytes: limits.manifestBytes, pageCount: pages.pages.length } };
}
function verifyExportResult(operation: Operation, request: ExportRequest, ports: AgentPorts, value: JsonObject): void {
  assertBatchHeader(value.header);
  if (value.header.storeKey !== request.key || value.header.batchId !== request.batchId ||
      value.header.senderMachine !== ports.config.machineId || value.header.after !== request.after) throw new Error("Conflicting export evidence");
  if (value.header.count === 0) {
    if (value.artifact !== null) throw new Error("Conflicting empty export evidence");
    return;
  }
  const artifact = value.artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || artifact.id !== operation.id ||
      typeof artifact.manifestDigest !== "string" || typeof artifact.pageBytes !== "number" ||
      !Number.isSafeInteger(artifact.pageBytes) || artifact.pageBytes < 1) throw new Error("Invalid export evidence");
  const manifest = outgoingManifest(ports, operation.id);
  if (!manifest || manifest.kind !== "batch" || manifestDigest(manifest) !== artifact.manifestDigest ||
      manifest.sha256 !== artifact.sha256 || manifest.byteLength !== artifact.byteLength) throw new Error("Missing export artifact");
  verifyOutgoing(ports, manifest);
  const limits = pageLimits(ports.config.limits);
  if (artifact.pageBytes > limits.manifestBytes) throw new Error("Export page limit changed");
  const pages = createManifestPages(manifest, { ...limits, manifestBytes: artifact.pageBytes });
  if (pages.head !== artifact.head || pages.pages.length !== artifact.pageCount) throw new Error("Conflicting export pages");
}
function cleanupSnapshot(operation: Operation, request: ExportRequest, ports: AgentPorts): void {
  try {
    const saved = ports.journal.read(operation.id).filter(action => action.action === "export-snapshot");
    const store = openStore(ports, request.key);
    for (const action of saved) {
      try {
        const batch = snapshot(action.result, request, store, ports);
        const bytes = readPrivate(batch.file, batch.byteLength);
        if (bytes.length === batch.byteLength && hash(bytes) === batch.sha256) unlinkSync(batch.file);
      } catch { /* Keep any snapshot whose path or content cannot be verified. */ }
    }
  } catch { /* A committed export does not depend on temporary-file cleanup. */ }
}
function splitValue(ports: AgentPorts, request: Extract<Request, { kind: "split" }>): JsonObject {
  const staging = openOutgoingStaging(ports.root, ports.config.limits, false);
  let manifest: ArtifactManifest | null;
  try { manifest = staging.get(request.artifact, request.digest); } finally { staging.close(); }
  if (!manifest) throw new Error("Outgoing artifact is not committed");
  const pages = createManifestPages(manifest, { ...pageLimits(ports.config.limits), manifestBytes: request.pageBytes });
  if (pages.head !== request.head || request.index >= pages.pages.length) throw new Error("Invalid manifest page digest or index");
  return { page: JSON.parse(pages.pages[request.index].toString("utf8")) as JsonObject };
}
function assembleValue(ports: AgentPorts, request: AssembleRequest): JsonObject | null {
  const release = acquireTransferLease(ports.root, request.sourceMachine, ports.config.limits.peerConcurrency);
  if (!release) return null;
  try {
    const staging = openStaging(ports.root, request.sourceMachine, ports.config.limits);
    try {
      const manifest = staging.manifestFor(request.transferId);
      if (manifest.id !== request.artifact || manifest.sha256 !== request.sha256) throw new Error("Conflicting staged artifact");
      staging.assemble(manifest);
      return { artifactId: manifest.id, sha256: manifest.sha256, byteLength: manifest.byteLength };
    } finally { staging.close(); }
  } finally { release(); }
}
function cleanReceipt(staging: StagingStore, request: ImportRequest, store: Store): void {
  const manifest = staging.manifestFor(request.transferId);
  if (manifest.id !== request.artifact || manifest.sha256 !== request.sha256 || manifest.kind !== "batch") {
    throw new Error("Conflicting staged artifact");
  }
  if (!receipt(store.db, request)) throw new Error("Durable receipt is missing");
  staging.release(manifest.id, request.transferId);
  staging.removeAfterReceipt(manifest, { artifactId: manifest.id, sha256: manifest.sha256 }, () => receipt(store.db, request) !== null);
}
function retryCleanup(ports: AgentPorts, request: ImportRequest): void {
  let release: (() => void) | null = null;
  try {
    if (!existsSync(join(ports.root, "incoming", request.sourceMachine, "quota.db"))) return;
    release = acquireTransferLease(ports.root, request.sourceMachine, ports.config.limits.peerConcurrency);
    if (!release) return;
    const staging = openStaging(ports.root, request.sourceMachine, ports.config.limits);
    try { cleanReceipt(staging, request, openStore(ports, request.key)); } finally { staging.close(); }
  } catch { /* Retain evidence if cleanup or receipt verification fails. */ }
  finally { try { release?.(); } catch { /* Cleanup cannot change a committed result. */ } }
}
function commitImport(operation: Operation, ports: AgentPorts, committed: ApplyReceipt): Outcome<JsonObject> {
  const value = receiptValue(committed);
  try { ports.journal.record(operation.id, "done", { value }); }
  catch { return outcome(3, "Operation result is pending reconciliation", operation.id); }
  return outcome(0, "complete", operation.id, value);
}
async function importBatch(operation: Operation, request: ImportRequest, ports: AgentPorts): Promise<Outcome<JsonObject>> {
  const store = openStore(ports, request.key);
  const prior = receipt(store.db, request);
  if (prior) {
    const result = commitImport(operation, ports, prior);
    if (result.code === 0) retryCleanup(ports, request);
    return result;
  }
  const release = acquireTransferLease(ports.root, request.sourceMachine, ports.config.limits.peerConcurrency);
  if (!release) return outcome(3, "Artifact transfer is waiting for a peer slot", operation.id);
  try {
    let committed = receipt(store.db, request);
    if (committed) {
      const result = commitImport(operation, ports, committed);
      if (result.code === 0) {
        try {
          const staging = openStaging(ports.root, request.sourceMachine, ports.config.limits);
          try { cleanReceipt(staging, request, store); } finally { staging.close(); }
        } catch { /* Retain evidence when cleanup is unavailable. */ }
      }
      return result;
    }
    const staging = openStaging(ports.root, request.sourceMachine, ports.config.limits);
    try {
      const manifest = staging.manifestFor(request.transferId);
      if (manifest.id !== request.artifact || manifest.sha256 !== request.sha256 || manifest.kind !== "batch") {
        throw new Error("Conflicting staged artifact");
      }
      for (const action of ports.journal.read(operation.id)) {
        if (action.action !== "validation-attempt" || typeof action.result.attemptId !== "string") continue;
        try { staging.cancelValidationCopy(manifest, action.result.attemptId, () => true); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "Validation reservation is missing") throw error;
        }
      }
      const attemptId = randomUUID();
      ports.journal.record(operation.id, "validation-attempt", { attemptId });
      let reserved = false;
      try {
        const input = staging.reserveValidationCopy(manifest, attemptId);
        reserved = true;
        const now = Date.now();
        const validated = await validateBatch({ file: input, byteLength: manifest.byteLength, sha256: manifest.sha256, header: request.header },
          { storeKey: request.key, senderMachine: request.sourceMachine, senderStream: request.header.senderStream, now });
        const file = staging.promoteValidationCopy(manifest, attemptId, validated.file);
        reserved = false;
        committed = applyBatch(store.db, { ...validated, file }, { hubMachine: ports.config.hubMachineId, effects: store.effects,
          now, sessionHome: id => sessionHome(ports, id) });
      } catch (error) {
        if (reserved) staging.cancelValidationCopy(manifest, attemptId, () => true);
        throw error;
      }
      const result = commitImport(operation, ports, committed);
      if (result.code === 0) {
        try { cleanReceipt(staging, request, store); }
        catch { /* The receipt is durable. Retain anything that cannot be verified or released. */ }
      }
      return result;
    } finally { staging.close(); }
  } finally { release(); }
}

/** Production callers share the default staging root. Tests may inject an isolated root. */
export function createAgentPorts(ports: Omit<AgentPorts, "root">): AgentPorts {
  return { ...ports, root: defaultStagingRoot() };
}

function artifactFailure(ports: AgentPorts, code: 1 | 2 | 3, reason: string): Buffer {
  const bytes = Buffer.from(JSON.stringify({ code, reason }));
  if (bytes.length > ports.config.limits.replyBytes) throw new Error("Artifact reply exceeds its limit");
  return bytes;
}

/** Route the internal artifact argv while leaving the byte payload untouched. */
export async function dispatchArtifactCommand(
  argv: readonly string[], stdin: Buffer | undefined, sourceMachine: string, ports: AgentPorts,
): Promise<Buffer> {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "roam" || argv[1] !== "artifact" || argv[2] !== "receive" ||
      typeof argv[3] !== "string" || Buffer.byteLength(argv[3]) > ports.config.limits.replyBytes) {
    return artifactFailure(ports, 2, "Invalid artifact command");
  }
  let input: unknown;
  try { input = parseRoamJson(argv[3]); }
  catch { return artifactFailure(ports, 2, "Invalid artifact command"); }
  return handleAgentArtifactRequest(input, stdin, sourceMachine, ports);
}

/** The source identity comes from the authenticated caller, never the request body. */
export async function handleAgentArtifactRequest(
  input: unknown, stdin: Buffer | undefined, sourceMachine: string, ports: AgentPorts,
): Promise<Buffer> {
  const reply = (code: 1 | 2 | 3, reason: string) => artifactFailure(ports, code, reason);
  if (!input || typeof input !== "object" || Array.isArray(input) || !enrolledSource(sourceMachine, ports)) {
    return reply(2, "Invalid artifact request");
  }
  const operation = (input as { operation?: Operation }).operation;
  if (!operation || operation.machineId !== ports.config.machineId || operation.expectedEpoch !== null || operation.kind !== "artifact-transfer") {
    return reply(2, "Invalid artifact operation");
  }
  let release: (() => void) | null = null;
  try {
    release = acquireTransferLease(ports.root, sourceMachine, ports.config.limits.peerConcurrency);
    if (!release) return reply(3, "Artifact transfer is waiting for a peer slot");
    const store = openStaging(ports.root, sourceMachine, ports.config.limits);
    try {
      const response = await handleArtifactRequest(input, stdin, { store, journal: ports.journal, machineId: ports.config.machineId, limits: ports.config.limits });
      const decoded = JSON.parse(response.toString("utf8")) as { code?: unknown; reason?: unknown };
      if (decoded.code === 1 && typeof decoded.reason === "string" && decoded.reason.startsWith("Staging full (quota) at ")) {
        return reply(3, decoded.reason);
      }
      return response;
    } finally { store.close(); }
  } catch (error) {
    if (error instanceof StagingFullError) return reply(3, error.message);
    return reply(1, "Artifact request failed");
  } finally { release?.(); }
}

/** Dispatch a local operation after reserving its immutable arguments. */
export async function handleAgentOperation(operation: Operation, ports: AgentPorts): Promise<Outcome<JsonObject>> {
  const limit = ports.config.limits.replyBytes;
  if (!Number.isSafeInteger(limit) || limit < Buffer.byteLength(JSON.stringify(outcome(1, "", "")))) {
    throw new Error("Reply limit is too small for an agent outcome");
  }
  const result = await dispatchAgentOperation(operation, ports);
  if (Buffer.byteLength(JSON.stringify(result)) <= limit) return result;
  const code = result.code === 0 ? 1 : result.code;
  for (const [reason, id] of [["Reply exceeds its limit", result.operationId], ["Reply too small", ""], ["", ""]]) {
    const failure = outcome(code, reason, id);
    if (Buffer.byteLength(JSON.stringify(failure)) <= limit) return failure;
  }
  throw new Error("Reply limit is too small for an agent outcome");
}

async function dispatchAgentOperation(operation: Operation, ports: AgentPorts): Promise<Outcome<JsonObject>> {
  let id = "";
  let request: Request;
  try {
    if (!plainObject(operation) || !plainObject(operation.args) ||
        ("header" in operation.args && !plainObject(operation.args.header))) throw new Error("Invalid operation object");
    operation = structuredClone(operation);
    id = artifactId(operation.id);
    request = parseRequest(operation, ports);
  } catch { return outcome(2, "Invalid agent operation", id); }
  let entry: ReturnType<AgentPorts["journal"]["begin"]>;
  try { entry = ports.journal.begin(operation); }
  catch (error) {
    const invalid = error instanceof Error && /invalid operation|different arguments/i.test(error.message);
    return outcome(invalid ? 2 : 1, invalid ? "Invalid or conflicting operation arguments" : "Operation journal unavailable", id);
  }
  if (entry.kind === "done") {
    const value = entry.result?.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return outcome(1, "Invalid committed operation result", id);
    if (request.kind === "import" && (value.batchId !== request.header.batchId || value.stream !== request.header.senderStream ||
        value.through !== request.header.through || value.sha256 !== request.sha256 ||
        !(value.applyMs === null || typeof value.applyMs === "number" && Number.isFinite(value.applyMs) && value.applyMs >= 0))) {
      return outcome(1, "Invalid committed import result", id);
    }
    const result = outcome(0, "complete", id, value);
    if (Buffer.byteLength(JSON.stringify(result)) > ports.config.limits.replyBytes) return outcome(1, "Reply exceeds its limit", id);
    if (request.kind === "import") retryCleanup(ports, request);
    if (request.kind === "assemble") {
      try {
        const available = assembleValue(ports, request);
        if (!available || available.artifactId !== value.artifactId || available.sha256 !== value.sha256 ||
            available.byteLength !== value.byteLength) return outcome(3, "Committed assembly is unavailable", id);
      } catch { return outcome(3, "Committed assembly is unavailable", id); }
    }
    if (request.kind === "export") {
      try { verifyExportResult(operation, request, ports, value); }
      catch { return outcome(3, "Committed export artifact is unavailable", id); }
      cleanupSnapshot(operation, request, ports);
    }
    return result;
  }
  const bound = successBound(operation, request, ports);
  if (bound && Buffer.byteLength(JSON.stringify(outcome(0, "complete", id, bound))) > ports.config.limits.replyBytes) {
    return outcome(2, "Reply limit is too small", id);
  }
  try {
    if (request.kind === "import") return await importBatch(operation, request, ports);
    let value: JsonObject;
    if (request.kind === "inventory") value = inventory(ports, request.key);
    else if (request.kind === "enable-capture") {
      enableMemoryCapture(openStore(ports, request.key, true).db, request.key);
      value = { storeKey: request.key, enabled: true };
    } else if (request.kind === "export") value = await exportValue(operation, request, ports);
    else if (request.kind === "split") value = splitValue(ports, request);
    else if (request.kind === "assemble") {
      const assembled = assembleValue(ports, request);
      if (!assembled) return outcome(3, "Artifact transfer is waiting for a peer slot", id);
      value = assembled;
    } else if (request.kind === "cursor") {
      const { db } = openStore(ports, request.key);
      const row = db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
        .get(request.sourceMachine, request.stream) as { last_seq: number } | undefined;
      if (row && (!Number.isSafeInteger(row.last_seq) || row.last_seq < 0)) throw new Error("Invalid stored cursor");
      value = { lastSeq: row?.last_seq ?? 0 };
    } else {
      const row = receiptRow(openStore(ports, request.key).db, request.sourceMachine, request.batchId);
      if (!row) return outcome(3, "Receipt is pending", id);
      value = { batchId: request.batchId, stream: row.peer_stream, through: row.through_seq, sha256: row.sha256, applyMs: null };
    }
    if (Buffer.byteLength(JSON.stringify(outcome(0, "complete", id, value))) > ports.config.limits.replyBytes) {
      throw new Error("Agent reply exceeds its limit");
    }
    try { ports.journal.record(id, "done", { value }); }
    catch { return outcome(3, "Operation result is pending reconciliation", id); }
    if (request.kind === "export") cleanupSnapshot(operation, request, ports);
    return outcome(0, "complete", id, value);
  } catch (error) {
    if (error instanceof PendingOperation) return outcome(3, error.message, id);
    if (error instanceof StagingFullError) return outcome(3, error.message, id);
    if (request.kind === "enable-capture" && error instanceof Error && error.message.startsWith("Roaming capture is unsafe:")) {
      return outcome(1, "Roaming capture is unsafe for this store", id);
    }
    if (error instanceof Error && (
      /^Roaming todo collision between [A-Za-z0-9._-]{1,128} and [A-Za-z0-9._-]{1,128}$/.test(error.message) ||
      /^Roaming row (?:global_memory|memory|sessions|todos|runs|run_events|session_homes)\/[A-Za-z0-9._-]{1,128} exceeds the (?:hard wire|configured batch) limit$/.test(error.message)
    )) {
      const failure = outcome(1, error.message, id);
      if (Buffer.byteLength(JSON.stringify(failure)) <= ports.config.limits.replyBytes) return failure;
    }
    if (error && typeof error === "object" && "retryable" in error && error.retryable === true) {
      return outcome(3, error instanceof Error ? error.message : "Agent operation is retryable", id);
    }
    return outcome(1, "Agent operation failed", id);
  }
}
