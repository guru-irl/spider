// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDbAt } from '@spider/db-core';
import { createHerdrDataSource, type HostDataSourceOptions } from '../herdr/data-source.js';
import * as readers from '../usage/dashboard-reader.js';
import { openUsageLedger } from '../usage/ledger.js';
import { UsageRuntime, type UsageWorker } from '../usage/runtime.js';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import type { UsageWorkerCommand } from '../usage/protocol.js';
import { pathToFileURL } from 'node:url';
import { dashboardBatch, dashboardCall } from '../usage/__tests__/fixtures/dashboard-ledger.js';
import { readUsageCube, sessionRows } from '../usage/query-redesign-shared.js';
import { computePace } from '../usage/billing-pace.js';
import { readPaceHistoryFromDb } from '../usage/pace-history.js';
import type { RunMeta, SessionMeta } from '../usage/ledger.js';
import type { Owner, SessionFeed } from '../../../herdr/src/contracts.js';

const NOW = Date.UTC(2026, 10, 15, 12);
const unavailable = { credits: null, label: 'unavailable' };
const roots: string[] = [];
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture(readUsage: HostDataSourceOptions['readUsage'], initialNow = NOW) {
  const scratch = resolve('.spider/scratch/h/cost'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'fixture-')); roots.push(root);
  const runFile = join(root, 'runs.db'), approvalFile = join(root, 'approvals.db');
  openDbAt(runFile, 'worktree').close(); openDbAt(approvalFile, 'global').close();
  openUsageLedger(join(root, 'usage.db')).close();
  const owner: Owner = { sessionId: 'fixture-owner' as Owner['sessionId'], generation: 'g' as Owner['generation'], terminal: { coreId: 'core' as never, terminalId: 'terminal' as never, address: 'terminal' as never, socket: join(root, 's'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: 'Fixture' };
  let now = initialNow;
  const source = createHerdrDataSource({
    resolveRunDb: () => ({ db: openDbAt(runFile, 'worktree'), dbPath: runFile }), openApprovalDbs: () => ({ global: openDbAt(approvalFile, 'global'), repo: null }),
    runEvents: { on: () => () => {} }, scheduler: { listTriggers: () => [], subscribe: () => () => {} },
    readUsage, readConfig: () => ({ globalRoot: root, limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 } }), clock: () => now,
  });
  disposals.push(() => source.dispose());
  return { root, owner, source, advance: (ms: number) => { now += ms; } };
}
const emptyUsage = { snapshots: [], budget: 100, correctedMonth: null, correctedWindow: null, updatedAt: null };

class SilentWorker extends EventEmitter {
  postMessage(command: UsageWorkerCommand) { if (command.type === 'stop') queueMicrotask(() => this.emit('message', { type: 'stopped' })); }
  async terminate() { return 0; }
  unref() {}
}
function silentRuntime(root: string, worker: SilentWorker): UsageRuntime {
  return new UsageRuntime({ bundleUrl: new URL('file:///fixture/extension.js'), child: false,
    roots: { ledgerFile: join(root, 'usage.db'), registryDb: join(root, 'registry.db'), sessionsDir: join(root, 'sessions'), authPath: join(root, 'auth.json'), leaseDir: join(root, 'leases') }, workerFactory: () => worker as unknown as UsageWorker });
}

it('publishes unavailable immediately while the first usage value is pending', async () => {
  // Reintroducing an awaited usage read stalls the feed instead of publishing the pending state.
  let finish!: (value: typeof emptyUsage) => void;
  const pending = new Promise<typeof emptyUsage>(resolve => { finish = resolve; });
  const f = fixture(() => pending);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const feed = await Promise.race([f.source.snapshot(f.owner), new Promise<'blocked'>(resolve => { timer = setTimeout(() => resolve('blocked'), 100); })]);
    expect(feed).not.toBe('blocked');
    expect((feed as SessionFeed).monthCost).toEqual(unavailable);
    expect((feed as SessionFeed).pace.used).toBeNull();
  } finally { clearTimeout(timer); finish(emptyUsage); }
});

it('never opens the usage dashboard reader on the snapshot caller thread', async () => {
  // Moving the month query back into snapshot trips this native-reader boundary.
  const f = fixture(async () => emptyUsage);
  let callingThreadRead = false;
  vi.spyOn(readers, 'openDashboardReader').mockImplementation(() => { callingThreadRead = true; throw new Error('calling-thread-ledger-read'); });
  const feed = await f.source.snapshot(f.owner);
  expect(callingThreadRead).toBe(false);
  expect(feed.monthCost).toEqual(unavailable);
});

