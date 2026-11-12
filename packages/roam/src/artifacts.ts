import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { ArtifactManifest, Journal, Limits, Operation, Outcome, Peer, Transport } from "./contracts";
import { isMachineId } from "./machine-id";
import type { StagingHeader, StagingStore } from "./staging";
import {
  acquireTransferLease, artifactId, defaultStagingRoot, hash, kindLimit, manifestDigest, openOutgoingStaging, openStaging,
  privateIncomingArtifact, privateOutgoingArtifact, readPrivate, sourceChunk, syncStagingAncestors,
  validateManifest, validateStagingHeader, verifyStagedFile,
} from "./staging";

export interface StageOptions { root?: string; artifactId?: string }
export interface ManifestPages { head: string; pages: readonly Buffer[] }

type Chunk = ArtifactManifest["chunks"][number];
type ArtifactHeader = Omit<ArtifactManifest, "chunks">;
type ManifestPage = { version: 1; artifact: ArtifactHeader; index: number; next: string | null; chunks: readonly Chunk[] };

function pageLimit(limits: Limits): number {
  const size = Math.min(limits.manifestBytes, limits.replyBytes);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid manifest page limit");
  return size;
}

/** Encode the manifest in individually bounded pages linked by SHA-256. */
export function createManifestPages(manifest: ArtifactManifest, limits: Limits): ManifestPages {
  validateManifest(manifest, limits);
  const limit = pageLimit(limits);
  const artifact: ArtifactHeader = { id: manifest.id, kind: manifest.kind, byteLength: manifest.byteLength, sha256: manifest.sha256 };
  const groups: Chunk[][] = [];
  let position = 0;
  do {
    const group: Chunk[] = [];
    const template: ManifestPage = { version: 1, artifact, index: groups.length, next: "0".repeat(64), chunks: [] };
    let size = Buffer.byteLength(JSON.stringify(template));
    if (size > limit) throw new Error("Manifest page limit is too small");
    while (position < manifest.chunks.length) {
      const { index, rawLength, sha256 } = manifest.chunks[position];
      const chunk = { index, rawLength, sha256 };
      const added = Buffer.byteLength(JSON.stringify(chunk)) + (group.length ? 1 : 0);
      if (size + added > limit) break;
      group.push(chunk);
      position++;
      size += added;
    }
    if (!group.length && position < manifest.chunks.length) throw new Error("Manifest page limit is too small for a chunk");
    groups.push(group);
  } while (position < manifest.chunks.length);
  const pages: Buffer[] = new Array(groups.length);
  let next: string | null = null;
  for (let index = groups.length - 1; index >= 0; index--) {
    const page: ManifestPage = { version: 1, artifact, index, next, chunks: groups[index] };
    pages[index] = Buffer.from(JSON.stringify(page));
    if (pages[index].length > limit) throw new Error("Manifest page exceeds its limit");
    next = hash(pages[index]);
  }
  return { head: next!, pages };
}

