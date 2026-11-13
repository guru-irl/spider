// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { claimIdLock, type IdLockHandle } from '../sessions/id-lock.js';
import { readLaunchHandoff, removeLaunchHandoff } from '../sessions/launch-handoff.js';
import { createSessionLeases, type ProcessIdentity, type ProcessInventoryPorts, type ProcessProbe } from '../sessions/lease.js';
import { createProcessPresence } from '../sessions/presence.js';
import { launchExactSession, type ExactSessionLaunchPorts, type LaunchNoStartProof, type PiSpawnRequest } from '../sessions/launcher.js';

let root: string;
let probes: Map<number, ProcessProbe>;
const launcher: ProcessIdentity = { pid: 101, startIdentity: 'launcher-start' };
const firstChild: ProcessIdentity = { pid: 102, startIdentity: 'child-one-start' };
const secondChild: ProcessIdentity = { pid: 103, startIdentity: 'child-two-start' };
const bootId = async () => 'boot-fixture';
const probe = async (pid: number): Promise<ProcessProbe> => probes.get(pid) ?? { kind: 'absent' };
const launchOperation = (request: PiSpawnRequest) => request.terminal!.labels['spider.roam.operation'];
const noTerminalProof = (operationId: string) => ({ kind: 'no-terminal-after-hc-exit' as const, operationId,
  coreIdBefore: 'destination-core', hcExitedAt: 100,
  first: { coreId: 'destination-core', issuedAt: 101, terminal: 'absent' as const },
  second: { coreId: 'destination-core', issuedAt: 351, terminal: 'absent' as const }, confirmationBoundMs: 250 });
const claim = (identity: ProcessIdentity, handoff?: { operationId: string; nonce: string }) =>
  claimIdLock(root, 'session-1', identity, probe, { bootId, ...(handoff ? { handoff } : {}) });

beforeEach(async () => {
  const base = resolve('.spider/scratch/exact-launch');
  await mkdir(base, { recursive: true });
  root = await mkdtemp(join(base, 'case-'));
  probes = new Map([launcher, firstChild, secondChild].map(identity => [identity.pid, { kind: 'live', startIdentity: identity.startIdentity }]));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function exactFixture() {
  const globalRoot = join(root, 'global'), cwd = join(root, 'workspace'), agent = join(root, 'agent');
  await Promise.all([globalRoot, cwd, agent].map(directory => mkdir(directory, { mode: 0o700 })));
  const stateRoot = join(globalRoot, 'herdr'), file = join(root, 'session.jsonl'), pi = join(root, 'bin', 'pi');
  const contents = JSON.stringify({ type: 'session', version: 3, id: 'session-1', cwd }) + '\n';
  await writeFile(file, contents, { mode: 0o600 });
  const sha256 = createHash('sha256').update(contents).digest('hex');
  const leases = createSessionLeases(stateRoot);
  const inventory: ProcessInventoryPorts = { leases, presence: createProcessPresence(stateRoot), processes: async () => [], probe };
  const spawned: PiSpawnRequest[] = [];
  let child: IdLockHandle | undefined;
  let wake!: () => void;
  const changed = new Promise<void>(resolveChange => { wake = resolveChange; });
  let now = 0;
  const adopt = async (request: PiSpawnRequest, identity = firstChild) => {
    const operationId = launchOperation(request), path = join(stateRoot, 'handoffs', `${operationId}.json`);
    const data = await readLaunchHandoff(stateRoot, path, request.sessionId, request.sessionFile);
    const handoff = { operationId, nonce: data.nonce, file: request.sessionFile };
    child = await claimIdLock(stateRoot, 'session-1', identity, probe, { bootId: ports.bootId, handoff });
    await leases.adopt(request.sessionFile, data.leaseToken, identity);
    await removeLaunchHandoff(stateRoot, operationId);
  };
  const ports: ExactSessionLaunchPorts = {
    leases, processInventory: inventory, processIdentity: launcher,
    env: { SPIDER_GLOBAL_ROOT: globalRoot, PI_CODING_AGENT_DIR: agent, PATH: '/fixture/bin',
      HC_SESSION: 'other', HC_SOCKET: '/foreign/core.sock', HC_TERMINAL_ID: 'foreign-terminal', HC_SCOPE: 'foreign' },
    bootId, limits: async () => ({ soft: 1024, hard: 100_000 }), shell: '/bin/sh',
    machineId: '2b6b318c-b186-4998-a64f-ab68f4cba113', core: { session: 'destination', socket: join(root, 'destination.sock'), coreId: 'destination-core' },
    launchMs: 1000, now: () => now, wait: async (ms: number) => { await changed; now += Math.max(ms, 1000); },
    reconcileLaunch: async operationId => ({ receipt: 'absent' as const, terminal: 'absent' as const, proof: noTerminalProof(operationId) }),
    spawnPi: async (request: PiSpawnRequest) => {
      spawned.push(request);
      try { await adopt(request); } finally { wake(); }
    },
  };
  return { globalRoot, stateRoot, file, cwd, pi, contents, sha256, leases, inventory, spawned, ports, adopt, wake,
    request: { sessionId: 'session-1', file, cwd, sha256, epoch: 2, moveId: 'move-1', pi },
    releaseChild: async () => { if (child) await child.release(); } };
}

it('a valid handoff nonce cannot adopt a different session file', async () => {
  const f = await exactFixture();
  const parent = await claimIdLock(f.stateRoot, 'session-1', launcher, probe, { bootId });
  const handoff = await parent.prepareHandoff('launch-op', f.file);
  await expect(claimIdLock(f.stateRoot, 'session-1', firstChild, probe, {
    bootId, handoff: { ...handoff, file: join(root, 'other.jsonl') },
  })).rejects.toMatchObject({ code: 'session-id-owner' });
  const child = await claimIdLock(f.stateRoot, 'session-1', firstChild, probe, {
    bootId, handoff: { ...handoff, file: f.file },
  });
  await child.release();
}, 5000);

it.each(['symlink', 'nonprivate'] as const)('unsafe handoff directory prevents launch: %s', async mode => {
  const f = await exactFixture();
  await mkdir(f.stateRoot, { mode: 0o700 });
  const directory = join(f.stateRoot, 'handoffs');
  if (mode === 'symlink') { const other = join(root, 'other-handoffs'); await mkdir(other, { mode: 0o700 }); await symlink(other, directory); }
  else { await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o755); }
  try {
    await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'unsafe-state-path' });
    expect(f.spawned).toEqual([]);
    expect(await f.leases.get(f.file)).toBeNull();
  } finally { await f.releaseChild(); }
}, 5000);

