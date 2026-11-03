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
  excludeFiles?: ReadonlySet<string>;
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
  const include = (manifest: SessionManifest): SessionManifest => ({ ...manifest, sessions: manifest.sessions.filter(session => !session.file || !ports.excludeFiles?.has(session.file)) });
  const deadline = ports.clock() + 30 * 60 * 1000; let manifest = include(initial); const reused = new Map<string, LaunchedSession>();
  let liveReport: string | undefined; let blockedReport = new Set<string>();
  for (;;) {
    if (ports.signal?.aborted) throw new HerdrError('aborted', 'Cutover aborted before allocation');
    reused.clear();
    const inventory = await inventorySnapshot(ports.processInventory);
    const messages = new Set<string>();
    let blocked = false;
    for (const target of manifest.sessions) {
      refuseExplicitExtensions(target.name ?? target.sessionId ?? target.file ?? 'unresolved session', target.extensionArguments);
      if (target.file === null || ports.excludeFiles?.has(target.file)) continue;
      const existing = await ports.alreadyLaunched?.(target);
      if (ports.excludeFiles?.has(target.file)) continue;
      if (existing) { reused.set(target.file, existing); continue; }
      const liveness = await assessSessionLiveness(target.file, ports.processInventory);
      if (liveness.kind !== 'free') { blocked = true; messages.add(`Close selected session ${target.name ?? target.sessionId ?? target.file}; PIDs: ${liveness.pids.join(', ')}`); }
    }
    manifest = include(manifest);
    const unknownMessages = new Set<string>();
    if (manifest.sessions.some(target => !target.file || !reused.has(target.file))) {
      if (inventory.unknownPids.length || inventory.uncertainPids.length) blocked = true;
      for (const pid of inventory.unknownPids) unknownMessages.add(`Unrecorded pi PID ${pid}: /reload in that session, or closing it, clears this block.`);
      for (const pid of inventory.uncertainPids) unknownMessages.add(`Selected owner PID ${pid} has an uncertain process identity; close it or restore its presence record.`);
    }
    const blockingRecords = inventory.records.filter(record => manifest.sessions.some(target => (target.sessionId && target.sessionId === record.sessionId || target.file && target.file === record.sessionFile) && (!target.file || !reused.has(target.file))));
    const currentLive = JSON.stringify(blockingRecords.map(record => [record.pid, record.sessionName ?? record.sessionId ?? '(unnamed)']).sort((a, b) => Number(a[0]) - Number(b[0])));
    if (currentLive !== liveReport) { ports.reportLive(blockingRecords); liveReport = currentLive; }
    const allMessages = new Set([...unknownMessages, ...messages]);
    for (const message of allMessages) if (!blockedReport.has(message)) ports.reportBlocked(message);
    blockedReport = allMessages;
    if (!blocked) {
      manifest = include(await discoverSessions(initial.config, discoveryPorts));
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
