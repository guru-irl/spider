// SPDX-License-Identifier: MIT
import { afterEach } from 'vitest';
import { join } from 'node:path';
import type { CoreId, MachineName, HcClient, HcEvent, JobId, Owner, PreparedProgram, TerminalAddress, TerminalFinish, TerminalSummary } from '../contracts.js';
import { createJobMonitor, type JobMonitor, type JobMonitorOptions, type JobNotice } from '../jobs/monitor.js';
import { createClientFixture, type ClientFixture } from './testutil.js';

export const program: PreparedProgram = { directory: '/fixture/runtime', argv: ['node', 'runtime.mjs'], files: [], cwd: null, env: {} };
export const finish: TerminalFinish = { exitCode: 23, reason: 'exited', signal: null, finishedAt: 1000 };
const cleanups: (() => Promise<unknown> | unknown)[] = [];
export function cleanup(close: () => Promise<unknown> | unknown): void { cleanups.push(close); }
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
});
export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
export async function bounded<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wait did not settle')), ms); })]); }
  finally { clearTimeout(timer); }
}
interface MonitorFixture {
  f: ClientFixture; owner: Owner; hc: HcClient; options: JobMonitorOptions;
  monitor(extra?: Partial<JobMonitorOptions>): JobMonitor;
  terminals: Map<TerminalAddress, TerminalSummary>;
  complete(address: TerminalAddress): void; emit(event: HcEvent): void;
  errors: unknown[]; notices: JobNotice[]; kills: TerminalAddress[];
  liveViews(): number; early(): void;
}
export async function monitorFixture(): Promise<MonitorFixture> {
  const f = await createClientFixture(); cleanup(f.close);
  const owner = { sessionId: 'monitor-session', generation: 'g1', terminal: { coreId: 'core', terminalId: 't-owner', address: 't-owner', socket: f.localSocket, sessionNamespace: 'fl' }, cwd: f.root, sessionFile: null, name: null } as Owner;
  const terminals = new Map<TerminalAddress, TerminalSummary>(), listeners = new Set<(event: HcEvent) => void>();
  const notices: JobNotice[] = [], errors: unknown[] = [], kills: TerminalAddress[] = [];
  let early = false, views = 0, terminalSequence = 0;
  const emit = (event: HcEvent) => { for (const listener of listeners) listener(event); };
  const complete = (address: TerminalAddress) => {
    Object.assign(terminals.get(address)!, { state: 'finished', ...finish });
    emit({ type: 'finished', terminal: address, data: finish, seq: 2 });
  };
  const hc: HcClient = {
    identity: async () => owner.terminal, caller: async () => owner.terminal, machines: async () => [{ id: 'remote-core' as CoreId, name: 'remote.invalid' as MachineName, aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }], setLabels: async () => {},
    events: () => { views++; const subscriptions = new Set<(event: HcEvent) => void>(); return {
      ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null,
      subscribe: listener => { listeners.add(listener); subscriptions.add(listener); return () => { listeners.delete(listener); subscriptions.delete(listener); }; },
      dispose: () => { views--; for (const listener of subscriptions) listeners.delete(listener); subscriptions.clear(); },
    }; },
    run: async request => {
      const address = `remote.invalid/t${++terminalSequence}` as TerminalAddress;
      const terminal: TerminalSummary = { address, parent: owner.terminal.address, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null };
      terminals.set(address, terminal); emit({ type: 'created', terminal: address, data: terminal, seq: 1 });
      if (early) complete(address);
      return { address, coreId: 'remote-core' as never };
    },
    get: async address => { const t = terminals.get(address); if (!t) throw Object.assign(new Error('missing'), { code: 'not_found' }); return t; },
    read: async () => '', kill: async address => { kills.push(address); }, rm: async address => { terminals.delete(address); },
    fileRead: async () => Buffer.alloc(0), fileWrite: async () => {},
  };
  const options: JobMonitorOptions = {
    hc, journalRoot: f.root, clock: () => 1000, observedJobMessages: async () => [], notifier: notice => { notices.push(notice); }, reportError: error => { errors.push(error); },
    outputCollector: {
      prepare: async (p, job) => ({ program: { ...p, directory: join(f.root, 'remote.invalid', job.id) }, nonce: 'nonce', releaseDeadlineAt: 10000 }),
      collect: async job => {
        const done = 'address' in job.phase && terminals.get(job.phase.address)?.state === 'finished';
        return { complete: Boolean(done), summary: done ? 'job output' : '', receipt: done ? { jobId: job.id, nonce: 'nonce', finish } : null };
      },
    },
  };
  const monitor = (extra: Partial<JobMonitorOptions> = {}) => { const m = createJobMonitor({ ...options, ...extra }); cleanup(() => m.shutdown('reload')); return m; };
  return { f, owner, hc, options, monitor, terminals, complete, emit, errors, notices, kills, liveViews: () => views, early: () => { early = true; } };
}
export const on = 'remote.invalid' as Parameters<HcClient['fileRead']>[0];
export const jobId = (value: string): JobId => value as JobId;
