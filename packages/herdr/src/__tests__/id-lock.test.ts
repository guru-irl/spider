// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { claimIdLock as claim } from '../sessions/id-lock.js';
import type { ProcessIdentity, ProcessProbe } from '../sessions/lease.js';
import { hash } from '../sessions/registry.js';

let root: string;
const firstIdentity: ProcessIdentity = { pid: 101, startIdentity: 'boot-a:start-1' };
const nextIdentity: ProcessIdentity = { pid: 102, startIdentity: 'boot-a:start-2' };
let processes: Map<number, ProcessProbe>;
const probe = async (pid: number): Promise<ProcessProbe> => processes.get(pid) ?? { kind: 'absent' };
const bootA = { bootId: async () => 'boot-a' };
const bootB = { bootId: async () => 'boot-b' };
const unknownBoot = { bootId: async () => '' };
const claimIdLock = (root: string, id: string, identity: ProcessIdentity, probe: (pid: number) => Promise<ProcessProbe>, options = bootA) => claim(root, id, identity, probe, options);

beforeEach(async () => {
  const base = resolve('.spider/scratch/id-lock-tests');
  await mkdir(base, { recursive: true });
  root = await mkdtemp(join(base, 'case-'));
  processes = new Map([[101, { kind: 'live', startIdentity: firstIdentity.startIdentity }], [102, { kind: 'live', startIdentity: nextIdentity.startIdentity }]]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function record() {
  const dir = join(root, 'id-locks');
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  const file = join(dir, files[0]);
  return { file, identity: JSON.parse(await readFile(file, 'utf8')).identity as ProcessIdentity };
}

it('same ID different file still has one owner', async () => {
  const files = [join(root, 'one.jsonl'), join(root, 'two.jsonl')];
  await Promise.all(files.map(file => writeFile(file, JSON.stringify({ id: 'session-1' }))));
  const ids = await Promise.all(files.map(async file => (JSON.parse(await readFile(file, 'utf8')) as { id: string }).id));
  const first = await claimIdLock(root, ids[0], firstIdentity, probe);
  await expect(claimIdLock(root, ids[1], nextIdentity, probe)).rejects.toThrow(/owner/i);
  expect((await record()).identity).toEqual(firstIdentity);
  await first.release();
  const second = await claimIdLock(root, 'session-1', nextIdentity, probe);
  expect((await record()).identity).toEqual(nextIdentity);
  await second.release();
}, 5000);

it('stale ID lock from a killed process is reclaimed', async () => {
  const stale = await claimIdLock(root, 'session-1', firstIdentity, probe);
  processes.set(firstIdentity.pid, { kind: 'absent' });
  const claim = claimIdLock(root, 'session-1', nextIdentity, probe);
  await expect(claim).resolves.toHaveProperty('release');
  const current = await claim;
  const reclaimed = await record();
  expect(reclaimed.identity).toEqual(nextIdentity);
  await stale.release();
  expect((await record()).identity).toEqual(nextIdentity);
  await expect(stale.transfer(firstIdentity)).rejects.toThrow();
  await current.release();
}, 5000);

it('PID reuse or unknown ownership refuses', async () => {
  const first = await claimIdLock(root, 'session-1', firstIdentity, probe);
  const saved = await record();
  const before = await readFile(saved.file, 'utf8');
  const beforeInode = (await stat(saved.file)).ino;
  for (const observed of [
    { kind: 'unknown' } as const,
    { kind: 'live', startIdentity: 'boot-a:start-reused' } as const,
    { kind: 'live', startIdentity: 'boot-b:start-1' } as const,
  ]) {
    processes.set(firstIdentity.pid, observed);
    await expect(claimIdLock(root, 'session-1', nextIdentity, probe)).rejects.toThrow(/owner/i);
    const unknownOwnerWrites = Number((await readFile(saved.file, 'utf8')) !== before || (await stat(saved.file)).ino !== beforeInode);
    expect(unknownOwnerWrites).toBe(0);
  }
  await first.release();
}, 5000);

it('serializes concurrent claims while checking a stale owner', async () => {
  await claimIdLock(root, 'session-1', firstIdentity, probe);
  let entered!: () => void;
  let release!: () => void;
  const checking = new Promise<void>(resolveChecking => { entered = resolveChecking; });
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  processes.set(firstIdentity.pid, { kind: 'absent' });
  const slowProbe = async (pid: number): Promise<ProcessProbe> => {
    if (pid === firstIdentity.pid) { entered(); await gate; return { kind: 'absent' }; }
    return probe(pid);
  };
  const firstClaim = claimIdLock(root, 'session-1', nextIdentity, slowProbe);
  await checking;
  const third: ProcessIdentity = { pid: 103, startIdentity: 'boot-a:start-3' };
  processes.set(third.pid, { kind: 'live', startIdentity: third.startIdentity });
  let secondProbe!: () => void;
  const secondChecked = new Promise<void>(resolveChecked => { secondProbe = resolveChecked; });
  const secondClaim = claimIdLock(root, 'session-1', third, async pid => { secondProbe(); return probe(pid); });
  const outcomes = Promise.allSettled([firstClaim, secondClaim]);
  try { await Promise.race([secondChecked, new Promise(resolveWait => setTimeout(resolveWait, 300))]); }
  finally { release(); }
  const results = await outcomes;
  expect(results[0].status).toBe('fulfilled');
  expect(results[1].status).toBe('rejected');
  expect((await record()).identity).toEqual(nextIdentity);
  if (results[0].status === 'fulfilled') await results[0].value.release();
}, 5000);

it('serializes competing claims from separate processes', async () => {
  const entry = join(root, 'claim-worker.ts');
  await writeFile(entry, `
    import { claimIdLock } from ${JSON.stringify(fileURLToPath(new URL('../sessions/id-lock.ts', import.meta.url)))};
    process.on('message', async message => {
      if (message === 'claim') {
        try {
          await claimIdLock(${JSON.stringify(root)}, 'session-1', { pid: process.pid, startIdentity: 'child:' + process.pid }, async () => ({ kind: 'live', startIdentity: 'occupied' }), { bootId: async () => 'boot-a' });
          process.send?.('claimed');
        } catch (error) { process.send?.(error && typeof error === 'object' && 'code' in error ? error.code : 'unexpected'); }
      } else if (message === 'stop') process.exit(0);
    });
    process.send?.('ready');
  `);
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@spider/db-core': fileURLToPath(new URL('../../../db-core/src/command-env.ts', import.meta.url)) } }, build: { ssr: entry, outDir: root, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'claim-worker.mjs' } } } });
  const children: ChildProcess[] = [];
  const receive = (child: ChildProcess) => new Promise<unknown>((resolveMessage, reject) => {
    child.once('message', resolveMessage);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Worker exited before replying (${code})`)));
  });
  try {
    for (let i = 0; i < 2; i++) children.push(fork(join(root, 'claim-worker.mjs'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
    expect(await Promise.all(children.map(receive))).toEqual(['ready', 'ready']);
    const replies = children.map(receive);
    for (const child of children) child.send!('claim');
    expect((await Promise.all(replies)).sort()).toEqual(['claimed', 'session-id-owner']);
    expect((await record()).identity.pid).toBeGreaterThan(0);
  } finally {
    await Promise.all(children.map(child => new Promise<void>(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
      child.once('exit', () => resolveExit());
      child.send?.('stop');
    })));
  }
}, 5000);

it('rejects malformed or unsafe records without replacing them', async () => {
  await claimIdLock(root, 'session-1', firstIdentity, probe);
  const { file } = await record();
  const previous = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const malformed = JSON.stringify({ ...previous, version: 2 });
  processes.set(firstIdentity.pid, { kind: 'absent' });
  await writeFile(file, malformed);
  await expect(claimIdLock(root, 'session-1', nextIdentity, probe)).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe(malformed);
  const { bootId: _bootId, ...withoutBoot } = previous;
  const missingBoot = JSON.stringify(withoutBoot);
  await writeFile(file, missingBoot);
  await expect(claimIdLock(root, 'session-1', nextIdentity, probe)).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe(missingBoot);
  for (const bootId of [1, '   ']) {
    const invalidBoot = JSON.stringify({ ...previous, bootId });
    await writeFile(file, invalidBoot);
    await expect(claimIdLock(root, 'session-1', nextIdentity, probe)).rejects.toMatchObject({ code: 'invalid-session-id-lock' });
    expect(await readFile(file, 'utf8')).toBe(invalidBoot);
  }
  await rm(file);
  const target = join(root, 'target');
  await writeFile(target, 'unchanged', { mode: 0o600 });
  await symlink(target, file);
  await expect(claimIdLock(root, 'session-1', nextIdentity, probe)).rejects.toThrow();
  expect(await readFile(target, 'utf8')).toBe('unchanged');
}, 5000);

it('creates private session records keyed by session ID', async () => {
  const first = await claimIdLock(root, 'session-1', firstIdentity, probe);
  const otherClaim = claimIdLock(root, 'session-2', nextIdentity, probe);
  await expect(otherClaim).resolves.toHaveProperty('release');
  const other = await otherClaim;
  const directory = join(root, 'id-locks');
  const files = await readdir(directory);
  expect(files.sort()).toEqual([`${hash('session-1')}.json`, `${hash('session-2')}.json`].sort());
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, files[0]))).mode & 0o777).toBe(0o600);
  await first.release();
  await expect(claimIdLock(root, 'session-2', firstIdentity, probe)).rejects.toThrow(/owner/i);
  await other.release();
}, 5000);

it('rejects invalid IDs and identities without creating an ownership record', async () => {
  await expect(claimIdLock(root, '', firstIdentity, probe)).rejects.toThrow();
  await expect(claimIdLock(root, 'session-1', { pid: 0, startIdentity: 'start' }, probe)).rejects.toThrow();
  await expect(claimIdLock(root, 'session-1', { pid: 101, startIdentity: '' }, probe)).rejects.toThrow();
  await expect(readdir(join(root, 'id-locks'))).rejects.toMatchObject({ code: 'ENOENT' });
  const owner = await claimIdLock(root, 'session-1', firstIdentity, probe);
  await expect(owner.transfer({ pid: 0, startIdentity: 'start' })).rejects.toThrow();
  expect((await record()).identity).toEqual(firstIdentity);
  await owner.release();
}, 5000);

it('rejects nonprivate ID-lock directories before changing ownership', async () => {
  const directory = join(root, 'id-locks');
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o755);
  await expect(claimIdLock(root, 'session-1', firstIdentity, probe)).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
}, 5000);

it('rejects a symlinked ID-lock directory without writing its target', async () => {
  const target = join(root, 'target');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, join(root, 'id-locks'));
  await expect(claimIdLock(root, 'session-1', firstIdentity, probe)).rejects.toThrow();
  expect(await readdir(target)).toEqual([]);
}, 5000);

it('rejects a nonprivate process-lock directory before changing ownership', async () => {
  const locks = join(root, 'locks');
  await mkdir(locks, { mode: 0o700 });
  await chmod(locks, 0o755);
  await expect(claimIdLock(root, 'session-1', firstIdentity, probe)).rejects.toThrow();
  await expect(readdir(join(root, 'id-locks'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 5000);

it('handoff retains one owner', async () => {
  const first = await claimIdLock(root, 'session-1', firstIdentity, probe);
  await first.transfer(nextIdentity);
  expect((await record()).identity).toEqual(nextIdentity);
  await expect(claimIdLock(root, 'session-1', firstIdentity, probe)).rejects.toThrow(/owner/i);
  await first.release();
  const replacement = await claimIdLock(root, 'session-1', firstIdentity, probe);
  await replacement.release();
}, 5000);

it('transferred lock is adopted by the named process', async () => {
  const launcher = await claimIdLock(root, 'session-1', firstIdentity, probe);
  await launcher.transfer(nextIdentity);
  const adopted = await claimIdLock(root, 'session-1', nextIdentity, probe);
  const repeated = await claimIdLock(root, 'session-1', nextIdentity, probe);
  await launcher.release();
  await expect(launcher.transfer(firstIdentity)).rejects.toThrow(/owner/i);
  await expect(claimIdLock(root, 'session-1', firstIdentity, probe)).rejects.toThrow(/owner/i);
  expect((await record()).identity).toEqual(nextIdentity);
  await adopted.release();
  const replacement = await claimIdLock(root, 'session-1', firstIdentity, probe);
  await repeated.release();
  await expect(claimIdLock(root, 'session-1', nextIdentity, probe)).rejects.toThrow(/owner/i);
  await replacement.release();
}, 5000);

it('adopts a transferred lock in a separate process', async () => {
  const entry = join(root, 'adopt-worker.ts');
  await writeFile(entry, `
    import { claimIdLock } from ${JSON.stringify(fileURLToPath(new URL('../sessions/id-lock.ts', import.meta.url)))};
    let handle;
    process.on('message', async message => {
      try {
        if (message === 'adopt') {
          handle = await claimIdLock(${JSON.stringify(root)}, 'session-1', { pid: process.pid, startIdentity: 'child:' + process.pid }, async () => ({ kind: 'live', startIdentity: 'occupied' }), { bootId: async () => 'boot-a' });
          process.send?.('adopted');
        } else if (message === 'release') { await handle.release(); process.send?.('released'); }
        else if (message === 'stop') process.exit(0);
      } catch { process.send?.('error'); }
    });
    process.send?.('ready');
  `);
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@spider/db-core': fileURLToPath(new URL('../../../db-core/src/command-env.ts', import.meta.url)) } }, build: { ssr: entry, outDir: root, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'adopt-worker.mjs' } } } });
  const launcher = await claimIdLock(root, 'session-1', firstIdentity, probe);
  const child = fork(join(root, 'adopt-worker.mjs'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const receive = () => new Promise<unknown>((resolveMessage, reject) => {
    child.once('message', resolveMessage);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Worker exited before replying (${code})`)));
  });
  try {
    expect(await receive()).toBe('ready');
    const childIdentity = { pid: child.pid!, startIdentity: `child:${child.pid}` };
    processes.set(childIdentity.pid, { kind: 'live', startIdentity: childIdentity.startIdentity });
    await launcher.transfer(childIdentity);
    let reply = receive(); child.send!('adopt');
    expect(await reply).toBe('adopted');
    await expect(claimIdLock(root, 'session-1', firstIdentity, probe)).rejects.toThrow(/owner/i);
    reply = receive(); child.send!('release');
    expect(await reply).toBe('released');
    const replacement = await claimIdLock(root, 'session-1', firstIdentity, probe);
    await launcher.release();
    await expect(claimIdLock(root, 'session-1', childIdentity, probe)).rejects.toThrow(/owner/i);
    await replacement.release();
  } finally {
    await new Promise<void>(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
      child.once('exit', () => resolveExit()); child.send?.('stop');
    });
  }
}, 5000);