it('keeps the previous cost and pace during a replacement read but clears them after its failure', async () => {
  let reject!: (error: Error) => void;
  const failed = new Promise<typeof emptyUsage>((_resolve, fail) => { reject = fail; });
  let attempt = 0;
  const f = fixture(() => ++attempt === 1 ? Promise.resolve({ ...emptyUsage, correctedMonth: 12, monthCost: { credits: 7, label: '7' } }) : failed);
  const first = await f.source.snapshot(f.owner);
  expect(first.monthCost).toEqual({ credits: 7, label: '7' });
  expect(first.pace.used).toBe(12);
  f.advance(30000);
  const pending = await f.source.snapshot(f.owner);
  expect(pending.monthCost).toEqual({ credits: 7, label: '7' });
  expect(pending.pace).toEqual(first.pace);
  reject(new Error('worker unavailable'));
  await Promise.resolve(); await Promise.resolve();
  const failure = await f.source.snapshot(f.owner);
  expect(failure.monthCost).toEqual(unavailable);
  expect(failure.pace.used).toBeNull();
  expect(failure.pace.unavailableReason).toBe('usage-read-failed');
});

it('clears a pending replacement at the month boundary and ignores its old-month result', async () => {
  // Reusing a prior month's cached value or completing read would publish the wrong month's cost.
  let finish!: (value: typeof emptyUsage & { monthCost: { credits: number; label: string } }) => void;
  const replacement = new Promise<typeof emptyUsage & { monthCost: { credits: number; label: string } }>(resolve => { finish = resolve; });
  let attempt = 0;
  const f = fixture(() => ++attempt === 1 ? Promise.resolve({ ...emptyUsage, correctedMonth: 12, monthCost: { credits: 7, label: '7' } })
    : attempt === 2 ? replacement : new Promise(() => {}), Date.UTC(2026, 10, 30, 23, 59, 15));
  const first = await f.source.snapshot(f.owner);
  expect(first.pace.periodStart).toBe(Date.UTC(2026, 10, 1));
  f.advance(30000);
  const pending = await f.source.snapshot(f.owner);
  expect(pending.monthCost).toEqual({ credits: 7, label: '7' });
  expect(pending.pace).toEqual(first.pace);
  f.advance(15000);
  const boundary = await f.source.snapshot(f.owner);
  expect(boundary.monthCost).toEqual(unavailable);
  expect(boundary.pace.used).toBeNull();
  finish({ ...emptyUsage, monthCost: { credits: 8, label: '8' } });
  await Promise.resolve(); await Promise.resolve();
  const late = await f.source.snapshot(f.owner);
  expect(late.monthCost).toEqual(unavailable);
  expect(late.pace.used).toBeNull();
});

it('clears kept figures at a mid-month pace reset and ignores a late prior-period result', async () => {
  // Calendar-only invalidation would retain the prior billing period after its reset.
  const at = Date.UTC(2026, 10, 14, 23, 59, 15);
  const initial = { ...emptyUsage, snapshots: [{ ts: at, creditsUsed: 12, resetDate: '2026-11-15', raw: {} }], monthCost: { credits: 7, label: '7' } };
  let finish!: (value: typeof initial) => void;
  const replacement = new Promise<typeof initial>(resolve => { finish = resolve; });
  let attempt = 0;
  const f = fixture(() => ++attempt === 1 ? Promise.resolve(initial) : attempt === 2 ? replacement : new Promise(() => {}), at);
  const first = await f.source.snapshot(f.owner);
  expect(first.pace).toMatchObject({ used: 12, periodStart: Date.UTC(2026, 9, 15), periodEnd: Date.UTC(2026, 10, 15) });
  f.advance(30000);
  const pending = await f.source.snapshot(f.owner);
  expect(pending.monthCost).toEqual({ credits: 7, label: '7' });
  expect(pending.pace).toEqual(first.pace);
  f.advance(15000);
  const reset = await f.source.snapshot(f.owner);
  expect(reset.monthCost).toEqual(unavailable);
  expect(reset.pace.used).toBeNull();
  finish({ ...initial, monthCost: { credits: 8, label: '8' } });
  await Promise.resolve(); await Promise.resolve();
  const late = await f.source.snapshot(f.owner);
  expect(late.monthCost).toEqual(unavailable);
  expect(late.pace.used).toBeNull();
});

