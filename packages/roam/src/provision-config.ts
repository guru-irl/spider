import { closeSync, constants, fsyncSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withProcessLock, writePrivateJson, type ProcessLockOptions } from "@spider/herdr/sessions/registry";
import { parseConfig } from "./config";
import type { Peer } from "./contracts";
import { readLocalIdentity } from "./runtime";
import { createIntercomRegistry } from "./intercom-registry";
import type { IntercomEnrollmentPair } from "./provision-contracts";

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

/** Publish routing for one approved pair; do not enable intercom or alter replication. */
export async function persistIntercomPairRoute(root: string, pair: IntercomEnrollmentPair, operationId: string, graphDigest: string): Promise<void> {
  const initial = readLocalIdentity(root), directory = join(root, "roam"), file = join(directory, "config.json");
  const local = initial.machineId, remote = local === pair.source.machineId ? pair.target : local === pair.target.machineId ? pair.source : null;
  if (!remote || (local === pair.source.machineId ? pair.source.globalRoot : pair.target.globalRoot) !== root) throw new Error("machine-mismatch");
  await withProcessLock(directory, "roam-configuration", async () => {
    const current = readLocalIdentity(root), record = await createIntercomRegistry(root).get(pair.pairId);
    if (current.machineId !== local || !current.intercom.enabled || !(current.intercom.mode === "peers" || current.role === "box" && current.intercom.mode === "hub-only")) throw new Error("intercom-mode-not-peers");
    const registered = record?.pair as Partial<IntercomEnrollmentPair> | undefined;
    if (!record || !["pending", "active"].includes(record.state) || record.operationId !== operationId || record.graphDigest !== graphDigest ||
        registered?.edgeEpoch !== pair.edgeEpoch || registered?.source?.machineId !== pair.source.machineId || registered?.target?.machineId !== pair.target.machineId ||
        registered?.sshUser !== pair.sshUser || registered?.hostKeyAlias !== pair.hostKeyAlias || registered?.hostKey?.type !== pair.hostKey.type ||
        registered?.hostKey?.base64 !== pair.hostKey.base64) throw new Error("peer-consent-required");
    const previous = current.intercom.routes.find(route => route.peer.machineId === remote.machineId);
    if (current.intercom.mode === "hub-only") {
      if (previous) {
        if (previous.kind !== "relay" || previous.via !== current.hubMachineId) throw new Error("intercom-route-missing");
        return;
      }
      if (!current.intercom.routes.some(route => route.kind === "direct" && route.peer.machineId === current.hubMachineId)) throw new Error("intercom-route-missing");
    } else if (previous && (previous.kind !== "direct" || previous.edgeEpoch !== pair.edgeEpoch) && !record.fenceId) throw new Error("intercom-edge-must-be-revoked");
    const transportPeer = local === pair.source.machineId && record.resources ? { ...remote, alias: record.resources.route.name } : remote;
    // The registry stages the direct edge. Only the durable hub switch activates it.
    const route = current.intercom.mode === "hub-only"
      ? { kind: "relay" as const, peer: remote, via: current.hubMachineId }
      : { kind: "direct" as const, peer: transportPeer, edgeEpoch: pair.edgeEpoch };
    if (previous && JSON.stringify(previous) === JSON.stringify(route)) return;
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid-intercom-config");
    const object = raw as Record<string, unknown>, intercom = object.intercom as Record<string, unknown>;
    if (!intercom || typeof intercom !== "object" || Array.isArray(intercom)) throw new Error("invalid-intercom-config");
    const routes = [...current.intercom.routes.filter(item => item.peer.machineId !== remote.machineId), route];
    const next = { ...object, intercom: { ...intercom, routes } }, validated = parseConfig(next);
    await writePrivateJson(file, next);
    if (process.platform !== "win32") { const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
    if (JSON.stringify(readLocalIdentity(root)) !== JSON.stringify(validated)) throw new Error("invalid-intercom-config");
  });
}
