// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFeed, panelIpcArgv, parsePanelIpcArgv, parseSessionIpcReply } from '../../assets/shared/feed.js';
import shippedPatches from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import { projectAgentChildren, filterTopLevelAgents, loadAgentFeeds, selectAgentChildren, agentFilterOptions, createAgentFilters, projectMachineRows } from '../../assets/agents/children.js';
import { buildGlassLayout } from '../look/layout.js';
import { HERDR_LABELS, HERDR_KINDS, HerdrLabelContract } from '../contracts.js';
import type { AgentTerminal } from '../../assets/agents/children.js';
import type { Owner, RunSummary, SessionFeed } from '../contracts.js';
import { middlePath } from '../../assets/shared/feed.js';

const contract = HerdrLabelContract;
const owner = { sessionId: 'session-one', generation: 'generation-one', terminal: { address: 't1', coreId: 'core-one', terminalId: 't1', socket: '/fixture/socket', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: 'Fixture' } as Owner;
function terminal(address: string, parent: string | null, kind?: string, key?: string): AgentTerminal {
  return { address, parent, state: 'live', status: 'working', labels: kind ? { [HERDR_LABELS.kind]: kind, [kind === HERDR_KINDS.subagentViewer ? HERDR_LABELS.run : HERDR_LABELS.job]: key!, [HERDR_LABELS.session]: owner.sessionId, [HERDR_LABELS.ownerCore]: owner.terminal.coreId, [HERDR_LABELS.ownerTerminal]: 't1' } : {} };
}
function run(id = 'run-one'): RunSummary {
  return { id, ownerSessionId: owner.sessionId, name: 'Child', status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1000, finishedAt: null, viewer: 't4', result: null } as RunSummary;
}
function feed(runs: RunSummary[] = [run()]): SessionFeed {
  const session: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: 2000, owner, placement: null, lifecycle: 'live', status: { native: 'working', effective: 'working', message: null }, runs: { rows: runs, total: runs.length, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], ipc: { address: "/fixture/ipc.sock", capabilityFile: "/fixture/capability.json" }, errors: [] };
  return session;
}
function clones(source = 'const heading = "Agents";'): HerdrClones {
  const mod = (name: string) => ({ name: `glass-${name}`, clonedFrom: { name, version: '0.1.11' }, files: { 'main.js': source, 'mod.json': JSON.stringify({ cloned_from: { name, version: '0.1.11' } }) } });
  return { agents: mod('agents'), spaces: mod('spaces'), pane: mod('pane'), tabs: mod('tabs') };
}
const patches: LookPatchSet = { version: 1, upstreamVersion: '0.1.11', mods: { agents: [{ id: 'heading', anchor: '"Agents"', replacement: '"AGENTS"' }], spaces: [], pane: [], tabs: [] } };
const cleanup: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });

const names = { agents: 'glass-agents', spaces: 'glass-spaces', pane: 'glass-pane', tabs: 'glass-tabs', spider: 'spider' };
const layoutFixture = () => ({ id: 'root', type: 'row', cloned_from: { name: 'main', version: '0.1.11' }, terminal_padding: [14, 12], divider: { width: 1 }, children: [
  { id: 'sidebar', content: { mod: 'spaces' }, children: [{ id: 'agents', content: { mod: 'agents' } }] },
  { id: 'work-body', children: [{ id: 'main', content: { tab: 'active', pane: { lone: true, header: { content: { mod: 'pane' }, height: 30 } } } }, { id: 'panel', hidden: true, size: { px: 368 }, min: 280, max: 900, children: [{ id: 'panel-body', type: 'stack', active: 'files', children: [{ id: 'files', content: { mod: 'files', props: { keep: true } } }, { id: 'changes', content: { mod: 'changes' } }] }] }] }
] });
function findNode(value: unknown, id: string): Record<string, unknown> | undefined {
  const node = value as Record<string, unknown>; if (node.id === id) return node;
  return (node.children as unknown[] ?? []).map(n => findNode(n, id)).find(Boolean);
}

