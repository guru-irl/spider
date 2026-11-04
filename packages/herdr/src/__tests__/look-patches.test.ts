// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEED_REFRESH_MS, createFeedReader, parseFeed, panelIpcArgv, parsePanelIpcArgv, parseSessionIpcReply } from '../../assets/shared/feed.js';
import shippedPatches from '../../assets/look/patches.json' with { type: 'json' };
import glassTheme from '../../assets/themes/spider-glass.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import { projectAgentChildren, filterTopLevelAgents, loadAgentFeeds, selectAgentChildren } from '../../assets/agents/children.js';
import { buildGlassLayout } from '../look/layout.js';
import { HERDR_LABELS, HERDR_KINDS, HerdrLabelContract } from '../contracts.js';
import type { AgentTerminal } from '../../assets/agents/children.js';
import type { Owner, RunSummary, SessionFeed } from '../contracts.js';
import { middlePath } from '../../assets/shared/feed.js';
import { identityPill, assignSpaceIdentities, threadKeylines } from '../../assets/shared/look.js';

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
  const mod = (name: string) => ({ name: `glass-${name}`, clonedFrom: { name, version: '0.1.12' }, files: { 'main.js': source, 'mod.json': JSON.stringify({ cloned_from: { name, version: '0.1.12' } }) } });
  return { agents: mod('agents'), spaces: mod('spaces'), pane: mod('pane'), tabs: mod('tabs'), 'workspace-chrome': mod('workspace-chrome') };
}
const patches: LookPatchSet = { version: 1, upstreamVersion: '0.1.12', mods: { agents: [{ id: 'heading', anchor: '"Agents"', replacement: '"AGENTS"' }], spaces: [], pane: [], tabs: [] } };
const cleanup: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });

