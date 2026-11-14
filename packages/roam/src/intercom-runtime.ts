import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Db } from "@spider/db-core";
import { assertTestConfigPath } from "@spider/db-core";
import { IntercomFederationClient } from "@spider/intercom/broker/client";
import { spawnBrokerIfNeeded } from "@spider/intercom/broker/spawn";
import { addressKey, type LocalPresence, type RemoteSessionInfo, type SessionAddress } from "@spider/intercom/protocol";
import type { Clock, IntercomLifecycle, RoamConfig, Transport } from "./contracts";
import { createIntercomBridge, type IntercomBridge, type IntercomBroker } from "./intercom-bridge";
import { acquireHelperRoute, type HelperRouteLease } from "./intercom-route";
import { openIntercomStore } from "./intercom-store";
import type { IntercomStore } from "./intercom-contracts";
import { isMachineId } from "./machine-id";
import { createHostIntercomDelivery, type HostIntercomDelivery } from "./intercom-delivery";
import { hasIntercomGeneration } from "./intercom-exclusion";

export interface MachineIntercomOptions {
  root: string;
  globalDb: Db;
  config: RoamConfig;
  agentDir: string;
  clock: Clock;
  transport: Transport;
  broker?: IntercomBroker;
  env?: NodeJS.ProcessEnv;
  ensureBroker?(input: { agentDir: string; signal: AbortSignal }): Promise<void>;
  generationKnown?(sessionId: string, generation: string): boolean;
}
export interface MachineIntercom extends IntercomLifecycle {
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
  const settings = options.config.intercom;
  const enabled = settings.enabled && options.env?.PI_SUBAGENT_CHILD !== "1" && (options.env || process.env).PI_SUBAGENT_CHILD !== "1";
  let status: ReturnType<MachineIntercom["readiness"]> = { state: enabled ? "pending" : "disabled", reason: enabled ? "starting" : null };
  let bridge: IntercomBridge | undefined, store: IntercomStore | undefined, lease: HelperRouteLease | undefined;
  let delivery: HostIntercomDelivery | undefined;
  let startTask: Promise<void> | undefined, stopTask: Promise<void> | undefined, attemptTask: Promise<void> | undefined;
  let cancelRetry: (() => void) | undefined, stopped = false;
  const abort = new AbortController();
  const broker = options.broker ?? new IntercomFederationClient();
  const transitionPrefix = randomUUID();
  let transitionSerial = 0;
  const locals = new Map<string, { info: RemoteSessionInfo; transition: string }>();
  const remotes = new Map<string, RemoteSessionInfo>();
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

  const closeAttempt = async () => {
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
        clock: options.clock, limits: settings.limits });
      const direct = settings.routes.filter(route => route.kind === "direct");
      const local = options.config.machineId;
      delivery = createHostIntercomDelivery({ store, broker, sender, now: options.clock.now,
        machineAlias(machineId) { return machineId === local ? settings.machineAlias : settings.routes.find(route => route.peer.machineId === machineId)?.peer.alias ?? null; },
        endpoint(address) { const info = locals.get(addressKey(address))?.info;
          return info ? { address: info.address, machineId: info.machineId, homeEpoch: info.homeEpoch, activationEpoch: info.activationEpoch } : null; },
        wake(peer) { bridge?.wake(peer); },
      });
      broker.on("presence", onPresence); broker.on("disconnected", onDisconnected);
      bridge = createIntercomBridge({ machineId: local, machineAlias: settings.machineAlias,
        edges: direct.map(route => ({ peer: route.peer, edgeEpoch: route.edgeEpoch, initiator: local < route.peer.machineId })),
        nextHop(destination) { const route = settings.routes.find(candidate => candidate.peer.machineId === destination);
          return route?.kind === "direct" ? route.peer.machineId : route?.via ?? null; },
        authorizePresence(peer, entry) {
          const route = settings.routes.find(candidate => candidate.peer.machineId === entry.machineId);
          if (!route || route.peer.alias.toLowerCase() !== entry.machineAlias.toLowerCase()) return false;
          return entry.machineId === peer || settings.mode === "hub-only" && options.config.role === "box" &&
            peer === options.config.hubMachineId && route.kind === "relay" && route.via === peer;
        },
        authorizeOrigin(peer, origin) {
          if (origin === peer) return true;
          const route = settings.routes.find(candidate => candidate.peer.machineId === origin);
          return settings.mode === "hub-only" && options.config.role === "box" && peer === options.config.hubMachineId && route?.kind === "relay" && route.via === peer;
        },
        advertiseRelay(peer, entry) {
          return settings.mode === "hub-only" && options.config.role === "hub" && peer !== entry.machineId &&
            direct.some(route => route.peer.machineId === peer) && direct.some(route => route.peer.machineId === entry.machineId);
        },
        localPresence: () => [], authorizeLocalPresence: knownGeneration, authoritativeHome(address) {
          const row = options.globalDb.prepare("SELECT machine_id,epoch,move_id,updated_at FROM session_homes WHERE session_id=?").get(address.sessionId) as
            { machine_id: string; epoch: number; move_id: string | null; updated_at: number } | undefined;
          if (!row) return null;
          if (!isMachineId(row.machine_id)) throw new Error("intercom-home-unavailable");
          return { sessionId: address.sessionId, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at };
        },
        publishPresence(entries) { remotes.clear(); for (const entry of entries) remotes.set(addressKey(entry.address), entry); notifyReady(); },
        onInbound(input) { delivery?.onInbound(input); }, onReceipt(frame) { delivery?.onReceipt(frame); if (frame.receipt.status === "not_injected") notifyReady(); },
        onControl(frame) { delivery?.onControl(frame); }, onAskFailed(failure) { delivery?.onAskFailed(failure); },
        onExpiry(event) { delivery?.onExpiry(event); },
        store, transport: options.transport, clock: options.clock, broker, globalRoot: options.root, agentDir: options.agentDir, routeLease: lease,
        async ensureBroker() {
          checkDirectory(options.agentDir); checkBrokerBoundary(options.agentDir);
          if (options.ensureBroker) await options.ensureBroker({ agentDir: options.agentDir, signal: abort.signal });
          else await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], { agentDir: options.agentDir, env: options.env, signal: abort.signal });
          if (abort.signal.aborted) throw new Error("intercom-stopped");
        },
        onBrokerState(ready) { if (!stopped) status = ready ? { state: "ready", reason: null } : { state: "pending", reason: "broker-unavailable" }; },
      });
      await bridge.start();
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
  return {
    start() {
      return startTask ??= (async () => {
        if (!enabled) return;
        checkDirectory(options.root); checkDirectory(options.agentDir); checkBrokerBoundary(options.agentDir);
        if (process.platform !== "win32" && Buffer.byteLength(join(options.agentDir, "intercom", "broker.sock")) >= 104) throw new Error("intercom broker socket path too long");
        await runAttempt();
      })();
    },
    stop() {
      return stopTask ??= (async () => {
        stopped = true; abort.abort(); cancelRetry?.(); cancelRetry = undefined;
        try { await startTask; } catch { /* startup error already reported */ }
        try { await attemptTask; } catch { /* retry error already reported */ }
        await closeAttempt();
      })();
    },
    diagnostics: () => bridge?.diagnostics() ?? [],
    readiness: () => ({ ...status }),
  };
}
