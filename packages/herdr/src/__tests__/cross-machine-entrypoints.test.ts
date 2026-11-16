// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it, vi } from 'vitest';
import * as actions from '../../assets/machines/actions.js';

const local = { key: 'local', alias: null, label: 'This computer', coreId: 'core-local', machineId: null, state: 'connected' };
const remote = { key: 'box-1.invalid', alias: 'box-1.invalid', label: 'box-1.invalid', coreId: 'core-remote', machineId: 'machine-1', state: 'connected' };
const placement = { space: 's1', tab: 'tab-1', pane: 'pane-original' };
const target = { coreId: 'core-remote', terminalId: 't1', address: 'box-1.invalid/t1', createdMs: 1, identityLabels: {}, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'terminal', sessionId: null, generation: null, homeEpoch: null, runId: null, consoleId: null, name: null, cwd: null };
const presentation = { id: 'presentation-1', revision: 1, mode: 'proxy', role: 'shell', target, proxy: 'proxy-1', slot: placement, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null };
function makePorts() {
  const facts: any = { operationId: 'operation-1', space: 's1', focused: presentation, nativeTarget: null, focusedPlacement: { ...placement }, machines: [local, remote] };
  const overlays: any[] = [], nativeCreates: any[] = [];
  const ports: any = { facts: () => facts, openOverlay: (mod: string, props: unknown) => overlays.push({ mod, props }), nativeCreate: (...args: unknown[]) => nativeCreates.push(args), config: { nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' } };
  return { facts, ports, overlays, nativeCreates };
}
const open = (intent: unknown, ports: unknown) => (actions as any).openMachinePicker(intent, ports);

it('tab plus shows machines before new menu', () => {
  const h = makePorts(); open({ place: 'tab', program: 'menu' }, h.ports);
  expect(h.overlays).toHaveLength(1);
  expect(h.overlays[0]).toMatchObject({ mod: 'spider-machine-picker', props: { continuation: 'menu', machineKey: 'box-1.invalid', intent: { space: 's1', place: 'tab', program: { kind: 'shell' } } } });
  expect(h.nativeCreates).toEqual([]);
});

it('a direct creation carries its captured intent without native creation', () => {
  const h = makePorts();
  const intent = { operationId: 'clicked-1', space: 's1', place: 'right', anchor: { ...placement }, program: { kind: 'shell' } };
  open(intent, h.ports);
  expect(h.overlays).toHaveLength(1);
  expect(h.overlays[0]).toMatchObject({ mod: 'spider-machine-picker', props: { continuation: 'shell', machineKey: 'box-1.invalid', intent } });
  expect(h.nativeCreates).toEqual([]);
});

it('an unmanaged local pane defaults to this computer', () => {
  const h = makePorts(); h.facts.focused = null;
  open({ place: 'tab', program: 'menu' }, h.ports);
  expect(h.overlays[0].props.machineKey).toBe('local');
});

it('the picker request retains the original split anchor after focus changes', () => {
  const h = makePorts();
  const intent = { operationId: 'clicked-1', space: 's1', place: 'down', anchor: { ...placement }, program: { kind: 'shell' } };
  open(intent, h.ports); intent.anchor.pane = 'pane-other'; h.facts.focusedPlacement.pane = 'pane-other';
  expect(h.overlays[0].props.intent.anchor.pane).toBe('pane-original');
});

it('new menu consumes one selection ticket, bound to its operation', () => {
  const data = new Map<string, unknown>();
  const store = { shared: (key: string) => data.get(key), setShared: (key: string, value: unknown) => data.set(key, value), now: () => 1000 };
  const intent = { operationId: 'op-1', space: 's1', place: 'tab', anchor: null, program: { kind: 'shell' } };
  const ticket = (actions as any).issueMenuTicket(intent, remote, store);
  expect((actions as any).consumeMenuTicket({ ...ticket, operationId: 'op-other' }, store)).toBeNull();
  expect((actions as any).consumeMenuTicket(ticket, store)).toMatchObject({ intent, machineKey: remote.key, alias: remote.alias });
  expect((actions as any).consumeMenuTicket(ticket, store)).toBeNull();
});

it('split entry captures the clicked pane instead of the later focus', () => {
  const overlays: any[] = [];
  const host: any = { focused: () => ({ space: 's1', tab: 'tab-2', pane: 'pane-other' }),
    spaces: () => [{ id: 's1', machine: null, tabs: [{ id: 'tab-1' }, { id: 'tab-2' }] }],
    panes: () => [{ pane: 'pane-original', tab: 'tab-1' }, { pane: 'pane-other', tab: 'tab-2' }],
    openOverlay: (spec: any) => overlays.push(spec), notify: vi.fn() };
  (actions as any).openPickerFromHost({ place: 'right', program: { kind: 'shell' }, pane: 'pane-original' }, host);
  expect(overlays).toHaveLength(1);
  expect(overlays[0]).toMatchObject({ mod: 'spider-machine-picker', props: { intent: { place: 'right', anchor: placement } } });
  expect(host.notify).not.toHaveBeenCalled();
});

it('layout terminal block has no split action', () => {
  const host: any = { focused: () => ({ space: 's1', pane: 'layout-terminal' }), spaces: () => [{ id: 's1', machine: null, tabs: [] }], panes: () => [], openOverlay: vi.fn(), notify: vi.fn() };
  (actions as any).openPickerFromHost({ place: 'right', program: { kind: 'shell' }, pane: 'layout-terminal' }, host);
  expect(host.openOverlay).not.toHaveBeenCalled();
});

it('a reused or expired menu continuation refuses instead of opening again', async () => {
  const data = new Map<string, unknown>(); let time = 1000;
  const requests: any[] = [], overlays: any[] = [], notices: any[] = [];
  const host: any = { shared: (k: string) => data.get(k), setShared: (k: string, v: unknown) => data.set(k, v), now: () => time,
    appHome: () => '/fixture/app', readTextFile: async () => JSON.stringify({ version: 1, nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' }),
    spaces: () => [{ id: 's1', machine: null, tabs: [] }], openOverlay: (x: any) => overlays.push(x), notify: (x: any) => notices.push(x),
    exec: async (_cmd: string, args: string[]) => { const request = JSON.parse(args.at(-1)!); requests.push(request); return { code: 0, stdout: JSON.stringify(request.op === 'snapshot' ? { version: 1, kind: 'snapshot', machines: [remote] } : { version: 1, kind: 'outcome', outcome: { status: 'complete' } }) }; } };
  const intent = { operationId: 'op-menu', space: 's1', place: 'tab', anchor: null, program: { kind: 'shell' } };
  const ticket = (actions as any).issueMenuTicket(intent, remote, host);
  await (actions as any).chooseMenuProgram(ticket, { kind: 'agent', key: 'pi' }, 's1', host);
  await (actions as any).chooseMenuProgram(ticket, { kind: 'shell' }, 's1', host);
  const expired = (actions as any).issueMenuTicket({ ...intent, operationId: 'op-expired' }, remote, host);
  time += 60_001;
  await (actions as any).chooseMenuProgram(expired, { kind: 'shell' }, 's1', host);
  expect(requests.filter(x => x.op === 'open')).toMatchObject([{ operationId: 'op-menu', machineKey: 'box-1.invalid', intent: { program: { kind: 'agent', key: 'pi' } } }]);
  expect(overlays).toEqual([]);
  expect(notices).toHaveLength(2);
});

it('a machine reconnected to another core refuses before creation', async () => {
  const data = new Map<string, unknown>(); const requests: any[] = []; const notices: any[] = [];
  const host: any = { shared: (k: string) => data.get(k), setShared: (k: string, v: unknown) => data.set(k, v),
    appHome: () => '/fixture/app', readTextFile: async () => JSON.stringify({ version: 1, nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' }),
    spaces: () => [{ id: 's1', machine: null, tabs: [] }], notify: (x: unknown) => notices.push(x),
    exec: async (_cmd: string, args: string[]) => { const request = JSON.parse(args.at(-1)!); requests.push(request);
      return { code: 0, stdout: JSON.stringify({ version: 1, kind: 'snapshot', machines: [{ ...remote, coreId: 'core-successor' }] }) }; } };
  const intent = { operationId: 'op-core', space: 's1', place: 'tab', anchor: null, program: { kind: 'shell' } };
  const ticket = (actions as any).issueMenuTicket(intent, remote, host);
  await (actions as any).chooseMenuProgram(ticket, { kind: 'shell' }, 's1', host);
  expect(requests.map(x => x.op)).toEqual(['snapshot']);
  expect(notices[0].title).toBe('Machine is unreachable');
});

it('an expired selection ticket refuses without opening a terminal', () => {
  const data = new Map<string, unknown>(); let time = 1000;
  const store = { shared: (key: string) => data.get(key), setShared: (key: string, value: unknown) => data.set(key, value), now: () => time };
  const intent = { operationId: 'op-2', space: 's1', place: 'tab', anchor: null, program: { kind: 'shell' } };
  const ticket = (actions as any).issueMenuTicket(intent, remote, store);
  time += 60_001;
  expect((actions as any).consumeMenuTicket(ticket, store)).toBeNull();
});
