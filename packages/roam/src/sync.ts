import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import type { Db } from "@spider/db-core";
import { assertBatchHeader, isRoamUuid, parseRoamJson, storeScope } from "@spider/db-core/roam/codec";
import type { ApplyReceipt, JsonObject, StoreKey } from "@spider/db-core/roam/types";
import { pullArtifact, readManifestPages, stageArtifact, transferArtifact } from "./artifacts";
import { barrierWatermarks } from "./barriers";
import type { Clock, Journal, Operation, Outcome, Peer, RoamConfig, StorePort, SyncService, Transport } from "./contracts";
import { assignInitialHome, markInitialConflict } from "./homes";
import { isPeerFailureReason, peerFailureReason } from "./peer-errors";
import { loadPeerState, receiptMatches, savePeerState, sizedBytes, type PeerState, type PendingBatch } from "./peer-state";
import { defaultStagingRoot } from "./staging";
import { removeOutgoing, type StoreAdapter } from "./stores";

interface Ports {
  config: RoamConfig; globalDb: Db; transport: Transport; journal: Journal; clock: Clock; stores: StorePort;
  onPeerSync?(peer: Peer, results: readonly Outcome<ApplyReceipt>[]): void | Promise<void>;
}
export interface SyncAdapter extends SyncService { drain(): Promise<void> }
class SyncFailure extends Error {
  readonly code: 1 | 2 | 3;
  readonly operationId: string | null;
  constructor(code: 1 | 2 | 3, message: string, operationId: string | null = null) { super(message); this.code = code; this.operationId = operationId; }
}
function object(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function outcome(code: 0 | 1 | 2 | 3, reason: string, operationId: string, value: ApplyReceipt | null = null): Outcome<ApplyReceipt> {
  return { code, reason, operationId, home: null, epoch: null, repairCommand: null, value };
}
function discard(file: string): void { if (existsSync(file)) unlinkSync(file); }
export function createSync(ports: Ports): SyncAdapter {
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
  async function remote(peer: Peer, kind: string, args: JsonObject, id: string = randomUUID()): Promise<JsonObject> {
    const operation: Operation = { id, machineId: peer.machineId, expectedEpoch: null, kind, args };
    const saved = journal.begin(operation);
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
    if (!object(decoded) || ![0, 1, 2, 3].includes(decoded.code as number) || decoded.operationId !== id) throw new SyncFailure(1, "Invalid peer outcome");
    if (decoded.code !== 0) {
      const reason = typeof decoded.reason === "string" && /^(?:Roaming todo collision between |Roaming row |Mapping fenced replica |Staging full \(quota\) at )/.test(decoded.reason)
        ? decoded.reason : `Peer ${kind} refused`;
      throw new SyncFailure(decoded.code as 1 | 2 | 3, reason, id);
    }
    if (!object(decoded.value)) throw new SyncFailure(1, "Invalid peer value");
    record(id, "done", { value: decoded.value, ...(kind === "split" ? { wire } : {}) });
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
  async function pull(peer: Peer, key: StoreKey, state: PeerState, results: Outcome<ApplyReceipt>[]) {
    const info = await remote(peer, "inventory", { storeKey: key }); handshake(info, peer);
    if (info.storeKey !== key || !isRoamUuid(info.stream) || info.roamable !== true) throw new SyncFailure(1, "Peer store is quarantined or invalid");
    for (;;) {
      const pending = attempt(state, peer, "pull", key, stores.cursor(key, peer.machineId, info.stream));
      const value = pending.exported ?? await remote(peer, "export", { storeKey: key, after: pending.after,
        targetBytes: pending.targetBytes, batchId: pending.id }, pending.id);
      assertBatchHeader(value.header);
      const header = value.header;
      if (header.storeKey !== key || header.senderMachine !== peer.machineId || header.senderStream !== info.stream || header.after !== pending.after || header.batchId !== pending.id) throw new SyncFailure(1, "Conflicting export header");
      pending.exported = value; savePeerState(globalDb, peer.machineId, state);
      if (header.count === 0) { if (value.artifact !== null) throw new SyncFailure(1, "Invalid empty export"); complete(state, peer, "pull", key); break; }
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
        receipt = await stores.accept(key, { header, file, sha256: artifact.sha256, byteLength: artifact.byteLength });
        if (!receiptMatches({ ...receipt }, header, artifact.sha256)) throw new SyncFailure(1, "Invalid committed local receipt");
        record(receiptId, "done", { value: { ...receipt } });
      }
      results.push(outcome(0, "pulled", receiptId, receipt));
      // A receipt on this hub is the authorization to release the peer's export.
      await remote(peer, "release-export", { exportId: pending.id, sha256: artifact.sha256 }, `release-${pending.id}`);
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
      if (batch.header.count === 0) { discard(batch.file); complete(state, peer, "push", key); break; }
      const prior = journal.read(`import-${pending.id}`).find(row => row.action === "done")?.result.value;
      if (object(prior) && receiptMatches(prior, batch.header, batch.sha256)) {
        removeOutgoing(defaultStagingRoot(), pending.id, config, () => true);
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
      discard(batch.file); complete(state, peer, "push", key, receipt);
    }
  }
  function assignHomes() {
    const gathered = config.peers.every(peer => loadPeerState(globalDb, peer.machineId, config.limits.targetBatchBytes).pulled);
    const adapter = stores as Partial<StoreAdapter>;
    if (!adapter.origins) return;
    for (const [id, origins] of adapter.origins()) {
      if (origins.size > 1) markInitialConflict(globalDb, id, config.hubMachineId);
      else if (gathered && origins.size === 1) assignInitialHome(globalDb, id, [...origins][0], config.hubMachineId);
    }
  }
  async function peerSync(peer: Peer): Promise<readonly Outcome<ApplyReceipt>[]> {
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
      const discovery = await remote(peer, "stores", {}); handshake(discovery, peer); connected = true;
      if (!Array.isArray(discovery.stores)) throw new SyncFailure(1, "Invalid peer store list");
      const keys = [...new Set(discovery.stores.map(key => { storeScope(key); return key as StoreKey; }))].sort();
      if (!keys.includes("global")) throw new SyncFailure(1, "Peer global store is missing");
      let globalReady = false, pulled = true;
      for (const key of keys) {
        if (key !== "global" && !globalReady) { pulled = false; continue; }
        try { await pull(peer, key, state, results); if (key === "global") globalReady = true; }
        catch (error) { pulled = false; results.push(failure(error, peer.machineId)); }
      }
      if (pulled) { state.pulled = true; savePeerState(globalDb, peer.machineId, state); }
      assignHomes();
      for (const key of keys) {
        if (!globalReady) break;
        try { await push(peer, key, state, results, observe); }
        catch (error) { results.push(failure(error, peer.machineId)); if (key === "global") break; }
      }
      completed = pulled && globalReady && results.every(result => result.code === 0);
    } catch (error) { results.push(failure(error, peer.machineId)); }
    const uncertain = results.some(result => result.code === 3);
    state.failures = uncertain ? state.failures + 1 : 0;
    state.observation = { machineId: peer.machineId, observedAt, connected: uncertain ? null : connected,
      lastSyncAt: completed ? clock.now() : Number.isSafeInteger(previousSync) && previousSync! >= 0 ? previousSync! : null,
      cursors: uncertain ? [] : cursors, failure: results.find(result => result.code === 1 && isPeerFailureReason(result.reason))?.reason ?? null };
    savePeerState(globalDb, peer.machineId, state);
    return results;
  }
  function failure(error: unknown, id: string): Outcome<ApplyReceipt> {
    return outcome(error instanceof SyncFailure ? error.code : error && typeof error === "object" && "retryable" in error && error.retryable ? 3 : 1,
      error instanceof SyncFailure ? error.message : "Store synchronization refused", error instanceof SyncFailure ? error.operationId ?? id : id);
  }
  function schedule(peer: Peer, ms: number) {
    timers.get(peer.machineId)?.();
    timers.set(peer.machineId, clock.later(ms, () => { timers.delete(peer.machineId); void run(peer).catch(() => {}); }));
  }
  function run(peer: Peer): Promise<readonly Outcome<ApplyReceipt>[]> {
    const existing = inFlight.get(peer.machineId); if (existing) return existing;
    const task = slot(() => peerSync(peer)).then(async results => {
      await ports.onPeerSync?.(peer, results);
      return results;
    }).finally(() => {
      inFlight.delete(peer.machineId);
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
        const watermarks = await barrierWatermarks(stores, config, required); if (!watermarks) return false;
        await service.sync(machine);
        for (const barrier of watermarks) if (await remoteCursor(peer, barrier.storeKey, barrier.stream) < barrier.through) return false;
        return true;
      } catch { return false; }
    },
  };
  return service;
}