/** Verify the entire linked page sequence before trusting any chunk descriptor. */
export function readManifestPages(head: string, pages: Iterable<Buffer>, limits: Limits): ArtifactManifest {
  const limit = pageLimit(limits);
  if (!/^[a-f0-9]{64}$/.test(head) || !pages || typeof pages[Symbol.iterator] !== "function") throw new Error("Invalid manifest page digest");
  let expected: string | null = head;
  let header: ArtifactHeader | undefined;
  const chunks: Chunk[] = [];
  let index = 0, total = 0;
  for (const bytes of pages) {
    if (!Buffer.isBuffer(bytes) || bytes.length > limit || expected === null || hash(bytes) !== expected) {
      throw new Error("Invalid manifest page digest or size");
    }
    let page: ManifestPage;
    try { page = JSON.parse(bytes.toString("utf8")) as ManifestPage; }
    catch { throw new Error("Invalid manifest page"); }
    if (!page || page.version !== 1 || page.index !== index || !page.artifact || !Array.isArray(page.chunks) ||
        !(page.next === null || typeof page.next === "string" && /^[a-f0-9]{64}$/.test(page.next))) {
      throw new Error("Invalid manifest page");
    }
    if (header && JSON.stringify(header) !== JSON.stringify(page.artifact)) throw new Error("Conflicting manifest page header");
    if (!header) {
      validateManifest({ ...page.artifact, byteLength: 0, chunks: [] }, limits);
      if (!Number.isSafeInteger(page.artifact.byteLength) || page.artifact.byteLength < 0 ||
          page.artifact.byteLength > kindLimit(page.artifact.kind, limits)) throw new Error("Invalid artifact size");
      header = page.artifact;
    }
    for (const chunk of page.chunks) {
      if (!chunk || chunk.index !== chunks.length || !Number.isSafeInteger(chunk.rawLength) || chunk.rawLength <= 0 ||
          chunk.rawLength > limits.chunkBytes || typeof chunk.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(chunk.sha256)) {
        throw new Error("Invalid artifact chunk");
      }
      total += chunk.rawLength;
      if (!Number.isSafeInteger(total) || total > header.byteLength) throw new Error("Invalid artifact size");
      chunks.push({ index: chunk.index, rawLength: chunk.rawLength, sha256: chunk.sha256 });
    }
    expected = page.next;
    index++;
  }
  if (expected !== null || !header) throw new Error("Missing manifest page");
  const manifest: ArtifactManifest = { ...header, chunks };
  validateManifest(manifest, limits);
  return {
    id: manifest.id, kind: manifest.kind, byteLength: manifest.byteLength, sha256: manifest.sha256,
    chunks: manifest.chunks.map(({ index, rawLength, sha256 }) => ({ index, rawLength, sha256 })),
  };
}

function readExact(fd: number, length: number, offset: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let at = 0;
  while (at < length) {
    const count = readSync(fd, bytes, at, length - at, offset + at);
    if (!count) throw new Error("Source artifact changed while staging");
    at += count;
  }
  return bytes;
}

/** Snapshot a file into immutable, private chunks. */
export async function stageArtifact(
  file: string, kind: ArtifactManifest["kind"], limits: Limits, options: StageOptions = {},
): Promise<ArtifactManifest> {
  if (!isAbsolute(file)) throw new Error("Artifact source must be absolute");
  const root = options.root ?? defaultStagingRoot();
  if (!isAbsolute(root)) throw new Error("Staging directory must be absolute");
  const id = artifactId(options.artifactId ?? randomUUID());
  const cap = kindLimit(kind, limits);
  if (!Number.isSafeInteger(cap) || cap <= 0 || !Number.isSafeInteger(limits.chunkBytes) || limits.chunkBytes <= 0) {
    throw new Error("Invalid artifact limits");
  }
  const source = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(source);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size > cap) throw new Error("Artifact exceeds size limit or is not a regular file");
    const store = openOutgoingStaging(root, limits);
    try {
      const { current: previous } = store.inspect(id);
      if (previous && (previous.kind !== kind || before.size < previous.byteLength ||
          kind !== "session" && before.size !== previous.byteLength)) throw new Error("Conflicting artifact ID");
      const chunks: { index: number; rawLength: number; sha256: string }[] = [];
      const whole = createHash("sha256"), prefix = createHash("sha256");
      let prefixRemaining = previous?.byteLength ?? 0;
      for (let offset = 0, index = 0; offset < before.size; index++) {
        const bytes = readExact(source, Math.min(limits.chunkBytes, before.size - offset), offset);
        whole.update(bytes);
        const prefixBytes = Math.min(prefixRemaining, bytes.length);
        if (prefixBytes) prefix.update(bytes.subarray(0, prefixBytes));
        prefixRemaining -= prefixBytes;
        chunks.push({ index, rawLength: bytes.length, sha256: hash(bytes) });
        offset += bytes.length;
      }
      if (previous && (prefixRemaining || prefix.digest("hex") !== previous.sha256)) throw new Error("Artifact prefix changed or conflicts with its ID");
      const scanned = fstatSync(source);
      if (scanned.size !== before.size || scanned.mtimeMs !== before.mtimeMs || scanned.ctimeMs !== before.ctimeMs) {
        throw new Error("Source artifact changed while staging");
      }
      const manifest: ArtifactManifest = { id, kind, byteLength: before.size, sha256: whole.digest("hex"), chunks };
      validateManifest(manifest, limits);
      store.prepare(manifest, previous ? manifestDigest(previous) : null);
      const version = manifestDigest(manifest);
      let offset = 0;
      for (const chunk of chunks) {
        const bytes = readExact(source, chunk.rawLength, offset);
        if (hash(bytes) !== chunk.sha256) throw new Error("Source artifact changed while staging");
        store.writeChunk(id, version, chunk, bytes);
        offset += bytes.length;
      }
      const after = fstatSync(source);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        throw new Error("Source artifact changed while staging");
      }
      syncStagingAncestors(chunks.length ? join(root, "outgoing", id, "chunks") : join(root, "outgoing"));
      store.commit(manifest);
      return manifest;
    } finally { store.close(); }
  } finally { closeSync(source); }
}

