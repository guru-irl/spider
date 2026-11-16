import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Blocker, Home } from "@spider/db-core/roam/types";
import { openDbReadOnly, openGlobal, openGlobalReadOnly, paths, type Db } from "@spider/db-core";
import { join } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { INTERCOM_HOST_EVENT, addressKey, createIntercomDeliveryObserver, isSessionEndpoint, sameAddress, type FederationBlockers, type IntercomHostRequest, type MessageReceipt, type SessionAddress, type SessionEndpoint } from "@spider/intercom/protocol";
import type { SessionGenerationExclusion } from "@spider/roam/intercom-contracts";
import type { ReconcileProof } from "@spider/roam/intercom-delivery";
import { intercomExclusion, probeIntercomProcess, recordIntercomGeneration, type NativeProcess } from "@spider/roam/intercom-exclusion";
import { sessionHome } from "@spider/roam/homes";
import { readLocalIdentity } from "@spider/roam/runtime";
import { recordFirstHomeAdoption } from "@spider/roam/intercom-first-home";
export { createHostIntercomDelivery, type HostIntercomDelivery, type HostIntercomDeliveryPorts, type ReconcileProof } from "@spider/roam/intercom-delivery";
import type { Admission, AdmissionGate } from "./admission.js";
import { ordinaryWorkAllowed } from "./activation.js";
import { randomUUID } from "node:crypto";
import { qualifiedName, isSessionAddress, isRemoteSessionInfo, sameAddress as equalAddress, type IntercomIntakeFence, type RemoteSessionInfo } from "@spider/intercom/protocol";
import { isIntercomIntakeFence } from "../../../intercom/src/broker/protocol.js";
import type { IntercomFederationClient } from "@spider/intercom/broker/client";
import type { IntercomBridge } from "@spider/roam/intercom-bridge";
import type { IntercomMovePorts } from "@spider/roam/contracts";
import { intercomBlockers } from "./blockers.js";
export type { IntercomMovePorts } from "@spider/roam/contracts";
import { isMachineId } from "@spider/roam/machine-id";

export { IntercomFenceError, createIntercomMovePorts, type IntercomMoveInput } from "@spider/roam/intercom-move";

