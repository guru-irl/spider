// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createUiModules } from './strict-mod-api.mjs';
import { HerdrLabelContract } from '../contracts.js';
import { applyModPatches } from '../look/patches.js';
import { pickerRows, selectPickerRow } from '../../assets/picker/model.js';
import { indexPaneNavigation, projectNavigation } from '../../assets/shared/navigation.js';
import { describeOpenFailure } from '../../assets/shared/open-failure.js';
import { assignSpaceIdentities } from '../../assets/shared/look.js';
import { FEED_REFRESH_MS, createFeedReader, panelIpcArgv, parseSessionIpcReply, requestPaneService } from '../../assets/shared/feed.js';

const source = resolve('packages/herdr/assets/picker/main.js');
const localSpace = { id: 's1', index: 1, name: 'Work', machine: null, active: true, tabs: [{ id: 'tb1', name: 'Coding', active: true, status: null }] };
const remoteSpace = { id: 'box-1.invalid/s2', index: 2, name: 'Box', machine: 'box-1.invalid', active: false, tabs: [{ id: 'box-1.invalid/tb2', name: 'Remote', active: true, status: null }] };
const terminal = (address = 't1') => ({ address, parent: null, labels: {}, state: 'live', status: 'working' });
const agent = (address = 't1', pane = 'p1', title = 'Pi · Pi · Pi') => ({ address, pane, space: 's1', space_name: 'Work', tab: 'tb1', title, program: { name: 'pi' }, status: 'working', pinned: false, focused: false });
function feed(generation = 'gen-1', name = 'Writer') {
  const owner = { sessionId: 'session', generation, terminal: { coreId: 'core', terminalId: 't1', address: 't1', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name };
  return { version: 1, sessionId: 'session', generation, revision: 1, updatedAt: Date.now(), owner, lifecycle: 'live', placement: null,
    status: { native: 'working', effective: 'working', message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false },
    triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' } };
}
function flatten(root: any): any[] { return root && typeof root === 'object' ? [root, ...(root.items ?? []).flatMap(flatten)] : []; }
function text(root: any): string[] { return root && typeof root === 'object' ? (root.items ?? []).flatMap(text) : typeof root === 'string' ? [root] : []; }
function id(root: any, value: string): any { return flatten(root).find(item => item.styles?.id?.[0] === value); }
function inheritedStyle(root: any, matches: (node: any) => boolean): any {
  function visit(node: any, inherited: any): any {
    if (!node || typeof node !== 'object') return undefined;
    const style = { ...inherited };
    for (const [key, value] of Object.entries(node.styles ?? {}) as [string, any[]][]) {
      if (key === 'font_family' || key === 'text_size' || key === 'text_color') style[key] = value[0];
      if (key === 'font_normal') style.weight = 400;
      if (key === 'font_medium') style.weight = 500;
      if (key === 'font_semibold') style.weight = 600;
      if (key === 'font_bold') style.weight = 700;
      if (key === 'font_weight') style.weight = value[0];
    }
    if (matches(node)) return style;
    for (const child of node.items ?? []) { const found = visit(child, style); if (found) return found; }
    return undefined;
  }
  return visit(root, { weight: 400 });
}
const textStyle = (root: any, label: string) => inheritedStyle(root, node => node.items?.includes(label));

function host(options: { checking?: boolean; config?: 'props' | 'file' | 'missing' | 'invalid'; parked?: boolean; feeds?: any[]; status?: string; snapshotGate?: Promise<void>; fonts?: { body: string; label: string; paths: string }; pickerSource?: string } = {}) {
  const modules = createUiModules(), kit = modules['gpui-kit'], base = modules['gpui-base'];
  const inputs: any[] = [], calls: any[] = [], timers = new Set<any>(), watches = new Set<any>();
  let closed!: () => void;
  const state: any = { feeds: options.feeds ?? [feed()], spaces: [localSpace, remoteSpace], terms: [terminal()], agents: options.parked ? [] : [agent()],
    panes: options.parked ? [] : [{ pane: 'p1', terminal: 't1', tab: 'tb1', cwd: '/fixture' }], focus: { space: 's1', tab: 'tb1', pane: 'p1' }, closedReaders: 0, ipcReply: null, failSnapshot: false,
    closed: new Promise<void>(resolve => { closed = resolve; }) };
  const config = { version: 1, modId: 'spider-picker', feedRoot: '/fixture/feed', cliPath: '/fixture/cli.mjs', nodePath: '/fixture/node', labelContract: HerdrLabelContract, retention: { completedRows: 50, completedHours: 24 }, ...(options.fonts ? { fonts: options.fonts } : {}) };
  const inputState = { new() { const handlers: Record<string, Function> = {}; const input = { handlers, valueText: '', on(name: string, fn: Function) { handlers[name] = fn; }, value() { return this.valueText; }, focus() {} }; inputs.push(input); return input; } };
  const timer = { every(ms: number, fn: Function) { const handle = { ms, fn, cancel() { timers.delete(handle); } }; timers.add(handle); calls.push(['timer', ms]); return handle; }, after(ms: number, fn: Function) { return this.every(ms, fn); } };
  const cx: any = { timer, notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn(fn: Function) { const work: any = Promise.resolve().then(() => fn(cx)); work.cancel = () => {}; work.catch(() => {}); return work; } };
  const herdr: any = {
    props: () => options.config === 'invalid' ? { ...config, labelContract: { version: 1, labels: {}, kinds: {} }, overlay: 'overlay' }
      : options.config === 'props' || !options.config ? { ...config, overlay: 'overlay' } : { overlay: 'overlay' },
    checking: options.checking ? () => true : undefined,
    openOverlay: (spec: unknown) => calls.push(['openOverlay', spec]),
    appHome: () => '/fixture/app', readTextFile: async (path: string) => { calls.push(['readTextFile', path]); return options.config === 'file' ? JSON.stringify(config) : null; },
    spaces: () => state.spaces, agents: () => state.agents, terminals: () => state.terms, panes: () => state.panes,
    machines: () => [{ name: null, layout: 'ready' }, { name: 'box-1.invalid', layout: 'ready' }], focused: () => state.focus,
    theme: () => ({ foreground: '#ececed', muted: '#b4b4b5', dim: '#969697', hover: '#262628', working: '#d0d0d2', blocked: '#ffcb6b', done: '#969697', ansi1: '#ff5555' }),
    settings: () => ({ zoom: 1 }), closeOverlay: (overlay: string) => { calls.push(['closeOverlay', overlay]); closed(); }, run: (name: string, args: unknown) => calls.push(['run', name, args]),
    hc: async (args: string[]) => { calls.push(['hc', args]); return { code: 0, stdout: JSON.stringify(args[0] === 'server' ? { core: { id: 'core' } } : { machines: [] }) }; },
    exec: async (command: string, args: string[], options?: unknown) => {
      calls.push(['exec', command, args, options]);
      if (args.includes('panes')) {
        const request = JSON.parse(args.at(-1)!);
        if (request.op === 'snapshot') return { code: state.paneSnapshot ? 0 : 1, stdout: JSON.stringify(state.paneSnapshot ?? null) };
        return { code: 0, stdout: JSON.stringify({ version: 1, kind: 'outcome', outcome: { status: 'complete' } }) };
      }
      if (args.includes('ipc')) return state.ipcReply ? await state.ipcReply(JSON.parse(args[args.indexOf('--request') + 1]), options) : { code: 0, stdout: JSON.stringify({ ok: true, op: 'openSession', terminal: 't1' }) };
      return { code: 0, stdout: JSON.stringify({ version: 1, port: 1234, pid: 123, token: 'a'.repeat(64) }) };
    },
    watchFolder: (path: string) => {
      calls.push(['watchFolder', path]); let finish!: (value: string[]) => void;
      const promise: any = new Promise<string[]>(resolve => { finish = resolve; });
      promise.cancel = () => { if (watches.delete(promise)) finish([]); }; promise.fire = () => finish(['changed']); watches.add(promise); return promise;
    },
    nextCommand: () => new Promise(resolve => { state.deliverCommand = resolve; }),
  };
  const fetch = async (url: string) => {
    calls.push(['fetch', url]);
    if (url.endsWith('/close')) { state.closedReaders++; return { ok: true, json: async () => ({}) }; }
    if (options.snapshotGate) await options.snapshotGate;
    if (state.failSnapshot) throw new Error('offline');
    const entries = state.feeds.map((item: any) => ({ source: item.sessionId, stamp: item.generation, updatedAt: Date.now() }));
    return { ok: true, json: async () => ({ version: 1, entries, changes: state.feeds.map((item: any) => ({ source: item.sessionId, stamp: item.generation, feed: item })), errors: [] }) };
  };
  const api = { ...kit, ...base, svg: (path: string) => Object.assign(kit.svg(), { svgPath: path }), InputState: inputState, Input: { new: () => Object.assign(kit.div(), { inputElement: true }) }, herdr, fetch, pickerRows, selectPickerRow, projectNavigation, indexPaneNavigation, describeOpenFailure, assignSpaceIdentities, FEED_REFRESH_MS, createFeedReader, panelIpcArgv, parseSessionIpcReply, requestPaneService };
  const body = (options.pickerSource ?? readFileSync(source, 'utf8')).replace(/^import .*;\s*$/gm, '').replace(/export default class Picker/, 'class Picker').replace(/export class Picker/, 'class Picker').replace(/export default Picker;?/g, '');
  const Picker = new Function('api', `const { ${Object.keys(api).join(', ')} } = api; ${body}; return Picker;`)(api);
  const view = new Picker(); view.init({}, cx);
  return { view, cx, state, calls, inputs, timers, watches, config, herdr };
}

function sourceSnapshot(name: string | null) {
  const target = { coreId: 'remote-core', terminalId: 'remote-owner', address: 'remote-core/remote-owner', createdMs: 42, identityLabels: {}, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'session', sessionId: 'remote-session', generation: 'remote-generation', homeEpoch: 1, runId: null, consoleId: null, name, cwd: '/project' };
  return { version: 1, kind: 'snapshot', complete: true, omittedRows: 0, presentations: [], rows: [{ sessionId: target.sessionId, generation: target.generation, owner: { terminal: { address: target.address } }, target, name, status: 'working', machineKey: 'box-1.invalid', updatedAt: Date.now(), children: [{ runId: 'remote-child', name: 'Source child', status: 'working' }], consoles: [], unavailableReason: null }] };
}

it('keeps source-owned names and child actions without a local feed or remote app layout', async () => {
  const h = host({ feeds: [] });
  h.state.paneSnapshot = sourceSnapshot('Source writer');
  try {
    await h.view.ready;
    const root = h.view.render();
    expect(text(root)).toContain('Source writer');
    expect(text(root)).toContain('Source child');
    expect(text(root)).not.toContain('Pi · Pi · Pi');
    expect(textStyle(root, 'Source writer')).toMatchObject({ font_family: 'JetBrains Mono', text_size: 13, weight: 400 });
    expect(root.styles.bg?.[0]).toBe('#161618fe');
    await h.view.activate('session:remote-session');
    const requests = h.calls.filter(call => call[0] === 'exec' && call[2].includes('panes')).map(call => JSON.parse(call[2].at(-1)));
    expect(requests.filter(request => request.op === 'snapshot')).toHaveLength(2);
    expect(requests).toContainEqual(expect.objectContaining({ op: 'open-existing', sessionId: 'remote-session', generation: 'remote-generation', slot: { space: 's1', tab: 'tb1', pane: null } }));
    expect(h.calls.filter(call => call[0] === 'run' && call[1] === 'pane.focus')).toEqual([]);
  } finally { await h.view.close(); }
});

it('0.1.16 keeps a remote native picker action until a snapshot is available', async () => {
  const patchPath = resolve('packages/herdr/assets/look/native-picker-0.1.16.json');
  const records = existsSync(patchPath) ? JSON.parse(readFileSync(patchPath, 'utf8')) : [];
  const pickerSource = applyModPatches({ 'main.js': readFileSync(source, 'utf8') }, records, 'picker')['main.js'];
  const h = host({ config: 'missing', pickerSource });
  const address = 'box-1.invalid/t2';
  h.state.agents = [{ ...agent(address, 'remote-pane', 'Remote'), space: remoteSpace.id, tab: remoteSpace.tabs[0].id }];
  h.state.terms = [{ ...terminal(address), labels: { 'spider.display-name': 'Remote' } }];
  h.state.panes = [{ pane: 'remote-pane', terminal: address, tab: remoteSpace.tabs[0].id }];
  try {
    await h.view.ready;
    const row = h.view.rows().find((item: any) => item.id === `agent:${address}`);
    expect.soft(row?.enabled).toBe(true);
    await h.view.activate(`agent:${address}`);
    expect.soft(h.calls).toContainEqual(['run', 'pane.focus', { pane: 'remote-pane' }]);
  } finally { await h.view.close(); }
  const service = host({ feeds: [], pickerSource }); service.state.paneSnapshot = sourceSnapshot('Source writer');
  try {
    await service.view.ready;
    await service.view.activate('session:remote-session');
    const requests = service.calls.filter(call => call[0] === 'exec' && call[2].includes('panes')).map(call => JSON.parse(call[2].at(-1)));
    expect.soft(requests).toContainEqual(expect.objectContaining({ op: 'open-existing', sessionId: 'remote-session' }));
    expect.soft(service.calls.filter(call => call[0] === 'run' && call[1] === 'pane.focus')).toEqual([]);
  } finally { await service.view.close(); }
});

it('0.1.16 keeps the picker usable when a pane snapshot has malformed children', async () => {
  const patchPath = resolve('packages/herdr/assets/look/native-picker-0.1.16.json');
  const pickerSource = applyModPatches({ 'main.js': readFileSync(source, 'utf8') }, JSON.parse(readFileSync(patchPath, 'utf8')), 'picker')['main.js'];
  const h = host({ pickerSource });
  const bad = sourceSnapshot('Remote');
  (bad.rows[0] as any).children = null;
  h.state.paneSnapshot = bad;
  try {
    await h.view.ready;
    expect(() => h.view.render()).not.toThrow();
    expect(text(h.view.render())).toContain('Writer');
    expect(text(h.view.render())).toContain('Pane service unavailable; run doctor');
  } finally { await h.view.close(); }
});

it('hides an unnamed source owner and its children rather than using a generic agent name', async () => {
  const h = host({ feeds: [] });
  h.state.paneSnapshot = sourceSnapshot(null);
  try {
    await h.view.ready;
    expect(text(h.view.render())).not.toContain('Agent');
    expect(text(h.view.render())).not.toContain('Source child');
    h.state.paneSnapshot.rows[0].name = 'Source writer';
    await h.view.refresh();
    expect(text(h.view.render())).toContain('Source writer');
    expect(text(h.view.render())).toContain('Source child');
  } finally { await h.view.close(); }
});

it('renders neutral shape rows and named sessions without an input border or shadow', async () => {
  const h = host(); await h.view.ready;
  const root = h.view.render();
  expect(root.styles.rounded?.[0]).toBe(12); expect(root.styles.bg?.[0]).toBe('#161618fe');
  expect(text(root)).toContain('Writer'); expect(text(root)).not.toContain('Pi · Pi · Pi');
  expect(flatten(root).some(node => Object.keys(node.styles ?? {}).some(key => key.startsWith('border') || key.startsWith('shadow')))).toBe(false);
  expect(flatten(root).some(node => node.svgPath === 'mods/spider-picker/space-triangle.svg')).toBe(true);
  const manifest = JSON.parse(readFileSync(resolve('packages/herdr/assets/picker/mod.json'), 'utf8'));
  expect(manifest.overlay.frame).toBe('none');
  await h.view.close();
});

it.each([['blocked', 'needs you', '#ffcb6b'], ['error', 'error', '#ff5555']])('styles %s status without coloring the machine pill', async (status, label, color) => {
  const value = feed(); value.status.effective = status;
  const h = host({ feeds: [value] }); await h.view.ready;
  h.state.agents.push({ ...agent('box-1.invalid/t2', 'remote-pane', 'Remote'), space: remoteSpace.id, tab: remoteSpace.tabs[0].id });
  h.state.terms.push({ ...terminal('box-1.invalid/t2'), labels: { 'spider.display-name': 'Remote' } }); h.state.panes.push({ pane: 'remote-pane', terminal: 'box-1.invalid/t2', tab: remoteSpace.tabs[0].id, cwd: null });
  const nodes = flatten(h.view.render());
  expect(nodes.find(node => text(node).includes(label) && node.styles?.text_color?.[0] === color)).toBeDefined();
  expect(nodes.find(node => text(node).includes('box-1.invalid') && node.styles?.bg?.[0] === '#ffffff0d' && node.styles?.text_color?.[0] === '#969697')).toBeDefined();
  await h.view.close();
});

it('uses the shared space identity even when filtering changes row positions', async () => {
  const h = host({ config: 'missing' }); await h.view.ready;
  h.state.spaces = [localSpace, { id: 's2', index: 2, name: 'Alpha', machine: null, active: false, tabs: [] }, remoteSpace];
  h.inputs[0].valueText = 'Alpha'; h.inputs[0].handlers.change({}, h.cx);
  const row = id(h.view.render(), 'pk-space:s2'); expect(row).toBeDefined();
  expect(flatten(row).some(node => node.svgPath === 'mods/spider-picker/space-star.svg')).toBe(true);
  await h.view.close();
});

it('indents child identities and uses the sidebar body and name fonts', async () => {
  const value = feed(); (value.runs.rows as any[]).push({ id: 'run-a', ownerSessionId: 'session', name: 'Child', status: 'running', childMode: 'rpc', canSteer: true, startedAt: Date.now(), finishedAt: null, viewer: null, result: null }); value.runs.total = 1;
  const h = host({ feeds: [value] }); await h.view.ready; const root = h.view.render();
  const parent = id(root, 'pk-session:session'), child = id(root, 'pk-run:session:run-a');
  expect(parent).toBeDefined(); expect(child).toBeDefined();
  expect(parent.styles.pl?.[0]).toBe(10); expect(child.styles.pl?.[0]).toBe(26);
  expect(flatten(child).some(node => node.svgPath === 'mods/spider-agents/bot.svg')).toBe(true);
  expect(root.styles.font_family?.[0]).toBe('Google Sans Flex');
  expect(flatten(parent).find(node => node.items?.includes('Writer'))?.styles.font_family?.[0]).toBe('JetBrains Mono');
  await h.view.close();
});

it('uses the same regular sidebar name style for every kind of row', async () => {
  const value = feed();
  (value.runs.rows as any[]).push({ id: 'run-a', ownerSessionId: 'session', name: 'Child', status: 'running', childMode: 'rpc', canSteer: true, startedAt: Date.now(), finishedAt: null, viewer: null, result: null }); value.runs.total = 1;
  const h = host({ feeds: [value], fonts: { body: 'Fixture Body', label: 'Fixture Heavy', paths: 'Fixture Mono' } }); await h.view.ready;
  h.state.terms.push({ ...terminal('view1'), parent: 't1', labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 'session', 'spider.run': 'run-a' } },
    { ...terminal('box-1.invalid/console'), parent: 'view1', labels: { 'spider.kind': 'remote-console', 'spider.session': 'session', 'spider.run': 'run-a', 'spider.machine': 'box-1.invalid' } });
  const root = h.view.render();
  for (const label of ['Work', 'Coding', 'Writer', 'Child', 'Child console', 'New tab', 'New space']) {
    expect.soft(textStyle(root, label), label).toMatchObject({ font_family: 'Fixture Mono', text_size: 13, weight: 400, text_color: '#ececed' });
  }
  await h.view.close();
});

it('matches sidebar headings, input, path and machine metadata', async () => {
  const value = feed(); value.status.effective = 'blocked';
  const h = host({ feeds: [value], fonts: { body: 'Fixture Body', label: 'Fixture Heavy', paths: 'Fixture Mono' } }); await h.view.ready;
  h.state.agents.push({ ...agent('box-1.invalid/t2', 'remote-pane', 'Remote agent'), space: remoteSpace.id, tab: remoteSpace.tabs[0].id });
  h.state.terms.push({ ...terminal('box-1.invalid/t2'), labels: { 'spider.display-name': 'Remote agent' } }); h.state.panes.push({ pane: 'remote-pane', terminal: 'box-1.invalid/t2', tab: remoteSpace.tabs[0].id, cwd: null });
  const root = h.view.render();
  expect.soft(textStyle(root, 'Go to…')).toMatchObject({ font_family: 'Fixture Body', text_size: 11.5, weight: 500, text_color: '#969697' });
  expect.soft(textStyle(root, 'Agents without a local tab')).toMatchObject({ font_family: 'Fixture Body', text_size: 11.5, weight: 500, text_color: '#969697' });
  expect.soft(textStyle(root, 'Esc')).toMatchObject({ font_family: 'Fixture Body', text_size: 11, weight: 400, text_color: '#969697' });
  expect.soft(inheritedStyle(root, node => node.inputElement)).toMatchObject({ font_family: 'Fixture Body', text_size: 13, weight: 400, text_color: '#ececed' });
  expect.soft(textStyle(root, '/fixture')).toMatchObject({ font_family: 'Fixture Mono', text_size: 10, weight: 400, text_color: '#969697' });
  expect.soft(textStyle(root, 'box-1.invalid')).toMatchObject({ font_family: 'Fixture Body', text_size: 10, weight: 400, text_color: '#969697' });
  expect.soft(textStyle(root, 'needs you')).toMatchObject({ font_family: 'Fixture Body', text_size: 10.5, weight: 600, text_color: '#ffcb6b' });
  await h.view.close();
});

it('matches the sidebar error metadata style', async () => {
  const value = feed(); value.status.effective = 'error';
  const h = host({ feeds: [value], fonts: { body: 'Fixture Body', label: 'Fixture Heavy', paths: 'Fixture Mono' } }); await h.view.ready;
  expect(textStyle(h.view.render(), 'error')).toMatchObject({ font_family: 'Fixture Mono', text_size: 10.5, weight: 400, text_color: '#ff5555' });
  await h.view.close();
});

it.each([1, 25])('covers all picker content with the near-solid neutral surface (%i tabs)', async count => {
  const h = host({ config: 'missing' }); await h.view.ready;
  h.state.spaces = [{ ...localSpace, tabs: Array.from({ length: count }, (_, index) => ({ id: `tab-${index}`, name: `Tab ${index}`, active: index === 0 })) }];
  const root = h.view.render();
  expect(root.styles.bg?.[0]).toBe('#161618fe');
  expect(root.styles.w_full).toBeDefined();
  expect(id(root, 'pk-list')).toBeDefined();
  expect(flatten(root).some(node => node.styles?.opacity)).toBe(false);
  expect(flatten(root).some(node => Object.keys(node.styles ?? {}).some(key => key.startsWith('border') || key.startsWith('shadow')))).toBe(false);
  await h.view.close();
});

it('refreshes feeds every five seconds and caches machine identities for fifteen seconds', async () => {
  const now = Date.now(), h = host(); await h.view.ready;
  const machineCalls = () => h.calls.filter(call => call[0] === 'hc' && call[1][0] === 'machine').length;
  try {
    expect([...h.timers].some((timer: any) => timer.ms === 5000)).toBe(true);
    expect(machineCalls()).toBe(1); await h.view.refresh(); await h.view.refresh(); expect(machineCalls()).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(now + 16000); await h.view.refresh(); expect(machineCalls()).toBe(2);
  } finally { vi.restoreAllMocks(); await h.view.close(); }
});

it('keeps wheel scrolling instead of snapping back until selection changes', async () => {
  const h = host({ config: 'missing' }); await h.view.ready;
  h.state.spaces = [{ ...localSpace, tabs: Array.from({ length: 25 }, (_, index) => ({ id: `tab-${index}`, index: index + 1, name: `Tab ${index}`, active: index === 0 })) }];
  const first = h.view.render(), list = id(first, 'pk-list');
  expect(list.events.on_scroll_wheel).toBeTypeOf('function');
  list.events.on_scroll_wheel({ delta: { y: -120 } }, h.cx); h.view.render();
  expect(h.view.scroll).toBe(120);
  h.view.selectedId = 'tab:s1:tab-24'; h.view.render(); expect(h.view.scroll).toBeGreaterThan(120);
  await h.view.close();
});

it('falls back to labelled native rows when the picker config is absent', async () => {
  const h = host({ config: 'missing' }); h.state.terms[0].labels['spider.display-name'] = 'Linter'; await h.view.ready;
  expect(h.view.rows().map((row: any) => row.label)).toContain('Linter');
  expect(h.view.rows().map((row: any) => row.label)).not.toContain('Pi · Pi · Pi');
  expect(h.calls.filter(call => call[0] === 'exec')).toEqual([]);
  await h.view.close();
});

it('disposes the feed reader and every folder watch when the overlay closes', async () => {
  const h = host(); await h.view.ready;
  expect(h.watches.size).toBe(1);
  await h.view.close();
  expect(h.state.closedReaders).toBe(1); expect(h.watches.size).toBe(0); expect(h.timers.size).toBe(0);
});

it('rejects malformed label contracts in props and keeps labelled native rows', async () => {
  const h = host({ config: 'invalid' }); h.state.terms[0].labels['spider.display-name'] = 'Linter'; await h.view.ready;
  expect(h.view.rows().map((row: any) => row.label)).toContain('Linter');
  expect(h.view.rows().map((row: any) => row.label)).not.toContain('Pi · Pi · Pi');
  expect(h.calls.filter(call => call[0] === 'exec')).toEqual([]);
  expect(h.calls).toContainEqual(['readTextFile', '/fixture/app/mods/spider-picker/config.json']);
  await h.view.close();
});

it.each(['props', 'file'] as const)('first frame hides raw targets while %s config and feed load', async config => {
  let release!: () => void;
  const snapshotGate = new Promise<void>(resolve => { release = resolve; });
  const h = host({ config, snapshotGate });
  h.state.agents[0].title = 'π - raw terminal title'; h.state.panes[0].cwd = '/fixture/raw-terminal-path';
  try {
    const first = h.view.render();
    expect(text(first)).toContain('Work');
    expect.soft(text(first)).not.toContain('Coding');
    expect.soft(text(first)).not.toContain('π - raw terminal title');
    expect.soft(text(first)).not.toContain('/fixture/raw-terminal-path');
    expect.soft(flatten(first).some(node => node.svgPath === 'mods/workspace-chrome/terminal.svg')).toBe(false);
    await vi.waitFor(() => expect(h.calls.some(call => call[0] === 'fetch' && call[1].endsWith('/snapshot'))).toBe(true));
    const pending = h.view.render();
    expect(text(pending)).toContain('Work');
    expect(text(pending)).not.toContain('π - raw terminal title');
    expect(text(pending)).not.toContain('/fixture/raw-terminal-path');
    release(); await h.view.ready;
    const settled = h.view.render();
    expect(text(settled)).toContain('Coding');
    expect(text(settled)).toContain('Writer');
    expect(text(settled)).not.toContain('π - raw terminal title');
  } finally { release(); await h.view.close(); }
});

it('first frame and missing config never reveal an unlabelled terminal title', async () => {
  const h = host({ config: 'missing' });
  h.state.agents[0].title = 'π - raw terminal title'; h.state.panes[0].cwd = '/fixture/raw-terminal-path';
  const first = h.view.render();
  expect(text(first)).toContain('Work');
  expect(text(first)).not.toContain('π - raw terminal title');
  expect(text(first)).not.toContain('/fixture/raw-terminal-path');
  await h.view.ready;
  expect(text(h.view.render())).not.toContain('π - raw terminal title');
  h.state.terms[0].labels['spider.display-name'] = 'Linter';
  expect(text(h.view.render())).toContain('Linter');
  await h.view.close();
});

it('does not expose raw terminal names or paths when no feed identifies an agent', async () => {
  const h = host({ feeds: [] });
  h.state.agents[0].title = 'π - raw terminal title'; h.state.panes[0].cwd = '/fixture/raw-terminal-path';
  await h.view.ready;
  const noName = h.view.render();
  expect(text(noName)).not.toContain('π - raw terminal title');
  expect(text(noName)).not.toContain('/fixture/raw-terminal-path');
  h.state.terms[0].labels['spider.display-name'] = 'Linter';
  expect(text(h.view.render())).toContain('Linter');
  await h.view.close();
});

it('uses only display labels on an initial feed failure and restores feed names after recovery', async () => {
  const h = host(); h.state.failSnapshot = true;
  h.state.agents[0].title = 'π - raw terminal title'; h.state.panes[0].cwd = '/fixture/raw-terminal-path';
  h.state.terms[0].labels['spider.display-name'] = 'Linter';
  try {
    await h.view.ready;
    const failed = h.view.render();
    expect(text(failed)).toContain('Linter');
    expect(text(failed)).not.toContain('π - raw terminal title');
    expect(text(failed)).not.toContain('/fixture/raw-terminal-path');
    expect(text(failed)).toContain('Session information is unavailable');
    h.state.failSnapshot = false;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
    expect(await h.view.refresh()).toBe(true);
    expect(text(h.view.render())).toContain('Writer');
    expect(text(h.view.render())).not.toContain('Linter');
  } finally { vi.restoreAllMocks(); await h.view.close(); }
});

it('hides an unnamed feed owner and its children until a display name is available', async () => {
  const value = feed(); (value.owner as any).name = null;
  (value.runs.rows as any[]).push({ id: 'run-a', ownerSessionId: 'session', name: 'Child', status: 'running', childMode: 'rpc', canSteer: true, startedAt: Date.now(), finishedAt: null, viewer: null, result: null }); value.runs.total = 1;
  const h = host({ feeds: [value] }); h.state.agents[0].title = 'π - raw terminal title'; await h.view.ready;
  expect(text(h.view.render())).not.toContain('π - raw terminal title');
  expect(text(h.view.render())).not.toContain('Child');
  h.state.terms[0].labels['spider.display-name'] = 'Linter';
  expect(text(h.view.render())).toContain('Linter');
  expect(text(h.view.render())).toContain('Child');
  await h.view.close();
});

it('keeps the current tab as the default after an initial spaces-only frame', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = host({ snapshotGate: gate });
  try {
    expect(text(h.view.render())).toContain('Work');
    await vi.waitFor(() => expect(h.calls.some(call => call[0] === 'fetch' && call[1].endsWith('/snapshot'))).toBe(true));
    release(); await h.view.ready; h.view.render();
    expect(h.view.selectedId).toBe('tab:s1:tb1');
    h.inputs[0].handlers.submit({}, h.cx); await h.state.closed;
    expect(h.calls.filter(call => call[0] === 'run')).toEqual([['run', 'tab.select', { id: 'tb1' }]]);
  } finally { release(); await h.view.close(); }
});

