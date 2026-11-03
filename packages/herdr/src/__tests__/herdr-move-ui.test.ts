// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import * as move from '../../assets/agents/move.js';
import { panelIpcArgv, parseSessionIpcReply, FEED_DISCONNECT_MS } from '../../assets/shared/feed.js';
import { HerdrLabelContract } from '../contracts.js';

type Node = { id?: string; height?: number; marginY?: number; paddingTop?: number; paddingBottom?: number; flexNone?: boolean; mode?: string; textSize?: number; disabled?: boolean; events: Record<string, Function>; items: unknown[] };
const data = new WeakMap<object, Node>();
function element(): any {
  const node: Node = { events: {}, items: [] };
  const proxy: any = new Proxy(node, { get(_target, key: string) {
    if (key === 'when') return (yes: boolean, fn: Function) => { if (yes) fn(proxy); return proxy; };
    if (key === 'child') return (value: unknown) => { node.items.push(value); return proxy; };
    if (key === 'children') return (values: unknown[]) => { node.items.push(...values); return proxy; };
    if (key === 'id') return (id: string) => { node.id = id; return proxy; };
    if (key === 'h') return (height: number) => { node.height = height; return proxy; };
    if (key === 'my') return (marginY: number) => { node.marginY = marginY; return proxy; };
    if (key === 'pt') return (paddingTop: number) => { node.paddingTop = paddingTop; return proxy; };
    if (key === 'pb') return (paddingBottom: number) => { node.paddingBottom = paddingBottom; return proxy; };
    if (key === 'flex_none') return () => { node.flexNone = true; return proxy; };
    if (key === 'mode') return (mode: string) => { node.mode = mode; return proxy; };
    if (key === 'text_size') return (textSize: number) => { node.textSize = textSize; return proxy; };
    if (key === 'disabled') return (value: boolean) => { node.disabled = value; return proxy; };
    if (key.startsWith('on_')) return (...args: unknown[]) => { node.events[key] = args.at(-1) as Function; return proxy; };
    return () => proxy;
  }});
  data.set(proxy, node); return proxy;
}
function flatten(root: unknown): Node[] { const node = data.get(root as object); return node ? [node, ...node.items.flatMap(flatten)] : []; }
function texts(root: unknown): string[] { return flatten(root).flatMap(node => node.items.filter((item): item is string => typeof item === 'string')); }
function byId(root: unknown, id: string): Node { const result = flatten(root).find(node => node.id === id); if (!result) throw new Error(`Missing ${id}`); return result; }
function listChildren(list: Node): Node[] { return list.items.map(item => data.get(item as object)!); }
function totalHeight(list: Node): number { return listChildren(list).reduce((sum, child) => sum + (child.height ?? 0) + 2 * (child.marginY ?? 0), 0); }

async function popup(propsValue: any, extra: Record<string, unknown> = {}, feeds: any[] = []) {
  let source = '';
  try { source = await readFile(new URL('../../assets/agents/move-menu.js', import.meta.url), 'utf8'); } catch { /* The missing module is the behavior under test. */ }
  expect(source.length).toBeGreaterThan(0);
  const calls: any[] = [], closed: string[] = [], overlays: any[] = [], notifications: any[] = [], tasks: Promise<unknown>[] = [];
  const props = () => propsValue;
  const palette = { popover: '#161618', foreground: '#eeeeee', muted: '#aaaaaa', dim: '#999999', hover: '#262628', selected: '#29292a', border: '#38383a' };
  const api: Record<string, any> = { div: element, v_flex: element, h_flex: element, svg: element, ...move, panelIpcArgv, parseSessionIpcReply, FEED_DISCONNECT_MS,
    props, theme: () => palette, spaces: () => [{ id: 's1', name: 'Work', machine: null, tabs: [{ id: 't1', name: 'Current' }, { id: 't2', name: 'Review' }] }, { id: 's2', name: 'Other', machine: null, tabs: [{ id: 't3', name: 'Notes' }] }],
    panes: () => [], terminals: () => [], focused: () => ({ space: 's1', tab: 't1' }),
    run: (name: string, args: unknown) => calls.push({ name, args }), closeOverlay: (id: string) => closed.push(id), openOverlay: (value: unknown) => overlays.push(value), notify: (value: unknown) => notifications.push(value),
    exec: async (binary: string, args: string[]) => { calls.push({ binary, args }); const request = JSON.parse(args[args.indexOf('--request') + 1]); return { code: 0, stdout: JSON.stringify({ ok: true, op: request.op, ...(request.op === 'killJob' ? { jobId: request.jobId } : {}), ...(request.op === 'moveRun' || request.op === 'moveJob' ? { viewer: 'viewer' } : {}) }), stderr: '' }; },
    hc: async () => ({ code: 0, stdout: '', stderr: '' }), ...extra };
  const code = source.replace(/^import .*;\s*$/gm, '').replaceAll('export function ', 'function ').replaceAll('export async function ', 'async function ');
  const exported = new Function('api', `const { ${Object.keys(api).join(', ')} } = api; ${code}; return { initMoveMenu, renderMoveMenu };`)(api);
  const cx: any = { focus_handle: () => ({ focus() {} }), notify() {}, spawn(fn: Function) { const result = Promise.resolve(fn(cx)); tasks.push(result); return result; }, sleep: async () => {} };
  const instance: any = { spiderFeeds: [], reloadSpiderFeeds: async function () { this.spiderFeeds = feeds; } };
  exported.initMoveMenu(instance, cx);
  const drain = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  return { ...exported, instance, cx, calls, closed, overlays, notifications, drain };
}

