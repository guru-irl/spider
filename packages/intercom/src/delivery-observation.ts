import type { ConsumptionEvidence, MessageReceipt } from "./protocol.js";

export interface GenerationExclusion { excludedGeneration: string; complete: true }
export interface DeliveryObservation<Evidence> {
  generation: string;
  accepted: boolean;
  observed: boolean;
  state: "pending" | "injected" | "matched_waiter" | "not_injected" | "unknown";
  evidence?: Evidence;
}

/** Adapters supply correlation and proof. Acceptance alone never confirms entry. */
export function createDeliveryObserver<Evidence = unknown>() {
  const pending = new Map<string, DeliveryObservation<Evidence>>();
  const current = (id: string, generation: string) => {
    const value = pending.get(id);
    return value?.generation === generation ? value : undefined;
  };
  return {
    register(id: string, generation: string): boolean {
      const previous = pending.get(id);
      if (previous && previous.state !== "not_injected") return false;
      pending.set(id, { generation, accepted: false, observed: false, state: "pending" });
      return true;
    },
    accept(id: string, generation: string): void {
      const value = current(id, generation);
      if (value) value.accepted = true;
    },
    observe(id: string, generation: string, evidence: Evidence, state: "injected" | "matched_waiter" = "injected"): void {
      const value = current(id, generation);
      if (!value || value.observed || value.state === "not_injected") return;
      value.observed = true;
      value.state = state;
      value.evidence = evidence;
    },
    settle(id: string, generation: string, proof?: GenerationExclusion): DeliveryObservation<Evidence> | undefined {
      const value = current(id, generation);
      if (!value) return undefined;
      if (!value.observed) value.state = proof?.complete && proof.excludedGeneration === generation ? "not_injected" : "unknown";
      return { ...value };
    },
    snapshot(id: string): DeliveryObservation<Evidence> | undefined {
      const value = pending.get(id);
      return value ? { ...value } : undefined;
    },
    forget(id: string): void { pending.delete(id); },
  };
}

export interface IntercomObservationPorts {
  sessionId: string;
  generation: string;
  /** Complete physical entries of this session, never the active branch or model projection. */
  entries(): readonly unknown[];
  receipt(value: MessageReceipt): void;
  now(): number;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function createIntercomDeliveryObserver(ports: IntercomObservationPorts) {
  const observer = createDeliveryObserver<ConsumptionEvidence>();
  const ids = new Set<string>();
  const reported = new Map<string, string>();
  const report = (id: string) => {
    const value = observer.snapshot(id);
    if (!value || value.state === "pending" || reported.get(id) === value.state) return;
    reported.set(id, value.state);
    ports.receipt({ messageId: id, status: value.state, timestamp: ports.now(), ...(value.evidence ? { evidence: value.evidence } : value.state === "not_injected" ? { evidence: { kind: "absence" as const, sessionId: ports.sessionId, activationEpoch: ports.generation, excludedGeneration: ports.generation, complete: true as const } } : {}) });
  };
  const observeEntries = (): boolean => {
    let entries: readonly unknown[];
    try { entries = ports.entries(); } catch { return false; }
    for (const entry of entries) {
      if (!record(entry) || entry.type !== "custom_message" || entry.customType !== "intercom_message" || typeof entry.id !== "string") continue;
      const details = entry.details;
      if (!record(details) || !record(details.message) || !record(details.intercom)) continue;
      const id = details.message.id;
      if (typeof id !== "string" || !ids.has(id) || details.intercom.sessionId !== ports.sessionId || details.intercom.activationEpoch !== ports.generation) continue;
      observer.observe(id, ports.generation, { kind: "entry", entryId: entry.id, sessionId: ports.sessionId, activationEpoch: ports.generation });
      report(id);
    }
    return true;
  };
  return {
    register(id: string): boolean {
      const registered = observer.register(id, ports.generation);
      if (registered) { ids.add(id); reported.delete(id); }
      return registered;
    },
    accept(id: string): void { observer.accept(id, ports.generation); },
    observeEntries: (): void => { observeEntries(); },
    snapshot: (id: string): DeliveryObservation<ConsumptionEvidence> | undefined => observer.snapshot(id),
    priorReceipt(id: string): void { reported.delete(id); report(id); },
    matchedWaiter(id: string, evidence: Extract<ConsumptionEvidence, { kind: "waiter" }>): void {
      observer.observe(id, ports.generation, evidence, "matched_waiter");
      report(id);
    },
    refuse(id: string): void {
      const complete = observeEntries();
      observer.settle(id, ports.generation, complete ? { excludedGeneration: ports.generation, complete: true } : undefined);
      report(id);
    },
    settle(proof?: GenerationExclusion): void {
      const complete = observeEntries();
      for (const id of ids) {
        observer.settle(id, ports.generation, complete ? proof : undefined);
        report(id);
      }
    },
  };
}