it('reads the installed versioned config when overlay props do not contain it', async () => {
  const h = host({ config: 'file' }); await h.view.ready;
  expect(h.calls).toContainEqual(['readTextFile', '/fixture/app/mods/spider-picker/config.json']);
  expect(h.view.rows().map((row: any) => row.label)).toContain('Writer');
  await h.view.close();
});

it('shares Enter and click activation while a current-owner IPC request is pending', async () => {
  const h = host({ parked: true }); await h.view.ready;
  const reply = { ok: true, op: 'openSession', terminal: 't1' };
  expect(parseSessionIpcReply(JSON.stringify(reply))).toEqual(reply);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const actions: Promise<void>[] = [], activate = h.view.activate.bind(h.view);
  h.view.activate = (rowId: string) => { const action = activate(rowId); actions.push(action); return action; };
  h.state.ipcReply = async () => { entered(); await gate; return { code: 0, stdout: JSON.stringify(reply) }; };
  try {
    h.view.selectedId = 'session:session';
    const row = id(h.view.render(), 'pk-session:session'); expect(row).toBeDefined();
    expect(h.view.rows().find((item: any) => item.id === 'session:session')).toMatchObject({ enabled: true, target: { action: { kind: 'ipc', request: { op: 'openSession' } } } });
    h.inputs[0].handlers.submit({}, h.cx);
    await Promise.race([started, actions[0].then(() => { throw new Error(`IPC did not start: ${h.view.problem ?? 'no action'}`); })]);
    row.events.on_click({}, h.cx);
    expect(h.calls.filter(call => call[0] === 'exec' && call[2].includes('ipc'))).toHaveLength(1);
    release(); await Promise.all(actions);
    expect(h.view.problem).toBeNull();
    expect(h.calls).toContainEqual(['closeOverlay', 'overlay']);
    expect(h.calls).toContainEqual(['run', 'pane.focus', { terminal: 't1' }]);
  } finally { release(); await h.view.close(); }
});