async function heightPopup(extra: Record<string, unknown> = {}) {
  const pane = { pane: 'p1', terminal: 'shell', tab: 't1', program: { key: 'shell' } };
  const ui = await popup({ modId: 'spider-agents', labelContract: HerdrLabelContract,
    moveMenu: { kind: 'pane', pane: 'p1', terminal: 'shell' } },
    { panes: () => [pane], terminals: () => [{ address: 'shell', labels: {} }], ...extra });
  await ui.drain(); return ui;
}

it('gives the main menu enough height for its actions and separator', async () => {
  const ui = await heightPopup(), root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Move to tab');
  const list = byId(root, 'move-menu-items');
  expect(list.height).toBe(102);
  expect(list.height).toBe(totalHeight(list));
  expect(list.flexNone).toBe(true);
  expect(listChildren(list).every(child => child.flexNone)).toBe(true);
  expect(list.mode).toBeUndefined();
});

it('sizes the tab list for its back action, headings, and tabs', async () => {
  const ui = await heightPopup();
  byId(ui.renderMoveMenu(ui.instance, ui.cx), 'move-tabs').events.on_click({}, ui.cx);
  const root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toEqual(expect.arrayContaining(['Work', 'Review', 'Other', 'Notes']));
  const list = byId(root, 'move-menu-items');
  expect(list.height).toBe(151);
  expect(listChildren(list).every(child => child.height !== undefined)).toBe(true);
  expect(list.height).toBe(totalHeight(list));
  expect(listChildren(list).every(child => child.flexNone)).toBe(true);
});

it('caps the height of a long tab list', async () => {
  const ui = await heightPopup({ spaces: () => [{ id: 's1', name: 'Work', machine: null,
    tabs: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: `Tab ${i}` })) }] });
  byId(ui.renderMoveMenu(ui.instance, ui.cx), 'move-tabs').events.on_click({}, ui.cx);
  const list = byId(ui.renderMoveMenu(ui.instance, ui.cx), 'move-menu-items');
  expect(list.height).toBe(380);
  expect(list.height).toBe(Math.min(380, totalHeight(list)));
  expect(totalHeight(list)).toBeGreaterThan(380);
  expect(list.mode).toBe('always');
  expect(list.flexNone).toBe(true);
  expect(listChildren(list).every(child => child.flexNone)).toBe(true);
});

it('uses the menu text size when the pane is unavailable', async () => {
  const ui = await popup({ modId: 'spider-agents', moveMenu: { kind: 'pane', pane: 'gone', terminal: 'shell' } });
  await ui.drain();
  const root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Pane unavailable');
  expect(flatten(root)[0].textSize).toBe(12.8);
});

