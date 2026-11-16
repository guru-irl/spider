// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrError } from '../client/parse.js';
import { HERDR_KINDS, HERDR_LABELS, type AppClient, type AppPaneInspection, type AppSpaceInfo, type Destination, type HcClient, type Owner, type OwnerPlacement, type TerminalAddress, type TerminalSummary } from '../contracts.js';
import { withProcessLock } from '../sessions/registry.js';

export interface SessionOpenPorts {
  hc: HcClient;
  app: AppClient & AppPaneInspection;
  placementRoot: string;
  appIdentity: string;
  limit: number;
  clock(): number;
  signal?: AbortSignal;
  returnFocus?: OwnerPlacement;
  backgroundKeep?: boolean;
  cleanupApp?: AppClient & AppPaneInspection;
}
const openTimeoutMs = 20_000;
const minimum = { cols: 60, rows: 8 };
const auxiliary = new Set<string>([HERDR_KINDS.subagentViewer, HERDR_KINDS.remoteObserver, HERDR_KINDS.remoteConsole]);
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : null;

/** Reopen the current owner's terminal; never start or discard a process. */
export async function openOwnedSession(owner: Owner, destination: Destination, ports: SessionOpenPorts): Promise<TerminalAddress> {
  const { hc, app, signal } = ports;
  const address = owner.terminal.address;
  if (address.includes('/')) throw new HerdrError('view-on-mac', 'This needs the Herdr app on this Mac');
  const check = () => { if (signal?.aborted) throw new HerdrError('aborted', 'Session opening was cancelled'); };
  const command = async (name: string, args: Readonly<Record<string, unknown>>) => {
    check(); const reply = await app.command(name, args);
    if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
    return reply;
  };
  const verify = async () => {
    check();
    const local = await hc.identity();
    if (local.coreId !== owner.terminal.coreId || local.socket !== owner.terminal.socket || local.sessionNamespace !== owner.terminal.sessionNamespace) {
      throw new HerdrError('core-mismatch', 'The session belongs to a different core');
    }
    let terminal: TerminalSummary;
    try { terminal = await hc.get(address, { signal }); }
    catch (error) { if (errorCode(error) === 'not_found') throw new HerdrError('not-found', 'The session terminal no longer exists'); throw error; }
    if (terminal.state !== 'live') throw new HerdrError('not-found', 'The session terminal has exited');
    check(); return terminal;
  };
  const placement = async () => {
    try { return await app.ownerPlacement(address); }
    catch (error) { if (errorCode(error) === 'owner-unplaced') return null; throw error; }
  };
  const waitForPlacement = async (space: AppSpaceInfo['id'], tab: OwnerPlacement['tab'] | null) => {
    const deadline = ports.clock() + openTimeoutMs;
    for (;;) {
      check(); const observed = await placement();
      if (observed) {
        if (observed.space !== space || (tab !== null && observed.tab !== tab)) throw new HerdrError('placement-mismatch', 'The terminal appeared in a different tab');
        return observed;
      }
      if (ports.clock() >= deadline) throw new HerdrError('pane-timeout', 'The session pane was not acknowledged');
      try { await delay(50, undefined, { signal }); } catch { throw new HerdrError('aborted', 'Session opening was cancelled'); }
    }
  };
  const ensureLive = async () => { await verify(); };
  const focus = async () => { await command('pane.focus', { terminal: address }); };
  const cleanup = ports.cleanupApp ?? app;
  const restoreFocus = async (previous: OwnerPlacement | null | undefined) => {
    if (!previous) return;
    let exists = false;
    try { exists = (await cleanup.tabPanes(previous)).some(row => row.pane === previous.pane); }
    catch (failure) { if (errorCode(failure) !== 'tab-unplaced') throw failure; }
    if (exists) {
      const restored = await cleanup.command('pane.focus', { pane: previous.pane });
      if (restored.error) throw new HerdrError(restored.error.code, restored.error.message);
    }
  };
  const settle = async () => { try { await delay(50, undefined, { signal }); } catch { throw new HerdrError('aborted', 'Session opening was cancelled'); } };
  const park = async () => {
    await command('terminal.park', { terminal: address });
    const deadline = ports.clock() + openTimeoutMs;
    while (await placement()) {
      check(); if (ports.clock() >= deadline) throw new HerdrError('pane-timeout', 'The unsafe pane was not parked');
      await settle();
    }
  };
  const perform = async () => {
    await ensureLive();
    if (await placement()) {
      const previous = ports.returnFocus ?? await app.focusedPane();
      check();
      try { await focus(); check(); }
      catch (error) { if (signal?.aborted) await restoreFocus(previous); throw error; }
      return address;
    }
    if (!app.listSpaces) throw new HerdrError('app-unavailable', 'Space inventory is unavailable');
    const inventory = await app.listSpaces();
    const eligible = inventory.filter(space => space.machine === null);
    if (!eligible.length) throw new HerdrError('no-local-space', 'No local space is available to reopen the session');
    const focused = await app.focusedPane();
    const chosen = destination && eligible.find(space => space.id === destination.space && space.tabs.some(tab => tab.id === destination.tab));
    const active = eligible.find(space => space.id === focused?.space) ?? eligible.find(space => space.active === true);
    const targetSpace = chosen || active || eligible[0];
    const targetTab = chosen ? destination!.tab : active && focused?.space === active.id && active.tabs.some(tab => tab.id === focused.tab) ? focused.tab : null;
    let split: { anchor: OwnerPlacement; direction: 'right' | 'down'; existing: TerminalAddress[] } | null = null;
    if (targetTab) {
      const target = { space: targetSpace.id, tab: targetTab };
      const panes = await app.tabPanes(target);
      const rows = await Promise.all(panes.map(async row => {
        try { return { ...row, summary: await hc.get(row.terminal, { signal }) }; }
        catch (error) { if (errorCode(error) === 'not_found') return { ...row, summary: null }; throw error; }
      }));
      const occupied = rows.filter(row => !row.summary || auxiliary.has(row.summary.labels[HERDR_LABELS.kind])).length;
      const suitable = rows.every(row => row.summary && (row.summary.cols ?? 0) >= minimum.cols && (row.summary.rows ?? 0) >= minimum.rows);
      const anchor = rows.find(row => row.pane === focused?.pane) ?? rows[0];
      if (occupied < ports.limit && suitable && anchor?.summary) {
        const cols = anchor.summary.cols ?? 0, height = anchor.summary.rows ?? 0;
        const right = Math.floor((cols - 1) / 2) >= minimum.cols && height >= minimum.rows;
        const down = cols >= minimum.cols + (rows.length === 1 ? 1 : 0) && Math.floor((height - (rows.length === 1 ? 5 : 3)) / 2) >= minimum.rows;
        if (right || down) split = { anchor: { ...target, pane: anchor.pane }, direction: right ? 'right' : 'down', existing: rows.map(row => row.terminal) };
      }
    }
    check();
    try {
      if (split) {
        await command('pane.focus', { pane: split.anchor.pane });
        const actual = await app.focusedPane();
        if (!actual || actual.space !== split.anchor.space || actual.tab !== split.anchor.tab || actual.pane !== split.anchor.pane)
          throw new HerdrError('focus-changed', 'The target pane changed before opening');
      } else {
        await command('space.select', { id: targetSpace.id });
        const actual = await app.focusedPane();
        if (actual && actual.space !== targetSpace.id) throw new HerdrError('focus-changed', 'The target space changed before opening');
      }
      await ensureLive();
    } catch (error) {
      if (signal?.aborted) await restoreFocus(ports.returnFocus ?? focused);
      throw error;
    }
    let keepDispatched = false;
    try {
      check(); keepDispatched = true;
      const result = await command('terminal.keep', { terminal: address, place: split?.direction ?? 'tab', ...(ports.backgroundKeep ? { focus: false } : {}) });
      const opened = await waitForPlacement(targetSpace.id, split ? targetTab : null);
      if (result.pane && result.pane !== opened.pane) throw new HerdrError('placement-mismatch', 'The terminal pane changed before acknowledgement');
      if (split) {
        // Verify the settled result, not only the predicted split. A known-bad split can be
        // parked safely and reopened in a tab; never kill or recreate its primary process.
        await settle();
        const sizes = await Promise.all([...split.existing, address].map(id => hc.get(id, { signal }).catch(() => null)));
        if (sizes.some(size => !size || (size.cols ?? 0) < minimum.cols || (size.rows ?? 0) < minimum.rows)) {
          await park();
          keepDispatched = false;
          await command('space.select', { id: targetSpace.id });
          const actual = await app.focusedPane();
          if (actual && actual.space !== targetSpace.id) throw new HerdrError('focus-changed', 'The target space changed before opening');
          await ensureLive();
          check(); keepDispatched = true;
          const fallback = await command('terminal.keep', { terminal: address, place: 'tab', ...(ports.backgroundKeep ? { focus: false } : {}) });
          const placed = await waitForPlacement(targetSpace.id, null);
          if (fallback.pane && fallback.pane !== placed.pane) throw new HerdrError('placement-mismatch', 'The terminal pane changed before acknowledgement');
        }
      }
      await focus(); check(); return address;
    } catch (error) {
      if (signal?.aborted) {
        // Older apps can focus a keep before cancellation arrives. Park it and restore the original pane.
        if (keepDispatched) {
          const observe = async () => {
            try { return await cleanup.ownerPlacement(address); }
            catch (failure) { if (errorCode(failure) === 'owner-unplaced') return null; throw failure; }
          };
          const deadline = ports.clock() + openTimeoutMs;
          let observed = await observe();
          while (!observed && ports.clock() < deadline) { await delay(50); observed = await observe(); }
          if (observed) {
            const result = await cleanup.command('terminal.park', { terminal: address });
            if (result.error) throw new HerdrError(result.error.code, result.error.message);
            const parkedDeadline = ports.clock() + openTimeoutMs;
            while (await observe()) {
              if (ports.clock() >= parkedDeadline) throw new HerdrError('pane-timeout', 'The cancelled session pane was not parked');
              await delay(50);
            }
          }
        }
        await restoreFocus(ports.returnFocus ?? focused);
      }
      throw error;
    }
  };
  check();
  const local = await hc.identity();
  const keys = [...new Set([`${ports.appIdentity}:${owner.terminal.coreId}:focus`, `${ports.appIdentity}:${local.coreId}:focus`])].sort();
  const locked = (index: number): Promise<TerminalAddress> => index === keys.length ? perform()
    : withProcessLock(ports.placementRoot, keys[index], () => locked(index + 1), { timeoutMs: openTimeoutMs, signal });
  return locked(0);
}
