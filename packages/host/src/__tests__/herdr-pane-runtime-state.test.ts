// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths } from '@spider/db-core';
import { createProductionRoamPresentationPorts, type RoamPresentationPorts } from '../herdr/roam-presentations.js';
import * as paneSocket from '../../../herdr/src/panes/socket.js';
import { createPaneRuntime, type PaneRuntime } from '../herdr/pane-runtime.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { parsePanePresentation } from '../../../herdr/src/panes/codec.js';
import type { HerdrConfig, HcClient, TerminalSummary } from '../../../herdr/src/contracts.js';
import type { PresentedAuxiliaryOptions } from '../../../herdr/src/panes/auxiliary.js';
import type { PaneAgentRow, PanePresentation, PaneTerminalFacts } from '../../../herdr/src/panes/types.js';
import { createRoamPlacement, createRoamPresentationOperations } from '../../../herdr/src/roam-placement.js';
const boundary = vi.hoisted(() => ({ client: null as HcClient | null, facts: vi.fn(), app: {} as Record<string, unknown>, rows: [] as PaneAgentRow[], remote: vi.fn(), auxiliary: null as PresentedAuxiliaryOptions | null, terminals: new Map<string, TerminalSummary>(), layout: { spaces: [] } as unknown }));
vi.mock('../../../herdr/src/client/hc.js', () => ({ createHcClient: () => boundary.client, invokeCli: vi.fn(async (_binary, args) => {
  if (args[0] === 'machine') return { machines: [{ name: 'box-1.invalid', aliases: [], id: 'core-remote', machine_id: 'machine-1', state: 'connected' }, { name: 'box-2.invalid', aliases: [], id: 'core-second', machine_id: 'machine-2', state: 'connected' }] };
  if (args[0] === 'read') return { text: 'Ready', how: 'screen', complete: true };
  if (args[0] === 'get') {
    const address = String(args[1]), terminal = boundary.terminals.get(address.split('/').at(-1)!);
    const target = boundary.rows.find(row => row.target?.address === address)?.target;
    return { address, parent: terminal?.parent ?? null, state: terminal?.state ?? 'live', labels: terminal?.labels ?? target?.identityLabels ?? {}, status: null, exit_code: null, reason: null, signal: null, finished_ms: null, created_ms: 17, title: 'Example', cols: 80, rows: 24 };
  }
  throw new Error('Unexpected CLI call');
}) }));
vi.mock('../../../herdr/src/client/argv-client.js', () => ({ createArgvClient: () => ({ exec: async () => { throw new Error('Unexpected process execution'); } }) }));
vi.mock('../../../herdr/src/client/app.js', () => ({ createAppClient: () => boundary.app }));
vi.mock('../../../herdr/src/client/cli-transport.js', () => ({ invokeCli: vi.fn(async (_binary, args) => args[0] === 'commands' ? [] : boundary.layout) }));
vi.mock('../../../herdr/src/panes/hc.js', () => ({ readPaneTerminal: (...args: unknown[]) => boundary.facts(...args) }));
vi.mock('../../../herdr/src/client/liveness.js', () => ({ isCoreAvailable: async () => true }));
vi.mock('../herdr/bin/pane-endpoint.js', () => ({ createProductionPaneEndpointPorts: () => ({}) }));
vi.mock('../herdr/pane-endpoint.js', () => ({ handleRemotePaneRequest: async () => ({ version: 1, op: 'list', page: { version: 1, rows: boundary.rows.filter(row => row.target?.coreId === 'core-local'), complete: true, next: null } }) }));
vi.mock('../herdr/pane-transport.js', () => ({ createPaneRemoteRequest: () => boundary.remote }));
vi.mock('../../../herdr/src/panes/auxiliary.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../herdr/src/panes/auxiliary.js')>();
  return { ...actual, createPresentedAuxiliaryPanes: (options: PresentedAuxiliaryOptions) => { boundary.auxiliary = options; return actual.createPresentedAuxiliaryPanes(options); } };
});
const productionPorts: RoamPresentationPorts[] = [];
const resources: { root: string; runtime: PaneRuntime }[] = [];
afterEach(async () => { for (const ports of productionPorts.splice(0)) await ports.dispose(); for (const { root, runtime } of resources.splice(0)) { await runtime.dispose(); await rm(root, { recursive: true, force: true }); } vi.restoreAllMocks(); vi.clearAllMocks(); });
async function fixture(spaces: HerdrConfig['spaces'] = []) {
  const base = join(paths.scratch('worktree', process.cwd()), 'pane-runtime-state'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'f-'));
  boundary.rows = []; boundary.terminals.clear(); boundary.app = {}; boundary.layout = { spaces: [] }; boundary.remote.mockImplementation(async (_machine, request) => {
    if (request.op !== 'list') throw new Error('Unexpected remote effect');
    return { version: 1, op: 'list', page: { version: 1, rows: boundary.rows.filter(row => row.target?.coreId === _machine.coreId), complete: true, next: null } };
  });
  const config = parseHerdrConfig({ mode: 'full', app: { binary: '/owned/app', home: join(root, 'app') }, core: { binary: '/owned/hc', config: join(root, 'core.toml') }, globalRoot: root, agentDirectory: join(root, 'agent'), shellRc: join(root, 'shellrc'),
    machines: ['box-1.invalid', 'box-2.invalid'].map(name => ({ name, nodePath: '/usr/bin/node', runtime: { directory: '/home/example/runtime', commands: {} } })), spaces });
  const hc = { identity: async () => ({ coreId: 'core-local', socket: '/owned/core.sock', sessionNamespace: 'fixture' }),
    get: vi.fn(async address => boundary.terminals.get(String(address).split('/').at(-1)!) ?? { address, state: 'live' }),
    run: vi.fn(async request => { const address = 'proxy-1'; boundary.terminals.set(address, { address: address as never, state: 'live', labels: request.labels, parent: null, status: null, exitCode: null, reason: null, signal: null, finishedAt: null, cols: 80, rows: 24 }); return { address, coreId: 'core-local' }; }),
    events: () => ({ ready: Promise.resolve(), subscribe: (listener: Parameters<ReturnType<HcClient['events']>['subscribe']>[0]) => { listener({ type: 'snapshot', seq: 1, terminals: [...boundary.terminals.values()] }); return () => {}; }, dispose() {} }),
    kill: vi.fn(async address => { const terminal = boundary.terminals.get(String(address)); if (terminal) terminal.state = 'finished'; }),
    rm: vi.fn(async address => { boundary.terminals.delete(String(address)); }), dispose: async () => {}, setLabels: vi.fn() } as unknown as HcClient;
  boundary.client = hc;
  boundary.facts.mockImplementation(async target => facts({ target, id: target.terminalId } as PanePresentation));
  const input = { config, hc, env: {}, packageRoot: process.cwd(), endpointBytes: Buffer.from('synthetic endpoint') };
  const runtime = createPaneRuntime(input), resource = { root, runtime };
  resources.push(resource); return { root, runtime, hc, config, restart: async () => { await resource.runtime.dispose(); resource.runtime = createPaneRuntime(input); return resource.runtime; } };
}
function presentation(id: string, visibility: PanePresentation['visibility'] = 'visible'): PanePresentation {
  return parsePanePresentation({ id, revision: 1, mode: 'proxy', role: 'shell', target: { coreId: 'core-remote', terminalId: id, address: `core-remote/${id}`, createdMs: 17, identityLabels: { 'spider.pane-operation': id }, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'terminal', sessionId: null, generation: null, homeEpoch: null, runId: null, consoleId: null, name: id, cwd: '/home/example' }, proxy: null, slot: null, visibility, launch: 'none', closeOperationId: null, conversion: null });
}
function facts(p: PanePresentation): PaneTerminalFacts {
  return { terminal: { address: p.target.address, state: 'live', labels: p.target.identityLabels, parent: null, status: null, exitCode: null, reason: null, signal: null, finishedAt: null, cols: 80, rows: 24 }, createdMs: 17, identityLabels: p.target.identityLabels, currentCwd: '/home/example', title: p.id, app: null, status: null };
}
function installPlacementApp() {
  let placeholder = false, placed = false, focused = 'owner-pane', placeholderOperation = '';
  const slot = { space: 's1', tab: 'tb1', pane: 'proxy-pane' };
  const space = { id: 's1', name: 'Work', machine: null, tabs: [{ id: 'tb1', name: 'Work' }] };
  const updateLayout = () => { boundary.layout = { spaces: [{ ...space, tabs: [{ ...space.tabs[0], panes: [{ id: 'owner-pane' }, ...(placeholder ? [{ id: 'placeholder', mod: 'spider-pane-waiting', props: { operationId: placeholderOperation } }] : [])] }] }] }; };
  updateLayout();
  Object.assign(boundary.app, {
    listSpaces: async () => [space], tabPanes: async () => [], tabTerminals: async () => placed ? ['proxy-1'] : [],
    ownerPlacement: async () => { if (!placed) throw new HerdrError('owner-unplaced', 'Not placed'); return slot; },
    focusedPane: async () => ({ ...slot, pane: focused }),
    command: vi.fn(async (name, args) => {
      if (name === 'pane.split') { placeholder = true; placeholderOperation = args.props.operationId; updateLayout(); return { pane: 'placeholder' }; }
      if (name === 'pane.focus') focused = args.pane;
      if (name === 'terminal.keep') placed = true;
      if (name === 'pane.close') { placeholder = false; updateLayout(); }
      return {};
    }),
  });
}
function sessionRow(generation = 'gen-1'): Extract<PaneAgentRow, { unavailableReason: null }> {
  const target = { ...presentation('execution').target, kind: 'session' as const, sessionId: 'session-1' as never, generation: generation as never, homeEpoch: 0, name: 'Builder' };
  return { sessionId: 'session-1' as never, generation: generation as never, target, name: 'Builder', status: 'working', updatedAt: 1, machineKey: 'core-remote', unavailableReason: null, children: [], consoles: [],
    owner: { sessionId: 'session-1' as never, generation: generation as never, terminal: { coreId: 'core-remote' as never, terminalId: 'execution' as never, address: 'core-remote/execution' as never, socket: '/owned/remote.sock', sessionNamespace: 'fixture' }, cwd: '/home/example', sessionFile: null, name: 'Builder' } };
}
test('a discovered remote session without a slot opens in its configured space', async () => {
  const { runtime, hc } = await fixture([{ name: 'Work', sessions: [{ name: 'Builder' }] }]); installPlacementApp(); boundary.rows = [sessionRow()];
  const service = runtime.createService(); await service.reconcile();
  expect((await runtime.store.read()).presentations).toMatchObject([{ slot: null, proxy: null, launch: 'none' }]);
  const result = await service.request({ version: 1, op: 'open-existing', operationId: 'click-session', sessionId: 'session-1' as never, generation: 'gen-1' as never, slot: null });
  expect(result).toMatchObject({ outcome: { status: 'complete', reason: 'proxy-presented', presentation: { slot: { space: 's1', tab: 'tb1', pane: 'proxy-pane' } } } });
  expect(hc.run).toHaveBeenCalledTimes(1);
  boundary.rows = [sessionRow('gen-2')]; await service.reconcile();
  const afterReload = await service.request({ version: 1, op: 'open-existing', operationId: 'click-reloaded', sessionId: 'session-1' as never, generation: 'gen-2' as never, slot: null });
  expect(afterReload).toMatchObject({ outcome: { status: 'complete', presentation: { target: { generation: 'gen-2' }, proxy: 'proxy-1' } } });
  const current = (await runtime.store.read()).presentations[0];
  expect(await service.request({ version: 1, op: 'move', operationId: 'move-reloaded', presentationId: current.id, expectedRevision: current.revision, slot: { space: 's1' as never, tab: 'tb1' as never, pane: null } }))
    .toMatchObject({ outcome: { status: 'complete', presentation: { target: { generation: 'gen-2' } } } });
  expect((await runtime.store.read()).presentations).toHaveLength(1); expect(hc.run).toHaveBeenCalledTimes(1);
});
test('completed handoff replays after restart but a different operation cannot capture it', async () => {
  const { runtime, hc, restart } = await fixture();
  Object.assign(boundary.app, { focusedPane: async () => null });
  const source = sessionRow(), destination = sessionRow('gen-2');
  destination.target = { ...destination.target, terminalId: 'moved' as never, address: 'core-remote/moved' as never, homeEpoch: 1 };
  boundary.rows = [source];
  const p = { ...presentation('handoff'), role: 'agent' as const, target: source.target, visibility: 'parked' as const, slot: { space: 's1' as never, tab: 'tb1' as never, pane: 'old-pane' as never } };
  await runtime.store.update(state => ({ ...state, presentations: [p] }));
  const service = runtime.createService();
  expect(await service.request({ version: 1, op: 'prepare-handoff', operationId: 'capture-1', presentationId: p.id, expectedRevision: 1, sessionId: source.sessionId, generation: source.generation, homeEpoch: 0 })).toMatchObject({ outcome: { status: 'complete' } });
  boundary.rows = [destination];
  const request = { version: 1 as const, op: 'present-ready' as const, operationId: 'ready-1', presentationId: p.id, expectedRevision: 1, target: destination.target };
  const completed = await service.request(request);
  expect(completed).toMatchObject({ outcome: { status: 'complete', presentation: { visibility: 'parked', target: destination.target } } });
  const restarted = await restart(), next = restarted.createService();
  expect(await next.request(request)).toEqual(completed);
  const current = (await restarted.store.read()).presentations[0];
  expect(await next.request({ ...request, operationId: 'different-ready', expectedRevision: current.revision })).toMatchObject({ outcome: { status: 'refused' } });
  expect((await restarted.store.read()).presentations[0]).toEqual(current);
  expect(hc.run).not.toHaveBeenCalled();
});

