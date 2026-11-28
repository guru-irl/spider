// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { createClientFixture } from './testutil.js';
import { createJobMonitor, type JobMonitor, type JobNotice } from '../jobs/monitor.js';
import { createJobStore } from '../jobs/store.js';
import { createJobHandoff, processStartIdentity } from '../jobs/handoff.js';
import type { HcClient, Owner, JobId, TerminalAddress, TerminalSummary, RunId } from '../contracts.js';
import { scenario } from './child-remote-scenario.js';

it('real Node child runs direct exec against fake hc and hands off a background job after SIGKILL', async () => { await scenario('fake'); }, 45000);
const hcAvailable = await access(process.env.SPIDER_HERDR_HC_BINARY ?? join(homedir(), '.local/bin/hc')).then(() => true, () => false);
it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !hcAvailable)('real Node child runs on an isolated hc fake remote and parent posts one notice after child exit (requires SPIDER_HERDR_E2E=1 and hc; no app window)', async () => { await scenario('hc'); }, 45000);

it('handoff releases a settled run monitor and never re-adopts it after reload', async () => {
  const f = await createClientFixture();
  const owner = { sessionId: 'owner', generation: 'g1', terminal: { coreId: 'core', terminalId: 't-owner', address: 't-owner', socket: f.localSocket, sessionNamespace: 'fl' }, cwd: f.root, sessionFile: null, name: null } as Owner;
  const runId = 'ended-run' as RunId, store = createJobStore(f.root, owner.sessionId, runId);
  const finish = { exitCode: 0, reason: 'exited', signal: null, finishedAt: 1000 };
  const journal = await store.read();
  journal.child = { id: runId, pid: process.pid, startIdentity: 'ended', ended: true };
  journal.jobs = [{ version: 1, id: 'job' as JobId, runId, owner, machine: 'remote.invalid' as never, kind: 'exec', phase: { kind: 'finished', address: 'remote.invalid/t1' as TerminalAddress, result: finish }, viewer: null, localDirectory: join(store.directory, 'logs/job'), remoteDirectory: join(f.root, 'program'), detached: true, noticeMode: 'async', notice: 'pending', nonce: 'nonce', releaseDeadlineAt: 10000, originalFinish: finish, output: { complete: true, summary: 'done' }, callerOwned: true, uncertain: false, evidenceConflict: false, noticeDelivered: false, settledMarked: false, terminalExpired: false, updatedAt: 1000 }];
  await store.write(journal);
  const adopted: string[] = [], stopped: string[] = [], consoles: string[] = [];
  const options = { root: f.root, owner, hc: {} as HcClient,
    closeAgentConsoles: async (o: Owner & { runId: RunId }) => { consoles.push(o.runId); },
    adopt: async (id: RunId) => { adopted.push(id); return {
      reconcile: async () => { const j = await store.read(); j.jobs[0].settledMarked = true; j.jobs[0].noticeDelivered = true; j.jobs[0].notice = 'observed'; j.jobs[0].terminalReleased = true; await store.write(j); },
      shutdown: async (reason: 'quit' | 'reload') => { stopped.push(reason); },
    }; },
  };
  const handoff = createJobHandoff(options);
  try {
    await handoff.reconcile(); expect(stopped).toEqual(['reload']);
    expect((await store.read()).child).toMatchObject({ settled: true });
    const bytes = await readFile(store.path, 'utf8'); await handoff.reconcile();
    expect(await readFile(store.path, 'utf8')).toBe(bytes);
    await handoff.shutdown('reload'); const reloaded = createJobHandoff(options); await reloaded.reconcile(); await reloaded.shutdown('reload');
    expect(adopted).toEqual([runId]); expect(consoles).toEqual([runId]); expect(stopped).toEqual(['reload']);
  } finally { await handoff.shutdown('reload'); await f.close(); }
});

it('an adopted monitor uses no periodic timer and leaves unchanged journal bytes intact', async () => {
  const f = await createClientFixture();
  const owner = { sessionId: 'owner', generation: 'g1', terminal: { coreId: 'core', terminalId: 't-owner', address: 't-owner', socket: f.localSocket, sessionNamespace: 'fl' }, cwd: f.root, sessionFile: null, name: null } as Owner;
  const runId = 'ended-run' as RunId, store = createJobStore(f.root, owner.sessionId, runId), journal = await store.read();
  journal.child = { id: runId, pid: process.pid, startIdentity: 'ended', ended: true }; await store.write(journal);
  let disposed = false;
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected hc call for settled jobs'); };
  const hc: HcClient = { identity: async () => owner.terminal, caller: async () => owner.terminal, machines: async () => [], run: unexpected, get: unexpected, read: unexpected, kill: unexpected, rm: unexpected, fileRead: unexpected, fileWrite: unexpected, setLabels: unexpected, events: () => ({ ready: Promise.resolve(), lookup: async () => null, subscribe: () => () => {}, dispose: async () => { disposed = true; } }) };
  const monitor = createJobMonitor({ hc, adoptedRunId: runId, journalRoot: f.root, clock: () => 1000, observedJobMessages: async () => [], notifier: () => {}, outputCollector: { prepare: async () => { throw new Error('no launch'); }, collect: async () => { throw new Error('no jobs'); } } });
  vi.useFakeTimers();
  try {
    await monitor.activate(owner); expect(vi.getTimerCount()).toBe(0);
    const before = await readFile(store.path, 'utf8'); await monitor.reconcile(); await monitor.reconcile();
    expect(await readFile(store.path, 'utf8')).toBe(before);
    await monitor.shutdown('reload'); expect(disposed).toBe(true);
  } finally { await monitor.shutdown('reload'); vi.useRealTimers(); await f.close(); }
});

