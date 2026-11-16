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
  const state: any = { agents: [], terminals: [], panes: [], spaces: [{ id: 'space', name: 'Work', tabs: [] }], feeds: [] };
  let rendering = false, historyReads = 0, notifications = 0;
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
      if (rendering && (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key))) historyReads++;
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
  const pending = () => { const promise = new Promise(() => {}); return Object.assign(promise, { cancel() {} }); };
  const modules = createUiModules(), kit = modules['gpui-kit'], base = modules['gpui-base'];
  const palette = new Proxy({}, { get: () => '#808080' });
  const config = { modId: 'spider-agents', feedRoot: 'feeds', nodePath: 'node', cliPath: 'cli', labelContract: contract, retention: { completedRows: 50, completedHours: 24 } };
  const storage = new Map<string, string>();
  const host: Record<string, any> = {
    ...children, ...grouping, ...connections, ...consoleGroups, ...look, ...feed, ...kit, ...base, projectNavigation, describeOpenFailure,
    createFeedReader: () => ({ read: async () => ({ feeds: state.feeds, errors: [] }), close: async () => {} }),
    initMoveMenu() {}, renderMoveMenu() {}, herdr: { checking: () => false }, props: () => config,
    agents: () => structuredClone(state.agents), terminals: () => structuredClone(state.terminals), panes: () => structuredClone(state.panes), spaces: () => structuredClone(state.spaces), machines: () => [{ name: null, layout: 'ready' }],
    focused: () => ({ space: 'space', tab: 'tab0', pane: 'pane0', agent: 't0' }), theme: () => palette, shared: () => null, setShared() {}, setAgentOrder() {},
    layout: () => ({ id: 'sidebar', size: { px: 268 } }), window: () => ({ platform: 'macos' }),
    run() {}, openOverlay() {}, closeOverlay() {}, nextCommand: pending,
    watchFolder: () => {
      let fire!: () => void;
      const promise = new Promise<void>(resolve => { fire = resolve; });
      watches.push({ fire }); return Object.assign(promise, { cancel() {} });
    },
    exec: async () => ({ code: 0, stdout: '{}' }), hc: async (args: string[]) => ({ code: 0, stdout: JSON.stringify(args[0] === 'server' ? { core: { id: 'core' } } : { machines: [] }) }),
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
  const render = () => { rendering = true; try { return view.render(cx); } finally { rendering = false; } };
  const text = (node: any): string[] => typeof node === 'string' ? [node] : node && typeof node === 'object' ? (node.items ?? []).flatMap(text) : [];
  return {
    state, view, cx, watches, timers, flush, render, text,
    get historyReads() { return historyReads; },
    get notifications() { return notifications; },
    async ready() { await flush(); await view.spiderConnections.refresh(); await flush(); },
  };
}

for (const version of ['0.1.13', '0.1.16'] as const) {
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
    } finally { await h.view.close(); }
  });

  it(`${version}: does not request renders for unchanged feed-watch bursts`, async () => {
    let now = 1000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 2);
    try {
      await h.ready(); h.render(); await h.flush();
      const before = h.notifications;
      for (let i = 0; i < 5; i++) { h.watches.at(-1)!.fire(); await h.flush(); }
      expect(h.notifications).toBe(before);
      now += 5000;
      h.state.feeds = [{ ...h.state.feeds[0], revision: 2, updatedAt: now, owner: { ...h.state.feeds[0].owner, name: 'Renamed' } }];
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.notifications).toBe(before + 1);
      expect(h.text(h.render())).toContain('Renamed');
    } finally { await h.view.close(); }
  });
}