it('passes a private operation-named file to the child and removes it after adoption', async () => {
  const f = await exactFixture();
  let observed: { path: string; mode: number; directoryMode: number; nonce: string } | undefined;
  f.ports.spawnPi = async request => {
    f.spawned.push(request);
    const operationId = request.terminal!.labels['spider.roam.operation'];
    const path = join(f.stateRoot, 'handoffs', `${operationId}.json`);
    const info = await lstat(path).catch(() => null);
    if (info) {
      const directory = await lstat(join(f.stateRoot, 'handoffs'));
      const record = JSON.parse(await readFile(path, 'utf8')) as { nonce: string };
      observed = { path, mode: info.mode & 0o777, directoryMode: directory.mode & 0o777, nonce: record.nonce };
    }
    try { await f.adopt(request); } finally { f.wake(); }
  };
  await launchExactSession(f.request, f.ports);
  expect(observed).toBeDefined();
  expect(observed!.mode).toBe(0o600);
  expect(observed!.directoryMode).toBe(0o700);
  expect(f.spawned[0].argv.slice(5, 8)).toEqual([f.globalRoot, f.ports.env.PI_CODING_AGENT_DIR, observed!.path]);
  expect(f.spawned[0].argv.join('\n')).not.toContain(observed!.nonce);
  expect(JSON.stringify(f.spawned[0].terminal?.labels)).not.toContain(observed!.nonce);
  expect(f.spawned[0].env.SPIDER_HERDR_HANDOFF_NONCE).toBeUndefined();
  expect(await lstat(observed!.path).catch(() => null)).toBeNull();
  await f.releaseChild();
}, 5000);

it('launches an exact session in the destination core after both locks are adopted', async () => {
  const module = await import('../sessions/launcher.js');
  expect(typeof module.launchExactSession).toBe('function');
  if (typeof module.launchExactSession !== 'function') return;
  const f = await exactFixture();
  const result = await module.launchExactSession(f.request, f.ports);
  expect(result).toMatchObject({ ...firstChild, sessionId: 'session-1', sessionFile: f.file, cwd: f.cwd });
  expect(f.spawned).toHaveLength(1);
  const launch = f.spawned[0], execTail = launch.argv.slice(-3), shellScript = launch.argv[2];
  expect(execTail).toEqual([f.pi, '--session', f.file]);
  expect(shellScript).toContain('ulimit -Sn');
  expect(shellScript).toContain('SPIDER_HERDR_HANDOFF_FILE');
  expect(shellScript).toContain('PI_SUBAGENT_CHILD');
  expect(shellScript).toContain('exec "$@"');
  expect(launch.argv[4]).toBe(String(Math.min(100_000, Math.max(1024, 65_536))));
  expect(Object.fromEntries(Object.entries(launch.env).filter(([key]) => key.startsWith('HC_')))).toEqual({ HC_SESSION: 'destination', HC_SOCKET: f.ports.core.socket });
  expect(launch.env.SPIDER_HERDR_HANDOFF_NONCE).toBeUndefined();
  expect(launch.terminal).toMatchObject({ background: true, noNotify: true, outliveParent: true, parent: null,
    labels: { 'spider.session': 'session-1', 'spider.machine': f.ports.machineId, 'spider.roam.epoch': '2', 'spider.roam.move': 'move-1', 'spider.roam.operation': result.operationId } });
  await expect(claimIdLock(f.stateRoot, 'session-1', secondChild, probe, { bootId })).rejects.toMatchObject({ code: 'session-id-owner' });
  await f.releaseChild();
}, 5000);

it.each(['missing', 'empty', 'changed', 'replaced', 'symlink'] as const)('empty missing or replaced exact file never launches: %s', async mode => {
  const f = await exactFixture();
  if (mode === 'missing') await unlink(f.file);
  if (mode === 'empty') await writeFile(f.file, '');
  if (mode === 'changed') await writeFile(f.file, f.contents + '{}\n');
  if (mode === 'replaced') f.ports.limits = async () => {
    const replacement = join(root, 'replacement.jsonl');
    await writeFile(replacement, f.contents + '{}\n');
    await rename(replacement, f.file);
    return { soft: 1024, hard: 100_000 };
  };
  if (mode === 'symlink') {
    const alias = join(root, 'alias.jsonl'); await symlink(f.file, alias); f.request.file = alias;
  }
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'session-file-invalid' });
  expect(f.spawned).toEqual([]);
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect(await inspectIdLock(f.stateRoot, 'session-1')).toBeNull();
}, 5000);

