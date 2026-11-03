// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { setTimeout as delay } from 'node:timers/promises';
import type { AppClient, HcClient, IpcMoveDestination, OwnerPlacement, TerminalAddress } from '../contracts.js';
import { HERDR_LABELS } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { withProcessLock } from '../sessions/registry.js';
import { moveTerminal } from '../../assets/agents/move.js';
import { recordSessionMove, type LayoutSnapshot } from './setup.js';

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
