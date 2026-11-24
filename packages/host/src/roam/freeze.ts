import { MoveCompositionError } from "@spider/roam/move-failure";
import { createHash, randomUUID } from "node:crypto";
import { sameAddress, type IntercomIntakeFence, type SessionAddress } from "@spider/intercom/protocol";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Db } from "@spider/db-core";
import { storeScope } from "@spider/db-core/roam/codec";
import { readSessionState } from "@spider/db-core/roam/state";
import type { Blocker, Home, JsonObject, ProcessIdentity, StoreBarrier, StoreKey } from "@spider/db-core/roam/types";
import type { FreezeAck, IntercomMovePorts, Operation } from "@spider/roam/contracts";
import { isMachineId } from "@spider/roam/machine-id";
import type { FreezeJournal } from "@spider/roam/journal";
import { freezeAdmissionAndIntake, type AdmissionGate } from "./admission.js";
import { IntercomFenceError } from "./intercom.js";

export interface AbortAuthorization { home: Home; cancelledMoveId: string }
export interface FreezePorts {
  gate: AdmissionGate;
  journal: FreezeJournal;
  stores: readonly Db[];
  /** Complete roster from the participant's validated location catalog. */
  expectedStores: readonly StoreKey[];
  /** Missing intake evidence refuses a move; production leaves control unmounted until supplied. */
  intercom?: { address: SessionAddress; ports: IntercomMovePorts };
  drain(): Promise<void>;
  resume(): Promise<void>;
  inspect(fence?: IntercomIntakeFence): Promise<{ blockers: readonly Blocker[]; file: string; cwd: string; leaf: string; owner: ProcessIdentity | null }>;
  ingestThrough(file: string, size: number): Promise<void>;
  /** Fresh hub evidence must cover both the current home and cancellation. */
  authorizeAbort(operation: Operation): Promise<AbortAuthorization | null>;
  /** Notify on reconnection; the callback must not perform an initial connection. */
  onHubRestored(listener: () => void): () => void;
  /** Dormant adapters route retries through a new ownership and lock check. */
  retryAbort?(operation: Operation): Promise<void>;
}

export class FreezeBlockedError extends Error {
  readonly code = "freeze-blocked";
  constructor(readonly blockers: readonly Blocker[]) { super("Session has work that prevents freezing"); }
}
export class AbortAuthorizationPendingError extends Error {
  readonly code = "abort-authorization-pending";
  readonly retryable = true;
  constructor() { super("waiting for the hub to confirm the cancelled move"); }
}

type Identity = { sessionId: string; moveId: string; epoch: number };
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
function identity(operation: Operation, kind: "session-freeze" | "session-unfreeze" | "session-retire"): Identity {
  if (!operation || operation.kind !== kind || !text(operation.id) || !text(operation.machineId) || !operation.args ||
      !text(operation.args.sessionId) || !text(operation.args.moveId) || !Number.isSafeInteger(operation.expectedEpoch) || operation.expectedEpoch! < 1)
    throw new Error("Invalid participant control operation");
  return { sessionId: operation.args.sessionId, moveId: operation.args.moveId, epoch: operation.expectedEpoch! };
}
function validOwner(owner: ProcessIdentity | null): boolean {
  return owner === null || !!owner && text(owner.bootId) && Number.isSafeInteger(owner.pid) && owner.pid > 0 && text(owner.startTime);
}

// A live activation has one set of ports. Serialize freeze and abort against each other.
const transitions = new WeakMap<FreezePorts, Promise<void>>();
function sequence<T>(ports: FreezePorts, work: () => Promise<T>): Promise<T> {
  const previous = transitions.get(ports) ?? Promise.resolve();
  const next = previous.then(work);
  const settled = next.then(() => {}, () => {});
  transitions.set(ports, settled);
  void settled.then(() => { if (transitions.get(ports) === settled) transitions.delete(ports); });
  return next;
}