describe('glass layout', () => {
  it('preserves files and changes and the hidden dock bounds', () => {
    const source = layoutFixture(); const before = JSON.stringify(source);
    const result = buildGlassLayout(source, names);
    expect(findNode(result, 'panel')).toMatchObject({ hidden: true, size: { px: 368 }, min: 280, max: 900 });
    expect((findNode(result, 'panel-body')!.children as { id: string }[]).map(n => n.id)).toEqual(['files', 'changes', 'spider']);
    expect(findNode(result, 'files')).toMatchObject({ content: { mod: 'files', props: { keep: true } } });
    expect(result).toMatchObject({ theme: 'spider-glass', ui_font: 'Google Sans Flex', terminal_opacity: 0, colors: { surface: '#161618f0', popover: '#161618f0', selected: '#ffffff14', border: '#00000000' } });
    expect(findNode(result, 'main')).toMatchObject({ content: { pane: { lone: true, radius: 12, gap: 8, header: { content: { mod: 'glass-pane' }, height: 30 }, border: { width: 0 }, focus: { width: 0 } } } });
    expect(JSON.stringify(source)).toBe(before);
  });
  it('the glass ground is the Firefox window tint over its inactive solid, and text panes are near-opaque', () => {
    // Firefox Liquid Fox: tint stops 0% rgba(170,155,110,0) and 100% rgba(185,150,85,0.06) over the inactive fill rgb(24,24,26).
    const over = (rgba: number[], base = [24, 24, 26]): string => '#' + base.map((v, i) => Math.round(rgba[i] * rgba[3] + v * (1 - rgba[3])).toString(16).padStart(2, '0')).join('');
    const result = buildGlassLayout(layoutFixture(), names);
    expect(result.background).toEqual({ gradient: [over([170, 155, 110, 0]), over([185, 150, 85, 0.06])], angle: 176 });
    expect(result.background).toEqual({ gradient: ['#18181a', '#22201e'], angle: 176 });
    expect(findNode(result, 'main')).toMatchObject({ content: { pane: { background: '#161618f0' } } });
  });
  it('the selected body font reaches chrome while the terminal font survives', () => {
    const source = { ...layoutFixture(), font: 'Fixture Terminal Face' };
    const result = buildGlassLayout(source, { ...names, bodyFont: 'Fixture Body Face' });
    expect(result.ui_font).toBe('Fixture Body Face'); expect(result.font).toBe('Fixture Terminal Face');
  });
  it('refuses missing or duplicate dock nodes before changing anything', () => {
    const missing = layoutFixture(); missing.children.pop();
    expect(() => buildGlassLayout(missing, names)).toThrowError(/panel/);
    const duplicate = layoutFixture(); duplicate.children.push(duplicate.children[1]);
    expect(() => buildGlassLayout(duplicate, names)).toThrowError(/panel/);
  });
  it('filters top-level viewer and observer replay but preserves other agents', () => {
    const all = [terminal('t3', null, HERDR_KINDS.remoteObserver, 'job-one'), terminal('t4', 't1', HERDR_KINDS.subagentViewer, 'run-one')];
    expect(filterTopLevelAgents([{ address: 't1' }, { address: 't3' }, { address: 't4' }, { address: 't7' }], all, contract).map(a => a.address)).toEqual(['t1', 't7']);
  });
});

describe('current clone patches', () => {
  it('a moved upstream anchor fails without replacing the installed clone', async () => {
    const scratch = resolve('.spider/scratch/h'); await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, 'look-')); cleanup.push(root);
    const installed = join(root, 'main.js'); await writeFile(installed, 'previous usable clone');
    const before = await readFile(installed);
    await expect(applyLookPatches(clones('const heading = "Moved";'), patches)).rejects.toMatchObject({ code: 'patch-anchor-mismatch' });
    expect(await readFile(installed)).toEqual(before);
    const rows = projectAgentChildren([terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one'), terminal('t3', null, HERDR_KINDS.remoteObserver, 'job-one'), terminal('t4', 't1', HERDR_KINDS.subagentViewer, 'run-one')], [feed()], 't1', contract, { now: 2000 });
    expect(rows.map(row => row.key)).toEqual(['job-one', 'run-one']);
  });
});

