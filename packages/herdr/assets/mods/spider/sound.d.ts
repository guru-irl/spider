// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { NotificationUrgency, SessionFeed } from '../../../src/contracts.js';
import type { NotificationItem } from './data.js';
export interface SoundState { baselineAt: number; observed: { token: string; createdAt: number }[] }
export function notificationSound(urgency: NotificationUrgency): 'blocked' | 'done';
export function observeNotificationSounds(notices: readonly Pick<NotificationItem, 'kind' | 'key' | 'urgency' | 'createdAt'>[], state: SoundState | null, enabled: boolean, now: number, mountedAt?: number): { state: SoundState; sounds: ('blocked' | 'done')[] };
export function createNotificationSound(ports: { shared: (key: string) => unknown; setShared: (key: string, value: unknown) => void; playSound: (sound: string) => unknown; props: () => unknown; report: (message: string) => void }): { observe(snapshot: { feeds: readonly SessionFeed[]; errors: readonly { source: string }[] }): void };
