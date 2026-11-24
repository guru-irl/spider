// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createHcClient } from '../client/hc.js';
import { trackAvailability } from '../client/availability.js';
import { HerdrError } from '../client/parse.js';
import type { MachineName, TerminalAddress } from '../contracts.js';

const boundary = vi.hoisted(() => ({ mode: 'timeout', machineDown: false, sharedHost: false, machineGate: null as Promise<void> | null, calls: [] as string[][] }));
vi.mock('../client/liveness.js', () => ({ requireCoreAvailable: async () => {} }));
vi.mock('../client/cli-transport.js', () => ({ invokeCli: async (_binary: string, args: string[]) => {
  boundary.calls.push([...args]);
  if (args[0] === 'server') return { version: '0.1.16', core: { id: 'local-core' } };
  if (args[0] === 'machine') {
    if (boundary.machineGate) await boundary.machineGate;
    if (boundary.machineDown) throw new HerdrError('core-unavailable', 'Machine inventory unavailable');
    const first = { id: 'remote-core', name: 'box-1.invalid', host: boundary.sharedHost ? 'shared.invalid' : 'box-1.invalid', target: 'box-1.invalid', state: 'connected', session: 'fixture' };
    return { machines: boundary.sharedHost ? [first, { ...first, id: 'other-core', name: 'box-2.invalid', target: 'box-2.invalid' }] : [first] };
  }
  if (args[0] === 'get') {
    if (boundary.mode === 'local-error' || boundary.mode === 'remote-error') throw new HerdrError('unavailable', 'Core failure');
    return { address: 'box-1.invalid/t1', labels: {}, parent: null, state: 'live', status: null, exit_code: null, finished_ms: null, reason: null, signal: null };
  }
  if (args[0] === 'file' && args[1] === 'read') {
    if (boundary.mode === 'timeout') throw new HerdrError('cli-timeout', 'CLI request exceeded its deadline', { timeoutMs: 15000 });
    if (boundary.mode === 'cli') throw new HerdrError('cli-exit', 'CLI exited', { exitCode: 1, stderr: 'connection lost', stdout: '' });
    if (boundary.mode === 'unavailable') throw new HerdrError('unavailable', 'Destination unavailable', { exitCode: 5 });
    if (boundary.mode === 'invalid') return { text: 42 };
    return { text: 'fresh remote content' };
  }
  if (args[0] === 'file' && args[1] === 'write') return boundary.mode === 'write-invalid' ? [] : {};
  throw new Error('Unexpected request');
} }));
afterEach(() => { boundary.mode = 'timeout'; boundary.machineDown = false; boundary.sharedHost = false; boundary.machineGate = null; boundary.calls = []; vi.useRealTimers(); });
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

it.each(['authentication failed', 'permission denied', 'identity mismatch while offline', 'unexpected argument --wrong', 'unrecognized argument --wrong', 'usage: hc command'])('does not scope a non-connectivity CLI exit: %s', async stderr => {
  const original = new HerdrError('cli-exit', 'CLI exited', { exitCode: 1, stderr });
  const error = await trackAvailability(scope, async () => { throw original; }).catch(caught => caught);
  expect(error).toBe(original);
  expect(error.availability).toBeUndefined();
});

it.each([
  'remote file not found: /home/fixture/downloads/file',
  'remote file not found: /home/fixture/lost+found/file',
  'remote command rejected during shutdown',
  'remote file not found: /home/fixture/report-503',
  'missing record 502',
])('does not treat a content error as a transport outage: %s', async stderr => {
  const original = new HerdrError('cli-exit', 'CLI exited', { exitCode: 1, stderr });
  const error = await trackAvailability(scope, async () => { throw original; }).catch(caught => caught);
  expect(error).toBe(original);
  expect(error.availability).toBeUndefined();
});

it.each([
  'remote host is down',
  'connection was reset',
  'HTTP 502 Bad Gateway',
  'HTTP/1.1 503 Service Unavailable',
  'status: 504',
])('recognizes actual transport evidence: %s', async stderr => {
  const error = await trackAvailability(scope, async () => { throw new HerdrError('cli-exit', 'CLI exited', { stderr }); }).catch(caught => caught);
  expect(error.availability).toEqual(scope);
});

it.each([
  { code: 'unavailable', message: 'Destination unavailable', details: { hint: 'Authentication failed' } },
  { code: 'cli-exit', message: 'CLI exited', details: { stderr: 'connection reset', hint: 'usage: check authentication' } },
  { code: 'cli-exit', message: 'CLI exited', details: { stderr: 'connection reset', stdout: 'HTTP 403 forbidden' } },
])('does not mistake hint or stdout content for an authentication error: $code', async ({ code, message, details }) => {
  const error = await trackAvailability(scope, async () => { throw new HerdrError(code, message, details); }).catch(caught => caught);
  expect(error.availability).toEqual(scope);
});

it.each([
  new HerdrError('cli-exit', 'Authentication failed', { stderr: 'connection reset' }),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'authentication failed while connection reset' }),
])('still treats authentication in the message or stderr as a non-connectivity failure', async original => {
  const error = await trackAvailability(scope, async () => { throw original; }).catch(caught => caught);
  expect(error).toBe(original);
  expect(error.availability).toBeUndefined();
});

