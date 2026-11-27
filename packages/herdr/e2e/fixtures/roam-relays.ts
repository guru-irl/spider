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
const RELAY_ALIAS = 'relay-1.invalid';
const SENDER_ALIAS = 'dest.invalid';
const TARGET_ALIAS = 'target.invalid';
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

interface Core { side: string; namespace: string; socket: string; env: Record<string, string>; coreId: string; pid: number }
interface Machine { machineId: string; alias: string; core: Core; root: string; agent: string; cli: string; env: Record<string, string> }
export interface RelayEndpoint { id: string; machineId: string; alias: string; pi: RpcDriver; root: string; agent: string; file: string }
interface DoctorObservation { result: InvokeResult; diagnostics: { reason: string }[] }
type RelayStart = { kind: 'up'; doctor: DoctorObservation; reason: string }
  | { kind: 'unsupported'; exitCode: 2; reply: unknown; log: string };
export interface RelayFixture {
  sender: RelayEndpoint;
  target: RelayEndpoint;
  controls: { routes: object; homes: readonly RunningHome[]; homeObservations: object; endpoints: object };
  readonly relayStart: RelayStart | undefined;
  startRelay(index: 0 | 1): Promise<void>;
  stopRelay(index: 0 | 1): Promise<void>;
  waitForDown(): Promise<DoctorObservation>;
  close(): Promise<void>;
}

function checked(result: HcResult, what: string): Record<string, unknown> {
  if (result.exitCode !== 0 || !result.json || typeof result.json !== 'object' || Array.isArray(result.json)) {
    throw new HarnessError('hc-failed', `${what}: exit ${result.exitCode} ${result.stderr}`, result);
  }
  return result.json as Record<string, unknown>;
}

