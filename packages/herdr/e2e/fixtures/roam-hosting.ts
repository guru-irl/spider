// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import { migrate, openDb, paths } from '@spider/db-core';
import { recordLocation } from '@spider/db-core/roam/catalog';
import { writeLocal } from '@spider/db-core/roam/local-state';
import { mapWorkspace } from '@spider/db-core/roam/repo-map';
import { inspectIdLock } from '../../src/sessions/id-lock.js';
import { createSessionLeases } from '../../src/sessions/lease.js';
import { fixtureProcessDomain } from '../../../host/src/herdr/fixture-process-domain.js';
import type { HcRecord } from '../harness/hc.js';
import { readObserved, type ObservedEvent } from '../harness/pi.js';
import { identityAlive, identityOf } from '../harness/resources.js';
import { spawnOwned, type OwnedProcess } from '../harness/processes.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

const HUB = '00000000-0000-4000-8000-000000000001';
const BOX = '00000000-0000-4000-8000-000000000002';

export interface V0SupervisorCommand { command: string; args: string[]; env: Record<string, string> }

/** Read the fixture-owned unit, rather than inventing the service's launch command. */
export function parseV0SupervisorUnit(unit: string, node: string, supervisor: string): V0SupervisorCommand {
  const lines = unit.split('\n');
  const starts = lines.filter(line => line.startsWith('ExecStart='));
  const match = starts.length === 1 && /^ExecStart=("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*") --v0$/.exec(starts[0]);
  if (!match) throw new Error('invalid v0 supervisor command');
  const decode = (value: string): string => {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'string') throw new Error('invalid v0 supervisor value');
    return parsed.replaceAll('%%', '%');
  };
  const command = decode(match[1]).replaceAll('$$', '$');
  const executable = decode(match[2]).replaceAll('$$', '$');
  if (command !== node || executable !== supervisor) throw new Error('unexpected v0 supervisor executable');
  const env: Record<string, string> = {};
  const allowed = new Set(['SPIDER_GLOBAL_ROOT', 'SPIDER_ROAM_PI', 'PI_CODING_AGENT_DIR', 'SPIDER_ROAM_HC', 'HC_SESSION', 'HC_SOCKET', 'PATH']);
  for (const line of lines.filter(line => line.startsWith('Environment='))) {
    const value = decode(line.slice('Environment='.length)), at = value.indexOf('=');
    const key = value.slice(0, at);
    if (at < 1 || !allowed.has(key) || Object.hasOwn(env, key)) throw new Error('unexpected v0 supervisor environment');
    env[key] = value.slice(at + 1);
  }
  return { command, args: [executable, '--v0'], env };
}

export function enterHostingEnvironment(env: Readonly<Record<string, string>>): () => void {
  const previous = { ...process.env };
  // Vitest's marker keeps the database fixture fence active in this process.
  for (const key of Object.keys(process.env)) if (!/^VITEST(?:_|$)|^NODE_ENV$/.test(key)) delete process.env[key];
  Object.assign(process.env, env);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
}

/** Check all exact Pi launches, including attempts that exit before they can own a lock. */
export function assertHostedLaunches(records: readonly Pick<HcRecord, 'argv'>[], pi: string, file: string): number {
  const count = records.filter(({ argv }) => {
    const end = argv.indexOf('--');
    if (argv[0] !== 'run' || end < 0) return false;
    const command = argv.slice(end + 1);
    return command.at(-3) === pi && command.at(-2) === '--session' && command.at(-1) === file;
  }).length;
  expect(count, 'session launch attempts').toBe(2);
  return count;
}

export interface HostedOwner { pid: number; terminal: string; sessionId: string; file: string; cwd: string }
export function observedHostedOwner(event: ObservedEvent, sessionId: string): HostedOwner | null {
  if (event.type !== 'session_start' || event.sessionId !== sessionId) return null;
  if (typeof event.sessionFile !== 'string' || typeof event.cwd !== 'string' || typeof event.hcTerminal !== 'string')
    throw new Error('incomplete hosted owner observation');
  return { pid: event.pid, terminal: event.hcTerminal, sessionId, file: event.sessionFile, cwd: event.cwd };
}
export interface V0HostingFixture {
  suite: Suite; root: string; cwd: string; sessionId: string; file: string; machineId: string; epoch: number;
  coreUnit: string; supervisorUnit: string; systemctlLog: string;
  provisionUnit(): Promise<void>; start(): Promise<void>; close(): Promise<void>; restartCore(): Promise<void>;
  waitOwner(previousPid?: number): Promise<HostedOwner>; owners(): Promise<HostedOwner[]>;
  events(pid: number): Promise<ObservedEvent[]>; home(): Record<string, unknown> | undefined;
}

