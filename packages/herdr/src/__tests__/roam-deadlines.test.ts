// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { invokeBytes } from '../client/bytes.js';
import { HerdrError } from '../client/parse.js';
import * as coreClient from '../client/hc.js';
import * as argvClient from '../client/argv-client.js';
import * as liveness from '../client/liveness.js';
import { createTransport } from '../../../roam/src/transport.js';
import { createClientFixture } from './testutil.js';

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); });

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 12345,
    kill: vi.fn((signal: string) => { queueMicrotask(() => child.emit('close', null, signal)); return true; }),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

test('each command uses its own explicit deadline', async () => {
  vi.useFakeTimers();
  const deadlines: number[] = [];
  for (const timeoutMs of [30_000, 60_000, 120_000, 600_000]) {
    const child = childProcess();
    let settled = false;
    const result = invokeBytes('fixture-hc', [], {}, { timeoutMs, maxBytes: 32 })
      .catch(error => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error).toMatchObject({ code: 'cli-timeout', details: { timeoutMs } });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    deadlines.push(error.details.timeoutMs);
  }
  expect(deadlines).toEqual([30_000, 60_000, 120_000, 600_000]);
  expect(vi.getTimerCount()).toBe(0);
}, 5000);

test('abort stops a pending byte call before its deadline', async () => {
  vi.useFakeTimers();
  const child = childProcess();
  const aborter = new AbortController();
  const options = { timeoutMs: 1000, maxBytes: 32, signal: aborter.signal };
  const result = invokeBytes('fixture-hc', [], {}, options).catch(error => error);
  aborter.abort();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({ code: 'cli-aborted' });
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(vi.getTimerCount()).toBe(0);
}, 5000);

test('remote timeout uses the budget remaining after the core liveness probe', async () => {
  const fixture = await createClientFixture();
  try {
    vi.useFakeTimers();
    vi.spyOn(liveness, 'requireCoreAvailable').mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1500)));
    const child = childProcess();
    const client = argvClient.createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    const pending = client.exec('box-1.invalid', ['/fixture/node'], { timeoutMs: 2501, maxBytes: 16 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['exec', '--on', 'box-1.invalid', '--timeout', '1', '--', '/fixture/node']);
    child.stdout.write(Buffer.from('ok'));
    child.emit('close', 0, null);
    expect(await pending).toEqual(Buffer.from('ok'));
  } finally { vi.useRealTimers(); await fixture.close(); }
}, 5000);

