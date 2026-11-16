// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { createReplica } from '@spider/db-core/testutil';
import { runHub, type HubRuntimePorts } from '@spider/roam/hub';
import { openJournal } from '@spider/roam/journal';
import { DEFAULT_LIMITS, disabledIntercom } from '@spider/roam/contracts';
import { afterEach, expect, test, vi } from 'vitest';
import type { AppClient, AppPaneInspection, HcClient, OwnerPlacement, TerminalAddress } from '../contracts.js';
import { parsePaneTarget } from '../panes/codec.js';
import { convertNativePresentation, type PaneOpenPorts } from '../panes/open.js';
import { confirmPresentationClose } from '../panes/lifecycle.js';
import { createPaneService } from '../panes/service.js';
import { createPanePlacementStore } from '../panes/store.js';
import type { PanePresentation, PaneServiceRequest, PaneTarget } from '../panes/types.js';
import { createRoamPlacement, createRoamPresentationOperations } from '../roam-placement.js';
import { HerdrError } from '../client/parse.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function target(coreId = 'core-local', terminalId = 't1', epoch = 1): PaneTarget {
  return parsePaneTarget({ coreId, terminalId, address: `${coreId}/${terminalId}`, createdMs: epoch + 10,
    identityLabels: { 'spider.session': 'session-1', 'spider.generation': `gen-${epoch}` }, alias: coreId === 'core-local' ? null : 'box-1.invalid',
    machineId: coreId === 'core-local' ? 'machine-local' : 'machine-remote', kind: 'session', sessionId: 'session-1', generation: `gen-${epoch}`,
    homeEpoch: epoch, runId: null, consoleId: null, name: 'Example', cwd: '/example' });
}
async function fixture() {
  const base = join(paths.scratch('worktree', process.cwd()), 'presentation-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'p-')); roots.push(root);
  const stateRoot = join(root, 'placement'), store = createPanePlacementStore(stateRoot);
  const source = target(), remote = target('core-remote', 't2', 2);
  const slot = { space: 'space-1', tab: 'tab-1', pane: 'pane-1' } as OwnerPlacement;
  let focusSlot = slot;
  let focused = true, appPresent = true, screenReady = true, launchLost = false, recoverLaunch = false, spawnFailures = 0;
  const placements = new Map<TerminalAddress, OwnerPlacement>([['t1' as TerminalAddress, slot]]), events: string[] = [];
  const displays = new Map<string, PanePresentation>();
  const app = {
    ownerPlacement: async (address: TerminalAddress) => { if (!appPresent) throw Error('app absent'); const found = placements.get(address); if (!found) throw Error('unplaced'); return found; },
    focusedPane: async () => focused ? focusSlot : { ...slot, pane: 'other-pane' },
    tabTerminals: async () => [...placements.keys()],
    command: async (name: string, args: Record<string, unknown>) => { events.push(name); if (name === 'terminal.keep') { focusSlot = { ...slot, pane: 'replacement' as never }; placements.set(args.terminal as TerminalAddress, focusSlot); } if (name === 'terminal.park') placements.delete(args.terminal as TerminalAddress); return {}; },
  } as unknown as AppClient & AppPaneInspection;
  const hc = {
    identity: async () => ({ coreId: 'core-local', socket: '/unused', sessionNamespace: 'test' }),
    get: async (address: TerminalAddress) => { const p = displays.get(address); return { address, state: 'live', labels: { 'spider.kind': p?.id === 'legacy' ? 'roam-proxy' : 'pane-proxy', 'spider.session': 'session-1', 'spider.owner-core': p?.target.coreId, 'spider.owner-terminal': 'box-1.invalid/' + p?.target.terminalId, 'spider.pane-id': p?.id, 'spider.target-core': p?.target.coreId, 'spider.target-terminal': p?.target.terminalId } }; },
    kill: async () => { events.push('kill'); },
    rm: async (address: string) => { displays.delete(address); events.push('remove'); },
    events: () => ({ ready: Promise.resolve(), subscribe: (listener: (event: unknown) => void) => { listener({ type: 'snapshot', terminals: [...displays].map(([address, p]) => ({ address, state: 'live', labels: { 'spider.kind': p.id === 'legacy' ? 'roam-proxy' : 'pane-proxy', 'spider.session': 'session-1', 'spider.owner-core': p.target.coreId, 'spider.owner-terminal': 'box-1.invalid/' + p.target.terminalId } })) }); return () => {}; } }),
  } as unknown as HcClient;
  const open: PaneOpenPorts = {
    store, hc, app, placeholderMod: 'synthetic-waiting',
    launchTarget: async () => { throw Error('must not launch pi'); },
    launchProxy: async p => { events.push('proxy'); if (spawnFailures-- > 0) throw new HerdrError('spawn-error', 'Could not start', { pid: undefined }); displays.set('t3', p); if (launchLost) throw Error('reply lost'); return 't3' as TerminalAddress; },
    findProxy: async p => recoverLaunch && [...displays.values()].some(display => display.id === p.id && display.target.terminalId === p.target.terminalId) ? 't3' as TerminalAddress : null, findTargetLaunch: async () => null, agentArgv: async () => [],
    readNativeTarget: async () => ({ ...source, kind: 'terminal', sessionId: null, generation: null, homeEpoch: null }), validateTarget: async value => value,
    verifyPlaceholder: async () => false, findPlaceholder: async () => null,
    deferSourceView: async () => false,
    appCapabilities: async () => ({ backgroundTabCreation: false, explicitTargetSwap: false, noFocusConversion: false, commandDigest: 'a'.repeat(64) }),
    awaitPresented: async (address, _target, expected) => { if (!screenReady) throw Error('screen pending'); events.push('screen'); const placed = await app.ownerPlacement(address); if (placed.tab !== expected.tab || placed.space !== expected.space) throw Error('wrong slot'); return placed; },
  };
  const captured = new Map<string, { source: OwnerPlacement | null; sourceFocused: boolean }>();
  const requests: PaneServiceRequest[] = [];
  let readyGate: { entered(): void; wait: Promise<void>; completed(): void } | null = null, crashDispatch = false;
  const servicePorts: Parameters<typeof createPaneService>[0] = { root: join(root, 'service'), store, hc, app, coreAvailable: async () => true, clock: Date.now,
    machines: async () => [], inventory: async () => ({ version: 1, rows: [], complete: true, next: null }), targetFacts: async () => ({}), renewLeases: async () => {},
    appCapabilities: open.appCapabilities, subscribe: () => () => {}, schedule: () => () => {}, validateTarget: async value => value, closeSession: async () => 'stale',
    async dispatch(request) {
      const p = 'presentationId' in request ? (await store.read()).presentations.find(p => p.id === request.presentationId) : null;
      if (!p) throw Error('missing presentation');
      if (request.op === 'prepare-handoff') { captured.set(p.id, { source: p.slot as OwnerPlacement, sourceFocused: focused }); events.push('capture'); return { status: 'complete', reason: 'handoff-prepared', presentation: p }; }
      if (request.op === 'present-ready') {
        const gate = readyGate; gate?.entered(); await gate?.wait;
        const result = await convertNativePresentation({ presentation: p, destination: request.target, ...captured.get(p.id)! }, open);
        gate?.completed();
        if (crashDispatch && result.status === 'complete') { crashDispatch = false; throw Error('process interrupted before outcome write'); }
        return result;
      }
      throw Error('unexpected operation');
    },
  };
  let service = createPaneService(servicePorts);
  let loseReadyReply = false;
  const operations = () => createRoamPresentationOperations({ stateRoot, hc, app: appPresent ? app : null, request: async request => { requests.push(request); const result = await service.request(request); if (request.op === 'present-ready' && loseReadyReply) { loseReadyReply = false; throw Error('reply lost'); } return result; } });
  const placement = () => createRoamPlacement({ stateRoot, hc, app, hcBinary: '/unused/hc', registry: { list: async () => [] } as never,
    presentation: { resolveTarget: async () => remote, presentReadyTarget: value => operations().presentReadyTarget(value) } });
  return { root, stateRoot, hc, source, remote, slot, store, events, placements, operations, requests, placement,
    recoverLaunch: () => { recoverLaunch = true; }, failSpawns: (count: number) => { spawnFailures = count; },
    interruptOutcome: () => { crashDispatch = true; }, restartService: async () => { await service.stop(); service = createPaneService(servicePorts); },
    blockReady: () => {
      let entered!: () => void, release!: () => void, completed!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; }), done = new Promise<void>(resolve => { completed = resolve; });
      readyGate = { entered, wait, completed }; return { started, release, done };
    },
    lateLegacy: () => { displays.set('legacy-proxy', { ...(displays.get('t3') ?? { target: remote }), id: 'legacy' } as PanePresentation); placements.set('legacy-proxy' as TerminalAddress, slot); },
    displays,
    close: (p: PanePresentation) => confirmPresentationClose({ id: p.id, expectedRevision: p.revision, target: p.target, operationId: 'stale-close' }, { store, hc, app, validateTarget: open.validateTarget, closeSession: async () => { throw Error('cannot close a successor'); } }), stop: () => service.stop(),
    focus: (value: boolean) => { focused = value; }, absent: () => { appPresent = false; open.app = null; },
    replaceSource: () => { open.readNativeTarget = async () => ({ ...source, createdMs: source.createdMs + 1, kind: 'terminal', sessionId: null, generation: null, homeEpoch: null }); },
    loseReadyReply: () => { loseReadyReply = true; },
    screen: (value: boolean) => { screenReady = value; }, loseLaunch: () => { launchLost = true; },
  };
}

