// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import shippedPatches from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import * as children from '../../assets/agents/children.js';
import { HerdrLabelContract } from '../contracts.js';
import { FEED_REFRESH_MS, middlePath } from '../../assets/shared/feed.js';
import * as look from '../../assets/shared/look.js';

// A recording stand-in for gpui elements: every call is kept with its arguments.
interface Node { calls: [string, unknown[]][]; children: unknown[]; svg?: string; id?: string; click?: (...args: unknown[]) => unknown }
const data = new WeakMap<object, Node>();
function element(svgPath?: string): any {
  const node: Node = { calls: [], children: [], svg: svgPath };
  const proxy: any = new Proxy(node, { get(_o, key: string) {
    if (key === 'when') return (on: boolean, fn: (el: unknown) => unknown) => { if (on) fn(proxy); return proxy; };
    if (key === 'child') return (value: unknown) => { node.children.push(value); return proxy; };
    if (key === 'children') return (values: unknown[]) => { node.children.push(...values); return proxy; };
    if (key === 'hover') return () => proxy;
    return (...args: unknown[]) => { node.calls.push([key, args]); if (key === 'id') node.id = args[0] as string; if (key === 'on_click') node.click = args[0] as Node['click']; return proxy; };
  } });
  data.set(proxy, node); return proxy;
}
const ui = { div: () => element(), h_flex: () => element(), v_flex: () => element(), image: () => element(), svg: (path: string) => element(path), Scrollbar: { vertical: () => element() } };
function all(root: unknown): Node[] {
  const node = data.get(root as object); if (!node) return [];
  return [node, ...node.children.flatMap(all)];
}
const call = (node: Node, name: string) => node.calls.find(([key]) => key === name)?.[1];
const texts = (root: unknown): string[] => all(root).flatMap(node => node.children.filter((c): c is string => typeof c === 'string'));

