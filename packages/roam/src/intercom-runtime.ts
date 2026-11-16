import { startMachineMoveSocket } from "./machine-move-socket";
import { randomUUID } from "node:crypto";
import { localEntries } from "@spider/db-core/roam/local-state";
import { openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import { listStoreKeys } from "./store-inventory";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Db } from "@spider/db-core";
import { assertTestConfigPath, openDbReadOnly } from "@spider/db-core";
import { IntercomFederationClient } from "@spider/intercom/broker/client";
import { spawnBrokerIfNeeded } from "@spider/intercom/broker/spawn";
import { addressKey, sameAddress, type FederationBlockers, type IntercomIntakeFence, type LocalPresence, type RemoteSessionInfo, type SessionAddress, type SessionEndpoint } from "@spider/intercom/protocol";
import type { Home } from "@spider/db-core/roam/types";
import { sessionHome } from "./homes";
import { createIntercomMovePorts } from "./intercom-move";
import { createRollbackIntercomPorts, type MoveEvidenceBindings, type RollbackEvidence } from "./move-ports";
import type { Operation } from "./contracts";
import type { Clock, IntercomLifecycle, Peer, RoamConfig, Transport } from "./contracts";
import { createIntercomBridge, type IntercomBridge, type IntercomBroker } from "./intercom-bridge";
import { acquireHelperRoute, type HelperRouteLease } from "./intercom-route";
import { openIntercomStore } from "./intercom-store";
import type { IntercomStore } from "./intercom-contracts";
import { isMachineId } from "./machine-id";
import { createHostIntercomDelivery, type HostIntercomDelivery } from "./intercom-delivery";
import { hasIntercomGeneration, pruneIntercomRecords } from "./intercom-exclusion";
import { firstHomeEndpointMatches, readFirstHomeAdoption } from "./intercom-first-home";
import { createIntercomRegistry, withIntercomPeerLock } from "./intercom-registry";
import { readLocalIdentity } from "./runtime";
import { topologyTransitionId } from "./intercom-topology";
import { openJournal, openFreezeJournal } from "./journal";
import type { IntercomEnrollmentPair } from "./provision-contracts";

export interface MachineIntercomOptions {
  root: string;
  globalDb: Db;
  config: RoamConfig;
  roamingEnabled?(): boolean;
  moveJournal?: import("./journal").FreezeJournal;
  agentDir: string;
  clock: Clock;
  transport: Transport;
  directPeers?: Peer[];
  pairScopedHostReady?(pairId: string): Promise<boolean>;
  recoverRevocations?(store: IntercomStore): Promise<unknown>;
  broker?: IntercomBroker;
  env?: NodeJS.ProcessEnv;
  ensureBroker?(input: { agentDir: string; signal: AbortSignal }): Promise<void>;
  generationKnown?(sessionId: string, generation: string): boolean;
  moveRollbackProof?(operation: Operation): Promise<RollbackEvidence | null>;
  moveOwns?(endpoint: SessionEndpoint): Promise<boolean>;
}
export interface MachineMovePort {
  intake: import("./contracts").IntercomMovePorts;
  broker(address: SessionAddress): Promise<FederationBlockers>;
  bridge(address: SessionAddress): Promise<FederationBlockers>;
  settlement: NonNullable<MoveEvidenceBindings["settlement"]>;
  endpoint(address: SessionAddress): Promise<SessionEndpoint>;
  releaseRollbackFence(fence: IntercomIntakeFence, home: Home, receipt: Home): Promise<void>;
}
export interface MachineIntercom extends IntercomLifecycle {
  move: MachineMovePort;
  readiness(): { state: "disabled" | "pending" | "ready"; reason: string | null };
}

function checkDirectory(dir: string): void {
  assertTestConfigPath(dir);
  if (!isAbsolute(dir) || resolve(dir) !== dir) throw new Error("intercom directory must be absolute");
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(dir) !== dir) throw new Error("unsafe intercom directory");
  if (process.getuid && stat.uid !== process.getuid()) throw new Error("foreign intercom directory");
}
function checkBrokerBoundary(agentDir: string): void {
  const directory = join(agentDir, "intercom");
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== directory ||
      process.getuid && stat.uid !== process.getuid() || process.platform !== "win32" && (stat.mode & 0o7777) !== 0o700) {
    throw new Error("unsafe intercom broker directory");
  }
  for (const name of ["broker.sock", "broker.pid", "broker.spawn.lock", "broker.port.json"]) {
    try { stat = lstatSync(join(directory, name)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || (name === "broker.sock" ? !stat.isSocket() : !stat.isFile() || stat.nlink !== 1) ||
        process.getuid && stat.uid !== process.getuid() || process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) {
      throw new Error("unsafe intercom broker metadata");
    }
  }
}