async function remoteRowPopup(kind: 'console' | 'remote', placed: boolean, connected = true, withoutSpace = false) {
  const terminal = `alpha.invalid/${kind}`, key = kind === 'console' ? `console:${terminal}` : 'job';
  const feed = { sessionId: 'owner', generation: 'gen', lifecycle: 'live', updatedAt: Date.now(),
    ipc: { address: 'socket', capabilityFile: 'cap' }, owner: { terminal: { address: 'parent' } }, runs: { rows: [] } };
  const labels = { 'spider.kind': kind === 'console' ? 'remote-console' : 'exec', 'spider.session': 'owner',
    'spider.machine': 'alpha.invalid', ...(kind === 'remote' ? { 'spider.job': 'job' } : {}) };
  let pane: any = placed ? { pane: 'alpha.invalid/p1', terminal, tab: 'alpha.invalid/t1' } : null;
  const commands: any[] = [];
  const spaces: { id: string; name: string; machine: string | null; tabs: { id: string; name: string }[] }[] = [{ id: 's0', name: 'Local', machine: null, tabs: [{ id: 't0', name: 'Local tab' }] }];
  if (!withoutSpace) spaces.push({ id: 'alpha.invalid/s1', name: 'Remote', machine: 'alpha.invalid', tabs: [{ id: 'alpha.invalid/t1', name: 'Current' }, { id: 'alpha.invalid/t2', name: 'Target' }] });
  const ui = await popup({ modId: 'spider-agents', nodePath: 'node', cliPath: 'cli', appBinary: 'app', feedRoot: '/fixture/feed', overlay: 'overlay', labelContract: HerdrLabelContract,
    moveMenu: { kind, key, terminal, action: { kind: 'ipc', descriptor: { version: 1, sessionId: 'owner', generation: 'gen', ...feed.ipc } } } }, {
    spaces: () => spaces, panes: () => pane ? [pane] : [], terminals: () => [{ address: terminal, labels }], focused: () => ({ space: 's0', tab: 't0' }),
    run: (name: string, args: any) => { commands.push([name, args]); if (name === 'terminal.park') pane = null; },
    hc: async (args: string[]) => { commands.push(['hc', args]); const tab = args.find(arg => arg.startsWith('herdr.tab='))!.slice('herdr.tab='.length);
      const space = args.find(arg => arg.startsWith('herdr.space='))!.slice('herdr.space='.length);
      if (!spaces.some(value => value.id === `alpha.invalid/${space}`)) spaces.push({ id: `alpha.invalid/${space}`, name: 'Remote', machine: 'alpha.invalid', tabs: [{ id: `alpha.invalid/${tab}`, name: 'New' }] });
      pane = { pane: 'alpha.invalid/p2', terminal, tab: `alpha.invalid/${tab}` }; return { code: 0, stdout: '', stderr: '' }; },
    exec: async (binary: string, args: string[]) => {
      commands.push([binary, args]);
      if (binary === 'app') {
        spaces[1].tabs.push({ id: 'alpha.invalid/new', name: 'New' });
        return { code: 0, stdout: JSON.stringify({ space: 'alpha.invalid/s1', tab: 'alpha.invalid/new', pane: 'alpha.invalid/placeholder' }), stderr: '' };
      }
      const request = JSON.parse(args[args.indexOf('--request') + 1]);
      return { code: 0, stdout: JSON.stringify({ ok: true, op: request.op, jobId: request.jobId }), stderr: '' };
    },
  }, connected ? [feed] : []);
  await ui.drain();
  return { ...ui, terminal, commands, placement: () => pane };
}

it.each([
  ['console', true, 'Move to new tab', 'Move to tab', 'Kill terminal'],
  ['console', false, 'Open in new tab', 'Open in tab', 'Kill terminal'],
  ['remote', true, 'Move to new tab', 'Move to tab', 'Kill command'],
  ['remote', false, 'Open in new tab', 'Open in tab', 'Kill command'],
] as const)('shows the %s row menu with pane=%s', async (kind, placed, first, second, kill) => {
  const ui = await remoteRowPopup(kind, placed), root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toEqual([first, second, kill]);
  const children = listChildren(byId(root, 'move-menu-items'));
  expect(children.map(child => child.id ?? 'separator')).toEqual(['move-new', 'move-tabs', 'separator', 'move-kill']);
});