export interface Disposable { dispose(): void }
export interface HostIntercomPorts {
  admission(): Admission;
  refreshInitialHome?(): Promise<Admission>;
  machineId(): Promise<string | undefined>;
  home(address: SessionAddress): Home | null | "unknown";
  exclusion?(owner: SessionEndpoint): SessionGenerationExclusion | undefined;
  recordGeneration?(owner: SessionEndpoint): void;
  recordFirstHome?(previous: SessionEndpoint, current: SessionEndpoint): void;
  reconcile?(ctx: ExtensionContext, requests: readonly ReconcileRequest[]): Promise<readonly ReconcileProof[]>;
  pendingOwn?(sessionId: string, scopeId: string | null): readonly { messageId: string; owner: SessionEndpoint }[];
}
export interface ReconcileRequest { messageId: string; owner: SessionEndpoint; exclusion?: SessionGenerationExclusion }
export function createHostIntercomPorts(gate: AdmissionGate, options: { db?: Db; root?: string; pid?: number; probe?: (pid: number) => NativeProcess } = {}): HostIntercomPorts {
  const withDb = <T>(run: (db: Db) => T): T => { const db = options.db ?? openGlobal(); try { return run(db); } finally { if (!options.db) db.close(); } };
  return { admission: () => gate.inspect(), refreshInitialHome: () => gate.refreshInitialHome(), machineId: async () => {
    const admission = gate.inspect();
    if (!ordinaryWorkAllowed(admission)) return undefined;
    if (admission.home) return admission.home.machineId;
    try { const config = readLocalIdentity(paths.globalRoot); return config.intercom.enabled ? config.machineId : undefined; } catch { return undefined; }
  },
  recordGeneration(owner) { withDb(db => recordIntercomGeneration(db, { sessionId: owner.address.sessionId, generation: owner.activationEpoch, pid: options.pid ?? process.pid }, options.probe ?? probeIntercomProcess)); },
  exclusion(owner) { return withDb(db => intercomExclusion(db, owner, options.probe ?? probeIntercomProcess)); },
  recordFirstHome(previous, current) { withDb(db => recordFirstHomeAdoption(db, previous, current)); },
  reconcile: reconcileOwnIntercom,
  pendingOwn(sessionId, scopeId) {
    const root = options.root ?? paths.globalRoot, file = join(root, "roam", "intercom", "queue.db");
    try {
      for (const directory of [root, join(root, "roam"), join(root, "roam", "intercom")]) {
        const info = lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory ||
            typeof process.getuid === "function" && info.uid !== process.getuid() ||
            directory !== root && process.platform !== "win32" && (info.mode & 0o7777) !== 0o700) throw new Error("intercom-queue-unavailable");
      }
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || typeof process.getuid === "function" && info.uid !== process.getuid() ||
          process.platform !== "win32" && (info.mode & 0o7777) !== 0o600) throw new Error("intercom-queue-unavailable");
      const db = openDbReadOnly(file); if (!db) return [];
      try {
        const rows = db.prepare(`SELECT c.id,c.endpoint_json FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id
          WHERE c.direction='inbound' AND c.unknown_outcome=1 AND m.to_key=? ORDER BY c.id`).all(addressKey({ sessionId, scopeId })) as Array<{ id: string; endpoint_json: string }>;
        return rows.flatMap(row => { const endpoint: unknown = JSON.parse(row.endpoint_json);
          return isSessionEndpoint(endpoint) && endpoint.address.sessionId === sessionId && endpoint.address.scopeId === scopeId ? [{ messageId: row.id, owner: endpoint }] : []; });
      } finally { db.close(); }
    } catch { return []; }
  },
  home(address) {
    let db: ReturnType<typeof openGlobalReadOnly>;
    try {
      db = openGlobalReadOnly();
      return db ? sessionHome(db, address.sessionId) : null;
    } catch { return "unknown"; } finally { db?.close(); }
  } };
}
export function registerRoamIntercom(pi: ExtensionAPI, ports: HostIntercomPorts): Disposable {
  let sessionId = "", machineId: string | undefined, context: ExtensionContext | undefined, disposed = false, generation = 0;
  const off = pi.events.on(INTERCOM_HOST_EVENT, payload => {
    const request = payload as IntercomHostRequest;
    if (disposed || request.sessionId !== sessionId) return;
    request.home = address => ports.home(address);
    request.exclusion = owner => {
      if (!machineId || owner.machineId !== machineId) return undefined;
      const proof = ports.exclusion?.(owner);
      if (!proof || !sameAddress(proof.owner.address, owner.address) || proof.owner.machineId !== owner.machineId || proof.owner.homeEpoch !== owner.homeEpoch || proof.owner.activationEpoch !== owner.activationEpoch || proof.excludedGeneration !== owner.activationEpoch) return undefined;
      return { excludedGeneration: owner.activationEpoch, complete: true };
    };
    if (ports.pendingOwn) request.pendingOwn = async () => ports.pendingOwn!(request.sessionId, request.scopeId);
    const ownGeneration = generation, ownMachine = machineId;
    if (context && ports.reconcile) request.reconcile = async (messageId, owner) => {
      if (disposed || ownGeneration !== generation || !context) throw new Error("session-inactive");
      const proof = await ports.reconcile!(context, [{ messageId, owner, exclusion: owner.machineId === ownMachine ? ports.exclusion?.(owner) : undefined }]);
      return proof[0].receipt;
    };
    const admission = ports.admission();
    if (!machineId || !ordinaryWorkAllowed(admission)) return;
    const endpoint = { address: { sessionId, scopeId: request.scopeId }, machineId, homeEpoch: admission.home?.epoch ?? null, activationEpoch: request.activationEpoch };
    try { ports.recordGeneration?.(endpoint); request.endpoint = endpoint; } catch { /* Without durable identity, delivery stays unadmitted. */ }
    request.refreshInitialHome = async () => {
      if (!ports.refreshInitialHome || !ports.recordFirstHome || request.endpoint?.homeEpoch !== null) return undefined;
      const home = ports.home(endpoint.address);
      if (!home || home === "unknown") return undefined;
      const refreshed = await ports.refreshInitialHome();
      if (disposed || ownGeneration !== generation || !ordinaryWorkAllowed(refreshed) || !refreshed.home) return undefined;
      const current = { ...endpoint, homeEpoch: refreshed.home.epoch };
      ports.recordFirstHome(endpoint, current);
      return current;
    };
  });
  const dispose = () => { if (disposed) return; disposed = true; generation++; machineId = undefined; context = undefined; off(); };
  pi.on("session_start", async (_event, ctx) => {
    if (disposed) return;
    const ticket = ++generation; sessionId = ctx.sessionManager.getSessionId(); context = ctx; machineId = undefined;
    try { const current = await ports.machineId(); if (!disposed && ticket === generation) machineId = current; } catch { /* Unenrolled local sessions remain local. */ }
  });
  pi.on("session_shutdown", dispose);
  return { dispose };
}
export async function inspectIntercomBlockers(address: SessionAddress, ports: {
  broker(address: SessionAddress): Promise<FederationBlockers>;
  bridge(address: SessionAddress): FederationBlockers;
}): Promise<readonly Blocker[]> {
  const broker = await ports.broker(address), bridge = ports.bridge(address);
  const result = new Map<string, Blocker>();
  for (const blockers of [broker, bridge]) {
    const add = (kind: string, id: string) => result.set(JSON.stringify([kind, id]), { kind, id, detail: "Intercom work is unsettled." });
    for (const ask of blockers.asks) add("intercom-ask", ask.id);
    for (const id of blockers.pendingDispatch) add("intercom-dispatch", id);
    for (const id of blockers.unknownOutcomes) add("intercom-unknown", id);
    for (const id of blockers.unobservedReceipts) add("intercom-receipt", id);
  }
  return [...result.values()];
}
/** This runtime inspects only its own complete physical entry tree. No transcript path is opened. */
export async function reconcileOwnIntercom(ctx: ExtensionContext, requests: readonly ReconcileRequest[]): Promise<readonly ReconcileProof[]> {
  return requests.map(request => {
    const receipts: MessageReceipt[] = [], owner = request.owner;
    const entries = () => {
      if (ctx.sessionManager.getSessionId() !== owner.address.sessionId || !ctx.sessionManager.getSessionFile()) throw new Error("own-session-entries-unavailable");
      return ctx.sessionManager.getEntries();
    };
    const observer = createIntercomDeliveryObserver({ sessionId: owner.address.sessionId, generation: owner.activationEpoch, entries, receipt: receipt => receipts.push(receipt), now: Date.now });
    observer.register(request.messageId);
    observer.accept(request.messageId); // Reconciliation starts after an uncertain handoff.
    const exclusion = request.exclusion;
    const excluded = exclusion && sameAddress(exclusion.owner.address, owner.address) && exclusion.owner.machineId === owner.machineId && exclusion.owner.homeEpoch === owner.homeEpoch && exclusion.owner.activationEpoch === owner.activationEpoch && exclusion.excludedGeneration === owner.activationEpoch;
    observer.settle(excluded ? { excludedGeneration: owner.activationEpoch, complete: true } : undefined);
    return { owner, receipt: receipts.at(-1)! };
  });
}