test('app absence captures durable handoff intent and a screen retry resumes the same proxy', async () => {
  const { runtime, hc } = await fixture();
  let absent = true;
  const slot = { space: 's1' as never, tab: 'tb1' as never, pane: 'old-pane' as never };
  const commands = vi.fn(async () => ({}));
  Object.assign(boundary.app, { ownerPlacement: async () => { if (absent) throw new HerdrError('app-disconnected', 'App is absent'); return slot; },
    focusedPane: async () => { if (absent) throw new HerdrError('app-disconnected', 'App is absent'); return null; }, command: commands });
  const source = sessionRow(), destination = sessionRow('gen-2');
  destination.target = { ...destination.target, terminalId: 'moved' as never, address: 'core-remote/moved' as never, homeEpoch: 1 };
  boundary.rows = [source];
  const p = { ...presentation('handoff'), role: 'agent' as const, target: source.target, visibility: 'visible' as const, slot, proxy: 'proxy-1' as never, launch: 'acknowledged' as const };
  boundary.terminals.set('proxy-1', { ...facts(p).terminal, address: 'proxy-1' as never });
  const service = runtime.createService();
  await runtime.store.update(state => ({ ...state, presentations: [{ ...p, slot: null }] }));
  expect(await service.request({ version: 1, op: 'prepare-handoff', operationId: 'capture-no-slot', presentationId: p.id, expectedRevision: 1, sessionId: source.sessionId, generation: source.generation, homeEpoch: 0 })).toMatchObject({ outcome: { status: 'pending', reason: 'source-view-unavailable', presentation: { slot: null } } });
  await runtime.store.update(state => ({ ...state, presentations: [p] }));
  expect(await service.request({ version: 1, op: 'prepare-handoff', operationId: 'capture-absent', presentationId: p.id, expectedRevision: 1, sessionId: source.sessionId, generation: source.generation, homeEpoch: 0 })).toMatchObject({ outcome: { status: 'pending', presentation: { slot } } });
  boundary.rows = [destination];
  const ready = { version: 1 as const, op: 'present-ready' as const, operationId: 'ready-absent', presentationId: p.id, expectedRevision: 1, target: destination.target };
  expect(await service.request(ready)).toMatchObject({ outcome: { status: 'pending', presentation: { target: destination.target, conversion: { state: 'waiting-readiness' } } } });
  const waiting = (await runtime.store.read()).presentations[0];
  absent = false;
  expect(await service.request({ ...ready, operationId: 'ready-screen', expectedRevision: waiting.revision })).toMatchObject({ outcome: { status: 'complete', presentation: { target: destination.target, proxy: 'proxy-1', slot, conversion: null } } });
  expect(hc.run).not.toHaveBeenCalled();
  expect(commands).not.toHaveBeenCalled();
});

