// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import type { PresentedAuxiliaryOptions } from '../../../herdr/src/panes/auxiliary.js';
import type { PaneServicePorts } from '../../../herdr/src/panes/service.js';
import type { PaneAgentRow, PanePresentation, PaneServiceRequest, PaneTarget, PlacementState } from '../../../herdr/src/panes/types.js';
import type { Owner, PaneReservation } from '../../../herdr/src/contracts.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { parsePaneInventoryPage, parseRemotePaneReply } from '../../../herdr/src/panes/codec.js';
import { createPaneRuntime } from '../herdr/pane-runtime.js';
const boundary = vi.hoisted(() => ({ service: null as PaneServicePorts | null, auxiliary: null as PresentedAuxiliaryOptions | null, openPresented: vi.fn(), page: null as unknown, reply: null as unknown, labels: {} as Record<string, string>, state: { version: 2, revision: 0, slots: [], attempts: [], presentations: [], launches: [], choices: [] } as unknown as PlacementState }));
vi.mock('../../../herdr/src/panes/service.js', () => ({ createPaneService: (ports: PaneServicePorts) => { boundary.service = ports; return {}; } }));
vi.mock('../../../herdr/src/panes/auxiliary.js', () => ({ createPresentedAuxiliaryPanes: (ports: PresentedAuxiliaryOptions) => { boundary.auxiliary = ports; return { openPresented: boundary.openPresented }; } }));
vi.mock('../../../herdr/src/panes/store.js', () => ({ createPanePlacementStore: () => ({ read: async () => boundary.state, update: async (change: (state: PlacementState) => PlacementState) => { boundary.state = change(boundary.state); } }) }));
vi.mock('../herdr/bin/pane-endpoint.js', () => ({ createProductionPaneEndpointPorts: () => ({}) }));
vi.mock('../herdr/pane-transport.js', () => ({ createPaneRemoteRequest: () => async (_machine: unknown, request: { op: string }) => request.op === 'list' ? { op: 'list', page: boundary.page } : boundary.reply }));
vi.mock('../../../herdr/src/client/app.js', () => ({ createAppClient: () => ({ ownerPlacement: async () => ({ space: 'space-1', tab: 'tab-1', pane: 'pane-1' }) }) }));
vi.mock('../../../herdr/src/client/argv-client.js', () => ({ createArgvClient: () => ({}) }));
vi.mock('../../../herdr/src/client/hc.js', () => ({ invokeCli: async () => ({ machines: [{ id: 'core-source', name: 'box-1.invalid', state: 'connected', aliases: [] }, { id: 'core-other', name: 'box-2.invalid', state: 'connected', aliases: [] }] }) }));
vi.mock('../../../herdr/src/panes/hc.js', () => ({ readPaneTerminal: async () => ({ terminal: { state: 'live' }, currentCwd: '/home/example', identityLabels: { 'spider.view-generation': 'current-generation' } }) }));
const owner: Owner = { sessionId: 'session-1' as never, generation: 'generation-1' as never, terminal: { coreId: 'core-source' as never, terminalId: 't1' as never, address: 'core-source/t1' as never, socket: '/home/example/core.sock', sessionNamespace: 'test' }, cwd: '/home/example', sessionFile: null, name: 'agent' };
const target: PaneTarget = { coreId: 'core-source' as never, terminalId: 't2' as never, address: 'core-source/t2' as never, createdMs: 1, identityLabels: {}, alias: 'box-1.invalid', machineId: null, kind: 'subagent', sessionId: owner.sessionId, generation: owner.generation, homeEpoch: null, runId: 'run-1' as never, consoleId: null, name: 'child', cwd: '/home/example' };
function fixture() {
  const config = parseHerdrConfig({ mode: 'full', app: { binary: '/usr/bin/false', home: '/home/example/app' }, core: { binary: '/usr/bin/false', config: '/home/example/core.toml' }, globalRoot: '/home/example/state', agentDirectory: '/home/example/agent', shellRc: '/home/example/rc', machines: [{ name: 'box-1.invalid', nodePath: '/usr/bin/node', runtime: { directory: '/home/example/jobs', commands: {} } }, { name: 'box-2.invalid', nodePath: '/usr/bin/node', runtime: { directory: '/home/example/jobs', commands: {} } }], spaces: [] });
  const runtime = createPaneRuntime({ config, hc: { identity: async () => ({ coreId: 'core-local', socket: '/home/example/core.sock', sessionNamespace: 'test' }), setLabels: async (_address: unknown, labels: Record<string, string>) => { boundary.labels = labels; } } as never, env: {}, packageRoot: '/home/example/package', endpointBytes: Buffer.from('endpoint') });
  runtime.createService();
  return { runtime, service: boundary.service!, auxiliary: boundary.auxiliary!, reservation: { id: 'run-1', owner, kind: 'subagent', viewer: 't-local', pane: 'pane-1' } as PaneReservation };
}
afterEach(() => { boundary.state = { ...boundary.state, presentations: [] }; boundary.labels = {}; boundary.openPresented.mockReset(); });
function sourceRow(): Extract<PaneAgentRow, { unavailableReason: null }> {
  const session = { ...target, terminalId: owner.terminal.terminalId, address: owner.terminal.address, kind: 'session' as const, runId: null };
  return { sessionId: owner.sessionId, generation: owner.generation, name: owner.name, status: 'working', updatedAt: 1, machineKey: 'box-1.invalid', target: session, owner, unavailableReason: null, children: [], consoles: [] };
}
function agentPresentation(): PanePresentation {
  return { id: 'agent', revision: 1, role: 'agent', mode: 'proxy', target: sourceRow().target, proxy: 't-local' as never,
    slot: { space: 'space-1' as never, tab: 'tab-1' as never, pane: 'pane-1' as never }, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null };
}
const auxiliaryRequest = { version: 1 as const, op: 'open-auxiliary' as const, operationId: 'aux-1', sessionId: owner.sessionId, generation: owner.generation, view: { kind: 'subagent' as const, runId: 'run-1' as never } };

