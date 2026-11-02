// SPDX-License-Identifier: MIT
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import * as adoption from '../durable-adoption';
import { connectDurableChild } from '../durable-child';
import { build } from 'vite';
import { freshDb, testScratchPath } from './helpers/testutil';
import { openDbAt } from '@spider/db-core';
import { RunStore } from '../run-store';
import { defaultSpawner } from '../spawn-default';
import { isProcessAlive } from '../kill-process';
import { processStartTime } from '../process-identity';
import { getChild, registerChild, teardownAllAsync, teardownSessionAsync } from '../coordinators';
import { registerShared } from '../child-registry';
import { registerSubagentActions } from '../index';
import { adoptReloadedChildren } from '../actions/run';

const runtime = resolve('dist/herdr/subagent-supervisor.mjs');
const parentEntry = testScratchPath('durable-parent.mjs');
const childEntry = testScratchPath('durable-fake-pi.mjs');
const slowEntry = testScratchPath('durable-slow-supervisor.mjs');
const cleanups: (() => Promise<unknown> | unknown)[] = [];
async function until<T>(probe: () => T | Promise<T>, check: (value: T) => boolean, timeout = 10000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) { const value = await probe(); if (check(value)) return value; if (Date.now() > end) throw new Error(`Deadline waiting for ${String(value)}`); await new Promise(r => setTimeout(r, 20)); }
}
function json(path: string): any { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function fixture(longPath = false) {
  const db = freshDb(), store = new RunStore(db);
  const { id } = store.create({ sessionId: 'planner', agent: 'worker', task: 'finish after a steer' }); store.start(id); store.setLaunch(id, { childMode: 'rpc' });
  const directory = testScratchPath('sa-' + id.slice(0, 8) + (longPath ? '/nested-' + 'x'.repeat(80) : '')); mkdirSync(directory, { recursive: true });
  const dbPath = (db.raw as any)?.name;
  // The concrete DB interface exposes its path through the native connection.
  const actualPath = dbPath ?? (db as any).path;
  const spec = { argv: [process.execPath, childEntry], cwd: resolve('.'), env: { FAKE_STATE: join(directory, 'fake.json'), FAKE_BEAT_MS: '30', PI_SPIDER_DB_PATH: actualPath, PI_SUBAGENT_RUN_ID: id }, childMode: 'rpc' as const, prompt: 'work',
    supervisor: { entry: runtime, directory, dbPath: actualPath, runId: id, sessionId: 'planner' } };
  cleanups.push(() => db.close());
  cleanups.push(async () => {
    const state = json(join(directory, 'state.json'));
    if (state && isProcessAlive(state.supervisorPid)) {
      process.kill(state.supervisorPid, 'SIGTERM');
      await until(() => isProcessAlive(state.supervisorPid), alive => !alive);
    }
  });
  return { db, store, id, directory, spec };
}

beforeAll(async () => {
  await build({ configFile: resolve('vite.herdr.config.mjs'), mode: 'subagent-supervisor', logLevel: 'silent' });
  writeFileSync(slowEntry, `import {writeFileSync,readFileSync,existsSync} from 'node:fs';import{dirname,join}from'node:path';import{setTimeout as delay}from'node:timers/promises';
const dir=dirname(process.argv[2]);writeFileSync(join(dir,'launched.json'),JSON.stringify({pid:process.pid}));
while(!existsSync(join(dir,'start')))await delay(10);
writeFileSync(join(dir,'starting.json'),JSON.stringify({version:1,supervisorPid:process.pid,startedAt:Date.now(),supervisorStartTime:JSON.parse(readFileSync(join(dir,'identity.json'),'utf8'))}));
while(!existsSync(join(dir,'continue')))await delay(10);
await import(${JSON.stringify(runtime)});`);
  writeFileSync(childEntry, `import {writeFileSync} from 'node:fs';import Database from 'better-sqlite3';
const db=new Database(process.env.PI_SPIDER_DB_PATH);db.pragma('busy_timeout=5000');
let buffer='',n=0; const save=()=>writeFileSync(process.env.FAKE_STATE,JSON.stringify({pid:process.pid,beats:++n}));
const tick=setInterval(save,Number(process.env.FAKE_BEAT_MS)); save(); const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');
process.stdin.on('data', chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const c=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
if(c.type==='prompt'){out({type:'response',id:c.id,command:c.type,success:true,data:{disposition:'started'}});out({type:'agent_start'});}
if(c.type==='steer'){out({type:'queue_update',steering:[c.message],followUp:[]});out({type:'response',id:c.id,command:c.type,success:true,data:{disposition:'queued'}});out({type:'message_start',message:{role:'user',content:c.message}});out({type:'queue_update',steering:[],followUp:[]});setTimeout(()=>{db.prepare('INSERT INTO run_events (run_id,session_id,ts,type,summary,payload) VALUES (?,?,?,?,?,?)').run(process.env.PI_SUBAGENT_RUN_ID,'planner',Date.now(),'message','Finished '+c.message,JSON.stringify({stopReason:'stop'}));out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Finished '+c.message}],stopReason:'stop'}});out({type:'agent_settled'});},100);}
if(c.type==='abort')out({type:'response',id:c.id,command:c.type,success:true});}});
process.stdin.on('end',()=>{clearInterval(tick);process.exit(0)});`);
  // Build an actual parent process using the production spawner, then hang it up.
  const source = testScratchPath('durable-parent.ts');
  writeFileSync(source, `import {defaultSpawner} from ${JSON.stringify(resolve('packages/subagents/src/spawn-default.ts'))};
import {writeFileSync,readFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));const h=defaultSpawner(input.spec);h.detach();
writeFileSync(input.ready,JSON.stringify({parentPid:process.pid}));h.wait().then(value=>{writeFileSync(input.result,JSON.stringify(value));process.exit()});setInterval(()=>{},1000);`);
  await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: source, outDir: resolve(parentEntry, '..'), emptyOutDir: false,
    rollupOptions: { external: id => id.startsWith('node:') || ['better-sqlite3','sqlite-vec','@earendil-works/pi-coding-agent'].includes(id), output: { entryFileNames: 'durable-parent.mjs', codeSplitting: false } } } });
}, 30000);
afterEach(async () => { await teardownAllAsync({ graceMs: 20 }); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function slowFixture() {
  const f = fixture(); f.spec.supervisor.entry = slowEntry;
  cleanups.push(() => { const pid = json(join(f.directory, 'launched.json'))?.pid; if (pid && isProcessAlive(pid)) process.kill(pid, 'SIGKILL'); });
  return f;
}

test('waiting for the supervisor to launch does not consume its startup deadline', async () => {
  const f = slowFixture(), h = defaultSpawner(f.spec); h.detach();
  const launched = await until<{ pid: number }>(() => json(join(f.directory, 'launched.json')), Boolean);
  let settled = false; void h.wait().then(() => { settled = true; });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20000);
  try { await new Promise(resolve => setTimeout(resolve, 100)); expect(settled).toBe(false); }
  finally { clock.mockRestore(); }
  writeFileSync(join(f.directory, 'identity.json'), JSON.stringify(processStartTime(launched.pid)));
  writeFileSync(join(f.directory, 'start'), ''); writeFileSync(join(f.directory, 'continue'), '');
  expect(await h.steer!('finish after a slow launch')).toMatchObject({ delivered: true });
  expect(await h.wait()).toMatchObject({ exitCode: 0 });
}, 30000);

test('a supervisor that misses its startup deadline is stopped by its heartbeat pid', async () => {
  const f = slowFixture(), h = defaultSpawner(f.spec); h.detach();
  const launched = await until<{ pid: number }>(() => json(join(f.directory, 'launched.json')), Boolean);
  writeFileSync(join(f.directory, 'identity.json'), JSON.stringify(processStartTime(launched.pid)));
  writeFileSync(join(f.directory, 'start'), '');
  await until(() => json(join(f.directory, 'starting.json')), Boolean);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20000);
  try { expect(await h.wait()).toMatchObject({ exitCode: 1, result: expect.stringContaining("didn't start in time") }); }
  finally { clock.mockRestore(); }
  await until(() => isProcessAlive(launched.pid), alive => !alive);
  expect(existsSync(f.spec.env.FAKE_STATE)).toBe(false);
}, 30000);

