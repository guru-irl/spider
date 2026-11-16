// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { AppClient, HcClient } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { paneSnapshot } from './snapshot.js';
import { prunePaneHistory } from './retention.js';
import { encodePaneServiceRequest, parsePaneServiceRequest } from './codec.js';
import { createPaneServiceInventory } from './inventory.js';
import { confirmPresentationClose, parkPresentation, reconcilePendingClose, reconcilePresentationExit, samePaneTarget, type PaneLifecyclePorts } from './lifecycle.js';
import type { AppPaneCapabilities, FolderMapPort, MachineChoice, PaneActionOutcome, PaneAgentRow, PaneInventoryPage, PanePlacementStore, PanePresentation, PaneServiceReply, PaneServiceRequest, PaneTerminalFacts } from './types.js';
export interface PaneService {
  request(input: PaneServiceRequest): Promise<PaneServiceReply>;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}
export type PaneMutation = Exclude<PaneServiceRequest, { op: 'snapshot' }>;
export interface PrivatePaneInventory { rows: readonly PaneAgentRow[]; complete: boolean; stale: boolean }
export interface PaneServicePorts extends Pick<PaneLifecyclePorts, 'validateTarget' | 'closeSession'> {
  root: string; store: PanePlacementStore; hc: HcClient; app: AppClient | null;
  folderMap?: FolderMapPort;
  coreAvailable(): Promise<boolean>;
  clock(): number;
  machines(): Promise<readonly MachineChoice[]>;
  inventory(machine: MachineChoice, signal: AbortSignal, cursor?: string | null): Promise<PaneInventoryPage>;
  reconcileInventory?(inventory: PrivatePaneInventory): Promise<void>;
  targetFacts(presentations: readonly PanePresentation[], signal: AbortSignal): Promise<Readonly<Record<string, PaneTerminalFacts>>>;
  renewLeases(machine: MachineChoice, signal: AbortSignal): Promise<void>;
  appCapabilities(): Promise<AppPaneCapabilities>;
  subscribe(changed: () => void): () => void;
  schedule(tick: () => void, ms: number): () => void;
  /** Source-owned operations, including generation and home validation, are injected. */
  dispatch(input: PaneMutation, beforeLaunch: () => Promise<void>, inventory: PrivatePaneInventory): Promise<PaneActionOutcome>;
}
const outcome = (reason: string): PaneServiceReply => ({ version: 1, kind: 'outcome', outcome: { status: 'refused', reason, presentation: null } });
export function createPaneService(ports: PaneServicePorts): PaneService {
  let stopped = false;
  let machines: readonly MachineChoice[] = [];
  let facts: Readonly<Record<string, PaneTerminalFacts>> = {};
  const inventories = new Map<string, PrivatePaneInventory>();
  const retry = new Map<string, { after: number; failures: number }>();
  const pending = new Map<string, Promise<void>>();
  const replay = new Map<string, { bytes: string; reply: Promise<PaneServiceReply>; settledAt: number | null }>();
  const pruneReplay = () => {
    const cutoff = ports.clock() - 60000;
    for (const [id, entry] of replay) if (entry.settledAt !== null && entry.settledAt <= cutoff) replay.delete(id);
  };
  let queue = Promise.resolve();
  let refreshing: Promise<void> | null = null;
  let leaseTick = -Infinity;
  const abort = new AbortController();
  const readInventory = createPaneServiceInventory({ root: ports.root, readPage: ports.inventory, clock: ports.clock });
  const lifecycle: PaneLifecyclePorts = { store: ports.store, hc: ports.hc, app: ports.app, validateTarget: ports.validateTarget, closeSession: ports.closeSession };
  async function live() {
    if (stopped) throw new HerdrError('service-stopped', 'Presentation service stopped');
    if (!await ports.coreAvailable()) throw new HerdrError('core-unavailable', 'Selected core is unavailable');
    await ports.hc.identity();
  }
  async function bounded<T>(effect: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const cancellation = new AbortController();
    const onAbort = () => cancellation.abort(); abort.signal.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([effect(cancellation.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { cancellation.abort(); reject(new HerdrError('pane-timeout', 'Pane endpoint deadline exceeded')); }, 5000);
        cancellation.signal.addEventListener('abort', () => reject(new HerdrError('aborted', 'Pane endpoint cancelled')), { once: true });
      })]);
    } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort); }
  }
  function unreachable(key: string) {
    const old = inventories.get(key);
    if (old) inventories.set(key, { ...old, complete: false, stale: true, rows: old.rows.map(row => ({ ...row, status: 'unreachable' })) });
  }
  async function refresh(machine: MachineChoice) {
    const connected = machine.state === 'connected' && !!machine.coreId;
    // Retry throttling applies only to connected machines; a disconnected one still reads its cache.
    if (connected && (retry.get(machine.key)?.after ?? 0) > ports.clock()) return;
    const running = pending.get(machine.key); if (running) return running;
    const operation = (async () => {
      try {
        // The adapter walks every page within its bounds, persists complete snapshots, and returns
        // the cached rows marked unreachable when the machine is disconnected or the read fails.
        const snapshot = await readInventory(machine, abort.signal);
        if (!connected && snapshot.rows.length === 0 && inventories.has(machine.key)) unreachable(machine.key);
        else inventories.set(machine.key, { rows: snapshot.rows, complete: snapshot.complete, stale: snapshot.stale });
        if (connected && snapshot.stale) {
          const failures = (retry.get(machine.key)?.failures ?? 0) + 1;
          retry.set(machine.key, { failures, after: ports.clock() + Math.min(1000 * 2 ** Math.min(failures - 1, 4), 10000) });
        } else retry.delete(machine.key);
      } catch {
        unreachable(machine.key);
      } finally { pending.delete(machine.key); }
    })();
    pending.set(machine.key, operation); return operation;
  }
  async function pruneHistory(checkTargets: boolean) {
    const state = await ports.store.read(), removed: PanePresentation[] = [];
    if (checkTargets) {
      let index = 0;
      const cancellation = new AbortController(), timer = setTimeout(() => cancellation.abort(), 5000);
      const signal = AbortSignal.any([abort.signal, cancellation.signal]);
      try { await Promise.all(Array.from({ length: Math.min(4, state.presentations.length) }, async () => {
        while (index < state.presentations.length && !signal.aborted) {
          const p = state.presentations[index++];
          if (p.visibility === 'closing' || p.visibility === 'ended' || p.target.createdMs <= 0 || p.conversion) continue;
          const machine = machines.find(machine => machine.coreId === p.target.coreId);
          if (machine?.state !== 'connected') continue;
          const source = inventories.get(machine.key);
          if (!source?.complete || source.stale) continue;
          if (source.rows.some(row => row.target?.coreId === p.target.coreId && row.target.terminalId === p.target.terminalId && row.target.createdMs !== p.target.createdMs)) { removed.push(p); continue; }
          const key = `${p.target.coreId}/${p.target.terminalId}`;
          try {
            const cached = facts[key];
            const terminal = cached?.createdMs === p.target.createdMs ? cached.terminal : await ports.hc.get(p.target.address, { signal });
            if (terminal.state === 'finished') removed.push(p);
          } catch (error) {
            if (error instanceof HerdrError && error.code === 'not_found') removed.push(p);
          }
        }
      })); } finally { clearTimeout(timer); }
    }
    if (removed.length || state.presentations.some(p => p.visibility === 'ended')) await ports.store.update(current => prunePaneHistory(current, removed));
  }
  function reconcile(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      await live(); await pruneHistory(false); machines = await ports.machines();
      const renew = ports.clock() - leaseTick >= 5000;
      if (renew) leaseTick = ports.clock();
      await Promise.all(machines.map(async machine => {
        await refresh(machine);
        if (renew && machine.state === 'connected') await bounded(signal => ports.renewLeases(machine, signal)).catch(() => {});
      }));
      await ports.reconcileInventory?.(privateInventory());
      try { facts = await ports.targetFacts((await ports.store.read()).presentations.filter(p => p.visibility === 'visible'), abort.signal); } catch { /* Keep the last verified display facts. */ }
      const before = await ports.store.read();
      for (const p of before.presentations) {
        if (p.visibility === 'closing' || p.visibility === 'ended' || p.target.createdMs > 0 && (p.target.kind === 'terminal' || p.target.generation !== null)) continue;
        try {
          const target = await bounded(() => ports.validateTarget(p.target, 'open'));
          if (target.coreId !== p.target.coreId || target.terminalId !== p.target.terminalId || target.address !== p.target.address || target.sessionId !== p.target.sessionId || target.createdMs <= 0 || target.kind !== p.target.kind || target.kind !== 'terminal' && target.generation === null || p.target.generation !== null && target.generation !== p.target.generation || p.target.homeEpoch !== null && target.homeEpoch !== p.target.homeEpoch || !Object.entries(p.target.identityLabels).every(([key, value]) => target.identityLabels[key] === value)) continue;
          await ports.store.update(state => ({ ...state, presentations: state.presentations.map(current => current.id === p.id && current.revision === p.revision ? { ...current, target, revision: current.revision + 1 } : current) }));
        } catch { /* Legacy facts remain unverified until their exact source confirms them. */ }
      }
      const state = await ports.store.read();
      for (const p of state.presentations) {
        if (p.visibility === 'closing') await reconcilePendingClose(p.id, lifecycle);
        else if (p.mode === 'proxy' && p.visibility === 'visible' && p.proxy) {
          const terminal = await ports.hc.get(p.proxy).catch(() => null);
          await reconcilePresentationExit(p, terminal, lifecycle);
        }
      }
      await pruneHistory(true);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  const privateInventory = (): PrivatePaneInventory => {
    const active = machines.map(machine => inventories.get(machine.key));
    const complete = machines.length > 0 && machines.every((machine, i) => machine.state === 'connected' && active[i]?.complete === true);
    return { rows: active.flatMap(page => page?.rows ?? []), complete, stale: !complete || active.some(page => page?.stale) };
  };
  async function apply(request: PaneServiceRequest): Promise<PaneServiceReply> {
    await live();
    if (request.op === 'snapshot') {
      if (!machines.length) machines = await ports.machines();
      const state = await ports.store.read();
      void reconcile().catch(() => {});
      return paneSnapshot(state, machines, privateInventory(), facts);
    }
    const state = await ports.store.read();
    if ('presentationId' in request) {
      const current = state.presentations.find(p => p.id === request.presentationId);
      if (!current || current.revision !== request.expectedRevision) return outcome('stale-presentation');
      if (request.op === 'open-existing' && (current.target.coreId !== request.targetIncarnation.coreId || current.target.terminalId !== request.targetIncarnation.terminalId || current.target.createdMs !== request.targetIncarnation.createdMs || current.target.kind !== 'terminal')) return outcome('stale-presentation');
      if (current.visibility === 'closing' && request.op !== 'close-confirmed') return outcome('Session changed. Close again.');
      if (request.op === 'present-ready') {
        try {
          const verified = await bounded(() => ports.validateTarget(request.target, 'handoff'));
          if (verified.createdMs <= 0 || !samePaneTarget(verified, request.target) || current.target.sessionId !== null && verified.sessionId !== current.target.sessionId) return outcome('readiness-unverified');
        } catch { return { version: 1, kind: 'outcome', outcome: { status: 'pending', reason: 'readiness-unavailable', presentation: current } }; }
      }
      if (request.op === 'prepare-handoff') {
        try {
          const verified = await bounded(() => ports.validateTarget(current.target, 'handoff'));
          if (verified.createdMs <= 0 || !samePaneTarget(verified, current.target) || verified.sessionId !== request.sessionId || verified.generation !== request.generation || verified.homeEpoch !== request.homeEpoch) return outcome('handoff-unverified');
        } catch { return { version: 1, kind: 'outcome', outcome: { status: 'pending', reason: 'handoff-unavailable', presentation: current } }; }
      }
    }
    const beforeLaunch = async () => {
      if (request.op !== 'open') return;
      const current = (await ports.machines()).find(machine => machine.key === request.machineKey);
      if (!current || current.state !== 'connected' || current.coreId !== request.coreId || current.machineId !== request.machineId) throw new HerdrError('machine-changed', 'Selected machine changed');
    };
    try { await beforeLaunch(); } catch { return outcome('machine-changed'); }
    let result: PaneActionOutcome;
    try { result = request.op === 'park' ? await parkPresentation(request.presentationId, request.expectedRevision, lifecycle)
      : request.op === 'close-confirmed' ? await confirmPresentationClose({ id: request.presentationId, expectedRevision: request.expectedRevision, operationId: request.operationId, target: request.target }, lifecycle)
      : await ports.dispatch(request, beforeLaunch, privateInventory());
    } catch (error) { if (error instanceof HerdrError) return outcome(error.code); throw error; }
    void reconcile().catch(() => {});
    return { version: 1, kind: 'outcome', outcome: result };
  }
  async function response(reply: Promise<PaneServiceReply>): Promise<PaneServiceReply> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([reply, new Promise<PaneServiceReply>(resolve => {
        timer = setTimeout(() => resolve({ version: 1, kind: 'outcome', outcome: { status: 'pending', reason: 'operation-in-progress', presentation: null } }), 4000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const unsubscribe = ports.subscribe(() => { void reconcile().catch(() => {}); });
  const cancelTimer = ports.schedule(() => { void reconcile().catch(() => {}); }, 5000);
  return {
    request(input) {
      const request = parsePaneServiceRequest(input); const bytes = encodePaneServiceRequest(request);
      if (request.op === 'snapshot') return apply(request);
      pruneReplay();
      const previous = replay.get(request.operationId);
      if (previous) return previous.bytes === bytes ? response(previous.reply) : Promise.resolve(outcome('operation-reused'));
      // In-flight and recent actions must retain their replay evidence.
      if (replay.size >= 4096) return Promise.resolve(outcome('service-operation-limit'));
      const reply = queue.then(() => apply(request)); queue = reply.then(() => {}, () => {});
      const entry = { bytes, reply, settledAt: null as number | null };
      replay.set(request.operationId, entry);
      void reply.then(() => { entry.settledAt = ports.clock(); }, () => { entry.settledAt = ports.clock(); });
      return response(reply);
    }, reconcile,
    async stop() { if (stopped) return; stopped = true; abort.abort(); unsubscribe(); cancelTimer(); await queue; await refreshing?.catch(() => {}); },
  };
}
