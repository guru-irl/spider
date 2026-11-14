import { constants, lstatSync, openSync, closeSync, fsyncSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { jsonFiles, readPrivateJson, withProcessLock, writePrivateJson } from "@spider/herdr/sessions/registry";
import type { Peer } from "./contracts";
import type { IntercomEnrollmentPair, IntercomEnrollmentPlan, IntercomRevocationCleanupReason } from "./provision-contracts";
import { validHostKey } from "./intercom-enrollment";
import { isMachineId } from "./machine-id";

export interface IntercomPairRecord {
  version: 1; pair: IntercomEnrollmentPlan | IntercomEnrollmentPair; state: "pending" | "active" | "revoking" | "revoked";
  operationId: string; graphDigest: string; fenceId: string | null; cleanupReason: IntercomRevocationCleanupReason | null;
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
    [p.node, p.pi, p.cli, p.core, p.globalRoot].every(path => typeof path === "string" && posix.isAbsolute(path) && posix.normalize(path) === path &&
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
  const copy = (p: Peer): Peer => ({ machineId: p.machineId, alias: p.alias, node: p.node, pi: p.pi, cli: p.cli, core: p.core, globalRoot: p.globalRoot });
  return { pairId: value.pairId, source: copy(value.source), target: copy(value.target), edgeEpoch: value.edgeEpoch,
    connector: { tunnelId: value.connector.tunnelId, remotePort: value.connector.remotePort, session: value.connector.session } };
}
function samePlan(a: IntercomEnrollmentPlan, b: IntercomEnrollmentPlan): boolean { return JSON.stringify(normalizePlan(a)) === JSON.stringify(normalizePlan(b)); }
function normalizePair(value: IntercomEnrollmentPair): IntercomEnrollmentPair {
  if (!plan(value) || !bound(value)) throw new Error("invalid-intercom-pair");
  return { ...normalizePlan(value), sshUser: value.sshUser, hostKey: { type: value.hostKey.type, base64: value.hostKey.base64 }, hostKeyAlias: value.hostKeyAlias };
}
function validate(value: unknown, pairId: string): IntercomPairRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-intercom-registry");
  const item = value as IntercomPairRecord;
  if (item.version !== 1 || !plan(item.pair) || item.pair.pairId !== pairId || !["pending", "active", "revoking", "revoked"].includes(item.state) ||
      !id(item.operationId) || !hash(item.graphDigest) || !(item.fenceId === null || isMachineId(item.fenceId)) ||
      !(item.cleanupReason === null || reasons.has(item.cleanupReason)) || item.state !== "pending" && !bound(item.pair) ||
      (item.state === "revoking" || item.state === "revoked") && item.fenceId === null) throw new Error("invalid-intercom-registry");
  return { version: 1, pair: bound(item.pair) ? normalizePair(item.pair) : normalizePlan(item.pair), state: item.state,
    operationId: item.operationId, graphDigest: item.graphDigest, fenceId: item.fenceId, cleanupReason: item.cleanupReason };
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

/** Read methods create nothing. Mutations serialize within this machine's private state root. */
export function createIntercomRegistry(root: string) {
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error("unsafe-intercom-registry");
  assertTestConfigPath(root);
  const base = join(root, "roam", "intercom"), directory = join(base, "enrollments");
  const file = (pairId: string): string => { if (!id(pairId)) throw new Error("invalid-intercom-pair"); return join(directory, `${pairId}.json`); };
  const get = async (pairId: string): Promise<IntercomPairRecord | null> => {
    const path = file(pairId); if (!checkPrivateFile(path)) return null;
    const value = await readPrivateJson(path); return value === null ? null : validate(value, pairId);
  };
  const save = async (item: IntercomPairRecord): Promise<void> => {
    const path = file(item.pair.pairId); checkPrivateFile(path);
    await writePrivateJson(path, validate(item, item.pair.pairId));
    if (process.platform !== "win32") { const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
  };
  const locked = <T>(work: () => Promise<T>): Promise<T> => withProcessLock(base, "intercom-enrollment-registry", work);
  return {
    get(pairId: string): Promise<IntercomPairRecord | null> { return get(pairId); },
    async list(): Promise<IntercomPairRecord[]> {
      const files = await jsonFiles(directory), records: IntercomPairRecord[] = [];
      for (const path of files) {
        const name = path.slice(directory.length + 1, -5);
        if (!id(name)) throw new Error("invalid-intercom-registry");
        const item = await get(name); if (item) records.push(item);
      }
      return records;
    },
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
      await locked(async () => {
        const existing = await get(candidate.pairId);
        if (existing) {
          if (existing.pair.source.machineId !== candidate.source.machineId || existing.pair.target.machineId !== candidate.target.machineId) throw new Error("intercom-pair-conflict");
          if (existing.state === "revoked") {
            if (existing.operationId === operationId || existing.pair.edgeEpoch === candidate.edgeEpoch) throw new Error("fresh-peer-consent-required");
          } else {
            if (existing.operationId === operationId && existing.graphDigest === graphDigest && samePlan(existing.pair, candidate)) return;
            throw new Error("intercom-pair-conflict");
          }
        }
        await save({ version: 1, pair: candidate, state: "pending", operationId, graphDigest, fenceId: existing?.fenceId ?? null, cleanupReason: existing?.cleanupReason ?? null });
      });
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
    async activate(pairId: string, operationId: string): Promise<void> {
      await locked(async () => {
        const existing = await get(pairId);
        if (!existing || existing.operationId !== operationId || !bound(existing.pair)) throw new Error("intercom-pair-conflict");
        if (existing.state === "active") return;
        if (existing.state !== "pending") throw new Error("intercom-pair-conflict");
        await save({ ...existing, state: "active", fenceId: null, cleanupReason: null });
      });
    },
    async beginRevocation(pairId: string, fenceId: string): Promise<void> {
      if (!isMachineId(fenceId)) throw new Error("invalid-intercom-fence");
      await locked(async () => {
        const existing = await get(pairId);
        if (!existing || !bound(existing.pair)) throw new Error("intercom-pair-not-found");
        if (existing.fenceId && existing.fenceId !== fenceId) throw new Error("intercom-fence-mismatch");
        if (existing.state === "revoking" || existing.state === "revoked" && existing.cleanupReason === null) return;
        await save({ ...existing, state: "revoking", fenceId });
      });
    },
    async finishRevocation(pairId: string, cleanupReason: IntercomRevocationCleanupReason | null): Promise<void> {
      if (cleanupReason !== null && !reasons.has(cleanupReason)) throw new Error("invalid-intercom-cleanup-reason");
      await locked(async () => {
        const existing = await get(pairId);
        if (!existing || existing.state !== "revoking" && existing.state !== "revoked" || !existing.fenceId) throw new Error("intercom-pair-conflict");
        if (existing.state === "revoked") return;
        await save({ ...existing, state: "revoked", cleanupReason });
      });
    },
  };
}
