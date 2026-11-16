// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { setTimeout as delay } from 'node:timers/promises';
import type { AppClient, HcClient, IpcMoveDestination, OwnerPlacement, TerminalAddress } from '../contracts.js';
import { HERDR_LABELS } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { withProcessLock } from '../sessions/registry.js';
import { moveTerminal } from '../../assets/agents/move.js';
import { recordSessionMove, type LayoutSnapshot } from './setup.js';
import { presentProxy, type PaneOpenPorts } from '../panes/open.js';
import { paneAddress } from '../panes/codec.js';
import type { PanePresentation, PaneSlot } from '../panes/types.js';
import { rememberRemoteSessionPlacement } from './remote-placement.js';

export interface SessionMovePorts {
  app: AppClient;
  hc: Pick<HcClient, 'setLabels'>;
  journalRoot: string;
  placementRoot?: string;
  appIdentity?: string;
  layoutSnapshot(): Promise<LayoutSnapshot>;
  clock(): number;
  signal?: AbortSignal;
}
export async function moveOwnedSession(owner: { sessionId: string; terminal: TerminalAddress; coreId: string }, destination: Exclude<IpcMoveDestination, { kind: 'hide' }>, ports: SessionMovePorts): Promise<void> {
  const source = await ports.app.ownerPlacement(owner.terminal);
  if (!ports.app.tabSpace) throw new HerdrError('unavailable', 'Tab lookup is unavailable');
  const targetSpace = destination.kind === 'tab' ? await ports.app.tabSpace(destination.tab) : source.space;
  if (!targetSpace) throw new HerdrError('not-found', 'Target tab is unavailable');
  const machine = owner.terminal.includes('/') ? owner.terminal.slice(0, owner.terminal.indexOf('/')) : null;
  const targetMachine = targetSpace.includes('/') ? targetSpace.slice(0, targetSpace.indexOf('/')) : null;
  if (machine !== targetMachine) throw new HerdrError('unavailable', 'A terminal cannot move to another machine');
  const local = (id: string) => machine && id.startsWith(`${machine}/`) ? id.slice(machine.length + 1) : id;
  const target = destination.kind === 'tab' ? { ...destination, space: targetSpace } : { ...destination, space: source.space };
  const perform = async () => {
    await moveTerminal(owner.terminal, target, {
      now: ports.clock, timeoutMs: 20000,
      sleep: ms => delay(ms, undefined, { signal: ports.signal }),
      placement: async address => ports.app.ownerPlacement(address as TerminalAddress).catch(error => { if (error instanceof HerdrError && error.code === 'owner-unplaced') return null; throw error; }),
      targetPane: async () => null,
      tabExists: async tab => Boolean(await ports.app.tabSpace!(tab as OwnerPlacement['tab'])),
      run: (name, args) => ports.app.command(name, args),
      createTab: async space => {
        const reply = await ports.app.command('tab.new', { space, mod: 'pane' });
        if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
        if (!reply.tab || !reply.pane) throw new HerdrError('invalid-reply', 'New tab has no pane');
        return { space: reply.space ?? space, tab: reply.tab, pane: reply.pane };
      },
      adopt: async (address, placement) => {
        if (!placement.space) throw new HerdrError('not-found', 'Target space is unavailable');
        await ports.hc.setLabels(address as TerminalAddress, { [HERDR_LABELS.space]: local(placement.space), [HERDR_LABELS.tab]: local(placement.tab) });
      },
      changed: async placement => { if (placement) await recordSessionMove(ports.journalRoot, owner, ports.layoutSnapshot); },
    });
  };
  if (!ports.placementRoot) return perform();
  await withProcessLock(ports.placementRoot, `${ports.appIdentity ?? 'app'}:${owner.coreId}:focus`, perform, { timeoutMs: 20000, signal: ports.signal });
}

