// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { afterEach, expect, test, vi } from 'vitest';
import { HerdrError } from '../client/parse.js';
import { selectRemoteSessionSlot } from '../spaces/remote-placement.js';
import { createPaneService, type PaneServicePorts } from '../panes/service.js';
import { createPaneInventoryCache } from '../panes/inventory.js';
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
test('subscription readiness does not start inventory before the first operation', async () => {
  const f = await fixture();
  f.ports.subscribe = changed => { changed(); return () => {}; };
  const service = createPaneService(f.ports);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.ports.inventory).not.toHaveBeenCalled();
    await service.request({ version: 1, op: 'snapshot', operationId: 'initial' });
    await vi.waitFor(() => expect(f.ports.inventory).toHaveBeenCalledTimes(1));
    expect(f.ports.inventory).toHaveBeenCalledTimes(1);
  } finally { await service.stop(); }
});
test('one mutation reconciles once even when its own effects emit core events', async () => {
  const f = await fixture(); let changed = () => {};
  f.ports.subscribe = listener => { changed = listener; return () => {}; };
  f.ports.dispatch = async () => { changed(); await Promise.resolve(); changed(); return { status: 'complete', reason: 'applied', presentation: f.presentation }; };
  const service = createPaneService(f.ports);
  try {
    await service.request({ version: 1, op: 'move', operationId: 'one-scan', presentationId: 'p1', expectedRevision: 1, slot: { space: 's1' as never, tab: 'tb1' as never, pane: null } });
    await vi.waitFor(() => expect(f.ports.inventory).toHaveBeenCalledTimes(1));
    await service.stop();
    expect(f.ports.inventory).toHaveBeenCalledTimes(1);
  } finally { await service.stop(); }
});
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
test('identical readiness replay after a service restart does not retarget twice', async () => {
  const f = await fixture();
  const request = { version: 1 as const, op: 'present-ready' as const, operationId: 'durable-ready', presentationId: 'p1', expectedRevision: 1, target: { ...f.presentation.target, homeEpoch: 3 } };
  f.ports.dispatch = vi.fn(async () => {
    const presentation = { ...f.presentation, target: request.target, revision: 2 };
    await f.ports.store.update(state => ({ ...state, presentations: [presentation] }));
    return { status: 'complete' as const, reason: 'proxy-retargeted', presentation };
  });
  const service = createPaneService(f.ports), result = await service.request(request); await service.stop();
  const restarted = createPaneService(f.ports);
  try { expect(await restarted.request(request)).toEqual(result); expect(f.ports.dispatch).toHaveBeenCalledTimes(1); }
  finally { await restarted.stop(); }
});
test('a changed readiness request cannot reuse completed operation evidence', async () => {
  const f = await fixture();
  const request = { version: 1 as const, op: 'present-ready' as const, operationId: 'durable-ready', presentationId: 'p1', expectedRevision: 1, target: f.presentation.target };
  const service = createPaneService(f.ports); await service.request(request); await service.stop();
  const restarted = createPaneService(f.ports);
  try {
    expect(await restarted.request({ ...request, target: { ...request.target, homeEpoch: 3 } })).toMatchObject({ outcome: { status: 'refused' } });
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  } finally { await restarted.stop(); }
});
test('a superseded generation cannot replay an old completed readiness', async () => {
  const f = await fixture();
  const request = { version: 1 as const, op: 'present-ready' as const, operationId: 'durable-ready', presentationId: 'p1', expectedRevision: 1, target: f.presentation.target };
  const service = createPaneService(f.ports); await service.request(request); await service.stop();
  await f.ports.store.update(state => ({ ...state, presentations: [{ ...f.presentation, revision: 2, target: { ...f.presentation.target, generation: 'gen-2' as never, homeEpoch: 3 } }] }));
  const restarted = createPaneService(f.ports);
  try { expect(await restarted.request(request)).toMatchObject({ outcome: { status: 'refused', reason: 'stale-presentation' } }); expect(f.ports.dispatch).toHaveBeenCalledTimes(1); }
  finally { await restarted.stop(); }
});
test('an in-memory readiness reply cannot outlive its generation', async () => {
  const f = await fixture();
  const request = { version: 1 as const, op: 'present-ready' as const, operationId: 'durable-ready', presentationId: 'p1', expectedRevision: 1, target: f.presentation.target };
  const service = createPaneService(f.ports);
  try {
    await service.request(request);
    await f.ports.store.update(state => ({ ...state, presentations: [{ ...f.presentation, revision: 2, target: { ...f.presentation.target, generation: 'gen-2' as never, homeEpoch: 3 } }] }));
    expect(await service.request(request)).toMatchObject({ outcome: { status: 'refused', reason: 'stale-presentation' } });
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  } finally { await service.stop(); }
});
test('incomplete readiness never earns a durable replay', async () => {
  const f = await fixture();
  const request = { version: 1 as const, op: 'present-ready' as const, operationId: 'unfinished-ready', presentationId: 'p1', expectedRevision: 1, target: f.presentation.target };
  f.ports.dispatch = vi.fn(async () => {
    const presentation = { ...f.presentation, revision: 2 };
    await f.ports.store.update(state => ({ ...state, presentations: [presentation] }));
    return { status: 'pending' as const, reason: 'destination-screen-pending', presentation };
  });
  const service = createPaneService(f.ports); await service.request(request); await service.stop();
  const restarted = createPaneService(f.ports);
  try { expect(await restarted.request(request)).toMatchObject({ outcome: { status: 'refused', reason: 'stale-presentation' } }); expect(f.ports.dispatch).toHaveBeenCalledTimes(1); }
  finally { await restarted.stop(); }
});