test('move seeds Mac slot before freeze', async () => {
  const f = await fixture(); try {
    expect(await f.operations().prepareHandoff(f.source.sessionId!, f.source)).toMatchObject({ status: 'complete', presentation: { mode: 'native', proxy: null, slot: f.slot } });
    expect((await f.store.read()).slots).toEqual([{ session: 'session-1', space: 'space-1', tab: 'tab-1' }]);
    expect(f.events).toEqual(['capture']);
    expect(f.requests[0]).toMatchObject({ op: 'prepare-handoff', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 1 });
  } finally { await f.stop(); }
});
test('remote ready retargets proxy without changing tab', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source);
    expect(await f.operations().presentReadyTarget(f.remote)).toMatchObject({ status: 'complete', presentation: { mode: 'proxy', proxy: 't3', slot: { space: 'space-1', tab: 'tab-1' } } });
    expect(f.events.indexOf('screen')).toBeLessThan(f.events.indexOf('terminal.park'));
    const next = { ...f.remote, terminalId: 't4', address: 'core-remote/t4', createdMs: 14, homeEpoch: 3 } as PaneTarget;
    await f.operations().prepareHandoff(f.remote.sessionId!, f.remote);
    expect(await f.operations().presentReadyTarget(next)).toMatchObject({ status: 'complete', presentation: { proxy: 't3', target: next, slot: { space: 'space-1', tab: 'tab-1' } } });
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
  } finally { await f.stop(); }
});
test('one readiness through the hub and move paths has exactly one presentation owner', async () => {
  const f = await fixture(), hubId = '00000000-0000-4000-8000-000000000001', boxId = '00000000-0000-4000-8000-000000000002';
  const global = createReplica('global', hubId);
  let hub: Awaited<ReturnType<typeof runHub>> | undefined;
  try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source);
    global.db.prepare('INSERT INTO session_homes VALUES(?,?,?,?,?)').run('session-1', boxId, 2, 'move-a', 1);
    const peer = { machineId: boxId, alias: 'box-1.invalid', core: 'core-remote', node: '/bin/node', pi: '/bin/pi', cli: '/bin/spider', globalRoot: '/example' };
    const placement = createRoamPlacement({ stateRoot: f.stateRoot, hc: f.hc, app: null, hcBinary: '/unused/hc', registry: { list: async () => [] } as never,
      presentation: { resolveTarget: async () => f.remote, presentReadyTarget: target => f.operations().presentReadyTarget(target) } });
    let afterSync!: Parameters<HubRuntimePorts['prepare']>[0];
    hub = await runHub({ config: { enabled: true, role: 'hub', machineId: hubId, hubMachineId: hubId, peers: [peer], discoveryRoots: [], coreUnit: 'synthetic', syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() }, globalDb: global.db,
      journal: openJournal(join(f.root, 'journal.db')), placement, clock: { now: () => 1, later: () => () => {} },
      sync: { start() {}, stop() {}, sync: async () => [], barriers: async () => true }, runtimeRoot: join(f.root, 'hub'), socketPath: join(f.root, 'hub', 'hub.sock'),
      identity: { pid: 12345, startIdentity: 'synthetic-owner' }, probe: async () => ({ kind: 'live', startIdentity: 'synthetic-owner' }),
      prepare: async ready => { afterSync = ready; }, drain: async () => {}, closeStores: () => {}, homeChangeInProgress: async () => false,
      notices: { publish: async () => {}, clear: async () => {} }, observe: async () => ({ reachability: 'reachable', suspensions: [], readiness: [{ origin: 'hub-operation', opId: 'move-a', sessionId: 'session-1', epoch: 2, cwd: '/example', file: '/example/session.jsonl', core: 'core-remote', terminal: 't2' }] }),
    });
    await Promise.all([afterSync(peer, []), f.operations().presentReadyTarget(f.remote)]);
    expect((await f.store.read()).presentations).toMatchObject([{ mode: 'proxy', target: f.remote, slot: { space: 'space-1', tab: 'tab-1' } }]);
    expect((await f.store.read()).presentations).toHaveLength(1);
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
    expect(f.events.filter(value => value === 'terminal.park')).toHaveLength(1);
    expect(f.requests.filter(request => request.op === 'present-ready')).toHaveLength(1);
  } finally { await hub?.stop(); await f.stop(); global.close(); }
});

