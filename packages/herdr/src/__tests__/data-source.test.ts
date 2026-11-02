// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { openDb, openDbAt, setGlobalDbPathForTests, bindSession, bus, appendRunEvent, type Db } from '@spider/db-core';
import { scratchDbPath, cleanupScratch } from '@spider/db-core/testutil';
import { emitEscalation, emitStatus } from '../../../subagents/src/run-events.js';
import { registerChild, unregisterChild } from '../../../subagents/src/coordinators.js';
import { RunStore } from '../../../subagents/src/run-store.js';
import { addTodo } from '../../../todo/src/store.js';
import { stageWrite } from '../../../memory/src/staging.js';
import { SessionScheduler } from '../../../host/src/loop/index.js';
import { createHerdrDataSource, budgetNotifications, type HostDataSourceOptions } from '../../../host/src/herdr/data-source.js';
import { openSessionRunDb } from '../../../host/src/session-run-db.js';
import { registerProject } from '@spider/db-core';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { atomicPrivateWrite } from '../feed/publisher.js';
import type { Owner, PaceSummary, SessionFeed } from '../contracts.js';
const root = resolve('.spider/scratch/h/ds');
const owner: Owner = { sessionId: 'session-a' as Owner['sessionId'], generation: 'generation-a' as Owner['generation'], terminal: { coreId: 'core-a' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: 't1' as Owner['terminal']['address'], socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null };
let db: Db; let globalDb: Db; let repoDb: Db; let scheduler: SessionScheduler; let options: HostDataSourceOptions; let ownedRunId: string; let globalApprovalId: string;
const now = Date.UTC(2026, 0, 15);
const nextAt = now + 60_000;
const ctx = { mode: 'tui', isIdle: () => false, sessionManager: { getSessionId: () => owner.sessionId, getEntries: () => [] }, ui: { notify() {} } } as unknown as ExtensionContext;
beforeEach(async () => {
  vi.stubEnv('PI_SUBAGENT_CHILD', ''); vi.stubEnv('SPIDER_GLOBAL_ROOT', join(root, 'global')); vi.useFakeTimers(); vi.setSystemTime(now);
  await mkdir(root, { recursive: true });
  const dbPath = join(root, basename(scratchDbPath('runs'))); const globalPath = join(root, basename(scratchDbPath('global'))); const repoPath = join(root, basename(scratchDbPath('repo')));
  db = openDbAt(dbPath, 'worktree'); globalDb = openDbAt(globalPath, 'global'); repoDb = openDbAt(repoPath, 'repo'); setGlobalDbPathForTests(globalPath);
  registerProject({ projectKey: 'bound-fixture', realPath: root, dbPath });
  const store = new RunStore(db); ownedRunId = store.create({ sessionId: owner.sessionId, agent: 'worker', name: 'owned' }).id; store.start(ownedRunId); store.setLaunch(ownedRunId, { childMode: 'rpc' });
  const foreign = store.create({ sessionId: 'foreign-session', agent: 'worker', name: 'foreign' }).id; store.start(foreign);
  addTodo(db, owner.sessionId, 'owned todo'); addTodo(db, 'foreign-session', 'foreign todo');
  globalApprovalId = stageWrite(globalDb, 'global', { category: 'convention', content: 'Use generic fixtures', source: 'user' }, { autoStage: true }).uuid!;
  stageWrite(repoDb, 'repo', { category: 'convention', content: 'Repository pending note', source: 'user' }, { autoStage: true });
  const pi = { appendEntry() {}, sendUserMessage() {} } as unknown as ExtensionAPI;
  scheduler = new SessionScheduler(pi, { resolveTimeZone: tz => tz ?? 'UTC', parseAt: value => Date.parse(value), formatInZone: at => new Date(at).toISOString(), parseCron: () => ({}), nextCronAt: () => nextAt });
  await scheduler.loop({ name: 'morning', prompt: 'check external result', cron: '0 8 * * *', tz: 'UTC' }, ctx);
  options = {
    resolveRunDb: o => openSessionRunDb(o.cwd, o.sessionId, { projectKey: 'bound-fixture', realPath: root, dbPath }),
    openApprovalDbs: () => ({ global: openDb(globalPath), repo: { db: openDb(repoPath), repoKey: 'fixture-repository' } }),
    runEvents: bus, scheduler, readJobJournal: async () => [],
    readUsage: async () => ({ snapshots: [{ ts: now, creditsUsed: 80, resetDate: '2026-02-01', accountLogin: 'fixture', raw: {} }], budget: 100, correctedMonth: null, correctedWindow: null, updatedAt: now }),
    readConfig: () => ({ limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 } }), clock: () => Date.now(),
  };
});
afterEach(async () => { scheduler?.shutdown(); db?.close(); globalDb?.close(); repoDb?.close(); setGlobalDbPathForTests(null); vi.useRealTimers(); vi.unstubAllEnvs(); cleanupScratch(); await rm(root, { recursive: true, force: true }); });
it('closes the last snapshot with its next revision and no further live reads', async () => {
  const source = createHerdrDataSource(options);
  try {
    const live = await source.snapshot(owner);
    options.resolveRunDb = () => { throw new Error('No reads during closure'); };
    options.readOwnerFacts = async () => { throw new Error('No layout calls during closure'); };
    options.readJobJournal = async () => { throw new Error('No journal reads during closure'); };
    await vi.advanceTimersByTimeAsync(2000);
    const closed = await source.snapshot(owner, 'closed');
    expect(closed).toMatchObject({ lifecycle: 'closed', ipc: null, sessionId: owner.sessionId, generation: owner.generation, revision: live.revision + 1, updatedAt: now + 2000 });
    expect(closed.runs).toEqual(live.runs); expect(closed.errors).toEqual(live.errors);
  } finally { source.dispose(); }
});

