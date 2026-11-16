// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import * as children from '../../assets/agents/children.js';
import * as grouping from '../../assets/agents/grouping.js';
import * as connections from '../../assets/agents/connections.js';
import * as consoleGroups from '../../assets/agents/console-groups.js';
import * as look from '../../assets/shared/look.js';
import * as feed from '../../assets/shared/feed.js';
import { projectNavigation } from '../../assets/shared/navigation.js';
import { describeOpenFailure } from '../../assets/shared/open-failure.js';
import { HerdrLabelContract } from '../contracts.js';
import { createUiModules } from './strict-mod-api.mjs';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe, type SpacesAVersion } from './spaces-a-fixture.js';

afterEach(() => vi.restoreAllMocks());

function fixture(version: SpacesAVersion, count: number, finished: number) {
  const now = Date.now(), contract = HerdrLabelContract;
  const state: any = { agents: [], terminals: [], panes: [], spaces: [{ id: 'space', name: 'Work', tabs: [] }], feeds: [], errors: [],
    focus: { space: 'space', tab: 'tab0', pane: 'pane0', agent: 't0' }, machines: [{ name: null, layout: 'ready' }], inventory: [] };
  let rendering = false, historyReads = 0, allHistoryReads = 0, notifications = 0, agentReads = 0, projections = 0, projectedFinished = 0;
  for (let i = 0; i < count; i++) {
    const address = `t${i}`, sessionId = `s${i}`, tab = `tab${i}`, pane = `pane${i}`, live = `live${i}`;
    const program = { key: 'agent', name: 'Agent', icon: null, agent: true };
    state.agents.push({ address, pane, tab, space: 'space', space_name: 'Work', status: 'working', seq: i, focused: false, title: `Task ${i}`, program });
    state.terminals.push({ address, parent: null, state: 'live', status: 'working', program, labels: { 'spider.session': sessionId } });
    state.terminals.push({ address: `v${i}`, parent: address, state: 'live', status: 'working', labels: { 'spider.kind': 'subagent-viewer', 'spider.session': sessionId, 'spider.run': live } });
    state.panes.push({ pane, tab, terminal: address, title: `Task ${i}`, program, focused: false });
    state.spaces[0].tabs.push({ id: tab, name: `Task ${i}`, named: true });
    const runs: any[] = [{ id: live, ownerSessionId: sessionId, name: `Active ${i}`, status: 'running', childMode: 'rpc', canSteer: true, startedAt: now - 10000, finishedAt: null, viewer: `v${i}`, result: null }];
    for (let j = 0; j < finished; j++) runs.push({ id: `run${i}-${j}`, ownerSessionId: sessionId, name: `Finished ${i}-${j}`, status: 'done', childMode: 'print', canSteer: false, startedAt: now - 60000, finishedAt: now - 5000 - j * 1000, viewer: null, result: null });
    const rows = new Proxy(runs, { get(target, key, receiver) {
      if (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key)) { allHistoryReads++; if (rendering) historyReads++; }
      return Reflect.get(target, key, receiver);
    } });
    const owner = { sessionId, generation: 'gen', terminal: { coreId: 'core', terminalId: address, address, socket: 'socket', sessionNamespace: 'fixture' }, cwd: 'fixture', sessionFile: null, name: `Owner ${i}` };
    state.feeds.push({ version: 1, sessionId, generation: 'gen', revision: 1, updatedAt: now, owner, placement: null, lifecycle: 'live', status: { native: 'working', effective: 'working', message: null }, runs: { rows, total: rows.length, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], ipc: { address: 'ipc', capabilityFile: 'capability' }, errors: [] });
  }
  const watches: { fire: () => void }[] = [], after: { callback: (cx: any) => unknown; cancelled: boolean }[] = [];
  const timers: { ms: number; callback: (cx: any) => unknown }[] = [];
  const cx: any = {
    notify() { notifications++; }, stop_propagation() {},
    timer: {
      every(ms: number, callback: (cx: any) => unknown) { timers.push({ ms, callback }); return { cancel() {} }; },
      after(_ms: number, callback: (cx: any) => unknown) { const task = { callback, cancelled: false }; after.push(task); return { cancel() { task.cancelled = true; } }; },
    },
    spawn(fn: (cx: any) => unknown) { const task = Promise.resolve().then(() => fn(cx)); task.catch(() => {}); return task; },
    sleep: async () => {},
  };
  const commands: ((command: string) => void)[] = [], sharedState = new Map<string, unknown>(), execCalls: unknown[][] = [], runCalls: unknown[][] = [];
  const nextCommand = () => new Promise<string>(resolve => commands.push(resolve));
  const modules = createUiModules(), kit = modules['gpui-kit'], base = modules['gpui-base'];
  const palette = new Proxy({}, { get: () => '#808080' });
  const config = { modId: 'spider-agents', feedRoot: 'feeds', nodePath: 'node', cliPath: 'cli', labelContract: contract, retention: { completedRows: 50, completedHours: 24 } };
  const storage = new Map<string, string>();
  const host: Record<string, any> = {
    ...children, ...grouping, ...connections, ...consoleGroups, ...look, ...feed, ...kit, ...base,
    projectAgentChildren: (...args: Parameters<typeof children.projectAgentChildren>) => { const rows = children.projectAgentChildren(...args); projections++; projectedFinished += rows.filter(row => row.retained).length; return rows; },
    projectNavigation: (snapshot: Parameters<typeof projectNavigation>[0]) => { if (state.throwNavigation) { state.throwNavigation = false; throw new Error('projection failed'); } return projectNavigation(snapshot); }, describeOpenFailure,
    createFeedReader: () => ({ read: async () => ({ feeds: state.feeds, errors: state.errors }), stamps: () => new Map(state.feeds.map((item: any) => [item.sessionId, String(item.stamp ?? item.revision)])), close: async () => {} }),
    initMoveMenu() {}, renderMoveMenu() {}, herdr: { checking: () => false }, props: () => config,
    agents: () => { agentReads++; return structuredClone(state.agents); }, terminals: () => structuredClone(state.terminals), panes: () => structuredClone(state.panes), spaces: () => structuredClone(state.spaces), machines: () => structuredClone(state.machines),
    focused: () => structuredClone(state.focus), theme: () => palette, shared: (key: string) => sharedState.get(key) ?? null, setShared: (key: string, value: unknown) => sharedState.set(key, value), setAgentOrder() {},
    layout: () => ({ id: 'sidebar', size: { px: 268 } }), window: () => ({ platform: 'macos' }),
    run: (...args: unknown[]) => { runCalls.push(args); }, openOverlay() {}, closeOverlay() {}, nextCommand,
    watchFolder: () => {
      let fire!: () => void;
      const promise = new Promise<void>(resolve => { fire = resolve; });
      watches.push({ fire }); return Object.assign(promise, { cancel() {} });
    },
    exec: async (...args: unknown[]) => { execCalls.push(args); return { code: 0, stdout: '{}' }; }, hc: async (args: string[]) => ({ code: 0, stdout: JSON.stringify(args[0] === 'server' ? { core: { id: 'core' } } : { machines: state.inventory }) }),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  };
  const recipe = loadPublishedSpacesARecipe(version);
  let source = replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe).agents!['main.js']!;
  source = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)*import .*;\s*$/gm, '').replace('export default class ', 'class ');
  const name = /class (\w+) extends View/.exec(source)![1];
  const Agents = new Function('host', `const { ${Object.keys(host).join(', ')} } = host; ${source}; return ${name};`)(host);
  const view = new Agents(); view.init({}, cx);
  const flush = async () => {
    for (let i = 0; i < 80; i++) {
      await Promise.resolve();
      for (const task of after.splice(0)) if (!task.cancelled) await task.callback(cx);
    }
  };
  const step = async () => { await Promise.resolve(); const task = after.shift(); if (task && !task.cancelled) await task.callback(cx); };
  const render = () => { rendering = true; try { return view.render(cx); } finally { rendering = false; } };
  const text = (node: any): string[] => typeof node === 'string' ? [node] : node && typeof node === 'object' ? (node.items ?? []).flatMap(text) : [];
  return {
    state, view, cx, watches, timers, flush, step, render, text, sharedState, execCalls, runCalls,
    get historyReads() { return historyReads; },
    get allHistoryReads() { return allHistoryReads; },
    get notifications() { return notifications; },
    get agentReads() { return agentReads; },
    get projections() { return projections; },
    get projectedFinished() { return projectedFinished; },
    async send(command: string) { const resolve = commands.shift(); if (!resolve) throw new Error('No command waiter'); resolve(command); await flush(); },
    async ready() { await flush(); await view.spiderConnections.refresh(); view.spiderRequestRefresh(); await flush(); },
  };
}

