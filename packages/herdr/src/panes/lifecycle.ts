// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { AppClient, HcClient, TerminalAddress, TerminalSummary } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import type { PaneActionOutcome, PanePlacementStore, PanePresentation, PaneTarget } from './types.js';
export interface PaneLifecyclePorts {
  store: PanePlacementStore; hc: HcClient; app: AppClient | null;
  validateTarget(target: PaneTarget, cause: 'open' | 'handoff' | 'close'): Promise<PaneTarget>;
  /** Atomically validate generation/home and persist supervised stopped intent before normal session shutdown. */
  closeSession(target: PaneTarget, operationId: string): Promise<'ended' | 'pending' | 'stale'>;
}
export function samePaneTarget(a: PaneTarget, b: PaneTarget): boolean {
  return a.coreId === b.coreId && a.terminalId === b.terminalId && a.address === b.address && a.createdMs === b.createdMs &&
    a.kind === b.kind && a.sessionId === b.sessionId && a.generation === b.generation && a.homeEpoch === b.homeEpoch && a.runId === b.runId && a.consoleId === b.consoleId &&
    Object.keys(a.identityLabels).length === Object.keys(b.identityLabels).length && Object.entries(a.identityLabels).every(([key, value]) => b.identityLabels[key] === value);
}
const result = (status: PaneActionOutcome['status'], reason: string, presentation: PanePresentation | null): PaneActionOutcome => ({ status, reason, presentation });
const stale = (presentation: PanePresentation | null) => result('refused', 'Session changed. Close again.', presentation);
async function read(id: string, ports: PaneLifecyclePorts): Promise<PanePresentation | null> { return (await ports.store.read()).presentations.find(p => p.id === id) ?? null; }
async function transition(p: PanePresentation, fields: Partial<PanePresentation>, ports: PaneLifecyclePorts): Promise<PanePresentation | null> {
  let updated: PanePresentation | null = null;
  await ports.store.update(state => ({ ...state, presentations: state.presentations.map(current => {
    if (current.id !== p.id || current.revision !== p.revision || !samePaneTarget(current.target, p.target)) return current;
    updated = { ...current, ...fields, revision: current.revision + 1 }; return updated;
  }) }));
  return updated;
}
async function validate(target: PaneTarget, ports: PaneLifecyclePorts): Promise<boolean> {
  if (target.createdMs <= 0 || Object.keys(target.identityLabels).length === 0 || target.kind !== 'terminal' && target.generation === null) return false;
  return samePaneTarget(target, await ports.validateTarget(target, 'close'));
}
export async function confirmPresentationClose(input: { id: string; expectedRevision: number; operationId: string; target: PaneTarget }, ports: PaneLifecyclePorts): Promise<PaneActionOutcome> {
  const p = await read(input.id, ports);
  if (!p || p.revision !== input.expectedRevision || !samePaneTarget(p.target, input.target)) return stale(p);
  if (p.mode !== 'proxy' || p.visibility === 'ended') return result('refused', 'native-close-required', p);
  if (p.visibility === 'closing') return p.closeOperationId === input.operationId ? reconcilePendingClose(p.id, ports) : stale(p);
  try { if (!await validate(p.target, ports)) return stale(p); }
  catch { return result('pending', 'target-validation-unavailable', p); }
  const closing = await transition(p, { visibility: 'closing', closeOperationId: input.operationId, conversion: null }, ports);
  if (!closing) return stale(await read(input.id, ports));
  return reconcilePendingClose(input.id, ports);
}
export async function reconcilePendingClose(id: string, ports: PaneLifecyclePorts): Promise<PaneActionOutcome> {
  const p = await read(id, ports);
  if (!p || p.visibility !== 'closing' || !p.closeOperationId) return result('refused', 'no-confirmed-close-intent', p);
  try {
    if (!await validate(p.target, ports)) return stale(p);
    if (p.target.kind === 'session') {
      const observed = await ports.hc.get(p.target.address);
      if (observed.address !== p.target.address || !Object.entries(p.target.identityLabels).every(([key, value]) => observed.labels[key] === value)) return stale(p);
      const outcome = observed.state === 'finished' ? 'ended' : await ports.closeSession(p.target, p.closeOperationId);
      if (outcome === 'stale') return stale(p);
      if (outcome === 'pending') return result('pending', 'close-pending', p);
    } else {
      // Each get/kill uses the captured qualified address, never its routing alias.
      const terminal = await ports.hc.get(p.target.address);
      if (terminal.address !== p.target.address || !Object.entries(p.target.identityLabels).every(([key, value]) => terminal.labels[key] === value)) return stale(p);
      if (terminal.state !== 'finished') {
        if (!await validate(p.target, ports)) return stale(p);
        await ports.hc.kill(p.target.address);
        if (!await validate(p.target, ports)) return stale(p);
        const after = await ports.hc.get(p.target.address);
        if (after.address !== p.target.address || after.state !== 'finished' || !Object.entries(p.target.identityLabels).every(([key, value]) => after.labels[key] === value)) return result('pending', 'close-pending', p);
      }
    }
    const ended = await transition(p, { visibility: 'ended' }, ports);
    if (ended && p.target.kind === 'terminal') await ports.hc.rm(p.target.address);
    return ended ? result('complete', 'target-ended', ended) : stale(await read(id, ports));
  } catch { return result('pending', 'close-pending', await read(id, ports)); }
}
async function ownedProxy(p: PanePresentation, ports: PaneLifecyclePorts): Promise<TerminalSummary | 'absent' | null> {
  if (!p.proxy) return null;
  const local = await ports.hc.identity();
  if (p.proxy.includes('/') && !p.proxy.startsWith(`${local.coreId}/`)) return null;
  let terminal: TerminalSummary;
  try { terminal = await ports.hc.get(p.proxy); }
  catch (error) { if (error instanceof HerdrError && error.code === 'not_found') return 'absent'; throw error; }
  if (terminal.address !== p.proxy) return null;
  const labels = terminal.labels;
  const generic = labels['spider.kind'] === 'pane-proxy' && labels['spider.pane-id'] === p.id;
  const legacy = labels['spider.kind'] === 'roam-proxy' && labels['spider.session'] === p.target.sessionId && labels['spider.owner-core'] === p.target.coreId && labels['spider.owner-terminal']?.split('/').at(-1) === p.target.terminalId;
  return generic || legacy ? terminal : null;
}
export async function parkPresentation(id: string, expectedRevision: number, ports: PaneLifecyclePorts): Promise<PaneActionOutcome> {
  const p = await read(id, ports);
  if (!p || p.revision !== expectedRevision) return result('refused', 'stale-presentation', p);
  if (p.visibility === 'closing') return stale(p);
  const parked = p.visibility === 'parked' ? p : await transition(p, { visibility: 'parked', conversion: null }, ports);
  if (!parked) return result('refused', 'stale-presentation', await read(id, ports));
  if (!p.proxy || p.mode === 'native') return result('complete', 'parked', parked);
  if (!ports.app) return result('pending', 'park-removal-pending', parked);
  try {
    const proxy = await ownedProxy(parked, ports); if (!proxy) return result('pending', 'proxy-identity-unavailable', parked);
    if (proxy !== 'absent') {
      const reply = await ports.app.command('terminal.park', { terminal: p.proxy });
      if (reply.error) return result('pending', 'park-removal-pending', parked);
    }
    if (!p.slot || (await ports.app.tabTerminals(p.slot)).includes(p.proxy)) return result('pending', 'park-removal-pending', parked);
    // A late revision or a reopened pane cancels cleanup of its new presentation.
    const current = await read(id, ports); if (!current || current.revision !== parked.revision || current.visibility !== 'parked') return result('pending', 'presentation-changed', current);
    if (proxy === 'absent') return result('complete', 'parked', parked);
    try {
      const again = await ownedProxy(parked, ports);
      if (again === 'absent') return result('complete', 'parked', parked);
      if (again?.state === 'live') await ports.hc.kill(p.proxy);
      const finished = await ownedProxy(parked, ports);
      if (finished === 'absent') return result('complete', 'parked', parked);
      if (finished?.state !== 'finished') return result('pending', 'park-removal-pending', parked);
      await ports.hc.rm(p.proxy);
    } catch (error) {
      // The auxiliary actor can finish removal after our ownership and unplacement proofs.
      if (!(error instanceof HerdrError) || error.code !== 'not_found') throw error;
    }
    return result('complete', 'parked', parked);
  } catch { return result('pending', 'park-removal-pending', parked); }
}
const coreLoss = new Set(['server_stop', 'host_shutdown', 'holder_lost']);
export async function reconcilePresentationExit(presentation: PanePresentation, terminal: TerminalSummary | null, ports: PaneLifecyclePorts): Promise<PaneActionOutcome> {
  const p = await read(presentation.id, ports);
  if (!p || !samePaneTarget(p.target, presentation.target)) return result('refused', 'stale-presentation', p);
  if (p.visibility === 'closing') return reconcilePendingClose(p.id, ports);
  if (!terminal || terminal.state === 'live' || coreLoss.has(terminal.reason ?? '') || p.mode !== 'proxy') return result('pending', 'presentation-retained', p);
  if (!p.proxy || terminal.address !== p.proxy) return result('refused', 'proxy-identity-unavailable', p);
  if (p.visibility === 'parked' || p.visibility === 'ended') return result('complete', p.visibility, p);
  let finished = false;
  try {
    if (p.target.createdMs > 0 && samePaneTarget(p.target, await ports.validateTarget(p.target, 'open'))) {
      const target = await ports.hc.get(p.target.address);
      finished = target.address === p.target.address && target.state === 'finished' && Object.entries(p.target.identityLabels).every(([key, value]) => target.labels[key] === value);
    }
  } catch { /* Unavailable source evidence never grants target-stop authority. */ }
  const updated = await transition(p, { visibility: finished ? 'ended' : 'parked', conversion: null }, ports);
  return updated ? result('complete', finished ? 'target-ended' : `Pane closed; still running on ${p.target.alias ?? 'Machine unavailable'}`, updated) : result('refused', 'stale-presentation', await read(p.id, ports));
}
