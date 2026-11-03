// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, readFile, symlink, unlink, writeFile, stat } from 'node:fs/promises';
import { createJobStore } from '../jobs/store.js';
import { registerHerdrJobs } from '../jobs/register.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { JobMonitor } from '../jobs/monitor.js';
import { join } from 'node:path';
import type { CoreId, MachineName, HcEvent, HcEventStream, HcClient, JobId, Owner, PreparedProgram, TerminalAddress, TerminalFinish, TerminalSummary } from '../contracts.js';
import { createClientFixture } from './testutil.js';
import { createJobMonitor, type JobMonitorOptions, type JobNotice, type JobOutput } from '../jobs/monitor.js';

const finish: TerminalFinish = { exitCode: 23, reason: 'exited', signal: null, finishedAt: 1000 };
const program: PreparedProgram = { directory: '/fixture/runtime', argv: ['node', 'runtime.mjs'], files: [], cwd: null, env: {} };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture() {
  const f = await createClientFixture(); cleanups.push(f.close);
  const owner = { sessionId: 'session-one', generation: 'gen-one', terminal: { coreId: 'core-one', terminalId: 't1', address: 't1', socket: f.localSocket, sessionNamespace: 'fl' }, cwd: f.root, sessionFile: null, name: null } as Owner;
  let listener: ((e: HcEvent) => void) | undefined;
  const terminals = new Map<TerminalAddress, TerminalSummary>();
  const stream: HcEventStream = { ready: Promise.resolve(), lookup: async a => terminals.get(a) ?? null, subscribe: l => { listener = l; return () => { listener = undefined; }; }, dispose: async () => { listener = undefined; } };
  const notices: JobNotice[] = []; const observed = new Set<JobId>(); const kills: TerminalAddress[] = []; const removed: TerminalAddress[] = []; const releases: string[] = []; const launches: unknown[] = [];
  let outcome: JobOutput = { complete: true, summary: 'output', receipt: null };
  let currentJob: JobId;
  let early = true; let failLaunch = false; let submitFailure = false; let collectFailure = false;
  let now = 1000;
  const emit = (e: HcEvent) => listener?.(e);
  const hc: HcClient = {
    setLabels: async () => {}, identity: async () => owner.terminal, caller: async () => owner.terminal, machines: async () => [{ id: 'remote-core' as CoreId, name: 'remote.invalid' as MachineName, aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }], events: () => stream,
    run: async request => {
      launches.push(request);
      const address = 'remote.invalid/t2' as TerminalAddress;
      const t: TerminalSummary = { address, parent: owner.terminal.address, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null };
      terminals.set(address, t); emit({ type: 'created', terminal: address, data: t, seq: 1 });
      if (early) { Object.assign(t, { state: 'finished', ...finish }); outcome = { complete: true, summary: 'payload\u001b]0;bad\u0007', receipt: { jobId: currentJob, nonce: 'private-nonce', finish } }; emit({ type: 'finished', terminal: address, data: finish, seq: 2 }); }
      if (failLaunch) throw new Error('reply lost');
      return { address, coreId: 'remote-core' as Owner['terminal']['coreId'] };
    },
    get: async a => { const t = terminals.get(a); if (!t) throw Object.assign(new Error('missing'), { code: 'not_found' }); return t; },
    read: async () => '', kill: async a => { kills.push(a); }, rm: async a => { removed.push(a); terminals.delete(a); }, fileRead: async () => Buffer.alloc(0), fileWrite: async () => {},
  };
  const options: JobMonitorOptions & { panes: NonNullable<JobMonitorOptions['panes']> } = {
    hc, app: { tabTerminals: async () => [], ownerPlacement: async () => ({ space: 's1', tab: 'tb1', pane: 'p1' } as never), awaitPane: async () => 'p2' as never, command: async () => ({}) },
    panes: { reserve: async () => ({ id: 'slot' }), observe: async () => ({ viewer: 'observer' as TerminalAddress, release: async () => { releases.push('observer'); } }), abandon: async () => {} },
    outputCollector: { prepare: async (_p, job) => { currentJob = job.id; return { program: { ...program, directory: join(f.root, 'remote.invalid', job.id) }, nonce: 'private-nonce', releaseDeadlineAt: now + 10000 }; }, collect: async () => { if (collectFailure) throw new Error('chunk unavailable'); return outcome; } },
    journalRoot: f.root, observedJobMessages: async () => [...observed], notifier: async notice => { notices.push(notice); if (submitFailure) throw new Error('submission uncertain'); }, clock: () => now,
  };
  const monitor = () => { const m = createJobMonitor(options); cleanups.push(async () => { await m.dispose(); }); return m; };
  return { f, owner, options, monitor, stream, notices, observed, launches, releases, kills, removed, terminals, emit, setEarly: (v: boolean) => { early = v; }, setOutput: (o: JobOutput) => { outcome = o; }, setLaunchFailure: () => { failLaunch = true; }, setSubmitFailure: () => { submitFailure = true; }, setCollectFailure: () => { collectFailure = true; }, setNow: (v: number) => { now = v; } };
}