it('honors a configured lower session-artifact limit', async () => {
  const f = await exactFixture();
  Object.assign(f.ports, { sessionBytes: Buffer.byteLength(f.contents) - 1 });
  try {
    await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'session-file-invalid' });
    expect(f.spawned).toEqual([]);
    expect(await f.leases.get(f.file)).toBeNull();
  } finally { await f.releaseChild(); }
}, 5000);

it('allows a session artifact exactly at the configured limit', async () => {
  const f = await exactFixture();
  f.ports.sessionBytes = Buffer.byteLength(f.contents);
  await expect(launchExactSession(f.request, f.ports)).resolves.toMatchObject(firstChild);
  expect(f.spawned).toHaveLength(1);
  await f.releaseChild();
}, 5000);

it.each([1, 2])('accepts a legacy version %s persistent session header', async version => {
  const f = await exactFixture();
  const contents = JSON.stringify({ type: 'session', version, id: 'session-1', cwd: f.cwd }) + '\n';
  await writeFile(f.file, contents, { mode: 0o600 });
  f.request.sha256 = createHash('sha256').update(contents).digest('hex');
  await expect(launchExactSession(f.request, f.ports)).resolves.toMatchObject(firstChild);
  expect(f.spawned).toHaveLength(1);
  await f.releaseChild();
}, 5000);

it('refuses a session file readable by other users', async () => {
  const f = await exactFixture();
  await chmod(f.file, 0o644);
  const outcome = await launchExactSession(f.request, f.ports).then(() => 'launched', error => error.code as string);
  expect(outcome).toBe('session-file-invalid');
  expect(f.spawned).toEqual([]);
}, 5000);

it('refuses a same-content file replacement between validation and launch', async () => {
  const f = await exactFixture();
  f.ports.limits = async () => {
    const replacement = join(root, 'same-bytes.jsonl');
    await writeFile(replacement, f.contents, { mode: 0o600 });
    await rename(replacement, f.file);
    return { soft: 1024, hard: 100_000 };
  };
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'session-file-invalid' });
  expect(f.spawned).toEqual([]);
  expect(await f.leases.get(f.file)).toBeNull();
}, 5000);

it.each([
  [1024, 100_000, '65536'],
  [80_000, 100_000, '80000'],
  [1024, 32_000, '32000'],
  [1024, Infinity, '65536'],
  [Infinity, Infinity, 'unlimited'],
])('shell raises soft limit without lowering it or exceeding hard: %s, %s', async (soft, hard, expected) => {
  const f = await exactFixture();
  f.ports.limits = async () => ({ soft, hard });
  await launchExactSession(f.request, f.ports);
  expect(f.spawned[0].argv[4]).toBe(expected);
  expect(f.spawned[0].argv.slice(-3)).toEqual([f.pi, '--session', f.file]);
  await f.releaseChild();
}, 5000);

it.each(['unknown', 'reused'] as const)('boot ID or start time defeats PID reuse: %s', async mode => {
  const f = await exactFixture();
  const prior = { pid: 500, startIdentity: 'old-start' };
  await f.leases.claim(f.file, prior, f.inventory, { mode: 'cutover', bootId: 'boot-fixture' });
  probes.set(prior.pid, mode === 'unknown' ? { kind: 'unknown' } : { kind: 'live', startIdentity: 'new-start' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'session-may-be-live' });
  expect(f.spawned).toEqual([]);
  expect(await f.leases.get(f.file)).toMatchObject(prior);
}, 5000);

it('reclaims a file lease only after its owner is proved absent', async () => {
  const f = await exactFixture();
  const prior = { pid: 500, startIdentity: 'old-start' };
  await f.leases.claim(f.file, prior, f.inventory, { mode: 'cutover', bootId: 'boot-fixture' });
  probes.set(prior.pid, { kind: 'absent' });
  await expect(launchExactSession(f.request, f.ports)).resolves.toMatchObject(firstChild);
  expect(await f.leases.get(f.file)).toMatchObject(firstChild);
  await f.releaseChild();
}, 5000);

it('does not infer a legacy file lease boot identity from a different lock', async () => {
  const f = await exactFixture();
  const old = { pid: 500, startIdentity: 'linux:123' };
  const oldBoot = async () => '11111111-1111-4111-8111-111111111111';
  probes.set(old.pid, { kind: 'live', startIdentity: old.startIdentity });
  await claimIdLock(f.stateRoot, 'session-1', old, probe, { bootId: oldBoot });
  await f.leases.claim(f.file, old, f.inventory);
  f.ports.bootId = async () => '22222222-2222-4222-8222-222222222222';
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'session-may-be-live' });
  expect(f.spawned).toEqual([]);
  expect(await f.leases.get(f.file)).toMatchObject(old);
}, 5000);

it('a changed boot ID reclaims a stale file lease even when PID and start ticks repeat', async () => {
  const f = await exactFixture();
  const old = { pid: 500, startIdentity: 'linux:123' };
  const oldBoot = async () => '11111111-1111-4111-8111-111111111111';
  const currentBoot = async () => '22222222-2222-4222-8222-222222222222';
  probes.set(old.pid, { kind: 'live', startIdentity: old.startIdentity });
  const oldId = await claimIdLock(f.stateRoot, 'session-1', old, probe, { bootId: oldBoot });
  await f.leases.claim(f.file, old, f.inventory, { mode: 'cutover', bootId: await oldBoot() });
  f.ports.bootId = currentBoot;
  await expect(launchExactSession(f.request, f.ports)).resolves.toMatchObject(firstChild);
  expect(await f.leases.get(f.file)).toMatchObject(firstChild);
  await oldId.release();
  await f.releaseChild();
}, 5000);

