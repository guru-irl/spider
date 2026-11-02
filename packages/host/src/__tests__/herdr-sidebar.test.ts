// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { configFixtureCwd } from './herdr-config-fixture.js';
import { createHerdrHarness, type HerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { HerdrLabelContract } from '../../../herdr/src/contracts.js';

// A fenced setup must not inspect other pi sessions on this host.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});

const fixture = process.env.SPIDER_HERDR_MOD_FIXTURE;
if (!fixture) console.info('SKIP installed sidebar tests: set SPIDER_HERDR_MOD_FIXTURE to the upstream Herdr mods');
describe.skipIf(!fixture)('production-installed sidebar', () => {
let harness: HerdrHarness | undefined;
let ports: ReturnType<typeof createProductionHerdrCliPorts> | undefined;
let source: string;
let children: Record<string, unknown>;
let sharedFeed: Record<string, unknown>;
let doctorFailures: unknown;

beforeAll(async () => {
  harness = await createHerdrHarness('fake');
  const h = harness;
  await h.start();
  execFileSync('git', ['init', '-q', h.directories.local]);
  expect(h.localSocket).toContain(h.root);
  expect(h.remoteSocket).toContain(h.root);
  expect(h.localSocket).not.toContain('/default/default.sock');
  const root = join(h.root, 'package');
  await mkdir(join(root, 'packages/herdr'), { recursive: true });
  await cp(resolve('packages/herdr/assets'), join(root, 'packages/herdr/assets'), { recursive: true });
  await mkdir(join(root, 'dist/herdr'), { recursive: true });
  await writeFile(join(root, 'dist/herdr/remote-runtime.mjs'), stripTypeScriptTypes(await readFile(resolve('packages/herdr/src/remote/runtime.ts'), 'utf8')));
  await mkdir(join(h.directories.agent, 'sessions'), { recursive: true });
  for (const kind of ['agents', 'spaces', 'pane', 'tabs']) {
    const dir = join(h.directories.app, 'mods', kind);
    await mkdir(dir, { recursive: true });
    for (const file of ['main.js', 'mod.json']) await cp(join(fixture!, kind, file), join(dir, file));
  }
  await mkdir(join(h.directories.app, 'layouts'), { recursive: true });
  await writeFile(join(h.directories.app, 'layouts/main.json'), JSON.stringify({ children: [
    { id: 'sidebar', content: { mod: 'agents' } }, { id: 'spaces', content: { mod: 'spaces' } }, { id: 'tabs', content: { mod: 'tabs' } },
    { id: 'work-body', children: [{ id: 'main', content: { tab: 'active', pane: { header: { content: { mod: 'pane' } } } } },
      { id: 'panel', children: [{ id: 'panel-body', type: 'stack', children: [{ id: 'files' }, { id: 'changes' }] }] }] },
  ] }));
  await writeFile(join(h.directories.app, 'settings.json'), '{"theme":"stock"}');
  await writeFile(join(h.directories.agent, 'settings.json'), '{"theme":"stock"}');
  const script = join(h.root, 'app-selection.mjs');
  await writeFile(script, `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), path = process.env.HERDR_APP_HOME + '/settings.json';
if (args[0] === '--version') console.log('herdr-app 0.1.11');
else if (args[0] === 'do') { const settings = JSON.parse(readFileSync(path, 'utf8')); if (args[1] === 'layout.switch') settings.layout = args[args.indexOf('--name') + 1]; if (args[1] === 'app.theme') settings.theme = args[args.indexOf('--name') + 1]; writeFileSync(path, JSON.stringify(settings)); console.log('{}'); }
else console.log('{"spaces":[]}');\n`);
  const app = join(h.root, 'app-selection');
  await writeFile(app, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(app, 0o700);
  const configPath = join(h.root, 'config.json');
  await writeFile(configPath, JSON.stringify({ app: { binary: app, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'programs'), cwd: null, commands: {} } }] }));
  vi.spyOn(ModelRegistry.prototype, 'getAvailable').mockImplementation(function (this: ModelRegistry) { return this.getAll(); });
  ports = configFixtureCwd(createProductionHerdrCliPorts(root, { ...h.localEnv, SPIDER_GLOBAL_ROOT: h.directories.global }), h.directories.local);
  const request = await ports.request(configPath);
  try {
    const result = await setupHerdr(request, await ports.setupParts(request));
    expect(result.probes).toHaveLength(1);
    doctorFailures = result.doctor.failures;
  } catch (error: any) {
    if (error.code !== 'setup-verification-failed') throw error;
    doctorFailures = error.details.failures;
  }
  const agentDir = join(h.directories.app, 'mods/spider-agents');
  source = await readFile(join(agentDir, 'main.js'), 'utf8');
  children = await import(pathToFileURL(join(agentDir, 'spider-children.js')).href);
  sharedFeed = await import(pathToFileURL(join(agentDir, 'shared/feed.js')).href);
}, 120_000);

afterAll(async () => {
  await ports?.dispose();
  if (harness) {
    await harness.close();
    expect(await harness.remainingOwnedResources()).toEqual([]);
  }
  vi.restoreAllMocks();
}, 120_000);

interface Element { id?: string; children: unknown[]; click?: (...args: any[]) => void; color?: string }
const data = new WeakMap<object, Element>();
function ui(): Element {
  const target: Element = { children: [] };
  const proxy = new Proxy(target, { get(o, key) {
    if (key === 'when') return (on: boolean, fn: (el: Element) => unknown) => { if (on) fn(proxy); return proxy; };
    if (key === 'child') return (value: unknown) => { o.children.push(value); return proxy; };
    if (key === 'children') return (values: unknown[]) => { o.children.push(...values); return proxy; };
    if (key === 'id') return (id: string) => { o.id = id; return proxy; };
    if (key === 'on_click') return (fn: (...args: any[]) => void) => { o.click = fn; return proxy; };
    if (key === 'text_color') return (value: string) => { o.color = value; return proxy; };
    return () => proxy;
  } });
  data.set(proxy, target); return proxy;
}
function elements(root: Element): Element[] {
  const value = data.get(root) ?? root;
  return [value, ...value.children.filter(x => typeof x === 'object' && x !== null).flatMap(x => elements(x as Element))];
}
function loadView(supplied: Record<string, unknown>): any {
  const dependencies = { ...children, ...supplied };
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const name = /class (\w+) extends View/.exec(code)![1];
  return new Function('dependencies', `const { ${Object.keys(dependencies).join(', ')} } = dependencies; ${code}; return ${name};`)(dependencies);
}
function failedFeed(now: number) {
  const owner = { sessionId: 'session-one', generation: 'generation-one', terminal: { address: 't1', coreId: 'core-one', terminalId: 't1', socket: '/fixture/socket', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: 'Owner' };
  return { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: now, owner, lifecycle: 'live', placement: null,
    status: { native: 'idle', effective: 'idle', message: null }, runs: { rows: [{ id: 'run-one', ownerSessionId: owner.sessionId, name: 'Failed child', status: 'failed', childMode: 'rpc', canSteer: false, startedAt: now - 20 * 3600000 - 1000, finishedAt: now - 20 * 3600000, viewer: null, result: null }], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/cap' }, pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' } };
}

describe('installed agents sidebar', () => {
  test('setup verifies patches applied to the real upstream mods', () => {
    expect(doctorFailures).toEqual([]);
  });

  test('setup refuses a newer upstream app before changing installed files', async () => {
    const h = harness!, app = join(h.root, 'app-selection');
    const original = await readFile(app, 'utf8');
    const layout = join(h.directories.app, 'layouts/spider-glass.json');
    const before = await readFile(layout);
    await writeFile(app, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'herdr-app 0.1.12'; else exec '${process.execPath}' '${join(h.root, 'app-selection.mjs')}' "$@"; fi\n`);
    try {
      const request = await ports!.request(join(h.root, 'config.json'));
      await expect(setupHerdr(request, await ports!.setupParts(request))).rejects.toMatchObject({ code: 'upstream-version-mismatch' });
      expect(await readFile(layout)).toEqual(before);
      await writeFile(app, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo unknown; else exec '${process.execPath}' '${join(h.root, 'app-selection.mjs')}' "$@"; fi\n`);
      await expect(setupHerdr(request, await ports!.setupParts(request))).rejects.toMatchObject({ code: 'upstream-version-unavailable' });
      expect(await readFile(layout)).toEqual(before);
    } finally { await writeFile(app, original); }
  }, 120_000);




  test('doctor reports stale installed sidebar props after configuration changes', async () => {
    const h = harness!, configPath = join(h.root, 'config.json');
    const original = await readFile(configPath, 'utf8');
    const config = JSON.parse(original); config.limits = { completedRows: 7, completedHours: 3 };
    await writeFile(configPath, JSON.stringify(config));
    try {
      const request = await ports!.request(configPath);
      const result = await (await ports!.doctorParts(request)).inspect('layout-theme', request);
      expect(result.failures).toContainEqual(expect.objectContaining({ code: 'layout-props-mismatch', repair: expect.stringContaining('setup') }));
    } finally { await writeFile(configPath, original); }
    const request = await ports!.request(configPath);
    expect((await (await ports!.doctorParts(request)).inspect('layout-theme', request)).failures).toEqual([]);
  });

  test('one render projects each owner once and does not cache later snapshots', () => {
    const stored = new Map<string, unknown>(), calls: string[] = [];
    let throwOnOrder = false;
    const project = children.projectAgentChildren as (...args: any[]) => any[];
    const mains = [{ address: 't1', status: 'idle', seq: 1 }, { address: 't9', status: 'working', seq: 2 }];
    const Agents = loadView({ View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui,
      projectAgentChildren: (...args: any[]) => { calls.push(args[2]); return project(...args); },
      agents: () => mains, terminals: () => [], panes: () => [], focused: () => null, spaces: () => [], theme: () => ({}),
      props: () => ({ modId: 'spider-agents', labelContract: HerdrLabelContract }), shared: (key: string) => stored.get(key), setShared: (key: string, value: unknown) => stored.set(key, value),
      setAgentOrder: () => { if (throwOnOrder) throw new Error('render failed'); }, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pins = []; view.spiderFeeds = [failedFeed(Date.now())];
    view.filters().set({ machine: null, agent: 'run:run-one' });
    view.render({});
    expect(calls).toEqual(['t1', 't9']);
    throwOnOrder = true;
    expect(() => view.render({})).toThrow('render failed');
    view.spiderFeeds = [];
    expect(view.tree([], 't1')).toEqual([]);
    expect(calls).toEqual(['t1', 't9', 't1', 't9', 't1']);
  });

  test('tree connectors distinguish siblings and their last descendants', () => {
    const terminal = (address: string, parent: string) => ({ address, parent, state: 'live', status: 'working', labels: {} });
    const terminals = [terminal('t2', 't1'), terminal('t3', 't2'), terminal('t4', 't2'), terminal('t5', 't1'), terminal('t6', 't5')];
    const Agents = loadView({ View: class {}, props: () => ({ labelContract: HerdrLabelContract }), shared: () => null, setShared: () => {} });
    const view = new Agents(); view.spiderFeeds = [];
    expect(view.tree(terminals, 't1').map((row: any) => [row.t.key, row.lines])).toEqual([
      ['t2', ['├']], ['t3', ['│', '├']], ['t4', ['│', '└']], ['t5', ['└']], ['t6', ['', '└']],
    ]);
  });

  test('collapsing a console hides a job and its native descendants', () => {
    const base = failedFeed(Date.now()); const feed = { ...base, runs: { rows: [], total: 0, truncated: false } };
    const terminal = (address: string, parent: string, labels: Record<string, string> = {}) => ({ address, parent, state: 'live', status: 'working', labels });
    const terminals = [
      terminal('remote.invalid/t2', 't1', { 'spider.kind': 'remote-console', 'spider.session': 'session-one', 'spider.machine': 'remote.invalid' }),
      terminal('remote.invalid/t3', 't1', { 'spider.kind': 'exec', 'spider.job': 'job-one', 'spider.session': 'session-one', 'spider.machine': 'remote.invalid' }),
      terminal('remote.invalid/t4', 'remote.invalid/t3'),
    ];
    const project = children.projectAgentChildren as (...args: any[]) => any[];
    const select = children.selectAgentChildren as (...args: any[]) => any[];
    const rows = project(terminals, [feed], 't1', HerdrLabelContract);
    expect(select(rows, { machine: null, agent: null }, []).map(row => row.key)).toEqual(['console:remote.invalid/t2']);
    expect(select(rows, { machine: null, agent: null }, ['console:remote.invalid/t2']).map(row => row.key)).toEqual(['console:remote.invalid/t2', 'job-one', 'remote.invalid/t4']);
  });

  test('native descendants remain under their job and viewer', () => {
    const base = failedFeed(Date.now());
    const feed = { ...base, runs: { ...base.runs, rows: [{ ...base.runs.rows[0], status: 'running', finishedAt: null, viewer: 't4' }] } };
    const terminal = (address: string, parent: string, labels: Record<string, string> = {}) => ({ address, parent, state: 'live', status: 'working', labels });
    const terminals = [
      terminal('remote.invalid/t2', 't1', { 'spider.kind': 'exec', 'spider.job': 'job-one', 'spider.session': 'session-one', 'spider.machine': 'remote.invalid' }),
      terminal('remote.invalid/t3', 'remote.invalid/t2'),
      terminal('t4', 't1', { 'spider.kind': 'subagent-viewer', 'spider.run': 'run-one', 'spider.session': 'session-one' }),
      terminal('t5', 't4'),
    ];
    const project = children.projectAgentChildren as (...args: any[]) => any[];
    const rows = project(terminals, [feed], 't1', HerdrLabelContract);
    expect(rows.map(row => [row.key, row.parentKey, row.depth])).toEqual([
      ['job-one', null, 0], ['remote.invalid/t3', 'job-one', 1], ['run-one', null, 0], ['t5', 'run-one', 1],
    ]);
  });

  test('the sidebar displays the reason a child can no longer be opened', async () => {
    let reply: unknown = { ok: false, code: 'not-found', message: 'No owned job' };
    const p = { modId: 'spider-agents', labelContract: HerdrLabelContract, nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' };
    const Agents = loadView({ ...sharedFeed, View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui,
      agents: () => [{ address: 't1', status: 'idle', seq: 1 }], terminals: () => [], panes: () => [], focused: () => null, spaces: () => [], theme: () => ({}),
      props: () => p, shared: () => null, setShared: () => {}, setAgentOrder: () => {}, exec: async () => ({ code: 0, stdout: JSON.stringify(reply) }),
      layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pins = []; view.spiderFeeds = [];
    const action = { kind: 'ipc', descriptor: { version: 1, sessionId: 'session-one', generation: 'generation-one', address: '/fixture/ipc', capabilityFile: '/fixture/cap' }, request: { op: 'openJob', jobId: 'job-one', generation: 'generation-one' } };
    await view.openChild({ action });
    expect(elements(view.render({})).some(el => el.children.includes('No owned job'))).toBe(true);
    reply = {};
    await view.openChild({ action });
    expect(elements(view.render({})).some(el => el.children.includes('Child view unavailable; run doctor'))).toBe(true);
  });

  test('a saved filter survives an empty initial agent snapshot', () => {
    const stored = new Map<string, unknown>();
    const Agents = loadView({ View: class {}, props: () => ({ modId: 'spider-agents', labelContract: HerdrLabelContract, feedRoot: '/fixture' }),
      shared: (key: string) => stored.get(key), setShared: (key: string, value: unknown) => stored.set(key, value) });
    const view = new Agents(); view.spiderFeeds = [failedFeed(Date.now())]; view.spiderFeedsLoaded = true;
    view.filters().set({ machine: null, agent: 'run:run-one' });
    view.reconcileFilters([], []);
    expect(view.filters().get()).toEqual({ machine: null, agent: 'run:run-one' });
    view.reconcileFilters([], [{ address: 't1' }]);
    expect(view.filters().get().agent).toBe('run:run-one');
    view.reconcileFilters([], []);
    expect(view.filters().get()).toEqual({ machine: null, agent: null });
  });

  test('agent choices all have rows and remain selected under the machine filter', () => {
    const stored = new Map<string, unknown>(), overlays: any[] = [], terminals: any[] = [];
    const mains = [{ address: 't1', status: 'idle', seq: 1 }];
    const p: any = { modId: 'spider-agents', labelContract: HerdrLabelContract };
    const Agents = loadView({ View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui,
      agents: () => mains, terminals: () => terminals, panes: () => [], focused: () => null, spaces: () => [], theme: () => ({}),
      props: () => p, shared: (key: string) => stored.get(key), setShared: (key: string, value: unknown) => stored.set(key, value),
      setAgentOrder: () => {}, openOverlay: (value: unknown) => overlays.push(value), closeOverlay: () => {},
      layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pins = []; view.spiderFeeds = [failedFeed(Date.now())];
    const menu = () => {
      elements(view.filterControls({})).find(el => el.id === 'agents-filter-agent')!.click!();
      Object.assign(p, overlays.at(-1).props);
      return elements(view.filterMenu({}));
    };
    const withoutChildren = menu();
    expect(withoutChildren.map(el => el.id)).not.toContain('agent-filter-agent-session:session-one');
    expect(withoutChildren.map(el => el.id)).toContain('agent-filter-agent-run:run-one');
    delete p.filterMenu;
    terminals.push({ address: 'remote.invalid/t2', parent: 't1', state: 'live', status: 'working', labels: { 'spider.kind': 'exec', 'spider.session': 'session-one', 'spider.job': 'job-one', 'spider.machine': 'remote.invalid' } });
    view.filters().set({ machine: 'remote.invalid', agent: null });
    const filtered = menu();
    expect(filtered.map(el => el.id)).not.toContain('agent-filter-agent-run:run-one');
    filtered.find(el => el.id === 'agent-filter-agent-session:session-one')!.click!();
    delete p.filterMenu;
    view.render({});
    expect(view.filters().get()).toEqual({ machine: 'remote.invalid', agent: 'session:session-one' });
  });

  test('a retained failed child is visible but does not put its idle owner in Needs you', () => {
    const now = Date.now();
    const agents = [{ address: 't1', status: 'idle', seq: 1 }, { address: 't9', status: 'working', seq: 2 }];
    const theme = { dim: '#777777', blocked: '#ff0000', working: '#00ff00', idle: '#cccccc' };
    const order: string[][] = [];
    const terminals: unknown[] = [];
    const Agents = loadView({ View: class {}, div: ui, h_flex: ui, v_flex: ui, image: ui, svg: ui,
      agents: () => agents, terminals: () => terminals, panes: () => [], focused: () => null, spaces: () => [], theme: () => theme,
      shared: () => null, setShared: () => {}, setAgentOrder: (ids: string[]) => order.push(ids), openOverlay: () => {},
      props: () => ({ modId: 'spider-agents', labelContract: HerdrLabelContract }), layout: () => ({ id: 'sidebar', size: { px: 268 } }),
      run: () => {}, localStorage: { getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(['t1']); view.changed = {}; view.pins = []; view.spiderFeeds = [failedFeed(now)];
    const rendered = elements(view.render({}));
    expect(order.at(-1)).toEqual(['t9', 't1']);
    expect(rendered.find(el => el.id === 'fold-t1')?.color).toBe(theme.dim);
    view.folded.delete('t1');
    expect(elements(view.render({})).map(el => el.id)).toContain('sub-run-one');
    view.folded.add('t1');
    terminals.push({ address: 't2', parent: 't1', state: 'live', status: 'blocked', labels: {} });
    const blocked = elements(view.render({}));
    expect(order.at(-1)).toEqual(['t1', 't9']);
    expect(blocked.find(el => el.id === 'fold-t1')?.color).toBe(theme.blocked);
  });
});
});
