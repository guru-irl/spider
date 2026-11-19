import { join } from "node:path";
import { withProcessLock, type ProcessLockOptions } from "@spider/herdr/sessions/registry";
import type { Journal, Limits, Peer } from "./contracts";
import type { ProvisionPorts } from "./provision-contracts";
import { createHcProvisionAdapter } from "./provision-adapter";
import { persistProvisionPeer } from "./provision-config";
import { createProvisionLock } from "./provision-lock";
import type { ProvisionTransport } from "./transport";
import { openLocalCore, readLocalIdentity } from "./runtime";
import { setEnrolledPeerEnabled } from "./peer-enabled";

export interface ProductionProvisionOptions {
  root: string; hubMachineId: string; peer: Peer; operationId: string; transport: ProvisionTransport; journal: Journal; limits: Limits;
  source: ProvisionPorts["source"]; destination: ProvisionPorts["destination"]; unitDir: string;
  release: ProvisionPorts["release"]; configuredClis?: ProvisionPorts["configuredClis"];
  present: ProvisionPorts["present"]; confirm: ProvisionPorts["confirm"]; report: ProvisionPorts["report"];
  resources: ProvisionPorts["resources"]; bootId: ProvisionPorts["bootId"]; lockOptions?: ProcessLockOptions;
}
function samePeer(a: Peer, b: Peer): boolean {
  return a.machineId === b.machineId && a.alias === b.alias && a.node === b.node && a.pi === b.pi &&
    a.cli === b.cli && a.core === b.core && a.globalRoot === b.globalRoot && a.agentDir === b.agentDir && a.coreUnit === b.coreUnit;
}

/** Never use stale readiness to re-enable a box after a completed provisioning retry. */
export async function setProvisionParticipation(input: Pick<ProductionProvisionOptions, "root" | "hubMachineId" | "journal" | "transport" | "lockOptions"> &
    { peer: Peer; ready: boolean | null }): Promise<void> {
  await withProcessLock(join(input.root, "roam"), "roam-configuration", async () => {
    const config = readLocalIdentity(input.root);
    if (config.role !== "hub" || config.machineId !== input.hubMachineId || !config.peers.some(peer => samePeer(peer, input.peer))) {
      throw new Error("machine-not-enrolled");
    }
    if (config.enabled && input.ready === null) return;
    await setEnrolledPeerEnabled({ config, peer: input.peer, enabled: config.enabled && input.ready === true,
      journal: input.journal, transport: input.transport });
  }, input.lockOptions);
}

/** Bind production effects to one peer and operation; UI and resource probes stay injected. */
export function createProductionProvisionPorts(input: ProductionProvisionOptions): ProvisionPorts {
  const adapter = createHcProvisionAdapter({ peer: input.peer, operationId: input.operationId, destination: input.destination,
    unitDir: input.unitDir, limits: input.limits, transport: input.transport, piProviders: input.source.piProviders });
  const lock = createProvisionLock(input.root, input.lockOptions);
  return {
    hubMachineId: input.hubMachineId, transport: input.transport.transport, journal: input.journal, limits: input.limits, ...(input.peer.coreUnit ? { coreUnit: input.peer.coreUnit } : {}),
    ...(input.configuredClis ? { configuredClis: input.configuredClis } : {}),
    source: input.source, destination: input.destination, release: input.release,
    confirm: input.confirm, present: input.present, report: input.report, resources: input.resources, bootId: input.bootId,
    systemd: adapter.systemd, transfer: adapter, verifyPeer: adapter.verifyPeer,
    withPeerLock: lock,
    async assertCorePinReplaceIdle(peer) {
      const core = openLocalCore(input.root);
      try {
        if (core.config.enabled || core.db.prepare("SELECT 1 FROM session_homes WHERE machine_id = ? LIMIT 1").get(peer.machineId)) {
          throw Object.assign(new Error("Stop hosting and move sessions off this box before replacing its core pin"), { code: "core-pin-in-use" });
        }
      } finally { core.close(); }
    },
    bootstrap: { async probeAgentDirectory(peer, home) {
      if (!samePeer(input.peer, peer) || home !== input.destination.home) throw new Error("Provision target changed");
      return input.transport.probeAgentDirectory(peer, home);
    }, async previewSettings(peer, home, entries, maximum, core, selectedPaths) {
      if (!samePeer(input.peer, peer) || home !== input.destination.home) throw new Error("Provision target changed");
      return input.transport.previewSettings(peer, home, entries, maximum, core, selectedPaths);
    }, async claimIdentity(peer, operationId, core) {
      if (!samePeer(input.peer, peer) || operationId !== input.operationId) throw new Error("Provision target changed");
      return input.transport.claimIdentity(peer, operationId, core);
    } },
    async persistPeer(peer) {
      if (!samePeer(input.peer, peer)) throw new Error("Provision target changed");
      await persistProvisionPeer(input.root, peer, input.lockOptions);
    },
    async setParticipation(peer, ready) {
      if (!samePeer(input.peer, peer)) throw new Error("Provision target changed");
      await setProvisionParticipation({ ...input, peer, ready });
    },
  };
}
