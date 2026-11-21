#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadavg } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

// Only generated data is opened. No input database or session directory is accepted.
// This measures worker-side query work, not runtime sampling: direct worker
// messages bypass the sampler. Runtime coalescing has separate deterministic
// writer and follower tests rather than a CPU measurement in this harness.
async function worker() {
  const { bootUsageWorker } = await import(workerData.module);
  let queries = 0;
  const counts = new Map(), prepare = Database.prototype.prepare;
  if (workerData.sqlInstrumentation) Database.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    for (const method of ['all', 'get', 'iterate', 'run']) {
      const execute = statement[method].bind(statement);
      statement[method] = (...args) => {
        queries++;
        let count = counts.get(sql);
        if (!count) { count = { count: 0, cpuUs: 0 }; counts.set(sql, count); }
        count.count++;
        const timed = action => {
          const before = process.threadCpuUsage();
          try { return action(); }
          finally { const spent = process.threadCpuUsage(before); count.cpuUs += spent.user + spent.system; }
        };
        const value = timed(() => execute(...args));
        if (method === 'iterate') {
          const step = value.next.bind(value);
          value.next = (...args) => timed(() => step(...args));
        }
        return value;
      };
    }
    return statement;
  };
  const start = process.threadCpuUsage();
  parentPort.on('message', message => {
    if (message.type !== 'metrics') return;
    parentPort.postMessage({ type: 'metrics', queries: workerData.sqlInstrumentation ? queries : null, cpu: process.threadCpuUsage(start),
      statements: [...counts].map(([sql, count]) => ({ sql, ...count })) });
  });
  await bootUsageWorker(parentPort, workerData.command, {
    now: () => workerData.now,
    // The owner retains a live lease but never finishes its first discovery.
    discover: () => new Promise(() => {}),
  });
  parentPort.postMessage({ type: 'ready' });
}
function next(worker, type, send, matches = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`worker ${type} deadline`)); }, 60000);
    const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
    const message = value => { if (value.type === type && matches(value)) { cleanup(); resolve(value); } };
    const error = failure => { cleanup(); reject(failure); };
    const exit = code => error(new Error(`worker exited ${code} before ${type}`));
    worker.on('message', message); worker.on('error', error); worker.on('exit', exit); send?.();
  });
}
async function main() {
  if (process.env.SPIDER_USAGE_BENCHMARK !== '1') throw new Error('Requires SPIDER_USAGE_BENCHMARK=1');
  const rows = Number(process.argv[2] ?? 100000);
  if (!Number.isSafeInteger(rows) || rows < 1000 || rows > 160000) throw new Error('Row count must be between 1000 and 160000');
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // Generated modules need an ancestor with this checkout's dependencies.
  const parent = process.env.SPIDER_USAGE_BENCHMARK_ROOT ?? join(checkout, 'node_modules');
  let root, cleanupPromise;
  const workers = [];
  let interrupted = false;
  const cleanup = () => cleanupPromise ??= (async () => {
    await Promise.allSettled(workers.map(worker => worker.terminate()));
    if (root) rmSync(root, { recursive: true, force: true });
  })();
  const interrupt = code => {
    if (interrupted) return;
    interrupted = true;
    process.exitCode = code;
    void cleanup().then(() => process.exit(code), error => { console.error(error); process.exit(1); });
  };
  const onInterrupt = () => interrupt(130), onTerminate = () => interrupt(143);
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  try {
    root = mkdtempSync(join(parent, 'usage-worker-benchmark-'));
    console.error(`Generated benchmark data: ${root}`);
    for (const [key, name] of [['HOME', 'home'], ['TMPDIR', 'tmp'], ['SQLITE_TMPDIR', 'tmp'], ['SPIDER_GLOBAL_ROOT', 'global'], ['PI_CODING_AGENT_DIR', 'agent']]) {
      process.env[key] = join(root, name); mkdirSync(process.env[key], { recursive: true });
    }
    const { build } = await import('vite');
    const source = file => JSON.stringify(join(checkout, 'packages/host/src/usage', file));
    const entry = join(root, 'entry.mjs');
    writeFileSync(entry, `export { bootUsageWorker } from ${source('worker-entry.ts')};
      export { USAGE_WORKER_RESOURCE_LIMITS } from ${source('runtime.ts')};
      export { seedPlanLedger, captureQueries, explainQueries } from ${source('__tests__/fixtures/dashboard-plan.ts')};
      export { openDashboardReader } from ${source('dashboard-reader.ts')};
      export { readCorrectedTotal, readSessionUsageCube } from ${source('query-redesign-shared.ts')};
      export { scopeFor, scopedRange } from ${source('query-session.ts')};
      export { openDb } from '@spider/db-core';`);
    await build({ configFile: false, root: checkout, logLevel: 'error', build: {
      outDir: join(root, 'dist'), emptyOutDir: false, minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'probe.mjs' },
      rolldownOptions: { external: id => !id.startsWith('.') && !isAbsolute(id) && !id.startsWith('@spider/') },
    } });
    const moduleUrl = pathToFileURL(join(root, 'dist/probe.mjs')).href;
    const module = await import(moduleUrl), file = join(root, 'synthetic.db');
    const sqlInstrumentation = process.env.SPIDER_USAGE_BENCHMARK_SQL !== '0';
    const report = { rows, sqlInstrumentation, load: loadavg(), scenario: 'live owner stalled in discovery', samples: [] };
    const seed = module.seedPlanLedger(file, rows, { denseMonthCalls: Math.floor(rows / 5) });
    const db = module.openDb(file);
    db.pragma('wal_checkpoint(TRUNCATE)');
    report.bytes = statSync(file).size;
    assert.ok(report.bytes <= 500 * 1024 * 1024, 'synthetic database exceeds size cap');
    const reader = module.openDashboardReader(file, { instanceId: 'probe', serverBuild: 'synthetic', now: () => seed.now, calibrationMode: () => 'auto' });
    let expectedMonthCost;
    const expectedUsed = db.prepare('SELECT credits_used AS n FROM counter_snapshots ORDER BY ts DESC,rowid DESC LIMIT 1').get().n;
    try {
      const captured = reader.snapshot(ctx => module.captureQueries(ctx, () => ({
        month: module.readCorrectedTotal(ctx, seed.periods[0]),
        session: module.readSessionUsageCube(ctx, seed.periods[0], module.scopedRange(module.scopeFor(ctx, seed.sessionId), { from: seed.periods[0].start, to: seed.now })).total,
      })));
      assert.ok(Number.isFinite(captured.value.month));
      expectedMonthCost = captured.value.session.credits;
      report.plans = module.explainQueries(db, captured.queries);
      report.queries = captured.queries;
    } finally { reader.close(); db.close(); }
    const command = owner => ({ type: 'start', owner, child: false, poll: false, roots: {
      ledgerFile: file, registryDb: join(root, 'missing-registry.db'), sessionsDir: join(root, 'empty-sessions'),
      authPath: join(root, 'absent-auth.json'), leaseDir: join(root, 'leases'),
    } });
    const startWorker = async owner => {
      const worker = new Worker(new URL(import.meta.url), { resourceLimits: module.USAGE_WORKER_RESOURCE_LIMITS, execArgv: [],
        workerData: { module: moduleUrl, command: command(owner), now: seed.now, sqlInstrumentation } });
      workers.push(worker); await next(worker, 'ready'); return worker;
    };
    const owner = await startWorker('synthetic-owner'), follower = await startWorker('synthetic-follower');
    const measure = async (label, run) => {
      const before = await next(follower, 'metrics', () => follower.postMessage({ type: 'metrics' }));
      const started = performance.now(); await run();
      const after = await next(follower, 'metrics', () => follower.postMessage({ type: 'metrics' }));
      const elapsedMs = performance.now() - started, cpuMs = (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000;
      const prior = new Map(before.statements.map(row => [row.sql, row]));
      const value = { label, elapsedMs, cpuMs, cpuPercent: 100 * cpuMs / elapsedMs, queries: after.queries === null ? null : after.queries - before.queries,
        statements: after.statements.map(row => ({ sql: row.sql, count: row.count - (prior.get(row.sql)?.count ?? 0), cpuUs: row.cpuUs - (prior.get(row.sql)?.cpuUs ?? 0) })).filter(row => row.count) };
      report.samples.push(value); console.error(JSON.stringify({ ...value, statements: undefined }));
    };
    await measure('idle follower for two ticks', () => new Promise(resolve => setTimeout(resolve, 6200)));
    await measure('five panel messages at one-second cadence', async () => {
      const requests = [];
      for (let i = 0; i < 5; i++) {
        const request = next(follower, 'panel-usage', () => follower.postMessage({ type: 'panel-usage', requestId: i, now: seed.now + i * 1000, sessionId: seed.sessionId }), response => response.requestId === i);
        // A worker can exit before the cadence loop reaches Promise.all.
        void request.catch(() => {});
        requests.push(request);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      for (const result of await Promise.all(requests)) {
        assert.equal(result.data?.monthCost.credits, expectedMonthCost);
        assert.equal(result.data?.pace.used, expectedUsed);
      }
    });
    await measure('eight queued panel messages', async () => {
      const requests = Array.from({ length: 8 }, (_, i) => next(follower, 'panel-usage',
        () => follower.postMessage({ type: 'panel-usage', requestId: i + 10, now: seed.now, sessionId: seed.sessionId }), response => response.requestId === i + 10));
      for (const result of await Promise.all(requests)) {
        assert.equal(result.data?.monthCost.credits, expectedMonthCost);
        assert.equal(result.data?.pace.used, expectedUsed);
      }
    });
    report.owner = await next(owner, 'metrics', () => owner.postMessage({ type: 'metrics' }));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    await cleanup();
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
  }
}
if (isMainThread) main().catch(error => { console.error(error); process.exitCode = 1; });
else worker().catch(error => { throw error; });
