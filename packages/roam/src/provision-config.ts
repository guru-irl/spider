import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withProcessLock, writePrivateJson, type ProcessLockOptions } from "@spider/herdr/sessions/registry";
import { parseConfig } from "./config";
import type { Peer } from "./contracts";
import { readLocalIdentity } from "./runtime";

/** Store the destination's absolute launcher paths without replacing another identity. */
export async function persistProvisionPeer(root: string, peer: Peer, options: ProcessLockOptions = {}): Promise<void> {
  const initial = readLocalIdentity(root);
  if (initial.role !== "hub") throw new Error("Peer configuration requires the hub");
  const directory = join(root, "roam"), file = join(directory, "config.json");
  await withProcessLock(directory, "roam-configuration", async () => {
    const current = readLocalIdentity(root);
    if (current.role !== "hub" || current.machineId !== initial.machineId) throw new Error("Roaming configuration changed");
    const conflicts = current.peers.filter(item => item.alias === peer.alias || item.machineId === peer.machineId);
    if (conflicts.some(item => item.alias !== peer.alias || item.machineId !== peer.machineId) || conflicts.length > 1) {
      throw new Error("Peer identity or alias already belongs to another machine");
    }
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid roaming configuration");
    const peers = conflicts.length ? current.peers.map(item => item.machineId === peer.machineId ? peer : item) : [...current.peers, peer];
    const next = { ...raw, peers }, validated = parseConfig(next);
    await writePrivateJson(file, next);
    const saved = readLocalIdentity(root);
    if (JSON.stringify(saved) !== JSON.stringify(validated)) throw new Error("Cannot verify peer configuration");
  }, options);
}
