// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it, vi } from 'vitest';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe, type SpacesAVersion } from './spaces-a-fixture.js';
import { createNotificationSound } from '../../assets/mods/spider/sound.js';
import { notificationAgentPatches } from '../look/notification-patches.js';

function fixture(version: SpacesAVersion, sharedState = new Map<string, unknown>(), checking = false) {
  const recipe = loadPublishedSpacesARecipe(version);
  let source = replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe).agents!['main.js']!;
  for (const patch of notificationAgentPatches) {
    if (source.split(patch.anchor).length !== 2) throw new Error(`expected one anchor for ${patch.id}`);
    source = source.replace(patch.anchor, `/* spider-look:${patch.id} */${patch.replacement}`);
  }
  source = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)*import .*;\s*$/gm, '').replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const calls: string[] = [], props: any = { feedRoot: '/fixture/feeds', nodePath: '/fixture/node', notifications: { sound: true } };
  const state: any = { feeds: [{ sessionId: 'owner', notifications: [] }], errors: [], reads: 0 };
  const timer = { every: () => ({ cancel() {} }), after: () => ({ cancel() {} }) };
  const cx: any = { timer, notify() {}, spawn(fn: Function) { const result = Promise.resolve().then(() => fn(cx)); result.catch(() => {}); return result; } };
  const herdr: any = { checking: () => checking, playSound: (sound: string) => { calls.push(sound); if (state.failSound) throw new Error('device unavailable'); } };
  const ports: any = {
    View: class {}, createNotificationSound, spiderPlaySound: herdr.playSound, props: () => props, herdr, shared: (key: string) => sharedState.get(key), setShared: (key: string, value: unknown) => sharedState.set(key, value),
    createFeedReader: () => ({ read: async () => { state.reads++; return structuredClone(state); }, close: async () => {} }),
    watchFolder: () => { const p: any = new Promise(() => {}); p.cancel = () => {}; return p; },
    exec: async () => ({}), fetch: async () => ({}), FEED_REFRESH_MS: 5000,
    localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    createMachineConnections: () => ({ refresh: async () => {}, close() {} }), hc: async () => ({}),
    nextCommand: () => new Promise(() => {}), setSharedNoop() {},
  };
  const name = /class (\w+) extends View/.exec(source)![1];
  const Agents = new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${source}; return ${name};`)(ports);
  const view = new Agents(); view.init({}, cx);
  const refresh = async () => { view.spiderReloadAt = -Infinity; await view.reloadSpiderFeeds(); };
  return { view, cx, state, props, calls, sharedState, refresh, ready: async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); } };
}
const notice = (id: string, urgency: string) => ({ id, kind: 'intentional', urgency, createdAt: Date.now() });

for (const version of ['0.1.13', '0.1.16'] as const) {
  it(`${version}: performs no sound observation during mod checking`, async () => {
    const a = fixture(version, new Map(), true); await a.ready();
    expect(a.state.reads).toBe(0);
    expect(a.calls).toEqual([]);
    expect(a.sharedState.has('spider.notifications.sounded')).toBe(false);
    await a.view.close();
  });

  it(`${version}: sounds hidden-panel arrivals once per refresh and claims across mounts`, async () => {
    const shared = new Map<string, unknown>(), a = fixture(version, shared), b = fixture(version, shared);
    await a.ready(); await b.ready();
    a.state.feeds[0].notifications.push(notice('low', 'low'), notice('urgent', 'urgent'));
    b.state.feeds = structuredClone(a.state.feeds);
    await a.refresh(); await b.refresh();
    expect([...a.calls, ...b.calls]).toEqual(['blocked']);
    expect((shared.get('spider.notifications.sounded') as any).observed.map((entry: any) => entry.token)).toEqual(expect.arrayContaining(['intentional:owner:low', 'intentional:owner:urgent']));
    await a.refresh(); await b.refresh();
    expect([...a.calls, ...b.calls]).toEqual(['blocked']);
    await a.view.close(); await b.view.close();
  });

  it(`${version}: silences old reconnect batches and sounds a fresh occurrence`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2026, 0, 1); vi.setSystemTime(start);
    const a = fixture(version);
    try {
      await a.ready();
      a.state.errors = [{ source: 'sessions', message: 'offline' }]; await a.refresh();
      vi.setSystemTime(start + 15 * 60_000); a.state.errors = [];
      a.state.feeds[0].notifications.push({ ...notice('old-one', 'urgent'), createdAt: start + 1_000 }); await a.refresh();
      a.state.feeds[0].notifications.push({ ...notice('old-two', 'attention'), createdAt: start + 2_000 }); await a.refresh();
      expect(a.calls).toEqual([]);
      a.state.feeds[0].notifications.push(notice('fresh', 'low')); await a.refresh(); await a.refresh();
      expect(a.calls).toEqual(['done']);
      expect((a.sharedState.get('spider.notifications.sounded') as any).observed.map((entry: any) => entry.token)).toEqual(expect.arrayContaining(['intentional:owner:old-one', 'intentional:owner:old-two', 'intentional:owner:fresh']));
    } finally { await a.view.close(); vi.useRealTimers(); }
  });

  it(`${version}: baselines history, observes muted notices and sounds later low arrivals`, async () => {
    const a = fixture(version); a.state.feeds[0].notifications.push(notice('history', 'urgent'));
    await a.ready(); expect(a.calls).toEqual([]);
    a.props.notifications.sound = false; a.state.feeds[0].notifications.push(notice('muted', 'urgent')); await a.refresh();
    a.props.notifications.sound = true; await a.refresh(); expect(a.calls).toEqual([]);
    a.state.feeds[0].notifications.push(notice('new', 'low')); await a.refresh(); expect(a.calls).toEqual(['done']);
    await a.view.close();
  });

  it(`${version}: waits for a successful initial snapshot and rejects malformed sound settings`, async () => {
    const a = fixture(version); a.state.errors = [{ source: 'sessions', message: 'offline' }];
    await a.ready();
    expect(a.sharedState.has('spider.notifications.sounded')).toBe(false);
    a.state.errors = []; a.state.feeds[0].notifications.push(notice('history', 'urgent')); await a.refresh();
    expect(a.calls).toEqual([]);
    a.props.notifications.sound = 'invalid'; a.state.feeds[0].notifications.push(notice('bad-config', 'attention')); await a.refresh();
    expect(a.view.spiderFeedError).toBe('Invalid notification sound setting');
    expect(a.calls).toEqual([]);
    a.props.notifications.sound = true; await a.refresh(); expect(a.calls).toEqual([]);
    a.state.feeds[0].notifications.push(notice('later', 'low')); await a.refresh(); expect(a.calls).toEqual(['done']);
    await a.view.close();
  });

  it(`${version}: claims before playback and reports failure without retrying`, async () => {
    const a = fixture(version); await a.ready(); a.state.failSound = true;
    a.state.feeds[0].notifications.push(notice('sound-failure', 'urgent')); await a.refresh();
    expect(a.calls).toEqual(['blocked']);
    expect(a.view.spiderFeedError).toBe('Notification sound unavailable');
    expect(a.sharedState.get('spider.notifications.soundProblem')).toMatchObject({ message: 'Notification sound unavailable' });
    expect((a.sharedState.get('spider.notifications.sounded') as any).observed).toContainEqual(expect.objectContaining({ token: 'intentional:owner:sound-failure' }));
    a.state.failSound = false; await a.refresh(); expect(a.calls).toEqual(['blocked']);
    await a.view.close();
  });

  it(`${version}: a newly mounted view does not consume an existing view's arrival`, async () => {
    const shared = new Map<string, unknown>(), a = fixture(version, shared); await a.ready();
    const next = notice('during-mount', 'urgent'), b = fixture(version, shared);
    b.state.feeds[0].notifications.push(next); await b.ready();
    a.state.feeds[0].notifications.push(next); await a.refresh();
    expect([...a.calls, ...b.calls]).toEqual(['blocked']);
    expect((shared.get('spider.notifications.sounded') as any).observed).toContainEqual(expect.objectContaining({ token: 'intentional:owner:during-mount' }));
    await a.view.close(); await b.view.close();
  });
}
