// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { migrate, openDb } from '@spider/db-core';
import { mapRepository } from '@spider/db-core/roam/repo-map';
import { enableMemoryCapture } from '@spider/db-core/roam/seed';
import { processStartIdentity } from '../../src/jobs/handoff.js';
import { inspectIdLock } from '../../src/sessions/id-lock.js';
import { createSessionLeases } from '../../src/sessions/lease.js';
import { readObserved } from '../harness/pi.js';
import { spawnOwned, type OwnedProcess } from '../harness/processes.js';
import { identityOf } from '../harness/resources.js';
import type { Side } from '../harness/hc.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';
import { mark } from './child-scripts.js';
import { assertNativeLaunch } from './relocate-assertions.js';

const HUB = '00000000-0000-4000-8000-000000000001';
const BOX = '00000000-0000-4000-8000-000000000002';
const REPO = '00000000-0000-4000-8000-000000000003';

interface Machine { id: string; side: Side; root: string; agent: string; env: Record<string, string> }
export interface RelocateOwner { pid: number; terminal: string; sessionId: string; file: string; cwd: string }
interface HomeRow { session_id: string; machine_id: string; epoch: number; state: string; destination: string | null; move_id: string | null }
interface GitState { head: string; status: string; staged: string; working: string; untracked: string }
export interface RelocateFixture {
  hub: Machine; box: Machine; original: RelocateOwner;
  home(machine?: Machine): HomeRow | null;
  owner(machine: Machine, terminal: string, sessionId: string, placement?: { file: string; cwd: string }): Promise<RelocateOwner>;
  relocate(sessionId: string, target: string): Promise<{ terminal: string; file: string; cwd: string }>;
  turn(machine: Machine, owner: RelocateOwner, marker: string, answer: string): Promise<void>;
  gitState(cwd: string): Promise<GitState>;
  close(): Promise<void>;
}

