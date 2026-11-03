// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreId, MachineName, HcClient, HcEvent, JobId, Owner, PreparedProgram, RunId, TerminalAddress, TerminalFinish, TerminalSummary } from '../contracts.js';
import { createJobMonitor, type JobMonitorOptions, type JobNotice } from '../jobs/monitor.js';
import { createJobStore } from '../jobs/store.js';
import { processStartIdentity, createJobHandoff } from '../jobs/handoff.js';
import { createClientFixture } from './testutil.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const program: PreparedProgram = { directory: '/fixture/runtime', argv: ['node', 'runtime.mjs'], files: [], cwd: null, env: {} };
const finish: TerminalFinish = { exitCode: 23, reason: 'exited', signal: null, finishedAt: 1000 };
async function fixture() {
  const f = await createClientFixture(); cleanup.push(f.close);
  const owner = { sessionId: 'owner', generation: 'g1', terminal: { coreId: 'core', terminalId: 't-owner', address: 't-owner', socket: f.localSocket, sessionNamespace: 'fl' }, cwd: f.root, sessionFile: null, name: null } as Owner;
  const listeners = new Set<(event: HcEvent) => void>(), terminals = new Map<TerminalAddress, TerminalSummary>();
  const notices: JobNotice[] = [], launches: Parameters<HcClient['run']>[0][] = [], kills: TerminalAddress[] = [], markers: string[] = [];
  const hc: HcClient = { identity: async () => owner.terminal, caller: async () => owner.terminal, machines: async () => [{ id: 'remote-core' as CoreId, name: 'remote.invalid' as MachineName, aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }], setLabels: async () => {},
    events: () => { let own: ((event: HcEvent) => void) | undefined; return { ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null, subscribe: listener => { own = listener; listeners.add(listener); queueMicrotask(() => listener({ type: 'snapshot', seq: 1, terminals: [...terminals.values()] })); return () => listeners.delete(listener); }, dispose: () => { if (own) listeners.delete(own); } }; },
    run: async request => { launches.push(request); const address = `remote.invalid/t${launches.length}` as TerminalAddress; const terminal: TerminalSummary = { address, parent: owner.terminal.address, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null }; terminals.set(address, terminal); return { address, coreId: 'remote-core' as never }; },
    get: async address => { const terminal = terminals.get(address); if (!terminal) throw Object.assign(new Error('missing'), { code: 'not_found' }); return terminal; }, read: async () => '', kill: async address => { kills.push(address); }, rm: async () => {}, fileRead: async () => Buffer.alloc(0), fileWrite: async (_on, path) => { markers.push(path); },
  };
  const options: JobMonitorOptions = { hc, journalRoot: f.root, clock: () => 1000, observedJobMessages: async () => [], notifier: notice => { notices.push(notice); },
    app: { command: async () => { throw new Error('no app'); }, tabTerminals: async () => [], ownerPlacement: async () => { throw new Error('no pane'); }, awaitPane: async () => { throw new Error('no pane'); } },
    panes: { reserve: async () => ({ id: 'unused' }), observe: async () => ({ viewer: 'unused' as TerminalAddress, release: async () => {} }), abandon: async () => {} },
    outputCollector: { prepare: async (p, job) => ({ program: { ...p, directory: join(f.root, 'remote.invalid', job.id) }, nonce: 'nonce', releaseDeadlineAt: 10000 }), collect: async job => ({ complete: job.phase.kind === 'finished' || Boolean(terminals.get('address' in job.phase ? job.phase.address : '' as TerminalAddress)?.state === 'finished'), summary: 'child output', receipt: terminals.get('address' in job.phase ? job.phase.address : '' as TerminalAddress)?.state === 'finished' ? { jobId: job.id, nonce: 'nonce', finish } : null }) },
  };
  const monitor = (extra: Partial<JobMonitorOptions> = {}) => { const m = createJobMonitor({ ...options, ...extra }); cleanup.push(() => m.shutdown('reload')); return m; };
  const complete = (address: TerminalAddress) => { Object.assign(terminals.get(address)!, { state: 'finished', ...finish }); for (const listener of listeners) listener({ type: 'finished', terminal: address, data: finish, seq: 2 }); };
  return { f, owner, options, monitor, complete, notices, launches, kills, markers };
}
function childRun(id: string, pid = process.pid) { return { id: id as RunId, pid, startIdentity: processStartIdentity(pid)! }; }

