// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import shippedPatches from '../../assets/look/patches.json' with { type: 'json' };
import theme from '../../assets/themes/spider-glass.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import { projectAgentChildren, filterTopLevelAgents, loadAgentFeeds, selectAgentChildren, agentFilterOptions, createAgentFilters, projectMachineRows } from '../../assets/agents/children.js';
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

async function currentClones(): Promise<HerdrClones> {
  const root = process.env.SPIDER_HERDR_MOD_FIXTURE!;
  const result = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs'] as const) {
    result[name] = { name: `spider-${name}`, clonedFrom: { name, version: '0.1.11' }, files: { 'main.js': await readFile(join(root, name, 'main.js'), 'utf8'), 'mod.json': await readFile(join(root, name, 'mod.json'), 'utf8') } };
  }
  return result;
}
function loadView(source: string, supplied: Record<string, unknown>): any {
  const ports = { middlePath, projectAgentChildren, filterTopLevelAgents, loadAgentFeeds, selectAgentChildren, agentFilterOptions, createAgentFilters, projectMachineRows, View: class {}, ...ui, ...supplied };
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const name = /class (\w+) extends View/.exec(code)![1];
  return new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return ${name};`)(ports);
}
const palette = { chrome: '#101012', foreground: '#ececed', muted: '#b4b4b5', dim: '#969697', hover: '#262628', selected: '#29292a', raised: '#303031', input: '#242426', ansi1: '#ff5555', blocked: '#ffcb6b', working: '#ececed', idle: '#969697', done: '#969697' };
const neutral = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return Math.max(r, g, b) - Math.min(r, g, b) <= 8; };

describe('Herdr UI theme accents', () => {
  it('keeps chrome accents neutral and status colours only for failure and needs-you', () => {
    for (const key of ['accent', 'working', 'done', 'idle', 'selected', 'hover']) expect([key, neutral((theme.colors as Record<string, string>)[key])]).toEqual([key, true]);
    expect(neutral(theme.colors.blocked)).toBe(false);
    // The terminal palette stays Dracula+.
    expect(theme.ansi[1]).toBe('#ff5555'); expect(theme.ansi[6]).toBe('#8be9fd');
  });
});

describe.skipIf(!process.env.SPIDER_HERDR_MOD_FIXTURE)('sidebar look on the current built-ins (requires SPIDER_HERDR_MOD_FIXTURE; no app window)', () => {
  const props = { modId: 'spider-agents', labelContract: HerdrLabelContract, labelFont: 'Glass Label' };

  it('section titles are Herdr\'s own, not the bold condensed label face', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => [], terminals: () => [], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: () => null, setShared: () => {}, setAgentOrder: () => {}, openOverlay: () => {}, closeOverlay: () => {}, props: () => props, window: () => ({}),
      layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { getItem: () => null, setItem: () => {} } });
    const agents = new Agents(); agents.folded = new Set(); agents.changed = {}; agents.pins = []; agents.spiderFeeds = []; agents.listed = new Map();
    const Spaces = loadView(clones.spaces.files['main.js'], { machines: () => [], spaces: () => [], panes: () => [], focused: () => null, theme: () => palette, shared: () => null, setShared: () => {},
      run: () => {}, props: () => props, window: () => ({}), layout: () => ({ id: 'sidebar', size: { px: 268 } }), openOverlay: () => {}, closeOverlay: () => {} });
    const spaces = new Spaces(); spaces.folded = new Set(); spaces.machines = []; spaces.shown = new Set();
    for (const [view, title] of [[agents.render({}), 'Agents'], [spaces.render(), 'Spaces']] as const) {
      const nodes = all(view);
      expect(texts(view)).toContain(title);
      expect(texts(view)).not.toContain(title.toUpperCase());
      expect(nodes.some(node => call(node, 'font_family'))).toBe(false);
    }
  });

  it('space badges are neutral grey and the selected space is inverted', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Spaces = loadView(clones.spaces.files['main.js'], { machines: () => [], spaces: () => [], panes: () => [], theme: () => palette, props: () => props,
      shared: (key: string) => key === 'space.colors' ? { a: 'ansi6', b: 'ansi5' } : null, setShared: () => {}, run: () => {} });
    const view = new Spaces();
    const badge = (active: boolean, id: string) => all(view.row({ w: { id, name: 'docs', active }, i: 0, g: null, tree: null }, palette)).find(node => node.children.includes('D'))!;
    const off = badge(false, 'a'), on = badge(true, 'b');
    expect(call(off, 'bg')).toEqual(['#2c2c2f']); expect(call(off, 'text_color')).toEqual(['#d9d9db']);
    expect(call(on, 'bg')).toEqual(['#e6e6e8']); expect(call(on, 'text_color')).toEqual(['#141416']);
  });

  it('child rows show a kind icon, thread keylines and state glyphs without coloured dots', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(clones.agents.files['main.js'], { props: () => props, terminals: () => [], run: () => {}, theme: () => palette });
    const view = new Agents(); view.listed = new Map(); view.expandedConsoles = new Set();
    const row = (kind: string, status: string, lines: string[], extra: Record<string, unknown> = {}) =>
      all(view.subRow(palette, { t: { key: `${kind}-key`, kind, status, address: 'x', name: `${kind} row`, spider: kind !== 'native', outcome: null, action: null, ...extra }, lines }, null, false));
    const icon = (nodes: Node[]) => nodes.find(node => node.svg && /\/(bot|server|list|terminal)\.svg$/.test(node.svg))?.svg;
    expect(icon(row('subagent', 'working', ['├']))).toBe('mods/spider-agents/bot.svg');
    expect(icon(row('remote', 'working', ['├']))).toBe('mods/workspace-chrome/server.svg');
    expect(icon(row('console', 'idle', ['└']))).toBe('mods/spider-agents/list.svg');
    expect(icon(row('native', 'idle', ['└'], { spider: false }))).toBe('mods/workspace-chrome/terminal.svg');

    // A continuing branch draws a full-height rail and an elbow; a passing rail has no elbow; the last child only an elbow.
    const rails = row('remote', 'working', ['│', '├', '└']).filter(node => call(node, 'border_color')?.[0] === '#3a3a3d');
    const elbows = rails.filter(node => call(node, 'rounded_bl'));
    const fullRails = rails.filter(node => !call(node, 'rounded_bl') && call(node, 'bottom'));
    expect(elbows).toHaveLength(2); expect(fullRails).toHaveLength(2);

    const done = row('subagent', 'done', ['└']);
    expect(done.find(node => node.svg === 'mods/workspace-chrome/check.svg')).toBeDefined();
    expect(done.some(node => call(node, 'rounded') && call(node, 'size')?.[0] === 7)).toBe(false);
    const check = done.find(node => node.svg === 'mods/workspace-chrome/check.svg')!;
    expect(call(check, 'text_color')).toEqual([palette.dim]);

    const failed = row('remote', 'error', ['└'], { outcome: 'exit 1' });
    const cross = failed.find(node => node.svg === 'mods/workspace-chrome/x.svg')!;
    expect(call(cross, 'text_color')).toEqual([palette.ansi1]);
    expect(texts(view.subRow(palette, { t: { key: 'k', kind: 'remote', status: 'error', address: 'x', name: 'build', spider: true, outcome: 'exit 1', action: null }, lines: ['└'] }, null, false))).toContain('exit 1');

    const working = row('subagent', 'working', ['└']).find(node => node.svg === 'mods/workspace-chrome/spinner.svg')!;
    expect(neutral((call(working, 'text_color') as string[])[0])).toBe(true);
  });

  it('keeps Herdr\'s hairline between Spaces and Agents', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => [], terminals: () => [], panes: () => [], focused: () => null, spaces: () => [], theme: () => ({ ...palette, border: '#00000000' }),
      shared: () => null, setShared: () => {}, setAgentOrder: () => {}, props: () => props, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pins = []; view.spiderFeeds = []; view.listed = new Map();
    const root = data.get(view.render({}))!;
    expect(call(root, 'border_t')).toEqual([1]); expect(call(root, 'border_color')).toEqual(['#2f2f32']);
  });

  it('one priority list with no state headers; names are monospace and nothing says parked', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const mains = [{ address: 't1', status: 'idle', seq: 1, space_name: 'spider' }, { address: 't9', status: 'blocked', seq: 2, space_name: 'tools' }, { address: 'edge.invalid/t3', status: 'working', seq: 3, space_name: 'remote' }];
    const child = { address: 't5', parent: 't1', state: 'live', status: 'idle', labels: {}, name: 'helper' };
    const order: string[][] = [];
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => mains, terminals: () => [child], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: () => null, setShared: () => {}, setAgentOrder: (ids: string[]) => order.push(ids), props: () => props, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pins = []; view.spiderFeeds = []; view.listed = new Map();
    const rendered = all(view.render({}));
    expect(rendered.filter(node => node.id && /^(sec-|pinned$)/.test(node.id))).toEqual([]);
    for (const word of ['Needs you', 'Working', 'Idle', 'Done', 'Pinned', 'parked']) expect(texts(view.render({}))).not.toContain(word);
    expect(order.at(-1)).toEqual(['t9', 'edge.invalid/t3', 't1']);
    const mono = (text: string) => rendered.find(node => node.children.includes(text) && call(node, 'font_family')?.[0] === 'JetBrains Mono');
    for (const name of ['spider', 'tools', 'remote', 'edge.invalid', 'helper']) expect([name, Boolean(mono(name))]).toEqual([name, true]);

    const Spaces = loadView(clones.spaces.files['main.js'], { machines: () => [], spaces: () => [], panes: () => [], theme: () => palette, props: () => props, shared: () => null, setShared: () => {}, run: () => {} });
    const space = all(new Spaces().row({ w: { id: 's', name: 'docs · build tools', active: false }, i: 0, g: null, tree: null }, palette));
    expect(call(space.find(node => node.children.includes('docs · build tools'))!, 'font_family')).toEqual(['JetBrains Mono']);
  });

  it('spider pane headers: name, parent pill, middle-truncated cwd, then the steer chip at the right; never a kind word', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const render = (labels: Record<string, string>, title: string, cwd = '/fixture/home/src/spider', width?: number) => {
      const Pane = loadView(clones.pane.files['main.js'], { panes: () => [{ pane: 'p1', terminal: 't4', focused: false, status: 'idle', cwd, title }],
        props: () => ({ pane: 'p1', labelContract: HerdrLabelContract }), run: () => {}, theme: () => palette, home: () => '/fixture/home',
        terminals: () => [{ address: 't4', labels }] });
      const view = new Pane(); view.init(); if (width !== undefined) view.spiderPathWidth = width; return view.render({});
    };
    const viewer = render({ 'spider.kind': 'subagent-viewer', 'spider.parent-name': 'planner', 'spider.steer': 'rpc' }, 'e2e-task1 viewer');
    const nodes = all(viewer), words = texts(viewer);
    const at = (text: string) => words.indexOf(text);
    expect([at('e2e-task1') >= 0, at('e2e-task1') < at('planner'), at('planner') < at('~/src/spider'), at('~/src/spider') < at('Can steer')]).toEqual([true, true, true, true]);
    expect(words.join(' ')).not.toMatch(/viewer|observer|console|\u21b3/i);
    for (const text of ['e2e-task1', '~/src/spider', 'planner']) expect(call(nodes.find(node => node.children.includes(text))!, 'font_family')).toEqual(['JetBrains Mono']);
    const pill = nodes.find(node => node.children.includes('planner'))!;
    expect([call(pill, 'rounded'), call(pill, 'bg')]).toEqual([[999], ['#ffffff14']]);
    const path = nodes.find(node => node.children.includes('~/src/spider'))!;
    expect(call(path, 'tooltip')).toEqual(['~/src/spider']); expect(call(path, 'truncate')).toBeUndefined();
    // A narrow header keeps the prefix and the last folder, with the full path on hover.
    const narrow = all(render({ 'spider.kind': 'subagent-viewer', 'spider.parent-name': 'planner' }, 'e2e', '/fixture/home/src/spider/worktrees/feature/checkout-01', 22 * 7));
    const cut = narrow.find(node => node.children.includes('~/src/spi\u2026/checkout-01'))!;
    expect(call(cut, 'tooltip')).toEqual(['~/src/spider/worktrees/feature/checkout-01']);
    expect(texts(render({ 'spider.kind': 'subagent-viewer', 'spider.parent-name': 'parent-run', 'spider.steer': 'print' }, 'nested'))).toEqual(expect.arrayContaining(['nested', 'parent-run', 'Read-only']));
    expect(texts(render({ 'spider.kind': 'remote-observer' }, 'npm test observer'))).toContain('npm test');
    expect(texts(render({ 'spider.kind': 'remote-console' }, 'console \u00b7 build.invalid'))).toContain('build.invalid');
    const plain = texts(render({}, 'zsh'));
    expect(plain).toContain('zsh'); expect(plain.join(' ')).not.toMatch(/Can steer|Read-only/);
  });

  it('pane headers show the display-name label first and fall back to the terminal name', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const render = (labels: Record<string, string>, title: string) => {
      const Pane = loadView(clones.pane.files['main.js'], { panes: () => [{ pane: 'p1', terminal: 't4', focused: false, status: 'idle', cwd: '/fixture/home/src', title }],
        props: () => ({ pane: 'p1', labelContract: { ...HerdrLabelContract, labels: { ...HerdrLabelContract.labels, displayName: 'spider.display-name' } } }), run: () => {}, theme: () => palette, home: () => '/fixture/home',
        terminals: () => [{ address: 't4', labels }] });
      const view = new Pane(); view.init(); return texts(view.render({}));
    };
    // hc slugs the terminal name; the label carries the readable one.
    const labelled = render({ 'spider.kind': 'subagent-viewer', 'spider.display-name': 'Review pass 2' }, 'review-pass-2');
    expect(labelled).toContain('Review pass 2'); expect(labelled).not.toContain('review-pass-2');
    expect(render({ 'spider.kind': 'subagent-viewer' }, 'review-pass-2')).toContain('review-pass-2');
  });

  it('sidebar child rows show the display-name label first and fall back to the terminal name', () => {
    const contract = HerdrLabelContract;
    const row = (labels: Record<string, string>) => projectAgentChildren([{ address: 'w/t2', parent: 'w/t1', state: 'live', status: 'working', name: 'make-test-build', labels }], [], 'w/t1', contract)[0]!.name;
    expect(row({ 'spider.display-name': 'make test build' })).toBe('make test build');
    expect(row({})).toBe('make-test-build');
  });

  it('middlePath keeps short paths, cuts long ones in the middle, and never exceeds the budget', () => {
    expect(middlePath('~/src/spider', 40)).toBe('~/src/spider');
    expect(middlePath('~/src/spider', 12)).toBe('~/src/spider');
    expect(middlePath('~/src/spider/worktrees/feature/checkout-01', 22)).toBe('~/src/spi\u2026/checkout-01');
    expect(middlePath('~/src/spider/worktrees/feature/checkout-01', 13)).toBe('\u2026/checkout-01');
    // A last folder too long to keep whole falls back to a plain middle cut.
    expect(middlePath('/a/very-long-final-segment-name', 12)).toBe('/a/ver\u2026-name');
    expect([middlePath('~/abc', 0), middlePath('~/abc', 1)]).toEqual(['', '\u2026']);
    const wide = '~/\u6587\u6863/\u{1F600}\u{1F600}\u{1F600}\u{1F600}/\u00fcn\u00efc\u00f8d\u00e9/\u{1F680}\u{1F680}';
    const length = [...wide].length;
    for (let max = 0; max <= length + 2; max++) {
      const out = middlePath(wide, max), points = [...out];
      expect([max, points.length]).toEqual([max, Math.min(max, length)]);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
      if (max >= 4 && max < length) expect(out.endsWith('/\u{1F680}\u{1F680}')).toBe(true);
    }
  });

  it('needs-you rows keep their amber mark with a glyph', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(clones.agents.files['main.js'], { props: () => props, terminals: () => [] });
    const view = new Agents();
    const blocked = all(view.status(palette, { status: 'blocked' }, true));
    expect(blocked.some(node => node.children.includes('!') && call(node, 'text_color')?.[0] === palette.blocked)).toBe(true);
  });
});
