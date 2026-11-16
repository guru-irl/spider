// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import type { PresentedAuxiliaryOptions } from '../../../herdr/src/panes/auxiliary.js';
import type { PaneServicePorts } from '../../../herdr/src/panes/service.js';
import type { PaneTarget, PanePlacementState } from '../../../herdr/src/panes/types.js';
import type { Owner, PaneReservation } from '../../../herdr/src/contracts.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { createPaneRuntime } from '../herdr/pane-runtime.js';
const boundary = vi.hoisted(() => ({ service: null as PaneServicePorts | null, auxiliary: null as PresentedAuxiliaryOptions | null, page: null as unknown, reply: null as unknown, labels: {} as Record<string, string>, state: { version: 2, revision: 0, presentations: [], launches: [], choices: [] } as unknown as PanePlacementState }));
vi.mock('../../../herdr/src/panes/service.js', () => ({ createPaneService: (ports: PaneServicePorts) => { boundary.service = ports; return {}; } }));
vi.mock('../../../herdr/src/panes/auxiliary.js', () => ({ createPresentedAuxiliaryPanes: (ports: PresentedAuxiliaryOptions) => { boundary.auxiliary = ports; return {}; } }));
vi.mock('../../../herdr/src/panes/store.js', () => ({ createPanePlacementStore: () => ({ read: async () => boundary.state, update: async (change: (state: PanePlacementState) => PanePlacementState) => { boundary.state = change(boundary.state); } }) }));
vi.mock('../herdr/bin/pane-endpoint.js', () => ({ createProductionPaneEndpointPorts: () => ({}) }));
vi.mock('../herdr/pane-transport.js', () => ({ createPaneRemoteRequest: () => async (_machine: unknown, request: { op: string }) => request.op === 'list' ? { op: 'list', page: boundary.page } : boundary.reply }));
vi.mock('../../../herdr/src/client/app.js', () => ({ createAppClient: () => ({ ownerPlacement: async () => ({ space: 'space-1', tab: 'tab-1', pane: 'pane-1' }) }) }));
vi.mock('../../../herdr/src/client/argv-client.js', () => ({ createArgvClient: () => ({}) }));
vi.mock('../../../herdr/src/client/hc.js', () => ({ invokeCli: async () => ({ machines: [{ id: 'core-source', name: 'box-1.invalid', state: 'connected', aliases: [] }, { id: 'core-other', name: 'box-2.invalid', state: 'connected', aliases: [] }] }) }));
vi.mock('../../../herdr/src/panes/hc.js', () => ({ readPaneTerminal: async () => ({ terminal: { state: 'live' }, currentCwd: '/home/example', identityLabels: { 'spider.view-generation': 'current-generation' } }) }));
const owner: Owner = { sessionId: 'session-1' as never, generation: 'generation-1' as never, terminal: { coreId: 'core-source' as never, terminalId: 't1' as never, address: 'core-source/t1' as never }, cwd: '/home/example', sessionFile: null, name: 'agent' };
const target: PaneTarget = { coreId: 'core-source' as never, terminalId: 't2' as never, address: 'core-source/t2' as never, createdMs: 1, identityLabels: {}, alias: 'box-1.invalid', machineId: null, kind: 'subagent', sessionId: owner.sessionId, generation: owner.generation, homeEpoch: null, runId: 'run-1' as never, consoleId: null, name: 'child', cwd: '/home/example' };
function fixture() {
  const config = parseHerdrConfig({ mode: 'full', app: { binary: '/usr/bin/false', home: '/home/example/app' }, core: { binary: '/usr/bin/false', config: '/home/example/core.toml' }, globalRoot: '/home/example/state', agentDirectory: '/home/example/agent', shellRc: '/home/example/rc', machines: [{ name: 'box-1.invalid', nodePath: '/usr/bin/node', runtime: { directory: '/home/example/jobs', commands: {} } }, { name: 'box-2.invalid', nodePath: '/usr/bin/node', runtime: { directory: '/home/example/jobs', commands: {} } }], spaces: [] });
  const runtime = createPaneRuntime({ config, hc: { identity: async () => ({ coreId: 'core-local', socket: '/home/example/core.sock', sessionNamespace: 'test' }), setLabels: async (_address: unknown, labels: Record<string, string>) => { boundary.labels = labels; } } as never, env: {}, packageRoot: '/home/example/package', endpointBytes: Buffer.from('endpoint') });
  runtime.createService();
  return { runtime, service: boundary.service!, auxiliary: boundary.auxiliary!, reservation: { id: 'run-1', owner, kind: 'subagent', viewer: 't-local', pane: 'pane-1' } as PaneReservation };
}
afterEach(() => { boundary.state = { ...boundary.state, presentations: [] }; boundary.labels = {}; });
test('production inventory refuses an owner on a different machine', async () => {
  const { service } = fixture();
  boundary.page = { version: 1, rows: [{ machineKey: 'core-source', target: { ...target, kind: 'session' }, owner: { ...owner, terminal: { ...owner.terminal, coreId: 'core-other' } }, unavailableReason: null, consoles: [] }], next: null, complete: true };
  const machine = (await service.machines()).find(row => row.coreId === 'core-source')!;
  await expect(service.inventory(machine, new AbortController().signal)).rejects.toThrow(/source/i);
});
test('production subagent launch refuses a target on another connected machine', async () => {
  const { auxiliary } = fixture();
  boundary.reply = { op: 'launch-viewer', target: { ...target, coreId: 'core-other', address: 'core-other/t2' } };
  await expect(auxiliary.launchTarget('subagent', 'run-1' as never, owner, 'lease-1')).rejects.toThrow(/source|machine/i);
});
test('production binding validates the live view before storing or labelling it', async () => {
  const { runtime, auxiliary, reservation } = fixture();
  await expect(auxiliary.bindTarget(reservation, target, { observe: false })).rejects.toThrow(/generation/);
  expect((await runtime.store.read()).presentations).toEqual([]);
  expect(boundary.labels).toEqual({});
});
