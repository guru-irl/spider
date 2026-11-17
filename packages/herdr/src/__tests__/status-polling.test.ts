// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Owner, PendingCounts } from '../contracts.js';
import { registerHerdrStatusContribution } from '../status/register.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
function fixture(listPending: () => Promise<PendingCounts>) {
  vi.stubEnv('HC_TERMINAL_ID', 'fixture'); vi.stubEnv('PI_SUBAGENT_CHILD', ''); vi.stubEnv('PI_PROGRAM_STATUS', '1');
  const terminal = Object.create(ProcessTerminal.prototype) as ProcessTerminal;
  terminal.setProgramStatus({ state: 'idle' });
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  const ctx = { mode: 'tui', ui: { setWidget(_name: string, widget?: (tui: { terminal: ProcessTerminal }) => unknown) { widget?.({ terminal }); } } } as unknown as ExtensionContext;
  const owner = { sessionId: 'owner', generation: 'g1' } as Owner;
  const warnings: string[] = []; let notify = () => {};
  const contribution = registerHerdrStatusContribution(pi, { currentOwner: () => owner, listPending,
    subscribeRuns: (_owner, listener) => { notify = listener; return () => {}; }, reportDisabled: reason => { warnings.push(reason); },
  });
  return { contribution, owner, warnings, start: () => handlers.get('session_start')!({}, ctx), notify: () => notify() };
}

it('keeps one status read across slow ticks and run notifications', async () => {
  vi.useFakeTimers();
  let active = 0, started = 0;
  const releases = new Set<() => void>();
  const h = fixture(async () => {
    active++; started++;
    try { await new Promise<void>(resolve => { releases.add(resolve); }); return { running: 1, queued: 0, paused: 0 }; }
    finally { active--; }
  });
  const starting = h.start();
  const counts: number[] = [];
  try {
    for (const ms of [20_000, 40_000, 60_000]) { await vi.advanceTimersByTimeAsync(ms); counts.push(active); h.notify(); }
    expect(counts).toEqual([1, 1, 1]);
    expect(started).toBe(1);
    for (const release of releases) release(); releases.clear(); await starting;
    expect(h.contribution.currentStatus(h.owner)).toMatchObject({ effective: 'working', message: '1 subagent running' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(started).toBe(2);
    expect(active).toBe(1);
    h.contribution.dispose(); h.notify();
    expect(started).toBe(2);
  } finally {
    h.contribution.dispose(); for (const release of releases) release(); await starting;
  }
  expect(active).toBe(0);
});

it('allows a new status read after rejection', async () => {
  vi.useFakeTimers(); let fail = true;
  const h = fixture(async () => { if (fail) throw new Error('Unavailable'); return { running: 0, queued: 2, paused: 0 }; });
  try {
    await h.start(); expect(h.warnings).toEqual(['status-counts-unavailable']);
    fail = false; await vi.advanceTimersByTimeAsync(2000);
    expect(h.contribution.currentStatus(h.owner)).toMatchObject({ effective: 'working', message: '2 queued' });
  } finally { h.contribution.dispose(); }
});
