// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { panelSessionState } from './data.js';
const DAY = 86400000;
const retained = (id, seenAt, now) => now - seenAt < (id.startsWith('budget:') ? 62 * DAY : 7 * DAY);
function prune(entries, now, limit) {
  for (const [id, entry] of entries) if (!retained(id, entry.seenAt, now)) entries.delete(id);
  if (entries.size <= limit) return;
  const ordered = [...entries].sort(([a, x], [b, y]) => Number(b.startsWith('budget:')) - Number(a.startsWith('budget:')) || y.seenAt - x.seenAt);
  for (const [id] of ordered.slice(limit)) entries.delete(id);
}
export function createPanelNotifications(modId, ports) {
  if (typeof modId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(modId)) throw new Error('Notifications unavailable: missing or invalid modId');
  const key = `spider.notifications/${modId}`, notices = new Map();
  let closed = false;
  const tracker = createNotificationTracker({
    read: () => ports.read(key), write: ids => ports.write(key, ids), clock: ports.clock,
    notify: notification => new Promise(resolve => {
      ports.schedule(async () => {
        try {
          const feeds = ports.feeds(), now = ports.clock();
          const actionable = notification.scope === 'shared' ? Boolean(await usageEndpoint(feeds, ports, now))
            : feeds.some(feed => panelSessionState(feed, now) === 'live' && feed.sessionId === notification.sessionId && feed.owner.terminal.address === notification.ownerAddress);
          if (closed) { resolve(false); return; }
          ports.post({title:notification.title,body:notification.body + (actionable ? '' : ' · Action unavailable: no live endpoint'),
            level:notification.kind === 'budget' || notification.kind === 'escalation' ? 'warning' : 'info',
            ...(actionable ? {action:{name:`${modId}.notice-${encodeURIComponent(notification.id)}`}} : {})});
          notices.set(notification.id, { notification, seenAt: ports.clock() });
          prune(notices, ports.clock(), 512);
          resolve(true);
        } catch (error) { resolve(false); throw error; }
      });
    }),
  });
  return {
    update(feeds, now) { if (!closed) { prune(notices, now, 512); tracker.update(feeds, now); } },
    async command(command) {
      if (closed || !command.startsWith('notice-')) return {ok:false,reason:'Unknown notification'};
      prune(notices, ports.clock(), 512);
      let id; try { id = decodeURIComponent(command.slice(7)); } catch { return {ok:false,reason:'Unknown notification'}; }
      const entry = notices.get(id);
      if (!entry) return {ok:false,reason:'Unknown notification'};
      return dispatchPanelNotification(entry.notification, ports.feeds(), ports, ports.clock());
    },
    close() { closed = true; notices.clear(); },
  };
}
async function usageEndpoint(feeds, ports, now) {
  const live = feeds.filter(feed => panelSessionState(feed, now) === 'live' && feed.ipc);
  live.sort((a,b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
  for (const feed of live) { try { if (await ports.ping(feed)) return feed; } catch { /* Try another verified shared endpoint. */ } }
  return null;
}
export async function dispatchPanelNotification(notification, feeds, ports, now) {
  if (!notification.action) return {ok:false,reason:'Action unavailable'};
  const live = feeds.filter(feed => panelSessionState(feed, now) === 'live');
  if (notification.scope === 'shared') {
    const feed = await usageEndpoint(live, ports, now);
    if (!feed) return {ok:false,reason:'No live usage endpoint'};
    try { await ports.openUsage(feed); return {ok:true}; }
    catch (error) { return {ok:false,reason:error.message}; }
  }
  const owner = live.find(feed => feed.sessionId === notification.sessionId && feed.owner.terminal.address === notification.ownerAddress);
  if (!owner) return {ok:false,reason:'Owner unavailable'};
  try { await ports.focus(notification.ownerAddress); return {ok:true}; }
  catch (error) { return {ok:false,reason:error.message}; }
}
export function createNotificationTracker(ports) {
  const stored = ports.read();
  const pair = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isFinite(value[1]) && value[1] >= 0;
  let initialized = Array.isArray(stored) && stored.every(value => typeof value === 'string' || pair(value));
  const seen = new Map(), pending = new Set();
  let startedAt = ports.clock?.(), serialized = JSON.stringify(stored);
  let legacy = initialized ? stored : [];
  function save(now) {
    prune(seen, now, 2048);
    const ids = [...seen].map(([id, entry]) => [id, entry.seenAt]);
    const next = JSON.stringify(ids);
    if (next !== serialized) { serialized = next; ports.write(ids); }
  }
  const remember = (id, now) => { if (!seen.has(id)) seen.set(id, { seenAt: now }); };
  return { update(feeds, now) {
    startedAt ??= now;
    if (legacy) {
      for (const value of legacy) {
        const [id, seenAt] = typeof value === 'string' ? [value, now] : value;
        seen.set(id, { seenAt });
      }
      legacy = null;
    }
    prune(seen, now, 2048);
    if (!initialized) {
      for (const feed of feeds) for (const n of feed.notifications) if (n.createdAt <= now) remember(n.id, now);
      initialized = true; save(now); return;
    }
    const excluded = new Set([...seen.keys(), ...pending]);
    for (const feed of feeds) for (const n of feed.notifications) if (n.createdAt < startedAt) {
      remember(n.id, now); excluded.add(n.id);
    }
    const selected = selectPanelNotifications(feeds, excluded, now);
    for (const n of selected) {
      pending.add(n.id);
      const delivered = ok => {
        pending.delete(n.id);
        if (ok !== false) { remember(n.id, ports.clock?.() ?? now); save(ports.clock?.() ?? now); }
      };
      try {
        const result = ports.notify(n);
        if (result && typeof result.then === 'function') result.then(delivered, () => { pending.delete(n.id); });
        else delivered(result);
      } catch { pending.delete(n.id); }
    }
    save(now);
  }};
}
export function selectPanelNotifications(feeds, seen, now) {
  const selected = new Map();
  for (const feed of feeds) for (const notification of feed.notifications) {
    if (seen.has(notification.id) || notification.createdAt > now || panelSessionState(feed, now) === 'disconnected') continue;
    if (notification.kind === 'budget' && (feed.pace.budget === null || (notification.id.endsWith(':projected') ? feed.pace.projected === null : feed.pace.used === null))) continue;
    selected.set(notification.id, notification);
  }
  return [...selected.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