interface TranscriptSnapshot {
  size: number;
  sha256: string;
  cwd: string;
  physicalLeaf: string;
  entries: ReadonlySet<string>;
  verify(): Promise<void>;
  close(): Promise<void>;
}
async function snapshotTranscript(file: string, sessionId: string): Promise<TranscriptSnapshot> {
  if (!isAbsolute(file)) throw new Error("Invalid session file");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    const size = Number(before.size);
    if (!before.isFile() || !Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024 * 1024) throw new Error("Invalid session file size");
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder("utf-8", { fatal: true });
    const entries = new Set<string>();
    let position = 0, pending = "", cwd = "", physicalLeaf = "", haveHeader = false;
    const line = (source: string) => {
      const value: unknown = JSON.parse(source);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session entry");
      const row = value as Record<string, unknown>;
      if (!haveHeader) {
        if (row.type !== "session" || row.version !== 3 || row.id !== sessionId || typeof row.cwd !== "string" || !isAbsolute(row.cwd)) throw new Error("Invalid session header");
        cwd = row.cwd; haveHeader = true; return;
      }
      if (!text(row.type) || row.type === "session" || !text(row.id) || !text(row.timestamp) || entries.has(row.id) ||
          !(row.parentId === null || typeof row.parentId === "string" && entries.has(row.parentId))) throw new Error("Invalid session graph");
      if (row.type === "compaction" && (typeof row.firstKeptEntryId !== "string" || !entries.has(row.firstKeptEntryId)))
        throw new Error("Invalid compaction boundary");
      entries.add(row.id); physicalLeaf = row.id;
    };
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new Error("Session file changed during freeze");
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk); position += bytesRead; pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > 64 * 1024 * 1024) throw new Error("Session entry exceeds limit");
    }
    pending += decoder.decode();
    if (pending || !haveHeader || !physicalLeaf) throw new Error("Incomplete session file");
    const verify = async () => {
      const after = await handle.stat({ bigint: true }), path = await lstat(file, { bigint: true });
      if (!path.isFile() || path.isSymbolicLink() || path.dev !== before.dev || path.ino !== before.ino ||
          after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
          path.size !== before.size || path.mtimeNs !== before.mtimeNs || path.ctimeNs !== before.ctimeNs) {
        throw new Error("Session file changed during freeze");
      }
    };
    await verify();
    return { size, sha256: digest.digest("hex"), cwd, physicalLeaf, entries, verify, close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}

/** With no live selected branch, the last physical entry is the dormant leaf. */
export async function inspectDormantTranscript(file: string, sessionId: string): Promise<{ cwd: string; leaf: string }> {
  const snapshot = await snapshotTranscript(file, sessionId);
  try { return { cwd: snapshot.cwd, leaf: snapshot.physicalLeaf }; }
  finally { await snapshot.close(); }
}

