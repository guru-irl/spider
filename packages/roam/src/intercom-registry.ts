import { AsyncLocalStorage } from "node:async_hooks";
import { constants, lstatSync, openSync, closeSync, fsyncSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { jsonFiles, readPrivateJson, withProcessLock, writePrivateJson } from "@spider/herdr/sessions/registry";
import type { Peer } from "./contracts";
import type { IntercomEnrollmentPair, IntercomEnrollmentPlan, IntercomRevocationCleanupReason } from "./provision-contracts";
import { validHostKey, validPublicKey } from "./intercom-enrollment";
import type { IntercomPairResources, IntercomUnitRecord } from "./intercom-pair-resources";
import type { IntercomPairApproval, IntercomPairFence } from "./intercom-contracts";
import { isMachineId } from "./machine-id";
import { openDiagnosticSnapshot } from "./diagnostic-snapshot";
import { validRevocationGates, type RevocationGate } from "./cause-codes";

const peerLeases = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();
/** Fixed order: peer lifecycle, then unit/config/registry locks. Never reclaim by age. */
export async function withIntercomPeerLock<T>(root: string, first: string, second: string, work: () => Promise<T>): Promise<T> {
  if (!isMachineId(first) || !isMachineId(second) || first === second) throw new Error("invalid-intercom-peer");
  assertTestConfigPath(root);
  const key = `intercom-peer:${[first, second].sort().join(":")}`, token = `${resolve(root)}:${key}`;
  const inherited = peerLeases.getStore(); if (inherited?.get(token)?.active) return work();
  return withProcessLock(join(root, "roam", "intercom"), key, async () => {
    const lease = { active: true }, scope = new Map(inherited); scope.set(token, lease);
    try { return await peerLeases.run(scope, work); } finally { lease.active = false; }
  }, { timeoutMs: 40_000, reclaimReusedOwner: true });
}

export interface IntercomPairRecord {
  version: 1; pair: IntercomEnrollmentPlan | IntercomEnrollmentPair; state: "pending" | "active" | "revoking" | "revoked" | "cancelled";
  operationId: string; graphDigest: string; fenceId: string | null; cleanupReason: IntercomRevocationCleanupReason | null;
  resources?: IntercomPairResources; unit?: IntercomUnitRecord; revocationEpoch?: string;
  commandApprovalFenceId?: string | null; revocationGates?: readonly RevocationGate[]; predecessorPairId?: string;
}
/** The owning receipt must prove closure of this exact revocation generation. */
export function isIntercomRevocationComplete(record: IntercomPairRecord, fence: Pick<IntercomPairFence, "edgeEpoch" | "fenceId">): boolean {
  return record.state === "revoked" && record.cleanupReason === null && record.fenceId === fence.fenceId &&
    record.revocationEpoch === fence.edgeEpoch && record.unit?.closedFenceId === fence.fenceId;
}
/** Resources remain as cleanup receipts. A recorded epoch and no obligation prove completion. */
export function canReuseRevokedPairId(record: IntercomPairRecord | null, candidate: IntercomEnrollmentPlan): boolean {
  return record?.state === "revoked" && record.revocationEpoch !== undefined && record.cleanupReason === null &&
    (record.pair.source.machineId !== candidate.source.machineId || record.pair.target.machineId !== candidate.target.machineId);
}
const reasons = new Set(["intercom-revocation-unconfirmed", "intercom-revocation-peer-unreachable", "intercom-revocation-identity-mismatch", "intercom-revocation-shared-jobs",
  "intercom-revocation-access-open", "intercom-revocation-verification-pending", "intercom-revocation-remote-fence-pending", "intercom-revocation-cleanup-pending"]);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const owned = (value: { uid: number }): boolean => process.platform === "win32" || typeof process.getuid !== "function" || value.uid === process.getuid();
function peer(value: unknown): value is Peer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Peer;
  return isMachineId(p.machineId) && typeof p.alias === "string" && !!p.alias && p.alias.trim() === p.alias && p.alias.length <= 255 && !/[\u0000-\u001f\u007f]/.test(p.alias) &&
    [p.node, p.pi, p.cli, p.core, p.globalRoot, ...(p.agentDir === undefined ? [] : [p.agentDir])].every(path => typeof path === "string" && posix.isAbsolute(path) && posix.normalize(path) === path &&
      path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(path));
}
function plan(value: unknown): value is IntercomEnrollmentPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as IntercomEnrollmentPlan;
  return id(p.pairId) && id(p.edgeEpoch) && peer(p.source) && peer(p.target) && p.source.machineId < p.target.machineId &&
    !!p.connector && id(p.connector.tunnelId) && id(p.connector.session) && Number.isSafeInteger(p.connector.remotePort) &&
    p.connector.remotePort >= 1 && p.connector.remotePort <= 65535;
}
function bound(value: IntercomEnrollmentPlan | IntercomEnrollmentPair): value is IntercomEnrollmentPair {
  const pair = value as IntercomEnrollmentPair;
  return typeof pair.sshUser === "string" && /^[A-Za-z_][A-Za-z0-9._-]{0,62}\$?$/.test(pair.sshUser) &&
    validHostKey(pair.hostKey) && typeof pair.hostKeyAlias === "string" && /^spider-[0-9a-f]{32}$/.test(pair.hostKeyAlias);
}
function normalizePlan(value: IntercomEnrollmentPlan): IntercomEnrollmentPlan {
  if (!plan(value)) throw new Error("invalid-intercom-pair");
  const copy = (p: Peer): Peer => ({ machineId: p.machineId, alias: p.alias, node: p.node, pi: p.pi, cli: p.cli, core: p.core, globalRoot: p.globalRoot, ...(p.agentDir === undefined ? {} : { agentDir: p.agentDir }) });
  return { pairId: value.pairId, source: copy(value.source), target: copy(value.target), edgeEpoch: value.edgeEpoch,
    connector: { tunnelId: value.connector.tunnelId, remotePort: value.connector.remotePort, session: value.connector.session } };
}
function samePlan(a: IntercomEnrollmentPlan, b: IntercomEnrollmentPlan): boolean { return JSON.stringify(normalizePlan(a)) === JSON.stringify(normalizePlan(b)); }
function normalizePair(value: IntercomEnrollmentPair): IntercomEnrollmentPair {
  if (!plan(value) || !bound(value)) throw new Error("invalid-intercom-pair");
  return { ...normalizePlan(value), sshUser: value.sshUser, hostKey: { type: value.hostKey.type, base64: value.hostKey.base64 }, hostKeyAlias: value.hostKeyAlias };
}
function resources(value: IntercomPairResources, pair: IntercomEnrollmentPlan): IntercomPairResources {
  const route = value?.route;
  if (!value || value.hostUnit !== `spider-pair-${pair.pairId}-host.service` || value.connectUnit !== `spider-pair-${pair.pairId}-connect.service` ||
      !route || route.name !== `spider-pair-${pair.pairId}` || typeof route.targetCoreId !== "string" || !route.targetCoreId || route.targetCoreId.length > 4096 || /[\u0000-\u001f\u007f]/.test(route.targetCoreId) ||
      route.via !== posix.join(pair.source.globalRoot, "roam", "intercom", "pairs", pair.pairId, pair.edgeEpoch, "via") || route.session !== pair.connector.session || route.temporary !== false ||
      value.publicKey !== undefined && !validPublicKey(value.publicKey)) throw new Error("invalid-intercom-resources");
  return { hostUnit: value.hostUnit, connectUnit: value.connectUnit, route: { ...route }, ...(value.publicKey === undefined ? {} : { publicKey: value.publicKey }) };
}
function unit(value: IntercomUnitRecord, pair: IntercomEnrollmentPlan): IntercomUnitRecord {
  if (!value || ![`spider-pair-${pair.pairId}-host.service`, `spider-pair-${pair.pairId}-connect.service`].includes(value.name) ||
      typeof value.file !== "string" || !isAbsolute(value.file) || resolve(value.file) !== value.file || !Number.isSafeInteger(value.localPort) || value.localPort < 1 || value.localPort > 65535 || typeof value.contents !== "string" || value.contents.length > 64 * 1024 ||
      !(value.closedFenceId === null || isMachineId(value.closedFenceId)) || !(value.main === null || Number.isSafeInteger(value.main?.pid) && value.main.pid > 0 &&
        typeof value.main.startIdentity === "string" && !!value.main.startIdentity && value.main.startIdentity.length < 1024 && typeof value.main.controlGroup === "string" &&
        posix.isAbsolute(value.main.controlGroup) && posix.normalize(value.main.controlGroup) === value.main.controlGroup && value.main.controlGroup !== "/")) throw new Error("invalid-intercom-unit");
  return structuredClone(value);
}
function validate(value: unknown, pairId: string): IntercomPairRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-intercom-registry");
  const item = value as IntercomPairRecord;
  if (item.version !== 1 || !plan(item.pair) || item.pair.pairId !== pairId || !["pending", "active", "revoking", "revoked", "cancelled"].includes(item.state) ||
      !id(item.operationId) || !hash(item.graphDigest) || !(item.fenceId === null || isMachineId(item.fenceId)) ||
      !(item.cleanupReason === null || reasons.has(item.cleanupReason)) || item.revocationEpoch !== undefined && !id(item.revocationEpoch) ||
      item.revocationGates !== undefined && (item.cleanupReason !== "intercom-revocation-unconfirmed" || !validRevocationGates(item.revocationGates)) ||
      item.predecessorPairId !== undefined && (!id(item.predecessorPairId) || item.predecessorPairId === pairId) ||
      item.commandApprovalFenceId !== undefined && (!(item.commandApprovalFenceId === null || isMachineId(item.commandApprovalFenceId)) || !bound(item.pair)) ||
      !["pending", "cancelled"].includes(item.state) && !bound(item.pair) ||
      item.state === "cancelled" && (bound(item.pair) || item.resources || item.unit || item.cleanupReason || item.revocationEpoch) ||
      (item.state === "revoking" || item.state === "revoked") && item.fenceId === null) throw new Error("invalid-intercom-registry");
  return { version: 1, pair: bound(item.pair) ? normalizePair(item.pair) : normalizePlan(item.pair), state: item.state,
    operationId: item.operationId, graphDigest: item.graphDigest, fenceId: item.fenceId, cleanupReason: item.cleanupReason,
    ...(item.revocationEpoch === undefined ? {} : { revocationEpoch: item.revocationEpoch }),
    ...(item.revocationGates === undefined ? {} : { revocationGates: item.revocationGates.map(({ side, gate, causeCode }) => ({ side, gate, ...(causeCode === undefined ? {} : { causeCode }) })) }),
    ...(item.commandApprovalFenceId === undefined ? {} : { commandApprovalFenceId: item.commandApprovalFenceId }),
    ...(item.predecessorPairId === undefined ? {} : { predecessorPairId: item.predecessorPairId }),
    ...(item.resources === undefined ? {} : { resources: resources(item.resources, item.pair) }), ...(item.unit === undefined ? {} : { unit: unit(item.unit, item.pair) }) };
}
function checkPrivateFile(file: string): boolean {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || !owned(info) || info.nlink !== 1 || process.platform !== "win32" && (info.mode & 0o7777) !== 0o600) {
      throw new Error("unsafe-intercom-registry");
    }
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

