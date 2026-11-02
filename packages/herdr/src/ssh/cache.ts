// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CoreIdentity, HcClient, Disposable } from '../contracts.js';
import { HerdrError, object, text } from '../client/parse.js';
import { normalizeSshHost } from './parse.js';
export const CACHE_REFRESH_MS = 30000;
export const CACHE_VALID_MS = 120000;
export interface CacheDescriptor { path: string; identity: CoreIdentity }
export interface MachineCacheOptions { hc: Pick<HcClient, 'identity' | 'machines'>; identity: CoreIdentity; directory: string; aliases?: Readonly<Record<string, readonly string[]>>; clock?: () => number; reportFailure?: (error: unknown) => void }
export interface MachineRoute { id: string; name: string; targets: readonly string[] }
export interface MachineSnapshot { version: 1; identity: CoreIdentity; fetchedAt: number; machines: readonly MachineRoute[] }
export interface MachineCache extends Disposable { ready: Promise<void>; descriptor: CacheDescriptor; refresh(): Promise<void>; snapshot(): MachineSnapshot | null; now(): number }
export function sameCore(a: CoreIdentity, b: CoreIdentity): boolean { return a.coreId === b.coreId && a.socket === b.socket && a.sessionNamespace === b.sessionNamespace; }
export function validSnapshot(snapshot: MachineSnapshot, now: number): boolean { return now >= snapshot.fetchedAt && now - snapshot.fetchedAt < CACHE_VALID_MS; }
export function parseMachineSnapshot(value: unknown, identity: CoreIdentity): MachineSnapshot {
  const s = object(value), core = object(s.identity);
  if (s.version !== 1 || !sameCore(core as unknown as CoreIdentity, identity) || typeof s.fetchedAt !== 'number' || !Number.isSafeInteger(s.fetchedAt) || !Array.isArray(s.machines)) throw new HerdrError('ssh-cache-invalid', 'Machine cache does not match this core namespace');
  const machines = s.machines.map(value => {
    const m = object(value); if (!Array.isArray(m.targets) || !m.targets.length) throw new HerdrError('ssh-cache-invalid', 'Invalid machine targets');
    return { id: text(m.id), name: text(m.name), targets: m.targets.map(v => text(v)) };
  });
  return { version: 1, identity, fetchedAt: s.fetchedAt, machines };
}
export async function readMachineSnapshot(descriptor: CacheDescriptor): Promise<MachineSnapshot | null> {
  try { const bytes = await readFile(descriptor.path); if (bytes.length > 1024 * 1024) return null; return parseMachineSnapshot(JSON.parse(bytes.toString('utf8')), descriptor.identity); } catch { return null; }
}
export function createMachineCache(options: MachineCacheOptions): MachineCache {
  if (!isAbsolute(options.directory)) throw new HerdrError('ssh-cache-invalid', 'Machine cache directory must be absolute');
  const key = createHash('sha256').update(JSON.stringify([options.identity.coreId, options.identity.sessionNamespace, options.identity.socket])).digest('hex');
  const descriptor = { path: join(options.directory, `${key}.json`), identity: Object.freeze({ ...options.identity }) };
  const clock = options.clock ?? Date.now; let current: MachineSnapshot | null = null, closed = false, running: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve(); if (running) return running;
    running = (async () => {
      try {
        const identity = await options.hc.identity(); if (!sameCore(identity, options.identity)) throw new HerdrError('ssh-cache-core-changed', 'Machine cache cannot borrow another core');
        const machines = await options.hc.machines();
        const next: MachineSnapshot = { version: 1, identity: descriptor.identity, fetchedAt: clock(), machines: machines.map(m => ({ id: m.id, name: m.name,
          targets: [...new Set([m.name, ...m.aliases, ...(options.aliases?.[m.name] ?? [])].map(normalizeSshHost).filter(Boolean))] })) };
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        const temporary = descriptor.path + '.' + randomUUID();
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, descriptor.path);
        if (!closed) current = next;
      } catch (error) { options.reportFailure?.(error); }
    })().finally(() => { running = undefined; }); return running;
  };
  const ready = (async () => { current = await readMachineSnapshot(descriptor); await refresh(); })();
  const timer = setInterval(() => { void refresh(); }, CACHE_REFRESH_MS); timer.unref?.();
  return { ready, descriptor, refresh, snapshot: () => current, now: clock, async dispose() { closed = true; clearInterval(timer); await running; } };
}
