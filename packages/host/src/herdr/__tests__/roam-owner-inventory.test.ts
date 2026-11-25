import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createProcessPresence } from '@spider/herdr/sessions/presence';
import { assessSessionLiveness } from '@spider/herdr/sessions/lease';
import { createBothLocks } from '@spider/roam/session-control';
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
  await presence.record({ ...identity, sessionId: 'other-session', sessionFile: unrelated, sessionName: null, kind: 'top-level', hcAddress: null });
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
  await f.presence.record({ ...f.identity, sessionId: 'target-session', sessionFile: f.file, sessionName: null, kind: 'top-level', hcAddress: null });
  expect(await assessSessionLiveness(f.file, createProcessInventory(f.local, false, [f.other]))).toMatchObject({ kind: 'live', pids: [process.pid] });
});

it('a reused PID in a different runtime remains an unidentified live process', async () => {
  const f = await fixture();
  await f.presence.remove(f.identity);
  await f.presence.record({ ...f.identity, startIdentity: 'old-start', sessionId: 'other-session', sessionFile: f.unrelated, sessionName: null, kind: 'top-level', hcAddress: null });
  expect(await assessSessionLiveness(f.file, createProcessInventory(f.local, false, [f.other]))).toMatchObject({ kind: 'uncertain', pids: [process.pid] });
  expect(await f.presence.list()).toHaveLength(1);
});

it('a read-only inventory never removes a stale registration from another runtime', async () => {
  const f = await fixture();
  await f.presence.record({ pid: 99999991, startIdentity: 'gone-start', sessionId: 'old-session', sessionFile: f.unrelated, sessionName: null, kind: 'top-level', hcAddress: null });
  await assessSessionLiveness(f.file, createProcessInventory(f.local, true, [f.other]));
  expect(await f.presence.list()).toHaveLength(2);
});