async function bounded<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wait did not settle')), ms); })]); }
  finally { clearTimeout(timer!); }
}

describe('in-process jobs', () => {
  it('reconcile never treats a prior serialized job result as an abort signal', async () => {
    const h = await fixture(); h.setEarly(false);
    h.options.hc.run = async request => {
      const address = 'remote/t2' as TerminalAddress;
      h.terminals.set(address, { address, parent: null, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null });
      return { address, coreId: 'remote-core' as Owner['terminal']['coreId'] };
    };
    const jobs = h.monitor(); await jobs.start(program, h.owner, 'remote' as never, {});
    await expect(jobs.reconcile()).resolves.toBeUndefined();
  });

  it.each(['quit', 'reload'] as const)('%s releases a reconcile blocked on event readiness', async reason => {
    const h = await fixture(), jobs = h.monitor(); await jobs.activate(h.owner);
    let release!: () => void;
    h.stream.ready = new Promise<void>(resolve => { release = resolve; });
    const reconcile = jobs.reconcile(); void reconcile.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    const shutdown = jobs.shutdown(reason);
    try {
      await bounded(shutdown);
      await expect(reconcile).rejects.toMatchObject({ code: 'disposed' });
    } finally { release(); await reconcile.catch(() => {}); await shutdown; }
    expect(h.launches).toEqual([]);
  });

  it('a launch abort releases an event readiness wait without launching a payload', async () => {
    const h = await fixture(), jobs = h.monitor(); await jobs.activate(h.owner);
    let release!: () => void;
    h.stream.ready = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const launch = jobs.start(program, h.owner, 'remote' as never, { signal: controller.signal }); void launch.catch(() => {});
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    try { await expect(bounded(launch)).rejects.toMatchObject({ code: 'aborted' }); }
    finally { release(); await launch.catch(() => {}); }
    expect(h.launches).toEqual([]);
  });

  it('a first launch abort releases activation readiness without launching a payload', async () => {
    const h = await fixture(), jobs = h.monitor();
    let release!: () => void;
    h.stream.ready = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    let entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const events = h.options.hc.events;
    h.options.hc.events = () => { entered(); return events(); };
    const launch = jobs.start(program, h.owner, 'remote' as never, { signal: controller.signal }); void launch.catch(() => {});
    await began; controller.abort();
    try { await expect(bounded(launch)).rejects.toMatchObject({ code: 'aborted' }); }
    finally { release(); await launch.catch(() => {}); }
    expect(h.launches).toEqual([]);
  });

  it.each(['reconcile', 'remote launch'])('a silent event stream makes %s fail with core-unavailable', async operation => {
    const h = await fixture(), jobs = h.monitor(); await jobs.activate(h.owner);
    let release!: () => void;
    h.stream.ready = new Promise<void>(resolve => { release = resolve; });
    const result: Promise<unknown> = operation === 'reconcile' ? jobs.reconcile() : jobs.start(program, h.owner, 'remote' as never, {});
    void result.catch(() => {});
    try { await expect(bounded(result, 3000)).rejects.toMatchObject({ code: 'core-unavailable' }); }
    finally { release(); await result.catch(() => {}); }
    expect(h.launches).toEqual([]);
  });

  it('every launch runs parked after confirmed labels without reserving a slot or starting an observer', async () => {
    const h = await fixture(); h.setEarly(false);
    h.options.panes.reserve = async () => { throw new Error('no slot'); };
    h.options.panes.observe = async () => { throw new Error('no observer'); };
    const writes: string[] = [];
    h.options.hc.fileWrite = async (_on, path) => { writes.push(path); };
    const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    expect(writes).toEqual([join(handle.remoteDirectory, 'release.json')]);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]).toMatchObject({ background: true, noNotify: true, labels: { 'spider.job': handle.id, 'spider.session': h.owner.sessionId } });
    const journal = JSON.parse(await readFile(join(h.f.root, 'sessions/session-one/jobs.json'), 'utf8'));
    expect(journal.jobs[0]).toMatchObject({ viewer: null, phase: { kind: 'running' } });
  });

  it('does not release until hc replies with all job ownership labels', async () => {
    const h = await fixture(); h.setEarly(false);
    let entered!: () => void, confirm!: () => void;
    const waiting = new Promise<void>(r => { confirm = r; }), began = new Promise<void>(r => { entered = r; });
    const get = h.options.hc.get;
    h.options.hc.get = async address => { entered(); await waiting; return get(address); };
    const writes: string[] = []; h.options.hc.fileWrite = async (_on, path) => { writes.push(path); };
    const jobs = h.monitor(), launching = jobs.start(program, h.owner, 'remote.invalid' as never, {});
    await began; expect(writes).toEqual([]); confirm();
    const handle = await launching;
    expect(writes).toEqual([join(handle.remoteDirectory, 'release.json')]);
  });

  it('unconfirmed labels expire after ten seconds without release and remove the original job', async () => {
    const h = await fixture(); h.setEarly(false);
    let entered!: () => void;
    const began = new Promise<void>(r => { entered = r; });
    h.options.hc.get = async address => { entered(); return { ...h.terminals.get(address)!, labels: {} }; };
    const writes: string[] = []; h.options.hc.fileWrite = async (_on, path) => { writes.push(path); };
    const jobs = h.monitor(), launching = jobs.start(program, h.owner, 'remote.invalid' as never, {});
    void launching.catch(() => {});
    // Cross the runtime's ten-second deadline only after the confirmation loop begins.
    await began; h.setNow(11000);
    await expect(launching).rejects.toMatchObject({ code: 'release-timeout' });
    expect(writes).toEqual([]); expect(h.kills).toEqual(['remote.invalid/t2']); expect(h.removed).toEqual(['remote.invalid/t2']);
  });
  it('a finish before the launch reply produces one identified detached notice', async () => {
    const h = await fixture(); const jobs = h.monitor();
    const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, { background: true });
    await jobs.detach(handle.id); await jobs.shutdown('reload');
    const reloaded = h.monitor(); await reloaded.activate({ ...h.owner, generation: 'gen-two' as never });
    expect(h.notices.map(m => m.details.jobId)).toEqual([handle.id]);
    expect(h.notices[0].details.exitCode).toBe(23);
    expect(h.notices[0].content).not.toContain('\u001b');
    expect(h.launches).toHaveLength(1);
    expect(JSON.parse(await readFile(join(h.f.root, 'sessions/session-one/jobs.json'), 'utf8')).jobs[0]).toMatchObject({ notice: 'submitted', detached: true });
  });
  it('reconciles a lost reply by its preassigned label without launching twice', async () => {
    const h = await fixture(); h.setLaunchFailure(); const jobs = h.monitor();
    const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    await jobs.detach(handle.id);
    expect(h.launches).toHaveLength(1);
    expect(h.notices.map(n => n.details.exitCode)).toEqual([23]);
  });

  it('conflicting original and receipt evidence stays unknown on repeated reconciliation', async () => {
    const h = await fixture(); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    h.setOutput({ complete: true, summary: 'conflict', receipt: { jobId: handle.id, nonce: 'private-nonce', finish: { ...finish, exitCode: 25 } } });
    await jobs.detach(handle.id); await jobs.reconcile(); await jobs.reconcile();
    expect(h.notices).toEqual([]);
    const journal = JSON.parse(await readFile(join(h.f.root, 'sessions/session-one/jobs.json'), 'utf8'));
    expect(journal.jobs[0].phase.kind).toBe('disconnected');
  });

  it('withholds a fast finish until synchronous consumption and never posts it after reload', async () => {
    const h = await fixture(); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    expect(await handle.finished).toEqual(finish); expect(h.notices).toEqual([]);
    await jobs.consumeNotice(handle.id); await jobs.shutdown('reload');
    await h.monitor().activate({ ...h.owner, generation: 'gen-two' as never }); expect(h.notices).toEqual([]);
  });

  it('detach and tool return do not create or release an observer', async () => {
    const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, { background: true });
    await jobs.detach(handle.id); expect(h.releases).toEqual([]);
    await jobs.toolReturned(handle.id); expect(h.releases).toEqual([]);
    await jobs.toolReturned(handle.id); expect(h.releases).toEqual([]);
  });

  it('lost, restarted and observer exit zero are not payload completion', async () => {
    const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    h.emit({ type: 'lost', terminal: handle.address, seq: 2, data: { exitCode: null, signal: 9, reason: 'lost' , finishedAt: null } });
    h.emit({ type: 'restarted', terminal: handle.address, seq: 3, data: { ...h.terminals.get(handle.address)!, state: 'live' } });
    h.emit({ type: 'finished', terminal: 'observer' as TerminalAddress, seq: 4, data: { ...finish, exitCode: 0 } });
    await jobs.detach(handle.id); await jobs.reconcile(); expect(h.notices).toEqual([]);
  });

  it('a wrapper exit without a verified nonce-bound receipt is unknown', async () => {
    const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    h.emit({ type: 'finished', terminal: handle.address, seq: 2, data: { ...finish, exitCode: 0 } });
    h.setOutput({ complete: false, summary: '', receipt: null }); await jobs.detach(handle.id); await jobs.reconcile();
    expect(h.notices).toEqual([]);
    h.setOutput({ complete: true, summary: '', receipt: { jobId: handle.id, nonce: 'foreign', finish } }); await jobs.reconcile(); expect(h.notices).toEqual([]);
  });

  it.each(['removed', 'finished'] as const)('observer %s never cancels its still-running foreground job', async type => {
    const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    h.emit(type === 'removed' ? { type, terminal: 'observer' as TerminalAddress, seq: 2 } : { type, terminal: 'observer' as TerminalAddress, seq: 2, data: { ...finish, exitCode: 0 } }); await jobs.reconcile();
    expect(h.kills).toEqual([]); expect(h.notices).toEqual([]);
  });

  it('observer close, cancellation and shutdown never signal a restarted recovery shell', async () => {
    const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    h.emit({ type: 'restarted', terminal: handle.address, seq: 2, data: { ...h.terminals.get(handle.address)!, state: 'live' } }); await jobs.reconcile();
    h.emit({ type: 'removed', terminal: 'observer' as TerminalAddress, seq: 3 }); await jobs.reconcile();
    await expect(handle.cancel('abort')).rejects.toMatchObject({ code: 'job-outcome-unknown' }); await jobs.shutdown('quit'); expect(h.kills).toEqual([]); expect(h.notices).toEqual([]);
  });

  it('restart evidence is captured before a blocked label confirmation can signal the original', async () => {
    const h = await fixture(); h.setEarly(false); let entered!: () => void, unblock!: () => void;
    const started = new Promise<void>(r => { entered = r; }), waiting = new Promise<void>(r => { unblock = r; });
    const get = h.options.hc.get;
    h.options.hc.get = async address => { entered(); await waiting; await get(address); throw Object.assign(new Error('label confirmation failed'), { code: 'release-timeout' }); };
    const jobs = h.monitor(), launching = jobs.start(program, h.owner, 'remote.invalid' as never, {}); void launching.catch(() => {}); await started;
    const address = 'remote.invalid/t2' as TerminalAddress; h.emit({ type: 'restarted', terminal: address, seq: 2, data: { ...h.terminals.get(address)!, state: 'live' } }); unblock();
    await expect(launching).rejects.toMatchObject({ code: 'release-timeout' }); await jobs.shutdown('quit'); expect(h.kills).toEqual([]);
    expect(JSON.parse(await readFile(join(h.f.root, 'sessions/session-one/jobs.json'), 'utf8')).jobs[0]).toMatchObject({ uncertain: true, phase: { kind: 'disconnected', address } });
  });

  it('retains a durable verified result when the receipt transport later disappears', async () => {
    const h = await fixture(); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    h.setOutput({ complete: false, summary: '', receipt: null }); await jobs.detach(handle.id);
    expect(h.notices.map(n => n.details.exitCode)).toEqual([23]);
  });

  it('a valid receipt settles an expired original record after reload', async () => {
    const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, { background: true });
    await jobs.detach(handle.id); await jobs.shutdown('reload'); h.terminals.clear();
    h.setOutput({ complete: true, summary: 'caught up logs', receipt: { jobId: handle.id, nonce: 'private-nonce', finish } });
    await h.monitor().activate({ ...h.owner, generation: 'gen-two' as never }); expect(h.notices.map(n => n.details.exitCode)).toEqual([23]);
  });

  it('an uncertain submission is retained and an observed transcript suppresses replay', async () => {
    const h = await fixture(); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    h.setSubmitFailure(); await expect(jobs.detach(handle.id)).rejects.toThrow('submission uncertain');
    await jobs.shutdown('reload'); h.observed.add(handle.id);
    await h.monitor().activate({ ...h.owner, generation: 'gen-two' as never }); expect(h.notices).toHaveLength(1);
    expect(JSON.parse(await readFile(join(h.f.root, 'sessions/session-one/jobs.json'), 'utf8')).jobs[0].notice).toBe('observed');
  });

  it('shutdown records an in-flight finish without starting another pi turn', async () => {
    const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, { background: true }); await jobs.detach(handle.id);
    let collecting!: () => void, release!: () => void;
    const started = new Promise<void>(r => { collecting = r; }); const blocked = new Promise<void>(r => { release = r; });
    h.options.outputCollector.collect = async () => { collecting(); await blocked; return { complete: true, summary: 'finished', receipt: { jobId: handle.id, nonce: 'private-nonce', finish } }; };
    h.emit({ type: 'finished', terminal: handle.address, seq: 2, data: finish }); await started;
    const stopped = jobs.shutdown('quit'); release(); await stopped;
    expect(h.notices).toEqual([]);
    expect(JSON.parse(await readFile(join(h.f.root, 'sessions/session-one/jobs.json'), 'utf8')).jobs[0]).toMatchObject({ notice: 'pending', phase: { kind: 'finished' } });
  });

  it('ordinary shutdown cancels foreground jobs while reload and detached jobs survive', async () => {
    for (const reason of ['quit', 'reload'] as const) {
      const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
      if (reason === 'quit') { await jobs.detach(handle.id); }
      await jobs.shutdown(reason); expect(h.kills).toEqual([]); expect(h.releases).toEqual([]);
    }
    const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    await jobs.shutdown('quit'); expect(h.kills).toEqual([handle.address]); expect(h.releases).toEqual([]);
  });

  it('refuses a foreign owner and never launches after a failed journal write', async () => {
    const h = await fixture(); const jobs = h.monitor(); await jobs.activate(h.owner);
    await expect(jobs.start(program, { ...h.owner, sessionId: 'other' as never }, 'remote.invalid' as never, {})).rejects.toMatchObject({ code: 'job-owner-mismatch' });
    const store = createJobStore(h.f.root, h.owner.sessionId); const bytes = await readFile(store.path); await unlink(store.path); await symlink(join(h.f.root, 'absent'), store.path);
    try { await expect(jobs.start(program, h.owner, 'remote.invalid' as never, {})).rejects.toThrow(); expect(h.launches).toEqual([]); expect(h.notices).toEqual([]); }
    finally { await unlink(store.path); await writeFile(store.path, bytes); }
  });

  it('registration starts only on session_start and steers job notices to the agent without changing the draft', async () => {
    const h = await fixture(); let bound: JobMonitor | null = null;
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
    const sent: { message: JobNotice; options: unknown }[] = []; let draft = 'unfinished draft';
    const pi = { on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(event, handler); return () => handlers.delete(event); }, sendMessage: (message: JobNotice, options: unknown) => { sent.push({ message, options }); } } as unknown as ExtensionAPI;
    const ctx = { sessionManager: { getBranch: () => [] }, ui: { getEditorText: () => draft, setEditorText: (v: string) => { draft = v; } } } as unknown as ExtensionContext;
    const registration = registerHerdrJobs(pi, { currentOwner: () => h.owner, monitorOptions: () => h.options, bind: value => { bound = value; }, jobIdsForToolResult: () => [] });
    cleanups.push(async () => { await registration.dispose(); }); expect(bound).toBeNull();
    await handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, ctx);
    expect(bound).not.toBeNull();
    const monitor = bound as unknown as JobMonitor; const handle = await monitor.start(program, h.owner, 'remote.invalid' as never, {}); await monitor.detach(handle.id);
    expect(sent[0].message.details.exitCode).toBe(23); expect(sent[0].options).toEqual({ triggerTurn: true, deliverAs: 'steer' }); expect(draft).toBe('unfinished draft');
    await handlers.get('session_shutdown')?.({ type: 'session_shutdown', reason: 'reload' }, ctx); expect(bound).toBeNull();
  });

  it('the journal rejects foreign versions, symlinks and oversized input', async () => {
    const h = await fixture(); const store = createJobStore(h.f.root, h.owner.sessionId); await store.read();
    await writeFile(store.path, JSON.stringify({ version: 2 })); await expect(store.read()).rejects.toThrow();
    await writeFile(store.path, ' '.repeat(1024 * 1024 + 1)); await expect(store.read()).rejects.toMatchObject({ code: 'invalid-journal' });
  });

  it('keeps background, incomplete and unconsumed directories beyond seven days', async () => {
    const h = await fixture(); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, { background: true });
    await jobs.consumeNotice(handle.id); h.setNow(1000 + 8 * 86400000); await jobs.reconcile();
    expect((await stat(handle.localDirectory)).isDirectory()).toBe(true); await vi.waitFor(() => expect(h.removed).toEqual([handle.address]), { timeout: 3500 });
  });

  it('writes a remote settled marker only after known completion and notice consumption', async () => {
    const h = await fixture(); const writes: string[] = []; h.options.hc.fileWrite = async (_on, path) => { if (path.endsWith('/.spider-settled')) writes.push(path); };
    const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    await jobs.reconcile(); expect(writes).toEqual([]);
    await jobs.consumeNotice(handle.id); await vi.waitFor(() => expect(writes).toEqual([join(handle.remoteDirectory, '.spider-settled')]));
  });

  it('a receipt cannot settle a still-live retained original terminal', async () => {
    const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    let resolved = false; void handle.finished.then(() => { resolved = true; });
    h.setOutput({ complete: true, summary: 'logs ready', receipt: { jobId: handle.id, nonce: 'private-nonce', finish } }); await jobs.reconcile();
    expect(resolved).toBe(false); expect(h.notices).toEqual([]);
    h.emit({ type: 'finished', terminal: handle.address, seq: 2, data: finish }); await jobs.reconcile(); expect(await handle.finished).toEqual(finish);
  });

  it('publishes a cached settled notice after remote receipt reads become unavailable', async () => {
    const h = await fixture(); h.setEarly(false); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    h.terminals.delete(handle.address); h.setOutput({ complete: true, summary: 'copied logs', receipt: { jobId: handle.id, nonce: 'private-nonce', finish } }); await jobs.reconcile(); expect(await handle.finished).toEqual(finish); expect(h.notices).toEqual([]);
    await jobs.shutdown('reload'); h.setCollectFailure(); await h.monitor().activate({ ...h.owner, generation: 'gen-two' as never });
    expect(h.notices.map(n => n.details.exitCode)).toEqual([23]);
  });

  it('a verified receipt settles an expired record and marks its directory during reconcile', async () => {
    const h = await fixture(); h.setEarly(false); const writes: string[] = []; h.options.hc.fileWrite = async (_on, path) => { if (path.endsWith('/.spider-settled')) writes.push(path); };
    const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {}); h.terminals.clear();
    h.setOutput({ complete: true, summary: 'complete logs', receipt: { jobId: handle.id, nonce: 'private-nonce', finish } }); await jobs.reconcile();
    await vi.waitFor(() => expect(writes).toEqual([join(handle.remoteDirectory, '.spider-settled')])); expect(h.notices).toEqual([]);
  });

  it('a live or unknown job never gets a remote settled marker across reconcile', async () => {
    const h = await fixture(); h.setEarly(false); const writes: string[] = []; h.options.hc.fileWrite = async (_on, path) => { if (path.endsWith('/.spider-settled')) writes.push(path); };
    const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, { background: true });
    await jobs.detach(handle.id); await jobs.reconcile(); expect(writes).toEqual([]);
    h.emit({ type: 'finished', terminal: handle.address, seq: 2, data: { ...finish, exitCode: 0 } }); await jobs.reconcile(); expect(writes).toEqual([]);
  });

  it('uncertain notice submission preserves the remote directory until observation', async () => {
    const h = await fixture(); const writes: string[] = []; h.options.hc.fileWrite = async (_on, path) => { if (path.endsWith('/.spider-settled')) writes.push(path); };
    const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    h.setSubmitFailure(); await expect(jobs.detach(handle.id)).rejects.toThrow(); await jobs.reconcile(); expect(writes).toEqual([]);
    h.observed.add(handle.id); await jobs.reconcile(); await vi.waitFor(() => expect(writes).toEqual([join(handle.remoteDirectory, '.spider-settled')]));
  });

  it('cleans only consumed complete foreground logs after seven days', async () => {
    const h = await fixture(); const jobs = h.monitor(); const handle = await jobs.start(program, h.owner, 'remote.invalid' as never, {});
    await jobs.consumeNotice(handle.id); await vi.waitFor(() => expect(h.removed).toEqual([handle.address]), { timeout: 3500 }); h.setNow(1000 + 7 * 86400000 + 1); await jobs.reconcile();
    await vi.waitFor(async () => { await expect(access(handle.localDirectory)).rejects.toMatchObject({ code: 'ENOENT' }); });
    await vi.waitFor(() => expect(h.removed).toEqual([handle.address]), { timeout: 3500 });
  });
});
