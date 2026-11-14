import type { ProcessLockOptions } from "@spider/herdr/sessions/registry";
import type { Journal, Limits, Peer } from "./contracts";
import type { ProvisionPorts } from "./provision-contracts";
import { createHcProvisionAdapter } from "./provision-adapter";
import { persistProvisionPeer } from "./provision-config";
import { createProvisionLock } from "./provision-lock";
import type { ProvisionTransport } from "./transport";

export interface ProductionProvisionOptions {
  root: string; hubMachineId: string; peer: Peer; operationId: string; transport: ProvisionTransport; journal: Journal; limits: Limits;
  source: ProvisionPorts["source"]; destination: ProvisionPorts["destination"]; unitDir: string; coreUnit: string;
  release: ProvisionPorts["release"]; configuredClis?: ProvisionPorts["configuredClis"];
  present: ProvisionPorts["present"]; confirm: ProvisionPorts["confirm"]; report: ProvisionPorts["report"];
  resources: ProvisionPorts["resources"]; bootId: ProvisionPorts["bootId"]; lockOptions?: ProcessLockOptions;
}
function samePeer(a: Peer, b: Peer): boolean {
  return a.machineId === b.machineId && a.alias === b.alias && a.node === b.node && a.pi === b.pi &&
    a.cli === b.cli && a.core === b.core && a.globalRoot === b.globalRoot;
}

/** Bind production effects to one peer and operation; UI and resource probes stay injected. */
export function createProductionProvisionPorts(input: ProductionProvisionOptions): ProvisionPorts {
  const adapter = createHcProvisionAdapter({ peer: input.peer, operationId: input.operationId, destination: input.destination,
    unitDir: input.unitDir, coreUnit: input.coreUnit, limits: input.limits, transport: input.transport, piProviders: input.source.piProviders });
  const lock = createProvisionLock(input.root, input.lockOptions);
  return {
    hubMachineId: input.hubMachineId, transport: input.transport.transport, journal: input.journal, limits: input.limits, coreUnit: input.coreUnit,
    ...(input.configuredClis ? { configuredClis: input.configuredClis } : {}),
    source: input.source, destination: input.destination, release: input.release,
    confirm: input.confirm, present: input.present, report: input.report, resources: input.resources, bootId: input.bootId,
    systemd: adapter.systemd, transfer: adapter, verifyPeer: adapter.verifyPeer,
    withPeerLock: lock,
    bootstrap: { async probeAgentDirectory(peer, home) {
      if (!samePeer(input.peer, peer) || home !== input.destination.home) throw new Error("Provision target changed");
      return input.transport.probeAgentDirectory(peer, home);
    }, async previewSettings(peer, home, entries, maximum, core) {
      if (!samePeer(input.peer, peer) || home !== input.destination.home) throw new Error("Provision target changed");
      return input.transport.previewSettings(peer, home, entries, maximum, core);
    }, async claimIdentity(peer, operationId, core) {
      if (!samePeer(input.peer, peer) || operationId !== input.operationId) throw new Error("Provision target changed");
      return input.transport.claimIdentity(peer, operationId, core);
    } },
    async persistPeer(peer) {
      if (!samePeer(input.peer, peer)) throw new Error("Provision target changed");
      await persistProvisionPeer(input.root, peer, input.lockOptions);
    },
  };
}
