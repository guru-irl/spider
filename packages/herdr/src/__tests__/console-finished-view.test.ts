// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { join } from 'node:path';
import { ensureAgentConsole, openAgentConsoleView, type AgentConsoleLaunch } from '../remote/console.js';
import { parseRuntimePublication } from '../remote/runtime.js';
import type { CoreId, HcClient, HcRunRequest, JobHandle, MachineName, Owner, TerminalAddress, TerminalSummary } from '../contracts.js';

type Operation = ['get' | 'kill' | 'rm' | 'run', TerminalAddress];

function fixture() {
  const owner = { sessionId: 'session-one', generation: 'generation-one', name: 'Writer', cwd: '/fixture', sessionFile: null,
    terminal: { coreId: 'owner-core', terminalId: 'owner-terminal', address: 'box-1.invalid/owner-terminal', socket: '/fixture/core.sock', sessionNamespace: 'fixture' } } as Owner;
  const on = 'box-2.invalid' as MachineName, core = 'console-core' as CoreId;
  const request: AgentConsoleLaunch = { owner, on, target: { on, cwd: null, directory: '/fixture/remote', commands: {}, environment: {},
    nodePath: '/fixture/node', runtimePath: '/fixture/runtime.mjs', runtimeSha256: 'a'.repeat(64) }, source: { kind: 'code', language: 'shell', code: 'echo output' } };
  const env = { HC_TERMINAL_ID: 'owner-terminal' };
  const terminals = new Map<TerminalAddress, TerminalSummary>(), files = new Map<string, Buffer>();
  const operations: Operation[] = [], launches: HcRunRequest[] = [], errors: unknown[] = [];
  let afterSnapshot: (() => void) | undefined, removeFailure: Error | undefined;
  const missing = () => Object.assign(new Error('missing'), { code: 'not_found' });
  const hc: HcClient = {
    identity: async () => ({ coreId: core, socket: '/fixture/console.sock', sessionNamespace: 'fixture' }),
    caller: async () => { throw new Error('No caller lookup'); },
    machines: async () => [{ id: core, name: on, aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }],
    run: async input => {
      launches.push(input); const address = `${on}/console-${launches.length}` as TerminalAddress;
      operations.push(['run', address]);
      terminals.set(address, { address, parent: null, state: 'live', labels: { ...input.labels }, status: null, exitCode: null, reason: null, signal: null, finishedAt: null });
      return { address, coreId: core };
    },
    get: async address => {
      operations.push(['get', address]); const terminal = terminals.get(address); if (!terminal) throw missing();
      return { ...terminal, labels: { ...terminal.labels } };
    },
    kill: async address => {
      operations.push(['kill', address]); const terminal = terminals.get(address); if (!terminal) throw missing();
      terminals.set(address, { ...terminal, state: 'finished', exitCode: 0, reason: 'exited', finishedAt: 1 });
    },
    rm: async address => {
      operations.push(['rm', address]); if (removeFailure) throw removeFailure;
      if (!terminals.delete(address)) throw missing();
    },
    read: async () => '', setLabels: async () => { throw new Error('Unexpected label write'); },
    fileRead: async (_on, file) => { const value = files.get(file); if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return value; },
    fileWrite: async (_on, file, bytes) => { files.set(file, bytes); },
    events: () => ({ ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null,
      subscribe: listener => {
        const snapshot = [...terminals.values()].map(terminal => ({ ...terminal, labels: { ...terminal.labels } }));
        listener({ type: 'snapshot', seq: 1, terminals: snapshot });
        const change = afterSnapshot; afterSnapshot = undefined; change?.(); return () => {};
      }, dispose: () => {} }),
  };
  const open = (changes: Partial<AgentConsoleLaunch> = {}, displayLeaseFile = '/fixture/display-lease.json') =>
    openAgentConsoleView({ ...request, ...changes, reportError: error => { errors.push(error); }, displayLeaseFile }, hc, env);
  const finish = (address: TerminalAddress) => {
    const terminal = terminals.get(address)!;
    terminals.set(address, { ...terminal, state: 'finished', exitCode: 0, reason: 'exited', finishedAt: 1 });
  };
  return { request, env, hc, terminals, files, operations, launches, errors, open, finish,
    onSnapshot: (change: () => void) => { afterSnapshot = change; },
    failRemove: (error: Error) => { removeFailure = error; } };
}

function job(id: string): JobHandle {
  return { id: id as JobHandle['id'], address: `box-2.invalid/${id}` as TerminalAddress, remoteDirectory: `/fixture/${id}`,
    localDirectory: `/fixture/local-${id}`, finished: new Promise(() => {}), cancel: async () => {} };
}