test.each(['restored home', 'parked restored home', 'hosting restart', 'box start', 'unplaced session', 'closing presentation', 'stale generation', 'stale epoch'] as const)('production readiness without a handoff handles %s', async scenario => {
  const { root, runtime, hc } = await fixture();
  const slot = { space: 's1' as never, tab: 'tb1' as never, pane: 'old-pane' as never };
  const placements = new Map<string, typeof slot>([['old-proxy', slot]]);
  let focused = slot;
  const commands = vi.fn(async (name: string, args: Record<string, string>) => {
    if (name === 'terminal.keep') { focused = { ...slot, pane: 'replacement' as never }; placements.set(args.terminal, focused); }
    if (name === 'terminal.park') placements.delete(args.terminal);
    return {};
  });
  Object.assign(boundary.app, { focusedPane: async () => focused,
    ownerPlacement: async (address: string) => { const p = placements.get(address); if (!p) throw new HerdrError('owner-unplaced', 'Not placed'); return p; },
    tabTerminals: async () => [...placements.keys()], command: commands });
  const source = sessionRow(), destination = sessionRow('gen-2');
  const restored = scenario.includes('restored');
  destination.target = { ...destination.target, terminalId: 'ready' as never, address: `${restored ? 'core-local' : 'core-remote'}/ready` as never,
    coreId: (restored ? 'core-local' : 'core-remote') as never, alias: restored ? null : 'box-1.invalid', machineId: restored ? null : 'machine-1', homeEpoch: restored ? 1 : 0 };
  destination.machineKey = destination.target.coreId;
  destination.owner = { ...destination.owner, terminal: { ...destination.owner.terminal, coreId: destination.target.coreId, terminalId: destination.target.terminalId, address: destination.target.address } };
  boundary.rows = [destination];
  const p = { ...presentation('existing'), target: source.target, role: 'agent' as const, proxy: 'old-proxy' as never, slot,
    visibility: scenario === 'parked restored home' ? 'parked' as const : scenario === 'closing presentation' ? 'closing' as const : 'visible' as const, closeOperationId: scenario === 'closing presentation' ? 'close-1' : null, launch: 'acknowledged' as const };
  boundary.terminals.set('old-proxy', { ...facts(p).terminal, address: 'old-proxy' as never, labels: { 'spider.kind': 'pane-proxy', 'spider.pane-id': p.id, 'spider.target-core': source.target.coreId, 'spider.target-terminal': source.target.terminalId } });
  if (scenario !== 'unplaced session') await runtime.store.update(state => ({ ...state, presentations: [p] }));
  const service = runtime.createService();
  const operations = createRoamPresentationOperations({ stateRoot: join(root, 'roam', 'placement'), hc, app: boundary.app as never, request: request => service.request(request) });
  const readyTarget = { ...destination.target, ...(scenario === 'stale generation' ? { generation: 'gen-stale' as never } : {}), ...(scenario === 'stale epoch' ? { homeEpoch: 99 } : {}) };
  let outcome = await operations.presentReadyTarget(readyTarget);
  while (outcome.status === 'pending' && outcome.reason === 'operation-in-progress') outcome = await operations.presentReadyTarget(readyTarget);
  if (scenario === 'closing presentation' || scenario.startsWith('stale ')) {
    expect(outcome).toMatchObject({ status: scenario === 'closing presentation' ? 'refused' : 'pending', reason: scenario === 'closing presentation' ? 'Session changed. Close again.' : 'readiness-unavailable' });
    expect((await runtime.store.read()).presentations[0]).toEqual(p);
    expect(commands).not.toHaveBeenCalled();
  } else if (scenario === 'unplaced session') {
    expect(outcome).toMatchObject({ status: 'pending', reason: 'source-view-unavailable' });
    expect((await runtime.store.read()).presentations).toEqual([]);
    expect(commands).not.toHaveBeenCalled();
  } else {
    expect(outcome).toMatchObject({ status: 'complete', presentation: { id: 'existing', target: destination.target, mode: restored ? 'native' : 'proxy',
      proxy: restored ? null : 'old-proxy', slot: { space: 's1', tab: 'tb1' }, visibility: scenario === 'parked restored home' ? 'parked' : 'visible' } });
    expect((await runtime.store.read()).presentations).toHaveLength(1);
    expect(commands.mock.calls.map(([name]) => name)).toEqual(scenario === 'restored home' ? ['terminal.keep', 'terminal.park'] : []);
  }
  expect(hc.run).not.toHaveBeenCalled();
  expect(hc.kill).toHaveBeenCalledTimes(scenario === 'restored home' ? 1 : 0);
});