type Meta = { machine_id: string; store_key: StoreKey | null; stream_id: string; capture_enabled: number; importing: number; roamable: number; problem: string | null };
function storeMeta(db: Db, machine: string): Meta & { store_key: StoreKey } {
  const meta = db.prepare("SELECT machine_id,store_key,stream_id,capture_enabled,importing,roamable,problem FROM roam_meta WHERE id=1").get() as Meta | undefined;
  if (!meta || meta.machine_id !== machine || !meta.store_key || !text(meta.stream_id) || meta.capture_enabled !== 1 ||
      meta.importing !== 0 || meta.roamable !== 1 || meta.problem !== null) throw new Error("Participant store is unavailable");
  storeScope(meta.store_key);
  return meta as Meta & { store_key: StoreKey };
}
function highSequence(db: Db): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM roam_changes").get() as { seq: number };
  if (!Number.isSafeInteger(row.seq) || row.seq < 0) throw new Error("Invalid participant barrier");
  return row.seq;
}
function freezeStore(db: Db, machine: string, key: Identity): StoreBarrier {
  return db.raw.transaction(() => {
    const meta = storeMeta(db, machine);
    let through = highSequence(db);
    if (storeScope(meta.store_key) === "worktree") {
      const state = readSessionState(db, key.sessionId);
      if (!state || state.epoch !== key.epoch) throw new Error("Participant store epoch does not match");
      if (state.state === "frozen" && state.moveId === key.moveId && Number.isSafeInteger(state.freezeSeq) && state.freezeSeq! >= 0 && state.freezeSeq! <= through) {
        through = state.freezeSeq!;
      } else {
        if (state.state !== "active") throw new Error("Participant store is not active");
        db.prepare("UPDATE roam_sessions SET state='frozen',move_id=?,freeze_seq=? WHERE session_id=? AND epoch=? AND state='active'")
          .run(key.moveId, through, key.sessionId, key.epoch);
      }
    }
    return { storeKey: meta.store_key, stream: meta.stream_id, through };
  }).immediate();
}
function unfreezeStore(db: Db, machine: string, key: Identity): void {
  db.raw.transaction(() => {
    const meta = storeMeta(db, machine);
    if (storeScope(meta.store_key) !== "worktree") return;
    const state = readSessionState(db, key.sessionId);
    if (!state || state.epoch !== key.epoch) throw new Error("Participant store epoch does not match");
    if (state.state === "active") return;
    if (state.state !== "frozen" || state.moveId !== key.moveId) throw new Error("Participant store cannot be reactivated");
    db.prepare("UPDATE roam_sessions SET state='active',move_id=NULL,freeze_seq=NULL WHERE session_id=? AND epoch=? AND state='frozen' AND move_id=?")
      .run(key.sessionId, key.epoch, key.moveId);
  }).immediate();
}
function roster(ports: FreezePorts, machine: string): void {
  if (!Array.isArray(ports.stores) || ports.stores.length === 0 || !Array.isArray(ports.expectedStores) || ports.expectedStores.length === 0)
    throw new Error("Participant store roster is unavailable");
  const names = new Set<string>();
  for (const db of ports.stores) {
    const meta = storeMeta(db, machine);
    if (names.has(meta.store_key)) throw new Error("Duplicate participant store");
    names.add(meta.store_key);
  }
  if (![...names].some(key => storeScope(key as StoreKey) === "worktree")) throw new Error("Participant worktree store is unavailable");
  if (new Set(ports.expectedStores).size !== ports.expectedStores.length || names.size !== ports.expectedStores.length ||
      ports.expectedStores.some(key => !names.has(key))) throw new MoveCompositionError("participant-stores-unavailable");
}

function intercomPorts(ports: FreezePorts, key: Identity) {
  if (!ports.intercom || ports.intercom.address.sessionId !== key.sessionId) throw new FreezeBlockedError([
    { kind: "intercom-fence-unsupported", id: key.sessionId, detail: "The session has no negotiated intercom intake fence." },
  ]);
  return ports.intercom;
}
function recordedFence(ports: FreezePorts, key: Identity): IntercomIntakeFence {
  const intercom = intercomPorts(ports, key), fence = ports.journal.readIntercomFence(key.sessionId, key.moveId);
  if (!fence || !sameAddress(fence.address, intercom.address) || fence.expectedEpoch !== key.epoch) throw new FreezeBlockedError([
    { kind: "intercom-generation-changed", id: key.sessionId, detail: "The durable intercom closure generation is unavailable." },
  ]);
  return fence;
}
async function checkIntercom(ports: FreezePorts, key: Identity, fence: IntercomIntakeFence): Promise<void> {
  const intercom = intercomPorts(ports, key);
  await intercom.ports.checkGeneration(fence);
  const snapshot = await intercom.ports.inspect(fence);
  if (snapshot.blockers.length) throw new FreezeBlockedError(snapshot.blockers);
  await intercom.ports.checkGeneration(fence);
}