it('exposes stable content stamps while heartbeats change and new content replaces a feed', async () => {
  const snapshots = [
    { version: 1, entries: [{ source: 's', stamp: 'first', updatedAt: 100 }], changes: [{ source: 's', stamp: 'first', feed: { version: 1, sessionId: 's', revision: 1, runs: { rows: [] } } }], errors: [] },
    { version: 1, entries: [{ source: 's', stamp: 'first', updatedAt: 200 }], changes: [], errors: [] },
    { version: 1, entries: [{ source: 's', stamp: 'second', updatedAt: 300 }], changes: [{ source: 's', stamp: 'second', feed: { version: 1, sessionId: 's', revision: 1, runs: { rows: [{ id: 'new' }] } } }], errors: [] },
  ];
  const reader = feed.createFeedReader({ nodePath: 'node', cliPath: 'cli', feedRoot: 'feeds' }, {
    timer: { every: () => ({ cancel() {} }) },
    exec: async () => ({ code: 0, stdout: JSON.stringify({ version: 1, port: 1234, pid: 1, token: 'a'.repeat(64) }), stderr: '' }),
    fetch: async url => ({ ok: true, json: async () => url.endsWith('/close') ? {} : snapshots.shift() }),
  });
  try {
    const first = await reader.read();
    expect(first.feeds[0].updatedAt).toBe(100);
    expect(reader.stamps().get('s')).toBe('first');
    const heartbeat = await reader.read();
    expect(heartbeat.feeds[0].updatedAt).toBe(200);
    expect(reader.stamps().get('s')).toBe('first');
    const changed = await reader.read();
    expect(changed.feeds[0].runs.rows).toHaveLength(1);
    expect(reader.stamps().get('s')).toBe('second');
  } finally { await reader.close(); }
});