test.each(['moved proxy', 'closed moved proxy', 'new native terminal'])('the production slot store places the next terminal after a %s', async previous => {
  const { root, runtime, hc } = await fixture();
  const slot = { space: 's2' as never, tab: 'tb2' as never, pane: 'old-pane' as never };
  let focused = slot;
  const placements = new Map<string, typeof slot>([[previous === 'new native terminal' ? 'native-2' : 'legacy-proxy', slot]]);
  const spaces = [{ id: 's2', name: 'Moved', machine: null, tabs: [{ id: 'tb2', name: 'Moved' }] }];
  Object.assign(boundary.app, { listSpaces: async () => spaces, focusedPane: async () => focused,
    tabPanes: async () => [...placements].map(([terminal, p]) => ({ terminal, pane: p.pane })),
    ownerPlacement: async (address: string) => { const p = placements.get(address); if (!p) throw new HerdrError('owner-unplaced', 'Not placed'); return p; },
    tabTerminals: async () => [...placements.keys()],
    command: async (name: string, args: Record<string, string>) => {
      if (name === 'pane.split') return { pane: 'placeholder' };
      if (name === 'pane.focus') focused = { ...slot, pane: args.pane as never };
      if (name === 'terminal.keep') { focused = { ...slot, pane: 'new-pane' as never }; placements.set(args.terminal, focused); }
      if (name === 'terminal.park') placements.delete(args.terminal);
      return {};
    } });
  let placeholder = false;
  boundary.layout = { spaces: [{ id: 's2', machine: null, tabs: [{ id: 'tb2', panes: [{ id: 'old-pane' }] }] }] };
  const command = boundary.app.command as (name: string, args: Record<string, string>) => Promise<Record<string, unknown>>;
  boundary.app.command = async (name: string, args: Record<string, string> & { props?: { operationId: string } }) => {
    const reply = await command(name, args);
    if (name === 'pane.split') placeholder = true;
    if (name === 'pane.close') placeholder = false;
    boundary.layout = { spaces: [{ id: 's2', machine: null, tabs: [{ id: 'tb2', panes: [{ id: 'old-pane' }, ...(placeholder ? [{ id: 'placeholder', mod: 'spider-pane-waiting', props: { operationId: args.props?.operationId ?? 'open-next' } }] : [])] }] }] };
    return reply;
  };
  const owner = { ...sessionRow().owner, terminal: { ...sessionRow().owner.terminal, coreId: 'core-local' as never, terminalId: 'native-2' as never, address: 'native-2' as never } };
  const legacy = { address: 'legacy-proxy' as never, state: 'live' as const, labels: { 'spider.kind': 'roam-proxy', 'spider.session': 'session-1', 'spider.owner-core': 'core-remote', 'spider.owner-terminal': 'box-1.invalid/old' }, parent: null, status: null, exitCode: null, reason: null, signal: null, finishedAt: null };
  boundary.terminals.set(previous === 'new native terminal' ? 'native-2' : 'legacy-proxy', previous === 'new native terminal' ? { ...legacy, address: 'native-2' as never, labels: {} } : legacy);
  await runtime.store.update(state => ({ ...state, slots: [{ session: 'session-1', space: 's1', tab: 'tb1' }], attempts: previous === 'new native terminal' ? [] : [{ session: 'session-1', remote: 'box-1.invalid/old', core: 'core-remote', proxy: 'legacy-proxy', closed: false, localOwners: [] }] }));
  const service = runtime.createService(), stateRoot = join(root, 'roam', 'placement');
  const operations = createRoamPresentationOperations({ stateRoot, hc, app: boundary.app as never, request: request => service.request(request) });
  const row = sessionRow('gen-2'); row.target = { ...row.target, terminalId: 'next' as never, address: 'core-remote/next' as never };
  boundary.rows = [row];
  const placement = createRoamPlacement({ stateRoot, hc, hcBinary: '/owned/hc', app: boundary.app as never,
    registry: { list: async () => previous === 'new native terminal' ? [{ owner, recordedAt: 1 }] : [] } as never,
    presentation: { resolveTarget: async () => row.target, presentReadyTarget: target => operations.presentReadyTarget(target) } });
  await placement.reconcile([]);
  expect((await runtime.store.read()).slots).toEqual([{ session: 'session-1', space: 's2', tab: 'tb2' }]);
  if (previous === 'closed moved proxy') { boundary.terminals.set('legacy-proxy', { ...legacy, state: 'finished' }); placements.delete('legacy-proxy'); }
  await placement.reconcile([]);
  await service.reconcile();
  expect(await service.request({ version: 1, op: 'open-existing', operationId: 'open-next', sessionId: row.sessionId, generation: row.generation, slot: null }))
    .toMatchObject({ outcome: { status: 'complete', presentation: { slot: { space: 's2', tab: 'tb2' }, target: { terminalId: 'next' } } } });
  expect(hc.run).toHaveBeenCalledTimes(1);
  expect((await runtime.store.read()).presentations).toHaveLength(1);
});

