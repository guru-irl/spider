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