it('projects a large owner history without repeatedly traversing the history', () => {
  const h = fixture('0.1.13', 1, 400);
  let reads = 0;
  const source = h.state.feeds[0];
  const rows = new Proxy(source.runs.rows, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const input = { ...source, runs: { ...source.runs, rows } };
  const result = children.projectAgentChildren([], [input], 't0', HerdrLabelContract, { now: Date.now(), completedRows: 50 });
  expect(result).toHaveLength(51);
  expect(result[0]).toMatchObject({ key: 'live0', status: 'working' });
  expect(reads).toBeLessThan(10000);
  void h.view.close();
});

it('counts collapsed finished runs without projecting their rows', () => {
  const h = fixture('0.1.13', 1, 400);
  const summary: { hiddenFinished?: number } = {};
  const rows = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract,
    { now: Date.now(), completedRows: 50, finishedSummary: summary });
  expect(rows.map(row => row.key)).toContain('live0');
  expect(rows.filter(row => row.retained)).toHaveLength(0);
  expect(summary.hiddenFinished).toBe(50);
  void h.view.close();
});

it.each([['run0-0', 2, true], ['run0-3', 2, false], ['run0-3', 4, true]] as const)(
  'retains a finished run %s only when its live child and retention require it', (runId, limit, retained) => {
    const h = fixture('0.1.13', 1, 4), now = Date.now();
    h.state.terminals.push({ address: 'remote/job', parent: 't0', state: 'live', status: 'working',
      labels: { 'spider.kind': 'exec', 'spider.session': 's0', 'spider.job': 'job', 'spider.run': runId, 'spider.machine': 'remote' } });
    const options = { now, completedRows: limit }, summary: { hiddenFinished?: number } = {};
    const full = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, options);
    const visible = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, { ...options, finishedSummary: summary });
    expect(visible.find(row => row.key === 'job')?.parentKey).toBe(full.find(row => row.key === 'job')?.parentKey);
    expect(visible.some(row => row.key === runId)).toBe(retained);
    expect(summary.hiddenFinished).toBe(limit - Number(retained));
    void h.view.close();
  },
);

