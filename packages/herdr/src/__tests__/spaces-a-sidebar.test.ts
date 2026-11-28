// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { localSpaceCreateArgs, localSpaceRows, localSpaces } from '../../assets/spaces/local.js';
import { assignSpaceIdentities, threadKeylines } from '../../assets/shared/look.js';
import { loadSpacesAFiles, loadPublishedSpacesARecipe, replaySpacesARecipe, type SpacesAPatch, type SpacesAVersion } from './spaces-a-fixture.js';
import { modApi } from './strict-mod-api.mjs';

const localB = { id: 's2', index: 2, name: 'Branch B', machine: null, active: false, tabs: [], repository: '/fixture/repo' };
const localA = { id: 's1', index: 4, name: 'Branch A', machine: null, active: true, tabs: [], repository: '/fixture/repo' };
const remoteA = { id: 'r1', index: 1, name: 'Remote A', machine: 'box-1.invalid', active: false, tabs: [] };
const remoteB = { id: 'r2', index: 3, name: 'Remote B', machine: 'box-2.invalid', active: false, tabs: [] };

it('lists only local spaces at one depth in stored order', () => {
  const writes: string[] = [];
  const watch = <T extends object>(space: T): T => new Proxy(space, {
    set(_target, key) { writes.push(`set ${String(key)}`); return false; },
    defineProperty(_target, key) { writes.push(`define ${String(key)}`); return false; },
    deleteProperty(_target, key) { writes.push(`delete ${String(key)}`); return false; },
  });
  const b = watch(localB);
  const a = watch(localA);
  const spaces = Object.freeze([watch(remoteA), b, watch(remoteB), a]);

  expect(localSpaces(spaces).map(space => space.id)).toEqual(['s2', 's1']);
  const rows = localSpaceRows(spaces);
  expect(rows.map(row => row.tree)).toEqual([null, null]);
  expect(rows.map(row => row.index)).toEqual([2, 4]);
  expect(rows.map(row => row.space.id)).toEqual(['s2', 's1']);
  expect(rows[0].space).toBe(b);
  expect(rows[1].space).toBe(a);
  expect(writes).toEqual([]);
});

it('keeps local create arguments independent of remote selection', () => {
  expect(localSpaces([remoteA, remoteB])).toEqual([]);
  expect(localSpaceRows([remoteA, remoteB])).toEqual([]);
  expect(localSpaceCreateArgs()).toEqual({ machine: '' });
});

