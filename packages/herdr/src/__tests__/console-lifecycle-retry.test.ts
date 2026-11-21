// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HcClient, HcEvent, MachineName, Owner, RunId, TerminalAddress, TerminalSummary } from '../contracts.js';
import { closeAgentConsoles, registerAgentConsoleLifecycle } from '../remote/console.js';
import { HerdrError } from '../client/parse.js';

const owner = (session: string): Owner => ({ sessionId: session, generation: `generation-${session}`, terminal: {
  coreId: 'core', terminalId: 'parent', address: 'parent', socket: '/fixture/core.sock', sessionNamespace: 'fixture',
}, cwd: '/fixture', sessionFile: null, name: session } as Owner);
const A = owner('session-a'), B = owner('session-b');
const copy = (terminal: TerminalSummary): TerminalSummary => ({ ...terminal, labels: { ...terminal.labels } });

function fixture() {
  const terminals = new Map<TerminalAddress, TerminalSummary>();
  const states = new Map([['alpha.invalid', 'connected'], ['beta.invalid', 'connected']]);
  const listeners = new Set<(event: HcEvent) => void>(), hooks = new Map<string, Function>();
  const runEnds = new Map<string, (run: RunId) => void>(), ended = new Set<string>();
  const errors: unknown[] = [], quiet: unknown[] = [], attempts = new Map<string, number>();
  let current = A, onKill: ((terminal: TerminalSummary) => void) | undefined;
  let getError: ((address: TerminalAddress) => unknown | undefined) | undefined;
  let onGet: ((address: TerminalAddress) => Promise<void>) | undefined;
  let ownerCheck: (terminal: TerminalSummary) => Promise<boolean | null> = async () => true;
  let runCheck: (terminal: TerminalSummary) => Promise<boolean | null> = async terminal => ended.has(terminal.labels['spider.run']) ? false : true;
  const emit = (event: HcEvent) => { for (const listener of [...listeners]) listener(event); };
  const notFound = () => Object.assign(new Error('terminal not found'), { code: 'not_found' });
  const hc: HcClient = {
    identity: async () => A.terminal, caller: async () => A.terminal,
    machines: async () => [...states].map(([name, state]) => ({ id: `${name}-core` as never, name: name as MachineName, aliases: [], state: state as 'connected' | 'disconnected', sessionNamespace: 'fixture', runtime: null })),
    events: () => {
      const subscriptions = new Set<(event: HcEvent) => void>();
      return { ready: Promise.resolve(), lookup: async address => terminals.has(address) ? copy(terminals.get(address)!) : null,
        subscribe(listener) {
          listeners.add(listener); subscriptions.add(listener);
          void Promise.resolve().then(() => { if (subscriptions.has(listener)) listener({ type: 'snapshot', seq: 1, terminals: [...terminals.values()].map(copy) }); });
          return () => { listeners.delete(listener); subscriptions.delete(listener); };
        },
        dispose() { for (const listener of subscriptions) listeners.delete(listener); subscriptions.clear(); },
      };
    },
    get: async address => {
      attempts.set(address, (attempts.get(address) ?? 0) + 1);
      await onGet?.(address);
      const error = getError?.(address); if (error) throw error;
      if (states.get(address.split('/')[0]) !== 'connected') throw notFound();
      const terminal = terminals.get(address); if (!terminal) throw notFound(); return copy(terminal);
    },
    kill: async address => { const terminal = terminals.get(address); if (!terminal) throw notFound(); terminal.state = 'finished'; onKill?.(terminal); },
    rm: async address => { if (!terminals.delete(address)) throw notFound(); },
    run: async () => { throw new Error('Use the test inventory'); }, read: async () => '', setLabels: async () => {},
    fileRead: async () => Buffer.alloc(0), fileWrite: async () => {},
  };
  const pi = { on: (name: string, handler: Function) => { hooks.set(name, handler); return () => hooks.delete(name); } } as unknown as ExtensionAPI;
  const life = registerAgentConsoleLifecycle(pi, {
    hc, env: { HC_TERMINAL_ID: 'parent' }, currentOwner: () => current,
    ownerIsLive: terminal => ownerCheck(terminal), runIsLive: terminal => runCheck(terminal),
    subscribeRunEnds: (agent, listener) => { runEnds.set(agent.sessionId, listener); return () => runEnds.delete(agent.sessionId); },
    reportError: error => errors.push(error), reportCleanupError: (error: unknown) => quiet.push(error),
  } as Parameters<typeof registerAgentConsoleLifecycle>[1]);
  const create = (agent: Owner, id: string, machine = 'alpha.invalid', run?: string, notify = true) => {
    const address = `${machine}/${id}` as TerminalAddress;
    const terminal: TerminalSummary = { address, parent: null, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null,
      labels: { 'spider.kind': 'remote-console', 'spider.session': agent.sessionId, 'spider.machine': machine,
        'spider.owner-core': agent.terminal.coreId, 'spider.owner-terminal': agent.terminal.terminalId, ...(run ? { 'spider.run': run } : {}) } };
    terminals.set(address, terminal);
    if (notify) emit({ type: 'created', seq: 2, terminal: address, data: copy(terminal) });
    return address;
  };
  return {
    hc, terminals, errors, quiet, attempts, create,
    useOwner: (value: Owner) => { current = value; },
    online: (machine: string, connected: boolean) => { states.set(machine, connected ? 'connected' : 'disconnected'); },
    signalInventory: () => emit({ type: 'missed', seq: 3, terminals: [] }),
    replay: (address: TerminalAddress) => emit({ type: 'created', seq: 4, terminal: address, data: copy(terminals.get(address)!) }),
    finish: (session: Owner, run: string) => { ended.add(run); runEnds.get(session.sessionId)?.(run as RunId); },
    markEnded: (run: string) => { ended.add(run); },
    onKill: (handler: (terminal: TerminalSummary) => void) => { onKill = handler; },
    getError: (handler: ((address: TerminalAddress) => unknown | undefined) | undefined) => { getError = handler; },
    onGet: (handler: (address: TerminalAddress) => Promise<void>) => { onGet = handler; },
    ownerCheck: (handler: typeof ownerCheck) => { ownerCheck = handler; },
    runCheck: (handler: typeof runCheck) => { runCheck = handler; },
    start: async (reason = 'startup') => hooks.get('session_start')?.({ reason }, {} as ExtensionContext),
    shutdown: async (reason = 'quit') => hooks.get('session_shutdown')?.({ reason }, {} as ExtensionContext),
    dispose: () => life.dispose(),
  };
}

