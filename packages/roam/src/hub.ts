import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertTestConfigPath, type Db } from "@spider/db-core";
import { localEntries, readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { resumePendingMappings } from "@spider/db-core/roam/repo-map";
import type { ApplyReceipt, JsonObject, Readiness } from "@spider/db-core/roam/types";
import { createRoamPlacement } from "@spider/herdr/roam-placement";
import { hash, withProcessLock } from "@spider/herdr/sessions/registry";
import type { ProcessIdentity, ProcessProbe } from "@spider/herdr/sessions/lease";
import { createAgentPorts } from "./agent";
import { sweepStoreArtifacts } from "./cleanup";
import { startHubControl, type HubControlReply, type HubControlRequest } from "./control-socket";
import type { AgentPorts, Clock, HubPorts, Journal, Outcome, Peer, PlacementPort, RoamConfig, SyncService, Transport } from "./contracts";
import { defaultStagingRoot, privateDirectory } from "./staging";
import { createStorePort, type StoreAdapter } from "./stores";
import { createSync, type SyncAdapter } from "./sync";
import { removedPlacementSessions } from "./placement-inventory";

const UNREACHABLE_MS = 10 * 60_000;
const LOCK = "roam-hub";
type PeerResult = readonly Outcome<ApplyReceipt>[];
export interface HubObservation {
  reachability: "reachable" | "unreachable" | "unknown";
  /** Null means the terminal inventory could not be observed. */
  readiness: readonly Readiness[] | null;
  /** Null means suspension state could not be observed. */
  suspensions: readonly { sessionId: string; epoch: number }[] | null;
}
export interface HubNotice { id: string; kind: "unreachable" | "suspended"; machineId: string; sessionId?: string }
export interface HubNoticePort {
  /** Publish is idempotent by id, including after a lost reply. */
  publish(notice: HubNotice): Promise<void>;
  clear(id: string): Promise<void>;
}
type Alert = { id: string; delivered: boolean; clearing: boolean; sessionId?: string; epoch?: number };
type PeerStatus = { since: number | null; unreachable: Alert | null; suspensions: Alert[] };
type Prepare = (onPeerSync: (peer: Peer, results: PeerResult) => Promise<void>) => Promise<void>;

export interface HubRuntimePorts extends HubPorts {
  globalDb: Db;
  runtimeRoot: string;
  socketPath: string;
  identity: ProcessIdentity;
  probe(pid: number): Promise<ProcessProbe>;
  observe(peer: Peer, results: PeerResult): Promise<HubObservation>;
  notices: HubNoticePort;
  homeChangeInProgress(): Promise<boolean | null>;
  prepare: Prepare;
  drain(): Promise<void>;
  closeStores(): void | Promise<void>;
}
export interface StandaloneHubPorts {
  config: RoamConfig; globalDb: Db; journal: Journal; transport: Transport; clock: Clock;
  placement: PlacementPort | Omit<Parameters<typeof createRoamPlacement>[0], "removedSessions">;
  runtimeRoot: string; socketPath: string; identity: ProcessIdentity;
  probe(pid: number): Promise<ProcessProbe>;
  observe(peer: Peer, results: PeerResult): Promise<HubObservation>;
  notices: HubNoticePort;
  homeChangeInProgress(): Promise<boolean | null>;
  /** Null or a failure means activity cannot be proved absent. */
  artifactActive(value: string): boolean | null;
}

function validAlert(value: unknown): value is Alert {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as Alert;
  return typeof a.id === "string" && !!a.id && typeof a.delivered === "boolean" && typeof a.clearing === "boolean" &&
    (a.sessionId === undefined || typeof a.sessionId === "string" && !!a.sessionId) &&
    (a.epoch === undefined || Number.isSafeInteger(a.epoch) && a.epoch! > 0);
}
function peerStatus(db: Db, machine: string): PeerStatus {
  const state = readLocal<PeerStatus>(db, "hub-peer", machine);
  if (state === undefined) return { since: null, unreachable: null, suspensions: [] };
  if (!state || !(state.since === null || Number.isSafeInteger(state.since) && state.since! >= 0) ||
      !(state.unreachable === null || validAlert(state.unreachable)) || !Array.isArray(state.suspensions) ||
      state.suspensions.some(alert => !validAlert(alert) || !alert.sessionId || !alert.epoch)) throw new Error("Invalid durable hub status");
  return state;
}
function saveStatus(db: Db, machine: string, state: PeerStatus): void {
  db.raw.transaction(() => writeLocal(db, "hub-peer", machine, state)).immediate();
}
function pendingRows(db: Db, machine: string): Readiness[] {
  const value = readLocal<unknown>(db, "hub-placement", machine);
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(row => !validReadiness(row))) throw new Error("Invalid durable placement state");
  return value as Readiness[];
}
function savePending(db: Db, machine: string, rows: readonly Readiness[]): void {
  db.raw.transaction(() => writeLocal(db, "hub-placement", machine, rows.length ? rows : undefined)).immediate();
}
function plain(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}
function validReadiness(value: unknown): value is Readiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Readiness;
  return plain(row.operationId) && plain(row.sessionId) && Number.isSafeInteger(row.epoch) && row.epoch > 0 &&
    plain(row.cwd) && isAbsolute(row.cwd) && plain(row.file) && isAbsolute(row.file) && plain(row.core) && plain(row.terminal);
}
function validObservation(value: unknown): value is HubObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as HubObservation;
  return ["reachable", "unreachable", "unknown"].includes(row.reachability) &&
    (row.readiness === null || Array.isArray(row.readiness) && row.readiness.every(validReadiness)) &&
    (row.suspensions === null || Array.isArray(row.suspensions) && row.suspensions.every(item => item && plain(item.sessionId) && Number.isSafeInteger(item.epoch) && item.epoch > 0));
}
function homed(db: Db, machine: string, session: string, epoch: number): boolean {
  return !!db.prepare("SELECT 1 FROM session_homes WHERE session_id=? AND machine_id=? AND epoch=?").get(session, machine, epoch);
}
function hasHomes(db: Db, machine: string): boolean {
  return !!db.prepare("SELECT 1 FROM session_homes WHERE machine_id=? LIMIT 1").get(machine);
}
function json(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }

