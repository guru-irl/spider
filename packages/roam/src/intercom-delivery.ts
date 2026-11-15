import { addressKey, sameAddress, type MessageReceipt, type RemoteSessionInfo, type SessionAddress, type SessionEndpoint } from "@spider/intercom/protocol";
import { FederationRequestNotSentError, type IntercomFederationClient } from "@spider/intercom/broker/client";
import type { IntercomControlFrame, IntercomReceiptFrame, IntercomStore } from "./intercom-contracts";
import { firstHomeEndpointMatches, type FirstHomeAdoption } from "./intercom-first-home";

export interface ReconcileProof { owner: SessionEndpoint; receipt: MessageReceipt }
export interface HostIntercomDeliveryPorts {
  store: IntercomStore;
  broker: Pick<IntercomFederationClient, "deliver" | "deliverReceipt" | "deliverControl"> & Partial<Pick<IntercomFederationClient, "deliverRevocationNotice">>;
  endpoint(address: SessionAddress): SessionEndpoint | null;
  initialHomeAdoption?(endpoint: SessionEndpoint): FirstHomeAdoption | undefined;
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
  onRevocationNotice(frame: IntercomReceiptFrame): Promise<boolean>;
  onControl(frame: IntercomControlFrame): void;
  onAskFailed(failure: { id: string; from: SessionAddress; to: SessionAddress; reason: "link-down" }): void;
  onExpiry(event: { id: string; from: SessionAddress; to: SessionAddress }): void;
  stop(): Promise<void>;
}
export function createHostIntercomDelivery(ports: HostIntercomDeliveryPorts): HostIntercomDelivery {
  const readiness = new Map<string, string>(), active = new Map<string, Promise<void>>(), rerun = new Set<string>();
  let stopped = false;
  const report = () => ports.onError?.("intercom-broker-unavailable");
  const matches = (queued: SessionEndpoint, live: SessionEndpoint) => {
    if (sameEndpoint(queued, live)) return true;
    try { return firstHomeEndpointMatches(ports.initialHomeAdoption?.(queued), queued, live); }
    catch { return false; }
  };
  // Origin is historical provenance, not a current reply route or activation. Do
  // not consult presence: the sender may have exited or moved since acceptance.
  const historical = (address: SessionAddress, machineId: string, endpoint?: SessionEndpoint): RemoteSessionInfo => ({
    remote: true, id: address.sessionId, address, machineId, machineAlias: ports.machineAlias?.(machineId) ?? machineId,
    homeEpoch: endpoint?.homeEpoch ?? null, activationEpoch: endpoint?.activationEpoch ?? "unknown",
    endpointEpoch: endpoint?.activationEpoch ?? "unknown", cwd: "", model: "", startedAt: 0, lastActivity: 0,
    status: "unknown", stale: true, reachability: "down",
  });
  function ready(address: SessionAddress, transition: string): Promise<void> {
    if (stopped) return Promise.resolve();
    const key = addressKey(address), changed = readiness.get(key) !== transition;
    readiness.set(key, transition);
    const current = active.get(key);
    if (current) { if (changed) rerun.add(key); return current; }
    let resolveRun!: () => void, rejectRun!: (error: unknown) => void;
    const run = new Promise<void>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    active.set(key, run);
    void (async () => {
      try {
        do { rerun.delete(key); await drain(address, readiness.get(key)!); }
        while (!stopped && rerun.has(key));
      } finally { active.delete(key); rerun.delete(key); }
    })().then(resolveRun, rejectRun);
    return run;
  }
  async function drain(address: SessionAddress, transition: string): Promise<void> {
    const endpoint = ports.endpoint(address); if (!endpoint) return;
    let progress: boolean;
    do {
      progress = false;
      for (const identity of ports.store.pending({ kind: "inbound", address })) {
        if (stopped) break;
        let retained = ports.store.retained("inbound", identity.id);
        if (!retained || !retained.originMachineId) continue;
        if (!matches(retained.endpoint, endpoint)) {
          try { ports.store.rebindInboundAfterAbsence(identity.id, endpoint); retained = ports.store.retained("inbound", identity.id); }
          catch { continue; }
        }
        if (!retained || !matches(retained.endpoint, endpoint) || !retained.originMachineId) continue;
        const sender = historical(identity.from, retained.originMachineId);
        let frame;
        const owner = retained.endpoint;
        try { frame = ports.store.beginDispatch({ id: identity.id, endpoint: owner, readiness: transition }); }
        catch (error) { if (error instanceof Error && error.message === "Intercom retry needs a new readiness transition") continue; throw error; }
        progress = true;
        const attempt = ports.store.retained("inbound", identity.id)!.latestAttempt;
        try {
          // The broker still checks the exact current registration. The durable
          // copy and its receipts keep the pre-adoption owner, on this activation.
          const result = await ports.broker.deliver(sender, endpoint, frame.message);
          if (result.consumption) await reconcile([{ owner, receipt: result.consumption }]);
        } catch (error) {
          if (error instanceof FederationRequestNotSentError) {
            ports.store.retryKnownNotSent({ id: identity.id, endpoint: owner, attempt });
            report(); return;
          }
          report();
        }
      }
    } while (progress && !stopped);
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
      const key = addressKey(input.to), transition = readiness.get(key);
      if (!stopped && transition) {
        if (active.has(key)) rerun.add(key);
        void ready(input.to, transition).catch(report);
      }
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
    async onRevocationNotice(frame: IntercomReceiptFrame): Promise<boolean> {
      const row = ports.store.retained("outbound", frame.receipt.messageId);
      if (!row || !sameEndpoint(row.endpoint, frame.from) || !sameAddress(row.identity.from, frame.to) || row.identity.digest !== frame.digest ||
          frame.receipt.status !== "cancelled" || frame.receipt.detail !== "peer-revoked") throw new Error("intercom-receipt-route-mismatch");
      const sender = historical(frame.from.address, frame.from.machineId, frame.from);
      return ports.broker.deliverRevocationNotice ? ports.broker.deliverRevocationNotice(sender, frame.to, frame.receipt) : false;
    },
    onControl(frame: IntercomControlFrame): void {
      const sender = ports.sender(frame.from); if (sender) ports.broker.deliverControl(sender, frame.to, frame.control);
    },
    onAskFailed(failure: { id: string; from: SessionAddress; to: SessionAddress; reason: "link-down" }): void {
      const row = ports.store.retained("outbound", failure.id);
      const sender = row ? historical(failure.to, row.endpoint.machineId, row.endpoint) : ports.sender(failure.to);
      if (row && sender && !ports.store.noticeReported(failure.id, "link-down")) {
        ports.broker.deliverReceipt(sender, failure.from, { messageId: failure.id, status: "unknown", timestamp: ports.now(), detail: "link-down" }); ports.store.markNoticeReported(failure.id, "link-down");
      }
    },
    onExpiry(event: { id: string; from: SessionAddress; to: SessionAddress }): void {
      const row = ports.store.retained("outbound", event.id);
      const sender = row ? historical(event.to, row.endpoint.machineId, row.endpoint) : ports.sender(event.to);
      if (row && sender && !ports.store.noticeReported(event.id, "expiry")) {
        ports.broker.deliverReceipt(sender, event.from, { messageId: event.id, status: "expired", timestamp: ports.now(), detail: "Question or queued message expired." }); ports.store.markNoticeReported(event.id, "expiry");
      }
    },
  };
}