const fixtures: ReturnType<typeof fixture>[] = [];
function makeFixture() { const f = fixture(); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); vi.useRealTimers(); });
function fakeClock() { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); }
async function settle() { await vi.advanceTimersByTimeAsync(0); }

it.each(['new', 'resume', 'fork'])('keeps the replacement session lifecycle after an offline %s close', async reason => {
  fakeClock(); const f = makeFixture(); await f.start();
  const old = f.create(A, 'old'); f.online('alpha.invalid', false); f.useOwner(B);
  let startupError: unknown, shutdownError: unknown;
  try { await f.start(reason); } catch (error) { startupError = error; }
  f.online('alpha.invalid', true);
  const next = f.create(B, 'next');
  try { await f.shutdown(); } catch (error) { shutdownError = error; }
  // The original regression leaves the new console live even though quit completed.
  expect(f.terminals.has(next)).toBe(false);
  expect(startupError).toBeUndefined(); expect(shutdownError).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2500);
  expect(f.terminals.has(old)).toBe(false);
  expect(f.quiet.length).toBeGreaterThan(0); expect(f.errors).toEqual([]);
});

it('installs the replacement startup scan and run-end watcher after a failed close', async () => {
  fakeClock(); const f = makeFixture(); await f.start();
  f.create(A, 'old'); f.online('alpha.invalid', false); f.useOwner(B);
  f.markEnded('finished-before-start');
  const atStart = f.create(B, 'startup', 'beta.invalid', 'finished-before-start', false);
  await expect(f.start('new')).resolves.toBeUndefined();
  expect(f.terminals.has(atStart)).toBe(false);
  const late = f.create(B, 'late', 'beta.invalid', 'finished-later'); await settle();
  expect(f.terminals.has(late)).toBe(true);
  f.finish(B, 'finished-later'); await settle();
  expect(f.terminals.has(late)).toBe(false);
});