it('keeps figures across a UTC month rollover within the same mid-month pace period', async () => {
  // A calendar key would cause an unavailable blink despite an unchanged billing period.
  const at = Date.UTC(2026, 10, 30, 23, 59, 15);
  let attempt = 0;
  const f = fixture(() => ++attempt === 1 ? Promise.resolve({ ...emptyUsage, snapshots: [{ ts: at, creditsUsed: 12, resetDate: '2026-12-15', raw: {} }], monthCost: { credits: 7, label: '7' } }) : new Promise(() => {}), at);
  const first = await f.source.snapshot(f.owner);
  expect(first.pace).toMatchObject({ periodStart: Date.UTC(2026, 10, 15), periodEnd: Date.UTC(2026, 11, 15) });
  f.advance(30000);
  const pending = await f.source.snapshot(f.owner);
  expect(pending.monthCost).toEqual({ credits: 7, label: '7' });
  expect(pending.pace).toEqual(first.pace);
  f.advance(15000);
  const rollover = await f.source.snapshot(f.owner);
  expect(rollover.monthCost).toEqual({ credits: 7, label: '7' });
  expect(rollover.pace).toEqual(first.pace);
});

it('retains a pending value for at most twice the cache TTL without renewing its age', async () => {
  // Giving a replacement the original value's age prevents an indefinitely stale pending feed.
  let attempt = 0;
  const f = fixture(() => ++attempt === 1 ? Promise.resolve({ ...emptyUsage, correctedMonth: 12, monthCost: { credits: 7, label: '7' } }) : new Promise(() => {}));
  const first = await f.source.snapshot(f.owner);
  f.advance(30000);
  const pending = await f.source.snapshot(f.owner);
  expect(pending.monthCost).toEqual({ credits: 7, label: '7' });
  expect(pending.pace).toEqual(first.pace);
  f.advance(30000);
  const limit = await f.source.snapshot(f.owner);
  expect(limit.monthCost).toEqual({ credits: 7, label: '7' });
  expect(limit.pace).toEqual(first.pace);
  f.advance(1);
  const tooOld = await f.source.snapshot(f.owner);
  expect(tooOld.monthCost).toEqual(unavailable);
  expect(tooOld.pace.used).toBeNull();
});

it('does not share a cached session cost with another owner', async () => {
  const f = fixture(async (_now, owner) => ({ ...emptyUsage, monthCost: { credits: owner.sessionId === 'fixture-owner' ? 7 : 9, label: owner.sessionId === 'fixture-owner' ? '7' : '9' } }));
  expect((await f.source.snapshot(f.owner)).monthCost).toEqual({ credits: 7, label: '7' });
  expect((await f.source.snapshot({ ...f.owner, sessionId: 'other-owner' as Owner['sessionId'] })).monthCost).toEqual({ credits: 9, label: '9' });
});

it('returns unavailable when the existing usage worker cannot service panel reads', async () => {
  const f = fixture(async () => emptyUsage);
  const runtime = new UsageRuntime({ bundleUrl: new URL('file:///fixture/extension.js'), roots: { ledgerFile: join(f.root, 'usage.db'), registryDb: join(f.root, 'registry.db'), sessionsDir: join(f.root, 'sessions'), authPath: join(f.root, 'auth.json'), leaseDir: join(f.root, 'leases') }, child: false });
  // A missing off-thread route must not be mistaken for a zero-cost session.
  const result = await runtime.readPanel(NOW, f.owner.sessionId);
  expect(result).toBeNull();
  await runtime.stop();
});

it('bounds pending worker reads and returns unavailable on timeout', async () => {
  const f = fixture(async () => emptyUsage), worker = new SilentWorker(), runtime = silentRuntime(f.root, worker);
  vi.useFakeTimers();
  try {
    runtime.start(false); await vi.advanceTimersByTimeAsync(0);
    const waiting = Array.from({ length: 8 }, () => runtime.readPanel(NOW, f.owner.sessionId));
    expect(await runtime.readPanel(NOW, f.owner.sessionId)).toBeNull();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await Promise.all(waiting)).toEqual(Array(8).fill(null));
  } finally { await runtime.stop(); vi.useRealTimers(); }
});