test('runtime forwards the auxiliary mode and keeps the real source owner', async () => {
  const { service } = fixture();
  boundary.openPresented.mockResolvedValue(null);
  const inventory = { rows: [sourceRow()], complete: true, stale: false };
  for (const [mode, automatic] of [[undefined, false], ['explicit', false], ['automatic', true]] as const) {
    const request = { ...auxiliaryRequest, ...(mode ? { mode } : {}) } as PaneServiceRequest;
    expect(await service.dispatch(request as never, async () => {}, inventory)).toMatchObject({ status: 'pending', reason: 'view-unplaced' });
    expect(boundary.openPresented).toHaveBeenLastCalledWith('subagent', 'run-1', owner,
      expect.objectContaining({ automatic, ownerRelative: !automatic }));
  }
});

test('automatic console requests never open a background job pane', async () => {
  const { service } = fixture(), consoleId = ('console-' + 'a'.repeat(64)) as never;
  boundary.openPresented.mockResolvedValue(null);
  const row = { ...sourceRow(), consoles: [{ consoleId, machineKey: 'box-2.invalid', name: 'Output', target: null }] };
  const request = { ...auxiliaryRequest, mode: 'automatic' as const, view: { kind: 'console' as const, machineKey: 'box-2.invalid', consoleId } };
  expect(await service.dispatch(request, async () => {}, { rows: [row], complete: true, stale: false })).toMatchObject({ status: 'pending', reason: 'view-unplaced' });
  expect(boundary.openPresented).not.toHaveBeenCalled();
});

test('runtime does not report a view as presented until its target is bound', async () => {
  const { service, reservation } = fixture();
  boundary.openPresented.mockResolvedValue(reservation);
  const reply = await service.dispatch(auxiliaryRequest, async () => {}, { rows: [sourceRow()], complete: true, stale: false });
  expect(reply).toMatchObject({ status: 'pending', reason: 'view-unplaced', presentation: null });
});

test('runtime returns only the matching acknowledged auxiliary presentation', async () => {
  const { service, reservation } = fixture();
  boundary.openPresented.mockResolvedValue(reservation);
  const view: PanePresentation = { ...agentPresentation(), id: 'view', role: 'subagent', target, proxy: reservation.viewer };
  const inventory = { rows: [sourceRow()], complete: true, stale: false };
  boundary.state.presentations = [view];
  expect(await service.dispatch(auxiliaryRequest, async () => {}, inventory)).toMatchObject({ status: 'complete', reason: 'view-presented', presentation: view });
  boundary.state.presentations = [{ ...view, target: { ...target, runId: 'other-run' as never } }];
  expect(await service.dispatch(auxiliaryRequest, async () => {}, inventory)).toMatchObject({ status: 'pending', reason: 'view-unplaced', presentation: null });
});

test('owner presentation must match the source terminal and be unique', async () => {
  const { auxiliary } = fixture(), agent = agentPresentation();
  boundary.state.presentations = [agent];
  expect(await auxiliary.ownerPresentation(owner)).toBe('t-local');
  boundary.state.presentations = [{ ...agent, target: { ...agent.target, terminalId: 'successor' as never, address: 'core-source/successor' as never } }];
  expect(await auxiliary.ownerPresentation(owner)).toBeNull();
  boundary.state.presentations = [agent, { ...agent, id: 'duplicate' }];
  expect(await auxiliary.ownerPresentation(owner)).toBeNull();
  boundary.state.presentations = [{ ...agent, mode: 'native', proxy: null }];
  expect(await auxiliary.ownerPresentation(owner)).toBeNull();
});

test('production inventory refuses an owner on a different machine', async () => {
  const { service } = fixture();
  boundary.page = parsePaneInventoryPage({ version: 1, rows: [{ sessionId: owner.sessionId, generation: owner.generation, name: owner.name, status: 'working', updatedAt: 1, machineKey: 'core-source', target: { ...target, kind: 'session', runId: null }, owner: { ...owner, terminal: { ...owner.terminal, coreId: 'core-other', address: 'core-other/t1' } }, unavailableReason: null, children: [], consoles: [] }], next: null, complete: true });
  const machine = (await service.machines()).find(row => row.coreId === 'core-source')!;
  await expect(service.inventory(machine, new AbortController().signal)).rejects.toThrow(/source/i);
});
test('production subagent launch refuses a target on another connected machine', async () => {
  const { auxiliary } = fixture();
  boundary.reply = parseRemotePaneReply({ version: 1, op: 'launch-viewer', target: { ...target, coreId: 'core-other', address: 'core-other/t2' } });
  await expect(auxiliary.launchTarget('subagent', 'run-1' as never, owner, 'lease-1')).rejects.toThrow(/source|machine/i);
});
test('production binding validates the live view before storing or labelling it', async () => {
  const { runtime, auxiliary, reservation } = fixture();
  await expect(auxiliary.bindTarget(reservation, target, { observe: false })).rejects.toThrow(/generation/);
  expect((await runtime.store.read()).presentations).toEqual([]);
  expect(boundary.labels).toEqual({});
});