it('does not report recovery for cached metadata, terminal metadata, or a malformed remote reply', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const available: string[] = [], connected: string[] = [], hc = client(key => available.push(key));
  const unsubscribe = hc.onMachineAvailable!(machine => connected.push(machine));
  try {
    await expect(hc.fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).rejects.toMatchObject({ code: 'cli-timeout' });
    await hc.get('box-1.invalid/t1' as TerminalAddress);
    boundary.mode = 'invalid';
    await expect(hc.fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).rejects.toMatchObject({ code: 'invalid-reply' });
    expect(boundary.calls.filter(args => args[0] === 'machine')).toHaveLength(1);
    expect(available).not.toContain(scope.key);
    expect(connected).toEqual([]);
    boundary.mode = 'success';
    expect((await hc.fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).toString()).toBe('fresh remote content');
    expect(available.filter(key => key === scope.key)).toHaveLength(1);
    expect(connected).toEqual(['box-1.invalid']);
    unsubscribe(); await hc.fileRead('box-1.invalid' as MachineName, '/home/fixture/input');
    expect(connected).toEqual(['box-1.invalid']);
  } finally { await hc.dispose(); }
});

it('backs off unresolved alias metadata checks without changing the original error', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const start = Date.parse('2026-01-01T00:00:00Z'); vi.setSystemTime(start);
  boundary.mode = 'remote-error'; boundary.machineDown = true;
  const hc = client(() => {});
  try {
    for (let i = 0; i < 20; i++) await expect(hc.get('unknown.invalid/t1' as TerminalAddress)).rejects.toMatchObject({ code: 'unavailable', availability: { machine: 'unknown.invalid' } });
    expect(boundary.calls.filter(args => args[0] === 'machine')).toHaveLength(1);
    vi.setSystemTime(start + 29_999); await expect(hc.get('unknown.invalid/t1' as TerminalAddress)).rejects.toMatchObject({ code: 'unavailable' });
    expect(boundary.calls.filter(args => args[0] === 'machine')).toHaveLength(1);
    vi.setSystemTime(start + 30_000); await expect(hc.get('unknown.invalid/t1' as TerminalAddress)).rejects.toMatchObject({ code: 'unavailable' });
    expect(boundary.calls.filter(args => args[0] === 'machine')).toHaveLength(2);
  } finally { await hc.dispose(); }
});

it('shares one in-flight alias lookup among concurrent failures', async () => {
  boundary.mode = 'remote-error'; boundary.machineDown = true;
  let release!: () => void; boundary.machineGate = new Promise<void>(resolve => { release = resolve; });
  const hc = client(() => {});
  try {
    const calls = Array.from({ length: 20 }, () => hc.get('unknown.invalid/t1' as TerminalAddress).catch(error => error));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(boundary.calls.filter(args => args[0] === 'machine')).toHaveLength(1);
    release(); const errors = await Promise.all(calls);
    expect(errors.every(error => error.code === 'unavailable')).toBe(true);
  } finally { release(); await hc.dispose(); }
});

it('does not assign a shared ambiguous alias to either machine', async () => {
  boundary.mode = 'remote-error'; boundary.sharedHost = true;
  const available: string[] = [], hc = client(key => available.push(key));
  try {
    const error = await hc.get('shared.invalid/t1' as TerminalAddress).catch(caught => caught);
    expect(error).toMatchObject({ code: 'unavailable', availability: { key: 'machine:shared.invalid', machine: 'shared.invalid' } });
    boundary.mode = 'success'; await hc.fileRead('box-1.invalid' as MachineName, '/home/fixture/input');
    expect(available).not.toContain('machine:shared.invalid');
  } finally { await hc.dispose(); }
});

it('does not describe a qualified local-core failure as a remote machine outage', async () => {
  const hc = client(() => {});
  try {
    await hc.identity(); boundary.mode = 'local-error';
    const error = await hc.get('local-core/t1' as TerminalAddress).catch(caught => caught);
    expect(error).toMatchObject({ code: 'unavailable', availability: { key: 'hc:get:' } });
    expect(error.availability.machine).toBeUndefined();
  } finally { await hc.dispose(); }
});

it('does not publish recovery for a malformed write acknowledgment', async () => {
  const available: string[] = [], hc = client(key => available.push(key));
  try {
    boundary.mode = 'write-invalid';
    await expect(hc.fileWrite('box-1.invalid' as MachineName, '/home/fixture/input', Buffer.from('payload'))).rejects.toMatchObject({ code: 'invalid-reply' });
    expect(available).not.toContain('machine:box-1.invalid');
    boundary.mode = 'success';
    await hc.fileWrite('box-1.invalid' as MachineName, '/home/fixture/input', Buffer.from('payload'));
    expect(available.filter(key => key === 'machine:box-1.invalid')).toHaveLength(1);
  } finally { await hc.dispose(); }
});

it('keeps a successful remote read successful when the availability reporter throws', async () => {
  boundary.mode = 'success';
  const hc = client(() => { throw new Error('Reporter failed'); }), seen: string[] = [];
  hc.onMachineAvailable!(machine => seen.push(machine));
  try {
    expect((await hc.fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).toString()).toBe('fresh remote content');
    expect(seen).toEqual(['box-1.invalid']);
  } finally { await hc.dispose(); }
});

it('keeps a successful remote read successful when a recovery subscriber throws', async () => {
  boundary.mode = 'success';
  const hc = client(() => {}), seen: string[] = [];
  hc.onMachineAvailable!(() => { throw new Error('Subscriber failed'); });
  hc.onMachineAvailable!(machine => seen.push(machine));
  try {
    expect((await hc.fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).toString()).toBe('fresh remote content');
    expect(seen).toEqual(['box-1.invalid']);
  } finally { await hc.dispose(); }
});