it('counts deduplicated finished runs and respects equal-time retention ties', () => {
  const h = fixture('0.1.13', 1, 4), now = Date.now(), runs = h.state.feeds[0].runs.rows;
  for (const run of runs.slice(1)) run.finishedAt = now - 1000;
  runs.push({ ...runs[1], name: 'duplicate' });
  h.state.terminals.push({ address: 'remote/job', parent: 't0', state: 'live', status: 'working',
    labels: { 'spider.kind': 'exec', 'spider.session': 's0', 'spider.job': 'job', 'spider.run': 'run0-3', 'spider.machine': 'remote' } });
  const options = { now, completedRows: 2 }, summary: { hiddenFinished?: number } = {};
  const full = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, options);
  const visible = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, { ...options, finishedSummary: summary });
  expect(full.filter(row => row.retained).map(row => row.key)).toEqual(['run0-0', 'run0-1']);
  expect(visible.find(row => row.key === 'job')?.parentKey).toBeNull();
  expect(summary.hiddenFinished).toBe(2);
  void h.view.close();
});

it('preserves visible row order when a finished duplicate becomes active', () => {
  const h = fixture('0.1.13', 1, 0), now = Date.now(), active = h.state.feeds[0].runs.rows[0];
  h.state.feeds[0].runs.rows = [{ ...active, status: 'done', finishedAt: now - 1000 }, active];
  h.state.terminals.push({ address: 'remote/job', parent: 't0', state: 'live', status: 'working',
    labels: { 'spider.kind': 'exec', 'spider.session': 's0', 'spider.job': 'job', 'spider.machine': 'remote' } });
  const options = { now, completedRows: 50 }, summary: { hiddenFinished?: number } = {};
  const full = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, options);
  const compact = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, { ...options, finishedSummary: summary });
  expect(full.map(row => row.key)).toEqual(['live0', 'job']);
  expect(compact.map(row => row.key)).toEqual(full.map(row => row.key));
  void h.view.close();
});

it('does not count a retained terminal hidden under a folded finished run', () => {
  const h = fixture('0.1.13', 1, 4), now = Date.now();
  h.state.terminals.push({ address: 'remote/old-console', parent: 't0', state: 'finished', status: 'idle', finishedAt: now - 2000,
    labels: { 'spider.kind': 'remote-console', 'spider.session': 's0', 'spider.run': 'run0-0', 'spider.machine': 'remote' } });
  const summary: { hiddenFinished?: number } = {};
  const rows = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract,
    { now, completedRows: 50, finishedSummary: summary, folded: new Set(['run0-0']), expandedConsoles: new Set() });
  expect(rows.filter(row => row.retained)).toHaveLength(0);
  expect(summary.hiddenFinished).toBe(4);
  void h.view.close();
});

it('can resolve parked owners without projecting their children', () => {
  const h = fixture('0.1.13', 1, 48);
  h.state.agents[0].pane = null;
  h.state.panes = [];
  const snapshot = { ...h.state, coreId: 'core', destination: null, contract: HerdrLabelContract,
    machines: [{ name: null, layout: 'ready' }], now: Date.now(), completedRows: 50, completedHours: 24 };
  const owners = projectNavigation({ ...snapshot, includeChildren: false });
  expect(owners).toHaveLength(1);
  expect(owners[0]).toMatchObject({ kind: 'agent', sessionId: 's0', pane: null, name: 'Owner 0' });
  void h.view.close();
});