it.each([
  ['console', true, 'new'], ['console', false, 'new'], ['console', true, 'tab'], ['console', false, 'tab'],
  ['remote', true, 'new'], ['remote', false, 'new'], ['remote', true, 'tab'], ['remote', false, 'tab'],
] as const)('places the %s row with pane=%s in a %s tab', async (kind, placed, destination) => {
  const ui = await remoteRowPopup(kind, placed); let root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain(placed ? 'Move to new tab' : 'Open in new tab');
  if (destination === 'tab') {
    byId(root, 'move-tabs').events.on_click({}, ui.cx); root = ui.renderMoveMenu(ui.instance, ui.cx);
    expect(texts(root)).not.toContain('Local tab');
    byId(root, 'move-tab-alpha.invalid/t2').events.on_click({}, ui.cx);
  } else byId(root, 'move-new').events.on_click({}, ui.cx);
  await ui.drain();
  expect(ui.placement()).toMatchObject({ terminal: ui.terminal, tab: destination === 'new' ? 'alpha.invalid/new' : 'alpha.invalid/t2' });
  expect(ui.commands.filter((entry: any[]) => entry[0] === 'terminal.park')).toHaveLength(placed ? 1 : 0);
  expect(ui.commands.some((entry: any[]) => entry[0] === 'app' && entry[1].includes('alpha.invalid/s1'))).toBe(destination === 'new');
  expect(ui.commands.some((entry: any[]) => ['window.focus', 'window.activate', 'app.focus'].includes(entry[0]) || Array.isArray(entry[1]) && entry[1].some((arg: string) => arg === 'pi' || arg.endsWith('/pi')))).toBe(false);
  expect(ui.closed).toEqual(['overlay']); expect(ui.notifications).toEqual([]);
});

