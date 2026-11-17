// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { monitorFixture } from './herdr-monitor-fixture.js';

const handoff = vi.hoisted(() => ({ reconcile: vi.fn(), shutdown: vi.fn() }));
vi.mock('../jobs/handoff.js', async importOriginal => ({
  ...await importOriginal<typeof import('../jobs/handoff.js')>(), createJobHandoff: () => handoff,
}));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('does not attach another completion handler to a stalled maintenance scan on each tick', async () => {
  const h = await monitorFixture();
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  handoff.reconcile.mockReturnValue(stalled);
  handoff.shutdown.mockImplementation(async () => { release(); });
  vi.useFakeTimers();
  const parent = h.monitor();
  await parent.activate(h.owner);
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(handoff.reconcile).toHaveBeenCalledTimes(1);
    release(); await vi.advanceTimersByTimeAsync(2001);
    expect(handoff.reconcile).toHaveBeenCalledTimes(2);
    expect(h.errors).toEqual([]);
  } finally { await parent.shutdown('reload'); }
});

it('waits for child handoff when a parent reconcile is explicitly awaited', async () => {
  const h = await monitorFixture();
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  handoff.reconcile.mockReturnValue(stalled);
  handoff.shutdown.mockResolvedValue(undefined);
  const parent = h.monitor(); await parent.activate(h.owner);
  let done = false;
  try {
    const result = parent.reconcile().then(() => { done = true; });
    await vi.waitFor(() => expect(handoff.reconcile).toHaveBeenCalled());
    expect(done).toBe(false);
    release(); await result;
    expect(done).toBe(true);
  } finally { release(); await parent.shutdown('reload'); }
});

it('keeps maintenance scanning while an explicit caller waits for a child', async () => {
  const h = await monitorFixture();
  let release!: () => void, scans = 0;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  handoff.reconcile.mockImplementation((settings?: { wait?: boolean }) => {
    if (settings?.wait === false) { scans++; return Promise.resolve(); }
    return stalled;
  });
  handoff.shutdown.mockResolvedValue(undefined);
  vi.useFakeTimers();
  const parent = h.monitor(); await parent.activate(h.owner);
  let done = false;
  try {
    const result = parent.reconcile().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4001);
    expect(done).toBe(false);
    expect(scans).toBeGreaterThanOrEqual(2);
    release(); await result;
    expect(done).toBe(true);
  } finally { release(); await parent.shutdown('reload'); }
});

it('releases the maintenance slot after failure without a burst of queued retries', async () => {
  const h = await monitorFixture();
  let reject!: (error: Error) => void;
  const stalled = new Promise<void>((_resolve, fail) => { reject = fail; });
  handoff.reconcile.mockReturnValueOnce(stalled).mockResolvedValue(undefined);
  handoff.shutdown.mockResolvedValue(undefined);
  vi.useFakeTimers();
  const parent = h.monitor(); await parent.activate(h.owner);
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(handoff.reconcile).toHaveBeenCalledTimes(1);
    reject(new Error('Scan failed')); await vi.advanceTimersByTimeAsync(2001);
    expect(handoff.reconcile).toHaveBeenCalledTimes(2);
    expect(h.errors.map(error => (error as Error).message)).toEqual(['Scan failed']);
  } finally { await parent.shutdown('reload'); }
});