interface LiveFenceReader {
  machineId: string;
  read(peer: string): Promise<{ machineId: string; peer: string; fence: { edgeEpoch: string; fenceId: string } | null }>;
}

/** Diagnostic reads create nothing. Endpoint mutations use the live queue owner's fence under the peer lock. */
export function createIntercomRegistry(root: string, live?: LiveFenceReader) {
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error("unsafe-intercom-registry");
  assertTestConfigPath(root);
  const base = join(root, "roam", "intercom"), directory = join(base, "enrollments");
  const file = (pairId: string): string => { if (!id(pairId)) throw new Error("invalid-intercom-pair"); return join(directory, `${pairId}.json`); };
  const get = async (pairId: string): Promise<IntercomPairRecord | null> => {
    const path = file(pairId); if (!checkPrivateFile(path)) return null;
    const value = await readPrivateJson(path); return value === null ? null : validate(value, pairId);
  };
  const list = async (): Promise<IntercomPairRecord[]> => {
    const records: IntercomPairRecord[] = [];
    for (const path of await jsonFiles(directory)) {
      const name = path.slice(directory.length + 1, -5);
      if (!id(name)) throw new Error("invalid-intercom-registry");
      const item = await get(name); if (item) records.push(item);
    }
    return records;
  };
  const pending = async (existing: IntercomPairRecord | null, candidate?: IntercomEnrollmentPlan, peer?: string): Promise<{ pending: boolean; predecessor?: IntercomPairRecord }> => {
    if (existing?.state === "revoking" || existing?.cleanupReason) return { pending: true };
    const scope = existing?.pair ?? candidate; if (!scope && !peer) return { pending: false };
    if (peer !== undefined && !isMachineId(peer)) throw new Error("invalid-intercom-peer");
    const records = await list();
    const obligation = (first: string, second: string): boolean => records.some(record =>
      (record.pair.source.machineId === first && record.pair.target.machineId === second ||
       record.pair.source.machineId === second && record.pair.target.machineId === first) &&
      (record.state === "revoking" || record.cleanupReason !== null));
    if (scope && obligation(scope.source.machineId, scope.target.machineId)) return { pending: true };
    const queue = join(base, "queue.db");
    if (live && !checkPrivateFile(queue)) return { pending: false };
    const snapshot = live ? undefined : openDiagnosticSnapshot(queue); if (!live && !snapshot) return { pending: false };
    try {
      let machineId = live?.machineId;
      if (snapshot) {
        const meta = snapshot.prepare("SELECT machine_id,version FROM intercom_meta WHERE id=1").get() as { machine_id: string; version: number } | undefined;
        if (!meta || !isMachineId(meta.machine_id) || meta.version !== 3 && meta.version !== 4 && meta.version !== 5 && meta.version !== 6 && meta.version !== 7 && meta.version !== 8 && meta.version !== 9) throw new Error("intercom-fence-unavailable");
        machineId = meta.machine_id;
      }
      if (!isMachineId(machineId)) throw new Error("intercom-fence-unavailable");
      const scopedPeer = scope ? machineId === scope.source.machineId ? scope.target.machineId : machineId === scope.target.machineId ? scope.source.machineId : null : undefined;
      const other = peer ?? scopedPeer;
      if (!other) return { pending: false };
      if (obligation(machineId, other)) return { pending: true };
      let fence: { edge_epoch: string; fence_id: string } | undefined;
      if (live) {
        const observed = await live.read(other);
        if (observed.machineId !== live.machineId || observed.peer !== other || !(observed.fence === null ||
            id(observed.fence?.edgeEpoch) && isMachineId(observed.fence?.fenceId))) throw new Error("intercom-fence-unavailable");
        if (observed.fence) fence = { edge_epoch: observed.fence.edgeEpoch, fence_id: observed.fence.fenceId };
      } else fence = snapshot!.prepare("SELECT edge_epoch,fence_id FROM intercom_pair_fences WHERE peer=?").get(other) as typeof fence;
      if (fence && (!id(fence.edge_epoch) || !isMachineId(fence.fence_id))) throw new Error("intercom-fence-unavailable");
      if (!fence) return { pending: false };
      // A fresh pair carries a reference, never its predecessor's completion proof.
      const predecessorPairId = existing?.state === "pending" || existing?.state === "cancelled" ? existing.predecessorPairId : undefined;
      const predecessors: IntercomPairRecord[] = [];
      for (const record of records) {
        if (record.pair.pairId !== existing?.pair.pairId && (predecessorPairId === undefined || record.pair.pairId === predecessorPairId) &&
            record.fenceId === fence.fence_id &&
            record.revocationEpoch === fence.edge_epoch &&
            (record.pair.source.machineId === machineId && record.pair.target.machineId === other ||
             record.pair.target.machineId === machineId && record.pair.source.machineId === other)) predecessors.push(record);
      }
      if (predecessors.length === 1 && isIntercomRevocationComplete(predecessors[0], {
        edgeEpoch: fence.edge_epoch, fenceId: fence.fence_id,
      })) return { pending: false, predecessor: predecessors[0] };
      if (predecessorPairId !== undefined) return { pending: true };
      // A predecessor receipt only accounts for the peer recorded on that pair.
      if (other !== scopedPeer) return { pending: true };
      if (existing?.state === "revoked" && existing.fenceId === fence.fence_id && (existing.revocationEpoch ?? existing.pair.edgeEpoch) === fence.edge_epoch) return { pending: false };
      // A pending fresh enrollment may retain its completed predecessor until approved admission clears it.
      if ((existing?.state === "pending" || existing?.state === "cancelled") && existing.fenceId === fence.fence_id &&
          existing.pair.edgeEpoch !== fence.edge_epoch && candidate?.edgeEpoch !== fence.edge_epoch) return { pending: false };
      return { pending: true };
    } finally { snapshot?.close(); }
  };
  const save = async (item: IntercomPairRecord): Promise<void> => {
    const path = file(item.pair.pairId); checkPrivateFile(path);
    await writePrivateJson(path, validate(item, item.pair.pairId));
    if (process.platform !== "win32") { const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
  };
  const locked = <T>(work: () => Promise<T>): Promise<T> => withProcessLock(base, "intercom-enrollment-registry", work);
  return {
    get(pairId: string): Promise<IntercomPairRecord | null> { return get(pairId); },
    async revocationPending(pair: string | IntercomEnrollmentPlan, peer?: string): Promise<boolean> {
      const candidate = typeof pair === "string" ? undefined : normalizePlan(pair);
      return (await pending(await get(typeof pair === "string" ? pair : pair.pairId), candidate, peer)).pending;
    },
    list(): Promise<IntercomPairRecord[]> { return list(); },
    async fences(pairs: readonly IntercomEnrollmentPlan[]): Promise<Record<string, string | null>> {
      const result: Record<string, string | null> = Object.create(null);
      for (const value of pairs) {
        const candidate = normalizePlan(value), record = await get(candidate.pairId);
        if (record && (record.pair.source.machineId !== candidate.source.machineId || record.pair.target.machineId !== candidate.target.machineId)) throw new Error("intercom-pair-conflict");
        result[candidate.pairId] = record?.fenceId ?? null;
      }
      return result;
    },
    async register(value: IntercomEnrollmentPlan, operationId: string, graphDigest: string): Promise<void> {
      const candidate = normalizePlan(value);
      if (!id(operationId) || !hash(graphDigest)) throw new Error("invalid-intercom-enrollment");
      await withIntercomPeerLock(root, candidate.source.machineId, candidate.target.machineId, () => locked(async () => {
        const existing = await get(candidate.pairId);
        let observation = await pending(existing, candidate);
        if (observation.pending) throw new Error("revocation-pending");
        const reuse = canReuseRevokedPairId(existing, candidate);
        if (reuse) {
          observation = await pending(null, candidate);
          if (observation.pending) throw new Error("revocation-pending");
        }
        if (observation.predecessor?.revocationEpoch === candidate.edgeEpoch) throw new Error("fresh-peer-consent-required");
        if (existing) {
          if (!reuse && (existing.pair.source.machineId !== candidate.source.machineId || existing.pair.target.machineId !== candidate.target.machineId)) throw new Error("intercom-pair-conflict");
          if (existing.state === "revoked" || existing.state === "cancelled") {
            if (existing.operationId === operationId || existing.state === "revoked" && existing.pair.edgeEpoch === candidate.edgeEpoch) throw new Error("fresh-peer-consent-required");
          } else {
            if (existing.operationId === operationId && existing.graphDigest === graphDigest && samePlan(existing.pair, candidate)) return;
            throw new Error("intercom-pair-conflict");
          }
        }
        await save({ version: 1, pair: candidate, state: "pending", operationId, graphDigest,
          fenceId: observation.predecessor?.fenceId ?? (reuse ? null : existing?.fenceId ?? null), cleanupReason: existing?.cleanupReason ?? null,
          ...(observation.predecessor === undefined ? {} : { predecessorPairId: observation.predecessor.pair.pairId }) });
      }));
    },
    async cancelPending(pairId: string, operationId: string, graphDigest: string): Promise<void> {
      const observed = await get(pairId);
      if (!observed) throw new Error("intercom-pair-not-found");
      await withIntercomPeerLock(root, observed.pair.source.machineId, observed.pair.target.machineId, () => locked(async () => {
        const existing = await get(pairId);
        if (!existing || existing.operationId !== operationId || existing.graphDigest !== graphDigest) throw new Error("intercom-pair-conflict");
        if (existing.state === "cancelled") return;
        if (existing.state !== "pending" || bound(existing.pair)) throw new Error("intercom-enrollment-bound");
        if (existing.cleanupReason) throw new Error("intercom-predecessor-cleanup-pending");
        if (existing.resources || existing.unit || existing.revocationEpoch) throw new Error("intercom-pending-resources-present");
        // Binding precedes setup effects. Keep the receipt and any predecessor fence
        // so a retry is a no-op and fresh approved enrollment can reconcile the fence.
        await save({ ...existing, state: "cancelled" });
      }));
    },
    async bind(value: IntercomEnrollmentPair, operationId: string): Promise<void> {
      const candidate = normalizePair(value);
      await locked(async () => {
        const existing = await get(candidate.pairId);
        if (!existing || existing.operationId !== operationId || !["pending", "active"].includes(existing.state) || !samePlan(existing.pair, candidate)) throw new Error("intercom-pair-conflict");
        if (bound(existing.pair)) {
          if (JSON.stringify(normalizePair(existing.pair)) !== JSON.stringify(candidate)) throw new Error("host-key-changed");
          return;
        }
        await save({ ...existing, pair: candidate });
      });
    },
    async bindResources(pairId: string, operationId: string, value: IntercomPairResources): Promise<void> {
      await locked(async () => {
        const existing = await get(pairId);
        if (!existing || existing.operationId !== operationId || !["pending", "active"].includes(existing.state)) throw new Error("intercom-pair-conflict");
        const candidate = resources(value, existing.pair);
        if (existing.resources) {
          if (JSON.stringify({ ...existing.resources, publicKey: undefined }) !== JSON.stringify({ ...candidate, publicKey: undefined })) throw new Error("intercom-resource-mismatch");
          return;
        }
        await save({ ...existing, resources: candidate });
      });
    },
    async recordPublicKey(pairId: string, publicKey: string): Promise<void> {
      if (!validPublicKey(publicKey)) throw new Error("unsafe-pair-key");
      await locked(async () => {
        const existing = await get(pairId); if (!existing?.resources) return;
        if (existing.resources.publicKey && existing.resources.publicKey !== publicKey) throw new Error("unsafe-pair-key");
        await save({ ...existing, resources: { ...existing.resources, publicKey } });
      });
    },
    async recordUnit(pairId: string, value: IntercomUnitRecord): Promise<void> {
      await locked(async () => {
        const existing = await get(pairId); if (!existing?.resources) throw new Error("connector-not-pair-scoped");
        const candidate = unit(value, existing.pair), previous = existing.unit;
        if (candidate.name.endsWith("-connect.service") && candidate.closedFenceId === null) {
          for (const path of await jsonFiles(directory)) {
            const other = await get(path.slice(directory.length + 1, -5));
            if (other && other.pair.pairId !== pairId && other.pair.source.machineId === existing.pair.source.machineId && other.unit?.name.endsWith("-connect.service") &&
                other.unit.localPort === candidate.localPort && other.unit.closedFenceId === null) throw new Error("intercom-peer-port-in-use");
          }
        }
        if (previous && (previous.name !== candidate.name || previous.file !== candidate.file || previous.contents !== candidate.contents || previous.localPort !== candidate.localPort)) throw new Error("intercom-unit-mismatch");
        await save({ ...existing, unit: candidate });
      });
    },
    /** Admit the freshly approved key without clearing the bridge's federation fence. */
    async approveCommands(pairId: string, approval: IntercomPairApproval): Promise<void> {
      if (!(approval.expectedFenceId === null || isMachineId(approval.expectedFenceId))) throw new Error("invalid-intercom-fence");
      await locked(async () => {
        const existing = await get(pairId);
        if (!existing || !["pending", "active"].includes(existing.state) || !bound(existing.pair) ||
            existing.operationId !== approval.operationId || existing.graphDigest !== approval.graphDigest || existing.pair.edgeEpoch !== approval.edgeEpoch ||
            existing.fenceId !== approval.expectedFenceId && !(existing.fenceId === null && existing.commandApprovalFenceId === approval.expectedFenceId)) {
          throw new Error("fresh-peer-consent-required");
        }
        if (existing.commandApprovalFenceId === approval.expectedFenceId) return;
        await save({ ...existing, commandApprovalFenceId: approval.expectedFenceId });
      });
    },
    async activate(pairId: string, operationId: string): Promise<void> {
      await locked(async () => {
        const existing = await get(pairId);
        if (!existing || existing.operationId !== operationId || !bound(existing.pair)) throw new Error("intercom-pair-conflict");
        if (existing.state === "active") return;
        if (existing.state !== "pending") throw new Error("intercom-pair-conflict");
        await save({ ...existing, state: "active", fenceId: null, cleanupReason: null });
      });
    },
    async beginRevocation(pairId: string, fenceId: string, revocationEpoch?: string): Promise<void> {
      if (revocationEpoch !== undefined && !id(revocationEpoch)) throw new Error("invalid-intercom-fence");
      if (!isMachineId(fenceId)) throw new Error("invalid-intercom-fence");
      await locked(async () => {
        const existing = await get(pairId);
        if (!existing || !bound(existing.pair)) throw new Error("intercom-pair-not-found");
        if (existing.fenceId && existing.fenceId !== fenceId) throw new Error("intercom-fence-mismatch");
        const epoch = revocationEpoch ?? existing.revocationEpoch ?? existing.pair.edgeEpoch;
        if (existing.state === "revoked" && existing.cleanupReason === null && existing.revocationEpoch !== undefined && existing.revocationEpoch !== epoch) throw new Error("intercom-fence-mismatch");
        if ((existing.state === "revoking" || existing.state === "revoked" && existing.cleanupReason === null) && existing.revocationEpoch === epoch) return;
        await save({ ...existing, state: "revoking", fenceId, revocationEpoch: epoch });
      });
    },
    async finishRevocation(pairId: string, cleanupReason: IntercomRevocationCleanupReason | null, revocationGates?: readonly RevocationGate[]): Promise<void> {
      if (cleanupReason !== null && !reasons.has(cleanupReason)) throw new Error("invalid-intercom-cleanup-reason");
      if (revocationGates !== undefined && (cleanupReason !== "intercom-revocation-unconfirmed" || !validRevocationGates(revocationGates))) throw new Error("invalid-intercom-cleanup-gates");
      await locked(async () => {
        const existing = await get(pairId);
        if (!existing || existing.state !== "revoking" && existing.state !== "revoked" || !existing.fenceId) throw new Error("intercom-pair-conflict");
        const gates = cleanupReason === "intercom-revocation-unconfirmed" && existing.cleanupReason === cleanupReason
          ? revocationGates ?? existing.revocationGates : revocationGates;
        if (existing.state === "revoked" && existing.cleanupReason === cleanupReason && JSON.stringify(existing.revocationGates) === JSON.stringify(gates)) return;
        const { revocationGates: _oldGates, ...rest } = existing;
        await save({ ...rest, state: "revoked", cleanupReason, ...(gates === undefined ? {} : { revocationGates: gates }) });
      });
    },
  };
}