it.each(['empty', 'unavailable'] as const)('unknown boot identity prevents launch: %s', async mode => {
  const f = await exactFixture();
  f.ports.bootId = async () => { if (mode === 'unavailable') throw new Error('private boot detail'); return ''; };
  const error = await launchExactSession(f.request, f.ports).catch(value => value as Error & { code?: string });
  expect(error).toMatchObject({ code: 'process-identity-unavailable' });
  expect(String(error)).not.toContain('private boot detail');
  expect(f.spawned).toEqual([]);
}, 5000);

it('a failed limit probe releases the reservation without exposing probe details', async () => {
  const f = await exactFixture();
  f.ports.limits = async () => { throw new Error('private limit detail'); };
  const error = await launchExactSession(f.request, f.ports).catch(value => value as Error & { code?: string });
  expect(error).toMatchObject({ code: 'launch-limits-unavailable' });
  expect(String(error)).not.toContain('private limit detail');
  expect(f.spawned).toEqual([]);
  expect(await f.leases.get(f.file)).toBeNull();
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect(await inspectIdLock(f.stateRoot, 'session-1')).toBeNull();
}, 5000);

it.each([[65_536, 1024], [-1, 1024], [NaN, 1024], [Infinity, 65_536]])('invalid file limits are refused: %s, %s', async (soft, hard) => {
  const f = await exactFixture();
  f.ports.limits = async () => ({ soft, hard });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-limits-invalid' });
  expect(f.spawned).toEqual([]);
  expect(await f.leases.get(f.file)).toBeNull();
}, 5000);

it.each([-1, 0, Infinity, NaN])('invalid launch deadline is refused: %s', async value => {
  const f = await exactFixture();
  f.ports.launchMs = value;
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); };
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-deadline-invalid' });
  expect(f.spawned).toEqual([]);
  expect(await f.leases.get(f.file)).toBeNull();
}, 5000);

it('refuses file leases from a different destination ownership root', async () => {
  const f = await exactFixture();
  const foreign = createSessionLeases(join(root, 'foreign'));
  const ports = { ...f.ports, leases: foreign, processInventory: { ...f.inventory, leases: foreign } };
  await expect(launchExactSession(f.request, ports)).rejects.toMatchObject({ code: 'launch-environment-invalid' });
  expect(f.spawned).toEqual([]);
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect(await inspectIdLock(f.stateRoot, 'session-1')).toBeNull();
}, 5000);

it('both locks prevent duplicate local ID while the first spawn is pending', async () => {
  const f = await exactFixture();
  const otherFile = join(root, 'other.jsonl');
  await writeFile(otherFile, f.contents);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolveStarted => { entered = resolveStarted; });
  const gate = new Promise<void>(resolveGate => { finish = resolveGate; });
  f.ports.spawnPi = async request => { f.spawned.push(request); entered(); await gate; try { await f.adopt(request); } finally { f.wake(); } };
  const first = launchExactSession(f.request, f.ports);
  await started;
  try {
    await expect(launchExactSession({ ...f.request, file: otherFile }, f.ports)).rejects.toMatchObject({ code: 'session-id-owner' });
    expect(f.spawned).toHaveLength(1);
  } finally { finish(); }
  await expect(first).resolves.toMatchObject(firstChild);
  await f.releaseChild();
}, 5000);

it('a competing launch cannot release another launch reservation before handoff', async () => {
  const f = await exactFixture();
  let entered!: () => void, finish!: () => void;
  const enteredLimits = new Promise<void>(resolveEntered => { entered = resolveEntered; });
  const gate = new Promise<void>(resolveGate => { finish = resolveGate; });
  f.ports.limits = async () => { entered(); await gate; return { soft: 1024, hard: 100_000 }; };
  const first = launchExactSession(f.request, f.ports);
  await enteredLimits;
  try { await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'session-id-owner' }); }
  finally { finish(); }
  await expect(first).resolves.toMatchObject(firstChild);
  expect(f.spawned).toHaveLength(1);
  await f.releaseChild();
}, 5000);

it('finishes after child adoption even when the spawn reply never arrives', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => {
    f.spawned.push(request);
    try { await f.adopt(request); } finally { f.wake(); }
    await new Promise<void>(() => {});
  };
  await expect(launchExactSession(f.request, f.ports)).resolves.toMatchObject(firstChild);
  expect(f.spawned).toHaveLength(1);
  await f.releaseChild();
}, 5000);

it('reconciles a lost spawn reply after the child adopts', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => {
    f.spawned.push(request);
    try { await f.adopt(request); } finally { f.wake(); }
    throw new Error('lost reply');
  };
  await expect(launchExactSession(f.request, f.ports)).resolves.toMatchObject(firstChild);
  expect(f.spawned).toHaveLength(1);
  await f.releaseChild();
}, 5000);

it.each([
  { errorCode: 'core-unavailable' as const }, { errorCode: 'core-mismatch' as const },
  { errorCode: 'missing-hc' as const, hcPid: null }, { errorCode: 'spawn-error' as const, hcPid: null },
])('clears a handoff for a proved pre-launch error: %o', async failure => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('failed'); };
  f.ports.reconcileLaunch = async operationId => ({ receipt: 'unknown', terminal: 'unknown',
    proof: { kind: 'prelaunch-error', operationId, beforeLaunch: true, ...failure } });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-not-started' });
  expect(await f.leases.get(f.file)).toBeNull();
  expect(await lstat(join(f.stateRoot, 'handoffs', `${launchOperation(f.spawned[0])}.json`)).catch(() => null)).toBeNull();
}, 5000);

