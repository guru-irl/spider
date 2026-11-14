// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { parseReadiness } from '@spider/db-core/roam/readiness';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { migrate, openDb } from '@spider/db-core';
import { createHcClient } from '../../src/client/hc.js';
import { HERDR_LABELS, type SpaceId, type TabId, type TerminalAddress } from '../../src/contracts.js';
import { claimIdLock } from '../../src/sessions/id-lock.js';
import { mapWorkspace } from '@spider/db-core/roam/repo-map';
import { createParticipantAdmission } from '../../../host/src/roam/readiness.js';
import { createRunningIntentAuthority } from '@spider/roam/session-control';
import { handleSessionOperation } from '@spider/roam/participant-runtime';
import { openJournal } from '@spider/roam/journal';
import { createIntentStore } from '@spider/roam/intent';
import { readLocal } from '@spider/db-core/roam/local-state';
import { createLocalDiagnosticPorts } from '@spider/roam/local-diagnostics';
import { readLocalIdentity } from '@spider/roam/runtime';
import { rememberRoamSlot } from '../../src/roam-placement.js';
import { spawnOwned } from '../harness/processes.js';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

const HUB = '00000000-0000-4000-8000-000000000001';
const BOX = '00000000-0000-4000-8000-000000000002';

async function configureStore(root: string, machineId: string, role: 'hub' | 'box', peers: readonly object[], enabled = false): Promise<void> {
  await mkdir(join(root, 'roam'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'roam/machine.json'), JSON.stringify({ machineId }), { mode: 0o600 });
  await writeFile(join(root, 'roam/config.json'), JSON.stringify({ enabled, role, machineId, hubMachineId: HUB,
    peers, discoveryRoots: [], coreUnit: 'fixture' }), { mode: 0o600 });
  const db = openDb(join(root, 'spider.db'));
  try {
    migrate(db, 'global', { machineId, globalRoot: root });
    if (enabled) db.prepare("UPDATE roam_meta SET store_key='global',capture_enabled=1 WHERE id=1").run();
  } finally { db.close(); }
}

/** The CLI bytes are from the npm pack; only the release build identity is a fixture. */
async function releaseCli(suite: Suite): Promise<string> {
  const root = join(suite.root, 'release'), roam = join(root, 'roam');
  await mkdir(roam, { recursive: true });
  const cli = join(roam, 'cli.mjs');
  await copyFile(suite.packed.roamCli, cli);
  await writeFile(join(root, 'extension.js'), '// SPIDER_BUILD_ID=abcdef1@2026-01-01T00:00:00.000Z v1.2.3\n');
  return cli;
}

