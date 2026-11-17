import { EventEmitter } from 'node:events';
import type { MessagePort } from 'node:worker_threads';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from '@spider/db-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DashboardReader } from '../dashboard-contract.js';
import { bootUsageWorker, type UsageWorkerDependencies } from '../worker-entry.js';
import { UsageRuntime, type UsageWorker } from '../runtime.js';
import { createPanelUsageReader } from '../panel-usage.js';
import { openUsageLedger } from '../ledger.js';
import { USAGE_MIGRATIONS } from '../migrate.js';
import { USAGE_LEASE_SCHEMA } from '../schema.js';
import { acquireUsageLease, type Lease } from '../lease.js';
import type { UsageWorkerCommand, UsageWorkerEvent } from '../protocol.js';
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_DAY as DAY, DASHBOARD_MONTH as START, type DashboardFixture } from './fixtures/dashboard-ledger.js';
import { assertCallPlans, callPassQueries, captureQueries, explainQueries } from './fixtures/dashboard-plan.js';

// The message handler is exercised inline; only its thread-identity guard is replaced.
vi.mock('node:worker_threads', async original => ({ ...await original<typeof import('node:worker_threads')>(), isMainThread: false }));
const work = vi.hoisted(() => ({ totals: 0, fits: 0, opened: 0, closed: 0, ownership: 0, inspections: 0, failRead: false }));
vi.mock('../ledger.js', async original => {
  const actual = await original<typeof import('../ledger.js')>();
  return { ...actual, openUsageLedgerReadOnly: (...args: Parameters<typeof actual.openUsageLedgerReadOnly>) => {
    const ledger = actual.openUsageLedgerReadOnly(...args);
    if (ledger) {
      const inspect = ledger.leases.inspect.bind(ledger.leases);
      ledger.leases.inspect = (...args) => { work.inspections++; return inspect(...args); };
    }
    return ledger;
  } };
});
vi.mock('../query-redesign-shared.js', async original => {
  const actual = await original<typeof import('../query-redesign-shared.js')>();
  return { ...actual, readCorrectedTotal: (...args: Parameters<typeof actual.readCorrectedTotal>) => {
    work.totals++; return actual.readCorrectedTotal(...args);
  } };
});
vi.mock('../dashboard-reader.js', async original => {
  const actual = await original<typeof import('../dashboard-reader.js')>();
  return { ...actual, openDashboardReader: (...args: Parameters<typeof actual.openDashboardReader>) => {
    const reader = actual.openDashboardReader(...args);
    if (!reader) return reader;
    work.opened++;
    return { ...reader, snapshot<T>(read: Parameters<DashboardReader['snapshot']>[0]): T {
      if (work.failRead) throw new Error('injected read failure');
      return reader.snapshot(ctx => {
        const captured = captureQueries(ctx, () => read(ctx));
        const plans = explainQueries(ctx.db, captured.queries);
        assertCallPlans(plans);
        work.fits += callPassQueries(ctx.db, captured.queries.filter(query => query.calibration !== undefined)).length;
        work.ownership += callPassQueries(ctx.db, captured.queries.filter(query => query.sql.includes('AS own FROM json_each'))).length;
        return captured.value as T;
      });
    }, close() { work.closed++; reader.close(); } };
  } };
});
class Port extends EventEmitter {
  events: UsageWorkerEvent[] = [];
  closed = false;
  postMessage(event: UsageWorkerEvent) { this.events.push(event); }
  close() { this.closed = true; }
}
let f: DashboardFixture, p: Port, lease: Lease, clock: number;
const runtimes: UsageRuntime[] = [];
const now = START + 4.5 * DAY;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(work, { totals: 0, fits: 0, opened: 0, closed: 0, ownership: 0, inspections: 0, failRead: false });
  clock = now;
  f = createDashboardFixture(false); p = new Port();
  const price = (aic: number) => ({ status: 'priced' as const, aic,
    components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: 'fixture', tier: 'fixture', confidence: 'estimated' as const });
  f.ledger.apply(dashboardBatch([
    dashboardCall('other-first', { ts: START + DAY + 1, sessionId: 'other', price: price(300) }),
    dashboardCall('other-second', { ts: START + 2 * DAY + 1, sessionId: 'other', price: price(300) }),
    dashboardCall('own', { ts: START + 3 * DAY + 1, sessionId: 'human', price: price(10) }),
  ]));
  for (let day = 1; day <= 3; day++) f.ledger.insertCounter({ ts: START + day * DAY,
    creditsUsed: 1000 + (day - 1) * 150, accountLogin: 'fixture-account', resetDate: '2026-11-01', raw: {} });
  lease = acquireUsageLease(f.ledger, 'ingest', 'stalled-owner', () => now, 600000)!;
});
afterEach(async () => {
  const stops = runtimes.splice(0).map(runtime => runtime.stop());
  await vi.advanceTimersByTimeAsync(0); await Promise.all(stops);
  p.emit('message', { type: 'stop' }); await vi.advanceTimersByTimeAsync(0);
  lease.release(); f.close(); vi.useRealTimers(); vi.restoreAllMocks();
});
async function boot(discover: NonNullable<UsageWorkerDependencies['discover']> = async () => { throw new Error('follower must not discover'); }) {
  await bootUsageWorker(p as unknown as MessagePort, { type: 'start', owner: 'follower', child: false, poll: false, roots: {
    ledgerFile: f.file, registryDb: join(f.root, 'absent.db'), sessionsDir: join(f.root, 'sessions'), authPath: join(f.root, 'auth.json'), leaseDir: join(f.root, 'leases'),
  } }, { now: () => clock, discover });
  await vi.advanceTimersByTimeAsync(0);
}
function panel(at = now, sessionId = 'human', budget = 5000) {
  const requestId = p.events.length;
  p.emit('message', { type: 'panel-usage', requestId, now: at, sessionId, budget });
  const response = p.events.at(-1);
  if (response?.type !== 'panel-usage' || response.requestId !== requestId) throw new Error('missing panel response');
  return response.data;
}
it('does not aggregate whole-account fallback totals when counter history supplies cost and rate', async () => {
  // Reintroducing unconditional month/window projections reads unrelated calls twice per request.
  await boot();
  const value = panel();
  expect(value?.monthCost).toEqual({ credits: 5, label: '5' });
  expect(value?.pace).toMatchObject({ used: 1300, ratePerDay: 150, usedSource: 'counter', rateSource: 'counter' });
  expect(work.totals).toBe(0);
});
it('reuses calibrated evidence across unchanged panel messages and lease heartbeat writes', async () => {
  // Reopening the dashboard reader drops its calibration cache and repeats historical call passes.
  await boot();
  expect(panel()?.monthCost.credits).toBe(5);
  expect(work.fits).toBeGreaterThan(0);
  const fits = work.fits;
  for (let second = 1; second <= 10; second++) {
    f.db.exec("UPDATE leases SET expires_at=expires_at+1 WHERE name='ingest'");
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel(now + second * 1000)?.monthCost.credits).toBe(5);
  }
  expect(work.fits - fits).toBe(0);
  p.emit('message', { type: 'stop' }); await vi.advanceTimersByTimeAsync(0);
  expect(p.closed).toBe(true);
  expect(work.closed).toBe(work.opened);
});
it.each([['human', 5], ['new-session', 0]] as const)('does not re-probe unrelated identities for an unchanged %s panel', async (sessionId, credits) => {
  // Rebuilding scopeFor on each message repeats identity reads for every historical session.
  await boot();
  expect(panel(now, sessionId)?.monthCost.credits).toBe(credits);
  expect(work.ownership).toBeGreaterThan(0);
  const probes = work.ownership;
  for (let second = 1; second <= 10; second++) {
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel(now + second * 1000, sessionId)?.monthCost.credits).toBe(credits);
  }
  expect(work.ownership - probes).toBe(0);
});
it('releases an idle ownership scope and rebuilds it on the next panel read', async () => {
  // Keeping the scope forever prevents an idle worker from releasing its ownership graph.
  await boot();
  expect(panel()?.monthCost.credits).toBe(5);
  const initial = work.ownership;
  expect(initial).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(59000);
  expect(panel()?.monthCost.credits).toBe(5);
  expect(work.ownership).toBe(initial);
  await vi.advanceTimersByTimeAsync(59000);
  expect(panel()?.monthCost.credits).toBe(5);
  expect(work.ownership).toBe(initial);
  await vi.advanceTimersByTimeAsync(60000);
  expect(panel()?.monthCost.credits).toBe(5);
  expect(work.ownership).toBeGreaterThan(initial);
});
it('bounds a live stalled owner follower to one inspection per tick and takes over only at expiry', async () => {
  let discoveries = 0;
  await boot(async () => { discoveries++; return { sources: [], runs: [], errors: [] }; });
  const revision = f.db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get();
  await vi.advanceTimersByTimeAsync(60000);
  expect(discoveries).toBe(0);
  expect(p.events.filter(event => event.type === 'snapshot')).toHaveLength(21);
  expect(work.inspections).toBe(22);
  expect(work.fits).toBe(0);
  expect(work.ownership).toBe(0);
  expect(f.db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get()).toEqual(revision);
  expect(lease.isCurrent(() => clock)).toBe(true);
  clock += 600001;
  await vi.advanceTimersByTimeAsync(3000);
  expect(discoveries).toBe(1);
  expect(p.events.filter(event => event.type === 'snapshot').at(-1)?.ingestRole).toBe('owner');
  expect(lease.isCurrent(() => clock)).toBe(false);
});
it.each([{ cadence: 1000, kind: 'call' }, { cadence: 30000, kind: 'call' },
  { cadence: 1000, kind: 'checkpoint' }, { cadence: 30000, kind: 'checkpoint' }])('bounds $kind invalidation fan-out with three followers requesting every $cadence ms', async ({ cadence, kind }) => {
  vi.setSystemTime(now);
  let sent = 0;
  const roots = { ledgerFile: f.file, registryDb: join(f.root, 'absent.db'), sessionsDir: join(f.root, 'sessions'),
    authPath: join(f.root, 'auth.json'), leaseDir: join(f.root, 'leases') };
  for (let i = 0; i < 3; i++) {
    const runtime = new UsageRuntime({ bundleUrl: 'file:///synthetic-worker.mjs', child: false, roots, supportsWorkers: () => true,
      workerFactory: (_url, options) => {
        const events = new EventEmitter(), port = new Port();
        port.postMessage = event => { events.emit('message', event); };
        void bootUsageWorker(port as unknown as MessagePort,
          (options.workerData as { command: Extract<UsageWorkerCommand, { type: 'start' }> }).command,
          { now: () => clock, discover: async () => { throw new Error('follower must not discover'); } });
        return Object.assign(events, {
          postMessage(command: UsageWorkerCommand) { if (command.type === 'panel-usage') sent++; port.emit('message', command); },
          terminate: async () => 0, unref() {},
        }) as unknown as UsageWorker;
      } });
    runtimes.push(runtime); runtime.start(false);
  }
  await vi.advanceTimersByTimeAsync(0);
  const read = async () => {
    const values = await Promise.all(runtimes.map(runtime => runtime.readPanel(Date.now(), 'human', 5000)));
    expect(values.map(value => value?.monthCost.credits)).toEqual([5, 5, 5]);
  };
  if (kind === 'checkpoint') f.db.prepare('INSERT INTO import_state(path,generation,offset,size,last_ingest_at) VALUES (?,0,1,2,?)').run('unrelated-source.jsonl', now);
  await read();
  const fits = work.fits, ownership = work.ownership;
  const revision = () => f.db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get();
  const before = revision();
  for (let second = 1; second <= 60; second++) {
    // These calls are after the last counter anchor and belong to another known session.
    if (kind === 'call') f.ledger.apply(dashboardBatch([dashboardCall(`appended-${second}`, { sessionId: 'other', ts: now + second * 1000 })]));
    else f.db.exec("UPDATE import_state SET offset=offset+1,size=size+1 WHERE path='unrelated-source.jsonl'");
    clock += 1000; await vi.advanceTimersByTimeAsync(1000);
    if (second * 1000 % cadence === 0) await read();
  }
  expect(revision()).not.toEqual(before);
  expect(work.fits - fits).toBe(2 * fits);
  expect(work.ownership - ownership).toBe(2 * ownership);
  expect(sent).toBe(9);
  expect(work.totals).toBe(0);
  const atRest = work.fits;
  for (let second = 1; second <= 30; second++) {
    clock += 1000; await vi.advanceTimersByTimeAsync(1000); await read();
  }
  expect(work.fits).toBe(atRest);
});
it('reads only a trailing fallback when the counter supplies usage but not a rate', async () => {
  f.db.exec(`DELETE FROM counter_snapshots WHERE ts<${START + 3 * DAY}`);
  await boot();
  const value = panel();
  expect(value?.monthCost.credits).toBe(10);
  expect(value?.pace).toMatchObject({ used: 1300, usedSource: 'counter', rateSource: 'pi' });
  expect(value?.pace.ratePerDay).toBeCloseTo(135.55555555555554);
  expect(work.totals).toBe(1);
});
it('keeps both corrected fallbacks when there is no counter history', async () => {
  f.db.exec('DELETE FROM counter_snapshots');
  await boot();
  const value = panel();
  expect(value?.monthCost.credits).toBe(10);
  expect(value?.pace).toMatchObject({ used: 610, usedSource: 'pi', rateSource: 'pi' });
  expect(value?.pace.ratePerDay).toBeCloseTo(135.55555555555554);
  expect(work.totals).toBe(2);
});
it('refreshes cached fits for counter-only appends without a call revision change', async () => {
  await boot();
  expect(panel()?.monthCost.credits).toBe(5);
  const fits = work.fits;
  const revision = () => f.db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get();
  const before = revision();
  f.ledger.insertCounter({ ts: START + 3.5 * DAY, creditsUsed: 1450, accountLogin: 'fixture-account', resetDate: '2026-11-01', raw: {} });
  expect(revision()).toEqual(before);
  const value = panel();
  expect(value?.monthCost.credits).toBeCloseTo(7.377049180327869);
  expect(value?.pace).toMatchObject({ used: 1450, ratePerDay: 180 });
  expect(work.fits).toBeGreaterThan(fits);
});
it('refreshes cached fits and session totals after a call commit', async () => {
  await boot();
  expect(panel()?.monthCost.credits).toBe(5);
  const fits = work.fits;
  f.ledger.apply(dashboardBatch([dashboardCall('additional', { ts: START + 3 * DAY + 2, sessionId: 'human',
    price: { status: 'priced', aic: 20, components: { input: 20, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: 'fixture', tier: 'fixture', confidence: 'estimated' } })]));
  expect(panel()?.monthCost.credits).toBe(15);
  expect(work.fits).toBeGreaterThan(fits);
});
it('does not cache panel values across owners, budgets, time ranges or calibration modes', async () => {
  await boot();
  expect(panel()?.monthCost.credits).toBe(5);
  // The earliest accepted factor is back-applied to both earlier days: 600 * 0.5.
  expect(panel(now, 'other')?.monthCost.credits).toBe(300);
  expect(panel(now, 'new-session')?.monthCost.credits).toBe(0);
  expect(panel(now, 'human', 2000)?.pace).toMatchObject({ budget: 2000, remaining: 700 });
  expect(panel(START + 3 * DAY)?.monthCost.credits).toBe(0);
  p.emit('message', { type: 'configure', poll: false, calibration: 'off' });
  expect(panel()?.monthCost.credits).toBe(10);
  p.emit('message', { type: 'configure', poll: false, calibration: 'auto' });
  expect(panel()?.monthCost.credits).toBe(5);
  expect(panel(START + 32 * DAY)?.monthCost.credits).toBe(0);
});
it('invalidates ownership after a session metadata-only reassignment', async () => {
  const session = (id: string, ownerSessionId: string | null) => ({ id, ownerSessionId, name: id, nameSource: 'name' as const,
    project: null, firstActivity: START, lastActivity: now, nameOrder: 1 });
  f.ledger.apply(dashboardBatch([dashboardCall('child', { sessionId: 'child', ts: START + 3 * DAY + 2 })], {
    sessions: [session('human', null), session('other', null), session('child', 'human')],
  }));
  await boot();
  expect(panel()?.monthCost.credits).toBe(5.5);
  f.db.exec("UPDATE sessions SET owner_session_id='other' WHERE id='child'");
  expect(panel()?.monthCost.credits).toBe(5);
  expect(panel(now, 'other')?.monthCost.credits).toBe(300.5);
});
it('invalidates a missing identity when its first call is ingested', async () => {
  await boot();
  expect(panel(now, 'new-session')?.monthCost.credits).toBe(0);
  f.ledger.apply(dashboardBatch([dashboardCall('first', { sessionId: 'new-session', ts: START + 3 * DAY + 2 })]));
  expect(panel(now, 'new-session')?.monthCost.credits).toBe(0.5);
});
it('closes a failed connection and retries the next panel request', async () => {
  await boot();
  expect(panel()?.monthCost.credits).toBe(5);
  work.failRead = true;
  expect(panel()).toBeNull();
  expect(work.closed).toBe(1);
  work.failRead = false;
  expect(panel()?.monthCost.credits).toBe(5);
  expect(work.opened).toBe(2);
});
it('replaces its retained connection and cached identity after a schema upgrade', () => {
  const file = join(f.root, 'upgraded.db'), db = openDb(file);
  try {
    for (const migration of USAGE_MIGRATIONS.filter(migration => migration.version <= 6)) {
      db.exec(migration.sql); migration.apply?.(db.raw);
      db.pragma(`user_version=${migration.version}`);
    }
    db.exec(USAGE_LEASE_SCHEMA);
  } finally { db.close(); }
  const reader = createPanelUsageReader(file);
  try {
    expect(reader.read(now, 'new-session', undefined, 'off')?.monthCost.credits).toBe(0);
    const ledger = openUsageLedger(file);
    try { ledger.apply(dashboardBatch([dashboardCall('upgraded-first', { sessionId: 'new-session', ts: START + 3 * DAY + 2 })])); }
    finally { ledger.close(); }
    expect(reader.read(now, 'new-session', undefined, 'off')?.monthCost.credits).toBe(1);
  } finally { reader.close(); }
});
it('retries a missing ledger without creating it from a panel read', () => {
  const file = join(f.root, 'appears-later.db'), reader = createPanelUsageReader(file);
  try {
    expect(reader.read(now, 'human', undefined, 'off')).toBeNull();
    expect(existsSync(file)).toBe(false);
    const ledger = openUsageLedger(file); ledger.close();
    expect(reader.read(now, 'human', undefined, 'off')?.monthCost.credits).toBe(0);
  } finally { reader.close(); }
});