test('a remote retarget remains pending until its destination screen is acknowledged', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source); await f.operations().presentReadyTarget(f.remote);
    await f.operations().prepareHandoff(f.remote.sessionId!, f.remote);
    const next = { ...f.remote, terminalId: 't4', address: 'core-remote/t4', createdMs: 14, homeEpoch: 3 } as PaneTarget;
    f.screen(false);
    expect(await f.operations().presentReadyTarget(next)).toMatchObject({ status: 'pending', reason: 'destination-screen-pending' });
    expect((await f.store.read()).presentations[0].conversion?.state).toBe('waiting-readiness');
    f.screen(true);
    expect(await f.operations().presentReadyTarget(next)).toMatchObject({ status: 'complete', presentation: { conversion: null, target: next, proxy: 't3' } });
    expect(f.events.filter(value => value === 'screen')).toHaveLength(2);
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
  } finally { await f.stop(); }
});

test('local home returns to native pane', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source); await f.operations().presentReadyTarget(f.remote);
    await f.operations().prepareHandoff(f.remote.sessionId!, f.remote);
    const local = target('core-local', 't5', 3);
    expect(await f.operations().presentReadyTarget(local)).toMatchObject({ status: 'complete', presentation: { mode: 'native', proxy: null, target: local, slot: { space: 'space-1', tab: 'tab-1' } } });
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
  } finally { await f.stop(); }
});
test('park survives moved and restarted terminal ids', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source);
    await f.store.update(s => ({ ...s, presentations: s.presentations.map(p => ({ ...p, visibility: 'parked' })) }));
    expect(await f.operations().presentReadyTarget(f.remote)).toMatchObject({ status: 'complete', presentation: { visibility: 'parked', mode: 'proxy', proxy: null } });
    expect(await f.operations().presentReadyTarget(target('core-local', 't6', 3))).toMatchObject({ status: 'complete', presentation: { visibility: 'parked', mode: 'native', proxy: null, slot: f.slot } });
    expect(f.events).toEqual(['capture']);
  } finally { await f.stop(); }
});
test('unfocused native move defers conversion without focus', async () => {
  const f = await fixture(); try {
    f.focus(false); await f.operations().prepareHandoff(f.source.sessionId!, f.source);
    expect(await f.operations().presentReadyTarget(f.remote)).toMatchObject({ status: 'pending', reason: 'waiting-focus-placeholder-unproved' });
    expect(f.events).toEqual(['capture']);
    f.focus(true); expect((await f.operations().presentReadyTarget(f.remote)).status).toBe('complete');
    expect((await f.operations().presentReadyTarget(f.remote)).status).toBe('complete');
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
  } finally { await f.stop(); }
});
test('closing presentation refuses readiness with Close again', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source);
    await f.store.update(s => ({ ...s, presentations: s.presentations.map(p => ({ ...p, visibility: 'closing', closeOperationId: 'close-1' })) }));
    const before = (await f.store.read()).presentations;
    expect(await f.operations().presentReadyTarget(f.remote)).toMatchObject({ status: 'refused', reason: 'Session changed. Close again.' });
    expect((await f.store.read()).presentations).toEqual(before);
    expect(f.events).toEqual(['capture']);
  } finally { await f.stop(); }
});
test('a concurrent stale close cannot stop the successor after handoff', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source);
    const captured = (await f.store.read()).presentations[0];
    await f.operations().presentReadyTarget(f.remote);
    expect(await f.close(captured)).toMatchObject({ status: 'refused', reason: 'Session changed. Close again.' });
    expect((await f.store.read()).presentations[0]).toMatchObject({ visibility: 'visible', target: f.remote });
    expect(f.events).not.toContain('kill');
  } finally { await f.stop(); }
});

