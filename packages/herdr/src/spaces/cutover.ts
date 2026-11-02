// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { PresenceRecord } from '../sessions/presence.js';
import { assessSessionLiveness, inventorySnapshot } from '../sessions/lease.js';
import type { SessionLaunchResult } from '../sessions/launcher.js';
import { refuseExplicitExtensions } from '../sessions/registry.js';
import { HerdrError } from '../client/parse.js';
import { discoverSessions, selectedProcessInventory, type SessionDiscoveryPorts, type SessionManifest, type SessionSelection, type ResolvedSession } from './discovery.js';
export type LaunchedSession = Omit<SessionLaunchResult, 'token'>;
export interface CutoverPorts extends SessionDiscoveryPorts {
  signal?: AbortSignal;
  clock(): number; waitForChange(deadline: number, signal: AbortSignal): Promise<void>;
  reportLive(records: readonly PresenceRecord[]): void; reportBlocked(message: string): void;
  notesDisabled(): Promise<boolean>;
  /** Allocate only an argv that invokes the packaged leased launcher; never open pi directly. */
  launchLeasedSession(target: ResolvedSession): Promise<LaunchedSession>;
  alreadyLaunched?(target: SessionSelection): Promise<LaunchedSession | null>;
  beforeLaunch?(manifest: SessionManifest): Promise<void>;
  launched?(target: ResolvedSession, result: LaunchedSession): Promise<void>;
}
export interface CutoverResult { manifest: SessionManifest; launched: LaunchedSession[] }
export async function startCutover(initial: SessionManifest, ports: CutoverPorts): Promise<CutoverResult> {
  const discoveryPorts = ports;
  ports = { ...ports, processInventory: selectedProcessInventory(initial.config, ports.processInventory, initial.sessions) };
  const deadline = ports.clock() + 30 * 60 * 1000; let manifest = initial; const reused = new Map<string, LaunchedSession>();
  for (;;) {
    if (ports.signal?.aborted) throw new HerdrError('aborted', 'Cutover aborted before allocation');
    reused.clear();
    const inventory = await inventorySnapshot(ports.processInventory); ports.reportLive(inventory.records);
    let blocked = inventory.unknownPids.length > 0 || inventory.uncertainPids.length > 0;
    if (blocked) {
      for (const pid of inventory.unknownPids) ports.reportBlocked(`Unrecorded pi PID ${pid}: /reload in that session, or closing it, clears this block.`);
      for (const pid of inventory.uncertainPids) ports.reportBlocked(`Selected owner PID ${pid} has an uncertain process identity; close it or restore its presence record.`);
    }
    for (const target of manifest.sessions) {
      refuseExplicitExtensions(target.name ?? target.sessionId ?? target.file ?? 'unresolved session', target.extensionArguments);
      if (target.file === null) continue;
      const existing = await ports.alreadyLaunched?.(target);
      if (existing) { reused.set(target.file, existing); continue; }
      const liveness = await assessSessionLiveness(target.file, ports.processInventory);
      if (liveness.kind !== 'free') { blocked = true; ports.reportBlocked(`Close selected session ${target.name ?? target.sessionId ?? target.file}; PIDs: ${liveness.pids.join(', ')}`); }
    }
    if (!blocked) {
      manifest = await discoverSessions(initial.config, discoveryPorts);
      // Metadata for an already-verified journalled live owner comes from its journal, not from opening its file.
      manifest.sessions = manifest.sessions.map(s => { const r = s.file && reused.get(s.file); return r ? { ...s, sessionId: r.sessionId, cwd: r.cwd } : s; });
      if (manifest.sessions.some(s => s.file === null || s.sessionId === null || s.cwd === null)) throw new HerdrError('session-selector-unresolved', 'Selected session metadata is unavailable');
      manifest.unresolved = false;
      break;
    }
    if (ports.clock() >= deadline) throw new HerdrError('cutover-deadline', 'Cutover timed out after 30 minutes without opening selected sessions');
    const controller = new AbortController(); let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new HerdrError('cutover-deadline', 'Cutover timed out after 30 minutes without opening selected sessions')), deadline - ports.clock()); timer.unref(); });
    let abort!: () => void;
    const aborted = new Promise<void>((_, reject) => { abort = () => reject(new HerdrError('aborted', 'Cutover aborted before allocation')); ports.signal?.addEventListener('abort', abort, { once: true }); if (ports.signal?.aborted) abort(); });
    try { await Promise.race([ports.waitForChange(deadline, controller.signal), timeout, aborted]); } finally { ports.signal?.removeEventListener('abort', abort); controller.abort(); clearTimeout(timer); }
  }
  for (const target of manifest.sessions) refuseExplicitExtensions(target.name ?? target.sessionId ?? target.file ?? 'unresolved session', target.extensionArguments);
  if (!await ports.notesDisabled()) throw new HerdrError('notes-enabled', 'Set notes = false before allocating fresh terminals');
  await ports.beforeLaunch?.(manifest);
  const launched: LaunchedSession[] = [];
  for (const selection of manifest.sessions) {
    if (ports.signal?.aborted) throw new HerdrError('aborted', 'Cutover aborted before allocation');
    const target = selection as ResolvedSession;
    const existing = reused.get(target.file); if (existing) { launched.push(existing); continue; }
    if ((await assessSessionLiveness(target.file, ports.processInventory)).kind !== 'free') throw new HerdrError('session-may-be-live', 'A concurrent writer appeared before tab allocation');
    const result = await ports.launchLeasedSession(target);
    await ports.launched?.(target, result); launched.push(result);
  }
  return { manifest, launched };
}
