// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createUiModules, initView, strictInit } from './strict-mod-api.mjs';
import { chooseMenuProgram, consumeMenuTicket, issueMenuTicket } from '../../assets/machines/actions.js';

const local = { key: 'local', alias: null, label: 'This computer', coreId: 'core-local', machineId: null, state: 'connected' };
const remote = { key: 'box-1.invalid', alias: 'box-1.invalid', label: 'box-1.invalid', coreId: 'core-remote', machineId: 'machine-1', state: 'connected' };
const down = { key: 'box-2.invalid', alias: 'box-2.invalid', label: 'box-2.invalid', coreId: null, machineId: null, state: 'disconnected' };
const target = { coreId: 'core-remote', terminalId: 't1', address: 'box-1.invalid/t1', createdMs: 1, identityLabels: {}, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'terminal', sessionId: null, generation: null, homeEpoch: null, runId: null, consoleId: null, name: null, cwd: null };
const presentation = { id: 'presentation-1', revision: 1, mode: 'proxy', role: 'shell', target, proxy: 'proxy-1', slot: { space: 's1', tab: 'tab-1', pane: 'pane-original' }, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null };
const flat = (root: any): any[] => root && typeof root === 'object' ? [root, ...(root.items ?? []).flatMap(flat)] : [];
const text = (root: any): string[] => typeof root === 'string' ? [root] : root && typeof root === 'object' ? (root.items ?? []).flatMap(text) : [];
const byId = (root: any, id: string) => flat(root).find(node => node.styles?.id?.[0] === id);