it('cancels a pending replacement close if the old session is resumed', async () => {
  fakeClock(); const f = makeFixture(); await f.start();
  const address = f.create(A, 'resumed'); f.online('alpha.invalid', false); f.useOwner(B);
  await expect(f.start('new')).resolves.toBeUndefined();
  f.useOwner(A); await f.start('resume');
  f.online('alpha.invalid', true); f.signalInventory(); await vi.advanceTimersByTimeAsync(65000);
  expect(f.terminals.get(address)?.state).toBe('live');
});

it('keeps a failed replacement close pending through a reload event', async () => {
  fakeClock(); const f = makeFixture(); await f.start();
  const address = f.create(A, 'reload-pending'); f.online('alpha.invalid', false); f.useOwner(B); await f.start('new');
  await f.shutdown('reload'); await f.start('reload');
  f.online('alpha.invalid', true); f.signalInventory(); await vi.advanceTimersByTimeAsync(2500);
  expect(f.terminals.has(address)).toBe(false);
});

it('does not close a console if its session resumes during a queued lookup', async () => {
  fakeClock(); const f = makeFixture(); await f.start();
  const address = f.create(A, 'close-inflight'); f.online('alpha.invalid', false); f.useOwner(B); await f.start('new');
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.onGet(async target => { if (target === address) { entered(); await held; } });
  try {
    f.online('alpha.invalid', true); f.signalInventory(); await settle(); await started;
    f.useOwner(A); await f.start('resume'); release(); await settle();
    expect(f.terminals.get(address)?.state).toBe('live');
  } finally { release(); }
}, 5000);

it('does not reap a queued former orphan after its session resumes', async () => {
  fakeClock(); const f = makeFixture();
  const address = f.create(A, 'orphan', 'alpha.invalid', undefined, false);
  f.online('alpha.invalid', false); f.ownerCheck(async () => false); f.useOwner(B);
  await f.start('startup');
  f.useOwner(A); await f.start('resume');
  f.online('alpha.invalid', true); f.signalInventory(); await vi.advanceTimersByTimeAsync(2500);
  expect(f.terminals.get(address)?.state).toBe('live');
});

it('does not kill a queued orphan if its session resumes during lookup', async () => {
  fakeClock(); const f = makeFixture();
  const address = f.create(A, 'orphan-inflight', 'alpha.invalid', undefined, false);
  f.online('alpha.invalid', false); f.ownerCheck(async () => false); f.useOwner(B); await f.start('startup');
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.onGet(async target => { if (target === address) { entered(); await held; } });
  try {
    f.online('alpha.invalid', true); f.signalInventory(); await settle(); await started;
    f.useOwner(A); await f.start('resume'); release(); await settle();
    expect(f.terminals.get(address)?.state).toBe('live');
  } finally { release(); }
}, 5000);

it('rechecks a queued run when its owning session resumes during liveness lookup', async () => {
  fakeClock(); const f = makeFixture();
  const address = f.create(A, 'run-inflight', 'alpha.invalid', 'live-run', false);
  let resumed = false, hold = false, release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.ownerCheck(async () => false);
  f.runCheck(async () => { const result = resumed ? true : null; if (hold) { entered(); await held; } return result; });
  f.online('alpha.invalid', false); f.useOwner(B); await f.start('startup');
  try {
    hold = true; f.online('alpha.invalid', true); f.signalInventory(); await settle(); await started;
    resumed = true; f.useOwner(A); await f.start('resume'); hold = false; release(); await settle();
    expect(f.terminals.get(address)?.state).toBe('live');
  } finally { release(); }
}, 5000);

it('retries a failed quit close while the lifecycle is still alive', async () => {
  fakeClock(); const f = makeFixture(); await f.start();
  const address = f.create(A, 'quit'); f.online('alpha.invalid', false);
  await expect(f.shutdown()).resolves.toBeUndefined(); await settle();
  expect(f.terminals.has(address)).toBe(true);
  f.online('alpha.invalid', true); f.signalInventory(); await vi.advanceTimersByTimeAsync(2500);
  expect(f.terminals.has(address)).toBe(false);
  expect(f.quiet.length).toBeGreaterThan(0); expect(f.errors).toEqual([]);
});

it.each(['spider.kind', 'spider.session', 'spider.run'])('does not remove a console relabelled after kill in closeAgentConsoles: %s', async label => {
  const f = makeFixture(), address = f.create(A, 'close-relabel', 'alpha.invalid', 'run', false);
  f.onKill(terminal => { terminal.labels = { ...terminal.labels, [label]: 'foreign' }; });
  await closeAgentConsoles({ ...A, runId: 'run' as RunId }, f.hc);
  expect(f.terminals.get(address)).toMatchObject({ state: 'finished', labels: { [label]: 'foreign' } });
});