it.each(['wrong-operation', 'changed-before', 'changed-first', 'changed-second', 'first-before-exit',
  'second-too-soon', 'first-present', 'second-present', 'zero-bound', 'current-terminal-present'] as const)
('incomplete two-query proof stays fenced: %s', async mode => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async operationId => {
    const proof = noTerminalProof(operationId);
    if (mode === 'wrong-operation') proof.operationId = 'different-operation';
    if (mode === 'changed-before') proof.coreIdBefore = 'other-core';
    if (mode === 'changed-first') proof.first.coreId = 'other-core';
    if (mode === 'changed-second') proof.second.coreId = 'other-core';
    if (mode === 'first-before-exit') proof.first.issuedAt = proof.hcExitedAt;
    if (mode === 'second-too-soon') proof.second.issuedAt--;
    if (mode === 'first-present') Object.assign(proof.first, { terminal: 'present' });
    if (mode === 'second-present') Object.assign(proof.second, { terminal: 'present' });
    if (mode === 'zero-bound') proof.confirmationBoundMs = 0;
    return { receipt: 'absent', terminal: mode === 'current-terminal-present' ? 'present' : 'absent', proof };
  };
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  expect(f.spawned).toHaveLength(1);
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
}, 5000);

it('a core-mismatch error with launch details is not a pre-call proof', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async operationId => ({ receipt: 'unknown', terminal: 'unknown',
    proof: { kind: 'prelaunch-error', operationId, errorCode: 'core-mismatch', beforeLaunch: true, details: { pid: 123 } } as unknown as LaunchNoStartProof });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
}, 5000);

it('a missing-hc proof with a process ID stays pending', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async operationId => ({ receipt: 'unknown', terminal: 'unknown',
    proof: { kind: 'prelaunch-error', operationId, errorCode: 'missing-hc', hcPid: 123, beforeLaunch: true } as unknown as LaunchNoStartProof });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
}, 5000);

it('does not accept an ambiguous timeout as a pre-launch error', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async operationId => ({ receipt: 'absent', terminal: 'absent',
    proof: { kind: 'prelaunch-error', operationId, errorCode: 'cli-timeout', beforeLaunch: true } as unknown as LaunchNoStartProof });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
}, 5000);

it('clears a handoff when its observed terminal exited without adoption', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async operationId => ({ receipt: 'started', terminal: 'present',
    proof: { kind: 'terminal-exited-without-adoption', operationId, coreId: 'destination-core', terminalId: 't7', terminalExited: true, lockNeverAdopted: true } });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-not-started' });
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect(await inspectIdLock(f.stateRoot, 'session-1')).toBeNull();
  expect(await f.leases.get(f.file)).toBeNull();
  expect(await lstat(join(f.stateRoot, 'handoffs', `${launchOperation(f.spawned[0])}.json`)).catch(() => null)).toBeNull();
}, 5000);

it.each(['wrong-operation', 'changed-core', 'missing-terminal', 'remote-terminal', 'still-live', 'adoption-seen'] as const)
('incomplete terminal-exit proof stays fenced: %s', async mode => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async operationId => ({ receipt: 'started', terminal: 'present', proof: {
    kind: 'terminal-exited-without-adoption', operationId: mode === 'wrong-operation' ? 'different-operation' : operationId,
    coreId: mode === 'changed-core' ? 'other-core' : 'destination-core', terminalId: mode === 'missing-terminal' ? '' : mode === 'remote-terminal' ? 'other.invalid/t7' : 't7',
    terminalExited: mode !== 'still-live', lockNeverAdopted: mode !== 'adoption-seen',
  } as unknown as LaunchNoStartProof });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
}, 5000);

it('accepts a proved terminal exit even if the local spawn reply never arrives', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); await new Promise<void>(() => {}); };
  f.ports.reconcileLaunch = async operationId => ({ receipt: 'started', terminal: 'present',
    proof: { kind: 'terminal-exited-without-adoption', operationId, coreId: 'destination-core', terminalId: 't7', terminalExited: true, lockNeverAdopted: true } });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-not-started' });
  expect(await f.leases.get(f.file)).toBeNull();
}, 5000);

it('reconciles a lost reply and releases both locks only when no start is proved', async () => {
  const f = await exactFixture();
  let observedOperation = '';
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async operationId => { observedOperation = operationId; return { receipt: 'absent', terminal: 'absent', proof: noTerminalProof(operationId) }; };
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-not-started' });
  expect(observedOperation).toBe(launchOperation(f.spawned[0]));
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect(await inspectIdLock(f.stateRoot, 'session-1')).toBeNull();
  expect(await f.leases.get(f.file)).toBeNull();
}, 5000);

