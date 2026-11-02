// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { HerdrNotification, SessionFeed, TerminalAddress } from '../../../src/contracts.js';
export function selectPanelNotifications(feeds: readonly SessionFeed[], seen: ReadonlySet<string>, now: number): HerdrNotification[];
export interface NotificationTrackerPorts {
  clock?(): number;
  read(): unknown;
  write(ids: [string, number][]): void;
  notify(notification: HerdrNotification): void | boolean | Promise<void | boolean>;
}
export function createNotificationTracker(ports: NotificationTrackerPorts): { update(feeds: readonly SessionFeed[], now: number): void };
export interface NotificationActionPorts {
  ping(feed: SessionFeed): Promise<boolean>;
  openUsage(feed: SessionFeed): Promise<void>;
  focus(address: TerminalAddress): Promise<void>;
}
export interface NativePanelNotice {
  title: string; body: string; level: 'warning' | 'info'; action?: { name: string };
}
export interface PanelNotificationPorts extends NotificationActionPorts {
  read(key: string): unknown;
  write(key: string, ids: [string, number][]): void;
  feeds(): readonly SessionFeed[];
  clock(): number;
  schedule(work: () => Promise<void>): void;
  post(notification: NativePanelNotice): void;
}
export function createPanelNotifications(modId: unknown, ports: PanelNotificationPorts): {
  update(feeds: readonly SessionFeed[], now: number): void;
  command(command: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  close(): void;
};
export function dispatchPanelNotification(notification: HerdrNotification, feeds: readonly SessionFeed[], ports: NotificationActionPorts, now: number): Promise<{ ok: true } | { ok: false; reason: string }>;
