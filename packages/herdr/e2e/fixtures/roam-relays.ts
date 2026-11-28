// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { migrate, openDb } from '@spider/db-core';
import { writeLocal } from '@spider/db-core/roam/local-state';
import { requestV0Broker } from '@spider/intercom/broker/roam-v0-client';
import { createHomeStore } from '@spider/roam/relocate/home';
import type { RelocateId, RunningHome, SessionId, SessionPlacement } from '@spider/roam/relocate/types';
import { stageRoamDestination } from './roam-destination.js';
import { assertSocketPath, checkoutRoot, HarnessError } from '../harness/environment.js';
import { realHcBinary, runHc, type HcResult } from '../harness/hc.js';
import type { RpcDriver } from '../harness/pi.js';
import { spawnOwned, type OwnedProcess } from '../harness/processes.js';
import { identityOf } from '../harness/resources.js';
import type { InvokeResult, Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

const RELAY_ID = '00000000-0000-4000-8000-000000000001';
const SENDER_ID = '00000000-0000-4000-8000-000000000002';
const TARGET_ID = '00000000-0000-4000-8000-000000000003';
const BACKUP_ID = '00000000-0000-4000-8000-000000000004';
const RELAY_ALIAS = 'relay-1.invalid';
const BACKUP_ALIAS = 'relay-2.invalid';
const SENDER_ALIAS = 'dest.invalid';
const TARGET_ALIAS = 'target.invalid';
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

interface Core { side: string; namespace: string; socket: string; env: Record<string, string>; coreId: string; pid: number }
interface Machine { machineId: string; alias: string; core: Core; root: string; agent: string; cli: string; env: Record<string, string> }
export interface RelayEndpoint { id: string; machineId: string; alias: string; pi: RpcDriver; root: string; agent: string; file: string }
interface DoctorObservation { result: InvokeResult; diagnostics: { reason: string }[] }
type RelayStart = { kind: 'up'; doctor: DoctorObservation; reason: string };
export interface RelayFixture {
  sender: RelayEndpoint;
  target: RelayEndpoint;
  controls: { routes: object; homes: readonly RunningHome[]; homeObservations: object; endpoints: object };
  readonly relayStart: RelayStart | undefined;
  startRelay(index: 0 | 1): Promise<void>;
  stopRelay(index: 0 | 1): Promise<void>;
  waitForDown(): Promise<DoctorObservation>;
  withoutBackupTargetRoute<T>(run: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function checked(result: HcResult, what: string): Record<string, unknown> {
  if (result.exitCode !== 0 || !result.json || typeof result.json !== 'object' || Array.isArray(result.json)) {
    throw new HarnessError('hc-failed', `${what}: exit ${result.exitCode} ${result.stderr}`, result);
  }
  return result.json as Record<string, unknown>;
}

async function extraCore(suite: Suite, namespace: 'b' | 'c', side: 'relay-target' | 'relay-backup'): Promise<Core> {
  const cores = suite.cores!;
  const env: Record<string, string> = { ...cores.dest.env, HC_SESSION: namespace, HOME: suite.ownPath(join(suite.root, `h${namespace}`)),
    TMPDIR: suite.ownPath(join(suite.root, `t${namespace}`)), XDG_CONFIG_HOME: suite.ownPath(join(suite.root, `c${namespace}`)) };
  for (const key of ['HC_SOCKET', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'XDG_RUNTIME_DIR']) delete env[key];
  for (const dir of [env.HOME, env.TMPDIR, join(env.XDG_CONFIG_HOME, 'herdr-core')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core', 'config.toml'), 'notes = false\n', { mode: 0o600 });
  const socket = assertSocketPath(suite.root, join(env.XDG_STATE_HOME, 'herdr-core', namespace, `${namespace}.sock`));
  suite.ledger.update(ledger => { ledger.cores.push({ side, namespace, socket, hcBinary: realHcBinary(), env }); });
  const call = (args: readonly string[]) => runHc(cores.wrapper, args, env);
  checked(await call(['server', 'start', '--json']), `${side} core start`);
  const status = checked(await call(['server', 'status', '--json']), `${side} core status`);
  const core = status.core as { id?: unknown } | undefined;
  if (status.version !== '0.1.16' || typeof status.pid !== 'number' || typeof core?.id !== 'string' || !lstatSync(socket).isSocket()) {
    throw new HarnessError('isolation-unproved', `${side} is not an owned hc 0.1.16 core`, status);
  }
  const identity = identityOf(status.pid);
  suite.ledger.update(ledger => {
    const entry = ledger.cores.find(item => item.side === side)!;
    entry.coreId = core.id as string; entry.pid = identity.pid; entry.start = identity.start;
  });
  return { side, namespace, socket, env, coreId: core.id, pid: status.pid };
}

async function viaRoute(suite: Suite, destination: Core, index: 2 | 3): Promise<string> {
  const descriptor = suite.ownPath(join(suite.root, `via-i${index}.json`));
  const via = suite.ownPath(join(suite.root, 'bin', `via-i${index}`));
  await writeFile(descriptor, JSON.stringify({ root: suite.root, env: destination.env, log: suite.cores!.viaLog,
    ledgerPath: suite.ledger.path, socket: destination.socket, viaDirectory: join(suite.root, 'via-processes') }), { mode: 0o600 });
  const program = fileURLToPath(new URL('./via.mjs', import.meta.url));
  await writeFile(via, `#!/bin/sh\nexec 9<"$0"\nexec ${quote(process.execPath)} ${quote(program)} ${quote(descriptor)} "$@"\n`, { mode: 0o700 });
  return via;
}

async function stageMachine(suite: Suite, core: Core, machineId: string, alias: string, name: string): Promise<Machine> {
  const base = suite.ownPath(join(suite.root, name)), root = suite.ownPath(join(base, 'g'));
  await mkdir(base, { recursive: true, mode: 0o700 });
  const staged = await stageRoamDestination({ root: base, sourceAgent: suite.directories.PI_CODING_AGENT_DIR,
    box: root, home: core.env.HOME, release: suite.packed.root, checkout: checkoutRoot(), cli: suite.packed.roamCli });
  await copyFile(join(suite.directories.PI_CODING_AGENT_DIR, 'models.json'), join(staged.agent, 'models.json'));
  await copyFile(join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json'), join(root, 'config.json'));
  await mkdir(join(staged.agent, 'sessions'), { recursive: true, mode: 0o700 });
  suite.ledger.update(ledger => { (ledger.intercomDirectories ??= []).push(join(staged.agent, 'intercom')); });
  const env = { ...suite.env, ...core.env, HC_SESSION: core.namespace, HC_SOCKET: core.socket,
    HOME: core.env.HOME, PI_CODING_AGENT_DIR: staged.agent, PI_CODING_AGENT_SESSION_DIR: join(staged.agent, 'sessions'),
    SPIDER_GLOBAL_ROOT: root, SPIDER_ROAM_PI: suite.pi.launcher };
  return { machineId, alias, core, root, agent: staged.agent, cli: staged.cli, env };
}

async function configureMachine(suite: Suite, machine: Machine, role: 'hub' | 'box'): Promise<void> {
  for (const directory of [join(machine.root, 'roam'), join(machine.root, 'herdr')]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(machine.root, 'roam', 'machine.json'), JSON.stringify({ machineId: machine.machineId }), { mode: 0o600 });
  await writeFile(join(machine.root, 'roam', 'config.json'), JSON.stringify({ enabled: true, role, machineId: machine.machineId,
    hubMachineId: RELAY_ID, peers: [], discoveryRoots: [], coreUnit: 'fixture.service',
    intercom: { enabled: false, machineAlias: machine.alias } }), { mode: 0o600 });
  await writeFile(join(machine.root, 'herdr', 'config.json'), JSON.stringify({ app: { binary: join(suite.root, 'closed-app'), home: suite.directories.HERDR_APP_HOME },
    core: { binary: suite.cores!.wrapper, config: join(suite.root, 'core.toml') }, globalRoot: machine.root,
    agentDirectory: machine.agent, shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [] }), { mode: 0o600 });
  const db = openDb(join(machine.root, 'spider.db'));
  try {
    migrate(db, 'global', { machineId: machine.machineId, globalRoot: machine.root });
    db.prepare("UPDATE roam_meta SET store_key='global' WHERE id=1").run();
  } finally { db.close(); }
}

/** Set up private brokers and live v0 homes without starting the old federation. */
export async function relayFixture(suite: Suite, options: { secondRelay?: boolean } = {}): Promise<RelayFixture> {
  if (!suite.cores || process.platform !== 'linux') throw new HarnessError('missing-prerequisite', 'relay story needs owned Linux cores');
  const cores = suite.cores;
  const brokers: OwnedProcess[] = [], sessions: RpcDriver[] = [], logs: { path: string; evidence: string }[] = [];
  const services = new Map<0 | 1, OwnedProcess>();
  let relayStart: RelayStart | undefined, relayCount = 0, closed = false;
  const call = (core: Core, argv: readonly string[]) => runHc(cores.wrapper, argv,
    { ...core.env, HC_SESSION: core.namespace, HC_SOCKET: assertSocketPath(suite.root, core.socket) });
  const addRoute = async (core: Core, destination: Core, alias: string, via: string) => {
    checked(await call(core, ['machine', 'add', '--via', via, '--name', alias, '--session', destination.namespace, '--json']), `${core.side} route to ${alias}`);
  };
  const linkRoute = async (core: Core, destination: Core, alias: string, via: string) => {
    suite.ledger.update(ledger => { ledger.machines.push({ side: core.side, name: alias }); });
    await addRoute(core, destination, alias, via);
  };
  const close = async (): Promise<void> => {
    if (closed) return; closed = true;
    const errors: unknown[] = [];
    for (const service of [...services.values()].reverse()) try { await service.stop(); } catch (error) { errors.push(error); }
    for (const pi of sessions.splice(0).reverse()) try { await pi.close(); } catch (error) { errors.push(error); }
    for (const broker of brokers.splice(0).reverse()) try { await broker.stop(); } catch (error) { errors.push(error); }
    for (const log of logs) if (existsSync(log.path)) try { await suite.keepEvidence(log.path, log.evidence); } catch (error) { errors.push(error); }
    for (const [file, name] of [[cores.recordLog, 'R19-hc.jsonl'], [cores.viaLog, 'R19-via.jsonl']] as const)
      try { await suite.keepEvidence(file, name); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'relay fixture cleanup failed');
  };
  try {
    const third = await extraCore(suite, 'b', 'relay-target');
    const fourth = options.secondRelay ? await extraCore(suite, 'c', 'relay-backup') : undefined;
    const ownedCores = [cores.local, cores.dest, third, ...(fourth ? [fourth] : [])];
    if (new Set(ownedCores.map(core => core.coreId)).size !== ownedCores.length ||
        new Set(ownedCores.map(core => core.socket)).size !== ownedCores.length) throw new HarnessError('isolation-unproved', 'relay cores are not independent');
    const targetVia = await viaRoute(suite, third, 2);
    await linkRoute(cores.local, third, TARGET_ALIAS, targetVia);
    if (fourth) {
      await linkRoute(fourth, cores.dest, SENDER_ALIAS, await viaRoute(suite, cores.dest, 3));
      await linkRoute(fourth, third, TARGET_ALIAS, targetVia);
    }
    const relayMachine: Machine = { machineId: RELAY_ID, alias: RELAY_ALIAS, core: cores.local,
      root: suite.directories.SPIDER_GLOBAL_ROOT, agent: suite.directories.PI_CODING_AGENT_DIR, cli: suite.packed.roamCli,
      env: { ...suite.env, ...cores.local.env, HC_SESSION: cores.local.namespace, HC_SOCKET: cores.local.socket,
        SPIDER_GLOBAL_ROOT: suite.directories.SPIDER_GLOBAL_ROOT, PI_CODING_AGENT_DIR: suite.directories.PI_CODING_AGENT_DIR,
        SPIDER_ROAM_PI: suite.pi.launcher } };
    const senderMachine = await stageMachine(suite, cores.dest, SENDER_ID, SENDER_ALIAS, 'm1');
    const targetMachine = await stageMachine(suite, third, TARGET_ID, TARGET_ALIAS, 'm2');
    const backupMachine = fourth ? await stageMachine(suite, fourth, BACKUP_ID, BACKUP_ALIAS, 'm3') : undefined;
    const carriers = [relayMachine, ...(backupMachine ? [backupMachine] : [])];
    const sessionMachines = [senderMachine, targetMachine];
    const machines = [...carriers, ...sessionMachines];
    for (const machine of machines) await configureMachine(suite, machine, machine === relayMachine ? 'hub' : 'box');

    const peer = (machine: Machine) => ({ machineId: machine.machineId, alias: machine.alias, node: process.execPath,
      pi: suite.pi.launcher, cli: machine.cli, core: cores.wrapper, globalRoot: machine.root, agentDir: machine.agent });
    const relays = carriers.map(machine => machine.machineId);
    const carrierConfig = { version: 2, sendTo: sessionMachines.map(peer), acceptFrom: [], relays, linkTo: [SENDER_ID, TARGET_ID] };
    const configs = [
      ...carriers.map(() => carrierConfig),
      { version: 2, sendTo: [], acceptFrom: [{ machineId: TARGET_ID, alias: TARGET_ALIAS }], relays, linkTo: [] },
      { version: 2, sendTo: [], acceptFrom: [{ machineId: SENDER_ID, alias: SENDER_ALIAS }], relays, linkTo: [] },
    ];
    for (const [index, machine] of machines.entries())
      await writeFile(join(machine.root, 'roam', 'intercom-v0.json'), JSON.stringify(configs[index]), { mode: 0o600 });

    const senderList = await call(cores.dest, ['machine', 'ls', '--json']);
    const senderRows = checked(senderList, 'sender route list').machines;
    if (!Array.isArray(senderRows)) throw new HarnessError('isolation-unproved', 'sender machine list is malformed');
    expect(senderRows.filter(row => row?.name === TARGET_ALIAS || row?.id === third.coreId)).toEqual([]);
    const relayLists = [], identityReads = [];
    for (const carrier of carriers) {
      const listing = await call(carrier.core, ['machine', 'ls', '--json']);
      const rows = checked(listing, `${carrier.alias} route list`).machines;
      expect(rows).toHaveLength(2);
      relayLists.push({ alias: carrier.alias, listing });
      for (const machine of sessionMachines) {
        expect(rows).toContainEqual(expect.objectContaining({ name: machine.alias, id: machine.core.coreId }));
        const result = await call(carrier.core, ['exec', '--on', machine.alias, '--timeout', '15', '--', 'cat', '--', join(machine.root, 'roam', 'machine.json')]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.json).toEqual({ machineId: machine.machineId });
        identityReads.push({ relay: carrier.alias, alias: machine.alias, result });
      }
    }
    const routes = { relays: relayLists, sender: senderList, identityReads, configs };
    await suite.evidence('R19-routes.json', routes);

    const ids = [randomUUID() as SessionId, randomUUID() as SessionId];
    const homes: RunningHome[] = [];
    const hubDb = openDb(join(relayMachine.root, 'spider.db'));
    try {
      const store = createHomeStore({ db: hubDb, hubMachineId: RELAY_ID, localMachineId: RELAY_ID });
      for (const [index, machine] of sessionMachines.entries()) {
        const initial = await store.initialize(ids[index], RELAY_ID);
        const moving = { ...initial, state: 'moving', destination: machine.machineId, moveId: `v0-${randomUUID()}` as RelocateId, epoch: initial.epoch + 1 } as const;
        const running: RunningHome = { ...moving, state: 'running', machineId: machine.machineId, destination: null, epoch: moving.epoch + 1 };
        expect(await store.compareAndSwap(initial, moving)).toMatchObject({ kind: 'applied' });
        expect(await store.compareAndSwap(moving, running)).toEqual({ kind: 'applied', home: running });
        homes.push(running);
      }
    } finally { hubDb.close(); }
    for (const machine of machines.slice(1)) {
      const db = openDb(join(machine.root, 'spider.db'));
      try {
        const insert = db.prepare('INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,?,?,?,?,?)');
        for (const home of homes) insert.run(home.sessionId, home.machineId, home.epoch, home.moveId, home.updatedAt, home.state, home.destination);
      } finally { db.close(); }
    }
    const files: string[] = [], cwds: string[] = [], placements: SessionPlacement[] = [];
    for (const [index, machine] of sessionMachines.entries()) {
      const cwd = await suite.project(`relay-${index}`), file = suite.ownPath(join(machine.agent, 'sessions', `${ids[index]}.jsonl`));
      await writeFile(file, [
        { type: 'session', version: 3, id: ids[index], cwd, timestamp: '2026-01-01T00:00:00Z' },
        { type: 'message', id: 'seed', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'fixture history', timestamp: 1 } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      const placement: SessionPlacement = { sessionId: ids[index], machineId: machine.machineId, historyMachine: RELAY_ID,
        repoKey: randomUUID(), workspaceId: randomUUID(), repository: cwd, cwd, file, stores: ['global'] };
      const db = openDb(join(machine.root, 'spider.db'));
      try { writeLocal(db, 'relocate-managed', ids[index], placement); }
      finally { db.close(); }
      files.push(file); cwds.push(cwd); placements.push(placement);
    }
    await suite.evidence('R19-homes.json', { homes, placements });

    const endpoints: RelayEndpoint[] = [];
    for (const [index, machine] of sessionMachines.entries()) {
      const brokerLog = join(suite.root, `R19-broker-${index}.log`);
      logs.push({ path: brokerLog, evidence: `R19-broker-${index}.log` });
      const broker = spawnOwned(suite.ledger, { label: `R19-broker-${index}`, command: process.execPath,
        args: [suite.packed.intercomBroker], env: machine.env, cwd: suite.root, stdio: { log: brokerLog } });
      brokers.push(broker);
      await waitFor('owned private intercom broker', () => {
        if (broker.child.exitCode !== null || broker.child.signalCode !== null) throw new Error(`broker exited: ${brokerLog}`);
        try { return lstatSync(join(machine.agent, 'intercom', 'broker.sock')).isSocket(); } catch { return false; }
      }, Boolean, deadline(30_000));
      const driver = await suite.launchPi({ mode: 'rpc', cwd: cwds[index], args: ['--session', files[index], '--name', index === 0 ? 'relay-sender' : 'relay-target'],
        extraEnv: machine.env, label: `R19-pi-${index}` });
      if (driver.mode !== 'rpc') throw new Error('RPC driver required');
      sessions.push(driver);
      const started = await driver.waitEvent('session_start', () => true, deadline(30_000));
      expect(started.sessionId).toBe(ids[index]);
      expect(started.sessionFile).toBe(files[index]);
      endpoints.push({ id: ids[index], machineId: machine.machineId, alias: machine.alias, pi: driver, root: machine.root, agent: machine.agent, file: files[index] });
    }
    const live = [];
    for (const [index, endpoint] of endpoints.entries()) {
      const lookup = () => requestV0Broker(endpoint.agent, { kind: 'lookup', scopeId: null, selector: { by: 'id', value: endpoint.id } });
      const found = await waitFor(`live v0 endpoint ${endpoint.alias}`, lookup,
        value => value.kind === 'matches' && value.targets.length === 1 && value.targets[0].address.sessionId === endpoint.id &&
          value.targets[0].address.scopeId === null && value.targets[0].homeEpoch === homes[index].epoch && Boolean(value.targets[0].endpointEpoch), deadline(30_000));
      expect(found).toMatchObject({ kind: 'matches', targets: [{ address: { sessionId: endpoint.id, scopeId: null }, homeEpoch: homes[index].epoch, endpointEpoch: expect.any(String) }] });
      const otherScope = await requestV0Broker(endpoint.agent, { kind: 'lookup', scopeId: 'other-scope', selector: { by: 'id', value: endpoint.id } });
      expect(otherScope).toEqual({ kind: 'matches', targets: [] });
      live.push({ machine: endpoint.machineId, alias: endpoint.alias, found, otherScope });
    }
    await suite.evidence('R19-live-endpoints.json', live);
    const homeObservations = [];
    for (const machine of machines) {
      const db = openDb(join(machine.root, 'spider.db'), { fileMustExist: true });
      try {
        const store = createHomeStore({ db, hubMachineId: RELAY_ID, localMachineId: machine.machineId });
        const observed = await Promise.all(ids.map(id => store.read(id)));
        expect(observed).toEqual(homes);
        homeObservations.push({ machine: machine.machineId, alias: machine.alias, homes: observed });
      } finally { db.close(); }
    }
    await suite.evidence('R19-home-controls.json', { homes, homeObservations, placements });

    const doctor = async (): Promise<DoctorObservation> => {
      const result = await suite.invoke(process.execPath, [senderMachine.cli, 'roam', 'doctor', '--json'], senderMachine.env);
      let report: { value?: { diagnostics?: { reason: string }[] } };
      try { report = JSON.parse(result.stdout); } catch { throw new Error(`sender doctor did not return JSON: ${result.stdout} ${result.stderr}`); }
      if (!Array.isArray(report.value?.diagnostics)) throw new Error('sender doctor did not return value.diagnostics');
      return { result, diagnostics: report.value.diagnostics };
    };
    const startRelay: RelayFixture['startRelay'] = async index => {
      const carrier = carriers[index];
      if (!carrier || services.has(index)) throw new Error('only a configured, stopped relay can be started');
      const number = ++relayCount, log = join(suite.root, `R19-relay-${number}.log`);
      logs.push({ path: log, evidence: `R19-relay-${number}.log` });
      const relayProcess = spawnOwned(suite.ledger, { label: `R19-relay-${number}`, command: process.execPath,
        args: [carrier.cli, 'roam', 'agent', '--v0', 'relay'], env: carrier.env, cwd: suite.root, stdio: { log } });
      services.set(index, relayProcess);
      relayStart = await waitFor(`${carrier.alias} link is up`, async (): Promise<RelayStart | null> => {
        if (relayProcess.child.exitCode !== null || relayProcess.child.signalCode !== null) {
          const exit = await relayProcess.exited, text = await readFile(log, 'utf8');
          throw new Error(`relay exited before the link was up: ${JSON.stringify(exit)} ${text}`);
        }
        const observation = await doctor();
        const row = observation.diagnostics.find(item => typeof item.reason === 'string' && item.reason.startsWith(`intercom-link: ${carrier.alias} up;`));
        return row ? { kind: 'up', doctor: observation, reason: row.reason } : null;
      }, value => value !== null, deadline(30_000), { reconcileMs: 500 }) ?? undefined;
      await suite.evidence(`R19-relay-start-${number}.json`, relayStart!);
    };
    const stopRelay: RelayFixture['stopRelay'] = async index => {
      const service = services.get(index);
      if (!service) throw new Error('only a running relay can be stopped');
      await service.stop(); services.delete(index);
    };
    const waitForDown = async (): Promise<DoctorObservation> => {
      const down = await waitFor('relay link lease goes down', doctor,
        observation => observation.diagnostics.some(row => typeof row.reason === 'string' && row.reason.startsWith(`intercom-link: ${RELAY_ALIAS} down;`)),
        deadline(40_000), { reconcileMs: 1_000 });
      await suite.evidence(`R19-relay-down-${relayCount}.json`, down);
      return down;
    };
    const withoutBackupTargetRoute = async <T>(run: () => Promise<T>): Promise<T> => {
      if (!fourth) throw new Error('the backup relay is not configured');
      const status = checked(await call(fourth, ['server', 'status', '--json']), 'backup core before removing its route');
      if (status.pid !== fourth.pid || (status.core as { id?: unknown } | undefined)?.id !== fourth.coreId)
        throw new HarnessError('isolation-unproved', 'backup core identity changed');
      const removal = await call(fourth, ['machine', 'rm', TARGET_ALIAS, '--json']);
      if (removal.exitCode !== 0) throw new HarnessError('hc-failed', 'could not remove the owned backup-to-target route', removal);
      try {
        await suite.evidence('R19-backup-route-removed.json', removal);
        return await run();
      } finally {
        await addRoute(fourth, third, TARGET_ALIAS, targetVia);
      }
    };
    return { sender: endpoints[0], target: endpoints[1], controls: { routes, homes, homeObservations, endpoints: live },
      get relayStart() { return relayStart; }, startRelay, stopRelay, waitForDown, withoutBackupTargetRoute, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'relay fixture setup and cleanup failed'); }
    throw error;
  }
}