test('the supervisor publishes its startup heartbeat before opening a locked database', async () => {
  const f = fixture();
  f.db.raw.exec('BEGIN EXCLUSIVE');
  const h = defaultSpawner(f.spec); h.detach();
  try {
    const starting = await until<{ supervisorPid: number }>(() => json(join(f.directory, 'starting.json')), Boolean, 2000);
    expect(isProcessAlive(starting.supervisorPid)).toBe(true);
    expect(existsSync(join(f.directory, 'state.json'))).toBe(false);
  } finally { f.db.raw.exec('ROLLBACK'); }
  expect(await h.steer!('finish after database unlock')).toMatchObject({ delivered: true });
  await h.wait();
}, 30000);

// Break caught: direct stdio ownership sends EOF to pi when its parent is hung up.
test('parent hang-up leaves the child alive, a new parent re-adopts it and delivers a steer and one result', async () => {
  const f = fixture(); f.spec.env.FAKE_BEAT_MS = '1000';
  const input = join(f.directory, 'parent.json'), ready = join(f.directory, 'parent-ready.json');
  writeFileSync(input, JSON.stringify({ spec: f.spec, ready, result: join(f.directory, 'old-result.json') }));
  const parent = spawn(process.execPath, [parentEntry, input], { stdio: 'ignore' });
  cleanups.push(() => { try { parent.kill('SIGKILL'); } catch {} });
  await until(() => json(ready), Boolean);
  const before = await until<{ pid: number; beats: number }>(() => json(f.spec.env.FAKE_STATE), Boolean);
  const supervisor = json(join(f.directory, 'state.json'));
  expect(Number(execFileSync('ps', ['-p', String(supervisor.supervisorPid), '-o', 'ppid='], { encoding: 'utf8' }).trim())).not.toBe(parent.pid);
  parent.kill('SIGHUP'); await new Promise<void>(r => parent.once('exit', () => r()));
  await until(() => json(f.spec.env.FAKE_STATE)?.beats, beats => beats > before.beats);
  expect(isProcessAlive(before.pid)).toBe(true);
  expect(json(f.spec.env.FAKE_STATE).beats).toBeGreaterThan(before.beats);
  const diagnostic = adoption.diagnoseDurableChildren;
  expect(diagnostic).toBeTypeOf('function');
  expect(diagnostic({ db: f.db, sessionId: 'planner', runDbPath: f.spec.supervisor.dbPath })).toEqual([
    expect.objectContaining({ runId: f.id, status: 'running', supervisor: 'alive', child: 'alive', owner: 'detached' }),
  ]);
  const notices: any[] = [];
  await adoptReloadedChildren({ db: f.db, sessionId: 'planner', cwd: resolve('.'), runDbPath: f.spec.supervisor.dbPath,
    pi: { sendMessage: (m: any) => notices.push(m) } });
  const child = getChild('planner', f.id);
  expect(child?.steer).toBeTypeOf('function');
  expect(await child!.steer!('finish now')).toMatchObject({ accepted: true, delivered: true });
  await until(() => f.store.get(f.id)!.status, status => status !== 'running');
  await until(() => notices.length, n => n === 1);
  expect(f.store.get(f.id)).toMatchObject({ status: 'done', result: 'Finished finish now\n\n1 steer(s) delivered.' });
  expect(notices[0].customType).toBe('spider.subagent_done');
  const state = json(join(f.directory, 'state.json'));
  await until(() => isProcessAlive(state.supervisorPid), alive => !alive);
  expect(existsSync(state.socket)).toBe(false);
  expect(diagnostic({ db: f.db, sessionId: 'planner', runDbPath: f.spec.supervisor.dbPath })).toEqual([]);
}, 30000);