test('app absence retains the captured presentation without hidden launches', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source); f.absent();
    expect(await f.operations().presentReadyTarget(f.remote)).toMatchObject({ status: 'pending', presentation: { target: f.source, conversion: { destination: f.remote } } });
    expect(f.events).toEqual(['capture']);
  } finally { await f.stop(); }
});
test('lost readiness reply reuses the recorded service request', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source); f.loseReadyReply();
    expect((await f.operations().presentReadyTarget(f.remote)).status).toBe('pending');
    expect((await f.operations().presentReadyTarget(f.remote)).status).toBe('complete');
    expect(f.requests.filter(request => request.op === 'present-ready')[0]).toEqual(f.requests.filter(request => request.op === 'present-ready')[1]);
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
    expect(f.events.filter(value => value === 'terminal.park')).toHaveLength(1);
  } finally { await f.stop(); }
});
test('a replaced native terminal is never parked by stale source evidence', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source); f.replaceSource();
    expect(await f.operations().presentReadyTarget(f.remote)).toMatchObject({ status: 'pending', reason: 'source-retirement-unverified' });
    expect(f.events).not.toContain('terminal.park');
    expect(f.events).not.toContain('kill');
  } finally { await f.stop(); }
});

test('handoff removal cannot create a replacement presentation', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source);
    await f.store.update(state => ({ ...state, presentations: [] }));
    expect(await f.operations().presentReadyTarget(f.remote)).toMatchObject({ status: 'pending', reason: 'source-view-unavailable' });
    expect((await f.store.read()).presentations).toEqual([]);
    expect(f.events).toEqual(['capture']);
  } finally { await f.stop(); }
});