it('does not release or respawn when a lost reply has start evidence', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => ({ receipt: 'started', terminal: 'present' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  expect(f.spawned).toHaveLength(1);
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect(await inspectIdLock(f.stateRoot, 'session-1')).toMatchObject({ pendingOperationId: launchOperation(f.spawned[0]) });
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
}, 5000);

it('reconciles a dead launcher handoff before allowing another child', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => ({ receipt: 'started', terminal: 'present' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  const firstOperation = launchOperation(f.spawned[0]);
  probes.set(launcher.pid, { kind: 'absent' });
  const replacement = { pid: 104, startIdentity: 'new-launcher-start' };
  probes.set(replacement.pid, { kind: 'live', startIdentity: replacement.startIdentity });
  let reconciled = '';
  const ports = { ...f.ports, processIdentity: replacement, reconcileLaunch: async (operationId: string) => {
    reconciled = operationId; return { receipt: 'started' as const, terminal: 'present' as const };
  } };
  await expect(launchExactSession(f.request, ports)).rejects.toMatchObject({ code: 'launch-pending' });
  expect(reconciled).toBe(firstOperation);
  expect(f.spawned).toHaveLength(1);
  await f.adopt(f.spawned[0]);
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect(await inspectIdLock(f.stateRoot, 'session-1')).toMatchObject({ identity: firstChild, operationId: firstOperation });
  await f.releaseChild();
}, 5000);

it('a replacement launcher retries only after both start records are absent', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => ({ receipt: 'unknown', terminal: 'unknown' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  const firstOperation = launchOperation(f.spawned[0]);
  probes.set(launcher.pid, { kind: 'absent' });
  const replacement = { pid: 104, startIdentity: 'new-launcher-start' };
  probes.set(replacement.pid, { kind: 'live', startIdentity: replacement.startIdentity });
  let reconciled = '', adopted!: () => void;
  const ready = new Promise<void>(resolveReady => { adopted = resolveReady; });
  const ports: ExactSessionLaunchPorts = { ...f.ports, processIdentity: replacement, reconcileLaunch: async operationId => {
    reconciled = operationId; return { receipt: 'absent', terminal: 'absent', proof: noTerminalProof(operationId) };
  }, wait: async () => { await ready; }, spawnPi: async request => { f.spawned.push(request); try { await f.adopt(request); } finally { adopted(); } } };
  await expect(launchExactSession(f.request, ports)).resolves.toMatchObject(firstChild);
  expect(reconciled).toBe(firstOperation);
  expect(f.spawned).toHaveLength(2);
  expect(launchOperation(f.spawned[1])).not.toBe(firstOperation);
  await f.releaseChild();
}, 5000);

it.each([
  { receipt: 'started', terminal: 'absent' }, { receipt: 'finished', terminal: 'absent' },
  { receipt: 'absent', terminal: 'present' }, { receipt: 'unknown', terminal: 'absent' },
  { receipt: 'absent', terminal: 'unknown' },
] as const)('incomplete reconciliation keeps both locks: %o', async evidence => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => ({ ...evidence, noStartProven: true });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  expect(f.spawned).toHaveLength(1);
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
}, 5000);

it('absence snapshots alone do not prove an uncertain launch cannot start later', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => ({ receipt: 'absent', terminal: 'absent' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  expect(f.spawned).toHaveLength(1);
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect((await inspectIdLock(f.stateRoot, 'session-1'))?.pendingOperationId).toBe(launchOperation(f.spawned[0]));
  expect(await lstat(join(f.stateRoot, 'handoffs', `${launchOperation(f.spawned[0])}.json`)).catch(() => null)).not.toBeNull();
}, 5000);

it('does not replace a pending handoff while the spawn request can still start a child', async () => {
  const f = await exactFixture();
  let finish!: () => void;
  const inFlight = new Promise<void>(resolveFlight => { finish = resolveFlight; });
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); await inFlight; throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => ({ receipt: 'absent', terminal: 'absent' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  try {
    await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
    expect(f.spawned).toHaveLength(1);
  } finally { finish(); }
}, 5000);

it('a new core cannot prove absence for an operation started on the old core', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => ({ receipt: 'unknown', terminal: 'unknown' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  f.ports.core.coreId = 'replacement-core';
  f.ports.reconcileLaunch = async operationId => {
    const proof = noTerminalProof(operationId);
    proof.coreIdBefore = proof.first.coreId = proof.second.coreId = 'replacement-core';
    return { receipt: 'absent', terminal: 'absent', proof };
  };
  let adopted!: () => void;
  const ready = new Promise<void>(resolveReady => { adopted = resolveReady; });
  f.ports.wait = async () => { await ready; };
  f.ports.spawnPi = async request => { f.spawned.push(request); try { await f.adopt(request); } finally { adopted(); } };
  try {
    await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
    expect(f.spawned).toHaveLength(1);
  } finally { await f.releaseChild(); }
}, 5000);

it('reconciles an old handoff even if the next requested file is missing', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => ({ receipt: 'unknown', terminal: 'unknown' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  const oldOperation = launchOperation(f.spawned[0]);
  await unlink(f.file);
  let reconciled = '';
  f.ports.reconcileLaunch = async operationId => { reconciled = operationId; return { receipt: 'absent', terminal: 'absent', proof: noTerminalProof(operationId) }; };
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'session-file-invalid' });
  expect(reconciled).toBe(oldOperation);
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect(await inspectIdLock(f.stateRoot, 'session-1')).toBeNull();
  expect(await f.leases.get(f.file)).toBeNull();
  expect(await lstat(join(f.stateRoot, 'handoffs', `${oldOperation}.json`)).catch(() => null)).toBeNull();
  expect(f.spawned).toHaveLength(1);
}, 5000);

it('only one same-process retry can reconcile a pending handoff', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => ({ receipt: 'unknown', terminal: 'unknown' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  let entered!: () => void, unblock!: () => void, adopted!: () => void;
  const inReconciliation = new Promise<void>(resolveEntered => { entered = resolveEntered; });
  const barrier = new Promise<void>(resolveBarrier => { unblock = resolveBarrier; });
  const ready = new Promise<void>(resolveReady => { adopted = resolveReady; });
  f.ports.reconcileLaunch = async operationId => { entered(); await barrier; return { receipt: 'absent', terminal: 'absent', proof: noTerminalProof(operationId) }; };
  f.ports.wait = async () => { await ready; };
  f.ports.spawnPi = async request => { f.spawned.push(request); try { await f.adopt(request); } finally { adopted(); } };
  const firstRetry = launchExactSession(f.request, f.ports);
  await inReconciliation;
  try { await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'session-id-owner' }); }
  finally { unblock(); }
  await expect(firstRetry).resolves.toMatchObject(firstChild);
  expect(f.spawned).toHaveLength(2);
  await f.releaseChild();
}, 5000);

it('the same launcher can reconcile a pending no-start and retry without leaving the old file leased', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => ({ receipt: 'unknown', terminal: 'unknown' });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  const firstOperation = launchOperation(f.spawned[0]);
  const firstNonce = JSON.parse(await readFile(join(f.stateRoot, 'handoffs', `${firstOperation}.json`), 'utf8')).nonce as string;
  const otherFile = join(root, 'retry.jsonl');
  await writeFile(otherFile, f.contents, { mode: 0o600 });
  let adopted!: () => void, secondNonce = '';
  const ready = new Promise<void>(resolveReady => { adopted = resolveReady; });
  f.ports.reconcileLaunch = async operationId => ({ receipt: 'absent', terminal: 'absent', proof: noTerminalProof(operationId) });
  f.ports.wait = async () => { await ready; };
  f.ports.spawnPi = async request => {
    f.spawned.push(request);
    try {
      const path = join(f.stateRoot, 'handoffs', `${launchOperation(request)}.json`);
      secondNonce = (await readLaunchHandoff(f.stateRoot, path, request.sessionId, request.sessionFile)).nonce;
      await f.adopt(request);
    } finally { adopted(); }
  };
  await expect(launchExactSession({ ...f.request, file: otherFile }, f.ports)).resolves.toMatchObject(firstChild);
  expect(f.spawned).toHaveLength(2);
  expect(launchOperation(f.spawned[1])).not.toBe(firstOperation);
  expect(secondNonce).not.toBe(firstNonce);
  expect(await lstat(join(f.stateRoot, 'handoffs', `${firstOperation}.json`)).catch(() => null)).toBeNull();
  expect(await f.leases.get(f.file)).toBeNull();
  expect(await f.leases.get(otherFile)).toMatchObject(firstChild);
  await f.releaseChild();
}, 5000);

it('an unknown child process cannot complete adoption', async () => {
  const f = await exactFixture();
  f.ports.processInventory.probe = async pid => pid === firstChild.pid ? { kind: 'unknown' } : probe(pid);
  f.ports.reconcileLaunch = async () => ({ receipt: 'unknown', terminal: 'unknown' });
  try {
    await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
    expect(await f.leases.get(f.file)).toMatchObject(firstChild);
  } finally { await f.releaseChild(); }
}, 5000);

it('an unavailable child identity probe stays pending without exposing probe details', async () => {
  const f = await exactFixture();
  f.ports.processInventory.probe = async pid => { if (pid === firstChild.pid) throw new Error('private probe detail'); return probe(pid); };
  f.ports.reconcileLaunch = async () => ({ receipt: 'unknown', terminal: 'unknown' });
  try {
    const error = await launchExactSession(f.request, f.ports).catch(value => value as Error & { code?: string });
    expect(error).toMatchObject({ code: 'launch-pending' });
    expect(String(error)).not.toContain('private probe detail');
    expect(await f.leases.get(f.file)).toMatchObject(firstChild);
  } finally { await f.releaseChild(); }
}, 5000);

it('an overdue reconciliation is aborted and leaves the operation pending', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  let aborted = false;
  Object.assign(f.ports, { reconcileMs: 20, reconcileLaunch: async (operationId: string, options?: { signal: AbortSignal }) => {
    if (!options) return { receipt: 'absent', terminal: 'absent', proof: noTerminalProof(operationId) };
    await new Promise<void>(resolveAbort => options.signal.addEventListener('abort', () => { aborted = true; resolveAbort(); }, { once: true }));
    return { receipt: 'unknown', terminal: 'unknown' };
  } });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  expect(aborted).toBe(true);
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
}, 5000);

it('a no-start result arriving after the reconciliation deadline cannot clear the handoff', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  let finish!: (value: { receipt: 'absent'; terminal: 'absent'; proof: ReturnType<typeof noTerminalProof> }) => void;
  f.ports.reconcileMs = 20;
  f.ports.reconcileLaunch = async () => new Promise(resolveObservation => { finish = resolveObservation; });
  await expect(launchExactSession(f.request, f.ports)).rejects.toMatchObject({ code: 'launch-pending' });
  finish({ receipt: 'absent', terminal: 'absent', proof: noTerminalProof(launchOperation(f.spawned[0])) });
  await Promise.resolve();
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect(await inspectIdLock(f.stateRoot, 'session-1')).toMatchObject({ pendingOperationId: launchOperation(f.spawned[0]) });
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
}, 5000);