it.each(['error', 'stop'] as const)('settles pending panel reads as unavailable on worker %s', async kind => {
  const f = fixture(async () => emptyUsage), worker = new SilentWorker(), runtime = silentRuntime(f.root, worker);
  vi.useFakeTimers();
  try {
    runtime.start(false); await vi.advanceTimersByTimeAsync(0);
    const waiting = runtime.readPanel(NOW, f.owner.sessionId);
    if (kind === 'error') worker.emit('error', new Error('worker failed')); else await runtime.stop();
    expect(await waiting).toBeNull();
    expect(await runtime.readPanel(NOW, f.owner.sessionId)).toBeNull();
  } finally { await runtime.stop(); vi.useRealTimers(); }
});

it('the real bundled worker reads only the requested session and returns the dashboard month and pace inputs', async () => {
  const f = fixture(async () => emptyUsage);
  const ledger = openUsageLedger(join(f.root, 'usage.db'));
  const price = (aic: number) => ({ status: 'priced' as const, aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: 'fixture', tier: 'fixture', confidence: 'estimated' as const });
  ledger.apply(dashboardBatch([
    dashboardCall('own', { sessionId: f.owner.sessionId, ts: NOW - 86400000, price: price(7) }),
    dashboardCall('other', { sessionId: 'other-owner', ts: NOW - 86400000, price: price(9) }),
    dashboardCall('old', { sessionId: f.owner.sessionId, ts: Date.UTC(2026, 9, 30), price: price(900) }),
  ], { at: NOW })); ledger.close();
  openDbAt(join(f.root, 'registry.db'), 'global').close();
  let ready!: () => void;
  const online = new Promise<void>(resolve => { ready = resolve; });
  const runtime = new UsageRuntime({ bundleUrl: pathToFileURL(resolve('dist/extension.js')), roots: { ledgerFile: join(f.root, 'usage.db'), registryDb: join(f.root, 'registry.db'), sessionsDir: join(f.root, 'sessions'), authPath: join(f.root, 'auth.json'), leaseDir: join(f.root, 'leases') }, child: false,
    workerFactory: (entry, options) => { const worker = new Worker(entry, { ...options, env: { ...options.env as NodeJS.ProcessEnv, SPIDER_GLOBAL_ROOT: f.root, PI_CODING_AGENT_DIR: join(f.root, 'agent'), HOME: f.root } }); worker.once('online', ready); return worker; },
  });
  try {
    expect(await runtime.readPanel(NOW, f.owner.sessionId)).toBeNull();
    runtime.start(false, 'off'); await online;
    let callingThreadRead = false;
    vi.spyOn(readers, 'openDashboardReader').mockImplementation(() => { callingThreadRead = true; throw new Error('calling-thread-ledger-read'); });
    expect(await runtime.readPanel(NOW, f.owner.sessionId)).toMatchObject({ monthCost: { credits: 7, label: '7' }, pace: { used: 16, ratePerDay: 16 / 7, usedSource: 'pi', rateSource: 'pi' }, updatedAt: null });
    expect(await runtime.readPanel(NOW, 'other-owner')).toMatchObject({ monthCost: { credits: 9, label: '9' }, pace: { used: 16 } });
    expect(await runtime.readPanel(NOW, 'quiet-owner')).toMatchObject({ monthCost: { credits: 0, label: '0' } });
    expect(callingThreadRead).toBe(false);
  } finally { await runtime.stop(); }
}, 30000);

