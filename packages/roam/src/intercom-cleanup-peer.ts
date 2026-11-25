import type { Peer } from "./contracts";

/** Enrollment retains cleanup scope; provisioning may upgrade its executable. */
export function selectIntercomCleanupPeer(peer: Peer, configured: readonly Peer[]): Peer {
  const current = configured.find(candidate => candidate.machineId === peer.machineId);
  if (!current) return peer;
  if (current.globalRoot !== peer.globalRoot || current.agentDir !== peer.agentDir) throw new Error("machine-mismatch");
  return { ...peer, cli: current.cli };
}