it('sends an authenticated cancellation on Escape while a reopen is pending', async () => {
  const h = host({ parked: true }); await h.view.ready;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: any[] = [];
  h.state.ipcReply = async (request: any) => {
    requests.push(request);
    if (request.op === 'cancelOpen') return { code: 0, stdout: JSON.stringify({ ok: true, op: 'cancelOpen' }) };
    entered(); await gate; return { code: 0, stdout: JSON.stringify({ ok: true, op: 'openSession', terminal: 't1' }) };
  };
  try {
    h.herdr.commands = () => [{ name: 'terminal.keep', args: [{ name: 'terminal' }, { name: 'place' }, { name: 'focus' }] }];
    const opening = h.view.activate('session:session'); await started;
    expect(requests[0]).toMatchObject({ returnFocus: { space: 's1', tab: 'tb1', pane: 'p1' }, backgroundKeep: true });
    await h.view.activate('tab:s1:tb1');
    expect(h.calls.filter(call => call[0] === 'run')).toEqual([]);
    h.view.render().events.on_key_down({ key: 'escape' }, h.cx);
    await vi.waitFor(() => expect(requests.find(request => request.op === 'cancelOpen')).toMatchObject({ generation: requests[0].generation, requestId: requests[0].requestId }));
    expect(requests[0].requestId).toMatch(/^[a-z0-9]{16,64}$/);
    release(); await opening;
    expect(h.calls.filter(call => call[0] === 'run')).toEqual([]);
    const ipcCalls = h.calls.filter(call => call[0] === 'exec' && call[2].includes('ipc'));
    expect(ipcCalls[0][3]).toMatchObject({ timeout: 65000 });
  } finally { release(); await h.view.close(); }
});

