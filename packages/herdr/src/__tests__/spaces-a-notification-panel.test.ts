// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createUiModules } from './strict-mod-api.mjs';
import { runPanelScene } from './acceptance/i.js';
import { HerdrLabelContract, type IntentionalNotification, type SessionFeed } from '../contracts.js';
import { indexPaneNavigation, projectNavigation } from '../../assets/shared/navigation.js';
import * as children from '../../assets/agents/children.js';
import { projectPanePresentations } from '../../assets/shared/presentations.js';
import { applyModPatches } from '../look/patches.js';
import { describeOpenFailure } from '../../assets/shared/open-failure.js';
import { FEED_DISCONNECT_MS, FEED_REFRESH_MS, panelIpcArgv, parseSessionIpcReply, requestPaneService } from '../../assets/shared/feed.js';
import * as data from '../../assets/mods/spider/data.js';
import * as sound from '../../assets/mods/spider/sound.js';
import * as paneServiceState from '../../assets/shared/pane-service-state.js';

const now = Date.UTC(2026, 10, 15, 12), day = 86400000;
function feed(session: string, space = 'space-a'): SessionFeed {
  const sessionId = session as SessionFeed['sessionId'], generation = 'g' as SessionFeed['generation'];
  return { version: 1, sessionId, generation, revision: 1, updatedAt: now, lifecycle: 'live',
    owner: { sessionId, generation, terminal: { coreId: 'core' as never, terminalId: session as never, address: session as never, socket: '/fixture/socket', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: session },
    placement: { spaceId: space as never, spaceName: space, spaceOrder: 0, tabId: null }, status: { native: 'idle', effective: 'idle', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: null },
    approvals: [], notifications: [], ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/cap' }, errors: [] };
}
function notice(source: SessionFeed, id: string, urgency: IntentionalNotification['urgency'], createdAt = now): IntentionalNotification {
  return { id, createdAt, title: 'Owner', body: 'Choose a fix', kind: 'intentional', scope: 'session', sessionId: source.sessionId,
    ownerAddress: source.owner.terminal.address, urgency, runId: null, action: { kind: 'focus-owner', sessionId: source.sessionId, address: source.owner.terminal.address } };
}

describe('intentional notification projection', () => {
  it('shows only intentional cards despite blocked status and pending memories', () => {
    const source = feed('owner'); source.status = { native: 'blocked', effective: 'blocked', message: 'Approve?' };
    source.approvals = [{ uuid: 'memory', scope: 'global', repoKey: null, ownerSessionId: null, category: 'insight', preview: 'A memory' }];
    expect(data.projectNotifications([source], now)).toEqual([]);
    expect(data.projectMemoryReview([source])).toHaveLength(1);
    expect(data.projectSessionFacts(source, now).state).toBe('blocked');
  });

  it('orders explicit urgency and shows notices from another space', () => {
    const a = feed('local'), b = feed('other', 'space-b');
    a.notifications = [notice(a, 'low', 'low'), notice(a, 'attention', 'attention')]; b.notifications = [notice(b, 'urgent', 'urgent')];
    const items = data.projectNotifications([a, b], now) as any[];
    expect(items.map(item => item.urgency)).toEqual(['urgent', 'attention', 'low']);
    expect(items.map(item => item.key)).toEqual(['intentional:other:urgent', 'intentional:local:attention', 'intentional:local:low']);
    expect(data.notificationText(items[0])).toContain('Choose a fix');
    const panel = data.projectSpacePanel([a, b], { id: 'space-a', name: 'A' }, now);
    expect(panel.notifications).toHaveLength(3);
    expect(panel.sessions.map(session => session.id)).toEqual(['local']);
  });

  it('names a child occurrence using its run, falling back to the stable run id', () => {
    const source = feed('owner');
    source.runs = { rows: [{ id: 'run-1' as never, ownerSessionId: source.sessionId, name: 'reviewer', status: 'done', childMode: 'print', canSteer: false, startedAt: now - 100, finishedAt: now - 10, viewer: null, result: null }], total: 1, truncated: false };
    source.notifications = [{ ...notice(source, 'child', 'attention'), runId: 'run-1' as never, action: { kind: 'open-run', sessionId: source.sessionId, runId: 'run-1' as never } }];
    expect(data.notificationText(data.projectNotifications([source], now)[0])).toBe('owner reviewer Choose a fix');
    source.runs.rows = []; source.runs.total = 0;
    expect(data.notificationText(data.projectNotifications([source], now)[0])).toBe('owner Run run-1 Choose a fix');
    source.notifications[0] = { ...notice(source, 'child', 'attention'), runId: '0123456789abcdef' as never, action: { kind: 'open-run', sessionId: source.sessionId, runId: '0123456789abcdef' as never } };
    expect(data.notificationText(data.projectNotifications([source], now)[0])).toBe('owner Run 01234567 Choose a fix');
  });

  it('keeps stale and closed owner cards dismissible without deriving automatic cards', () => {
    const stale = feed('stale'), closed = feed('closed'); stale.updatedAt = now - 60000; closed.lifecycle = 'closed';
    stale.notifications = [notice(stale, 'stale-id', 'urgent')]; closed.notifications = [notice(closed, 'closed-id', 'low')];
    expect((data.projectNotifications([stale, closed], now) as any[]).map(item => item.key)).toEqual(['intentional:stale:stale-id', 'intentional:closed:closed-id']);
  });

  it('keeps dismissals across a missing feed until the occurrence expires', () => {
    const a = feed('owner'); a.notifications = [notice(a, 'one', 'attention', now - 1000)];
    const dismissed = new Map([['intentional:owner:one', now - 1000 + 7 * day]]);
    const pruned = (data.pruneDismissed as any)(dismissed, [], now + day);
    expect(pruned.has('intentional:owner:one')).toBe(true);
    expect(data.visibleNotifications(data.projectNotifications([a], now + day), pruned)).toEqual([]);
    a.notifications.push(notice(a, 'two', 'attention', now + day));
    expect(data.visibleNotifications(data.projectNotifications([a], now + day), pruned).map((item: any) => item.key)).toEqual(['intentional:owner:two']);
    expect((data.pruneDismissed as any)(pruned, [], now + 8 * day).size).toBe(0);
  });

  it('does not resurrect a dismissed occurrence at the exact expiry instant', () => {
    const a = feed('owner'); a.notifications = [notice(a, 'one', 'attention', now)];
    const expires = now + 7 * day, dismissed = data.pruneDismissed(new Map([['intentional:owner:one', expires]]), [], expires);
    expect(dismissed.size).toBe(0);
    expect(data.visibleNotifications(data.projectNotifications([a], expires), dismissed)).toEqual([]);
  });

  it('reads legacy strings safely and bounds persisted dismissals', () => {
    const stored = ['legacy-token', ['intentional:owner:1', now + day], ['expired', now - 1], ['bad', 'later'], null];
    const parsed = (data as any).readDismissed(stored, now);
    expect(parsed.get('legacy-token')).toBe(now + 7 * day);
    expect(parsed.get('intentional:owner:1')).toBe(now + day);
    expect(parsed.has('expired')).toBe(false); expect(parsed.has('bad')).toBe(false);
    const many = Array.from({ length: 700 }, (_, i) => [`n-${i}`, now + day]);
    expect((data as any).readDismissed(many, now).size).toBe(512);
  });

  it('deduplicates duplicate feeds and counts only undismissed attention and urgent notices', () => {
    const a = feed('owner'); a.notifications = [notice(a, 'u', 'urgent'), notice(a, 'a', 'attention'), notice(a, 'l', 'low')];
    const items = data.projectNotifications([a, a], now);
    expect(items).toHaveLength(3);
    const count = (data as any).notificationBadge;
    expect(typeof count).toBe('function');
    expect(count(items, new Map())).toBe(2);
    expect(count(items, new Map([['intentional:owner:u', now + day]]))).toBe(1);
    expect(count(items, new Map([['intentional:owner:u', now + day], ['intentional:owner:a', now + day]]))).toBe(0);
  });

  it('recognizes only visible layout nodes and active stack children', () => {
    const shown = (data as any).panelIsShown;
    expect(typeof shown).toBe('function');
    const root = { id: 'root', type: 'row', children: [{ id: 'panel', type: 'column', children: [{ type: 'stack', active: 'spider', children: [
      { id: 'files', type: 'block', content: { mod: 'files' } }, { id: 'spider', type: 'block', content: { mod: 'spider-panel' } },
    ] }] }] };
    expect(shown(root, 'spider-panel')).toBe(true);
    root.children[0].children[0].active = 'files'; expect(shown(root, 'spider-panel')).toBe(false);
    root.children[0].children[0].active = 'spider'; (root.children[0] as any).hidden = true; expect(shown(root, 'spider-panel')).toBe(false);
    expect(shown({ type: 'stack', active: 'other', children: [{ id: 'spider', content: { mod: 'spider-panel' } }, { id: 'other', hidden: true, content: { mod: 'other' } }] }, 'spider-panel')).toBe(false);
    expect(shown(null, 'spider-panel')).toBe(false);
  });
});

function panelHost(options: { checking?: boolean; hidden?: boolean; parked?: boolean; configured?: boolean; storage?: Map<string, unknown>; panelSource?: string; navigation?: typeof projectNavigation; paneService?: typeof requestPaneService } = {}) {
  const source = feed('owner'); source.updatedAt = Date.now(); source.notifications = [notice(source, 'notice-1', 'attention', Date.now())];
  const state: any = { feeds: [source], terms: [{ address: 'owner', parent: null, labels: {}, state: 'live', status: 'working' }],
    agents: options.parked ? [] : [{ address: 'owner', pane: 'pane-owner', space: 'space-a', tab: 'tab-a', title: 'Pi', program: { name: 'pi' }, status: 'working' }],
    panes: options.parked ? [] : [{ pane: 'pane-owner', terminal: 'owner', tab: 'tab-a' }], failRead: false, reply: null, layout: { id: 'panel', hidden: options.hidden ?? false, content: { mod: 'spider-panel' } } };
  const modules = createUiModules(), kit = modules['gpui-kit'], base = modules['gpui-base'], calls: any[] = [], tasks: any[] = [], timers: any[] = [];
  const storage = options.storage ?? new Map<string, unknown>();
  const config: any = { modId: 'spider-panel', feedRoot: '/fixture/feed', nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs', configPath: '/fixture/config.json', labelContract: HerdrLabelContract, retention: { completedRows: 50, completedHours: 24 }, ...(options.configured ? { paneServiceConfigured: true } : {}) };
  const cx: any = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), timer: { every(ms: number, fn: Function) { const timer = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; } },
    spawn(fn: Function) { const task: any = Promise.resolve().then(() => fn(cx)); task.cancel = () => {}; task.catch(() => {}); tasks.push(task); return task; } };
  const herdr: any = { props: () => config, checking: options.checking ? () => true : undefined,
    theme: () => ({ foreground: '#eee', dim: '#aaa', muted: '#aaa', hover: '#ffffff12', ansi1: '#ff6b6b', blocked: '#f2c063' }),
    spaces: () => [{ id: 'space-a', name: 'Work', index: 1, machine: null, active: true, tabs: [{ id: 'tab-a', name: 'Tab', active: true }] }],
    agents: () => state.agents, terminals: () => state.terms, panes: () => state.panes, machines: () => [{ name: null, layout: 'ready' }], focused: () => ({ space: 'space-a', tab: 'tab-a', pane: 'pane-owner' }),
    layout: () => state.layout, shared: (key: string) => storage.get(key), setShared: (key: string, value: unknown) => { storage.set(key, value); calls.push(['setShared', key, value]); },
    setBadge: (value: string | null) => calls.push(['badge', value]), playSound: (value: string) => { calls.push(['playSound', value]); if (state.failSound) throw new Error('device unavailable'); }, run: (name: string, args: unknown) => calls.push(['run', name, args]),
    hc: async (args: string[]) => { calls.push(['hc', args]); return { code: 0, stdout: JSON.stringify(args[0] === 'server' ? { core: { id: 'core' } } : { machines: [] }) }; },
    watchFolder: () => { let finish!: (paths: string[]) => void; const promise: any = new Promise(resolve => { finish = resolve; }); promise.cancel = () => { calls.push(['cancelWatch']); finish([]); }; state.watch = promise; calls.push(['watch']); return promise; },
    nextCommand: () => new Promise(resolve => { state.command = resolve; }),
    exec: async (command: string, args: string[]) => { calls.push(['exec', command, args]); if (args.includes('panes')) return { code: 0, stdout: JSON.stringify({ version: 1, kind: 'outcome', outcome: { status: 'complete', reason: 'presented', presentation: null } }) }; const request = JSON.parse(args[args.indexOf('--request') + 1]);
      return state.reply ? state.reply(request) : { code: 0, stdout: JSON.stringify({ ok: true, op: request.op, ...(request.op === 'openSession' ? { terminal: 'owner' } : { viewer: 'viewer' }) }) }; },
  };
  const createFeedReader = () => ({ read: async () => { calls.push(['read']); if (state.readGate) await state.readGate; if (state.failRead) throw new Error('offline'); return { feeds: structuredClone(state.feeds), errors: structuredClone(state.snapshotErrors ?? []) }; }, close: async () => { calls.push(['closeReader']); } });
  const api = { ...kit, ...base, ...data, ...sound, ...herdr, ...paneServiceState, herdr, createFeedReader, projectNavigation: options.navigation ?? projectNavigation, indexPaneNavigation, describeOpenFailure, FEED_DISCONNECT_MS, FEED_REFRESH_MS, panelIpcArgv, parseSessionIpcReply, requestPaneService: options.paneService ?? requestPaneService };
  const text = (options.panelSource ?? readFileSync(resolve('packages/herdr/assets/mods/spider/main.js'), 'utf8')).replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)*import .*;\s*$/gm, '').replace('export default class SpiderPanel', 'class SpiderPanel');
  const Panel = new Function('api', `const { ${Object.keys(api).join(', ')} } = api; ${text}; return SpiderPanel;`)(api);
  const view = new Panel(); view.init({}, cx);
  const drain = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await Promise.all(tasks.filter(task => task !== view.watchTask && task !== view.commandTask && task !== view.refreshTask)); };
  return { view, cx, state, calls, tasks, timers, storage, herdr, config, ready: tasks[0] ?? Promise.resolve(), drain };
}
function flatten(root: any): any[] { return root && typeof root === 'object' ? [root, ...(root.items ?? []).flatMap(flatten)] : []; }
function byId(root: any, id: string): any { return flatten(root).find(item => item.styles?.id?.[0] === id); }

