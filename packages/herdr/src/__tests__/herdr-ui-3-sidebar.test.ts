// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import shippedPatches from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import * as children from '../../assets/agents/children.js';
import { HerdrLabelContract } from '../contracts.js';
import { FEED_REFRESH_MS, middlePath } from '../../assets/shared/feed.js';

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

async function currentClones(): Promise<HerdrClones> {
  const root = process.env.SPIDER_HERDR_MOD_FIXTURE!;
  const result = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) {
    result[name] = { name: `spider-${name}`, clonedFrom: { name, version: '0.1.12' }, files: { 'main.js': await readFile(join(root, name, 'main.js'), 'utf8'), 'mod.json': await readFile(join(root, name, 'mod.json'), 'utf8') } };
  }
  return result;
}
function loadView(source: string, supplied: Record<string, unknown>): any {
  const ports = { FEED_REFRESH_MS, middlePath, ...children, View: class {}, ...ui, ...supplied };
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const name = /class (\w+) extends View/.exec(code)![1];
  return new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return ${name};`)(ports);
}
const palette = { chrome: '#101012', foreground: '#ececed', muted: '#b4b4b5', dim: '#969697', hover: '#262628', selected: '#29292a', raised: '#303031', input: '#242426', ansi1: '#ff5555', blocked: '#ffcb6b', working: '#ececed', idle: '#969697', done: '#969697', border: '#2f2f32' };
const configured = [{ name: 'alpha.invalid' }, { name: 'beta.invalid' }, { name: 'gamma.invalid' }, { name: 'delta.invalid' }];
const inventory = [{ name: 'alpha.invalid', state: 'connected' }, { name: 'beta.invalid', state: 'disconnected' }, { name: 'gamma.invalid', state: 'stopped' }];

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

  it.each([268, 76])('shows children despite a saved machine filter at width %s, without filter controls', async width => {
    const store = new Map<string, unknown>([['spider.agents.filters/spider-agents', { machine: 'alpha.invalid', agent: null }]]);
    const child = { address: 't2', parent: 't1', state: 'live', status: 'working', name: 'child', labels: {} };
    const { view } = await agentsView({ agents: () => [{ address: 't1', status: 'working', seq: 1 }], terminals: () => [child],
      layout: () => ({ id: 'sidebar', size: { px: width } }) }, store);
    const rendered = all(view.render({}));
    expect(view.tree([child], 't1').map((row: any) => row.t.key)).toContain('t2');
    expect(rendered.map(node => node.id)).toContain('ag-t1');
    if (width >= 160) expect(rendered.map(node => node.id)).toContain('sub-t2');
    expect(rendered.some(node => node.id?.startsWith('agents-filter-') || node.id === 'agents-clear-filters')).toBe(false);
  });

  it('uses the spider mark for pi agents and keeps other program icons', async () => {
    const mains = [
      { address: 't1', status: 'working', seq: 1, title: 'alpha', program: { key: 'pi', name: 'pi', icon: 'pi.svg', agent: true } },
      { address: 't2', status: 'working', seq: 2, title: 'beta', program: { key: 'node', name: 'node', icon: 'node.svg', tint: true, agent: true } },
    ];
    const { view } = await agentsView({ agents: () => mains });
    const nodes = all(view.render({}));
    expect(nodes.some(node => node.svg === 'mods/spider-tabs/spider.svg' && call(node, 'size')?.[0] === 16)).toBe(true);
    expect(nodes.some(node => node.svg === 'pi.svg')).toBe(false);
    expect(nodes.some(node => node.svg === 'node.svg' && call(node, 'size')?.[0] === 16)).toBe(true);
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
