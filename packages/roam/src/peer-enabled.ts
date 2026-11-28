import { randomUUID } from "node:crypto";
import type { Diagnostic, Journal, Peer, RoamConfig, Transport } from "./contracts";
import type { ProvisionTransport } from "./transport";
import { remoteDoctor } from "./remote-observations";
export async function setEnrolledPeerEnabled(input: { config: RoamConfig; peer: Peer; enabled: boolean; operationId?: string; journal: Journal; transport: ProvisionTransport }): Promise<void> {
  const { config, peer, enabled, journal, transport } = input;
  if (config.role !== "hub" || !config.peers.some(row => JSON.stringify(row) === JSON.stringify(peer))) throw new Error("machine-not-enrolled");
  const operationId = input.operationId ?? randomUUID();
  const begun = journal.begin({ id: operationId, machineId: peer.machineId, expectedEpoch: null, kind: "explicit-participant-control", args: { hubMachineId: config.machineId, enabled } });
  if (begun.kind === "done") {
    if (begun.result?.enabled !== enabled) throw new Error("peer-enabled-unconfirmed");
    return;
  }
  if (!journal.read(operationId).some(row => row.action === "provision-consent"))
    journal.record(operationId, "provision-consent", { approved: true, scope: "roaming-enabled", target: peer.alias, machineId: peer.machineId, enabled });
  const handle = await transport.transport.resolve(peer);
  const result = await transport.executeProvision(handle, { action: "roaming-enabled", operationId, machineId: peer.machineId,
    globalRoot: peer.globalRoot, node: peer.node, pi: peer.pi, cli: peer.cli, hubMachineId: config.machineId, enabled });
  if (!result || typeof result !== "object" || !("enabled" in result) || result.enabled !== enabled) throw new Error("peer-enabled-unconfirmed");
  journal.record(operationId, "done", { enabled });
}
export async function peerEnabledDiagnostics(config: RoamConfig, transport: Transport): Promise<Diagnostic[]> {
  if (config.role !== "hub") return [];
  const findings: Diagnostic[] = [];
  for (const peer of config.peers) {
    try {
      const report = await remoteDoctor(transport, peer, config);
      if (report.enabled !== config.enabled) findings.push({ reason: `peer-enabled-mismatch:${peer.machineId}`, severity: "warning", repairCommand: config.enabled ? "spider roam enable" : "spider roam disable" });
    } catch { findings.push({ reason: `peer-enabled-unavailable:${peer.machineId}`, severity: "warning", repairCommand: "spider roam doctor" }); }
  }
  return findings;
}
