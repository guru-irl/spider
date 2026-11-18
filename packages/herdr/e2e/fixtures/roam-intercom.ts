// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { openDb, openDbReadOnly, migrate, type Db } from '@spider/db-core';
import { readLocal, writeLocal } from '@spider/db-core/roam/local-state';
import { mapWorkspace, resolveRepositoryKey } from '@spider/db-core/roam/repo-map';
import type { StoreKey } from '@spider/db-core/roam/types';
import { readSessionHeader } from '@spider/herdr/sessions/launcher';
import { seedNewParticipant } from '../../../roam/src/session-control.js';
import { createStorePort } from '../../../roam/src/stores.js';
import { IntercomClient } from '@spider/intercom/broker/client';
import { parseConfig } from '../../../roam/src/config.js';
import { installSupervisorCorePin } from '../../../roam/src/enrollment.js';
import type { IntercomRoute, Peer, RoamConfig } from '../../../roam/src/contracts.js';
import { assertSocketPath, HarnessError } from '../harness/environment.js';
import { realHcBinary, runHc, type HcResult } from '../harness/hc.js';
import { launchPi, type InteractiveDriver } from '../harness/pi.js';
import { spawnOwned, type OwnedProcess } from '../harness/processes.js';
import { identityOf } from '../harness/resources.js';
import { deadline, waitFor } from '../harness/wait.js';
import type { Suite } from '../harness/suite.js';

const IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
] as const;
const ALIASES = ['hub.invalid', 'box-1.invalid', 'box-2.invalid'] as const;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

interface Core { side: string; namespace: string; socket: string; env: Record<string, string>; coreId: string; pid: number }
export interface Machine {
  id: string; alias: string; core: Core; agent: string; global: string; sessions: string;
  env: Record<string, string>; config: RoamConfig; service: OwnedProcess; probe: IntercomClient;
  faultFile?: string; clockSocket?: string;
}
export interface Network {
  machines: readonly Machine[];
  restartHub(): Promise<void>;
  restartBox(index: 1 | 2, config: RoamConfig, pairDescriptor?: string): Promise<void>;
  close(): Promise<void>;
}

/** Fault controls affect only owned hc exec processes, never the core or its protocol. */
export async function setLinkFault(machine: Machine, down: readonly string[], scope?: "exchange"): Promise<void> {
  if (!machine.faultFile || down.some(alias => !ALIASES.includes(alias as typeof ALIASES[number]) || alias === machine.alias)) throw new HarnessError('unsafe-fault', 'fault is not an owned edge');
  const temporary = `${machine.faultFile}.new`;
  await writeFile(temporary, JSON.stringify({ down, ...(scope ? { scope } : {}) }), { mode: 0o600 });
  await rename(temporary, machine.faultFile);
}

export async function dropNextReply(machine: Machine, alias: string, messageId: string): Promise<void> {
  if (!machine.faultFile || !ALIASES.includes(alias as typeof ALIASES[number]) || alias === machine.alias || !/^[0-9a-f-]{36}$/.test(messageId)) {
    throw new HarnessError('unsafe-fault', 'lost reply must target an owned edge and message');
  }
  await writeFile(`${machine.faultFile}.drop-${alias}`, messageId, { mode: 0o600, flag: 'wx' });
}

