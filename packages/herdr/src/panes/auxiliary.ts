// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomUUID } from 'node:crypto';
import { createAuxiliaryPanes, type AuxiliaryPaneActor, type AuxiliaryPaneOptions, type PaneAcquireOptions } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { ConsoleId, Generation, Owner, PaneReservation, RunId, TerminalAddress } from '../contracts.js';
import type { PaneTarget } from './types.js';
export const DISPLAY_RENEWAL_MS = 5000;
export interface PresentedAuxiliaryOptions extends AuxiliaryPaneOptions {
  ownerPresentation(owner: Owner): Promise<TerminalAddress | null>;
  /** True is an observed pane, false is a proved hide, null is unavailable. */
  observed(reservation: PaneReservation): Promise<boolean | null>;
  targetIsLive(target: PaneTarget): Promise<boolean | null>;
  /** Retry the same lease to reconcile lost replies; do not launch blindly. */
  launchTarget(kind: 'subagent' | 'console', id: RunId | ConsoleId, owner: Owner, leaseId: string): Promise<PaneTarget>;
  bindTarget(reservation: PaneReservation, target: PaneTarget, options: { observe: boolean }): Promise<void>;
  leaseMachine?(owner: Owner, target: PaneTarget | null): string;
  renew(machineKey: string, leases: { leaseId: string; generation: Generation }[]): Promise<void>;
  stop(machineKey: string, leaseId: string): Promise<void>;
  /** Console machine can differ from the owner's source machine. */
  viewMachine?(kind: 'subagent' | 'console', id: RunId | ConsoleId, owner: Owner): string;
}
export interface PresentedAuxiliaryPanes extends AuxiliaryPaneActor {
  openPresented(kind: 'subagent' | 'console', id: RunId | ConsoleId, owner: Owner, request: PaneAcquireOptions): Promise<PaneReservation | null>;
  tick(): Promise<void>;
}
interface Display {
  reservation: PaneReservation; kind: 'subagent' | 'console'; id: RunId | ConsoleId; owner: Owner;
  machine: string; leaseId: string; target: PaneTarget | null;
}
export function createPresentedAuxiliaryPanes(options: PresentedAuxiliaryOptions): PresentedAuxiliaryPanes {
  const actor = createAuxiliaryPanes(options), displays = new Map<string, Display>(), pending = new Map<string, Promise<PaneReservation | null>>();
  let disposed = false, ticking: Promise<void> | null = null;
  const key = (kind: string, id: string, owner: Owner) => JSON.stringify([kind, id, owner.sessionId, owner.generation, owner.terminal.coreId, owner.terminal.terminalId]);
  const machine = (display: Display) => options.leaseMachine?.(display.owner, display.target) ?? display.target?.coreId ?? display.machine;
  async function retire(display: Display): Promise<void> {
    await options.stop(machine(display), display.leaseId);
    await actor.release(display.reservation);
    displays.delete(key(display.kind, display.id, display.owner));
  }
  async function bind(display: Display): Promise<void> {
    // Recheck presence after reservation and before every launch or relaunch.
    if (disposed || await options.observed(display.reservation) !== true) return;
    const target = await options.launchTarget(display.kind, display.id, display.owner, display.leaseId);
    if (target.kind !== display.kind || target.sessionId !== display.owner.sessionId || target.generation !== display.owner.generation
      || display.kind === 'subagent' && target.runId !== display.id || display.kind === 'console' && target.consoleId !== display.id)
      throw new HerdrError('view-target-mismatch', 'Auxiliary view identity changed');
    display.target = target;
    if (disposed || await options.observed(display.reservation) !== true) { await retire(display); return; }
    await options.bindTarget(display.reservation, target, { observe: display.kind === 'console' });
  }
  const openPresented: PresentedAuxiliaryPanes['openPresented'] = (kind, id, owner, request) => {
    if (disposed || request.signal?.aborted || kind === 'subagent' && request.automatic && !options.automaticSubagentPanes) return Promise.resolve(null);
    const idKey = key(kind, id, owner), previous = pending.get(idKey); if (previous) return previous;
    const opening = (async () => {
      let display = displays.get(idKey);
      if (display && await options.observed(display.reservation) === false) { await retire(display); display = undefined; }
      if (!display) {
        const reservation = await actor.reservePresented(kind, id, owner, request); if (!reservation) return null;
        display = { reservation, kind, id, owner, machine: options.viewMachine?.(kind, id, owner) ?? owner.terminal.coreId, leaseId: randomUUID(), target: null };
        displays.set(idKey, display);
      }
      if (display.target && await options.targetIsLive(display.target) === false) {
        await options.stop(machine(display), display.leaseId); display.target = null; display.leaseId = randomUUID();
      }
      if (!display.target) await bind(display);
      return disposed || request.signal?.aborted ? null : display.reservation;
    })().finally(() => { if (pending.get(idKey) === opening) pending.delete(idKey); });
    pending.set(idKey, opening); return opening;
  };
  const tick = (): Promise<void> => {
    if (disposed) return Promise.resolve(); if (ticking) return ticking;
    ticking = (async () => {
      const batches = new Map<string, {leaseId: string; generation: Generation}[]>();
      for (const display of [...displays.values()]) {
        if (pending.has(key(display.kind, display.id, display.owner))) continue;
        try {
          const observed = await options.observed(display.reservation);
          if (observed === false) { await retire(display); continue; } if (observed !== true) continue;
          if (display.target && await options.targetIsLive(display.target) === false) {
            await options.stop(machine(display), display.leaseId); display.target = null; display.leaseId = randomUUID();
          }
          if (!display.target) await bind(display);
          if (!display.target || !displays.has(key(display.kind, display.id, display.owner))) continue;
          const name = machine(display), batch = batches.get(name) ?? [];
          batch.push({ leaseId: display.leaseId, generation: display.owner.generation }); batches.set(name, batch);
        } catch (error) { options.reportError?.(error); }
      }
      await Promise.all([...batches].map(async ([name, leases]) => { try { await options.renew(name, leases); } catch (error) { options.reportError?.(error); } }));
    })().finally(() => { ticking = null; });
    return ticking;
  };
  const timer = setInterval(() => { void tick(); }, DISPLAY_RENEWAL_MS); timer.unref();
  return { ...actor, openPresented, tick,
    async release(reservation) {
      const display = [...displays.values()].find(display => display.reservation === reservation);
      if (display) await retire(display); else await actor.release(reservation);
    },
    async park(runId) {
      for (const display of [...displays.values()]) if (display.kind === 'subagent' && display.id === runId) await retire(display);
      await actor.park(runId);
    },
    async dispose() {
      disposed = true; clearInterval(timer); await ticking; await Promise.allSettled([...pending.values()]);
      const errors: unknown[] = [];
      for (const display of [...displays.values()]) { try { await retire(display); } catch (error) { errors.push(error); } }
      await actor.dispose(); if (errors.length) throw new AggregateError(errors, 'Some source views could not be stopped; their leases will expire');
    },
  };
}