test('an exhausted liveness budget refuses to spawn a remote program', async () => {
  const fixture = await createClientFixture();
  try {
    vi.useFakeTimers();
    vi.spyOn(liveness, 'requireCoreAvailable').mockImplementation(() => new Promise(resolve => setTimeout(resolve, 2000)));
    const child = childProcess();
    const client = argvClient.createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    const pending = client.exec('box-1.invalid', ['/fixture/node'], { timeoutMs: 1000, maxBytes: 16 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(2000);
    child.emit('close', 0, null);
    expect(await pending).toMatchObject({ code: 'cli-timeout' });
    expect(spawn).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); await fixture.close(); }
}, 5000);

test('the bracket passes only its remaining budget after observing the core', async () => {
  const fixture = await createClientFixture();
  try {
    const peer = { machineId: '00000000-0000-4000-8000-000000000001', alias: 'box-1.invalid', node: '/fixture/node', pi: '/fixture/pi', cli: '/fixture/cli', core: '/fixture/hc', globalRoot: '/fixture/global' };
    let slow = false, delayed = false, payloadBudget = 0;
    vi.spyOn(coreClient, 'invokeCli').mockImplementation(async (_binary, argv) => {
      if (slow && !delayed && argv[0] === 'server') { delayed = true; await new Promise(resolve => setTimeout(resolve, 1500)); }
      return argv[0] === 'server' ? { core: { id: 'local-core' }, version: '0.1.16' }
        : { machines: [{ name: peer.alias, id: 'remote-core-1' }] };
    });
    const exec: import('../contracts.js').HcArgvClient['exec'] = async (_on, argv, options) => {
      if (argv[0] === 'cat') return Buffer.from(JSON.stringify({ machineId: peer.machineId }));
      payloadBudget = options.timeoutMs; return Buffer.from('ok');
    };
    vi.spyOn(argvClient, 'createArgvClient').mockReturnValue({ exec, run: vi.fn() });
    vi.useFakeTimers();
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    slow = true;
    const pending = transport.exec(resolved, ['inspect'], { timeoutMs: 5000, maxBytes: 16 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual(Buffer.from('ok'));
    expect(payloadBudget).toBe(3500);
  } finally { vi.useRealTimers(); await fixture.close(); }
}, 5000);

test('background launch has a 60-second deadline', async () => {
  const fixture = await createClientFixture();
  try {
    vi.spyOn(coreClient, 'invokeCli').mockImplementation((_binary, _argv, _env, _max, _input, options) =>
      new Promise((_resolve, reject) => setTimeout(() => reject(new HerdrError('cli-timeout', 'expired')), options?.timeoutMs)));
    vi.useFakeTimers();
    const client = argvClient.createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    let settled = false;
    const result = client.run('box-1.invalid', ['/fixture/node'], { 'spider.operation': 'operation-7' })
      .catch(error => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: 'cli-timeout' });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    await fixture.close();
  }
}, 5000);

test('the transfer deadline aborts a hung core observation before payload launch', async () => {
  const fixture = await createClientFixture();
  try {
    let observationAborted = false;
    vi.spyOn(coreClient, 'invokeCli').mockImplementation((_binary, _argv, _env, _max, _input, options) =>
      new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => {
        observationAborted = true; reject(new Error('aborted'));
      }, { once: true })));
    const exec = vi.fn();
    vi.spyOn(argvClient, 'createArgvClient').mockReturnValue({ exec, run: vi.fn() });
    const peer = { machineId: '00000000-0000-4000-8000-000000000001', alias: 'box-1.invalid', node: '/fixture/node', pi: '/fixture/pi', cli: '/fixture/cli', core: '/fixture/hc', globalRoot: '/fixture/global' };
    vi.useFakeTimers();
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    let settled = false;
    const result = transport.resolve(peer).catch(error => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: 'cli-timeout', retryable: true });
    expect(observationAborted).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    await fixture.close();
  }
}, 5000);

test('the transfer deadline aborts a hung payload and discards its result', async () => {
  const fixture = await createClientFixture();
  try {
    const peer = { machineId: '00000000-0000-4000-8000-000000000001', alias: 'box-1.invalid', node: '/fixture/node', pi: '/fixture/pi', cli: '/fixture/cli', core: '/fixture/hc', globalRoot: '/fixture/global' };
    vi.spyOn(coreClient, 'invokeCli').mockImplementation(async (_binary, argv, _env, _max, _input, options) => {
      if (options?.signal?.aborted) throw new Error('aborted');
      return argv[0] === 'server' ? { core: { id: 'local-core' }, version: '0.1.16' }
        : { machines: [{ name: peer.alias, id: 'remote-core-1' }] };
    });
    let actionStarted = false, actionAborted = false;
    const exec: import('../contracts.js').HcArgvClient['exec'] = async (_on, argv, options) => {
      if (argv[0] === 'cat') return Buffer.from(JSON.stringify({ machineId: peer.machineId }));
      actionStarted = true;
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => {
        actionAborted = true; reject(new Error('aborted'));
      }, { once: true }));
    };
    vi.spyOn(argvClient, 'createArgvClient').mockReturnValue({ exec, run: vi.fn() });
    vi.useFakeTimers();
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    let settled = false;
    const result = transport.exec(resolved, ['import'], { timeoutMs: 30_000, maxBytes: 16 })
      .catch(error => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(actionStarted).toBe(true);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: 'cli-timeout', retryable: true });
    expect(actionAborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    await fixture.close();
  }
}, 5000);
