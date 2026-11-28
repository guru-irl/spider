import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Db } from "@spider/db-core";
import type { StoreKey } from "@spider/db-core/roam/types";
import type { SessionAddress } from "@spider/intercom/protocol";
import type { IntercomFederationClient } from "@spider/intercom/broker/client";
import { openFreezeJournal } from "@spider/roam/journal";
import type { UsageRoots } from "../usage/discovery.js";
import { resolveUsageRoots } from "../usage/mount.js";
import type { AdmissionGate } from "./admission.js";
import type { BlockerActivity } from "./blockers.js";
import { inspectBlockers } from "./blockers.js";
import type { LiveFreezePorts } from "./control.js";
import { createBlockerPorts } from "./evidence.js";
import { inspectLiveOwner } from "./live-owner.js";
import { createProducerDrain } from "./producers.js";
import { createUsageIngestThrough } from "./usage-ingest.js";

export { inspectLiveOwner } from "./live-owner.js";

type Producers = Parameters<typeof createProducerDrain>[0];
type Evidence = Parameters<typeof createBlockerPorts>[0];
export interface LiveFreezeInput {
  globalRoot: string; sessionId: string; machineId: string; context(): ExtensionContext | undefined; bootId?: () => Promise<string>;
  gate: AdmissionGate; stores: readonly Db[]; expectedStores: readonly StoreKey[]; routeStores: readonly Db[]; address: SessionAddress;
  /** Open move-only stores on first freeze, not ordinary session admission. */
  resolveStores?(): readonly Db[];
  activity: BlockerActivity; jobRoots: readonly string[]; scratchRoots: readonly string[]; usageRoots?: UsageRoots;
  usage: Producers["usage"]; embeddings: Producers["embeddings"]; organism: Producers["organism"]; others: Producers["others"];
  broker?: Pick<IntercomFederationClient, "inspectFreezeBlockers">; bridge?: Evidence["bridge"]; settlement?: Evidence["settlement"];
  authorizeAbort?: LiveFreezePorts["authorizeAbort"]; onHubRestored?: LiveFreezePorts["onHubRestored"];
  shutdown?: LiveFreezePorts["shutdown"];
  intercom?: LiveFreezePorts["intercom"];
}

/** Missing hub, broker or bridge ports remain unavailable; none is represented as an empty snapshot. */
export function createLiveFreezePorts(input: LiveFreezeInput): LiveFreezePorts {
  const unavailable = () => { throw new Error("Control evidence unavailable"); };
  const blockers = createBlockerPorts({ sessionId: input.sessionId, address: input.address, activity: input.activity,
    routeStores: input.routeStores, jobRoots: input.jobRoots, scratchRoots: input.scratchRoots,
    broker: input.broker ? address => input.broker!.inspectFreezeBlockers(address) : async () => unavailable(), bridge: input.bridge ?? unavailable,
    settlement: input.settlement ?? (async () => null) });
  const producers = createProducerDrain(input), usageRoots = input.usageRoots ?? resolveUsageRoots();
  if (!isAbsolute(input.globalRoot) || !isAbsolute(usageRoots.registryDb) || !isAbsolute(usageRoots.ledgerFile) ||
      resolve(usageRoots.registryDb) !== join(resolve(input.globalRoot), "spider.db") ||
      resolve(usageRoots.ledgerFile) !== join(resolve(input.globalRoot), "usage.db")) throw new Error("Usage roots do not match the participant global root");
  const ingestThrough = createUsageIngestThrough(usageRoots, input.sessionId, input.machineId);
  return {
    gate: input.gate, journal: openFreezeJournal(join(input.globalRoot, "roam", "journal.db")),
    get stores() { return input.resolveStores?.() ?? input.stores; },
    expectedStores: input.expectedStores, intercom: input.intercom, ...producers, ingestThrough,
    authorizeAbort: input.authorizeAbort ?? (async () => null), onHubRestored: input.onHubRestored ?? unavailable,
    shutdown: input.shutdown ?? (async () => unavailable()),
    async inspect(fence) {
      const ctx = input.context();
      if (!ctx || ctx.sessionManager.getSessionId() !== input.sessionId) throw new Error("Participant context unavailable");
      const file = ctx.sessionManager.getSessionFile(), leaf = ctx.sessionManager.getLeafId();
      if (!file || !leaf) throw new Error("Participant transcript unavailable");
      const owner = await inspectLiveOwner(join(input.globalRoot, "herdr"), input.sessionId, file, input.bootId);
      return { file, cwd: ctx.cwd, leaf, owner, blockers: await inspectBlockers(ctx, input.stores, fence && input.intercom ? { ...blockers,
        intercom: async () => (await input.intercom!.ports.inspect(fence)).blockers } : blockers) };
    },
  };
}
