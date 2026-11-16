// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { notificationSound, observeNotificationSounds } from '../../assets/mods/spider/sound.js';
import { soundPreference } from '../../assets/mods/spider/data.js';

const DAY = 86400000, NOW = Date.UTC(2026, 10, 15, 12);
const item = (id: string, urgency: 'low' | 'attention' | 'urgent', createdAt: number) => ({
  kind: 'intentional' as const, key: `intentional:owner:${id}`, urgency, createdAt,
});

describe('intentional notification sounds', () => {
  it('maps attention and urgent to blocked and low to done', () => {
    expect(['attention', 'urgent', 'low'].map(urgency => notificationSound(urgency as any))).toEqual(['blocked', 'blocked', 'done']);
  });

  it('defaults sound on and rejects non-boolean installed props', () => {
    expect(soundPreference({})).toBe(true);
    expect(soundPreference({ notifications: { sound: true } })).toBe(true);
    expect(soundPreference({ notifications: { sound: false } })).toBe(false);
    for (const notifications of [null, {}, [], { sound: 'false' }, { sound: 0 }]) expect(soundPreference({ notifications })).toBeNull();
  });

  it('ignores malformed and automatic notices', () => {
    const baseline = observeNotificationSounds([], null, true, NOW);
    const invalid = [{ ...item('bad', 'attention', NOW + 1), urgency: 'loud' }, { ...item('auto', 'urgent', NOW + 1), kind: 'job-result' }, { ...item('future', 'low', NOW + 10), createdAt: NOW + 10 }];
    const result = observeNotificationSounds(invalid as any, baseline.state, true, NOW + 2);
    expect(result.sounds).toEqual([]); expect(result.state.observed).toEqual([]);
  });

  it('silences mount history and sounds each new urgency once', () => {
    const history = item('old', 'attention', NOW - 1);
    const baseline = observeNotificationSounds([history], null, true, NOW);
    expect(baseline.sounds).toEqual([]);
    const batch = [history, item('a', 'attention', NOW + 1), item('u', 'urgent', NOW + 2), item('l', 'low', NOW + 3)];
    const arrived = observeNotificationSounds(batch, baseline.state, true, NOW + 3);
    expect(arrived.sounds).toEqual(['blocked', 'blocked', 'done']);
    expect(observeNotificationSounds(batch, arrived.state, true, NOW + 4).sounds).toEqual([]);
  });

  it('observes muted arrivals without replaying them after sound is enabled', () => {
    const baseline = observeNotificationSounds([], null, true, NOW);
    const muted = observeNotificationSounds([item('muted', 'urgent', NOW + 1)], baseline.state, false, NOW + 2);
    expect(muted.sounds).toEqual([]);
    expect(observeNotificationSounds([item('muted', 'urgent', NOW + 1)], muted.state, true, NOW + 3).sounds).toEqual([]);
    expect(observeNotificationSounds([item('new', 'low', NOW + 4)], muted.state, true, NOW + 5).sounds).toEqual(['done']);
  });

  it('retains observed tokens while feeds are absent and sounds delayed new occurrences', () => {
    const baseline = observeNotificationSounds([], null, true, NOW);
    const arrived = observeNotificationSounds([item('one', 'attention', NOW + 1)], baseline.state, true, NOW + 2);
    const missing = observeNotificationSounds([], arrived.state, true, NOW + DAY);
    expect(missing.state.observed).toContainEqual({ token: 'intentional:owner:one', createdAt: NOW + 1 });
    const returned = observeNotificationSounds([item('one', 'attention', NOW + 1), item('delayed', 'urgent', NOW + 10)], missing.state, true, NOW + DAY + 1);
    expect(returned.sounds).toEqual(['blocked']);
  });

  it('does not sound old delayed history and expires claims after seven days', () => {
    const baseline = observeNotificationSounds([], null, true, NOW);
    const old = observeNotificationSounds([item('historical', 'attention', NOW - 10)], baseline.state, true, NOW + 1);
    expect(old.sounds).toEqual([]);
    const expired = observeNotificationSounds([], old.state, true, NOW - 10 + 7 * DAY);
    expect(expired.state.observed).toEqual([]);
  });
});
