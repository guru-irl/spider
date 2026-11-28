import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDb } from '@spider/db-core';
import { buildViteFixture as build } from '../../../../../scripts/test-fixture-build.js';
import { expect, it } from 'vitest';
import { seedPlanLedger } from './fixtures/dashboard-plan.js';

it('does not retain the ownership dictionary after a worker panel read', async () => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, 'panel-memory-'));
  try {
    const file = join(root, 'ledger.db');
    const seed = seedPlanLedger(file, 10000);
    const db = openDb(file);
    try {
      db.exec(`INSERT INTO sessions(id,owner_session_id,name,name_source,first_activity,last_activity,name_order)
        SELECT value,NULL,value,'id',0,${seed.now},0 FROM dimension_values WHERE dimension='session' AND has_value=1`);
      db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000)
        INSERT INTO sessions(id,owner_session_id,name,name_source,first_activity,last_activity,name_order)
        SELECT 'extra-session-'||i,CASE WHEN i%4=0 THEN 'extra-session-'||(i-1) ELSE NULL END,'session-'||i,'name',0,${seed.now},0 FROM n`);
      db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<40000)
        INSERT INTO runs_meta(id,db_path,session_id,role,started_at,ended_at,status)
        SELECT 'extra-run-'||i,'synthetic/runs.db','extra-session-'||(1+(i%20000)),'worker',0,${seed.now},'done' FROM n`);
    } finally { db.close(); }
    await build({ configFile: false, logLevel: 'error', build: { outDir: root, emptyOutDir: false, minify: false,
      lib: { entry: resolve('packages/host/src/usage/__tests__/fixtures/panel-memory-worker.ts'), formats: ['es'], fileName: () => 'worker.mjs' },
      rolldownOptions: { external: id => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('@spider/') } } });
    const worker = new Worker(join(root, 'worker.mjs'), { resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      workerData: { file, now: seed.now, sessionId: seed.sessionId } });
    let result: { before: number; retained: number; value: { monthCost: { credits: number } } | null };
    try {
      result = await new Promise((resolve, reject) => {
        worker.once('message', resolve); worker.once('error', reject);
        worker.once('exit', code => reject(new Error(`worker exited before reporting: ${code}`)));
      });
    } finally { await worker.terminate(); }
    expect(result.value).not.toBeNull();
    expect(result.value!.monthCost.credits).toBeGreaterThan(0);
    const retainedBytes = result.retained - result.before;
    console.log(`panel worker retained heap: ${retainedBytes} bytes`);
    expect(retainedBytes).toBeLessThan(8 * 1024 * 1024);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10000);