it('keeps selection stable across feed refresh and sends the current generation', async () => {
  const h = host({ parked: true }); await h.view.ready;
  h.view.selectedId = 'session:session'; h.state.feeds = [feed('gen-2', 'Writer updated')];
  await h.view.refresh();
  expect(h.view.rows().find((row: any) => row.id === h.view.selectedId)?.label).toBe('Writer updated');
  await h.view.activate('session:session');
  const call = h.calls.find(call => call[0] === 'exec' && call[2].includes('ipc'));
  expect(JSON.parse(call[2][call[2].indexOf('--request') + 1])).toMatchObject({ op: 'openSession', generation: 'gen-2' });
  await h.view.close();
});

it('explains why a reachable child is disabled when its owner machine is down', async () => {
  const work = feed(); work.owner.terminal.coreId = 'remote-core'; work.owner.terminal.address = 'box-1.invalid/t1';
  (work.runs.rows as any[]).push({ id: 'run-1', ownerSessionId: 'session', name: 'Child', status: 'running', childMode: 'rpc', canSteer: true, startedAt: Date.now(), finishedAt: null, viewer: null, result: null }); work.runs.total = 1;
  const h = host({ feeds: [work] }); await h.view.ready;
  h.state.agents = []; h.state.terms = [terminal('box-1.invalid/t1'), { ...terminal('box-2.invalid/view'), parent: 'box-1.invalid/t1', labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 'session', 'spider.run': 'run-1' } }];
  h.view.machineIds = new Map([['box-1.invalid', 'remote-core'], ['box-2.invalid', 'box-2-core']]);
  h.herdr.machines = () => [{ name: 'box-1.invalid', layout: 'unavailable' }, { name: 'box-2.invalid', layout: 'ready' }];
  const row = id(h.view.render(), 'pk-run:session:run-1');
  expect(row).toBeDefined(); expect(row.styles.tooltip?.[0]).toBe('Owner on box-1.invalid is unreachable');
  expect(row.events.on_click).toBeUndefined(); await h.view.close();
});