it('explains a timed-out notification open without exposing raw codes', async () => {
  const h = panelHost({ parked: true }); await h.ready; await h.drain();
  h.state.reply = async () => ({ code: 0, stdout: JSON.stringify({ ok: false, code: 'unavailable', message: 'pane-timeout' }) });
  await expect(h.view.ipc(h.state.feeds[0], { op: 'openSession', destination: null })).rejects.toThrow('Timed out opening the pane');
  await h.view.close();
});

it('plays at most one sound for a mixed batch of new intentional notices', async () => {
  const h = panelHost(); await h.ready; await h.drain();
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]);
  h.state.feeds[0].status = { native: 'blocked', effective: 'blocked', message: 'waiting' };
  h.state.feeds[0].notifications.push({ ...notice(h.state.feeds[0], 'automatic', 'urgent', Date.now()), kind: 'job-result' });
  await h.view.reload(h.cx); expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]);
  h.state.feeds[0].status = { native: 'idle', effective: 'idle', message: 'done' };
  h.state.feeds[0].notifications.push(notice(h.state.feeds[0], 'urgent-new', 'urgent', Date.now()), notice(h.state.feeds[0], 'attention-new', 'attention', Date.now()), notice(h.state.feeds[0], 'low-new', 'low', Date.now()));
  await h.view.reload(h.cx); await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked']]);
  expect(h.calls.filter(call => call[0] === 'exec' || call[0] === 'run')).toEqual([]); await h.view.close();
});