it.each(['spider.kind', 'spider.session', 'spider.run'])('does not remove a console relabelled after kill in the lifecycle reaper: %s', async label => {
  const f = makeFixture(), address = f.create(A, 'reap-relabel', 'alpha.invalid', 'run', false);
  f.markEnded('run'); f.onKill(terminal => { terminal.labels = { ...terminal.labels, [label]: 'foreign' }; });
  await f.start();
  expect(f.terminals.get(address)).toMatchObject({ state: 'finished', labels: { [label]: 'foreign' } });
});

it.each(['not_found', 'ENOENT', 'other'])('preserves a %s liveness error and retries the original check', async code => {
  fakeClock(); const f = makeFixture(), address = f.create(A, 'liveness', 'alpha.invalid', 'run', false);
  const error = Object.assign(new Error('owner check failed'), { code }); let failing = true;
  f.ownerCheck(async () => { if (failing) throw error; return true; }); f.markEnded('run');
  await f.start(); await settle();
  expect(f.terminals.has(address)).toBe(true);
  expect(f.quiet).toContain(error); expect(f.errors).toEqual([]);
  failing = false; await vi.advanceTimersByTimeAsync(30000);
  expect(f.terminals.has(address)).toBe(false);
});

it('does not treat a console get ENOENT as a definite missing terminal', async () => {
  fakeClock(); const f = makeFixture(), address = f.create(A, 'get-error', 'alpha.invalid', 'run', false);
  const error = Object.assign(new Error('client executable is missing'), { code: 'ENOENT' }); let failing = true;
  f.getError(value => value === address && failing ? error : undefined); f.markEnded('run');
  await f.start(); await settle();
  expect(f.terminals.has(address)).toBe(true);
  expect(f.quiet).toContain(error);
  failing = false; await vi.advanceTimersByTimeAsync(30000);
  expect(f.terminals.has(address)).toBe(false);
});

it('bounds console cleanup wakeups when machine metadata flaps but the destination stays offline', async () => {
  fakeClock(); vi.setSystemTime(0);
  const f = makeFixture(); await f.start();
  const address = f.create(A, 'flapping', 'alpha.invalid', 'flapping-run');
  f.getError(target => target === address ? new HerdrError('unavailable', 'Destination unavailable') : undefined);
  f.online('alpha.invalid', false); f.finish(A, 'flapping-run'); await settle();
  const before = f.attempts.get(address) ?? 0; expect(before).toBeGreaterThan(0);
  for (let i = 0; i < 10; i++) {
    f.online('alpha.invalid', true); f.signalInventory(); await settle();
    f.online('alpha.invalid', false); f.signalInventory(); await settle();
    await vi.advanceTimersByTimeAsync(2000);
  }
  expect((f.attempts.get(address) ?? 0) - before).toBe(1);
  expect(f.terminals.has(address)).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  f.online('alpha.invalid', true); f.signalInventory(); await settle();
  expect((f.attempts.get(address) ?? 0) - before).toBe(2);
});

it('retries only the reconnected machine without bypassing a connected machine backoff', async () => {
  fakeClock(); const f = makeFixture(); await f.start();
  const alpha = f.create(A, 'alpha', 'alpha.invalid', 'alpha-run');
  const beta = f.create(A, 'beta', 'beta.invalid', 'beta-run');
  const error = new Error('beta is connected but cleanup failed');
  f.online('alpha.invalid', false); f.getError(address => address === beta ? error : undefined);
  f.finish(A, 'alpha-run'); f.finish(A, 'beta-run'); await settle();
  const betaAttempts = f.attempts.get(beta);
  expect(f.terminals.has(alpha)).toBe(true); expect(f.terminals.has(beta)).toBe(true);
  f.online('alpha.invalid', true); f.signalInventory(); await vi.advanceTimersByTimeAsync(2500);
  expect(f.terminals.has(alpha)).toBe(false);
  expect(f.attempts.get(beta)).toBe(betaAttempts);
  await vi.advanceTimersByTimeAsync(27499);
  expect(f.attempts.get(beta)).toBe(betaAttempts);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.attempts.get(beta)).toBeGreaterThan(betaAttempts!);
});