test.each([
  { name: 'without an idle probe', isConsoleIdle: undefined },
  { name: 'while a payload is active', isConsoleIdle: async () => false },
])('replaces a finished current-runtime view $name', async ({ isConsoleIdle }) => {
  const f = fixture(), first = (await f.open())!;
  await ensureAgentConsole({ ...f.request, job: job('job-one') }, f.hc, f.env);
  await ensureAgentConsole({ ...f.request, job: job('job-two') }, f.hc, f.env);
  f.finish(first.address); const before = f.operations.length;
  const second = (await f.open({ isConsoleIdle }, '/fixture/new-display-lease.json'))!;

  expect(second.address).not.toBe(first.address);
  expect(second.consoleId).toBe(first.consoleId);
  expect(second.directory).toBe(first.directory);
  expect(f.operations.slice(before)).toEqual([['get', first.address], ['rm', first.address], ['run', second.address]]);
  expect(f.terminals.has(first.address)).toBe(false);
  expect(f.terminals.get(second.address)).toMatchObject({ state: 'live', labels: {
    'spider.kind': 'remote-console', 'spider.session': 'session-one', 'spider.owner-core': 'owner-core',
    'spider.owner-terminal': 'owner-terminal', 'spider.machine': 'box-2.invalid', 'spider.runtime': 'a'.repeat(64),
    'spider.console-id': first.consoleId, 'spider.view-generation': 'generation-one',
  } });
  expect(parseRuntimePublication(f.files.get(join(second.directory, 'console.json'))!)).toMatchObject({ start: 2 });
  expect(parseRuntimePublication(f.files.get(join(second.directory, 'head.json'))!)).toMatchObject({ count: 2 });
  expect(parseRuntimePublication(f.files.get(join(second.directory, 'view-lease.json'))!)).toMatchObject({ file: '/fixture/new-display-lease.json', consoleId: first.consoleId });
  expect(f.launches[1].argv).toContain('/fixture/new-display-lease.json');
  expect(f.errors).toEqual([]);
});

test('serializes concurrent opens of a finished view into one replacement', async () => {
  const f = fixture(), first = (await f.open())!; f.finish(first.address); const before = f.operations.length;
  const [a, b] = await Promise.all([f.open(), f.open()]);
  expect(a!.address).not.toBe(first.address);
  expect(b!.address).toBe(a!.address);
  expect(f.operations.slice(before)).toEqual([['get', first.address], ['rm', first.address], ['run', a!.address]]);
  expect(f.terminals.has(first.address)).toBe(false);
  expect(f.terminals.get(a!.address)?.state).toBe('live');
  expect(f.launches).toHaveLength(2);
});

test('replaces a finished view that disappears after the snapshot', async () => {
  const f = fixture(), first = (await f.open())!; f.finish(first.address); const before = f.operations.length;
  f.onSnapshot(() => { f.terminals.delete(first.address); });
  const second = (await f.open())!;
  expect(second.address).not.toBe(first.address);
  expect(f.operations.slice(before)).toEqual([['get', first.address], ['run', second.address]]);
  expect(f.terminals.get(second.address)?.state).toBe('live');
  expect(parseRuntimePublication(f.files.get(join(second.directory, 'console.json'))!)).toMatchObject({ start: 0 });
  expect(f.errors).toEqual([]);
});

test('replaces a finished view that disappears during removal', async () => {
  const f = fixture(), first = (await f.open())!; f.finish(first.address); const before = f.operations.length;
  const remove = f.hc.rm;
  f.hc.rm = async address => { f.terminals.delete(address); await remove(address); };
  const second = (await f.open())!;
  expect(second.address).not.toBe(first.address);
  expect(f.operations.slice(before)).toEqual([['get', first.address], ['rm', first.address], ['run', second.address]]);
  expect(f.terminals.get(second.address)?.state).toBe('live');
  expect(f.errors).toEqual([]);
});

test.each(['spider.owner-core', 'spider.owner-terminal'])('refuses a finished view with a different %s', async label => {
  const f = fixture(), first = (await f.open())!; f.finish(first.address); const before = f.operations.length;
  const terminal = f.terminals.get(first.address)!;
  f.terminals.set(first.address, { ...terminal, labels: { ...terminal.labels, [label]: 'other-owner' } });
  await expect(f.open()).rejects.toMatchObject({ code: 'console-identity-mismatch' });
  expect(f.operations.slice(before)).toEqual([]);
  expect(f.terminals.get(first.address)?.labels[label]).toBe('other-owner');
  expect(f.launches).toHaveLength(1);
});