it('repeated adoption does not invalidate an existing handle', async () => {
  const first = await claimIdLock(root, 'session-1', firstIdentity, probe);
  const adopted = await claimIdLock(root, 'session-1', firstIdentity, probe);
  await first.release();
  const replacement = await claimIdLock(root, 'session-1', nextIdentity, probe);
  expect((await record()).identity).toEqual(nextIdentity);
  await adopted.release();
  await expect(claimIdLock(root, 'session-1', firstIdentity, probe)).rejects.toThrow(/owner/i);
  await replacement.release();
}, 5000);

it('same pid with different start identity cannot adopt', async () => {
  const owner = await claimIdLock(root, 'session-1', firstIdentity, probe);
  const reused = { pid: firstIdentity.pid, startIdentity: 'different-start' };
  await expect(claimIdLock(root, 'session-1', reused, probe)).rejects.toThrow(/owner/i);
  expect((await record()).identity).toEqual(firstIdentity);
  await owner.release();
}, 5000);

it('adopted handle release frees the lock', async () => {
  const launcher = await claimIdLock(root, 'session-1', firstIdentity, probe);
  await launcher.transfer(nextIdentity);
  const adopted = await claimIdLock(root, 'session-1', nextIdentity, probe);
  await adopted.release();
  const replacement = await claimIdLock(root, 'session-1', firstIdentity, probe);
  expect((await record()).identity).toEqual(firstIdentity);
  await replacement.release();
}, 5000);