it('counts one failed liveness check only once when duplicate events arrive concurrently', async () => {
  fakeClock(); const f = makeFixture(); await f.start();
  const address = f.create(A, 'duplicate-events', 'alpha.invalid', 'run', false); f.markEnded('run');
  let release!: () => void, failing = true;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.ownerCheck(async () => { if (failing) { await held; throw new Error('one failed check'); } return true; });
  for (let i = 0; i < 30; i++) f.replay(address);
  await Promise.resolve(); failing = false; release(); await settle();
  expect(f.quiet.filter(value => (value as { code?: string }).code === 'console-cleanup-exhausted')).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.terminals.has(address)).toBe(false);
});

it('keeps console cleanup through repeated connectivity failures and removes it after recovery', async () => {
  fakeClock(); const f = makeFixture(); await f.start();
  const machine = 'box-1.invalid', address = f.create(A, 'offline', machine, 'run');
  f.online(machine, true);
  let offline = true;
  f.getError(value => value === address && offline ? new HerdrError('cli-timeout', 'Destination timed out') : undefined);
  f.finish(A, 'run'); await settle();
  for (let i = 0; i < 30; i++) {
    f.online(machine, false); f.signalInventory(); await settle();
    f.online(machine, true); f.signalInventory(); await vi.advanceTimersByTimeAsync(60_000);
  }
  expect(f.attempts.get(address)).toBeGreaterThan(24);
  expect(f.terminals.has(address)).toBe(true);
  expect(f.quiet.filter(value => (value as { code?: string }).code === 'console-cleanup-exhausted')).toHaveLength(0);
  expect(f.quiet).toHaveLength(1);
  offline = false;
  f.online(machine, false); f.signalInventory(); await settle();
  f.online(machine, true); f.signalInventory(); await settle();
  expect(f.terminals.has(address)).toBe(false);
  expect(f.errors).toEqual([]);
});

it('keeps cleanup after repeated disconnected inventory results', async () => {
  fakeClock(); const f = makeFixture(); await f.start();
  const machine = 'box-1.invalid', address = f.create(A, 'disconnected', machine, 'run');
  let offline = true; f.online(machine, false);
  f.onGet(async value => { if (value === address && offline) f.online(machine, false); });
  f.finish(A, 'run'); await settle();
  for (let i = 0; i < 30; i++) {
    f.online(machine, false); f.signalInventory(); await settle();
    f.online(machine, true); f.signalInventory(); await settle();
    await vi.advanceTimersByTimeAsync(30_000);
  }
  expect(f.attempts.get(address)).toBeGreaterThan(24);
  expect(f.terminals.has(address)).toBe(true);
  expect(f.quiet.filter(value => (value as { code?: string }).code === 'console-cleanup-exhausted')).toHaveLength(0);
  expect(f.quiet).toHaveLength(1);
  offline = false; f.online(machine, false); f.signalInventory(); await settle();
  f.online(machine, true); f.signalInventory(); await settle();
  expect(f.terminals.has(address)).toBe(false);
});

it.each([
  ['generic failure', new Error('permanent cleanup failure')],
  ['identity mismatch', new HerdrError('caller-mismatch', 'Wrong terminal identity while offline')],
])('bounds retries for one console after a %s even if the machine repeatedly reconnects', async (_kind, error) => {
  fakeClock(); const f = makeFixture(); await f.start();
  const address = f.create(A, 'exhausted', 'alpha.invalid', 'run');
  f.getError(value => value === address ? error : undefined);
  f.finish(A, 'run'); await settle();
  for (let i = 0; i < 30; i++) {
    f.online('alpha.invalid', false); f.signalInventory(); await settle();
    f.online('alpha.invalid', true); f.signalInventory(); await settle();
  }
  const attempts = f.attempts.get(address)!;
  expect(attempts).toBeLessThanOrEqual(24);
  expect(f.terminals.has(address)).toBe(true);
  expect(f.quiet.filter(value => (value as { code?: string }).code === 'console-cleanup-exhausted')).toHaveLength(1);
  f.signalInventory(); await vi.advanceTimersByTimeAsync(8 * 3600000);
  expect(f.attempts.get(address)).toBe(attempts); expect(f.errors).toEqual([]);
});
