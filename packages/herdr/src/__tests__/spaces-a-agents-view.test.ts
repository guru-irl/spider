// SPDX-License-Identifier: MIT
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import * as children from '../../assets/agents/children.js';
import emptyRunName from './fixtures/empty-run-name.json' with { type: 'json' };
import * as look from '../../assets/shared/look.js';
import * as feed from '../../assets/shared/feed.js';
import { describeOpenFailure } from '../../assets/shared/open-failure.js';
import * as grouping from '../../assets/agents/grouping.js';
import * as connections from '../../assets/agents/connections.js';
import * as consoleGroups from '../../assets/agents/console-groups.js';
import { HerdrLabelContract } from '../contracts.js';
import { modApi } from './strict-mod-api.mjs';
import { loadSpacesAFiles, replaySpacesARecipe, loadPublishedSpacesARecipe, type SpacesAPatch, type SpacesAVersion } from './spaces-a-fixture.js';

interface Node {
  id?: string; svg?: string; children: unknown[]; calls: [string, unknown[]][];
  events: Record<string, (...args: any[]) => any>;
}
const recorded = new WeakMap<object, Node>();
const methods = new Set<string>(modApi.elements['gpui-kit.NativeElement']);
const textViewMethods = new Set<string>(modApi.elements['gpui-base.TextViewElement']);
function element(svgPath?: string, allowed = methods): any {
  const node: Node = { svg: svgPath, children: [], calls: [], events: {} };
  const proxy: any = new Proxy(node, { get(target, key: string | symbol) {
    if (typeof key === 'symbol') return Reflect.get(target, key);
    if (!allowed.has(key)) throw new Error(`Unknown GPUI method: ${key}`);
    if (key === 'when') return (on: boolean, fn: (element: any) => unknown) => { if (on) fn(proxy); return proxy; };
    const add = (value: unknown) => {
      if (!recorded.has(value as object) && !['string', 'number', 'boolean'].includes(typeof value)) throw new TypeError('Invalid GPUI child');
      node.children.push(value);
    };
    if (key === 'child') return (value: unknown) => { add(value); return proxy; };
    if (key === 'children') return (values: unknown[]) => { values.forEach(add); return proxy; };
    if (key === 'hover') return () => proxy;
    return (...args: unknown[]) => {
      node.calls.push([key, args]);
      if (key === 'id') node.id = args[0] as string;
      if (key.startsWith('on_')) {
        const name = key === 'on_mouse_down' || key === 'on_mouse_up' ? `${key}:${args[0]}` : key;
        node.events[name] = args.at(-1) as Node['events'][string];
      }
      return proxy;
    };
  } });
  recorded.set(proxy, node);
  return proxy;
}
function all(root: unknown): Node[] {
  const node = recorded.get(root as object);
  return node ? [node, ...node.children.flatMap(all)] : [];
}
const texts = (root: unknown): string[] => all(root).flatMap(node => node.children.filter((value): value is string => typeof value === 'string'));
const call = (node: Node, name: string) => node.calls.find(([key]) => key === name)?.[1];
const byId = (root: unknown, id: string): Node | undefined => all(root).find(node => node.id === id);
const palette = { chrome: '#161618', foreground: '#ececed', muted: '#b4b4b5', dim: '#969697', hover: '#262628', selected: '#29292a', raised: '#303031', popover: '#222224', ansi1: '#ff5555', ansi2: '#50fa7b', blocked: '#ffcb6b', working: '#ececed', idle: '#969697', done: '#969697', border: '#2f2f32' };
const ok = (value: unknown = {}) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
function agent(address: string, pane: string, pinned = false) {
  return { address, pane, space: 's1', space_name: 'Work', tab: 'tab', title: 'Writer', seq: 1,
    program: { name: 'pi', key: 'pi' }, status: 'idle', pinned, focused: false };
}
function terminal(address: string, labels: Record<string, string> = {}) {
  return { address, parent: null, state: 'live', status: 'idle', labels };
}
const patchedSources = new Map<SpacesAVersion, string>();
function patched(version: SpacesAVersion): string {
  const cached = patchedSources.get(version);
  if (cached) return cached;
  const recipe = loadPublishedSpacesARecipe(version);
  const source = replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe).agents['main.js'];
  patchedSources.set(version, source);
  return source;
}
function loadView(source: string, ports: Record<string, unknown>): any {
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)*import .*;\s*$/gm, '')
    .replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const name = /class (\w+) extends View/.exec(code)![1];
  return new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return ${name};`)(ports);
}
function fixture(version: SpacesAVersion, options: { checking?: boolean; sortMenu?: boolean; feedRoot?: boolean; clipboard?: boolean; corruptStorage?: boolean; ports?: Record<string, unknown> } = {}) {
  const nativeAgents = [agent('box-1.invalid/unpinned', 'p1'), agent('local', 'p2'), agent('box-1.invalid/pinned', 'p3', true), agent('proxy', 'p4')];
  const nativeTerminals: any[] = [terminal('box-1.invalid/unpinned'), terminal('local'), terminal('box-1.invalid/pinned'),
    terminal('proxy', { 'spider.kind': 'roam-proxy', 'spider.machine': 'box-2.invalid', 'spider.owner-terminal': 'box-2.invalid/owner' })];
  const inventory = [
    { name: 'box-1.invalid', id: 'core-1', state: 'connected', target: 'ssh-one.invalid' },
    { name: 'box-2.invalid', id: 'core-2', state: 'disconnected', target: 'ssh-two.invalid', temporary: true },
    { name: 'box-3.invalid', id: 'core-3', state: 'needs_login', target: 'ssh-three.invalid' },
    { name: 'box-4.invalid', id: 'core-4', state: 'connected', target: 'ssh-four.invalid' },
  ];
  const layouts = [null, ...inventory.map(machine => machine.name)].map(name => ({ name, layout: 'ready' }));
  const spaces = [{ id: 's1', index: 1, name: 'Work', machine: null, active: true, tabs: [{ id: 'tab', name: 'Writer', active: true, named: true, status: null }] }];
  const stored = new Map<string, string>(), state = new Map<string, unknown>([['agents.sort', 'machine']]);
  if (options.corruptStorage) { stored.set('changed', '{broken'); stored.set('pins', '{}'); }
  const commands: [string, any][] = [], hcCalls: string[][] = [], execCalls: unknown[][] = [], timers: { delay: number; callback: (cx: any) => unknown }[] = [], copied: string[] = [], overlays: unknown[] = [], snapshots: any[] = [];
  const targets: any[] = [];
  let failed = false, addFails = false, notifications = 0, execStarted: (() => void) | null = null;
  let execResult: () => Promise<{ code: number; stdout: string; stderr: string }> = async () => ok({ ok: true, op: 'openSession', terminal: 'local' });
  const waits: ((command: string) => void)[] = [], queued: string[] = [], noticeWaiters: (() => void)[] = [];
  const watches: { finish: (value: string[]) => void; cancelled: number }[] = [];
  const watchWaiters: { count: number; resolve: () => void }[] = [];
  let readerClosed = 0;
  const deliver = (command: string) => { const resolve = waits.shift(); if (resolve) resolve(command); else queued.push(command); };
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) };
  const cx: any = {
    notify() { notifications++; for (const resolve of noticeWaiters.splice(0)) resolve(); }, stop_propagation() {}, write_to_clipboard(value: string) { copied.push(value); },
    timer: { every(delay: number, callback: (cx: any) => unknown) { timers.push({ delay, callback }); return { cancel() {} }; } },
    spawn(fn: (cx: any) => unknown) { return fn(cx); },
  };
  if (options.clipboard === false) delete cx.write_to_clipboard;
  const props = { modId: 'spider-agents', labelContract: HerdrLabelContract, retention: { completedHours: 24, completedRows: 50 }, machines: [{ name: 'box-5.invalid' }], nodePath: 'node', cliPath: 'cli', feedRoot: options.feedRoot ? '/fixture/feeds' : undefined, sortMenu: options.sortMenu ?? false };
  const host = {
    ...children, ...look, ...feed, ...grouping, ...connections, ...consoleGroups, describeOpenFailure,
    createFeedReader: () => ({ read: async () => ({ feeds: [], errors: [] }), close: async () => { readerClosed++; } }),
    View: class {}, div: () => element(), h_flex: () => element(), v_flex: () => element(), image: () => element(), svg: (path: string) => element(path),
    Scrollbar: { vertical: () => element() }, TextView: { html: (id: string, value: string) => element(undefined, textViewMethods).id(id).child(value) },
    initMoveMenu() {}, renderMoveMenu: () => element(),
    projectNavigation: (snapshot: any) => { snapshots.push(snapshot); return [...targets]; },
    herdr: version === '0.1.13' && !options.checking ? {} : { checking: () => options.checking ?? false },
    checking: () => options.checking ?? false,
    agents: () => nativeAgents, terminals: () => nativeTerminals, panes: () => [], machines: () => layouts, spaces: () => spaces,
    focused: () => ({ space: 's1', tab: 'tab', agent: null }), theme: () => palette, props: () => props,
    layout: () => ({ id: 'sidebar', size: { px: 268 }, children: [] }), window: () => ({ active: true, platform: 'macos' }),
    shared: (key: string) => state.get(key) ?? null, setShared: (key: string, value: unknown) => state.set(key, value),
    setAgentOrder: () => {}, run: (name: string, args?: any) => { commands.push([name, args]); if (name.startsWith('spider-agents.')) deliver(name.slice('spider-agents.'.length)); },
    openOverlay: (value: unknown) => overlays.push(value), closeOverlay: () => {}, localStorage: storage,
    nextCommand: () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<string>(resolve => waits.push(resolve)),
    hc: async (args: string[]) => { hcCalls.push(args); if (args[0] === 'server') return ok({ core: { id: 'local-core' } }); if (args[1] === 'ls') return failed ? { code: 1, stdout: '', stderr: 'offline' } : ok({ machines: inventory }); if (args[1] === 'add' && addFails) return { code: 1, stdout: JSON.stringify({ error: { message: 'login required' } }), stderr: '' }; return ok(); },
    exec: async (...args: unknown[]) => { execCalls.push(args); execStarted?.(); return execResult(); },
    panelIpcArgv: (_node: string, _cli: string, descriptor: unknown, request: unknown) => ['node', 'cli', JSON.stringify({ descriptor, request })],
    parseSessionIpcReply: (text: string) => JSON.parse(text),
    watchFolder: () => {
      let finish!: (value: string[]) => void;
      const promise = new Promise<string[]>(resolve => { finish = resolve; });
      const watch = { finish, cancelled: 0 };
      Object.assign(promise, { cancel() { watch.cancelled++; finish([]); } });
      watches.push(watch);
      for (const waiter of watchWaiters.filter(item => watches.length >= item.count)) waiter.resolve();
      return promise;
    }, readTextFile: async () => null, ...options.ports,
  };
  const Agents = loadView(patched(version), host);
  const view = new Agents();
  view.init({}, cx);
  return {
    view, cx, nativeAgents, nativeTerminals, inventory, layouts, spaces, props, stored, state, commands, hcCalls, execCalls, timers, copied, overlays, snapshots, targets, waits, watches,
    get notifications() { return notifications; },
    get readerClosed() { return readerClosed; },
    failRemote(value = true) { failed = value; },
    failAdd(value = true) { addFails = value; },
    async ready() { if (view.spiderConnections) await view.spiderConnections.refresh(); },
    async send(command: string) { if (!waits.length) throw new Error('command loop is not listening'); const notice = new Promise<void>(resolve => noticeWaiters.push(resolve)); deliver(command); await notice; },
    waitForExec() { return execCalls.length ? Promise.resolve() : new Promise<void>(resolve => { execStarted = resolve; }); },
    waitForNotice() { return new Promise<void>(resolve => noticeWaiters.push(resolve)); },
    waitForWatches(count: number) { return watches.length >= count ? Promise.resolve() : new Promise<void>(resolve => watchWaiters.push({ count, resolve })); },
    setExec(fn: typeof execResult) { execResult = fn; },
  };
}

function seedConsoles(test: ReturnType<typeof fixture>) {
  const session = 'session-one', run = 'run-local';
  const labels = (extra: Record<string, string>) => ({ 'spider.session': session, ...extra });
  test.layouts.push({ name: 'box-5.invalid', layout: 'unavailable' });
  test.nativeTerminals.push(
    { ...terminal('subviewer', labels({ 'spider.kind': 'subagent-viewer', 'spider.run': run })), parent: 'local', status: 'working', name: 'Helper' },
    { ...terminal('box-4.invalid/console-a', labels({ 'spider.kind': 'remote-console', 'spider.machine': 'box-4.invalid' })), parent: 'local' },
    { ...terminal('box-4.invalid/job-a', labels({ 'spider.kind': 'exec', 'spider.machine': 'box-4.invalid', 'spider.job': 'job-a' })), parent: 'box-4.invalid/console-a', status: 'working' },
    { ...terminal('box-5.invalid/console-away', labels({ 'spider.kind': 'remote-console', 'spider.machine': 'box-5.invalid' })), parent: 'local' },
    { ...terminal('box-4.invalid/nested', labels({ 'spider.kind': 'remote-console', 'spider.machine': 'box-4.invalid', 'spider.run': run })), parent: 'subviewer' },
    { ...terminal('box-2.invalid/console-b', { 'spider.kind': 'remote-console', 'spider.machine': 'box-2.invalid' }), parent: 'box-1.invalid/pinned' },
  );
  test.view.spiderFeeds = [{ sessionId: session, generation: 'gen', lifecycle: 'live', updatedAt: Date.now(),
    owner: { sessionId: session, generation: 'gen', name: 'Writer', terminal: { address: 'local' } },
    ipc: { address: 'endpoint', capabilityFile: 'cap' }, runs: { rows: [] } }];
}
const consoleKey = (owner: string, parent: string | null = null) => `console-group:${JSON.stringify([owner, parent])}`;
const consoleId = (owner: string, parent: string | null = null) => `console-group:${encodeURIComponent(consoleKey(owner, parent))}`;

it('0.1.13: refreshes machines at mount and allows remote focus before observation', async () => {
  const test = fixture('0.1.13');
  const root = test.view.render(test.cx);
  expect(test.hcCalls).toEqual([['server', 'status', '--json'], ['machine', 'ls', '--json']]);
  expect(byId(root, 'ag-box-1.invalid/unpinned')!.events.on_click).toBeDefined();
  byId(root, 'ag-box-1.invalid/unpinned')!.events.on_click?.();
  expect(test.commands).toContainEqual(['pane.focus', { pane: 'p1' }]);
  await test.ready();
  expect(byId(test.view.render(test.cx), 'machine:box-4.invalid')).toBeDefined();
});

for (const version of ['0.1.13', '0.1.16'] as const) {
  it(`${version}: keeps remote focus available when the first machine observation fails`, async () => {
    const test = fixture(version, { ports: { hc: async () => ({ code: 1, stdout: '', stderr: 'offline' }) } });
    await test.ready();
    const row = byId(test.view.render(test.cx), 'ag-box-1.invalid/unpinned')!;
    expect(row.events.on_click).toBeDefined();
    row.events.on_click?.();
    expect(test.commands).toContainEqual(['pane.focus', { pane: 'p1' }]);
  });

  it(`${version}: restores the space and pinned heading caret, glyph slot, inset and thread stem`, async () => {
    const test = fixture(version);
    await test.ready();
    test.state.set('agents.sort', 'grouped');
    const root = test.view.render(test.cx);
    for (const id of ['sp-s1', 'pinned']) {
      const heading = byId(root, id)!;
      const parts = heading.children.flatMap(all);
      expect(call(heading, 'pl')).toEqual([40]);
      expect(call(byId(root, `group-fold-${id}`) ?? { calls: [] } as any, 'left')).toEqual([4]);
      expect(parts.some(node => node.svg === 'mods/workspace-chrome/chevron-down.svg')).toBe(true);
      const stem = parts.find(node => call(node, 'top')?.[0] === 26 && call(node, 'w')?.[0] === 1);
      expect(stem && call(stem, 'left')).toEqual([23.5]);
      expect(stem && call(stem, 'bottom')).toEqual([0]);
    }
    const glyph = byId(root, 'sp-s1')!.children.flatMap(all).find(node => node.svg?.startsWith('mods/spider-agents/space-'));
    expect(glyph && call(glyph, 'left')).toEqual([17]);
    expect(glyph && call(glyph, 'size')).toEqual([14]);
  });

  it(`${version}: restores all folded space pills and blocked-child attention`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    test.nativeTerminals.find(row => row.address === 'subviewer').status = 'blocked';
    await test.ready();
    test.state.set('agents.sort', 'grouped');
    test.view.folded.add('sp-s1');
    const root = test.view.render(test.cx);
    for (const [kind, count, icon] of [
      ['agents', '3', 'mods/spider-tabs/spider.svg'],
      ['subagents', '1', 'mods/spider-agents/bot.svg'],
      ['consoles', '2', 'mods/workspace-chrome/terminal.svg'],
    ]) {
      const pill = byId(root, `group-count-${kind}-sp-s1`);
      expect(pill?.children).toContain(count);
      expect(pill?.children.flatMap(all).some(node => node.svg === icon)).toBe(true);
      expect(pill && call(pill, 'bg')).toEqual([palette.hover]);
    }
    expect(call(byId(root, 'group-count-subagents-sp-s1') ?? { calls: [] } as any, 'text_color')).toEqual([palette.blocked]);
    expect(byId(root, 'sp-s1')!.children.flatMap(all).some(node => call(node, 'bg')?.[0] === palette.blocked + '26')).toBe(true);
    expect(byId(root, 'sp-s1')!.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/chevron-right.svg')).toBe(true);
    expect(byId(root, 'ag-local')).toBeUndefined();
  });

  it(`${version}: a folded machine signals blocked members and children`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    test.nativeAgents[1].status = 'blocked';
    test.nativeTerminals.find(row => row.address === 'subviewer').status = 'blocked';
    await test.ready();
    test.view.foldedMachines.add('machine:');
    const root = test.view.render(test.cx);
    expect(call(byId(root, 'machine-subagents-local')!, 'text_color')).toEqual([palette.blocked]);
    expect(call(byId(root, 'machine-agents-local')!, 'text_color')).toEqual([palette.blocked]);
    expect(byId(root, 'machine:')!.children.flatMap(all).some(node => call(node, 'bg')?.[0] === palette.blocked + '26')).toBe(true);
  });

  it(`${version}: folded machine attention includes blocked and failed agents without children`, async () => {
    const test = fixture(version);
    await test.ready();
    test.view.foldedMachines.add('machine:');
    for (const status of ['blocked', 'error']) {
      test.nativeAgents[1].status = status;
      const root = test.view.render(test.cx);
      expect(call(byId(root, 'machine-agents-local')!, 'text_color')).toEqual([palette.blocked]);
      expect(byId(root, 'machine:')!.children.flatMap(all).some(node => call(node, 'bg')?.[0] === palette.blocked + '26')).toBe(true);
    }
  });

  it(`${version}: a stale Reconnect control cannot tear down a newly connected machine`, async () => {
    const test = fixture(version);
    await test.ready();
    const reconnect = byId(test.view.render(test.cx), 'machine-reconnect-box-2.invalid')!;
    test.inventory[1].state = 'connected';
    await test.view.spiderConnections.refresh();
    await reconnect.events.on_click({}, test.cx);
    expect(test.hcCalls.filter(args => args[1] === 'rm' || args[1] === 'add')).toEqual([]);
  });

  it(`${version}: each folded space count pill opens the group in one click`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    test.state.set('agents.sort', 'grouped');
    for (const kind of ['agents', 'subagents', 'consoles']) {
      test.view.folded.add('sp-s1');
      const root = test.view.render(test.cx);
      byId(root, `group-count-${kind}-sp-s1`)!.events.on_click({}, test.cx);
      expect(byId(test.view.render(test.cx), 'ag-local')).toBeDefined();
    }
  });

  it(`${version}: offers Reconnect only for disconnected or rebuilt machines`, async () => {
    const test = fixture(version);
    await test.ready();
    let root = test.view.render(test.cx);
    expect(byId(root, 'machine-reconnect-box-1.invalid')).toBeUndefined();
    expect(byId(root, 'machine-reconnect-box-3.invalid')).toBeUndefined();
    expect(byId(root, 'machine-reconnect-box-2.invalid')).toBeDefined();
    test.inventory[1].state = 'unreachable';
    await test.view.spiderConnections.refresh();
    root = test.view.render(test.cx);
    expect(byId(root, 'machine-reconnect-box-2.invalid')).toBeDefined();
  });

  it(`${version}: a saved repair never offers Reconnect on a needs-login machine`, async () => {
    const saved = new Map([['machines.reconnecting', JSON.stringify({ 'box-3.invalid': {
      machine: { name: 'box-3.invalid', state: 'needs_login', target: 'ssh-three.invalid' }, removed: true, busy: false, error: 'login required',
    } })]]);
    const test = fixture(version, { ports: { localStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key),
    } } });
    await test.ready();
    const root = test.view.render(test.cx);
    expect(Boolean(byId(root, 'machine-reconnect-box-3.invalid'))).toBe(false);
    expect(byId(root, 'machine-login-copy-box-3.invalid')).toBeDefined();
  });

  it(`${version}: checks clipboard support on the event context, not the render context`, async () => {
    const test = fixture(version);
    await test.ready();
    const renderCx = { ...test.cx, write_to_clipboard: undefined };
    const root = test.view.render(renderCx);
    expect(texts(root)).not.toContain("Copy isn't available in this Herdr version");
    const copy = byId(root, 'machine-login-copy-box-3.invalid');
    expect(copy).toBeDefined();
    copy?.events.on_click({}, test.cx);
    expect(test.copied).toEqual(['hc machine login box-3.invalid']);
  });

  it(`${version}: native next and previous navigation follows the visible grouping`, async () => {
    const orders: string[][] = [];
    const test = fixture(version, { ports: { setAgentOrder: (order: string[]) => orders.push(order) } });
    await test.ready();
    for (const sort of ['machine', 'grouped', 'priority']) {
      test.state.set('agents.sort', sort);
      const root = test.view.render(test.cx);
      const visible = all(root).filter(node => node.id?.startsWith('ag-') && node.id !== 'ag-list' && node.id !== 'ag-sort').map(node => node.id!.slice(3));
      expect(orders.at(-1)).toEqual(visible);
    }
  });

  it(`${version}: a machine named local does not collide with This computer element ids`, async () => {
    const test = fixture(version);
    test.inventory.push({ name: 'local', id: 'remote-local', state: 'connected', target: 'ssh-local.invalid' });
    test.layouts.push({ name: 'local', layout: 'ready' });
    test.nativeAgents.push(agent('local/owner', 'remote-local-pane'));
    test.nativeTerminals.push(terminal('local/owner'));
    await test.ready();
    test.view.foldedMachines.add('machine:');
    test.view.foldedMachines.add('machine:local');
    const root = test.view.render(test.cx);
    const ids = all(root).flatMap(node => node.id ? [node.id] : []);
    expect(ids.length).toBe(new Set(ids).size);
    expect(byId(root, 'machine-dot-local')).toBeDefined();
    expect(byId(root, 'machine-dot-remote:local')).toBeDefined();
    expect(byId(root, 'machine-agents-remote:local')?.children).toContain('1');
  });

  it(`${version}: one click on the folded agent consoles pill reveals its consoles group`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    test.view.folded.add('local');
    let root = test.view.render(test.cx);
    byId(root, 'console-count-local')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-console:box-4.invalid/console-a')).toBeDefined();
    expect(call(byId(root, consoleId('local'))!, 'accessibility_label')).toEqual(['Consoles, 1, expanded']);
  });

  it(`${version}: the consoles caret and icon use the same columns as child rows`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    test.state.set('agents.sort', 'priority');
    const root = test.view.render(test.cx);
    const group = byId(root, consoleId('local'))!;
    const caret = group.children.flatMap(all).find(node => node.svg === 'mods/workspace-chrome/chevron-right.svg')!;
    const icon = group.children.flatMap(all).find(node => node.svg === 'mods/workspace-chrome/terminal.svg');
    expect(call(caret, 'left')).toEqual([30]);
    expect(icon && call(icon, 'left')).toEqual([43]);
  });

  it(`${version}: replays malformed agent rows as a muted diagnostic and recovers`, async () => {
    const test = fixture(version);
    await test.ready();
    test.nativeAgents.push({ ...agent('bad', 'bad-pane'), title: {} } as any);
    const root = test.view.render(test.cx);
    expect(byId(root, 'ag-local')).toBeDefined();
    expect(byId(root, 'ag-bad')).toBeUndefined();
    const diagnostic = all(root).find(node => node.children.includes('Some agent rows unavailable (agent)'))!;
    expect(call(diagnostic, 'text_color')).toEqual([palette.dim]);
    test.nativeAgents.pop();
    expect(texts(test.view.render(test.cx)).join(' ')).not.toContain('Some agent rows unavailable');
    expect(test.view.spiderRenderRows).toBeNull();
    expect(test.view.spiderRenderSnapshot).toBeNull();
  });

  it(`${version}: isolates a child builder failure with the muted content-free diagnostic`, async () => {
    const test = fixture(version);
    test.nativeTerminals.push({ ...terminal('good-child'), parent: 'local', name: 'Good child' }, { ...terminal('bad-child'), parent: 'local', name: 'Bad child' });
    await test.ready();
    const render = test.view.subRow.bind(test.view);
    test.view.subRow = (...args: any[]) => { if (args[1].t.key === 'bad-child') throw Error('SECRET'); return render(...args); };
    const root = test.view.render(test.cx);
    expect(byId(root, 'ag-local')).toBeDefined();
    expect(byId(root, 'sub-good-child')).toBeDefined();
    expect(byId(root, 'sub-bad-child')).toBeUndefined();
    const diagnostic = all(root).find(node => node.children.includes('Some agent rows unavailable (child)'))!;
    expect(call(diagnostic, 'text_color')).toEqual([palette.dim]);
    expect(texts(root).join(' ')).not.toContain('SECRET');
  });

  it(`${version}: validates projected children before folded console grouping`, async () => {
    const good = { key: 'good', kind: 'native', depth: 0, name: 'Good child', address: 'good', parentKey: null, status: 'working', retained: false, terminal: null };
    const test = fixture(version, { ports: { projectAgentChildren: () => [null, { ...good, key: 'bad', depth: Infinity }, good] } });
    await test.ready();
    const root = test.view.render(test.cx);
    expect(byId(root, 'sub-good')).toBeDefined();
    expect(byId(root, 'sub-bad')).toBeUndefined();
    expect(texts(root)).toContain('Some agent rows unavailable (child)');
    test.view.foldedMachines.add('machine:');
    expect(() => test.view.render(test.cx)).not.toThrow();
  });

  it(`${version}: retains a key caption for an empty-name run with no viewer`, async () => {
    const test = fixture(version);
    await test.ready();
    const parsed = feed.parseFeed(JSON.stringify({ ...emptyRunName, updatedAt: Date.now(),
      owner: { ...emptyRunName.owner, terminal: { ...emptyRunName.owner.terminal, address: 'local', terminalId: 'local' } } }));
    expect(parsed).not.toBeNull();
    test.view.spiderFeeds = [parsed];
    let root = test.view.render(test.cx);
    expect(byId(root, 'sub-empty-run')).toBeDefined();
    expect(texts(root)).toContain('empty-run');
    expect(texts(root).join(' ')).not.toContain('Some agent rows unavailable');
    test.view.spiderFeeds[0].runs.rows.push(null);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-empty-run')).toBeDefined();
    expect(texts(root)).toContain('Some agent rows unavailable (run)');
  });

  it(`${version}: rejects malformed terminal and feed neighbors before child projection`, async () => {
    const test = fixture(version);
    test.nativeTerminals.push(null, { ...terminal('good-child'), parent: 'local', name: 'Good child' });
    await test.ready();
    test.view.spiderFeeds = [{ owner: null }];
    const root = test.view.render(test.cx);
    expect(byId(root, 'ag-local')).toBeDefined();
    expect(byId(root, 'sub-good-child')).toBeDefined();
    expect(texts(root)).toContain('Some agent rows unavailable (feed, terminal)');
  });

  it(`${version}: isolates a root builder failure while keeping other machine members`, async () => {
    const test = fixture(version);
    await test.ready();
    const status = test.view.status.bind(test.view);
    test.view.status = (...args: any[]) => { if (args[1].address === 'local') throw Error('SECRET'); return status(...args); };
    const root = test.view.render(test.cx);
    expect(byId(root, 'ag-local')).toBeUndefined();
    expect(byId(root, 'ag-box-1.invalid/pinned')).toBeDefined();
    expect(texts(root)).toContain('Some agent rows unavailable (agent)');
    expect(texts(root).join(' ')).not.toContain('SECRET');
  });

  it(`${version}: uses one validated snapshot throughout machine and parked projections`, async () => {
    let reads = 0, machineReads = 0;
    const test = fixture(version, { ports: {
      terminals: () => ++reads === 1 ? [terminal('local'), { ...terminal('good-child'), parent: 'local', name: 'Good child' }] : [null],
      machines: () => ++machineReads === 1 ? [{ name: null, layout: 'ready' }, { name: 'box-1.invalid', layout: 'ready' }] : [null],
    } });
    await test.ready();
    const root = test.view.render(test.cx);
    expect(byId(root, 'ag-local')).toBeDefined();
    expect(byId(root, 'ag-box-1.invalid/pinned')).toBeDefined();
    expect(byId(root, 'sub-good-child')).toBeDefined();
    expect(reads).toBe(1);
    expect(machineReads).toBe(1);
  });

  it(`${version}: guards group headings, console rows and the finished toggle independently`, async () => {
    const test = fixture(version, { ports: { svg: (path: string) => { if (path.endsWith('/monitor.svg')) throw Error('SECRET'); return element(path); } } });
    seedConsoles(test);
    await test.ready();
    test.view.consoleGroupRow = () => { throw Error('SECRET'); };
    test.view.finishedToggle = () => { throw Error('SECRET'); };
    const root = test.view.render(test.cx);
    expect(byId(root, 'ag-local')).toBeDefined();
    expect(byId(root, 'ag-box-1.invalid/pinned')).toBeDefined();
    expect(texts(root)).toContain('Some agent rows unavailable (child, finished, group)');
    expect(texts(root).join(' ')).not.toContain('SECRET');
  });

  it(`${version}: keeps the muted fallback for an iconless agent`, async () => {
    const test = fixture(version);
    test.nativeAgents[1].program = { name: 'Custom', key: 'custom' };
    await test.ready();
    const root = test.view.render(test.cx);
    expect(byId(root, 'ag-local')).toBeDefined();
    expect(byId(root, 'ag-local')!.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/terminal.svg')).toBe(true);
    expect(texts(root).join(' ')).not.toContain('Some agent rows unavailable');
  });

  it(`${version}: normalizes primitive numeric titles without discarding the agent`, async () => {
    const test = fixture(version);
    test.spaces[0].tabs[0].name = 42 as any;
    test.nativeAgents.forEach(item => { item.title = 42 as any; });
    await test.ready();
    const root = test.view.render(test.cx);
    expect(byId(root, 'ag-local')).toBeDefined();
    expect(texts(root)).toContain('42');
    expect(texts(root).join(' ')).not.toContain('Some agent rows unavailable');
  });

  it(`${version}: groups native agents once per machine, retaining pin order and proxy ownership`, async () => {
    const test = fixture(version);
    await test.ready();
    const root = test.view.render(test.cx);
    const list = byId(root, 'ag-list')!;
    const ids = list.children.flatMap(all).map(node => node.id).filter(Boolean);
    expect(ids.filter(id => id?.startsWith('machine:'))).toEqual(['machine:', 'machine:box-1.invalid', 'machine:box-2.invalid', 'machine:box-3.invalid', 'machine:box-4.invalid', 'machine:box-5.invalid']);
    expect(ids.filter(id => id === 'ag-box-1.invalid/pinned')).toHaveLength(1);
    expect(ids.indexOf('ag-box-1.invalid/pinned')).toBeLessThan(ids.indexOf('ag-box-1.invalid/unpinned'));
    expect(ids.indexOf('ag-proxy')).toBeGreaterThan(ids.indexOf('machine:box-2.invalid'));
    expect(ids.indexOf('ag-proxy')).toBeLessThan(ids.indexOf('machine:box-3.invalid'));
    expect(texts(root)).toContain('This computer');
    expect(test.hcCalls.filter(args => args[1] === 'rm' || args[1] === 'add')).toEqual([]);
  });

  it(`${version}: focuses an agent's existing pane in a remote-owned space`, async () => {
    const test = fixture(version);
    Object.assign(test.nativeAgents[0], { space: 'remote-space', space_name: 'Remote' });
    test.spaces.push({ id: 'remote-space', index: 2, name: 'Remote', machine: 'box-1.invalid', active: false, tabs: [] } as any);
    await test.ready();
    const root = test.view.render(test.cx);
    byId(root, 'ag-box-1.invalid/unpinned')!.events.on_click();
    expect(test.commands).toContainEqual(['pane.focus', { pane: 'p1' }]);
    expect(test.commands.filter(([name]) => name === 'space.move' || name === 'space.new')).toEqual([]);
  });

  it(`${version}: disables a disconnected remote pane but keeps a local proxy selectable`, async () => {
    const test = fixture(version);
    test.inventory[0].state = 'disconnected';
    test.layouts.find(item => item.name === 'box-1.invalid')!.layout = 'unavailable';
    await test.ready();
    let root = test.view.render(test.cx);
    const remote = byId(root, 'ag-box-1.invalid/unpinned')!;
    expect(remote).toBeDefined();
    expect(remote.events.on_click).toBeUndefined();
    byId(root, 'ag-proxy')!.events.on_click();
    expect(test.commands.filter(([name]) => name === 'pane.focus')).toEqual([['pane.focus', { pane: 'p4' }]]);
    test.failRemote();
    await test.view.spiderConnections.refresh();
    root = test.view.render(test.cx);
    expect(byId(root, 'ag-box-1.invalid/unpinned')!.events.on_click).toBeUndefined();
  });

  it(`${version}: rechecks a remote row when its machine disconnects before the click`, async () => {
    const test = fixture(version);
    await test.ready();
    const row = byId(test.view.render(test.cx), 'ag-box-1.invalid/unpinned')!;
    expect(row.events.on_click).toBeDefined();
    test.inventory[0].state = 'needs_login';
    await test.view.spiderConnections.refresh();
    row.events.on_click();
    expect(test.commands.filter(([name]) => name === 'pane.focus')).toEqual([]);
  });

  it(`${version}: gives every known idle machine a dot, dims failed observations, and copies login guidance`, async () => {
    const test = fixture(version);
    await test.ready();
    let root = test.view.render(test.cx);
    expect(call(byId(root, 'machine-dot-local')!, 'bg')).toEqual([palette.ansi2]);
    expect(call(byId(root, 'machine-dot-remote:box-1.invalid')!, 'bg')).toEqual([palette.ansi2]);
    expect(call(byId(root, 'machine-dot-remote:box-2.invalid')!, 'bg')).toEqual([palette.dim]);
    expect(call(byId(root, 'machine-dot-remote:box-3.invalid')!, 'bg')).toEqual([palette.dim]);
    expect(call(byId(root, 'machine-dot-remote:box-4.invalid')!, 'bg')).toEqual([palette.ansi2]);
    expect(call(byId(root, 'machine-dot-remote:box-5.invalid')!, 'bg')).toEqual([palette.dim]);
    const localHeading = byId(root, 'machine:')!, remoteHeading = byId(root, 'machine:box-3.invalid')!;
    expect(localHeading.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/monitor.svg')).toBe(true);
    expect(remoteHeading.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/server.svg')).toBe(true);
    expect(call(localHeading, 'tooltip')).toEqual(['This computer · connected']);
    expect(call(remoteHeading, 'tooltip')).toEqual(['box-3.invalid · needs login']);
    expect(byId(root, 'machine-reconnect-local')).toBeUndefined();
    byId(root, 'machine-login-copy-box-3.invalid')!.events.on_click({}, test.cx);
    expect(test.copied).toEqual(['hc machine login box-3.invalid']);
    test.failRemote();
    await test.view.spiderConnections.refresh();
    root = test.view.render(test.cx);
    expect(call(byId(root, 'machine-dot-remote:box-1.invalid')!, 'bg')).toEqual([palette.dim]);
    expect(call(byId(root, 'machine-dot-local')!, 'bg')).toEqual([palette.ansi2]);
    expect(test.snapshots.at(-1).machines.find((item: any) => item.name === 'box-1.invalid')).toEqual({ name: 'box-1.invalid', layout: 'unavailable' });
    expect(test.hcCalls.filter(args => args[1] === 'rm' || args[1] === 'add')).toEqual([]);
  });

  it(`${version}: offers selectable login guidance when clipboard support is absent`, async () => {
    const test = fixture(version, { clipboard: false });
    await test.ready();
    let root = test.view.render(test.cx);
    byId(root, 'machine-login-copy-box-3.invalid')?.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    const login = byId(root, 'machine-login-text-box-3.invalid')!;
    expect(call(login, 'selectable')).toEqual([true]);
    expect(login.children).toContain('hc machine login box-3.invalid');
    expect(texts(root)).toContain("Copy isn't available in this Herdr version");
    expect(byId(root, 'machine-login-copy-box-3.invalid')).toBeDefined();
    expect(test.copied).toEqual([]);
  });

  it(`${version}: reports a clipboard capability lost between render and click`, async () => {
    const test = fixture(version);
    await test.ready();
    let root = test.view.render(test.cx);
    const eventCx = { ...test.cx, write_to_clipboard: undefined };
    byId(root, 'machine-login-copy-box-3.invalid')!.events.on_click({}, eventCx);
    root = test.view.render(test.cx);
    expect(texts(root)).toContain("Copy isn't available in this Herdr version");
    expect(call(byId(root, 'machine-login-text-box-3.invalid')!, 'selectable')).toEqual([true]);
    expect(test.copied).toEqual([]);
  });

  it(`${version}: escapes untrusted machine names in selectable login guidance`, async () => {
    const test = fixture(version, { clipboard: false });
    test.inventory.push({ name: 'box<&', id: 'core-unsafe', state: 'needs_login', target: 'ssh-unsafe.invalid' } as any);
    test.layouts.push({ name: 'box<&', layout: 'ready' });
    await test.ready();
    const root = test.view.render(test.cx);
    byId(root, 'machine-login-copy-box<&')?.events.on_click({}, test.cx);
    const login = byId(test.view.render(test.cx), 'machine-login-text-box<&')!;
    expect(call(login, 'selectable')).toEqual([true]);
    expect(login.children).toContain('hc machine login &#39;box&lt;&amp;&#39;');
  });

  it(`${version}: falls back visibly if a clipboard write throws`, async () => {
    const test = fixture(version);
    await test.ready();
    let root = test.view.render(test.cx);
    const eventCx = { ...test.cx, write_to_clipboard: () => { throw new Error('unavailable'); } };
    expect(() => byId(root, 'machine-login-copy-box-3.invalid')!.events.on_click({}, eventCx)).not.toThrow();
    root = test.view.render(test.cx);
    expect(texts(root)).toContain("Copy isn't available in this Herdr version");
    expect(call(byId(root, 'machine-login-text-box-3.invalid')!, 'selectable')).toEqual([true]);
  });

  it(`${version}: keeps a disconnected temporary idle machine as a heading`, async () => {
    const test = fixture(version);
    test.inventory.push({ name: 'box-6.invalid', id: 'core-6', state: 'disconnected', target: 'ssh-six.invalid', temporary: true } as any);
    test.layouts.push({ name: 'box-6.invalid', layout: 'unavailable' });
    await test.ready();
    const root = test.view.render(test.cx);
    expect(byId(root, 'machine:box-6.invalid')).toBeDefined();
    expect(call(byId(root, 'machine-dot-remote:box-6.invalid')!, 'bg')).toEqual([palette.dim]);
  });

  it(`${version}: counts only live reachable children when a machine group is folded`, async () => {
    const test = fixture(version);
    test.layouts.push({ name: 'box-5.invalid', layout: 'unavailable' });
    test.nativeTerminals.push(
      { ...terminal('run-live', { 'spider.kind': 'subagent-viewer', 'spider.run': 'run-live' }), parent: 'local', status: 'working' },
      { ...terminal('box-4.invalid/console', { 'spider.kind': 'remote-console', 'spider.machine': 'box-4.invalid' }), parent: 'local' },
      { ...terminal('box-5.invalid/away', { 'spider.kind': 'remote-console', 'spider.machine': 'box-5.invalid' }), parent: 'local' },
      { ...terminal('run-old', { 'spider.kind': 'subagent-viewer', 'spider.run': 'run-old' }), parent: 'local', state: 'finished', finishedAt: Date.now(), exitCode: 0, reason: 'exited' } as any,
    );
    await test.ready();
    let root = test.view.render(test.cx);
    byId(root, 'machine:')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'machine-subagents-local')!.children).toContain('1');
    expect(byId(root, 'machine-consoles-local')!.children).toContain('1');
    expect(byId(root, 'machine-agents-local')!.children).toContain('1');
    expect(call(byId(root, 'machine-subagents-local')!, 'bg')).toEqual([palette.hover]);
    expect(call(byId(root, 'machine-consoles-local')!, 'bg')).toEqual([palette.hover]);
  });

  it(`${version}: reconnects only from the remote heading action`, async () => {
    const test = fixture(version);
    await test.ready();
    const root = test.view.render(test.cx);
    byId(root, 'machine:box-2.invalid')!.events.on_click({}, test.cx);
    expect(test.hcCalls.filter(args => args[1] === 'rm' || args[1] === 'add')).toEqual([]);
    await byId(root, 'machine-reconnect-box-2.invalid')!.events.on_click({}, test.cx);
    expect(test.hcCalls.filter(args => args[1] === 'rm' || args[1] === 'add')).toEqual([
      ['machine', 'rm', 'box-2.invalid', '--json'],
      ['machine', 'add', 'ssh-two.invalid', '--name', 'box-2.invalid', '--temp', '--json'],
    ]);
  });

  it(`${version}: identifies a rebuilt remote machine before explicit recovery`, async () => {
    const test = fixture(version);
    Object.assign(test.inventory[1], { state: 'unreachable', why: 'a different core answers there ("new-core")' });
    await test.ready();
    const root = test.view.render(test.cx);
    expect(byId(root, 'machine-rebuilt-box-2.invalid')!.children).toContain('Rebuilt');
    expect(call(byId(root, 'machine-rebuilt-box-2.invalid')!, 'tooltip')).toEqual(['This machine was rebuilt or replaced. Reconnect to its new core.']);
    expect(test.hcCalls.filter(args => args[1] === 'rm' || args[1] === 'add')).toEqual([]);
  });

  it(`${version}: shows a reconnect error without automatically retrying`, async () => {
    const test = fixture(version);
    test.failAdd();
    await test.ready();
    let root = test.view.render(test.cx);
    await byId(root, 'machine-reconnect-box-2.invalid')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'machine-error-box-2.invalid')!.children).toContain('login required');
    expect(call(byId(root, 'machine-reconnect-box-2.invalid')!, 'tooltip')).toEqual(['login required']);
    await test.view.spiderConnections.refresh();
    test.view.render(test.cx);
    expect(test.hcCalls.filter(args => args[1] === 'rm')).toHaveLength(1);
    expect(test.hcCalls.filter(args => args[1] === 'add')).toHaveLength(1);
  });

  it(`${version}: renders numeric titles for agents sharing a native tab`, async () => {
    const test = fixture(version);
    test.spaces[0].tabs[0].name = '42';
    test.nativeAgents.forEach(item => { item.title = '42'; });
    await test.ready();
    expect(() => test.view.render(test.cx)).not.toThrow();
    expect(texts(test.view.render(test.cx))).toContain('42');
  });

  it(`${version}: dispatches parked activation only on click and uses the verified current opener`, async () => {
    const test = fixture(version);
    const sessionId = 'session/a b';
    const target: any = { id: `session:${sessionId}`, kind: 'agent', ownerId: null, sessionId, terminal: 'box-1.invalid/owner', pane: null, space: 's1', tab: 'tab', name: 'Parked Writer', path: '/fixture', status: 'idle', machine: 'box-1.invalid', retained: false,
      action: { kind: 'ipc', descriptor: { version: 1, sessionId, generation: 'gen', address: 'endpoint', capabilityFile: 'cap' }, request: { op: 'openSession', generation: 'gen', destination: null } } };
    test.targets.push(target);
    await test.ready();
    const root = test.view.render(test.cx);
    expect(test.execCalls).toEqual([]);
    expect(test.commands.filter(([name]) => name.startsWith('spider-agents.activate-session:'))).toEqual([]);
    expect(test.snapshots.at(-1)).toMatchObject({ coreId: 'local-core', machines: expect.arrayContaining([{ name: 'box-1.invalid', layout: 'ready', coreId: 'core-1' }]) });
    const row = byId(root, `parked-session:${encodeURIComponent(sessionId)}`)!;
    expect(row).toBeDefined();
    expect(texts(root)).toContain('Parked Writer');
    await test.view.spiderConnections.refresh();
    expect(test.execCalls).toEqual([]);
    const started = test.waitForExec();
    row.events.on_click({}, test.cx);
    await started;
    expect(test.commands.filter(([name]) => name.startsWith('spider-agents.activate-session:'))).toEqual([[`spider-agents.activate-session:${encodeURIComponent(sessionId)}`, undefined]]);
    const request = JSON.parse((test.execCalls[0][1] as string[])[1]);
    expect(request.request).toMatchObject({ op: 'openSession', generation: 'gen' });
    expect(request.descriptor.sessionId).toBe(sessionId);

    target.pane = 'reopened-pane';
    target.action = { kind: 'focus', pane: 'reopened-pane' } as any;
    test.nativeAgents.push(agent('box-1.invalid/owner', 'reopened-pane'));
    const reopened = test.view.render(test.cx);
    expect(byId(reopened, `parked-session:${encodeURIComponent(sessionId)}`)).toBeUndefined();
    expect(all(reopened).filter(node => node.id === 'ag-box-1.invalid/owner')).toHaveLength(1);
  });

  it(`${version}: Enter dispatches the same parked-session activation command`, async () => {
    const test = fixture(version);
    test.targets.push({ id: 'session:one', kind: 'agent', ownerId: null, sessionId: 'one', terminal: 'local', pane: null, space: 's1', tab: 'tab', name: 'Parked', status: 'idle', machine: null, retained: false,
      action: { kind: 'ipc', descriptor: { sessionId: 'one' }, request: { op: 'openSession', generation: 'gen', destination: null } } });
    await test.ready();
    const row = byId(test.view.render(test.cx), 'parked-session:one')!;
    const started = test.waitForExec();
    row.events.on_key_down({ key: 'enter' }, test.cx);
    await started;
    expect(test.commands.filter(([name]) => name.startsWith('spider-agents.activate-session:'))).toEqual([['spider-agents.activate-session:one', undefined]]);
    expect(test.execCalls).toHaveLength(1);
  });

  it(`${version}: coalesces repeated parked activations while the opener is pending`, async () => {
    const test = fixture(version);
    test.targets.push({ id: 'session:one', kind: 'agent', ownerId: null, sessionId: 'one', terminal: 'local', pane: null, space: 's1', tab: 'tab', name: 'Parked', status: 'idle', machine: null, retained: false,
      action: { kind: 'ipc', descriptor: { sessionId: 'one' }, request: { op: 'openSession', generation: 'gen', destination: null } } });
    let release!: (value: ReturnType<typeof ok>) => void;
    test.setExec(() => new Promise(resolve => { release = resolve; }));
    await test.ready();
    const row = byId(test.view.render(test.cx), 'parked-session:one')!;
    const started = test.waitForExec();
    row.events.on_click({}, test.cx);
    await started;
    row.events.on_click({}, test.cx);
    await Promise.resolve();
    await test.send('sort-machine');
    expect(test.execCalls).toHaveLength(1);
    release(ok({ ok: true, op: 'openSession', terminal: 'local' }));
  });

  it(`${version}: reports an old opener without retrying an uncertain dispatch`, async () => {
    const test = fixture(version);
    test.targets.push({ id: 'session:one', kind: 'agent', ownerId: null, sessionId: 'one', terminal: 'local', pane: null, space: 's1', tab: 'tab', name: 'Parked', status: 'idle', machine: null, retained: false,
      action: { kind: 'ipc', descriptor: { sessionId: 'one' }, request: { op: 'openSession', generation: 'gen', destination: null } } });
    let release!: (value: ReturnType<typeof ok>) => void;
    test.setExec(() => new Promise(resolve => { release = resolve; }));
    await test.ready();
    const row = byId(test.view.render(test.cx), 'parked-session:one')!;
    const started = test.waitForExec();
    row.events.on_click({}, test.cx);
    await started;
    const settled = test.waitForNotice();
    release({ code: 1, stdout: JSON.stringify({ ok: false, code: 'unknown-op', message: 'Unknown operation' }), stderr: '' });
    await settled;
    expect(test.view.spiderFeedError).toBe('Run /reload to enable session reopening');
    expect(test.execCalls).toHaveLength(1);
  });

  it(`${version}: explains a timed out session open in plain words`, async () => {
    const test = fixture(version);
    test.targets.push({ id: 'session:one', kind: 'agent', ownerId: null, sessionId: 'one', terminal: 'local', pane: null, space: 's1', tab: 'tab', name: 'Parked', status: 'idle', machine: null, retained: false,
      action: { kind: 'ipc', descriptor: { sessionId: 'one' }, request: { op: 'openSession', generation: 'gen', destination: null } } });
    test.setExec(async () => ok({ ok: false, code: 'unavailable', message: 'pane-timeout' }));
    await test.ready();
    await test.view.activateSession('one');
    expect(test.view.spiderFeedError).toBe('Timed out opening the pane');
  });

  it(`${version}: ignores stale or malformed parked commands and handles the three sort commands`, async () => {
    const test = fixture(version);
    await test.ready();
    for (const [command, selected] of [['sort-priority', 'priority'], ['sort-space', 'grouped'], ['sort-machine', 'machine']] as const) {
      await test.send(command);
      expect(test.state.get('agents.sort')).toBe(selected);
      const rendered = test.view.render(test.cx);
      expect(all(rendered).filter(node => node.id === 'ag-box-1.invalid/pinned')).toHaveLength(1);
      expect(Boolean(byId(rendered, 'machine:box-1.invalid'))).toBe(selected === 'machine');
      if (selected === 'machine') {
        expect(texts(rendered)).toContain('This computer');
        expect(byId(rendered, 'machine:box-4.invalid')).toBeDefined();
        expect(byId(rendered, 'ag-box-4.invalid')).toBeUndefined();
      } else if (selected === 'grouped') expect(texts(rendered)).toContain('Work');
    }
    await test.send('activate-session:%E0%A4%A');
    await test.send('activate-session:missing');
    test.targets.push({ id: 'session:stale', kind: 'agent', ownerId: null, sessionId: 'stale', terminal: 'local', pane: null, name: 'Unavailable', status: 'idle', machine: null, retained: false, action: null });
    await test.send('activate-session:stale');
    expect(test.execCalls).toEqual([]);
  });

  it(`${version}: keeps parked sessions visible in all three sorts`, async () => {
    const test = fixture(version);
    test.targets.push({ id: 'session:one', kind: 'agent', ownerId: null, sessionId: 'one', terminal: 'local', pane: null, space: 's1', tab: 'tab', name: 'Parked', status: 'idle', machine: null, retained: false, action: null });
    await test.ready();
    for (const command of ['sort-priority', 'sort-space', 'sort-machine']) {
      await test.send(command);
      expect(all(test.view.render(test.cx)).filter(node => node.id === 'parked-session:one')).toHaveLength(1);
    }
  });

  it(`${version}: labels parked primaries and shows their owning machines`, async () => {
    const test = fixture(version);
    test.targets.push(
      { id: 'session:local', kind: 'agent', ownerId: null, sessionId: 'local', terminal: 'local', pane: null, space: 's1', tab: 'tab', name: 'Local Writer', status: 'idle', machine: null, retained: false, action: null },
      { id: 'session:remote', kind: 'agent', ownerId: null, sessionId: 'remote', terminal: 'box-1.invalid/parked', pane: null, space: 's1', tab: 'tab', name: 'Remote Writer', status: 'idle', machine: 'box-1.invalid', retained: false, action: null },
    );
    await test.ready();
    const root = test.view.render(test.cx);
    expect(byId(root, 'parked-session:local')).toBeDefined();
    expect(byId(root, 'parked-session:remote')).toBeDefined();
    expect(byId(root, 'parked-label:local')!.children).toContain('Parked');
    expect(byId(root, 'parked-machine:local')!.children).toContain('This computer');
    expect(byId(root, 'parked-label:remote')!.children).toContain('Parked');
    expect(byId(root, 'parked-machine:remote')!.children).toContain('box-1.invalid');
  });

  it(`${version}: replays both complete sidebar fragments and syntax-checks the final modules`, () => {
    const agents: SpacesAPatch[] = JSON.parse(readFileSync(`packages/herdr/assets/look/spaces-a-sidebar/agents-${version}.json`, 'utf8'));
    const spaces: SpacesAPatch[] = JSON.parse(readFileSync(`packages/herdr/assets/look/spaces-a-sidebar/spaces-${version}.json`, 'utf8'));
    const fragments = { agents, spaces };
    const first = replaySpacesARecipe(version, loadSpacesAFiles(version), fragments);
    expect(replaySpacesARecipe(version, first, fragments)).toEqual(first);
    for (const name of ['agents', 'spaces']) {
      const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: first[name]['main.js'], encoding: 'utf8' });
      expect(checked.status, checked.stderr).toBe(0);
    }
  });

  it(`${version}: cancels the owned feed watch before re-arming and on close`, async () => {
    const test = fixture(version, { feedRoot: true });
    await test.waitForWatches(1);
    const rearmed = test.waitForWatches(2);
    test.watches[0].finish(['/fixture/feeds/sessions/changed']);
    await rearmed;
    expect(test.watches[0].cancelled).toBeGreaterThan(0);
    await test.view.close();
    expect(test.watches[1].cancelled).toBeGreaterThan(0);
    expect(test.readerClosed).toBe(1);
  });

  it(`${version}: shows folded Consoles groups without hiding sibling subagents in every sort`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    for (const command of ['sort-priority', 'sort-space', 'sort-machine']) {
      await test.send(command);
      const root = test.view.render(test.cx);
      const group = byId(root, consoleId('local'))!;
      expect(group).toBeDefined();
      expect(byId(root, consoleId('local', 'run-local'))).toBeDefined();
      expect(byId(root, consoleId('box-1.invalid/pinned'))).toBeUndefined();
      expect(byId(root, 'sub-run-local')).toBeDefined();
      expect(byId(root, 'sub-console:box-4.invalid/console-a')).toBeUndefined();
      expect(group.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/chevron-right.svg')).toBe(true);
      expect(group.children.flatMap(all).flatMap(node => node.children)).toContain('Consoles');
      expect(group.children.flatMap(all).flatMap(node => node.children)).toContain('1');
      expect(call(group, 'accessibility_label')).toEqual(['Consoles, 1, collapsed']);
      expect(call(group, 'tab_index')).toEqual([0]);
    }
  });

  it(`${version}: expands only the selected owner's consoles and preserves console actions`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    let root = test.view.render(test.cx);
    byId(root, consoleId('local'))!.events.on_click({}, test.cx);
    expect(test.execCalls).toEqual([]);
    expect(test.commands.filter(([name]) => name === 'pane.focus' || name === 'terminal.peek')).toEqual([]);
    root = test.view.render(test.cx);
    const open = byId(root, consoleId('local'))!;
    expect(open.children.flatMap(all).some(node => node.svg === 'mods/workspace-chrome/chevron-down.svg')).toBe(true);
    expect(call(open, 'accessibility_label')).toEqual(['Consoles, 1, expanded']);
    expect(byId(root, 'sub-console:box-4.invalid/console-a')).toBeDefined();
    const machinePill = byId(root, 'child-machine:console:box-4.invalid/console-a')!;
    expect(machinePill.children).toContain('box-4.invalid');
    expect(call(machinePill, 'bg')).toEqual([palette.hover]);
    expect(byId(root, 'sub-job-a')).toBeUndefined();
    expect(byId(root, 'sub-console:box-4.invalid/nested')).toBeUndefined();
    expect(byId(root, 'sub-console:box-2.invalid/console-b')).toBeUndefined();
    test.setExec(async () => ok({ ok: true, op: 'openJob', viewer: 'console-pane' }));
    const started = test.waitForExec();
    byId(root, 'sub-console:box-4.invalid/console-a')!.events.on_click({}, test.cx);
    await started;
    const request = JSON.parse((test.execCalls[0][1] as string[])[1]);
    expect(request.request).toMatchObject({ op: 'openJob', jobId: 'console:box-4.invalid/console-a' });
  });

  it(`${version}: expands nested consoles independently of their owner and subagent fold`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    let root = test.view.render(test.cx);
    byId(root, consoleId('local', 'run-local'))!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-console:box-4.invalid/nested')).toBeDefined();
    expect(byId(root, 'sub-console:box-4.invalid/console-a')).toBeUndefined();
    byId(root, 'child-fold-run-local')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, consoleId('local', 'run-local'))).toBeUndefined();
    await test.send(`console-group-toggle:${encodeURIComponent(consoleKey('local', 'run-local'))}`);
    byId(root, 'child-fold-run-local')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-console:box-4.invalid/nested')).toBeDefined();
    expect(call(byId(root, consoleId('local', 'run-local'))!, 'accessibility_label')).toEqual(['Consoles, 1, expanded']);
  });

  it(`${version}: keeps machine and agent folds independent when their keys collide`, async () => {
    const test = fixture(version);
    const address = 'machine:box-1.invalid';
    test.nativeAgents.push(agent(address, 'collision-pane'));
    test.nativeTerminals.push(terminal(address), { ...terminal('collision-child', { 'spider.kind': 'subagent-viewer', 'spider.run': 'collision-run' }), parent: address });
    await test.ready();
    let root = test.view.render(test.cx);
    expect(byId(root, 'sub-collision-run')).toBeDefined();
    byId(root, 'machine:box-1.invalid')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'ag-box-1.invalid/unpinned')).toBeUndefined();
    expect(byId(root, 'sub-collision-run')).toBeDefined();
    byId(root, 'fold-left-machine:box-1.invalid')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-collision-run')).toBeUndefined();
    byId(root, 'machine:box-1.invalid')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'ag-box-1.invalid/unpinned')).toBeDefined();
    expect(byId(root, 'sub-collision-run')).toBeUndefined();
  });

  it(`${version}: keeps a qualified remote subagent and its console under the remote owner`, async () => {
    const test = fixture(version);
    test.nativeTerminals.push(
      { ...terminal('box-1.invalid/sub', { 'spider.kind': 'subagent-viewer', 'spider.run': 'remote-run' }), parent: 'box-1.invalid/pinned', status: 'working' },
      { ...terminal('box-4.invalid/remote-console', { 'spider.kind': 'remote-console', 'spider.machine': 'box-4.invalid', 'spider.run': 'remote-run' }), parent: 'box-1.invalid/sub' },
    );
    await test.ready();
    let root = test.view.render(test.cx);
    expect(byId(root, 'sub-remote-run')).toBeDefined();
    const nested = byId(root, consoleId('box-1.invalid/pinned', 'remote-run'))!;
    expect(nested).toBeDefined();
    nested.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-console:box-4.invalid/remote-console')).toBeDefined();
    expect(byId(root, 'child-machine:console:box-4.invalid/remote-console')!.children).toContain('box-4.invalid');
  });

  it(`${version}: disables a stale remote console action and removes it from live counts`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    let root = test.view.render(test.cx);
    byId(root, consoleId('local'))!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    const oldConsole = byId(root, 'sub-console:box-4.invalid/console-a')!;
    expect(oldConsole.events.on_click).toBeDefined();
    test.failRemote();
    await test.view.spiderConnections.refresh();
    oldConsole.events.on_click({}, test.cx);
    expect(test.execCalls).toEqual([]);
    root = test.view.render(test.cx);
    expect(byId(root, consoleId('local'))).toBeUndefined();
    expect(byId(root, 'sub-console:box-4.invalid/console-a')).toBeUndefined();
  });

  it(`${version}: excludes an unavailable remote native child from focus and live counts`, async () => {
    const test = fixture(version);
    test.nativeTerminals.push({ ...terminal('box-4.invalid/native-child'), parent: 'local' });
    test.nativeAgents.push(agent('box-4.invalid/native-child', 'child-pane'));
    await test.ready();
    let root = test.view.render(test.cx);
    const oldChild = byId(root, 'sub-box-4.invalid/native-child')!;
    expect(oldChild.events.on_click).toBeDefined();
    test.inventory.find(machine => machine.name === 'box-4.invalid')!.state = 'disconnected';
    await test.view.spiderConnections.refresh();
    oldChild.events.on_click({}, test.cx);
    expect(test.commands.filter(([name]) => name === 'pane.focus')).toEqual([]);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-box-4.invalid/native-child')!.events.on_click).toBeUndefined();
    byId(root, 'machine:')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(Boolean(byId(root, 'machine-subagents-local'))).toBe(false);
  });

  it(`${version}: disables a remote owner's child when the owner disconnects`, async () => {
    const test = fixture(version);
    test.nativeTerminals.push({ ...terminal('box-4.invalid/remote-owner-console', { 'spider.kind': 'remote-console', 'spider.machine': 'box-4.invalid', 'spider.session': 'remote-session' }), parent: 'box-1.invalid/pinned' });
    test.view.spiderFeeds.push({ sessionId: 'remote-session', generation: 'gen', lifecycle: 'live', updatedAt: Date.now(), owner: { sessionId: 'remote-session', generation: 'gen', name: 'Remote', terminal: { address: 'box-1.invalid/pinned' } }, ipc: { address: 'endpoint', capabilityFile: 'cap' }, runs: { rows: [] } });
    await test.ready();
    let root = test.view.render(test.cx);
    byId(root, consoleId('box-1.invalid/pinned'))!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    const oldConsole = byId(root, 'sub-console:box-4.invalid/remote-owner-console')!;
    expect(oldConsole.events.on_click).toBeDefined();
    test.inventory[0].state = 'disconnected';
    await test.view.spiderConnections.refresh();
    oldConsole.events.on_click({}, test.cx);
    expect(test.execCalls).toEqual([]);
    root = test.view.render(test.cx);
    expect(byId(root, consoleId('box-1.invalid/pinned'))).toBeUndefined();
    expect(byId(root, 'sub-console:box-4.invalid/remote-owner-console')).toBeUndefined();
  });

  it(`${version}: leaves command history folded until its individual console is opened`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    let root = test.view.render(test.cx);
    byId(root, consoleId('local'))!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-job-a')).toBeUndefined();
    byId(root, 'console-fold-console:box-4.invalid/console-a')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-job-a')).toBeDefined();
    expect(call(byId(root, consoleId('local'))!, 'accessibility_label')).toEqual(['Consoles, 1, expanded']);
    expect(test.execCalls).toEqual([]);
  });

  it(`${version}: leaves raw navigation children unchanged by sidebar folds`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    const raw = () => children.projectAgentChildren(test.nativeTerminals, test.view.spiderFeeds, 'local', HerdrLabelContract, { machines: test.layouts as any })
      .filter(row => row.kind === 'console').map(row => row.originalAddress).sort();
    const before = raw();
    expect(before).toEqual(['box-4.invalid/console-a', 'box-4.invalid/nested', 'box-5.invalid/console-away']);
    let root = test.view.render(test.cx);
    byId(root, consoleId('local'))!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    byId(root, consoleId('local', 'run-local'))!.events.on_click({}, test.cx);
    expect(raw()).toEqual(before);
  });

  it(`${version}: hides a retained-only console group until finished rows are requested`, async () => {
    const test = fixture(version);
    test.nativeTerminals.push({ ...terminal('box-4.invalid/old', { 'spider.kind': 'remote-console', 'spider.machine': 'box-4.invalid' }), parent: 'local', state: 'finished', finishedAt: Date.now(), exitCode: 0, reason: 'exited' });
    await test.ready();
    let root = test.view.render(test.cx);
    expect(byId(root, consoleId('local'))).toBeUndefined();
    expect(byId(root, 'sub-console:box-4.invalid/old')).toBeUndefined();
    byId(root, 'finished-toggle-local')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(call(byId(root, consoleId('local'))!, 'accessibility_label')).toEqual(['Consoles, 0, collapsed']);
    byId(root, consoleId('local'))!.events.on_click({}, test.cx);
    expect(byId(test.view.render(test.cx), 'sub-console:box-4.invalid/old')).toBeDefined();
  });

  it(`${version}: keeps a parked primary's children and consoles under that owner`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    test.nativeAgents.splice(test.nativeAgents.findIndex(item => item.address === 'local'), 1);
    test.targets.push({ id: 'session:session-one', kind: 'agent', ownerId: null, sessionId: 'session-one', terminal: 'local', pane: null, space: 's1', tab: 'tab', name: 'Parked Writer', status: 'idle', machine: null, retained: false,
      action: { kind: 'ipc', descriptor: { sessionId: 'session-one' }, request: { op: 'openSession', generation: 'gen', destination: null } } });
    await test.ready();
    let root = test.view.render(test.cx);
    expect(byId(root, 'parked-session:session-one')).toBeDefined();
    expect(byId(root, 'sub-run-local')).toBeDefined();
    expect(byId(root, consoleId('local'))).toBeDefined();
    byId(root, consoleId('local'))!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-console:box-4.invalid/console-a')).toBeDefined();
    expect(test.execCalls).toEqual([]);
    byId(root, 'machine:')!.events.on_click({}, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'machine-agents-local')!.children.filter(value => typeof value === 'string')).toContain('1');
    expect(byId(root, 'machine-subagents-local')!.children.filter(value => typeof value === 'string')).toContain('1');
    expect(byId(root, 'machine-consoles-local')!.children.filter(value => typeof value === 'string')).toContain('2');
  });

  it(`${version}: Enter and Space toggle a console group without focusing a terminal`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    let root = test.view.render(test.cx);
    byId(root, consoleId('local'))!.events.on_key_down({ key: 'enter' }, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-console:box-4.invalid/console-a')).toBeDefined();
    byId(root, consoleId('local'))!.events.on_key_down({ keystroke: { key: 'space' } }, test.cx);
    root = test.view.render(test.cx);
    expect(byId(root, 'sub-console:box-4.invalid/console-a')).toBeUndefined();
    expect(test.commands.filter(([name]) => name === 'pane.focus' || name === 'terminal.peek')).toEqual([]);
    expect(test.execCalls).toEqual([]);
  });

  it(`${version}: validates console commands and hides a group with no live consoles`, async () => {
    const test = fixture(version);
    seedConsoles(test);
    await test.ready();
    const key = consoleKey('local');
    await test.send(`console-group-toggle:${encodeURIComponent(key)}`);
    expect(byId(test.view.render(test.cx), 'sub-console:box-4.invalid/console-a')).toBeDefined();
    await test.send('console-group-toggle:%E0%A4%A');
    await test.send(`console-group-toggle:${encodeURIComponent('console-group:["missing",null]')}`);
    expect(byId(test.view.render(test.cx), 'sub-console:box-4.invalid/console-a')).toBeDefined();
    test.nativeTerminals.splice(test.nativeTerminals.findIndex(item => item.address === 'box-4.invalid/console-a'), 1);
    let root = test.view.render(test.cx);
    expect(byId(root, consoleId('local'))).toBeUndefined();
    expect(byId(root, 'sub-console:box-5.invalid/console-away')).toBeUndefined();
    const [away] = test.nativeTerminals.splice(test.nativeTerminals.findIndex(item => item.address === 'box-5.invalid/console-away'), 1);
    root = test.view.render(test.cx);
    expect(byId(root, consoleId('local'))).toBeUndefined();
    await test.send(`console-group-toggle:${encodeURIComponent(key)}`);
    expect(byId(test.view.render(test.cx), consoleId('local'))).toBeUndefined();
    test.nativeTerminals.push(away);
    root = test.view.render(test.cx);
    expect(byId(root, consoleId('local'))).toBeUndefined();
    expect(test.execCalls).toEqual([]);
  });

  it(`${version}: tolerates malformed stored status and pin data`, async () => {
    let test!: ReturnType<typeof fixture>;
    expect(() => { test = fixture(version, { corruptStorage: true }); }).not.toThrow();
    await test.ready();
    expect(() => test.view.render(test.cx)).not.toThrow();
    expect(test.commands.filter(([name]) => name === 'terminal.pin')).toEqual([]);
  });

  it(`${version}: keeps both existing sort options and adds the machine option`, () => {
    const test = fixture(version, { sortMenu: true });
    const root = test.view.render(test.cx);
    expect(['sort-priority', 'sort-grouped', 'sort-machine'].map(id => Boolean(byId(root, id)))).toEqual([true, true, true]);
    byId(root, 'sort-machine')!.events.on_click();
    expect(test.state.get('agents.sort')).toBe('machine');
  });
}

it('0.1.16: starts no Agents side effects while the app checks the mod', () => {
  const test = fixture('0.1.16', { checking: true, feedRoot: true });
  expect(() => test.view.render(test.cx)).not.toThrow();
  expect(test.timers).toEqual([]);
  expect(test.hcCalls).toEqual([]);
  expect(test.execCalls).toEqual([]);
  expect(test.waits).toEqual([]);
  expect(test.watches).toEqual([]);
  expect(test.stored.size).toBe(0);
});
