import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Blocker, Home } from "@spider/db-core/roam/types";
import { openGlobalReadOnly } from "@spider/db-core";
import { INTERCOM_HOST_EVENT, createIntercomDeliveryObserver, sameAddress, type FederationBlockers, type IntercomHostRequest, type MessageReceipt, type SessionAddress, type SessionEndpoint } from "@spider/intercom/protocol";
import type { IntercomControlFrame, IntercomReceiptFrame, IntercomStore, SessionGenerationExclusion } from "@spider/roam/intercom-contracts";
import type { IntercomFederationClient } from "@spider/intercom/broker/client";
import { addressKey, type RemoteSessionInfo } from "@spider/intercom/protocol";
import type { Admission, AdmissionGate } from "./admission.js";
import { ordinaryWorkAllowed } from "./activation.js";

export interface Disposable { dispose(): void }
export interface HostIntercomPorts {
  admission(): Admission;
  machineId(): Promise<string | undefined>;
  home(address: SessionAddress): Home | null | "unknown";
  exclusion?(owner: SessionEndpoint): SessionGenerationExclusion | undefined;
}
export interface ReconcileRequest { messageId: string; owner: SessionEndpoint; exclusion?: SessionGenerationExclusion }
export interface ReconcileProof { owner: SessionEndpoint; receipt: MessageReceipt }
export function createHostIntercomPorts(gate: AdmissionGate): HostIntercomPorts {
  return { admission: () => gate.inspect(), machineId: async () => {
    const admission = gate.inspect();
    return ordinaryWorkAllowed(admission) ? admission.home?.machineId : undefined;
  }, home(address) {
    let db: ReturnType<typeof openGlobalReadOnly>;
    try {
      db = openGlobalReadOnly();
      const row = db?.prepare("SELECT machine_id,epoch,move_id,updated_at FROM session_homes WHERE session_id=?").get(address.sessionId) as { machine_id: string; epoch: number; move_id: string | null; updated_at: number } | undefined;
      return row ? { sessionId: address.sessionId, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at } : null;
    } catch { return "unknown"; } finally { db?.close(); }
  } };
}
export function registerRoamIntercom(pi: ExtensionAPI, ports: HostIntercomPorts): Disposable {
  let sessionId = "", machineId: string | undefined, disposed = false, generation = 0;
  const off = pi.events.on(INTERCOM_HOST_EVENT, payload => {
    const request = payload as IntercomHostRequest;
    if (disposed || request.sessionId !== sessionId) return;
    request.home = address => ports.home(address);
    request.exclusion = owner => {
      const proof = ports.exclusion?.(owner);
      if (!proof || !sameAddress(proof.owner.address, owner.address) || proof.owner.machineId !== owner.machineId || proof.owner.homeEpoch !== owner.homeEpoch || proof.owner.activationEpoch !== owner.activationEpoch || proof.excludedGeneration !== owner.activationEpoch) return undefined;
      return { excludedGeneration: owner.activationEpoch, complete: true };
    };
    const admission = ports.admission();
    if (!machineId || !ordinaryWorkAllowed(admission)) return;
    request.endpoint = { address: { sessionId, scopeId: request.scopeId }, machineId, homeEpoch: admission.home?.epoch ?? null, activationEpoch: request.activationEpoch };
  });
  const dispose = () => { if (disposed) return; disposed = true; generation++; machineId = undefined; off(); };
  pi.on("session_start", async (_event, ctx) => {
    if (disposed) return;
    const ticket = ++generation; sessionId = ctx.sessionManager.getSessionId(); machineId = undefined;
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


export interface HostIntercomDeliveryPorts {
  store: IntercomStore;
  broker: Pick<IntercomFederationClient, "deliver" | "deliverReceipt" | "deliverControl">;
  endpoint(address: SessionAddress): SessionEndpoint | null;
  sender(address: SessionAddress): RemoteSessionInfo | null;
  wake(peer: string): void;
  now(): number;
  onError?(reason: string): void;
}
const sameEndpoint = (a: SessionEndpoint, b: SessionEndpoint) => sameAddress(a.address, b.address) && a.machineId === b.machineId && a.homeEpoch === b.homeEpoch && a.activationEpoch === b.activationEpoch;
/** The machine service owns this adapter. Only the owning fork supplies physical-entry evidence. */
export interface HostIntercomDelivery {
  ready(address: SessionAddress, transition: string): Promise<void>;
  reconcile(proofs: readonly ReconcileProof[]): Promise<void>;
  onInbound(input: { id: string; to: SessionAddress }): void;
  onReceipt(frame: IntercomReceiptFrame): void;
  onControl(frame: IntercomControlFrame): void;
  onAskFailed(failure: { id: string; from: SessionAddress; to: SessionAddress; reason: "link-down" }): void;
  onExpiry(event: { id: string; from: SessionAddress; to: SessionAddress }): void;
}
export function createHostIntercomDelivery(ports: HostIntercomDeliveryPorts): HostIntercomDelivery {
  const readiness = new Map<string, string>(), active = new Map<string, Promise<void>>(), notified = new Set<string>();
  const report = () => ports.onError?.("intercom-broker-unavailable");
  async function ready(address: SessionAddress, transition: string): Promise<void> {
    const key = addressKey(address); readiness.set(key, transition);
    const current = active.get(key);
    if (current) { await current; if (readiness.get(key) !== transition) return; }
    const run = (async () => {
      const endpoint = ports.endpoint(address); if (!endpoint) return;
      let progress: boolean;
      do {
        progress = false;
        for (const identity of ports.store.pending({ kind: "inbound", address })) {
          const retained = ports.store.retained("inbound", identity.id), sender = ports.sender(identity.from);
          if (!retained || !sameEndpoint(retained.endpoint, endpoint) || !sender) continue;
          let frame;
          try { frame = ports.store.beginDispatch({ id: identity.id, endpoint, readiness: transition }); }
          catch (error) { if (error instanceof Error && error.message === "Intercom retry needs a new readiness transition") continue; throw error; }
          progress = true;
          try {
            const result = await ports.broker.deliver(sender, endpoint, frame.message);
            if (result.consumption) await reconcile([{ owner: endpoint, receipt: result.consumption }]);
          } catch { report(); }
        }
      } while (progress);
    })();
    active.set(key, run);
    try { await run; } finally { if (active.get(key) === run) active.delete(key); }
  }
  async function reconcile(proofs: readonly ReconcileProof[]): Promise<void> {
    for (const proof of proofs) {
      const row = ports.store.retained("inbound", proof.receipt.messageId);
      if (!row || !sameEndpoint(row.endpoint, proof.owner)) throw new Error("intercom-reconciliation-owner-mismatch");
      const frame = { from: row.endpoint, to: row.identity.from, digest: row.identity.digest, receipt: proof.receipt, attempt: row.latestAttempt };
      if (proof.receipt.status === "not_injected") {
        if (row.reconciliation && JSON.stringify(row.reconciliation) === JSON.stringify(proof.receipt) && row.state !== "unknown") continue;
        ports.store.resolveUnknown({ queue: "inbound", id: row.identity.id, digest: row.identity.digest, proof: frame });
      } else ports.store.settleReceipt({ queue: "inbound", peer: row.peer, frame });
      ports.wake(row.peer);
    }
  }
  return {
    ready, reconcile,
    onInbound(input: { id: string; to: SessionAddress }): void {
      const transition = readiness.get(addressKey(input.to));
      if (transition) void ready(input.to, transition).catch(report);
    },
    onReceipt(frame: IntercomReceiptFrame): void {
      const row = ports.store.retained("outbound", frame.receipt.messageId);
      if (!row || !sameEndpoint(row.endpoint, frame.from) || !sameAddress(row.identity.from, frame.to) || row.identity.digest !== frame.digest) throw new Error("intercom-receipt-route-mismatch");
      if (frame.receipt.status === "not_injected" && row.pendingProof) {
        ports.store.resolveUnknown({ queue: "outbound", id: row.identity.id, digest: row.identity.digest, proof: frame });
        ports.wake(row.peer);
      }
      // Wire receipts remain body-free. A reply injected as an ordinary entry (not
      // a matched waiter) carries enough durable identity to reconstruct this notice.
      const receipt = row.identity.askId && row.identity.askId !== row.identity.id && frame.receipt.status === "injected"
        ? { ...frame.receipt, detail: "asker-no-longer-waiting" } : frame.receipt;
      const sender = ports.sender(frame.from.address); if (sender) ports.broker.deliverReceipt(sender, frame.to, receipt);
    },
    onControl(frame: IntercomControlFrame): void {
      const sender = ports.sender(frame.from); if (sender) ports.broker.deliverControl(sender, frame.to, frame.control);
    },
    onAskFailed(failure: { id: string; from: SessionAddress; to: SessionAddress; reason: "link-down" }): void {
      const sender = ports.sender(failure.to), key = `link-down:${failure.id}`;
      if (sender && !notified.has(key)) {
        ports.broker.deliverReceipt(sender, failure.from, { messageId: failure.id, status: "unknown", timestamp: ports.now(), detail: "link-down" }); notified.add(key);
      }
    },
    onExpiry(event: { id: string; from: SessionAddress; to: SessionAddress }): void {
      const sender = ports.sender(event.to), key = `expired:${event.id}`;
      if (sender && !notified.has(key)) {
        ports.broker.deliverReceipt(sender, event.from, { messageId: event.id, status: "expired", timestamp: ports.now(), detail: "Question or queued message expired." }); notified.add(key);
      }
    },
  };
}