describe('remote child handoff', () => {
  it('closes an ended run console and does not close an active sibling console', async () => {
    const h = await fixture(), ended = h.monitor({ child: childRun('ended-run') }), active = h.monitor({ child: childRun('active-run') });
    await ended.start(program, h.owner, 'remote.invalid' as never, { background: true }); await ended.shutdown('quit');
    await active.start(program, h.owner, 'remote.invalid' as never, { background: true });
    const closed: string[] = [];
    const handoff = createJobHandoff({ root: h.f.root, owner: h.owner, hc: h.options.hc, adopt: async () => ({ reconcile: async () => {}, shutdown: async () => {} }), closeAgentConsoles: async owner => { closed.push(owner.runId); } });
    await handoff.reconcile(); await handoff.reconcile();
    expect(closed).toEqual(['ended-run']);
  });
  it('labels child jobs with the top owner and run, using a separate run journal', async () => {
    const h = await fixture(), child = h.monitor({ child: childRun('run-one') });
    const job = await child.start(program, h.owner, 'remote.invalid' as never, { background: true });
    expect(h.launches[0].labels).toMatchObject({ 'spider.session': 'owner', 'spider.owner-terminal': 't-owner', 'spider.run': 'run-one', 'spider.kind': 'exec' });
    expect((await createJobStore(h.f.root, h.owner.sessionId).read()).jobs).toEqual([]);
    expect((await createJobStore(h.f.root, h.owner.sessionId, 'run-one' as RunId).read()).jobs.map(j => j.id)).toEqual([job.id]);
  });
  it('keeps a settled result without transport warnings after the remote runtime prunes its files', async () => {
    const h = await fixture(), errors: unknown[] = [];
    const child = h.monitor({ child: childRun('run-one'), reportError: error => errors.push(error) });
    const job = await child.start(program, h.owner, 'remote.invalid' as never, {}); h.complete(job.address); await child.reconcile(); await child.consumeNotice(job.id);
    h.options.outputCollector.collect = async () => { throw Object.assign(new Error('directory pruned'), { code: 'not_found' }); };
    await child.reconcile(); expect(errors).toEqual([]);
    await child.shutdown('quit'); const parent = h.monitor({ reportError: error => errors.push(error) }); await parent.activate(h.owner);
    expect(errors).toEqual([]); expect(h.notices).toEqual([]);
  });
  it('the child monitor delivers a background notice only to the child while it is alive', async () => {
    const h = await fixture(), childNotices: JobNotice[] = [];
    const child = h.monitor({ child: childRun('run-one'), notifier: notice => { childNotices.push(notice); } });
    const job = await child.start(program, h.owner, 'remote.invalid' as never, { background: true }); await child.detach(job.id);
    const parent = h.monitor(); await parent.activate(h.owner); h.complete(job.address); await child.reconcile(); await parent.reconcile();
    expect(childNotices.map(n => n.details.runId)).toEqual(['run-one']); expect(h.notices).toEqual([]);
  });
  it('parent adopts background and cancels foreground exactly once after a child process is SIGKILLed mid-job', async () => {
    const processChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    cleanup.push(async () => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGKILL'); });
    const exited = new Promise<void>(resolve => processChild.once('exit', () => resolve()));
    const h = await fixture(), child = h.monitor({ child: childRun('run-one', processChild.pid!) });
    const background = await child.start(program, h.owner, 'remote.invalid' as never, { background: true }); await child.detach(background.id);
    const foreground = await child.start(program, h.owner, 'remote.invalid' as never, {});
    // Abandon the extension without a graceful quit, just as a killed process leaves its journal.
    await child.shutdown('reload'); const parent = h.monitor(); await parent.activate(h.owner);
    expect(h.kills).toEqual([]); processChild.kill('SIGKILL'); await exited; await parent.reconcile();
    await vi.waitFor(() => expect(h.kills).toEqual([foreground.address]), { timeout: 5000 });
    h.complete(background.address); await parent.reconcile(); await parent.reconcile();
    await vi.waitFor(() => expect(h.notices.map(n => ({ job: n.details.jobId, run: n.details.runId }))).toEqual([{ job: background.id, run: 'run-one' }]), { timeout: 5000 });
    await vi.waitFor(() => expect(h.markers.filter(path => path.endsWith('.spider-settled'))).toHaveLength(1));
    await parent.shutdown('reload'); const reloaded = h.monitor(); await reloaded.activate({ ...h.owner, generation: 'g2' as never }); await reloaded.reconcile();
    expect(h.notices).toHaveLength(1); await vi.waitFor(() => expect(h.kills).toEqual([foreground.address]), { timeout: 5000 });
  });
  it('parent cancels a foreground launch recovered from labels after the child journal lost its reply', async () => {
    const h = await fixture(), child = h.monitor({ child: childRun('run-one') });
    const job = await child.start(program, h.owner, 'remote.invalid' as never, {}); await child.shutdown('quit');
    const store = createJobStore(h.f.root, h.owner.sessionId, 'run-one' as RunId), journal = await store.read();
    journal.jobs[0].phase = { kind: 'preparing' }; await store.write(journal); h.kills.length = 0;
    const parent = h.monitor(); await parent.activate(h.owner); await parent.reconcile();
    await vi.waitFor(() => expect(h.kills).toEqual([job.address]), { timeout: 5000 });
    await parent.reconcile(); await vi.waitFor(() => expect(h.kills).toEqual([job.address]), { timeout: 5000 });
  });
  it('adopts background work even when the child died before its detach timeout', async () => {
    const h = await fixture(), child = h.monitor({ child: childRun('run-one') });
    const job = await child.start(program, h.owner, 'remote.invalid' as never, { background: true }); await child.shutdown('quit');
    const parent = h.monitor(); await parent.activate(h.owner); await parent.shutdown('quit');
    expect(h.kills).toEqual([]);
    const reloaded = h.monitor(); await reloaded.activate(h.owner); h.complete(job.address); await reloaded.reconcile();
    await vi.waitFor(() => expect(h.notices.map(n => n.details.jobId)).toEqual([job.id]), { timeout: 5000 });
  });
  it('parent reload does not touch a live child job and takes over after graceful child exit', async () => {
    const h = await fixture(), child = h.monitor({ child: childRun('run-one') });
    const job = await child.start(program, h.owner, 'remote.invalid' as never, { background: true }); await child.detach(job.id);
    const parent = h.monitor(); await parent.activate(h.owner); await parent.shutdown('reload');
    const reloaded = h.monitor(); await reloaded.activate({ ...h.owner, generation: 'g2' as never }); expect(h.kills).toEqual([]);
    await child.shutdown('quit'); await reloaded.reconcile(); h.complete(job.address); await reloaded.reconcile();
    await vi.waitFor(() => expect(h.notices.map(n => n.details.jobId)).toEqual([job.id]), { timeout: 5000 });
  });
  it('a child-consumed result is never replayed to the parent on handoff', async () => {
    const h = await fixture(), child = h.monitor({ child: childRun('run-one') });
    const job = await child.start(program, h.owner, 'remote.invalid' as never, {}); h.complete(job.address); await child.reconcile(); await child.consumeNotice(job.id); await child.shutdown('quit');
    const parent = h.monitor(); await parent.activate(h.owner); await parent.reconcile(); expect(h.notices).toEqual([]);
    expect(JSON.parse(await readFile(createJobStore(h.f.root, h.owner.sessionId, 'run-one' as RunId).path, 'utf8')).jobs[0].notice).toBe('observed');
  });
});