/** A replicated running home on an isolated box, started by the installed v0 service definition. */
export async function v0HostingFixture(suite: Suite): Promise<V0HostingFixture> {
  const cores = suite.cores;
  if (!cores || process.platform !== 'linux') throw new Error('v0 hosting needs an isolated Linux core');
  const root = suite.directories.SPIDER_GLOBAL_ROOT, cwd = await suite.project('hosting-v0');
  const agent = suite.directories.PI_CODING_AGENT_DIR, herdr = join(root, 'herdr');
  const sessionId = randomUUID(), repo = randomUUID(), workspace = randomUUID(), moveId = `v0-${randomUUID()}`, epoch = 3;
  const file = suite.ownPath(join(cwd, 'session.jsonl')), store = `worktree:${repo}:${workspace}` as const;
  const unitDir = suite.ownPath(join(suite.root, 'units')), coreUnit = join(unitDir, 'herdr-core.service');
  const supervisorUnit = join(unitDir, 'spider-roam-supervisor-v0.service');
  const systemctlLog = suite.ownPath(join(suite.root, 'v0-systemctl.log'));
  const supervisorLog = suite.ownPath(join(suite.root, 'v0-supervisor.log'));
  for (const dir of [join(root, 'roam'), herdr, unitDir, paths.projectRoot(cwd)]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(coreUnit, 'existing fixture core service\n', { mode: 0o600 });
  await writeFile(join(root, 'roam', 'machine.json'), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  await writeFile(join(root, 'roam', 'config.json'), JSON.stringify({ enabled: false, role: 'box', machineId: BOX,
    hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: 'herdr-core.service' }), { mode: 0o600 });
  await writeFile(join(herdr, 'config.json'), JSON.stringify({ enabled: true, mode: 'core-only',
    core: { binary: cores.wrapper, config: join(suite.root, 'core.toml') }, agentDirectory: agent, globalRoot: root,
    shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [] }), { mode: 0o600 });
  await writeFile(file, [
    { type: 'session', version: 3, id: sessionId, cwd, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'message', id: 'seed', parentId: null, timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: 'fixture history', timestamp: 1 } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });

  const db = openDb(join(root, 'spider.db')), worktree = openDb(join(paths.projectRoot(cwd), 'project.db'));
  try {
    migrate(db, 'global', { machineId: BOX, globalRoot: root });
    db.prepare("UPDATE roam_meta SET store_key='global' WHERE id=1").run();
    migrate(worktree, 'worktree', { machineId: BOX, globalRoot: root });
    await mapWorkspace(db, { repoKey: repo, workspaceId: workspace, path: cwd });
    worktree.prepare('UPDATE roam_meta SET store_key=? WHERE id=1').run(store);
    worktree.prepare('INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)').run(sessionId, HUB);
    worktree.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,?,'active')").run(sessionId, epoch);
    db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,?,?,1,'running',NULL)")
      .run(sessionId, BOX, epoch, moveId);
    const placement = { sessionId, machineId: BOX, historyMachine: HUB, repoKey: repo, workspaceId: workspace,
      repository: cwd, cwd, file, stores: ['global', store] };
    writeLocal(db, 'relocate-managed', sessionId, placement);
    recordLocation(db, { sessionId, stores: ['global', store], home: { sessionId, machineId: BOX, epoch, moveId, updatedAt: 1 }, file, cwd });
  } finally { worktree.close(); db.close(); }

  const env = { ...suite.env, ...cores.local.env, HC_SESSION: cores.local.namespace, HC_SOCKET: cores.local.socket,
    SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: agent, SPIDER_ROAM_PI: suite.pi.launcher };
  const restoreEnv = enterHostingEnvironment(env);
  let domain: NonNullable<ReturnType<typeof fixtureProcessDomain>>;
  let cli: { main(argv: readonly string[], io: { out(text: string): void; err(text: string): void }, options: {
    bundleUrl: URL; v0: { lifecycle: { systemd: { unitDir: string; run(args: readonly string[]): Promise<void> } } };
  }): Promise<number> };
  try {
    const created = fixtureProcessDomain(herdr, env);
    if (!created) throw new Error('missing fixture process domain');
    domain = created;
    cli = await import(/* @vite-ignore */ pathToFileURL(join(suite.packed.root, 'dist', 'roam', 'cli-main.mjs')).href) as typeof cli;
  } catch (error) { restoreEnv(); throw error; }
  let supervisor: OwnedProcess | undefined;
  const provisionUnit = async () => {
    const output: string[] = [], errors: string[] = [];
    const code = await cli.main(['roam', 'enable'], { out: line => output.push(line), err: line => errors.push(line) }, {
      bundleUrl: pathToFileURL(suite.packed.extension), v0: { lifecycle: { systemd: { unitDir, async run(args) {
        const command = args.join(' ');
        if (!['--user daemon-reload', '--user enable --now spider-roam-supervisor-v0.service'].includes(command))
          throw new Error(`unexpected fixture service command: ${command}`);
        await appendFile(systemctlLog, `${command}\n`, { mode: 0o600 });
      } } } },
    });
    if (code !== 0) throw new Error(`packed v0 enable failed (${code}): ${errors.join('')}${output.join('')}`);
  };
  const start = async () => {
    if (supervisor) throw new Error('supervisor already started');
    const installed = parseV0SupervisorUnit(await readFile(supervisorUnit, 'utf8'), process.execPath, suite.packed.roamSupervisor);
    const required: Record<string, string> = { SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: agent, SPIDER_ROAM_PI: suite.pi.launcher,
      SPIDER_ROAM_HC: cores.wrapper, HC_SESSION: cores.local.namespace, HC_SOCKET: cores.local.socket };
    for (const [key, value] of Object.entries(required)) if (installed.env[key] !== value) throw new Error(`unit has the wrong ${key}`);
    supervisor = spawnOwned(suite.ledger, { label: 'v0-supervisor', command: installed.command, args: installed.args,
      env: { ...env, ...installed.env }, cwd: suite.root, stdio: { log: supervisorLog } });
  };
  const events = (pid: number) => readObserved(suite.pi.observerDir, pid);
  const owners = async () => {
    const rows: HostedOwner[] = [];
    for (const item of await domain.processes()) {
      const entry = (await events(item.pid)).find(event => event.type === 'session_start' && event.sessionId === sessionId);
      if (entry) rows.push(observedHostedOwner(entry, sessionId)!);
    }
    return rows;
  };
  const leases = createSessionLeases(herdr);
  const waitOwner: V0HostingFixture['waitOwner'] = async previousPid => {
    const rows = await waitFor('one packed exact-session owner', async () => {
      if (!supervisor || !identityAlive(supervisor.identity)) throw new Error(`v0 supervisor exited: ${await readFile(supervisorLog, 'utf8').catch(() => '')}`);
      return owners();
    }, values => values.length === 1 && values[0].pid !== previousPid, deadline(60_000), { reconcileMs: 100 });
    const owner = rows[0], lock = await inspectIdLock(herdr, sessionId);
    if (owner.file !== file || owner.cwd !== cwd) throw new Error('session owner has the wrong file or cwd');
    if (!lock || lock.identity.pid !== owner.pid || lock.pendingOperationId !== null) {
      await suite.evidence('R04-lock-failure.json', { owner, lock, events: await events(owner.pid) });
      throw new Error('session owner did not adopt its ID lock');
    }
    const lease = await leases.get(file);
    if (!lease || lease.pid !== owner.pid || lease.startIdentity !== lock.identity.startIdentity) {
      await suite.evidence('R04-lease-failure.json', { owner, lock, lease, events: await events(owner.pid) });
      throw new Error('session owner did not adopt its file lease');
    }
    const identity = identityOf(owner.pid);
    suite.ledger.update(ledger => {
      if (!ledger.terminals.some(item => item.side === 'local' && item.address === owner.terminal)) ledger.terminals.push({ side: 'local', address: owner.terminal });
      if (!ledger.processes.some(item => item.pid === identity.pid && item.start === identity.start)) ledger.processes.push({ ...identity, label: 'v0-hosted-pi', group: false });
    });
    return owner;
  };
  const restartCore = async () => {
    if (!supervisor || !identityAlive(supervisor.identity)) throw new Error('fixture supervisor is not live');
    const service = supervisor.identity;
    const before = await suite.hc(['server', 'status', '--json']);
    const current = before.json as { pid?: number; core?: { id?: string } } | null;
    if (before.exitCode !== 0 || current?.pid !== cores.local.pid || current.core?.id !== cores.local.coreId) throw new Error('refusing to restart an unowned core');
    const stopped = await suite.hc(['server', 'stop', '--json']);
    if (stopped.exitCode !== 0) throw new Error(`fixture core stop failed: ${stopped.stderr}`);
    const started = await suite.hc(['server', 'start', '--json']);
    if (started.exitCode !== 0) throw new Error(`fixture core start failed: ${started.stderr}`);
    const after = await suite.hc(['server', 'status', '--json']);
    const next = after.json as { pid?: number; core?: { id?: string } } | null;
    if (after.exitCode !== 0 || typeof next?.pid !== 'number' || next.pid === current.pid || next.core?.id !== cores.local.coreId)
      throw new Error('fixture core identity changed or did not restart');
    const identity = identityOf(next.pid); cores.local.pid = next.pid;
    suite.ledger.update(ledger => { const core = ledger.cores.find(item => item.side === 'local'); if (!core) throw new Error('fixture core not recorded'); core.pid = identity.pid; core.start = identity.start; });
    if (!identityAlive(service)) throw new Error('fixture supervisor did not survive the core restart');
  };
  const home = () => {
    const current = openDb(join(root, 'spider.db'), { fileMustExist: true });
    try { return current.prepare('SELECT session_id,machine_id,epoch,move_id,state,destination FROM session_homes WHERE session_id=?').get(sessionId) as Record<string, unknown> | undefined; }
    finally { current.close(); }
  };
  const close = async () => {
    try { if (supervisor) await supervisor.stop(); }
    finally {
      try {
        if (hasFile(supervisorLog)) await suite.keepEvidence(supervisorLog, 'v0-supervisor.log');
        await suite.keepEvidence(cores.recordLog, 'v0-hc.jsonl');
      } finally { restoreEnv(); }
    }
  };
  return { suite, root, cwd, sessionId, file, machineId: BOX, epoch, coreUnit, supervisorUnit, systemctlLog,
    provisionUnit, start, close, restartCore, waitOwner, owners, events, home };
}

export const digestFile = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');
export const hasFile = (file: string): boolean => existsSync(file);
