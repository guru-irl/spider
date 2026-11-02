// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import * as move from '../../assets/agents/move.js';
import { panelIpcArgv, parseSessionIpcReply, FEED_DISCONNECT_MS } from '../../assets/shared/feed.js';
import { HerdrLabelContract } from '../contracts.js';

type Node = { id?: string; disabled?: boolean; events: Record<string, Function>; items: unknown[] };
const data = new WeakMap<object, Node>();
function element(): any {
  const node: Node = { events: {}, items: [] };
  const proxy: any = new Proxy(node, { get(_target, key: string) {
    if (key === 'when') return (yes: boolean, fn: Function) => { if (yes) fn(proxy); return proxy; };
    if (key === 'child') return (value: unknown) => { node.items.push(value); return proxy; };
    if (key === 'children') return (values: unknown[]) => { node.items.push(...values); return proxy; };
    if (key === 'id') return (id: string) => { node.id = id; return proxy; };
    if (key === 'disabled') return (value: boolean) => { node.disabled = value; return proxy; };
    if (key.startsWith('on_')) return (...args: unknown[]) => { node.events[key] = args.at(-1) as Function; return proxy; };
    return () => proxy;
  }});
  data.set(proxy, node); return proxy;
}
function flatten(root: unknown): Node[] { const node = data.get(root as object); return node ? [node, ...node.items.flatMap(flatten)] : []; }
function texts(root: unknown): string[] { return flatten(root).flatMap(node => node.items.filter((item): item is string => typeof item === 'string')); }
function byId(root: unknown, id: string): Node { const result = flatten(root).find(node => node.id === id); if (!result) throw new Error(`Missing ${id}`); return result; }

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