async function twoCoreSync(suite: Suite): Promise<void> {
  const cores = suite.cores;
  if (!cores) throw new Error('R01 requires the two isolated fixture cores');
  const hub = suite.directories.SPIDER_GLOBAL_ROOT, box = suite.ownPath(join(suite.root, 'box-global'));
  const cli = await releaseCli(suite), bootstrap = suite.ownPath(join(suite.root, 'bootstrap'));
  const peer = { machineId: BOX, alias: cores.machine, node: process.execPath, pi: process.execPath,
    cli, core: cores.wrapper, globalRoot: box };
  await configureStore(hub, HUB, 'hub', [peer]);
  await configureStore(box, BOX, 'box', []);
  await mkdir(join(hub, 'herdr'), { recursive: true, mode: 0o700 });
  await writeFile(join(hub, 'herdr/config.json'), JSON.stringify({ app: { binary: join(suite.root, 'unused-app'), home: suite.directories.HERDR_APP_HOME },
    core: { binary: cores.wrapper, config: join(suite.root, 'core.toml') }, agentDirectory: suite.directories.PI_CODING_AGENT_DIR,
    globalRoot: hub, shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [] }), { mode: 0o600 });
  const sqlite = suite.ownPath(join(suite.root, 'bin/sqlite3'));
  await writeFile(sqlite, `#!${process.execPath}\nconsole.log('3.45.0');\n`, { mode: 0o700 });
  const launchctl = suite.ownPath(join(suite.root, 'bin/launchctl-fixture'));
  await writeFile(launchctl, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; if(process.argv[2]==='bootstrap') writeFileSync(${JSON.stringify(bootstrap)},'requested');\n`, { mode: 0o700 });
  const env = { ...cores.local.env, HC_SOCKET: cores.local.socket, SPIDER_GLOBAL_ROOT: hub, SPIDER_TEST_ROAM_LAUNCHCTL: launchctl };
  const enable = suite.invoke(process.execPath, [cli, 'roam', 'enable'], env);
  let early: string | undefined;
  void enable.then(result => { early = `${result.exitCode} ${result.stderr}`; }, error => { early = String(error); });
  await waitFor('fixture service bootstrap requested', () => {
    if (early) throw new Error(`enable returned before bootstrap: ${early}`);
    return existsSync(bootstrap);
  }, Boolean, deadline(60_000), { reconcileMs: 25 });
  const service = spawnOwned(suite.ledger, { label: 'roam-hub', startsCores: true, command: process.execPath,
    args: [cli, 'roam', 'hub'], env, cwd: suite.root, stdio: { log: join(suite.root, 'logs/roam-hub.log') } });
  try {
    const enabled = await enable;
    expect(enabled.exitCode, enabled.stderr + enabled.stdout).toBe(0);
    const initial = await suite.invoke(process.execPath, [cli, 'roam', 'sync', cores.machine], env);
    expect(initial.exitCode, initial.stderr + initial.stdout).toBe(0);
    const db = openDb(join(hub, 'spider.db'));
    try {
      db.prepare('INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?,?,?,?,?)')
        .run('session-r01', HUB, 1, null, 1);
    } finally { db.close(); }
    const sync = await suite.invoke(process.execPath, [cli, 'roam', 'sync', cores.machine], env);
    expect(sync.exitCode, sync.stderr + sync.stdout).toBe(0);
    const hubDb = openDb(join(hub, 'spider.db'));
    try {
      const peerDb = openDb(join(box, 'spider.db'));
      try {
        const hubHome = hubDb.prepare('SELECT machine_id,epoch FROM session_homes WHERE session_id=?').get('session-r01');
        const boxHome = peerDb.prepare('SELECT machine_id,epoch FROM session_homes WHERE session_id=?').get('session-r01');
        expect(hubHome).toEqual({ machine_id: HUB, epoch: 1 });
        expect(peerDb.prepare('SELECT capture_enabled FROM roam_meta').get()).toEqual({ capture_enabled: 1 });
        expect(boxHome).toEqual(hubHome);
      } finally { peerDb.close(); }
    } finally { hubDb.close(); }
    await suite.evidence('R01-sync.json', { boundary: 'packed CLI and two isolated fixture cores',
      releaseIdentity: 'synthetic fixture', enabled: enabled.stdout, sync: sync.stdout });
  } finally { await service.stop(); }
}

async function closedAppPlacement(suite: Suite): Promise<void> {
  const cores = suite.cores;
  if (!cores) throw new Error('R02 requires the two isolated fixture cores');
  const remote = await suite.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--json', '--', '/bin/cat'], 'dest');
  expect(remote.exitCode, remote.stderr).toBe(0);
  const terminal = (remote.json as { address: string }).address;
  expect(terminal).toBeTruthy();
  suite.ledger.update(ledger => { ledger.terminals.push({ side: 'dest', address: terminal }); });
  const hc = createHcClient({ binary: cores.wrapper, env: cores.local.env });
  const hub = suite.directories.SPIDER_GLOBAL_ROOT, box = suite.ownPath(join(suite.root, 'box-global'));
  const root = suite.ownPath(join(hub, 'roam', 'placement')), workspace = suite.ownPath(join(suite.root, 'workspace'));
  const address = `${cores.machine}/${terminal}`, sessionId = 'session-r02', file = join(workspace, 'session.jsonl');
  const cli = await releaseCli(suite), peer = { machineId: BOX, alias: cores.machine, node: process.execPath, pi: process.execPath, cli, core: cores.wrapper, globalRoot: box };
  await configureStore(hub, HUB, 'hub', [peer], true); await configureStore(box, BOX, 'box', [], true);
  await writeFile(join(box, 'roam/config.json'), JSON.stringify({ ...readLocalIdentity(box), enabled: false }), { mode: 0o600 });
  for (const globalRoot of [hub, box]) {
    await mkdir(join(globalRoot, 'herdr'), { recursive: true, mode: 0o700 });
    await writeFile(join(globalRoot, 'herdr/config.json'), JSON.stringify({ app: { binary: join(suite.root, 'closed-app'), home: suite.directories.HERDR_APP_HOME },
      core: { binary: cores.wrapper, config: join(suite.root, 'core.toml') }, agentDirectory: suite.directories.PI_CODING_AGENT_DIR,
      globalRoot, shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [] }), { mode: 0o600 });
  }
  await mkdir(join(workspace, '.spider'), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: workspace }) + '\n', { mode: 0o600 });
  const boxDb = openDb(join(box, 'spider.db')), worktree = openDb(join(workspace, '.spider/project.db'));
  migrate(worktree, 'worktree', { machineId: BOX, globalRoot: box });
  const repoKey = '00000000-0000-4000-8000-000000000003', workspaceId = '00000000-0000-4000-8000-000000000004';
  await mapWorkspace(boxDb, { repoKey, workspaceId, path: workspace });
  const authority = createRunningIntentAuthority(boxDb), journal = openJournal(join(box, 'roam/journal.db'));
  const admission = createParticipantAdmission({ cwd: () => workspace,
    async open() { return { db: boxDb, config: readLocalIdentity(box), journal, authority,
      async stores() { return [{ db: worktree, key: `worktree:${repoKey}:${workspaceId}` as const }]; }, close() {} }; },
    async terminal() {
      const observed = await createLocalDiagnosticPorts(box, []).probeProcess({ machineId: BOX, label: 'fixture owner', peer: null }, process.pid);
      if (observed.kind !== 'live') throw new Error('Fixture owner identity unavailable');
      return { core: cores.dest.coreId, terminal, operationId: null, owner: { pid: process.pid, startIdentity: observed.startIdentity } };
    } });
  const probe = createLocalDiagnosticPorts(box, []).probeProcess;
  const processIdentity = await probe({ machineId: BOX, label: 'fixture owner', peer: null }, process.pid);
  if (processIdentity.kind !== 'live') throw new Error('Fixture owner identity unavailable');
  const lock = await claimIdLock(join(box, 'herdr'), sessionId, { pid: process.pid, startIdentity: processIdentity.startIdentity },
    pid => probe({ machineId: BOX, label: 'fixture owner', peer: null }, pid), { bootId: async () => 'r02-fixture-boot' });
  const bootFile = suite.ownPath(join(box, 'roam', 'fixture-boot-id')); await writeFile(bootFile, 'r02-fixture-boot', { mode: 0o600 });
  await admission.prepare!(sessionId, file); await admission.ready!(sessionId, file, 1, null);
  const readiness = parseReadiness(readLocal(boxDb, 'participant-ready', sessionId));
  expect(readiness).toMatchObject({ origin: 'box-local', machineId: BOX });
  expect(readiness).not.toHaveProperty('opId');
  const env = { ...cores.local.env, HC_SOCKET: cores.local.socket, SPIDER_GLOBAL_ROOT: hub };
  const service = spawnOwned(suite.ledger, { label: 'roam-hub', startsCores: true, command: process.execPath,
    args: [cli, 'roam', 'hub'], env, cwd: suite.root, stdio: { log: join(suite.root, 'logs/roam-hub.log') } });
  try {
    await waitFor('packed hub socket', async () => {
      if (service.child.exitCode !== null) throw new Error(await readFile(join(suite.root, 'logs/roam-hub.log'), 'utf8'));
      return existsSync(join(hub, 'roam/hub.sock'));
    }, Boolean, deadline(20_000));
    const sync = async () => { const result = await suite.invoke(process.execPath, [cli, 'roam', 'sync', cores.machine], env); expect(result.exitCode, result.stderr + result.stdout).toBe(0); };
    await sync();
    const queueDb = openDb(join(hub, 'spider.db'));
    try { expect(readLocal(queueDb, 'hub-placement', BOX)).toEqual([{ ...readiness, terminal: address }]); } finally { queueDb.close(); }
    expect(JSON.parse(await readFile(join(root, 'roam-placement.json'), 'utf8')).attempts).toEqual([]);
    await rememberRoamSlot(root, sessionId, { space: 'fixture-space' as SpaceId, tab: 'fixture-tab' as TabId });
    await sync();
    const observedHosting = await suite.invoke(process.execPath, [cli, 'roam', 'observe', 'hosting'], { ...cores.dest.env, SPIDER_GLOBAL_ROOT: box, SPIDER_TEST_ROAM_BOOT_ID: bootFile });
    await suite.evidence('R02-hosting.json', observedHosting);
    expect(observedHosting.exitCode, observedHosting.stderr + observedHosting.stdout).toBe(0);
    expect(JSON.parse(observedHosting.stdout).value.readiness).toEqual([readiness]);
    const hubStatus = await suite.invoke(process.execPath, [cli, 'roam', 'status'], env);
    await suite.evidence('R02-hub-status.json', hubStatus);
    const state = await waitFor('packed observer places exactly one proxy', async () => JSON.parse(await readFile(join(root, 'roam-placement.json'), 'utf8')) as { attempts: Array<{ proxy: string | null }> },
      value => value.attempts.some(row => Boolean(row.proxy)), deadline(20_000));
    expect(state.attempts).toHaveLength(1);
    const proxy = state.attempts[0].proxy as TerminalAddress;
    expect(proxy).toBeTruthy();
    suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address: proxy }); });
    const observed = await hc.get(proxy);
    expect(observed.labels).toMatchObject({ [HERDR_LABELS.kind]: 'roam-proxy', [HERDR_LABELS.session]: sessionId,
      [HERDR_LABELS.ownerTerminal]: address, [HERDR_LABELS.ownerCore]: cores.dest.coreId,
      [HERDR_LABELS.space]: 'fixture-space', [HERDR_LABELS.tab]: 'fixture-tab' });
    const marker = 'r02-live-attach-proof';
    const sent = await suite.hc(['send', '--json', '--force', terminal, marker], 'dest');
    expect(sent.exitCode, sent.stderr).toBe(0);
    const screen = await waitFor('live proxy receives remote output after placement', async () => {
      const current = await hc.get(proxy);
      if (current.state !== 'live') throw new Error('Proxy attach exited before receiving remote output');
      return hc.read(proxy, { lines: 100 });
    }, text => text.includes(marker), deadline(5000), { reconcileMs: 50 });
    expect(screen).toContain(marker);
    expect((await hc.get(proxy)).state).toBe('live');
    await sync();
    expect(JSON.parse(await readFile(join(root, 'roam-placement.json'), 'utf8')).attempts).toHaveLength(1);
    const records = await cores.records();
    const proxies = records.filter(record => record.argv[0] === 'run' && record.argv.some(arg => arg.includes('roam-proxy')));
    expect(proxies).toHaveLength(1);
    expect(proxies[0].argv).not.toContain('--focus');
    const started = await handleSessionOperation({ id: 'r02-hub-start', kind: 'session-start', machineId: BOX, expectedEpoch: 1, args: { sourceMachine: HUB, sessionId } },
      { config: readLocalIdentity(box), journal, root: join(box, 'roam/staging'), openStore(key) { return { db: key === 'global' ? boxDb : worktree, effects: {} as never, policy: {} as never }; } }, { wake: async () => {} });
    expect(started).toMatchObject({ code: 3, reason: 'readiness-pending', value: null });
    expect(readLocal(boxDb, 'participant-ready', sessionId)).toEqual(readiness);
    const intent = await authority.get(sessionId); if (!intent) throw new Error('Admitted authority missing');
    const intents = createIntentStore(box);
    expect(await intents.update(sessionId, null, { intent: { ...intent, suspended: 'fixture suspension' }, failures: [], supervision: { kind: 'idle', nextAttemptAt: null } })).toMatchObject({ kind: 'updated' });
    await sync();
    const status = await suite.invoke(process.execPath, [cli, 'roam', 'status'], env);
    expect(status.stdout).toContain(`Suspended ${sessionId}`);
    const hubDb = openDb(join(hub, 'spider.db'));
    try {
      expect(readLocal(hubDb, 'hub-placement', BOX)).toBeUndefined();
      expect(readLocal<{ suspensions: unknown[] }>(hubDb, 'hub-peer', BOX)?.suspensions).toEqual([expect.objectContaining({ sessionId, epoch: 1 })]);
    } finally { hubDb.close(); }
    await suite.evidence('R02-scope.json', { boundary: 'host admission -> packaged box observer -> packaged hub -> one closed-app proxy',
      owner: 'fixture process identity and live fixture terminal; no production participant', readiness, proxy, labels: observed.labels, marker, screen, suspension: status.stdout });
  } finally { await service.stop(); await suite.keepEvidence(join(suite.root, 'logs/roam-hub.log')); await suite.keepEvidence(cores.recordLog); await lock.release(); worktree.close(); boxDb.close(); await hc.dispose(); }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R01'), title: 'two isolated cores sync capture and session home through the packed CLI', tiers: ['headless'], run: twoCoreSync },
  { id: storyId('R02'), title: 'admitted box readiness reaches packaged hub and places one no-focus proxy in the remembered slot', tiers: ['headless'], run: closedAppPlacement },
];
registerScenarios(scenarios);