it('reboot with same pid and start ticks reclaims and does not adopt', async () => {
  const old = await claimIdLock(root, 'session-1', firstIdentity, probe, bootA);
  const current = await claimIdLock(root, 'session-1', firstIdentity, probe, bootB);
  await old.release();
  await expect(old.transfer(nextIdentity)).rejects.toThrow(/owner/i);
  await expect(claimIdLock(root, 'session-1', nextIdentity, probe, bootB)).rejects.toThrow(/owner/i);
  expect((await record()).identity).toEqual(firstIdentity);
  await current.release();
}, 5000);

it('unknown boot ID refuses rather than adopts', async () => {
  const known = await claimIdLock(root, 'known', firstIdentity, probe, bootA);
  await expect(claimIdLock(root, 'known', firstIdentity, probe, unknownBoot)).rejects.toThrow(/owner/i);
  await expect(claimIdLock(root, 'known', firstIdentity, probe, { bootId: async () => { throw new Error('unavailable'); } })).rejects.toThrow(/owner/i);
  processes.set(firstIdentity.pid, { kind: 'absent' });
  await expect(claimIdLock(root, 'known', nextIdentity, probe, unknownBoot)).rejects.toThrow(/owner/i);
  await known.release();
  const unknown = await claimIdLock(root, 'unknown', firstIdentity, probe, unknownBoot);
  await expect(claimIdLock(root, 'unknown', firstIdentity, probe, bootA)).rejects.toThrow(/owner/i);
  await expect(claimIdLock(root, 'unknown', nextIdentity, probe, bootA)).rejects.toThrow(/owner/i);
  await unknown.release();
}, 5000);
