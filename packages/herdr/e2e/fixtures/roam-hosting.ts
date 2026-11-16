// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate, openDb, paths } from '@spider/db-core';
import { recordLocation } from '@spider/db-core/roam/catalog';
import { readLocal } from '@spider/db-core/roam/local-state';
import { mapWorkspace } from '@spider/db-core/roam/repo-map';
import { parseReadiness } from '@spider/db-core/roam/readiness';
import { inspectIdLock } from '../../src/sessions/id-lock.js';
import { createSessionLeases, type ProcessInventoryPorts } from '../../src/sessions/lease.js';
import { createProcessPresence } from '../../src/sessions/presence.js';
import { fixtureProcessDomain } from '../../../host/src/herdr/fixture-process-domain.js';
import { createLocalDiagnosticPorts } from '../../../roam/src/local-diagnostics.js';
import { createIntentStore } from '../../../roam/src/intent.js';
import { DEFAULT_LIMITS } from '../../../roam/src/contracts.js';
import { PROVISION_REMOTE_SCRIPT } from '../../../roam/src/provision-remote-script.js';
import { renderSupervisorUnit } from '../../../roam/src/systemd.js';
import type { SupervisorSystemPorts } from '../../../roam/src/production-supervisor.js';
import { readObserved, type ObservedEvent } from '../harness/pi.js';
import { identityAlive, identityOf } from '../harness/resources.js';
import { spawnOwned } from '../harness/processes.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

const HUB = '00000000-0000-4000-8000-000000000001';
const BOX = '00000000-0000-4000-8000-000000000002';
const BOOT = '00000000-0000-4000-8000-000000000005';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function participantBootSettings(settings: Record<string, unknown>, release: string, extension: string): Record<string, unknown> {
  if (!Array.isArray(settings.packages)) throw new Error('packed extension is unavailable');
  const packages = settings.packages.filter(entry => entry !== extension);
  const matches = (entry: unknown) => entry === release || !!entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as Record<string, unknown>).source === release;
  if (packages.filter(matches).length !== 1) throw new Error('packed extension is unavailable');
  return { ...settings, packages: packages.flatMap(entry => matches(entry) ? [
    { ...(typeof entry === 'object' && entry !== null ? entry : { source: release }), extensions: [] }, extension,
  ] : [entry]) };
}

