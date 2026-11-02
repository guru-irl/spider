// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomUUID } from 'node:crypto';
import { withProcessLock } from '../sessions/registry.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppClient, AuxiliaryPanes, HcClient, JobId, Owner, OwnerPlacement, PaneReservation, RunId, TerminalAddress, ViewerLauncher } from '../contracts.js';
import type { JobSlot } from './monitor.js';
import { HerdrError } from '../client/parse.js';
import { herdrErrorNotice } from '../notices.js';
import { HERDR_LABELS, HERDR_KINDS } from '../contracts.js';
import { moveTerminal, type MoveDestination } from '../../assets/agents/move.js';
export interface PaneAcquireOptions { signal?: AbortSignal; timeoutMs: number; automatic?: boolean; userInitiated?: boolean }
export interface AuxiliaryPaneOptions {
  hc: HcClient;
  app: AppClient;
  appForSignal?(signal: AbortSignal): AppClient;
  subagentViewer: ViewerLauncher;
  discardSubagentViewer(runId: RunId, owner: Owner, viewer: TerminalAddress): Promise<void>;
  remoteObserver?(id: JobId, owner: Owner, signal?: AbortSignal): Promise<TerminalAddress>;
  limit?: number;
  /** Automatic subagent viewers remain parked unless explicitly enabled. */
  automaticSubagentPanes?: boolean;
  /** Shared by session processes, so counting and acknowledging a pane uses one tab lock. */
  placementRoot?: string;
  paneRemovalTimeoutMs?: number;
  clock(): number;
  reportError?(error: unknown): void;
}
export interface AuxiliaryPaneActor extends AuxiliaryPanes {
  acquire(kind: 'remote' | 'subagent', id: JobId | RunId, owner: Owner, options: PaneAcquireOptions): Promise<PaneReservation | null>;
  moveRun(id: RunId, owner: Owner, destination: MoveDestination, options: PaneAcquireOptions): Promise<PaneReservation | null>;
  moveJob(id: JobId, owner: Owner, viewer: TerminalAddress, destination: MoveDestination, options: PaneAcquireOptions): Promise<PaneReservation | null>;
  reserveRemote(id: JobId, owner: Owner, options: { signal?: AbortSignal; timeoutMs: number }): Promise<JobSlot>;
  display(slot: JobSlot, viewer: TerminalAddress, options: PaneAcquireOptions): Promise<PaneReservation>;
  placement(slot: JobSlot): OwnerPlacement;
  abandon(slot: JobSlot): Promise<void>;
}
interface Slot {
  token: JobSlot;
  id: JobId | RunId;
  owner: Owner;
  kind: 'remote' | 'subagent';
  placement: OwnerPlacement;
  reservation: PaneReservation | null;
  displayedAt: number;
  displaying?: Promise<PaneReservation | null>;
  releasing?: Promise<void>;
  removing?: Promise<void>;
  removedTerminal?: TerminalAddress;
  userInitiated?: boolean;
}
function code(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : null; }
function protectedKind(labels: Readonly<Record<string, string>>): string | null {
  const kind = labels[HERDR_LABELS.kind];
  if (kind === HERDR_KINDS.session) return 'agent-pane-protected';
  if ([HERDR_KINDS.exec, HERDR_KINDS.execFile, HERDR_KINDS.batch].some(value => value === kind)) return 'job-terminal-protected';
  return null;
}
export function createAuxiliaryPanes(options: AuxiliaryPaneOptions): AuxiliaryPaneActor {
  const slots = new Map<string, Slot>();
  const displays = new Map<string, Promise<unknown>>();
  const explicitRemoteOpens = new Map<string, number>();
  const openKey = (id: JobId | RunId, owner: Owner) => JSON.stringify([id, owner.sessionId, owner.generation]);
  const report = options.reportError ?? ((error: unknown) => { console.error(herdrErrorNotice(error)); });
  let disposed = false, sequence = 0;
  const limit = options.limit ?? 2;
  // Lifecycle ownership only. The launcher is the sole viewer identity cache.
  const viewers = new Map<TerminalAddress, { owner: Owner; runId: RunId }>();
  const group = (s: Pick<Slot, 'owner' | 'placement'>) => `${s.owner.terminal.coreId}:${s.placement.space}:${s.placement.tab}`;
  const displayed = (g: string) => [...slots.values()].filter(s => group(s) === g && s.reservation !== null);
  async function occupied(s: Slot): Promise<number> {
    const addresses = await options.app.tabTerminals(s.placement);
    // Native closes and manual moves may arrive before the core event stream.
    for (const local of displayed(group(s))) if (local.reservation && !addresses.includes(local.reservation.viewer)) local.reservation = null;
    let count = 0;
    for (const address of addresses) {
      if (address === s.owner.terminal.address) continue;
      if ([...slots.values()].some(slot => slot.reservation?.viewer === address)) { count++; continue; }
      const terminal = await options.hc.get(address).catch(error => { if (code(error) === 'not_found') return null; throw error; });
      // A pane can briefly outlive its core terminal. Reserve its capacity until the app removes it.
      if (!terminal || [HERDR_KINDS.subagentViewer, HERDR_KINDS.remoteObserver, HERDR_KINDS.remoteConsole].some(kind => kind === terminal.labels[HERDR_LABELS.kind])) count++;
    }
    return count;
  }
  const check = (signal?: AbortSignal) => {
    if (disposed) throw new HerdrError('disposed', 'Placement actor is closed');
    if (signal?.aborted) throw new HerdrError('aborted', 'Pane acquisition aborted');
  };
  async function reserve(id: JobId | RunId, owner: Owner, kind: Slot['kind'], signal?: AbortSignal, observed?: OwnerPlacement): Promise<Slot> {
    check(signal);
    const find = () => [...slots.values()].find(s => s.id === id && s.owner.sessionId === owner.sessionId && !(s.kind === 'subagent' && s.removedTerminal));
    const existing = find();
    if (existing?.removedTerminal) await removeSlot(existing);
    else if (existing) {
      if (!existing.reservation && !existing.displaying) {
        const placement = observed ?? await options.app.ownerPlacement(owner.terminal.address);
        if (!existing.reservation && !existing.displaying) existing.placement = placement;
      }
      if (explicitRemoteOpens.has(openKey(id, owner))) existing.userInitiated = true;
      return existing;
    }
    const placement = observed ?? await options.app.ownerPlacement(owner.terminal.address);
    check(signal);
    const raced = find(); if (raced) return raced.removedTerminal ? reserve(id, owner, kind, signal, observed) : raced;
    const value: Slot = { token: { id: randomUUID() }, id, owner, kind, placement, reservation: null, displayedAt: 0, userInitiated: explicitRemoteOpens.has(openKey(id, owner)) };
    slots.set(value.token.id, value); return value;
  }
  function slot(token: JobSlot): Slot {
    const s = slots.get(token.id); if (!s) throw new HerdrError('pane-not-owned', 'Reservation does not belong to this placement actor'); return s;
  }
  async function focus(viewer: TerminalAddress): Promise<void> {
    const reply = await options.app.command('pane.focus', { terminal: viewer });
    if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
  }
  function acknowledged(s: Slot, viewer: TerminalAddress, placement: OwnerPlacement): PaneReservation {
    s.placement = placement;
    if (s.reservation?.viewer === viewer && s.reservation.pane === placement.pane) return s.reservation;
    const reservation: PaneReservation = { id: s.id, owner: s.owner, kind: s.kind, viewer, pane: placement.pane };
    s.reservation = reservation; s.displayedAt = ++sequence; return reservation;
  }
  async function keepInTab(s: Slot, viewer: TerminalAddress, displayOptions: PaneAcquireOptions, displayName?: string): Promise<PaneReservation> {
    const reply = await options.app.command('terminal.keep', { terminal: viewer, place: 'tab' });
    if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
    const deadline = options.clock() + displayOptions.timeoutMs;
    while (true) {
      check(displayOptions.signal);
      try {
        const placement = await options.app.ownerPlacement(viewer);
        if (reply.tab && (placement.tab !== reply.tab || reply.pane && placement.pane !== reply.pane)) throw new HerdrError('owner-unplaced', 'New tab placement is still pending');
        if (displayName && reply.pending && reply.tab && (placement.space !== s.placement.space || placement.tab !== s.placement.tab)) {
          const renamed = await options.app.command('tab.rename', { id: reply.tab, name: displayName });
          if (renamed.error) throw new HerdrError(renamed.error.code, renamed.error.message);
        }
        await focus(viewer); return acknowledged(s, viewer, placement);
      } catch (error) { if (code(error) !== 'owner-unplaced') throw error; }
      if (options.clock() >= deadline) throw new HerdrError('pane-timeout', 'New terminal tab was not acknowledged');
      await delay(50, undefined, { signal: displayOptions.signal });
    }
  }
  async function show(token: JobSlot, viewer: TerminalAddress, displayOptions: PaneAcquireOptions): Promise<PaneReservation | null> {
    const s = slot(token);
    if (viewer === s.owner.terminal.address) throw new HerdrError('agent-pane-protected', 'An agent terminal cannot be an auxiliary pane');
    const viewerLabels = (await options.hc.get(viewer)).labels;
    const protection = protectedKind(viewerLabels);
    if (protection) throw new HerdrError(protection, 'Session and payload terminals cannot be auxiliary panes');
    const explicit = displayOptions.userInitiated ?? s.userInitiated ?? false;
    if (s.displaying) return s.displaying;
    if (s.reservation && !explicit) return s.reservation;
    const g = group(s);
    const previous = displays.get(g) ?? Promise.resolve();
    const display = async () => {
      check(displayOptions.signal);
      if (!slots.has(token.id)) throw new HerdrError('pane-not-owned', 'Reservation ended before display');
      if (explicit || displayOptions.automatic) {
        const placed = await options.app.ownerPlacement(viewer).catch(error => { if (code(error) === 'owner-unplaced') return null; throw error; });
        if (placed) { if (explicit) await focus(viewer); return acknowledged(s, viewer, placed); }
      }
      if (s.kind === 'subagent' && displayOptions.automatic && !options.automaticSubagentPanes) {
        await abandon(token); return null;
      }
      const current = await options.app.ownerPlacement(s.owner.terminal.address);
      if (current.space !== s.placement.space || current.tab !== s.placement.tab) throw new HerdrError('owner-tab-changed', 'Owner moved before pane acknowledgement');
      for (const ended of displayed(g)) if (ended.removedTerminal) await removeSlot(ended);
      let occupancy = await occupied(s);
      if (displayOptions.automatic && occupancy >= limit) {
        await awaitAbsent(viewer, true);
        await abandon(token); return null;
      }
      if (explicit && displayed(g).length >= limit) return keepInTab(s, viewer, displayOptions, viewerLabels[HERDR_LABELS.displayName]);
      // Capacity used by another session process has no local reservation to release.
      if (explicit && occupancy >= limit && displayed(g).length < limit) return keepInTab(s, viewer, displayOptions, viewerLabels[HERDR_LABELS.displayName]);
      while (occupancy >= limit) {
        // Slots contain auxiliary panes only. Job observers and consoles rank below viewers.
        const victim = displayed(g).sort((a, b) => Number(a.kind === 'subagent') - Number(b.kind === 'subagent') || a.displayedAt - b.displayedAt)[0];
        if (!victim?.reservation) { await awaitAbsent(viewer, true); await abandon(token); return null; }
        if (victim.removing) await victim.removing;
        else await release(victim.reservation);
        occupancy = await occupied(s);
      }
      check(displayOptions.signal);
      await options.hc.setLabels(viewer, { [HERDR_LABELS.space]: s.placement.space, [HERDR_LABELS.tab]: s.placement.tab });
      const pane = await options.app.awaitPane(viewer, s.placement, displayOptions);
      if (disposed || !slots.has(token.id)) throw new HerdrError('disposed', 'Reservation ended before its pane was acknowledged');
      if (explicit) await focus(viewer);
      return acknowledged(s, viewer, { ...s.placement, pane });
    };
    const operation = previous.catch(() => {}).then(() => options.placementRoot
      ? withProcessLock(options.placementRoot, g, display, { timeoutMs: displayOptions.timeoutMs })
      : display());
    s.displaying = operation; displays.set(g, operation);
    try { return await operation; }
    finally { s.displaying = undefined; if (displays.get(g) === operation) displays.delete(g); }
  }
  async function awaitAbsent(viewer: TerminalAddress, requestPark = false): Promise<void> {
    const timeoutMs = options.paneRemovalTimeoutMs ?? 10000, deadline = options.clock() + timeoutMs;
    const controller = new AbortController(), app = options.appForSignal?.(controller.signal) ?? options.app;
    const failure = new HerdrError('pane-removal-timeout', `terminal.park did not remove ${viewer} from the app layout within ${timeoutMs}ms`, { terminal: viewer, timeoutMs });
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure); }, timeoutMs); });
    const observe = async () => {
      if (requestPark) {
        const terminal = await options.hc.get(viewer).catch(async error => {
          if (code(error) !== 'not_found') throw error;
          try { await app.ownerPlacement(viewer); }
          catch (layoutError) { if (code(layoutError) === 'owner-unplaced') return null; throw layoutError; }
          throw error;
        });
        if (controller.signal.aborted) throw failure;
        if (!terminal) return;
        const protection = protectedKind(terminal.labels);
        if (protection) throw new HerdrError(protection, 'Session and payload terminals cannot be parked by the auxiliary actor');
        const result = await app.command('terminal.park', { terminal: viewer });
        if (result.error) throw new HerdrError(result.error.code, result.error.message);
      }
      // Native pending is not removal, and parking does not remove the core terminal.
      // Completion is its absence from the app's actual tab layout.
      while (!controller.signal.aborted) {
        try { await app.ownerPlacement(viewer); }
        catch (error) { if (code(error) === 'owner-unplaced') return; throw error; }
        if (options.clock() >= deadline) throw failure;
        await delay(50, undefined, { signal: controller.signal });
      }
      throw failure;
    };
    try { await Promise.race([observe(), timeout]); }
    catch (error) { throw controller.signal.aborted ? failure : error; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async function release(reservation: PaneReservation): Promise<void> {
    const s = [...slots.values()].find(s => s.reservation === reservation); if (!s) return;
    return s.releasing ??= (async () => {
      await awaitAbsent(reservation.viewer, true);
      slots.delete(s.token.id);
    })().catch(error => { s.releasing = undefined; throw error; });
  }
  async function abandon(token: JobSlot): Promise<void> {
    const s = slots.get(token.id); if (!s) return;
    if (s.reservation) await release(s.reservation);
    else slots.delete(token.id);
  }
  async function removeViewer(address: TerminalAddress): Promise<void> {
    const owned = viewers.get(address); if (!owned) return;
    const terminal = await options.hc.get(address).catch(error => { if (code(error) === 'not_found') return null; throw error; });
    if (terminal?.state === 'finished' && terminal.labels[HERDR_LABELS.kind] === HERDR_KINDS.subagentViewer
      && terminal.labels[HERDR_LABELS.session] === owned.owner.sessionId && terminal.labels[HERDR_LABELS.run] === owned.runId
      && terminal.labels[HERDR_LABELS.ownerCore] === owned.owner.terminal.coreId && terminal.labels[HERDR_LABELS.ownerTerminal] === owned.owner.terminal.terminalId) {
      await options.hc.rm(address).catch(error => { if (code(error) !== 'not_found') throw error; });
    }
    viewers.delete(address);
  }
  async function removeSlot(s: Slot): Promise<void> {
    const terminal = s.removedTerminal; if (!terminal) return;
    return s.removing ??= (async () => {
      if (s.kind === 'subagent') {
        // Native pane removal can lag the viewer's exit. Count its occupancy
        // without making new viewers wait for that acknowledgement.
        try { await options.app.ownerPlacement(terminal); return; }
        catch (error) { if (code(error) !== 'owner-unplaced') throw error; }
        await removeViewer(terminal);
      } else {
        await awaitAbsent(terminal);
        const ended = await options.hc.get(terminal).catch(error => { if (code(error) === 'not_found') return null; throw error; });
        if (ended?.state === 'finished' && [HERDR_KINDS.remoteObserver, HERDR_KINDS.remoteConsole].some(kind => ended.labels[HERDR_LABELS.kind] === kind)
          && ended.labels[HERDR_LABELS.session] === s.owner.sessionId && ended.labels[HERDR_LABELS.ownerCore] === s.owner.terminal.coreId
          && ended.labels[HERDR_LABELS.ownerTerminal] === s.owner.terminal.terminalId) {
          await options.hc.rm(terminal).catch(error => { if (code(error) !== 'not_found') throw error; });
        }
      }
      slots.delete(s.token.id);
    })().finally(() => { s.removing = undefined; });
  }
  // This actor owns only its event view, never the shared events process.
  const stream = options.hc.events();
  const unsubscribe = stream.subscribe(event => {
    if (disposed || !('terminal' in event)) return;
    const s = [...slots.values()].find(s => s.reservation?.viewer === event.terminal);
    if (event.type === 'removed') viewers.delete(event.terminal);
    if (event.type === 'removed' || event.type === 'finished' && (s || viewers.has(event.terminal))) {
      if (s) { s.removedTerminal = event.terminal; void removeSlot(s).catch(report); }
      else if (event.type === 'finished') void removeViewer(event.terminal).catch(report);
    } else if (s && (event.type === 'lost' || event.type === 'restarted')) {
      viewers.delete(event.terminal);
      void (async () => { if (s.reservation) await release(s.reservation); await options.hc.kill(event.terminal); await options.hc.rm(event.terminal); })().catch(report);
    }
  });
  async function moveViewer(kind: Slot['kind'], id: JobId | RunId, owner: Owner, destination: MoveDestination, moveOptions: PaneAcquireOptions, claimed?: TerminalAddress): Promise<PaneReservation | null> {
    check(moveOptions.signal);
    const existing = [...slots.values()].find(s => s.id === id && s.kind === kind && s.owner.sessionId === owner.sessionId && !s.removedTerminal);
    let viewer: TerminalAddress;
    if (kind === 'remote') {
      if (!claimed || existing?.reservation && existing.reservation.viewer !== claimed) throw new HerdrError('pane-not-owned', 'Observer does not belong to this job');
      const terminal = await options.hc.get(claimed);
      const labels = terminal.labels;
      if (terminal.state !== 'live' || labels[HERDR_LABELS.kind] !== HERDR_KINDS.remoteObserver || labels[HERDR_LABELS.job] !== id
        || labels[HERDR_LABELS.session] !== owner.sessionId || labels[HERDR_LABELS.ownerCore] !== owner.terminal.coreId
        || labels[HERDR_LABELS.ownerTerminal] !== owner.terminal.terminalId) throw new HerdrError('pane-not-owned', 'Observer does not belong to this job');
      viewer = claimed;
    } else {
      viewer = existing?.reservation?.viewer ?? await options.subagentViewer(id as RunId, owner, moveOptions.signal, 'explicit');
      viewers.set(viewer, { owner, runId: id as RunId });
    }
    const s = existing ?? await reserve(id, owner, kind, moveOptions.signal);
    if (s.displaying) await s.displaying;
    const groupKey = group(s), previous = displays.get(groupKey) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      check(moveOptions.signal);
      if (!options.app.tabSpace) throw new HerdrError('unavailable', 'Tab lookup is unavailable');
      let target = destination;
      if (destination.kind === 'tab') {
        const space = await options.app.tabSpace(destination.tab as OwnerPlacement['tab']);
        if (!space || destination.space && destination.space !== space) throw new HerdrError('not-found', 'Target tab is unavailable');
        const viewerMachine = viewer.includes('/') ? viewer.slice(0, viewer.indexOf('/')) : null;
        const targetMachine = space.includes('/') ? space.slice(0, space.indexOf('/')) : null;
        if (viewerMachine !== targetMachine) throw new HerdrError('unavailable', 'A terminal cannot move to another machine');
        target = { ...destination, space };
      } else if (destination.kind === 'new') {
        const placed = await options.app.ownerPlacement(viewer).catch(error => { if (code(error) === 'owner-unplaced') return null; throw error; });
        target = { ...destination, space: placed?.space ?? (await options.app.ownerPlacement(owner.terminal.address)).space };
      }
      const perform = async () => {
      await moveTerminal(viewer, target, {
        now: options.clock, timeoutMs: moveOptions.timeoutMs,
        sleep: async ms => { check(moveOptions.signal); await delay(ms, undefined, { signal: moveOptions.signal }); },
        placement: async address => options.app.ownerPlacement(address as TerminalAddress).catch(error => { if (code(error) === 'owner-unplaced') return null; throw error; }),
        targetPane: async () => null,
        tabExists: async tab => Boolean(await options.app.tabSpace!(tab as OwnerPlacement['tab'])),
        run: (name, args) => options.app.command(name, args),
        createTab: async space => {
          const reply = await options.app.command('tab.new', { space, mod: 'pane' });
          if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
          if (!reply.tab || !reply.pane) throw new HerdrError('invalid-reply', 'New tab has no pane');
          return { space: reply.space ?? space, tab: reply.tab, pane: reply.pane };
        },
        adopt: async (address, placement) => {
          if (!placement.space) throw new HerdrError('not-found', 'Target space is unavailable');
          const machine = address.includes('/') ? address.slice(0, address.indexOf('/')) : null;
          const local = (id: string) => machine && id.startsWith(`${machine}/`) ? id.slice(machine.length + 1) : id;
          await options.hc.setLabels(address as TerminalAddress, { [HERDR_LABELS.space]: local(placement.space), [HERDR_LABELS.tab]: local(placement.tab) });
        },
        changed: async placement => { if (placement) acknowledged(s, viewer, placement as OwnerPlacement); else s.reservation = null; },
      });
      return s.reservation;
      };
      if (!options.placementRoot) return perform();
      const targetKey = target.kind === 'tab' ? `${owner.terminal.coreId}:${target.space}:${target.tab}` : groupKey;
      const keys = [...new Set([groupKey, targetKey])].sort();
      const lock = async (index: number): Promise<PaneReservation | null> => index === keys.length ? perform() : withProcessLock(options.placementRoot!, keys[index], () => lock(index + 1), { timeoutMs: moveOptions.timeoutMs });
      return lock(0);
    });
    s.displaying = operation; displays.set(groupKey, operation);
    try { return await operation; }
    finally { s.displaying = undefined; if (displays.get(groupKey) === operation) displays.delete(groupKey); }
  }
  return {
    acquire: async function acquire(kind, id, owner, acquireOptions): Promise<PaneReservation | null> {
      check(acquireOptions.signal);
      let viewer: TerminalAddress;
      const explicit = acquireOptions.userInitiated ?? !acquireOptions.automatic;
      if (kind === 'remote') {
        const existing = [...slots.values()].find(s => s.id === id && s.owner.sessionId === owner.sessionId);
        if (existing?.reservation) return show(existing.token, existing.reservation.viewer, { ...acquireOptions, userInitiated: explicit });
        if (!options.remoteObserver) throw new HerdrError('remote-observer-unavailable', 'No explicit job observer launcher is bound');
        const key = openKey(id, owner); if (explicit) explicitRemoteOpens.set(key, (explicitRemoteOpens.get(key) ?? 0) + 1);
        try { viewer = await options.remoteObserver(id as JobId, owner, acquireOptions.signal); }
        finally { if (explicit) { const count = explicitRemoteOpens.get(key)! - 1; if (count) explicitRemoteOpens.set(key, count); else explicitRemoteOpens.delete(key); } }
      } else {
        try { viewer = await options.subagentViewer(id as RunId, owner, acquireOptions.signal, explicit ? 'explicit' : 'automatic'); }
        catch (error) { if (!explicit && code(error) === 'run-finished') return null; throw error; }
        viewers.set(viewer, { owner, runId: id as RunId });
      }
      let s: Slot | undefined, observed: OwnerPlacement | undefined;
      try {
        if (kind === 'subagent' && !explicit && !options.automaticSubagentPanes) {
          const placed = await options.app.ownerPlacement(viewer).catch(error => { if (code(error) === 'owner-unplaced') return null; throw error; });
          check(acquireOptions.signal);
          if (!placed) return null;
          observed = placed;
        }
        const previous = [...slots.values()].find(s => s.id === id && s.owner.sessionId === owner.sessionId && !(s.kind === 'subagent' && s.removedTerminal));
        if (previous?.reservation && previous.reservation.viewer !== viewer) {
          const oldViewer = previous.reservation.viewer;
          const terminal = kind === 'subagent' ? await options.hc.get(oldViewer).catch(error => { if (code(error) === 'not_found') return null; throw error; }) : undefined;
          if (kind === 'subagent' && (!terminal || terminal.state === 'finished')) {
            previous.removedTerminal = oldViewer;
            void removeSlot(previous).catch(report);
          } else await release(previous.reservation);
        }
        s = await reserve(id, owner, kind, acquireOptions.signal, observed);
        check(acquireOptions.signal);
        const reservation = await show(s.token, viewer, { ...acquireOptions, userInitiated: explicit });
        // A concurrent automatic opener can park and abandon this slot.
        // Retry the user request with a fresh slot, reusing the same live viewer.
        return explicit && reservation === null ? acquire(kind, id, owner, acquireOptions) : reservation;
      } catch (error) {
        if (kind === 'subagent' && !explicit && !options.automaticSubagentPanes) {
          if (s && !s.reservation) slots.delete(s.token.id);
          if (disposed || acquireOptions.signal?.aborted) {
            viewers.delete(viewer);
            await options.discardSubagentViewer(id as RunId, owner, viewer);
          }
          throw error;
        }
        // Only the shared launcher knows whether another opener has claimed
        // this viewer. A canceled placement cannot decide its process lifetime.
        if (kind === 'subagent' && (disposed || acquireOptions.signal?.aborted)) {
          await options.discardSubagentViewer(id as RunId, owner, viewer);
          throw error;
        }
        if (explicit && kind === 'subagent' && !disposed && !acquireOptions.signal?.aborted && code(error) === 'pane-not-owned' && s && !slots.has(s.token.id)) {
          // A finished viewer can retire its slot while this display is queued.
          // Revalidate the viewer and reserve again for the still-current user open.
          return acquire(kind, id, owner, acquireOptions);
        }
        if (explicit && kind === 'subagent' && !disposed && !acquireOptions.signal?.aborted && (code(error) === 'app-error' || code(error) === 'not_found' || code(error) === 'cli-exit')) {
          const terminal = await options.hc.get(viewer).catch(cause => { if (code(cause) === 'not_found') return null; throw cause; });
          if (!terminal || terminal.state === 'finished') {
            if (s) { s.removedTerminal = viewer; await removeSlot(s); }
            return acquire(kind, id, owner, acquireOptions);
          }
        }
        // Placement can time out while the owner is suspended. The viewer's
        // lifetime does not depend on its pane being acknowledged.
        const preserveViewer = kind === 'subagent' && !disposed && !acquireOptions.signal?.aborted;
        if (!preserveViewer) viewers.delete(viewer);
        if (s) await abandon(s.token);
        if (viewer !== owner.terminal.address) {
          const current = await options.hc.get(viewer).catch(error => { if (code(error) === 'not_found') return null; throw error; });
          if (current && !protectedKind(current.labels)) {
            if (preserveViewer) await awaitAbsent(viewer, true).catch(error => { if (explicit) report(error); });
            else { await options.hc.kill(viewer); await options.hc.rm(viewer); }
          }
        }
        throw error;
      }
    },
    moveRun: (id, owner, destination, moveOptions) => moveViewer('subagent', id, owner, destination, moveOptions),
    moveJob: (id, owner, viewer, destination, moveOptions) => moveViewer('remote', id, owner, destination, moveOptions, viewer),
    reserveRemote: async (id, owner, reserveOptions) => (await reserve(id, owner, 'remote', reserveOptions.signal)).token,
    display: async (token, viewer, displayOptions) => {
      const reservation = await show(token, viewer, { ...displayOptions, automatic: false });
      if (!reservation) throw new HerdrError('auxiliary-disabled', 'No auxiliary pane slots are configured');
      return reservation;
    },
    placement: token => slot(token).placement,
    release,
    abandon,
    park: async runId => { const s = [...slots.values()].find(s => s.id === runId && s.kind === 'subagent' && !s.removedTerminal); if (s?.reservation) await release(s.reservation); },
    dispose: async () => {
      if (disposed) return;
      disposed = true; unsubscribe();
      try { for (const s of [...slots.values()]) if (s.kind !== 'subagent') await abandon(s.token); }
      finally { slots.clear(); viewers.clear(); await stream.dispose(); }
    },
  };
}
