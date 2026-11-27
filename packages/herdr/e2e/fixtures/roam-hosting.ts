// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import { migrate, openDb, paths } from '@spider/db-core';
import { recordLocation } from '@spider/db-core/roam/catalog';
import { writeLocal } from '@spider/db-core/roam/local-state';
import { mapWorkspace } from '@spider/db-core/roam/repo-map';
import { inspectIdLock } from '../../src/sessions/id-lock.js';
import { createSessionLeases } from '../../src/sessions/lease.js';
import { fixtureProcessDomain } from '../../../host/src/herdr/fixture-process-domain.js';
import type { HcRecord, HcResult } from '../harness/hc.js';
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
interface Sentinel { address: string; pid: number; start: string }
interface ProvisionOutcome { code: number; reason: string; value: { hostingReady: boolean } }
export interface V0HostingFixture {
  root: string; cwd: string; sessionId: string; file: string; machineId: string; epoch: number;
  pi: string; supervisor: string; coreUnit: string; unrelatedUnit: string; supervisorUnit: string;
  hc(argv: readonly string[]): Promise<HcResult>;
  provision(): Promise<ProvisionOutcome>; enable(): Promise<void>; seedHome(): Promise<void>;
  participating(): Promise<boolean>; serviceCommands(): Promise<string[]>; sentinel(): Promise<Sentinel>;
  start(): Promise<void>; close(): Promise<void>; restartCore(): Promise<void>;
  waitOwner(previousPid?: number): Promise<HostedOwner>; owners(): Promise<HostedOwner[]>;
  events(pid: number): Promise<ObservedEvent[]>; home(): Record<string, unknown> | undefined;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const INSTALL = 'r04-provision';

// npm only supplies local inputs. Spider still transfers, validates, installs, and verifies the actual packed release.
async function stageOfflineNpm(suite: Suite, bin: string, root: string, prefix: string, digest: string): Promise<void> {
  const pi = `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = --version ]; then printf '%s\\n' 1.2.0; exit 0; fi
exec ${shellQuote(suite.pi.launcher)} "$@"
`;
  const offlineSdk = join(suite.packed.root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');
  const releasePrefix = join(prefix, 'spider-releases', digest);
  const archive = join(root, 'roam', 'provision', `${INSTALL}-install`, 'release-release.tgz');
  await writeFile(join(bin, 'npm'), `#!${process.execPath}
const { cpSync, mkdirSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const args = JSON.stringify(process.argv.slice(2));
if (args === ${JSON.stringify(JSON.stringify(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '@earendil-works/pi-coding-agent@1.2.0']))}) {
  const prefix = ${JSON.stringify(prefix)}, piDir = join(prefix, 'bin');
  mkdirSync(piDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(piDir, 'pi'), ${JSON.stringify(pi)}, { mode: 0o700 });
  const sdk = join(prefix, 'lib/node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(join(sdk, 'dist'), { recursive: true, mode: 0o700 });
  writeFileSync(join(sdk, 'package.json'), '{"type":"module"}');
  writeFileSync(join(sdk, 'dist/index.js'), ${JSON.stringify(`export * from ${JSON.stringify(pathToFileURL(offlineSdk).href)};`)});
} else if (args === ${JSON.stringify(JSON.stringify(['install', '--prefix', releasePrefix, '--no-audit', '--no-fund', archive]))}) {
  const modules = join(${JSON.stringify(releasePrefix)}, 'node_modules');
  const installed = join(modules, '@guru-irl/spider');
  mkdirSync(installed, { recursive: true, mode: 0o700 });
  execFileSync('/usr/bin/tar', ['-xzf', ${JSON.stringify(archive)}, '--strip-components=1', '-C', installed]);
  for (const name of ['better-sqlite3', 'sqlite-vec']) {
    cpSync(join(${JSON.stringify(join(suite.packed.root, 'node_modules'))}, name), join(modules, name), { recursive: true, dereference: true });
  }
} else throw new Error('unexpected offline npm command');
`, { mode: 0o700 });
}

/** A clean box on the fixture transport; the story provisions and enables it before seeding a running home. */
export async function v0HostingFixture(suite: Suite): Promise<V0HostingFixture> {
  const cores = suite.cores;
  if (!cores || process.platform !== 'linux') throw new Error('v0 hosting needs an isolated Linux core');
  const box = cores.dest, boxHome = box.env.HOME, hub = suite.directories.SPIDER_GLOBAL_ROOT;
  const root = suite.ownPath(join(boxHome, 'g')), cwd = await suite.project('hosting-v0');
  const agent = suite.ownPath(join(boxHome, '.pi/agent')), herdr = join(root, 'herdr'), bin = join(boxHome, 'bin');
  const prefix = join(boxHome, '.local'), node = join(bin, 'node'), pi = join(prefix, 'bin/pi');
  const sessionId = randomUUID(), repo = randomUUID(), workspace = randomUUID(), moveId = `v0-${randomUUID()}`, epoch = 3;
  const file = suite.ownPath(join(cwd, 'session.jsonl')), store = `worktree:${repo}:${workspace}` as const;
  const unitDir = suite.ownPath(join(boxHome, '.config/systemd/user')), coreUnit = join(unitDir, 'herdr-core.service');
  const unrelatedUnit = join(unitDir, 'unrelated.service'), supervisorUnit = join(unitDir, 'spider-roam-supervisor-v0.service');
  const systemctlLog = suite.ownPath(join(suite.root, 'v0-systemctl.log'));
  const supervisorLog = suite.ownPath(join(suite.root, 'v0-supervisor.log'));
  for (const dir of [join(hub, 'roam'), join(hub, 'herdr'), herdr, unitDir, agent, bin]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(coreUnit, 'existing fixture core service\n', { mode: 0o600 });
  await writeFile(unrelatedUnit, 'existing unrelated service\n', { mode: 0o600 });
  const auth = '{"fixture":{"type":"api_key","key":"fixture-only"}}\n';
  await writeFile(join(agent, 'auth.json'), auth, { mode: 0o600 });
  await copyFile(join(suite.directories.PI_CODING_AGENT_DIR, 'models.json'), join(agent, 'models.json'));
  await copyFile(join(hub, 'config.json'), join(root, 'config.json'));
  const settings = JSON.parse(await readFile(join(suite.directories.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8'));
  // Provisioning writes the Spider shim. Keep the fixture provider and observer without loading a second copy of Spider.
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ ...settings, packages: [suite.pi.providerPath, suite.pi.observerPath] }), { mode: 0o600 });
  const packed = await suite.invoke(join(dirname(process.execPath), 'npm'), ['pack', suite.packed.root, '--offline', '--ignore-scripts', '--json', '--pack-destination', suite.root]);
  if (packed.exitCode !== 0) throw new Error(`npm pack of the built release failed: ${packed.stderr}`);
  const name = JSON.parse(packed.stdout)[0]?.filename;
  if (typeof name !== 'string' || basename(name) !== name || !name.endsWith('.tgz')) throw new Error('invalid packed release name');
  const tarball = suite.ownPath(join(suite.root, name)), sha256 = await digestFile(tarball);
  const release = join(prefix, 'spider-releases', sha256, 'node_modules', '@guru-irl', 'spider');
  const installedCli = join(release, 'dist/roam/cli.mjs'), installedSupervisor = join(release, 'dist/roam/supervisor.mjs');
  await stageOfflineNpm(suite, bin, root, prefix, sha256);
  // Transport uses the enrolled peer executable for bootstrap, stdin requests, and the detached installer.
  const env: Record<string, string> = { ...suite.env, ...box.env, HC_SESSION: box.namespace, HC_SOCKET: box.socket,
    PATH: [bin, dirname(pi), suite.env.PATH].join(':'), SPIDER_GLOBAL_ROOT: root,
    PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(agent, 'sessions'), SPIDER_ROAM_PI: pi };
  const forwarded = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'HC_SESSION', 'HC_SOCKET',
    'SPIDER_GLOBAL_ROOT', 'PI_CODING_AGENT_DIR'] as const;
  await writeFile(node, `#!/bin/sh\n${forwarded.map(key => `export ${key}=${shellQuote(env[key])}`).join('\n')}\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o700 });
  // Observe only the fixture core. Any attempted service mutation is recorded and refused.
  await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
if (args === '--user is-system-running') console.log('running');
else if (args === '--user show-environment') console.log(${JSON.stringify(`PI_CODING_AGENT_DIR=${agent}`)});
else if (args === '--user show --property=Transient,FragmentPath,MainPID herdr-core.service')
  console.log(${JSON.stringify(`Transient=no\nFragmentPath=${coreUnit}\nMainPID=${box.pid}`)});
else {
  require('node:fs').appendFileSync(${JSON.stringify(systemctlLog)}, args + '\\n', { mode: 0o600 });
  process.exitCode = 1;
}
`, { mode: 0o700 });
  const herdrConfig = (globalRoot: string, agentDirectory: string) => JSON.stringify({ enabled: true, mode: 'core-only',
    core: { binary: cores.wrapper, config: join(suite.root, 'core.toml') }, agentDirectory, globalRoot,
    shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [] });
  await writeFile(join(hub, 'herdr/config.json'), herdrConfig(hub, suite.directories.PI_CODING_AGENT_DIR), { mode: 0o600 });
  await writeFile(join(herdr, 'config.json'), herdrConfig(root, agent), { mode: 0o600 });
  await writeFile(join(hub, 'roam/machine.json'), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  await writeFile(join(hub, 'roam/config.json'), JSON.stringify({ enabled: false, role: 'hub', machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: BOX, alias: cores.machine, node, cli: installedCli, pi, core: cores.wrapper, globalRoot: root, coreUnit: basename(coreUnit) }],
    discoveryRoots: [], coreUnit: basename(coreUnit) }), { mode: 0o600 });

  const hc = (argv: readonly string[]) => suite.hc(argv, 'dest');
  const launched = await hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', cwd, '--', '/bin/sleep', '600']);
  const address = (launched.json as { address?: string } | null)?.address;
  if (launched.exitCode !== 0 || !address) throw new Error('sentinel terminal did not start');
  suite.ledger.update(ledger => { ledger.terminals.push({ side: 'dest', address }); });
  const sentinel = async (): Promise<Sentinel> => {
    const result = await hc(['get', address, '--json']);
    const live = result.json as { address?: string; state?: string; pid?: number } | null;
    if (result.exitCode !== 0 || live?.address !== address || live.state !== 'live' || typeof live.pid !== 'number')
      throw new Error('sentinel terminal is no longer live');
    return { address, ...identityOf(live.pid) };
  };
  const provision = async () => {
    const result = await suite.invoke(process.execPath, [suite.packed.roamCli, 'roam', 'provision', cores.machine,
      '--release', tarball, '--use-destination-auth', '--yes', '--operation-id', INSTALL, '--json'],
    { ...cores.local.env, SPIDER_GLOBAL_ROOT: hub, HC_SOCKET: cores.local.socket, HC_SESSION: cores.local.namespace });
    await suite.evidence('R04-provision-cli.log', result.stderr);
    if (result.exitCode !== 0) throw new Error(`packed provision failed (${result.exitCode}): ${result.stderr}${result.stdout}`);
    expect(await readFile(join(agent, 'auth.json'), 'utf8')).toBe(auth);
    const db = openDb(join(root, 'spider.db'));
    try {
      migrate(db, 'global', { machineId: BOX, globalRoot: root });
      db.prepare("UPDATE roam_meta SET store_key='global' WHERE id=1").run();
    } finally { db.close(); }
    return JSON.parse(result.stdout) as ProvisionOutcome;
  };
  const participating = async () => JSON.parse(await readFile(join(root, 'roam/config.json'), 'utf8')).enabled as boolean;
  const serviceCommands = async () => hasFile(systemctlLog) ? (await readFile(systemctlLog, 'utf8')).trim().split('\n') : [];
  const restoreEnv = enterHostingEnvironment(env);
  const domain = fixtureProcessDomain(herdr, env);
  if (!domain) { restoreEnv(); throw new Error('missing fixture process domain'); }
  let supervisor: OwnedProcess | undefined;
  const enable = async () => {
    const cli: { main(argv: readonly string[], io: { out(text: string): void; err(text: string): void }, options: {
      bundleUrl: URL; v0: { lifecycle: { systemd: { unitDir: string; run(args: readonly string[]): Promise<void> } } };
    }): Promise<number> } = await import(/* @vite-ignore */ pathToFileURL(join(dirname(installedCli), 'cli-main.mjs')).href);
    const output: string[] = [], errors: string[] = [];
    const code = await cli.main(['roam', 'enable'], { out: line => output.push(line), err: line => errors.push(line) }, {
      bundleUrl: pathToFileURL(join(release, 'dist/extension.js')), v0: { lifecycle: { systemd: { unitDir, async run(args) {
        const command = args.join(' ');
        if (!['--user daemon-reload', '--user enable --now spider-roam-supervisor-v0.service'].includes(command))
          throw new Error(`unexpected fixture service command: ${command}`);
        await appendFile(systemctlLog, `${command}\n`, { mode: 0o600 });
      } } } },
    });
    if (code !== 0) throw new Error(`packed v0 enable failed (${code}): ${errors.join('')}${output.join('')}`);
  };
  const seedHome = async () => {
    await writeFile(file, [
      { type: 'session', version: 3, id: sessionId, cwd, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'message', id: 'seed', parentId: null, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'fixture history', timestamp: 1 } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    await mkdir(paths.projectRoot(cwd), { recursive: true, mode: 0o700 });
    const db = openDb(join(root, 'spider.db'), { fileMustExist: true }), worktree = openDb(join(paths.projectRoot(cwd), 'project.db'));
    try {
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
  };
  const start = async () => {
    if (supervisor) throw new Error('supervisor already started');
    const installed = parseV0SupervisorUnit(await readFile(supervisorUnit, 'utf8'), process.execPath, installedSupervisor);
    const required: Record<string, string> = { SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: agent, SPIDER_ROAM_PI: pi,
      SPIDER_ROAM_HC: cores.wrapper, HC_SESSION: box.namespace, HC_SOCKET: box.socket };
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
      if (!ledger.terminals.some(item => item.side === 'dest' && item.address === owner.terminal)) ledger.terminals.push({ side: 'dest', address: owner.terminal });
      if (!ledger.processes.some(item => item.pid === identity.pid && item.start === identity.start)) ledger.processes.push({ ...identity, label: 'v0-hosted-pi', group: false });
    });
    return owner;
  };
  const restartCore = async () => {
    if (!supervisor || !identityAlive(supervisor.identity)) throw new Error('fixture supervisor is not live');
    const service = supervisor.identity;
    const before = await hc(['server', 'status', '--json']);
    const current = before.json as { pid?: number; core?: { id?: string } } | null;
    if (before.exitCode !== 0 || current?.pid !== box.pid || current.core?.id !== box.coreId) throw new Error('refusing to restart an unowned core');
    const stopped = await hc(['server', 'stop', '--json']);
    if (stopped.exitCode !== 0) throw new Error(`fixture core stop failed: ${stopped.stderr}`);
    const started = await hc(['server', 'start', '--json']);
    if (started.exitCode !== 0) throw new Error(`fixture core start failed: ${started.stderr}`);
    const after = await hc(['server', 'status', '--json']);
    const next = after.json as { pid?: number; core?: { id?: string } } | null;
    if (after.exitCode !== 0 || typeof next?.pid !== 'number' || next.pid === current.pid || next.core?.id !== box.coreId)
      throw new Error('fixture core identity changed or did not restart');
    const identity = identityOf(next.pid); box.pid = next.pid;
    suite.ledger.update(ledger => { const core = ledger.cores.find(item => item.side === 'dest'); if (!core) throw new Error('fixture core not recorded'); core.pid = identity.pid; core.start = identity.start; });
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
  return { root, cwd, sessionId, file, machineId: BOX, epoch, coreUnit, unrelatedUnit, supervisorUnit, supervisor: installedSupervisor, pi,
    hc, provision, enable, seedHome, participating, serviceCommands, sentinel, start, close, restartCore, waitOwner, owners, events, home };
}

export const digestFile = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');
export const hasFile = (file: string): boolean => existsSync(file);