/** Run the hub while holding one injected-process-identity lock. */
export async function runHub(ports: HubRuntimePorts): Promise<{ stop(): Promise<void> }> {
  const { config, globalDb: db, clock } = ports;
  if (!config.enabled || config.role !== "hub" || config.machineId !== config.hubMachineId) throw new Error("Hub synchronization is disabled");
  if (!isAbsolute(ports.runtimeRoot) || !isAbsolute(ports.socketPath)) throw new Error("Hub runtime paths must be absolute");
  const root = resolve(ports.runtimeRoot), socket = resolve(ports.socketPath), rel = relative(root, socket);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Hub control socket must be inside the runtime directory");
  assertTestConfigPath(join(root, "hub-lock")); assertTestConfigPath(socket);
  privateDirectory(root); privateDirectory(join(root, "locks")); privateDirectory(join(root, "locks", hash(LOCK)));
  const timers = new Map<string, () => void>();
  const queues = new Map<string, Promise<void>>();
  let stopping = false, disabled = false;

  function queue(peer: Peer, work: () => Promise<void>): Promise<void> {
    const prior = queues.get(peer.machineId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    queues.set(peer.machineId, next);
    void next.finally(() => { if (queues.get(peer.machineId) === next) queues.delete(peer.machineId); }).catch(() => {});
    return next;
  }
  function cancelTimer(machine: string): void { timers.get(machine)?.(); timers.delete(machine); }
  function schedule(peer: Peer, delay: number): void {
    cancelTimer(peer.machineId);
    if (stopping || disabled) return;
    timers.set(peer.machineId, clock.later(Math.max(0, delay), () => {
      timers.delete(peer.machineId);
      void queue(peer, () => unreachable(peer)).catch(() => {});
    }));
  }
  async function flushAlerts(peer: Peer): Promise<void> {
    let state = peerStatus(db, peer.machineId);
    const entries = [...(state.unreachable ? [{ kind: "unreachable" as const, alert: state.unreachable }] : []),
      ...state.suspensions.map(alert => ({ kind: "suspended" as const, alert }))];
    for (const { kind, alert } of entries) {
      try {
        if (alert.clearing) await ports.notices.clear(alert.id);
        else if (!alert.delivered) await ports.notices.publish({ id: alert.id, kind, machineId: peer.machineId, ...(alert.sessionId ? { sessionId: alert.sessionId } : {}) });
        else continue;
        state = peerStatus(db, peer.machineId);
        if (kind === "unreachable" && state.unreachable?.id === alert.id) {
          if (alert.clearing) state.unreachable = null; else state.unreachable.delivered = true;
        } else {
          const current = state.suspensions.find(item => item.id === alert.id);
          if (current && alert.clearing) state.suspensions = state.suspensions.filter(item => item.id !== alert.id);
          else if (current) current.delivered = true;
        }
        saveStatus(db, peer.machineId, state);
      } catch { /* The same notice ID is retried after the next observation. */ }
    }
  }
  async function unreachable(peer: Peer): Promise<void> {
    if (stopping || disabled) return;
    const state = peerStatus(db, peer.machineId);
    if (state.since === null) return;
    if (!hasHomes(db, peer.machineId)) {
      state.since = null;
      if (state.unreachable) state.unreachable.clearing = true;
      saveStatus(db, peer.machineId, state); await flushAlerts(peer); return;
    }
    const remaining = state.since + UNREACHABLE_MS - clock.now();
    if (remaining > 0) { schedule(peer, remaining); return; }
    if (!state.unreachable) { state.unreachable = { id: randomUUID(), delivered: false, clearing: false }; saveStatus(db, peer.machineId, state); }
    await flushAlerts(peer);
  }
  async function afterSync(peer: Peer, results: PeerResult): Promise<void> {
    await queue(peer, async () => {
      if (stopping || disabled) return;
      let observation: HubObservation;
      try { observation = await ports.observe(peer, results); } catch { return; }
      if (!validObservation(observation) || observation.reachability === "unknown") return;
      let state = peerStatus(db, peer.machineId);
      if (observation.reachability === "unreachable") {
        if (!hasHomes(db, peer.machineId)) {
          state.since = null; if (state.unreachable) state.unreachable.clearing = true;
          saveStatus(db, peer.machineId, state); cancelTimer(peer.machineId); await flushAlerts(peer); return;
        }
        if (state.since === null) { state.since = clock.now(); saveStatus(db, peer.machineId, state); }
        await unreachable(peer); return;
      }
      cancelTimer(peer.machineId);
      state.since = null;
      if (state.unreachable) state.unreachable.clearing = true;
      if (observation.suspensions !== null) {
        const current = observation.suspensions.filter(item => homed(db, peer.machineId, item.sessionId, item.epoch));
        for (const existing of state.suspensions) if (!current.some(item => item.sessionId === existing.sessionId && item.epoch === existing.epoch)) existing.clearing = true;
        for (const item of current) if (!state.suspensions.some(existing => existing.sessionId === item.sessionId && existing.epoch === item.epoch && !existing.clearing))
          state.suspensions.push({ id: randomUUID(), delivered: false, clearing: false, sessionId: item.sessionId, epoch: item.epoch });
      }
      saveStatus(db, peer.machineId, state);
      await flushAlerts(peer);
      if (observation.readiness === null) return;
      const rows = observation.readiness.filter(row => homed(db, peer.machineId, row.sessionId, row.epoch) &&
        (!row.terminal.includes("/") || row.terminal.slice(0, row.terminal.indexOf("/")) === peer.alias));
      // Persist before placement, whose launch reply may be lost.
      savePending(db, peer.machineId, rows);
      try {
        const result = await ports.placement.reconcile(rows);
        if (!result || !Array.isArray(result.pending) || result.pending.some(value => !rows.some(row => row.terminal === value))) throw new Error("Invalid placement result");
        savePending(db, peer.machineId, rows.filter(row => result.pending.includes(row.terminal)));
      } catch { /* Unobserved launch outcomes remain pending for reconciliation. */ }
    });
  }
  function status(): JsonObject {
    const pending = config.peers.flatMap(peer => pendingRows(db, peer.machineId).map(row => ({ machineId: peer.machineId, sessionId: row.sessionId, terminal: row.terminal })));
    const warnings = config.peers.flatMap(peer => {
      const state = peerStatus(db, peer.machineId);
      return [...(state.unreachable ? [{ machineId: peer.machineId, kind: "unreachable" }] : []),
        ...state.suspensions.map(alert => ({ machineId: peer.machineId, kind: "suspended", sessionId: alert.sessionId }))];
    });
    return json({ enabled: !disabled, pending, warnings });
  }
  async function control(request: HubControlRequest): Promise<HubControlReply> {
    if (request.op === "status") return { code: 0, reason: "ok", value: status() };
    if (request.op === "disable") {
      let moving: boolean | null;
      try { moving = await ports.homeChangeInProgress(); } catch { moving = null; }
      if (moving !== false) return { code: 1, reason: "A home change is in progress or unknown", value: null };
      disabled = true; ports.sync.stop(); for (const peer of config.peers) cancelTimer(peer.machineId);
      await ports.drain();
      return { code: 0, reason: "Hub scheduling disabled", value: null };
    }
    if (disabled || stopping) return { code: 1, reason: "Hub synchronization is disabled", value: null };
    const results = await ports.sync.sync(request.machine);
    const code = results.some(row => row.code === 3) ? 3 : results.some(row => row.code === 1) ? 1 : results.some(row => row.code === 2) ? 2 : 0;
    return { code, reason: code === 0 ? "Synchronization complete" : "Synchronization needs attention", value: json({ outcomes: results }) };
  }

  let ready!: (value: { stop(): Promise<void> }) => void, rejectReady!: (error: unknown) => void;
  const started = new Promise<{ stop(): Promise<void> }>((resolveReady, reject) => { ready = resolveReady; rejectReady = reject; });
  let release!: () => void;
  const hold = new Promise<void>(resolveHold => { release = resolveHold; });
  let endpoint: Awaited<ReturnType<typeof startHubControl>> | undefined;
  let completion!: Promise<void>, stopPromise: Promise<void> | undefined;
  completion = withProcessLock(root, LOCK, async () => {
    try {
      await ports.prepare(afterSync);
      // Validate retained state before opening the control socket or starting sync.
      for (const peer of config.peers) {
        const state = peerStatus(db, peer.machineId); pendingRows(db, peer.machineId);
        if (state.since !== null && !state.unreachable?.delivered) schedule(peer, Math.max(0, state.since + UNREACHABLE_MS - clock.now()));
      }
      endpoint = await startHubControl(socket, control);
      ports.sync.start();
      ready({ stop() { return stopPromise ??= (async () => { release(); await completion; })(); } });
      await hold;
    } finally {
      stopping = true; ports.sync.stop();
      for (const peer of config.peers) cancelTimer(peer.machineId);
      await endpoint?.close();
      await ports.drain();
      await Promise.allSettled([...queues.values()]);
      await ports.closeStores();
    }
  }, { identity: ports.identity, probe: ports.probe, timeoutMs: 100 });
  void completion.catch(rejectReady);
  return started;
}

function pendingReference(db: Db, value: string): boolean {
  try {
    const terms = [...new Set([value, basename(value).replace(/\.ndjson$/, "")])].filter(Boolean);
    for (const row of localEntries<{ pending?: unknown }>(db, "sync-peer")) {
      if (!row.value || !row.value.pending || typeof row.value.pending !== "object" || Array.isArray(row.value.pending)) return true;
      for (const item of Object.values(row.value.pending)) {
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof (item as { id?: unknown }).id !== "string") return true;
        const id = (item as { id: string }).id, encoded = JSON.stringify(item);
        if (terms.some(term => encoded.includes(term) || term.includes(id))) return true;
      }
    }
    return false;
  } catch { return true; }
}
function artifactReferenced(db: Db, journal: Journal, value: string): boolean {
  if (pendingReference(db, value)) return true;
  const candidate = journal as Partial<Journal & { hasArtifactReference(value: string): boolean }>;
  try { return typeof candidate.hasArtifactReference !== "function" || candidate.hasArtifactReference(value) !== false; }
  catch { return true; }
}

