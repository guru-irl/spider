// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createUiModules } from './strict-mod-api.mjs';
import { HerdrLabelContract } from '../contracts.js';
import { pickerRows, selectPickerRow } from '../../assets/picker/model.js';
import { projectNavigation } from '../../assets/shared/navigation.js';
import { assignSpaceIdentities } from '../../assets/shared/look.js';
import { FEED_REFRESH_MS, createFeedReader, panelIpcArgv, parseSessionIpcReply } from '../../assets/shared/feed.js';

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

function host(options: { checking?: boolean; config?: 'props' | 'file' | 'missing' | 'invalid'; parked?: boolean; feeds?: any[]; status?: string } = {}) {
  const modules = createUiModules(), kit = modules['gpui-kit'], base = modules['gpui-base'];
  const inputs: any[] = [], calls: any[] = [], timers = new Set<any>(), watches = new Set<any>();
  let closed!: () => void;
  const state: any = { feeds: options.feeds ?? [feed()], spaces: [localSpace, remoteSpace], terms: [terminal()], agents: options.parked ? [] : [agent()],
    panes: options.parked ? [] : [{ pane: 'p1', terminal: 't1', tab: 'tb1', cwd: '/fixture' }], focus: { space: 's1', tab: 'tb1', pane: 'p1' }, closedReaders: 0, ipcReply: null, failSnapshot: false,
    closed: new Promise<void>(resolve => { closed = resolve; }) };
  const config = { version: 1, modId: 'spider-picker', feedRoot: '/fixture/feed', cliPath: '/fixture/cli.mjs', nodePath: '/fixture/node', labelContract: HerdrLabelContract, retention: { completedRows: 50, completedHours: 24 } };
  const inputState = { new() { const handlers: Record<string, Function> = {}; const input = { handlers, valueText: '', on(name: string, fn: Function) { handlers[name] = fn; }, value() { return this.valueText; }, focus() {} }; inputs.push(input); return input; } };
  const timer = { every(ms: number, fn: Function) { const handle = { ms, fn, cancel() { timers.delete(handle); } }; timers.add(handle); calls.push(['timer', ms]); return handle; }, after(ms: number, fn: Function) { return this.every(ms, fn); } };
  const cx: any = { timer, notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn(fn: Function) { const work: any = Promise.resolve().then(() => fn(cx)); work.cancel = () => {}; work.catch(() => {}); return work; } };
  const herdr: any = {
    props: () => options.config === 'invalid' ? { ...config, labelContract: { version: 1, labels: {}, kinds: {} }, overlay: 'overlay' }
      : options.config === 'props' || !options.config ? { ...config, overlay: 'overlay' } : { overlay: 'overlay' },
    checking: options.checking ? () => true : undefined,
    appHome: () => '/fixture/app', readTextFile: async (path: string) => { calls.push(['readTextFile', path]); return options.config === 'file' ? JSON.stringify(config) : null; },
    spaces: () => state.spaces, agents: () => state.agents, terminals: () => state.terms, panes: () => state.panes,
    machines: () => [{ name: null, layout: 'ready' }, { name: 'box-1.invalid', layout: 'ready' }], focused: () => state.focus,
    theme: () => ({ foreground: '#eeeeee', muted: '#aaaaaa', dim: '#888888', hover: '#ffffff12', working: '#aaaaaa', blocked: '#f2c063', done: '#aaaaaa', error: '#ff6b6b' }),
    settings: () => ({ zoom: 1 }), closeOverlay: (overlay: string) => { calls.push(['closeOverlay', overlay]); closed(); }, run: (name: string, args: unknown) => calls.push(['run', name, args]),
    hc: async (args: string[]) => { calls.push(['hc', args]); return { code: 0, stdout: JSON.stringify(args[0] === 'server' ? { core: { id: 'core' } } : { machines: [] }) }; },
    exec: async (command: string, args: string[]) => {
      calls.push(['exec', command, args]);
      if (args.includes('ipc')) return state.ipcReply ? await state.ipcReply() : { code: 0, stdout: JSON.stringify({ ok: true, op: 'openSession', terminal: 't1' }) };
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
    if (state.failSnapshot) throw new Error('offline');
    const entries = state.feeds.map((item: any) => ({ source: item.sessionId, stamp: item.generation, updatedAt: Date.now() }));
    return { ok: true, json: async () => ({ version: 1, entries, changes: state.feeds.map((item: any) => ({ source: item.sessionId, stamp: item.generation, feed: item })), errors: [] }) };
  };
  const api = { ...kit, ...base, svg: (path: string) => Object.assign(kit.svg(), { svgPath: path }), InputState: inputState, Input: { new: () => kit.div() }, herdr, fetch, pickerRows, selectPickerRow, projectNavigation, assignSpaceIdentities, FEED_REFRESH_MS, createFeedReader, panelIpcArgv, parseSessionIpcReply };
  const body = readFileSync(source, 'utf8').replace(/^import .*;\s*$/gm, '').replace(/export default class Picker/, 'class Picker').replace(/export class Picker/, 'class Picker').replace(/export default Picker;?/g, '');
  const Picker = new Function('api', `const { ${Object.keys(api).join(', ')} } = api; ${body}; return Picker;`)(api);
  const view = new Picker(); view.init({}, cx);
  return { view, cx, state, calls, inputs, timers, watches, config, herdr };
}

it('renders neutral shape rows and named sessions without an input border or shadow', async () => {
  const h = host(); await h.view.ready;
  const root = h.view.render();
  expect(root.styles.rounded?.[0]).toBe(12); expect(root.styles.bg?.[0]).toBe('#161618f0');
  expect(text(root)).toContain('Writer'); expect(text(root)).not.toContain('Pi · Pi · Pi');
  expect(flatten(root).some(node => Object.keys(node.styles ?? {}).some(key => key.startsWith('border') || key.startsWith('shadow')))).toBe(false);
  expect(flatten(root).some(node => node.svgPath === 'mods/spider-picker/space-triangle.svg')).toBe(true);
  const manifest = JSON.parse(readFileSync(resolve('packages/herdr/assets/picker/mod.json'), 'utf8'));
  expect(manifest.overlay.frame).toBe('none');
  await h.view.close();
});

it.each([['blocked', 'needs you', '#f2c063'], ['error', 'error', '#ff6b6b']])('styles %s status without coloring the machine pill', async (status, label, color) => {
  const value = feed(); value.status.effective = status;
  const h = host({ feeds: [value] }); await h.view.ready;
  h.state.agents.push({ ...agent('box-1.invalid/t2', 'remote-pane', 'Remote'), space: remoteSpace.id, tab: remoteSpace.tabs[0].id });
  h.state.terms.push(terminal('box-1.invalid/t2')); h.state.panes.push({ pane: 'remote-pane', terminal: 'box-1.invalid/t2', tab: remoteSpace.tabs[0].id, cwd: null });
  const nodes = flatten(h.view.render());
  expect(nodes.find(node => text(node).includes(label) && node.styles?.text_color?.[0] === color)).toBeDefined();
  expect(nodes.find(node => text(node).includes('box-1.invalid') && node.styles?.bg?.[0] === '#ffffff0d' && node.styles?.text_color?.[0] === '#a0a0a4')).toBeDefined();
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

it('indents child identities and uses the intended label and monospace fonts', async () => {
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

it('falls back to named native rows when the picker config is absent', async () => {
  const h = host({ config: 'missing' }); await h.view.ready;
  expect(h.view.rows().map((row: any) => row.label)).toContain('Pi · Pi · Pi');
  expect(h.calls.filter(call => call[0] === 'exec')).toEqual([]);
  await h.view.close();
});

it('disposes the feed reader and every folder watch when the overlay closes', async () => {
  const h = host(); await h.view.ready;
  expect(h.watches.size).toBe(1);
  await h.view.close();
  expect(h.state.closedReaders).toBe(1); expect(h.watches.size).toBe(0); expect(h.timers.size).toBe(0);
});

it('rejects malformed label contracts in props and keeps native rows', async () => {
  const h = host({ config: 'invalid' }); await h.view.ready;
  expect(h.view.rows().map((row: any) => row.label)).toContain('Pi · Pi · Pi');
  expect(h.calls.filter(call => call[0] === 'exec')).toEqual([]);
  expect(h.calls).toContainEqual(['readTextFile', '/fixture/app/mods/spider-picker/config.json']);
  await h.view.close();
});

it('keeps native rows visible while feed initialization is pending', async () => {
  const h = host();
  expect(text(h.view.render())).toContain('Pi · Pi · Pi');
  await h.view.ready; expect(text(h.view.render())).toContain('Writer');
  await h.view.close();
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

it('uses local creation commands after a remote focus and never passes machine to tab.new', async () => {
  const tab = host({ config: 'missing' }); await tab.view.ready;
  tab.state.spaces = [{ ...localSpace, active: false }, { ...remoteSpace, active: true }]; tab.state.focus = { space: remoteSpace.id, tab: remoteSpace.tabs[0].id, pane: 'remote-pane' };
  await tab.view.activate('new-tab');
  expect(tab.calls).toContainEqual(['run', 'tab.new', { space: 's1' }]);
  expect(tab.calls.find(call => call[0] === 'run' && call[1] === 'tab.new')[2]).not.toHaveProperty('machine');
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