it('keeps native rows usable when the feed reader is unavailable', async () => {
  const h = host(); await h.view.ready; h.state.failSnapshot = true;
  await h.view.activate('tab:s1:tb1');
  expect(h.calls).toContainEqual(['run', 'tab.select', { id: 'tb1' }]);
  await h.view.close();
});

it('does not dispatch a stale action when the required refresh fails', async () => {
  const h = host({ parked: true }); await h.view.ready; h.state.failSnapshot = true;
  await h.view.activate('session:session');
  expect(h.calls.filter(call => call[0] === 'exec' && call[2].includes('ipc'))).toEqual([]);
  expect(h.view.problem).toBe('Session information is unavailable');
  await h.view.close();
});

it.each([
  ['wrong-generation', 'wrong-generation', 'Owning session unavailable'],
  ['unavailable', 'pane-timeout', 'Timed out opening the pane'],
  ['unavailable', 'view-on-mac', 'This needs the Herdr app on this Mac'],
])('explains %s/%s in words', async (code, message, expected) => {
  const h = host({ parked: true }); await h.view.ready;
  h.state.ipcReply = async () => ({ code: 0, stdout: JSON.stringify({ ok: false, code, message }) });
  await h.view.activate('session:session');
  expect(h.view.problem).toBe(expected);
  await h.view.close();
});