async function verifyAcknowledgement(ack: FreezeAck, operation: Operation, key: Identity, ports: FreezePorts): Promise<void> {
  const fence = recordedFence(ports, key);
  if (!text(ack.intercomGeneration) || ack.intercomGeneration !== fence.generation) throw new Error("Invalid freeze intercom generation");
  await checkIntercom(ports, key, fence);
  roster(ports, operation.machineId);
  ports.journal.bindFreezeRoster(key.sessionId, key.moveId, key.epoch, ports.expectedStores);
  if (!ack || ack.operationId !== operation.id || ack.sessionId !== key.sessionId || ack.epoch !== key.epoch ||
      !Array.isArray(ack.barriers) || ack.barriers.length !== ports.stores.length) throw new Error("Invalid freeze acknowledgement");
  const barriers = new Map(ack.barriers.map(barrier => [barrier.storeKey, barrier]));
  if (barriers.size !== ports.stores.length) throw new Error("Invalid freeze barriers");
  for (const db of ports.stores) {
    const meta = storeMeta(db, operation.machineId), barrier = barriers.get(meta.store_key);
    if (!barrier || barrier.stream !== meta.stream_id || !Number.isSafeInteger(barrier.through) || barrier.through < 0 || highSequence(db) < barrier.through)
      throw new Error("Freeze barrier changed");
    if (storeScope(meta.store_key) === "worktree") {
      const state = readSessionState(db, key.sessionId);
      if (!state || state.state !== "frozen" || state.epoch !== key.epoch || state.moveId !== key.moveId || state.freezeSeq !== barrier.through)
        throw new Error("Participant is not frozen at its barrier");
    }
  }
  const transcript = await snapshotTranscript(ack.file, key.sessionId);
  try {
    if (transcript.size !== ack.size || transcript.sha256 !== ack.sha256 || !transcript.entries.has(ack.leaf) ||
        ack.owner === null && ack.leaf !== transcript.physicalLeaf) throw new Error("Frozen transcript changed");
  }
  finally { await transcript.close(); }
}

/** A successful acknowledgement is immutable and only follows a full durable freeze. */
export function freezeParticipant(operation: Operation, ports: FreezePorts): Promise<FreezeAck> {
  const key = identity(operation, "session-freeze");
  return sequence(ports, async () => {
    roster(ports, operation.machineId);
    const prior = ports.journal.begin(operation);
    const progress = ports.journal.beginFreeze(key.sessionId, key.moveId, key.epoch);
    if (prior.kind === "done") {
      if (progress.state !== "frozen") throw new Error("Freeze is no longer active");
      const ack = prior.result as unknown as FreezeAck;
      await verifyAcknowledgement(ack, operation, key, ports);
      return ack;
    }
    const fence = await freezeAdmissionAndIntake(ports.gate, key.moveId, key.epoch, async () => {
      const intercom = intercomPorts(ports, key);
      const intended = ports.journal.readIntercomFence(key.sessionId, key.moveId) ?? {
        address: intercom.address, moveId: key.moveId, expectedEpoch: key.epoch, generation: randomUUID(),
      };
      ports.journal.bindIntercomFence(intended);
      try { return await intercom.ports.close(intended.address, key.moveId, key.epoch, intended.generation); }
      catch (error) { if (error instanceof IntercomFenceError) throw new FreezeBlockedError(error.blockers); throw error; }
    });
    if (fence.generation !== recordedFence(ports, key).generation) throw new Error("Intercom closure generation changed");
    await ports.drain();
    await intercomPorts(ports, key).ports.drain(fence);
    const observed = await ports.inspect(fence);
    if (!observed || !Array.isArray(observed.blockers) || observed.blockers.some(blocker => !blocker || !text(blocker.kind) || !text(blocker.id) || !text(blocker.detail)))
      throw new Error("Invalid blocker evidence");
    const intercom = await intercomPorts(ports, key).ports.inspect(fence);
    if (observed.blockers.length || intercom.blockers.length) throw new FreezeBlockedError([...observed.blockers, ...intercom.blockers]);
    if (!text(observed.file) || !text(observed.cwd) || !isAbsolute(observed.cwd) || !text(observed.leaf) || !validOwner(observed.owner)) throw new Error("Invalid participant evidence");
    roster(ports, operation.machineId);
    ports.journal.bindFreezeRoster(key.sessionId, key.moveId, key.epoch, ports.expectedStores);
    const snapshot = await snapshotTranscript(observed.file, key.sessionId);
    try {
      if (!snapshot.entries.has(observed.leaf) || observed.owner === null && observed.leaf !== snapshot.physicalLeaf)
        throw new Error("Participant physical leaf does not match");
      const barriers: StoreBarrier[] = [];
      for (const db of ports.stores) {
        const meta = storeMeta(db, operation.machineId);
        ports.journal.record(operation.id, "store-freezing", { storeKey: meta.store_key });
        const barrier = freezeStore(db, operation.machineId, key);
        barriers.push(barrier);
        ports.journal.record(operation.id, "store-frozen", { ...barrier });
      }
      await ports.ingestThrough(observed.file, snapshot.size);
      await snapshot.verify();
      await checkIntercom(ports, key, fence);
      const ack: FreezeAck = { operationId: operation.id, sessionId: key.sessionId, epoch: key.epoch, owner: observed.owner,
        file: observed.file, cwd: observed.cwd, leaf: observed.leaf, size: snapshot.size, sha256: snapshot.sha256, barriers, intercomGeneration: fence.generation };
      ports.journal.advanceFreeze(key.sessionId, key.moveId, key.epoch, "frozen");
      ports.journal.record(operation.id, "done", ack as unknown as JsonObject);
      return ack;
    } finally { await snapshot.close(); }
  });
}