it.each(['console', 'remote'] as const)('opens a parked %s in a new tab when its machine has no space', async kind => {
  const ui = await remoteRowPopup(kind, false, true, true), root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Open in new tab');
  byId(root, 'move-new').events.on_click({}, ui.cx); await ui.drain();
  expect(ui.placement()).toMatchObject({ terminal: ui.terminal, tab: expect.stringMatching(/^alpha\.invalid\//) });
  expect(ui.commands.filter((entry: any[]) => entry[0] === 'hc')).toHaveLength(1);
  expect(ui.commands.some((entry: any[]) => ['window.focus', 'window.activate', 'app.focus'].includes(entry[0]) || Array.isArray(entry[1]) && entry[1].some((arg: string) => arg === 'pi' || arg.endsWith('/pi')))).toBe(false);
  expect(ui.closed).toEqual(['overlay']); expect(ui.notifications).toEqual([]);
});

it.each([['console', true], ['console', false], ['remote', true], ['remote', false]] as const)('kills the %s row target with pane=%s', async (kind, placed) => {
  const ui = await remoteRowPopup(kind, placed), root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain(kind === 'console' ? 'Kill terminal' : 'Kill command');
  byId(root, 'move-kill').events.on_click({}, ui.cx); await ui.drain();
  if (kind === 'console') expect(ui.commands).toEqual([['terminal.kill', { terminal: ui.terminal }]]);
  else {
    const sent = ui.commands.find((entry: any[]) => entry[0] === 'node')!;
    expect(JSON.parse(sent[1][sent[1].indexOf('--request') + 1])).toEqual({ op: 'killJob', jobId: 'job', generation: 'gen' });
    expect(ui.commands.some((entry: any[]) => entry[0] === 'terminal.kill')).toBe(false);
  }
  expect(ui.closed).toEqual(['overlay']); expect(ui.notifications).toEqual([]);
});

it('disables command kill when the owner is unavailable', async () => {
  const ui = await remoteRowPopup('remote', false, false), root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Kill command');
  expect(byId(root, 'move-kill').disabled).toBe(true);
  expect(byId(root, 'move-kill').events.on_click).toBeUndefined();
});

it('uses the command row owner when no feed directory is configured', async () => {
  const terminal = 'alpha.invalid/job', descriptor = { version: 1, sessionId: 'owner', generation: 'gen', address: 'socket', capabilityFile: 'cap' };
  const ui = await popup({ modId: 'spider-agents', nodePath: 'node', cliPath: 'cli', overlay: 'overlay', labelContract: HerdrLabelContract,
    moveMenu: { kind: 'remote', key: 'job', terminal, action: { kind: 'ipc', descriptor } } },
    { terminals: () => [{ address: terminal, labels: { 'spider.kind': 'exec', 'spider.job': 'job', 'spider.session': 'owner' } }] });
  const root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(byId(root, 'move-kill').events.on_click).toBeTypeOf('function');
  byId(root, 'move-kill').events.on_click({}, ui.cx); await ui.drain();
  const sent = ui.calls.find((value: any) => value.binary === 'node');
  expect(JSON.parse(sent.args[sent.args.indexOf('--request') + 1])).toEqual({ op: 'killJob', jobId: 'job', generation: 'gen' });
  expect(ui.notifications).toEqual([]);
});

it('refuses a console row if the clicked pane is classified as a session', async () => {
  const terminal = 'alpha.invalid/item';
  const pane = { pane: 'alpha.invalid/p1', terminal, tab: 'alpha.invalid/t1', program: { key: 'pi' } };
  const ui = await popup({ modId: 'spider-agents', labelContract: HerdrLabelContract,
    moveMenu: { kind: 'console', key: `console:${terminal}`, terminal } },
    { panes: () => [pane], terminals: () => [{ address: terminal, labels: { 'spider.kind': 'remote-console' } }] });
  const root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toEqual(['Pane unavailable']);
});

it('does not reopen a pane-header terminal that disappears before the move', async () => {
  let pane: any = { pane: 'p1', terminal: 'shell', tab: 't1', program: { key: 'shell' } };
  const commands: any[] = [];
  const ui = await popup({ modId: 'spider-agents', overlay: 'overlay', labelContract: HerdrLabelContract,
    moveMenu: { kind: 'pane', pane: 'p1', terminal: 'shell' } }, {
    panes: () => pane ? [pane] : [], terminals: () => [{ address: 'shell', labels: {} }],
    hc: async (args: string[]) => { commands.push(args); pane = { pane: 'p2', terminal: 'shell', tab: 't2' }; return { code: 0, stdout: '', stderr: '' }; },
  });
  await ui.drain(); let root = ui.renderMoveMenu(ui.instance, ui.cx);
  byId(root, 'move-tabs').events.on_click({}, ui.cx); root = ui.renderMoveMenu(ui.instance, ui.cx);
  pane = null; byId(root, 'move-tab-t2').events.on_click({}, ui.cx); await ui.drain();
  expect(commands).toEqual([]);
  expect(ui.notifications).toMatchObject([{ title: 'Move failed', body: 'The terminal pane is unavailable' }]);
  expect(ui.closed).toEqual([]);
});

it('opens a parked subagent in a selected tab through its owner', async () => {
  const descriptor = { version: 1, sessionId: 'owner', generation: 'gen', address: 'socket', capabilityFile: 'cap' };
  const ui = await popup({ modId: 'spider-agents', nodePath: 'node', cliPath: 'cli', overlay: 'overlay', labelContract: HerdrLabelContract,
    moveMenu: { kind: 'subagent', key: 'run', terminal: null, retained: false, action: { kind: 'ipc', descriptor } } });
  let root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Open in new tab'); expect(texts(root)).toContain('Open in tab'); expect(texts(root)).toContain('Kill subagent');
  byId(root, 'move-tabs').events.on_click({}, ui.cx);
  root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Work'); expect(texts(root)).toContain('Review'); expect(texts(root)).toContain('Other');
  byId(root, 'move-tab-t2').events.on_click({}, ui.cx); await ui.drain();
  const sent = ui.calls.find((value: any) => value.binary === 'node');
  expect(JSON.parse(sent.args[sent.args.indexOf('--request') + 1])).toEqual({ op: 'moveRun', runId: 'run', destination: { kind: 'tab', tab: 't2' }, generation: 'gen' });
  expect(ui.closed).toEqual(['overlay']); expect(ui.notifications).toEqual([]);
});

it('refreshes the owning endpoint when the sidebar row only has a stale peek action', async () => {
  const feed = { sessionId: 'owner', generation: 'gen', lifecycle: 'live', updatedAt: Date.now(), ipc: { address: 'socket', capabilityFile: 'cap' }, owner: { terminal: { address: 'parent' } }, runs: { rows: [{ id: 'run', ownerSessionId: 'owner', status: 'running' }] } };
  const ui = await popup({ modId: 'spider-agents', nodePath: 'node', cliPath: 'cli', feedRoot: '/fixture/feed', overlay: 'overlay', labelContract: HerdrLabelContract,
    moveMenu: { kind: 'subagent', key: 'run', terminal: 'viewer', retained: false, action: { kind: 'peek', terminal: 'viewer' } } }, {}, [feed]);
  await ui.drain(); const root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(byId(root, 'move-new').events.on_click).toBeTypeOf('function');
  byId(root, 'move-new').events.on_click({}, ui.cx); await ui.drain();
  const sent = ui.calls.find((value: any) => value.binary === 'node');
  expect(JSON.parse(sent.args[sent.args.indexOf('--request') + 1])).toEqual({ op: 'moveRun', runId: 'run', destination: { kind: 'new' }, generation: 'gen' });
});

it('offers a saved view the same open actions without offering a live kill', async () => {
  const descriptor = { version: 1, sessionId: 'owner', generation: 'gen', address: 'socket', capabilityFile: 'cap' };
  const ui = await popup({ modId: 'spider-agents', nodePath: 'node', cliPath: 'cli', overlay: 'overlay', labelContract: HerdrLabelContract,
    moveMenu: { kind: 'subagent', key: 'finished', terminal: null, retained: true, action: { kind: 'ipc', descriptor } } });
  const root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Open in new tab'); expect(texts(root)).toContain('Open in tab');
  expect(byId(root, 'move-new').events.on_click).toBeTypeOf('function');
  expect(byId(root, 'move-kill').events.on_click).toBeUndefined();
});

it('sends a command pane kill to its owner instead of the observer', async () => {
  const feed = { sessionId: 'owner', generation: 'gen', lifecycle: 'live', updatedAt: Date.now(), ipc: { address: 'socket', capabilityFile: 'cap' }, owner: { terminal: { address: 'parent' } }, runs: { rows: [] } };
  const pane = { pane: 'p1', terminal: 'observer', tab: 't1', program: { key: 'shell' } };
  const ui = await popup({ modId: 'spider-agents', nodePath: 'node', cliPath: 'cli', overlay: 'overlay', labelContract: HerdrLabelContract, moveMenu: { kind: 'pane', pane: 'p1', terminal: 'observer' } },
    { panes: () => [pane], terminals: () => [{ address: 'observer', labels: { 'spider.kind': 'remote-observer', 'spider.session': 'owner', 'spider.job': 'job' } }] }, [feed]);
  await ui.drain(); const root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Kill command');
  byId(root, 'move-kill').events.on_click({}, ui.cx); await ui.drain();
  const sent = ui.calls.find((value: any) => value.binary === 'node');
  expect(JSON.parse(sent.args[sent.args.indexOf('--request') + 1])).toEqual({ op: 'killJob', jobId: 'job', generation: 'gen' });
  expect(ui.closed).toEqual(['overlay']);
});

it('labels unavailable owner actions instead of silently offering them', async () => {
  const ui = await popup({ modId: 'spider-agents', overlay: 'overlay', labelContract: HerdrLabelContract,
    moveMenu: { kind: 'subagent', key: 'run', terminal: null, retained: false, action: null } });
  const root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Owner unavailable');
  expect(byId(root, 'move-new').events.on_click).toBeUndefined(); expect(byId(root, 'move-new').disabled).toBe(true);
  expect(byId(root, 'move-kill').events.on_click).toBeUndefined(); expect(byId(root, 'move-kill').disabled).toBe(true);
});

async function sessionPopup(age = 0, connected = true) {
  const pane = { pane: 'p1', terminal: 'parent', tab: 't1', program: { key: 'pi' } };
  const feed = { sessionId: 'owner', generation: 'gen', lifecycle: 'live', updatedAt: Date.now() - age,
    owner: { terminal: { address: 'parent' } }, ipc: { address: 'socket', capabilityFile: 'cap' } };
  const ui = await popup({ modId: 'spider-agents', nodePath: 'node', cliPath: 'cli', overlay: 'overlay', labelContract: HerdrLabelContract, moveMenu: { kind: 'pane', pane: 'p1', terminal: 'parent' } },
    { panes: () => [pane], terminals: () => [{ address: 'parent', labels: {} }] }, connected ? [feed] : []);
  await ui.drain(); return ui;
}

it('asks before killing a session and sends only the confirmed owner stop request', async () => {
  const ui = await sessionPopup(); let root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Kill session…');
  byId(root, 'move-kill').events.on_click({}, ui.cx); await ui.drain();
  root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(texts(root)).toContain('Kill session?'); expect(texts(root).join(' ')).toContain('subagents');
  expect(ui.calls).toEqual([]); expect(ui.closed).toEqual([]);
  byId(root, 'move-kill-confirm').events.on_click({}, ui.cx); await ui.drain();
  const sent = ui.calls.find((value: any) => value.binary === 'node');
  expect(JSON.parse(sent.args[sent.args.indexOf('--request') + 1])).toEqual({ op: 'killSession', generation: 'gen' });
  expect(ui.calls.some((value: any) => value.name === 'terminal.kill')).toBe(false);
  expect(ui.closed).toEqual(['overlay']); expect(ui.notifications).toEqual([]);
});

it.each(['cancel', 'escape'])('leaves the session and its children alone on %s', async method => {
  const ui = await sessionPopup(); let root = ui.renderMoveMenu(ui.instance, ui.cx);
  byId(root, 'move-kill').events.on_click({}, ui.cx); await ui.drain(); root = ui.renderMoveMenu(ui.instance, ui.cx);
  if (method === 'cancel') byId(root, 'move-kill-cancel').events.on_click({}, ui.cx);
  else byId(root, 'move-kill-prompt').events.on_key_down({ key: 'escape' }, ui.cx);
  await ui.drain(); expect(ui.calls).toEqual([]); expect(ui.closed).toEqual(['overlay']);
});

it('does not offer an unsafe native kill when the session owner is unavailable', async () => {
  const ui = await sessionPopup(0, false), root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(byId(root, 'move-kill').disabled).toBe(true);
  expect(byId(root, 'move-kill').events.on_click).toBeUndefined(); expect(ui.calls).toEqual([]);
});

it('keeps owner actions available until the shared disconnect cutoff', async () => {
  const ui = await sessionPopup(FEED_DISCONNECT_MS - 3000), root = ui.renderMoveMenu(ui.instance, ui.cx);
  expect(byId(root, 'move-new').disabled).not.toBe(true); expect(byId(root, 'move-kill').disabled).not.toBe(true);
});

it('moves an unmanaged pi pane after confirming it is absent from the setup journal', async () => {
  let pane: any = { pane: 'p1', terminal: 'parent', tab: 't1', program: { key: 'pi' } };
  const commands: any[] = [];
  const ui = await popup({ modId: 'spider-agents', overlay: 'overlay', feedRoot: '/fixture/feed', labelContract: HerdrLabelContract, moveMenu: { kind: 'pane', pane: 'p1', terminal: 'parent' } }, {
    panes: () => pane ? [pane] : [], terminals: () => [{ address: 'parent', labels: {} }], readTextFile: async () => null,
    run: (name: string, args: any) => { commands.push([name, args]); if (name === 'terminal.park') pane = null; },
    hc: async (args: string[]) => { commands.push(['hc', args]); pane = { pane: 'p2', terminal: 'parent', tab: 't2', program: { key: 'pi' } }; return { code: 0, stdout: '', stderr: '' }; },
  });
  await ui.drain(); let root = ui.renderMoveMenu(ui.instance, ui.cx);
  byId(root, 'move-tabs').events.on_click({}, ui.cx); root = ui.renderMoveMenu(ui.instance, ui.cx);
  byId(root, 'move-tab-t2').events.on_click({}, ui.cx); await ui.drain();
  expect(pane.tab).toBe('t2');
  expect(commands).toEqual([
    ['terminal.park', { terminal: 'parent' }],
    ['hc', ['label', 'parent', 'herdr.space=s1', 'herdr.tab=t2', '--json']],
    ['pane.focus', { terminal: 'parent' }],
  ]);
  expect(ui.closed).toEqual(['overlay']); expect(ui.notifications).toEqual([]);
});