export async function advanceIntercomClock(machine: Machine, advanceMs: number): Promise<{ now: number; offset: number; timers: number }> {
  if (!machine.clockSocket) throw new HarnessError('missing-prerequisite', 'no fixture clock');
  const advanced = await new Promise<{ now: number; offset: number; timers: number }>((ok, fail) => {
    const socket = createConnection(machine.clockSocket!); let text = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ advanceMs })}\n`));
    socket.on('data', chunk => { text += chunk.toString('utf8'); });
    socket.on('error', fail);
    socket.on('end', () => { try { const value = JSON.parse(text); if (value.error) throw new Error(value.error); ok(value); } catch (error) { fail(error); } });
  });
  machine.env.SPIDER_E2E_INTERCOM_CLOCK_OFFSET = String(advanced.offset);
  return advanced;
}

/** Box admission requires a real terminal and its actual process ancestry. */
export async function launchMachinePi(suite: Suite, machine: Machine, cwd: string, name: string, extraEnv: Record<string, string> = {}, resumeSessionId?: string, args: readonly string[] = []): Promise<InteractiveDriver> {
  if (!suite.cores) throw new HarnessError('missing-prerequisite', 'intercom acceptance requires isolated cores');
  const sessionId = resumeSessionId ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new HarnessError('unsafe-session', 'invalid owned session ID');
  const file = suite.ownPath(join(machine.sessions, `${sessionId}.jsonl`));
  if (resumeSessionId) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new HarnessError('unsafe-session', 'resume transcript is not an owned regular file');
  } else await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n', { mode: 0o600, flag: 'wx' });
  const cores = { ...suite.cores, local: { ...suite.cores.local, coreId: machine.core.coreId },
    hc: (argv: readonly string[], _side?: 'local' | 'dest', options?: { cwd?: string; input?: string }) =>
      runHc(suite.cores!.wrapper, argv, machine.core.env, options) };
  return await launchPi(suite.pi, suite.ledger, { mode: 'interactive', cwd, args: ['--session', file, '--name', name, ...args],
    extraEnv: { ...machine.env, ...extraEnv }, terminalSide: machine.core.side }, cores) as InteractiveDriver;
}

export async function pauseFederation(network: Network): Promise<void> {
  for (const machine of network.machines) await machine.service.stop();
}

export async function resumeFederation(network: Network): Promise<void> {
  await network.restartHub();
  await network.restartBox(1, network.machines[1].config);
  await network.restartBox(2, network.machines[2].config);
}

async function captureSession(suite: Suite, machine: Machine, global: Db, id: string, file: string, cwd: string): Promise<StoreKey> {
  const db = openDb(suite.ownPath(join(cwd, '.spider', 'project.db')), { fileMustExist: true });
  try {
    const row = db.prepare('SELECT origin_machine FROM sessions WHERE id=?').get(id) as { origin_machine: string } | undefined;
    if (row?.origin_machine !== machine.id) throw new HarnessError('isolation-unproved', 'captured session is not native to its owned machine');
    let key = (db.prepare('SELECT store_key FROM roam_meta WHERE id=1').get() as { store_key: StoreKey | null }).store_key;
    if (!key) {
      const repoKey = resolveRepositoryKey(global, cwd);
      let workspaceId = readLocal<string>(db, 'workspace', 'id');
      if (!workspaceId) {
        workspaceId = randomUUID();
        db.raw.transaction(() => writeLocal(db, 'workspace', 'id', workspaceId)).immediate();
      }
      await mapWorkspace(global, { repoKey, workspaceId, path: cwd });
      key = `worktree:${repoKey}:${workspaceId}`;
    }
    if (!global.prepare('SELECT 1 FROM session_homes WHERE session_id=?').get(id)) {
      seedNewParticipant({ globalDb: global, machineId: machine.id, sessionId: id, file, cwd,
        stores: [{ key, db }], limit: machine.config.limits.targetBatchBytes });
    }
    return key;
  } finally { db.close(); }
}

/** Capture real owned session rows, then import/export the resulting records through the hub.
 * This mirrors admission capture and data sync without assigning a first home. */
export async function syncOrigins(suite: Suite, network: Network): Promise<void> {
  const globals = network.machines.map(machine => openDb(suite.ownPath(join(machine.global, 'spider.db')), { fileMustExist: true }));
  const adapters = globals.map((db, i) => createStorePort(network.machines[i].config, db));
  const keys = new Map<StoreKey, number>();
  try {
    for (const [i, machine] of network.machines.entries()) {
      for (const name of await readdir(machine.sessions)) {
        if (!/^[0-9a-f-]{36}\.jsonl$/.test(name)) continue;
        const file = suite.ownPath(join(machine.sessions, name)), header = await readSessionHeader(file);
        const cwd = suite.ownPath(header.cwd);
        const key = await captureSession(suite, machine, globals[i], header.id, file, cwd);
        keys.set(key, i);
      }
    }
    for (const key of keys.keys()) {
      const separator = key.lastIndexOf(':');
      const repoKey = key.slice('worktree:'.length, separator), workspaceId = key.slice(separator + 1);
      for (const [i, machine] of network.machines.entries()) {
        if (globals[i].prepare('SELECT 1 FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?').get(repoKey, workspaceId)) continue;
        const path = suite.ownPath(join(machine.global, 'origin-workspaces', workspaceId));
        await mkdir(path, { recursive: true, mode: 0o700 });
        const db = openDb(suite.ownPath(join(path, '.spider', 'project.db')));
        try { migrate(db, 'worktree', { machineId: machine.id, globalRoot: machine.global }); }
        finally { db.close(); }
        await mapWorkspace(globals[i], { repoKey, workspaceId, path });
      }
    }
    const transfer = async (from: number, to: number, key: StoreKey): Promise<void> => {
      const meta = adapters[from].openStore(key).db.prepare('SELECT machine_id,stream_id FROM roam_meta WHERE id=1').get() as { machine_id: string; stream_id: string };
      for (;;) {
        const after = adapters[to].cursor(key, meta.machine_id, meta.stream_id);
        const batch = await adapters[from].export(key, after, network.machines[from].config.limits.targetBatchBytes, randomUUID());
        if (batch.header.count === 0) return;
        suite.ownPath(batch.file);
        try { await adapters[to].accept(key, batch); }
        finally { await unlink(batch.file); }
      }
    };
    for (const [key, source] of keys) {
      if (source !== 0) await transfer(source, 0, key);
      for (let target = 1; target < network.machines.length; target++) await transfer(0, target, key);
    }
    await suite.evidence('captured-origins.json', adapters.map(adapter => [...adapter.origins()].map(([id, origins]) => ({ id, origins: [...origins] }))));
  } finally {
    for (const adapter of adapters.reverse()) adapter.close();
    for (const db of globals.reverse()) db.close();
  }
}

export async function saveIntercomEvidence(suite: Suite, network: Network): Promise<void> {
  const snapshots = network.machines.map(machine => {
    const db = openDbReadOnly(suite.ownPath(join(machine.global, 'roam', 'intercom', 'queue.db')));
    if (!db) throw new HarnessError('missing-prerequisite', 'owned intercom queue is missing');
    try {
      return db.raw.transaction(() => ({ machine: machine.id, tables: Object.fromEntries([
        'intercom_messages', 'intercom_copies', 'intercom_cursors', 'intercom_receipts', 'intercom_resumptions',
        'intercom_edge_state', 'intercom_rejections', 'intercom_endpoint_aliases',
      ].map(table => [table, db.prepare(`SELECT * FROM ${table} LIMIT 100`).all()])) }))();
    } finally { db.close(); }
  });
  await suite.evidence('intercom-queues.json', snapshots);
  for (const [i, machine] of network.machines.entries()) {
    await suite.keepEvidence(join(machine.global, '..', 'service.log'), `intercom-service-${i}.log`);
    await suite.keepEvidence(join(machine.global, '..', 'broker.log'), `intercom-broker-${i}.log`);
  }
}

function checked(result: HcResult, what: string): Record<string, unknown> {
  if (result.exitCode !== 0 || !result.json || typeof result.json !== 'object') throw new HarnessError('hc-failed', `${what}: ${result.stderr}`);
  return result.json as Record<string, unknown>;
}

/** A third and fourth owned core let all three peers use the existing guarded via fixture. */
async function extraCore(suite: Suite, namespace: 'b' | 'c'): Promise<Core> {
  if (!suite.cores) throw new HarnessError('missing-prerequisite', 'intercom acceptance requires isolated cores');
  const base = suite.cores.dest.env;
  const env: Record<string, string> = { ...base, HC_SESSION: namespace, HOME: suite.ownPath(join(suite.root, `h${namespace}`)),
    TMPDIR: suite.ownPath(join(suite.root, `t${namespace}`)), XDG_CONFIG_HOME: suite.ownPath(join(suite.root, `c${namespace}`)) };
  for (const key of ['HC_SOCKET', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'XDG_RUNTIME_DIR']) delete env[key];
  for (const dir of [env.HOME, env.TMPDIR, join(env.XDG_CONFIG_HOME, 'herdr-core')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core', 'config.toml'), 'notes = false\n', { mode: 0o600 });
  const socket = assertSocketPath(suite.root, join(env.XDG_STATE_HOME, 'herdr-core', namespace, `${namespace}.sock`));
  const side = `intercom-${namespace}`;
  suite.ledger.update(ledger => { ledger.cores.push({ side, namespace, socket, hcBinary: realHcBinary(), env }); });
  const call = (args: readonly string[]) => runHc(suite.cores!.wrapper, args, env);
  checked(await call(['server', 'start', '--json']), `${side} start`);
  const status = checked(await call(['server', 'status', '--json']), `${side} status`);
  const core = status.core as { id?: unknown } | undefined;
  if (status.version !== '0.1.16' || typeof status.pid !== 'number' || typeof core?.id !== 'string' || !lstatSync(socket).isSocket()) {
    throw new HarnessError('isolation-unproved', `${side} is not an owned hc 0.1.16 core`);
  }
  const identity = identityOf(status.pid);
  suite.ledger.update(ledger => { const entry = ledger.cores.find(item => item.side === side)!; entry.coreId = core.id as string; entry.pid = identity.pid; entry.start = identity.start; });
  return { side, namespace, socket, env, coreId: core.id, pid: status.pid };
}

async function mesh(suite: Suite, cores: readonly Core[]): Promise<void> {
  const existing = suite.cores!;
  const viaDirectory = suite.ownPath(join(suite.root, 'via-processes'));
  for (let target = 0; target < cores.length; target++) {
    const descriptor = suite.ownPath(join(suite.root, `via-i${target}.json`));
    const via = suite.ownPath(join(suite.root, 'bin', `via-i${target}`));
    await writeFile(descriptor, JSON.stringify({ root: suite.root, env: cores[target].env, log: existing.viaLog,
      ledgerPath: suite.ledger.path, socket: cores[target].socket, viaDirectory }), { mode: 0o600 });
    const program = fileURLToPath(new URL('./via.mjs', import.meta.url));
    await writeFile(via, `#!/bin/sh\nexec 9<"$0"\nexec ${quote(process.execPath)} ${quote(program)} ${quote(descriptor)} "$@"\n`, { mode: 0o700 });
    for (let source = 0; source < cores.length; source++) {
      if (source === target) continue;
      suite.ledger.update(ledger => { ledger.machines.push({ side: cores[source].side, name: ALIASES[target] }); });
      checked(await runHc(existing.wrapper, ['machine', 'add', '--via', via, '--name', ALIASES[target], '--session', cores[target].namespace, '--json'], cores[source].env), 'machine add');
      const listing = checked(await runHc(existing.wrapper, ['machine', 'ls', '--json'], cores[source].env), 'machine list');
      const record = Array.isArray(listing.machines) ? listing.machines.find((item: { name?: unknown }) => item.name === ALIASES[target]) : undefined;
      if (!record || record.id !== cores[target].coreId) throw new HarnessError('isolation-unproved', 'fixture route does not reach its owned core');
    }
  }
}

