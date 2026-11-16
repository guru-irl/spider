// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPaneRuntime, type PaneRuntime } from '../herdr/pane-runtime.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { parsePanePresentation } from '../../../herdr/src/panes/codec.js';
import type { HerdrConfig, HcClient, TerminalSummary } from '../../../herdr/src/contracts.js';
import type { PaneAgentRow, PanePresentation, PaneTerminalFacts } from '../../../herdr/src/panes/types.js';
const boundary = vi.hoisted(() => ({ facts: vi.fn(), app: {} as Record<string, unknown>, rows: [] as PaneAgentRow[], remote: vi.fn(), terminals: new Map<string, TerminalSummary>(), layout: { spaces: [] } as unknown }));
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
const resources: { root: string; runtime: PaneRuntime }[] = [];
afterEach(async () => { for (const { root, runtime } of resources.splice(0)) { await runtime.dispose(); await rm(root, { recursive: true, force: true }); } vi.clearAllMocks(); });
async function fixture(spaces: HerdrConfig['spaces'] = []) {
  const base = resolve('.spider/scratch/pane-runtime-state'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'f-'));
  boundary.rows = []; boundary.terminals.clear(); boundary.app = {}; boundary.layout = { spaces: [] }; boundary.remote.mockImplementation(async (_machine, request) => {
    if (request.op !== 'list') throw new Error('Unexpected remote effect');
    return { version: 1, op: 'list', page: { version: 1, rows: boundary.rows, complete: true, next: null } };
  });
  const config = parseHerdrConfig({ mode: 'full', app: { binary: '/owned/app', home: join(root, 'app') }, core: { binary: '/owned/hc', config: join(root, 'core.toml') }, globalRoot: root, agentDirectory: join(root, 'agent'), shellRc: join(root, 'shellrc'),
    machines: [{ name: 'box-1.invalid', nodePath: '/usr/bin/node', runtime: { directory: '/home/example/runtime', commands: {} } }], spaces });
  const hc = { identity: async () => ({ coreId: 'core-local', socket: '/owned/core.sock', sessionNamespace: 'fixture' }),
    get: vi.fn(async address => boundary.terminals.get(String(address).split('/').at(-1)!) ?? { address, state: 'live' }),
    run: vi.fn(async request => { const address = 'proxy-1'; boundary.terminals.set(address, { address: address as never, state: 'live', labels: request.labels, parent: null, status: null, exitCode: null, reason: null, signal: null, finishedAt: null, cols: 80, rows: 24 }); return { address, coreId: 'core-local' }; }),
    events: () => ({ ready: Promise.resolve(), subscribe: listener => { listener({ type: 'snapshot', seq: 1, terminals: [...boundary.terminals.values()] }); return () => {}; }, dispose() {} }), kill: vi.fn(), rm: vi.fn(), setLabels: vi.fn() } as unknown as HcClient;
  boundary.facts.mockImplementation(async target => facts({ target, id: target.terminalId } as PanePresentation));
  const runtime = createPaneRuntime({ config, hc, env: {}, packageRoot: process.cwd(), endpointBytes: Buffer.from('synthetic endpoint') });
  resources.push({ root, runtime }); return { runtime, hc };
}
function presentation(id: string, visibility: PanePresentation['visibility'] = 'visible'): PanePresentation {
  return parsePanePresentation({ id, revision: 1, mode: 'proxy', role: 'shell', target: { coreId: 'core-remote', terminalId: id, address: `core-remote/${id}`, createdMs: 17, identityLabels: { 'spider.pane-operation': id }, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'terminal', sessionId: null, generation: null, homeEpoch: null, runId: null, consoleId: null, name: id, cwd: '/home/example' }, proxy: null, slot: null, visibility, launch: 'none', closeOperationId: null, conversion: null });
}
function facts(p: PanePresentation): PaneTerminalFacts {
  return { terminal: { address: p.target.address, state: 'live', labels: p.target.identityLabels, parent: null, status: null, exitCode: null, reason: null, signal: null, finishedAt: null, cols: 80, rows: 24 }, createdMs: 17, identityLabels: p.target.identityLabels, currentCwd: '/home/example', title: p.id, app: null, status: null };
}
function installPlacementApp() {
  let placeholder = false, placed = false, focused = 'owner-pane';
  const slot = { space: 's1', tab: 'tb1', pane: 'proxy-pane' };
  const space = { id: 's1', name: 'Work', machine: null, tabs: [{ id: 'tb1', name: 'Work' }] };
  const updateLayout = () => { boundary.layout = { spaces: [{ ...space, tabs: [{ ...space.tabs[0], panes: [{ id: 'owner-pane' }, ...(placeholder ? [{ id: 'placeholder', mod: 'spider-pane-waiting', props: { operationId: 'click-session' } }] : [])] }] }] }; };
  updateLayout();
  Object.assign(boundary.app, {
    listSpaces: async () => [space], tabPanes: async () => [], tabTerminals: async () => placed ? ['proxy-1'] : [],
    ownerPlacement: async () => { if (!placed) throw new HerdrError('owner-unplaced', 'Not placed'); return slot; },
    focusedPane: async () => ({ ...slot, pane: focused }),
    command: vi.fn(async (name, args) => {
      if (name === 'pane.split') { placeholder = true; updateLayout(); return { pane: 'placeholder' }; }
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
  const firstWave = read.length;
  while (read.length < 8 || active) {
    releases.splice(0).forEach(release => release());
    await new Promise(resolve => setImmediate(resolve));
  }
  await running;
  expect(firstWave).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(4);
  expect(read.sort()).toEqual(live.map(p => p.id).sort());
  boundary.facts.mockImplementation(async target => facts(live.find(p => p.target.terminalId === target.terminalId)!));
  expect(await service.request({ version: 1, op: 'snapshot', operationId: 'facts' })).toMatchObject({ targetFacts: { 'core-remote/live-0': { title: 'live-0' }, 'core-remote/live-7': { title: 'live-7' } } });
});