function host(options: { place?: string; checking?: boolean; legacyCheck?: boolean; props?: any; snapshotWait?: Promise<void>; initialWait?: Promise<void>; initial?: any } = {}) {
  const ui = createUiModules();
  const inputs: any[] = [], calls: any[] = [];
  const sharedState = new Map<string, unknown>();
  const state: any = { rows: [local, remote, down], presentations: [presentation], focus: { space: 's1', tab: 'tab-1', pane: 'pane-original', terminal: 'proxy-1' },
    panes: [{ pane: 'pane-original', terminal: 'proxy-1', tab: 'tab-1' }], spaces: [{ id: 's1', machine: null, tabs: [{ id: 'tab-1' }] }],
    layout: [{ name: null, layout: 'ready' }, { name: 'box-1.invalid', layout: 'ready' }, { name: 'box-2.invalid', layout: 'unavailable' }], snapshotCount: 0, ...options.initial };
  const cx: any = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {}, spawn(fn: Function) { return Promise.resolve().then(() => fn(cx)); } };
  const InputState = { new() { const handlers: Record<string, Function> = {}; const input = { handlers, valueText: '', on(name: string, fn: Function) { handlers[name] = fn; }, value() { return this.valueText; }, focus() {} }; inputs.push(input); return input; } };
  const herdr: any = { props: () => ({ overlay: 'overlay', ...options.props }), ...(options.checking ? { checking: () => true } : {}),
    appHome: () => '/fixture/app', readTextFile: async (path: string) => { calls.push(['read', path]); return JSON.stringify({ version: 1, nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs', checkMode: !!options.legacyCheck }); },
    focused: () => state.focus, panes: () => state.panes, spaces: () => state.spaces, machines: () => state.layout, settings: () => ({ zoom: 1 }),
    closeOverlay: (id: string) => { calls.push(['close', id]); }, openOverlay: (spec: any) => { calls.push(['overlay', spec]); return 'next-overlay'; },
    writeTextFile: async (...args: any[]) => { calls.push(['write', ...args]); },
    shared: (key: string) => sharedState.get(key), setShared: (key: string, value: unknown) => sharedState.set(key, value),
    exec: async (command: string, args: string[]) => {
      const request = JSON.parse(args[args.indexOf('--json') + 1]); calls.push(['request', request]);
      if (request.op === 'snapshot') {
        state.snapshotCount++;
        if (state.snapshotCount === 1 && options.initialWait) await options.initialWait;
        if (state.snapshotCount > 1 && options.snapshotWait) await options.snapshotWait;
        return { code: 0, stdout: JSON.stringify({ version: 1, kind: 'snapshot', revision: 1, machines: state.rows, presentations: state.presentations, rows: [], targetFacts: {}, complete: false, omittedRows: 14 }), stderr: '' };
      }
      return { code: 0, stdout: JSON.stringify({ version: 1, kind: 'outcome', outcome: { status: 'complete', reason: '', presentation: null } }), stderr: '' };
    } };
  const actionsSource = readFileSync(resolve('packages/herdr/assets/machines/actions.js'), 'utf8').replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  const actions = new Function(`${actionsSource}; return { capturePaneIntent, selectMachine, issueMenuTicket };`)();
  const source = readFileSync(resolve('packages/herdr/assets/machines/picker.js'), 'utf8').replace(/^import .*;\s*$/gm, '').replace(/export default [^;]+;?/g, '').replace(/export /g, '');
  const api = { ...ui['gpui-kit'], ...ui['gpui-base'], InputState, Input: { new: () => ui['gpui-kit'].div() }, herdr, ...actions };
  const factory = new Function('api', `const { ${Object.keys(api).join(', ')} } = api; ${source}; return machinePickerView;`)(api);
  const view = strictInit(new (factory(options.place ?? 'tab'))()); initView(view, cx);
  return { view, cx, state, inputs, calls, requests: () => calls.filter(c => c[0] === 'request').map(c => c[1]), herdr };
}

it.each([
  ['tab', '/fixture/app/mods/spider-machine-picker/config.json'],
  ['right', '/fixture/app/mods/spider-machine-picker-right/config.json'],
  ['down', '/fixture/app/mods/spider-machine-picker-down/config.json'],
])('reads the installed %s shortcut configuration', async (place, path) => {
  const h = host({ place }); await h.view.ready;
  expect(h.calls).toContainEqual(['read', path]);
});

it.each(['tab', 'right', 'down'])('%s shortcut waits for one machine selection', async place => {
  const h = host({ place }); await h.view.ready;
  expect(h.requests().filter((r: any) => r.op === 'open')).toEqual([]);
  await h.view.activate('box-1.invalid');
  expect(h.requests().filter((r: any) => r.op === 'open')).toHaveLength(1);
  expect(h.requests().find((r: any) => r.op === 'open')).toMatchObject({ machineKey: 'box-1.invalid', intent: { place } });
});

it(' picker sends selected core and machine IDs', async () => {
  const h = host(); await h.view.ready;
  await h.view.activate('box-1.invalid');
  expect(h.requests().find((r: any) => r.op === 'open')).toMatchObject({
    machineKey: 'box-1.invalid', coreId: 'core-remote', machineId: 'machine-1',
  });
});

it(' menu continuation sends selected core and machine IDs', async () => {
  const h = host(); await h.view.ready;
  const intent: any = { operationId: 'menu-operation', space: 's1', place: 'tab', anchor: null, program: { kind: 'shell' } };
  const ticket = issueMenuTicket(intent, remote as any, h.herdr);
  await chooseMenuProgram(ticket, { kind: 'shell' }, 's1', h.herdr);
  expect(h.requests().find((r: any) => r.op === 'open')).toMatchObject({
    machineKey: 'box-1.invalid', coreId: 'core-remote', machineId: 'machine-1',
  });
});

it('tab plus selects a machine before opening a one-use new menu', async () => {
  const intent = { operationId: 'menu-operation', space: 's1', place: 'tab', anchor: null, program: { kind: 'shell' } };
  const h = host({ props: { continuation: 'menu', intent } }); await h.view.ready;
  await h.view.activate('box-1.invalid');
  expect(h.requests().filter((r: any) => r.op === 'open')).toEqual([]);
  const overlay = h.calls.find(c => c[0] === 'overlay')?.[1];
  expect(overlay.mod).toBe('spider-new-menu');
  expect(consumeMenuTicket(overlay.props.machineTicket, h.herdr)).toMatchObject({ operationId: 'menu-operation', machineKey: 'box-1.invalid', alias: 'box-1.invalid' });
  expect(consumeMenuTicket(overlay.props.machineTicket, h.herdr)).toBeNull();
});

it('picker defaults to focused execution machine', async () => {
  const h = host(); await h.view.ready;
  const root = h.view.render();
  expect(text(root)).toContain('Choose machine');
  expect(text(root)).toContain('This computer');
  expect(byId(root, 'machine-box-1.invalid').styles.bg[0]).toBe('#ffffff14');
  expect(h.view.rows().find((row: any) => row.key === 'box-2.invalid').enabled).toBe(false);
});

it('filter preserves the selectable default', async () => {
  const h = host(); await h.view.ready;
  h.inputs[0].valueText = 'box'; h.inputs[0].handlers.change({}, h.cx);
  expect(byId(h.view.render(), 'machine-box-1.invalid').styles.bg[0]).toBe('#ffffff14');
  h.inputs[0].valueText = 'computer'; h.inputs[0].handlers.change({}, h.cx);
  expect(byId(h.view.render(), 'machine-local').styles.bg[0]).toBe('#ffffff14');
});

it('arrows and hover share selection', async () => {
  const h = host(); await h.view.ready;
  let root = h.view.render(); root.events.on_key_down({ key: 'up' }, h.cx);
  expect(byId(h.view.render(), 'machine-local').styles.bg[0]).toBe('#ffffff14');
  root = h.view.render(); byId(root, 'machine-box-1.invalid').events.on_mouse_move({}, h.cx);
  h.inputs[0].handlers.submit({}, h.cx);
  await vi.waitFor(() => expect(h.requests().filter((r: any) => r.op === 'open')).toHaveLength(1));
  expect(h.requests().find((r: any) => r.op === 'open').machineKey).toBe('box-1.invalid');
});

it('Escape and empty matches create nothing', async () => {
  const h = host(); await h.view.ready;
  h.inputs[0].valueText = 'not-found'; h.inputs[0].handlers.change({}, h.cx);
  expect(text(h.view.render())).toContain('No available machines match');
  h.inputs[0].handlers.submit({}, h.cx); h.view.render().events.on_key_down({ key: 'escape' }, h.cx);
  await Promise.resolve();
  expect(h.calls).toContainEqual(['close', 'overlay']);
  expect(h.requests().filter((r: any) => r.op === 'open')).toEqual([]);
});

it('disconnected rows cannot launch', async () => {
  const h = host({ initial: { rows: [local, { ...remote, state: 'disconnected' }, down] } }); await h.view.ready;
  const root = h.view.render();
  expect(text(root)).toContain('Unreachable');
  expect(byId(root, 'machine-box-1.invalid').events.on_click).toBeUndefined();
  expect(byId(root, 'machine-box-2.invalid').events.on_click).toBeUndefined();
  h.inputs[0].valueText = 'box'; h.inputs[0].handlers.change({}, h.cx); h.inputs[0].handlers.submit({}, h.cx);
  await Promise.resolve(); expect(h.requests().filter((r: any) => r.op === 'open')).toEqual([]);
});

it('long machine lists scroll to the keyboard selection', async () => {
  const machines = Array.from({ length: 25 }, (_, i) => ({ key: `node-${i}.invalid`, alias: `node-${i}.invalid`, label: `node-${i}.invalid`, coreId: `core-${i}`, machineId: `machine-${i}`, state: 'connected' }));
  const layout = machines.map(row => ({ name: row.alias, layout: 'ready' }));
  const h = host({ initial: { rows: machines, layout, presentations: [] } }); await h.view.ready;
  let root = h.view.render();
  const list = byId(root, 'machine-list');
  expect(list.styles.h[0]).toBe(320);
  expect(list.events.on_scroll_wheel).toBeTypeOf('function');
  for (let i = 0; i < 20; i++) { root.events.on_key_down({ key: 'down' }, h.cx); root = h.view.render(); }
  expect(byId(root, 'machine-node-20.invalid').styles.bg[0]).toBe('#ffffff14');
  expect(byId(root, 'machine-node-0.invalid')).toBeUndefined();
});

it('a connected core without a remote app layout remains selectable', async () => {
  const h = host(); await h.view.ready;
  h.state.layout = h.state.layout.filter((row: any) => row.name !== 'box-1.invalid');
  const row = byId(h.view.render(), 'machine-box-1.invalid');
  expect(text(row)).toContain('Connected');
  row.events.on_click({}, h.cx);
  await vi.waitFor(() => expect(h.requests().filter((r: any) => r.op === 'open')).toHaveLength(1));
  expect(h.requests().find((r: any) => r.op === 'open').machineKey).toBe('box-1.invalid');
});

it('split keeps its captured anchor after focus changes', async () => {
  const h = host({ place: 'right' }); await h.view.ready;
  h.state.focus = { space: 's1', tab: 'tab-1', pane: 'pane-other', terminal: 'other' };
  h.state.panes.push({ pane: 'pane-other', tab: 'tab-1', terminal: 'other' });
  h.inputs[0].handlers.submit({}, h.cx);
  await vi.waitFor(() => expect(h.requests().filter((r: any) => r.op === 'open')).toHaveLength(1));
  expect(h.requests().find((r: any) => r.op === 'open').intent.anchor).toEqual({ space: 's1', tab: 'tab-1', pane: 'pane-original' });
});

it('a disappeared anchor or disconnected machine refuses without launch', async () => {
  const h = host({ place: 'down' }); await h.view.ready;
  h.state.panes = []; h.inputs[0].handlers.submit({}, h.cx); await Promise.resolve();
  expect(h.requests().filter((r: any) => r.op === 'open')).toEqual([]);
  const other = host(); await other.view.ready;
  other.state.rows = [local, { ...remote, state: 'disconnected' }, down];
  other.inputs[0].handlers.submit({}, other.cx);
  await vi.waitFor(() => expect(other.state.snapshotCount).toBe(2));
  expect(other.requests().filter((r: any) => r.op === 'open')).toEqual([]);
});

it('duplicate Enter while checking the connection creates once', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const h = host({ snapshotWait: gate }); await h.view.ready;
  h.inputs[0].handlers.submit({}, h.cx); h.inputs[0].handlers.submit({}, h.cx);
  await vi.waitFor(() => expect(h.state.snapshotCount).toBe(2));
  release(); await vi.waitFor(() => expect(h.requests().filter((r: any) => r.op === 'open')).toHaveLength(1));
  expect(h.state.snapshotCount).toBe(2);
});

it('Escape during the connection check never starts a target', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const h = host({ snapshotWait: gate }); await h.view.ready;
  h.inputs[0].handlers.submit({}, h.cx);
  await vi.waitFor(() => expect(h.state.snapshotCount).toBe(2));
  h.view.render().events.on_key_down({ key: 'escape' }, h.cx);
  release(); await vi.waitFor(() => expect(h.view.pending).toBe(false));
  expect(h.requests().filter((r: any) => r.op === 'open')).toEqual([]);
});

