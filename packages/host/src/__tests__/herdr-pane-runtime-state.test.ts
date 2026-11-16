// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { createPaneRuntime, type PaneRuntime } from '../herdr/pane-runtime.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { parsePanePresentation } from '../../../herdr/src/panes/codec.js';
import type { HerdrConfig, HcClient, TerminalSummary } from '../../../herdr/src/contracts.js';
import type { PresentedAuxiliaryOptions } from '../../../herdr/src/panes/auxiliary.js';
import type { PaneAgentRow, PanePresentation, PaneTerminalFacts } from '../../../herdr/src/panes/types.js';
const boundary = vi.hoisted(() => ({ facts: vi.fn(), app: {} as Record<string, unknown>, rows: [] as PaneAgentRow[], remote: vi.fn(), auxiliary: null as PresentedAuxiliaryOptions | null, terminals: new Map<string, TerminalSummary>(), layout: { spaces: [] } as unknown }));
vi.mock('../../../herdr/src/client/hc.js', () => ({ invokeCli: vi.fn(async (_binary, args) => {
  if (args[0] === 'machine') return { machines: [{ name: 'box-1.invalid', aliases: [], id: 'core-remote', machine_id: 'machine-1', state: 'connected' }] };
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
vi.mock('../herdr/pane-endpoint.js', () => ({ handleRemotePaneRequest: async () => ({ version: 1, op: 'list', page: { version: 1, rows: [], complete: true, next: null } }) }));
vi.mock('../herdr/pane-transport.js', () => ({ createPaneRemoteRequest: () => boundary.remote }));
vi.mock('../../../herdr/src/panes/auxiliary.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../herdr/src/panes/auxiliary.js')>();
  return { ...actual, createPresentedAuxiliaryPanes: (options: PresentedAuxiliaryOptions) => { boundary.auxiliary = options; return actual.createPresentedAuxiliaryPanes(options); } };
});
const resources: { root: string; runtime: PaneRuntime }[] = [];
afterEach(async () => { for (const { root, runtime } of resources.splice(0)) { await runtime.dispose(); await rm(root, { recursive: true, force: true }); } vi.clearAllMocks(); });
async function fixture(spaces: HerdrConfig['spaces'] = []) {
  const base = join(paths.scratch('worktree', process.cwd()), 'pane-runtime-state'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'f-'));
  boundary.rows = []; boundary.terminals.clear(); boundary.app = {}; boundary.layout = { spaces: [] }; boundary.remote.mockImplementation(async (_machine, request) => {
    if (request.op !== 'list') throw new Error('Unexpected remote effect');
    return { version: 1, op: 'list', page: { version: 1, rows: boundary.rows, complete: true, next: null } };
  });
  const config = parseHerdrConfig({ mode: 'full', app: { binary: '/owned/app', home: join(root, 'app') }, core: { binary: '/owned/hc', config: join(root, 'core.toml') }, globalRoot: root, agentDirectory: join(root, 'agent'), shellRc: join(root, 'shellrc'),
    machines: [{ name: 'box-1.invalid', nodePath: '/usr/bin/node', runtime: { directory: '/home/example/runtime', commands: {} } }], spaces });
  const hc = { identity: async () => ({ coreId: 'core-local', socket: '/owned/core.sock', sessionNamespace: 'fixture' }),
    get: vi.fn(async address => boundary.terminals.get(String(address).split('/').at(-1)!) ?? { address, state: 'live' }),
    run: vi.fn(async request => { const address = 'proxy-1'; boundary.terminals.set(address, { address: address as never, state: 'live', labels: request.labels, parent: null, status: null, exitCode: null, reason: null, signal: null, finishedAt: null, cols: 80, rows: 24 }); return { address, coreId: 'core-local' }; }),
    events: () => ({ ready: Promise.resolve(), subscribe: (listener: Parameters<ReturnType<HcClient['events']>['subscribe']>[0]) => { listener({ type: 'snapshot', seq: 1, terminals: [...boundary.terminals.values()] }); return () => {}; }, dispose() {} }),
    kill: vi.fn(async address => { const terminal = boundary.terminals.get(String(address)); if (terminal) terminal.state = 'finished'; }),
    rm: vi.fn(async address => { boundary.terminals.delete(String(address)); }), setLabels: vi.fn() } as unknown as HcClient;
  boundary.facts.mockImplementation(async target => facts({ target, id: target.terminalId } as PanePresentation));
  const input = { config, hc, env: {}, packageRoot: process.cwd(), endpointBytes: Buffer.from('synthetic endpoint') };
  const runtime = createPaneRuntime(input), resource = { root, runtime };
  resources.push(resource); return { root, runtime, hc, restart: async () => { await resource.runtime.dispose(); resource.runtime = createPaneRuntime(input); return resource.runtime; } };
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
