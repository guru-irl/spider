// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { afterEach, expect, test, vi } from 'vitest';
import { HerdrError } from '../client/parse.js';
import { selectRemoteSessionSlot } from '../spaces/remote-placement.js';
import { createPaneService, type PaneServicePorts } from '../panes/service.js';
import { createPanePlacementStore } from '../panes/store.js';
import { parseMachineChoice, parsePanePresentation } from '../panes/codec.js';
import type { HcClient } from '../contracts.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const base = join(paths.scratch('worktree', process.cwd()), 'b3', 'service'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 's-')); roots.push(root);
  const store = createPanePlacementStore(join(root, 'roam', 'placement'));
  const presentation = parsePanePresentation({ id: 'p1', revision: 1, mode: 'proxy', role: 'agent', target: { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', createdMs: 17, identityLabels: { 'spider.session': 'session-1' }, alias: 'box-1.invalid', machineId: null, kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 2, runId: null, consoleId: null, name: 'Example', cwd: '/home/example/work' }, proxy: 'core-local/t8', slot: null, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null });
  await store.update(s => ({ ...s, presentations: [presentation] }));
  let tick: (() => void) | null = null;
  const hc = { identity: vi.fn(async () => ({ coreId: 'core-local', socket: '/unused', sessionNamespace: 'test' })), get: vi.fn(async (address: string) => ({ address, state: 'live' })), kill: vi.fn() } as unknown as HcClient;
  const ports: PaneServicePorts = {
    root: join(root, 'herdr', 'panes'), store, hc, app: null,
    coreAvailable: vi.fn(async () => true), clock: () => 0,
    validateTarget: vi.fn(async target => target), closeSession: vi.fn(async () => 'ended' as const),
    machines: vi.fn(async () => [parseMachineChoice({ key: 'box-1.invalid', alias: 'box-1.invalid', label: 'box-1.invalid', coreId: 'core-remote', machineId: null, state: 'connected' })]),
    inventory: vi.fn(async () => ({ version: 1 as const, rows: [], next: null, complete: true })),
    targetFacts: vi.fn(async () => ({})), renewLeases: vi.fn(async () => {}),
    appCapabilities: vi.fn(async () => ({ backgroundTabCreation: false, explicitTargetSwap: false, noFocusConversion: false, commandDigest: 'a'.repeat(64) })),
    subscribe: vi.fn(() => () => {}), schedule: cb => { tick = cb; return () => { tick = null; }; },
    dispatch: vi.fn(async () => ({ status: 'complete' as const, reason: 'applied', presentation })),
  };
  return { ports, hc, presentation, tick: () => tick?.() };
}
test('absent core makes zero hc calls', async () => {
  const f = await fixture(); vi.mocked(f.ports.coreAvailable).mockResolvedValue(false);
  const service = createPaneService(f.ports);
  await expect(service.request({ version: 1, op: 'snapshot', operationId: 's1' })).rejects.toThrow(/core/i);
  expect(f.hc.identity).not.toHaveBeenCalled(); expect(f.ports.machines).not.toHaveBeenCalled(); await service.stop();
});
test('socket refuses oversized or stale mutation', async () => {
  const f = await fixture(); const service = createPaneService(f.ports);
  const result = await service.request({ version: 1, op: 'park', operationId: 'park1', presentationId: 'p1', expectedRevision: 0 });
  expect(result).toMatchObject({ kind: 'outcome', outcome: { status: 'refused', reason: 'stale-presentation' } });
  expect(f.ports.dispatch).not.toHaveBeenCalled(); await service.stop();
});
test('service park persists intent even when the app is absent', async () => {
  const f = await fixture(); const service = createPaneService(f.ports);
  const result = await service.request({ version: 1, op: 'park', operationId: 'park1', presentationId: 'p1', expectedRevision: 1 });
  expect(result).toMatchObject({ outcome: { status: 'pending', presentation: { visibility: 'parked' } } });
  expect((await f.ports.store.read()).presentations[0].visibility).toBe('parked');
  await service.stop();
});
test('replayed operation IDs share one effect and changed payload refuses', async () => {
  const f = await fixture(); const service = createPaneService(f.ports);
  const request = { version: 1 as const, op: 'move' as const, operationId: 'move1', presentationId: 'p1', expectedRevision: 1, slot: { space: 'space-1' as never, tab: 'tab-1' as never, pane: null } };
  const [a, b] = await Promise.all([service.request(request), service.request(request)]);
  expect(a).toEqual(b); expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  expect(await service.request({ ...request, expectedRevision: 2 })).toMatchObject({ outcome: { status: 'refused', reason: 'operation-reused' } }); await service.stop();
});
test('settled action replies expire so the 4097th action still works', async () => {
  const f = await fixture(); let now = 0;
  f.ports.clock = () => now;
  const state = await f.ports.store.read();
  f.ports.store = { read: async () => state, update: async change => change(state) };
  const service = createPaneService(f.ports);
  try {
    for (let i = 0; i < 4097; i++) {
      now = i * 1000;
      expect(await service.request({ version: 1, op: 'park', operationId: `expired-${i}`, presentationId: 'missing', expectedRevision: 1 }))
        .toMatchObject({ outcome: { status: 'refused', reason: 'stale-presentation' } });
    }
  } finally { await service.stop(); }
});
test('in-flight actions retain replay protection beyond the replay window', async () => {
  const f = await fixture(); let now = 0, finish!: () => void;
  f.ports.clock = () => now;
  const result = { status: 'complete' as const, reason: 'moved', presentation: f.presentation };
  f.ports.dispatch = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; }); return result; });
  const service = createPaneService(f.ports);
  const request = { version: 1 as const, op: 'move' as const, operationId: 'slow-move', presentationId: 'p1', expectedRevision: 1, slot: { space: 's1' as never, tab: 'tb1' as never, pane: null } };
  const first = service.request(request);
  await vi.waitFor(() => expect(f.ports.dispatch).toHaveBeenCalledTimes(1));
  now = 120001;
  const retry = service.request(request);
  expect(await service.request({ ...request, expectedRevision: 2 })).toMatchObject({ outcome: { reason: 'operation-reused' } });
  finish(); expect(await retry).toEqual(await first);
  now += 59000;
  expect(await service.request(request)).toMatchObject({ outcome: { reason: 'moved' } });
  expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  await service.stop();
});
test('changed readiness target refuses before dispatch', async () => {
  const f = await fixture(); vi.mocked(f.ports.validateTarget).mockResolvedValue({ ...f.presentation.target, homeEpoch: 4 }); const service = createPaneService(f.ports);
  const result = await service.request({ version: 1, op: 'present-ready', operationId: 'ready1', presentationId: 'p1', expectedRevision: 1, target: { ...f.presentation.target, homeEpoch: 3 } });
  expect(result).toMatchObject({ outcome: { status: 'refused', reason: 'readiness-unverified' } }); expect(f.ports.dispatch).not.toHaveBeenCalled(); await service.stop();
});
test('handoff checks current source generation and home before dispatch', async () => {
  const f = await fixture(); const service = createPaneService(f.ports);
  const result = await service.request({ version: 1, op: 'prepare-handoff', operationId: 'handoff1', presentationId: 'p1', expectedRevision: 1, sessionId: 'session-1' as never, generation: 'gen-2' as never, homeEpoch: 2 });
  expect(result).toMatchObject({ outcome: { status: 'refused', reason: 'handoff-unverified' } }); expect(f.ports.dispatch).not.toHaveBeenCalled(); await service.stop();
});
test('legacy source validation enriches facts without reopening parked or uncertain claims', async () => {
  const f = await fixture(); const legacy = { ...f.presentation, visibility: 'parked' as const, target: { ...f.presentation.target, createdMs: 0, generation: null, homeEpoch: null } };
  const attempts = [{ session: 'session-1', remote: 'box-1.invalid/t7', core: 'core-remote', proxy: null, closed: false, localOwners: ['owner-1'] }];
  await f.ports.store.update(s => ({ ...s, presentations: [legacy], attempts })); vi.mocked(f.ports.validateTarget).mockResolvedValue(f.presentation.target);
  const service = createPaneService(f.ports); await service.reconcile(); const state = await f.ports.store.read();
  expect(state.presentations[0]).toMatchObject({ visibility: 'parked', target: { createdMs: 17, generation: 'gen-1', homeEpoch: 2 } });
  expect(state.attempts).toEqual(attempts); expect(f.ports.dispatch).not.toHaveBeenCalled(); expect(f.hc.kill).not.toHaveBeenCalled(); await service.stop();
});
test('shutdown with live targets stops subscriptions not targets', async () => {
  const f = await fixture(); const service = createPaneService(f.ports); await service.reconcile(); await service.stop();
  expect(f.hc.kill).not.toHaveBeenCalled(); await expect(service.request({ version: 1, op: 'snapshot', operationId: 's1' })).rejects.toThrow(/stopped/);
});
test('disconnected machines mark their previously working agents unreachable', async () => {
  const f = await fixture(); const target = f.presentation.target;
  const row = { sessionId: 'session-1', generation: 'gen-1', name: 'Example', status: 'working', updatedAt: 1, machineKey: 'box-1.invalid', unavailableReason: null, target,
    owner: { sessionId: 'session-1', generation: 'gen-1', terminal: { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', socket: '/unused', sessionNamespace: 'test' }, cwd: '/home/example', sessionFile: null, name: 'Example' }, children: [], consoles: [] };
  f.ports.inventory = vi.fn(async () => ({ version: 1, rows: [row] as never, next: null, complete: true }));
  const service = createPaneService(f.ports); await service.reconcile();
  expect(await service.request({ version: 1, op: 'snapshot', operationId: 'connected' })).toMatchObject({ rows: [{ status: 'working' }] });
  const machine = (await f.ports.machines())[0]; vi.mocked(f.ports.machines).mockResolvedValue([{ ...machine, state: 'disconnected' }]);
  await service.reconcile();
  expect(await service.request({ version: 1, op: 'snapshot', operationId: 'disconnected' })).toMatchObject({ complete: false, rows: [{ status: 'unreachable' }] });
  await service.stop();
});
test('inventory refresh is single flight and unreachable machines back off', async () => {
  const f = await fixture(); let complete!: () => void;
  vi.mocked(f.ports.inventory).mockImplementation(async () => { await new Promise<void>(r => { complete = r; }); throw Error('unreachable'); });
  const service = createPaneService(f.ports); const first = service.reconcile();
  await vi.waitFor(() => expect(f.ports.inventory).toHaveBeenCalledTimes(1));
  const second = service.reconcile(); complete(); await Promise.all([first, second]); await service.reconcile();
  expect(f.ports.inventory).toHaveBeenCalledTimes(1); expect(f.ports.renewLeases).toHaveBeenCalledTimes(1); await service.stop();
});

const identityOpen = { version: 1 as const, op: 'open' as const, operationId: 'identity-open', machineKey: 'box-1.invalid', coreId: 'core-remote' as never, machineId: null,
  intent: { operationId: 'identity-open', space: 'space-1' as never, place: 'tab' as const, anchor: null, program: { kind: 'shell' as const } } };
test.each(['coreId', 'machineId'] as const)('open refuses a changed %s before dispatch', async field => {
  const f = await fixture(); const original = (await f.ports.machines())[0];
  vi.mocked(f.ports.machines).mockResolvedValue([{ ...original, [field]: 'replacement' }]);
  const service = createPaneService(f.ports);
  expect(await service.request(identityOpen)).toMatchObject({ outcome: { status: 'refused', reason: 'machine-changed' } });
  expect(f.ports.dispatch).not.toHaveBeenCalled(); await service.stop();
});
test.each(['coreId', 'machineId'] as const)('open rechecks %s immediately before launch', async field => {
  const f = await fixture(); const original = (await f.ports.machines())[0]; const launch = vi.fn();
  f.ports.dispatch = async (_request, beforeLaunch) => {
    vi.mocked(f.ports.machines).mockResolvedValue([{ ...original, [field]: 'replacement' }]);
    await beforeLaunch(); launch(); return { status: 'complete', reason: 'launched', presentation: null };
  };
  const service = createPaneService(f.ports);
  expect(await service.request(identityOpen)).toMatchObject({ outcome: { status: 'refused', reason: 'machine-changed' } });
  expect(launch).not.toHaveBeenCalled(); await service.stop();
});

test('stale parked shell incarnation refuses before dispatch', async () => {
  const f = await fixture(); const service = createPaneService(f.ports);
  const result = await service.request({ version: 1, op: 'open-existing', operationId: 'reopen-1', presentationId: 'p1', expectedRevision: 1, targetIncarnation: { coreId: 'core-remote' as never, terminalId: 't7' as never, createdMs: 18 } });
  expect(result).toMatchObject({ outcome: { status: 'refused', reason: 'stale-presentation' } });
  expect(f.ports.dispatch).not.toHaveBeenCalled(); await service.stop();
});

test('snapshot and a local action finish while unrelated inventory is still pending', async () => {
  const f = await fixture(); let finish!: () => void;
  f.ports.inventory = async () => { await new Promise<void>(resolve => { finish = resolve; }); return { version: 1, rows: [], next: null, complete: true }; };
  const service = createPaneService(f.ports), refreshing = service.reconcile();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const deadline = new Promise<'blocked'>(resolve => { const timer = setTimeout(() => resolve('blocked'), 100); timer.unref(); });
  const snapshot = await Promise.race([service.request({ version: 1, op: 'snapshot', operationId: 'cached' }), deadline]);
  const action = await Promise.race([service.request(identityOpen), deadline]);
  finish(); await refreshing; await service.stop();
  expect(snapshot).toMatchObject({ kind: 'snapshot', complete: false });
  expect(action).toMatchObject({ outcome: { status: 'complete', reason: 'applied' } });
});
test('a slow accepted open returns pending before the transport deadline and replays its final result', async () => {
  const f = await fixture(); const state = await f.ports.store.read();
  f.ports.store = { read: async () => state, update: async change => change(state) };
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.ports.dispatch = vi.fn(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return { status: 'complete', reason: 'opened', presentation: f.presentation }; });
  vi.useFakeTimers(); const service = createPaneService(f.ports);
  try {
    const request = service.request(identityOpen); await started;
    await vi.advanceTimersByTimeAsync(4000);
    const result = await Promise.race([request, Promise.resolve('blocked')]);
    finish();
    expect(result).toMatchObject({ outcome: { status: 'pending', reason: 'operation-in-progress' } });
    expect(await service.request(identityOpen)).toMatchObject({ outcome: { status: 'complete', reason: 'opened' } });
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  } finally { finish(); vi.useRealTimers(); await service.stop(); }
});
test('expected target and folder refusals are returned instead of looking like an outage', async () => {
  const f = await fixture(); const service = createPaneService(f.ports);
  try {
    for (const code of ['stale-pane-owner', 'target-mismatch', 'pane-folder-unavailable', 'pane-machine-mismatch', 'pane-build-mismatch', 'destination-unavailable']) {
      f.ports.dispatch = async () => { throw new HerdrError(code, 'Unavailable'); };
      expect(await service.request({ ...identityOpen, operationId: code, intent: { ...identityOpen.intent, operationId: code } }))
        .toMatchObject({ outcome: { status: 'refused', reason: code } });
    }
  } finally { await service.stop(); }
});
test('257 ended presentations cannot exhaust snapshots or retain their placement rows', async () => {
  const f = await fixture();
  let state = await f.ports.store.read();
  const history = Array.from({ length: 257 }, (_, i) => ({ ...f.presentation, id: `ended-${i}`, visibility: 'ended' as const,
    target: { ...f.presentation.target, sessionId: `gone-${i}` as never, terminalId: `old-${i}` as never, address: `core-remote/old-${i}` as never } }));
  state = { ...state, presentations: [...history, f.presentation],
    slots: [{ session: 'gone-0', space: 's1', tab: 'tb1' }], choices: [{ session: 'gone-0' as never, space: 's1' as never, tab: 'tb1' as never, revision: 1 }],
    attempts: [{ session: 'gone-0', remote: 'box-1.invalid/t1', core: 'core-remote', proxy: 't8', closed: true, localOwners: [] }],
    launches: [{ operationId: 'old-open', coreId: 'core-remote' as never, machineKey: 'box-1.invalid', intent: { ...identityOpen.intent, operationId: 'old-open' }, folder: { cwd: null, reason: 'home' }, state: 'observed', target: history[0].target, failure: null }] };
  f.ports.store = { read: async () => state, update: async change => state = change(state) };
  const service = createPaneService(f.ports);
  try {
    await service.reconcile();
    expect(await service.request({ version: 1, op: 'snapshot', operationId: 'after-history' })).toMatchObject({ kind: 'snapshot', presentations: [{ id: 'p1' }] });
    expect(state).toMatchObject({ presentations: [{ id: 'p1' }], slots: [], attempts: [], choices: [], launches: [] });
  } finally { await service.stop(); }
});
test('complete source evidence prunes finished and absent targets but keeps unavailable and live targets', async () => {
  const f = await fixture(); let state = await f.ports.store.read();
  state = { ...state, presentations: ['finished', 'absent', 'unavailable', 'live'].map(id => ({ ...f.presentation, id, mode: 'native', target: { ...f.presentation.target, terminalId: id as never, address: `core-remote/${id}` as never } })) };
  f.ports.store = { read: async () => state, update: async change => state = change(state) };
  vi.mocked(f.hc.get).mockImplementation(async address => {
    if (address === 'core-remote/absent') throw new HerdrError('not_found', 'No terminal');
    if (address === 'core-remote/unavailable') throw new HerdrError('unreachable', 'Source unavailable');
    return { address, state: address === 'core-remote/finished' ? 'finished' : 'live' } as never;
  });
  const service = createPaneService(f.ports);
  try { await service.reconcile(); expect(state.presentations.map(p => p.id)).toEqual(['unavailable', 'live']); }
  finally { await service.stop(); }
});
test('a complete inventory prunes a superseded terminal incarnation without stopping its successor', async () => {
  const f = await fixture(); const target = { ...f.presentation.target, createdMs: 18, generation: 'gen-2' };
  f.ports.inventory = async () => ({ version: 1, rows: [{ sessionId: 'session-1', generation: 'gen-2', name: 'Example', status: 'working', updatedAt: 2, machineKey: 'box-1.invalid', unavailableReason: null, target,
    owner: { sessionId: 'session-1', generation: 'gen-2', terminal: { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', socket: '/unused', sessionNamespace: 'test' }, cwd: '/home/example', sessionFile: null, name: 'Example' }, children: [], consoles: [] }] as never, next: null, complete: true });
  const service = createPaneService(f.ports);
  try { await service.reconcile(); expect((await f.ports.store.read()).presentations).toEqual([]); expect(f.hc.kill).not.toHaveBeenCalled(); }
  finally { await service.stop(); }
});
test('snapshot trims live presentations and terminal facts without raising codec bounds', async () => {
  const f = await fixture(); let state = await f.ports.store.read();
  state = { ...state, presentations: Array.from({ length: 257 }, (_, i) => ({ ...f.presentation, id: `live-${i}` })) };
  f.ports.store = { read: async () => state, update: async change => state = change(state) };
  const service = createPaneService(f.ports);
  try {
    const reply = await service.request({ version: 1, op: 'snapshot', operationId: 'live-cap' });
    expect(reply).toMatchObject({ kind: 'snapshot', complete: false });
    if (reply.kind !== 'snapshot') throw new Error('Expected snapshot');
    expect(reply.presentations).toHaveLength(256); expect(state.presentations).toHaveLength(257);
  } finally { await service.stop(); }
});
test('capped display snapshots retain the full private placement inventory', async () => {
  const f = await fixture();
  const owner = { sessionId: 'session-0', generation: 'gen-1', terminal: { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', socket: '/unused', sessionNamespace: 'test' }, cwd: '/home/example', sessionFile: null, name: 'Builder' };
  const rows = Array.from({ length: 270 }, (_, i) => ({ sessionId: `session-${i}`, generation: 'gen-1', name: i === 269 || i === 0 ? 'Builder' : `Other-${i}`, status: 'working', updatedAt: 1, machineKey: 'box-1.invalid', unavailableReason: null, owner: { ...owner, sessionId: `session-${i}` }, target: { ...f.presentation.target, sessionId: `session-${i}` }, children: [], consoles: [] }));
  f.ports.inventory = async (_machine, _signal, cursor) => ({ version: 1, rows: (cursor ? rows.slice(256) : rows.slice(0, 256)) as never, next: cursor ? null : 'page-2', complete: true });
  f.ports.dispatch = async (_request, _beforeLaunch, inventory) => {
    const selection = selectRemoteSessionSlot({ row: inventory.rows[0], rows: inventory.rows, inventoryComplete: inventory.complete, inventoryStale: inventory.stale,
      config: { spaces: [{ name: 'Work', sessions: [{ name: 'Builder' }] }] } as never,
      state: { ...(await f.ports.store.read()), presentations: [] }, layout: { spaces: [] }, capabilities: await f.ports.appCapabilities() });
    return { status: 'refused', reason: selection.kind === 'unplaced' ? selection.reason : 'placed', presentation: null };
  };
  const service = createPaneService(f.ports);
  await service.reconcile();
  const display = await service.request({ version: 1, op: 'snapshot', operationId: 'display' });
  expect(display).toMatchObject({ kind: 'snapshot', complete: false, omittedRows: 14 });
  if (display.kind !== 'snapshot') throw new Error('Expected display snapshot');
  expect(display.rows).toHaveLength(256);
  expect(await service.request({ version: 1, op: 'move', operationId: 'private-placement', presentationId: 'p1', expectedRevision: 1, slot: { space: 's1' as never, tab: 'tab-1' as never, pane: null } })).toMatchObject({ outcome: { reason: 'name-ambiguous' } });
  await service.stop();
});