test('production waiting claims are removed on release and do not block the same view from reopening', async () => {
  const { root, runtime, hc } = await fixture(); const owner = sessionRow().owner; runtime.createService();
  const first = await boundary.auxiliary!.waitingPresentation!('subagent', 'run-1' as never, owner);
  await hc.kill(first.address); await hc.rm(first.address);
  await boundary.auxiliary!.releaseWaitingPresentation?.('subagent', 'run-1' as never, owner, first.address);
  expect(await readdir(join(root, 'herdr/panes/waiting'))).toEqual([]);
  const second = await boundary.auxiliary!.waitingPresentation!('subagent', 'run-1' as never, owner);
  expect(second).toMatchObject({ address: 'proxy-1', coreId: 'core-local' }); expect(hc.run).toHaveBeenCalledTimes(2);
});
test('production recovers a dead waiting claim even after helper state was lost', async () => {
  const { runtime, hc, restart } = await fixture(); const owner = sessionRow().owner; runtime.createService();
  const first = await boundary.auxiliary!.waitingPresentation!('console', 'console-1' as never, owner);
  await hc.kill(first.address); await hc.rm(first.address);
  (await restart()).createService();
  expect(await boundary.auxiliary!.waitingPresentation!('console', 'console-1' as never, owner)).toMatchObject({ address: 'proxy-1' });
  expect(hc.run).toHaveBeenCalledTimes(2);
});
test('production waiting launch failure releases the claim and lost replies reuse the labelled display', async () => {
  const { root, runtime, hc } = await fixture(); const owner = sessionRow().owner; runtime.createService();
  const launch = vi.mocked(hc.run).getMockImplementation()!;
  vi.mocked(hc.run).mockRejectedValueOnce(new Error('launch failed'));
  await expect(boundary.auxiliary!.waitingPresentation!('subagent', 'run-1' as never, owner)).rejects.toThrow('launch failed');
  expect(await readdir(join(root, 'herdr/panes/waiting'))).toEqual([]);
  vi.mocked(hc.run).mockImplementationOnce(async input => { await launch(input); throw new Error('reply lost'); });
  expect(await boundary.auxiliary!.waitingPresentation!('subagent', 'run-1' as never, owner)).toMatchObject({ address: 'proxy-1' });
  expect(hc.run).toHaveBeenCalledTimes(2);
});
test('only the agent presentation can anchor auxiliary panes', async () => {
  const { runtime } = await fixture(); const row = sessionRow(); runtime.createService();
  const agent = { ...presentation('agent'), role: 'agent' as const, target: row.target, proxy: 'agent-proxy' as never };
  const console = { ...agent, id: 'console', role: 'console' as const, proxy: 'console-proxy' as never, target: { ...row.target, kind: 'console' as const, consoleId: ('console-' + 'a'.repeat(64)) as never } };
  await runtime.store.update(s => ({ ...s, presentations: [console, agent] }));
  expect(await boundary.auxiliary!.ownerPresentation(row.owner)).toBe('agent-proxy');
});
test('an ambiguous live proxy inventory never permits another proxy launch', async () => {
  const { runtime, hc } = await fixture(); const row = sessionRow(); installPlacementApp(); boundary.rows = [row];
  const p = { ...presentation('ambiguous'), role: 'agent' as const, target: row.target, launch: 'uncertain' as const, slot: { space: 's1' as never, tab: 'tb1' as never, pane: null } };
  await runtime.store.update(s => ({ ...s, presentations: [p] }));
  for (const address of ['duplicate-1', 'duplicate-2']) boundary.terminals.set(address, { ...facts(p).terminal, address: address as never, labels: { 'spider.kind': 'pane-proxy', 'spider.pane-id': p.id, 'spider.target-core': row.target.coreId, 'spider.target-terminal': row.target.terminalId } });
  const service = runtime.createService(); await service.reconcile();
  expect(await service.request({ version: 1, op: 'open-existing', operationId: 'ambiguous-click', sessionId: row.sessionId, generation: row.generation, slot: null }))
    .toMatchObject({ outcome: { status: 'pending', reason: 'proxy-launch-uncertain' } });
  expect(hc.run).not.toHaveBeenCalled();
});
test('production facts cancel the whole pass within the existing endpoint budget', async () => {
  const f = await fixture(); const service = f.runtime.createService(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), signals: AbortSignal[] = [];
  const presentations = Array.from({ length: 17 }, (_, index) => presentation(`live-${index}`));
  await f.runtime.store.update(state => ({ ...state, presentations }));
  boundary.facts.mockImplementation(async (_target, options) => {
    signals.push(options.signal); if (signals.length === 4) started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new HerdrError('aborted', 'Cancelled')), { once: true }));
  });
  vi.useFakeTimers();
  const running = service.reconcile();
  try {
    await ready; await vi.advanceTimersByTimeAsync(5000); const probesAtDeadline = signals.length;
    await service.stop(); await running;
    expect(probesAtDeadline).toBe(4); expect(signals.every(signal => signal.aborted)).toBe(true);
  } finally { await service.stop(); vi.useRealTimers(); await f.runtime.dispose(); }
});
test('production facts skip ended history and read live presentations with bounded concurrency', async () => {
  const { runtime } = await fixture(); const live = Array.from({ length: 8 }, (_, i) => presentation(`live-${i}`));
  await runtime.store.update(s => ({ ...s, presentations: [...live, presentation('ended', 'ended')] }));
  let active = 0, maximum = 0; const releases: (() => void)[] = [], read: string[] = [];
  boundary.facts.mockImplementation(async target => {
    read.push(target.terminalId); active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => releases.push(resolve)); active--;
    return facts(live.find(p => p.target.terminalId === target.terminalId)!);
  });
  const service = runtime.createService(), running = service.reconcile();
  await vi.waitFor(() => expect(read.length).toBeGreaterThan(0));
  const firstBatch = read.length;
  while (read.length < 8 || active) {
    releases.splice(0).forEach(release => release());
    await new Promise(resolve => setImmediate(resolve));
  }
  await running;
  expect(firstBatch).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(4);
  expect(read.sort()).toEqual(live.map(p => p.id).sort());
  boundary.facts.mockImplementation(async target => facts(live.find(p => p.target.terminalId === target.terminalId)!));
  expect(await service.request({ version: 1, op: 'snapshot', operationId: 'facts' })).toMatchObject({ targetFacts: { 'core-remote/live-0': { title: 'live-0' }, 'core-remote/live-7': { title: 'live-7' } } });
});