it('does not replay history from before this app panel mounted even if shared claims persisted', async () => {
  const storage = new Map<string, unknown>([['spider.notifications.sounded', { baselineAt: Date.now() - 86400000, observed: [] }]]);
  const h = panelHost({ storage }); h.state.feeds[0].notifications[0].createdAt = Date.now() - 5000;
  await h.ready; await h.drain();
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]);
  h.state.feeds[0].notifications.push(notice(h.state.feeds[0], 'after-restart', 'attention', Date.now())); await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked']]); await h.view.close();
});

it('silences initial history even when its timestamp equals the mount time', async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 15, 12));
  const storage = new Map<string, unknown>([['spider.notifications.sounded', { baselineAt: Date.now() - 86400000, observed: [] }]]);
  const h = panelHost({ storage });
  try {
    await h.ready; await h.drain(); await h.view.reload(h.cx);
    expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]);
    vi.setSystemTime(Date.now() + 1); h.state.feeds[0].notifications.push(notice(h.state.feeds[0], 'later', 'attention', Date.now())); await h.view.reload(h.cx);
    expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked']]);
  } finally { await h.view.close(); vi.useRealTimers(); }
});

it('does not establish a sound baseline before the first successful feed snapshot', async () => {
  const h = panelHost(); h.state.failRead = true; await h.ready; await h.drain();
  h.timers.find(timer => timer.ms === 2000)!.fn(h.cx);
  expect(h.storage.has('spider.notifications.sounded')).toBe(false);
  h.state.failRead = false; await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]); await h.view.close();
});

it('does not baseline a failed sessions listing as empty history', async () => {
  const h = panelHost(), original = h.state.feeds; h.state.feeds = []; h.state.snapshotErrors = [{ source: 'sessions', message: 'offline' }];
  await h.ready; await h.drain(); expect(h.storage.has('spider.notifications.sounded')).toBe(false);
  h.state.feeds = original; h.state.snapshotErrors = []; await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]); await h.view.close();
});

it('observes muted arrivals and re-reads sound props before later arrivals', async () => {
  const h = panelHost(); h.config.notifications = { sound: false }; await h.ready; await h.drain();
  h.state.feeds[0].notifications.push(notice(h.state.feeds[0], 'muted', 'urgent', Date.now())); await h.view.reload(h.cx);
  h.config.notifications.sound = true; await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]);
  h.state.feeds[0].notifications.push(notice(h.state.feeds[0], 'enabled', 'low', Date.now())); await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([['playSound', 'done']]); await h.view.close();
});

it('rejects malformed sound settings without playback or replay after repair', async () => {
  const h = panelHost(); h.config.notifications = { sound: 'yes' }; await h.ready; await h.drain();
  h.state.feeds[0].notifications.push(notice(h.state.feeds[0], 'bad-config', 'attention', Date.now())); await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]);
  expect(h.view.errors.some((error: any) => error.source === 'Notification sound')).toBe(true);
  h.config.notifications.sound = true; await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]); await h.view.close();
});

it('does not replay a hidden backlog when the panel is revealed', async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 15, 12));
  const h = panelHost({ hidden: true });
  try {
    await h.ready; await h.drain();
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + 3600000);
      h.state.feeds[0].notifications.push(notice(h.state.feeds[0], `backlog-${i}`, 'attention', Date.now()));
      await h.view.reload(h.cx);
    }
    h.state.layout.hidden = false; await h.view.reload(h.cx);
    expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]);
    h.state.feeds[0].notifications.push(notice(h.state.feeds[0], 'new-after-reveal', 'low', Date.now()));
    await h.view.reload(h.cx);
    expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([['playSound', 'done']]);
  } finally { await h.view.close(); vi.useRealTimers(); }
});

it('shares arrival claims between Agents and a hidden or visible panel', async () => {
  const h = panelHost({ hidden: true }); await h.ready; await h.drain();
  const agentSound = sound.createNotificationSound({ shared: h.herdr.shared, setShared: h.herdr.setShared, playSound: h.herdr.playSound, props: () => h.config, report: () => {} });
  agentSound.observe({ feeds: h.state.feeds, errors: [] });
  h.state.feeds[0].notifications.push(notice(h.state.feeds[0], 'hidden-mixed-low', 'low', Date.now()), notice(h.state.feeds[0], 'hidden-mixed-urgent', 'urgent', Date.now()));
  agentSound.observe({ feeds: h.state.feeds, errors: [] }); await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked']]);
  h.state.layout.hidden = false; await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked']]);
  h.state.feeds[0].notifications.push(notice(h.state.feeds[0], 'visible-new', 'low', Date.now()));
  await h.view.reload(h.cx); agentSound.observe({ feeds: h.state.feeds, errors: [] });
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked'], ['playSound', 'done']]);
  await h.view.close();
});