const names = { agents: 'glass-agents', spaces: 'glass-spaces', pane: 'glass-pane', tabs: 'glass-tabs', spider: 'spider', chrome: 'spider-chrome' };
const layoutFixture = () => ({ id: 'root', type: 'row', cloned_from: { name: 'main', version: '0.1.12' }, terminal_padding: [14, 12], divider: { width: 1 }, children: [
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
    expect(findNode(result, 'main')).toMatchObject({ content: { pane: { lone: true, radius: 12, gap: 8, header: { content: { mod: 'glass-pane' }, height: 30 } } } });
    expect(JSON.stringify(source)).toBe(before);
  });
  it('moves traffic lights off-window and uses the chrome clone only for the brand', () => {
    const source = layoutFixture();
    source.children.push({ id: 'brand', content: { mod: 'workspace-chrome' }, children: [] } as never);
    source.children.push({ id: 'footer', content: { mod: 'workspace-chrome', props: { footer: true } }, children: [] } as never);
    const result = buildGlassLayout(source, { ...names, chrome: 'spider-chrome' });
    expect(result.traffic_lights).toEqual([-60, -60]);
    expect(findNode(result, 'brand')).toMatchObject({ content: { mod: 'spider-chrome' } });
    expect(findNode(result, 'footer')).toMatchObject({ content: { mod: 'workspace-chrome', props: { footer: true } } });
  });
  it('frames all panes with a neutral border and focused panes with the theme accent', () => {
    const result = buildGlassLayout(layoutFixture(), names);
    expect(findNode(result, 'main')).toMatchObject({ content: { pane: { border: { width: 1, color: '#38383a' }, focus: { width: 1, color: 'accent' } } } });
    expect(result.colors).toMatchObject({ border: '#00000000' });
    expect(glassTheme.colors.accent).toBe('#d9d9db');
  });
  it('frames the panel without changing the stack or its spacing', () => {
    const result = buildGlassLayout(layoutFixture(), names);
    const panel = findNode(result, 'panel')!;
    expect(panel).toMatchObject({ radius: 12, border: { width: 1, color: '#38383a' }, padding: 5, background: '#161618f0' });
    const radius = panel.radius as number, inset = panel.padding as number, border = (panel.border as { width: number }).width;
    expect(Math.hypot(radius - inset, radius - inset)).toBeLessThan(radius - border);
    expect(findNode(result, 'work-body')).toMatchObject({ padding: 8, gap: 8 });
    expect((findNode(result, 'panel-body')!.children as { id: string }[]).map(n => n.id)).toEqual(['files', 'changes', 'spider']);
  });
  it('uses the dashboard web mark for the small Spider tab icon', async () => {
    const icon = await readFile(resolve('packages/herdr/assets/tabs/spider.svg'), 'utf8');
    const dashboard = await readFile(resolve('packages/host/src/usage/web/app.ts'), 'utf8');
    const path = /<path\s+d="([^"]+)"/.exec(icon)?.[1];
    const webPath = /svg\("([^"]+)", "0 0 56 56", "web-mark"\)/.exec(dashboard)?.[1];
    expect(path).toBeTruthy();
    expect(webPath).toBeTruthy();
    expect(path).toBe(webPath);
    expect(icon).toContain('viewBox="0 0 56 56"');
    expect(icon).toContain('stroke-width="3.5"');
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
    if (key === 'on_mouse_down') return (button: string, fn: Function) => { o[`mouse_${button}`] = fn; return proxy; };
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
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) {
    const source = await readFile(join(root, name, 'main.js'), 'utf8');
    result[name] = { name: `glass-${name}`, clonedFrom: { name, version: '0.1.12' }, files: { 'main.js': source, 'mod.json': await readFile(join(root, name, 'mod.json'), 'utf8') } };
  }
  return result;
}
function loadView(source: string, supplied: Record<string, unknown>): any {
  const ports = { FEED_REFRESH_MS, identityPill, assignSpaceIdentities, threadKeylines, projectAgentChildren, filterTopLevelAgents, loadAgentFeeds, selectAgentChildren, createFeedReader, exec: async () => { throw new Error('Unexpected reader process'); }, ...supplied };
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const name = /class (\w+) extends View/.exec(code)![1];
  return new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return ${name};`)(ports);
}
it('keeps owner actions and running rows live for twenty seconds, then disconnects them', () => {
  const content = { ...feed(), updatedAt: 1000 };
  const terminals = [terminal('t4', 't1', HERDR_KINDS.subagentViewer, 'run-one'), terminal('alpha.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one')];
  const fresh = projectAgentChildren(terminals, [content], 't1', contract, { now: 21000 });
  expect(fresh.find(row => row.key === 'run-one')).toMatchObject({ status: 'working', action: { kind: 'ipc' } });
  expect(fresh.find(row => row.key === 'job-one')?.status).toBe('working');
  const expired = projectAgentChildren(terminals, [content], 't1', contract, { now: 21001 });
  expect(expired.find(row => row.key === 'run-one')).toMatchObject({ status: 'disconnected', action: { kind: 'peek' } });
  expect(expired.find(row => row.key === 'job-one')?.status).toBe('disconnected');
});
const fixturePresent = Boolean(process.env.SPIDER_HERDR_MOD_FIXTURE);
describe.skipIf(!fixturePresent)('current built-ins (requires SPIDER_HERDR_MOD_FIXTURE; no app window)', () => {
  it.each([268, 76])('opens the clicked session menu at sidebar width %i', async width => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const opened: unknown[] = [], calls: unknown[] = [], config = { modId: 'spider-sidebar', labelContract: contract, feedRoot: '/fixture' };
    const ports = { View: class {}, div: ui, h_flex: ui, v_flex: ui, image: ui, svg: ui, projectAgentChildren, filterTopLevelAgents,
      agents: () => [{ address: 'remote.invalid/t5', pane: 'remote.invalid/p5', status: 'working', seq: 1 }, { address: 't6', pane: null, status: 'working', seq: 2 }],
      terminals: () => [], panes: () => [], focused: () => null, spaces: () => [], theme: () => ({}), shared: () => null, setShared: () => {}, setAgentOrder: () => {},
      openOverlay: (spec: unknown) => opened.push(spec), closeOverlay: () => {}, props: () => config, window: () => ({}), layout: () => ({ id: 'sidebar', size: { px: width } }),
      run: (name: string, args: unknown) => calls.push([name, args]), localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } };
    const Agents = loadView(patched.agents.files['main.js'], ports), view = new Agents();
    view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = []; view.listed = new Map();
    const rows = elements(view.render({})), row = rows.find(el => el.id === 'ag-remote.invalid/t5')!, parked = rows.find(el => el.id === 'ag-t6')!;
    if (width < 160) {
      expect(row).toBeUndefined();
      expect(parked).toBeUndefined();
      expect(opened).toEqual([]);
      return;
    }
    expect(row.mouse_right).toBeTypeOf('function');
    let stopped = 0;
    (row.mouse_right as Function)({}, { stop_propagation: () => { stopped++; } });
    expect(stopped).toBe(1);
    expect(opened).toEqual([{ mod: 'spider-agents', kind: 'popup', width: 280, height: 420,
      props: { ...config, modId: 'spider-agents', moveMenu: { kind: 'pane', pane: 'remote.invalid/p5', terminal: 'remote.invalid/t5' } } }]);
    expect(parked.mouse_right).toBeUndefined();
    (row.click as Function)();
    expect(calls).toEqual([['pane.focus', { pane: 'remote.invalid/p5' }]]);
  });

  it('opens the subagent menu with the owning mod identity', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const opened: unknown[] = [], config = { modId: 'spider-sidebar', labelContract: contract };
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui,
      props: () => config, terminals: () => [], openOverlay: (spec: unknown) => opened.push(spec) });
    const view = new Agents(); view.listed = new Map();
    const item = { kind: 'subagent', key: 'run-one', address: 'viewer', originalAddress: 'viewer', action: null, retained: false, status: 'working', spider: true };
    const row = elements(view.subRow({}, { t: item, lines: [] }, null, false)).find(el => el.id === 'sub-run-one')!;
    let stopped = 0;
    (row.mouse_right as Function)({}, { stop_propagation: () => { stopped++; } });
    expect(stopped).toBe(1);
    expect(opened).toEqual([{ mod: 'spider-agents', kind: 'popup', width: 280, height: 420,
      props: { ...config, modId: 'spider-agents', moveMenu: { kind: 'subagent', key: 'run-one', terminal: 'viewer', action: null, retained: false } } }]);
  });

  it('one patched agents tree merges both child kinds and suppresses top-level replay', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const all = [terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one'), terminal('t3', 't1', HERDR_KINDS.remoteObserver, 'job-one'), terminal('t4', 't1', HERDR_KINDS.subagentViewer, 'run-one')];
    let order: string[] = [];
    const ports = { View: class {}, div: ui, h_flex: ui, v_flex: ui, image: ui, svg: ui, projectAgentChildren, filterTopLevelAgents,
      agents: () => [{ address: 't1', status: 'working', seq: 1, focused: false }, { address: 't3', status: 'working', seq: 2 }, { address: 't4', status: 'working', seq: 3 }], terminals: () => all, panes: () => [], focused: () => null, spaces: () => [], theme: () => ({}), shared: () => null, setShared: () => {}, setAgentOrder: (ids: string[]) => { order = ids; }, openOverlay: () => {}, closeOverlay: () => {}, props: () => ({ labelContract: contract, labelFont: 'Fixture Label Face' }), window: () => ({}), layout: () => ({ id: 'sidebar', size: { px: 268 } }), run: () => {}, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } };
    const Agents = loadView(patched.agents.files['main.js'], ports); const view = new Agents();
    view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = [feed()]; view.listed = new Map();
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
      createFeedReader: () => ({ read: async () => { calls.push(['snapshot']); return { feeds: [{ ...feed([done]), updatedAt: Date.now() }], errors: [] }; } }),
      exec: async (bin: string, args: string[]) => { calls.push([bin, args]); return { code: 0, stdout: JSON.stringify(args[1] === 'ipc' ? { ok: true, op: 'openRun', viewer: 't4' } : ['session-one']), stderr: '' }; },
      watchFolder: async () => { throw new Error('fixture watcher closed'); },
      props: () => config, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} }, run: (name: string, args: unknown) => calls.push([name, args]), terminals: () => [],
    };
    const cx = { notify: () => {}, timer: { every: () => {} }, spawn: (fn: (cx: unknown) => Promise<unknown>) => { tasks.push(fn(cx)); } };
    const Agents = loadView(patched.agents.files['main.js'], ports), view = new Agents();
    view.init({}, cx); await Promise.all(tasks);
    expect(view.spiderFeeds?.map((f: SessionFeed) => f.sessionId)).toEqual(['session-one']);
    expect(calls.some(c => JSON.stringify(c).includes('jobs.json'))).toBe(false);
    expect(view.tree([], 't1')).toEqual([]);
    const toggle = uiData.get(view.finishedToggle({}, 't1')[0])!;
    expect(toggle.children).toContain('1 finished');
    (toggle.click as Function)(null, cx);
    const rows = view.tree([], 't1');
    const button = uiData.get(view.subRow({}, rows[0], null, false))!; (button.click as (...args: unknown[]) => void)(null, cx); await Promise.all(tasks);
    const ipcCall = calls.find(c => Array.isArray(c) && c[0] === '/fixture/node' && Array.isArray(c[1]) && c[1][1] === 'ipc') as [string, string[]];
    expect(parsePanelIpcArgv([ipcCall[0], ...ipcCall[1]])).toMatchObject({ request: { op: 'openRun', runId: 'run-one', generation: 'generation-one' } });
    expect(calls.some(c => Array.isArray(c) && c[0] === 'terminal.peek')).toBe(false);
  });
  it('feed watch bursts request at most one snapshot every five seconds and retain the latest update', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    let now = 10000, revision = 1;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const listings: number[] = [], reads: number[] = [], watches: (() => void)[] = [], timers: { ms: number; tick: (cx: any) => void }[] = [];
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, props: () => ({ labelContract: contract, feedRoot: '/fixture', nodePath: '/fixture/node' }),
      createFeedReader: () => ({ read: async () => { listings.push(now); reads.push(revision); return { feeds: [{ ...feed(), revision }], errors: [] }; } }),
      watchFolder: () => new Promise<void>(resolve => watches.push(resolve)), localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
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
    now += 5000; reloadTick(); await settle(); expect(listings).toEqual([10000, 15000, 20000]);
    expect(timers.map(t => t.ms).sort((a, b) => a - b)).toEqual([5000, 30000]);
  });
  it('a failed feed watch still refreshes heartbeat snapshots every five seconds', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    let now = 10000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const listings: number[] = [], timers: { ms: number; tick: (cx: any) => void }[] = [];
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, props: () => ({ labelContract: contract, feedRoot: '/fixture', nodePath: '/fixture/node' }),
      createFeedReader: () => ({ read: async () => { listings.push(now); return { feeds: [feed()], errors: [] }; } }),
      watchFolder: async () => { throw new Error('watch unavailable'); }, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const cx: any = { notify: () => {}, spawn: (fn: (cx: any) => Promise<unknown>) => fn(cx), timer: { every: (ms: number, tick: (cx: any) => void) => timers.push({ ms, tick }) } };
    const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    const view = new Agents(); view.init({}, cx); await settle(); expect(listings).toEqual([10000]);
    const expected = [10000];
    for (const elapsed of [5000, 10000, 25000, 30000]) {
      now = 10000 + elapsed; expected.push(now); timers.forEach(t => t.tick(cx)); await settle();
      expect(listings).toEqual(expected);
    }
  });
  it('refreshes heartbeat-only snapshots every five seconds so a busy owner never flashes disconnected', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    let now = 10000, heartbeat = now, requests = 0, starts = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const content = { ...feed(), updatedAt: now };
    const timers: { ms: number; tick: (cx: any) => void; cancelled: boolean }[] = [];
    const Agents = loadView(patched.agents.files['main.js'], { View: class {},
      props: () => ({ labelContract: contract, feedRoot: '/fixture', nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' }),
      exec: async () => { starts++; return { code: 0, stdout: JSON.stringify({ version: 1, port: 34567, token: '0'.repeat(64), pid: 1 }) }; },
      fetch: async (url: string) => ({ ok: true, json: async () => url.endsWith('/close') ? { ok: true } : {
        version: 1, entries: [{ source: content.sessionId, stamp: 'unchanged', updatedAt: heartbeat }],
        changes: ++requests === 1 ? [{ source: content.sessionId, stamp: 'unchanged', feed: content }] : [], errors: [],
      } }),
      watchFolder: async () => { throw new Error('watch unavailable'); }, localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} },
    });
    const cx: any = { notify() {}, spawn: (fn: (cx: any) => Promise<unknown>) => fn(cx), timer: { every: (ms: number, tick: (cx: any) => void) => {
      const entry = { ms, tick, cancelled: false }; timers.push(entry); return { cancel: () => { entry.cancelled = true; } };
    } } };
    const view = new Agents();
    const settle = async () => {
      for (let i = 0; i < 1000; i++) { if (!view.spiderLoading && view.spiderWatchFailed) return; await Promise.resolve(); }
      throw new Error('Sidebar refresh did not settle');
    };
    view.init({}, cx); await settle();
    const statuses: string[] = [];
    for (now = 15000; now <= 70000; now += 5000) {
      heartbeat = Math.floor(now / 2000) * 2000;
      for (const timer of [...timers]) if (!timer.cancelled) timer.tick(cx); await settle();
      statuses.push(view.tree([], 't1').find((row: any) => row.t.key === 'run-one')?.t.status ?? 'missing');
    }
    await view.close();
    expect(statuses).toEqual(Array(12).fill('working'));
    expect(requests).toBe(13); expect(starts).toBe(1);
    expect(view.spiderFeeds[0]).toMatchObject({ revision: 1, updatedAt: heartbeat });
    expect(content.updatedAt).toBe(10000);
  });
  it('releases the sidebar refresh when its reader stops responding', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    vi.useFakeTimers();
    const Agents = loadView(patched.agents.files['main.js'], { View: class {},
      props: () => ({ feedRoot: '/fixture', nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' }),
      exec: async () => ({ code: 0, stdout: JSON.stringify({ version: 1, port: 34567, token: 'a'.repeat(64), pid: 1 }) }),
      fetch: async (url: string) => url.endsWith('/close') ? { ok: true, json: async () => ({}) } : new Promise(() => {}),
      watchFolder: () => new Promise(() => {}), localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} },
    });
    const cx: any = { notify() {}, spawn: (fn: (cx: any) => Promise<unknown>) => fn(cx), timer: { every: (ms: number, fn: (cx: any) => void) => {
      const handle = setInterval(() => fn(cx), ms); return { cancel: () => clearInterval(handle) };
    } } };
    const view = new Agents();
    try {
      view.init({}, cx);
      await vi.advanceTimersByTimeAsync(15000);
      expect(view.spiderLoading).toBe(false);
      expect(view.spiderFeedError).toBe('Session feeds unavailable; run doctor');
    } finally { await view.close(); vi.useRealTimers(); }
  });

  it('reuses one reader across sidebar reloads and closes it with the view', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    let now = 10000, starts = 0, requests = 0, closes = 0; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const Agents = loadView(patched.agents.files['main.js'], { View: class {},
      props: () => ({ feedRoot: '/fixture', nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' }),
      exec: async () => { starts++; return { code: 0, stdout: JSON.stringify({ version: 1, port: 34567, token: '0'.repeat(64), pid: 1 }) }; },
      fetch: async (url: string) => { if (url.endsWith('/close')) closes++; else requests++; return { ok: true, json: async () => ({ version: 1, entries: [], changes: [], errors: [] }) }; },
    });
    const view = new Agents(); view.spiderFeeds = [];
    view.spiderFeedTimer = { every: (ms: number, callback: () => void) => { const handle = setTimeout(callback, ms); return { cancel: () => clearTimeout(handle) }; } };
    for (let i = 0; i < 6; i++) { now += 5001; await view.reloadSpiderFeeds(); }
    await view.close();
    expect(starts).toBe(1); expect(requests).toBe(6); expect(closes).toBe(1);
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
  it('the native sort menu still offers grouping by space', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const stored = new Map<string, unknown>(), closed: unknown[] = [];
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui,
      theme: () => ({}), props: () => ({ modId: 'glass-agents-a', sortMenu: true, overlay: 'sort-overlay' }),
      shared: (key: string) => stored.get(key), setShared: (key: string, value: unknown) => stored.set(key, value),
      closeOverlay: (id: unknown) => closed.push(id) });
    const menu = elements(new Agents().render({}));
    expect(menu.some(el => el.children.includes('Priority'))).toBe(true);
    expect(menu.some(el => el.children.includes('Grouped by space'))).toBe(true);
    menu.find(el => el.id === 'sort-grouped')!.click!();
    expect(stored.get('agents.sort')).toBe('grouped');
    expect(closed).toEqual(['sort-overlay']);
  });
  it.each([268, 76])('all main sessions remain visible with old stored filters at width %s', async width => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const old = { machine: 'remote.invalid', agent: 'run:run-one' };
    const stored = new Map<string, unknown>([['spider.agents.filters/glass-agents', old]]), overlays: any[] = [];
    const job = terminal('remote.invalid/t2', 't1', HERDR_KINDS.exec, 'job-one');
    job.labels = { ...job.labels, [contract.labels.machine]: 'remote.invalid' };
    const all = [job];
    const mains = [{ address: 't1', status: 'working', seq: 1 }, { address: 't9', status: 'idle', seq: 2 }];
    const p = { modId: 'glass-agents', labelContract: contract };
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, image: ui, svg: ui,
      agents: () => mains, terminals: () => all, panes: () => [], focused: () => null, spaces: () => [], theme: () => ({}),
      shared: (key: string) => stored.get(key), setShared: (key: string, value: unknown) => stored.set(key, value), setAgentOrder: () => {},
      openOverlay: (o: unknown) => overlays.push(o), props: () => p, layout: () => ({ id: 'sidebar', size: { px: width } }), run: () => {},
      localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Agents(); view.folded = new Set(); view.changed = {}; view.pendingPins = []; view.migratingPins = new Set(); view.spiderFeeds = [feed()];
    const rendered = elements(view.render({})), ids = rendered.map(el => el.id);
    if (width < 160) {
      expect(ids).not.toContain('ag-t1');
      expect(ids).not.toContain('ag-t9');
      expect(stored.get('spider.agents.filters/glass-agents')).toEqual(old);
      return;
    }
    expect(ids).toEqual(expect.arrayContaining(['ag-t1', 'ag-t9']));
    expect(ids.filter(id => id?.startsWith('sec-'))).toEqual([]);
    expect(ids.some(id => id?.startsWith('agents-filter-') || id === 'agents-clear-filters')).toBe(false);
    expect(stored.get('spider.agents.filters/glass-agents')).toEqual(old);
    if (width >= 160) {
      expect(ids).toContain('sub-run-one');
      expect(ids).toContain('sub-job-one');
      rendered.find(el => el.id === 'ag-sort')!.click!();
      expect(overlays.at(-1).mod).toBe('glass-agents');
    }
  });
  it('loads the first feed without reading or rewriting old filter state', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const stored = new Map<string, unknown>([['spider.agents.filters/glass-agents', { machine: null, agent: 'run:run-one' }]]);
    let release!: () => void; const reads: string[] = [], writes: string[] = [];
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, parseFeed,
      props: () => ({ modId: 'glass-agents', labelContract: contract, feedRoot: '/fixture', nodePath: '/fixture/node' }),
      createFeedReader: () => ({ read: () => new Promise(resolve => { release = () => resolve({ feeds: [feed()], errors: [] }); }) }),
      shared: (key: string) => { reads.push(key); return stored.get(key); }, setShared: (key: string, value: unknown) => { writes.push(key); stored.set(key, value); } });
    const view = new Agents(); view.spiderFeeds = [];
    const loading = view.reloadSpiderFeeds(); for (let i = 0; i < 10; i++) await Promise.resolve();
    release(); await loading;
    expect(view.spiderFeeds.map((item: SessionFeed) => item.sessionId)).toEqual(['session-one']);
    expect(reads).toEqual([]); expect(writes).toEqual([]);
    expect(stored.get('spider.agents.filters/glass-agents')).toEqual({ machine: null, agent: 'run:run-one' });
  });
  it('the sort popup remains usable when there are no agents', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Agents = loadView(patched.agents.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui,
      theme: () => ({}), props: () => ({ modId: 'glass-agents', sortMenu: true }), shared: () => null, setShared: () => {} });
    const menu = elements(new Agents().render({}));
    expect(menu.some(el => el.children.includes('Priority'))).toBe(true);
    expect(menu.some(el => el.children.includes('Grouped by space'))).toBe(true);
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
  it('the Spaces header keeps the new-space control but has no Spider panel button', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const Spaces = loadView(patched.spaces.files['main.js'], { View: class {}, div: ui, h_flex: ui, v_flex: ui, svg: ui, image: ui,
      machines: () => [], spaces: () => [], panes: () => [], focused: () => null, theme: () => ({}), shared: () => null, setShared: () => {},
      run: () => {}, props: () => ({}), window: () => ({}), layout: () => ({ id: 'sidebar', size: { px: 268 } }), openOverlay: () => {}, closeOverlay: () => {},
      localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Spaces(); view.folded = new Set(); view.machines = []; view.reconnecting = {}; view.shown = new Set();
    const rendered = elements(view.render());
    expect(rendered.some(el => el.children.includes('Spaces'))).toBe(true);
    expect(rendered.some(el => el.id === 'spider-panel')).toBe(false);
    expect(rendered.some(el => el.id === 'space-new')).toBe(true);
  });
  it('the panel tab strip opens Spider without focusing a terminal', async () => {
    const patched = await applyLookPatches(await currentClones(), shippedPatches as LookPatchSet);
    const actions: unknown[] = [];
    const root = { id: 'root', children: [{ id: 'sidebar', size: { px: 268 } }, { id: 'panel', hidden: true, children: [{ id: 'panel-body', active: 'files' }] }] };
    const Tabs = loadView(patched.tabs.files['main.js'], { View: class {}, div: ui, h_flex: ui, svg: ui, image: ui,
      spaces: () => [{ id: 'space', active: true, tabs: [] }], panes: () => [], run: (name: string, args: unknown) => actions.push([name, args]),
      openOverlay: () => {}, theme: () => ({}), window: () => ({}), shared: () => null, layout: () => root, settings: () => ({ zoom: 1 }),
      localStorage: { removeItem: () => {}, getItem: () => null, setItem: () => {} } });
    const view = new Tabs(); view.init();
    const rendered = elements(view.render());
    expect(rendered.some(el => el.id === 'panel-spider')).toBe(true);
    rendered.find(el => el.id === 'panel-spider')!.click!();
    expect(actions).toEqual([['layout.select', { stack: 'panel-body', child: 'spider' }], ['layout.show', { id: 'panel' }]]);
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
    const next = clones(); next.agents.clonedFrom.version = '0.1.13';
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
    expect(projectAgentChildren([live], [stale], 't1', contract, { now: 20002 })[0]).toMatchObject({ status: 'disconnected', outcome: null, completeness: 'unknown', retained: false });
  });
});