type RecordedNode = {
  id?: string; svg?: string; items: unknown[]; calls: [string, unknown[]][];
  events: Record<string, (...args: any[]) => any>;
};
const nodes = new WeakMap<object, RecordedNode>();
const elementMethods = new Set<string>(modApi.elements['gpui-kit.NativeElement']);
function element(svgPath?: string): any {
  const node: RecordedNode = { svg: svgPath, items: [], calls: [], events: {} };
  const proxy: any = new Proxy(node, { get(_target, key: string) {
    if (!elementMethods.has(key)) throw new Error(`Unknown GPUI method: ${key}`);
    if (key === 'when') return (condition: boolean, apply: (el: unknown) => unknown) => { if (condition) apply(proxy); return proxy; };
    if (key === 'child') return (item: unknown) => { node.items.push(item); return proxy; };
    if (key === 'children') return (items: unknown[]) => { node.items.push(...items); return proxy; };
    if (key === 'hover') return () => proxy;
    return (...args: unknown[]) => {
      node.calls.push([key, args]);
      if (key === 'id') node.id = args[0] as string;
      if (key.startsWith('on_')) {
        const name = key === 'on_mouse_down' || key === 'on_mouse_up' ? `${key}:${args[0]}` : key;
        node.events[name] = args[key === 'on_mouse_down' || key === 'on_mouse_up' ? 1 : 0] as (...args: any[]) => any;
      }
      return proxy;
    };
  } });
  nodes.set(proxy, node);
  return proxy;
}
function all(root: unknown): RecordedNode[] {
  if (!root || typeof root !== 'object') return [];
  const node = nodes.get(root);
  return node ? [node, ...node.items.flatMap(all)] : [];
}
function text(root: unknown): string[] {
  return all(root).flatMap(node => node.items.filter((item): item is string => typeof item === 'string'));
}
function fragment(version: SpacesAVersion): SpacesAPatch[] {
  try { return JSON.parse(readFileSync(new URL(`../../assets/look/spaces-a-sidebar/spaces-${version}.json`, import.meta.url), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
const viewSources = new Map<SpacesAVersion, string>();
function spacesSource(version: SpacesAVersion): string {
  const cached = viewSources.get(version);
  if (cached) return cached;
  const result = replaySpacesARecipe(version, loadSpacesAFiles(version), { spaces: fragment(version) });
  const source = result.spaces!['main.js']!;
  viewSources.set(version, source);
  return source;
}
const palette = { chrome: '#161618', foreground: '#ededed', muted: '#b8b8ba', dim: '#88888b',
  hover: '#262628', selected: '#29292a', raised: '#303031', accent: '#ededed', ansi1: '#ff5555',
  ansi2: '#50fa7b', blocked: '#ffcb6b', working: '#ededed', idle: '#88888b', done: '#88888b', unknown: '#88888b' };

function renderFixture(version: SpacesAVersion, options: { width?: number; checking?: boolean; spaces?: any[]; hidden?: string[]; published?: boolean; pathFont?: string } = {}) {
  const spaces = options.spaces ?? [
    { ...remoteA, folder: '/fixture/remote', status: null },
    { ...localB, folder: '/fixture/branch-b', status: null },
    { ...remoteB, folder: '/fixture/remote-two', status: null },
    { ...localA, folder: '/fixture/branch-a', status: null },
  ];
  const blocks = ['brand', 'agents', 'sidebar-footer'].map(id => ({ id, hidden: options.hidden?.includes(id) ?? false }));
  const sidebar = { id: 'sidebar', size: { px: options.width ?? 268 }, children: blocks };
  const stored = new Map<string, string>([['machines.folded', JSON.stringify([null, 'box-1.invalid'])]]);
  const shared = new Map<string, unknown>([['sidebar.width', 268]]);
  const commands: [string, any][] = [], hcCalls: unknown[][] = [], execCalls: unknown[][] = [], overlays: unknown[] = [], reads: string[] = [], scrolls: number[] = [];
  const timers: { delay: number; callback: (cx: any) => void }[] = [], pending: ((cx: any) => Promise<void>)[] = [];
  let machineReads = 0, notifications = 0;
  const cx = {
    timer: { every: (delay: number, callback: (cx: any) => void) => timers.push({ delay, callback }) },
    spawn: (task: (cx: any) => Promise<void>) => { pending.push(task); },
    notify: () => { notifications++; }, stop_propagation: () => {},
  };
  const run = (name: string, args?: any) => {
    commands.push([name, args]);
    const block = blocks.find(item => item.id === args?.id);
    if (name === 'layout.hide' && block) block.hidden = true;
    if (name === 'layout.show' && block) block.hidden = false;
    if (name === 'layout.resize' && args?.id === 'sidebar') sidebar.size.px = args.px;
    return null;
  };
  const ports: Record<string, unknown> = {
    View: class {}, div: () => element(), h_flex: () => element(), v_flex: () => element(),
    image: () => element(), svg: (path: string) => element(path),
    Scrollbar: { vertical: () => element() }, ScrollHandle: { new: () => ({ scroll_to_item: (index: number) => scrolls.push(index) }) },
    props: () => ({ modId: 'spider-spaces', fonts: { paths: options.pathFont } }),
    spaces: () => spaces, panes: () => [], machines: () => { machineReads++; return []; },
    run, openOverlay: (value: unknown) => overlays.push(value), exec: async (...args: unknown[]) => { execCalls.push(args); return { code: 1, stdout: '', stderr: '' }; },
    hc: async (...args: unknown[]) => { hcCalls.push(args); return { code: 0, stdout: '{"machines":[]}', stderr: '' }; },
    theme: () => palette, shared: (key: string) => shared.get(key) ?? null, setShared: (key: string, value: unknown) => shared.set(key, value),
    watchFolder: () => Promise.resolve([]), window: () => ({ active: false, platform: 'macos' }), layout: () => sidebar,
    localStorage: { getItem: (key: string) => { reads.push(key); return stored.get(key) ?? null; }, setItem: (key: string, value: string) => stored.set(key, value) },
    checking: () => options.checking ?? false, herdr: version === '0.1.13' && !options.checking ? {} : { checking: () => options.checking ?? false },
    localSpaces, localSpaceRows, localSpaceCreateArgs, assignSpaceIdentities, threadKeylines,
  };
  const recipe = options.published ? loadPublishedSpacesARecipe(version) : null;
  const source = recipe ? replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe).spaces!['main.js']! : spacesSource(version);
  const code = source.replace(/^(?:(?:\/\* spider-look:[a-z0-9-]+ \*\/)\s*)*import [^\n]+$/gm, '')
    .replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const View = new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return Spaces;`)(ports);
  const view = new View();
  view.init({}, cx);
  return {
    view, spaces, blocks, sidebar, stored, commands, hcCalls, execCalls, overlays, reads, scrolls, timers, cx,
    machineReads: () => machineReads, notifications: () => notifications,
    flush: async () => { while (pending.length) await pending.shift()!(cx); },
  };
}

it('0.1.16: uses the configured path font for space names and falls back when absent', () => {
  for (const [pathFont, expected] of [['Fixture Paths', 'Fixture Paths'], [undefined, 'JetBrains Mono']] as const) {
    const fixture = renderFixture('0.1.16', { published: true, pathFont, spaces: [localA] });
    const name = all(fixture.view.render()).find(node => node.items.includes('Branch A'))!;
    expect(name.calls.find(([method]) => method === 'font_family')?.[1]).toEqual([expected]);
  }
});

for (const version of ['0.1.13', '0.1.16'] as const) {
  it(`${version}: shows branches and counts without a repository name`, () => {
    const fixture = renderFixture(version, { spaces: [
      { ...localA, name: 'harness', folder: '/fixture/main', status: null },
      { ...localB, name: 'work', folder: '/fixture/spike', status: null },
    ] });
    const main = { name: 'spider', repo: 'spider', branch: 'main', linked: false, ahead: 0, behind: 0 };
    fixture.view.git[JSON.stringify([null, '/fixture/main'])] = main;
    fixture.view.git[JSON.stringify([null, '/fixture/spike'])] = { ...main, branch: 'spike', ahead: 2, behind: 1 };
    for (const branch of ['main', 'master', 'harness']) {
      main.branch = branch;
      const root = fixture.view.render();
      const harness = all(root).find(node => node.id === 'space-s1')!;
      const spike = all(root).find(node => node.id === 'space-s2')!;
      expect(harness.items.flatMap(all).flatMap(node => node.items).filter(item => typeof item === 'string')).toEqual(['harness']);
      expect(spike.items.flatMap(all).flatMap(node => node.items).filter(item => typeof item === 'string')).toEqual(expect.arrayContaining(['work', 'spike', '↑2', '↓1']));
      expect(text(root)).not.toContain('spider');
    }
  });

  it(`${version}: uses overflow-only scrollbars and 14 pixel shapes in wide and narrow lists`, () => {
    for (const width of [268, 76]) {
      const fixture = renderFixture(version, { width });
      const rendered = all(fixture.view.render());
      const shapes = rendered.filter(node => node.svg?.startsWith('mods/spider-agents/space-'));
      expect(shapes.map(node => node.calls.find(([name]) => name === 'size')?.[1])).toEqual([[14], [14]]);
      expect(rendered.filter(node => node.calls.some(([name]) => name === 'mode')).map(node => node.calls.find(([name]) => name === 'mode')?.[1])).toEqual([['scrolling']]);
      expect(rendered.some(node => node.calls.some(([name]) => name === 'overflow_y_scrollbar'))).toBe(false);
      if (version === '0.1.16' && width === 268) {
        expect(rendered.find(node => node.id === 'spaces-list')?.calls.some(([name]) => name === 'track_scroll')).toBe(true);
      }
    }
  });

  it(`${version}: renders flat local shapes in stored order without machine activity or automatic moves`, async () => {
    const fixture = renderFixture(version);
    await fixture.flush();
    fixture.view.git[JSON.stringify([null, '/fixture/branch-b'])] = { name: 'repo', repo: 'same-repo', branch: 'topic', linked: true, ahead: 2, behind: 1 };
    fixture.view.git[JSON.stringify([null, '/fixture/branch-a'])] = { name: 'repo', repo: 'same-repo', branch: 'main', linked: false, ahead: 0, behind: 0 };
    const root = fixture.view.render();
    const rendered = all(root);
    expect(rendered.filter(node => /^space-(?:s|r)\d+$/.test(node.id ?? '')).map(node => node.id)).toEqual(['space-s2', 'space-s1']);
    expect(rendered.filter(node => node.svg?.startsWith('mods/spider-agents/space-')).map(node => node.svg)).toEqual([
      'mods/spider-agents/space-triangle.svg', 'mods/spider-agents/space-octagon.svg',
    ]);
    expect(text(root)).toContain('topic');
    expect(text(root)).not.toContain('repo');
    expect(rendered.some(node => node.id?.startsWith('machine-'))).toBe(false);
    expect(fixture.commands.filter(([name]) => name === 'space.move' || name.startsWith('machine.'))).toEqual([]);
    expect(fixture.hcCalls).toEqual([]);
    expect(fixture.machineReads()).toBe(0);
    expect(fixture.reads).not.toContain('machines.folded');
    expect(fixture.reads).not.toContain('machines.reconnecting');
    expect(fixture.timers.map(timer => timer.delay)).not.toContain(15000);
    const ahead = rendered.find(node => node.items.includes('↑2'))!;
    expect(ahead.calls.find(([name]) => name === 'text_color')?.[1]).toEqual([palette.dim]);
  });

  it(`${version}: keeps narrow-sidebar restoration independent of machine folds`, () => {
    const fixture = renderFixture(version, { width: 76, hidden: ['brand', 'sidebar-footer'] });
    fixture.stored.set('spider.sidebar.rail', JSON.stringify({ folded: false, userHidden: [] }));
    const folded = fixture.view.render();
    const foldedNodes = all(folded);
    expect(foldedNodes.filter(node => /^space-(?:s|r)\d+$/.test(node.id ?? '')).map(node => node.id)).toEqual(['space-s2', 'space-s1']);
    expect(foldedNodes.filter(node => node.svg?.startsWith('mods/spider-agents/space-')).map(node => node.svg)).toEqual([
      'mods/spider-agents/space-triangle.svg', 'mods/spider-agents/space-octagon.svg',
    ]);
    expect(fixture.blocks.map(block => block.hidden)).toEqual([true, true, true]);
    foldedNodes.find(node => node.id === 'collapse')!.events.on_click({}, fixture.cx);
    fixture.view.render();
    expect(fixture.blocks.map(block => block.hidden)).toEqual([true, false, true]);
    expect(fixture.reads).not.toContain('machines.folded');
  });

  it(`${version}: creates a local space after remote focus and in the empty state`, () => {
    const fixture = renderFixture(version, { spaces: [{ ...remoteA, active: true, folder: '/fixture/remote', status: null }] });
    const root = fixture.view.render();
    expect(text(root)).toContain('No spaces yet');
    expect(all(root).some(node => node.id === 'space-r1')).toBe(false);
    all(root).find(node => node.id === 'space-new')!.events.on_click({}, fixture.cx);
    expect(fixture.commands).toContainEqual(['space.new', { machine: '' }]);
  });

  it(`${version}: drags the correct local ID to the target global index with interleaved remote spaces`, () => {
    const fixture = renderFixture(version);
    const root = fixture.view.render();
    const source = all(root).find(node => node.id === 'space-s2')!;
    const target = all(root).find(node => node.id === 'space-s1')!;
    source.events['on_mouse_down:left']({}, fixture.cx);
    target.events.on_mouse_move({}, fixture.cx);
    target.events['on_mouse_up:left']({}, fixture.cx);
    expect(fixture.commands.filter(([name]) => name === 'space.move')).toEqual([['space.move', { id: 's2', index: 4 }]]);
    target.events['on_mouse_down:right']({}, fixture.cx);
    expect(fixture.overlays).toContainEqual({ mod: 'menu', kind: 'popup', width: 200, height: 260, props: { tab: 'space', target: { id: 's1' } } });
  });

  it(`${version}: uses the target's native index instead of its array offset`, () => {
    const fixture = renderFixture(version);
    fixture.spaces[3].index = 9;
    const root = fixture.view.render();
    const source = all(root).find(node => node.id === 'space-s2')!;
    const target = all(root).find(node => node.id === 'space-s1')!;
    source.events['on_mouse_down:left']({}, fixture.cx);
    target.events.on_mouse_move({}, fixture.cx);
    target.events['on_mouse_up:left']({}, fixture.cx);
    expect(fixture.commands.filter(([name]) => name === 'space.move')).toEqual([['space.move', { id: 's2', index: 9 }]]);
  });

  it(`${version}: refuses a drag when its source becomes remote before release`, () => {
    const fixture = renderFixture(version);
    const root = fixture.view.render();
    const source = all(root).find(node => node.id === 'space-s2')!;
    const target = all(root).find(node => node.id === 'space-s1')!;
    source.events['on_mouse_down:left']({}, fixture.cx);
    target.events.on_mouse_move({}, fixture.cx);
    fixture.spaces[1].machine = 'box-1.invalid';
    target.events['on_mouse_up:left']({}, fixture.cx);
    expect(fixture.commands.filter(([name]) => name === 'space.move')).toEqual([]);
  });

  it(`${version}: does not schedule side effects while the app checks the mod`, async () => {
    const fixture = renderFixture(version, { checking: true });
    await fixture.flush();
    expect(fixture.timers).toEqual([]);
    expect(fixture.hcCalls).toEqual([]);
    expect(fixture.commands).toEqual([]);
  });

  it(`${version}: announces newly added local spaces without polling machines`, () => {
    const fixture = renderFixture(version);
    fixture.spaces.push({ id: 's3', index: 5, name: 'New', machine: null, folder: '', active: false, tabs: [], status: null });
    fixture.timers.find(timer => timer.delay === 250)!.callback(fixture.cx);
    expect(fixture.notifications()).toBeGreaterThan(0);
    expect(all(fixture.view.render()).some(node => node.id === 'space-s3')).toBe(true);
    expect(fixture.machineReads()).toBe(0);
  });

  it(`${version}: refreshes git only for local spaces`, async () => {
    const fixture = renderFixture(version);
    fixture.timers.find(timer => timer.delay === 250)!.callback(fixture.cx);
    await fixture.flush();
    expect(fixture.execCalls.length).toBeGreaterThan(0);
    expect(fixture.execCalls.map(call => (call[2] as { on: string | null }).on)).toEqual(fixture.execCalls.map(() => null));
    expect(fixture.hcCalls).toEqual([]);
  });

  it(`${version}: replays the actual fragment, checks syntax, and repeats byte-identically`, () => {
    const patches = fragment(version);
    expect(patches.length).toBeGreaterThan(0);
    const files = loadSpacesAFiles(version);
    const output = replaySpacesARecipe(version, files, { spaces: patches });
    expect(replaySpacesARecipe(version, output, { spaces: patches })).toEqual(output);
    const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: output.spaces!['main.js'], encoding: 'utf8' });
    expect(checked.status, checked.stderr).toBe(0);
  });
}

