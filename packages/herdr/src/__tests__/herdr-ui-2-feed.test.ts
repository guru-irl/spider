// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { openDb, openDbAt, setGlobalDbPathForTests, bus, type Db } from '@spider/db-core';
import { scratchDbPath, cleanupScratch } from '@spider/db-core/testutil';
import { SessionScheduler } from '../../../host/src/loop/index.js';
import { UsageRuntime } from '../../../host/src/usage/runtime.js';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createHerdrDataSource, type HostDataSourceOptions } from '../../../host/src/herdr/data-source.js';
import { openSessionRunDb } from '../../../host/src/session-run-db.js';
import { openUsageLedger } from '../../../host/src/usage/ledger.js';
import { dashboardBatch, dashboardCall } from '../../../host/src/usage/__tests__/fixtures/dashboard-ledger.js';
import { formatValue, formatLocalTime } from '../../../host/src/usage/web/format.js';
import { registerProject } from '@spider/db-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseFeed } from '../../assets/shared/feed.js';
import type { Owner } from '../contracts.js';

const root = resolve('.spider/scratch/h/fx4-ui-2-feed');
const global = join(root, 'global');
const owner = (id: string): Owner => ({ sessionId: id as Owner['sessionId'], generation: 'g' as Owner['generation'],
  terminal: { coreId: 'core' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: `t-${id}` as Owner['terminal']['address'], socket: join(root, 's'), sessionNamespace: 'fixture' },
  cwd: root, sessionFile: null, name: id });
// Mid-November: the billing month (no counter reset date) starts on the 1st, UTC.
const now = Date.UTC(2026, 10, 15, 12);
const NOV = Date.UTC(2026, 10, 1);
let db: Db; let globalDb: Db; let scheduler: SessionScheduler; let options: HostDataSourceOptions;
let runtime: UsageRuntime | undefined;