test('uncertain launch never starts another proxy on readiness retry', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source); f.loseLaunch();
    expect((await f.operations().presentReadyTarget(f.remote)).status).toBe('pending');
    expect((await f.operations().presentReadyTarget(f.remote)).status).toBe('pending');
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
    expect((await f.store.read()).presentations[0].launch).toBe('uncertain');
  } finally { await f.stop(); }
});


test('a lost conversion launch reply recovers through the service without another launch', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source); f.loseLaunch();
    const row = { origin: 'hub-operation' as const, opId: 'move-1', sessionId: 'session-1', epoch: 2, core: 'core-remote', terminal: 'box-1.invalid/t2', cwd: '/example', file: '/example/session.jsonl' };
    expect(await f.placement().reconcile([row])).toEqual({ pending: [row.terminal] });
    f.recoverLaunch();
    expect(await f.placement().reconcile([row])).toEqual({ pending: [] });
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
    expect(f.events.filter(value => value === 'terminal.park')).toHaveLength(1);
    expect((await f.store.read()).presentations).toMatchObject([{ target: f.remote, proxy: 't3', launch: 'acknowledged' }]);
  } finally { await f.stop(); }
});
test.each([1, 2])('conversion spawn failures are retried at most twice: %i failure(s)', async failures => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source); f.failSpawns(failures);
    const row = { origin: 'hub-operation' as const, opId: 'move-1', sessionId: 'session-1', epoch: 2, core: 'core-remote', terminal: 'box-1.invalid/t2', cwd: '/example', file: '/example/session.jsonl' };
    expect(await f.placement().reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(await f.placement().reconcile([row])).toEqual({ pending: failures === 1 ? [] : [row.terminal] });
    expect(await f.placement().reconcile([row])).toEqual({ pending: failures === 1 ? [] : [row.terminal] });
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(2);
    expect(f.events.filter(value => value === 'terminal.park')).toHaveLength(failures === 1 ? 1 : 0);
    expect((await f.store.read()).presentations[0].launch).not.toBe('uncertain');
  } finally { await f.stop(); }
});
test('an uncertain legacy claim with the service present cannot create a second view', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source);
    const attempt = { session: 'session-1', remote: 'box-1.invalid/t2', core: 'core-remote', proxy: null, closed: false, localOwners: [], failure: { attempts: 1, retryable: false } };
    await f.store.update(state => ({ ...state, attempts: [attempt] }));
    const row = { origin: 'hub-operation' as const, opId: 'move-1', sessionId: 'session-1', epoch: 2, core: 'core-remote', terminal: 'box-1.invalid/t2', cwd: '/example', file: '/example/session.jsonl' };
    expect(await f.placement().reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(f.events.filter(value => value === 'proxy')).toEqual([]);
    expect((await f.store.read()).attempts).toEqual([attempt]);
    f.lateLegacy();
    expect(await f.placement().reconcile([row])).toEqual({ pending: [] });
    expect(f.displays.size).toBe(1);
    expect(f.placements.has('legacy-proxy' as TerminalAddress)).toBe(false);
    expect((await f.store.read()).attempts[0]).toMatchObject({ closed: true, failure: { attempts: 1, retryable: false } });
    expect((await f.store.read()).presentations).toHaveLength(1);
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
  } finally { await f.stop(); }
});