it('tab works with a mod pane; absent model panes cannot anchor splits', async () => {
  const h = host({ initial: { focus: { space: 's1', tab: 'tab-1', pane: 'mod-pane', terminal: null }, panes: [{ pane: 'mod-pane', tab: 'tab-1', terminal: null, mod: 'fixture' }] } });
  await h.view.ready; h.inputs[0].handlers.submit({}, h.cx);
  await vi.waitFor(() => expect(h.requests().filter((r: any) => r.op === 'open')).toHaveLength(1));
  expect(h.requests().find((r: any) => r.op === 'open').intent.space).toBe('s1');
  const noPane = host({ place: 'right', initial: { focus: { space: 's1', tab: 'tab-1', pane: null, terminal: null }, panes: [] } });
  await noPane.view.ready; noPane.inputs[0].handlers.submit({}, noPane.cx); await Promise.resolve();
  expect(noPane.requests().filter((r: any) => r.op === 'open')).toEqual([]);
  const window = host({ place: 'down', initial: { panes: [] } });
  await window.view.ready; window.inputs[0].handlers.submit({}, window.cx); await Promise.resolve();
  expect(window.requests().filter((r: any) => r.op === 'open')).toEqual([]);
});

it('loading snapshot is not presented as an empty result', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const h = host({ initialWait: gate });
  await vi.waitFor(() => expect(h.state.snapshotCount).toBe(1));
  expect(text(h.view.render())).toContain('Loading');
  expect(text(h.view.render())).not.toContain('No available machines match');
  release(); await h.view.ready;
  expect(text(h.view.render())).toContain('Connected');
});