test('completed readiness evidence never bypasses another action revision check', async () => {
  const f = await fixture();
  const request = { version: 1 as const, op: 'present-ready' as const, operationId: 'durable-ready', presentationId: 'p1', expectedRevision: 1, target: f.presentation.target };
  const service = createPaneService(f.ports); await service.request(request); await service.stop();
  await f.ports.store.update(state => ({ ...state, presentations: [{ ...f.presentation, revision: 2 }] }));
  const restarted = createPaneService(f.ports);
  try { expect(await restarted.request({ version: 1, op: 'park', operationId: request.operationId, presentationId: 'p1', expectedRevision: 1 })).toMatchObject({ outcome: { status: 'refused', reason: 'stale-presentation' } }); expect((await f.ports.store.read()).presentations[0].visibility).toBe('visible'); }
  finally { await restarted.stop(); }
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
  f.ports.inventory = vi.fn(async () => ({ version: 1 as const, rows: [row] as never, next: null, complete: true }));
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

test('a slow inventory source does not delay another machine\'s lease renewal', async () => {
  const f = await fixture(), first = (await f.ports.machines())[0];
  const second = parseMachineChoice({ key: 'box-2.invalid', alias: 'box-2.invalid', label: 'box-2.invalid', coreId: 'core-other', machineId: null, state: 'connected' });
  vi.mocked(f.ports.machines).mockResolvedValue([first, second]);
  let release: (() => void) | undefined, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), renewed: string[] = [];
  f.ports.inventory = vi.fn(async machine => {
    if (machine.key === 'box-1.invalid') { started(); await new Promise<void>(resolve => { release = resolve; }); }
    return { version: 1 as const, rows: [], next: null, complete: true };
  });
  f.ports.renewLeases = vi.fn(async machine => { renewed.push(machine.key); });
  const service = createPaneService(f.ports), reconciling = service.reconcile();
  try {
    await entered;
    await vi.waitFor(() => expect(renewed).toContain('box-2.invalid'));
    expect(renewed).not.toContain('box-1.invalid');
  } finally { release?.(); await reconciling; await service.stop(); }
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

test('a cold snapshot includes machine choices without waiting for source inventory', async () => {
  const f = await fixture(); let finish!: () => void;
  f.ports.inventory = async () => { await new Promise<void>(resolve => { finish = resolve; }); return { version: 1, rows: [], next: null, complete: true }; };
  const service = createPaneService(f.ports);
  const reply = await service.request({ version: 1, op: 'snapshot', operationId: 'cold' });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); finish(); await service.stop();
  expect(reply).toMatchObject({ complete: false, machines: [{ coreId: 'core-remote', state: 'connected' }] });
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
  f.ports.dispatch = vi.fn(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return { status: 'complete' as const, reason: 'opened', presentation: f.presentation }; });
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
test('finished facts from another incarnation cannot retire the current live target', async () => {
  const f = await fixture();
  f.ports.targetFacts = async () => ({ 'core-remote/t7': { terminal: { address: 'core-remote/t7' as never, parent: null, labels: {}, state: 'finished', status: null, exitCode: 0, reason: 'exited', signal: null, finishedAt: 1 }, createdMs: 16, identityLabels: {}, currentCwd: null, title: 'Previous incarnation', app: null, status: null } });
  const service = createPaneService(f.ports);
  try { await service.reconcile(); expect((await f.ports.store.read()).presentations).toMatchObject([{ id: 'p1', target: { createdMs: 17 } }]); }
  finally { await service.stop(); }
});
test('history probes share one endpoint budget instead of timing out once per target', async () => {
  const f = await fixture(); const signals: AbortSignal[] = []; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  await f.ports.store.update(state => ({ ...state, presentations: Array.from({ length: 17 }, (_, index) => ({ ...f.presentation, id: `p-${index}`, visibility: 'parked' as const, target: { ...f.presentation.target, terminalId: `t-${index}` as never, address: `core-remote/t-${index}` as never } })) }));
  vi.mocked(f.hc.get).mockImplementation(async (_address, options) => {
    const signal = options!.signal!; signals.push(signal); if (signals.length === 4) started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new HerdrError('aborted', 'Cancelled')), { once: true }));
  });
  vi.useFakeTimers(); const service = createPaneService(f.ports), running = service.reconcile();
  try {
    await ready; await vi.advanceTimersByTimeAsync(5000); const count = signals.length;
    await vi.advanceTimersByTimeAsync(50000); await running; await service.stop();
    expect(count).toBe(4); expect(signals.every(signal => signal.aborted)).toBe(true);
    expect((await f.ports.store.read()).presentations).toHaveLength(17);
  } finally { await service.stop(); vi.useRealTimers(); }
});
test('a complete inventory prunes a superseded terminal incarnation without stopping its successor', async () => {
  const f = await fixture(); const target = { ...f.presentation.target, createdMs: 18, generation: 'gen-2' };
  f.ports.inventory = async () => ({ version: 1, rows: [{ sessionId: 'session-1', generation: 'gen-2', name: 'Example', status: 'working', updatedAt: 2, machineKey: 'box-1.invalid', unavailableReason: null, target,
    owner: { sessionId: 'session-1', generation: 'gen-2', terminal: { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', socket: '/unused', sessionNamespace: 'test' }, cwd: '/home/example', sessionFile: null, name: 'Example' }, children: [], consoles: [] }] as never, next: null, complete: true });
  const service = createPaneService(f.ports);
  try { await service.reconcile(); expect((await f.ports.store.read()).presentations).toEqual([]); expect(f.hc.kill).not.toHaveBeenCalled(); }
  finally { await service.stop(); }
});
const coldAuxiliary = { version: 1 as const, op: 'open-auxiliary' as const, operationId: 'cold-auxiliary', sessionId: 'session-1' as never, generation: 'gen-1' as never, view: { kind: 'subagent' as const, runId: 'run-1' as never } };
function availableOwnerRow(presentation: Awaited<ReturnType<typeof fixture>>['presentation']) {
  const target = presentation.target;
  return { sessionId: 'session-1', generation: 'gen-1', name: 'Example', status: 'working', updatedAt: 1, machineKey: 'box-1.invalid', unavailableReason: null, target,
    owner: { sessionId: 'session-1', generation: 'gen-1', terminal: { coreId: target.coreId, terminalId: target.terminalId, address: target.address, socket: '/unused', sessionNamespace: 'test' }, cwd: '/home/example', sessionFile: null, name: 'Example' }, children: [], consoles: [] };
}
function observeOwnerLookup(f: Awaited<ReturnType<typeof fixture>>) {
  const launch = vi.fn();
  f.ports.dispatch = vi.fn<PaneServicePorts['dispatch']>(async (request, _beforeLaunch, inventory) => {
    if (request.op !== 'open-auxiliary' && !(request.op === 'open-existing' && 'sessionId' in request)) throw new Error('Unexpected request');
    const matches = inventory.rows.filter(row => row.sessionId === request.sessionId && row.generation === request.generation && row.unavailableReason === null);
    if (matches.length !== 1 || !matches[0].owner) return { status: 'refused', reason: 'not-in-hc', presentation: null };
    launch(matches[0].owner);
    return { status: 'complete', reason: 'view-presented', presentation: null };
  });
  return launch;
}

test('cold auxiliary lookup refreshes and finds an existing owner before launch', async () => {
  const f = await fixture(), row = availableOwnerRow(f.presentation), launch = observeOwnerLookup(f);
  f.ports.inventory = vi.fn(async () => ({ version: 1 as const, rows: [row] as never, next: null, complete: true }));
  const service = createPaneService(f.ports);
  try {
    expect(await service.request(coldAuxiliary)).toMatchObject({ outcome: { status: 'complete', reason: 'view-presented' } });
    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', terminal: expect.objectContaining({ coreId: 'core-remote' }) }));
  } finally { await service.stop(); }
});

test('persisted owner rows cannot authorize a launch when refresh fails', async () => {
  const f = await fixture(), row = availableOwnerRow(f.presentation), launch = observeOwnerLookup(f);
  f.ports.inventory = vi.fn(async () => ({ version: 1 as const, rows: [row] as never, next: null, complete: true }));
  const original = createPaneService(f.ports);
  await original.reconcile(); await original.stop();
  expect(await createPaneInventoryCache(f.ports.root).readCache('box-1.invalid')).not.toBeNull();
  f.ports.inventory = vi.fn(async () => { throw new Error('source unavailable'); });
  const restarted = createPaneService(f.ports);
  try {
    await restarted.reconcile();
    expect(await restarted.request(coldAuxiliary)).toMatchObject({ outcome: { status: 'pending' } });
    expect(launch).not.toHaveBeenCalled();
  } finally { await restarted.stop(); }
});

test('concurrent cold owner lookups share one in-flight inventory refresh', async () => {
  const f = await fixture(), row = availableOwnerRow(f.presentation), launch = observeOwnerLookup(f);
  let release!: () => void;
  f.ports.inventory = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { version: 1 as const, rows: [row] as never, next: null, complete: true }; });
  const service = createPaneService(f.ports);
  const first = service.request(coldAuxiliary);
  const second = service.request({ ...coldAuxiliary, operationId: 'cold-auxiliary-2' });
  try {
    await vi.waitFor(() => expect(f.ports.inventory).toHaveBeenCalledTimes(1));
    expect(launch).not.toHaveBeenCalled();
    release();
    expect(await Promise.all([first, second])).toMatchObject([{ outcome: { status: 'complete' } }, { outcome: { status: 'complete' } }]);
    expect(f.ports.inventory).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(2);
  } finally { release?.(); await service.stop(); }
});

test('a slow cold inventory lookup returns pending before the transport deadline and never launches later', async () => {
  const f = await fixture(), row = availableOwnerRow(f.presentation), launch = observeOwnerLookup(f);
  let state = await f.ports.store.read(), release: (() => void) | undefined, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.ports.store = { read: async () => state, update: async change => state = change(state) };
  f.ports.inventory = vi.fn(async () => {
    started(); await new Promise<void>(resolve => { release = resolve; });
    return { version: 1 as const, rows: [row] as never, next: null, complete: true };
  });
  vi.useFakeTimers(); const service = createPaneService(f.ports);
  try {
    const first = service.request(coldAuxiliary);
    await entered; await vi.advanceTimersByTimeAsync(3500);
    expect(await Promise.race([first, Promise.resolve('blocked')])).toMatchObject({ outcome: { status: 'pending', reason: 'inventory-unavailable' } });
    expect(launch).not.toHaveBeenCalled();
    expect(release).toBeTypeOf('function');
    release?.(); vi.useRealTimers();
    await service.reconcile();
    expect(await service.request(coldAuxiliary)).toMatchObject({ outcome: { status: 'pending', reason: 'inventory-unavailable' } });
    await service.stop();
    expect(launch).not.toHaveBeenCalled();
  } finally { release?.(); vi.useRealTimers(); await service.stop(); }
});

test('a timed-out owner lookup does not dispatch after its inventory finishes', async () => {
  const f = await fixture(), row = availableOwnerRow(f.presentation), launch = observeOwnerLookup(f);
  let state = await f.ports.store.read(), release: (() => void) | undefined, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.ports.store = { read: async () => state, update: async change => state = change(state) };
  f.ports.inventory = vi.fn(async () => {
    started(); await new Promise<void>(resolve => { release = resolve; });
    return { version: 1 as const, rows: [row] as never, next: null, complete: true };
  });
  vi.useFakeTimers(); const service = createPaneService(f.ports);
  try {
    const first = service.request(coldAuxiliary);
    await entered; await vi.advanceTimersByTimeAsync(4000);
    expect(await first).toMatchObject({ outcome: { status: 'pending' } });
    release?.(); vi.useRealTimers();
    await service.reconcile(); await service.stop();
    expect(launch).not.toHaveBeenCalled();
  } finally { release?.(); vi.useRealTimers(); await service.stop(); }
});

test('an owner lookup in retry backoff returns pending without waiting for machines', async () => {
  const f = await fixture(), launch = observeOwnerLookup(f), machine = (await f.ports.machines())[0];
  let state = await f.ports.store.read(), release: (() => void) | undefined;
  f.ports.store = { read: async () => state, update: async change => state = change(state) };
  f.ports.inventory = vi.fn(async () => { throw new Error('source unavailable'); });
  const service = createPaneService(f.ports);
  try {
    await service.reconcile();
    vi.mocked(f.ports.machines).mockImplementation(() => new Promise(resolve => { release = () => resolve([machine]); }));
    vi.useFakeTimers();
    const request = service.request(coldAuxiliary);
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([request, Promise.resolve('blocked')])).toMatchObject({ outcome: { status: 'pending', reason: 'inventory-unavailable' } });
    expect(f.ports.inventory).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  } finally { release?.(); vi.useRealTimers(); await service.stop(); }
});

test('another mutation proceeds while a cold owner inventory refresh is pending', async () => {
  const f = await fixture(), row = availableOwnerRow(f.presentation), launch = observeOwnerLookup(f);
  const ownerDispatch = f.ports.dispatch;
  let state = await f.ports.store.read(), release: (() => void) | undefined, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.ports.store = { read: async () => state, update: async change => state = change(state) };
  f.ports.inventory = vi.fn(async () => {
    started(); await new Promise<void>(resolve => { release = resolve; });
    return { version: 1 as const, rows: [row] as never, next: null, complete: true };
  });
  f.ports.dispatch = vi.fn<PaneServicePorts['dispatch']>((request, beforeLaunch, inventory) => request.op === 'move'
    ? Promise.resolve({ status: 'complete', reason: 'moved', presentation: f.presentation })
    : ownerDispatch(request, beforeLaunch, inventory));
  vi.useFakeTimers(); const service = createPaneService(f.ports);
  try {
    const first = service.request(coldAuxiliary); await entered;
    const other = service.request({ version: 1, op: 'move', operationId: 'independent-move', presentationId: 'p1', expectedRevision: 1, slot: { space: 's1' as never, tab: 'tb1' as never, pane: null } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([other, Promise.resolve('blocked')])).toMatchObject({ outcome: { status: 'complete', reason: 'moved' } });
    expect(launch).not.toHaveBeenCalled();
    release?.(); vi.useRealTimers(); await Promise.all([first, other]);
  } finally { release?.(); vi.useRealTimers(); await service.stop(); }
});

test('a cold owner lookup cannot launch after its deadline while another mutation holds the queue', async () => {
  const f = await fixture(), row = availableOwnerRow(f.presentation), launch = observeOwnerLookup(f);
  const ownerDispatch = f.ports.dispatch;
  let state = await f.ports.store.read(), release: (() => void) | undefined, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.ports.store = { read: async () => state, update: async change => state = change(state) };
  f.ports.inventory = vi.fn(async () => ({ version: 1 as const, rows: [row] as never, next: null, complete: true }));
  f.ports.dispatch = vi.fn<PaneServicePorts['dispatch']>(async (request, beforeLaunch, inventory) => {
    if (request.op !== 'move') return ownerDispatch(request, beforeLaunch, inventory);
    started(); await new Promise<void>(resolve => { release = resolve; });
    return { status: 'complete', reason: 'moved', presentation: f.presentation };
  });
  vi.useFakeTimers(); const service = createPaneService(f.ports);
  try {
    const first = service.request({ version: 1, op: 'move', operationId: 'blocking-move', presentationId: 'p1', expectedRevision: 1, slot: { space: 's1' as never, tab: 'tb1' as never, pane: null } });
    await entered;
    const lookup = service.request(coldAuxiliary);
    await vi.advanceTimersByTimeAsync(0); await service.reconcile();
    await vi.advanceTimersByTimeAsync(3500);
    expect(await Promise.race([lookup, Promise.resolve('blocked')])).toMatchObject({ outcome: { status: 'pending', reason: 'inventory-unavailable' } });
    release?.(); vi.useRealTimers(); await first; await service.stop();
    expect(launch).not.toHaveBeenCalled();
  } finally { release?.(); vi.useRealTimers(); await service.stop(); }
});

test('a warm owner dispatches without a new inventory refresh', async () => {
  const f = await fixture(), row = availableOwnerRow(f.presentation), launch = observeOwnerLookup(f);
  f.ports.inventory = vi.fn(async () => ({ version: 1 as const, rows: [row] as never, next: null, complete: true }));
  const service = createPaneService(f.ports);
  try {
    await service.reconcile(); vi.mocked(f.ports.inventory).mockClear();
    const ownerDispatch = f.ports.dispatch; let readsAtDispatch = -1;
    f.ports.dispatch = async (...args) => { readsAtDispatch = vi.mocked(f.ports.inventory).mock.calls.length; return ownerDispatch(...args); };
    expect(await service.request(coldAuxiliary)).toMatchObject({ outcome: { status: 'complete', reason: 'view-presented' } });
    expect(readsAtDispatch).toBe(0);
    expect(launch).toHaveBeenCalledOnce();
  } finally { await service.stop(); }
});

test('an absent owner is not-in-hc only after a completed cold refresh', async () => {
  const f = await fixture(), launch = observeOwnerLookup(f), service = createPaneService(f.ports);
  vi.useFakeTimers();
  try {
    expect(await service.request(coldAuxiliary)).toMatchObject({ outcome: { status: 'refused', reason: 'not-in-hc' } });
    expect(f.ports.inventory).toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); await service.stop(); }
});

test('an absent owner stays pending when any possible source is unavailable', async () => {
  const f = await fixture(), launch = observeOwnerLookup(f);
  f.ports.inventory = vi.fn(async () => { throw new Error('source unavailable'); });
  const service = createPaneService(f.ports);
  try {
    expect(await service.request(coldAuxiliary)).toMatchObject({ outcome: { status: 'pending' } });
    expect(launch).not.toHaveBeenCalled();
  } finally { await service.stop(); }
});

test('a refreshed owner remains available when an unrelated machine is disconnected', async () => {
  const f = await fixture(), row = availableOwnerRow(f.presentation), launch = observeOwnerLookup(f);
  const machine = (await f.ports.machines())[0];
  vi.mocked(f.ports.machines).mockResolvedValue([machine, parseMachineChoice({ key: 'box-2.invalid', alias: 'box-2.invalid', label: 'box-2.invalid', coreId: 'core-offline', machineId: null, state: 'disconnected' })]);
  f.ports.inventory = vi.fn(async () => ({ version: 1 as const, rows: [row] as never, next: null, complete: true }));
  const service = createPaneService(f.ports);
  try {
    expect(await service.request(coldAuxiliary)).toMatchObject({ outcome: { status: 'complete', reason: 'view-presented' } });
    expect(launch).toHaveBeenCalledOnce();
  } finally { await service.stop(); }
});

test('a cold open-existing owner lookup also waits for source inventory', async () => {
  const f = await fixture(), row = availableOwnerRow(f.presentation), launch = observeOwnerLookup(f);
  f.ports.inventory = vi.fn(async () => ({ version: 1 as const, rows: [row] as never, next: null, complete: true }));
  const service = createPaneService(f.ports);
  try {
    expect(await service.request({ version: 1, op: 'open-existing', operationId: 'cold-existing', sessionId: 'session-1' as never, generation: 'gen-1' as never, slot: null }))
      .toMatchObject({ outcome: { status: 'complete', reason: 'view-presented' } });
    expect(launch).toHaveBeenCalledOnce();
  } finally { await service.stop(); }
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


test('ready outcome queries remain read-only after revision changes and service restart', async () => {
  const f = await fixture();
  const request = { version: 1 as const, op: 'present-ready' as const, operationId: 'query-ready', presentationId: 'p1', expectedRevision: 1, target: f.presentation.target };
  const service = createPaneService(f.ports), completed = await service.request(request); await service.stop();
  await f.ports.store.update(state => ({ ...state, presentations: [{ ...f.presentation, revision: 2, visibility: 'parked' }] }));
  const before = await f.ports.store.read(); vi.mocked(f.ports.validateTarget).mockClear();
  const restarted = createPaneService(f.ports);
  try {
    expect(await restarted.request({ version: 1, op: 'ready-outcome', operationId: request.operationId, presentationId: 'p1' })).toEqual(completed);
    expect(await restarted.request({ version: 1, op: 'ready-outcome', operationId: 'unknown', presentationId: 'p1' })).toMatchObject({ outcome: { status: 'pending', reason: 'operation-unknown' } });
    expect(await f.ports.store.read()).toEqual(before);
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(f.ports.validateTarget).not.toHaveBeenCalled();
  } finally { await restarted.stop(); }
});
test('ready outcome queries observe in-progress operations without dispatch or waiting for their effects', async () => {
  const f = await fixture(); let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.ports.dispatch = vi.fn(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return { status: 'pending', reason: 'screen-pending', presentation: f.presentation }; });
  const service = createPaneService(f.ports);
  const request = { version: 1 as const, op: 'present-ready' as const, operationId: 'query-running', presentationId: 'p1', expectedRevision: 1, target: f.presentation.target };
  const running = service.request(request); await started;
  try {
    expect(await service.request({ version: 1, op: 'ready-outcome', operationId: request.operationId, presentationId: 'p1' })).toMatchObject({ outcome: { status: 'pending', reason: 'operation-in-progress' } });
    finish(); const completed = await running;
    expect(await service.request({ version: 1, op: 'ready-outcome', operationId: request.operationId, presentationId: 'p1' })).toEqual(completed);
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  } finally { finish(); await running; await service.stop(); }
});
