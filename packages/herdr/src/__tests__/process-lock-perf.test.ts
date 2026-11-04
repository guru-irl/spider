import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { processStartTime, resetProcessStartTimeForTests } from '../../../subagents/src/process-identity.js';
import * as processIdentity from '../../../subagents/src/process-identity.js';
import { hash, withProcessLock, writePrivateJson } from '../sessions/registry.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
let root: string | undefined, child: ChildProcess | undefined;
afterEach(async () => {
  if (child) { const closed = once(child, 'close'); child.kill(); await closed; child = undefined; }
  if (root) await rm(root, { recursive: true, force: true }); root = undefined; vi.restoreAllMocks(); vi.clearAllMocks(); resetProcessStartTimeForTests();
});
async function fixture() { const base = resolve('.spider/scratch'); await mkdir(base, { recursive: true }); return root = await mkdtemp(join(base, 'lock-perf-')); }
const psCalls = () => vi.mocked(execFileSync).mock.calls.filter(args => args[0] === 'ps').length;
it.skipIf(process.platform === 'linux' || process.platform === 'win32')('acquires a usable lock after a transient own identity failure', async () => {
  await fixture(); resetProcessStartTimeForTests();
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('ps timed out'), { code: 'ETIMEDOUT' }); });
  expect(processStartTime(process.pid)).toBeNull();
  await expect(withProcessLock(root!, 'retry-identity', async () => 'acquired')).resolves.toBe('acquired');
  const recovered = processStartTime(process.pid);
  expect(recovered).not.toBeNull();
  expect(processStartTime(process.pid)).toBe(recovered);
});
it('captures its own start identity once for all lock callers', () => {
  const first = processStartTime(process.pid), initial = psCalls();
  for (let i = 0; i < 20; i++) expect(processStartTime(process.pid)).toBe(first);
  expect(first).not.toBeNull();
  expect(psCalls()).toBe(initial);
});
it('checks liveness without spawning again on each held-ticket poll', async () => {
  await fixture();
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); await once(child, 'spawn');
  const pid = child.pid!, startIdentity = processStartTime(pid)!;
  await writePrivateJson(join(root!, 'locks', hash('held'), 'holder.json'), { version: 1, pid, startIdentity, number: 1 });
  processStartTime(process.pid);
  vi.mocked(execFileSync).mockClear();
  let ran = false;
  await expect(withProcessLock(root!, 'held', async () => { ran = true; }, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'lock-occupied' });
  expect(ran).toBe(false);
  expect(psCalls()).toBeLessThanOrEqual(1);
});
it('describes a busy lock without assuming who owns it', async () => {
  await fixture();
  await writePrivateJson(join(root!, 'locks', hash('wording'), 'holder.json'), { version: 1, pid: process.pid, startIdentity: processStartTime(process.pid), number: 1 });
  await expect(withProcessLock(root!, 'wording', async () => {}, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'lock-occupied', message: 'The operation lock is busy' });
});
it('lets twenty local contenders finish with one ticket at a time', async () => {
  await fixture(); const directory = join(root!, 'locks', hash('local'));
  const counts: number[] = [], events: number[] = [];
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => withProcessLock(root!, 'local', async () => {
    counts.push((await readdir(directory)).length); events.push(i);
  }, { timeoutMs: 5000 })));
  expect(results.every(result => result.status === 'fulfilled')).toBe(true);
  expect(counts).toEqual(Array(20).fill(1));
  expect(events).toEqual(Array.from({ length: 20 }, (_, i) => i));
  expect(await readdir(directory)).toEqual([]);
});
it('fails a zero-timeout local contender without running it', async () => {
  await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const ready = new Promise<void>(resolveReady => { entered = resolveReady; });
  const holder = withProcessLock(root!, 'try-local', async () => { entered(); await gate; }); await ready;
  const attempt = withProcessLock(root!, 'try-local', async () => 'ran', { timeoutMs: 0 }).then(() => 'ran', error => error.code);
  try {
    expect(await Promise.race([attempt, new Promise(resolveWait => setTimeout(() => resolveWait('pending'), 100))])).toBe('lock-occupied');
    expect(await readdir(join(root!, 'locks', hash('try-local')))).toHaveLength(1);
  } finally { release(); await Promise.all([holder, attempt]); }
});
it('times out a nested same-key contender instead of hanging', async () => {
  await fixture();
  const abortController = new AbortController();
  const nested = withProcessLock(root!, 'nested', () => withProcessLock(root!, 'nested', async () => 'ran', { timeoutMs: 20, signal: abortController.signal }))
    .then(() => 'ran', error => error.code);
  try {
    expect(await Promise.race([nested, new Promise(resolveWait => setTimeout(() => resolveWait('pending'), 200))])).toBe('lock-occupied');
  } finally { abortController.abort(); await nested; }
});
it('removes a timed-out contender without letting later contenders skip the holder', async () => {
  await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const ready = new Promise<void>(resolveReady => { entered = resolveReady; });
  const events: string[] = [];
  const holder = withProcessLock(root!, 'timeout-order', async () => { entered(); await gate; events.push('holder'); }); await ready;
  const expired = withProcessLock(root!, 'timeout-order', async () => { events.push('expired'); }, { timeoutMs: 10 }).catch(error => error.code);
  const second = withProcessLock(root!, 'timeout-order', async () => { events.push('second'); });
  const third = withProcessLock(root!, 'timeout-order', async () => { events.push('third'); });
  try {
    expect(await Promise.race([expired, new Promise(resolveWait => setTimeout(() => resolveWait('pending'), 200))])).toBe('lock-occupied');
    expect(events).toEqual([]);
  } finally { release(); await Promise.all([holder, expired, second, third]); }
  expect(events).toEqual(['holder', 'second', 'third']);
});
it('shares one deadline between the local queue and the file lock', async () => {
  await fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.now();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const ready = new Promise<void>(resolveReady => { entered = resolveReady; });
  const holder = withProcessLock(root!, 'shared-deadline', async () => { entered(); await gate; }); await ready;
  const abortController = new AbortController();
  const identity = { pid: process.pid, startIdentity: processStartTime(process.pid)! };
  const waiting = withProcessLock(root!, 'shared-deadline', async () => 'ran', {
    timeoutMs: 100, signal: abortController.signal, identity,
    probe: async () => { vi.setSystemTime(start + 110); return { kind: 'live', startIdentity: identity.startIdentity }; },
  }).then(() => 'ran', error => error.code);
  try {
    await writePrivateJson(join(root!, 'locks', hash('shared-deadline'), 'foreign.json'), { version: 1, ...identity, number: 1 });
    vi.setSystemTime(start + 90); release(); await holder;
    expect(await Promise.race([waiting, new Promise(resolveWait => setTimeout(() => resolveWait('pending'), 200))])).toBe('lock-occupied');
  } finally { release(); abortController.abort(); await Promise.all([holder, waiting]); vi.useRealTimers(); }
});
it('cancels a queued contender without waiting for or releasing its predecessor', async () => {
  await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const ready = new Promise<void>(resolveReady => { entered = resolveReady; });
  const first = withProcessLock(root!, 'cancel', async () => { entered(); await gate; }); await ready;
  const abortController = new AbortController(); let result: unknown;
  const cancelled = withProcessLock(root!, 'cancel', async () => 'must-not-run', { signal: abortController.signal }).catch(error => { result = error; });
  let ran = false, third: Promise<void> | undefined;
  abortController.abort();
  try {
    await vi.waitFor(() => expect(result).toMatchObject({ code: 'aborted' }), { timeout: 200 });
    third = withProcessLock(root!, 'cancel', async () => { ran = true; });
    expect(await readdir(join(root!, 'locks', hash('cancel')))).toHaveLength(1);
    expect(ran).toBe(false);
  } finally { release(); await Promise.all([first, cancelled, third]); }
  expect(ran).toBe(true);
});
it('reclaims a dead holder after its identity was cached while waiting', async () => {
  await fixture();
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); await once(child, 'spawn');
  const pid = child.pid!, startIdentity = processStartTime(pid)!;
  await writePrivateJson(join(root!, 'locks', hash('dies'), 'holder.json'), { version: 1, pid, startIdentity, number: 1 });
  const waiting = withProcessLock(root!, 'dies', async () => 'acquired');
  const closed = once(child, 'close'); child.kill(); await closed; child = undefined;
  expect(await waiting).toBe('acquired');
  expect(await readdir(join(root!, 'locks', hash('dies')))).toEqual([]);
});
it.each(['different', 'reused'] as const)('checks a new ticket with a %s recorded identity during one wait', async recorded => {
  await fixture();
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); await once(child, 'spawn');
  const pid = child.pid!, startIdentity = processStartTime(pid)!;
  const directory = join(root!, 'locks', hash('new-ticket'));
  await writePrivateJson(join(directory, 'a.json'), { version: 1, pid, startIdentity, number: 1 });
  const readStart = processIdentity.processStartTime;
  let captured = false, replacement = false;
  vi.spyOn(processIdentity, 'processStartTime').mockImplementation(target => {
    if (target !== pid) return readStart(target);
    captured = true; return replacement ? 'replacement process start' : startIdentity;
  });
  let ran = false;
  const waiting = withProcessLock(root!, 'new-ticket', async () => { ran = true; }, { timeoutMs: 2000 }).then(() => 'ran', error => error.code);
  try {
    await vi.waitFor(() => expect(captured).toBe(true));
    replacement = true;
    await writePrivateJson(join(directory, 'b.json'), { version: 1, pid, startIdentity: recorded === 'different' ? 'different-start' : startIdentity, number: 1 });
    expect(await waiting).toBe('lock-owner-uncertain');
    expect(ran).toBe(false);
    expect(await readdir(directory)).toEqual(['a.json', 'b.json']);
  } finally { await waiting; }
});
it('does not trust a reused pid when a new ticket first appears', async () => {
  await fixture();
  await writePrivateJson(join(root!, 'locks', hash('reuse'), 'old.json'), { version: 1, pid: process.pid, startIdentity: 'different-start', number: 1 });
  let ran = false;
  await expect(withProcessLock(root!, 'reuse', async () => { ran = true; })).rejects.toMatchObject({ code: 'lock-owner-uncertain' });
  expect(ran).toBe(false);
  expect(await readdir(join(root!, 'locks', hash('reuse')))).toEqual(['old.json']);
});