/** Caller holds both dormant locks and has proved that the participant process exited. */
export async function retireDormantParticipant(operation: Operation, ports: FreezePorts & {
  authorizeRetire(operation: Operation): Promise<Home | null>;
}): Promise<void> {
  const key = identity(operation, "session-retire");
  await sequence(ports, async () => {
    const prior = ports.journal.begin(operation);
    if (prior.kind === "done") return;
    const progress = ports.journal.readFreeze(key.sessionId, key.moveId);
    if (!progress || progress.epoch !== key.epoch || !["frozen", "complete"].includes(progress.state)) throw new Error("Freeze is unavailable for retirement");
    let home: Home | null = null;
    try { home = await ports.authorizeRetire(operation); } catch { /* Missing hub evidence is not a commit. */ }
    if (!home || home.sessionId !== key.sessionId || home.machineId === operation.machineId || !isMachineId(home.machineId) ||
        !Number.isSafeInteger(home.epoch) || home.epoch !== key.epoch + 1 || home.moveId !== key.moveId ||
        !Number.isSafeInteger(home.updatedAt) || home.updatedAt < 0) throw new Error("Committed home evidence unavailable");
    roster(ports, operation.machineId);
    ports.journal.bindFreezeRoster(key.sessionId, key.moveId, key.epoch, ports.expectedStores);
    for (const db of ports.stores) {
      const meta = storeMeta(db, operation.machineId);
      if (storeScope(meta.store_key) !== "worktree") continue;
      const state = readSessionState(db, key.sessionId);
      if (!state || state.epoch !== key.epoch || state.moveId !== key.moveId || !["frozen", "retired"].includes(state.state))
        throw new Error("Participant cannot be retired");
    }
    for (const db of ports.stores) {
      const meta = storeMeta(db, operation.machineId);
      if (storeScope(meta.store_key) !== "worktree") continue;
      ports.journal.record(operation.id, "store-retiring", { storeKey: meta.store_key });
      db.raw.transaction(() => {
        const state = readSessionState(db, key.sessionId);
        if (!state || state.epoch !== key.epoch || state.moveId !== key.moveId || !["frozen", "retired"].includes(state.state))
          throw new Error("Participant changed during retirement");
        if (state.state === "frozen") db.prepare("UPDATE roam_sessions SET state='retired' WHERE session_id=? AND epoch=? AND state='frozen' AND move_id=?")
          .run(key.sessionId, key.epoch, key.moveId);
      }).immediate();
      ports.journal.record(operation.id, "store-retired", { storeKey: meta.store_key });
    }
    ports.journal.advanceFreeze(key.sessionId, key.moveId, key.epoch, "complete");
  });
}

const abortWatches = new WeakMap<FreezePorts, Map<string, () => void>>();
function clearAbortWatch(ports: FreezePorts, id: string): void {
  const watches = abortWatches.get(ports), stop = watches?.get(id);
  if (stop) { watches!.delete(id); stop(); }
}
export function disposeFreezePorts(ports: FreezePorts): void {
  const watches = abortWatches.get(ports);
  if (!watches) return;
  abortWatches.delete(ports);
  for (const [id] of watches) clearAbortWatchFrom(watches, id);
}
function clearAbortWatchFrom(watches: Map<string, () => void>, id: string): void {
  const stop = watches.get(id); watches.delete(id); stop?.();
}
function watchAbort(operation: Operation, ports: FreezePorts): void {
  let watches = abortWatches.get(ports);
  if (!watches) { watches = new Map(); abortWatches.set(ports, watches); }
  if (watches.has(operation.id)) return;
  const current = watches;
  const retry = () => {
    if (!current.has(operation.id)) return;
    void (async () => {
      if (ports.retryAbort) { await ports.retryAbort(operation); clearAbortWatch(ports, operation.id); }
      else await unfreezeParticipant(operation, ports);
    })().catch(() => {});
  };
  let stop: () => void;
  try { stop = ports.onHubRestored(retry); } catch { throw new AbortAuthorizationPendingError(); }
  if (typeof stop !== "function") throw new AbortAuthorizationPendingError();
  watches.set(operation.id, stop);
  // Recheck once after subscribing so a return between the failed check and subscription is not lost.
  queueMicrotask(retry);
}