export interface TransferPorts {
  transport: Transport; journal: Journal; limits: Limits; root: string; operationId?: string;
}
export interface ArtifactRequestPorts { store: StagingStore; journal: Journal; machineId: string; limits: Limits }
type ArtifactAction = "begin" | "page" | "manifest" | "missing" | "chunk" | "assemble";
type ArtifactRequest = { operation: Operation; action: ArtifactAction; index?: number; from?: number; count?: number };
type WireReply = {
  code: 0 | 1 | 2 | 3; reason: string; state?: "pending" | "done";
  file?: string; artifactId?: string; sha256?: string; manifestDigest?: string;
  missing?: number[]; next?: number | null;
};

function headerFromOperation(operation: Operation): StagingHeader {
  const args = operation.args;
  return {
    artifact: {
      id: args.artifactId as string, kind: args.kind as ArtifactManifest["kind"],
      byteLength: args.byteLength as number, sha256: args.sha256 as string,
    },
    manifestDigest: args.manifestDigest as string, head: args.head as string, pageCount: args.pageCount as number,
  };
}

function requestIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid artifact request index");
  return value;
}

function wireReply(reply: WireReply, limits: Limits): Buffer {
  const bytes = Buffer.from(JSON.stringify(reply));
  if (!Number.isSafeInteger(limits.replyBytes) || bytes.length > limits.replyBytes) throw new Error("Artifact reply exceeds its limit");
  return bytes;
}

function doneReply(result: Record<string, unknown>, header: StagingHeader): WireReply {
  if (typeof result.file !== "string" || result.artifactId !== header.artifact.id ||
      result.sha256 !== header.artifact.sha256 || result.manifestDigest !== header.manifestDigest) {
    throw new Error("Invalid committed artifact evidence");
  }
  return { code: 0, reason: "complete", state: "done", file: result.file,
    artifactId: header.artifact.id, sha256: header.artifact.sha256, manifestDigest: header.manifestDigest };
}

