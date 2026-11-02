// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runPanelScene } from './acceptance/i.js';
import type { Owner, SessionFeed } from '../contracts.js';
import { createFeedReader } from '../../assets/shared/feed.js';
it('does not wait for an earlier launch during close and closes a late acknowledgement', async () => {
  let release!: (reply: { code: number; stdout: string; stderr: string }) => void;
  const requests: string[] = [];
  const reader = createFeedReader({ nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs', feedRoot: '/fixture/feeds' }, {
    timer: { every: (ms, callback) => { const handle = setTimeout(callback, ms); return { cancel: () => clearTimeout(handle) }; } },
    exec: () => new Promise(resolve => { release = resolve; }),
    fetch: async url => { requests.push(url); return { ok: true, json: async () => ({ ok: true }) }; },
  });
  const reading = reader.read().then(() => null, error => error.message);
  let done = false; const closing = reader.close().then(() => { done = true; });
  try { await Promise.resolve(); await Promise.resolve(); expect(done).toBe(true); }
  finally { release({ code: 0, stdout: JSON.stringify({ version: 1, port: 34567, pid: 1, token: '0'.repeat(64) }), stderr: '' }); await closing; }
  expect(await reading).toBe('Feed reader closed');
  expect(requests).toEqual(['http://127.0.0.1:34567/close']);
});
it('releases the panel refresh when a reader request hangs', async () => {
  const owner: Owner = { sessionId: 'planner' as Owner['sessionId'], generation: 'g' as Owner['generation'], terminal: { coreId: 'core' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: 't1' as Owner['terminal']['address'], socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null };
  const feed: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: 1, owner, placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], ipc: null, errors: [] };
  const output = await runPanelScene<{ loading: boolean; message: string | null }>(`
    context.fetch=async url=>String(url).endsWith('/close')?{ok:true,json:async()=>({})}:new Promise(()=>{});
    initView(panel,cx);
    for(let i=0;i<30;i++)await Promise.resolve();
    const deadline=timers.find(timer=>timer.n===5000);if(deadline)deadline.f(cx);
    for(let i=0;i<40;i++)await Promise.resolve();
    const result={loading:panel.reloading,message:panel.errors[0]?.message??null};
    await panel.close();console.log(JSON.stringify(result));`, feed);
  expect(output.loading).toBe(false);
  expect(output.message).toContain('timed out');
});

it('starts one reader for repeated panel reloads and stops it when the panel closes', async () => {
  const scratch = resolve('.spider/scratch'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'reader-panel-'));
  try {
    const owner: Owner = { sessionId: 'planner' as Owner['sessionId'], generation: 'g' as Owner['generation'], terminal: { coreId: 'fixture' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: 't1' as Owner['terminal']['address'], socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null };
    const feed: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: Date.now(), owner, placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], ipc: null, errors: [] };
    await mkdir(join(root, 'sessions', 'planner'), { recursive: true }); await writeFile(join(root, 'sessions', 'planner', 'session.json'), JSON.stringify(feed), { mode: 0o600 });
    const output = await runPanelScene<{ starts: number; sessions: string[]; left: string[] }>(`
      props.feedRoot=${JSON.stringify(root)};props.nodePath=process.execPath;props.cliPath=${JSON.stringify(resolve('dist/herdr/cli.mjs'))};
      api.nativeReader=true;
      const {execFile}=await import('node:child_process');let starts=0;
      api.exec=(command,args)=>{starts++;return new Promise((resolve,reject)=>execFile(command,args,{maxBuffer:8*1024*1024,env:{...process.env,TMPDIR:path.dirname(m.identifier)}},(error,stdout,stderr)=>error?reject(error):resolve({code:0,stdout,stderr})));};
      initView(panel,cx);await tasks[0];
      for(let i=0;i<5;i++)await panel.reload(cx);
      const sessions=panel.feeds.map(feed=>feed.sessionId);await panel.close();
      let left=[];try{left=await fs.readdir(path.join(props.feedRoot,'readers'));}catch{}
      console.log(JSON.stringify({starts,sessions,left}));`, feed);
    expect(output.sessions).toEqual(['planner']);
    expect(output.starts).toBe(1);
    expect(output.left).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
