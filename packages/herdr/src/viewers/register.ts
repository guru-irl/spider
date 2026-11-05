// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrError } from '../client/parse.js';
import { HERDR_LABELS as labels, HERDR_KINDS as kinds } from '../contracts.js';
import type { Owner, RunId, IpcDescriptor, HcClient, Disposable, TerminalHandle, TerminalAddress, TerminalSummary, PaneReservation, ViewerLauncher, RunSummary, ViewerIntent } from '../contracts.js';
import type { AuxiliaryPaneActor } from '../jobs/placement.js';
import { recoverViewer as recoverOwnedViewer, sameRun } from './identity.js';
export interface ViewerRegistrationPorts {
  owner(): Owner | null;
  ownedRunEvents: { list(owner: Owner): Promise<readonly RunId[]>; subscribe(owner: Owner, listener: (id: RunId) => void): () => void };
  ipcDescriptor(): IpcDescriptor | null;
  panes: Pick<AuxiliaryPaneActor, 'acquire' | 'release' | 'park' | 'dispose' | 'reconcile'>; hc: HcClient; viewerExecutable: string; feedRoot: string;
  viewerLauncher?: ViewerLauncher; reportError?(error: unknown): void;
}
export interface ViewerRegistration extends Disposable { peek(runId: RunId): Promise<TerminalHandle | null>; launcher: ViewerLauncher }
export interface ViewerRunInfo { name?: string; cwd?: string; parentName?: string; steer?: 'rpc' | 'headless'; status?: RunSummary['status']; dbPath?: string }
export interface ManagedViewerLauncher extends ViewerLauncher {
  discard(runId: RunId, owner: Owner, address: TerminalAddress): Promise<void>;
}
/** Shared with the pane actor so concurrent opens reuse one local viewer. */
export function createViewerLauncher(ports: Pick<ViewerRegistrationPorts, 'hc' | 'ipcDescriptor' | 'viewerExecutable' | 'owner' | 'feedRoot'> & { piPackageRoot?: string; runInfo?(id: RunId, owner: Owner): ViewerRunInfo | Promise<ViewerRunInfo> }): ManagedViewerLauncher {
  const launches = new Map<string, { promise: Promise<TerminalAddress>; claim: { retained: boolean }; discard?: Promise<void> }>();
  const keyFor = (runId: RunId, owner: Owner) => JSON.stringify([owner.sessionId, owner.terminal.coreId, owner.terminal.terminalId, runId]);
  const current = (owner: Owner, signal?: AbortSignal) => {
    const active = ports.owner(); const descriptor = ports.ipcDescriptor();
    return !signal?.aborted && active?.sessionId === owner.sessionId && active.generation === owner.generation
      && active.terminal.coreId === owner.terminal.coreId && active.terminal.terminalId === owner.terminal.terminalId
      && descriptor?.sessionId === owner.sessionId && descriptor.generation === owner.generation;
  };
  async function recoverViewer(terminal: TerminalSummary, owner: Owner, runId: RunId, signal?: AbortSignal): Promise<boolean> {
    return recoverOwnedViewer(terminal, owner, runId, ports.hc, () => {
      if (!current(owner, signal)) throw new HerdrError('wrong-generation', 'Viewer owner is no longer current');
    });
  }
  const isFinal = (status: ViewerRunInfo['status']) => status === 'done' || status === 'failed' || status === 'cancelled';
  async function closingForSavedOpen(terminal: TerminalSummary, runId: RunId, owner: Owner, signal: AbortSignal | undefined, intent: ViewerIntent): Promise<boolean> {
    if (intent !== 'explicit' || terminal.labels[labels.viewerLifetime] !== 'live') return false;
    let info: ViewerRunInfo;
    try { info = await ports.runInfo?.(runId, owner) ?? {}; } catch { return false; }
    if (!isFinal(info.status)) return false;
    // A final live-run viewer is draining its transcript and two-second hold.
    // Never kill it or return its dying pane as the user's saved view.
    const deadline = Date.now() + 10000;
    while (true) {
      if (!current(owner, signal)) throw new HerdrError('wrong-generation', 'Viewer owner is no longer current');
      const latest = await ports.hc.get(terminal.address).catch(cause => {
        if (cause instanceof HerdrError && cause.code === 'not_found') return null;
        throw cause;
      });
      if (!latest || latest.state !== 'live') return true;
      if (Date.now() >= deadline) throw new HerdrError('viewer-closing', 'The live viewer has not finished closing. Open the saved view again.');
      await delay(100, undefined, { signal });
    }
  }
  const launcher: ViewerLauncher = (runId, suppliedOwner, signal, intent = 'explicit') => {
    const owner = { ...suppliedOwner, terminal: { ...suppliedOwner.terminal } };
    if (!current(owner, signal)) return Promise.reject(new HerdrError('wrong-generation', 'Viewer owner is no longer current'));
    const key = keyFor(runId, owner);
    const existing = launches.get(key);
    if (existing?.discard) return existing.discard.then(() => launcher(runId, owner, signal, intent));
    if (existing) {
      // A prior placement attempt can no longer retire a reused viewer.
      existing.claim.retained = true;
      return existing.promise.then(async address => {
        let terminal: TerminalSummary | null;
        try { terminal = await ports.hc.get(address); }
        catch (cause) { if (!(cause instanceof HerdrError) || cause.code !== 'not_found') throw cause; terminal = null; }
        if (!current(owner, signal)) throw new HerdrError('wrong-generation', 'Viewer owner is no longer current');
        if (terminal && await recoverViewer(terminal, owner, runId, signal) && !await closingForSavedOpen(terminal, runId, owner, signal, intent)) return address;
        if (launches.get(key) === existing) launches.delete(key);
        return launcher(runId, owner, signal, intent);
      }, cause => { if (!current(owner, signal)) throw cause; return launcher(runId, owner, signal, intent); });
    }
    const claim = { retained: false };
    const launch = (async () => {
      // Reconcile live labelled viewers before launch, including activation reloads.
      const stream = ports.hc.events(); const candidates = new Map<TerminalAddress, TerminalSummary>();
      const unsubscribe = stream.subscribe(event => {
        const terminals = event.type === 'snapshot' || event.type === 'missed' ? event.terminals : [];
        for (const terminal of terminals) if (sameRun(terminal, owner, runId)) candidates.set(terminal.address, terminal);
      });
      const cancelled = () => { void stream.dispose(); };
      signal?.addEventListener('abort', cancelled, { once: true });
      try { await stream.ready; } finally { signal?.removeEventListener('abort', cancelled); unsubscribe(); await stream.dispose(); }
      if (!current(owner, signal)) throw new HerdrError('wrong-generation', 'Viewer owner is no longer current');
      for (const found of candidates.values()) {
        if (await recoverViewer(found, owner, runId, signal) && !await closingForSavedOpen(found, runId, owner, signal, intent)) { claim.retained = true; return found.address; }
      }
      let info: ViewerRunInfo = {}, cwd = owner.cwd;
      try { info = await ports.runInfo?.(runId, owner) ?? {}; } catch { /* Display metadata cannot prevent a viewer launch. */ }
      if (intent === 'automatic' && isFinal(info.status))
        throw new HerdrError('run-finished', 'Automatic viewers do not open finished runs');
      try { if (info.cwd && isAbsolute(info.cwd) && (await stat(info.cwd)).isDirectory()) { await access(info.cwd, constants.X_OK); cwd = info.cwd; } } catch { /* A removed or unusable run directory retains today's viewer cwd. */ }
      if (!current(owner, signal)) throw new HerdrError('wrong-generation', 'Viewer owner is no longer current');
      const parentName = (info.parentName || owner.name || 'Agent').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 160);
      const displayName = (info.name || runId).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 120);
      const handle = await ports.hc.run({ name: `run-${createHash('sha256').update(key).digest('hex').slice(0, 28)}`, argv: [process.execPath, ports.viewerExecutable, '--run', runId, '--session', owner.sessionId, '--feed-root', ports.feedRoot, '--intent', intent, ...(info.status ? ['--initial-status', info.status] : []), ...(info.dbPath && isAbsolute(info.dbPath) ? ['--run-db', info.dbPath] : []), ...(ports.piPackageRoot ? ['--pi-root', ports.piPackageRoot] : [])],
        cwd, parent: owner.terminal.address, labels: { [labels.session]: owner.sessionId, [labels.ownerCore]: owner.terminal.coreId,
          [labels.ownerTerminal]: owner.terminal.terminalId, [labels.kind]: kinds.subagentViewer, [labels.run]: runId, [labels.parentName]: parentName, [labels.steer]: info.steer ?? 'headless', [labels.displayName]: displayName, [labels.viewerLifetime]: intent === 'automatic' || info.status && !isFinal(info.status) ? 'live' : 'saved' },
        background: true, noNotify: true, outliveParent: true });
      if (!current(owner, signal)) { await ports.hc.kill(handle.address); await ports.hc.rm(handle.address); throw new HerdrError('wrong-generation', 'Viewer owner changed during launch'); }
      return handle.address;
    })().catch(cause => { if (launches.get(key)?.promise === launch) launches.delete(key); throw cause; });
    launches.set(key, { promise: launch, claim }); return launch;
  };
  return Object.assign(launcher, { async discard(runId: RunId, owner: Owner, address: TerminalAddress): Promise<void> {
    const key = keyFor(runId, owner), launch = launches.get(key);
    if (!launch || launch.claim.retained) return;
    if (launch.discard) return launch.discard;
    let removeCachedLaunch = false;
    const pending = (async () => {
      if (await launch.promise !== address || launch.claim.retained) return;
      removeCachedLaunch = true;
      const absent = (cause: unknown) => { if (!(cause instanceof HerdrError) || cause.code !== 'not_found') throw cause; };
      await ports.hc.kill(address).catch(absent);
      await ports.hc.rm(address).catch(absent);
    })().finally(() => {
      if (launch.discard === pending) delete launch.discard;
      if (removeCachedLaunch && launches.get(key) === launch) launches.delete(key);
    });
    launch.discard = pending; return pending;
  } });
}
export function registerHerdrViewers(pi: ExtensionAPI, ports: ViewerRegistrationPorts): ViewerRegistration {
  const launcher = ports.viewerLauncher ?? createViewerLauncher(ports);
  let epoch = 0; let active: Owner | null = null; let activationAbort = new AbortController();
  let unsubscribe: (() => void) | undefined;
  const pending = new Map<RunId, Promise<TerminalHandle | null>>();
  const reservations = new Map<RunId, PaneReservation>();
  const current = (owner: Owner, version: number) => version === epoch && ports.owner()?.generation === owner.generation && ports.owner()?.sessionId === owner.sessionId;
  async function open(runId: RunId, automatic: boolean): Promise<TerminalHandle | null> {
    const owner = active; const version = epoch; const signal = activationAbort.signal;
    if (!owner || !current(owner, version)) return null;
    let reservation = reservations.get(runId);
    const releaseHeld = async () => {
      if (reservation && reservations.get(runId) === reservation) { reservations.delete(runId); await ports.panes.release(reservation); }
    };
    try {
      if (!(await ports.ownedRunEvents.list(owner)).includes(runId) || !current(owner, version)) return null;
      reservation = await ports.panes.acquire('subagent', runId, owner, { signal, timeoutMs: 10000, automatic }) ?? undefined;
      if (!current(owner, version)) { if (reservation) await ports.panes.release(reservation); return null; }
      if (reservation) reservations.set(runId, reservation);
      else { reservations.delete(runId); return null; }
      const address = await launcher(runId, owner, signal, automatic ? 'automatic' : 'explicit');
      if (!current(owner, version)) { await releaseHeld(); return null; }
      if (reservation && reservation.viewer !== address) { await releaseHeld(); throw new Error('Viewer reservation acknowledged a different terminal'); }
      return { address, coreId: owner.terminal.coreId };
    } catch (cause) {
      if (!current(owner, version)) { await releaseHeld(); return null; }
      if (automatic && cause instanceof HerdrError && cause.code === 'run-finished') return null;
      throw cause;
    }
  }
  function peek(runId: RunId, automatic = false): Promise<TerminalHandle | null> {
    const existing = pending.get(runId); if (existing) return automatic ? existing : existing.then(() => open(runId, false));
    const promise = open(runId, automatic).finally(() => { if (pending.get(runId) === promise) pending.delete(runId); });
    pending.set(runId, promise); return promise;
  }
  async function stop(): Promise<void> {
    activationAbort.abort(); const version = ++epoch; active = null; unsubscribe?.(); unsubscribe = undefined;
    await Promise.allSettled([...pending.values()]);
    if (version === epoch) reservations.clear();
  }
  pi.on('session_start', async () => {
    await stop(); const currentOwner = ports.owner(); if (!currentOwner || process.env.PI_SUBAGENT_CHILD === '1') return;
    const owner = { ...currentOwner, terminal: { ...currentOwner.terminal } }; activationAbort = new AbortController();
    active = owner; const version = epoch;
    await ports.panes.reconcile(owner, activationAbort.signal);
    if (!current(owner, version)) return;
    const seen = new Set<RunId>(), queue: RunId[] = []; let opening = 0;
    const report = ports.reportError ?? (() => {});
    const drain = () => {
      while (current(owner, version) && opening < 4 && queue.length) {
        const runId = queue.shift()!; opening++;
        void peek(runId, true).catch(() => {}).finally(() => { opening--; drain(); });
      }
    };
    const automatic = (runId: RunId) => {
      if (!current(owner, version) || seen.has(runId)) return;
      seen.add(runId); queue.push(runId); drain();
    };
    unsubscribe = ports.ownedRunEvents.subscribe(owner, automatic);
    void ports.ownedRunEvents.list(owner).then(ids => { for (const id of ids) automatic(id); }).catch(report);
  });
  pi.on('session_shutdown', stop);
  return { peek, launcher, dispose: stop };
}