it('matches calibrated dashboard rows and pace with mapped children, copies, reports, and unknown pricing', async () => {
  const f = fixture(async () => emptyUsage), S = Date.UTC(2026, 10, 1), D = 86400000, at = S + 4.5 * D;
  const human = (id: string, ownerSessionId: string | null = null): SessionMeta => ({ id, ownerSessionId, name: id, nameSource: 'name', nameOrder: 1, project: 'synthetic', firstActivity: S, lastActivity: at });
  const run = (id: string): RunMeta => ({ id, sessionId: f.owner.sessionId, parentRunId: null, dbPath: 'synthetic/runs.db', project: null, repo: null, agent: null, role: 'worker', name: id, model: null, thinking: null, phase: null, startedAt: S, endedAt: at });
  const price = (aic: number) => ({ status: 'priced' as const, aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: 'fixture', tier: 'fixture', confidence: 'estimated' as const });
  const call = (id: string, ts: number, aic: number, extras: Parameters<typeof dashboardCall>[1] = {}) => dashboardCall(id, { sessionId: f.owner.sessionId, ts, price: price(aic), ...extras });
  const ledger = openUsageLedger(join(f.root, 'usage.db'));
  ledger.apply(dashboardBatch([
    call('before', S + 1, 7), call('fit-a', S + D + 1, 300), call('fit-b', S + 2 * D + 1, 300),
    call('child', S + 3 * D + 1, 11, { sessionId: 'mapped-child', actor: 'subagent', runId: 'child-run', responseId: 'child-response' }),
    call('copy', S + 3 * D + 1, 11, { sessionId: 'other-owner', copied: true, sourceFile: 'synthetic/copy.jsonl', responseId: 'child-response' }),
    call('replaced-report', S + 3 * D + 2, 900, { actor: 'subagent', runId: 'child-run', aggregate: true, sourceKind: 'report' }),
    call('cover', S + 3 * D + 3, 5, { actor: 'subagent', runId: 'cover-run', aggregate: true, sourceKind: 'report' }),
    call('covered', S + 3 * D + 4, 77, { actor: 'subagent', runId: 'covered-run' }),
    call('other', S + 2, 9, { sessionId: 'other-owner' }),
    call('unpriced', S + 3 * D + 5, 0, { sessionId: 'unpriced-owner', price: { status: 'unpriced', reason: 'unknown-model' } }),
  ], { at, sessions: [human(f.owner.sessionId), human('mapped-child', f.owner.sessionId), human('other-owner'), human('unpriced-owner')], runs: [run('child-run'), run('cover-run'), run('covered-run')], coverageEdges: [{ reportRunId: 'cover-run', includedRunId: 'covered-run', evidence: 'transcript' }] }));
  for (let i = 1; i <= 3; i++) ledger.insertCounter({ ts: S + i * D, creditsUsed: 1000 + (i - 1) * 150, accountLogin: 'synthetic-account', resetDate: '2026-12-01', raw: {} });
  ledger.close(); openDbAt(join(f.root, 'registry.db'), 'global').close();
  const reader = readers.openDashboardReader(join(f.root, 'usage.db'), { instanceId: 'reference', serverBuild: 'fixture', now: () => at, calibrationMode: () => 'auto' })!;
  const reference = reader.snapshot(ctx => {
    const cube = readUsageCube(ctx, { range: 'custom', from: S, to: at, tz: 'UTC', unit: 'credits', buckets: [] });
    const window = readUsageCube(ctx, { range: 'custom', from: Math.max(S, at - 7 * D), to: at, tz: 'UTC', unit: 'credits', buckets: [] });
    return { rows: sessionRows(cube), pace: computePace({ now: at, snapshots: readPaceHistoryFromDb(ctx.db, at), budget: 5000, correctedMonth: cube.total.credits, correctedWindow: window.total.credits }) };
  }); reader.close();
  let ready!: () => void; const online = new Promise<void>(resolve => { ready = resolve; });
  const runtime = new UsageRuntime({ bundleUrl: pathToFileURL(resolve('dist/extension.js')), child: false,
    roots: { ledgerFile: join(f.root, 'usage.db'), registryDb: join(f.root, 'registry.db'), sessionsDir: join(f.root, 'sessions'), authPath: join(f.root, 'auth.json'), leaseDir: join(f.root, 'leases') },
    workerFactory: (entry, options) => { const worker = new Worker(entry, { ...options, env: { ...options.env as NodeJS.ProcessEnv, SPIDER_GLOBAL_ROOT: f.root, PI_CODING_AGENT_DIR: join(f.root, 'agent'), HOME: f.root } }); worker.once('online', ready); return worker; },
  });
  try {
    runtime.start(false, 'auto'); await online;
    const result = await runtime.readPanel(at, f.owner.sessionId, 5000);
    expect(result?.monthCost).toEqual({ credits: 311.5, label: '311.5' });
    expect(result?.monthCost.credits).toBe(reference.rows.find(row => row.id === f.owner.sessionId)?.value.credits);
    expect(result?.pace).toEqual(reference.pace);
    expect(result?.pace).toMatchObject({ used: 1300, budget: 5000, remaining: 3700, projected: 5125 });
    expect((await runtime.readPanel(at, 'other-owner', 5000))?.monthCost).toEqual({ credits: 4.5, label: '4.5' });
    expect((await runtime.readPanel(at, 'unpriced-owner', 5000))?.monthCost).toEqual(unavailable);
    expect((await runtime.readPanel(at, 'quiet-owner', 5000))?.monthCost).toEqual({ credits: 0, label: '0' });
  } finally { await runtime.stop(); }
}, 30000);