for (const version of ['0.1.13', '0.1.16'] as const) {
  it(`${version}: renders actual rows in the first frame`, async () => {
    const h = fixture(version, 2, 4);
    h.view.spiderFeeds = h.state.feeds;
    try {
      const first = h.text(h.render());
      expect(first).toContain('Owner 0');
      expect(first).toContain('Active 0');
      expect(first).toContain('4 finished');
      expect(first).not.toContain('Loading agent status…');
    } finally { await h.view.close(); }
  });

  it(`${version}: builds finished rows only when their history is expanded`, async () => {
    const h = fixture(version, 20, 48);
    h.view.spiderFeeds = h.state.feeds;
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      const first = h.render();
      expect(h.text(first).filter(value => value === '48 finished')).toHaveLength(20);
      expect(h.projectedFinished).toBe(0);
      const button = find(first, 'finished-toggle-t0');
      button.events.on_click({}, h.cx);
      const expanded = h.text(h.render());
      expect(expanded).toContain('Finished 0-0');
      expect(expanded.filter(value => value === '48 finished')).toHaveLength(19);
      expect(h.projectedFinished).toBe(48);
      await h.flush();
      const before = h.projections;
      h.render(); await h.flush(); h.render(); await h.flush();
      expect(h.projections).toBe(before);
    } finally { await h.view.close(); }
  });

  it(`${version}: does not read hidden run names again to build row objects`, async () => {
    const h = fixture(version, 1, 48); let nameReads = 0;
    const runs = h.state.feeds[0].runs.rows;
    for (let i = 1; i < runs.length; i++) runs[i] = new Proxy(runs[i], { get(target, key, receiver) {
      if (key === 'name') nameReads++;
      return Reflect.get(target, key, receiver);
    } });
    h.view.spiderFeeds = h.state.feeds;
    h.view.spiderFeedStamps = new Map([['s0', 'content']]);
    try {
      expect(h.text(h.render())).toContain('48 finished');
      expect(nameReads).toBe(48);
    } finally { await h.view.close(); }
  });

  it(`${version}: revalidates a visible child without building collapsed history`, async () => {
    const h = fixture(version, 1, 48); h.view.spiderFeeds = h.state.feeds;
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      const row = find(h.render(), 'sub-live0');
      expect(h.projectedFinished).toBe(0);
      row.events.on_click({}, h.cx); await Promise.resolve();
      expect(h.projectedFinished).toBe(0);
      expect(h.execCalls).toHaveLength(1);
    } finally { await h.view.close(); }
  });

  it(`${version}: renders a large unchanged snapshot without traversing finished history`, async () => {
    const h = fixture(version, 100, 48);
    try {
      await h.ready();
      const first = h.text(h.render());
      await h.flush();
      const before = h.historyReads;
      const next = h.text(h.render());
      expect(first).toContain('Owner 99');
      expect(next).toContain('Active 99');
      expect(next.filter(value => value === '48 finished')).toHaveLength(100);
      expect(h.historyReads - before).toBeLessThan(500);
      await h.flush();
      const historyBeforeInvalidations = h.allHistoryReads;
      for (let i = 0; i < 3; i++) { h.render(); await h.flush(); }
      expect(h.allHistoryReads - historyBeforeInvalidations).toBeLessThan(500);
    } finally { await h.view.close(); }
  });

  it(`${version}: keeps hidden history out of render and prepares expanded rows on demand`, async () => {
    const h = fixture(version, 100, 48);
    let rendering = false, reads = 0;
    const wrapped = new WeakMap<object, any>(), project = h.view.projectChildren.bind(h.view);
    h.view.projectChildren = (all: unknown, owner: string) => {
      const rows = project(all, owner);
      let proxy = wrapped.get(rows);
      if (!proxy) {
        proxy = new Proxy(rows, { get(target, key, receiver) {
          if (rendering && (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key))) reads++;
          return Reflect.get(target, key, receiver);
        } });
        wrapped.set(rows, proxy); wrapped.set(proxy, proxy);
        if (h.view.spiderRenderRows?.get(owner) === rows) h.view.spiderRenderRows.set(owner, proxy);
      }
      return proxy;
    };
    const render = () => { rendering = true; try { return h.render(); } finally { rendering = false; } };
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      await h.ready();
      const first = render();
      expect(h.text(first)).toContain('48 finished');
      expect(reads).toBeLessThan(500);
      find(first, 'finished-toggle-t0').events.on_click({}, h.cx);
      reads = 0;
      const expanded = render();
      expect(h.text(expanded)).toContain('Finished 0-0');
      expect(h.text(expanded)).toContain('Hide finished');
      expect(reads).toBeLessThan(500);
    } finally { await h.view.close(); }
  });

  it(`${version}: coalesces host invalidations and no-op commands`, async () => {
    const h = fixture(version, 4, 2);
    try {
      await h.ready(); h.render(); await h.flush();
      const notices = h.notifications, reads = h.agentReads;
      for (let i = 0; i < 5; i++) h.render();
      await h.flush();
      expect(h.agentReads - reads).toBe(1);
      expect(h.notifications).toBe(notices);
      await h.send('sort-priority');
      expect(h.sharedState.get('agents.sort')).toBe('priority');
      await h.send('activate-session:missing');
      await h.send('console-group-toggle:%E0%A4%A');
      await h.send('unrecognized');
      await h.send('toString');
      expect(h.notifications).toBe(notices);
      await h.send('sort-machine');
      expect(h.notifications).toBe(notices + 1);
    } finally { await h.view.close(); }
  });

  it(`${version}: does not notify for an unrelated native terminal label`, async () => {
    const h = fixture(version, 1, 0);
    try {
      await h.ready(); h.render(); await h.flush();
      const before = h.notifications;
      h.state.terminals[0].labels['unrelated.label'] = 'updated';
      h.render(); await h.flush();
      expect(h.notifications).toBe(before);
    } finally { await h.view.close(); }
  });

  it(`${version}: can retry after a projection task fails`, async () => {
    const h = fixture(version, 1, 0);
    try {
      await h.ready(); h.render(); await h.flush();
      h.state.agents[0].status = 'idle'; h.state.throwNavigation = true;
      h.render();
      await expect(h.step()).rejects.toThrow('projection failed');
      expect(h.view.spiderRefreshing).toBe(false);
      h.render(); await h.flush();
      expect(h.view.spiderModel.list[0].status).toBe('idle');
    } finally { await h.view.close(); }
  });

  it(`${version}: displays native rows before asynchronous feeds are available`, async () => {
    const h = fixture(version, 1, 4);
    try {
      const first = h.text(h.render());
      expect(first).toContain('Task 0');
      expect(first).not.toContain('Loading agent status…');
      await h.flush();
      expect(h.text(h.render())).toContain('Owner 0');
    } finally { await h.view.close(); }
  });

  it(`${version}: keeps the previous visible model while an update is built`, async () => {
    const h = fixture(version, 20, 8);
    try {
      await h.ready(); const before = h.text(h.render()); await h.flush();
      const feed = h.state.feeds[0];
      h.state.feeds[0] = { ...feed, revision: 2, owner: { ...feed.owner, name: 'Updated owner' } };
      h.view.spiderReloadAt = -Infinity; h.watches.at(-1)!.fire();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await h.step();
      expect(h.text(h.render())).toEqual(before);
      await h.flush();
      expect(h.text(h.render())).toContain('Updated owner');
    } finally { await h.view.close(); }
  });

  it(`${version}: preserves an expansion made while an update is in flight`, async () => {
    const h = fixture(version, 20, 8);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      await h.ready(); const first = h.render(); await h.flush();
      h.state.agents[0].status = 'blocked'; h.render(); await h.step();
      find(first, 'finished-toggle-t0').events.on_click({}, h.cx);
      expect(h.text(h.render())).toContain('Finished 0-0');
      await h.flush();
      expect(h.text(h.render())).toContain('Finished 0-0');
      expect(h.view.spiderModel.list[0].status).toBe('blocked');
    } finally { await h.view.close(); }
  });

  it(`${version}: catches changes arriving while a projection is in progress`, async () => {
    const h = fixture(version, 20, 8);
    try {
      await h.ready(); h.render(); await h.flush();
      h.state.agents[0].status = 'idle';
      h.render(); await h.step();
      h.state.agents[1].status = 'blocked';
      h.render(); await h.flush();
      expect(h.view.spiderModel.list[0].status).toBe('idle');
      expect(h.view.spiderModel.list[1].status).toBe('blocked');
    } finally { await h.view.close(); }
  });

  it(`${version}: notifies only when a pin hover changes the visible state`, async () => {
    const h = fixture(version, 1, 0);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      await h.ready(); const pin = find(h.render(), 'agent-pin-t0'); await h.flush();
      const before = h.notifications;
      pin.events.on_hover(true, h.cx); pin.events.on_hover(true, h.cx);
      pin.events.on_hover(false, h.cx); pin.events.on_hover(false, h.cx);
      expect(h.notifications).toBe(before + 2);
    } finally { await h.view.close(); }
  });

  it(`${version}: updates changed native and feed rows while reusing unaffected owners`, async () => {
    let now = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 2, 2);
    try {
      await h.ready(); h.render(); await h.flush();
      const unaffected = h.view.spiderModel.rows.get('t1'), before = h.notifications;
      h.state.agents[0].status = 'blocked'; h.state.agents[0].focused = true;
      h.state.terminals[0].status = 'blocked';
      h.render(); await h.flush();
      const changed = h.render(); await h.flush();
      expect(h.view.spiderModel.list[0]).toMatchObject({ status: 'blocked', focused: true });
      expect(h.text(changed)).toContain('!');
      expect(h.view.spiderModel.rows.get('t1')).toBe(unaffected);
      expect(h.notifications).toBe(before + 1);
      now += 5000;
      const first = h.state.feeds[0];
      h.state.feeds[0] = { ...first, stamp: 'changed-content', updatedAt: now,
        runs: { ...first.runs, rows: first.runs.rows.map((row: any, i: number) => i ? row : { ...row, name: 'Updated child' }) } };
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.text(h.render())).toContain('Updated child');
      expect(h.view.spiderModel.rows.get('t1')).toBe(unaffected);
      expect(h.notifications).toBe(before + 2);
    } finally { await h.view.close(); }
  });

  it(`${version}: revalidates child actions against newer snapshots before dispatch`, async () => {
    let now = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 0);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      await h.ready(); const row = find(h.render(), 'sub-live0'); await h.flush();
      expect(row.events.on_click).toBeTypeOf('function');
      now += 5000;
      h.state.feeds[0] = { ...h.state.feeds[0], revision: 2, updatedAt: now, lifecycle: 'closed', ipc: null };
      h.state.terminals[1].state = 'finished';
      h.watches.at(-1)!.fire();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(h.view.spiderFeeds[0].lifecycle).toBe('closed');
      row.events.on_click({}, h.cx); await Promise.resolve();
      expect(h.execCalls).toEqual([]);
      expect(h.runCalls).toEqual([]);
    } finally { await h.view.close(); }
  });

  it(`${version}: expires retained history and updates disconnected feeds at the correct time`, async () => {
    let now = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 2);
    h.state.feeds[0].runs.rows[1].finishedAt = now - 24 * 3600000 + 999;
    try {
      await h.ready(); expect(h.text(h.render())).toContain('2 finished'); await h.flush();
      const before = h.notifications;
      now += 1000; h.state.feeds[0].updatedAt = now;
      h.timers.find(timer => timer.ms === 30000)!.callback(h.cx); await h.flush();
      expect(h.text(h.render())).toContain('1 finished'); await h.flush();
      expect(h.notifications).toBe(before + 1);
      now += 20001;
      h.timers.find(timer => timer.ms === 30000)!.callback(h.cx); await h.flush();
      expect(h.text(h.render())).toContain('Disconnected'); await h.flush();
      expect(h.notifications).toBe(before + 2);
      h.state.feeds[0] = { ...h.state.feeds[0], updatedAt: now };
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.text(h.render())).not.toContain('Disconnected');
      expect(h.notifications).toBe(before + 3);
    } finally { await h.view.close(); }
  });

  it(`${version}: refreshes elapsed labels and machines only when their visible value changes`, async () => {
    let now = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 0);
    try {
      await h.ready(); h.render(); await h.flush();
      const before = h.notifications;
      now += 30000; h.state.feeds[0].updatedAt = now;
      h.timers.find(timer => timer.ms === 30000)!.callback(h.cx); await h.flush();
      await h.timers.find(timer => timer.ms === 15000)!.callback(h.cx); await h.flush();
      expect(h.notifications).toBe(before);
      now += 30000; h.state.feeds[0].updatedAt = now;
      h.timers.find(timer => timer.ms === 30000)!.callback(h.cx); await h.flush();
      expect(h.notifications).toBe(before + 1);
      expect(h.text(h.render())).toContain('1m');
    } finally { await h.view.close(); }
  });

  it(`${version}: notifies for machine changes but not repeated identical polls`, async () => {
    const h = fixture(version, 1, 0);
    try {
      await h.ready(); h.render(); await h.flush();
      const before = h.notifications;
      h.state.inventory = [{ name: 'remote.invalid', id: 'remote-core', state: 'needs_login', target: 'ssh-remote.invalid' }];
      await h.timers.find(timer => timer.ms === 15000)!.callback(h.cx); await h.flush();
      expect(h.notifications).toBe(before + 1);
      await h.timers.find(timer => timer.ms === 15000)!.callback(h.cx); await h.flush();
      expect(h.notifications).toBe(before + 1);
      await h.send('sort-machine');
      expect(h.text(h.render())).toContain('remote.invalid');
      expect(h.text(h.render())).toContain('needs a login: run');
    } finally { await h.view.close(); }
  });

  it(`${version}: updates parked status when its feed changes`, async () => {
    let now = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 0);
    h.state.agents[0].pane = null; h.state.panes = [];
    try {
      await h.ready(); expect(h.text(h.render())).toContain('Parked'); await h.flush();
      const before = h.notifications;
      now += 5000;
      h.state.feeds[0] = { ...h.state.feeds[0], revision: 2, updatedAt: now,
        status: { ...h.state.feeds[0].status, effective: 'blocked' } };
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.view.spiderModel.parked[0].status).toBe('blocked');
      expect(h.notifications).toBe(before + 1);
    } finally { await h.view.close(); }
  });

  it(`${version}: cancels queued projection work when the view closes`, async () => {
    const h = fixture(version, 10, 4);
    await h.ready(); h.render();
    const before = h.notifications;
    await h.view.close(); await h.flush();
    expect(h.notifications).toBe(before);
  });

  it(`${version}: does not request renders for unchanged feed-watch bursts`, async () => {
    let now = 1000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 2);
    try {
      await h.ready(); h.render(); await h.flush();
      const before = h.notifications;
      for (let i = 0; i < 5; i++) { h.watches.at(-1)!.fire(); await h.flush(); }
      expect(h.notifications).toBe(before);
      const rows = h.view.spiderModel.rows.get('t0');
      now += 5000;
      h.state.feeds = [{ ...h.state.feeds[0], updatedAt: now }];
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.notifications).toBe(before);
      expect(h.view.spiderModel.rows.get('t0')).toBe(rows);
      now += 5000;
      h.state.feeds = [{ ...h.state.feeds[0], revision: 2, updatedAt: now, status: { ...h.state.feeds[0].status, message: 'not shown' } }];
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.notifications).toBe(before);
      now += 5000;
      h.state.feeds = [{ ...h.state.feeds[0], revision: 3, updatedAt: now, owner: { ...h.state.feeds[0].owner, name: 'Renamed' } }];
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.notifications).toBe(before + 1);
      expect(h.text(h.render())).toContain('Renamed');
    } finally { await h.view.close(); }
  });
}
