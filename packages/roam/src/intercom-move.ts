import type { Blocker, Home } from "@spider/db-core/roam/types";
import { createHash, randomUUID } from "node:crypto";
import { addressKey, qualifiedName, isSessionAddress, isRemoteSessionInfo, sameAddress as equalAddress, sameAddress, isSessionEndpoint, type IntercomIntakeFence, type RemoteSessionInfo, type SessionAddress, type SessionEndpoint } from "@spider/intercom/protocol";
import { isIntercomIntakeFence, parseFederationBrokerMessage } from "@spider/intercom/broker/protocol";
import type { IntercomFederationClient } from "@spider/intercom/broker/client";
import type { IntercomBridge } from "./intercom-bridge";
import type { Journal } from "./contracts";
import type { IntercomMovePorts } from "./contracts";
import { isMachineId } from "./machine-id";
export class IntercomFenceError extends Error {
  constructor(readonly blockers: readonly Blocker[]) { super("Cannot verify the intercom move fence"); }
}
export interface IntercomMoveInput {
  journal?: Journal;
  broker: Pick<IntercomFederationClient, "intake" | "inspectFreezeBlockers">;
  bridge: Pick<IntercomBridge, "drainIntake" | "inspectMoveBlockers" | "undispatched" | "rebindMove" | "resumeIntake">;
  /** Live ownership or the dormant router's under-lock absence observation. */
  owns(endpoint: SessionEndpoint): Promise<boolean>;
  nextHop?(endpoint: SessionEndpoint): string;
  endpoint(address: SessionAddress): SessionEndpoint | null;
  home(address: SessionAddress): Promise<Home | null>;
  admitted(endpoint: SessionEndpoint): boolean;
  presence(endpoint: SessionEndpoint): RemoteSessionInfo | null;
  warnings(): readonly string[];
}
/** The broker handshake closes socket dispatch before acknowledging the same bridge generation. */
export function createIntercomMovePorts(input: IntercomMoveInput): IntercomMovePorts {
  const sources = new Map<string, SessionEndpoint>();
  const names = new Map<string, string | undefined>();
  const closures = new Map<string, IntercomIntakeFence>();
  const durableId = (address: SessionAddress, moveId: string, epoch: number) => `intake-${createHash("sha256").update(JSON.stringify([addressKey(address), moveId, epoch])).digest("hex").slice(0, 40)}`;
  const load = (fence: IntercomIntakeFence) => {
    const saved = input.journal?.read(durableId(fence.address, fence.moveId, fence.expectedEpoch)).find(row => row.action === "intake-owner")?.result;
    if (!saved) return;
    const owner = saved.owner as unknown as SessionEndpoint, bound = saved.fence as unknown as IntercomIntakeFence;
    if (!isSessionEndpoint(owner) || !isIntercomIntakeFence(bound) || bound.generation !== fence.generation || bound.moveId !== fence.moveId ||
        bound.expectedEpoch !== fence.expectedEpoch || !sameAddress(bound.address, fence.address) || !sameAddress(owner.address, fence.address) || owner.homeEpoch !== fence.expectedEpoch ||
        !(saved.name === null || typeof saved.name === "string")) throw new Error("Invalid durable intake owner");
    sources.set(fence.generation, owner); names.set(fence.generation, saved.name === null ? undefined : saved.name);
    closures.set(JSON.stringify([addressKey(fence.address), fence.moveId, fence.expectedEpoch]), bound);
  };
  const exactEndpoint = (a: SessionEndpoint, b: SessionEndpoint) => equalAddress(a.address, b.address) && a.machineId === b.machineId &&
    a.homeEpoch === b.homeEpoch && a.activationEpoch === b.activationEpoch;
  function refuse(kind: string, id: string): never { throw new IntercomFenceError([{ kind, id, detail: "Cannot verify the intercom move fence." }]); }
  const readHome = async (address: SessionAddress): Promise<Home | null> => {
    try {
      const home = await input.home(address);
      return home && home.sessionId === address.sessionId && isMachineId(home.machineId) && Number.isSafeInteger(home.epoch) && home.epoch >= 1 &&
        Number.isSafeInteger(home.updatedAt) && home.updatedAt >= 0 && (home.moveId === null || typeof home.moveId === "string" && home.moveId.length > 0) ? home : null;
    } catch { return null; }
  };
  const readEndpoint = (address: SessionAddress): SessionEndpoint | null => {
    try { const endpoint = input.endpoint(address); return endpoint && isSessionEndpoint(endpoint) && equalAddress(endpoint.address, address) ? endpoint : null; }
    catch { return null; }
  };
  const owned = async (endpoint: SessionEndpoint): Promise<boolean> => { try { return await input.owns(endpoint) === true; } catch { return false; } };
  const admitted = (endpoint: SessionEndpoint): boolean => { try { return input.admitted(endpoint) === true; } catch { return false; } };
  const readPresence = (endpoint: SessionEndpoint): RemoteSessionInfo | null => {
    try { const presence = input.presence(endpoint); return presence && isRemoteSessionInfo(presence) && exactEndpoint(presence, endpoint) ? presence : null; }
    catch { return null; }
  };
  const check = async (fence: IntercomIntakeFence, action: "check" | "open" = "check") => {
    if (!isIntercomIntakeFence(fence)) throw new Error("Invalid intercom closure");
    load(fence);
    try { if (await input.broker.intake(action, fence) === fence.generation) return; }
    catch (error) { if (error instanceof Error && error.message === "intercom-fence-unsupported") refuse("intercom-fence-unsupported", fence.address.sessionId); }
    refuse("intercom-generation-changed", fence.address.sessionId);
  };
  const ports: IntercomMovePorts = {
    async close(address, moveId, expectedEpoch, generation) {
      const key = JSON.stringify([addressKey(address), moveId, expectedEpoch]);
      const saved = input.journal?.read(durableId(address, moveId, expectedEpoch)).find(row => row.action === "intake-owner")?.result.fence as unknown as IntercomIntakeFence | undefined;
      if (saved) load(saved);
      const fence = closures.get(key) ?? { address, moveId, expectedEpoch, generation: generation ?? randomUUID() };
      if (!isIntercomIntakeFence(fence) || generation !== undefined && generation !== fence.generation) throw new Error("Invalid intercom closure");
      const endpoint = readEndpoint(address), home = await readHome(address);
      if (!endpoint || !isSessionEndpoint(endpoint) || !equalAddress(endpoint.address, address) || endpoint.homeEpoch !== expectedEpoch ||
          !home || home.sessionId !== address.sessionId || home.machineId !== endpoint.machineId || home.epoch !== expectedEpoch || !await owned(endpoint))
        refuse("intercom-owner-unknown", address.sessionId);
      closures.set(key, fence); sources.set(fence.generation, endpoint);
      names.set(fence.generation, readPresence(endpoint)?.name);
      if (input.journal) {
        const id = durableId(address, moveId, expectedEpoch);
        input.journal.begin({ id, machineId: endpoint.machineId, expectedEpoch, kind: "intake-owner", args: { address: { ...address }, moveId } });
        const previous = input.journal.read(id).find(row => row.action === "intake-owner")?.result;
        if (!previous) input.journal.record(id, "intake-owner", { fence: { ...fence, address: { ...address } }, owner: { ...endpoint, address: { ...address } }, name: names.get(fence.generation) ?? null });
        else load(fence);
      }
      try {
        if (await input.broker.intake("close", fence) !== fence.generation) refuse("intercom-generation-changed", address.sessionId);
      } catch (error) {
        if (error instanceof IntercomFenceError) throw error;
        refuse(error instanceof Error && error.message === "intercom-fence-unsupported" ? "intercom-fence-unsupported" : "intercom-fence-unavailable", address.sessionId);
      }
      return fence;
    },
    async drain(fence) { await check(fence); await input.bridge.drainIntake(fence); await check(fence); },
    async inspect(fence) {
      const result = new Map<string, Blocker>();
      const add = (blocker: Blocker) => result.set(JSON.stringify([blocker.kind, blocker.id]), blocker);
      try { await check(fence); } catch (error) {
        if (error instanceof IntercomFenceError) for (const blocker of error.blockers) add(blocker); else throw error;
      }
      for (const [source, read] of [
        ["broker", () => input.broker.inspectFreezeBlockers(fence.address)],
        ["bridge", () => input.bridge.inspectMoveBlockers(fence.address)],
      ] as const) {
        try {
          const observed = await read(), owner = sources.get(fence.generation);
          // This is positive durable route proof, never absence from a snapshot.
          let safe: string[] = [];
          if (source === "broker" && owner) {
            try { safe = input.bridge.undispatched(fence.address).filter(row => row.id && isSessionAddress(row.from) && isSessionAddress(row.to) &&
              isSessionEndpoint(row.endpoint) && equalAddress(row.to, fence.address) && exactEndpoint(row.endpoint, owner)).map(row => row.id); }
            catch { add({ kind: "blocker-source-unavailable", id: "bridge", detail: "Cannot inspect bridge blocker evidence." }); }
          }
          for (const blocker of intercomBlockers(fence.address, observed)) {
            if (blocker.kind === "intercom-receipt" && safe.includes(blocker.id)) continue;
            add(blocker);
          }
        }
        catch { add({ kind: "blocker-source-unavailable", id: source, detail: `Cannot inspect ${source} blocker evidence.` }); }
      }
      let warnings: readonly string[] = [];
      try {
        warnings = input.warnings();
        if (!Array.isArray(warnings) || warnings.some(warning => typeof warning !== "string" || !warning)) throw new Error("Invalid intercom warnings");
      } catch { warnings = []; add({ kind: "blocker-source-unavailable", id: "intercom-warnings", detail: "Cannot inspect intercom route warnings." }); }
      return { blockers: [...result.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)), cancelledWork: [], warnings };
    },
    checkGeneration: check,
    async abort(fence) {
      await check(fence);
      const source = sources.get(fence.generation), current = readEndpoint(fence.address), home = await readHome(fence.address);
      if (!source || !current || !exactEndpoint(source, current) || !home || home.sessionId !== fence.address.sessionId ||
          home.machineId !== source.machineId || home.epoch !== fence.expectedEpoch || !await owned(current)) refuse("intercom-owner-unknown", fence.address.sessionId);
      await check(fence, "open");
      input.bridge.resumeIntake(fence);
    },
    async ready(fence, endpoint) {
      await check(fence);
      const home = await readHome(fence.address), current = readEndpoint(fence.address), presence = readPresence(endpoint);
      if (!isSessionEndpoint(endpoint) || !equalAddress(endpoint.address, fence.address) || !current || !exactEndpoint(current, endpoint) ||
          !home || home.sessionId !== fence.address.sessionId || home.moveId !== fence.moveId || home.epoch <= fence.expectedEpoch ||
          home.machineId !== endpoint.machineId || home.epoch !== endpoint.homeEpoch || !admitted(endpoint) ||
          !presence || !exactEndpoint(presence, endpoint) || presence.name !== names.get(fence.generation)) refuse("intercom-readiness-unproved", fence.address.sessionId);
      const source = sources.get(fence.generation);
      if (!source) refuse("intercom-owner-unknown", fence.address.sessionId);
      const observed = await ports.inspect(fence);
      if (observed.blockers.length) throw new IntercomFenceError(observed.blockers);
      input.bridge.rebindMove(fence, endpoint, { owner: home,
        exclusion: { owner: source, excludedGeneration: source.activationEpoch, kind: "generation-fenced" },
        nextHop: input.nextHop?.(endpoint) ?? endpoint.machineId });
      await check(fence, "open");
      input.bridge.resumeIntake(fence);
      return { intercomAddress: qualifiedName(presence), warnings: observed.warnings };
    },
  };
  return ports;
}

export function intercomBlockers(address: SessionAddress, value: unknown): readonly Blocker[] {
  const parsed = parseFederationBrokerMessage({ type: "blockers", requestId: "move-inventory", blockers: value });
  if (!isSessionAddress(address) || !parsed || parsed.type !== "blockers") throw new Error("Invalid intercom evidence");
  const observed = parsed.blockers, result: Blocker[] = [];
  const add = (kind: string, id: string, detail: string) => result.push({ kind, id, detail });
  for (const ask of observed.asks) {
    if (sameAddress(ask.to, address)) add("intercom-ask-inbound", ask.id, "An inbound intercom ask is unresolved.");
    if (sameAddress(ask.from, address)) add("intercom-ask-outbound", ask.id, "An outbound intercom ask is unresolved.");
  }
  for (const id of observed.pendingDispatch) add("intercom-dispatch", id, "An intercom dispatch is pending.");
  for (const id of observed.unknownOutcomes) add("intercom-unknown", id, "An intercom dispatch outcome is unknown.");
  for (const id of observed.unobservedReceipts) add("intercom-receipt", id, "An intercom receipt has not been observed.");
  return result;
}
