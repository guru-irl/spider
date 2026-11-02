// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import shippedPatches from '../../assets/look/patches.json' with { type: 'json' };
import theme from '../../assets/themes/spider-glass.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import { projectAgentChildren, filterTopLevelAgents, loadAgentFeeds, selectAgentChildren } from '../../assets/agents/children.js';
import { HerdrLabelContract } from '../contracts.js';
import { FEED_REFRESH_MS, middlePath } from '../../assets/shared/feed.js';

// A recording stand-in for gpui elements: every call is kept with its arguments.
interface Node { calls: [string, unknown[]][]; children: unknown[]; svg?: string; id?: string; click?: (...args: any[]) => unknown; hoverChange?: (...args: any[]) => unknown; hoverStyle?: (value: any) => unknown }
const data = new WeakMap<object, Node>();
function element(svgPath?: string): any {
  const node: Node = { calls: [], children: [], svg: svgPath };
  const proxy: any = new Proxy(node, { get(_o, key: string) {
    if (key === 'when') return (on: boolean, fn: (el: unknown) => unknown) => { if (on) fn(proxy); return proxy; };
    if (key === 'child') return (value: unknown) => { node.children.push(value); return proxy; };
    if (key === 'children') return (values: unknown[]) => { node.children.push(...values); return proxy; };
    if (key === 'hover') return (fn: Node['hoverStyle']) => { node.hoverStyle = fn; return proxy; };
    return (...args: unknown[]) => { node.calls.push([key, args]); if (key === 'id') node.id = args[0] as string; if (key === 'on_click') node.click = args[0] as Node['click']; if (key === 'on_hover') node.hoverChange = args[0] as Node['hoverChange']; return proxy; };
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
  const ports = { FEED_REFRESH_MS, middlePath, projectAgentChildren, filterTopLevelAgents, loadAgentFeeds, selectAgentChildren, View: class {}, ...ui, ...supplied };
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

  it('placed sessions focus normally without promising to restore a parked main terminal', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const calls: unknown[] = [];
    const parked = { address: 't1', parent: null, state: 'live', status: 'working', name: 'planner',
      labels: { 'spider.kind': 'session', 'spider.session': 'planner' }, program: { key: 'pi', name: 'Pi', agent: true } };
    let placed: any[] = [{ ...parked, pane: 'p1', space: 's1', space_name: 'planner', tab: 'tb1' }];
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => placed, terminals: () => [parked], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: () => null, setShared: () => {}, setAgentOrder: () => {}, props: () => props,
      layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: (name: string, args: unknown) => calls.push({ name, args }), localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = []; view.listed = new Map();
    const row = all(view.render({})).find(node => node.id === 'ag-t1');
    expect(row).toBeDefined();
    row!.click!({}, { stop_propagation() {} });
    expect(calls).toEqual([{ name: 'pane.focus', args: { pane: 'p1' } }]);
    placed = [];
    expect(all(view.render({})).find(node => node.id === 'ag-t1')).toBeUndefined();
  });

  it('section titles are Herdr\'s own, not the bold condensed label face', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => [], terminals: () => [], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: () => null, setShared: () => {}, setAgentOrder: () => {}, openOverlay: () => {}, closeOverlay: () => {}, props: () => props, window: () => ({}),
      layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const agents = new Agents(); agents.folded = new Set(); agents.changed = {}; agents.pendingPins = []; agents.migratingPins = new Set(); agents.spiderFeeds = []; agents.listed = new Map();
    const Spaces = loadView(clones.spaces.files['main.js'], { machines: () => [], spaces: () => [], panes: () => [], focused: () => null, theme: () => palette, shared: () => null, setShared: () => {},
      run: () => {}, props: () => props, window: () => ({}), layout: () => ({ id: 'sidebar', size: { px: 268 } }), openOverlay: () => {}, closeOverlay: () => {} });
    const spaces = new Spaces(); spaces.folded = new Set(); spaces.machines = []; spaces.reconnecting = {}; spaces.shown = new Set();
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
      shared: () => null, setShared: () => {}, setAgentOrder: () => {}, props: () => props, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = []; view.listed = new Map();
    const root = data.get(view.render({}))!;
    expect(call(root, 'border_t')).toEqual([1]); expect(call(root, 'border_color')).toEqual(['#2f2f32']);
  });

  it('one priority list with no state headers; names are monospace and nothing says parked', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const mains = [{ address: 't1', status: 'idle', seq: 1, space_name: 'spider' }, { address: 't9', status: 'blocked', seq: 2, space_name: 'tools' }, { address: 'edge.invalid/t3', status: 'working', seq: 3, space_name: 'remote' }];
    const child = { address: 't5', parent: 't1', state: 'live', status: 'idle', labels: {}, name: 'helper' };
    const order: string[][] = [];
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => mains, terminals: () => [child], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: () => null, setShared: () => {}, setAgentOrder: (ids: string[]) => order.push(ids), props: () => props, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = []; view.listed = new Map();
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

  it('names each shared-tab agent from its own session or terminal while preserving a lone tab label', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const program = { name: 'pi', key: 'pi', agent: true };
    const mains = [
      { address: 't1', pane: 'p1', tab: 'shared', space_name: 'workspace', status: 'working', seq: 1, title: 'old owner title', program },
      { address: 't2', pane: 'p2', tab: 'shared', space_name: 'workspace', status: 'working', seq: 2, title: '✳ Builder two', program },
      { address: 't3', pane: 'p3', tab: 'single', space_name: 'workspace', status: 'working', seq: 3, title: 'other title', program },
      { address: 't4', pane: 'p4', tab: 'shared', space_name: 'workspace', status: 'working', seq: 4, title: '123', program },
    ];
    const panes = mains.map(a => ({ ...a, terminal: a.address }));
    const tabs = [{ id: 'shared', name: 'Shared tab' }, { id: 'single', name: 'Named tab', named: true }];
    let sorting = 'priority';
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => mains, terminals: () => [], panes: () => panes, focused: () => null,
      spaces: () => [{ id: 'space', name: 'workspace', tabs }], theme: () => palette, shared: (key: string) => key === 'agents.sort' ? sorting : null, setShared: () => {}, setAgentOrder: () => {},
      props: () => props, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.listed = new Map();
    view.spiderFeeds = [{ owner: { name: 'Planner', terminal: { address: 't1' } }, runs: { rows: [] } }];
    let rendered = view.render({});
    const rowWords = (id: string) => {
      const node = all(rendered).find(node => node.id === id)!;
      return [node, ...node.children.flatMap(all)].flatMap(n => n.children.filter((c): c is string => typeof c === 'string'));
    };
    expect(rowWords('ag-t1')).toContain('· Planner');
    expect(rowWords('ag-t2')).toContain('· Builder two');
    expect(rowWords('ag-t3')).toContain('· Named tab');
    expect(rowWords('ag-t4')).toContain('· 123');
    view.spiderFeeds.push({ owner: { name: '42', terminal: { address: 't3' } }, runs: { rows: [] } });
    rendered = view.render({});
    expect(rowWords('ag-t3')).toContain('· 42');
    sorting = 'grouped'; rendered = view.render({});
    expect(rowWords('ag-t1')).toContain('Planner');
    expect(rowWords('ag-t2')).toContain('Builder two');
    expect(rowWords('ag-t3')).toContain('42');
    expect(rowWords('ag-t4')).toContain('123');
  });

  it('subagent headers have two pills and no path or steer chip; consoles keep middle-truncated paths', async () => {
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
    expect([at('e2e-task1') >= 0, at('e2e-task1') < at('planner'), at('~/src/spider') === -1, at('Can steer') === -1]).toEqual([true, true, true, true]);
    expect(words.join(' ')).not.toMatch(/viewer|observer|console|\u21b3/i);
    for (const text of ['e2e-task1', 'planner']) expect(call(nodes.find(node => node.children.includes(text))!, 'font_family')).toEqual(['JetBrains Mono']);
    const pill = nodes.find(node => node.children.includes('planner'))!;
    expect([call(pill, 'rounded'), call(pill, 'bg')]).toEqual([[999], ['#ffffff14']]);
    const consoleNodes = all(render({ 'spider.kind': 'remote-console', 'spider.parent-name': 'planner' }, 'console'));
    const path = consoleNodes.find(node => node.children.includes('~/src/spider'))!;
    expect(call(path, 'tooltip')).toEqual(['~/src/spider']); expect(call(path, 'truncate')).toBeUndefined();
    // A narrow header keeps the prefix and the last folder, with the full path on hover.
    const narrow = all(render({ 'spider.kind': 'remote-observer', 'spider.parent-name': 'planner' }, 'command', '/fixture/home/src/spider/worktrees/feature/checkout-01', 22 * 7));
    const cut = narrow.find(node => node.children.includes('~/src/spi\u2026/checkout-01'))!;
    expect(call(cut, 'tooltip')).toEqual(['~/src/spider/worktrees/feature/checkout-01']);
    const nested = texts(render({ 'spider.kind': 'subagent-viewer', 'spider.parent-name': 'parent-run', 'spider.steer': 'print' }, 'nested'));
    expect(nested).toEqual(expect.arrayContaining(['nested', 'parent-run']));
    expect(nested).not.toContain('Read-only');
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

  it('keeps parked runs and finished ancestors of running work visible, with independent finished toggles', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const now = Date.now(), program = { name: 'pi', icon: 'mods/pi.svg', tint: true, agent: true };
    const makeFeed = (id: string, address: string, runs: any[]) => ({ sessionId: id, generation: 'generation', updatedAt: now, lifecycle: 'live',
      owner: { sessionId: id, name: id, terminal: { address } }, ipc: null, runs: { rows: runs.map(run => ({ ownerSessionId: id, ...run })) } });
    const run = (id: string, status: string, viewer: string | null) => ({ id, name: id, status, viewer, finishedAt: status === 'running' ? null : now - 1000 });
    const feeds = [makeFeed('session-one', 't1', [run('parked', 'running', null), run('parent-done', 'done', null), run('hidden-done', 'failed', null)]),
      makeFeed('session-two', 't9', [run('other-done', 'done', null)])];
    const job = { address: 'remote.invalid/t2', parent: 't1', state: 'live', status: 'working', name: 'running job', labels: { 'spider.kind': 'exec', 'spider.session': 'session-one', 'spider.run': 'parent-done', 'spider.job': 'job', 'spider.machine': 'remote.invalid' } };
    const mains = [{ address: 't1', pane: 'p1', status: 'idle', seq: 1, program }, { address: 't9', pane: 'p9', status: 'idle', seq: 2, program }];
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => mains, terminals: () => [job], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: () => null, setShared: () => {}, setAgentOrder: () => {}, props: () => props, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = feeds; view.listed = new Map();
    const cx = { notify() {}, stop_propagation() {} };
    let root = view.render({}), nodes = all(root), ids = nodes.map(node => node.id);
    expect(ids).toEqual(expect.arrayContaining(['sub-parked', 'sub-parent-done', 'sub-job', 'finished-toggle-t1', 'finished-toggle-t9']));
    expect(ids).not.toContain('sub-hidden-done'); expect(ids).not.toContain('sub-other-done');
    const toggle = nodes.find(node => node.id === 'finished-toggle-t1')!;
    expect(toggle.children).toContain('1 finished');
    expect(toggle.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/chevron-right.svg')).toBe(true);
    expect(all(root).find(node => node.id === 'finished-toggle-t9')!.children).toContain('1 finished');
    toggle.click!({}, cx); root = view.render({}); nodes = all(root); ids = nodes.map(node => node.id);
    expect(ids).toContain('sub-hidden-done'); expect(ids).not.toContain('sub-other-done');
    const expanded = nodes.find(node => node.id === 'finished-toggle-t1')!;
    expect(expanded.children).toContain('Hide finished');
    expect(expanded.children.flatMap(all).some(node => node.svg === 'mods/spider-agents/chevron-up.svg')).toBe(true);
    expanded.click!({}, cx); root = view.render({});
    expect(all(root).map(node => node.id)).not.toContain('sub-hidden-done');
    expect(all(root).find(node => node.id === 'finished-toggle-t1')!.children).toContain('1 finished');
  });

  it('keeps finished ancestors of a running job in a collapsed console and counts the job', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const now = Date.now(), program = { name: 'pi', icon: 'mods/pi.svg', tint: true, agent: true };
    const feed = { sessionId: 'session-one', generation: 'generation', updatedAt: now, lifecycle: 'live', owner: { sessionId: 'session-one', name: 'planner', terminal: { address: 't1' } }, ipc: null,
      runs: { rows: [{ id: 'parent-done', ownerSessionId: 'session-one', name: 'parent', status: 'done', viewer: null, finishedAt: now - 1000 }] } };
    const labels = { 'spider.session': 'session-one', 'spider.run': 'parent-done', 'spider.machine': 'remote.invalid' };
    const console = { address: 'remote.invalid/console', parent: 't1', state: 'finished', status: 'done', exitCode: 0, reason: 'exited', finishedAt: now - 1000, labels: { ...labels, 'spider.kind': 'remote-console' } };
    const job = { address: 'remote.invalid/job', parent: 't1', state: 'live', status: 'blocked', labels: { ...labels, 'spider.kind': 'exec', 'spider.job': 'job' } };
    const order: string[][] = [];
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => [{ address: 't1', pane: 'p1', status: 'idle', seq: 1, program }, { address: 't9', pane: 'p9', status: 'working', seq: 2, program }],
      terminals: () => [console, job], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette, shared: () => null, setShared: () => {},
      setAgentOrder: (ids: string[]) => order.push(ids), props: () => props, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = [feed]; view.listed = new Map();
    const cx = { notify() {}, stop_propagation() {} };
    let root = view.render({}), ids = all(root).map(node => node.id);
    expect(ids).toEqual(expect.arrayContaining(['sub-parent-done', 'sub-console:remote.invalid/console']));
    expect(ids).not.toContain('sub-job');
    expect(ids).not.toContain('finished-toggle-t1');
    expect(order.at(-1)).toEqual(['t1', 't9']);
    all(root).find(node => node.id === 'fold-left-t1')!.click!({}, cx); root = view.render({});
    const pill = all(root).find(node => node.id === 'fold-t1')!;
    expect(pill.children).toContain('1');
    expect(call(pill, 'text_color')).toEqual([palette.blocked]);
    expect(call(pill, 'tooltip')).toEqual(['1 subagent']);
  });

  it('places a centred fold chevron before the agent icon and keeps empty slots aligned', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const now = Date.now(), program = { name: 'pi', icon: 'mods/pi.svg', tint: true, agent: true };
    const mains = [{ address: 't1', pane: 'p1', status: 'idle', seq: 1, program }, { address: 't9', pane: 'p9', status: 'idle', seq: 2, program }];
    const child = { address: 't2', parent: 't1', state: 'live', status: 'blocked', labels: {}, name: 'live child' };
    const feed = { sessionId: 'session-one', generation: 'generation', updatedAt: now, lifecycle: 'live', owner: { sessionId: 'session-one', name: 'planner', terminal: { address: 't1' } }, ipc: null,
      runs: { rows: [{ id: 'finished', ownerSessionId: 'session-one', name: 'finished', status: 'done', viewer: null, finishedAt: now - 1000 }] } };
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => mains, terminals: () => [child], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: () => null, setShared: () => {}, setAgentOrder: () => {}, props: () => props, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = [feed]; view.listed = new Map();
    const cx = { notify() {}, stop_propagation() {} };
    let root = view.render({});
    for (const id of ['t1', 't9']) {
      const slot = all(root).find(node => node.id === `fold-slot-${id}`)!;
      expect(slot).toBeDefined();
      expect(call(slot, 'size')).toEqual([11]);
    }
    expect(all(root).find(node => node.id === 'fold-left-t9')).toBeUndefined();
    const chevron = all(root).find(node => node.id === 'fold-left-t1')!;
    for (const method of ['flex', 'items_center', 'justify_center', 'flex_none']) expect(call(chevron, method)).toEqual([]);
    expect(all(root).find(node => node.id === 'finished-toggle-t9')).toBeUndefined();
    const row = all(root).find(node => node.id === 'ag-t1')!;
    const rowNodes = [row, ...row.children.flatMap(all)];
    expect(rowNodes.findIndex(node => node.id === 'fold-slot-t1')).toBeLessThan(rowNodes.findIndex(node => node.id === 'agent-pin-t1'));
    expect(call(all(root).find(node => node.id === 'sub-t2')!, 'pl')).toEqual([17]);
    expect(call(all(root).find(node => node.id === 'finished-toggle-t1')!, 'pl')).toEqual([38]);
    chevron.click!({}, cx); root = view.render({});
    expect(all(root).map(node => node.id)).not.toContain('sub-t2');
    all(root).find(node => node.id === 'fold-left-t1')!.click!({}, cx); root = view.render({});
    expect(all(root).map(node => node.id)).toContain('sub-t2');
  });

  it('puts a fixed fold slot before each icon and a running-only pill on folded rows', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const now = Date.now(), program = { name: 'pi', icon: 'mods/pi.svg', tint: true, agent: true };
    const mains = [{ address: 't1', pane: 'p1', status: 'idle', seq: 1, program }, { address: 't9', pane: 'p9', status: 'idle', seq: 2, program }];
    const child = { address: 't2', parent: 't1', state: 'live', status: 'blocked', labels: {}, name: 'live child' };
    const feed = { sessionId: 'session-one', generation: 'generation', updatedAt: now, lifecycle: 'live', owner: { sessionId: 'session-one', name: 'planner', terminal: { address: 't1' } }, ipc: null,
      runs: { rows: [{ id: 'finished', ownerSessionId: 'session-one', name: 'finished', status: 'done', viewer: null, finishedAt: now - 1000 }] } };
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => mains, terminals: () => [child], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: () => null, setShared: () => {}, setAgentOrder: () => {}, props: () => props, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = [feed]; view.listed = new Map();
    const cx = { notify() {}, stop_propagation() {} };
    let root = view.render({});
    for (const id of ['t1', 't9']) {
      const slot = all(root).find(node => node.id === `fold-slot-${id}`)!;
      expect(slot).toBeDefined();
      expect(call(slot, 'size')).toEqual([11]);
    }
    expect(all(root).find(node => node.id === 'fold-left-t9')).toBeUndefined();
    const chevron = all(root).find(node => node.id === 'fold-left-t1')!;
    for (const method of ['flex', 'items_center', 'justify_center', 'flex_none']) expect(call(chevron, method)).toEqual([]);
    expect(all(root).find(node => node.id === 'finished-toggle-t9')).toBeUndefined();
    const row = all(root).find(node => node.id === 'ag-t1')!;
    const rowNodes = [row, ...row.children.flatMap(all)];
    expect(rowNodes.findIndex(node => node.id === 'fold-slot-t1')).toBeLessThan(rowNodes.findIndex(node => node.id === 'agent-pin-t1'));
    expect(call(all(root).find(node => node.id === 'sub-t2')!, 'pl')).toEqual([17]);
    expect(call(all(root).find(node => node.id === 'finished-toggle-t1')!, 'pl')).toEqual([38]);
    all(root).find(node => node.id === 'finished-toggle-t1')!.click!({}, cx); root = view.render({});
    expect(all(root).map(node => node.id)).toContain('sub-finished');
    all(root).find(node => node.id === 'fold-left-t1')!.click!({}, cx); root = view.render({});
    const pill = all(root).find(node => node.id === 'fold-t1')!;
    expect(pill.children).toContain('1');
    expect(call(pill, 'rounded')).toEqual([999]); expect(call(pill, 'bg')).toEqual([palette.hover]);
    const hover = element(); pill.hoverStyle!(hover);
    expect(call(data.get(hover)!, 'bg')).toEqual([palette.selected]);
    expect(call(pill, 'text_color')).toEqual([palette.blocked]); expect(call(pill, 'tooltip')).toEqual(['1 subagent']);
    expect(pill.children.flatMap(all).some(node => node.svg === 'mods/spider-agents/bot.svg' && call(node, 'size')?.[0] === 11)).toBe(true);
    expect(pill.children.flatMap(all).some(node => node.svg?.includes('chevron'))).toBe(false);
    pill.click!({}, cx); root = view.render({}); expect(all(root).map(node => node.id)).toContain('sub-t2');
  });

  it('shows pin only on icon hover and keeps the elapsed time visible', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const program = { name: 'pi', icon: 'mods/pi.svg', tint: true, agent: true }, actions: unknown[] = [], writes: string[] = [];
    const main = { address: 't1', pane: 'p1', status: 'working', seq: 1, program, pinned: false };
    const terminal = { address: 't1', parent: null, state: 'live', status: 'working', labels: {} };
    const child = { address: 't2', parent: 't1', state: 'live', status: 'working', labels: {}, name: 'child' };
    const Agents = loadView(clones.agents.files['main.js'], { agents: () => [main], terminals: () => [terminal, child], panes: () => [], focused: () => null, spaces: () => [], theme: () => palette,
      shared: () => null, setShared: () => {}, setAgentOrder: () => {}, props: () => props, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: (...args: unknown[]) => actions.push(args),
      localStorage: { removeItem: () => {}, getItem: () => null, setItem: (_key: string, value: string) => writes.push(value) } });
    const view = new Agents(); view.folded = new Set(); view.changed = { t1: { s: 'working', at: Date.now() - 60000 } }; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = []; view.listed = new Map();
    const cx = { notify() {}, stop_propagation() {} };
    let root = view.render({});
    const icon = () => all(root).find(node => node.id === 'agent-pin-t1')!;
    expect(icon()).toBeDefined();
    expect(call(icon(), 'size')).toEqual([16]); expect(texts(root)).toContain('1m');
    expect(icon().children.flatMap(all).some(node => node.svg === 'mods/pi.svg')).toBe(true);
    expect(all(root).some(node => node.id === 'pin-t1')).toBe(false);
    all(root).find(node => node.id === 'ag-t1')!.hoverChange?.(true, cx); root = view.render({});
    expect(icon().children.flatMap(all).some(node => node.svg === 'mods/pi.svg')).toBe(true);
    expect(texts(root)).toContain('1m');
    icon().hoverChange!(true, cx); root = view.render({});
    expect(texts(root)).toContain('1m');
    expect(icon().children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/pin.svg')).toBe(true);
    expect(call(icon(), 'tooltip')).toEqual(['Pin to the top']);
    icon().click!({}, cx); expect(view.pendingPins).toEqual([]); expect(view.folded.has('t1')).toBe(false); expect(actions).toEqual([['terminal.pin', { terminal: 't1', pinned: true }]]); expect(writes).toEqual([]);
    expect(main.pinned).toBe(false); main.pinned = true;
    root = view.render({}); icon().hoverChange!(true, cx); root = view.render({});
    expect(icon().children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/pin-off.svg')).toBe(true);
    expect(call(icon(), 'tooltip')).toEqual(['Unpin']);
    icon().click!({}, cx); expect(view.pendingPins).toEqual([]); expect(actions).toEqual([['terminal.pin', { terminal: 't1', pinned: true }], ['terminal.pin', { terminal: 't1', pinned: false }]]);
  });

  it('ships a small Lucide up-chevron for hiding finished rows', async () => {
    const icon = await readFile(join('packages/herdr/assets/agents/chevron-up.svg'), 'utf8').catch(() => '');
    expect(icon).toContain('stroke-width="2"');
    expect(icon).toContain('d="m18 15-6-6-6 6"');
  });

  it('centres the console chevron in a round 20-pixel target that toggles commands', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(clones.agents.files['main.js'], { props: () => props, terminals: () => [] });
    const view = new Agents(); view.listed = new Map(); view.expandedConsoles = new Set();
    const row = () => view.subRow(palette, { t: { key: 'console', kind: 'console', status: 'idle', address: 'x', name: 'console', spider: true, outcome: null, action: null }, lines: ['└'] }, null, false);
    const toggle = () => all(row()).find(node => node.id === 'console-fold-console')!;
    const cx = { notify() {}, stop_propagation() {} };
    let target = toggle();
    expect(call(target, 'size')).toEqual([20]);
    expect(call(target, 'rounded')).toEqual([999]);
    for (const method of ['flex', 'items_center', 'justify_center', 'flex_none']) expect(call(target, method)).toEqual([]);
    expect(call(target, 'tooltip')).toEqual(['Show commands']);
    expect(target.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/chevron-right.svg' && call(node, 'size')?.[0] === 11)).toBe(true);
    target.click!({}, cx); target = toggle();
    expect(call(target, 'tooltip')).toEqual(['Hide commands']);
    expect(target.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/chevron-down.svg')).toBe(true);
    target.click!({}, cx);
    expect(call(toggle(), 'tooltip')).toEqual(['Show commands']);
  });

  it('needs-you rows keep their amber mark with a glyph', async () => {
    const clones = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(clones.agents.files['main.js'], { props: () => props, terminals: () => [] });
    const view = new Agents();
    const blocked = all(view.status(palette, { status: 'blocked' }, true));
    expect(blocked.some(node => node.children.includes('!') && call(node, 'text_color')?.[0] === palette.blocked)).toBe(true);
  });
});