async function socketReady(path: string): Promise<void> {
  await waitFor('packed fixture broker socket', () => { try { return lstatSync(path).isSocket(); } catch { return false; } }, Boolean, deadline(30_000));
}

/** Connect a read-only roster observer without inheriting the caller's agent directory. */
async function rosterProbe(agent: string, index: number, cwd: string): Promise<IntercomClient> {
  const client = new IntercomClient();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  let opening: Promise<void>;
  try { opening = client.connect({ address: { sessionId: `probe-${index}`, scopeId: null }, cwd, model: 'fixture', pid: process.pid,
    name: `probe-${index}`, startedAt: 1, lastActivity: 1, activationEpoch: `probe-${index}` }, `probe-${index}`); }
  finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
  await opening;
  return client;
}

/** Starts the packaged hub, supervisors, brokers, helpers and extension against owned cores. */
export async function intercomNetwork(suite: Suite, options: { faults?: boolean; virtualClock?: boolean | 'all' } = {}): Promise<Network> {
  if (!suite.cores) throw new HarnessError('missing-prerequisite', 'intercom acceptance requires isolated cores');
  const extra: Core[] = [], machines: Machine[] = [], brokers: OwnedProcess[] = [], services: OwnedProcess[] = [], probes: IntercomClient[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    for (const probe of probes.reverse()) await probe.disconnect();
    for (const service of services.reverse()) await service.stop();
    for (const broker of brokers.reverse()) await broker.stop();
  };
  const startService = async (index: number, root: string, global: string, env: Record<string, string>, clockSocket?: string, pairDescriptor?: string) => {
    const serviceLog = join(root, 'service.log'); await writeFile(serviceLog, '');
    const args = index === 0 ? clockSocket
      ? [fileURLToPath(new URL('./roam-hub-clock.mjs', import.meta.url)), join(suite.packed.root, 'dist/roam/cli-main.mjs'), global, clockSocket]
      : [suite.packed.roamCli, 'roam', 'hub']
      : [fileURLToPath(new URL('./roam-supervisor-fixture.mjs', import.meta.url)), suite.packed.roamSupervisor, global];
    const service = spawnOwned(suite.ledger, { label: index === 0 ? 'packed-intercom-hub' : `packed-intercom-supervisor-${index}`,
      command: process.execPath, args, env: { ...env, SPIDER_HERDR_E2E_PACKED_ROOT: suite.packed.root,
        ...(pairDescriptor ? { SPIDER_E2E_PAIR_DESCRIPTOR: pairDescriptor } : {}),
        ...(clockSocket ? { SPIDER_E2E_INTERCOM_CLOCK: clockSocket } : {}) }, cwd: suite.root, stdio: { log: serviceLog } });
    services.push(service);
    await waitFor('packed machine service starts', async () => {
      const log = await readFile(serviceLog, 'utf8');
      if (service.child.exitCode !== null || service.child.signalCode !== null) throw new Error(`machine service exited: ${log}`);
      if (index !== 0) return log.includes('fixture supervisor ready');
      try { return lstatSync(join(global, 'roam', 'hub.sock')).isSocket(); } catch { return false; }
    }, Boolean, deadline(30_000));
    return service;
  };
  try {
    extra.push(await extraCore(suite, 'b')); extra.push(await extraCore(suite, 'c'));
    const cores: Core[] = [suite.cores.dest, ...extra];
    if (new Set(cores.map(core => core.coreId)).size !== 3 || new Set(cores.map(core => core.socket)).size !== 3) throw new HarnessError('isolation-unproved', 'intercom cores are not independent');
    await mesh(suite, cores);
    const roots = await Promise.all(cores.map(async (_, i) => {
      const root = suite.ownPath(join(suite.root, `m${i}`)), agent = join(root, 'a'), global = join(root, 'g'), sessions = join(root, 's'), home = join(root, 'h');
      for (const path of [root, agent, global, sessions, home, join(global, 'roam')]) await mkdir(path, { recursive: true, mode: 0o700 });
      await copyFile(join(suite.directories.PI_CODING_AGENT_DIR, 'settings.json'), join(agent, 'settings.json'));
      await copyFile(join(suite.directories.PI_CODING_AGENT_DIR, 'models.json'), join(agent, 'models.json'));
      await copyFile(join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json'), join(global, 'config.json'));
      await writeFile(join(global, 'roam', 'machine.json'), JSON.stringify({ machineId: IDS[i] }), { mode: 0o600 });
      const env: Record<string, string> = { ...suite.env, ...cores[i].env, HOME: home, HC_SOCKET: cores[i].socket,
        PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions, SPIDER_GLOBAL_ROOT: global };
      let binary = suite.cores!.wrapper, faultFile: string | undefined;
      if (options.faults) {
        binary = suite.ownPath(join(root, 'hc-fault')); faultFile = suite.ownPath(join(root, 'fault.json'));
        await writeFile(faultFile, JSON.stringify({ down: [] }), { mode: 0o600 });
        const program = fileURLToPath(new URL('./roam-hc-fault.mjs', import.meta.url));
        await writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`, { mode: 0o700 });
        Object.assign(env, { SPIDER_E2E_FIXTURE_ROOT: suite.root, SPIDER_E2E_HC_REAL: suite.cores!.wrapper, SPIDER_E2E_HC_FAULT: faultFile });
      }
      return { root, agent, global, sessions, env, binary, faultFile };
    }));
    const peers: Peer[] = roots.map((root, i) => ({ machineId: IDS[i], alias: ALIASES[i], node: process.execPath, pi: suite.pi.launcher,
      cli: join(suite.packed.root, 'dist/roam/cli.mjs'), core: suite.cores!.wrapper, globalRoot: root.global }));
    const mode = 'hub-only';
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      const routes = peers.flatMap<IntercomRoute>((peer, j) => {
        if (j === i) return [];
        if (mode === 'hub-only' && i !== 0 && j !== 0) return [{ kind: 'relay' as const, peer, via: IDS[0] }];
        return [{ kind: 'direct' as const, peer, edgeEpoch: `edge-${Math.min(i, j)}-${Math.max(i, j)}` }];
      });
      const config = parseConfig({ enabled: i === 0, role: i === 0 ? 'hub' : 'box', machineId: IDS[i], hubMachineId: IDS[0], coreUnit: 'fixture.service',
        intercom: { enabled: true, mode, machineAlias: ALIASES[i], routes } });
      await writeFile(join(root.global, 'roam', 'config.json'), JSON.stringify(config), { mode: 0o600 });
      if (i > 0) {
        const core = cores[i];
        installSupervisorCorePin(root.global, { binary: root.binary, coreId: core.coreId, socket: core.socket,
          sessionNamespace: core.namespace, stateHome: core.env.XDG_STATE_HOME, configHome: core.env.XDG_CONFIG_HOME });
      }
      await mkdir(join(root.global, 'herdr'), { recursive: true, mode: 0o700 });
      await writeFile(join(root.global, 'herdr', 'config.json'), JSON.stringify({
        app: { binary: join(suite.root, 'bin', 'unused-app'), home: suite.directories.HERDR_APP_HOME },
        core: { binary: root.binary, config: join(suite.root, 'core.toml') }, agentDirectory: root.agent,
        globalRoot: root.global, shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [],
      }), { mode: 0o600 });
      const db = openDb(join(root.global, 'spider.db'));
      try {
        migrate(db, 'global', { machineId: IDS[i], globalRoot: root.global });
        db.prepare("UPDATE roam_meta SET store_key = 'global', capture_enabled = 1 WHERE id = 1").run();
      } finally { db.close(); }
      const broker = spawnOwned(suite.ledger, { label: `packed-intercom-broker-${i}`, command: process.execPath,
        args: [suite.packed.intercomBroker], env: root.env, cwd: suite.root, stdio: { log: join(root.root, 'broker.log') } });
      brokers.push(broker); await socketReady(join(root.agent, 'intercom', 'broker.sock'));
      const clockSocket = (i === 0 && options.virtualClock || options.virtualClock === 'all') ? assertSocketPath(suite.root, join(root.global, 'clock.sock')) : undefined;
      const service = await startService(i, root.root, root.global, root.env, clockSocket);
      const probe = await rosterProbe(root.agent, i, root.root); probes.push(probe);
      machines.push({ id: IDS[i], alias: ALIASES[i], core: cores[i], agent: root.agent, global: root.global,
        sessions: root.sessions, env: root.env, config, service, probe, faultFile: root.faultFile, clockSocket });
    }
    await suite.evidence('intercom-cores.json', cores.map(core => ({ side: core.side, coreId: core.coreId, socket: core.socket, pid: core.pid })));
    const restartHub: Network['restartHub'] = async () => {
      const hub = machines[0];
      if (hub.config.role !== 'hub' || hub.id !== IDS[0] || hub.service.child.exitCode === null && hub.service.child.signalCode === null) {
        throw new HarnessError('unsafe-restart', 'owned hub must be stopped before restart');
      }
      hub.service = await startService(0, join(hub.global, '..'), hub.global, hub.env, hub.clockSocket);
    };
    const restartBox: Network['restartBox'] = async (index, config, pairDescriptor) => {
      const machine = machines[index];
      if (config.machineId !== machine.id || config.role !== 'box') throw new HarnessError('unsafe-restart', 'box identity changed');
      await machine.service.stop();
      await writeFile(join(machine.global, 'roam', 'config.json'), JSON.stringify(config), { mode: 0o600 });
      machine.config = config;
      machine.service = await startService(index, join(machine.global, '..'), machine.global, machine.env, machine.clockSocket, pairDescriptor);
    };
    return { machines, restartHub, restartBox, close };
  } catch (error) { await close(); throw error; }
}