/** Construct storage and synchronization only after the lock and mapping recovery. */
export async function runStandaloneHub(ports: StandaloneHubPorts): Promise<{ stop(): Promise<void>; agentPorts: AgentPorts }> {
  if (resolve(defaultStagingRoot()) !== join(dirname(resolve(ports.globalDb.raw.name)), "roam", "staging")) {
    throw new Error("Hub staging root does not match the global database");
  }
  let stores: StoreAdapter | undefined, sync: SyncAdapter | undefined;
  const delegated: SyncService = {
    start() { if (!sync) throw new Error("Hub synchronization is not prepared"); sync.start(); },
    stop() { sync?.stop(); },
    sync(machine) { if (!sync) throw new Error("Hub synchronization is not prepared"); return sync.sync(machine); },
    barriers(machine, required) { if (!sync) throw new Error("Hub synchronization is not prepared"); return sync.barriers(machine, required); },
  };
  const placement = "reconcile" in ports.placement ? ports.placement : createRoamPlacement({ ...ports.placement,
    async removedSessions(sessions) { return removedPlacementSessions(ports.globalDb, sessions); },
  });
  const hub = await runHub({ ...ports, placement, sync: delegated,
    async prepare(onPeerSync) {
      await resumePendingMappings(ports.globalDb);
      stores = createStorePort(ports.config, ports.globalDb);
      stores.recoverCatalog();
      sweepStoreArtifacts(stores, ports.config, { now: ports.clock.now(),
        referenced: value => artifactReferenced(ports.globalDb, ports.journal, value),
        active: value => { try { return ports.artifactActive(value) !== false; } catch { return true; } },
      });
      sync = createSync({ config: ports.config, globalDb: ports.globalDb, transport: ports.transport,
        journal: ports.journal, clock: ports.clock, stores, onPeerSync });
    },
    async drain() { await sync?.drain(); },
    closeStores() { stores?.close(); },
  });
  const adapter = stores as StoreAdapter | undefined;
  if (!adapter) { await hub.stop(); throw new Error("Hub stores are not prepared"); }
  return { ...hub, agentPorts: createAgentPorts({ config: ports.config, journal: ports.journal, openStore: adapter.openStore }) };
}