test.each(['app closed', 'unfocused pane', 'hosting restart'] as const)('a pending %s conversion does not prevent the next move capture', async scenario => {
  const { root, runtime, hc } = await fixture();
  const slot = { space: 's1' as never, tab: 'tb1' as never, pane: 'old-pane' as never };
  let absent = scenario !== 'unfocused pane', focused = scenario !== 'unfocused pane';
  const placements = new Map<string, typeof slot>([['execution', slot], ['old-proxy', slot]]);
  let focusSlot = slot;
  const commands = vi.fn(async (name: string, args: Record<string, string>) => {
    if (name === 'terminal.keep') { focusSlot = { ...slot, pane: 'replacement' as never }; placements.set(args.terminal, focusSlot); }
    if (name === 'terminal.park') placements.delete(args.terminal);
    return {};
  });
  Object.assign(boundary.app, {
    focusedPane: async () => { if (absent) throw new HerdrError('app-disconnected', 'App is absent'); return focused ? focusSlot : { ...slot, pane: 'other-pane' }; },
    ownerPlacement: async (address: string) => { if (absent) throw new HerdrError('app-disconnected', 'App is absent'); const found = placements.get(address); if (!found) throw new HerdrError('owner-unplaced', 'Not placed'); return found; },
    tabTerminals: async () => [...placements.keys()], command: commands,
  });
  const original = sessionRow(), first = sessionRow('gen-2'), second = sessionRow('gen-3');
  original.target = { ...original.target, homeEpoch: 1, ...(scenario === 'hosting restart' ? {} : { coreId: 'core-local' as never, address: 'core-local/execution' as never, alias: null, machineId: null }) };
  first.target = { ...first.target, terminalId: 'first' as never, address: 'core-remote/first' as never, homeEpoch: scenario === 'hosting restart' ? 1 : 2 };
  second.target = { ...second.target, coreId: 'core-second' as never, terminalId: 'second' as never, address: 'core-second/second' as never, alias: 'box-2.invalid', machineId: 'machine-2', homeEpoch: first.target.homeEpoch! + 1 };
  for (const row of [original, first, second]) { row.machineKey = row.target.coreId; row.owner = { ...row.owner, terminal: { ...row.owner.terminal, coreId: row.target.coreId, terminalId: row.target.terminalId, address: row.target.address } }; }
  const p: PanePresentation = { ...presentation('pending-conversion'), target: original.target, mode: scenario === 'hosting restart' ? 'proxy' : 'native', role: 'agent', proxy: scenario === 'hosting restart' ? 'old-proxy' as never : null, slot, launch: 'acknowledged' };
  await runtime.store.update(state => ({ ...state, presentations: [p] }));
  boundary.terminals.set('execution', { ...facts(p).terminal, address: 'execution' as never });
  if (p.proxy) boundary.terminals.set(p.proxy, { ...facts(p).terminal, address: p.proxy, labels: { 'spider.kind': 'pane-proxy', 'spider.pane-id': p.id, 'spider.target-core': original.target.coreId, 'spider.target-terminal': original.target.terminalId } });
  boundary.rows = [original];
  const service = runtime.createService();
  const operations = () => createRoamPresentationOperations({ stateRoot: join(root, 'roam', 'placement'), hc, app: boundary.app as never, request: request => service.request(request) });
  if (scenario !== 'hosting restart') expect((await operations().prepareHandoff(original.sessionId, original.target)).status).not.toBe('refused');
  boundary.rows = [first];
  expect((await operations().presentReadyTarget(first.target)).status).toBe('pending');
  // The pane service remains running while the execution source has advanced.
  const before = (await runtime.store.read()).presentations[0];
  expect(before.target).toEqual(original.target);
  expect(await operations().prepareHandoff(first.sessionId, first.target)).toMatchObject({ status: 'pending', reason: 'presentation-conversion-pending', presentation: before });
  expect((await runtime.store.read()).slots).toEqual([{ session: 'session-1', space: 's1', tab: 'tb1' }]);
  absent = false; focused = true; boundary.rows = [second];
  const outcome = await operations().presentReadyTarget(second.target);
  expect(outcome).toMatchObject({ status: 'complete', presentation: { target: second.target, mode: 'proxy', slot: { space: 's1', tab: 'tb1' }, conversion: null } });
  expect((await runtime.store.read()).presentations).toHaveLength(1);
  expect(hc.run).toHaveBeenCalledTimes(scenario === 'hosting restart' ? 0 : 1);
  expect(commands.mock.calls.filter(([name]) => name === 'pane.focus')).toEqual([]);
});