it('keeps ownership and redacts reconciliation failures', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async () => { throw new Error('private fixture detail'); };
  const error = await launchExactSession(f.request, f.ports).catch(value => value as Error & { code?: string });
  expect(error).toMatchObject({ code: 'launch-pending' });
  expect(String(error)).not.toContain('private fixture detail');
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  expect(await inspectIdLock(f.stateRoot, 'session-1')).toMatchObject({ pendingOperationId: launchOperation(f.spawned[0]) });
  expect(await f.leases.get(f.file)).toMatchObject(launcher);
}, 5000);

it('does not cancel when a child adopts during no-start reconciliation', async () => {
  const f = await exactFixture();
  f.ports.spawnPi = async request => { f.spawned.push(request); f.wake(); throw new Error('lost reply'); };
  f.ports.reconcileLaunch = async operationId => { await f.adopt(f.spawned[0]); return { receipt: 'absent', terminal: 'absent', proof: noTerminalProof(operationId) }; };
  await expect(launchExactSession(f.request, f.ports)).resolves.toMatchObject(firstChild);
  expect(await f.leases.get(f.file)).toMatchObject(firstChild);
  await f.releaseChild();
}, 5000);

it('observes the adopting operation without exposing handoff secrets', async () => {
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  const owner = await claim(launcher);
  const handoff = await owner.prepareHandoff('launch-1');
  const pending = await inspectIdLock(root, 'session-1');
  expect(pending).toMatchObject({ identity: launcher, pendingOperationId: 'launch-1', operationId: null });
  expect(JSON.stringify(pending)).not.toContain(handoff.nonce);
  const child = await claim(firstChild, handoff);
  const adopted = await inspectIdLock(root, 'session-1');
  expect(adopted).toMatchObject({ identity: firstChild, pendingOperationId: null, operationId: 'launch-1' });
  expect(JSON.stringify(adopted)).not.toContain(handoff.nonce);
  await owner.release();
  await child.release();
  expect(await inspectIdLock(root, 'session-1')).toBeNull();
}, 5000);

