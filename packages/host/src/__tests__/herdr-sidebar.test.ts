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
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../../../herdr/src/look/patches.js';
import { readJournal, digest } from '../../../herdr/src/setup/backup.js';

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
let sharedLook: Record<string, unknown>;
let doctorFailures: unknown;
let upgradeEvidence: { previousLayout: any; previousAgents: string; previousIcon: string; oldJournalHash: string | null; oldIconHash: string; oldChevronAbsent: boolean; refusedEdit: boolean; editPreserved: boolean; writes: readonly string[]; probes: readonly unknown[] };

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
  for (const kind of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome']) {
    const dir = join(h.directories.app, 'mods', kind);
    await cp(join(fixture!, kind), dir, { recursive: true });
  }
  await mkdir(join(h.directories.app, 'layouts'), { recursive: true });
  await writeFile(join(h.directories.app, 'layouts/main.json'), JSON.stringify({ children: [
    { id: 'brand', content: { mod: 'workspace-chrome' } }, { id: 'sidebar', content: { mod: 'agents' } }, { id: 'spaces', content: { mod: 'spaces' } }, { id: 'tabs', content: { mod: 'tabs' } },
    { id: 'work-body', children: [{ id: 'main', content: { tab: 'active', pane: { header: { content: { mod: 'pane' } } } } },
      { id: 'panel', children: [{ id: 'panel-body', type: 'stack', children: [{ id: 'files' }, { id: 'changes' }] }] }] },
    { id: 'status', type: 'block', size: { px: 28 }, content: { mod: 'workspace-status' } },
  ] }));
  await writeFile(join(h.directories.app, 'settings.json'), '{"theme":"stock"}');
  await writeFile(join(h.directories.agent, 'settings.json'), '{"theme":"stock"}');
  const script = join(h.root, 'app-selection.mjs');
  await writeFile(script, `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), path = process.env.HERDR_APP_HOME + '/settings.json';
if (args[0] === '--version') console.log('herdr-app 0.1.12');
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
  const previous = resolve('packages/host/src/__tests__/fixtures/herdr-look-previous');
  const oldPatches = JSON.parse(await readFile(join(previous, 'patches.json'), 'utf8')) as LookPatchSet;
  const oldEdits = JSON.parse(await readFile(join(previous, 'layout-edits.json'), 'utf8'));
  const clones = {} as HerdrClones;
  for (const kind of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) clones[kind] = {
    name: `spider-${kind}`, clonedFrom: { name: kind, version: '0.1.12' },
    files: { 'main.js': await readFile(join(fixture!, kind, 'main.js'), 'utf8'), 'mod.json': await readFile(join(fixture!, kind, 'mod.json'), 'utf8') },
  };
  const oldClones = await applyLookPatches(clones, { ...oldPatches, upstreamVersion: '0.1.12' });
  const parts = await ports.setupParts(request), stage = parts.stageLook;
  const oldParts = { ...parts, verify: async () => ({ failures: [], warnings: [], probes: [] }), stageLook: async (...args: Parameters<typeof stage>) => {
    const plans = (await stage(...args)).filter(plan => plan.path !== join(request.config.app.home, 'mods/spider-agents/chevron-up.svg'));
    return Promise.all(plans.map(async plan => {
      let bytes = plan.bytes;
      for (const kind of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) {
        const directory = join(request.config.app.home, 'mods', kind === 'workspace-chrome' ? 'spider-chrome' : `spider-${kind}`);
        if (plan.path === join(directory, 'main.js')) bytes = Buffer.from(oldClones[kind].files['main.js']);
        if (plan.path === join(directory, 'mod.json')) bytes = Buffer.from(JSON.stringify({ ...JSON.parse(oldClones[kind].files['mod.json']), clonedFrom: oldClones[kind].clonedFrom, patchState: oldClones[kind].patchState }));
      }
      if (plan.path === join(request.config.app.home, 'mods/spider-agents/spider-children.js')) bytes = await readFile(join(previous, 'children.js'));
      if (plan.path === join(request.config.app.home, 'mods/spider-tabs/spider.svg')) bytes = await readFile(join(previous, 'spider.svg'));
      if (plan.path === join(request.config.app.home, 'layouts/spider-glass.json')) {
        const layout = JSON.parse(bytes.toString());
        const walk = (node: any): void => {
          if (node.content?.tab === 'active') Object.assign(node.content.pane, oldEdits.pane);
          if (node.id === 'panel') { delete node.radius; delete node.border; delete node.padding; delete node.background; }
          for (const child of node.children ?? []) walk(child);
        };
        walk(layout);
        if (!layout.children.some((node: any) => node.id === 'status')) layout.children.push({ id: 'status', type: 'block', size: { px: 28 }, content: { mod: 'workspace-status' } });
        bytes = Buffer.from(JSON.stringify(layout, null, 2));
      }
      return { ...plan, bytes };
    }));
  } };
  const first = await setupHerdr(request, oldParts);
  expect(first.probes).toHaveLength(1);
  const iconPath = join(h.directories.app, 'mods/spider-tabs/spider.svg');
  const oldIcon = await readFile(iconPath);
  const oldJournal = await readJournal(request.journalRoot);
  const previousLayout = JSON.parse(await readFile(join(h.directories.app, 'layouts/spider-glass.json'), 'utf8'));
  const previousAgents = await readFile(join(h.directories.app, 'mods/spider-agents/main.js'), 'utf8');
  const oldChevronAbsent = await readFile(join(h.directories.app, 'mods/spider-agents/chevron-up.svg')).then(() => false, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return true; throw error; });
  await writeFile(iconPath, Buffer.concat([oldIcon, Buffer.from('<!-- user edit -->')]));
  let refusedEdit = false;
  try { await setupHerdr(request, await ports.setupParts(request)); } catch (error: any) { if (error.code !== 'unowned-clone-collision') throw error; refusedEdit = true; }
  const editPreserved = (await readFile(iconPath, 'utf8')).endsWith('<!-- user edit -->');
  await writeFile(iconPath, oldIcon);
  const result = await setupHerdr(request, await ports.setupParts(request));
  upgradeEvidence = { previousLayout, previousAgents, previousIcon: oldIcon.toString(), oldJournalHash: oldJournal.entries.find(entry => entry.path === iconPath)?.after ?? null,
    oldIconHash: digest(oldIcon), oldChevronAbsent, refusedEdit, editPreserved, writes: result.writes, probes: result.probes };
  doctorFailures = result.doctor.failures;
  const agentDir = join(h.directories.app, 'mods/spider-agents');
  source = await readFile(join(agentDir, 'main.js'), 'utf8');
  children = await import(pathToFileURL(join(agentDir, 'spider-children.js')).href);
  sharedFeed = await import(pathToFileURL(join(agentDir, 'shared/feed.js')).href);
  sharedLook = await import(pathToFileURL(join(agentDir, 'shared/look.js')).href);
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
  const dependencies = { ...children, ...sharedLook, Scrollbar: { vertical: () => ui() }, ...supplied };
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

  test('setup installs the shared look module and records its digest', async () => {
    const h = harness!;
    const packaged = await readFile(resolve('packages/herdr/assets/shared/look.js')).catch(() => null);
    expect(packaged).not.toBeNull();
    if (!packaged) return;
    const request = await ports!.request(join(h.root, 'config.json'));
    const journal = await readJournal(request.journalRoot);
    for (const mod of ['agents', 'spaces', 'pane']) {
      const path = join(h.directories.app, `mods/spider-${mod}/shared/look.js`);
      const installed = await readFile(path).catch(() => null);
      expect(installed).toEqual(packaged);
      expect(journal.entries.find(entry => entry.path === path)?.after).toBe(digest(packaged));
    }
  });

  test('setup installs each space shape and records its digest', async () => {
    const h = harness!, request = await ports!.request(join(h.root, 'config.json'));
    const journal = await readJournal(request.journalRoot);
    for (const shape of ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'star']) {
      const path = join(h.directories.app, `mods/spider-agents/space-${shape}.svg`);
      const installed = await readFile(path).catch(() => null);
      expect(installed).not.toBeNull();
      if (!installed) continue;
      expect(installed).toEqual(await readFile(resolve(`packages/herdr/assets/agents/space-${shape}.svg`)));
      expect(journal.entries.find(entry => entry.path === path)?.after).toBe(digest(installed));
    }
  });

  test('setup installs the parent icon and records its digest', async () => {
    const h = harness!;
    const path = join(h.directories.app, 'mods/spider-agents/corner-up-left.svg');
    const installed = await readFile(path).catch(() => null);
    expect(installed).not.toBeNull();
    if (!installed) return;
    const packaged = await readFile(resolve('packages/herdr/assets/agents/corner-up-left.svg'));
    expect(installed).toEqual(packaged);
    const request = await ports!.request(join(h.root, 'config.json'));
    const journal = await readJournal(request.journalRoot);
    expect(journal.entries.find(entry => entry.path === path)?.after).toBe(digest(installed));
    expect((await (await ports!.doctorParts(request)).inspect('clones', request)).failures).toEqual([]);
  });

  test('setup upgrades the recorded previous look but refuses an edited installed icon', async () => {
    const h = harness!, appHome = h.directories.app;
    const find = (node: any, id: string): any => node.id === id ? node : (node.children ?? []).map((child: any) => find(child, id)).find(Boolean);
    const old = upgradeEvidence;
    expect(find(old.previousLayout, 'main').content.pane.border).toEqual({ width: 0, color: '#00000000' });
    expect(find(old.previousLayout, 'panel').border).toBeUndefined();
    expect(find(old.previousLayout, 'status').content.mod).toBe('workspace-status');
    expect(old.previousAgents).toContain('spider-look:machines-section');
    expect(old.previousAgents).toContain('filterControls');
    expect(old.previousIcon).toContain('<ellipse');
    expect(old.oldJournalHash).toBe(old.oldIconHash);
    expect(old.oldChevronAbsent).toBe(true);
    expect(old.refusedEdit).toBe(true); expect(old.editPreserved).toBe(true);
    const paths = ['layouts/spider-glass.json', 'mods/spider-agents/main.js', 'mods/spider-agents/spider-children.js', 'mods/spider-agents/chevron-up.svg', 'mods/spider-spaces/main.js', 'mods/spider-tabs/spider.svg'];
    for (const path of paths) expect(old.writes).toContain(join(appHome, path));
    expect(old.probes).toEqual([]);
    const installed = JSON.parse(await readFile(join(appHome, 'layouts/spider-glass.json'), 'utf8'));
    expect(find(installed, 'main').content.pane.border).toEqual({ width: 1, color: '#38383a' });
    expect(find(installed, 'panel')).toMatchObject({ radius: 12, border: { width: 1, color: '#38383a' }, padding: 5, background: '#161618f0' });
    expect(find(installed, 'status')).toBeUndefined();
    expect(await readFile(join(appHome, 'mods/spider-agents/main.js'), 'utf8')).not.toContain('filterControls');
    expect(await readFile(join(appHome, 'mods/spider-tabs/spider.svg'), 'utf8')).toContain('viewBox="0 0 56 56"');
    expect(await readFile(join(appHome, 'mods/spider-agents/chevron-up.svg'), 'utf8')).toContain('d="m18 15-6-6-6 6"');
    const request = await ports!.request(join(h.root, 'config.json'));
    expect((await setupHerdr(request, await ports!.setupParts(request))).writes).toEqual([]);
  }, 120_000);

  test('setup refuses a newer upstream app before changing installed files', async () => {
    const h = harness!, app = join(h.root, 'app-selection');
    const original = await readFile(app, 'utf8');
    const layout = join(h.directories.app, 'layouts/spider-glass.json');
    const before = await readFile(layout);
    await writeFile(app, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'herdr-app 0.1.13'; else exec '${process.execPath}' '${join(h.root, 'app-selection.mjs')}' "$@"; fi\n`);
    try {
      const request = await ports!.request(join(h.root, 'config.json'));
      await expect(setupHerdr(request, await ports!.setupParts(request))).rejects.toMatchObject({ code: 'upstream-version-mismatch' });
      expect(await readFile(layout)).toEqual(before);
      await writeFile(app, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo unknown; else exec '${process.execPath}' '${join(h.root, 'app-selection.mjs')}' "$@"; fi\n`);
      await expect(setupHerdr(request, await ports!.setupParts(request))).rejects.toMatchObject({ code: 'upstream-version-unavailable' });
      expect(await readFile(layout)).toEqual(before);
    } finally { await writeFile(app, original); }
  }, 120_000);

  test('setup and doctor accept Herdr 0.1.12, using the rebased built-in mods', async () => {
    const h = harness!, app = join(h.root, 'app-selection');
    const original = await readFile(app, 'utf8');
    const request = await ports!.request(join(h.root, 'config.json'));
    await writeFile(app, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'herdr-app 0.1.12'; else exec '${process.execPath}' '${join(h.root, 'app-selection.mjs')}' "$@"; fi\n`);
    try {
      await setupHerdr(request, await ports!.setupParts(request));
      const manifest = JSON.parse(await readFile(join(h.directories.app, 'mods/spider-agents/mod.json'), 'utf8'));
      expect(manifest.clonedFrom).toEqual({ name: 'agents', version: '0.1.12' });
      expect((await (await ports!.doctorParts(request)).inspect('patch-version', request)).failures).toEqual([]);
    } finally {
      await writeFile(app, original);
      await setupHerdr(request, await ports!.setupParts(request));
    }
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
      setAgentOrder: () => { if (throwOnOrder) throw new Error('render failed'); }, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = [failedFeed(Date.now())];
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
    const view = new Agents(); view.folded = new Set(); view.spiderFeeds = [];
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
    expect(select(rows, []).map(row => row.key)).toEqual(['console:remote.invalid/t2']);
    expect(select(rows, ['console:remote.invalid/t2']).map(row => row.key)).toEqual(['console:remote.invalid/t2', 'job-one', 'remote.invalid/t4']);
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
      layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = [];
    const action = { kind: 'ipc', descriptor: { version: 1, sessionId: 'session-one', generation: 'generation-one', address: '/fixture/ipc', capabilityFile: '/fixture/cap' }, request: { op: 'openJob', jobId: 'job-one', generation: 'generation-one' } };
    await view.openChild({ action });
    expect(elements(view.render({})).some(el => el.children.includes('No owned job'))).toBe(true);
    reply = {};
    await view.openChild({ action });
    expect(elements(view.render({})).some(el => el.children.includes('Child view unavailable; run doctor'))).toBe(true);
  });

  test('a saved filter cannot hide children after an empty initial agent snapshot', () => {
    const saved = { machine: 'other.invalid', agent: 'run:other' };
    const stored = new Map<string, unknown>([['spider.agents.filters/spider-agents', saved]]);
    const Agents = loadView({ View: class {}, props: () => ({ modId: 'spider-agents', labelContract: HerdrLabelContract, feedRoot: '/fixture' }),
      shared: (key: string) => stored.get(key), setShared: (key: string, value: unknown) => stored.set(key, value) });
    const view = new Agents(); view.folded = new Set(); view.spiderFeeds = [];
    expect(view.tree([], 't1')).toEqual([]);
    const running = failedFeed(Date.now());
    view.spiderFeeds = [{ ...running, runs: { ...running.runs, rows: [{ ...running.runs.rows[0], status: 'running', finishedAt: null }] } }];
    expect(view.tree([], 't1').map((row: any) => row.t.key)).toEqual(['run-one']);
    expect(stored.get('spider.agents.filters/spider-agents')).toEqual(saved);
  });

  test('all installed child rows remain visible with a saved combined filter', () => {
    const saved = { machine: 'other.invalid', agent: 'run:other' };
    const stored = new Map<string, unknown>([['spider.agents.filters/spider-agents', saved]]);
    const terminals = [{ address: 'remote.invalid/t2', parent: 't1', state: 'live', status: 'working', labels: { 'spider.kind': 'exec', 'spider.session': 'session-one', 'spider.job': 'job-one', 'spider.machine': 'remote.invalid' } }];
    const Agents = loadView({ View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui,
      agents: () => [{ address: 't1', status: 'idle', seq: 1 }], terminals: () => terminals, panes: () => [], focused: () => null, spaces: () => [], theme: () => ({}),
      props: () => ({ modId: 'spider-agents', labelContract: HerdrLabelContract }), shared: (key: string) => stored.get(key), setShared: (key: string, value: unknown) => stored.set(key, value),
      setAgentOrder: () => {}, layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = [failedFeed(Date.now())];
    let rendered = elements(view.render({}));
    expect(rendered.map(el => el.id)).toEqual(expect.arrayContaining(['ag-t1', 'sub-job-one', 'finished-toggle-t1']));
    expect(rendered.map(el => el.id)).not.toContain('sub-run-one');
    rendered.find(el => el.id === 'finished-toggle-t1')!.click!(null, { notify() {} });
    rendered = elements(view.render({}));
    expect(rendered.map(el => el.id)).toContain('sub-run-one');
    expect(rendered.some(el => el.id?.startsWith('agents-filter-') || el.id === 'agents-clear-filters')).toBe(false);
    expect(stored.get('spider.agents.filters/spider-agents')).toEqual(saved);
  });

  test('a running blocked job still affects priority inside a collapsed console', () => {
    const order: string[][] = [], feed = failedFeed(Date.now());
    const terminals = [
      { address: 'remote.invalid/console', parent: 't1', state: 'live', status: 'idle', labels: { 'spider.kind': 'remote-console', 'spider.session': 'session-one', 'spider.machine': 'remote.invalid' } },
      { address: 'remote.invalid/job', parent: 't1', state: 'live', status: 'blocked', labels: { 'spider.kind': 'exec', 'spider.session': 'session-one', 'spider.job': 'job-one', 'spider.machine': 'remote.invalid' } },
    ];
    const Agents = loadView({ View: class {}, div: ui, h_flex: ui, v_flex: ui, image: ui, svg: ui,
      agents: () => [{ address: 't1', status: 'idle', seq: 1 }, { address: 't9', status: 'working', seq: 2 }], terminals: () => terminals,
      panes: () => [], focused: () => null, spaces: () => [], theme: () => ({}), shared: () => null, setShared: () => {},
      setAgentOrder: (ids: string[]) => order.push(ids), props: () => ({ modId: 'spider-agents', labelContract: HerdrLabelContract }),
      layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = [feed];
    const rendered = elements(view.render({}));
    expect(rendered.map(el => el.id)).not.toContain('sub-job-one');
    expect(order.at(-1)).toEqual(['t1', 't9']);
  });

  test('a hidden or expanded retained failed child does not put its idle owner in Needs you', () => {
    const now = Date.now();
    const agents = [{ address: 't1', status: 'idle', seq: 1 }, { address: 't9', status: 'working', seq: 2 }];
    const theme = { dim: '#777777', blocked: '#ff0000', working: '#00ff00', idle: '#cccccc' };
    const order: string[][] = [];
    const terminals: unknown[] = [];
    const Agents = loadView({ View: class {}, div: ui, h_flex: ui, v_flex: ui, image: ui, svg: ui,
      agents: () => agents, terminals: () => terminals, panes: () => [], focused: () => null, spaces: () => [], theme: () => theme,
      shared: () => null, setShared: () => {}, setAgentOrder: (ids: string[]) => order.push(ids), openOverlay: () => {},
      props: () => ({ modId: 'spider-agents', labelContract: HerdrLabelContract }), layout: () => ({ id: 'sidebar', size: { px: 268 } }),
      run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(['t1']); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = [failedFeed(now)];
    const rendered = elements(view.render({}));
    expect(order.at(-1)).toEqual(['t9', 't1']);
    expect(rendered.find(el => el.id === 'fold-t1')).toBeUndefined();
    view.folded.delete('t1');
    let expanded = elements(view.render({}));
    expect(expanded.map(el => el.id)).not.toContain('sub-run-one');
    expanded.find(el => el.id === 'finished-toggle-t1')!.click!(null, { notify() {} });
    expanded = elements(view.render({}));
    expect(expanded.map(el => el.id)).toContain('sub-run-one');
    expect(order.at(-1)).toEqual(['t9', 't1']);
    view.folded.add('t1');
    terminals.push({ address: 't2', parent: 't1', state: 'live', status: 'blocked', labels: {} });
    const blocked = elements(view.render({}));
    expect(order.at(-1)).toEqual(['t1', 't9']);
    expect(blocked.find(el => el.id === 'fold-t1')?.color).toBe(theme.blocked);
  });
});
});
