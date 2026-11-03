// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import patches from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import { HerdrLabelContract } from '../contracts.js';
import { middlePath } from '../../assets/shared/feed.js';

type Element = { events: Record<string, Function>; children: unknown[] };
function element(): any {
  const node: Element = { events: {}, children: [] };
  const proxy: any = new Proxy(node, { get(target, key: string) {
    if (key === 'events') return target.events;
    if (key === 'when') return (yes: boolean, fn: Function) => { if (yes) fn(proxy); return proxy; };
    if (key === 'child') return (child: unknown) => { target.children.push(child); return proxy; };
    if (key === 'children') return (children: unknown[]) => { target.children.push(...children); return proxy; };
    if (key === 'on_mouse_down') return (button: string, fn: Function) => { target.events[button] = fn; return proxy; };
    return () => proxy;
  }});
  return proxy;
}
async function cloned() {
  const root = process.env.SPIDER_HERDR_MOD_FIXTURE!;
  const clones = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) clones[name] = { name: `spider-${name}`, clonedFrom: { name, version: '0.1.12' }, files: { 'main.js': await readFile(join(root, name, 'main.js'), 'utf8'), 'mod.json': await readFile(join(root, name, 'mod.json'), 'utf8') } };
  return applyLookPatches(clones, patches as LookPatchSet);
}
function view(source: string, supplied: Record<string, unknown>): any {
  const ports = { View: class {}, div: element, h_flex: element, v_flex: element, svg: element, image: element, middlePath, ...supplied };
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ');
  const name = /class (\w+) extends View/.exec(code)![1];
  return new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return ${name};`)(ports);
}
const colors = { foreground: '#eee', muted: '#aaa', dim: '#999', hover: '#222', input: '#333', raised: '#222', working: '#eee' };
const common = { modId: 'spider-agents', labelContract: HerdrLabelContract, feedRoot: '/fixture/feed', nodePath: 'node', cliPath: 'cli' };

it('opens a menu for the clicked subagent including saved views', async () => {
  const source = (await cloned()).agents.files['main.js'];
  const opened: any[] = [];
  const Agents = view(source, { props: () => common, openOverlay: (spec: unknown) => opened.push(spec), terminals: () => [], theme: () => colors, run() {} });
  const instance = new Agents(); instance.listed = new Map(); instance.expandedConsoles = new Set();
  const action = { kind: 'ipc', descriptor: { sessionId: 'owner', generation: 'gen' }, request: { op: 'openRun', runId: 'run', generation: 'gen' } };
  const row = instance.subRow(colors, { t: { kind: 'subagent', key: 'run', address: null, name: 'worker', status: 'done', retained: true, spider: true, action }, lines: [] }, null, false);
  expect(row.events.right).toBeTypeOf('function');
  row.events.right({}, { stop_propagation() {} });
  expect(opened[0]).toMatchObject({ mod: 'spider-agents', kind: 'popup', props: { moveMenu: { kind: 'subagent', key: 'run' } } });
  const live = instance.subRow(colors, { t: { kind: 'subagent', key: 'live', address: null, originalAddress: 'viewer', name: 'worker', status: 'working', retained: false, spider: true, action }, lines: [] }, null, false);
  live.events.right({}, { stop_propagation() {} });
  expect(opened[1]).toMatchObject({ props: { moveMenu: { key: 'live', terminal: 'viewer' } } });
});

it.each(['console', 'remote'])('opens a menu for the clicked %s row', async kind => {
  const source = (await cloned()).agents.files['main.js'], opened: any[] = [];
  const Agents = view(source, { props: () => common, openOverlay: (spec: unknown) => opened.push(spec), terminals: () => [], theme: () => colors, run() {} });
  const instance = new Agents(); instance.listed = new Map(); instance.expandedConsoles = new Set();
  const action = { kind: 'ipc', descriptor: { sessionId: 'owner', generation: 'gen' } };
  const row = instance.subRow(colors, { t: { kind, key: 'key', address: 'alpha.invalid/item', originalAddress: 'alpha.invalid/item', name: 'item', status: 'working', action }, lines: [] }, null, false);
  expect(row.events.right).toBeTypeOf('function');
  let stopped = 0;
  row.events.right({}, { stop_propagation() { stopped++; } });
  expect(stopped).toBe(1);
  expect(opened).toMatchObject([{ mod: 'spider-agents', kind: 'popup', props: { moveMenu: { kind, key: 'key', terminal: 'alpha.invalid/item' } } }]);
});

it('does not attach a child menu to native rows', async () => {
  const source = (await cloned()).agents.files['main.js'];
  const Agents = view(source, { props: () => common, terminals: () => [], theme: () => colors, run() {} });
  const instance = new Agents(); instance.listed = new Map(); instance.expandedConsoles = new Set();
  const row = instance.subRow(colors, { t: { kind: 'native', key: 'native', address: 'native', name: 'native', status: 'working' }, lines: [] }, null, false);
  expect(row.events.right).toBeUndefined();
});

it('renders the separate menu for move popup props without starting sidebar watchers', async () => {
  const source = (await cloned()).agents.files['main.js'];
  let initialized = 0, timers = 0;
  const sentinel = {};
  const Agents = view(source, { props: () => ({ ...common, feedRoot: null, moveMenu: { kind: 'subagent', key: 'run' } }),
    initMoveMenu: () => { initialized++; }, renderMoveMenu: () => sentinel,
    localStorage: { getItem: () => null }, theme: () => colors });
  const instance = new Agents(), cx = { timer: { every() { timers++; } } };
  instance.init({}, cx);
  expect(initialized).toBe(1); expect(timers).toBe(0);
  expect(instance.render(cx)).toBe(sentinel);
});

it('opens a menu for the clicked terminal header but not a mod pane', async () => {
  const source = (await cloned()).pane.files['main.js'];
  let pane: any = { pane: 'p1', terminal: 't1', title: 'Terminal', program: null, cwd: null, status: null, zoomed: false };
  const opened: any[] = [];
  const Pane = view(source, { props: () => ({ ...common, modId: 'spider-pane', pane: pane.pane }), panes: () => [pane], terminals: () => [], theme: () => colors, home: () => '/home', run() {}, openOverlay: (spec: unknown) => opened.push(spec) });
  const instance = new Pane(); instance.init();
  const header = instance.render({});
  expect(header.events.right).toBeTypeOf('function');
  header.events.right({}, { stop_propagation() {} });
  expect(opened[0]).toMatchObject({ mod: 'spider-agents', kind: 'popup', props: { moveMenu: { kind: 'pane', pane: 'p1', terminal: 't1' } } });
  pane = { ...pane, terminal: null, mod: 'board' };
  expect(instance.render({}).events.right).toBeUndefined();
});