/** The hub must cancel the move before any participant store can become active. */
export function unfreezeParticipant(operation: Operation, ports: FreezePorts): Promise<void> {
  const key = identity(operation, "session-unfreeze");
  return sequence(ports, async () => {
    const prior = ports.journal.begin(operation);
    if (prior.kind === "done") { clearAbortWatch(ports, operation.id); return; }
    const progress = ports.journal.readFreeze(key.sessionId, key.moveId);
    if (!progress || progress.epoch !== key.epoch || progress.state === "complete") throw new Error("Freeze is unavailable for abort");
    let proof: AbortAuthorization | null = null;
    try { proof = await ports.authorizeAbort(operation); } catch { /* An unreachable hub is not authorization. */ }
    if (!proof || proof.cancelledMoveId !== key.moveId || !proof.home || proof.home.sessionId !== key.sessionId ||
        proof.home.machineId !== operation.machineId || proof.home.epoch !== key.epoch) {
      watchAbort(operation, ports);
      throw new AbortAuthorizationPendingError();
    }
    const fence = recordedFence(ports, key);
    await freezeAdmissionAndIntake(ports.gate, key.moveId, key.epoch, () => intercomPorts(ports, key).ports.close(fence.address, key.moveId, key.epoch, fence.generation));
    await intercomPorts(ports, key).ports.checkGeneration(fence);
    roster(ports, operation.machineId);
    if (!ports.journal.readFreezeRoster(key.sessionId, key.moveId)) {
      // A crash before binding the roster cannot have frozen any store yet.
      if (progress.state !== "freezing" || ports.stores.some(db => {
        const meta = storeMeta(db, operation.machineId);
        return storeScope(meta.store_key) === "worktree" && readSessionState(db, key.sessionId)?.state !== "active";
      })) throw new Error("Freeze store roster is unavailable");
    }
    ports.journal.bindFreezeRoster(key.sessionId, key.moveId, key.epoch, ports.expectedStores);
    if (progress.state !== "aborted") {
      ports.journal.advanceFreeze(key.sessionId, key.moveId, key.epoch, "aborting");
      ports.journal.record(operation.id, "abort-authorized", { sessionId: key.sessionId, moveId: key.moveId, epoch: key.epoch });
      for (const db of ports.stores) unfreezeStore(db, operation.machineId, key);
      ports.journal.advanceFreeze(key.sessionId, key.moveId, key.epoch, "aborted");
    } else {
      // A stale retry must not reactivate a later frozen or retired state.
      for (const db of ports.stores) {
        const meta = storeMeta(db, operation.machineId);
        if (storeScope(meta.store_key) === "worktree") {
          const state = readSessionState(db, key.sessionId);
          if (!state || state.state !== "active" || state.epoch !== key.epoch) throw new Error("Participant state changed after cancellation");
        }
      }
    }
    if (ports.gate.inspect().kind !== "ordinary") await ports.gate.unfreeze(key.moveId, key.epoch);
    try {
      if (!ports.journal.read(operation.id).some(row => row.action === "producers-resumed")) {
        await intercomPorts(ports, key).ports.abort(fence);
        await ports.resume();
        ports.journal.record(operation.id, "producers-resumed", {});
      }
    } catch (error) {
      await freezeAdmissionAndIntake(ports.gate, key.moveId, key.epoch, () => intercomPorts(ports, key).ports.close(fence.address, key.moveId, key.epoch, fence.generation));
      throw error;
    }
    ports.journal.record(operation.id, "done", { sessionId: key.sessionId, moveId: key.moveId, epoch: key.epoch });
    clearAbortWatch(ports, operation.id);
  });
}
