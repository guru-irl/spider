// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import shippedPatches from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import * as children from '../../assets/agents/children.js';
import { HerdrLabelContract } from '../contracts.js';
import { middlePath } from '../../assets/shared/feed.js';

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
const ui = { div: () => element(), h_flex: () => element(), v_flex: () => element(), image: () => element(), svg: (path: string) => element(path) };
function all(root: unknown): Node[] {
  const node = data.get(root as object); if (!node) return [];
  return [node, ...node.children.flatMap(all)];
}
const call = (node: Node, name: string) => node.calls.find(([key]) => key === name)?.[1];
const texts = (root: unknown): string[] => all(root).flatMap(node => node.children.filter((c): c is string => typeof c === 'string'));
// A found node and everything under it.
const below = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const words = (node: Node): string[] => below(node).flatMap(n => n.children.filter((c): c is string => typeof c === 'string'));

async function currentClones(): Promise<HerdrClones> {
  const root = process.env.SPIDER_HERDR_MOD_FIXTURE!;
  const result = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs'] as const) {
    result[name] = { name: `spider-${name}`, clonedFrom: { name, version: '0.1.11' }, files: { 'main.js': await readFile(join(root, name, 'main.js'), 'utf8'), 'mod.json': await readFile(join(root, name, 'mod.json'), 'utf8') } };
  }
  return result;
}
function loadView(source: string, supplied: Record<string, unknown>): any {
  const ports = { middlePath, ...children, View: class {}, ...ui, ...supplied };
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const name = /class (\w+) extends View/.exec(code)![1];
  return new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return ${name};`)(ports);
}
const palette = { chrome: '#101012', foreground: '#ececed', muted: '#b4b4b5', dim: '#969697', hover: '#262628', selected: '#29292a', raised: '#303031', input: '#242426', ansi1: '#ff5555', blocked: '#ffcb6b', working: '#ececed', idle: '#969697', done: '#969697', border: '#2f2f32' };
const configured = [{ name: 'alpha.invalid' }, { name: 'beta.invalid' }, { name: 'gamma.invalid' }, { name: 'delta.invalid' }];
const inventory = [{ name: 'alpha.invalid', state: 'connected' }, { name: 'beta.invalid', state: 'disconnected' }, { name: 'gamma.invalid', state: 'stopped' }];

describe('machine rows for the sidebar', () => {
  it('maps each configured machine to connected, disconnected or unavailable', () => {
    expect(children.projectMachineRows(configured, inventory)).toEqual([
      { name: 'alpha.invalid', status: 'connected' }, { name: 'beta.invalid', status: 'disconnected' },
      { name: 'gamma.invalid', status: 'unavailable' }, { name: 'delta.invalid', status: 'unavailable' },
    ]);
    // No connection list at all: nothing is known to be connected.
    expect(children.projectMachineRows([{ name: 'alpha.invalid' }], null)).toEqual([{ name: 'alpha.invalid', status: 'unavailable' }]);
    expect(children.projectMachineRows(undefined, inventory)).toEqual([]);
    expect(children.projectMachineRows([{ name: '' }, null, { name: 'alpha.invalid', temporary: true }, { name: 'alpha.invalid' }], [{ name: 'alpha.invalid', state: 'connecting' }]))
      .toEqual([{ name: 'alpha.invalid', status: 'unavailable' }]);
  });
});

describe.skipIf(!process.env.SPIDER_HERDR_MOD_FIXTURE)('global Machines section in the sidebar (requires SPIDER_HERDR_MOD_FIXTURE; no app window)', () => {
  const props = { modId: 'spider-agents', labelContract: HerdrLabelContract, labelFont: 'Glass Label', machines: configured };
  async function agentsView(extra: Record<string, unknown> = {}, store = new Map<string, unknown>()) {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => [], terminals: () => [], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: (key: string) => store.get(key) ?? null, setShared: (key: string, value: unknown) => store.set(key, value), setAgentOrder: () => {}, openOverlay: () => {}, closeOverlay: () => {},
      props: () => props, window: () => ({}), layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { getItem: () => null, setItem: () => {} },
      hc: async () => ({ code: 0, stdout: JSON.stringify({ machines: inventory }), stderr: '' }), ...extra });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pins = []; view.spiderFeeds = []; view.listed = new Map(); view.spiderFeedsLoaded = true;
    view.spiderMachineInventory = inventory;
    return { view, store };
  }
  const section = (root: unknown) => all(root).find(node => node.id === 'spider-machines');
  const row = (root: unknown, name: string) => all(root).find(node => node.id === `machine-row-${name}`)!;

  it('lists every configured machine under a Herdr-style header with a server icon, a monospace name and only its status', async () => {
    const { view } = await agentsView();
    const root = view.render({});
    const machines = section(root)!;
    // Herdr's divider and section header, like Agents.
    expect([call(machines, 'border_t'), call(machines, 'border_color')]).toEqual([[1], ['#2f2f32']]);
    const header = all(root).find(node => node.children.includes('Machines'))!;
    expect([call(header, 'text_size'), call(header, 'font_medium'), call(header, 'text_color'), call(header, 'font_family')]).toEqual([[11.5], [], [palette.dim], undefined]);
    expect(configured.map(m => Boolean(row(root, m.name)))).toEqual([true, true, true, true]);
    for (const m of configured) {
      const own = below(row(root, m.name));
      expect(own.filter(node => node.svg === 'mods/workspace-chrome/server.svg')).toHaveLength(1);
      expect(call(own.find(node => node.children.includes(m.name))!, 'font_family')).toEqual(['JetBrains Mono']);
      // Status only: no load, memory, lock, jobs or words.
      expect(words(row(root, m.name))).toEqual([m.name]);
    }
    // Disconnected: the only colour, a red glyph. Connected: no glyph. Stopped or unavailable: a dimmed row.
    const glyphs = (name: string) => below(row(root, name)).filter(node => node.svg && node.svg !== 'mods/workspace-chrome/server.svg');
    expect(glyphs('beta.invalid').map(node => [node.svg, call(node, 'text_color')])).toEqual([['mods/workspace-chrome/x.svg', [palette.ansi1]]]);
    expect(glyphs('alpha.invalid')).toEqual([]);
    expect(['alpha.invalid', 'beta.invalid', 'gamma.invalid', 'delta.invalid'].map(name => call(row(root, name), 'opacity')?.[0] ?? 1)).toEqual([1, 1, 0.5, 0.5]);
  });

  it('clicking a machine applies the agents list Machine filter, and clicking again clears it', async () => {
    const { view, store } = await agentsView();
    const filters = () => children.createAgentFilters('spider-agents', { read: key => store.get(key), write: (key, value) => store.set(key, value) }).get();
    row(view.render({}), 'beta.invalid').click!({}, { notify: () => {} });
    expect(filters()).toEqual({ machine: 'beta.invalid', agent: null });
    // The selected row is marked, the filter survives a render with no jobs there, and the chip names it.
    const filtered = view.render({});
    expect(filters()).toEqual({ machine: 'beta.invalid', agent: null });
    expect(call(row(filtered, 'beta.invalid'), 'bg')).toEqual([palette.selected]);
    expect(words(all(filtered).find(node => node.id === 'agents-filter-machine')!)).toContain('beta.invalid');
    row(filtered, 'beta.invalid').click!({}, { notify: () => {} });
    expect(filters()).toEqual({ machine: null, agent: null });
  });

  it('the Machine filter chip has an x that clears it', async () => {
    const { view, store } = await agentsView();
    store.set('spider.agents.filters/spider-agents', { machine: 'alpha.invalid', agent: null });
    const clear = all(view.render({})).find(node => node.id === 'agents-filter-machine-clear')!;
    expect(clear.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/x.svg')).toBe(true);
    clear.click!({}, { stop_propagation: () => {}, notify: () => {} });
    expect(store.get('spider.agents.filters/spider-agents')).toEqual({ machine: null, agent: null });
  });

  it('no configured machines, no section; a narrow sidebar hides it', async () => {
    const { view } = await agentsView({ props: () => ({ ...props, machines: [] }) });
    expect(section(view.render({}))).toBeUndefined();
    const narrow = await agentsView({ layout: () => ({ id: 'sidebar', size: { px: 44 } }) });
    expect(section(narrow.view.render({}))).toBeUndefined();
  });

  it('reads the connection list from Herdr when it starts', async () => {
    const calls: string[][] = [];
    const { view } = await agentsView({ hc: async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: JSON.stringify({ machines: [{ name: 'alpha.invalid', state: 'disconnected' }] }), stderr: '' }; } });
    view.spiderMachineInventory = undefined;
    const tasks: Promise<unknown>[] = [], timers: number[] = [];
    const cx = { spawn: (f: (cx: unknown) => Promise<unknown>) => { const p = f(cx); tasks.push(p); return p; }, notify: () => {}, timer: { every: (n: number) => { timers.push(n); return { cancel() {} }; } } };
    view.init({}, cx); await Promise.all(tasks);
    expect(calls).toContainEqual(['machine', 'ls', '--json']);
    expect(children.projectMachineRows(configured, view.spiderMachineInventory)[0]).toEqual({ name: 'alpha.invalid', status: 'disconnected' });
    expect(timers).toContain(15000);
  });
});