test('an in-progress ready operation retains its identity until completion', async () => {
  const f = await fixture(); const gate = f.blockReady(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source);
    const running = f.operations().presentReadyTarget(f.remote);
    await gate.started;
    expect(await running).toMatchObject({ status: 'pending', reason: 'operation-in-progress' });
    gate.release(); await gate.done;
    expect(await f.operations().presentReadyTarget(f.remote)).toMatchObject({ status: 'complete' });
    const requests = f.requests.filter(request => request.op === 'present-ready');
    expect(requests[1]).toEqual(requests[0]);
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
    expect(f.events.filter(value => value === 'terminal.park')).toHaveLength(1);
  } finally { gate.release(); await f.stop(); }
});
test('readiness after a park asks for its original outcome without retiring the source again', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source);
    expect((await f.operations().presentReadyTarget(f.remote)).status).toBe('complete');
    await f.store.update(state => ({ ...state, presentations: state.presentations.map(p => ({ ...p, visibility: 'parked', revision: p.revision + 1 })) }));
    expect(await f.operations().presentReadyTarget(f.remote)).toMatchObject({ status: 'complete', presentation: { visibility: 'parked' } });
    const requests = f.requests.filter(request => request.op === 'present-ready');
    expect(requests[1]).toEqual(requests[0]);
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
    expect(f.events.filter(value => value === 'terminal.park')).toHaveLength(1);
  } finally { await f.stop(); }
});
test('a restart between conversion commit and outcome write recovers the original operation', async () => {
  const f = await fixture(); try {
    await f.operations().prepareHandoff(f.source.sessionId!, f.source); f.interruptOutcome();
    expect((await f.operations().presentReadyTarget(f.remote)).status).toBe('pending');
    expect((await f.store.read()).presentations[0]).toMatchObject({ target: f.remote, conversion: null });
    await f.restartService();
    expect(await f.operations().presentReadyTarget(f.remote)).toMatchObject({ status: 'complete' });
    expect((await f.operations().presentReadyTarget(f.remote)).status).toBe('complete');
    const requests = f.requests.filter(request => request.op === 'present-ready');
    expect(requests[1]).toEqual(requests[0]);
    expect(f.events.filter(value => value === 'proxy')).toHaveLength(1);
    expect(f.events.filter(value => value === 'terminal.park')).toHaveLength(1);
  } finally { await f.stop(); }
});