it('keeps a pending handoff until its operation is explicitly cancelled', async () => {
  const { inspectIdLock } = await import('../sessions/id-lock.js');
  const owner = await claim(launcher);
  const handoff = await owner.prepareHandoff('launch-1');
  await expect(owner.release()).rejects.toMatchObject({ code: 'session-id-owner' });
  expect(await owner.cancelHandoff('another-launch')).toBe(false);
  expect(await inspectIdLock(root, 'session-1')).toMatchObject({ pendingOperationId: 'launch-1' });
  expect(await owner.cancelHandoff('launch-1')).toBe(true);
  expect(await inspectIdLock(root, 'session-1')).toBeNull();
  await expect(claim(firstChild, handoff)).rejects.toMatchObject({ code: 'session-id-owner' });
}, 5000);

it('a no-start cancellation cannot remove an already adopted owner', async () => {
  const owner = await claim(launcher);
  const handoff = await owner.prepareHandoff('launch-1');
  const child = await claim(firstChild, handoff);
  expect(await owner.cancelHandoff('launch-1')).toBe(false);
  await expect(claim(secondChild)).rejects.toMatchObject({ code: 'session-id-owner' });
  await child.release();
}, 5000);

it('allows the intended child to adopt before the spawn reply', async () => {
  const owner = await claim(launcher);
  const handoff = await owner.prepareHandoff('launch-1');
  const child = await claim(firstChild, handoff);
  await owner.release();
  await expect(claim(secondChild)).rejects.toMatchObject({ code: 'session-id-owner' });
  await child.release();
  const replacement = await claim(secondChild);
  await replacement.release();
}, 5000);

it('refuses a wrong handoff nonce without consuming the intended handoff', async () => {
  const owner = await claim(launcher);
  const handoff = await owner.prepareHandoff('launch-1');
  await expect(claim(secondChild, { ...handoff, nonce: '0'.repeat(64) })).rejects.toMatchObject({ code: 'session-id-owner' });
  const child = await claim(firstChild, handoff);
  await owner.release();
  await expect(claim(secondChild)).rejects.toMatchObject({ code: 'session-id-owner' });
  await child.release();
}, 5000);

it('allows only one of two children to adopt the same nonce', async () => {
  const owner = await claim(launcher);
  const handoff = await owner.prepareHandoff('launch-1');
  const results = await Promise.allSettled([claim(firstChild, handoff), claim(secondChild, handoff)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  await owner.release();
  const winner = results.find(result => result.status === 'fulfilled');
  if (winner?.status === 'fulfilled') await winner.value.release();
}, 5000);

it('allows the intended child to adopt after the launcher dies', async () => {
  const owner = await claim(launcher);
  const handoff = await owner.prepareHandoff('launch-1');
  probes.set(launcher.pid, { kind: 'absent' });
  const child = await claim(firstChild, handoff);
  await owner.release();
  await expect(claim(secondChild)).rejects.toMatchObject({ code: 'session-id-owner' });
  await child.release();
}, 5000);

it('a dead launcher alone cannot clear a pending handoff', async () => {
  const owner = await claim(launcher);
  const handoff = await owner.prepareHandoff('launch-1');
  probes.set(launcher.pid, { kind: 'absent' });
  await expect(claim(secondChild)).rejects.toMatchObject({ code: 'session-id-owner' });
  await expect(claimIdLock(root, 'session-1', secondChild, probe, { bootId, recoverPending: 'launch-1' })).rejects.toMatchObject({ code: 'session-id-owner' });
  const child = await claim(firstChild, handoff);
  await owner.release();
  await expect(claim(secondChild)).rejects.toMatchObject({ code: 'session-id-owner' });
  await child.release();
}, 5000);