it('does not attribute global approvals or account budget to a session', async () => {
  const source = createHerdrDataSource(options);
  try {
    const feed = await source.snapshot(owner);
    expect(feed.approvals.find(a => a.uuid === globalApprovalId)).toMatchObject({ scope: 'global', ownerSessionId: null });
    expect(feed.pace).toMatchObject({ scope: 'shared', used: 80, budget: 100, updatedAt: now });
    expect(feed.runs.rows.map(r => r.id)).toEqual([ownedRunId]); expect(feed.todos.rows.map(t => t.text)).toEqual(['owned todo']);
    expect(feed.triggers[0]).toMatchObject({ name: 'morning', nextAt, tz: 'UTC' });
  } finally { source.dispose(); }
});
it('ignores foreign run events but not owned runs or shared memory changes', async () => {
  const source = createHerdrDataSource(options); const changed = vi.fn(); source.subscribe(changed);
  try {
    await source.snapshot(owner);
    const foreign = new RunStore(db).listActive('foreign-session')[0];
    emitStatus(db, { runId: foreign.id, sessionId: 'foreign-session', status: 'running' });
    expect(changed).not.toHaveBeenCalled();
    emitStatus(db, { runId: ownedRunId, sessionId: owner.sessionId, status: 'running' });
    expect(changed).toHaveBeenCalledTimes(1);
    appendRunEvent(db, { sessionId: 'foreign-session', ts: now, type: 'memory-staged', tool: 'memory' });
    expect(changed).toHaveBeenCalledTimes(2);
  } finally { source.dispose(); }
});
it('reconciles runs and todos every two seconds while usage reads are at most once per thirty seconds', async () => {
  const readUsage = vi.fn(options.readUsage); options.readUsage = readUsage;
  const source = createHerdrDataSource(options); const changed = vi.fn(); const remove = source.subscribe(changed);
  try {
    const first = await source.snapshot(owner); await source.snapshot(owner); expect(readUsage).toHaveBeenCalledTimes(1);
    addTodo(db, owner.sessionId, 'reconciled todo');
    await vi.advanceTimersByTimeAsync(2000);
    expect(changed).toHaveBeenCalled(); const second = await source.snapshot(owner);
    expect(second.todos.rows.map(todo => todo.text)).toEqual(['owned todo', 'reconciled todo']);
    expect(second.revision).toBeGreaterThan(first.revision); expect(readUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(28000); await source.snapshot(owner); expect(readUsage).toHaveBeenCalledTimes(2);
    remove(); source.dispose(); const calls = changed.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000); expect(changed).toHaveBeenCalledTimes(calls);
  } finally { source.dispose(); }
});
it('retains finished children separately and derives steering only from a live owned RPC handle', async () => {
  const source = createHerdrDataSource(options);
  const row = new RunStore(db);
  row.setLaunch(ownedRunId, { childMode: 'rpc' });
  registerChild(owner.sessionId, ownedRunId, { wait: async () => ({ exitCode: 0 }), kill() {}, detach() {}, steer: async () => ({ accepted: true, delivered: true }) });
  try {
    expect((await source.snapshot(owner)).runs.rows[0].canSteer).toBe(true);
    unregisterChild(owner.sessionId, ownedRunId);
    expect((await source.snapshot(owner)).runs.rows[0].canSteer).toBe(false);
    row.finish(ownedRunId, { status: 'done', result: 'final result' }); emitStatus(db, { runId: ownedRunId, sessionId: owner.sessionId, status: 'done' });
    const feed = await source.snapshot(owner);
    expect(feed.runs.rows).toMatchObject([{ id: ownedRunId, status: 'done', canSteer: false, result: 'final result' }]);
  } finally { unregisterChild(owner.sessionId, ownedRunId); source.dispose(); }
});
it('keeps missing usage and null budgets unavailable rather than guessing zero', async () => {
  options.readUsage = async () => ({ snapshots: [], correctedMonth: null, correctedWindow: null, budget: undefined, updatedAt: null });
  const source = createHerdrDataSource(options);
  try { expect((await source.snapshot(owner)).pace).toMatchObject({ scope: 'shared', used: null, budget: null, projected: null, remaining: null, updatedAt: null, unavailableReason: 'usage-counter-unavailable' }); }
  finally { source.dispose(); }
});
it('produces owned run and job notices and shared period thresholds', async () => {
  const store = new RunStore(db);
  emitEscalation(db, { runId: ownedRunId, sessionId: owner.sessionId, severity: 'warning', summary: 'Need a smaller case' });
  emitEscalation(db, { runId: ownedRunId, sessionId: owner.sessionId, severity: 'warning', summary: 'Need a smaller case' });
  store.finish(ownedRunId, { status: 'done', result: 'finished output' });
  emitStatus(db, { runId: ownedRunId, sessionId: owner.sessionId, status: 'done' });
  emitStatus(db, { runId: ownedRunId, sessionId: owner.sessionId, status: 'done' });
  const journal = join(root, 'jobs.json');
  const job = { version: 1, id: 'job-a', owner, machine: 'fixture-machine.invalid', kind: 'exec', phase: { kind: 'finished', address: 'remote.invalid/t1', result: { exitCode: 23, reason: 'exited', signal: null, finishedAt: now } }, viewer: null, remoteDirectory: '/fixture/job', localDirectory: root, detached: true, noticeMode: 'async', notice: 'pending' };
  await atomicPrivateWrite(journal, JSON.stringify([job, { ...job, id: 'foreign-job', owner: { ...owner, sessionId: 'foreign-session' } }]));
  options.readJobJournal = async () => JSON.parse(await readFile(journal, 'utf8'));
  const source = createHerdrDataSource(options);
  try {
    const feed = await source.snapshot(owner);
    expect(feed.notifications.filter(n => n.kind === 'escalation')).toMatchObject([{ sessionId: owner.sessionId, ownerAddress: owner.terminal.address }]);
    expect(feed.notifications.find(n => n.kind === 'escalation')?.id).toContain(ownedRunId);
    expect(feed.notifications.find(n => n.kind === 'subagent-result')?.id).toContain(ownedRunId);
    expect(feed.notifications.find(n => n.kind === 'job-result')?.id).toContain('job-a');
    expect(feed.notifications.some(n => n.id.includes('foreign-job'))).toBe(false);
    const budget = feed.notifications.find(n => n.kind === 'budget');
    expect(budget).toMatchObject({ id: `budget:${Date.UTC(2026, 0, 1)}:80`, kind: 'budget', scope: 'shared', sessionId: null, ownerAddress: null, action: { kind: 'open-usage' } });
    expect((await source.snapshot({ ...owner, sessionId: 'second-session' as Owner['sessionId'] })).notifications.find(n => n.kind === 'budget')?.id).toBe(budget?.id);
    expect((await source.snapshot(owner)).notifications.map(n => n.id)).toEqual(feed.notifications.map(n => n.id));
  } finally { source.dispose(); }
});
it('budget IDs are period-plus-threshold, with null budgets and projections producing no warning', () => {
  const pace: PaceSummary = { scope: 'shared', used: 80, budget: 100, projected: null, remaining: 20, periodStart: 1000, periodEnd: 2000, updatedAt: 1500, unavailableReason: null };
  expect(budgetNotifications(pace)).toMatchObject([{ id: 'budget:1000:80', scope: 'shared', sessionId: null, ownerAddress: null, action: { kind: 'open-usage' } }]);
  expect(budgetNotifications({ ...pace, used: 100, projected: 101 }).map(n => n.id)).toEqual(['budget:1000:80', 'budget:1000:100', 'budget:1000:projected']);
  expect(budgetNotifications({ ...pace, budget: null })).toEqual([]);
  expect(budgetNotifications({ ...pace, used: null, projected: null })).toEqual([]);
  expect(budgetNotifications({ ...pace, periodStart: 3000 }).map(n => n.id)).toEqual(['budget:3000:80']);
});
it('keeps the live feed available when optional journal and layout sources fail', async () => {
  options.readJobJournal = async () => { throw new Error('journal unavailable'); };
  options.readOwnerFacts = async () => { throw new Error('layout unavailable'); };
  const source = createHerdrDataSource(options);
  try { const feed = await source.snapshot(owner); expect(feed.runs.rows[0].id).toBe(ownedRunId); expect(feed.placement).toBeNull(); expect(feed.errors.map(error => error.source)).toEqual(['placement', 'jobs']); }
  finally { source.dispose(); }
});
it('only publishes committed owned events and refreshes observed placement without changing terminal identity', async () => {
  let placement: SessionFeed['placement'] = { spaceId: 'space-a' as NonNullable<SessionFeed['placement']>['spaceId'], spaceName: 'Observed A', spaceOrder: 2, tabId: null };
  options.readOwnerFacts = async () => ({ placement, status: { native: 'done', effective: 'working', message: 'pending children' }, ipc: null });
  const source = createHerdrDataSource(options); const changed = vi.fn(); source.subscribe(changed);
  try {
    const first = await source.snapshot(owner);
    expect(() => db.transaction(() => { emitEscalation(db, { runId: ownedRunId, sessionId: owner.sessionId, severity: 'warning', summary: 'rolled back' }); throw new Error('rollback'); })()).toThrow('rollback');
    expect(changed).not.toHaveBeenCalled();
    db.transaction(() => { emitEscalation(db, { runId: ownedRunId, sessionId: owner.sessionId, severity: 'warning', summary: 'committed' }); })(); expect(changed).toHaveBeenCalledTimes(1);
    placement = { spaceId: 'space-b' as NonNullable<SessionFeed['placement']>['spaceId'], spaceName: null, spaceOrder: null, tabId: null };
    const second = await source.snapshot(owner);
    expect(second.owner.terminal).toEqual(first.owner.terminal); expect(second.placement).toEqual(placement);
    expect(second.notifications.filter(n => n.kind === 'escalation').map(n => n.body)).toEqual(['committed']);
  } finally { source.dispose(); }
});
it('keeps a truthful total when retained completion rows exceed the configured display limit', async () => {
  const store = new RunStore(db);
  for (let i = 0; i < 4; i++) { const id = store.create({ sessionId: owner.sessionId, agent: 'worker' }).id; store.finish(id, { status: 'done' }); }
  options.readConfig = () => ({ limits: { auxiliaryPanes: 2, completedRows: 2, completedHours: 24 } });
  const source = createHerdrDataSource(options);
  try { const feed = await source.snapshot(owner); expect(feed.runs).toMatchObject({ total: 5, truncated: true }); expect(feed.runs.rows).toHaveLength(3); expect(feed.runs.rows.filter(row => row.status === 'running')).toHaveLength(1); }
  finally { source.dispose(); }
});
it('reads the exact session-bound run database rather than the caller cwd database', async () => {
  const bound = join(root, 'bound'); await mkdir(bound); execFileSync('git', ['init', '-q', bound], { env: { ...process.env, TMPDIR: root } });
  bindSession(globalDb, owner.sessionId, bound);
  const resolved = openSessionRunDb(owner.cwd, owner.sessionId);
  expect(resolved.dbPath).toBe(join(bound, '.spider', 'project.db'));
  const id = new RunStore(resolved.db).create({ sessionId: owner.sessionId, agent: 'worker', name: 'bound only' }).id;
  new RunStore(resolved.db).start(id); resolved.db.close();
  options.resolveRunDb = o => openSessionRunDb(o.cwd, o.sessionId);
  const source = createHerdrDataSource(options);
  try { const feed = await source.snapshot(owner); expect(feed.runs.rows.map(row => row.name)).toEqual(['bound only']); expect(feed.runs.rows.some(row => row.id === ownedRunId)).toBe(false); }
  finally { source.dispose(); }
});
it('lists copied scheduler state and notifies replacements without changing delivery', async () => {
  const listener = vi.fn(); const remove = scheduler.subscribe(listener);
  expect(scheduler.listTriggers()).toMatchObject([{ name: 'morning', nextAt, tz: 'UTC' }]);
  const listing = scheduler.listTriggers(); listing[0].prompt = 'do not mutate the scheduler';
  expect(scheduler.listTriggers()[0].prompt).toBe('check external result');
  await scheduler.schedule({ name: 'morning', prompt: 'replacement', delaySeconds: 120 }, ctx);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(scheduler.listTriggers()).toMatchObject([{ name: 'morning', kind: 'once', nextAt: now + 120_000 }]);
  remove(); scheduler.shutdown(); expect(listener).toHaveBeenCalledTimes(1);
});