// Break caught: supervisor termination without a parent leaves an active row forever.
test('a child finishes without a parent, and its saved completion is delivered only once on resume', async () => {
  const f = fixture(); const h = defaultSpawner(f.spec);
  h.detach();
  expect(await h.steer!('saved result')).toMatchObject({ delivered: true });
  h.unbindEvents?.();
  await h.wait();
  expect(f.store.get(f.id)).toMatchObject({ status: 'done', result: 'Finished saved result' });
  const notices: any[] = [], ctx = { db: f.db, sessionId: 'planner', cwd: resolve('.'), runDbPath: f.spec.supervisor.dbPath, pi: { sendMessage: (m: any) => notices.push(m) } };
  await adoptReloadedChildren(ctx); await until(() => notices.length, n => n === 1);
  await adoptReloadedChildren(ctx); await new Promise(r => setTimeout(r, 40));
  expect(notices).toHaveLength(1);
}, 30000);

test.each(['SIGTERM', 'SIGINT'] as const)('a supervisor stopped by %s delivers a failed result on resume', async signal => {
  const f = fixture(), h = defaultSpawner(f.spec); h.detach();
  const state = await until<{ supervisorPid: number }>(() => json(join(f.directory, 'state.json')), Boolean);
  process.kill(state.supervisorPid, signal);
  await h.wait();
  expect(f.store.get(f.id)).toMatchObject({ status: 'failed', result: expect.stringContaining('stopped by a signal') });
  const notices: any[] = [];
  await adoptReloadedChildren({ db: f.db, sessionId: 'planner', cwd: resolve('.'), runDbPath: f.spec.supervisor.dbPath, pi: { sendMessage: (m: any) => notices.push(m) } });
  await until(() => notices.length, n => n === 1);
  expect(notices[0].details.status).toBe('failed');
  expect(notices[0].content).toContain('stopped by a signal');
}, 30000);

