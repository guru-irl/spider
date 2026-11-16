// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { createUiModules } from './strict-mod-api.mjs';
import { loadSpacesAFiles, type SpacesAVersion } from './spaces-a-fixture.js';
import { replaySpacesBRecipe } from './spaces-b-fixture.js';
import { middlePath } from '../../assets/shared/feed.js';
import { identityPill } from '../../assets/shared/look.js';

const placement = { space: 's1', tab: 'tab-1', pane: 'pane-1' };
const target: any = { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', createdMs: 42, identityLabels: { 'spider.session': 'session-1' }, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 1, runId: null, consoleId: null, name: 'Planner', cwd: '/home/example/work' };
const presentation: any = { id: 'pres-1', revision: 3, mode: 'proxy', role: 'agent', target, proxy: 'proxy-1', slot: placement, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null };
const labels = { 'spider.kind': 'pane-proxy', 'spider.pane-id': 'pres-1', 'spider.target-core': 'core-remote', 'spider.target-terminal': 't7' };
const header: any = { address: 'proxy-1', programIsAgent: false, nativeTitle: 'Node attach', nativeStatus: null, nativeCwd: '/mac/wrong', labels };
const context = () => ({ pane: { ...placement }, header: structuredClone(header), presentation: structuredClone(presentation) });
function module() {
  const ui = createUiModules();
  const machine = readFileSync(new URL('../../assets/pane/machine.js', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  const m = new Function('div', `${machine}; return { panePresentation };`)(ui['gpui-kit'].div);
  const actions = readFileSync(new URL('../../assets/pane/actions.js', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  return new Function('panePresentation', `${actions}; return { handlePaneCommand, capturePaneAction, paneActionPorts, routeMenuPaneCommand };`)(m.panePresentation);
}
function ports() {
  const shared = new Map<string, unknown>(), requests: any[] = [], overlays: any[] = [], notices: any[] = [], effects: string[] = [];
  let time = 1000, sequence = 0;
  const p: any = { shared: (k: string) => shared.get(k), setShared: (k: string, v: unknown) => shared.set(k, v), now: () => time, operationId: () => `op${++sequence}`,
    request: async (req: any) => { requests.push(structuredClone(req)); effects.push(req.op); if (req.op === 'park') effects.push('remove-proxy'); return { status: 'complete', reason: '', presentation: null }; },
    resolveTarget: vi.fn(async () => structuredClone(target)),
    openConfirm: (spec: any) => overlays.push(spec), notify: (message: string) => notices.push(message), nativeClose: vi.fn(), nativePark: vi.fn(), run: vi.fn(), nextCommand: vi.fn() };
  return { p, requests, overlays, notices, effects, advance: (ms: number) => { time += ms; } };
}

test('park records proxy intent before native removal', async () => {
  const h = ports(); await module().handlePaneCommand('park', context(), h.p);
  expect(h.requests).toMatchObject([{ version: 1, op: 'park', operationId: 'op1', presentationId: 'pres-1', expectedRevision: 3 }]);
  expect(h.effects).toEqual(['park', 'remove-proxy']);
  expect(h.p.nativePark).not.toHaveBeenCalled(); expect(h.p.run).not.toHaveBeenCalled();
});

test('remote running agent close uses exactly one existing confirmation', async () => {
  const h = ports(); await module().handlePaneCommand('close', context(), h.p);
  expect(h.overlays).toHaveLength(1);
  expect(h.overlays[0]).toMatchObject({ mod: 'confirm', kind: 'dialog', props: { command: { name: 'spider-pane.confirm-op1' } } });
  expect(h.requests).toEqual([]); expect(h.p.nativeClose).not.toHaveBeenCalled();
});

test('persisted confirmation contains only the opaque operation and incarnation', async () => {
  const h = ports(); await module().handlePaneCommand('close', context(), h.p);
  const records = h.p.shared('spider.pane-confirmations');
  const record: any = Object.values(records)[0];
  expect(Object.keys(record).sort()).toEqual(['coreId', 'createdMs', 'expectedRevision', 'expires', 'operationId', 'presentationId', 'terminalId']);
  expect(record).toEqual({ operationId: 'op1', presentationId: 'pres-1', expectedRevision: 3, coreId: 'core-remote', terminalId: 't7', createdMs: 42, expires: 31_000 });
  expect(JSON.stringify(records)).not.toContain('/home/example/work');
  expect(JSON.stringify(records)).not.toContain('spider.session');
  expect(JSON.stringify(records)).not.toContain('Planner');
});

test('legacy pending data is removed rather than persisted again', async () => {
  const h = ports();
  h.p.setShared('spider.pane-confirmations', { old: { operationId: 'old', presentationId: 'pres-1', expectedRevision: 3, target, expires: 60_000 } });
  await module().handlePaneCommand('close', context(), h.p);
  expect(Object.keys(h.p.shared('spider.pane-confirmations'))).toEqual(['op1']);
  expect(JSON.stringify(h.p.shared('spider.pane-confirmations'))).not.toContain('/home/example/work');
});

test('cancelled close leaves both targets live', async () => {
  const h = ports(); await module().handlePaneCommand('close', context(), h.p);
  expect(h.requests).toEqual([]); expect(h.effects).toEqual([]);
  expect(h.p.nativeClose).not.toHaveBeenCalled(); expect(h.p.nativePark).not.toHaveBeenCalled();
  await module().handlePaneCommand('close', context(), h.p);
  expect(h.overlays).toHaveLength(2);
});

test('later focus change cannot close another pane', async () => {
  const h = ports(), first = context(); await module().handlePaneCommand('close', first, h.p);
  first.presentation.target.terminalId = 'mutated';
  const other = { ...context(), pane: { space: 's1', tab: 'tab-2', pane: 'pane-other' }, presentation: { ...presentation, id: 'pres-other', revision: 9, target: { ...target, terminalId: 't-other' } } };
  await module().handlePaneCommand('confirm-op1', other, h.p);
  expect(h.requests).toMatchObject([{ op: 'close-confirmed', operationId: 'op1', presentationId: 'pres-1', expectedRevision: 3, target: { coreId: 'core-remote', terminalId: 't7', createdMs: 42 } }]);
  expect(h.p.resolveTarget).toHaveBeenCalledOnce();
  await module().handlePaneCommand('confirm-op1', other, h.p);
  expect(h.requests).toHaveLength(1); expect(h.p.resolveTarget).toHaveBeenCalledOnce(); expect(h.p.run).not.toHaveBeenCalled(); expect(h.notices).toEqual([]);
});

test('confirmation that expires while reading the snapshot cannot close', async () => {
  const h = ports(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.p.resolveTarget = vi.fn(async () => { await gate; return target; });
  await module().handlePaneCommand('close', context(), h.p);
  const confirming = module().handlePaneCommand('confirm-op1', context(), h.p);
  h.advance(30_001); release(); await confirming;
  expect(h.requests).toEqual([]); expect(h.notices).toEqual(['Confirmation expired']);
  await module().handlePaneCommand('confirm-op1', context(), h.p);
  expect(h.p.resolveTarget).toHaveBeenCalledOnce();
});

test('a nonexistent inherited-property confirmation does not read the service', async () => {
  const h = ports(); await module().handlePaneCommand('confirm-constructor', context(), h.p);
  expect(h.p.resolveTarget).not.toHaveBeenCalled(); expect(h.requests).toEqual([]);
});

test('remote shell close also requires confirmation', async () => {
  const h = ports(), ctx = context(); ctx.presentation.role = 'shell'; ctx.presentation.target = { ...ctx.presentation.target, kind: 'terminal', sessionId: null, generation: null };
  await module().handlePaneCommand('close', ctx, h.p);
  expect(h.overlays).toHaveLength(1); expect(h.requests).toEqual([]);
});

test('expired confirmation and changed proxy labels cannot authorize a target', async () => {
  const h = ports(); await module().handlePaneCommand('close', context(), h.p); h.advance(30_001);
  await module().handlePaneCommand('confirm-op1', context(), h.p);
  const invalid = context(); invalid.header.labels['spider.target-terminal'] = 'successor';
  await module().handlePaneCommand('close', invalid, h.p);
  expect(h.requests).toEqual([]); expect(h.overlays).toHaveLength(1); expect(h.p.nativeClose).not.toHaveBeenCalled();
});

test('local close and park retain native callbacks', async () => {
  const h = ports(), native = { pane: placement, header: { ...header, address: 'local-t1', programIsAgent: true, labels: { 'spider.kind': 'session' } }, presentation: null };
  await module().handlePaneCommand('close', native, h.p); await module().handlePaneCommand('park', native, h.p);
  expect(h.p.nativeClose).toHaveBeenCalledOnce(); expect(h.p.nativePark).toHaveBeenCalledOnce();
  expect(h.requests).toEqual([]); expect(h.overlays).toEqual([]);
});

test('unknown proxy binding never falls back to native close or park', async () => {
  const h = ports(), unknown = { ...context(), presentation: null };
  await module().handlePaneCommand('close', unknown, h.p); await module().handlePaneCommand('park', unknown, h.p);
  expect(h.p.nativeClose).not.toHaveBeenCalled(); expect(h.p.nativePark).not.toHaveBeenCalled();
  expect(h.requests).toEqual([]); expect(h.overlays).toEqual([]); expect(h.notices).toHaveLength(2);
});

const flat = (root: any): any[] => root && typeof root === 'object' ? [root, ...(root.items ?? []).flatMap(flat)] : [];
const texts = (root: any): string[] => typeof root === 'string' ? [root] : root && typeof root === 'object' ? (root.items ?? []).flatMap(texts) : [];
const byId = (root: any, id: string) => flat(root).find(node => node.styles?.id?.[0] === id);
function renderHarness(version: SpacesAVersion) {
  const ui = createUiModules(), calls: any[] = [], values = new Map<string, any>(), waiters: ((command: string) => void)[] = [];
  const state: any = { props: { pane: 'pane-1' }, pane: { pane: 'pane-1', tab: 'tab-1', terminal: 'proxy-1', title: 'Node attach', cwd: '/mac/wrong', status: null, focused: true, program: { name: 'node' } }, labels: { ...labels } };
  const theme = Object.fromEntries(['dim','foreground','muted','hover','chrome','border','raised','selected','popover','working','blocked','done','ansi1'].map(k => [k, '#777777']));
  const host: any = { props: () => state.props, panes: () => [state.pane], terminals: () => [{ address: state.pane.terminal, labels: state.labels, state: 'live' }],
    spaces: () => [{ id: 's1', machine: null, active: true, tabs: [{ id: 'tab-1', active: true }] }], focused: () => ({ ...placement, terminal: state.pane.terminal }),
    theme: () => theme, home: () => '/home/example', layout: () => ({}), keys: () => [], window: () => ({}),
    shared: (k: string) => values.get(k), setShared: (k: string, v: unknown) => values.set(k, v),
    run: (...args: unknown[]) => calls.push(['run', ...args]), notify: (...args: unknown[]) => calls.push(['notify', ...args]),
    openOverlay: (spec: any) => { calls.push(['overlay', spec]); return 'confirm-overlay'; }, closeOverlay: (...args: unknown[]) => { calls.push(['overlay-close', ...args]); if (state.clearPropsOnClose) state.props = {}; },
    nextCommand: () => new Promise<string>(resolve => waiters.push(resolve)), appHome: () => '/fixture/app',
    readTextFile: async () => JSON.stringify({ version: 1, nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' }),
    exec: async (_cmd: string, args: string[]) => { const req = JSON.parse(args.at(-1)!); calls.push(['request', req]);
      return { code: 0, stdout: JSON.stringify(req.op === 'snapshot' ? { version: 1, kind: 'snapshot', presentations: state.snapshotPresentations ?? [presentation], targetFacts: {} } : { version: 1, kind: 'outcome', outcome: { status: 'complete', reason: '', presentation: null } }) }; } };
  const machineSource = readFileSync(new URL('../../assets/pane/machine.js', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  const machine = new Function('div', `${machineSource}; return { panePresentation, paneTargetFacts, resolvePaneHeaderFacts, renderMachinePill, closePaneHeaderProjection };`)(ui['gpui-kit'].div);
  const actions = module();
  const api: any = { ...ui['gpui-kit'], ...ui['gpui-base'], ...host, herdrApi: host, machineHerdr: host, middlePath, identityPill, ...machine, ...actions,
    initPaneHeaderProjection() {}, openPickerFromHost() {}, parkFocusedTerminal() {} };
  const cx: any = { focus_handle: () => ({ focus() {} }), stop_propagation() {}, notify() {}, spawn(fn: Function) { return fn(cx); } };
  const records = JSON.parse(readFileSync(new URL('../../assets/look/cross-machine-patches.json', import.meta.url), 'utf8'));
  const files = replaySpacesBRecipe(version, loadSpacesAFiles(version), records.versions[version]);
  const create = (mod: string, name: string) => {
    const code = files[mod]!['main.js']!.replace(/^(?:(?:\/\* spider-look:[a-z0-9-]+ \*\/)\s*)*import .*;\s*$/gm, '').replace('export default class ', 'class ');
    const Ctor = new Function('api', `const {${Object.keys(api).filter(key => key !== name).join(',')}}=api;${code};return ${name};`)(api);
    const view = new Ctor(); view.init({}, cx); view.machineSnapshot = { presentations: [presentation], targetFacts: {} }; return view;
  };
  return { host, state, calls, cx, create, dispatch: (command: string) => { const next = waiters.shift(); if (!next) throw new Error('header is not waiting for a command'); next(command); } };
}

for (const version of ['0.1.13', '0.1.16'] as const) {
  test(`${version}: focused header confirms captured proxy after focus changes`, async () => {
    const h = renderHarness(version); const pane = h.create('pane', 'Pane'); pane.hovered = true;
    byId(pane.render(h.cx), 'ph-x-pane-1').events.on_click({}, h.cx);
    await vi.waitFor(() => expect(h.calls.filter(c => c[0] === 'overlay')).toHaveLength(1));
    const dialog = h.calls.find(c => c[0] === 'overlay')[1];
    expect(dialog.mod).toBe('confirm'); expect(dialog.props.command.name).toMatch(/^spider-pane\.confirm-/);
    expect(h.calls.filter(c => c[0] === 'request' || c[0] === 'run')).toEqual([]);
    h.state.pane.focused = false;
    h.dispatch(dialog.props.command.name.slice('spider-pane.'.length));
    await vi.waitFor(() => expect(h.calls.filter(c => c[0] === 'request' && c[1].op === 'close-confirmed')).toHaveLength(1));
    expect(h.calls.filter(c => c[0] === 'request').map(c => c[1].op)).toEqual(['snapshot', 'close-confirmed']);
    expect(h.calls.find(c => c[0] === 'request' && c[1].op === 'close-confirmed')[1]).toMatchObject({ presentationId: 'pres-1', expectedRevision: 3, target: { coreId: 'core-remote', terminalId: 't7' } });
    expect(h.calls.find(c => c[0] === 'request' && c[1].op === 'close-confirmed')[1].target).toEqual(target);
    expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  });

  test(`${version}: close command reaches only the focused header`, async () => {
    const h = renderHarness(version); h.create('pane', 'Pane'); h.state.pane.focused = false;
    h.dispatch('close'); await Promise.resolve();
    expect(h.calls.filter(c => c[0] === 'overlay')).toEqual([]);
    h.state.pane.focused = true; h.dispatch('close');
    await vi.waitFor(() => expect(h.calls.filter(c => c[0] === 'overlay')).toHaveLength(1));
    expect(h.calls.find(c => c[0] === 'overlay')[1].mod).toBe('confirm');
  });

  test(`${version}: focused park requests the service instead of a native removal`, async () => {
    const h = renderHarness(version); h.create('pane', 'Pane');
    h.dispatch('park');
    await vi.waitFor(() => expect(h.calls.filter(c => c[0] === 'request')).toHaveLength(1));
    expect(h.calls.find(c => c[0] === 'request')[1]).toMatchObject({ op: 'park', presentationId: 'pres-1', expectedRevision: 3 });
    expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  });

  test(`${version}: local pi retains the native confirmation`, () => {
    const h = renderHarness(version); h.state.pane = { ...h.state.pane, terminal: 'local-t1', program: { key: 'pi', name: 'pi', agent: true } }; h.state.labels = {};
    const pane = h.create('pane', 'Pane'); pane.machineSnapshot = { presentations: [], targetFacts: {} }; pane.hovered = true;
    byId(pane.render(h.cx), 'ph-x-pane-1').events.on_click({}, h.cx);
    expect(h.calls.filter(c => c[0] === 'overlay')).toHaveLength(1);
    expect(h.calls.find(c => c[0] === 'overlay')[1]).toMatchObject({ mod: 'confirm', props: { command: { name: 'pane.close', args: { pane: 'pane-1' } } } });
    expect(h.calls.filter(c => c[0] === 'request')).toEqual([]);
  });

  test(`${version}: proxy menu close confirms the clicked target after overlay disposal`, async () => {
    const h = renderHarness(version); h.state.props = { tab: 'pane', target: { pane: 'pane-1', terminal: 'proxy-1' }, overlay: 'old' }; h.state.clearPropsOnClose = true;
    const menu = h.create('menu', 'Menu'), root = menu.render(h.cx);
    const row = flat(root).find(node => node.styles?.id?.[0]?.startsWith('mi-') && texts(node).includes('Close pane'));
    expect(row).toBeDefined(); row.events.on_click({}, h.cx);
    await vi.waitFor(() => expect(h.calls.some(c => c[0] === 'overlay')).toBe(true));
    const dialog = h.calls.find(c => c[0] === 'overlay')[1];
    expect(dialog).toMatchObject({ mod: 'confirm', props: { command: { name: expect.stringMatching(/^spider-pane\.confirm-/) } } });
    expect(h.calls.filter(c => c[0] === 'request' && c[1].op === 'close-confirmed')).toEqual([]);
    expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  });

  test(`${version}: proxy menu offers send back and captures its clicked pane`, async () => {
    const h = renderHarness(version); h.state.props = { tab: 'pane', target: { pane: 'pane-1', terminal: 'proxy-1' }, overlay: 'old' }; h.state.clearPropsOnClose = true;
    const menu = h.create('menu', 'Menu'), root = menu.render(h.cx);
    const row = flat(root).find(node => node.styles?.id?.[0]?.startsWith('mi-') && texts(node).some(text => text.startsWith('Send back')));
    expect(row).toBeDefined(); row.events.on_click({}, h.cx);
    await vi.waitFor(() => expect(h.calls.some(c => c[0] === 'request' && c[1].op === 'park')).toBe(true));
    expect(h.calls.find(c => c[0] === 'request' && c[1].op === 'park')[1]).toMatchObject({ presentationId: 'pres-1', expectedRevision: 3 });
    expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  });
}

test.each([
  ['missing', []],
  ['presentation id', [{ ...presentation, id: 'pres-other' }]],
  ['ambiguous id', [presentation, presentation]],
  ['revision', [{ ...presentation, revision: 4 }]],
  ['core', [{ ...presentation, target: { ...target, coreId: 'core-other' } }]],
  ['terminal', [{ ...presentation, target: { ...target, terminalId: 't-other' } }]],
  ['incarnation', [{ ...presentation, target: { ...target, createdMs: 43 } }]],
  ['non-proxy', [{ ...presentation, mode: 'native' }]],
  ['hidden', [{ ...presentation, visibility: 'parked' }]],
])('confirmation refuses a snapshot with changed %s', async (_label, rows) => {
  const h = renderHarness('0.1.13'); h.create('pane', 'Pane'); h.dispatch('close');
  await vi.waitFor(() => expect(h.calls.some(c => c[0] === 'overlay')).toBe(true));
  const command = h.calls.find(c => c[0] === 'overlay')[1].props.command.name.slice('spider-pane.'.length);
  h.state.snapshotPresentations = rows; h.dispatch(command);
  await vi.waitFor(() => expect(h.calls.some(c => c[0] === 'notify')).toBe(true));
  expect(h.calls.filter(c => c[0] === 'request').map(c => c[1].op)).toEqual(['snapshot']);
  expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  h.dispatch(command); await Promise.resolve();
  expect(h.calls.filter(c => c[0] === 'request').map(c => c[1].op)).toEqual(['snapshot']);
});

test('confirmation refuses an unavailable snapshot and consumes its token', async () => {
  const h = renderHarness('0.1.13'); h.create('pane', 'Pane'); h.dispatch('close');
  await vi.waitFor(() => expect(h.calls.some(c => c[0] === 'overlay')).toBe(true));
  const command = h.calls.find(c => c[0] === 'overlay')[1].props.command.name.slice('spider-pane.'.length);
  h.host.exec = async () => { throw new Error('offline'); }; h.dispatch(command);
  await vi.waitFor(() => expect(h.calls.some(c => c[0] === 'notify')).toBe(true));
  h.dispatch(command); await Promise.resolve();
  expect(h.calls.filter(c => c[0] === 'request' && c[1].op === 'close-confirmed')).toEqual([]);
  expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  expect(h.host.shared('spider.pane-confirmations')).toEqual({});
});

test('captured native header recognizes a reported agent', () => {
  const h = renderHarness('0.1.13');
  h.state.pane = { ...h.state.pane, terminal: 'local-t1', app: 'codex', program: { name: 'shell', shell: true, agent: false } }; h.state.labels = {};
  expect(module().capturePaneAction(h.host, 'pane-1', null).header.programIsAgent).toBe(true);
});

test('native menu close still works when the service is unavailable', async () => {
  const h = renderHarness('0.1.13'); h.state.pane = { ...h.state.pane, terminal: 'local-t1' }; h.state.labels = {};
  h.host.exec = async () => { throw new Error('offline'); };
  await module().routeMenuPaneCommand('close', { pane: 'pane-1', terminal: 'local-t1' }, h.host);
  expect(h.calls.filter(c => c[0] === 'run')).toEqual([['run', 'pane.close', { pane: 'pane-1' }]]);
});

test('an unavailable service cannot send a proxy back natively', async () => {
  const h = renderHarness('0.1.13'); h.host.exec = async () => { throw new Error('offline'); };
  await module().routeMenuPaneCommand('park', { pane: 'pane-1', terminal: 'proxy-1' }, h.host);
  expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  expect(h.calls.find(c => c[0] === 'notify')[1].title).toBe('Pane target is unavailable');
});

test('a stale proxy park refusal never triggers native removal', async () => {
  const h = renderHarness('0.1.13');
  h.host.exec = async (_cmd: string, args: string[]) => { const req = JSON.parse(args.at(-1)!); h.calls.push(['request', req]);
    return { code: 0, stdout: JSON.stringify({ version: 1, kind: 'outcome', outcome: { status: 'refused', reason: 'stale-presentation', presentation: null } }) }; };
  h.create('pane', 'Pane'); h.dispatch('park');
  await vi.waitFor(() => expect(h.calls.some(c => c[0] === 'notify')).toBe(true));
  expect(h.calls.find(c => c[0] === 'notify')[1].title).toBe('stale-presentation');
  expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
});

test('a clicked menu pane replaced while reading the snapshot is refused', async () => {
  const h = renderHarness('0.1.13'); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = h.host.exec;
  h.host.exec = async (...args: any[]) => { await gate; return original(...args); };
  const request = module().routeMenuPaneCommand('park', { pane: 'pane-1', terminal: 'proxy-1' }, h.host);
  h.state.pane = { ...h.state.pane, terminal: 'successor' }; release(); await request;
  expect(h.calls.filter(c => c[0] === 'request' && c[1].op === 'park')).toEqual([]);
  expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  expect(h.calls.find(c => c[0] === 'notify')[1].title).toBe('Pane target changed');
});