/** Owns the bridge for one locked hub or supervisor, never for a pi session. */
export function createMachineIntercom(options: MachineIntercomOptions): MachineIntercom {
  const roamingEnabled = () => { try { return options.roamingEnabled?.() ?? options.config.enabled; } catch { return false; } };
  const settings = { ...options.config.intercom, routes: [...options.config.intercom.routes] };
  const initiates = (peer: Peer) => options.config.role === "hub" ||
    peer.machineId !== options.config.hubMachineId && options.config.machineId < peer.machineId;
  const stagedRoutes = new Map<string, { kind: "direct"; peer: Peer; edgeEpoch: string }>();
  let pendingSwitchAck: string | null = null, switchProblem: string | null = null, lastMaintenance = -Infinity;
  const activateRoutes = () => {
    if (settings.mode === "peers") for (const route of stagedRoutes.values()) {
      settings.routes = [...settings.routes.filter(item => item.peer.machineId !== route.peer.machineId), route];
    }
    if (settings.mode === "peers" && store) {
      const peers = settings.routes.filter(route => route.kind === "direct" && route.peer.machineId !== options.config.hubMachineId && !store!.pairFence(route.peer.machineId)).map(route => route.peer.machineId);
      store.rebindTopologyRoutes({ hubMachineId: options.config.hubMachineId, directPeers: peers });
    }
  };
  const enabled = settings.enabled && options.env?.PI_SUBAGENT_CHILD !== "1" && (options.env || process.env).PI_SUBAGENT_CHILD !== "1";
  let status: ReturnType<MachineIntercom["readiness"]> = { state: enabled ? "pending" : "disabled", reason: enabled ? "starting" : null };
  let bridge: IntercomBridge | undefined, store: IntercomStore | undefined, lease: HelperRouteLease | undefined;
  let delivery: HostIntercomDelivery | undefined;
  let startTask: Promise<void> | undefined, stopTask: Promise<void> | undefined, attemptTask: Promise<void> | undefined;
  let cancelRetry: (() => void) | undefined, stopped = false;
  let recoveryTask: Promise<void> | undefined, cancelRecovery: (() => void) | undefined;
  const recover = (): Promise<void> => {
    if (stopped || !store || !options.recoverRevocations) return Promise.resolve();
    if (recoveryTask) return recoveryTask;
    cancelRecovery?.(); cancelRecovery = undefined;
    const current = store;
    const task = Promise.resolve().then(() => options.recoverRevocations!(current)).then(() => undefined, () => undefined).finally(() => {
      if (recoveryTask === task) recoveryTask = undefined;
      if (!stopped && store === current) cancelRecovery = options.clock.later(10_000, () => { void recover(); });
    });
    recoveryTask = task; return task;
  };
  const abort = new AbortController();
  const broker = options.broker ?? new IntercomFederationClient();
  const transitionPrefix = randomUUID();
  let transitionSerial = 0;
  let enrollmentTail: Promise<void> = Promise.resolve();
  const locals = new Map<string, { info: RemoteSessionInfo; transition: string }>();
  const remotes = new Map<string, RemoteSessionInfo>();
  const machineAliases = new Map<string, string>();
  const idle = (status: string | undefined) => status === "idle" || status?.startsWith("idle · ") === true;
  const knownGeneration = (session: LocalPresence) => {
    try { return (options.generationKnown ?? ((id, generation) => hasIntercomGeneration(options.globalDb, id, generation)))(session.address.sessionId, session.activationEpoch); }
    catch { return false; }
  };
  const notifyReady = () => { for (const { info, transition } of locals.values()) void delivery?.ready(info.address, transition).catch(() => {}); };
  const onPresence = (sessions: LocalPresence[]) => {
    const next = new Map<string, { info: RemoteSessionInfo; transition: string }>();
    if (!settings.enabled) return;
    for (const session of sessions) {
      if (!knownGeneration(session)) continue;
      const key = addressKey(session.address), previous = locals.get(key);
      const changed = !previous || previous.info.activationEpoch !== session.activationEpoch || previous.info.homeEpoch !== session.homeEpoch ||
        !idle(previous.info.status) && idle(session.status);
      const info: RemoteSessionInfo = { remote: true, id: session.address.sessionId, address: session.address, machineId: options.config.machineId,
        machineAlias: settings.machineAlias, homeEpoch: session.homeEpoch, activationEpoch: session.activationEpoch, endpointEpoch: session.activationEpoch,
        cwd: session.cwd, model: session.model, startedAt: session.startedAt, lastActivity: session.lastActivity,
        ...(session.name === undefined ? {} : { name: session.name }), ...(session.status === undefined ? {} : { status: session.status }) };
      next.set(key, { info, transition: changed ? `${transitionPrefix}:${++transitionSerial}` : previous.transition });
    }
    locals.clear(); for (const [key, value] of next) locals.set(key, value);
    notifyReady();
  };
  const onDisconnected = () => { locals.clear(); remotes.clear(); };
  const sender = (address: SessionAddress) => locals.get(addressKey(address))?.info ?? remotes.get(addressKey(address)) ?? null;

  const cancelRecoveryTimer = () => { cancelRecovery?.(); cancelRecovery = undefined; };
  const closeAttempt = async () => {
    cancelRecoveryTimer();
    await recoveryTask;
    cancelRecoveryTimer();
    broker.off("presence", onPresence); broker.off("disconnected", onDisconnected);
    try { await bridge?.stop(); } finally {
      bridge = undefined;
      try { await delivery?.stop(); } finally {
        delivery = undefined; locals.clear(); remotes.clear();
        try { await lease?.close(); } finally { lease = undefined; store?.close(); store = undefined; }
      }
    }
  };
  const attempt = async (): Promise<void> => {
    if (!settings.enabled || stopped) return;
    try {
      lease = await acquireHelperRoute(options.root, options.agentDir, abort.signal);
      if (stopped) return;
      store = openIntercomStore({ file: join(options.root, "roam", "intercom", "queue.db"), machineId: options.config.machineId,
        clock: options.clock, limits: settings.limits, mode: settings.mode });
      settings.mode = store.topology().mode;
      stagedRoutes.clear();
      for (const record of await createIntercomRegistry(options.root).list()) {
        const pair = record.pair;
        if (pair.source.machineId === options.config.machineId) machineAliases.set(pair.target.machineId, pair.target.alias);
        else if (pair.target.machineId === options.config.machineId) machineAliases.set(pair.source.machineId, pair.source.alias);
        if (options.config.role === "box" && ["pending", "active"].includes(record.state) && "sshUser" in pair &&
            options.pairScopedHostReady && await options.pairScopedHostReady(pair.pairId)) {
          const remote = pair.source.machineId === options.config.machineId ? pair.target : pair.target.machineId === options.config.machineId ? pair.source : null;
          if (remote) {
            const routePeer = pair.source.machineId === options.config.machineId && record.resources ? { ...remote, alias: record.resources.route.name } : remote;
            const route = { kind: "direct" as const, peer: routePeer, edgeEpoch: pair.edgeEpoch };
            stagedRoutes.set(remote.machineId, route);
            if (options.directPeers && !options.directPeers.some(item => item.machineId === remote.machineId)) options.directPeers.push(routePeer);
          }
        }
      }
      activateRoutes();
      const direct = [...new Map([...settings.routes.filter(route => route.kind === "direct"), ...stagedRoutes.values()].map(route => [route.peer.machineId, route])).values()];
      const local = options.config.machineId;
      delivery = createHostIntercomDelivery({ store, broker, sender, now: options.clock.now,
        initialHomeAdoption(endpoint) { return readFirstHomeAdoption(options.globalDb, endpoint); },
        machineAlias(machineId) { return machineId === local ? settings.machineAlias : machineAliases.get(machineId) ?? settings.routes.find(route => route.peer.machineId === machineId)?.peer.alias ?? null; },
        endpoint(address) { const info = locals.get(addressKey(address))?.info;
          return info ? { address: info.address, machineId: info.machineId, homeEpoch: info.homeEpoch, activationEpoch: info.activationEpoch } : null; },
        wake(peer) { bridge?.wake(peer); },
      });
      broker.on("presence", onPresence); broker.on("disconnected", onDisconnected);
      const sessionMachines = (address: SessionAddress, originsOnly = false): string[] => {
        const db = options.globalDb, machines = new Set<string>();
        for (const kind of originsOnly ? ["observed-origin"] : ["observed-origin", "participant-origin", "intercom-first-home", "intercom-generation", "intercom-owner"]) {
          for (const { key, value } of localEntries<Record<string, unknown>>(db, kind)) {
            if ((value.id ?? value.sessionId ?? (kind === "participant-origin" ? key : null)) !== address.sessionId) continue;
            const machine = value.origin ?? value.machine ?? value.machineId ?? (kind === "intercom-generation" ? local : null);
            if (!isMachineId(machine)) throw new Error("intercom-owner-unavailable");
            machines.add(machine);
          }
        }
        const rememberHome = (json: string) => {
          const home = JSON.parse(json) as { machineId?: unknown };
          if (!isMachineId(home?.machineId)) throw new Error("intercom-owner-unavailable");
          machines.add(home.machineId);
        };
        if (!originsOnly) for (const row of db.prepare("SELECT committed_home_json AS home FROM roam_home_actions WHERE session_id=? AND committed_home_json IS NOT NULL").all(address.sessionId) as { home: string }[]) rememberHome(row.home);
        const location = db.prepare("SELECT home_json FROM roam_locations WHERE session_id=?").get(address.sessionId) as { home_json: string | null } | undefined;
        if (!originsOnly && location?.home_json) rememberHome(location.home_json);
        const inspect = (sessionDb: Db) => {
          if (!originsOnly && sessionDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_versions'").get()) {
            for (const row of sessionDb.prepare("SELECT origin_machine FROM roam_versions WHERE entity='sessions' AND row_key=?").all(address.sessionId) as { origin_machine: string }[]) {
              if (!isMachineId(row.origin_machine)) throw new Error("intercom-owner-unavailable"); machines.add(row.origin_machine);
            }
          }
          if (!sessionDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get()) return;
          const columns = sessionDb.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[];
          const hasOrigin = columns.some(row => row.name === "origin_machine");
          const row = sessionDb.prepare(`SELECT ${hasOrigin ? "origin_machine" : "'' AS origin_machine"} FROM sessions WHERE id=?`).get(address.sessionId) as { origin_machine: string } | undefined;
          if (row && (!originsOnly || row.origin_machine)) { const origin = row.origin_machine || local; if (!isMachineId(origin)) throw new Error("intercom-owner-unavailable"); machines.add(origin); }
        };
        inspect(db);
        for (const row of db.prepare("SELECT db_path FROM projects").all() as { db_path: string }[]) {
          let handle: Db | undefined;
          try {
            const stat = lstatSync(row.db_path);
            if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(row.db_path) !== row.db_path || process.getuid && stat.uid !== process.getuid()) throw new Error("intercom-owner-unavailable");
            handle = openDbReadOnly(row.db_path); if (!handle) throw new Error("intercom-owner-unavailable"); inspect(handle);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          finally { handle?.close(); }
        }
        for (const key of listStoreKeys(db)) if (key.startsWith("worktree:")) {
          const handle = openRoamStoreReadOnly(db, key); if (!handle) continue;
          try { inspect(handle); } finally { handle.close(); }
        }
        return [...machines];
      };
      bridge = createIntercomBridge({ machineId: local, machineAlias: settings.machineAlias,
        edges: direct.map(route => ({ peer: route.peer, edgeEpoch: route.edgeEpoch, initiator: initiates(route.peer) })),
        nextHop(destination) { const route = settings.routes.find(candidate => candidate.peer.machineId === destination);
          if (options.config.role === "box" && destination !== options.config.hubMachineId && settings.mode === "hub-only") return options.config.hubMachineId;
          return route?.kind === "direct" ? route.peer.machineId : settings.mode === "hub-only" ? route?.via ?? null : null; },
        authorizePresence(peer, entry) {
          const route = settings.routes.find(candidate => candidate.peer.machineId === entry.machineId);
          if (!route || (machineAliases.get(entry.machineId) ?? route.peer.alias).toLowerCase() !== entry.machineAlias.toLowerCase()) return false;
          return entry.machineId === peer || settings.mode === "hub-only" && options.config.role === "box" &&
            peer === options.config.hubMachineId && route.kind === "relay" && route.via === peer;
        },
        authorizeOrigin(peer, origin) {
          if (origin === peer) return true;
          const route = settings.routes.find(candidate => candidate.peer.machineId === origin);
          return settings.mode === "hub-only" && options.config.role === "box" && peer === options.config.hubMachineId && route?.kind === "relay" && route.via === peer;
        },
        advertiseRelay(peer, entry) {
          return settings.mode === "hub-only" && options.config.role === "hub" && (!store!.topology().transition || store!.topology().transition!.state === "draining") && peer !== entry.machineId &&
            direct.some(route => route.peer.machineId === peer) && direct.some(route => route.peer.machineId === entry.machineId);
        },
        topology(peer) {
          if (options.config.role === "hub") {
            const current = store!.topology().transition;
            if (!current) return undefined;
            const next = store!.advanceTopologyTransition();
            return next.state === "switching" && next.boxes[peer] === "pending" ? { transitionId: next.transitionId, action: "switch" } : undefined;
          }
          return peer === options.config.hubMachineId && pendingSwitchAck ? { transitionId: pendingSwitchAck, action: "switched" } : undefined;
        },
        onTopology(peer, control) {
          if (options.config.role === "hub") {
            if (control) {
              if (control.action !== "switched") throw new Error("intercom-transition-conflict");
              store!.acknowledgeTopologySwitch(control.transitionId, peer);
              settings.mode = store!.topology().mode;
            }
            return;
          }
          if (peer !== options.config.hubMachineId) { if (control) throw new Error("intercom-transition-conflict"); return; }
          pendingSwitchAck = null;
          if (!control) return;
          if (control.action !== "switch") throw new Error("intercom-transition-conflict");
          try {
            const directPeers = [...stagedRoutes.values(), ...settings.routes.filter(route => route.kind === "direct")]
              .filter(route => route.peer.machineId !== options.config.hubMachineId && !store!.pairFence(route.peer.machineId)).map(route => route.peer.machineId);
            store!.switchTopology({ transitionId: control.transitionId, hubMachineId: options.config.hubMachineId, directPeers });
            settings.mode = store!.topology().mode; activateRoutes();
            switchProblem = null; pendingSwitchAck = control.transitionId;
            for (const peer of directPeers) bridge?.wake(peer);
          } catch (error) {
            if (!(error instanceof Error) || !["intercom-topology-hub-custody", "intercom-topology-outcome-unknown"].includes(error.message)) throw error;
            switchProblem = error.message;
          }
        },
        async onTopologyRequest(request) {
          if (options.config.role !== "hub") throw new Error("intercom-requires-hub");
          if (request.from !== "hub-only" || request.to !== "peers") throw new Error("intercom-transition-unsupported");
          const records = (await createIntercomRegistry(options.root).list()).filter(record => record.state === "active" &&
            record.operationId === request.operationId && record.graphDigest === request.graphDigest);
          if (!records.length) throw new Error("peer-consent-required");
          const history = openJournal(join(options.root, "roam", "journal.db")).read(request.operationId);
          const consent = history.find(row => row.action === "intercom-peer-consent" &&
            row.result.approved === true && row.result.graphDigest === request.graphDigest);
          if (request.transitionId !== topologyTransitionId(local, request.operationId, request.graphDigest) || !consent || !Array.isArray(consent.result.pairs) || consent.result.pairs.length !== records.length ||
              consent.result.pairs.some(pair => !pair || typeof pair !== "object" || Array.isArray(pair) || !records.some(record => record.pair.pairId === pair.pairId))) throw new Error("peer-consent-required");
          if (store!.topology().mode === "peers") return { machineId: local, transitionId: request.transitionId, state: "complete" };
          const transition = store!.startTopologyTransition({ transitionId: request.transitionId, from: request.from, to: request.to,
            boxes: direct.map(route => route.peer.machineId) });
          for (const peer of Object.keys(transition.boxes)) bridge?.wake(peer);
          return { machineId: local, transitionId: transition.transitionId, state: transition.state };
        },
        async onRevokeRequest(request) {
          const registry = createIntercomRegistry(options.root), records = await registry.list();
          for (const record of records) {
            const pair = record.pair;
            if (!("sshUser" in pair) || pair.edgeEpoch !== request.edgeEpoch ||
                !((pair.source.machineId === local && pair.target.machineId === request.peer) ||
                  (pair.target.machineId === local && pair.source.machineId === request.peer))) continue;
            await registry.beginRevocation(pair.pairId, request.fenceId);
            await registry.finishRevocation(pair.pairId, "intercom-revocation-unconfirmed");
          }
          void recover();
        },
        onEnrollRequest(request) {
          const task = enrollmentTail.then(async () => {
            if (!options.pairScopedHostReady || !await options.pairScopedHostReady(request.pairId)) throw new Error("connector-not-pair-scoped");
            const record = await createIntercomRegistry(options.root).get(request.pairId), pair = record?.pair as IntercomEnrollmentPair | undefined;
            const config = readLocalIdentity(options.root), configured = config.intercom.routes.find(item => item.peer.machineId === request.peer);
            const remoteIdentity = pair && (pair.source.machineId === local ? pair.target : pair.target.machineId === local ? pair.source : null);
            const remote = remoteIdentity && pair.source.machineId === local && record?.resources ? { ...remoteIdentity, alias: record.resources.route.name } : remoteIdentity;
            const route = remote && { kind: "direct" as const, peer: remote, edgeEpoch: request.edgeEpoch };
            if (!record || !pair || !remote || !["pending", "active"].includes(record.state) || record.operationId !== request.operationId ||
                record.graphDigest !== request.graphDigest || !(record.fenceId === request.expectedFenceId || record.state === "active" && record.fenceId === null) || pair.edgeEpoch !== request.edgeEpoch ||
                remote.machineId !== request.peer || config.machineId !== local || !config.intercom.enabled || !(config.intercom.mode === "peers" || config.role === "box" && config.intercom.mode === "hub-only") ||
                !route || !configured || !(configured.kind === "direct" && configured.edgeEpoch === request.edgeEpoch && JSON.stringify(configured.peer) === JSON.stringify(remote) ||
                  config.role === "box" && config.intercom.mode === "hub-only" && configured.kind === "relay" && configured.via === config.hubMachineId)) {
              throw new Error("peer-consent-required");
            }
            if (remoteIdentity) machineAliases.set(remoteIdentity.machineId, remoteIdentity.alias);
            const priorRoutes = [...settings.routes], priorPeers = options.directPeers && [...options.directPeers];
            if (settings.mode === "peers") settings.routes = [...settings.routes.filter(item => item.peer.machineId !== request.peer), route];
            if (options.directPeers) options.directPeers.splice(0, options.directPeers.length,
              ...options.directPeers.filter(item => item.machineId !== request.peer), route.peer);
            try {
              if (!bridge) throw new Error("bridge-unavailable");
              await bridge.enrollPair({ peer: route.peer, edgeEpoch: route.edgeEpoch, initiator: initiates(route.peer) },
                { operationId: request.operationId, graphDigest: request.graphDigest, expectedFenceId: request.expectedFenceId, edgeEpoch: request.edgeEpoch });
            } catch (error) {
              settings.routes = priorRoutes; if (options.directPeers && priorPeers) options.directPeers.splice(0, options.directPeers.length, ...priorPeers);
              throw error;
            }
            stagedRoutes.set(request.peer, route); activateRoutes();
            bridge?.wake(request.peer);
            return { machineId: local, peer: request.peer, edgeEpoch: request.edgeEpoch, applied: true as const };
          });
          enrollmentTail = task.then(() => undefined, () => undefined);
          return task;
        },
        localPresence: () => [], authorizeLocalPresence: knownGeneration,
        firstHomeAttestation(endpoint) {
          try {
            const record = readFirstHomeAdoption(options.globalDb, endpoint);
            return record && firstHomeEndpointMatches(record, { ...endpoint, homeEpoch: null }, endpoint)
              ? { activation: record.activation, fromEpoch: null, toEpoch: record.toEpoch } : undefined;
          } catch { return undefined; }
        },
        maintain() {
          const now = options.clock.now(); if (now - lastMaintenance < 60_000) return;
          lastMaintenance = now;
          pruneIntercomRecords(options.globalDb, (id, generation) => store!.hasGenerationReferences(id, generation));
        },
        knownSessionMachines(address) { return sessionMachines(address); },
        sessionOrigin(address) {
          const origins = sessionMachines(address, true);
          return origins.length === 1 ? origins[0] : null;
        },
        authoritativeHome(address) {
          const row = options.globalDb.prepare("SELECT machine_id,epoch,move_id,updated_at FROM session_homes WHERE session_id=?").get(address.sessionId) as
            { machine_id: string; epoch: number; move_id: string | null; updated_at: number } | undefined;
          if (!row) return null;
          if (!isMachineId(row.machine_id)) throw new Error("intercom-home-unavailable");
          return { sessionId: address.sessionId, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at };
        },
        publishPresence(entries) { remotes.clear(); for (const entry of entries) remotes.set(addressKey(entry.address), entry); notifyReady(); },
        onInbound(input) { delivery?.onInbound(input); }, onReceipt(frame) { delivery?.onReceipt(frame); if (frame.receipt.status === "not_injected") notifyReady(); },
        async onRevocationNotice(frame) { return delivery ? delivery.onRevocationNotice(frame) : false; },
        onControl(frame) { delivery?.onControl(frame); }, onAskFailed(failure) { delivery?.onAskFailed(failure); },
        onExpiry(event) { delivery?.onExpiry(event); },
        store, transport: options.transport, clock: options.clock, broker, globalRoot: options.root, agentDir: options.agentDir, routeLease: lease,
        moveFences: true,
        async ensureBroker() {
          checkDirectory(options.agentDir); checkBrokerBoundary(options.agentDir);
          if (options.ensureBroker) await options.ensureBroker({ agentDir: options.agentDir, signal: abort.signal });
          else await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], { agentDir: options.agentDir, env: options.env, signal: abort.signal });
          if (abort.signal.aborted) throw new Error("intercom-stopped");
        },
        onBrokerState(ready) { if (!stopped) status = ready ? { state: "ready", reason: null } : { state: "pending", reason: "broker-unavailable" }; },
      });
      const revoke = bridge.revokePair;
      bridge.revokePair = (peer, epoch, requestedFence) => withIntercomPeerLock(options.root, local, peer, async () => {
        const registry = createIntercomRegistry(options.root);
        const records = (await registry.list()).filter(record => record.pair.edgeEpoch === epoch &&
          (record.pair.source.machineId === local && record.pair.target.machineId === peer || record.pair.target.machineId === local && record.pair.source.machineId === peer));
        const fence = requestedFence ?? records.find(record => record.state === "revoking" || record.state === "revoked")?.fenceId ?? randomUUID();
        for (const record of records) await registry.beginRevocation(record.pair.pairId, fence);
        const proof = await revoke(peer, epoch, fence);
        if (proof.edgeEpoch !== epoch || proof.fenceId !== fence) throw new Error("intercom-fence-mismatch");
        return proof;
      });
      await bridge.start();
      void recover();
      if (!stopped) status = { state: "ready", reason: null };
    } catch (error) {
      await closeAttempt();
      if (stopped) return;
      status = { state: "pending", reason: error instanceof Error && error.message === "unsupported-broker" ? "unsupported-broker" : "bridge-unavailable" };
      cancelRetry = options.clock.later(1000, () => {
        cancelRetry = undefined;
        void runAttempt().catch(() => { if (!stopped) status = { state: "pending", reason: "bridge-unavailable" }; });
      });
    }
  };
  const runAttempt = (): Promise<void> => {
    const running = attempt(); attemptTask = running;
    void running.then(() => { if (attemptTask === running) attemptTask = undefined; }, () => { if (attemptTask === running) attemptTask = undefined; });
    return running;
  };
  const moveAvailable = () => {
    if (!roamingEnabled() || !enabled || stopped || status.state !== "ready" || !bridge || !store) throw new Error("intercom-move-unavailable");
    return { bridge, store };
  };
  const moveEndpoint = async (address: SessionAddress): Promise<SessionEndpoint> => {
    moveAvailable();
    const info = sender(address), home = sessionHome(options.globalDb, address.sessionId);
    if (!info || !sameAddress(info.address, address) || !home || home === "unknown" || info.machineId !== home.machineId || info.homeEpoch !== home.epoch) throw new Error("intercom-endpoint-unproved");
    return { address: info.address, machineId: info.machineId, homeEpoch: info.homeEpoch, activationEpoch: info.activationEpoch };
  };
  let intakePorts: import("./contracts").IntercomMovePorts | undefined;
  const intake = () => {
    moveAvailable();
    return intakePorts ??= createIntercomMovePorts({
      journal: options.moveJournal,
      broker: {
        async intake(action, fence) {
          moveAvailable();
          const port = (broker as IntercomBroker & Partial<Pick<IntercomFederationClient, "intake">>).intake;
          if (!port) throw new Error("intercom-fence-unavailable");
          return port.call(broker, action, fence);
        },
        async inspectFreezeBlockers(address) {
          moveAvailable();
          const port = (broker as IntercomBroker & Partial<Pick<IntercomFederationClient, "inspectFreezeBlockers">>).inspectFreezeBlockers;
          if (!port) throw new Error("intercom-blocker-source-unavailable");
          return port.call(broker, address);
        },
      },
      bridge: {
        drainIntake: fence => moveAvailable().bridge.drainIntake(fence),
        inspectMoveBlockers: address => moveAvailable().bridge.inspectMoveBlockers(address),
        undispatched: address => moveAvailable().bridge.undispatched(address),
        rebindMove: (fence, endpoint, proof) => moveAvailable().bridge.rebindMove(fence, endpoint, proof),
        resumeIntake: fence => moveAvailable().bridge.resumeIntake(fence),
      },
      owns: endpoint => options.moveOwns ? options.moveOwns(endpoint) : Promise.resolve(false),
      endpoint: address => {
        const info = sender(address);
        return info ? { address: info.address, machineId: info.machineId, homeEpoch: info.homeEpoch, activationEpoch: info.activationEpoch } : null;
      },
      async home(address) { const home = sessionHome(options.globalDb, address.sessionId); return home === "unknown" ? null : home; },
      admitted: endpoint => { const info = sender(endpoint.address); return !!info && info.machineId === endpoint.machineId && info.homeEpoch === endpoint.homeEpoch && info.activationEpoch === endpoint.activationEpoch; },
      presence: endpoint => sender(endpoint.address),
      warnings: () => [...bridge?.diagnostics().map(item => `intercom-route-unavailable:${item.peer}`) ?? []],
    });
  };
  const move: MachineMovePort = {
    async broker(address) {
      moveAvailable();
      const port = (broker as IntercomBroker & Partial<Pick<IntercomFederationClient, "inspectFreezeBlockers">>).inspectFreezeBlockers;
      if (!port) throw new Error("intercom-blocker-source-unavailable");
      return port.call(broker, address);
    },
    intake: {
      async close(...args) { return intake().close(...args); }, async drain(...args) { return intake().drain(...args); },
      async inspect(...args) { return intake().inspect(...args); }, async checkGeneration(...args) { return intake().checkGeneration(...args); },
      async abort(...args) { return intake().abort(...args); }, async ready(...args) { return intake().ready(...args); },
    },
    async bridge(address) { return moveAvailable().bridge.inspectMoveBlockers(address); },
    endpoint: moveEndpoint,
    async settlement(query) {
      const { store } = moveAvailable();
      for (const direction of ["inbound", "outbound"] as const) {
        const retained = store.retained(direction, query.messageId);
        if (!retained || retained.identity.from.sessionId !== query.fromSessionId || retained.identity.to.sessionId !== query.toSessionId ||
            retained.identity.to.scopeId !== query.scopeId || retained.payloadRetained || !["injected", "matched_waiter"].includes(retained.state) || retained.latestAttempt < 1) continue;
        const endpoint = await moveEndpoint(retained.identity.to);
        if (endpoint.machineId !== retained.endpoint.machineId || endpoint.homeEpoch !== retained.endpoint.homeEpoch || endpoint.activationEpoch !== retained.endpoint.activationEpoch) continue;
        return { ...query, kind: "delivered" };
      }
      return null;
    },
    async releaseRollbackFence(fence, home, receipt) {
      const { bridge } = moveAvailable();
      const intake = (broker as IntercomBroker & Partial<Pick<IntercomFederationClient, "intake">>).intake;
      if (!options.moveRollbackProof || !intake) throw new Error("move-rollback-proof-missing");
      await createRollbackIntercomPorts({ journal: options.moveJournal ?? openFreezeJournal(join(options.root, "roam", "journal.db")), address: fence.address,
        proof: options.moveRollbackProof, broker: { intake: intake.bind(broker) }, bridge }).reopen(fence, home, receipt);
    },
  };
  let moveSocket: Awaited<ReturnType<typeof startMachineMoveSocket>> | undefined;
  return {
    move,
    start() {
      return startTask ??= (async () => {
        if (!enabled) return;
        checkDirectory(options.root); checkDirectory(options.agentDir); checkBrokerBoundary(options.agentDir);
        if (process.platform !== "win32" && Buffer.byteLength(join(options.agentDir, "intercom", "broker.sock")) >= 104) throw new Error("intercom broker socket path too long");
        await runAttempt();
        if (options.config.enabled || roamingEnabled()) moveSocket = await startMachineMoveSocket(options.root, () => roamingEnabled() && !stopped, move);
      })();
    },
    stop() {
      return stopTask ??= (async () => {
        stopped = true; abort.abort(); cancelRetry?.(); cancelRetry = undefined; cancelRecovery?.(); cancelRecovery = undefined;
        try { await startTask; } catch { /* startup error already reported */ }
        try { await attemptTask; } catch { /* retry error already reported */ }
        await moveSocket?.close(); moveSocket = undefined;
        await closeAttempt();
      })();
    },
    diagnostics: () => {
      const result = [...bridge?.diagnostics() ?? []], transition = store?.topology().transition;
      if (transition && transition.state !== "complete") for (const [peer, state] of Object.entries(transition.boxes)) if (state === "pending") {
        result.push({ peer, status: "pending", since: 0, reason: `intercom-transition-pending ${peer}` });
      }
      for (const peer of store?.missingTopologyRoutes() ?? []) result.push({ peer, status: "pending", since: 0, reason: `intercom-route-missing ${peer}` });
      if (switchProblem) result.push({ peer: options.config.hubMachineId, status: "blocked", since: 0, reason: switchProblem });
      return result;
    },
    readiness: () => ({ ...status }),
  };
}
