// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { FEED_DISCONNECT_MS, FEED_REFRESH_MS } from '../../assets/shared/feed.js';
import { indexPaneNavigation } from '../../assets/shared/navigation.js';
import { createPaneServiceState, disableUnavailableRemoteActions } from '../../assets/shared/pane-service-state.js';

afterEach(() => vi.restoreAllMocks());
const snapshot = () => ({ version: 1, kind: 'snapshot', complete: true, omittedRows: 0, presentations: [], rows: [] });
function fixture(configured = true) {
  const timers = new Set<{ fire: () => void }>();
  const timer = { every(_ms: number, fire: () => void) { const item = { fire }; timers.add(item); return { cancel() { timers.delete(item); } }; } };
  const request = vi.fn(async (_config: unknown, _exec: unknown, _body: unknown): Promise<any> => snapshot());
  const changed = vi.fn(), exec = vi.fn();
  const state = createPaneServiceState({ paneServiceConfigured: configured }, { exec, timer, request, index: indexPaneNavigation, refreshMs: FEED_REFRESH_MS, staleMs: FEED_DISCONNECT_MS, changed });
  return { state, request, changed, timers };
}

it('does no service work when the capability is not configured', async () => {
  const h = fixture(false);
  expect(h.state.state()).toMatchObject({ configured: false, unavailable: false, snapshot: null, index: null });
  await h.state.refresh();
  expect(h.request).not.toHaveBeenCalled(); expect(h.timers.size).toBe(0);
});

it('retains the last valid snapshot through failure, then disables remote actions after bounded staleness', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000), h = fixture();
  expect(h.state.state().unavailable).toBe(true);
  await h.state.refresh(); const valid = h.state.state().snapshot;
  expect(valid).not.toBeNull(); expect(h.state.state().unavailable).toBe(false);
  clock.mockReturnValue(105000); h.request.mockResolvedValueOnce({ ...snapshot(), rows: [{ children: null }] });
  await h.state.refresh();
  expect(h.state.state()).toMatchObject({ snapshot: valid, unavailable: false });
  clock.mockReturnValue(100000 + FEED_DISCONNECT_MS);
  expect(h.state.state()).toMatchObject({ snapshot: valid, unavailable: false });
  clock.mockReturnValue(100001 + FEED_DISCONNECT_MS);
  expect(h.state.state()).toMatchObject({ snapshot: valid, unavailable: true });
  const rows = [
    { id: 'remote', terminal: 'remote/a', machine: 'remote', action: { kind: 'pane' } },
    { id: 'child', ownerId: 'remote', terminal: 'local-viewer', machine: null, action: { kind: 'focus' } },
    { id: 'local', terminal: 'core/a', machine: null, action: { kind: 'focus' } },
  ];
  expect(disableUnavailableRemoteActions(rows, true, 'core')).toEqual([
    expect.objectContaining({ id: 'remote', action: null }), expect.objectContaining({ id: 'child', action: null }), rows[2],
  ]);
  expect(disableUnavailableRemoteActions(rows, false, 'core')).toBe(rows);
});

it('does not replace a good snapshot with an unprojectable target', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000), h = fixture();
  await h.state.refresh(); const valid = h.state.state().snapshot;
  clock.mockReturnValue(105000);
  h.request.mockResolvedValueOnce({ ...snapshot(), rows: [{ sessionId: 's', generation: 'g', owner: { terminal: { address: 'remote/a' } }, target: { coreId: 'remote', terminalId: 'a', address: 'remote/a' }, name: 'Owner', status: 'working', machineKey: 'remote', children: [], consoles: [], unavailableReason: null }] });
  await h.state.refresh();
  expect(h.state.state().snapshot).toBe(valid);
});

it('bounds a hung request, coalesces callers, backs off, and ignores its late result', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000), h = fixture();
  let release!: (value: any) => void;
  h.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = h.state.refresh(), second = h.state.refresh();
  expect(first).toBe(second); expect(h.request).toHaveBeenCalledTimes(1); expect(h.timers.size).toBe(1);
  clock.mockReturnValue(105000); [...h.timers][0].fire(); await first;
  expect(h.state.state()).toMatchObject({ snapshot: null, unavailable: true });
  release(snapshot()); await Promise.resolve();
  expect(h.state.state().snapshot).toBeNull();
  await h.state.refresh(); expect(h.request).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(110000); await h.state.refresh();
  expect(h.request).toHaveBeenCalledTimes(2); expect(h.state.state().unavailable).toBe(false);
  expect(h.timers.size).toBe(0);
});

it('backs off repeated failures and does not publish an in-flight reply after close', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000), h = fixture();
  h.request.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'));
  await h.state.refresh(); clock.mockReturnValue(105000); await h.state.refresh();
  clock.mockReturnValue(114999); await h.state.refresh(); expect(h.request).toHaveBeenCalledTimes(2);
  let release!: (value: any) => void;
  h.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  clock.mockReturnValue(115000); const pending = h.state.refresh();
  const notifications = h.changed.mock.calls.length; h.state.close(); release(snapshot()); await pending;
  expect(h.changed).toHaveBeenCalledTimes(notifications); expect(h.state.state().snapshot).toBeNull();
  await h.state.refresh(); expect(h.request).toHaveBeenCalledTimes(3); expect(h.timers.size).toBe(0);
});