async function currentClones(): Promise<HerdrClones> {
  const root = process.env.SPIDER_HERDR_MOD_FIXTURE!;
  const result = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) {
    result[name] = { name: `spider-${name}`, clonedFrom: { name, version: '0.1.12' }, files: { 'main.js': await readFile(join(root, name, 'main.js'), 'utf8'), 'mod.json': await readFile(join(root, name, 'mod.json'), 'utf8') } };
  }
  return result;
}
function loadView(source: string, supplied: Record<string, unknown>): any {
  const ports = { FEED_REFRESH_MS, middlePath, ...look, ...children, View: class {}, ...ui, ...supplied };
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const name = /class (\w+) extends View/.exec(code)![1];
  return new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return ${name};`)(ports);
}
const palette = { chrome: '#101012', foreground: '#ececed', muted: '#b4b4b5', dim: '#969697', hover: '#262628', selected: '#29292a', raised: '#303031', input: '#242426', ansi1: '#ff5555', blocked: '#ffcb6b', working: '#ececed', idle: '#969697', done: '#969697', border: '#2f2f32' };
const configured = [{ name: 'alpha.invalid' }, { name: 'beta.invalid' }, { name: 'gamma.invalid' }, { name: 'delta.invalid' }];
const inventory = [{ name: 'alpha.invalid', state: 'connected' }, { name: 'beta.invalid', state: 'disconnected' }, { name: 'gamma.invalid', state: 'stopped' }];

describe('space identity assignment', () => {
  it.each([1, 6, 7, 37])('assigns stable space shapes for %s spaces', count => {
    const assign = (look as unknown as { assignSpaceIdentities?: (spaces: { id: string; name: string }[]) => Map<string, { shape: string }> }).assignSpaceIdentities;
    expect(typeof assign).toBe('function');
    if (!assign) return;
    const spaces = Array.from({ length: count }, (_, n) => ({ id: `id-${n}`, name: `space-${String(n).padStart(2, '0')}` }));
    const assigned = assign(spaces);
    expect([...assigned.entries()].sort()).toEqual([...assign([...spaces].reverse()).entries()].sort());
    const values = spaces.map(space => assigned.get(space.id)!);
    expect(values.every(value => Object.keys(value).join() === 'shape')).toBe(true);
    expect(new Set(values.map(value => value.shape)).size).toBe(Math.min(count, 6));
    expect(values[0]).toEqual({ shape: 'triangle' });
  });

  it('probes the next free slot in name order for collisions', () => {
    const assign = (look as unknown as { assignSpaceIdentities?: (spaces: { id: string; name: string }[]) => Map<string, { shape: string }> }).assignSpaceIdentities;
    expect(typeof assign).toBe('function');
    if (!assign) return;
    const values = assign([{ id: 'later', name: 'space-06' }, { id: 'first', name: 'space-00' }]);
    expect(values.get('first')).toEqual({ shape: 'triangle' });
    expect(values.get('later')).toEqual({ shape: 'diamond' });
  });

  it('ships every space shape as a currentColor outline', async () => {
    for (const shape of ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'star']) {
      const svg = await readFile(resolve(`packages/herdr/assets/agents/space-${shape}.svg`), 'utf8');
      expect(svg).toMatch(/<svg[^>]* fill="none"/);
      expect(svg).toMatch(/<svg[^>]* stroke="currentColor"/);
      expect(svg).not.toMatch(/fill="currentColor"/);
    }
  });
});

describe('thread geometry', () => {
  const draw = (lines: string[], height = 26, options = {}) => look.threadKeylines(ui.div, lines, height, options).flatMap(all);
  const number = (node: Node, name: string) => call(node, name)?.[0] as number;
  const elbow = (nodes: Node[]) => nodes.find(node => call(node, 'border_b'))!;

  it('extends a rounded elbow to the icon when there is no caret', () => {
    const nodes = draw(['└']), join = elbow(nodes);
    expect(number(join, 'left') + number(join, 'w')).toBe(43);
    expect(number(join, 'top') + number(join, 'h') - 0.5).toBe(13);
    expect(number(join, 'rounded_bl')).toBe(6);
    expect(number(join, 'border_l')).toBe(1);
    expect(number(join, 'border_b')).toBe(1);
    expect(nodes.some(node => call(node, 'bottom'))).toBe(false);
  });

  it('ends a caret connector at the same fixed slot at every depth', () => {
    for (const [lines, end] of [[['└'], 30], [['│', '└'], 56], [['│', '', '└'], 82]] as const) {
      const join = elbow(draw([...lines], 30, { first: 20 }));
      expect(number(join, 'left') + number(join, 'w')).toBe(end);
      expect(number(join, 'top') + number(join, 'h') - 0.5).toBe(15);
    }
  });

  it('continues earlier siblings past a nested subtree without extending the final stem', () => {
    const nodes = draw(['│', '└']);
    const stems = nodes.filter(node => call(node, 'bottom'));
    expect(stems.map(node => number(node, 'left') + 0.5)).toEqual([24]);
    expect(number(elbow(nodes), 'left') + 0.5).toBe(50);
    expect(number(elbow(nodes), 'left') + number(elbow(nodes), 'w')).toBe(69);
    expect(number(elbow(nodes), 'h')).toBe(13.5);
  });

  it('joins a folded row at its toggle edge and starts below a parent icon', () => {
    const join = elbow(draw(['└'], 24, { first: 5 }));
    expect(number(join, 'left') + number(join, 'w')).toBe(45);
    expect(number(join, 'h') - 0.5).toBe(12);
    const stem = draw(['│'], 30, { start: 22 }).find(node => call(node, 'border_l'))!;
    expect(number(stem, 'top')).toBe(22);
    expect(number(stem, 'bottom')).toBe(0);
  });
});

describe('machine consoles in the agent tree', () => {
  it('keeps consoles under their owner without adding duplicate top-level agents', () => {
    const console = { address: 'alpha.invalid/t2', parent: 't1', state: 'live' as const, status: 'working', labels: { 'spider.kind': 'remote-console', 'spider.machine': 'alpha.invalid' } };
    const rows = children.projectAgentChildren([console], [], 't1', HerdrLabelContract);
    expect(rows.map(row => row.key)).toEqual(['console:alpha.invalid/t2']);
    expect(children.filterTopLevelAgents([{ address: 't1' }, { address: console.address }], [console], HerdrLabelContract)).toEqual([{ address: 't1' }]);
  });
});

describe.skipIf(!process.env.SPIDER_HERDR_MOD_FIXTURE)('sidebar without machine controls (requires SPIDER_HERDR_MOD_FIXTURE; no app window)', () => {
  const props = { modId: 'spider-agents', labelContract: HerdrLabelContract, labelFont: 'Glass Label', machines: configured };
  async function agentsView(extra: Record<string, unknown> = {}, store = new Map<string, unknown>()) {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => [], terminals: () => [], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: (key: string) => store.get(key) ?? null, setShared: (key: string, value: unknown) => store.set(key, value), setAgentOrder: () => {}, openOverlay: () => {}, closeOverlay: () => {},
      props: () => props, window: () => ({}), layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} },
      hc: async () => ({ code: 0, stdout: JSON.stringify({ machines: inventory }), stderr: '' }), ...extra });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = []; view.listed = new Map(); view.spiderFeedsLoaded = true;
    view.spiderMachineInventory = inventory;
    return { view, store };
  }
  const section = (root: unknown) => all(root).find(node => node.id === 'spider-machines');
  async function spacesView(spaces: any[], remote: any[], layouts: any[], stored = new Map<string, string>(), run: (...args: any[]) => void = () => {}) {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const colors = { ...palette, ansi2: '#50fa7b', ansi4: '#82aaff', ansi5: '#c792ea', ansi6: '#8be9fd', ansi12: '#d6acff', ansi13: '#ff92df' };
    const Spaces = loadView(clones.spaces.files['main.js'], { machines: () => layouts, spaces: () => spaces, panes: () => [], theme: () => colors, props: () => props,
      shared: () => null, setShared: () => {}, run, localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
    const view = new Spaces(); view.machines = remote; view.reconnecting = {}; view.folded = new Set(JSON.parse(stored.get('machines.folded') ?? '[]'));
    view.shown = new Set(spaces.map(space => space.id)); view.git = {}; view.born = {}; view.pressed = null;
    return { view, colors, stored };
  }

  it('keeps machine headings free of add buttons', async () => {
    const { view, colors } = await spacesView([{ id: 's1', name: 'bundler', tabs: [] }], inventory.slice(0, 1), [{ name: 'alpha.invalid', layout: 'ready' }]);
    const nodes = view.grouped(colors, false).flatMap(all) as Node[];
    expect(nodes.some(node => node.id?.startsWith('machine-add-'))).toBe(false);
    expect(nodes.flatMap(node => node.children).filter(child => child === '+')).toEqual([]);
    expect(nodes.find(node => node.id === 'machine-local')).toBeDefined();
  });

  it('machine headings put a stateful fold caret before the icon', async () => {
    const sp = [{ id: 's1', name: 'one', tabs: [] }, { id: 's2', name: 'two', machine: 'alpha.invalid', tabs: [] }];
    const remote = [{ name: 'alpha.invalid', state: 'connected' }];
    const layouts = [{ name: 'alpha.invalid', layout: 'ready' }];
    const commands: unknown[][] = [];
    const { view, colors, stored } = await spacesView(sp, remote, layouts, new Map(), (...args) => commands.push(args));
    const heading = (instance: any): Node => instance.grouped(colors, false).flatMap(all).find((node: Node) => node.id === 'machine-local')!;
    let stopped = 0;
    const cx = { stop_propagation() { stopped++; }, notify() {} };
    for (const [icon, tooltip, folded] of [['down', 'Hide spaces', false], ['right', 'Show spaces', true]] as const) {
      const nodes = heading(view).children.flatMap(all);
      const caret = nodes.find(node => node.svg === `mods/workspace-chrome/chevron-${icon}.svg`)!;
      expect(caret).toBeDefined();
      expect(call(caret, 'size')).toEqual([11]);
      expect(nodes.some(node => call(node, 'tooltip')?.[0] === tooltip)).toBe(true);
      expect(nodes.indexOf(caret)).toBeLessThan(nodes.findIndex(node => node.svg === 'mods/workspace-chrome/monitor.svg'));
      const add = nodes.find(node => node.id === 'machine-add-local')!;
      expect(add).toBeUndefined();
      expect(nodes.some(node => call(node, 'size')?.[0] === 6 && call(node, 'bg')?.[0] === colors.ansi2)).toBe(true);
      expect(view.folded.has(null)).toBe(folded);
      heading(view).click!({}, cx);
    }
    expect(commands).toEqual([]);
    expect(stopped).toBe(0);
    expect(JSON.parse(stored.get('machines.folded')!)).toEqual([]);
    heading(view).click!({}, cx);
    const restored = await spacesView(sp, remote, layouts, stored);
    expect(heading(restored.view).children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/chevron-right.svg')).toBe(true);
  });

  it('local-only spaces use the root icon column without a parent connector', async () => {
    const sp = [{ id: 's1', name: 'one', tabs: [] }, { id: 's2', name: 'two', tabs: [] }, { id: 's3', name: 'three', tabs: [] }];
    const { view, colors } = await spacesView(sp, [], []);
    const nodes = view.grouped(colors, false).flatMap(all) as Node[];
    for (const id of ['s1', 's2', 's3']) {
      const row = nodes.find(node => node.id === `space-${id}`)!;
      expect(row).toBeDefined();
      expect(call(row, 'pl')).toEqual([40]);
      expect(row.children.flatMap(all).find(node => node.svg?.includes('/space-'))?.calls).toContainEqual(['left', [17]]);
      expect(row.children.flatMap(all).some(node => call(node, 'border_l'))).toBe(false);
    }
  });

  it('narrow machine headings retain their fold carets', async () => {
    const sp = [{ id: 's1', name: 'one', tabs: [] }];
    const remote = [{ name: 'alpha.invalid', state: 'connected' }, { name: 'beta.invalid', state: 'connected' }];
    const { view, colors } = await spacesView(sp, remote, remote.map(machine => ({ name: machine.name, layout: 'ready' })));
    const nodes = () => view.grouped(colors, true).flatMap(all) as Node[];
    const caret = (id: string, direction: string) => nodes().find(node => node.id === id)!.children.flatMap(all).some(node => node.svg === `mods/workspace-chrome/chevron-${direction}.svg`);
    expect(caret('machine-local', 'down')).toBe(true);
    expect(caret('machine-empty-group', 'right')).toBe(true);
    nodes().find(node => node.id === 'machine-local')!.click!({}, { stop_propagation() {}, notify() {} });
    expect(caret('machine-local', 'right')).toBe(true);
  });

  it('shows machine space counts only when folded and opens from the pill', async () => {
    const sp = [{ id: 's1', name: 'one', tabs: [] }, { id: 's2', name: 'two', tabs: [] }, { id: 's3', name: 'three', machine: 'alpha.invalid', tabs: [] }];
    const { view, colors, stored } = await spacesView(sp, [{ name: 'alpha.invalid', state: 'connected' }], [{ name: 'alpha.invalid', layout: 'ready' }]);
    const nodes = () => view.grouped(colors, false).flatMap(all) as Node[];
    const cx = { stop_propagation() {}, notify() {} };
    expect(nodes().find(node => node.id === 'machine-count-local')).toBeUndefined();
    expect(nodes().find(node => node.id === 'machine-count-alpha.invalid')).toBeUndefined();
    nodes().find(node => node.id === 'machine-local')!.click!({}, cx);
    nodes().find(node => node.id === 'machine-alpha.invalid')!.click!({}, cx);
    const local = nodes().find(node => node.id === 'machine-count-local')!;
    expect(local.children).toContain('2');
    expect(local.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/layers.svg')).toBe(true);
    expect(nodes().find(node => node.id === 'machine-count-alpha.invalid')?.children).toContain('1');
    expect(nodes().find(node => node.id === 'space-s1')).toBeUndefined();
    local.click!({}, cx);
    expect(nodes().find(node => node.id === 'space-s1')).toBeDefined();
    expect(nodes().find(node => node.id === 'machine-count-local')).toBeUndefined();
    expect(JSON.parse(stored.get('machines.folded')!)).toEqual(['alpha.invalid']);
  });

  it('machine space count pills toggle rows and retain their status without add controls', async () => {
    const sp = [{ id: 's1', name: 'space-00', tabs: [] }, { id: 's2', name: 'space-06', machine: 'alpha.invalid', tabs: [] }];
    const { view, colors } = await spacesView(sp, [{ name: 'alpha.invalid', state: 'connected' }], [{ name: 'alpha.invalid', layout: 'ready' }]);
    const render = () => view.grouped(colors, false).flatMap(all) as Node[];
    const cx = { stop_propagation() {}, notify() {} };
    let nodes = render();
    nodes.find(node => node.id === 'machine-local')!.click!({}, cx);
    nodes.find(node => node.id === 'machine-alpha.invalid')!.click!({}, cx); nodes = render();
    const pill = nodes.find(node => node.id === 'machine-count-local');
    expect(pill).toBeDefined();
    expect(pill!.children).toContain('1');
    expect(pill!.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/layers.svg')).toBe(true);
    expect(call(pill!, 'rounded')).toEqual([999]);
    expect(nodes.find(node => node.id === 'machine-count-alpha.invalid')?.children).toContain('1');
    expect(nodes.find(node => node.id === 'machine-add-local')).toBeUndefined();
    expect(nodes.some(node => call(node, 'size')?.[0] === 6 && call(node, 'bg')?.[0] === colors.ansi2)).toBe(true);
    expect(nodes.find(node => node.id === 'space-s1')).toBeUndefined();
    nodes.find(node => node.id === 'machine-count-local')!.click!({}, cx); nodes = render();
    expect(nodes.find(node => node.id === 'space-s1')).toBeDefined();
    expect(view.folded.has(null)).toBe(false);
  });

  it('open machine threads connect the icon column to each space and end at the last row', async () => {
    const sp = [{ id: 's1', name: 'one', folder: '/project/main', tabs: [] }, { id: 's2', name: 'two', folder: '/project/linked', tabs: [] }, { id: 's3', name: 'three', machine: 'alpha.invalid', tabs: [] }];
    const commands: unknown[][] = [];
    const { view, colors } = await spacesView(sp, [{ name: 'alpha.invalid', state: 'connected' }], [{ name: 'alpha.invalid', layout: 'ready' }], new Map(), (...args) => commands.push(args));
    view.git = {
      [JSON.stringify([null, '/project/main'])]: { name: 'project', repo: 'repo', branch: 'main', linked: false },
      [JSON.stringify([null, '/project/linked'])]: { name: 'project', repo: 'repo', branch: 'topic', linked: true },
    };
    const nodes = () => view.grouped(colors, false).flatMap(all) as Node[];
    const subtree = (id: string) => nodes().find(node => node.id === id)!.children.flatMap(all);
    const lines = (id: string) => subtree(id).filter(node => call(node, 'border_l'));
    expect(lines('machine-local').length).toBeGreaterThan(0);
    expect(lines('space-s1').some(node => call(node, 'bottom')?.[0] === 0)).toBe(true);
    expect(lines('space-s1').some(node => call(node, 'border_b'))).toBe(true);
    expect(lines('space-s2').some(node => call(node, 'border_b'))).toBe(true);
    expect(lines('space-s2').some(node => call(node, 'bottom')?.[0] === 0)).toBe(false);
    expect(lines('space-s3').some(node => call(node, 'border_b'))).toBe(true);
    expect(lines('space-s3').some(node => call(node, 'bottom')?.[0] === 0)).toBe(false);
    const linked = nodes().find(node => node.id === 'space-s2')!;
    expect(call(linked, 'h')).toEqual([28]);
    expect(subtree('space-s2').some(node => node.svg === 'mods/workspace-chrome/branch.svg')).toBe(true);
    expect(subtree('space-s2').some(node => node.svg?.startsWith('mods/spider-agents/space-'))).toBe(true);
    const row = nodes().find(node => node.id === 'space-s1')!;
    (call(row, 'on_mouse_down')![1] as Function)();
    (call(row, 'on_mouse_up')![1] as Function)({}, { notify() {} });
    expect(commands).toEqual([['space.select', { id: 's1' }]]);
    nodes().find(node => node.id === 'machine-local')!.click!({}, { stop_propagation() {}, notify() {} });
    expect(lines('machine-local').length).toBe(0);
    expect(nodes().find(node => node.id === 'space-s1')).toBeUndefined();
  });

  it('threads expanded empty machine groups with the same icon and caret steps', async () => {
    const remote = inventory.slice(0, 2);
    const { view, colors } = await spacesView([{ id: 's1', name: 'bundler', tabs: [] }], remote, remote.map(machine => ({ name: machine.name, layout: 'ready' })));
    view.folded.add('\u0000spider-empty-machines-open');
    const nodes = view.grouped(colors, false).flatMap(all) as Node[];
    const row = (id: string) => nodes.find(node => node.id === id)!;
    const parts = (id: string) => row(id).children.flatMap(all);
    expect(call(row('machine-empty-group'), 'pl')).toEqual([17]);
    expect(call(row('machine-alpha.invalid'), 'pl')).toEqual([43]);
    expect(call(row('machine-beta.invalid'), 'pl')).toEqual([43]);
    expect(call(row('machine-fold-alpha.invalid'), 'left')).toEqual([30]);
    expect(call(row('machine-new-alpha.invalid'), 'pl')).toEqual([70]);
    expect(call(row('machine-new-alpha.invalid'), 'h')).toEqual([28]);
    const join = parts('machine-alpha.invalid').find(node => call(node, 'border_b'))!;
    expect((call(join, 'left')![0] as number) + (call(join, 'w')![0] as number)).toBe(30);
    const emptyJoin = parts('machine-new-alpha.invalid').find(node => call(node, 'border_b'))!;
    expect((call(emptyJoin, 'left')![0] as number) + (call(emptyJoin, 'w')![0] as number)).toBe(70);
    expect(parts('machine-new-alpha.invalid').some(node => call(node, 'left')?.[0] === 23.5 && call(node, 'bottom')?.[0] === 0)).toBe(true);
    expect(parts('machine-new-beta.invalid').some(node => call(node, 'left')?.[0] === 23.5 && call(node, 'bottom')?.[0] === 0)).toBe(false);
  });

  it('connects a loading child to its text without changing its row height', async () => {
    const { view, colors } = await spacesView([{ id: 's1', name: 'bundler', tabs: [] }], inventory.slice(0, 1), [{ name: 'alpha.invalid', layout: 'loading' }]);
    const nodes = view.grouped(colors, false).flatMap(all) as Node[];
    const loading = nodes.find(node => node.id === 'machine-loading-alpha.invalid')!;
    expect(call(loading, 'pl')).toEqual([66]);
    expect(call(loading, 'h')).toEqual([28]);
    expect(call(loading, 'items_center')).toEqual([]);
    expect(loading.children).toContain('Loading…');
    const join = loading.children.flatMap(all).find(node => call(node, 'border_b'))!;
    expect((call(join, 'left')![0] as number) + (call(join, 'w')![0] as number)).toBe(66);
    expect(loading.children.flatMap(all).some(node => call(node, 'bottom'))).toBe(false);
  });

  it('empty machine group has a left caret for its own persisted fold', async () => {
    const sp = [{ id: 's1', name: 'one', tabs: [] }];
    const remote = [{ name: 'alpha.invalid', state: 'connected' }, { name: 'beta.invalid', state: 'disconnected' }];
    const layouts = remote.map(machine => ({ name: machine.name, layout: 'ready' }));
    const { view, colors, stored } = await spacesView(sp, remote, layouts);
    const group = (instance: any): Node => instance.grouped(colors, false).flatMap(all).find((node: Node) => node.id === 'machine-empty-group')!;
    const cx = { stop_propagation() {}, notify() {} };
    for (const [icon, tooltip] of [['right', 'Show machines'], ['down', 'Hide machines']] as const) {
      const nodes = group(view).children.flatMap(all);
      const caret = nodes.find(node => node.svg === `mods/workspace-chrome/chevron-${icon}.svg`)!;
      expect(caret).toBeDefined();
      expect(call(caret, 'size')).toEqual([11]);
      expect(nodes.some(node => call(node, 'tooltip')?.[0] === tooltip)).toBe(true);
      expect(nodes.indexOf(caret)).toBeLessThan(nodes.findIndex(node => node.svg === 'mods/workspace-chrome/server.svg'));
      if (icon === 'down') {
        const restored = await spacesView(sp, remote, layouts, stored);
        expect(group(restored.view).children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/chevron-down.svg')).toBe(true);
      }
      group(view).click!({}, cx);
    }
  });

  it('groups known empty machines by default and persists expansion', async () => {
    const sp = [{ id: 'local', name: 'space-00', tabs: [] }, { id: 'remote', name: 'space-06', machine: 'gamma.invalid', tabs: [] }];
    const remote = [{ name: 'alpha.invalid', state: 'disconnected' }, { name: 'beta.invalid', state: 'connected' }, { name: 'gamma.invalid', state: 'connected' }, { name: 'delta.invalid', state: 'connected' }];
    const layouts = remote.map(machine => ({ name: machine.name, layout: machine.name === 'delta.invalid' ? 'loading' : 'ready' }));
    const { view, colors, stored } = await spacesView(sp, remote, layouts);
    const render = (instance: any) => instance.grouped(colors, false).flatMap(all) as Node[];
    let nodes = render(view);
    const group = nodes.find(node => node.id === 'machine-empty-group');
    expect(group).toBeDefined();
    expect(group!.children.flatMap(all).some(node => node.children.includes('2 machines'))).toBe(true);
    expect(group!.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/server.svg')).toBe(true);
    expect(nodes.find(node => node.id === 'machine-empty-group-count')?.children).toContain('2');
    expect(nodes.find(node => node.id === 'machine-alpha.invalid')).toBeUndefined();
    expect(nodes.find(node => node.id === 'machine-beta.invalid')).toBeUndefined();
    expect(nodes.find(node => node.id === 'machine-local')).toBeDefined();
    expect(nodes.find(node => node.id === 'machine-gamma.invalid')).toBeDefined();
    expect(nodes.find(node => node.id === 'machine-delta.invalid')).toBeDefined();
    group!.click!({}, { stop_propagation() {}, notify() {} }); nodes = render(view);
    expect(nodes.find(node => node.id === 'machine-alpha.invalid')).toBeDefined();
    expect(nodes.find(node => node.id === 'machine-beta.invalid')).toBeDefined();
    nodes.find(node => node.id === 'machine-beta.invalid')!.click!({}, { stop_propagation() {}, notify() {} }); nodes = render(view);
    expect(nodes.find(node => node.id === 'machine-count-beta.invalid')?.children).toContain('0');
    expect(nodes.find(node => node.id === 'machine-add-beta.invalid')).toBeUndefined();
    const restored = await spacesView(sp, remote, layouts, stored);
    expect(render(restored.view).find(node => node.id === 'machine-beta.invalid')).toBeDefined();
    render(restored.view).find(node => node.id === 'machine-empty-group-count')!.click!({}, { stop_propagation() {}, notify() {} });
    expect(render(restored.view).find(node => node.id === 'machine-beta.invalid')).toBeUndefined();
  });

  it.each([268, 76])('shows children despite a saved machine filter at width %s, without filter controls', async width => {
    const store = new Map<string, unknown>([['spider.agents.filters/spider-agents', { machine: 'alpha.invalid', agent: null }]]);
    const child = { address: 't2', parent: 't1', state: 'live', status: 'working', name: 'child', labels: {} };
    const { view } = await agentsView({ agents: () => [{ address: 't1', status: 'working', seq: 1 }], terminals: () => [child],
      layout: () => ({ id: 'sidebar', size: { px: width } }) }, store);
    const rendered = all(view.render({}));
    expect(view.tree([child], 't1').map((row: any) => row.t.key)).toContain('t2');
    if (width < 160) {
      expect(rendered.map(node => node.id)).not.toContain('ag-t1');
      expect(rendered.map(node => node.id)).not.toContain('sub-t2');
      expect(rendered.some(node => node.id?.startsWith('agents-filter-') || node.id === 'agents-clear-filters')).toBe(false);
      return;
    }
    expect(rendered.map(node => node.id)).toContain('ag-t1');
    if (width >= 160) expect(rendered.map(node => node.id)).toContain('sub-t2');
    expect(rendered.some(node => node.id?.startsWith('agents-filter-') || node.id === 'agents-clear-filters')).toBe(false);
  });

  const groupedFixtures = () => {
    const spaces = [{ id: 's1', name: 'bundler', tabs: [] }];
    const mains = [1, 2].map(n => ({ address: `t${n}`, pane: `p${n}`, space: 's1', space_name: 'bundler', status: 'idle', seq: n, title: `agent ${n}` }));
    const terminals = [
      { address: 't3', parent: 't1', state: 'live', status: 'idle', labels: { 'spider.kind': 'subagent-viewer', 'spider.run': 'run-one' } },
      { address: 't4', parent: 't1', state: 'live', status: 'idle', labels: {} },
      { address: 'alpha.invalid/c1', parent: 't1', state: 'live', status: 'idle', labels: { 'spider.kind': 'remote-console', 'spider.machine': 'alpha.invalid' } },
      ...['job-one', 'job-two'].map(id => ({ address: `alpha.invalid/${id}`, parent: 't1', state: 'live', status: id === 'job-one' ? 'blocked' : 'idle', labels: { 'spider.kind': 'exec', 'spider.job': id, 'spider.machine': 'alpha.invalid' } })),
    ];
    return { spaces, mains, terminals };
  };

  it('uses equal icon steps and identical caret slots across both sections and all child kinds', async () => {
    const { spaces, mains, terminals } = groupedFixtures();
    terminals.push({ address: 'nested', parent: 't3', state: 'live', status: 'idle', labels: {} });
    const { view } = await agentsView({ agents: () => mains, terminals: () => terminals, spaces: () => spaces }, new Map([['agents.sort', 'grouped']]));
    view.expandedConsoles = new Set(['console:alpha.invalid/c1']);
    const nodes = all(view.render({}));
    const at = (id: string) => nodes.find(node => node.id === id)!;
    const left = (id: string) => call(at(id), 'left')?.[0];
    expect(left('agent-pin-t1')).toBe(43);
    expect(left('thread-icon-run-one')).toBe(69);
    expect(left('thread-icon-nested')).toBe(95);
    expect(left('thread-icon-console:alpha.invalid/c1')).toBe(69);
    expect(left('thread-icon-job-one')).toBe(95);
    expect(left('fold-slot-t1')).toBe(30);
    expect(left('child-fold-run-one')).toBe(56);
    expect(left('console-fold-console:alpha.invalid/c1')).toBe(56);
    expect(call(at('ag-t1'), 'h')).toEqual([30]);
    expect(call(at('sub-job-one'), 'h')).toEqual([26]);
    for (const [rowId, firstId] of [
      ['ag-t1', 'fold-slot-t1'], ['ag-t2', 'agent-pin-t2'],
      ['sub-run-one', 'child-fold-run-one'], ['sub-t4', 'thread-icon-t4'],
      ['sub-console:alpha.invalid/c1', 'console-fold-console:alpha.invalid/c1'], ['sub-job-one', 'thread-icon-job-one'],
    ]) {
      const join = at(rowId).children.flatMap(all).find(node => call(node, 'border_b'))!;
      expect((call(join, 'left')![0] as number) + (call(join, 'w')![0] as number)).toBe(left(firstId));
    }
    const rootIcon = nodes.find(node => node.svg?.includes('/space-') && call(node, 'left'))!;
    expect(call(rootIcon, 'left')).toEqual([17]);
    const { view: spaceView, colors } = await spacesView([...spaces, { id: 's2', name: 'remote', tabs: [], machine: 'alpha.invalid' }], inventory.slice(0, 1), [{ name: 'alpha.invalid', layout: 'ready' }]);
    const spaceNodes = spaceView.grouped(colors, false).flatMap(all) as Node[];
    const machine = spaceNodes.find(node => node.id === 'machine-local')!;
    const space = spaceNodes.find(node => node.id === 'space-s1')!;
    expect(call(machine, 'pl')).toEqual([17]);
    expect(call(space, 'pl')).toEqual([66]);
    expect(space.children.flatMap(all).find(node => node.svg?.includes('/space-'))?.calls).toContainEqual(['left', [43]]);
    expect(spaceNodes.find(node => node.id === 'machine-fold-local')?.calls).toContainEqual(['left', [4]]);
  });

  it('folds a subagent subtree without moving its icon or its next sibling', async () => {
    const { spaces, mains, terminals } = groupedFixtures();
    terminals.push({ address: 'nested', parent: 't3', state: 'live', status: 'idle', labels: {} });
    const { view } = await agentsView({ agents: () => mains, terminals: () => terminals, spaces: () => spaces }, new Map([['agents.sort', 'grouped']]));
    const nodes = () => all(view.render({}));
    const caret = nodes().find(node => node.id === 'child-fold-run-one');
    expect(caret).toBeDefined();
    expect(nodes().some(node => node.id === 'sub-nested')).toBe(true);
    caret!.click!({}, { stop_propagation() {}, notify() {} });
    expect(nodes().some(node => node.id === 'sub-nested')).toBe(false);
    expect(nodes().find(node => node.id === 'thread-icon-run-one')?.calls).toContainEqual(['left', [69]]);
    expect(nodes().find(node => node.id === 'thread-icon-t4')?.calls).toContainEqual(['left', [69]]);
    nodes().find(node => node.id === 'child-fold-run-one')!.click!({}, { stop_propagation() {}, notify() {} });
    expect(nodes().some(node => node.id === 'sub-nested')).toBe(true);
  });

  it('connects the final live child through a finished toggle before ending the parent line', async () => {
    const { spaces, mains, terminals } = groupedFixtures();
    terminals.push({ address: 'done', parent: 't1', state: 'finished', status: 'done', finishedAt: Date.now() - 1000, labels: { 'spider.kind': 'subagent-viewer', 'spider.run': 'done' } } as any);
    const { view } = await agentsView({ agents: () => mains, terminals: () => terminals, spaces: () => spaces }, new Map([['agents.sort', 'grouped']]));
    const nodes = all(view.render({}));
    const subtree = (id: string) => nodes.find(node => node.id === id)!.children.flatMap(all);
    expect(subtree('sub-console:alpha.invalid/c1').some(node => call(node, 'left')?.[0] === 49.5 && call(node, 'bottom')?.[0] === 0)).toBe(true);
    const joins = subtree('finished-toggle-t1').filter(node => call(node, 'border_b'));
    expect(joins).toHaveLength(1);
    expect((call(joins[0], 'left')![0] as number) + (call(joins[0], 'w')![0] as number)).toBe(71);
    expect(subtree('finished-toggle-t1').some(node => call(node, 'left')?.[0] === 49.5 && call(node, 'bottom'))).toBe(false);
  });

  it('group headings put the fold caret on the left and omit open counts', async () => {
    const { spaces, mains, terminals } = groupedFixtures();
    const { view } = await agentsView({ agents: () => mains, terminals: () => terminals, spaces: () => spaces }, new Map([['agents.sort', 'grouped']]));
    const heading = () => all(view.render({})).find(node => node.id === 'sp-s1')!;
    const cx = { stop_propagation() {}, notify() {} };
    for (const [open, icon, tooltip] of [[true, 'down', 'Hide agents'], [false, 'right', 'Show agents']] as const) {
      const nodes = [heading(), ...heading().children.flatMap(all)];
      const carets = nodes.filter(node => node.svg?.includes('chevron-'));
      expect(carets.map(node => node.svg)).toEqual([`mods/workspace-chrome/chevron-${icon}.svg`]);
      expect(call(carets[0], 'size')).toEqual([11]);
      expect(nodes.find(node => call(node, 'tooltip')?.[0] === tooltip)).toBeDefined();
      expect(nodes.indexOf(carets[0])).toBeLessThan(nodes.findIndex(node => node.svg?.includes('/space-')));
      if (open) expect(nodes.some(node => node.id?.startsWith('group-count-'))).toBe(false);
      heading().click!({}, cx);
    }
    expect(view.folded.has('sp-s1')).toBe(false);
  });

  it('open heading connects its icon column to the first agent thread', async () => {
    const { spaces, mains, terminals } = groupedFixtures();
    const { view } = await agentsView({ agents: () => mains, terminals: () => terminals, spaces: () => spaces }, new Map([['agents.sort', 'grouped']]));
    const heading = all(view.render({})).find(node => node.id === 'sp-s1')!;
    const connector = heading.children.flatMap(all).find(node => call(node, 'top')?.[0] === 26)!;
    expect(connector).toBeDefined();
    expect(call(connector, 'border_l')).toEqual([1]);
    expect(call(connector, 'left')).toEqual([23.5]);
    view.folded.add('sp-s1');
    const folded = all(view.render({})).find(node => node.id === 'sp-s1')!;
    expect(folded.children.flatMap(all).some(node => call(node, 'border_l'))).toBe(false);
  });

  it('open group threads end at the last agent and continue around nested children', async () => {
    const { spaces, mains, terminals } = groupedFixtures();
    const { view } = await agentsView({ agents: () => mains, terminals: () => terminals, spaces: () => spaces }, new Map([['agents.sort', 'grouped']]));
    const nodes = all(view.render({}));
    const lines = (id: string) => {
      const row = nodes.find(node => node.id === id)!;
      return [row, ...row.children.flatMap(all)].filter(node => call(node, 'border_l') && call(node, 'left')?.[0] === 23.5);
    };
    expect(lines('ag-t1').some(node => call(node, 'bottom')?.[0] === 0)).toBe(true);
    expect(lines('ag-t1').some(node => call(node, 'border_b'))).toBe(true);
    expect(lines('ag-t2').some(node => call(node, 'border_b'))).toBe(true);
    expect(lines('ag-t2').some(node => call(node, 'bottom')?.[0] === 0)).toBe(false);
    expect(lines('sub-run-one').some(node => call(node, 'bottom')?.[0] === 0)).toBe(true);
    expect(lines('sub-run-one').some(node => call(node, 'border_b'))).toBe(false);
    expect(nodes.find(node => node.id === 'sub-run-one')!.children.flatMap(all).some(node => call(node, 'border_b') && call(node, 'left')?.[0] === 49.5)).toBe(true);
  });

  it('group thread continues through a finished-child toggle', async () => {
    const { spaces, mains, terminals } = groupedFixtures();
    terminals.push({ address: 't6', parent: 't1', state: 'finished', status: 'done', finishedAt: Date.now() - 1000, labels: { 'spider.kind': 'subagent-viewer', 'spider.run': 'finished' } } as any);
    const { view } = await agentsView({ agents: () => mains, terminals: () => terminals, spaces: () => spaces }, new Map([['agents.sort', 'grouped']]));
    const toggle = all(view.render({})).find(node => node.id === 'finished-toggle-t1')!;
    expect(toggle).toBeDefined();
    expect(toggle.children.flatMap(all).some(node => call(node, 'border_l') && call(node, 'bottom')?.[0] === 0)).toBe(true);
  });

  it('folded group counts match folded agent counts and pills open the group', async () => {
    const { spaces, mains, terminals } = groupedFixtures();
    const { view } = await agentsView({ agents: () => mains, terminals: () => terminals, spaces: () => spaces }, new Map([['agents.sort', 'grouped']]));
    view.folded.add('t1'); view.folded.add('sp-s1');
    const nodes = () => all(view.render({}));
    const pill = (kind: string) => nodes().find(node => node.id === `group-count-${kind}-sp-s1`);
    const expected = [['agents', '2', '2 agents', 'mods/spider-tabs/spider.svg'], ['subagents', '2', '2 subagents', 'mods/spider-agents/bot.svg'], ['consoles', '1', '1 console', 'mods/workspace-chrome/terminal.svg']];
    for (const [kind, count, tooltip, icon] of expected) {
      const p = pill(kind)!;
      expect(p).toBeDefined();
      expect(p.children).toContain(count);
      expect(call(p, 'tooltip')).toEqual([tooltip]);
      expect(call(p, 'rounded')).toEqual([999]);
      expect(call(p, 'bg')).toEqual([palette.hover]);
      expect(p.children.flatMap(all).some(node => node.svg === icon && call(node, 'size')?.[0] === 11)).toBe(true);
    }
    expect(call(pill('subagents')!, 'text_color')).toEqual([palette.blocked]);
    const heading = nodes().find(node => node.id === 'sp-s1')!;
    const ids = heading.children.flatMap(all).map(node => node.id);
    expect(ids.indexOf('group-count-agents-sp-s1')).toBeLessThan(ids.indexOf('group-count-subagents-sp-s1'));
    expect(ids.indexOf('group-count-subagents-sp-s1')).toBeLessThan(ids.indexOf('group-count-consoles-sp-s1'));
    const cx = { stop_propagation() {}, notify() {} };
    pill('consoles')!.click!({}, cx);
    expect(view.folded.has('sp-s1')).toBe(false);
    expect(nodes().find(node => node.id === 'fold-t1')?.children).toContain('2');
    expect(nodes().find(node => node.id === 'console-count-t1')?.children).toContain('1');
    terminals.splice(0, terminals.length); view.folded.add('sp-s1');
    expect(pill('subagents')).toBeUndefined();
    expect(pill('consoles')).toBeUndefined();
    expect(pill('agents')?.children).toContain('2');
  });

  it('folded headings spin for a working descendant even when the owner is idle', async () => {
    const { spaces, mains, terminals } = groupedFixtures();
    terminals.push({ address: 't5', parent: 't4', state: 'live', status: 'working', labels: { 'spider.kind': 'subagent-viewer', 'spider.run': 'run-two' } });
    const { view } = await agentsView({ agents: () => mains, terminals: () => terminals, spaces: () => spaces }, new Map([['agents.sort', 'grouped']]));
    view.folded.add('sp-s1');
    const heading = all(view.render({})).find(node => node.id === 'sp-s1')!;
    const nodes = heading.children.flatMap(all);
    expect(nodes.some(node => node.svg === 'mods/workspace-chrome/spinner.svg')).toBe(true);
    expect(nodes.findIndex(node => node.svg === 'mods/workspace-chrome/spinner.svg')).toBeGreaterThan(nodes.findIndex(node => node.id === 'group-count-consoles-sp-s1'));
  });

  it('pinned headings use the grouped caret and counts without a space shape', async () => {
    const { spaces, mains, terminals } = groupedFixtures();
    const pinned = [{ ...mains[0], pinned: true }];
    const { view } = await agentsView({ agents: () => pinned, terminals: () => terminals, spaces: () => spaces }, new Map([['agents.sort', 'grouped']]));
    const heading = () => all(view.render({})).find(node => node.id === 'pinned')!;
    let nodes = heading().children.flatMap(all);
    expect(nodes.some(node => node.svg === 'mods/workspace-chrome/chevron-down.svg')).toBe(true);
    expect(nodes.some(node => node.svg?.includes('/space-'))).toBe(false);
    expect(nodes.some(node => node.id?.startsWith('group-count-'))).toBe(false);
    const pinnedRow = all(view.render({})).find(node => node.id === 'ag-t1')!;
    expect(pinnedRow.children.flatMap(all).some(node => call(node, 'border_b'))).toBe(true);
    heading().click!({}, { stop_propagation() {}, notify() {} }); nodes = heading().children.flatMap(all);
    expect(nodes.some(node => node.svg === 'mods/workspace-chrome/chevron-right.svg')).toBe(true);
    expect(nodes.find(node => node.id === 'group-count-agents-pinned')?.children).toContain('1');
    expect(nodes.find(node => node.id === 'group-count-subagents-pinned')?.children).toContain('2');
    expect(nodes.find(node => node.id === 'group-count-consoles-pinned')?.children).toContain('1');
    expect(call(nodes.find(node => node.id === 'group-count-agents-pinned')!, 'tooltip')).toEqual(['1 agent']);
    expect(call(nodes.find(node => node.id === 'group-count-consoles-pinned')!, 'tooltip')).toEqual(['1 console']);
    terminals.splice(1, 1);
    nodes = heading().children.flatMap(all);
    expect(call(nodes.find(node => node.id === 'group-count-subagents-pinned')!, 'tooltip')).toEqual(['1 subagent']);
  });

  it('shows the same space shape in spaces and both agent views', async () => {
    const colors = { ...palette, ansi2: '#50fa7b', ansi4: '#82aaff', ansi5: '#c792ea', ansi6: '#8be9fd', ansi12: '#d6acff', ansi13: '#ff92df' };
    const spaces = [{ id: 's1', name: 'space-00', tabs: [{ id: 'tab', name: 'charlie', named: true }] }];
    const main = { address: 't1', pane: 'p1', tab: 'tab', space: 's1', space_name: 'space-00', status: 'working', seq: 1, title: 'charlie', program: { key: 'pi', name: 'pi', icon: 'pi.svg', agent: true } };
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Spaces = loadView(clones.spaces.files['main.js'], { spaces: () => spaces, panes: () => [], theme: () => colors, props: () => props, shared: () => null, setShared: () => {}, run: () => {} });
    const spaceView = new Spaces();
    const spaceRow = spaceView.row({ w: spaces[0], i: 0, g: null, tree: null }, colors);
    const nodes = (root: unknown): Node[] => data.has(root as object) ? all(root) : [root as Node, ...(root as Node).children.flatMap(all)];
    const mark = (root: unknown) => nodes(root).find(node => node.svg === 'mods/spider-agents/space-triangle.svg');
    expect(mark(spaceRow)).toBeDefined();
    expect(call(mark(spaceRow)!, 'text_color')).toEqual([colors.muted]);
    const store = new Map<string, unknown>();
    const { view } = await agentsView({ agents: () => [main], spaces: () => spaces, theme: () => colors }, store);
    let root = view.render({});
    let row = all(root).find(node => node.id === 'ag-t1')!;
    expect(mark(row)).toBeDefined();
    expect(call(mark(row)!, 'tooltip')).toEqual(['space-00']);
    expect(nodes(row).flatMap(node => node.children)).not.toContain('space-00');
    store.set('agents.sort', 'grouped'); root = view.render({});
    const heading = all(root).find(node => node.id === 'sp-s1')!;
    expect(mark(heading)).toBeDefined();
    expect(call(mark(heading)!, 'text_color')).toEqual([colors.muted]);
    store.set('agents.sort', 'priority'); root = view.render({});
    row = all(root).find(node => node.id === 'ag-t1')!;
    expect(call(mark(row)!, 'text_color')).toEqual([colors.muted]);
    expect(nodes(heading).flatMap(node => node.children)).toContain('space-00');
  });

  it('renders session names as plain monospace text without a pill in both sort views', async () => {
    const colors = { ...palette, ansi2: '#50fa7b', ansi4: '#82aaff', ansi5: '#c792ea', ansi6: '#8be9fd', ansi12: '#d6acff', ansi13: '#ff92df' };
    const main = { address: 't1', pane: 'p1', tab: 'tab', space: 's1', space_name: 'sample', status: 'working', seq: 1, title: 'charlie', program: { key: 'pi', name: 'pi', icon: 'pi.svg', agent: true } };
    const store = new Map<string, unknown>();
    const { view } = await agentsView({ agents: () => [main], spaces: () => [{ id: 's1', name: 'sample', tabs: [{ id: 'tab', name: 'charlie', named: true }] }], theme: () => colors }, store);
    for (const sort of ['priority', 'grouped']) {
      store.set('agents.sort', sort);
      const row = all(view.render({})).find(node => node.id === 'ag-t1')!;
      const name = [row, ...row.children.flatMap(all)].find(node => node.children.includes('charlie') || node.children.includes('· charlie'))!;
      expect(call(name, 'bg')).toBeUndefined();
      expect(call(name, 'rounded')).toBeUndefined();
      expect(call(name, 'text_color')).toEqual([colors.foreground]);
      expect(call(name, 'font_family')).toEqual(['JetBrains Mono']);
    }
  });

  it('counts a subagent and native child separately from a console and its commands', async () => {
    const terminals: any[] = [
      { address: 't2', parent: 't1', state: 'live', status: 'working', labels: { 'spider.kind': 'subagent-viewer', 'spider.run': 'run-one' } },
      { address: 't3', parent: 't1', state: 'live', status: 'working', labels: {} },
      { address: 'alpha.invalid/c1', parent: 't1', state: 'live', status: 'idle', labels: { 'spider.kind': 'remote-console', 'spider.machine': 'alpha.invalid' } },
      ...['job-one', 'job-two'].map(id => ({ address: `alpha.invalid/${id}`, parent: 't1', state: 'live', status: id === 'job-one' ? 'blocked' : 'working', labels: { 'spider.kind': 'exec', 'spider.job': id, 'spider.machine': 'alpha.invalid' } })),
    ];
    const { view } = await agentsView({ agents: () => [{ address: 't1', pane: 'p1', title: 'alpha', status: 'working', seq: 1 }], terminals: () => terminals });
    view.folded.add('t1');
    const pill = (id: string) => all(view.render({})).find(node => node.id === id);
    expect(pill('fold-t1')?.children).toContain('2');
    expect(call(pill('fold-t1')!, 'tooltip')).toEqual(['2 subagents']);
    expect(call(pill('fold-t1')!, 'text_color')).toEqual([palette.blocked]);
    expect(pill('console-count-t1')?.children).toContain('1');
    terminals.push({ address: 'beta.invalid/job-three', parent: 't1', state: 'live', status: 'working', labels: { 'spider.kind': 'exec', 'spider.job': 'job-three', 'spider.machine': 'beta.invalid' } });
    expect(pill('fold-t1')?.children).toContain('3');
    expect(pill('console-count-t1')?.children).toContain('1');
    terminals.splice(0, terminals.length, terminals[2]);
    expect(pill('fold-t1')).toBeUndefined();
    expect(pill('console-count-t1')?.children).toContain('1');
  });

  it('counts only live consoles including nested consoles on a collapsed owner', async () => {
    const mains = [{ address: 't1', status: 'working', seq: 1, title: 'alpha' }, { address: 't9', status: 'working', seq: 2, title: 'beta' }];
    const terminals = [
      { address: 't2', parent: 't1', state: 'live', status: 'working', labels: { 'spider.kind': 'subagent-viewer', 'spider.run': 'run-one' } },
      { address: 'alpha.invalid/c1', parent: 't1', state: 'live', status: 'idle', labels: { 'spider.kind': 'remote-console', 'spider.machine': 'alpha.invalid' } },
      { address: 'beta.invalid/c2', parent: 't2', state: 'live', status: 'idle', labels: { 'spider.kind': 'remote-console', 'spider.machine': 'beta.invalid', 'spider.run': 'run-one' } },
      { address: 'alpha.invalid/c3', parent: 't1', state: 'finished', status: 'done', exitCode: 0, reason: 'exited', finishedAt: Date.now() - 1000, labels: { 'spider.kind': 'remote-console', 'spider.machine': 'alpha.invalid' } },
    ];
    const { view } = await agentsView({ agents: () => mains, terminals: () => terminals });
    view.folded.add('t1'); view.folded.add('t9');
    let rendered = all(view.render({}));
    const pill = rendered.find(node => node.id === 'console-count-t1');
    expect(pill).toBeDefined();
    expect(pill!.children).toContain('2');
    expect(pill!.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/terminal.svg' && call(node, 'size')?.[0] === 11)).toBe(true);
    expect(call(pill!, 'rounded')).toEqual([999]);
    expect(rendered.find(node => node.id === 'console-count-t9')).toBeUndefined();
    pill!.click!({}, { stop_propagation() {}, notify() {} });
    expect(view.folded.has('t1')).toBe(false);
    rendered = all(view.render({}));
    expect(rendered.find(node => node.id === 'console-count-t1')).toBeUndefined();
  });

  it('uses the spider mark for pi agents and keeps other program icons', async () => {
    const mains = [
      { address: 't1', status: 'working', seq: 1, title: 'alpha', program: { key: 'pi', name: 'pi', icon: 'pi.svg', agent: true } },
      { address: 't2', status: 'working', seq: 2, title: 'beta', program: { key: 'node', name: 'node', icon: 'node.svg', tint: true, agent: true } },
    ];
    const { view } = await agentsView({ agents: () => mains });
    const nodes = all(view.render({}));
    const mark = nodes.find(node => node.svg === 'mods/spider-tabs/spider.svg');
    expect(mark).toBeDefined();
    expect(call(mark!, 'size')).toEqual([11]);
    const slot = nodes.find(node => node.children.some(child => data.get(child as object) === mark));
    expect(call(slot!, 'size')).toEqual([14]);
    expect(call(mark!, 'text_color')).toEqual([palette.muted]);
    expect(nodes.some(node => node.svg === 'pi.svg')).toBe(false);
    const other = nodes.find(node => node.svg === 'node.svg' && call(node, 'size')?.[0] === 14);
    expect(other).toBeDefined();
    expect(call(other!, 'text_color')).toEqual([palette.foreground]);
  });

  it('does not render a Machines section for configured machines', async () => {
    const { view } = await agentsView();
    const rendered = all(view.render({}));
    expect(rendered.map(node => node.id)).not.toContain('spider-machines');
    expect(rendered.some(node => node.id?.startsWith('machine-row-'))).toBe(false);
    expect(texts(view.render({}))).not.toContain('Machines');
  });

  it('does not poll machine inventory when the sidebar starts', async () => {
    const calls: string[][] = [], timers: number[] = [], tasks: Promise<unknown>[] = [];
    const { view } = await agentsView({ hc: async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: '{}', stderr: '' }; } });
    const cx = { spawn: (f: (cx: unknown) => Promise<unknown>) => { const task = f(cx); tasks.push(task); return task; }, notify: () => {}, timer: { every: (ms: number) => { timers.push(ms); } } };
    view.init({}, cx); await Promise.all(tasks);
    expect(calls).toEqual([]);
    expect(timers).not.toContain(15000);
  });

  it('keeps the Agents header and omits machine rows and their status controls', async () => {
    const { view } = await agentsView();
    const root = view.render({}), nodes = all(root);
    expect(texts(root)).toContain('Agents');
    expect(texts(root)).not.toContain('Machines');
    expect(nodes.some(node => node.svg === 'mods/workspace-chrome/server.svg')).toBe(false);
    expect(configured.map(machine => Boolean(nodes.find(node => node.id === `machine-row-${machine.name}`)))).toEqual([false, false, false, false]);
  });

  it('does not read or modify saved filters when a sidebar renders', async () => {
    const saved = { machine: 'beta.invalid', agent: null };
    const store = new Map<string, unknown>([['spider.agents.filters/spider-agents', saved]]);
    const { view } = await agentsView({}, store);
    const rendered = all(view.render({}));
    expect(store.get('spider.agents.filters/spider-agents')).toEqual(saved);
    expect(rendered.some(node => node.id === 'agents-filter-machine')).toBe(false);
    expect(rendered.some(node => node.id?.startsWith('machine-row-'))).toBe(false);
  });

  it('has no Clear control in either sidebar width even with a stored filter', async () => {
    const store = new Map<string, unknown>([['spider.agents.filters/spider-agents', { machine: 'alpha.invalid', agent: null }]]);
    for (const width of [268, 44]) {
      const { view } = await agentsView({ layout: () => ({ id: 'sidebar', size: { px: width } }) }, store);
      const nodes = all(view.render({}));
      expect(nodes.some(node => node.id === 'agents-filter-machine-clear' || node.id === 'agents-clear-filters')).toBe(false);
    }
  });

  it('no configured machines, no section; a narrow sidebar hides it', async () => {
    const { view } = await agentsView({ props: () => ({ ...props, machines: [] }) });
    expect(section(view.render({}))).toBeUndefined();
    const narrow = await agentsView({ layout: () => ({ id: 'sidebar', size: { px: 44 } }) });
    expect(section(narrow.view.render({}))).toBeUndefined();
  });

  it('retains the native group-by-space sort option', async () => {
    const store = new Map<string, unknown>(), closed: unknown[] = [];
    const { view } = await agentsView({ props: () => ({ ...props, sortMenu: true, overlay: 'sort-popup' }),
      closeOverlay: (id: unknown) => closed.push(id) }, store);
    const menu = all(view.render({}));
    expect(menu.some(node => node.children.includes('Grouped by space'))).toBe(true);
    menu.find(node => node.id === 'sort-grouped')!.click!();
    expect(store.get('agents.sort')).toBe('grouped');
    expect(closed).toEqual(['sort-popup']);
  });
});
