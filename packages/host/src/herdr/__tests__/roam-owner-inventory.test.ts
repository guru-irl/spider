import type { SessionId } from '@spider/herdr/contracts';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createProcessPresence } from '@spider/herdr/sessions/presence';
import { assessSessionLiveness, createSessionLeases } from '@spider/herdr/sessions/lease';
import { createBothLocks } from '@spider/roam/session-control';
import { withProcessLock } from '@spider/herdr/sessions/registry';
import { processStartTime } from '../../../../subagents/src/process-identity';
import { createProcessInventory } from '../process-inventory';

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) =>
    args[0] === 'ps' && args[1]?.[0] === '-U' ? `${process.pid} pi node pi` : actual.execFileSync(...args) };
});

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(resolve('.spider/scratch'), 'owner-')); roots.push(root);
  const local = join(root, 'local'), other = join(root, 'other');
  for (const directory of [local, other]) mkdirSync(directory, { mode: 0o700 });
  const file = join(root, 'target.jsonl'), unrelated = join(root, 'other.jsonl');
  writeFileSync(file, '{}\n'); writeFileSync(unrelated, '{}\n');
  const identity = { pid: process.pid, startIdentity: processStartTime(process.pid)! };
  const presence = createProcessPresence(other);
  await presence.record({ ...identity, sessionId: 'other-session' as SessionId, sessionFile: unrelated, sessionName: null, kind: 'top-level', hcAddress: null });
  return { root, local, other, file, unrelated, identity, presence };
}

it('an unrelated identity-matched Pi in another runtime does not block dormant ownership locks', async () => {
  const f = await fixture();
  const inventory = createProcessInventory(f.local, false, [f.other]);
  const locks = createBothLocks({ root: f.local, inventory, file: async () => f.file, identity: f.identity, bootId: async () => 'boot-a' });
  expect(await locks('target-session', async held => held!.owns())).toBe(true);
});

it('a different runtime registration for the target file still blocks dormant control', async () => {
  const f = await fixture();
  await f.presence.record({ ...f.identity, sessionId: 'target-session' as SessionId, sessionFile: f.file, sessionName: null, kind: 'top-level', hcAddress: null });
  expect(await assessSessionLiveness(f.file, createProcessInventory(f.local, false, [f.other]))).toMatchObject({ kind: 'live', pids: [process.pid] });
});

it('a reused PID in a different runtime remains an unidentified live process', async () => {
  const f = await fixture();
  await f.presence.remove(f.identity);
  await f.presence.record({ ...f.identity, startIdentity: 'old-start', sessionId: 'other-session' as SessionId, sessionFile: f.unrelated, sessionName: null, kind: 'top-level', hcAddress: null });
  expect(await assessSessionLiveness(f.file, createProcessInventory(f.local, false, [f.other]))).toMatchObject({ kind: 'uncertain', pids: [process.pid] });
  expect(await f.presence.list()).toHaveLength(1);
});

it('a stale file lease does not block absence when its reused PID is proved unrelated', async () => {
  const f = await fixture();
  const inventory = createProcessInventory(f.local, false, [f.other]);
  const leases = createSessionLeases(f.local);
  await leases.claim(f.file, { ...f.identity, startIdentity: 'old-start' }, inventory, { mode: 'bookkeeping' });
  const locks = createBothLocks({ root: f.local, inventory, file: async () => f.file, identity: f.identity, bootId: async () => 'boot-a' });
  expect(await locks('target-session', async held => held!.owns())).toBe(true);
});

it.each(['session-id', 'file-lease'] as const)('a stale %s mutex ticket with a reused PID does not block a proved unrelated replacement', async mode => {
  const f = await fixture();
  const inventory = createProcessInventory(f.local, false, [f.other]);
  const key = mode === 'session-id' ? 'session-id:target-session' : `lease:${f.file}`;
  const directory = join(f.local, 'locks', createHash('sha256').update(key).digest('hex'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'stale-ticket.json'), JSON.stringify({ version: 1, pid: process.pid, startIdentity: 'old-start', number: 1 }), { mode: 0o600 });
  const locks = createBothLocks({ root: f.local, inventory, file: async () => f.file, identity: f.identity, bootId: async () => 'boot-a' });
  expect(await locks('target-session', async held => held!.owns())).toBe(true);
});

it.each([
  ['session-id', 'matching'], ['session-id', 'unknown'], ['file-lease', 'matching'], ['file-lease', 'unknown'],
] as const)('a %s mutex ticket keeps a %s possibly-same owner blocking', async (mode, owner) => {
  const f = await fixture(), foreignPid = 99991;
  const key = mode === 'session-id' ? 'session-id:target-session' : `lease:${f.file}`;
  const directory = join(f.local, 'locks', createHash('sha256').update(key).digest('hex'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ticket = join(directory, 'owner-ticket.json');
  const contents = JSON.stringify({ version: 1, pid: foreignPid, startIdentity: 'owner-start', number: 1 });
  writeFileSync(ticket, contents, { mode: 0o600 });
  let entered = false;
  await expect(withProcessLock(f.local, key, async () => { entered = true; }, {
    identity: f.identity, reclaimReusedOwner: true, timeoutMs: 30,
    probe: async pid => pid !== foreignPid ? { kind: 'live', startIdentity: f.identity.startIdentity }
      : owner === 'matching' ? { kind: 'live', startIdentity: 'owner-start' } : { kind: 'unknown' },
  })).rejects.toMatchObject({ code: owner === 'matching' ? 'lock-occupied' : 'lock-owner-uncertain' });
  expect(entered).toBe(false);
  expect(readFileSync(ticket, 'utf8')).toBe(contents);
});

it('a read-only inventory never removes a stale registration from another runtime', async () => {
  const f = await fixture();
  await f.presence.record({ pid: 99999991, startIdentity: 'gone-start', sessionId: 'old-session' as SessionId, sessionFile: f.unrelated, sessionName: null, kind: 'top-level', hcAddress: null });
  await assessSessionLiveness(f.file, createProcessInventory(f.local, true, [f.other]));
  expect(await f.presence.list()).toHaveLength(2);
});