it.each(['activation', 'periodic'] as const)('an unreachable ended child discovered at %s does not delay launches or a settled sibling', async trigger => {
  const f = await createClientFixture();
  const owner = { sessionId: 'owner', generation: 'g1', terminal: { coreId: 'core', terminalId: 't-owner', address: 't-owner', socket: f.localSocket, sessionNamespace: 'fl' }, cwd: f.root, sessionFile: null, name: null } as Owner;
  const terminals = new Map<TerminalAddress, TerminalSummary>(); let launches = 0, blocked = false;
  let unblock!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; }), stuckEntered = new Promise<void>(resolve => { entered = resolve; });
  const hc: HcClient = { identity: async () => owner.terminal, caller: async () => owner.terminal, machines: async () => [], setLabels: async () => {},
    events: () => ({ ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null, subscribe: () => () => {}, dispose: async () => {} }),
    run: async request => { const address = `${request.on}/t${++launches}` as TerminalAddress; terminals.set(address, { address, parent: owner.terminal.address, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null }); return { address, coreId: 'remote' as never }; },
    get: async address => { const row = terminals.get(address); if (!row) throw Object.assign(new Error('missing'), { code: 'not_found' }); return row; }, read: async () => '', kill: async () => {}, rm: async () => {}, fileRead: async () => Buffer.alloc(0), fileWrite: async () => {},
  };
  const finish = { exitCode: 0, reason: 'exited', signal: null, finishedAt: Date.now() };
  const observed: JobId[] = [];
  const options = { hc, journalRoot: f.root, clock: Date.now, observedJobMessages: async () => observed, notifier: (notice: JobNotice) => { observed.push(notice.details.jobId); },
    closeAgentConsoles: async (child: Owner & { runId: RunId }) => { if (trigger === 'periodic' && blocked && child.runId === 'a-stuck') { entered(); await barrier; } },
    outputCollector: { prepare: async (program: import('../contracts.js').PreparedProgram) => ({ program, nonce: 'nonce', releaseDeadlineAt: Date.now() + 10000 }),
      collect: async (job: import('../contracts.js').JobRecord) => { if (trigger === 'activation' && blocked && job.machine === 'stuck.invalid') { entered(); await barrier; } const done = 'address' in job.phase && terminals.get(job.phase.address)?.state === 'finished'; return { complete: done, summary: done ? 'done' : '', receipt: done ? { jobId: job.id, nonce: 'nonce', finish } : null }; },
    },
  };
  const children = ['a-stuck', 'b-healthy'].map(id => createJobMonitor({ ...options, child: { id: id as RunId, pid: process.pid, startIdentity: processStartIdentity(process.pid)! } })), parent = createJobMonitor(options);
  let activation: Promise<void> | undefined, starting: ReturnType<JobMonitor['start']> | undefined;
  const within = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    const program = async () => ({ directory: join(f.root, 'programs', randomBytes(16).toString('hex')), argv: ['node'], files: [], cwd: null, env: {} });
    if (trigger === 'periodic') await parent.activate(owner);
    const stuck = await children[0].start(program, owner, 'stuck.invalid' as never, { background: true }); await children[0].detach(stuck.id);
    const healthy = await children[1].start(program, owner, 'healthy.invalid' as never, { background: true }); await children[1].detach(healthy.id);
    for (const child of children) await child.shutdown('quit');
    Object.assign(terminals.get(healthy.address)!, { state: 'finished', ...finish }); blocked = true;
    if (trigger === 'activation') { activation = parent.activate(owner); void activation.catch(() => {}); }
    // In the periodic case no explicit reconcile may discover the ended runs.
    await within(stuckEntered, 6000, 'Ended-run check did not reach the stuck child');
    starting = parent.start(program, owner, 'healthy.invalid' as never, { background: true });
    const launched = await within(starting, trigger === 'periodic' ? 5000 : 1000, 'New remote launch waited behind an unreachable child');
    expect(launched.address).toBe('healthy.invalid/t3');
    const healthyStore = createJobStore(f.root, owner.sessionId, 'b-healthy' as RunId);
    await expect.poll(async () => (await healthyStore.read()).child?.settled, { timeout: 5000 }).toBe(true);
  } finally { unblock(); await activation?.catch(() => {}); await starting?.catch(() => {}); await parent.shutdown('reload'); for (const child of children) await child.shutdown('reload'); await f.close(); }
}, 15000);
