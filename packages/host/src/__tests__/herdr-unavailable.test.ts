// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { mountedFixture } from './herdr-wiring-fixture.js';
import type { MachineCache } from '../../../herdr/src/ssh/cache.js';
import { terminal } from '../../../herdr/src/__tests__/testutil.js';
import type { JobId, RunId, TabId } from '../../../herdr/src/contracts.js';
import { openDbAt } from '@spider/db-core';
import { readFile } from 'node:fs/promises';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

async function fixture(killAction?: () => Promise<unknown>) {
  let cache!: MachineCache;
  const cacheModule = await import('../../../herdr/src/ssh/cache.js');
  const reports: ((error: unknown) => void)[] = [];
  const create = cacheModule.createMachineCache;
  vi.spyOn(cacheModule, 'createMachineCache').mockImplementation(options => {
    if (options.reportFailure) reports.push(options.reportFailure);
    return cache = create(options);
  });
  const f = await mountedFixture('fake', 'rpc', true, false, true, false, true, false, false, true, killAction); cleanups.push(async () => { await f.h.scenario({}); await f.close(); });
  vi.useFakeTimers({ toFake: ['Date'] });
  let current = f.mount;
  const remount = async (session = f.owner!.sessionId, fresh = false) => {
    await f.emit('session_shutdown', { reason: 'reload' }); await current.dispose();
    Reflect.set(f.ctx.sessionManager, 'getSessionId', () => session);
    if (fresh) {
      vi.resetModules();
      const module = await import('../../../herdr/src/ssh/cache.js'), create = module.createMachineCache;
      vi.spyOn(module, 'createMachineCache').mockImplementation(options => cache = create(options));
    }
    const { mountHerdr: mount } = await import('../herdr/mount.js');
    const next = mount(f.pi as never, { packageRoot: f.h.root, readConfig: async () => f.config as never,
      actionContext: () => ({}), reportError: error => f.errors.push(error),
      views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } },
      dataSource: { resolveRunDb: () => ({ db: openDbAt(f.db.raw.name, 'worktree'), dbPath: f.db.raw.name }),
        openApprovalDbs: () => ({ global: openDbAt(f.globalDb.raw.name, 'global'), repo: null }),
        readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }),
        scheduler: { listTriggers: () => [], subscribe: () => () => {} } } });
    cleanups.push(async () => { await f.h.scenario({}); await f.emit('session_shutdown', { reason: 'reload' }); await next.dispose(); });
    current = next;
    await f.emit('session_start', { reason: 'reload' });
    return cache;
  };
  return { ...f, cache, remount, reports };
}
const failure = { error: { kind: 'unavailable', message: 'A synthetic connection is unavailable' } };

test('one local outage warns once until the failed machine-list operation succeeds', async () => {
  const f = await fixture();
  await f.h.scenario({ steps: [{ argvPrefix: ['machine', 'ls'], stderr: failure, exitCode: 5 }] });
  for (let i = 0; i < 5; i++) {
    vi.setSystemTime(Date.now() + 61_000);
    await f.cache.refresh();
  }
  expect(f.notices).toEqual([expect.stringContaining("Herdr couldn't respond to spider")]);
  expect(f.errors.filter(error => (error as { code?: string }).code === 'unavailable')).toHaveLength(5);
  await f.h.scenario({}); await f.cache.refresh();
  await f.h.scenario({ steps: [{ argvPrefix: ['machine', 'ls'], stderr: failure, exitCode: 5 }] });
  await f.cache.refresh();
  expect(f.notices).toHaveLength(2);
});

test('remote IPC failures name the destination and do not conceal a separate local outage', async () => {
  const f = await fixture(), id = 'console:remote.invalid/t1' as JobId;
  await f.h.scenario({ steps: [{ argvPrefix: ['get', 'remote.invalid/t1'], stderr: failure, exitCode: 5 }] });
  for (let i = 0; i < 5; i++) {
    vi.setSystemTime(Date.now() + 61_000);
    expect(await f.ipc!.openJob(id)).toMatchObject({ ok: false, code: 'unavailable' });
    await f.cache.refresh();
  }
  expect(f.notices).toEqual([expect.stringContaining('remote.invalid')]);
  expect(f.notices[0]).toContain('keep trying');
  expect(f.notices[0]).not.toMatch(/doctor|herdr-setup/);
  await f.h.scenario({ steps: [
    { argvPrefix: ['get', 'remote.invalid/t1'], stderr: failure, exitCode: 5 },
    { argvPrefix: ['machine', 'ls'], stderr: failure, exitCode: 5 },
  ] });
  await f.cache.refresh();
  expect(f.notices).toHaveLength(2);
  expect(f.notices[1]).toContain("Herdr couldn't respond to spider");
  await f.h.scenario({ steps: [{ argvPrefix: ['get', 'remote.invalid/t1'], reply: terminal('remote.invalid/t1') }] });
  expect(await f.ipc!.openJob(id)).toMatchObject({ ok: false, code: 'not-found' });
  await f.h.scenario({ steps: [{ argvPrefix: ['get', 'remote.invalid/t1'], stderr: failure, exitCode: 5 }] });
  await f.ipc!.openJob(id);
  expect(f.notices).toHaveLength(3);
});