it('explains when a session vanishes during the pre-dispatch refresh', async () => {
  const h = host({ parked: true }); await h.view.ready;
  h.state.feeds = [];
  await h.view.activate('session:session');
  expect(h.view.problem).toBe('Owning session unavailable');
  expect(h.calls.filter(call => call[0] === 'exec' && call[2].includes('ipc'))).toEqual([]);
  await h.view.close();
});

it('explains when a target disappears before activation begins', async () => {
  const h = host({ parked: true }); await h.view.ready;
  h.view.feeds = []; h.state.terms = [];
  await h.view.activate('session:session');
  expect(h.view.problem).toBe('Owning session unavailable');
  expect(h.calls.filter(call => call[0] === 'exec' && call[2].includes('ipc'))).toEqual([]);
  await h.view.close();
});

it('selects the current tab on opening so Enter does not switch spaces', async () => {
  const h = host({ config: 'missing' });
  h.state.spaces = [{ ...localSpace, id: 's0', name: 'Other', active: false, tabs: [{ ...localSpace.tabs[0], id: 'tb0' }] }, localSpace];
  await h.view.ready; h.view.render(); h.inputs[0].handlers.submit({}, h.cx); await h.state.closed;
  expect(h.calls.filter(call => call[0] === 'run')).toEqual([['run', 'tab.select', { id: 'tb1' }]]);
});