/** Dispatch one internal artifact command. Its byte payload is never encoded as JSON. */
export async function handleArtifactRequest(input: unknown, stdin: Buffer | undefined, ports: ArtifactRequestPorts): Promise<Buffer> {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid artifact request");
    const request = input as ArtifactRequest;
    const operation = request.operation;
    if (!operation || operation.kind !== "artifact-transfer" || operation.machineId !== ports.machineId ||
        operation.expectedEpoch !== null || !operation.args || typeof operation.args !== "object" || Array.isArray(operation.args)) {
      throw new Error("Invalid artifact operation or target machine");
    }
    artifactId(operation.id);
    const header = headerFromOperation(operation);
    validateStagingHeader(header, ports.limits);
    if (!["begin", "page", "manifest", "missing", "chunk", "assemble"].includes(request.action)) throw new Error("Invalid artifact action");
    if (request.action === "page" || request.action === "chunk") {
      requestIndex(request.index);
      if (!Buffer.isBuffer(stdin)) throw new Error("Missing artifact bytes");
    }
    if (request.action === "missing") {
      requestIndex(request.from);
      const count = requestIndex(request.count);
      if (count < 1 || count > 256) throw new Error("Invalid artifact request range");
    }
    const entry = ports.journal.begin(operation);
    if (entry.kind === "done") return wireReply(doneReply(entry.result ?? {}, header), ports.limits);
    if (request.action === "begin") {
      ports.store.beginPages(header, operation.id);
      return wireReply({ code: 0, reason: "pending", state: "pending" }, ports.limits);
    }
    if (request.action === "page") {
      const index = requestIndex(request.index);
      const bytes = stdin!;
      if (index >= header.pageCount || bytes.length > Math.min(ports.limits.manifestBytes, ports.limits.replyBytes)) throw new Error("Invalid manifest page size or index");
      let expected: string | null = header.head;
      if (index) {
        const previous = JSON.parse(ports.store.readPage(operation.id, index - 1).toString("utf8")) as ManifestPage;
        expected = previous.next;
      }
      if (expected !== hash(bytes)) throw new Error("Invalid manifest page digest");
      const page = JSON.parse(bytes.toString("utf8")) as ManifestPage;
      if (!page || page.version !== 1 || page.index !== index || !page.artifact || !Array.isArray(page.chunks) ||
          page.artifact.id !== header.artifact.id || page.artifact.kind !== header.artifact.kind ||
          page.artifact.byteLength !== header.artifact.byteLength || page.artifact.sha256 !== header.artifact.sha256 ||
          (index === header.pageCount - 1 ? page.next !== null : typeof page.next !== "string" || !/^[a-f0-9]{64}$/.test(page.next))) {
        throw new Error("Invalid manifest page");
      }
      ports.store.writePage(operation.id, index, bytes);
      return wireReply({ code: 0, reason: "page stored", state: "pending" }, ports.limits);
    }
    if (request.action === "manifest") {
      function* pages(): Iterable<Buffer> {
        for (let index = 0; index < header.pageCount; index++) yield ports.store.readPage(operation.id, index);
      }
      const manifest = readManifestPages(header.head, pages(), ports.limits);
      if (manifestDigest(manifest) !== header.manifestDigest) throw new Error("Conflicting manifest digest");
      ports.store.declare(manifest, operation.id);
      return wireReply({ code: 0, reason: "manifest stored", state: "pending" }, ports.limits);
    }
    const manifest = ports.store.manifestFor(operation.id);
    if (manifestDigest(manifest) !== header.manifestDigest) throw new Error("Conflicting manifest digest");
    if (request.action === "missing") {
      const from = requestIndex(request.from), count = requestIndex(request.count);
      if (from > manifest.chunks.length) throw new Error("Invalid artifact request range");
      const end = Math.min(from + count, manifest.chunks.length);
      const missing = ports.store.missing(manifest, from, count);
      return wireReply({ code: 0, reason: "chunk inventory", state: "pending", missing, next: end < manifest.chunks.length ? end : null }, ports.limits);
    }
    if (request.action === "chunk") {
      ports.store.receive(manifest, requestIndex(request.index), stdin!);
      return wireReply({ code: 0, reason: "chunk stored", state: "pending" }, ports.limits);
    }
    const file = ports.store.assemble(manifest);
    const result = { file, artifactId: manifest.id, sha256: manifest.sha256, manifestDigest: header.manifestDigest };
    ports.journal.record(operation.id, "done", result);
    return wireReply(doneReply(result, header), ports.limits);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Artifact request failed";
    return wireReply({ code: 1, reason }, ports.limits);
  }
}

const activePeers = new Map<string, Set<string>>();
function peerSlotAvailable(root: string, peer: string, maximum: number): boolean {
  const peers = activePeers.get(root);
  return !peers || !peers.has(peer) && peers.size < maximum;
}
function addActivePeer(root: string, peer: string): void {
  const peers = activePeers.get(root) ?? new Set<string>();
  peers.add(peer); activePeers.set(root, peers);
}
function removeActivePeer(root: string, peer: string): void {
  const peers = activePeers.get(root);
  peers?.delete(peer);
  if (!peers?.size) activePeers.delete(root);
}

class TransferPending extends Error {}
class TransferRefused extends Error {
  readonly code: 1 | 2;
  constructor(message: string, code: 1 | 2) { super(message); this.code = code; }
}

function outcome(code: 0 | 1 | 2 | 3, reason: string, operationId: string, file?: string): Outcome<{ file: string }> {
  return { code, reason, operationId, home: null, epoch: null, repairCommand: null, value: file === undefined ? null : { file } };
}

function journalFailure(error: unknown, id: string): Outcome<{ file: string }> {
  const reason = error instanceof Error ? error.message : "Artifact journal failed";
  const invalid = /^(Invalid operation|Operation ID .*different arguments)/i.test(reason);
  return outcome(invalid ? 2 : 1, reason, id);
}