it('no focused pane defaults to this computer rather than an unrelated presentation', async () => {
  const unrelated = { ...presentation, proxy: null };
  const h = host({ initial: { focus: null, spaces: [{ id: 's1', machine: null, active: true, tabs: [{ id: 'tab-1', active: true }] }], presentations: [unrelated] } });
  await h.view.ready;
  expect(byId(h.view.render(), 'machine-local').styles.bg[0]).toBe('#ffffff14');
  h.inputs[0].handlers.submit({}, h.cx);
  await vi.waitFor(() => expect(h.requests().filter((r: any) => r.op === 'open')).toHaveLength(1));
  expect(h.requests().find((r: any) => r.op === 'open').machineKey).toBe('local');
});

it('a clicked split uses its own pane even when another pane is focused', async () => {
  const intent = { operationId: 'clicked-1', space: 's1', place: 'right', anchor: { space: 's1', tab: 'tab-1', pane: 'clicked' }, program: { kind: 'shell' } };
  const h = host({ place: 'right', props: { intent, machineKey: 'box-1.invalid' }, initial: { panes: [
    { pane: 'pane-original', terminal: 'proxy-1', tab: 'tab-1' }, { pane: 'clicked', terminal: 'clicked-terminal', tab: 'tab-1' },
  ] } });
  await h.view.ready; byId(h.view.render(), 'machine-box-1.invalid').events.on_click({}, h.cx);
  await vi.waitFor(() => expect(h.requests().filter((r: any) => r.op === 'open')).toHaveLength(1));
  expect(h.requests().find((r: any) => r.op === 'open').intent.anchor.pane).toBe('clicked');
});

it('a destination deleted during connection verification creates nothing', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const h = host({ snapshotWait: gate }); await h.view.ready;
  h.inputs[0].handlers.submit({}, h.cx);
  await vi.waitFor(() => expect(h.state.snapshotCount).toBe(2));
  h.state.spaces = []; release();
  await vi.waitFor(() => expect(h.view.pending).toBe(false));
  expect(h.requests().filter((r: any) => r.op === 'open')).toEqual([]);
});

it.each([{ checking: true }, { legacyCheck: true }])('native check mode makes no service start or write: %o', async options => {
  const h = host(options); await h.view.ready;
  expect(h.calls.filter(c => c[0] === 'request')).toEqual([]);
  expect(h.calls.filter(c => c[0] === 'write')).toEqual([]);
});

it('capped snapshots render the omitted agent count', async () => {
  const h = host(); await h.view.ready;
  expect(JSON.stringify(h.view.render())).toContain('14 more');
});