test('explicit stop cancels before shutdown and a cancelled run cannot be re-adopted or steered', async () => {
  const f = fixture(); const h = defaultSpawner(f.spec); h.detach();
  await until(() => json(f.spec.env.FAKE_STATE), Boolean);
  await h.killAsync!(30, 'Explicit stop'); await h.wait();
  expect(f.store.get(f.id)).toMatchObject({ status: 'cancelled', result: 'Explicit stop' });
  const notices: any[] = [];
  await adoptReloadedChildren({ db: f.db, sessionId: 'planner', cwd: resolve('.'), runDbPath: f.spec.supervisor.dbPath, pi: { sendMessage: (m: any) => notices.push(m) } });
  expect(getChild('planner', f.id)).toBeUndefined();
  expect(await h.steer!('must not restart')).toMatchObject({ accepted: false });
  expect(notices).toHaveLength(0);
}, 30000);

// Break caught: a pending launcher could start work after the run was already cancelled or finished.
test.each(['cancelled', 'done', 'failed'] as const)('a %s row is a permanent launch tombstone', async status => {
  const f = fixture(), result = `Saved ${status}`;
  if (status === 'cancelled') f.store.cancel(f.id, result); else f.store.finish(f.id, { status, result });
  const h = defaultSpawner(f.spec); h.detach();
  const observed = await until(() => ({ saved: json(join(f.directory, 'exit.json')), started: existsSync(f.spec.env.FAKE_STATE) }), value => value.saved || value.started);
  expect(observed.started).toBe(false);
  expect(await h.wait()).toMatchObject({ exitCode: status === 'done' ? 0 : status === 'cancelled' ? 130 : 1, result });
  expect(f.store.get(f.id)).toMatchObject({ status, result });
  expect(json(join(f.directory, 'state.json'))?.childPid).toBeUndefined();
}, 30000);