function fixtureClock() {
  let offset = 0;
  const timers = new Set<{ at: number; fn(): void; timer: ReturnType<typeof setTimeout> }>();
  const now = () => Date.now() + offset;
  return {
    now,
    later(ms: number, fn: () => void) {
      const entry = { at: now() + ms, fn, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      entry.timer = setTimeout(() => { timers.delete(entry); fn(); }, ms); timers.add(entry);
      return () => { clearTimeout(entry.timer); timers.delete(entry); };
    },
    advance(ms: number) {
      offset += ms;
      for (const entry of [...timers]) if (entry.at <= now()) { clearTimeout(entry.timer); timers.delete(entry); entry.fn(); }
    },
  };
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

type Service = { stop(): Promise<void> };
type StartSupervisor = (root: string, options: { system: SupervisorSystemPorts; clock: ReturnType<typeof fixtureClock> }) => Promise<Service>;

export interface HostedOwner { pid: number; terminal: string; sessionId: string; file: string; cwd: string }
export interface HostingFixture {
  suite: Suite; root: string; cwd: string; sessionId: string; file: string; coreUnit: string; supervisorUnit: string; systemctlLog: string; shellLog: string;
  start(): Promise<void>; settle(): Promise<void>; close(): Promise<void>; waitOwner(previousPid?: number): Promise<HostedOwner>;
  provisionUnit(): Promise<void>;
  owners(): Promise<HostedOwner[]>; events(pid: number): Promise<ObservedEvent[]>;
  control(kind: 'session-start' | 'session-stop' | 'session-resume', id: string): Promise<Record<string, unknown>>;
  restartCore(): Promise<void>; crash(owner: HostedOwner): Promise<void>; advance(ms: number): void;
  state(): ReturnType<ReturnType<typeof createIntentStore>['get']>;
}

/** Uses real packaged code and cores, with fixture-owned platform commands and process enumeration. */
export async function hostingFixture(suite: Suite, name = 'hosting'): Promise<HostingFixture> {
  const cores = suite.cores;
  if (!cores) throw new Error('hosting needs an isolated core');
  const root = suite.directories.SPIDER_GLOBAL_ROOT, cwd = await suite.project(name);
  const sessionId = randomUUID(), repo = randomUUID(), workspace = randomUUID(), file = suite.ownPath(join(cwd, 'session.jsonl'));
  const agent = suite.directories.PI_CODING_AGENT_DIR, herdr = join(root, 'herdr');
  const unitDir = suite.ownPath(join(suite.root, 'units')), coreUnit = join(unitDir, 'herdr-core.service'), supervisorUnit = join(unitDir, 'spider-roam-supervisor.service');
  const shell = suite.ownPath(join(suite.root, 'bin', 'hosting-shell')), shellLog = suite.ownPath(join(suite.root, 'shell-plan.log'));
  const systemctlLog = suite.ownPath(join(suite.root, 'systemctl.log'));
  const projectRoot = paths.projectRoot(cwd);
  for (const dir of [join(root, 'roam'), herdr, unitDir, projectRoot]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(coreUnit, 'existing fixture core service\n', { mode: 0o600 });
  await writeFile(join(root, 'roam', 'machine.json'), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  await writeFile(join(root, 'roam', 'config.json'), JSON.stringify({ enabled: false, role: 'box', machineId: BOX, hubMachineId: HUB,
    peers: [], discoveryRoots: [], coreUnit: 'herdr-core.service' }), { mode: 0o600 });
  await writeFile(join(herdr, 'config.json'), JSON.stringify({ enabled: true, mode: 'core-only', core: { binary: cores.wrapper, config: join(suite.root, 'core.toml') },
    agentDirectory: agent, globalRoot: root, shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [] }), { mode: 0o600 });
  await writeFile(join(agent, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } }), { mode: 0o600 });
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n', { mode: 0o600 });

  const bootExtension = suite.ownPath(join(suite.root, 'participant-boot.mjs'));
  const packedExtension = pathToFileURL(join(suite.packed.root, 'dist', 'extension.js')).href;
  await writeFile(bootExtension, `import spider from ${JSON.stringify(packedExtension)};\nexport default pi => spider(pi, { bootId: async () => ${JSON.stringify(BOOT)} });\n`, { mode: 0o600 });
  const settingsFile = join(agent, 'settings.json'), settings = JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>;
  await writeFile(settingsFile, JSON.stringify(participantBootSettings(settings, suite.packed.root, bootExtension), null, 2), { mode: 0o600 });

  // The launch shell records the requested limit instead of changing an operating-system limit.
  const systemctl = join(suite.root, 'bin', 'systemctl');
  await writeFile(systemctl, `#!/bin/sh\ncase "$*" in '--user start spider-roam-supervisor.service'|'--user enable spider-roam-supervisor.service'|'--user daemon-reload') ;; *) exit 1 ;; esac\nprintf '%s\\n' "$*" >> ${quote(systemctlLog)}\n`, { mode: 0o700 });
  await writeFile(shell, `#!/bin/sh\n[ "$1" = '-c' ] || exit 90\nshift 2\n[ "$1" = "$0" ] || exit 91\nshift\nprintf '%s\\n' "$1" >> ${quote(shellLog)}\nshift\n[ "$1" = ${quote(root)} ] && [ "$2" = ${quote(agent)} ] || exit 92\nexport SPIDER_GLOBAL_ROOT="$1" PI_CODING_AGENT_DIR="$2" SPIDER_HERDR_HANDOFF_FILE="$3"\nunset SPIDER_HERDR_HANDOFF_OPERATION_ID SPIDER_HERDR_HANDOFF_NONCE SPIDER_HERDR_LEASE_TOKEN SPIDER_HERDR_LEASE_FILE SPIDER_HERDR_SSH_BYPASS PI_SUBAGENT_CHILD\nshift 3\n[ "$1" = ${quote(suite.pi.launcher)} ] && [ "$2" = '--session' ] || exit 93\ncase "$3" in ${quote(suite.root)}/*) ;; *) exit 94 ;; esac\nexec "$@"\n`, { mode: 0o700 });
  for (const script of [systemctl, shell]) await chmod(script, 0o700);

  const db = openDb(join(root, 'spider.db')), worktree = openDb(join(projectRoot, 'project.db'));
  try {
    migrate(db, 'global', { machineId: BOX, globalRoot: root });
    db.prepare("UPDATE roam_meta SET store_key='global',capture_enabled=1 WHERE id=1").run();
    migrate(worktree, 'worktree', { machineId: BOX, globalRoot: root });
    await mapWorkspace(db, { repoKey: repo, workspaceId: workspace, path: cwd });
    worktree.prepare('UPDATE roam_meta SET store_key=?,capture_enabled=1 WHERE id=1').run(`worktree:${repo}:${workspace}`);
    worktree.prepare('INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)').run(sessionId, BOX);
    worktree.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'retired')").run(sessionId);
    db.prepare('INSERT INTO session_homes VALUES (?,?,1,NULL,1)').run(sessionId, BOX);
    recordLocation(db, { sessionId, stores: [`worktree:${repo}:${workspace}`], home: null, file, cwd });
  } finally { worktree.close(); db.close(); }

  const env = { ...suite.env, ...cores.local.env, HC_SESSION: cores.local.namespace, HC_SOCKET: cores.local.socket,
    SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: agent, SPIDER_ROAM_PI: suite.pi.launcher };
  const restoreEnv = enterHostingEnvironment(env);
  let domain: NonNullable<ReturnType<typeof fixtureProcessDomain>>;
  let packaged: { startProductionSupervisor: StartSupervisor };
  let processPorts: ReturnType<typeof createLocalDiagnosticPorts>;
  let intents: ReturnType<typeof createIntentStore>;
  try {
    const created = fixtureProcessDomain(herdr, env);
    if (!created) throw new Error('missing fixture process domain');
    domain = created;
    packaged = await import(/* @vite-ignore */ pathToFileURL(suite.packed.roamSupervisor).href) as typeof packaged;
    processPorts = createLocalDiagnosticPorts(root, []);
    intents = createIntentStore(root);
  } catch (error) { restoreEnv(); throw error; }
  const inventory: ProcessInventoryPorts = {
    presence: createProcessPresence(herdr), leases: createSessionLeases(herdr), processes: () => domain.processes(),
    probe: pid => processPorts.probeProcess({ machineId: BOX, label: 'fixture', peer: null }, pid),
  };
  const system = { shell, bootId: async () => BOOT, limits: async () => ({ soft: 8192, hard: 8192 }), inventory } as SupervisorSystemPorts;
  const clock = fixtureClock();
  let service: Service | undefined;
  const start = async () => { if (service) throw new Error('supervisor already started'); service = await packaged.startProductionSupervisor(root, { system, clock }); };
  const stop = async () => { if (service) { const current = service; service = undefined; await current.stop(); } };
  const close = async () => {
    try { await stop(); } finally { restoreEnv(); }
  };
  const control: HostingFixture['control'] = async (kind, id) => {
    const request = { id, kind, machineId: BOX, expectedEpoch: 1, args: { sourceMachine: HUB, sessionId } };
    const result = await suite.invoke(process.execPath, [suite.packed.roamCli, 'roam', 'agent', JSON.stringify(request)], env);
    if (result.exitCode !== 0) throw new Error(`packed control failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const events = (pid: number) => readObserved(suite.pi.observerDir, pid);
  const owners = async () => {
    const rows: HostedOwner[] = [];
    for (const process of await domain.processes()) {
      const entry = (await events(process.pid)).find(event => event.type === 'session_start' && event.sessionId === sessionId && event.sessionFile === file);
      if (entry && typeof entry.hcTerminal === 'string') rows.push({ pid: process.pid, terminal: entry.hcTerminal, sessionId, file, cwd });
    }
    return rows;
  };
  const waitOwner: HostingFixture['waitOwner'] = async previousPid => {
    const rows = await waitFor('one packed exact-session owner', owners,
      values => values.length === 1 && values[0].pid !== previousPid, deadline(60_000), { reconcileMs: 100 });
    const owner = rows[0], lock = await inspectIdLock(herdr, sessionId);
    if (!lock || lock.identity.pid !== owner.pid || lock.pendingOperationId !== null) throw new Error('session owner did not adopt its ID lock');
    const lease = await inventory.leases.get(file);
    if (!lease || lease.pid !== owner.pid || lease.startIdentity !== lock.identity.startIdentity) throw new Error('session owner did not adopt its file lease');
    const record = identityOf(owner.pid);
    suite.ledger.update(ledger => {
      if (!ledger.terminals.some(item => item.side === 'local' && item.address === owner.terminal)) ledger.terminals.push({ side: 'local', address: owner.terminal });
      if (!ledger.processes.some(item => item.pid === record.pid && item.start === record.start)) ledger.processes.push({ ...record, label: 'hosted-pi', group: false });
    });
    await waitFor('durable readiness belongs to the exact terminal', () => {
      const db = openDb(join(root, 'spider.db'));
      try { const row = readLocal<unknown>(db, 'participant-ready', sessionId); return row ? parseReadiness(row) : null; }
      finally { db.close(); }
    }, value => Boolean(value && value.sessionId === sessionId && value.file === file && value.terminal === owner.terminal), deadline(30_000));
    return owner;
  };
  const provisionUnit: HostingFixture['provisionUnit'] = async () => {
    const home = suite.root, npmPrefix = join(home, 'prefix');
    const common = { operationId: 'fixture-provision', machineId: BOX, home, globalRoot: root, agentDir: agent, npmPrefix, unitDir,
      core: cores.wrapper, coreId: cores.local.coreId, node: process.execPath, pi: suite.pi.launcher, cli: suite.packed.roamCli,
      supervisor: suite.packed.roamSupervisor, maximum: DEFAULT_LIMITS.agentBytes, chunkBytes: DEFAULT_LIMITS.chunkBytes };
    const execute = async (request: Record<string, unknown>) => {
      const process = spawnOwned(suite.ledger, { label: 'hosting-unit-install', command: globalThis.process.execPath,
        args: ['--input-type=module-typescript', '-e', PROVISION_REMOTE_SCRIPT], env: { ...suite.env, HOME: home }, cwd: suite.root, stdio: 'pipe' });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      process.child.stdout!.on('data', chunk => stdout.push(Buffer.from(chunk)));
      process.child.stderr!.on('data', chunk => stderr.push(Buffer.from(chunk)));
      process.child.stdin!.end(JSON.stringify({ ...common, ...request }));
      const code = await new Promise<number | null>(resolve => process.child.once('close', resolve));
      if (code !== 0) throw new Error(`fixture unit action failed: ${Buffer.concat(stderr).toString('utf8')}`);
      const reply = JSON.parse(Buffer.concat(stdout).toString('utf8')) as { value?: unknown; error?: string };
      if (reply.value !== true) throw new Error(`fixture unit action refused: ${reply.error ?? 'invalid reply'}`);
    };
    await execute({ action: 'unit-write', unit: 'spider-roam-supervisor.service', contents: renderSupervisorUnit({ node: process.execPath,
      supervisor: suite.packed.roamSupervisor, coreUnit: 'herdr-core.service', globalRoot: root, agentDir: agent, pi: suite.pi.launcher }) });
    await execute({ action: 'systemctl', argv: ['--user', 'daemon-reload'] });
    await execute({ action: 'systemctl', argv: ['--user', 'enable', 'spider-roam-supervisor.service'] });
  };
  const crash: HostingFixture['crash'] = async owner => {
    clock.advance(10_000);
    await waitFor('supervisor records the live owner before crash', () => intents.get(sessionId), row =>
      row?.value.supervision.kind === 'live' && row.value.supervision.identity.pid === owner.pid, deadline(30_000));
    const current = await owners();
    if (current.length !== 1 || current[0].pid !== owner.pid || current[0].terminal !== owner.terminal) throw new Error('refusing to signal an unowned session');
    const identity = identityOf(owner.pid); process.kill(owner.pid, 'SIGKILL');
    await waitFor('owned session process exits', () => identityAlive(identity), alive => !alive, deadline(30_000), { reconcileMs: 100 });
    await waitFor('crashed fixture owner is absent', () => inventory.probe(owner.pid), result => result.kind === 'absent', deadline(30_000), { reconcileMs: 100 });
  };
  const restartCore = async () => {
    await stop();
    const before = await suite.hc(['server', 'status', '--json']);
    const status = before.json as { pid?: number; core?: { id?: string } } | null;
    if (before.exitCode !== 0 || status?.pid !== cores.local.pid || status.core?.id !== cores.local.coreId) throw new Error('refusing to restart an unowned core');
    const stopped = await suite.hc(['server', 'stop', '--json']);
    if (stopped.exitCode !== 0) throw new Error(`fixture core stop failed: ${stopped.stderr}`);
    const started = await suite.hc(['server', 'start', '--json']);
    if (started.exitCode !== 0) throw new Error(`fixture core start failed: ${started.stderr}`);
    const after = await suite.hc(['server', 'status', '--json']);
    const next = after.json as { pid?: number; core?: { id?: string } } | null;
    if (after.exitCode !== 0 || typeof next?.pid !== 'number' || next.core?.id !== cores.local.coreId) throw new Error('fixture core identity changed on restart');
    const identity = identityOf(next.pid); cores.local.pid = next.pid;
    suite.ledger.update(ledger => { const core = ledger.cores.find(item => item.side === 'local'); if (!core) throw new Error('fixture core not recorded'); core.pid = identity.pid; core.start = identity.start; });
    await start();
  };
  return { suite, root, cwd, sessionId, file, coreUnit, supervisorUnit, systemctlLog, shellLog, start, settle: stop, close, waitOwner, owners, events, control, provisionUnit, restartCore, crash,
    advance: ms => clock.advance(ms), state: () => intents.get(sessionId) };
}

export const digestFile = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');
export const hasFile = (file: string): boolean => existsSync(file);