/** A third core has no route to either other core. Only the relay dials it. */
async function targetCore(suite: Suite): Promise<Core> {
  const cores = suite.cores!;
  const namespace = 'b', side = 'relay-target';
  const env: Record<string, string> = { ...cores.dest.env, HC_SESSION: namespace, HOME: suite.ownPath(join(suite.root, 'hb')),
    TMPDIR: suite.ownPath(join(suite.root, 'tb')), XDG_CONFIG_HOME: suite.ownPath(join(suite.root, 'cb')) };
  for (const key of ['HC_SOCKET', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'XDG_RUNTIME_DIR']) delete env[key];
  for (const dir of [env.HOME, env.TMPDIR, join(env.XDG_CONFIG_HOME, 'herdr-core')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core', 'config.toml'), 'notes = false\n', { mode: 0o600 });
  const socket = assertSocketPath(suite.root, join(env.XDG_STATE_HOME, 'herdr-core', namespace, `${namespace}.sock`));
  suite.ledger.update(ledger => { ledger.cores.push({ side, namespace, socket, hcBinary: realHcBinary(), env }); });
  const call = (args: readonly string[]) => runHc(cores.wrapper, args, env);
  checked(await call(['server', 'start', '--json']), 'target core start');
  const status = checked(await call(['server', 'status', '--json']), 'target core status');
  const core = status.core as { id?: unknown } | undefined;
  if (status.version !== '0.1.16' || typeof status.pid !== 'number' || typeof core?.id !== 'string' || !lstatSync(socket).isSocket()) {
    throw new HarnessError('isolation-unproved', 'target core is not an owned hc 0.1.16 core', status);
  }
  const identity = identityOf(status.pid);
  suite.ledger.update(ledger => {
    const entry = ledger.cores.find(item => item.side === side)!;
    entry.coreId = core.id as string; entry.pid = identity.pid; entry.start = identity.start;
  });
  return { side, namespace, socket, env, coreId: core.id, pid: status.pid };
}

async function addTargetRoute(suite: Suite, target: Core): Promise<void> {
  const cores = suite.cores!;
  const descriptor = suite.ownPath(join(suite.root, 'via-i2.json'));
  const via = suite.ownPath(join(suite.root, 'bin', 'via-i2'));
  await writeFile(descriptor, JSON.stringify({ root: suite.root, env: target.env, log: cores.viaLog,
    ledgerPath: suite.ledger.path, socket: target.socket, viaDirectory: join(suite.root, 'via-processes') }), { mode: 0o600 });
  const program = fileURLToPath(new URL('./via.mjs', import.meta.url));
  await writeFile(via, `#!/bin/sh\nexec 9<"$0"\nexec ${quote(process.execPath)} ${quote(program)} ${quote(descriptor)} "$@"\n`, { mode: 0o700 });
  suite.ledger.update(ledger => { ledger.machines.push({ side: 'local', name: TARGET_ALIAS }); });
  checked(await cores.hc(['machine', 'add', '--via', via, '--name', TARGET_ALIAS, '--session', target.namespace, '--json']), 'relay target route');
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
  if (options.secondRelay) throw new HarnessError('missing-prerequisite', 'this fixture has one relay');
  const cores = suite.cores;
  const brokers: OwnedProcess[] = [], sessions: RpcDriver[] = [], logs: { path: string; evidence: string }[] = [];
  let relay: OwnedProcess | undefined, relayStart: RelayStart | undefined, relayCount = 0, closed = false;
  const close = async (): Promise<void> => {
    if (closed) return; closed = true;
    const errors: unknown[] = [];
    if (relay) try { await relay.stop(); } catch (error) { errors.push(error); }
    for (const pi of sessions.splice(0).reverse()) try { await pi.close(); } catch (error) { errors.push(error); }
    for (const broker of brokers.splice(0).reverse()) try { await broker.stop(); } catch (error) { errors.push(error); }
    for (const log of logs) if (existsSync(log.path)) try { await suite.keepEvidence(log.path, log.evidence); } catch (error) { errors.push(error); }
    for (const [file, name] of [[cores.recordLog, 'R19-hc.jsonl'], [cores.viaLog, 'R19-via.jsonl']] as const)
      try { await suite.keepEvidence(file, name); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'relay fixture cleanup failed');
  };
  try {
    const third = await targetCore(suite);
    if (new Set([cores.local.coreId, cores.dest.coreId, third.coreId]).size !== 3 ||
        new Set([cores.local.socket, cores.dest.socket, third.socket]).size !== 3) throw new HarnessError('isolation-unproved', 'relay cores are not independent');
    await addTargetRoute(suite, third);
    const relayMachine: Machine = { machineId: RELAY_ID, alias: RELAY_ALIAS, core: cores.local,
      root: suite.directories.SPIDER_GLOBAL_ROOT, agent: suite.directories.PI_CODING_AGENT_DIR, cli: suite.packed.roamCli,
      env: { ...suite.env, ...cores.local.env, HC_SESSION: cores.local.namespace, HC_SOCKET: cores.local.socket,
        SPIDER_GLOBAL_ROOT: suite.directories.SPIDER_GLOBAL_ROOT, PI_CODING_AGENT_DIR: suite.directories.PI_CODING_AGENT_DIR,
        SPIDER_ROAM_PI: suite.pi.launcher } };
    const senderMachine = await stageMachine(suite, cores.dest, SENDER_ID, SENDER_ALIAS, 'm1');
    const targetMachine = await stageMachine(suite, third, TARGET_ID, TARGET_ALIAS, 'm2');
    for (const [machine, role] of [[relayMachine, 'hub'], [senderMachine, 'box'], [targetMachine, 'box']] as const)
      await configureMachine(suite, machine, role);

    const peer = (machine: Machine) => ({ machineId: machine.machineId, alias: machine.alias, node: process.execPath,
      pi: suite.pi.launcher, cli: machine.cli, core: cores.wrapper, globalRoot: machine.root, agentDir: machine.agent });
    const configs = [
      { version: 2, sendTo: [peer(senderMachine), peer(targetMachine)], acceptFrom: [], relays: [RELAY_ID], linkTo: [SENDER_ID, TARGET_ID] },
      { version: 2, sendTo: [], acceptFrom: [{ machineId: TARGET_ID, alias: TARGET_ALIAS }], relays: [RELAY_ID], linkTo: [] },
      { version: 2, sendTo: [], acceptFrom: [{ machineId: SENDER_ID, alias: SENDER_ALIAS }], relays: [RELAY_ID], linkTo: [] },
    ];
    for (const [index, machine] of [relayMachine, senderMachine, targetMachine].entries())
      await writeFile(join(machine.root, 'roam', 'intercom-v0.json'), JSON.stringify(configs[index]), { mode: 0o600 });

    const relayList = await cores.hc(['machine', 'ls', '--json']);
    const senderList = await runHc(cores.wrapper, ['machine', 'ls', '--json'], senderMachine.core.env);
    const relayRows = checked(relayList, 'relay route list').machines;
    const senderRows = checked(senderList, 'sender route list').machines;
    if (!Array.isArray(relayRows) || !Array.isArray(senderRows)) throw new HarnessError('isolation-unproved', 'machine lists are malformed');
    expect(relayRows).toContainEqual(expect.objectContaining({ name: SENDER_ALIAS, id: cores.dest.coreId }));
    expect(relayRows).toContainEqual(expect.objectContaining({ name: TARGET_ALIAS, id: third.coreId }));
    expect(senderRows.filter(row => row?.name === TARGET_ALIAS || row?.id === third.coreId)).toEqual([]);
    const identityReads = [];
    for (const machine of [senderMachine, targetMachine]) {
      const result = await cores.hc(['exec', '--on', machine.alias, '--timeout', '15', '--', 'cat', '--', join(machine.root, 'roam', 'machine.json')]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.json).toEqual({ machineId: machine.machineId });
      identityReads.push({ alias: machine.alias, result });
    }
    const routes = { relay: relayList, sender: senderList, identityReads, configs };
    await suite.evidence('R19-routes.json', routes);

    const ids = [randomUUID() as SessionId, randomUUID() as SessionId];
    const homes: RunningHome[] = [];
    const hubDb = openDb(join(relayMachine.root, 'spider.db'));
    try {
      const store = createHomeStore({ db: hubDb, hubMachineId: RELAY_ID, localMachineId: RELAY_ID });
      for (const [index, machine] of [senderMachine, targetMachine].entries()) {
        const initial = await store.initialize(ids[index], RELAY_ID);
        const moving = { ...initial, state: 'moving', destination: machine.machineId, moveId: `v0-${randomUUID()}` as RelocateId, epoch: initial.epoch + 1 } as const;
        const running: RunningHome = { ...moving, state: 'running', machineId: machine.machineId, destination: null, epoch: moving.epoch + 1 };
        expect(await store.compareAndSwap(initial, moving)).toMatchObject({ kind: 'applied' });
        expect(await store.compareAndSwap(moving, running)).toEqual({ kind: 'applied', home: running });
        homes.push(running);
      }
    } finally { hubDb.close(); }
    const files: string[] = [], cwds: string[] = [], placements: SessionPlacement[] = [];
    for (const [index, machine] of [senderMachine, targetMachine].entries()) {
      const cwd = await suite.project(`relay-${index}`), file = suite.ownPath(join(machine.agent, 'sessions', `${ids[index]}.jsonl`));
      await writeFile(file, [
        { type: 'session', version: 3, id: ids[index], cwd, timestamp: '2026-01-01T00:00:00Z' },
        { type: 'message', id: 'seed', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'fixture history', timestamp: 1 } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      const placement: SessionPlacement = { sessionId: ids[index], machineId: machine.machineId, historyMachine: RELAY_ID,
        repoKey: randomUUID(), workspaceId: randomUUID(), repository: cwd, cwd, file, stores: ['global'] };
      const db = openDb(join(machine.root, 'spider.db'));
      try {
        for (const home of homes) db.prepare('INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,?,?,?,?,?)')
          .run(home.sessionId, home.machineId, home.epoch, home.moveId, home.updatedAt, home.state, home.destination);
        writeLocal(db, 'relocate-managed', ids[index], placement);
      } finally { db.close(); }
      files.push(file); cwds.push(cwd); placements.push(placement);
    }
    await suite.evidence('R19-homes.json', { homes, placements });

    const endpoints: RelayEndpoint[] = [];
    for (const [index, machine] of [senderMachine, targetMachine].entries()) {
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
    for (const machine of [relayMachine, senderMachine, targetMachine]) {
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
      if (index !== 0 || relay) throw new Error('only the first stopped relay can be started');
      const number = ++relayCount, log = join(suite.root, `R19-relay-${number}.log`);
      logs.push({ path: log, evidence: `R19-relay-${number}.log` });
      relay = spawnOwned(suite.ledger, { label: `R19-relay-${number}`, command: process.execPath,
        args: [relayMachine.cli, 'roam', 'agent', '--v0', 'relay'], env: relayMachine.env, cwd: suite.root, stdio: { log } });
      const relayProcess = relay;
      relayStart = await waitFor('relay link is up or the base rejects the private command', async (): Promise<RelayStart | null> => {
        if (relayProcess.child.exitCode !== null || relayProcess.child.signalCode !== null) {
          const exit = await relayProcess.exited, text = await readFile(log, 'utf8');
          let reply: { ok?: unknown; refusal?: { code?: unknown } };
          try { reply = JSON.parse(text); } catch { throw new Error(`relay exited without a private-command response: ${text}`); }
          if (exit.code !== 2 || exit.signal !== null || reply.ok !== false || reply.refusal?.code !== 'invalid-arguments') {
            throw new Error(`relay exited unexpectedly: ${JSON.stringify({ exit, reply })}`);
          }
          return { kind: 'unsupported', exitCode: 2, reply, log: text };
        }
        const observation = await doctor();
        const row = observation.diagnostics.find(item => typeof item.reason === 'string' && item.reason.startsWith(`intercom-link: ${RELAY_ALIAS} up;`));
        return row ? { kind: 'up', doctor: observation, reason: row.reason } : null;
      }, value => value !== null, deadline(30_000), { reconcileMs: 500 }) ?? undefined;
      await suite.evidence(`R19-relay-start-${number}.json`, relayStart!);
    };
    const stopRelay: RelayFixture['stopRelay'] = async index => {
      if (index !== 0 || !relay) throw new Error('only the running first relay can be stopped');
      await relay.stop(); relay = undefined;
    };
    const waitForDown = async (): Promise<DoctorObservation> => {
      const down = await waitFor('relay link lease goes down', doctor,
        observation => observation.diagnostics.some(row => typeof row.reason === 'string' && row.reason.startsWith(`intercom-link: ${RELAY_ALIAS} down;`)),
        deadline(40_000), { reconcileMs: 1_000 });
      await suite.evidence('R19-relay-down.json', down);
      return down;
    };
    return { sender: endpoints[0], target: endpoints[1], controls: { routes, homes, homeObservations, endpoints: live },
      get relayStart() { return relayStart; }, startRelay, stopRelay, waitForDown, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'relay fixture setup and cleanup failed'); }
    throw error;
  }
}