test.each(['no Mac view', 'app closed', 'service down', 'core-only'] as const)('real production presentation ports preserve capture with %s', async scenario => {
  const { root, runtime, hc, config } = await fixture();
  execFileSync('git', ['init', '-q', root]); vi.spyOn(process, 'cwd').mockReturnValue(root);
  await mkdir(join(root, 'herdr'), { recursive: true });
  await mkdir(join(root, 'dist', 'herdr'), { recursive: true });
  await writeFile(join(root, 'dist', 'herdr', 'pane-endpoint.mjs'), 'export {};');
  await writeFile(join(root, 'herdr', 'installation.json'), JSON.stringify({ version: 1, packageRoot: root }), { mode: 0o600 });
  await writeFile(join(root, 'herdr', 'config.json'), JSON.stringify({ ...config, mode: scenario === 'core-only' ? 'core-only' : 'full' }), { mode: 0o600 });
  const row = sessionRow();
  row.target = { ...row.target, homeEpoch: 1, ...(scenario === 'no Mac view' ? {} : { coreId: 'core-local' as never, address: 'core-local/execution' as never, alias: null, machineId: null }) };
  row.machineKey = row.target.coreId;
  row.owner = { ...row.owner, terminal: { ...row.owner.terminal, coreId: row.target.coreId, address: row.target.address } };
  boundary.rows = [row];
  const slot = { space: 's1' as never, tab: 'tb1' as never, pane: 'old-pane' as never };
  const commands = vi.fn(async () => ({}));
  Object.assign(boundary.app, { ownerPlacement: async () => { throw new HerdrError('app-disconnected', 'App is absent'); }, focusedPane: async () => { throw new HerdrError('app-disconnected', 'App is absent'); }, command: commands });
  if (scenario === 'app closed' || scenario === 'service down') await runtime.store.update(state => ({ ...state, presentations: [{ ...presentation('captured'), target: row.target, role: 'agent', mode: 'native', slot, launch: 'acknowledged' }] }));
  const service = runtime.createService();
  // Only the socket boundary is replaced. Both the client and service use their real composition.
  const connect = vi.spyOn(paneSocket, 'connectPaneService').mockImplementation(async () => {
    if (scenario === 'service down') throw new HerdrError('service-unavailable', 'Service is absent');
    return { request: request => service.request(request), reconcile: () => service.reconcile(), stop: async () => {} };
  });
  const ports = createProductionRoamPresentationPorts(root); productionPorts.push(ports);
  const outcome = await ports.prepareHandoff(row.sessionId, row.target);
  expect(outcome).toMatchObject({ status: 'pending', reason: scenario === 'app closed' ? 'app-unavailable' : scenario === 'no Mac view' ? 'source-view-unavailable' : 'presentation-unavailable' });
  const state = await runtime.store.read();
  expect(state.slots).toEqual(['app closed', 'service down'].includes(scenario) ? [{ session: 'session-1', space: 's1', tab: 'tb1' }] : []);
  expect(state.presentations).toHaveLength(['app closed', 'service down'].includes(scenario) ? 1 : 0);
  if (scenario === 'core-only') { expect(await ports.resolveTarget({ sessionId: row.sessionId, machineId: 'machine-1', homeEpoch: 1, local: true })).toBeNull(); expect(connect).not.toHaveBeenCalled(); }
  if (scenario === 'app closed') {
    const { readPaneHandoff } = await import('../herdr/pane-handoff.js');
    expect(await readPaneHandoff(join(root, 'herdr', 'panes'), state.presentations[0])).toEqual({ source: slot, sourceFocused: false });
  }
  expect(hc.run).not.toHaveBeenCalled();
  expect(commands).not.toHaveBeenCalled();
});

