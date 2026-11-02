// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { processStartTime } from '../../../subagents/src/process-identity.js';
import { unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HerdrError } from '../client/parse.js';
import { canonicalSessionFile, hash, readPrivateJson, writePrivateJson, withProcessLock } from './registry.js';
import type { SessionId } from '../contracts.js';
import { createProcessPresence, type ProcessPresenceStore, type PresenceRecord } from './presence.js';
export interface ProcessIdentity { pid: number; startIdentity: string }
export type ProcessProbe = { kind: 'absent' } | { kind: 'unknown' } | { kind: 'live'; startIdentity: string };
export interface PiProcess { pid: number; startIdentity: string | null; classification: 'pi' | 'uncertain' }
export interface ProcessInventoryPorts { presence: ProcessPresenceStore; leases: SessionLeases; processes(): Promise<readonly PiProcess[]>; probe(pid: number): Promise<ProcessProbe> }
export type SessionLiveness = { kind: 'free' } | { kind: 'live' | 'uncertain'; pids: number[] };
export interface SessionLease extends ProcessIdentity { version: 1; file: string; token: string }
export type SessionLeasePolicy = { mode: 'cutover' } | { mode: 'bookkeeping' } | { mode: 'switch'; sessionId?: SessionId };
export interface SessionLeases {
  get(file: string): Promise<SessionLease | null>;
  claim(file: string, process: ProcessIdentity, inventory: ProcessInventoryPorts, policy?: SessionLeasePolicy): Promise<SessionLease>;
  transfer(file: string, token: string, process: ProcessIdentity): Promise<void>;
  release(file: string, token: string, policy?: SessionLeasePolicy): Promise<void>;
  adopt(file: string, token: string, process: ProcessIdentity): Promise<SessionLease>;
}
function validate(value: unknown): SessionLease {
  const r = value as SessionLease;
  if (!r || r.version !== 1 || typeof r.file !== 'string' || !isAbsolute(r.file) || !Number.isInteger(r.pid) || r.pid <= 0 || typeof r.startIdentity !== 'string' || !r.startIdentity || typeof r.token !== 'string' || !/^[a-f0-9]{64}$/.test(r.token)) throw new HerdrError('invalid-session-lease', 'Session lease has an invalid shape');
  return r;
}
async function presenceSnapshot(ports: ProcessInventoryPorts): Promise<{ records: PresenceRecord[]; uncertain: PresenceRecord[] }> {
  const records: PresenceRecord[] = [], uncertain: PresenceRecord[] = [];
  for (const record of await ports.presence.list()) {
    const current = await ports.probe(record.pid);
    if (current.kind === 'absent' || current.kind === 'live' && current.startIdentity !== record.startIdentity) {
      await ports.presence.remove(record);
    } else if (current.kind === 'unknown') uncertain.push(record);
    else records.push(record);
  }
  return { records, uncertain };
}
export async function inventorySnapshot(ports: ProcessInventoryPorts): Promise<{ records: PresenceRecord[]; unknownPids: number[]; uncertainPids: number[] }> {
  const { records, uncertain } = await presenceSnapshot(ports);
  const uncertainPids = uncertain.map(record => record.pid);
  const unknownPids = [];
  for (const p of await ports.processes()) {
    if (p.classification === 'uncertain' || !records.some(r => r.pid === p.pid && r.startIdentity === p.startIdentity)) unknownPids.push(p.pid);
  }
  return { records, unknownPids: [...new Set(unknownPids)], uncertainPids: [...new Set(uncertainPids)] };
}
export async function assessSessionLiveness(file: string, ports: ProcessInventoryPorts): Promise<SessionLiveness> {
  const canonical = await canonicalSessionFile(file); const snapshot = await inventorySnapshot(ports);
  const uncertain = [...snapshot.unknownPids, ...snapshot.uncertainPids]; const live: number[] = [];
  for (const r of snapshot.records) if (r.sessionFile !== null && await canonicalSessionFile(r.sessionFile) === canonical) live.push(r.pid);
  const lease = await ports.leases.get(canonical);
  if (lease) { const p = await ports.probe(lease.pid); if (p.kind === 'unknown' || p.kind === 'live' && p.startIdentity !== lease.startIdentity) uncertain.push(lease.pid); else if (p.kind === 'live') live.push(lease.pid); }
  if (uncertain.length) return { kind: 'uncertain', pids: [...new Set(uncertain)] };
  return live.length ? { kind: 'live', pids: [...new Set(live)] } : { kind: 'free' };
}
/** Everyday switching trusts only recorded, identity-matched live holders; cutover uses the stricter inventory. */
export async function recordedSessionLiveness(file: string, ports: ProcessInventoryPorts, sessionId?: SessionId): Promise<SessionLiveness> {
  const canonical = await canonicalSessionFile(file), { records, uncertain } = await presenceSnapshot(ports);
  const matches = async (record: PresenceRecord) => Boolean(sessionId && record.sessionId === sessionId || record.sessionFile && await canonicalSessionFile(record.sessionFile) === canonical);
  const holders: number[] = [], uncertainPids: number[] = [];
  for (const record of records) if (await matches(record)) holders.push(record.pid);
  for (const record of uncertain) if (await matches(record)) uncertainPids.push(record.pid);
  const lease = await ports.leases.get(canonical);
  if (lease) {
    const process = await ports.probe(lease.pid);
    if (process.kind === 'unknown') uncertainPids.push(lease.pid);
    else if (process.kind === 'live' && process.startIdentity === lease.startIdentity) holders.push(lease.pid);
  }
  if (uncertainPids.length) return { kind: 'uncertain', pids: [...new Set(uncertainPids)] };
  return holders.length ? { kind: 'live', pids: [...new Set(holders)] } : { kind: 'free' };
}
export function createSessionLeases(root: string): SessionLeases {
  const directory = join(root, 'leases'); const path = (file: string) => join(directory, `${hash(file)}.json`);
  async function locked<T>(file: string, operation: (canonical: string) => Promise<T>, policy?: SessionLeasePolicy, inventory?: ProcessInventoryPorts): Promise<T> {
    const canonical = await canonicalSessionFile(file);
    try { return await withProcessLock(root, `lease:${canonical}`, () => operation(canonical), policy?.mode === 'switch' || policy?.mode === 'bookkeeping' ? {
      ...(policy.mode === 'bookkeeping' ? { timeoutMs: 0 } : {}),
      probe: async pid => {
        const startIdentity = processStartTime(pid);
        if (pid === process.pid) return startIdentity ? { kind: 'live', startIdentity } : { kind: 'unknown' };
        const records = await (inventory?.presence ?? createProcessPresence(root)).list();
        return startIdentity && records.some(record => record.pid === pid && record.startIdentity === startIdentity) ? { kind: 'live', startIdentity } : { kind: 'absent' };
      },
    } : {}); }
    catch (error) { if (error instanceof HerdrError && (error.code === 'lock-occupied' || error.code === 'lock-owner-uncertain')) throw new HerdrError('session-may-be-live', error.message); throw error; }
  }
  const leases: SessionLeases = {
    async get(file) { const canonical = await canonicalSessionFile(file); const r = await readPrivateJson(path(canonical)); if (r === null) return null; const lease = validate(r); if (lease.file !== canonical) throw new HerdrError('invalid-session-lease', 'Lease path mismatch'); return lease; },
    async claim(file, process, inventory, policy = { mode: 'cutover' }) {
      const write = async (canonical: string) => {
        if (policy.mode !== 'bookkeeping') {
          const live = policy.mode === 'switch' ? await recordedSessionLiveness(canonical, inventory, policy.sessionId) : await assessSessionLiveness(canonical, inventory);
          if (live.kind !== 'free') throw new HerdrError('session-may-be-live', `Session is held by PID ${live.pids.join(', ')}. Close that session before switching or resuming it.`);
        }
        const lease = validate({ version: 1, file: canonical, ...process, token: randomBytes(32).toString('hex') }); await writePrivateJson(path(canonical), lease); return lease;
      };
      // Inactive integration observes ownership but never competes for exclusive launch permission.
      return policy.mode === 'bookkeeping' ? write(await canonicalSessionFile(file)) : locked(file, write, policy, inventory);
    },
    async transfer(file, token, process) { await locked(file, async canonical => { const lease = await leases.get(canonical); if (!lease || lease.token !== token) throw new HerdrError('lease-token-invalid', 'Lease transfer is unauthorized'); await writePrivateJson(path(canonical), validate({ ...lease, ...process })); }); },
    async adopt(file, token, process) { return locked(file, async canonical => { const lease = await leases.get(canonical); if (!lease || lease.token !== token) throw new HerdrError('lease-token-invalid', 'Lease adoption requires the launcher capability');
      const adopted = validate({ ...lease, ...process }); await writePrivateJson(path(canonical), adopted); return adopted; }); },
    async release(file, token, policy) { await locked(file, async canonical => { const lease = await leases.get(canonical); if (lease?.token === token) await unlink(path(canonical)); }, policy); },
  }; return leases;
}