async function warmMonthCosts(source: ReturnType<typeof createHerdrDataSource>, owners: Owner[]): Promise<void> {
  let ready!: () => void;
  const online = new Promise<void>(resolve => { ready = resolve; });
  runtime = new UsageRuntime({ bundleUrl: pathToFileURL(resolve('dist/extension.js')), child: false,
    roots: { ledgerFile: join(global, 'usage.db'), registryDb: join(root, 'registry.db'), sessionsDir: join(root, 'sessions'), authPath: join(root, 'auth.json'), leaseDir: join(root, 'leases') },
    workerFactory: (entry, config) => { const worker = new Worker(entry, { ...config, env: { ...config.env as NodeJS.ProcessEnv, SPIDER_GLOBAL_ROOT: global, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent') } }); worker.once('online', ready); return worker; },
  });
  runtime.start(false, 'auto'); await vi.advanceTimersByTimeAsync(0); await online;
  const original = options.readUsage;
  const reads: Promise<unknown>[] = [];
  options.readUsage = (at, o) => {
    const reading = (async () => ({ ...await original(at, o), monthCost: (await runtime!.readPanel(at, o.sessionId))?.monthCost ?? { credits: null, label: 'unavailable' } }))();
    reads.push(reading); return reading;
  };
  for (const o of owners) await source.snapshot(o);
  await Promise.all(reads); await Promise.resolve();
}
const price = (aic: number) => ({ status: 'priced' as const, aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: 'fixture', tier: 'fixture', confidence: 'estimated' as const });

beforeEach(async () => {
  vi.stubEnv('PI_SUBAGENT_CHILD', ''); vi.stubEnv('SPIDER_GLOBAL_ROOT', global); vi.useFakeTimers(); vi.setSystemTime(now);
  await mkdir(global, { recursive: true });
  const dbPath = join(root, basename(scratchDbPath('runs'))); const globalPath = join(root, basename(scratchDbPath('global')));
  db = openDbAt(dbPath, 'worktree'); globalDb = openDbAt(globalPath, 'global'); setGlobalDbPathForTests(globalPath);
  registerProject({ projectKey: 'fx4-ui-2', realPath: root, dbPath });
  scheduler = new SessionScheduler({ appendEntry() {}, sendUserMessage() {} } as unknown as ExtensionAPI, { resolveTimeZone: tz => tz ?? 'UTC', parseAt: Date.parse, formatInZone: at => new Date(at).toISOString(), parseCron: () => ({}), nextCronAt: () => now });
  options = {
    resolveRunDb: o => openSessionRunDb(o.cwd, o.sessionId, { projectKey: 'fx4-ui-2', realPath: root, dbPath }),
    openApprovalDbs: () => ({ global: openDb(globalPath), repo: null }),
    runEvents: bus, scheduler,
    readUsage: async () => ({ snapshots: [], budget: 5000, correctedMonth: 1284.4, correctedWindow: null, updatedAt: now - 4 * 60000 }),
    // The production mount passes the whole Herdr config; globalRoot locates usage.db.
    readConfig: () => ({ limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, globalRoot: global }), clock: () => Date.now(),
  };
});
afterEach(async () => { await runtime?.stop(); runtime = undefined; scheduler?.shutdown(); db?.close(); globalDb?.close(); setGlobalDbPathForTests(null); vi.useRealTimers(); vi.unstubAllEnvs(); cleanupScratch(); await rm(root, { recursive: true, force: true }); });

it('each session feed carries its month-to-date credits, formatted as the dashboard formats them', async () => {
  const ledger = openUsageLedger(join(global, 'usage.db'));
  try {
    ledger.apply(dashboardBatch([
      dashboardCall('a1', { sessionId: 'session-a', ts: NOV + 86400000, price: price(1000) }),
      dashboardCall('a2', { sessionId: 'session-a', ts: NOV + 2 * 86400000, price: price(284.36) }),
      dashboardCall('b1', { sessionId: 'session-b', ts: NOV + 86400000, price: price(41.25) }),
      // Last month's call never counts toward this month.
      dashboardCall('old', { sessionId: 'session-b', ts: NOV - 86400000, price: price(900) }),
    ], { at: now }));
  } finally { ledger.close(); }
  const source = createHerdrDataSource(options);
  try {
    await warmMonthCosts(source, [owner('session-a'), owner('session-b'), owner('quiet')]);
    const [a, b, c] = [await source.snapshot(owner('session-a')), await source.snapshot(owner('session-b')), await source.snapshot(owner('quiet'))];
    expect(a.monthCost?.label).toBe('1.3k');
    expect(a.monthCost?.credits).toBeCloseTo(1284.36);
    expect(b.monthCost).toEqual({ credits: 41.25, label: '41.3' });
    // Same as a dashboard row: Intl compact for 1,000+, one decimal below.
    expect(a.monthCost?.label).toBe(formatValue({ credits: a.monthCost!.credits, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }, calls: 0, unpricedCalls: 0 } as never, 'credits'));
    // A session with no calls this month costs 0, not unavailable.
    expect(c.monthCost).toEqual({ credits: 0, label: '0' });
    // The published file passes the panel's own decoder with the new fields intact.
    expect(parseFeed(JSON.stringify(a))?.monthCost).toEqual(a.monthCost);
    expect(a.pace.labels).toEqual({ month: 'NOV 2026', usedCompact: '1.3k', used: '1,284', projected: a.pace.projected === null ? 'unavailable' : expect.any(String), budget: '5,000', remaining: expect.any(String),
      updatedAt: formatLocalTime(now - 4 * 60000, Intl.DateTimeFormat().resolvedOptions().timeZone) });
    expect(parseFeed(JSON.stringify(a))?.pace.labels).toEqual(a.pace.labels);
  } finally { source.dispose(); }
});

it('says unavailable, never zero, when the usage ledger cannot be read', async () => {
  const source = createHerdrDataSource(options);
  try {
    expect((await source.snapshot(owner('session-a'))).monthCost).toEqual({ credits: null, label: 'unavailable' });
  } finally { source.dispose(); }
});

it('older feeds without the new fields still decode', () => {
  const feed = { version: 1, sessionId: 's', generation: 'g', revision: 1, updatedAt: 1, owner: { ...owner('s'), sessionId: 's', generation: 'g' }, placement: null, lifecycle: 'live',
    status: { native: null, effective: null, message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'x' }, approvals: [], notifications: [], ipc: null, errors: [] };
  expect(parseFeed(JSON.stringify(feed))).not.toBeNull();
  expect(parseFeed(JSON.stringify({ ...feed, monthCost: { credits: 'lots', label: '1k' } }))).toBeNull();
});
