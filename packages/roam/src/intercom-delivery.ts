import { addressKey, sameAddress, type MessageReceipt, type RemoteSessionInfo, type SessionAddress, type SessionEndpoint } from "@spider/intercom/protocol";
import type { IntercomFederationClient } from "@spider/intercom/broker/client";
import type { IntercomControlFrame, IntercomReceiptFrame, IntercomStore } from "./intercom-contracts";

export interface ReconcileProof { owner: SessionEndpoint; receipt: MessageReceipt }
export interface HostIntercomDeliveryPorts {
  store: IntercomStore;
  broker: Pick<IntercomFederationClient, "deliver" | "deliverReceipt" | "deliverControl">;
  endpoint(address: SessionAddress): SessionEndpoint | null;
  sender(address: SessionAddress): RemoteSessionInfo | null;
  machineAlias?(machineId: string): string | null;
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
  stop(): Promise<void>;
}
export function createHostIntercomDelivery(ports: HostIntercomDeliveryPorts): HostIntercomDelivery {
  const readiness = new Map<string, string>(), active = new Map<string, Promise<void>>(), notified = new Set<string>();
  let stopped = false;
  const report = () => ports.onError?.("intercom-broker-unavailable");
  // Origin is historical provenance, not a current reply route or activation. Do
  // not consult presence: the sender may have exited or moved since acceptance.
  const historical = (address: SessionAddress, machineId: string, endpoint?: SessionEndpoint): RemoteSessionInfo => ({
    remote: true, id: address.sessionId, address, machineId, machineAlias: ports.machineAlias?.(machineId) ?? machineId,
    homeEpoch: endpoint?.homeEpoch ?? null, activationEpoch: endpoint?.activationEpoch ?? "unknown",
    endpointEpoch: endpoint?.activationEpoch ?? "unknown", cwd: "", model: "", startedAt: 0, lastActivity: 0,
    status: "unknown", stale: true, reachability: "down",
  });
  async function ready(address: SessionAddress, transition: string): Promise<void> {
    if (stopped) return;
    const key = addressKey(address); readiness.set(key, transition);
    const current = active.get(key);
    if (current) { await current; if (stopped || readiness.get(key) !== transition) return; }
    const run = (async () => {
      const endpoint = ports.endpoint(address); if (!endpoint) return;
      let progress: boolean;
      do {
        progress = false;
        for (const identity of ports.store.pending({ kind: "inbound", address })) {
          if (stopped) break;
          let retained = ports.store.retained("inbound", identity.id);
          if (!retained || !retained.originMachineId) continue;
          if (!sameEndpoint(retained.endpoint, endpoint)) {
            try { ports.store.rebindInboundAfterAbsence(identity.id, endpoint); retained = ports.store.retained("inbound", identity.id); }
            catch { continue; }
          }
          if (!retained || !sameEndpoint(retained.endpoint, endpoint) || !retained.originMachineId) continue;
          const sender = historical(identity.from, retained.originMachineId);
          let frame;
          try { frame = ports.store.beginDispatch({ id: identity.id, endpoint, readiness: transition }); }
          catch (error) { if (error instanceof Error && error.message === "Intercom retry needs a new readiness transition") continue; throw error; }
          progress = true;
          try {
            const result = await ports.broker.deliver(sender, endpoint, frame.message);
            if (result.consumption) await reconcile([{ owner: endpoint, receipt: result.consumption }]);
          } catch { report(); }
        }
      } while (progress && !stopped);
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
    async stop() { stopped = true; await Promise.allSettled([...active.values()]); },
    onInbound(input: { id: string; to: SessionAddress }): void {
      const transition = readiness.get(addressKey(input.to));
      if (!stopped && transition) void ready(input.to, transition).catch(report);
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
      const sender = historical(frame.from.address, frame.from.machineId, frame.from);
      ports.broker.deliverReceipt(sender, frame.to, receipt);
    },
    onControl(frame: IntercomControlFrame): void {
      const sender = ports.sender(frame.from); if (sender) ports.broker.deliverControl(sender, frame.to, frame.control);
    },
    onAskFailed(failure: { id: string; from: SessionAddress; to: SessionAddress; reason: "link-down" }): void {
      const row = ports.store.retained("outbound", failure.id), key = `link-down:${failure.id}`;
      const sender = row ? historical(failure.to, row.endpoint.machineId, row.endpoint) : ports.sender(failure.to);
      if (sender && !notified.has(key)) {
        ports.broker.deliverReceipt(sender, failure.from, { messageId: failure.id, status: "unknown", timestamp: ports.now(), detail: "link-down" }); notified.add(key);
      }
    },
    onExpiry(event: { id: string; from: SessionAddress; to: SessionAddress }): void {
      const row = ports.store.retained("outbound", event.id), key = `expired:${event.id}`;
      const sender = row ? historical(event.to, row.endpoint.machineId, row.endpoint) : ports.sender(event.to);
      if (sender && !notified.has(key)) {
        ports.broker.deliverReceipt(sender, event.from, { messageId: event.id, status: "expired", timestamp: ports.now(), detail: "Question or queued message expired." }); notified.add(key);
      }
    },
  };
}
