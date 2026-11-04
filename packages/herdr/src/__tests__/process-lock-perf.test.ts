import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { processStartTime } from '../../../subagents/src/process-identity.js';
import { hash, withProcessLock, writePrivateJson } from '../sessions/registry.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
let root: string | undefined, child: ChildProcess | undefined;
afterEach(async () => {
  if (child) { const closed = once(child, 'close'); child.kill(); await closed; child = undefined; }
  if (root) await rm(root, { recursive: true, force: true }); root = undefined; vi.restoreAllMocks(); vi.clearAllMocks();
});
async function fixture() { const base = resolve('.spider/scratch'); await mkdir(base, { recursive: true }); return root = await mkdtemp(join(base, 'lock-perf-')); }
const psCalls = () => vi.mocked(execFileSync).mock.calls.filter(args => args[0] === 'ps').length;
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
  }, { timeoutMs: 1 })));
  expect(results.every(result => result.status === 'fulfilled')).toBe(true);
  expect(counts).toEqual(Array(20).fill(1));
  expect(events).toEqual(Array.from({ length: 20 }, (_, i) => i));
  expect(await readdir(directory)).toEqual([]);
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
it('does not trust a reused pid when a new ticket first appears', async () => {
  await fixture();
  await writePrivateJson(join(root!, 'locks', hash('reuse'), 'old.json'), { version: 1, pid: process.pid, startIdentity: 'different-start', number: 1 });
  let ran = false;
  await expect(withProcessLock(root!, 'reuse', async () => { ran = true; })).rejects.toMatchObject({ code: 'lock-owner-uncertain' });
  expect(ran).toBe(false);
  expect(await readdir(join(root!, 'locks', hash('reuse')))).toEqual(['old.json']);
});