it('explains an old endpoint without launching a replacement terminal', async () => {
  const h = host({ parked: true }); await h.view.ready;
  h.state.ipcReply = async () => ({ code: 0, stdout: JSON.stringify({ ok: false, code: 'unknown-op', message: 'unknown-op' }) });
  await h.view.activate('session:session');
  expect(h.view.problem).toBe('Run /reload to enable session reopening');
  expect(h.calls.filter(call => call[0] === 'run' && ['tab.new', 'terminal.keep'].includes(call[1]))).toEqual([]);
  await h.view.close();
});

it('surfaces an uncertain IPC result without retrying it', async () => {
  const h = host({ parked: true }); await h.view.ready;
  h.state.ipcReply = async () => { throw new Error('acknowledgement lost'); };
  await h.view.activate('session:session');
  expect(h.calls.filter(call => call[0] === 'exec' && call[2].includes('ipc'))).toHaveLength(1);
  expect(h.view.problem).toContain('acknowledgement lost');
  expect(h.calls.filter(call => call[0] === 'run')).toEqual([]);
  await h.view.close();
});

it('opens the machine picker in a Mac space after remote focus and keeps new space local', async () => {
  const tab = host({ config: 'missing' }); await tab.view.ready;
  tab.state.spaces = [{ ...localSpace, active: false }, { ...remoteSpace, active: true }]; tab.state.focus = { space: remoteSpace.id, tab: remoteSpace.tabs[0].id, pane: 'remote-pane' };
  await tab.view.activate('new-tab');
  expect(tab.calls.find(call => call[0] === 'openOverlay')?.[1]).toMatchObject({ mod: 'spider-machine-picker', props: { continuation: 'menu', intent: { space: 's1', place: 'tab', anchor: null } } });
  expect(tab.calls.filter(call => call[0] === 'run' && call[1] === 'tab.new')).toEqual([]);
  const space = host({ config: 'missing' }); await space.view.ready;
  space.state.spaces = [{ ...localSpace, active: false }, { ...remoteSpace, active: true }]; space.state.focus = tab.state.focus;
  await space.view.activate('new-space');
  expect(space.calls).toContainEqual(['run', 'space.new', { machine: '' }]);
});