// Break caught: an unauthenticated idle socket kept a finished supervisor and its listener alive.
test('idle unauthenticated clients cannot keep a finished supervisor alive', async () => {
  const f = fixture(), h = defaultSpawner(f.spec); h.detach();
  const state = await until<{ supervisorPid: number; socket: string }>(() => json(join(f.directory, 'state.json')), Boolean);
  const idle = createConnection(state.socket); cleanups.push(() => idle.destroy());
  await new Promise<void>((resolve, reject) => { idle.once('connect', resolve); idle.once('error', reject); });
  expect(await h.steer!('finished despite idle client')).toMatchObject({ delivered: true });
  await h.wait();
  await until(() => isProcessAlive(state.supervisorPid), alive => !alive, 1000);
  expect(existsSync(state.socket)).toBe(false);
  expect(f.store.get(f.id)!.status).toBe('done');
}, 30000);

// Break caught: a failed parent notification was marked delivered and lost on the next resume.
test('a failed completion notification stays recoverable for the next resume', async () => {
  const f = fixture(), h = defaultSpawner(f.spec); h.detach();
  await h.steer!('recover this completion'); await h.wait();
  const elsewhere = freshDb(), globalDb = openDbAt(testScratchPath(`routes-${randomUUID()}.db`), 'global');
  cleanups.push(() => elsewhere.close(), () => globalDb.close());
  globalDb.prepare('INSERT INTO run_routes (run_id,session_id,db_path) VALUES (?,?,?)').run(f.id, 'planner', f.spec.supervisor.dbPath);
  const ctx = { db: elsewhere, globalDb, sessionId: 'planner', cwd: resolve('.'), runDbPath: elsewhere.raw.name };
  await adoptReloadedChildren({ ...ctx, pi: { sendMessage() { throw new Error('Parent is unavailable'); } } });
  await new Promise(r => setTimeout(r, 50));
  const notices: any[] = [];
  await adoptReloadedChildren({ ...ctx, pi: { sendMessage: (message: any) => notices.push(message) } });
  await until(() => notices.length, count => count === 1);
  expect(notices).toHaveLength(1);
  await adoptReloadedChildren({ ...ctx, pi: { sendMessage: (message: any) => notices.push(message) } });
  await new Promise(r => setTimeout(r, 30));
  expect(notices).toHaveLength(1);
}, 30000);

// Break caught: a second parent mistook the first parent's live ownership for a failed child.
test('a second parent cannot steal RPC ownership or falsely finish a live child', async () => {
  const f = fixture(), first = defaultSpawner(f.spec); first.detach();
  await until(() => json(join(f.directory, 'state.json')), state => state?.ownerPid === process.pid);
  const second = connectDurableChild(f.directory); second.detach();
  let settled = false; void second.wait().then(() => { settled = true; });
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 20000);
  try {
    await new Promise(r => setTimeout(r, 100));
    expect(settled).toBe(false);
  } finally { clock.mockRestore(); }
  expect(await second.steer!('must not steal ownership')).toMatchObject({ accepted: false, delivery: 'refused' });
  expect(await first.steer!('finish under original owner')).toMatchObject({ delivered: true });
  await first.wait(); await second.wait();
  expect(f.store.get(f.id)!.status).toBe('done');
}, 30000);

