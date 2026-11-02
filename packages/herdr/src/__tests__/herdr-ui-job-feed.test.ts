// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import { monitorFixture, on } from './herdr-monitor-fixture.js';
import type { RuntimeTarget } from '../contracts.js';
import { createJobStore } from '../jobs/store.js';
import { openDbAt, openDb } from '@spider/db-core';
import { RunStore } from '../../../subagents/src/run-store.js';
import { createHerdrDataSource } from '../../../host/src/herdr/data-source.js';
import { parseFeed } from '../../assets/shared/feed.js';
import { runPanelScene } from './acceptance/i.js';

const target: RuntimeTarget = { on, cwd: null, directory: '/fixture/programs', commands: {}, environment: {}, nodePath: '/fixture/node', runtimePath: '/fixture/runtime.mjs', runtimeSha256: 'fixture' };

test('preparation carries a bounded single-line command preview from the original code, not the wrapper', async () => {
  const program = await prepareRemoteProgram({ kind: 'file', path: '/fixture/input.txt', language: 'shell', code: 'printf "hello"\u0000\t\nnext\u001b\u0085' + 'x'.repeat(300) }, target);
  expect((program as { commandPreview?: string }).commandPreview).toBe(('printf "hello" next ' + 'x'.repeat(300)).slice(0, 180));
  expect(program.files.some(file => file.bytes.toString().includes('FILE_CONTENT_PATH'))).toBe(true);
});

test('the monitor persists the prepared command preview with its job record', async () => {
  const h = await monitorFixture();
  const program = await prepareRemoteProgram({ kind: 'code', language: 'shell', code: 'npm test\n' }, target);
  const jobs = h.monitor();
  await jobs.start(program, h.owner, on, {});
  const journal = JSON.parse(await readFile(join(h.f.root, 'sessions', h.owner.sessionId, 'jobs.json'), 'utf8'));
  expect(journal.jobs[0]).toMatchObject({ commandPreview: 'npm test', machine: 'remote.invalid' });
});

test('the journal reader retains command metadata after the writer reloads', async () => {
  const h = await monitorFixture();
  const jobs = h.monitor();
  await jobs.start(await prepareRemoteProgram({ kind: 'code', language: 'shell', code: 'npm test' }, target), h.owner, on, {});
  const journal = await createJobStore(h.f.root, h.owner.sessionId).read();
  expect(journal.jobs[0]).toMatchObject({ commandPreview: 'npm test' });
});

test('a finished child command reaches the panel from the real feed with no finished terminals and opens job output', async () => {
  const h = await monitorFixture();
  const dbPath = join(h.f.root, 'feed.db');
  const db = openDbAt(dbPath, 'worktree');
  const approvalPath = join(h.f.root, 'approvals.db');
  openDbAt(approvalPath, 'global').close();
  const runs = new RunStore(db);
  const run = runs.create({ sessionId: h.owner.sessionId, agent: 'worker', name: 'reviewer' });
  runs.start(run.id); db.close();
  const jobs = h.monitor({ child: { id: run.id as never, pid: process.pid, startIdentity: 'fixture' } });
  const handle = await jobs.start(await prepareRemoteProgram({ kind: 'code', language: 'shell', code: 'npm test' }, target), h.owner, on, {});
  h.complete(handle.address); await jobs.reconcile(); await handle.finished;
  const source = createHerdrDataSource({
    resolveRunDb: () => ({ db: openDb(dbPath), dbPath }), openApprovalDbs: () => ({ global: openDb(approvalPath), repo: null }),
    runEvents: { on: () => () => {} }, scheduler: { subscribe: () => () => {}, listTriggers: () => [] },
    readJobJournal: async () => (await createJobStore(h.f.root, h.owner.sessionId, run.id as never).read()).jobs,
    readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }),
    readConfig: () => ({ limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 } }),
    readOwnerFacts: async () => ({ placement: null, status: { native: 'idle', effective: 'idle', message: null }, ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/capability' } }),
    clock: () => 1000,
  });
  try {
    const feed = await source.snapshot(h.owner);
    const notice = feed.notifications.find(n => n.kind === 'job-result');
    expect(notice).toMatchObject({ createdAt: 1000, job: { id: handle.id, runId: run.id, commandPreview: 'npm test', machine: 'remote.invalid', exitCode: 23, signal: null, finishedAt: 1000, address: handle.address } });
    expect(parseFeed(JSON.stringify(feed))).not.toBeNull();
    const result = await runPanelScene<{ text: string[]; requests: unknown[]; focus: unknown[] }>(`
      Date.now=()=>1000;api.terminals=()=>[];const requests=[];
      api.exec=async(command,args)=>{if(args[1]==='ipc'){const req=JSON.parse(args[5]);requests.push(req);return {code:0,stdout:JSON.stringify(req.op==='ping'?{ok:true,op:'ping',status:{native:'idle',effective:'idle'}}:{ok:true,op:'openJob',viewer:'output.invalid/t1'}),stderr:''};}
        return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      initView(panel,cx);await tasks[0];const tree=panel.render(cx);const row=byId(tree,${JSON.stringify('need-job:' + handle.id)});
      row.events.on_click({},cx);await drain();panel.close();console.log(JSON.stringify({text:texts(row),requests,focus:commands}));`, feed);
    expect(result.text).toEqual(['reviewer', 'npm test', 'failed', 'on', 'remote.invalid']);
    expect(result.requests).toEqual([{op:'ping',generation:h.owner.generation},{op:'openJob',jobId:handle.id,generation:h.owner.generation}]);
    expect(result.focus).toEqual([{name:'pane.focus',args:{terminal:'output.invalid/t1'}}]);
  } finally { source.dispose(); }
});