it('disables new tab with a reason when no local space exists', async () => {
  const h = host({ config: 'missing' }); await h.view.ready; h.state.spaces = [{ ...remoteSpace, active: true }];
  expect(h.view.rows().find((row: any) => row.id === 'new-tab')).toMatchObject({ enabled: false });
  expect(id(h.view.render(), 'pk-new-tab').styles.tooltip[0]).toBe('No local space is available');
  await h.view.activate('new-tab'); expect(h.calls.filter(call => call[0] === 'run')).toEqual([]);
  await h.view.close();
});

it('closes only the selected existing tab on Ctrl-D', async () => {
  const h = host({ config: 'missing' }); await h.view.ready; h.view.selectedId = 'tab:s1:tb1';
  h.view.render().events.on_key_down({ key: 'd', modifiers: { control: true } }, h.cx);
  expect(h.calls).toContainEqual(['run', 'tab.close', { id: 'tb1' }]); await h.state.closed;
  const other = host({ config: 'missing' }); await other.view.ready; other.view.selectedId = 'new-tab';
  other.view.render().events.on_key_down({ key: 'd', modifiers: { control: true } }, other.cx);
  expect(other.calls.filter(call => call[0] === 'run' && call[1] === 'tab.close')).toEqual([]); await other.view.close();
});

it('wraps arrows, selects on hover, and submits nothing for an empty filter', async () => {
  const h = host({ config: 'missing' }); await h.view.ready;
  const rows = h.view.rows().filter((row: any) => row.enabled); h.view.selectedId = rows[0].id;
  let root = h.view.render(); root.events.on_key_down({ key: 'up' }, h.cx);
  expect(h.view.selectedId).toBe(rows.at(-1).id);
  root.events.on_key_down({ key: 'down' }, h.cx); expect(h.view.selectedId).toBe(rows[0].id);
  root = h.view.render(); const target = id(root, `pk-${rows[1].id}`); expect(target).toBeDefined(); target.events.on_mouse_move({}, h.cx);
  expect(h.view.selectedId).toBe(rows[1].id);
  h.inputs[0].valueText = 'no matching item'; h.inputs[0].handlers.change({}, h.cx);
  expect(text(h.view.render())).toContain('No results'); h.inputs[0].handlers.submit({}, h.cx);
  expect(h.calls.filter(call => call[0] === 'run')).toEqual([]); await h.view.close();
});

it('uses a focus handle and closes from Escape and the visible Escape control', async () => {
  const h = host({ config: 'missing' }); await h.view.ready; const root = h.view.render();
  expect(root.styles.track_focus).toBeDefined(); root.events.on_key_down({ key: 'escape' }, h.cx); await h.state.closed;
  const click = host({ config: 'missing' }); await click.view.ready; const esc = id(click.view.render(), 'picker-esc');
  expect(esc).toBeDefined(); esc.events.on_click({}, click.cx); await click.state.closed;
});

it('cancels a completed watch before re-arming and releases repeated overlays', async () => {
  for (let i = 0; i < 3; i++) {
    const h = host(); await h.view.ready; const first: any = [...h.watches][0]; first.fire();
    await vi.waitFor(() => expect([...h.watches].some(watch => watch !== first)).toBe(true));
    expect(h.watches.has(first)).toBe(false); expect(h.watches.size).toBe(1);
    await h.view.close(); expect(h.watches.size).toBe(0);
  }
});

it('uses the same refresh and activate path for mod commands', async () => {
  const h = host(); await h.view.ready; const first = h.state.deliverCommand;
  h.state.feeds = [feed('gen-2', 'Updated')]; first('refresh');
  await vi.waitFor(() => expect(h.view.rows().map((row: any) => row.label)).toContain('Updated'));
  await vi.waitFor(() => expect(h.state.deliverCommand).not.toBe(first));
  h.view.selectedId = 'session:session'; h.state.deliverCommand('activate-current'); await h.state.closed;
  expect(h.calls).toContainEqual(['run', 'pane.focus', { pane: 'p1' }]);
});

it('does no process, timer, config, feed, or watch work during app checks', async () => {
  const h = host({ checking: true, config: 'missing' }); await h.view.ready; h.view.render();
  expect(h.calls.filter(call => ['exec', 'hc', 'timer', 'readTextFile', 'fetch', 'watchFolder'].includes(call[0]))).toEqual([]);
  await h.view.close();
});