it('0.1.18: the collapsed rail shows a 32px shape button without a second status glyph', () => {
  const fixture = renderFixture('0.1.18', { width: 76, checking: true, published: true, spaces: [{ ...localA, status: 'blocked' }] });
  const rendered = all(fixture.view.render());
  const button = rendered.find(node => node.id === 'space-s1')!;
  expect(button.calls).toContainEqual(['h', [32]]);
  expect(button.calls).toContainEqual(['tooltip', ['Branch A']]);
  expect(button.items).toHaveLength(1);
  expect(button.items.flatMap(all).map(node => node.svg)).toEqual(['mods/spider-agents/space-octagon.svg']);
});

it('0.1.16: cancels an obsolete local git watch when its space disappears', () => {
  const fixture = renderFixture('0.1.16');
  const gitKey = JSON.stringify([null, '/fixture/gone']);
  const repo = '/fixture/repo';
  const cancelled: string[] = [];
  fixture.view.git[gitKey] = { repo: JSON.stringify([null, repo]) };
  fixture.view.watching.set(repo, { cancel: () => cancelled.push(repo) });
  fixture.view.due(10000, [], []);
  expect(cancelled).toEqual(['/fixture/repo']);
  expect(fixture.view.watching.has(repo)).toBe(false);
  expect(fixture.view.git[gitKey]).toBeUndefined();
});

it('0.1.16: scrolls the active local row without counting hidden remote spaces', () => {
  const fixture = renderFixture('0.1.16');
  fixture.view.render();
  expect(fixture.scrolls).toEqual([1]);
  fixture.spaces[0].active = true;
  fixture.spaces[3].active = false;
  fixture.view.render();
  expect(fixture.scrolls).toEqual([1]);
});