it('does not consume arrivals in hidden or inactive-stack panels', async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 15, 12));
  const storage = new Map<string, unknown>(), visible = panelHost({ storage }), hidden = panelHost({ storage, hidden: true });
  try {
    await visible.ready; await visible.drain(); await hidden.ready; await hidden.drain();
    const next = notice(hidden.state.feeds[0], 'hidden', 'attention', Date.now()); hidden.state.feeds[0].notifications.push(next);
    await hidden.view.reload(hidden.cx); expect(hidden.calls.filter(call => call[0] === 'playSound')).toEqual([]);
    hidden.state.layout = { type: 'stack', active: 'other', children: [{ id: 'spider', content: { mod: 'spider-panel' } }, { id: 'other', content: { mod: 'other' } }] };
    await hidden.view.reload(hidden.cx); expect(hidden.calls.filter(call => call[0] === 'playSound')).toEqual([]);
    hidden.state.layout.active = 'spider'; await hidden.view.reload(hidden.cx);
    expect(hidden.calls.filter(call => call[0] === 'playSound')).toEqual([]);
  } finally { await visible.view.close(); await hidden.view.close(); vi.useRealTimers(); }
});

it('plays once when one of two same-mod layout blocks is visible', async () => {
  const storage = new Map<string, unknown>();
  const layout = { type: 'row', children: [{ id: 'visible', content: { mod: 'spider-panel' } }, { id: 'hidden', hidden: true, content: { mod: 'spider-panel' } }] };
  const a = panelHost({ storage }), b = panelHost({ storage }); a.state.layout = layout; b.state.layout = layout;
  await Promise.all([a.ready, b.ready]); await a.drain(); await b.drain();
  const next = notice(a.state.feeds[0], 'one-visible', 'urgent', Date.now()); a.state.feeds[0].notifications.push(next); b.state.feeds[0].notifications.push(next);
  await Promise.all([a.view.reload(a.cx), b.view.reload(b.cx)]);
  expect([...a.calls, ...b.calls].filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked']]);
  (layout.children[0] as any).hidden = true;
  const later = notice(a.state.feeds[0], 'now-hidden', 'attention', Date.now()); a.state.feeds[0].notifications.push(later); b.state.feeds[0].notifications.push(later);
  await Promise.all([a.view.reload(a.cx), b.view.reload(b.cx)]);
  expect([...a.calls, ...b.calls].filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked']]);
  expect((storage.get('spider.notifications.sounded') as any).observed.some((entry: any) => entry.token === 'intentional:owner:now-hidden')).toBe(false);
  await a.view.close(); await b.view.close();
});

it('does not sound or claim when both same-mod layout blocks are hidden', async () => {
  const storage = new Map<string, unknown>();
  const layout = { type: 'row', children: [{ id: 'first', hidden: true, content: { mod: 'spider-panel' } }, { id: 'second', hidden: true, content: { mod: 'spider-panel' } }] };
  const a = panelHost({ storage }), b = panelHost({ storage }); a.state.layout = layout; b.state.layout = layout;
  await Promise.all([a.ready, b.ready]); await a.drain(); await b.drain();
  const next = notice(a.state.feeds[0], 'all-hidden', 'attention', Date.now()); a.state.feeds[0].notifications.push(next); b.state.feeds[0].notifications.push(next);
  await Promise.all([a.view.reload(a.cx), b.view.reload(b.cx)]);
  expect([...a.calls, ...b.calls].filter(call => call[0] === 'playSound')).toEqual([]);
  expect(storage.has('spider.notifications.sounded')).toBe(false);
  layout.children[0].hidden = false;
  await Promise.all([a.view.reload(a.cx), b.view.reload(b.cx)]);
  expect([...a.calls, ...b.calls].filter(call => call[0] === 'playSound')).toEqual([]);
  await a.view.close(); await b.view.close();
});

it('does not silently consume an arrival when another visible panel mounts first', async () => {
  const storage = new Map<string, unknown>(), a = panelHost({ storage }); await a.ready; await a.drain();
  const next = notice(a.state.feeds[0], 'during-second-mount', 'urgent', Date.now());
  const b = panelHost({ storage }); b.state.feeds[0].notifications = [next]; await b.ready; await b.drain();
  a.state.feeds[0].notifications.push(next); await a.view.reload(a.cx);
  expect([...a.calls, ...b.calls].filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked']]);
  await a.view.close(); await b.view.close();
});

it('claims each arrival synchronously across duplicate visible panels', async () => {
  const storage = new Map<string, unknown>(), a = panelHost({ storage }), b = panelHost({ storage }); await Promise.all([a.ready, b.ready]); await a.drain(); await b.drain();
  const next = notice(a.state.feeds[0], 'shared', 'urgent', Date.now()); a.state.feeds[0].notifications.push(next); b.state.feeds[0].notifications.push(next);
  await Promise.all([a.view.reload(a.cx), b.view.reload(b.cx)]);
  expect([...a.calls, ...b.calls].filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked']]);
  const winner = a.calls.some(call => call[0] === 'playSound') ? a.calls : b.calls;
  const played = winner.findIndex(call => call[0] === 'playSound');
  expect(winner.slice(0, played).some(call => call[0] === 'setShared' && call[1] === 'spider.notifications.sounded' && call[2].observed.some((entry: any) => entry.token === 'intentional:owner:shared'))).toBe(true);
  await a.view.close(); await b.view.close();
});

it('keeps the card and reports playback failure without retrying', async () => {
  const h = panelHost(); await h.ready; await h.drain(); h.state.failSound = true;
  h.state.feeds[0].notifications.push(notice(h.state.feeds[0], 'failed-sound', 'attention', Date.now()));
  await h.view.reload(h.cx); await h.view.reload(h.cx);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([['playSound', 'blocked']]);
  expect(h.view.errors.some((error: any) => error.source === 'Notification sound')).toBe(true);
  expect(data.describePanelProblems(h.view.errors).rows.map(row => row.text)).toContain("Spider couldn't play a notification sound.");
  expect(byId(h.view.render(h.cx), 'card-intentional:owner:failed-sound')).toBeDefined(); await h.view.close();
});

it('shows a sound problem reported by the always-mounted Agents view', async () => {
  const h = panelHost({ hidden: true }); await h.ready; await h.drain();
  h.storage.set('spider.notifications.soundProblem', { at: Date.now(), message: 'Notification sound unavailable' });
  h.timers.find(timer => timer.ms === 2000)!.fn(h.cx);
  expect(h.view.errors.some((error: any) => error.source === 'Notification sound')).toBe(true);
  expect(data.describePanelProblems(h.view.errors).rows.map(row => row.text)).toContain("Spider couldn't play a notification sound.");
  expect(flatten(h.view.render(h.cx)).some(node => node.items?.includes("Spider couldn't play a notification sound."))).toBe(true);
  h.timers.find(timer => timer.ms === 2000)!.fn(h.cx);
  expect(h.view.errors.filter((error: any) => error.source === 'Notification sound')).toHaveLength(1);
  await h.view.close();
  const stale = panelHost({ storage: new Map([['spider.notifications.soundProblem', { at: Date.now() - 60001, message: 'Notification sound unavailable' }]]) });
  await stale.ready; await stale.drain();
  expect(stale.view.errors.some((error: any) => error.source === 'Notification sound')).toBe(false);
  await stale.view.close();
});

it('does not establish sound baselines or play sound while the app checks mods', async () => {
  const h = panelHost({ checking: true }); await h.ready;
  expect(h.storage.has('spider.notifications.sounded')).toBe(false);
  expect(h.calls.filter(call => call[0] === 'playSound')).toEqual([]); await h.view.close();
});

it('renders a neutral intentional card named for its owner and does not dismiss on click', async () => {
  const h = panelHost(); await h.ready; await h.drain();
  const root = h.view.render(h.cx), card = byId(root, 'card-intentional:owner:notice-1');
  expect(card).toBeDefined(); expect(card.styles.border).toBeUndefined(); expect(card.styles.shadow).toBeUndefined();
  expect(data.notificationText(data.projectNotifications(h.view.feeds, Date.now())[0])).toContain('owner');
  byId(root, 'need-intentional:owner:notice-1').events.on_click({}, h.cx); await h.drain();
  expect(h.calls).toContainEqual(['run', 'pane.focus', { pane: 'pane-owner' }]);
  expect(byId(h.view.render(h.cx), 'card-intentional:owner:notice-1')).toBeDefined(); await h.view.close();
});

it('0.1.16 opens a notification clicked during a feed reload', async () => {
  const patchPath = resolve('packages/herdr/assets/look/native-panel-0.1.16.json');
  const panelSource = applyModPatches({ 'main.js': readFileSync(resolve('packages/herdr/assets/mods/spider/main.js'), 'utf8') }, JSON.parse(readFileSync(patchPath, 'utf8')), 'panel')['main.js'];
  const h = panelHost({ parked: true, panelSource });
  await h.ready; await h.drain();
  let release!: () => void;
  h.state.readGate = new Promise<void>(resolve => { release = resolve; });
  const reload = h.view.reload(h.cx);
  const row = byId(h.view.render(h.cx), 'need-intentional:owner:notice-1');
  row.events.on_click({}, h.cx);
  await Promise.resolve();
  h.state.readGate = null; release();
  await reload; await h.drain();
  const args = h.calls.find(call => call[0] === 'exec' && call[2].includes('--request'))?.[2];
  expect(args).toBeDefined();
  expect(JSON.parse(args[args.indexOf('--request') + 1])).toMatchObject({ op: 'openSession', generation: 'g' });
  await h.view.close();
});

function patchedPanelSource(version = '0.1.16') {
  let main = readFileSync(resolve('packages/herdr/assets/mods/spider/main.js'), 'utf8');
  for (const path of [version === '0.1.16' ? 'packages/herdr/assets/look/native-panel-0.1.16.json' : '', 'packages/herdr/assets/look/pane-panel-b.json']) {
    if (path && existsSync(resolve(path))) main = applyModPatches({ 'main.js': main }, JSON.parse(readFileSync(resolve(path), 'utf8')), 'panel')['main.js'];
  }
  return main;
}

function patchedNavigation() {
  const navSource = applyModPatches({ 'navigation.js': readFileSync(resolve('packages/herdr/assets/shared/navigation.js'), 'utf8') }, JSON.parse(readFileSync(resolve('packages/herdr/assets/look/native-navigation-0.1.16.json'), 'utf8')), 'navigation')['navigation.js']
    .replace(/^import .*;\s*$/gm, '').replaceAll('export function ', 'function ');
  return new Function('filterTopLevelAgents', 'projectAgentChildren', 'FEED_DISCONNECT_MS', 'projectPanePresentations', `${navSource}; return projectNavigation;`)(children.filterTopLevelAgents, children.projectAgentChildren, FEED_DISCONNECT_MS, projectPanePresentations);
}

it.each(['0.1.13', '0.1.16'])('%s configured remote notifications retain service routing until the snapshot becomes stale', async version => {
  const navigation = patchedNavigation();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
  const requests: any[] = []; let snapshot: any = null;
  const paneService: any = async (_config: unknown, _exec: unknown, request: any) => { requests.push(request); if (request.op === 'snapshot') { if (!snapshot) throw Error('unavailable'); return snapshot; } return { status: 'complete' }; };
  const h = panelHost({ parked: true, configured: true, navigation, panelSource: patchedPanelSource(version), paneService });
  const source = h.state.feeds[0], address = 'box-1.invalid/owner';
  source.owner.terminal.address = address; source.owner.terminal.coreId = 'remote-core'; source.owner.cwd = '/home/fixture';
  h.state.terms = [{ address, parent: null, labels: {}, state: 'live', status: 'working' }];
  h.herdr.machines = () => [{ name: 'box-1.invalid', layout: 'ready' }];
  h.herdr.hc = async (args: string[]) => ({ code: 0, stdout: JSON.stringify(args[0] === 'server' ? { core: { id: 'core' } } : { machines: [{ name: 'box-1.invalid', id: 'remote-core', state: 'connected' }] }) });
  try {
    await h.ready; await h.drain();
    expect.soft(byId(h.view.render(h.cx), 'need-intentional:owner:notice-1')?.events.on_click).toBeUndefined();
    const target = { coreId: 'remote-core', terminalId: 'owner', address, createdMs: 42, identityLabels: {}, alias: 'box-1.invalid', machineId: 'm', kind: 'session', sessionId: 'owner', generation: 'g', homeEpoch: 1, runId: null, consoleId: null, name: 'owner', cwd: '/home/fixture' };
    snapshot = { version: 1, kind: 'snapshot', complete: true, omittedRows: 0, rows: [{ sessionId: 'owner', generation: 'g', owner: { terminal: { address } }, target, name: 'owner', status: 'working', machineKey: 'box-1.invalid', children: [], consoles: [], unavailableReason: null }], presentations: [] };
    clock.mockReturnValue(106000); h.timers.find(timer => timer.ms === 2000)!.fn(h.cx); await h.drain();
    let row = byId(h.view.render(h.cx), 'need-intentional:owner:notice-1');
    expect.soft(row?.events.on_click).toBeDefined(); row?.events.on_click?.({}, h.cx); await h.drain();
    expect.soft(requests).toContainEqual(expect.objectContaining({ op: 'open-existing', sessionId: 'owner', generation: 'g' }));
    expect.soft(h.calls.filter(call => call[0] === 'exec' && call[2].includes('--request'))).toEqual([]);
    requests.length = 0; snapshot = null;
    clock.mockReturnValue(112000); h.state.feeds[0].updatedAt = Date.now(); h.timers.find(timer => timer.ms === 2000)!.fn(h.cx); await h.drain();
    row = byId(h.view.render(h.cx), 'need-intentional:owner:notice-1');
    expect.soft(row?.events.on_click).toBeDefined(); row?.events.on_click?.({}, h.cx); await h.drain();
    expect.soft(requests).toContainEqual(expect.objectContaining({ op: 'open-existing', sessionId: 'owner' }));
    expect.soft(h.calls.filter(call => call[0] === 'exec' && call[2].includes('--request'))).toEqual([]);
    clock.mockReturnValue(127001); h.state.feeds[0].updatedAt = Date.now(); h.timers.find(timer => timer.ms === 2000)!.fn(h.cx); await h.drain();
    expect.soft(byId(h.view.render(h.cx), 'need-intentional:owner:notice-1')?.events.on_click).toBeUndefined();
    expect.soft(h.calls.filter(call => call[0] === 'exec' && call[2].includes('--request'))).toEqual([]);
  } finally { clock.mockRestore(); await h.view.close(); }
});

it('an unconfigured remote notification still opens natively', async () => {
  const h = panelHost({ parked: true, panelSource: patchedPanelSource(), navigation: patchedNavigation() });
  const address = 'box-1.invalid/owner', source = h.state.feeds[0];
  source.owner.terminal.address = address; source.owner.terminal.coreId = 'remote-core';
  h.state.terms = [{ address, parent: null, labels: {}, state: 'live', status: 'working' }];
  h.herdr.machines = () => [{ name: 'box-1.invalid', layout: 'ready' }];
  h.herdr.hc = async (args: string[]) => ({ code: 0, stdout: JSON.stringify(args[0] === 'server' ? { core: { id: 'core' } } : { machines: [{ name: 'box-1.invalid', id: 'remote-core', state: 'connected' }] }) });
  try {
    await h.ready; await h.drain();
    const row = byId(h.view.render(h.cx), 'need-intentional:owner:notice-1');
    expect(row?.events.on_click).toBeDefined(); row.events.on_click({}, h.cx); await h.drain();
    const args = h.calls.find(call => call[0] === 'exec' && call[2].includes('--request'))?.[2];
    expect(JSON.parse(args[args.indexOf('--request') + 1])).toMatchObject({ op: 'openSession', generation: 'g' });
  } finally { await h.view.close(); }
});

it.each(['0.1.13', '0.1.16'])('%s panel snapshots are throttled and retry failures with backoff', async version => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000), requests: any[] = [];
  const paneService: any = async (_config: unknown, _exec: unknown, request: any) => { requests.push(request); throw Error('offline'); };
  const h = panelHost({ configured: true, panelSource: patchedPanelSource(version), paneService });
  try {
    await h.ready; await h.drain();
    expect.soft(requests).toHaveLength(1);
    await h.view.reload(h.cx); await h.view.reload(h.cx); await h.drain();
    expect.soft(requests).toHaveLength(1);
    clock.mockReturnValue(104999); h.timers.find(timer => timer.ms === 2000)!.fn(h.cx); await h.drain(); expect.soft(requests).toHaveLength(1);
    clock.mockReturnValue(105000); h.timers.find(timer => timer.ms === 2000)!.fn(h.cx); await h.drain(); expect.soft(requests).toHaveLength(2);
    clock.mockReturnValue(114999); h.timers.find(timer => timer.ms === 2000)!.fn(h.cx); await h.drain(); expect.soft(requests).toHaveLength(2);
    clock.mockReturnValue(115000); h.timers.find(timer => timer.ms === 2000)!.fn(h.cx); await h.drain(); expect.soft(requests).toHaveLength(3);
  } finally { clock.mockRestore(); await h.view.close(); }
});

it.each(['0.1.13', '0.1.16'])('%s updates feeds and badge while the pane snapshot request is hung', async version => {
  let release!: () => void, starts = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const paneService: any = async () => { starts++; await gate; throw Error('offline'); };
  const h = panelHost({ configured: true, panelSource: patchedPanelSource(version), paneService });
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect.soft(starts).toBe(1);
    expect.soft(h.view.feeds).toHaveLength(1);
    expect.soft(h.calls.filter(call => call[0] === 'badge')).toContainEqual(['badge', '1']);
  } finally { release(); await h.ready; await h.drain(); await h.view.close(); }
});

it('does not focus a reused terminal address after the owner identity changes', async () => {
  const h = panelHost(); await h.ready; await h.drain(); const root = h.view.render(h.cx);
  h.state.terms[0].labels['spider.session'] = 'another-session';
  byId(root, 'need-intentional:owner:notice-1').events.on_click({}, h.cx); await h.drain();
  expect(h.calls.filter(call => call[0] === 'run')).toEqual([]);
  expect(h.view.errors.some((error: any) => error.message === 'Owner unavailable')).toBe(true);
  await h.view.close();
});

it('updates the app badge for hidden panels and clears it on dismissal', async () => {
  const h = panelHost({ hidden: true }); await h.ready; await h.drain();
  expect(h.calls.filter(call => call[0] === 'badge')).toContainEqual(['badge', '1']);
  byId(h.view.render(h.cx), 'dismiss-intentional:owner:notice-1').events.on_click({}, h.cx);
  expect(h.calls.filter(call => call[0] === 'badge')).toContainEqual(['badge', null]); await h.view.close();
});

it('clears the badge after the last panel closes and restores it from a remaining panel', async () => {
  const storage = new Map<string, unknown>(), a = panelHost({ storage }), b = panelHost({ storage });
  await Promise.all([a.ready, b.ready]); await a.drain(); await b.drain();
  await a.view.close();
  expect(a.calls.filter(call => call[0] === 'badge').at(-1)).toEqual(['badge', null]);
  b.view.updateBadge();
  expect(b.calls.filter(call => call[0] === 'badge').at(-1)).toEqual(['badge', '1']);
  await b.view.close();
  expect(b.calls.filter(call => call[0] === 'badge').at(-1)).toEqual(['badge', null]);
});

it('reports when a child notice outlives navigation retention', async () => {
  const h = panelHost(), source = h.state.feeds[0];
  source.runs = { rows: [{ id: 'run-long-expired', ownerSessionId: 'owner', name: 'reviewer', status: 'done', childMode: 'print', canSteer: false, startedAt: Date.now() - 30 * 3600000, finishedAt: Date.now() - 30 * 3600000, viewer: null, result: null }], total: 1, truncated: false };
  source.notifications[0] = { ...source.notifications[0], runId: 'run-long-expired', action: { kind: 'open-run', sessionId: 'owner', runId: 'run-long-expired' } };
  await h.ready; await h.drain();
  byId(h.view.render(h.cx), 'need-intentional:owner:notice-1').events.on_click({}, h.cx); await h.drain();
  expect(h.view.errors.some((error: any) => error.message === 'Owner unavailable')).toBe(true);
  expect(flatten(h.view.render(h.cx)).some(node => node.items?.some((part: unknown) => typeof part === 'string' && part.includes("Its pi session isn't reachable")))).toBe(true);
  expect(h.calls.filter(call => call[0] === 'run' || call[0] === 'exec')).toEqual([]);
  await h.view.close();
});

it('opens an older child when configured retention includes it', async () => {
  const h = panelHost(), source = h.state.feeds[0]; h.config.retention.completedHours = 48;
  source.runs = { rows: [{ id: 'run-long-retained', ownerSessionId: 'owner', name: 'reviewer', status: 'done', childMode: 'print', canSteer: false, startedAt: Date.now() - 30 * 3600000, finishedAt: Date.now() - 30 * 3600000, viewer: null, result: null }], total: 1, truncated: false };
  source.notifications[0] = { ...source.notifications[0], runId: 'run-long-retained', action: { kind: 'open-run', sessionId: 'owner', runId: 'run-long-retained' } };
  await h.ready; await h.drain();
  byId(h.view.render(h.cx), 'need-intentional:owner:notice-1').events.on_click({}, h.cx); await h.drain();
  const args = h.calls.find(call => call[0] === 'exec')?.[2];
  expect(args).toBeDefined();
  expect(JSON.parse(args[args.indexOf('--request') + 1])).toMatchObject({ op: 'openRun', runId: 'run-long-retained' });
  expect(h.calls).toContainEqual(['run', 'pane.focus', { terminal: 'viewer' }]);
  await h.view.close();
});

it('explains a restarted local core and a disconnected remote machine', async () => {
  const local = panelHost(); local.state.feeds[0].owner.terminal.coreId = 'old-core';
  await local.ready; await local.drain();
  byId(local.view.render(local.cx), 'need-intentional:owner:notice-1').events.on_click({}, local.cx); await local.drain();
  expect(local.view.errors.some((error: any) => error.message === "This computer's Herdr restarted; reopen the session")).toBe(true);
  expect(flatten(local.view.render(local.cx)).some(node => node.items?.some((part: unknown) => typeof part === 'string' && part.includes("This computer's Herdr restarted; reopen the session")))).toBe(true);
  await local.view.close();
  const remote = panelHost(); remote.state.feeds[0].owner.terminal.address = 'box.invalid/owner'; remote.state.feeds[0].owner.terminal.coreId = 'remote-core';
  remote.herdr.hc = async (args: string[]) => ({ code: 0, stdout: JSON.stringify(args[0] === 'server' ? { core: { id: 'core' } } : { machines: [{ name: 'box.invalid', id: 'remote-core', state: 'disconnected' }] }) });
  await remote.ready; await remote.drain();
  byId(remote.view.render(remote.cx), 'need-intentional:owner:notice-1').events.on_click({}, remote.cx); await remote.drain();
  expect(remote.view.errors.some((error: any) => error.message === 'Owner on box.invalid is unreachable')).toBe(true);
  expect(flatten(remote.view.render(remote.cx)).some(node => node.items?.some((part: unknown) => typeof part === 'string' && part.includes('Owner on box.invalid is unreachable')))).toBe(true);
  await remote.view.close();
});

it('reopens a parked primary using the freshly read generation, once for a double click', async () => {
  const h = panelHost({ parked: true }); await h.ready; await h.drain();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  h.state.feeds[0].generation = 'g2'; h.state.feeds[0].owner.generation = 'g2';
  h.state.reply = async (request: any) => { entered(); await gate; return { code: 0, stdout: JSON.stringify({ ok: true, op: request.op, terminal: 'owner' }) }; };
  try {
    const body = byId(h.view.render(h.cx), 'need-intentional:owner:notice-1');
    body.events.on_click({}, h.cx); await started; body.events.on_click({}, h.cx);
    const execs = h.calls.filter(call => call[0] === 'exec'); expect(execs).toHaveLength(1);
    const args = execs[0][2], request = JSON.parse(args[args.indexOf('--request') + 1]);
    expect(request).toMatchObject({ op: 'openSession', generation: 'g2' });
    release(); await h.drain(); expect(h.calls).toContainEqual(['run', 'pane.focus', { terminal: 'owner' }]);
  } finally { release(); await h.view.close(); }
});

it('opens a retained child run and reports an old primary endpoint without replacement', async () => {
  const h = panelHost();
  h.state.feeds[0].runs = { rows: [{ id: 'run-1', ownerSessionId: 'owner', name: 'reviewer', status: 'done', childMode: 'print', canSteer: false, startedAt: Date.now() - 2000, finishedAt: Date.now() - 1000, viewer: null, result: null }], total: 1, truncated: false };
  h.state.feeds[0].notifications[0] = { ...h.state.feeds[0].notifications[0], runId: 'run-1', action: { kind: 'open-run', sessionId: 'owner', runId: 'run-1' } };
  await h.ready; await h.drain();
  expect(data.notificationText(data.projectNotifications(h.view.feeds, Date.now())[0])).toBe('owner reviewer Choose a fix');
  byId(h.view.render(h.cx), 'need-intentional:owner:notice-1').events.on_click({}, h.cx); await h.drain();
  const args = h.calls.find(call => call[0] === 'exec')[2];
  expect(JSON.parse(args[args.indexOf('--request') + 1])).toMatchObject({ op: 'openRun', runId: 'run-1' });
  expect(h.calls).toContainEqual(['run', 'pane.focus', { terminal: 'viewer' }]); await h.view.close();
  const old = panelHost({ parked: true }); await old.ready; await old.drain();
  old.state.reply = async () => ({ code: 0, stdout: JSON.stringify({ ok: false, code: 'unknown-op', message: 'unknown-op' }) });
  byId(old.view.render(old.cx), 'need-intentional:owner:notice-1').events.on_click({}, old.cx); await old.drain();
  expect(old.view.errors.some((error: any) => /\/reload/.test(error.message))).toBe(true);
  expect(old.calls.filter(call => call[0] === 'run')).toEqual([]); await old.view.close();
});

it('does not open when the occurrence disappears during owner identity verification', async () => {
  const h = panelHost(); await h.ready; await h.drain();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  h.herdr.hc = async () => { entered(); await gate; return { code: 0, stdout: JSON.stringify({ core: { id: 'core' } }) }; };
  try {
    byId(h.view.render(h.cx), 'need-intentional:owner:notice-1').events.on_click({}, h.cx); await started;
    h.state.feeds[0].notifications = []; release(); await h.drain();
    expect(h.calls.filter(call => call[0] === 'run' || call[0] === 'exec')).toEqual([]);
  } finally { release(); await h.view.close(); }
});

it('keeps stale owner cards dismissible without dispatch', async () => {
  const h = panelHost(); h.state.feeds[0].updatedAt = Date.now() - 60000; await h.ready; await h.drain();
  const root = h.view.render(h.cx), body = byId(root, 'need-intentional:owner:notice-1'), dismiss = byId(root, 'dismiss-intentional:owner:notice-1');
  expect(body.events.on_click).toBeUndefined(); expect(body.styles.tooltip).toEqual(['Owner unavailable']); expect(dismiss.events.on_click).toBeTypeOf('function');
  dismiss.events.on_click({}, h.cx); expect(h.calls.filter(call => call[0] === 'run')).toEqual([]);
  expect(byId(h.view.render(h.cx), 'card-intentional:owner:notice-1')).toBeUndefined(); await h.view.close();
});

it('keeps a dismissed occurrence hidden through missing feeds and status changes', async () => {
  const h = panelHost(); await h.ready; await h.drain(); const original = structuredClone(h.state.feeds[0]);
  byId(h.view.render(h.cx), 'dismiss-intentional:owner:notice-1').events.on_click({}, h.cx);
  h.state.feeds = []; await h.view.reload(h.cx);
  original.status.effective = 'blocked'; h.state.feeds = [original]; await h.view.reload(h.cx);
  expect(byId(h.view.render(h.cx), 'card-intentional:owner:notice-1')).toBeUndefined();
  original.notifications.push({ ...original.notifications[0], id: 'notice-2' }); await h.view.reload(h.cx);
  expect(byId(h.view.render(h.cx), 'card-intentional:owner:notice-2')).toBeDefined();
  expect(h.calls.filter(call => call[0] === 'run')).toEqual([]); await h.view.close();
});

it('keeps low-only notifications out of the badge and tolerates an absent badge API', async () => {
  const h = panelHost(); h.state.feeds[0].notifications[0].urgency = 'low'; await h.ready; await h.drain();
  expect(h.calls.filter(call => call[0] === 'badge').at(-1)).toEqual(['badge', null]);
  h.state.feeds[0].notifications.push({ ...h.state.feeds[0].notifications[0], id: 'urgent', urgency: 'urgent' });
  await h.view.reload(h.cx); expect(h.calls.filter(call => call[0] === 'badge').at(-1)).toEqual(['badge', '1']);
  h.herdr.setBadge = undefined; h.state.feeds = []; await expect(h.view.reload(h.cx)).resolves.toBe(true); await h.view.close();
});

it('shares dismissal across duplicate panels without doubling the global badge', async () => {
  const storage = new Map<string, unknown>(), a = panelHost({ storage }), b = panelHost({ storage, hidden: true });
  await Promise.all([a.ready, b.ready]); await a.drain(); await b.drain();
  expect(a.calls.filter(call => call[0] === 'badge').at(-1)).toEqual(['badge', '1']);
  expect(b.calls.filter(call => call[0] === 'badge').at(-1)).toEqual(['badge', '1']);
  byId(a.view.render(a.cx), 'dismiss-intentional:owner:notice-1').events.on_click({}, a.cx);
  b.view.syncDismissed(); b.view.updateBadge(); expect(b.calls.filter(call => call[0] === 'badge').at(-1)).toEqual(['badge', null]);
  await a.view.close(); await b.view.close();
});

it('accepts only the exact refresh command and cancels its retained watch on close', async () => {
  const h = panelHost(); await h.ready; await h.drain();
  const before = h.calls.filter(call => call[0] === 'read').length;
  h.state.command('refresh'); for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(h.calls.filter(call => call[0] === 'read').length).toBe(before + 1);
  h.state.command('refresh:extra'); for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(h.calls.filter(call => call[0] === 'read').length).toBe(before + 1);
  await h.view.close(); expect(h.calls.some(call => call[0] === 'cancelWatch')).toBe(true);
});

it('queries only core identity on explicit activation or refresh, not passive work', async () => {
  const h = panelHost(); await h.ready; await h.drain();
  expect(h.calls.filter(call => call[0] === 'hc')).toEqual([]);
  h.view.render(h.cx); h.view.pendingReload = true; h.view.reloadAt = Date.now() - 4000; h.timers.find(timer => timer.ms === 2000).fn(h.cx); await h.drain();
  expect(h.calls.filter(call => call[0] === 'hc')).toEqual([]);
  byId(h.view.render(h.cx), 'need-intentional:owner:notice-1').events.on_click({}, h.cx); await h.drain();
  expect(h.calls.filter(call => call[0] === 'hc')).toEqual([['hc', ['server', 'status', '--json']]]);
  h.state.command('refresh'); for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(h.calls.filter(call => call[0] === 'hc')).toEqual([['hc', ['server', 'status', '--json']], ['hc', ['server', 'status', '--json']]]);
  await h.view.close();
});

it.each([['matching', 'remote-core', true], ['replaced', 'new-core', false], ['missing', null, false]])('verifies a %s remote machine core before activating its card', async (_label, machineCore, enabled) => {
  const h = panelHost(), remote = h.state.feeds[0];
  remote.owner.terminal.coreId = 'remote-core'; remote.owner.terminal.address = 'box-1.invalid/owner';
  remote.notifications[0].ownerAddress = remote.owner.terminal.address; remote.notifications[0].action.address = remote.owner.terminal.address;
  h.state.terms = [{ address: 'box-1.invalid/owner', parent: null, labels: {}, state: 'live', status: 'working' }];
  h.state.agents = [{ address: 'box-1.invalid/owner', pane: 'box-1.invalid/pane', space: 'space-a', tab: 'tab-a', title: 'Pi', program: { name: 'pi' }, status: 'working' }];
  h.state.panes = [{ pane: 'box-1.invalid/pane', terminal: 'box-1.invalid/owner', tab: 'tab-a' }];
  h.herdr.machines = () => [{ name: null, layout: 'ready' }, { name: 'box-1.invalid', layout: 'ready' }];
  h.herdr.hc = async (args: string[]) => { h.calls.push(['hc', args]); return { code: 0, stdout: JSON.stringify(args[0] === 'server' ? { core: { id: 'core' } } : { machines: machineCore ? [{ name: 'box-1.invalid', id: machineCore, state: 'connected' }] : [] }) }; };
  await h.ready; await h.drain(); expect(h.calls.filter(call => call[0] === 'hc')).toEqual([]);
  byId(h.view.render(h.cx), 'need-intentional:owner:notice-1').events.on_click({}, h.cx); await h.drain();
  expect(h.calls.filter(call => call[0] === 'hc')).toEqual([['hc', ['server', 'status', '--json']], ['hc', ['machine', 'ls', '--json']]]);
  if (enabled) {
    expect(h.calls.filter(call => call[0] === 'run')).toEqual([]);
    const request = h.calls.find(call => call[0] === 'exec' && call[2].includes('panes'));
    expect(request).toBeDefined();
    expect(JSON.parse(request![2].at(-1))).toMatchObject({ op: 'open-existing', sessionId: 'owner', generation: remote.generation });
  }
  else {
    expect(h.calls.filter(call => call[0] === 'run')).toEqual([]);
    expect(h.view.errors.some((error: any) => error.message === "box-1.invalid was rebuilt or can't be verified")).toBe(true);
    expect(flatten(h.view.render(h.cx)).some(node => node.items?.some((part: unknown) => typeof part === 'string' && part.includes("box-1.invalid was rebuilt or can't be verified")))).toBe(true);
  }
  await h.view.close();
});

it('bounds a hanging core-identity query and never dispatches a stale action', async () => {
  const h = panelHost(); await h.ready; await h.drain(); h.herdr.hc = () => new Promise(() => {});
  byId(h.view.render(h.cx), 'need-intentional:owner:notice-1').events.on_click({}, h.cx);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const timeout = h.timers.find(timer => timer.ms === 5000 && !timer.cancelled); expect(timeout).toBeDefined(); timeout.fn(h.cx);
  await h.drain(); expect(h.calls.filter(call => call[0] === 'run')).toEqual([]);
  expect(h.view.errors.some((error: any) => /timed out/i.test(error.message))).toBe(true); await h.view.close();
});

it('starts no reader, watch, timer, command, or badge work during checking', async () => {
  const h = panelHost({ checking: true }); await h.ready; await h.drain();
  expect(h.calls).toEqual([]); expect(h.timers).toEqual([]); await h.view.close();
});

// Track 3 Task 3.2 must make acceptance/i.ts stage the real navigation helpers
// through the installer's rewrite function before this release-scene gate runs.
it.skip('staged panel helpers focus an intentional owner occurrence', async () => {
  const source = feed('owner'); source.updatedAt = Date.now(); source.notifications = [notice(source, 'notice-1', 'attention', Date.now())];
  const result = await runPanelScene<{ card: boolean }>(`initView(panel,cx);await tasks[0];await drain();console.log(JSON.stringify({card:Boolean(byId(panel.render(cx),'card-intentional:owner:notice-1'))}));`, source);
  expect(result.card).toBe(true);
});
