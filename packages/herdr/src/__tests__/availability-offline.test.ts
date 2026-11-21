// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createHcClient } from '../client/hc.js';
import { trackAvailability } from '../client/availability.js';
import { HerdrError } from '../client/parse.js';
import type { MachineName, TerminalAddress } from '../contracts.js';

const boundary = vi.hoisted(() => ({ mode: 'timeout', calls: [] as string[][] }));
vi.mock('../client/liveness.js', () => ({ requireCoreAvailable: async () => {} }));
vi.mock('../client/cli-transport.js', () => ({ invokeCli: async (_binary: string, args: string[]) => {
  boundary.calls.push([...args]);
  if (args[0] === 'machine') return { machines: [{ id: 'remote-core', name: 'box-1.invalid', host: 'box-1.invalid', target: 'box-1.invalid', state: 'connected', session: 'fixture' }] };
  if (args[0] === 'get') return { address: 'box-1.invalid/t1', labels: {}, parent: null, state: 'live', status: null, exit_code: null, finished_ms: null, reason: null, signal: null };
  if (args[0] === 'file' && args[1] === 'read') {
    if (boundary.mode === 'timeout') throw new HerdrError('cli-timeout', 'CLI request exceeded its deadline', { timeoutMs: 15000 });
    if (boundary.mode === 'cli') throw new HerdrError('cli-exit', 'CLI exited', { exitCode: 1, stderr: 'connection lost', stdout: '' });
    if (boundary.mode === 'unavailable') throw new HerdrError('unavailable', 'Destination unavailable', { exitCode: 5 });
    if (boundary.mode === 'invalid') return { text: 42 };
    return { text: 'fresh remote content' };
  }
  throw new Error('Unexpected request');
} }));
afterEach(() => { boundary.mode = 'timeout'; boundary.calls = []; vi.useRealTimers(); });
const scope = { key: 'machine:box-1.invalid', machine: 'box-1.invalid' };
const client = (available: (key: string) => void) => createHcClient({ binary: 'fixture', env: { HC_SOCKET: join(process.cwd(), '.spider/scratch/offline-fixture.sock'), HC_SESSION: 'fixture' } }, available);

it.each(['cli-timeout', 'cli-exit', 'unreachable'])('attaches the destination to a %s transport failure', async code => {
  const original = new HerdrError(code, 'transport failed', { exitCode: 1, stderr: 'connection lost' });
  const error = await trackAvailability(scope, async () => { throw original; }).catch(caught => caught);
  expect(error).toBeInstanceOf(HerdrError);
  expect(error).toMatchObject({ code, availability: scope, details: original.details });
});

it.each(['invalid-reply', 'caller-mismatch', 'machine-not-found', 'cli-aborted'])('does not turn a %s failure into a machine outage', async code => {
  const original = new HerdrError(code, 'bad request or identity');
  const error = await trackAvailability(scope, async () => { throw original; }).catch(caught => caught);
  expect(error).toBe(original);
  expect(error.availability).toBeUndefined();
});

it.each(['authentication failed', 'permission denied', 'unrecognized argument --wrong', 'usage: hc command'])('does not scope a non-connectivity CLI exit: %s', async stderr => {
  const original = new HerdrError('cli-exit', 'CLI exited', { exitCode: 1, stderr });
  const error = await trackAvailability(scope, async () => { throw original; }).catch(caught => caught);
  expect(error).toBe(original);
  expect(error.availability).toBeUndefined();
});

it('does not report recovery for cached metadata, terminal metadata, or a malformed remote reply', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const available: string[] = [], hc = client(key => available.push(key));
  try {
    await expect(hc.fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).rejects.toMatchObject({ code: 'cli-timeout' });
    await hc.get('box-1.invalid/t1' as TerminalAddress);
    boundary.mode = 'invalid';
    await expect(hc.fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).rejects.toMatchObject({ code: 'invalid-reply' });
    expect(boundary.calls.filter(args => args[0] === 'machine')).toHaveLength(1);
    expect(available).not.toContain(scope.key);
    boundary.mode = 'success';
    expect((await hc.fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).toString()).toBe('fresh remote content');
    expect(available.filter(key => key === scope.key)).toHaveLength(1);
  } finally { await hc.dispose(); }
});