test.each([
  ['spider.kind', 'exec'],
  ['spider.session', 'other-session'],
  ['spider.owner-core', 'other-owner-core'],
  ['spider.owner-terminal', 'other-owner-terminal'],
  ['spider.machine', 'box-3.invalid'],
  ['spider.run', 'other-run'],
  ['spider.runtime', 'b'.repeat(64)],
])('refuses to remove a finished view whose %s changes after the snapshot', async (label, value) => {
  const f = fixture(), first = (await f.open())!; f.finish(first.address); const before = f.operations.length;
  f.onSnapshot(() => { const terminal = f.terminals.get(first.address)!; f.terminals.set(first.address, { ...terminal, labels: { ...terminal.labels, [label]: value } }); });
  await expect(f.open()).rejects.toMatchObject({ code: 'console-runtime-unavailable' });
  expect(f.operations.slice(before)).toEqual([['get', first.address]]);
  expect(f.terminals.get(first.address)?.labels[label]).toBe(value);
  expect(f.terminals.get(first.address)?.state).toBe('finished');
  expect(f.launches).toHaveLength(1);
});

test('does not kill a current-runtime view that becomes live after the snapshot', async () => {
  const f = fixture(), first = (await f.open())!; f.finish(first.address); const before = f.operations.length;
  f.onSnapshot(() => { const terminal = f.terminals.get(first.address)!; f.terminals.set(first.address, { ...terminal, state: 'live', exitCode: null, reason: null, finishedAt: null }); });
  await expect(f.open()).rejects.toMatchObject({ code: 'console-runtime-unavailable' });
  expect(f.operations.slice(before)).toEqual([['get', first.address]]);
  expect(f.terminals.get(first.address)?.state).toBe('live');
  expect(f.launches).toHaveLength(1);
});

test('does not start a replacement when removal of a finished view fails', async () => {
  const f = fixture(), first = (await f.open())!; f.finish(first.address); const before = f.operations.length;
  const failure = new Error('remove failed'); f.failRemove(failure);
  await expect(f.open()).rejects.toMatchObject({ code: 'console-runtime-unavailable' });
  expect(f.operations.slice(before)).toEqual([['get', first.address], ['rm', first.address], ['get', first.address]]);
  expect(f.terminals.get(first.address)?.state).toBe('finished');
  expect(f.launches).toHaveLength(1);
  expect(f.errors).toEqual([failure]);
});

test('reuses a live current-runtime view', async () => {
  const f = fixture(), first = (await f.open())!; const before = f.operations.length;
  const second = (await f.open({ isConsoleIdle: async () => { throw new Error('Idle probe must not run'); } }))!;
  expect(second.address).toBe(first.address);
  expect(f.operations.slice(before)).toEqual([]);
  expect(f.terminals.get(first.address)?.state).toBe('live');
  expect(f.launches).toHaveLength(1);
});

test('preserves the idle check when replacing a live older-runtime view', async () => {
  const f = fixture(), first = (await f.open())!; const before = f.operations.length;
  const target = { ...f.request.target, runtimeSha256: 'b'.repeat(64) };
  await expect(f.open({ target, isConsoleIdle: async () => false })).rejects.toMatchObject({ code: 'console-runtime-unavailable' });
  expect(f.operations.slice(before)).toEqual([]);
  expect(f.terminals.get(first.address)?.state).toBe('live');
  const second = (await f.open({ target, isConsoleIdle: async () => true }))!;
  expect(second.address).not.toBe(first.address);
  expect(f.operations.slice(before)).toEqual([['get', first.address], ['kill', first.address], ['rm', first.address], ['run', second.address]]);
  expect(f.terminals.has(first.address)).toBe(false);
  expect(f.terminals.get(second.address)?.labels['spider.runtime']).toBe('b'.repeat(64));
});

test('preserves the older-runtime fallback when removal fails after a kill', async () => {
  const f = fixture(), first = (await f.open())!; const before = f.operations.length;
  const failure = new Error('remove failed'); f.failRemove(failure);
  const target = { ...f.request.target, runtimeSha256: 'b'.repeat(64) };
  const second = (await f.open({ target, isConsoleIdle: async () => true }))!;
  expect(second.address).not.toBe(first.address);
  expect(f.operations.slice(before)).toEqual([['get', first.address], ['kill', first.address], ['rm', first.address], ['get', first.address], ['run', second.address]]);
  expect(f.terminals.get(first.address)?.state).toBe('finished');
  expect(f.terminals.get(second.address)?.state).toBe('live');
  expect(f.errors).toEqual([failure]);
});