// Break caught: changing the session kept the old socket and refused control from a resumed parent.
test.each(['new', 'resume', 'fork'])('shutdown for %s releases ownership so another parent can steer and kill', async reason => {
  const f = fixture(), first = defaultSpawner(f.spec); first.detach();
  registerShared({ sessionId: 'planner', runId: f.id, dbPath: f.spec.supervisor.dbPath, handle: first, mode: 'rpc', survivable: true });
  registerChild('planner', f.id, first);
  await until(() => json(join(f.directory, 'state.json')), state => state?.ownerPid === process.pid);
  const hooks = new Map<string, Function>();
  registerSubagentActions({ registerAction() {} }, { on: (name: string, handler: Function) => hooks.set(name, handler) });
  await hooks.get('session_shutdown')!({ reason }, { sessionManager: { getSessionId: () => 'planner' } });
  const second = connectDurableChild(f.directory); second.detach();
  // Wait for either an attached owner or an explicit refusal, rather than a fixed startup delay.
  const ack = await second.steer!('finish from resumed parent');
  expect(ack).toMatchObject({ accepted: true, delivered: true });
  await second.killAsync!(30, 'Stop from resumed parent');
  expect(f.store.get(f.id)).toMatchObject({ status: 'cancelled', result: 'Stop from resumed parent' });
}, 30000);

test.each([false, true])('session teardown reports a refused takeover, including a detached handle (%s)', async detached => {
  const f = fixture(), first = defaultSpawner(f.spec); first.detach();
  await until(() => json(join(f.directory, 'state.json')), state => state?.ownerPid === process.pid);
  const second = connectDurableChild(f.directory); second.detach();
  if (detached) {
    const entry = registerShared({ sessionId: 'planner', runId: f.id, dbPath: f.spec.supervisor.dbPath, handle: second, mode: 'rpc', survivable: true });
    entry.state = 'independent';
  } else registerChild('planner', f.id, second);
  await expect(teardownSessionAsync('planner')).rejects.toThrow(/Another live parent/);
  expect(f.store.get(f.id)!.status).toBe('running');
  await first.killAsync!(30, 'Stop from owning parent');
  await second.wait();
}, 30000);

test('resuming in the same process reconnects a released durable handle', async () => {
  const f = fixture(), first = defaultSpawner(f.spec); first.detach();
  registerShared({ sessionId: 'planner', runId: f.id, dbPath: f.spec.supervisor.dbPath, handle: first, mode: 'rpc', survivable: true });
  registerChild('planner', f.id, first);
  await until(() => json(join(f.directory, 'state.json')), state => state?.ownerPid === process.pid);
  const hooks = new Map<string, Function>();
  registerSubagentActions({ registerAction() {} }, { on: (name: string, handler: Function) => hooks.set(name, handler) });
  await hooks.get('session_shutdown')!({ reason: 'new' }, { sessionManager: { getSessionId: () => 'planner' } });
  const notices: any[] = [];
  await adoptReloadedChildren({ db: f.db, sessionId: 'planner', cwd: resolve('.'), runDbPath: f.spec.supervisor.dbPath, pi: { sendMessage: (m: any) => notices.push(m) } });
  expect(await getChild('planner', f.id)!.steer!('finish after returning')).toMatchObject({ delivered: true });
  await until(() => notices.length, n => n === 1);
  expect(notices[0].details.status).toBe('done');
}, 30000);

// Break caught: a valid deep checkout exceeded the Unix socket limit before the child could start.
test('long state directories use an authenticated loopback endpoint instead of failing to launch', async () => {
  const f = fixture(true), h = defaultSpawner(f.spec); h.detach();
  try { await until(() => json(f.spec.env.FAKE_STATE), Boolean, 1000); }
  catch (error) { throw new Error(readFileSync(join(f.directory, 'supervisor.log'), 'utf8'), { cause: error }); }
  expect(json(join(f.directory, 'state.json')).socket).toMatchObject({ host: '127.0.0.1', port: expect.any(Number) });
  expect(await h.steer!('finish in a deep checkout')).toMatchObject({ delivered: true });
  await h.wait();
  expect(f.store.get(f.id)!.status).toBe('done');
}, 30000);