// Only the UI/Herdr boundary is substituted: the actual current clone source executes.
interface Element { id?: string; children: unknown[]; click?: () => void; background?: string; family?: string; [key: string]: unknown }
const uiData = new WeakMap<object, Element>();
function ui(): Element {
  const target: Element = { children: [] };
  const proxy = new Proxy(target, { get(o, key) {
    if (key === 'when') return (on: boolean, fn: (el: Element) => unknown) => { if (on) fn(proxy); return proxy; };
    if (key === 'child') return (value: unknown) => { o.children.push(value); return proxy; };
    if (key === 'children') return (values: unknown[]) => { o.children.push(...values); return proxy; };
    if (key === 'id') return (id: string) => { o.id = id; return proxy; };
    if (key === 'on_click') return (fn: () => void) => { o.click = fn; return proxy; };
    if (key === 'bg') return (value: string) => { o.background = value; return proxy; };
    if (key === 'font_family') return (value: string) => { o.family = value; return proxy; };
    return () => proxy;
  } });
  uiData.set(proxy, target); return proxy;
}
function elements(root: Element): Element[] {
  const data = uiData.get(root) ?? root;
  return [data, ...data.children.filter(x => typeof x === 'object' && x !== null).flatMap(x => elements(x as Element))];
}
async function currentClones(): Promise<HerdrClones> {
  const root = process.env.SPIDER_HERDR_MOD_FIXTURE!;
  const result = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs'] as const) {
    const source = await readFile(join(root, name, 'main.js'), 'utf8');
    result[name] = { name: `glass-${name}`, clonedFrom: { name, version: '0.1.11' }, files: { 'main.js': source, 'mod.json': await readFile(join(root, name, 'mod.json'), 'utf8') } };
  }
  return result;
}
function loadView(source: string, supplied: Record<string, unknown>): any {
  const ports = { projectAgentChildren, filterTopLevelAgents, loadAgentFeeds, selectAgentChildren, agentFilterOptions, createAgentFilters, projectMachineRows, ...supplied };
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const name = /class (\w+) extends View/.exec(code)![1];
  return new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return ${name};`)(ports);
}
const fixturePresent = Boolean(process.env.SPIDER_HERDR_MOD_FIXTURE);
describe.skipIf(!fixturePresent)('current built-ins (requires SPIDER_HERDR_MOD_FIXTURE; no app window)', () => {
  it('one patched agents tree merges both child kinds and suppresses top-level replay', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const all = [terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one'), terminal('t3', 't1', HERDR_KINDS.remoteObserver, 'job-one'), terminal('t4', 't1', HERDR_KINDS.subagentViewer, 'run-one')];
    let order: string[] = [];
    const ports = { View: class {}, div: ui, h_flex: ui, v_flex: ui, image: ui, svg: ui, projectAgentChildren, filterTopLevelAgents,
      agents: () => [{ address: 't1', status: 'working', seq: 1, focused: false }, { address: 't3', status: 'working', seq: 2 }, { address: 't4', status: 'working', seq: 3 }], terminals: () => all, panes: () => [], focused: () => null, spaces: () => [], theme: () => ({}), shared: () => null, setShared: () => {}, setAgentOrder: (ids: string[]) => { order = ids; }, openOverlay: () => {}, closeOverlay: () => {}, props: () => ({ labelContract: contract, labelFont: 'Fixture Label Face' }), window: () => ({}), layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { getItem: () => null, setItem: () => {} } };
    const Agents = loadView(patched.agents.files['main.js'], ports); const view = new Agents();
    view.folded = new Set(); view.changed = {}; view.pins = []; view.spiderFeeds = [feed()]; view.listed = new Map();
    expect(view.tree(all, 't1').map((r: { t: { key: string } }) => r.t.key)).toEqual(['job-one', 'run-one']);
    const rendered = elements(view.render({})); expect(order).toEqual(['t1']);
    expect(rendered.filter(el => el.family && el.family !== 'JetBrains Mono')).toEqual([]);
    const error = view.status({ ansi1: '#ff5555' }, { status: 'error' }, false);
    expect(elements(error).some(el => el.children.includes('Error'))).toBe(true);
  });
  it('a native child row click peeks its terminal without IPC', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const all = [terminal('t5', 't1')], calls: unknown[] = [], tasks: Promise<unknown>[] = [];
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui,
      props: () => ({ labelContract: contract }), terminals: () => all, run: (name: string, args: unknown) => calls.push([name, args]),
      exec: () => { throw new Error('Native children must not invoke IPC'); } });
    const view = new Agents(); view.listed = new Map();
    const child = elements(view.subRow({}, view.tree(all, 't1')[0], null, false)).find(el => el.id === 'sub-t5')!;
    const cx = { notify: () => {}, spawn: (fn: (cx: unknown) => Promise<unknown>) => { tasks.push(fn(cx)); } };
    (child.click as Function)(null, cx); await Promise.all(tasks);
    expect(calls).toEqual([['terminal.peek', { terminal: 't5' }]]);
  });
  it('mounts public feeds and routes saved rows through canonical session IPC', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const calls: unknown[] = [], tasks: Promise<unknown>[] = [];
    const config = { labelContract: contract, feedRoot: '/fixture', nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' };
    const done = { ...run(), status: 'done' as const, finishedAt: Date.now() - 500 };
    const ports = { View: class {}, div: ui, h_flex: ui, v_flex: ui, image: ui, svg: ui, projectAgentChildren, filterTopLevelAgents, loadAgentFeeds, parseFeed, panelIpcArgv, parseSessionIpcReply,
      readTextFile: async (path: string) => { calls.push(['read', path]); return JSON.stringify({ ...feed([done]), updatedAt: Date.now() }); },
      exec: async (bin: string, args: string[]) => { calls.push([bin, args]); return { code: 0, stdout: JSON.stringify(args[1] === 'ipc' ? { ok: true, op: 'openRun', viewer: 't4' } : ['session-one']), stderr: '' }; },
      watchFolder: async () => { throw new Error('fixture watcher closed'); },
      props: () => config, localStorage: { getItem: () => null, setItem: () => {} }, run: (name: string, args: unknown) => calls.push([name, args]), terminals: () => [],
    };
    const cx = { notify: () => {}, timer: { every: () => {} }, spawn: (fn: (cx: unknown) => Promise<unknown>) => { tasks.push(fn(cx)); } };
    const Agents = loadView(patched.agents.files['main.js'], ports), view = new Agents();
    view.init({}, cx); await Promise.all(tasks);
    expect(view.spiderFeeds?.map((f: SessionFeed) => f.sessionId)).toEqual(['session-one']);
    expect(calls.some(c => JSON.stringify(c).includes('jobs.json'))).toBe(false);
    const rows = view.tree([], 't1');
    const button = uiData.get(view.subRow({}, rows[0], null, false))!; (button.click as (...args: unknown[]) => void)(null, cx); await Promise.all(tasks);
    const ipcCall = calls.find(c => Array.isArray(c) && c[0] === '/fixture/node' && Array.isArray(c[1]) && c[1][1] === 'ipc') as [string, string[]];
    expect(parsePanelIpcArgv([ipcCall[0], ...ipcCall[1]])).toMatchObject({ request: { op: 'openRun', runId: 'run-one', generation: 'generation-one' } });
    expect(calls.some(c => Array.isArray(c) && c[0] === 'terminal.peek')).toBe(false);
  });
  it('feed watch bursts start at most one Node listing every five seconds and retain the latest update', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    let now = 10000, revision = 1;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const listings: number[] = [], reads: number[] = [], watches: (() => void)[] = [], timers: { ms: number; tick: (cx: any) => void }[] = [];
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, props: () => ({ labelContract: contract, feedRoot: '/fixture', nodePath: '/fixture/node' }),
      readTextFile: async () => { reads.push(revision); return JSON.stringify({ ...feed(), revision }); }, parseFeed,
      exec: async () => { listings.push(now); return { code: 0, stdout: '["session-one"]' }; },
      watchFolder: () => new Promise<void>(resolve => watches.push(resolve)), localStorage: { getItem: () => null, setItem: () => {} } });
    const cx: any = { notify: () => {}, spawn: (fn: (cx: any) => Promise<unknown>) => fn(cx), timer: { every: (ms: number, tick: (cx: any) => void) => timers.push({ ms, tick }) } };
    const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    const view = new Agents(); view.init({}, cx); await settle();
    expect(listings).toEqual([10000]);
    const reloadTick = () => timers.filter(t => t.ms < 30000).forEach(t => t.tick(cx));
    for (let i = 0; i < 12; i++) { revision++; watches.shift()!(); await settle(); }
    expect(listings).toEqual([10000]);
    now += 4999; reloadTick(); await settle(); expect(listings).toEqual([10000]);
    now++; reloadTick(); await settle();
    expect(listings).toEqual([10000, 15000]); expect(reads).toEqual([1, revision]);
    expect(view.spiderFeeds[0].revision).toBe(revision);
    now += 5000; reloadTick(); await settle(); expect(listings).toEqual([10000, 15000]);
    expect(timers.map(t => t.ms).sort((a, b) => a - b)).toEqual([5000, 30000]);
  });
  it('a failed feed watch uses a slow fallback instead of permanent two-second Node starts', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    let now = 10000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const listings: number[] = [], timers: { ms: number; tick: (cx: any) => void }[] = [];
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, props: () => ({ labelContract: contract, feedRoot: '/fixture', nodePath: '/fixture/node' }),
      readTextFile: async () => JSON.stringify(feed()), parseFeed, exec: async () => { listings.push(now); return { code: 0, stdout: '["session-one"]' }; },
      watchFolder: async () => { throw new Error('watch unavailable'); }, localStorage: { getItem: () => null, setItem: () => {} } });
    const cx: any = { notify: () => {}, spawn: (fn: (cx: any) => Promise<unknown>) => fn(cx), timer: { every: (ms: number, tick: (cx: any) => void) => timers.push({ ms, tick }) } };
    const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    const view = new Agents(); view.init({}, cx); await settle(); expect(listings).toEqual([10000]);
    for (const elapsed of [5000, 10000, 25000, 30000]) {
      now = 10000 + elapsed; timers.forEach(t => t.tick(cx)); await settle();
      expect(listings).toEqual(elapsed < 30000 ? [10000] : [10000, 40000]);
    }
  });
  it('rejects malformed or wrong-operation view replies even when the CLI exits zero', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const descriptor = { version: 1, sessionId: owner.sessionId, generation: owner.generation, address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability.json' };
    for (const reply of [{}, { ok: true, op: 'openRun', viewer: 't4' }, { ok: false, code: 'not-found', message: 'No owned job' }]) {
      const Agents = loadView(patched.agents.files['main.js'], { View: class {}, props: () => ({ nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' }), panelIpcArgv, parseSessionIpcReply, exec: async () => ({ code: 0, stdout: JSON.stringify(reply), stderr: '' }) });
      const view = new Agents();
      await view.openChild({ action: { kind: 'ipc', descriptor, request: { op: 'openJob', jobId: 'job-one', generation: owner.generation } } });
      expect(view.spiderFeedError).toBe('ok' in reply && reply.ok === false ? 'No owned job' : 'Child view unavailable; run doctor');
    }
  });
  it('renders deferred states with labels instead of invisible status dots', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui, terminals: () => [], props: () => ({ labelContract: contract }) });
    const view = new Agents();
    for (const [status, text] of [['queued', 'Queued'], ['paused', 'Paused'], ['disconnected', 'Disconnected'], ['cancelled', 'Cancelled'], ['unknown', 'Unknown']]) {
      expect(elements(view.status({}, { status }, false)).some(el => el.children.includes(text))).toBe(true);
    }
  });
  it('machine and agent chips open selectors and persist choices only for their mod copy', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const stored = new Map<string, unknown>(), overlays: any[] = [], closed: unknown[] = [];
    const p: any = { modId: 'glass-agents-a', labelContract: { ...contract, labels: { ...contract.labels, machine: 'spider.machine' } } };
    const job = terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one'); job.labels = { ...job.labels, 'spider.machine': 'remote.invalid' };
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui,
      props: () => p, terminals: () => [job], shared: (key: string) => stored.get(key), setShared: (key: string, value: unknown) => stored.set(key, value),
      openOverlay: (o: unknown) => overlays.push(o), closeOverlay: (o: unknown) => closed.push(o) });
    const view = new Agents(); view.spiderFeeds = [feed()];
    const controls = elements(view.filterControls({ foreground: '#ffffff', muted: '#cccccc' }));
    controls.find(el => el.id === 'agents-filter-machine')!.click!();
    expect(overlays[0]).toMatchObject({ mod: 'glass-agents-a', props: { modId: 'glass-agents-a', filterMenu: 'machine' } });
    Object.assign(p, overlays[0].props, { overlay: 'filter-overlay' });
    const menu = elements(view.filterMenu({ foreground: '#ffffff', muted: '#cccccc' }));
    expect(menu.some(el => el.children.includes('All machines'))).toBe(true);
    menu.find(el => el.id === 'agent-filter-machine-remote.invalid')!.click!();
    expect(closed).toEqual(['filter-overlay']);
    expect(createAgentFilters('glass-agents-a', { read: key => stored.get(key), write: () => {} }).get()).toEqual({ machine: 'remote.invalid', agent: null });
    p.modId = 'glass-agents-b'; delete p.filterMenu;
    expect(view.filters().get()).toEqual({ machine: null, agent: null });
    expect(elements(view.filterControls({})).some(el => el.children.includes('All machines'))).toBe(true);
  });
  it.each([268, 76])('filters preserve every main session and group at width %s', async width => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const stored = new Map<string, unknown>(), overlays: any[] = [];
    const job = terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one');
    job.labels = { ...job.labels, [contract.labels.machine]: 'remote.invalid' };
    const all = [job];
    const mains = [{ address: 't1', status: 'working', seq: 1 }, { address: 't9', status: 'idle', seq: 2 }];
    const p = { modId: 'glass-agents', labelContract: contract };
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, image: ui, svg: ui,
      agents: () => mains, terminals: () => all, panes: () => [], focused: () => null, spaces: () => [], theme: () => ({}),
      shared: (key: string) => stored.get(key), setShared: (key: string, value: unknown) => stored.set(key, value), setAgentOrder: () => {},
      openOverlay: (o: unknown) => overlays.push(o), props: () => p, layout: () => ({ id: 'sidebar', size: { px: width } }), run: () => {},
      localStorage: { getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pins = []; view.spiderFeeds = [feed()];
    for (const filter of [{ machine: 'remote.invalid', agent: null }, { machine: null, agent: 'run:run-one' }, { machine: null, agent: 'session:session-one' }]) {
      view.filters().set(filter);
      const rendered = elements(view.render({})), ids = rendered.map(el => el.id);
      expect(ids).toEqual(expect.arrayContaining(['ag-t1', 'ag-t9'])); expect(ids.filter(id => id?.startsWith('sec-'))).toEqual([]);
      if (width < 160) {
        rendered.find(el => el.id === 'agents-clear-filters')!.click!();
        expect(view.filters().get()).toEqual({ machine: null, agent: null });
      }
    }
    view.filters().set({ machine: 'removed.invalid', agent: 'run:removed' });
    const stale = elements(view.render({}));
    expect(view.filters().get()).toEqual({ machine: null, agent: null });
    expect(stale.some(el => el.children.includes('run:removed'))).toBe(false);
    view.spiderFeeds = [feed([])]; all.length = 0;
    view.filters().set({ machine: null, agent: 'session:session-one' });
    view.render({}); expect(view.filters().get()).toEqual({ machine: null, agent: null });
    all.push(job); view.spiderFeeds = [feed()];
    if (width >= 160) {
      view.filters().set({ machine: null, agent: 'run:run-one' });
      expect(elements(view.render({})).some(el => el.children.includes('Child'))).toBe(true);
      elements(view.render({})).find(el => el.id === 'ag-sort')!.click!();
      expect(overlays.at(-1).mod).toBe('glass-agents');
    }
  });
  it('keeps persisted filters until the first feed snapshot is available', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const stored = new Map<string, unknown>(); let release!: (text: string) => void;
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, parseFeed,
      props: () => ({ modId: 'glass-agents', labelContract: contract, feedRoot: '/fixture', nodePath: '/fixture/node' }),
      exec: async () => ({ code: 0, stdout: '["session-one"]' }), readTextFile: () => new Promise<string>(resolve => { release = resolve; }),
      shared: (key: string) => stored.get(key), setShared: (key: string, value: unknown) => stored.set(key, value) });
    const view = new Agents(); view.spiderFeeds = [];
    view.filters().set({ machine: null, agent: 'run:run-one' });
    const loading = view.reloadSpiderFeeds(); for (let i = 0; i < 10; i++) await Promise.resolve();
    view.reconcileFilters([], [{ address: 't1' }]);
    expect(view.filters().get()).toEqual({ machine: null, agent: 'run:run-one' });
    release(JSON.stringify(feed())); await loading;
    view.reconcileFilters([], [{ address: 't1' }]); expect(view.filters().get().agent).toBe('run:run-one');
    view.spiderFeeds = [];
    view.reconcileFilters([], [{ address: 't1' }]);
    expect(view.filters().get()).toEqual({ machine: null, agent: null });
  });
  it('a filter popup without options still offers All', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui,
      props: () => ({ modId: 'glass-agents', filterMenu: 'machine' }), shared: () => null, setShared: () => {} });
    expect(elements(new Agents().filterMenu({})).some(el => el.children.includes('All machines'))).toBe(true);
  });
  it('console rows start collapsed and their caret expands jobs without opening a terminal', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const p = { modId: 'glass-agents', labelContract: { ...contract, labels: { ...contract.labels, machine: 'spider.machine' }, kinds: { ...contract.kinds, remoteConsole: 'remote-console' } } };
    const job = terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one'); job.labels = { ...job.labels, 'spider.machine': 'remote.invalid' };
    const console = terminal('remote.invalid/t3', null, 'remote-console'); console.labels = { ...console.labels, 'spider.machine': 'remote.invalid' };
    const opened: string[] = [];
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui,
      props: () => p, shared: () => null, setShared: () => {}, terminals: () => [job, console], run: (name: string) => opened.push(name) });
    const view = new Agents(); view.spiderFeeds = [feed([])]; view.listed = new Map(); view.expandedConsoles = new Set();
    const rows = view.tree([job, console], 't1');
    expect(rows.map((r: any) => r.t.key)).toEqual(['console:remote.invalid/t3']);
    const rendered = elements(view.subRow({}, rows[0], null, false));
    const caret = rendered.find(el => el.id === 'console-fold-console:remote.invalid/t3')!;
    let stopped = false; (caret.click as Function)(null, { stop_propagation: () => { stopped = true; }, notify: () => {} });
    expect(stopped).toBe(true); expect(opened).toEqual([]);
    expect(view.tree([job, console], 't1').map((r: any) => r.t.key)).toEqual(['console:remote.invalid/t3', 'job-one']);
  });
  it('pane focus is a fill and paths use the bundled monospace fallback', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Pane = loadView(patched.pane.files['main.js'], { middlePath, View: class {}, div: ui, h_flex: ui, svg: ui, image: ui, panes: () => [{ pane: 'p1', terminal: 't1', focused: true, status: 'blocked', cwd: '/fixture/path' }], props: () => ({ pane: 'p1' }), run: () => {}, theme: () => ({ ansi1: '#ff5555' }), home: () => '/fixture/home', terminals: () => [{ address: 't1', status: { state: 'error' } }] });
    const view = new Pane(); view.init(); const root = view.render({});
    expect(uiData.get(root)!.background).toBe('#ffffff14');
    expect(elements(root).some(el => el.family === 'JetBrains Mono')).toBe(true);
    expect(elements(root).some(el => el.children.includes('Error'))).toBe(true);
  });
  it('the spaces dock button selects the spider panel without focusing a terminal; there is no Machines button', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const actions: unknown[] = []; let railWidth = 268;
    const ports = { View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui, machines: () => [], spaces: () => [], panes: () => [], focused: () => null, theme: () => ({}), shared: () => null, setShared: () => {}, run: (name: string, args: unknown) => actions.push([name, args]), props: () => ({ labelFont: 'Fixture Label Face' }), window: () => ({}), layout: () => ({ id: 'sidebar', size: { px: 268 } }), openOverlay: () => {}, closeOverlay: () => {} };
    ports.layout = () => ({ id: 'sidebar', size: { px: railWidth } });
    const Spaces = loadView(patched.spaces.files['main.js'], ports); const view = new Spaces(); view.folded = new Set(); view.machines = []; view.shown = new Set();
    const rendered = elements(view.render());
    expect(rendered.filter(el => el.family)).toEqual([]);
    const buttons = rendered.filter(el => ['spider-panel', 'machines-panel'].includes(el.id!));
    expect(buttons.map(b => b.id)).toEqual(['spider-panel']); for (const b of buttons) b.click!();
    expect(actions).toEqual([['layout.show', { id: 'panel' }], ['layout.select', { stack: 'panel-body', child: 'spider' }]]);
    railWidth = 44;
    const compact = elements(view.render()).filter(el => ['spider-panel', 'machines-panel'].includes(el.id!));
    expect(compact).toHaveLength(1);
    expect(compact.some(el => el.children.some(c => c === 'Spider' || c === 'Machines'))).toBe(false);
  });
});

describe('patch ownership and lifecycle', () => {
  it('rejects duplicate anchors', async () => {
    await expect(applyLookPatches(clones('"Agents"; "Agents";'), patches)).rejects.toMatchObject({ code: 'patch-anchor-mismatch' });
  });
  it('reruns already-patched markers without changing bytes', async () => {
    const first = await applyLookPatches(clones(), patches);
    expect(await applyLookPatches(first, patches)).toEqual(first);
  });
  it('rejects a modified user clone even when the marker survived', async () => {
    const first = await applyLookPatches(clones(), patches);
    first.agents.files = { ...first.agents.files, 'main.js': first.agents.files['main.js'] + '\n// user edit' };
    await expect(applyLookPatches(first, patches)).rejects.toMatchObject({ code: 'clone-modified' });
  });
  it('requires an explicit rebase after an app update', async () => {
    const next = clones(); next.agents.clonedFrom.version = '0.1.12';
    await expect(applyLookPatches(next, patches)).rejects.toMatchObject({ code: 'upstream-version-mismatch' });
  });
});

describe('public agents feeds', () => {
  it('console replay never becomes a top-level agent', () => {
    const console = terminal('remote.invalid/t3', null, HERDR_KINDS.remoteConsole);
    console.labels = { ...console.labels, [contract.labels.machine]: 'remote.invalid' };
    expect(filterTopLevelAgents([{ address: 't1' }, { address: console.address }], [terminal('t1', null), console], contract)).toEqual([{ address: 't1' }]);
  });
  it('reopens a job observer through canonical openJob IPC rather than a view route', () => {
    const live = terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one');
    const action = projectAgentChildren([live], [feed([])], 't1', contract, { now: 2000 })[0].action;
    expect(action?.kind).toBe('ipc'); if (action?.kind !== 'ipc') throw new Error('Expected a session action');
    const argv = panelIpcArgv('/fixture/node', '/fixture/cli.mjs', action.descriptor, action.request);
    expect(parsePanelIpcArgv(argv)?.request).toEqual({ op: 'openJob', jobId: 'job-one', generation: owner.generation });
    expect(argv[2]).toBe('ipc');
  });
  it('opens a saved live-session subagent through canonical openRun IPC', () => {
    const live = feed(); live.ipc = { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability.json' };
    const row = projectAgentChildren([], [{ ...live, runs: { rows: [{ ...run(), status: 'done', finishedAt: 1500 }], total: 1, truncated: false } }], 't1', contract, { now: 2000 })[0];
    expect(row.action?.kind).toBe('ipc');
    if (row.action?.kind !== 'ipc') throw new Error('Expected a session action');
    const argv = panelIpcArgv('/fixture/node', '/fixture/cli.mjs', row.action.descriptor, row.action.request);
    expect(parsePanelIpcArgv(argv)).toMatchObject({ descriptor: { sessionId: 'session-one', generation: 'generation-one', address: '/fixture/ipc.sock' }, request: { op: 'openRun', runId: 'run-one', generation: 'generation-one' } });
    expect(argv.join(' ')).not.toContain('secret-token');
  });
  it('reads public session feeds only and rejects foreign directory ownership', async () => {
    const readPaths: string[] = [];
    const result = await loadAgentFeeds('/fixture/sessions', {
      listSessionIds: async () => ['session-one', '../private', 'foreign'],
      readTextFile: async path => { readPaths.push(path); return JSON.stringify(feed([{ ...run(), status: 'done', finishedAt: 1500 }])); }, parseFeed,
    });
    expect(result.feeds).toHaveLength(1);
    expect(readPaths).toEqual(['/fixture/sessions/session-one/session.json', '/fixture/sessions/foreign/session.json']);
    expect(projectAgentChildren([], result.feeds, 't1', contract, { now: 2000 })[0]).toMatchObject({ key: 'run-one', retained: true, action: { kind: 'ipc', request: { op: 'openRun', runId: 'run-one' } } });
    expect(result.errors).toHaveLength(2);
  });
});

describe('combined child tree', () => {
  it('a done status replay cannot complete a live job', () => {
    const live = terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one'); live.status = 'done';
    expect(projectAgentChildren([live], [feed([])], 't1', contract, { now: 2000 })[0]).toMatchObject({ key: 'job-one', status: 'working', retained: false, outcome: null });
  });
  it('a removed remote job does not reappear from a private journal', () => {
    expect(projectAgentChildren([], [feed([])], 't1', contract, { now: 2000 })).toEqual([]);
  });
  it('preserves native live children and filters observer status replay', () => {
    const rows = projectAgentChildren([terminal('t5', 't1'), terminal('t6', 't5'), terminal('t3', 't1', HERDR_KINDS.remoteObserver, 'job-one')], [], 't1', contract, { now: 2000 });
    expect(rows.map(r => [r.key, r.depth])).toEqual([['t5', 0], ['t6', 1]]);
  });
  it('keeps one row per ID and takes core error over folded blocked', () => {
    const core = terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one'); core.status = { state: 'error' };
    const rows = projectAgentChildren([core, { ...core, address: 'remote.invalid/t9' }], [feed(), feed()], 't1', contract, { now: 2000 });
    expect(rows.map(r => r.key)).toEqual(['job-one', 'run-one']);
    expect(rows[0].status).toBe('error');
  });
  it('does not retain finished job terminal rows, whose history belongs to machine consoles', () => {
    const done = terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one');
    done.state = 'finished'; done.exitCode = 23; done.finishedAt = 1500; done.reason = 'exited';
    const rows = projectAgentChildren([done], [feed([])], 't1', contract, { now: 2000 });
    expect(rows).toEqual([]);
  });
  it('moves a session by verified ID without duplicating its original native parent', () => {
    const moved = { ...feed(), owner: { ...owner, terminal: { ...owner.terminal, address: 't8' as never } } };
    const live = terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one');
    expect(projectAgentChildren([live], [moved], 't8', contract, { now: 2000 }).map(r => r.key)).toEqual(['job-one', 'run-one']);
    expect(projectAgentChildren([live], [moved], 't1', contract, { now: 2000 })).toEqual([]);
  });
  it('bounds completed rows to the latest fifty within twenty-four hours', () => {
    const runs = Array.from({ length: 55 }, (_, i) => ({ ...run(`run-${i}`), status: 'done' as const, finishedAt: 1000 + i, result: 'saved' }));
    runs.push({ ...run('expired'), status: 'done', finishedAt: 1, result: 'expired' });
    const rows = projectAgentChildren([], [feed(runs)], 't1', contract, { now: 86400002 });
    expect(rows).toHaveLength(50);
    expect(rows.map(r => r.key)).toEqual(Array.from({ length: 50 }, (_, i) => `run-${54 - i}`));
  });
  it('does not invent success from a stale feed or lost viewer', () => {
    const live = terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one');
    const stale = feed([]); stale.updatedAt = 1;
    expect(projectAgentChildren([live], [stale], 't1', contract, { now: 20000 })[0]).toMatchObject({ status: 'disconnected', outcome: null, completeness: 'unknown', retained: false });
  });
});