test('app operations rearm their own outage without a successful core call hiding it', async () => {
  const f = await fixture();
  const move = () => f.ipc!.request({ op: 'moveSession', generation: f.owner!.generation, destination: { kind: 'tab', tab: 'tb1' as TabId } });
  const offline = { appSteps: [{ argvPrefix: ['ls'], stderr: failure, exitCode: 5 }] };
  await f.h.scenario(offline);
  await move(); vi.setSystemTime(Date.now() + 61_000); await move();
  expect(f.notices).toHaveLength(1);
  await f.h.scenario({});
  expect(await move()).toMatchObject({ ok: true });
  await f.h.scenario(offline); await move();
  expect(f.notices).toHaveLength(2);
});

test('IPC action outages rearm after that action succeeds rather than a ping', async () => {
  let failed = true;
  const f = await fixture(async () => ({ isError: failed }));
  const run = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker' });
  const kill = () => f.ipc!.request({ op: 'killRun', generation: f.owner!.generation, runId: run.id as RunId });
  await kill();
  await f.ipc!.ping(); vi.setSystemTime(Date.now() + 61_000); await kill();
  expect(f.notices).toHaveLength(1);
  failed = false;
  expect(await kill()).toMatchObject({ ok: true });
  failed = true; await kill();
  expect(f.notices).toHaveLength(2);
});

test('a reloaded copy shares an outage but another session gets its own warning', async () => {
  const f = await fixture();
  const offline = { steps: [{ argvPrefix: ['machine', 'ls'], stderr: failure, exitCode: 5 }] };
  await f.h.scenario(offline); await f.cache.refresh();
  // Activation probes can succeed while the machine list remains unavailable.
  const staleReport = f.reports[0];
  const reloaded = await f.remount(f.owner!.sessionId, true);
  staleReport(new Error('A late failure from a retired extension'));
  vi.setSystemTime(Date.now() + 61_000); await reloaded.refresh();
  expect(f.notices).toHaveLength(1);
  const other = await f.remount('other-session' as NonNullable<typeof f.owner>['sessionId']);
  await other.refresh();
  expect(f.notices).toHaveLength(2);
});


test('feed outages stay quiet until a full feed refresh succeeds', async () => {
  const f = await fixture(), limits = f.config.limits;
  const { bus } = await import('@spider/db-core');
  const { HerdrError } = await import('../../../herdr/src/client/parse.js');
  let blocked = true;
  Object.defineProperty(f.config, 'limits', { configurable: true, get() {
    if (blocked) throw new HerdrError('unavailable', 'Synthetic feed data is unavailable');
    return limits;
  } });
  cleanups.push(async () => { blocked = false; });
  const refresh = () => bus.emit({ sessionId: f.owner!.sessionId, ts: Date.now(), type: 'status' });
  refresh(); await vi.waitFor(() => expect(f.errors).toHaveLength(1));
  vi.setSystemTime(Date.now() + 61_000);
  refresh(); await vi.waitFor(() => expect(f.errors).toHaveLength(2));
  expect(f.notices).toHaveLength(1);
  const revision = JSON.parse(await readFile(f.feedPath, 'utf8')).revision;
  f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker' });
  blocked = false; refresh();
  await vi.waitFor(async () => expect(JSON.parse(await readFile(f.feedPath, 'utf8')).revision).toBeGreaterThan(revision));
  // Other readers of the blocked config, such as reactions to the new run, may report too, so wait on warnings.
  blocked = true; refresh(); await vi.waitFor(() => expect(f.notices).toHaveLength(2));
  const seen = f.errors.length;
  refresh(); await vi.waitFor(() => expect(f.errors.length).toBeGreaterThan(seen));
  expect(f.notices).toHaveLength(2);
});

test('a successful feed write ends the outage even when a queued write then fails', async () => {
  const f = await fixture(), limits = f.config.limits;
  const { bus } = await import('@spider/db-core');
  const { HerdrError } = await import('../../../herdr/src/client/parse.js');
  const refresh = () => bus.emit({ sessionId: f.owner!.sessionId, ts: Date.now(), type: 'status' });
  let blocked = true, failAfterNextRead = false;
  Object.defineProperty(f.config, 'limits', { configurable: true, get() {
    if (blocked) throw new HerdrError('unavailable', 'Synthetic feed data is unavailable');
    // Each feed snapshot reads the limits once. The refresh lands after this read finishes, so this write
    // succeeds and the one it queues reads the limits again and fails.
    if (failAfterNextRead) { failAfterNextRead = false; blocked = true; queueMicrotask(refresh); }
    return limits;
  } });
  cleanups.push(async () => { blocked = false; });
  refresh(); await vi.waitFor(() => expect(f.errors).toHaveLength(1));
  expect(f.notices).toHaveLength(1);
  const seen = f.errors.length;
  blocked = false; failAfterNextRead = true; refresh();
  await vi.waitFor(() => expect(f.errors.length).toBeGreaterThan(seen));
  await vi.waitFor(() => expect(f.notices).toHaveLength(2));
});
