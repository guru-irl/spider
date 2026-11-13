// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { migrate, openDb } from '@spider/db-core';
import { createHcClient } from '../../src/client/hc.js';
import { HERDR_LABELS, type SpaceId, type TabId, type TerminalAddress } from '../../src/contracts.js';
import { createTerminalRegistry } from '../../src/sessions/registry.js';
import { createRoamPlacement, rememberRoamSlot } from '../../src/roam-placement.js';
import { spawnOwned } from '../harness/processes.js';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

const HUB = '00000000-0000-4000-8000-000000000001';
const BOX = '00000000-0000-4000-8000-000000000002';

async function configureStore(root: string, machineId: string, role: 'hub' | 'box', peers: readonly object[]): Promise<void> {
  await mkdir(join(root, 'roam'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'roam/machine.json'), JSON.stringify({ machineId }), { mode: 0o600 });
  await writeFile(join(root, 'roam/config.json'), JSON.stringify({ enabled: false, role, machineId, hubMachineId: HUB,
    peers, discoveryRoots: [], coreUnit: 'fixture' }), { mode: 0o600 });
  const db = openDb(join(root, 'spider.db'));
  try { migrate(db, 'global', { machineId, globalRoot: root }); } finally { db.close(); }
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
    const peerDb = openDb(join(box, 'spider.db'));
    try {
      expect(peerDb.prepare('SELECT capture_enabled FROM roam_meta').get()).toEqual({ capture_enabled: 1 });
      expect(peerDb.prepare('SELECT machine_id,epoch FROM session_homes WHERE session_id=?').get('session-r01'))
        .toEqual({ machine_id: HUB, epoch: 1 });
    } finally { peerDb.close(); }
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
  const root = suite.ownPath(join(suite.root, 'placement'));
  const registry = createTerminalRegistry(root);
  const placement = createRoamPlacement({ app: null, hc, registry, hcBinary: cores.wrapper, stateRoot: root });
  const address = `${cores.machine}/${terminal}`;
  const readiness = { operationId: 'fixture-operation', sessionId: 'session-r02', epoch: 1,
    cwd: suite.root, file: join(suite.root, 'session.jsonl'), core: cores.dest.coreId, terminal: address };
  try {
    expect(await placement.reconcile([readiness])).toEqual({ pending: [address] });
    await rememberRoamSlot(root, readiness.sessionId, { space: 'fixture-space' as SpaceId, tab: 'fixture-tab' as TabId });
    expect(await placement.reconcile([readiness])).toEqual({ pending: [] });
    const state = JSON.parse(await readFile(join(root, 'roam-placement.json'), 'utf8')) as { attempts: Array<{ proxy: string | null }> };
    expect(state.attempts).toHaveLength(1);
    const proxy = state.attempts[0].proxy as TerminalAddress;
    expect(proxy).toBeTruthy();
    suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address: proxy }); });
    const observed = await hc.get(proxy);
    expect(observed.labels).toMatchObject({ [HERDR_LABELS.kind]: 'roam-proxy', [HERDR_LABELS.session]: readiness.sessionId,
      [HERDR_LABELS.ownerTerminal]: address, [HERDR_LABELS.ownerCore]: cores.dest.coreId,
      [HERDR_LABELS.space]: 'fixture-space', [HERDR_LABELS.tab]: 'fixture-tab' });
    expect(await placement.reconcile([readiness])).toEqual({ pending: [] });
    expect(JSON.parse(await readFile(join(root, 'roam-placement.json'), 'utf8')).attempts).toHaveLength(1);
    await suite.evidence('R02-scope.json', { boundary: 'placement adapter only', input: 'synthetic readiness',
      excluded: 'packaged observer-to-placement path and native pane', deferred: 'Task 3.4', proxy, labels: observed.labels });
  } finally { await hc.dispose(); }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R01'), title: 'two isolated cores sync capture and session home through the packed CLI', tiers: ['headless'], run: twoCoreSync },
  { id: storyId('R02'), title: 'closed-app placement adapter only with synthetic readiness (packaged observer path deferred to Task 3.4)', tiers: ['app'], run: closedAppPlacement },
];
registerScenarios(scenarios);
