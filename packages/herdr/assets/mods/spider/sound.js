// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
const LIFETIME_MS = 7 * 86400000;

/** The built-in Herdr sound for one intentional occurrence. */
export function notificationSound(urgency) { return urgency === 'low' ? 'done' : 'blocked'; }

/** Observe once, including while muted; initial history is always silent. */
export function observeNotificationSounds(notices, previous, enabled, now, mountedAt = -Infinity) {
  const valid = previous && Number.isFinite(previous.baselineAt) && previous.baselineAt <= now && Array.isArray(previous.observed);
  const baselineAt = valid ? previous.baselineAt : now;
  const seen = new Map();
  if (valid) for (const entry of previous.observed) {
    if (entry && typeof entry.token === 'string' && entry.token && Number.isFinite(entry.createdAt)
      && entry.createdAt <= now && now - entry.createdAt < LIFETIME_MS) seen.set(entry.token, entry.createdAt);
  }
  const sounds = [];
  for (const notice of notices) {
    if (notice?.kind !== 'intentional' || typeof notice.key !== 'string' || !notice.key
      || !['attention', 'urgent', 'low'].includes(notice.urgency) || !Number.isFinite(notice.createdAt)
      || notice.createdAt > now || now - notice.createdAt >= LIFETIME_MS || seen.has(notice.key)) continue;
    seen.set(notice.key, notice.createdAt);
    if (valid && enabled && notice.createdAt >= baselineAt && notice.createdAt >= mountedAt) sounds.push(notificationSound(notice.urgency));
  }
  return { state: { baselineAt, observed: [...seen].map(([token, createdAt]) => ({ token, createdAt })) }, sounds };
}

/** Each Agents mount ignores its initial history and claims later arrivals synchronously. */
export function createNotificationSound({ shared, setShared, playSound, props, report }) {
  const key = 'spider.notifications.sounded';
  const problem = message => {
    try { setShared('spider.notifications.soundProblem', { at: Date.now(), message }); } catch { /* The sidebar still reports the failure. */ }
    report(message);
  };
  let history = null, mountedAt = Date.now();
  return {
    observe(snapshot) {
      if (snapshot.errors.some(error => error.source === 'sessions')) return;
      try {
        const now = Date.now(), notices = snapshot.feeds.flatMap(feed => (feed.notifications ?? []).map(notice => ({
          ...notice, key: `intentional:${feed.sessionId}:${notice.id}`,
        })));
        if (!history) {
          history = new Set(notices.map(notice => notice.key));
          if (!shared(key)) setShared(key, { baselineAt: now, observed: [] });
          return;
        }
        const config = props()?.notifications;
        const enabled = config === undefined ? true : config && typeof config === 'object' && !Array.isArray(config) && typeof config.sound === 'boolean' ? config.sound : null;
        if (enabled === null) problem('Invalid notification sound setting');
        const saved = shared(key);
        const result = observeNotificationSounds(notices.filter(notice => !history.has(notice.key)), saved, enabled === true, now, mountedAt);
        if (JSON.stringify(saved) !== JSON.stringify(result.state)) setShared(key, result.state);
        const sound = result.sounds.includes('blocked') ? 'blocked' : result.sounds[0];
        if (sound) {
          try { playSound(sound); } catch { problem('Notification sound unavailable'); }
        }
      } catch { problem('Notification sound unavailable'); }
    },
  };
}