/** Start real packaged v0 services and a native Pi, but never create its session state. */
export async function relocateFixture(suite: Suite): Promise<RelocateFixture> {
  const cores = suite.cores;
  if (!cores || process.platform !== 'linux') throw new Error('v0 relocation needs the two owned Linux fixture cores');
  const source = await suite.project('relocate-source');
  const destination = suite.ownPath(join(suite.root, 'p', 'relocate-repository'));
  const gitEnv = { ...suite.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = async (cwd: string, args: readonly string[]): Promise<string> => {
    const result = await suite.invoke('git', args, gitEnv, cwd);
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    return result.stdout.trimEnd();
  };
  await writeFile(join(source, '.gitignore'), '.spider/\n');
  await writeFile(join(source, 'tracked.txt'), 'base\n');
  await git(source, ['add', '.gitignore', 'tracked.txt']);
  await git(source, ['commit', '-qm', 'fixture content']);
  await git(suite.root, ['clone', '-q', source, destination]);

  const hubRoot = suite.directories.SPIDER_GLOBAL_ROOT, hubAgent = suite.directories.PI_CODING_AGENT_DIR;
  const boxRoot = suite.ownPath(join(suite.root, 'bg')), boxAgent = suite.ownPath(join(suite.root, 'ba'));
  const hub: Machine = { id: HUB, side: 'local', root: hubRoot, agent: hubAgent,
    env: { ...suite.env, ...cores.local.env, HC_SESSION: cores.local.namespace, HC_SOCKET: cores.local.socket,
      SPIDER_GLOBAL_ROOT: hubRoot, PI_CODING_AGENT_DIR: hubAgent, PI_CODING_AGENT_SESSION_DIR: join(hubAgent, 'sessions'), SPIDER_ROAM_PI: suite.pi.launcher } };
  const box: Machine = { id: BOX, side: 'dest', root: boxRoot, agent: boxAgent,
    env: { ...suite.env, ...cores.dest.env, HC_SESSION: cores.dest.namespace, HC_SOCKET: cores.dest.socket,
      SPIDER_GLOBAL_ROOT: boxRoot, PI_CODING_AGENT_DIR: boxAgent, PI_CODING_AGENT_SESSION_DIR: join(boxAgent, 'sessions'), SPIDER_ROAM_PI: suite.pi.launcher } };
  for (const dir of [join(hubAgent, 'sessions'), boxAgent, join(boxAgent, 'sessions'), join(boxRoot, 'roam')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ['settings.json', 'models.json']) await copyFile(join(hubAgent, name), join(boxAgent, name));
  await copyFile(join(hubRoot, 'config.json'), join(boxRoot, 'config.json'));
  suite.ledger.update(ledger => { (ledger.intercomDirectories ??= []).push(join(boxAgent, 'intercom')); });
  const peer = { machineId: BOX, alias: cores.machine, node: process.execPath, pi: suite.pi.launcher,
    cli: suite.packed.roamCli, core: cores.wrapper, globalRoot: boxRoot, agentDir: boxAgent };
  for (const [machine, cwd] of [[hub, source], [box, destination]] as const) {
    await mkdir(join(machine.root, 'roam'), { recursive: true, mode: 0o700 });
    await mkdir(join(machine.root, 'herdr'), { recursive: true, mode: 0o700 });
    await writeFile(join(machine.root, 'roam', 'machine.json'), JSON.stringify({ machineId: machine.id }), { mode: 0o600 });
    await writeFile(join(machine.root, 'roam', 'config.json'), JSON.stringify({ enabled: true, role: machine === hub ? 'hub' : 'box',
      machineId: machine.id, hubMachineId: HUB, peers: machine === hub ? [peer] : [], discoveryRoots: [], coreUnit: 'fixture.service',
      syncMs: 5_000 }), { mode: 0o600 });
    await writeFile(join(machine.root, 'herdr', 'config.json'), JSON.stringify({ app: { binary: join(suite.root, 'closed-app'), home: suite.directories.HERDR_APP_HOME },
      core: { binary: cores.wrapper, config: join(suite.root, 'core.toml') }, globalRoot: machine.root, agentDirectory: machine.agent,
      shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [] }), { mode: 0o600 });
    const db = openDb(join(machine.root, 'spider.db'));
    try {
      migrate(db, 'global', { machineId: machine.id, globalRoot: machine.root });
      enableMemoryCapture(db, 'global');
      await mapRepository(db, { repoKey: REPO, path: cwd });
    } finally { db.close(); }
  }

  const logs = [join(suite.root, 'v0-hub.log'), join(suite.root, 'v0-supervisor.log')];
  const services: OwnedProcess[] = [];
  const close = async () => {
    for (const service of services.splice(0).reverse()) await service.stop();
    for (const [i, file] of logs.entries()) if (existsSync(file)) await suite.keepEvidence(file, `v0-service-${i}.log`);
    await suite.keepEvidence(cores.recordLog, 'v0-hc.jsonl');
    await suite.keepEvidence(cores.viaLog, 'v0-via.jsonl');
  };
  try {
    const supervisor = spawnOwned(suite.ledger, { label: 'v0-supervisor', command: process.execPath,
      args: [suite.packed.roamSupervisor, '--v0'],
      env: box.env,
      cwd: suite.root, stdio: { log: logs[1] } });
    services.push(supervisor);
    await waitFor('v0 supervisor opens its journal', async () => {
      if (supervisor.child.exitCode !== null || supervisor.child.signalCode !== null) throw new Error(await readFile(logs[1], 'utf8'));
      return existsSync(join(box.root, 'roam', 'journal.db'));
    }, Boolean, deadline(20_000));
    const hubService = spawnOwned(suite.ledger, { label: 'v0-hub', command: process.execPath,
      args: [suite.packed.roamCli, 'roam', 'hub-v0'],
      env: hub.env,
      cwd: suite.root, stdio: { log: logs[0] } });
    services.push(hubService);
    await waitFor('v0 hub control socket', async () => {
      if (hubService.child.exitCode !== null || hubService.child.signalCode !== null) throw new Error(await readFile(logs[0], 'utf8'));
      return existsSync(join(hub.root, 'roam', 'relocate.sock'));
    }, Boolean, deadline(20_000));

    // No --session, ID, transcript, membership or home is provided here.
    const launch = await suite.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', source, '--',
      '/usr/bin/env', '-u', 'PI_CODING_AGENT_SESSION_DIR', `PI_CODING_AGENT_DIR=${hub.agent}`,
      `SPIDER_GLOBAL_ROOT=${hub.root}`, suite.pi.launcher]);
    const terminal = (launch.json as { address?: string } | null)?.address;
    expect(launch.exitCode, launch.stderr + launch.stdout).toBe(0);
    if (!terminal) throw new Error('ordinary Pi terminal address is missing');
    suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address: terminal }); });
    const observed = await waitFor('ordinary Pi starts in its native terminal', () => readObserved(suite.pi.observerDir),
      rows => rows.some(row => row.type === 'session_start' && row.hcTerminal === terminal && row.cwd === source), deadline(30_000));
    const start = observed.find(row => row.type === 'session_start' && row.hcTerminal === terminal && row.cwd === source)!;
    if (typeof start.sessionId !== 'string' || typeof start.sessionFile !== 'string') throw new Error('Pi did not allocate its own session');
    const sessionId = start.sessionId, file = suite.ownPath(start.sessionFile);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    const sourceIdentity = identityOf(start.pid);
    suite.ledger.update(ledger => { ledger.processes.push({ ...sourceIdentity, label: 'ordinary-pi', group: false }); });
    await waitFor('ordinary Pi holds its session ID lock', () => inspectIdLock(join(hub.root, 'herdr'), sessionId),
      lock => lock?.identity.pid === start.pid && lock.pendingOperationId === null, deadline(30_000));
    const original: RelocateOwner = { pid: start.pid, terminal, sessionId, file, cwd: source };
    const turn: RelocateFixture['turn'] = async (machine, owner, marker, answer) => {
      const at = Date.now();
      const sent = await suite.hc(['send', '--force', '--json', owner.terminal, mark(marker)], machine.side);
      expect(sent.exitCode, sent.stderr + sent.stdout).toBe(0);
      const rows = await waitFor(`session turn ${marker} settles`, () => readObserved(suite.pi.observerDir, owner.pid),
        list => list.some(row => row.type === 'agent_settled' && row.at >= at), deadline(30_000));
      expect(rows.some(row => row.type === 'message_end' && row.at >= at && row.role === 'assistant' && JSON.stringify(row.content).includes(answer))).toBe(true);
      expect((await readFile(owner.file, 'utf8')).includes(answer)).toBe(true);
    };
    await turn(hub, original, 'birth', 'ordinary source reply');
    const before = openDb(join(hub.root, 'spider.db'));
    const project = openDb(join(source, '.spider', 'project.db'), { fileMustExist: true });
    try {
      expect(before.prepare('SELECT * FROM session_homes WHERE session_id=?').get(sessionId)).toBeUndefined();
      expect(before.prepare('SELECT * FROM roam_locations WHERE session_id=?').get(sessionId)).toBeUndefined();
      expect(project.prepare('SELECT * FROM roam_sessions WHERE session_id=?').get(sessionId)).toBeUndefined();
      expect(project.prepare('SELECT origin_machine FROM sessions WHERE id=?').get(sessionId)).toEqual({ origin_machine: HUB });
    } finally { project.close(); before.close(); }
    await writeFile(join(source, 'tracked.txt'), 'staged\n'); await git(source, ['add', 'tracked.txt']);
    await writeFile(join(source, 'tracked.txt'), 'working\n'); await writeFile(join(source, 'untracked.txt'), 'untracked fixture\n');

    const home = (machine: Machine = hub): HomeRow | null => {
      const db = openDb(join(machine.root, 'spider.db'), { fileMustExist: true });
      try { return (db.prepare('SELECT session_id,machine_id,epoch,state,destination,move_id FROM session_homes WHERE session_id=?').get(sessionId) as HomeRow | undefined) ?? null; }
      finally { db.close(); }
    };
    let ownerCalls = 0;
    const owner: RelocateFixture['owner'] = async (machine, expectedTerminal, id, placement) => {
      const stop = ++ownerCalls;
      const locks = await Promise.all([hub, box].map(host => inspectIdLock(join(host.root, 'herdr'), id)));
      await suite.evidence(`v0-locks-${stop}.json`, locks);
      expect(locks.filter(Boolean)).toHaveLength(1);
      const index = machine === hub ? 0 : 1, lock = locks[index];
      expect(lock).toMatchObject({ pendingOperationId: null });
      if (!lock) throw new Error('expected session ID lock is missing');
      const identity = identityOf(lock.identity.pid);
      suite.ledger.update(ledger => {
        if (!ledger.terminals.some(row => row.side === machine.side && row.address === expectedTerminal)) ledger.terminals.push({ side: machine.side, address: expectedTerminal });
        if (!ledger.processes.some(row => row.pid === identity.pid && row.start === identity.start)) ledger.processes.push({ ...identity, label: 'relocated-pi', group: false });
      });
      const eventRows = await waitFor('the ID-lock holder reports its Pi session', () => readObserved(suite.pi.observerDir, lock.identity.pid),
        rows => rows.some(row => row.type === 'session_start' && row.sessionId === id && row.hcTerminal === expectedTerminal), deadline(30_000));
      const event = eventRows.find(row => row.type === 'session_start' && row.sessionId === id && row.hcTerminal === expectedTerminal)!;
      if (typeof event.sessionFile !== 'string' || typeof event.cwd !== 'string') throw new Error('Pi session observation is incomplete');
      const observedFile = suite.ownPath(event.sessionFile), observedCwd = suite.ownPath(event.cwd);
      expect(processStartIdentity(lock.identity.pid)).toBe(lock.identity.startIdentity);
      expect((await readFile(`/proc/${lock.identity.pid}/comm`, 'utf8')).trim()).toBe('pi');
      expect(await readlink(`/proc/${lock.identity.pid}/cwd`)).toBe(observedCwd);
      const native = await suite.hc(['get', expectedTerminal, '--json'], machine.side);
      expect(native.exitCode, native.stderr + native.stdout).toBe(0);
      expect(native.json).toMatchObject({ address: expectedTerminal, state: 'live', pid: lock.identity.pid });
      if (placement) {
        const current = home();
        if (!current) throw new Error('relocated home is missing');
        assertNativeLaunch(native.json, await cores.records(), placement,
          machine === hub ? cores.local.namespace : cores.dest.namespace, id, machine.id, current.epoch);
      }
      const lease = await createSessionLeases(join(machine.root, 'herdr')).get(observedFile);
      expect(lease).toMatchObject({ pid: lock.identity.pid, startIdentity: lock.identity.startIdentity });
      const all = await readObserved(suite.pi.observerDir);
      const candidates = [...new Set(all.filter(row => row.type === 'session_start' && row.sessionId === id).map(row => row.pid))];
      const alive = candidates.filter(pid => processStartIdentity(pid) !== null);
      expect(alive).toEqual([lock.identity.pid]);
      const found = { pid: lock.identity.pid, terminal: expectedTerminal, sessionId: id, file: observedFile, cwd: observedCwd };
      await suite.evidence(`v0-owner-${stop}.json`, { owner: found, locks, native: native.json, home: home(), liveSessionPids: alive });
      return found;
    };
    let calls = 0;
    const relocate: RelocateFixture['relocate'] = async (id, target) => {
      const call = ++calls;
      const result = await suite.invoke(process.execPath, [suite.packed.roamCli, 'roam', 'relocate', id, target, '--json'], hub.env);
      await suite.evidence(`v0-relocate-${call}.json`, result);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      const reply = JSON.parse(result.stdout) as { ok?: boolean; value?: { terminal?: string; placement?: { file?: string; cwd?: string; sessionId?: string } } };
      expect(reply.ok, result.stdout).toBe(true);
      const value = reply.value, placement = value?.placement;
      if (!value?.terminal || !placement?.file || !placement.cwd || placement.sessionId !== id) throw new Error('relocate reply has no exact session placement');
      if (suite.ownPath(placement.file) !== placement.file || suite.ownPath(placement.cwd) !== placement.cwd) {
        throw new Error('relocate reply placement is not canonical');
      }
      return { terminal: value.terminal, file: placement.file, cwd: placement.cwd };
    };
    const gitState: RelocateFixture['gitState'] = async cwd => ({ head: await git(cwd, ['rev-parse', 'HEAD']),
      status: await git(cwd, ['status', '--porcelain=v1', '-uall']), staged: await git(cwd, ['show', ':tracked.txt']),
      working: await readFile(join(cwd, 'tracked.txt'), 'utf8'), untracked: await readFile(join(cwd, 'untracked.txt'), 'utf8') });
    return { hub, box, original, home, owner, relocate, turn, gitState, close };
  } catch (error) { await close(); throw error; }
}