/** The execution target is never a placement address unless it is on this Mac. */
export async function presentExistingPane(presentation: PanePresentation, slot: PaneSlot, operationId: string, ports: PaneOpenPorts,
  reserve: (slot: PaneSlot, operationId: string) => Promise<OwnerPlacement>): Promise<PanePresentation> {
  const app = ports.app;
  if (!app) throw new HerdrError('view-on-mac', 'View on Mac');
  const current = (await ports.store.read()).presentations.find(p => p.id === presentation.id);
  if (!current || current.revision !== presentation.revision || current.visibility === 'closing' || current.visibility === 'ended') throw new HerdrError('stale-presentation', 'Presentation changed');
  const spaces = await app.listSpaces?.();
  if (!spaces?.some(space => space.machine === null && space.id === slot.space && space.tabs.some(tab => tab.id === slot.tab))) throw new HerdrError('destination-unavailable', 'The Mac tab is unavailable');
  const local = await ports.hc.identity();
  if (presentation.mode === 'native' && presentation.target.coreId !== local.coreId) throw new HerdrError('core-mismatch', 'Native display is not on this Mac');
  let selected = presentation;
  const update = async (fields: Partial<PanePresentation>) => {
    let changed: PanePresentation | null = null;
    await ports.store.update(state => ({ ...state, presentations: state.presentations.map(current => {
      if (current.id !== selected.id || current.revision !== selected.revision || ['closing', 'ended'].includes(current.visibility)) return current;
      changed = { ...current, ...fields, revision: current.revision + 1 }; return changed;
    }) }));
    if (!changed) throw new HerdrError('stale-presentation', 'Presentation changed');
    selected = changed;
  };
  const proxyState = async (address: TerminalAddress) => {
    if (address.includes('/')) throw new HerdrError('proxy-identity', 'Mac display is not local');
    const terminal = await ports.hc.get(address);
    if (terminal.address !== address || terminal.labels['spider.kind'] !== 'pane-proxy' || terminal.labels['spider.pane-id'] !== selected.id
      || terminal.labels['spider.target-core'] !== selected.target.coreId || terminal.labels['spider.target-terminal'] !== selected.target.terminalId) throw new HerdrError('proxy-identity', 'Mac display identity changed');
    return terminal.state;
  };
  let display = selected.mode === 'proxy' ? selected.proxy : paneAddress(selected.target.terminalId);
  let launch = false;
  if (selected.mode === 'proxy') {
    if (display) {
      const state = await proxyState(display).catch(error => {
        if (selected.visibility === 'parked' && error instanceof HerdrError && error.code === 'not_found') return 'absent' as const;
        throw error;
      });
      if (state === 'finished' || state === 'absent') { display = null; launch = true; }
    } else {
      display = await ports.findProxy(selected);
      if (display) {
        if (await proxyState(display) !== 'live') throw new HerdrError('proxy-launch-uncertain', 'Proxy launch is uncertain');
      } else launch = true;
    }
  }
  if (display?.includes('/')) throw new HerdrError('display-unavailable', 'Mac display is unavailable');
  const observe = () => display ? app.ownerPlacement(display).catch(error => { if (error instanceof HerdrError && error.code === 'owner-unplaced') return null; throw error; }) : Promise.resolve(null);
  const previous = await observe();
  const sameTab = previous?.space === slot.space && previous.tab === slot.tab;
  const placeholder = sameTab ? previous! : await reserve(slot, operationId);
  if (!sameTab && !await ports.verifyPlaceholder(placeholder, operationId)) throw new HerdrError('placeholder-unavailable', 'Mac placeholder identity is unproved');
  await update({ slot: placeholder, visibility: 'visible', ...(selected.mode === 'proxy' ? { proxy: display, ...(launch ? { launch: 'claimed' as const } : {}) } : {}) });
  if (launch) {
    try {
      display = await ports.launchProxy(selected);
      if (await proxyState(display) !== 'live') throw new HerdrError('proxy-identity', 'Mac display is not live');
      await update({ proxy: display, launch: 'acknowledged' });
    } catch {
      await update({ proxy: null, launch: 'uncertain' });
      throw new HerdrError('proxy-launch-uncertain', 'Proxy launch is uncertain');
    }
  }
  if (!display) throw new HerdrError('display-unavailable', 'Mac display is unavailable');
  const command = async (name: string, args: Record<string, unknown>) => {
    const reply = await app.command(name, args);
    if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
  };
  if (previous && !sameTab) {
    await command('terminal.park', { terminal: display });
    const deadline = Date.now() + 5000;
    while (await observe()) {
      if (Date.now() >= deadline) throw new HerdrError('pane-timeout', 'The old Mac pane was not parked');
      await delay(25);
    }
  }
  if (selected.mode === 'proxy') selected = await presentProxy(selected, operationId, ports);
  else {
    if (!sameTab) {
      await command('pane.focus', { pane: placeholder.pane });
      const focused = await app.focusedPane();
      if (focused?.pane !== placeholder.pane || focused.space !== slot.space || focused.tab !== slot.tab) throw new HerdrError('focus-changed', 'Mac destination changed');
      await command('terminal.keep', { terminal: display, place: 'right' });
    }
    const actual = await ports.awaitPresented(display, selected.target, selected.slot!);
    if (actual.space !== slot.space || actual.tab !== slot.tab) throw new HerdrError('placement-mismatch', 'Native pane appeared outside its Mac tab');
    if (!sameTab && actual.pane !== placeholder.pane && await ports.verifyPlaceholder(placeholder, operationId)) await command('pane.close', { pane: placeholder.pane });
    await update({ slot: actual, launch: 'acknowledged' });
  }
  if (!selected.slot?.pane) throw new HerdrError('placement-unacknowledged', 'Mac pane is unacknowledged');
  await ports.hc.setLabels(display, { [HERDR_LABELS.space]: selected.slot.space, [HERDR_LABELS.tab]: selected.slot.tab });
  if (selected.target.sessionId && selected.role === 'agent') await rememberRemoteSessionPlacement(selected.target.sessionId, { ...selected.slot, pane: selected.slot.pane }, ports.store);
  await command('pane.focus', { pane: selected.slot.pane });
  return selected;
}
