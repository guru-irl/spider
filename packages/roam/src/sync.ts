import { listStoreKeys, parseUngathered, type UngatheredStore } from "./store-inventory";
import { causeCode, safeCauseCode, type AgentOperationKind } from "./cause-codes";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import type { Db } from "@spider/db-core";
import { CursorMismatchError } from "@spider/db-core/roam/apply";
import { localEntries, readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { assertBatchHeader, isRoamUuid, parseRoamJson, storeScope } from "@spider/db-core/roam/codec";
import type { ApplyReceipt, Home, JsonObject, StoreKey } from "@spider/db-core/roam/types";
import { pullArtifact, readManifestPages, stageArtifact, transferArtifact } from "./artifacts";
import { barrierWatermarks } from "./barriers";
import type { Clock, Journal, Operation, Outcome, Peer, RoamConfig, StorePort, SyncService, Transport } from "./contracts";
import { appendMirror, type MirrorSource } from "./mirrors";
import { isRevoked, syncHandshake, type SyncHandshake } from "./revocation";
import { assignInitialHome, markInitialConflict } from "./homes";
import { readOnlyOperation, releaseJournalArtifact, type ArtifactJournal } from "./journal";
import { agentFailureCode, isPeerConnectivityError, isPeerFailureReason, isSyncConnectivityFailure, peerFailureReason, RecoveryArtifactError, RecoveryResponseError } from "./peer-errors";
import { loadPeerState, receiptMatches, savePeerState, sizedBytes, type PeerState, type PendingBatch } from "./peer-state";
import { acquireTransferLease, defaultStagingRoot, openOutgoingStaging, openStaging } from "./staging";
import { removeOutgoing, type StoreAdapter } from "./stores";
import { parseFirstHomeWithheld, type FirstHomeWithheld } from "./first-home-diagnostics";

export interface SyncPorts {
  config: RoamConfig; globalDb: Db; transport: Transport; journal: Journal; clock: Clock; stores: StorePort;
  /** Hosting composition supplies the private hub journal and retire-only reconnect delivery. */
  revocationDb?: Db;
  retireOnly?(peer: Peer, reply: Extract<SyncHandshake, { kind: "retire-only" }>): Promise<void>;
  mirrors?: {
    root: string; homes(machine: string): readonly Home[];
    /** A local verified copy of the peer's exact installed session, never metadata replication. */
    source(home: Home, peer: Peer): Promise<MirrorSource>;
  };
  onPeerSync?(peer: Peer, results: readonly Outcome<ApplyReceipt>[]): void | Promise<void>;
}
export interface SyncAdapter extends SyncService { drain(): Promise<void> }
class SyncFailure extends Error {
  readonly code: 1 | 2 | 3;
  readonly operationId: string | null;
  readonly causeCode?: string;
  readonly operationKind?: AgentOperationKind;
  constructor(code: 1 | 2 | 3, message: string, operationId: string | null = null, causeCode?: string, operationKind?: AgentOperationKind) {
    super(message); this.code = code; this.operationId = operationId; this.causeCode = causeCode; this.operationKind = operationKind;
  }
}
class QuarantinedStore extends SyncFailure {
  constructor(readonly sessions: string[]) { super(1, "Peer store is quarantined"); }
}
function object(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function outcome(code: 0 | 1 | 2 | 3, reason: string, operationId: string, value: ApplyReceipt | null = null): Outcome<ApplyReceipt> {
  return { code, reason, operationId, home: null, epoch: null, repairCommand: null, value };
}
function discard(file: string): void { if (existsSync(file)) unlinkSync(file); }
export function createSync(ports: SyncPorts): SyncAdapter {
  const { config, stores, globalDb, transport, journal, clock } = ports;
  let running = false, active = 0;
  const inFlight = new Map<string, Promise<readonly Outcome<ApplyReceipt>[]>>();
  const timers = new Map<string, () => void>();
  const queue: (() => void)[] = [];
  const capacity = Math.min(2, config.limits.peerConcurrency);
  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= capacity) await new Promise<void>(resolve => queue.push(resolve));
    else active++;
    try { return await work(); } finally { const next = queue.shift(); if (next) next(); else active--; }
  }
  function record(id: string, action: string, result: JsonObject): void {
    try { journal.record(id, action, result); }
    catch { throw new SyncFailure(3, "Operation journal result is pending reconciliation", id); }
  }
  function assertNotRevoked(peer: Peer): void {
    if (ports.revocationDb && isRevoked(ports.revocationDb, peer.machineId)) throw new SyncFailure(1, "machine-revoked");
  }
  async function remote(peer: Peer, kind: AgentOperationKind, args: JsonObject, id: string = randomUUID()): Promise<JsonObject> {
    assertNotRevoked(peer);
    const operation: Operation = { id, machineId: peer.machineId, expectedEpoch: null, kind, args };
    const saved = readOnlyOperation(kind) ? { kind: "new", result: null } as const : journal.begin(operation);
    if (saved.kind === "done") {
      if (kind === "split" && typeof saved.result?.wire === "string") {
        const replay = JSON.parse(saved.result.wire) as { value: JsonObject };
        if (!object(replay.value)) throw new SyncFailure(1, "Invalid saved manifest page");
        return replay.value;
      }
      if (!object(saved.result?.value)) throw new SyncFailure(1, "Invalid journal result");
      return saved.result.value;
    }
    let decoded: unknown;
    let wire = "";
    try {
      const handle = await transport.resolve(peer);
      if (handle.machineId !== peer.machineId) throw new SyncFailure(1, "Enrolled machine identity does not match");
      assertNotRevoked(peer);
      const bytes = await transport.exec(handle, ["roam", "agent", JSON.stringify(operation)], {
        timeoutMs: kind === "export" ? config.limits.exportMs : kind === "import" ? config.limits.importMs : config.limits.controlMs,
        maxBytes: config.limits.replyBytes,
      });
      if (!Buffer.isBuffer(bytes) || bytes.length > config.limits.replyBytes) throw new Error("Invalid reply");
      const parse = JSON.parse as unknown as (text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
      wire = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      decoded = parse(wire, (key, value, context) => {
        if (typeof value === "number" && key !== "applyMs" && key !== "confidence") {
          if (!context?.source) throw new Error("Missing numeric source");
          parseRoamJson(context.source);
        }
        return value;
      });
    } catch (error) {
      if (error instanceof SyncFailure) throw error;
      const peerFailure = peerFailureReason(error);
      if (peerFailure) throw new SyncFailure(1, peerFailure, id);
      throw new SyncFailure(3, "Peer operation is pending reconciliation", id);
    }
    assertNotRevoked(peer);
    if (!object(decoded) || ![0, 1, 2, 3].includes(decoded.code as number) || decoded.operationId !== id) throw new SyncFailure(1, "Invalid peer outcome");
    if (decoded.code !== 0) {
      if (kind === "receipt" && decoded.code === 3 && decoded.reason === "Receipt is pending") return { pending: true };
      const reason = agentFailureCode(decoded.reason) ?? (typeof decoded.reason === "string" && /^(?:Roaming todo collision between |Roaming row |Mapping fenced replica |Staging full \(quota\) at )/.test(decoded.reason)
        ? decoded.reason : `peer-${kind}-refused`);
      const cause = safeCauseCode(decoded.causeCode) ?? (reason === "agent-operation-failed" ? causeCode(null, kind) : undefined);
      throw new SyncFailure(decoded.code as 1 | 2 | 3, reason, id, cause, kind);
    }
    if (!object(decoded.value)) throw new SyncFailure(1, "Invalid peer value");
    if (!readOnlyOperation(kind)) record(id, "done", { value: decoded.value, ...(kind === "split" ? { wire } : {}) });
    return decoded.value;
  }
  function handshake(value: JsonObject, peer: Peer): void {
    if (value.protocol !== 1 || value.schema !== 14 || value.machineId !== peer.machineId) throw new SyncFailure(1, `Peer ${peer.machineId} protocol, schema or enrolled identity needs repair`);
  }
  async function remoteCursor(peer: Peer, key: StoreKey, stream: string): Promise<number> {
    const value = await remote(peer, "cursor", { storeKey: key, sourceMachine: config.machineId, stream });
    if (typeof value.lastSeq !== "number" || !Number.isSafeInteger(value.lastSeq) || value.lastSeq < 0) throw new SyncFailure(1, "Invalid peer cursor");
    return value.lastSeq;
  }
  async function manifest(peer: Peer, value: JsonObject, pending: PendingBatch) {
    const descriptor = value.artifact;
    if (!object(descriptor) || descriptor.id !== pending.id || descriptor.kind !== "batch" || typeof descriptor.head !== "string" ||
        typeof descriptor.manifestDigest !== "string" || typeof descriptor.pageBytes !== "number" || !Number.isSafeInteger(descriptor.pageBytes) ||
        descriptor.pageBytes < 1 || descriptor.pageBytes > config.limits.manifestBytes || typeof descriptor.pageCount !== "number" ||
        !Number.isSafeInteger(descriptor.pageCount) || descriptor.pageCount < 1 || descriptor.pageCount > config.limits.hardBatchBytes) throw new SyncFailure(1, "Invalid export manifest descriptor");
    const pages: Buffer[] = [];
    for (let index = 0; index < descriptor.pageCount; index++) {
      const page = await remote(peer, "split", { artifactId: pending.id, manifestDigest: descriptor.manifestDigest,
        head: descriptor.head, pageBytes: descriptor.pageBytes, index }, `${pending.id}-page-${index}`);
      if (!object(page.page)) throw new SyncFailure(1, "Invalid manifest page");
      pages.push(Buffer.from(JSON.stringify(page.page)));
    }
    const result = readManifestPages(descriptor.head, pages, config.limits);
    if (result.id !== descriptor.id || result.sha256 !== descriptor.sha256 || result.byteLength !== descriptor.byteLength) throw new SyncFailure(1, "Conflicting export manifest");
    return result;
  }
  function attempt(state: PeerState, peer: Peer, direction: string, key: StoreKey, after: number): PendingBatch {
    const name = `${direction}:${key}`;
    if (!state.pending[name]) {
      state.pending[name] = { id: randomUUID(), key, after, targetBytes: state.targetBytes, batch: null, exported: null };
      savePeerState(globalDb, peer.machineId, state);
    }
    return state.pending[name];
  }
  function complete(state: PeerState, peer: Peer, direction: string, key: StoreKey, receipt?: ApplyReceipt) {
    if (receipt) state.targetBytes = sizedBytes(state.targetBytes, receipt.applyMs, config.limits.applyTargetMs, config.limits.targetBatchBytes);
    delete state.pending[`${direction}:${key}`]; savePeerState(globalDb, peer.machineId, state);
  }
  function discardPending(peer: Peer, pending: PendingBatch): void {
    const root = defaultStagingRoot();
    const release = acquireTransferLease(root, peer.machineId, config.limits.peerConcurrency);
    if (!release) throw new SyncFailure(3, "Superseded artifact cleanup is waiting for a peer slot", pending.id);
    try {
      if (existsSync(`${root}/incoming/${peer.machineId}/quota.db`)) {
        const staging = openStaging(root, peer.machineId, config.limits);
        try { staging.discard(pending.id, () => true); } finally { staging.close(); }
      }
      if (existsSync(`${root}/outgoing/quota.db`)) {
        const staging = openOutgoingStaging(root, config.limits, false);
        try { staging.remove(pending.id); } finally { staging.close(); }
      }
      if (pending.batch) discard(pending.batch.file);
      const artifactJournal = journal as Partial<ArtifactJournal>;
      for (const id of [pending.id, `accept-${pending.id}`, `pull-${pending.id}`, `send-${pending.id}`, `import-${pending.id}`]) artifactJournal.cancel?.(id);
      releaseJournalArtifact(journal, pending.id);
    } finally { release(); }
  }
  async function supersededPull(peer: Peer, key: StoreKey, state: PeerState, pending: PendingBatch, value: JsonObject): Promise<void> {
    const descriptor = value.artifact;
    if (object(descriptor) && typeof descriptor.sha256 === "string")
      await remote(peer, "release-export", { exportId: pending.id, sha256: descriptor.sha256 }, `release-${pending.id}`);
    discardPending(peer, pending); complete(state, peer, "pull", key);
  }
  async function pull(peer: Peer, key: StoreKey, state: PeerState, results: Outcome<ApplyReceipt>[]) {
    let info = await remote(peer, "inventory", { storeKey: key }); handshake(info, peer);
    if (info.captureEnabled === false && storeScope(key) !== "worktree") {
      await remote(peer, "enable-capture", { storeKey: key });
      info = await remote(peer, "inventory", { storeKey: key }); handshake(info, peer);
    }
    if (info.storeKey !== key || !isRoamUuid(info.stream)) throw new SyncFailure(1, "Peer store is quarantined or invalid");
    if (info.roamable === false && key.startsWith("worktree:") && Array.isArray(info.sessions) && info.sessions.every(id => typeof id === "string" && id.length > 0))
      throw new QuarantinedStore(info.sessions as string[]);
    if (info.roamable !== true) throw new SyncFailure(1, "Peer store is quarantined or invalid");
    for (;;) {
      const pending = attempt(state, peer, "pull", key, stores.cursor(key, peer.machineId, info.stream));
      const value = pending.exported ?? await remote(peer, "export", { storeKey: key, after: pending.after,
        targetBytes: pending.targetBytes, batchId: pending.id }, pending.id);
      assertBatchHeader(value.header);
      const header = value.header;
      if (header.storeKey !== key || header.senderMachine !== peer.machineId || header.senderStream !== info.stream || header.after !== pending.after || header.batchId !== pending.id) throw new SyncFailure(1, "Conflicting export header");
      pending.exported = value; savePeerState(globalDb, peer.machineId, state);
      const candidate = { header, file: "", sha256: object(value.artifact) ? value.artifact.sha256 as string : "", byteLength: object(value.artifact) ? value.artifact.byteLength as number : 0 };
      const currentReceipt = () => (stores as Partial<StoreAdapter>).receipt?.(key, candidate) ?? null;
      if (stores.cursor(key, peer.machineId, header.senderStream) !== pending.after && !currentReceipt()) {
        await supersededPull(peer, key, state, pending, value); continue;
      }
      if (header.count === 0) { if (value.artifact !== null) throw new SyncFailure(1, "Invalid empty export"); releaseJournalArtifact(journal, pending.id); complete(state, peer, "pull", key); break; }
      const artifact = await manifest(peer, value, pending);
      const receiptId = `accept-${pending.id}`;
      const operation: Operation = { id: receiptId, machineId: config.machineId, expectedEpoch: null, kind: "sync-accept", args: { header: JSON.parse(JSON.stringify(header)) as JsonObject, sha256: artifact.sha256 } };
      const saved = journal.begin(operation);
      let receipt: ApplyReceipt;
      if (saved.kind === "done" && object(saved.result?.value) && receiptMatches(saved.result.value, header, artifact.sha256)) receipt = saved.result.value as unknown as ApplyReceipt;
      else {
        let file = journal.read(receiptId).find(row => row.action === "staged")?.result.file;
        if (typeof file !== "string") {
          const pulled = await pullArtifact(peer, artifact, { transport, journal, limits: config.limits, root: defaultStagingRoot(), operationId: `pull-${pending.id}` });
          if (pulled.code !== 0 || !pulled.value) throw new SyncFailure(pulled.code || 3,
            isPeerFailureReason(pulled.reason) ? pulled.reason : "Artifact pull is pending", pulled.operationId);
          file = pulled.value.file;
          record(receiptId, "staged", { file });
        }
        assertNotRevoked(peer);
        try { receipt = await stores.accept(key, { header, file, sha256: artifact.sha256, byteLength: artifact.byteLength }); }
        catch (error) {
          if (!(error instanceof CursorMismatchError) || stores.cursor(key, peer.machineId, header.senderStream) === pending.after || currentReceipt()) throw error;
          await supersededPull(peer, key, state, pending, value); continue;
        }
        if (!receiptMatches({ ...receipt }, header, artifact.sha256)) throw new SyncFailure(1, "Invalid committed local receipt");
        record(receiptId, "done", { value: { ...receipt } });
      }
      results.push(outcome(0, "pulled", receiptId, receipt));
      // A receipt on this hub is the authorization to release the peer's export.
      await remote(peer, "release-export", { exportId: pending.id, sha256: artifact.sha256 }, `release-${pending.id}`);
      releaseJournalArtifact(journal, pending.id);
      complete(state, peer, "pull", key, receipt);
    }
  }
  async function push(peer: Peer, key: StoreKey, state: PeerState, results: Outcome<ApplyReceipt>[],
    observe: (key: StoreKey, stream: string, through: number) => void) {
    const probe = await stores.export(key, 0, 1, randomUUID());
    const stream = probe.header.senderStream; discard(probe.file);
    for (;;) {
      const cursor = await remoteCursor(peer, key, stream);
      observe(key, stream, cursor);
      const pending = attempt(state, peer, "push", key, cursor);
      const batch = pending.batch ?? await stores.export(key, pending.after, pending.targetBytes, pending.id);
      if (batch.header.senderMachine !== config.machineId || batch.header.storeKey !== key || batch.header.senderStream !== (pending.batch?.header.senderStream ?? stream)) throw new SyncFailure(1, "Local store identity does not match");
      pending.batch = batch; savePeerState(globalDb, peer.machineId, state);
      const prior = journal.read(`import-${pending.id}`).find(row => row.action === "done")?.result.value;
      if (cursor !== pending.after && !(object(prior) && receiptMatches(prior, batch.header, batch.sha256))) {
        const committed = await remote(peer, "receipt", { storeKey: key, sourceMachine: config.machineId, batchId: pending.id });
        if (committed.pending === true) {
          discardPending(peer, pending); complete(state, peer, "push", key); continue;
        }
        if (!receiptMatches(committed, batch.header, batch.sha256)) throw new SyncFailure(1, "Conflicting peer apply receipt");
      }
      if (batch.header.count === 0) { discard(batch.file); complete(state, peer, "push", key); break; }
      if (object(prior) && receiptMatches(prior, batch.header, batch.sha256)) {
        removeOutgoing(defaultStagingRoot(), pending.id, config, () => true);
        releaseJournalArtifact(journal, pending.id);
        discard(batch.file);
        complete(state, peer, "push", key, prior as unknown as ApplyReceipt);
        continue;
      }
      const manifest = await stageArtifact(batch.file, "batch", config.limits, { artifactId: pending.id });
      const transfer = await transferArtifact(peer, manifest, { transport, journal, limits: config.limits, root: defaultStagingRoot(), operationId: `send-${pending.id}` });
      if (transfer.code !== 0) throw new SyncFailure(transfer.code,
        isPeerFailureReason(transfer.reason) ? transfer.reason : "Artifact push is pending", transfer.operationId);
      const value = await remote(peer, "import", { storeKey: key, sourceMachine: config.machineId, transferId: `send-${pending.id}`,
        artifactId: manifest.id, sha256: manifest.sha256, header: { ...batch.header } }, `import-${pending.id}`);
      if (!receiptMatches(value, batch.header, manifest.sha256)) throw new SyncFailure(1, "Invalid peer apply receipt");
      const receipt = value as unknown as ApplyReceipt;
      results.push(outcome(0, "pushed", `import-${pending.id}`, receipt));
      removeOutgoing(defaultStagingRoot(), manifest.id, config, () => journal.read(`import-${pending.id}`).some(row => row.action === "done" && object(row.result.value) && receiptMatches(row.result.value, batch.header, manifest.sha256)));
      releaseJournalArtifact(journal, manifest.id);
      discard(batch.file); complete(state, peer, "push", key, receipt);
    }
  }
  function assignHomes() {
    const states = config.peers.map(peer => ({ machineId: peer.machineId, state: loadPeerState(globalDb, peer.machineId, config.limits.targetBatchBytes) }));
    const gathered = states.every(({ state }) => state.pulled || state.readablePulled);
    const unavailable = [...localUngathered.map(store => ({ machineId: config.machineId, store })),
      ...states.flatMap(({ machineId, state }) => (state.ungathered ?? []).map(store => ({ machineId, store })))];
    const unknown = new Set(states.flatMap(({ state }) => Object.values(state.unknownSessions ?? {}).flat()));
    const adapter = stores as Partial<StoreAdapter>;
    if (!adapter.origins) return;
    for (const [id, origins] of adapter.origins()) {
      let withheld: FirstHomeWithheld | null = null;
      if (origins.size > 1) markInitialConflict(globalDb, id, config.hubMachineId);
      else if (gathered && origins.size === 1 && !unknown.has(id)) {
        const missing = unavailable.find(({ store }) => {
          if (store.scope !== "worktree" && store.scope !== "replica") return false;
          if (store.key === null) return true;
          const row = globalDb.prepare("SELECT stores_json FROM roam_locations WHERE session_id=?").get(id) as { stores_json: string } | undefined;
          return !row || (JSON.parse(row.stores_json) as string[]).includes(store.key);
        });
        if (!missing) assignInitialHome(globalDb, id, [...origins][0], config.hubMachineId);
        else try {
          if (!globalDb.prepare("SELECT 1 FROM session_homes WHERE session_id=?").get(id))
            withheld = parseFirstHomeWithheld({ machineId: missing.machineId, storeKind: missing.store.scope,
              ...(missing.store.check === "store-machine-mismatch" ? { storeCheck: "store-machine-mismatch" } : {}) });
        } catch { /* The diagnostic must not change synchronization. */ }
      }
      try { globalDb.raw.transaction(() => writeLocal(globalDb, "first-home-withheld", id, withheld ?? undefined)).immediate(); }
      catch { /* Diagnostic storage must not change home assignment. */ }
    }
  }
  async function mirrorHomes(peer: Peer): Promise<void> {
    if (!ports.mirrors) return;
    for (const home of ports.mirrors.homes(peer.machineId)) {
      assertNotRevoked(peer);
      const current = () => globalDb.prepare("SELECT 1 FROM session_homes WHERE session_id=? AND machine_id=? AND epoch=? AND move_id IS ?").get(home.sessionId, peer.machineId, home.epoch, home.moveId);
      if (home.machineId !== peer.machineId || !Number.isSafeInteger(home.epoch) || home.epoch < 1 || !current()) throw new SyncFailure(1, "mirror-home-changed");
      const source = await ports.mirrors.source(home, peer);
      assertNotRevoked(peer);
      if (!current()) throw new SyncFailure(1, "mirror-home-changed");
      if (source.transfer?.reason === "mirror-source-rewritten") throw new SyncFailure(1, "mirror-source-rewritten:full-copy");
      const key = createHash("sha256").update(JSON.stringify([home.sessionId, home.epoch, peer.machineId])).digest("hex");
      let id = readLocal<string>(globalDb, "sync-mirror", key);
      if (id !== undefined && !isRoamUuid(id)) throw new SyncFailure(3, "mirror-journal-invalid");
      if (!id) { id = randomUUID(); writeLocal(globalDb, "sync-mirror", key, id); }
      const begin = () => journal.begin({ id: id!, machineId: peer.machineId, kind: "sync-mirror", expectedEpoch: home.epoch, args: { sessionId: home.sessionId } });
      if (begin().kind === "done") { id = randomUUID(); writeLocal(globalDb, "sync-mirror", key, id); begin(); }
      await appendMirror({ sessionId: home.sessionId, epoch: home.epoch, source, root: ports.mirrors.root, operationId: id, limits: config.limits }, journal);
      record(id, "done", {});
      writeLocal(globalDb, "sync-mirror", key, undefined);
    }
  }
  async function peerSync(peer: Peer, inventories: Promise<Map<string, JsonObject | Error>>): Promise<readonly Outcome<ApplyReceipt>[]> {
    if (ports.revocationDb) {
      const reply = syncHandshake(ports.revocationDb, peer.machineId);
      if (reply.kind === "retire-only") {
        try { await ports.retireOnly?.(peer, reply); } catch { /* No sync authority is granted while retirement is pending. */ }
        return [outcome(1, reply.reason, peer.machineId)];
      }
    }
    const results: Outcome<ApplyReceipt>[] = [];
    const state = loadPeerState(globalDb, peer.machineId, config.limits.targetBatchBytes);
    const observedAt = clock.now(), cursors: Array<{ storeKey: StoreKey; stream: string; through: number }> = [];
    const previousSync = state.observation?.lastSyncAt;
    let connected: boolean | null = null, completed = false;
    const observe = (storeKey: StoreKey, stream: string, through: number) => {
      const index = cursors.findIndex(row => row.storeKey === storeKey && row.stream === stream);
      if (index >= 0) cursors[index] = { storeKey, stream, through }; else cursors.push({ storeKey, stream, through });
    };
    try {
      const discovery = (await inventories).get(peer.machineId)!;
      if (discovery instanceof Error) throw discovery;
      handshake(discovery, peer); connected = true;
      if (!Array.isArray(discovery.stores)) throw new SyncFailure(1, "Invalid peer store list");
      const keys = [...new Set(discovery.stores.map(key => { storeScope(key); return key as StoreKey; }))].sort();
      if (!keys.includes("global")) throw new SyncFailure(1, "Peer global store is missing");
      state.ungathered = parseUngathered(discovery.ungathered);
      const unavailable = [...localUngathered, ...config.peers.flatMap(other => loadPeerState(globalDb, other.machineId, config.limits.targetBatchBytes).ungathered ?? [])];
      const blocked = (key: StoreKey) => unavailable.some(store => store.key === key);
      let globalReady = false, pulled = true;
      state.gathered = {}; state.unknownSessions ??= {};
      for (const store of state.ungathered) if (store.key) state.gathered[store.key] = false;
      for (const key of keys) {
        if (blocked(key)) { state.gathered[key] = false; continue; }
        if (key !== "global" && !globalReady) { pulled = false; continue; }
        try {
          await pull(peer, key, state, results); state.gathered[key] = true; delete state.unknownSessions[key];
          if (key === "global") globalReady = true;
        } catch (error) {
          if (error instanceof QuarantinedStore) { state.gathered[key] = true; state.unknownSessions[key] = error.sessions; }
          else pulled = false;
          results.push(failure(error, peer.machineId));
        }
      }
      state.readablePulled = keys.every(key => blocked(key) || state.gathered![key] === true);
      state.pulled = state.ungathered.length === 0 && keys.every(key => state.gathered![key] === true);
      savePeerState(globalDb, peer.machineId, state);
      assignHomes();
      for (const key of keys) {
        if (!globalReady) break;
        if (blocked(key)) continue;
        try { await push(peer, key, state, results, observe); }
        catch (error) { results.push(failure(error, peer.machineId)); if (key === "global") break; }
      }
      await mirrorHomes(peer);
      completed = pulled && globalReady && state.ungathered.length === 0 && !keys.some(blocked) && results.every(result => result.code === 0);
    } catch (error) { results.push(failure(error, peer.machineId)); }
    const uncertain = results.some(result => result.code === 3);
    const outage = results.some(isSyncConnectivityFailure);
    if (outage) state.failures++;
    else if (connected === true) state.failures = 0;
    state.observation = { machineId: peer.machineId, observedAt,
      connected: results.some(result => result.code === 3 && isSyncConnectivityFailure(result)) ? null : connected,
      lastSyncAt: completed ? clock.now() : Number.isSafeInteger(previousSync) && previousSync! >= 0 ? previousSync! : null,
      cursors: uncertain ? [] : cursors, failure: results.find(result => result.code === 1 && isPeerFailureReason(result.reason))?.reason ?? null };
    savePeerState(globalDb, peer.machineId, state);
    return results;
  }
  function failure(error: unknown, id: string): Outcome<ApplyReceipt> {
    const peerFailure = peerFailureReason(error);
    if (peerFailure) return outcome(1, peerFailure, id);
    if (isPeerConnectivityError(error) || error instanceof Error && error.name === "HerdrError")
      return outcome(3, "Peer operation is pending reconciliation", id);
    if (error instanceof RecoveryArtifactError) return outcome(error.code, error.message, id);
    if (error instanceof RecoveryResponseError) return { ...outcome(error.code, error.reason, error.operationId), operationKind: error.operationKind,
      ...(error.causeCode ? { causeCode: error.causeCode } : {}) };
    return { ...outcome(error instanceof SyncFailure ? error.code : error && typeof error === "object" && "retryable" in error && error.retryable ? 3 : 1,
      error instanceof SyncFailure ? error.message : "Store synchronization refused", error instanceof SyncFailure ? error.operationId ?? id : id),
      ...(error instanceof SyncFailure && error.causeCode ? { causeCode: error.causeCode } : {}),
      ...(error instanceof SyncFailure && error.operationKind ? { operationKind: error.operationKind } : {}) };
  }
  function schedule(peer: Peer, ms: number) {
    timers.get(peer.machineId)?.();
    timers.set(peer.machineId, clock.later(ms, () => { timers.delete(peer.machineId); void run(peer).catch(() => {}); }));
  }
  let inventoryRound: Promise<Map<string, JsonObject | Error>> | undefined;
  let localUngathered: UngatheredStore[] = [];
  function gatherInventories(): Promise<Map<string, JsonObject | Error>> {
    if (inventoryRound) return inventoryRound;
    try { globalDb.raw.transaction(() => {
      for (const entry of localEntries(globalDb, "first-home-withheld")) writeLocal(globalDb, "first-home-withheld", entry.key, undefined);
    }).immediate(); } catch { /* Missing diagnostic cleanup never blocks synchronization. */ }
    localUngathered = [];
    listStoreKeys(globalDb, { onUngathered: store => localUngathered.push(store) });
    const round = Promise.all(config.peers.map(peer => slot(async () => {
      if (ports.revocationDb && syncHandshake(ports.revocationDb, peer.machineId).kind === "retire-only") return [peer.machineId, new Error("peer-revoked")] as const;
      try {
        const discovery = await remote(peer, "stores", {}); handshake(discovery, peer);
        const state = loadPeerState(globalDb, peer.machineId, config.limits.targetBatchBytes);
        state.ungathered = parseUngathered(discovery.ungathered); state.pulled = false; state.readablePulled = false;
        savePeerState(globalDb, peer.machineId, state);
        return [peer.machineId, discovery] as const;
      } catch (error) {
        const state = loadPeerState(globalDb, peer.machineId, config.limits.targetBatchBytes);
        state.pulled = false; state.readablePulled = false; savePeerState(globalDb, peer.machineId, state);
        return [peer.machineId, error instanceof Error ? error : new Error("Peer inventory refused")] as const;
      }
    }))).then(rows => new Map<string, JsonObject | Error>(rows));
    inventoryRound = round;
    return round;
  }
  function run(peer: Peer): Promise<readonly Outcome<ApplyReceipt>[]> {
    const existing = inFlight.get(peer.machineId); if (existing) return existing;
    const inventories = gatherInventories();
    const task = slot(() => peerSync(peer, inventories)).then(async results => {
      await ports.onPeerSync?.(peer, results);
      return results;
    }).finally(() => {
      inFlight.delete(peer.machineId);
      if (!inFlight.size) inventoryRound = undefined;
      if (running) { const state = loadPeerState(globalDb, peer.machineId, config.limits.targetBatchBytes);
        schedule(peer, state.failures ? [30_000, 60_000, 120_000][Math.min(2, state.failures - 1)] : config.syncMs); }
    });
    inFlight.set(peer.machineId, task); return task;
  }
  const service: SyncAdapter = {
    start() { if (running || !config.enabled || config.role !== "hub") return; running = true; for (const peer of config.peers) schedule(peer, 0); },
    stop() { running = false; for (const cancel of timers.values()) cancel(); timers.clear(); },
    async drain() { while (inFlight.size) await Promise.allSettled([...inFlight.values()]); },
    async sync(machine) {
      if (!config.enabled || config.role !== "hub") return [outcome(1, "Hub synchronization is disabled", "")];
      const peers = machine ? config.peers.filter(peer => peer.machineId === machine) : config.peers;
      if (machine && peers.length !== 1) return [outcome(2, "Machine is not enrolled", "")];
      return (await Promise.all(peers.map(run))).flat();
    },
    async barriers(machine, required) {
      const peer = config.peers.find(peer => peer.machineId === machine); if (!peer || !config.enabled || config.role !== "hub") return false;
      try {
        assertNotRevoked(peer);
        const satisfied = async () => {
          const watermarks = await barrierWatermarks(stores, config, required); if (!watermarks) return false;
          for (const barrier of watermarks) if (await remoteCursor(peer, barrier.storeKey, barrier.stream) < barrier.through) return false;
          return true;
        };
        try { if (await satisfied()) return true; } catch { /* Retry through synchronization. */ }
        await service.sync(machine);
        return await satisfied();
      } catch { return false; }
    },
  };
  return service;
}