function decodeReply(bytes: Buffer, limit: number): WireReply {
  if (!Buffer.isBuffer(bytes) || bytes.length > limit) throw new TransferPending("Invalid or oversized artifact reply");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new TransferPending("Invalid artifact reply"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TransferPending("Invalid artifact reply");
  const reply = value as WireReply;
  if (![0, 1, 2, 3].includes(reply.code) || typeof reply.reason !== "string") throw new TransferPending("Invalid artifact reply");
  if (reply.code === 1 || reply.code === 2) throw new TransferRefused(reply.reason, reply.code);
  if (reply.code === 3) throw new TransferPending(reply.reason);
  if (reply.state !== "pending" && reply.state !== "done") throw new TransferPending("Invalid artifact reply state");
  return reply;
}

function returnedFile(reply: WireReply, header: StagingHeader, peer: Peer): string | undefined {
  if (reply.state !== "done") return undefined;
  const result = doneReply(reply as unknown as Record<string, unknown>, header);
  const file = result.file!;
  if (!isAbsolute(peer.globalRoot) || !isAbsolute(file)) throw new TransferPending("Invalid committed artifact path");
  const suffix = relative(join(peer.globalRoot, "roam", "staging"), file);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new TransferPending("Invalid committed artifact path");
  const parts = suffix.split(sep);
  if (parts.length !== 6 || parts[0] !== "incoming" || !isMachineId(parts[1]) || parts[2] !== "artifacts" ||
      parts[3] !== header.artifact.id || parts[4] !== "complete" || parts[5] !== header.manifestDigest) {
    throw new TransferPending("Invalid committed artifact path");
  }
  return file;
}

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TransferPending("Artifact transfer deadline expired")), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function inFlightCalls() {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(call: Promise<T>): Promise<T> {
      pending.add(call);
      void call.then(() => pending.delete(call), () => pending.delete(call));
      return call;
    },
    busy(): boolean { return pending.size > 0; },
    release(lease: () => void): void {
      if (!pending.size) { lease(); return; }
      void Promise.allSettled([...pending]).then(lease).catch(error => {
        process.emitWarning(`Could not release artifact transfer lease: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  };
}

/** Send a staged artifact to a peer and return only durable, verified completion. */
export async function transferArtifact(peer: Peer, manifest: ArtifactManifest, ports: TransferPorts): Promise<Outcome<{ file: string }>> {
  let id = ports.operationId ?? "";
  let acquired = false;
  let rootKey = "";
  let releaseLease: (() => void) | null = null;
  const inFlight = inFlightCalls();
  let phase: "input" | "source" | "remote" = "input";
  try {
    validateManifest(manifest, ports.limits);
    if (!isMachineId(peer.machineId) || !isAbsolute(peer.globalRoot) || !isAbsolute(ports.root) ||
        [ports.limits.transferMs, ports.limits.fileMs, ports.limits.controlMs, ports.limits.directMs, ports.limits.importMs, ports.limits.peerConcurrency]
          .some(value => !Number.isSafeInteger(value) || value <= 0) ||
        !Array.isArray(ports.limits.retryDelaysMs) || ports.limits.retryDelaysMs.some(ms => !Number.isSafeInteger(ms) || ms < 0)) {
      throw new Error("Invalid artifact transfer arguments");
    }
    const deadline = performance.now() + ports.limits.transferMs;
    if (!Number.isFinite(deadline)) throw new Error("Invalid artifact transfer deadline");
    const remaining = () => {
      const ms = Math.ceil(deadline - performance.now());
      if (!Number.isSafeInteger(ms) || ms <= 0) throw new TransferPending("Artifact transfer deadline expired");
      return ms;
    };
    const pages = createManifestPages(manifest, ports.limits);
    const digest = manifestDigest(manifest);
    id = artifactId(ports.operationId ?? `transfer-${hash(Buffer.from(`${peer.machineId}:${digest}`)).slice(0, 48)}`);
    const header: StagingHeader = {
      artifact: { id: manifest.id, kind: manifest.kind, byteLength: manifest.byteLength, sha256: manifest.sha256 },
      manifestDigest: digest, head: pages.head, pageCount: pages.pages.length,
    };
    const operation: Operation = {
      id, machineId: peer.machineId, expectedEpoch: null, kind: "artifact-transfer",
      args: { artifactId: manifest.id, kind: manifest.kind, byteLength: manifest.byteLength, sha256: manifest.sha256,
        manifestDigest: digest, head: pages.head, pageCount: pages.pages.length },
    };
    let entry: ReturnType<Journal["begin"]>;
    try { entry = ports.journal.begin(operation); }
    catch (error) { return journalFailure(error, id); }
    if (entry.kind === "done") {
      const reply = doneReply(entry.result ?? {}, header);
      return outcome(0, "complete", id, returnedFile(reply, header, peer));
    }
    rootKey = resolve(ports.root);
    if (!peerSlotAvailable(rootKey, peer.machineId, ports.limits.peerConcurrency)) {
      return outcome(3, "Artifact transfer is waiting for a peer slot", id);
    }
    phase = "source";
    releaseLease = acquireTransferLease(rootKey, peer.machineId, ports.limits.peerConcurrency);
    if (!releaseLease) return outcome(3, "Artifact transfer is waiting for a peer slot", id);
    addActivePeer(rootKey, peer.machineId);
    acquired = true;
    const source = openOutgoingStaging(ports.root, ports.limits, false);
    let staged: ArtifactManifest | null;
    try { staged = source.get(manifest.id, digest); } finally { source.close(); }
    if (!staged || manifestDigest(staged) !== digest) throw new TransferRefused("Missing or conflicting staged artifact manifest", 1);
    for (const chunk of manifest.chunks) {
      remaining();
      privateOutgoingArtifact(ports.root, manifest.id);
      const bytes = readPrivate(sourceChunk(ports.root, manifest.id, chunk.index, chunk.sha256), chunk.rawLength);
      if (bytes.length !== chunk.rawLength || hash(bytes) !== chunk.sha256) throw new TransferRefused("Corrupt source artifact chunk", 1);
    }
    phase = "remote";
    const resolved = Object.freeze({ ...await bounded(inFlight.track(ports.transport.resolve(peer)), Math.min(ports.limits.controlMs, remaining())) });
    if (resolved.machineId !== peer.machineId || resolved.alias !== peer.alias || resolved.globalRoot !== peer.globalRoot) {
      throw new TransferRefused("Resolved peer identity changed", 1);
    }
    const send = async (action: ArtifactAction, fields: { index?: number; from?: number; count?: number } = {}, stdin?: Buffer): Promise<WireReply> => {
      const request: ArtifactRequest = { operation, action, ...fields };
      const duration = action === "chunk" || action === "page" ? ports.limits.fileMs
        : action === "assemble" ? Math.min(ports.limits.importMs, ports.limits.directMs) : ports.limits.controlMs;
      const timeoutMs = Math.min(duration, remaining());
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TransferPending("Invalid artifact command deadline");
      const bytes = await bounded(inFlight.track(ports.transport.exec(resolved, ["roam", "artifact", "receive", JSON.stringify(request)],
        { timeoutMs, maxBytes: ports.limits.replyBytes, ...(stdin ? { stdin } : {}) })), timeoutMs);
      remaining();
      return decodeReply(bytes, ports.limits.replyBytes);
    };
    const finish = (reply: WireReply): Outcome<{ file: string }> | undefined => {
      const file = returnedFile(reply, header, resolved);
      if (file === undefined) return undefined;
      ports.journal.record(id, "done", { file, artifactId: manifest.id, sha256: manifest.sha256, manifestDigest: digest });
      return outcome(0, "complete", id, file);
    };
    let reply = await send("begin");
    let result = finish(reply);
    if (result) return result;
    for (let index = 0; index < pages.pages.length; index++) {
      reply = await send("page", { index }, pages.pages[index]);
      result = finish(reply);
      if (result) return result;
    }
    reply = await send("manifest");
    result = finish(reply);
    if (result) return result;
    const count = Math.min(256, Math.floor((ports.limits.replyBytes - 128) / 12));
    if (count < 1) throw new TransferRefused("Artifact reply limit is too small", 2);
    for (let from = 0; from < manifest.chunks.length;) {
      reply = await send("missing", { from, count });
      result = finish(reply);
      if (result) return result;
      const end = Math.min(from + count, manifest.chunks.length);
      if (!Array.isArray(reply.missing) || reply.next !== (end < manifest.chunks.length ? end : null) ||
          new Set(reply.missing).size !== reply.missing.length || reply.missing.some(index => !Number.isSafeInteger(index) || index < from || index >= end)) {
        throw new TransferPending("Invalid chunk inventory reply");
      }
      for (const index of reply.missing) {
        const chunk = manifest.chunks[index];
        privateOutgoingArtifact(ports.root, manifest.id);
        const bytes = readPrivate(sourceChunk(ports.root, manifest.id, index, chunk.sha256), chunk.rawLength);
        if (bytes.length !== chunk.rawLength || hash(bytes) !== chunk.sha256) throw new TransferRefused("Corrupt source artifact chunk", 1);
        for (let attempt = 0;; attempt++) {
          try { reply = await send("chunk", { index }, bytes); break; }
          catch (error) {
            if (error instanceof TransferRefused || inFlight.busy() || attempt >= ports.limits.retryDelaysMs.length) throw error;
            const delay = ports.limits.retryDelaysMs[attempt];
            if (!Number.isSafeInteger(delay) || delay < 0 || delay >= remaining()) throw new TransferPending("Artifact transfer deadline expired");
            await bounded(new Promise<void>(resolve => setTimeout(resolve, delay)), remaining());
          }
        }
        result = finish(reply);
        if (result) return result;
      }
      from = end;
    }
    reply = await send("assemble");
    result = finish(reply);
    if (!result) throw new TransferPending("Artifact completion is unconfirmed");
    return result;
  } catch (error) {
    if (error instanceof TransferRefused) return outcome(error.code, error.message, id);
    if (error instanceof TransferPending) return outcome(3, error.message, id);
    return outcome(phase === "input" ? 2 : phase === "source" ? 1 : 3,
      error instanceof Error ? error.message : "Artifact transfer failed", id);
  } finally {
    inFlight.release(() => { try { releaseLease?.(); } finally { if (acquired) removeActivePeer(rootKey, peer.machineId); } });
  }
}

/** Pull chunks from a peer's private outgoing pool; the returned file remains staged until receipted. */
export async function pullArtifact(peer: Peer, manifest: ArtifactManifest, ports: TransferPorts): Promise<Outcome<{ file: string }>> {
  let id = ports.operationId ?? "";
  let phase: "input" | "local" | "remote" = "input";
  let acquired = false;
  let rootKey = "";
  let releaseLease: (() => void) | null = null;
  const inFlight = inFlightCalls();
  let store: StagingStore | undefined;
  try {
    validateManifest(manifest, ports.limits);
    if (!isMachineId(peer.machineId) || !isAbsolute(peer.globalRoot) || !isAbsolute(ports.root) ||
        !Number.isSafeInteger(ports.limits.fileMs) || ports.limits.fileMs <= 0 ||
        !Number.isSafeInteger(ports.limits.transferMs) || ports.limits.transferMs <= 0 ||
        !Number.isSafeInteger(ports.limits.peerConcurrency) || ports.limits.peerConcurrency <= 0 ||
        !Array.isArray(ports.limits.retryDelaysMs) || ports.limits.retryDelaysMs.some(ms => !Number.isSafeInteger(ms) || ms < 0) ||
        !Number.isSafeInteger(ports.limits.replyBytes) || ports.limits.replyBytes <= 0 ||
        manifest.chunks.some(chunk => chunk.rawLength > ports.limits.replyBytes)) throw new Error("Invalid transfer configuration");
    const deadline = performance.now() + ports.limits.transferMs;
    if (!Number.isFinite(deadline)) throw new Error("Invalid transfer deadline");
    const version = manifestDigest(manifest);
    id = artifactId(ports.operationId ?? `pull-${hash(Buffer.from(`${peer.machineId}:${version}`)).slice(0, 48)}`);
    const expectedFile = join(ports.root, "incoming", peer.machineId, "artifacts", manifest.id, "complete", version);
    const operation: Operation = {
      id, machineId: peer.machineId, kind: "artifact-pull", expectedEpoch: null,
      args: { artifactId: manifest.id, kind: manifest.kind, byteLength: manifest.byteLength, sha256: manifest.sha256, manifestDigest: version },
    };
    let entry: ReturnType<Journal["begin"]>;
    try { entry = ports.journal.begin(operation); } catch (error) { return journalFailure(error, id); }
    if (entry.kind === "done") {
      const data = entry.result as { file?: unknown; artifactId?: unknown; sha256?: unknown } | null;
      if (!data || data.file !== expectedFile || data.artifactId !== manifest.id || data.sha256 !== manifest.sha256) {
        return outcome(1, "Conflicting completed artifact receipt", id);
      }
      try { privateIncomingArtifact(ports.root, peer.machineId, manifest.id); verifyStagedFile(expectedFile, manifest); }
      catch { return outcome(3, "Committed artifact is unavailable; reconcile its receipt", id); }
      return outcome(0, "complete", id, expectedFile);
    }
    rootKey = resolve(ports.root);
    if (!peerSlotAvailable(rootKey, peer.machineId, ports.limits.peerConcurrency)) {
      return outcome(3, "Artifact transfer is waiting for a peer slot", id);
    }
    phase = "local";
    releaseLease = acquireTransferLease(rootKey, peer.machineId, ports.limits.peerConcurrency);
    if (!releaseLease) return outcome(3, "Artifact transfer is waiting for a peer slot", id);
    addActivePeer(rootKey, peer.machineId); acquired = true;
    phase = "remote";
    const resolveMs = Math.min(ports.limits.fileMs, Math.max(0, Math.floor(deadline - performance.now())));
    if (resolveMs <= 0) throw new TransferPending("Artifact transfer deadline expired");
    const resolved = await bounded(inFlight.track(ports.transport.resolve(peer)), resolveMs);
    if (!resolved || resolved.machineId !== peer.machineId || resolved.alias !== peer.alias || resolved.globalRoot !== peer.globalRoot) {
      throw new TransferRefused("Peer identity changed or is unavailable", 1);
    }
    phase = "local";
    store = openStaging(ports.root, peer.machineId, ports.limits);
    store.declare(manifest, id);
    for (const index of store.missing(manifest)) {
      const chunk = manifest.chunks[index];
      const remoteFile = sourceChunk(join(resolved.globalRoot, "roam", "staging"), manifest.id, index, chunk.sha256);
      let bytes: Buffer | undefined;
      for (let attempt = 0; attempt <= ports.limits.retryDelaysMs.length; attempt++) {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) throw new TransferPending("Artifact transfer deadline expired");
        phase = "remote";
        try {
          bytes = await bounded(inFlight.track(ports.transport.read(resolved, remoteFile, { timeoutMs: Math.min(remaining, ports.limits.fileMs), maxBytes: chunk.rawLength })),
            Math.min(remaining, ports.limits.fileMs));
          break;
        } catch (error) {
          if (inFlight.busy() || attempt === ports.limits.retryDelaysMs.length) throw error;
          const delay = ports.limits.retryDelaysMs[attempt];
          if (deadline - performance.now() <= delay) throw new TransferPending("Artifact transfer deadline expired");
          await bounded(new Promise<void>(resolve => setTimeout(resolve, delay)), deadline - performance.now());
        }
      }
      phase = "local";
      if (!Buffer.isBuffer(bytes) || bytes.length !== chunk.rawLength || hash(bytes) !== chunk.sha256) {
        throw new TransferRefused("Corrupt or incomplete peer artifact chunk", 1);
      }
      store.receive(manifest, index, bytes);
    }
    const file = store.assemble(manifest);
    if (file !== expectedFile) throw new Error("Unexpected reconstructed artifact path");
    if (performance.now() >= deadline) throw new TransferPending("Artifact transfer deadline expired");
    phase = "remote";
    ports.journal.record(id, "done", { file, artifactId: manifest.id, sha256: manifest.sha256 });
    return outcome(0, "complete", id, file);
  } catch (error) {
    if (error instanceof TransferRefused) return outcome(error.code, error.message, id);
    if (error instanceof TransferPending) return outcome(3, error.message, id);
    return outcome(phase === "input" ? 2 : phase === "local" ? 1 : 3,
      error instanceof Error ? error.message : "Artifact pull failed", id);
  } finally {
    try { store?.close(); } finally {
      inFlight.release(() => { try { releaseLease?.(); } finally { if (acquired) removeActivePeer(rootKey, peer.machineId); } });
    }
  }
}
