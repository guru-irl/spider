// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { migrate, openDb } from '@spider/db-core';
import { mapRepository, mapWorkspace } from '@spider/db-core/roam/repo-map';
import { recordLocation } from '@spider/db-core/roam/catalog';
import { text, mark, held, scripts } from '../fixtures/child-scripts.js';
import type { StoryPresentation } from '../fixtures/roam-presentation.js';
import { enableMemoryCapture, seedSession } from '@spider/db-core/roam/seed';
import { parseConfig } from '@spider/roam/config';
import { installSupervisorCorePin } from '@spider/roam/enrollment';
import { inspectSession } from '@spider/roam/session-file';
import { inspectIdLock } from '../../src/sessions/id-lock.js';
import { createSessionLeases } from '../../src/sessions/lease.js';
import { readObserved, writeScript, type InteractiveDriver } from '../harness/pi.js';
import { identityOf } from '../harness/resources.js';
import { spawnOwned } from '../harness/processes.js';
import { assertSocketPath, HarnessError } from '../harness/environment.js';
import { realHcBinary, runHc } from '../harness/hc.js';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

export function effectJsonLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'));
}

export function moveRecoveryPending(result: unknown): boolean {
  return !!result && typeof result === 'object' && 'code' in result && result.code === 3 && 'reason' in result &&
    (result.reason === 'move-destination-pending' || result.reason === 'move-pending' || result.reason === 'intercom-endpoint-not-ready');
}

export const HUB = '00000000-0000-4000-8000-000000000001';
export const BOX = '00000000-0000-4000-8000-000000000002';
export const BOX2 = '00000000-0000-4000-8000-000000000005';
const REPO = '00000000-0000-4000-8000-000000000003';
const WORKSPACE = '00000000-0000-4000-8000-000000000004';
const WT = `worktree:${REPO}:${WORKSPACE}` as const;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const source = (file: string) => JSON.stringify(fileURLToPath(new URL(file, import.meta.url)));

/** Only platform effects are supplied here. Move, freeze, Git, sync and admission stay real. */
async function platformCli(suite: Suite): Promise<string> {
  const entry = suite.ownPath(join(suite.root, 'platform.ts'));
  const code = `
import { readFileSync, appendFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createHostMoveBindings } from ${source('../../../host/src/roam/move-runtime.ts')};
import { createProcessInventory } from ${source('../../../host/src/herdr/process-inventory.ts')};
import { createExactLaunchAdapter, createProductionLocalExactHc } from ${source('../../../roam/src/launcher.ts')};
import { participantLaunchId } from ${source('../../../roam/src/participant-launch.ts')};
import { createIntentStore } from ${source('../../../roam/src/intent.ts')};
import { readMoveLaunchAbsenceReceipt } from ${source('../../../roam/src/pending-handoff.ts')};
import { createRunningIntentAuthority, readReadiness } from ${source('../../../roam/src/session-control.ts')};
import { requestHubControl } from ${source('../../../roam/src/control-socket.ts')};
import { createUsageIngestThrough } from ${source('../../../host/src/roam/usage-ingest.ts')};
import { openUsageLedgerReadOnly } from ${source('../../../host/src/usage/ledger.ts')};
import { inspectIdLock, localBootId } from ${source('../../src/sessions/id-lock.ts')};
import { createHcClient } from ${source('../../src/client/hc.ts')};
import { loadHerdrConfig } from ${source('../../../roam/src/host-config.ts')};
import { createProcessPresence } from ${source('../../src/sessions/presence.ts')};
import { createSessionLeases } from ${source('../../src/sessions/lease.ts')};
import { createLocalDiagnosticPorts } from ${source('../../../roam/src/local-diagnostics.ts')};
import { fixtureProcessDomain } from ${source('../../../host/src/herdr/fixture-process-domain.ts')};
import { snapshotWorkspace } from ${source('../../../roam/src/workspace.ts')};
import { openLocalCore, openLocalRuntime } from ${source('../../../roam/src/runtime.ts')};
import { sessionHome } from ${source('../../../roam/src/homes.ts')};
import { retireParticipantSessions, supervisorRetirementLifecycle } from ${source('../../../roam/src/participant-supervisor.ts')};
import { openFreezeJournal } from ${source('../../../roam/src/journal.ts')};

const descriptor = JSON.parse(readFileSync(${JSON.stringify(join(suite.root, 'move-machines.json'))}, 'utf8'));
const args = process.argv.slice(2);
const root = args[0] === '--global-root' ? args[1] : process.env.SPIDER_GLOBAL_ROOT;
const machine = descriptor.machines.find(row => row.root === root);
if (!machine || !root.startsWith(descriptor.root + '/')) throw Error('unowned move machine');
Object.assign(process.env, machine.env);
const record = value => appendFileSync(descriptor.effects, JSON.stringify(value) + '\\n');
const observedMoveJournals = new WeakSet();
const moveFactory = async input => {
  if (!observedMoveJournals.has(input.journal)) {
    observedMoveJournals.add(input.journal);
    const journalRecord = input.journal.record.bind(input.journal);
    input.journal.record = (id, action, result) => {
      journalRecord(id, action, result);
      if (action === 'move-action-start' || action === 'move-action-complete')
        record({ effect: 'move-phase', at: Date.now(), operationId: id, event: action, action: result.action });
    };
  }
  const runtime = await createHostMoveBindings(input);
  const endpoint = runtime.bindings.intercom!.destinationEndpoint;
  runtime.bindings.intercom!.destinationEndpoint = async home => {
    try {
      const value = await endpoint(home);
      record({ effect: 'move-endpoint-observed', machineId: machine.id, endpoint: {
        address: { sessionId: value?.address?.sessionId, scopeId: value?.address?.scopeId }, machineId: value?.machineId,
        homeEpoch: value?.homeEpoch, activationEpoch: value?.activationEpoch } });
      return value;
    } catch (error) {
      const diagnostic = error.diagnostic;
      record({ effect: 'move-endpoint-refused', machineId: machine.id,
        name: diagnostic?.name ?? 'Error', code: diagnostic?.code ?? null,
        message: diagnostic?.message ?? 'Intercom endpoint lookup failed.' });
      throw error;
    }
  };
  const observe = runtime.bindings.participant!.observation;
  runtime.bindings.participant!.observation = async (home, operation) => {
    const observed = await observe(home, operation);
    const launch = input.journal.read(home.moveId + '-session-start-' + input.config.machineId).find(row => row.action === 'participant-launch')?.result;
    record({ effect: 'move-observation', machineId: machine.id, home, operationId: operation.id,
      observed, launch, ready: launch ? readReadiness(input.journal, launch.launchId) : null,
      lock: await inspectIdLock(join(root, 'herdr'), home.sessionId),
      intent: await createRunningIntentAuthority(input.globalDb).get(home.sessionId) });
    return observed;
  };
  const gitRun = runtime.bindings.participant!.git.run;
  runtime.bindings.participant!.git.run = async (cwd, argv, options) => {
    try { return await gitRun(cwd, argv, options); }
    catch (error) { record({ effect: 'git-failed', machineId: machine.id, cwd, argv, status: error.status, stderr: String(error.stderr ?? '') }); throw error; }
  };
  const check = runtime.ports.check;
  runtime.ports.check = async request => {
    try { return await check(request); }
    catch (error) { record({ effect: 'move-check-failed', machineId: machine.id, error: String(error.stack ?? error) }); throw error; }
  };
  const dispatch = runtime.dispatch;
  runtime.dispatch = async operation => {
    try { return await dispatch(operation); }
    catch (error) { record({ effect: 'move-dispatch-failed', machineId: machine.id, kind: operation.kind, error: String(error.stack ?? error) }); throw error; }
  };
  runtime.bindings.power = { pid: process.pid, onExit: () => () => {}, notice: () => {}, async spawn(argv) {
    record({ effect: 'power-acquire', argv }); let done; const exited = new Promise(resolve => { done = resolve; });
    return { exited, async stop() { record({ effect: 'power-release' }); done(); } };
  } };
  if (input.config.role === 'box') {
    const wake = runtime.bindings.participant!.wake, views = createIntentStore(root), authority = createRunningIntentAuthority(input.globalDb);
    runtime.bindings.participant!.wake = async request => {
      const before = await views.get(request.sessionId), intent = await authority.get(request.sessionId);
      const outcome = await wake(request);
      if (!outcome.ok && outcome.reason === 'participant-launch-conflict') record({ effect: 'participant-wake-conflict', machineId: machine.id,
        before, after: await views.get(request.sessionId), intent, operationId: request.operationId,
        launchId: intent ? participantLaunchId(machine.id, request.sessionId, intent.epoch, request.operationId) : null, outcome });
      return outcome;
    };
  }
  if (input.config.role === 'hub') {
    runtime.bindings.participant!.wake = async ({ sessionId, operationId }) => {
      const intent = await createRunningIntentAuthority(input.globalDb).get(sessionId);
      if (!intent || intent.desired !== 'running') return { ok: false, reason: 'participant-intent-unavailable' };
      const launchId = participantLaunchId(input.config.machineId, sessionId, intent.epoch, operationId);
      if (input.journal.lookupOperation(launchId)) return { ok: true, launchId };
      const config = loadHerdrConfig(root), inventory = createProcessInventory(join(root, 'herdr'));
      const env = { ...process.env }, client = createHcClient({ binary: config.core.binary, env });
      const core = await client.identity(); await client.dispose();
      const hc = createProductionLocalExactHc({ binary: config.core.binary, env, probe: inventory.probe });
      try {
        const self = await inventory.probe(process.pid);
        if (self.kind !== 'live') throw Error('fixture process identity unavailable');
        const adapter = createExactLaunchAdapter({ journal: input.journal, hc,
          clock: { now: Date.now, wait: (ms, signal) => new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); reject(Error('aborted')); }, { once: true });
          }) },
          base: { leases: inventory.leases, processInventory: inventory, processIdentity: { pid: process.pid, startIdentity: self.startIdentity },
            env, machineId: input.config.machineId, core: { coreId: core.coreId, session: core.sessionNamespace, socket: core.socket },
            bootId: localBootId, limits: async () => ({ soft: 8192, hard: 8192 }), shell: machine.shell, sessionBytes: input.config.limits.sessionBytes } });
        await adapter.launch({ sessionId, file: intent.file, cwd: intent.cwd, epoch: intent.epoch, moveId: intent.moveId,
          pi: descriptor.pi, sha256: createHash('sha256').update(readFileSync(intent.file)).digest('hex'), operationId: launchId },
          { mode: input.journal.lookupOperation(launchId) ? 'reconcile' : 'fresh' });
        return { ok: true, launchId };
      } catch (error) {
        if (!input.journal.lookupOperation(launchId)) throw error;
        record({ effect: 'hub-launch-pending', launchId, reason: String(error.message ?? error) });
        return { ok: true, launchId };
      } finally { await hc.dispose(); }
    };
  }
  if (input.config.role === 'hub') {
    const presentation = request => new Promise((resolve, reject) => {
      const socket = connect(descriptor.presentationSocket); let bytes = '';
      socket.on('connect', () => socket.write(JSON.stringify(request) + '\\n'));
      socket.on('data', chunk => { bytes += chunk.toString('utf8'); const newline = bytes.indexOf('\\n'); if (newline < 0) return;
        socket.destroy(); const reply = JSON.parse(bytes.slice(0, newline)); reply.error ? reject(Error(reply.error)) : resolve(reply.value); });
      socket.on('error', reject); socket.setTimeout(5000, () => { socket.destroy(); reject(Error('presentation deadline')); });
    });
    runtime.bindings.handoff!.prepareHandoff = ({ source }) => presentation({ action: 'prepare', home: source });
    runtime.bindings.handoff!.presentReadyTarget = target => presentation({ action: 'present', home: { ...target, epoch: target.homeEpoch } });
  }
  return runtime;
};
const linkFault = JSON.parse(readFileSync(descriptor.faults, 'utf8'));
if (linkFault.offline === machine.id || linkFault.intercomDown === machine.id && args.includes('intercom') && args.includes('exchange')) {
  record({ effect: 'link-unavailable', machineId: machine.id }); process.exitCode = 1;
  process.stdout.write(JSON.stringify({ code: 1, reason: 'fixture-machine-unavailable', machineId: machine.id }) + '\\n');
} else if (args.length === 5 && args[0] === '--global-root' && args[2] === 'roam' && args[3] === 'intercom' &&
    (args[4] === 'exchange' || args[4] === 'revoke-local')) {
  const result = spawnSync(process.execPath, [descriptor.entry, ...args], { env: process.env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} else if (args[0] === 'fixture-status') {
  const status = await requestHubControl(join(root, 'roam', 'hub.sock'), { op: 'status' });
  process.exitCode = status.code; process.stdout.write(JSON.stringify(status) + '\\n');
} else if (args[0] === 'fixture-observe') {
  const core = openLocalCore(root), journal = openFreezeJournal(join(root, 'roam', 'journal.db'));
  let runtime;
  try {
    const home = sessionHome(core.db, args[1]);
    if (!home || home === 'unknown' || home.machineId !== machine.id || home.moveId !== args[2]) throw Error('fixture observation home mismatch');
    const nativeFile = join(root, 'roam', 'fixture-launch-native.json');
    if (!existsSync(nativeFile)) {
      const lock = await inspectIdLock(join(root, 'herdr'), args[1]);
      if (lock?.pendingOperationId) {
        const attempt = journal.read(lock.pendingOperationId).findLast(row => row.action === 'exact-attempt')?.result.attemptId;
        const capture = argv => { const result = spawnSync(loadHerdrConfig(root).core.binary, argv, { env: process.env, encoding: 'utf8' }); return { status: result.status, stdout: result.stdout, stderr: result.stderr }; };
        const labels = ['--label', 'spider.roam.operation=' + lock.pendingOperationId, ...(attempt ? ['--label', 'spider.roam.attempt=' + attempt] : [])];
        writeFileSync(nativeFile, JSON.stringify({ lock, attempt, filtered: capture(['ls', '--all', '--json', ...labels]), all: capture(['ls', '--all', '--json']), help: capture(['ls', '--help']) }), { mode: 0o600 });
      }
    }
    runtime = await moveFactory({ root, globalDb: core.db, config: core.config, journal, sessionId: args[1], transport: {} as never });
    const observed = await runtime.bindings.participant!.observation(home, { id: args[2] + '-fixture-inspect', kind: 'move-observation', machineId: machine.id, expectedEpoch: home.epoch, args: { sessionId: args[1] } });
    const receipt = readMoveLaunchAbsenceReceipt(journal, args[2]), complete = receipt && observed.owner.kind === 'absent' && !observed.readiness;
    const code = complete ? 0 : 3;
    process.exitCode = code;
    process.stdout.write(JSON.stringify({ code, reason: complete ? receipt.kind : 'launch-outcome-pending', receipt, observed, native: existsSync(nativeFile) ? JSON.parse(readFileSync(nativeFile, 'utf8')) : null }) + '\\n');
  } finally { await runtime?.close(); core.close(); }
} else if (args[0] === 'fixture-baseline') {
  const core = openLocalCore(root), journal = openFreezeJournal(join(root, 'roam', 'journal.db'));
  let runtime;
  try {
    runtime = await createHostMoveBindings({ root, globalDb: core.db, config: core.config, journal, sessionId: args[1], transport: {} as never });
    const participant = runtime.bindings.participant!, moveId = 'baseline-' + machine.id;
    journal.begin({ id: moveId, kind: 'workspace-snapshot', machineId: machine.id, expectedEpoch: null, args: {} });
    const snapshot = await snapshotWorkspace({ root: machine.cwd, cwd: machine.cwd, repoKey: ${JSON.stringify(REPO)}, workspaceId: ${JSON.stringify(WORKSPACE)}, moveId, stage: 'final', writers: await participant.writers(machine.cwd) },
      { ...participant.git, journal, limits: core.config.limits });
    const changed = core.db.prepare('UPDATE roam_workspace_maps SET snapshot_json=? WHERE repo_key=? AND workspace_id=? AND path=?').run(JSON.stringify(snapshot), snapshot.repoKey, snapshot.workspaceId, machine.cwd).changes;
    if (changed !== 1) throw Error('fixture baseline mapping unavailable');
    process.stdout.write(JSON.stringify({ code: 0 }) + '\\n');
  } finally { await runtime?.close(); core.close(); }
} else if (args[0] === 'fixture-ingest') {
  let code = 0;
  try {
    await createUsageIngestThrough({ registryDb: join(root, 'spider.db'), ledgerFile: join(root, 'usage.db'), sessionsDir: join(machine.agent, 'sessions'),
      authPath: join(machine.agent, 'auth.json'), leaseDir: join(root, 'usage-leases') }, args[1], machine.id)(args[2], Number(args[3]));
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Usage ingest lease unavailable') throw error;
    const ledger = openUsageLedgerReadOnly(join(root, 'usage.db'));
    try {
      const state = ledger?.getImportState(args[2]), file = statSync(args[2]);
      code = state && state.inode === file.dev + ':' + file.ino && state.offset >= Number(args[3]) ? 0 : 3;
    } finally { ledger?.close(); }
  }
  process.exitCode = code;
  process.stdout.write(JSON.stringify({ code }) + '\\n');
} else if (args[0] === 'fixture-retirement') {
  const core = openLocalRuntime(root);
  let runtime, service;
  try {
    runtime = await createHostMoveBindings({ root, globalDb: core.db, config: core.config, journal: core.journal, sessionId: args[1], transport: {} as never });
    service = supervisorRetirementLifecycle(root, core.config, () => retireParticipantSessions(core.agent, async sessionId => {
      const home = sessionHome(core.db, sessionId);
      if (!home || home === 'unknown') return { kind: 'uncertain' as const };
      return (await runtime.bindings.participant!.observation(home, { id: 'reconnect-inspect', kind: 'session-inspect', machineId: machine.id, expectedEpoch: home.epoch, args: { sessionId } })).owner;
    }));
    await service.start();
    process.stdout.write('move retirement ready\\n');
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  } finally { await service?.stop(); await runtime?.close(); core.close(); }
} else if (args[0] === 'fixture-supervisor') {
  const { startProductionSupervisor } = await import(pathToFileURL(descriptor.supervisor).href);
  const herdr = join(root, 'herdr'), domain = fixtureProcessDomain(herdr, process.env);
  if (!domain) throw Error('fixture process domain unavailable');
  const diagnostic = createLocalDiagnosticPorts(root, []);
  const service = await startProductionSupervisor(root, { system: { shell: machine.shell, bootId: localBootId,
    limits: async () => ({ soft: 8192, hard: 8192 }), inventory: { leases: createSessionLeases(herdr), presence: createProcessPresence(herdr),
      processes: () => domain.processes(), probe: pid => diagnostic.probeProcess({ machineId: machine.id, label: 'owned process', peer: null }, pid) } } });
  process.stdout.write('move supervisor ready\\n');
  await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  await service.stop();
} else {
  const cli = await import(pathToFileURL(descriptor.cli).href);
  const output: string[] = [];
  process.exitCode = await cli.main(args, { out: text => output.push(text), err: text => process.stderr.write(text) }, { moveFactory });
  const agent = args.indexOf('agent'), operation = agent < 0 ? null : JSON.parse(args[agent + 1]);
  const fault = JSON.parse(readFileSync(descriptor.faults, 'utf8'));
  if (operation && fault.drop.includes(operation.kind)) {
    record({ effect: 'reply-dropped', kind: operation.kind, operationId: operation.id, result: process.exitCode });
    process.exitCode = 1;
  } else process.stdout.write(output.join(''));
}
`;
  await writeFile(entry, code, { mode: 0o600 });
  const { buildViteFixture: build } = await import('../../../../scripts/test-bundle.js');
  const output = suite.ownPath(join(suite.root, 'platform'));
  await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.spiderIntercomBrokerRelative': JSON.stringify(suite.packed.intercomBroker),
    'import.meta.spiderHerdrRuntimeEntry': 'false', 'import.meta.spiderPaneEndpointEntry': 'false' },
    ssr: { target: 'node', noExternal: true }, build: { ssr: entry, outDir: output, emptyOutDir: false, minify: false,
      rolldownOptions: { external: id => id.startsWith('node:') || ['better-sqlite3', 'sqlite-vec'].some(name => id === name || id.startsWith(`${name}/`)),
        output: { format: 'es', entryFileNames: 'cli.mjs', codeSplitting: false } } } });
  return join(output, 'cli.mjs');
}

export interface MoveMachine { id: string; alias: string; root: string; cwd: string; agent: string; env: Record<string, string>; side: 'local' | 'dest' | 'move-second'; coreId: string; shell: string }
export interface MoveOwner { pid: number; terminal: string; file: string; cwd: string; sessionId: string }
export interface MoveStory {
  suite: Suite; sessionId: string; originalFile: string; machines: readonly [MoveMachine, MoveMachine, MoveMachine];
  original: InteractiveDriver; cli(machine: MoveMachine, args: readonly string[]): Promise<Record<string, any>>;
  moveTo(machine: MoveMachine, destination: string): Promise<Record<string, any>>;
  owners(): Promise<MoveOwner[]>; owner(machine: MoveMachine): Promise<MoveOwner>;
  home(): { machine_id: string; epoch: number; move_id: string | null };
  trees(cwd: string): Promise<{ head: string; index: string; working: string }>;
  sync(): Promise<void>; close(): Promise<void>;
  effects: string; faults: string; untouched: string; untouchedDigest: string; presentation: StoryPresentation; stopBox(): Promise<void>; reconnectBox(): Promise<void>;
}

async function secondBoxCore(suite: Suite) {
  const namespace = 'r', side = 'move-second' as const;
  const env: Record<string, string> = { ...suite.cores!.dest.env, HC_SESSION: namespace, HOME: suite.ownPath(join(suite.root, 'hr')),
    TMPDIR: suite.ownPath(join(suite.root, 'tr')), XDG_CONFIG_HOME: suite.ownPath(join(suite.root, 'cr')) };
  for (const key of ['HC_SOCKET', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'XDG_RUNTIME_DIR']) delete (env as Record<string, string>)[key];
  for (const directory of [env.HOME, env.TMPDIR, join(env.XDG_CONFIG_HOME, 'herdr-core')]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core', 'config.toml'), 'notes = false\n', { mode: 0o600 });
  const socket = assertSocketPath(suite.root, join(env.XDG_STATE_HOME, 'herdr-core', namespace, `${namespace}.sock`));
  suite.ledger.update(ledger => { ledger.cores.push({ side, namespace, socket, hcBinary: realHcBinary(), env }); });
  expect((await runHc(suite.cores!.wrapper, ['server', 'start', '--json'], env)).exitCode).toBe(0);
  const status = await runHc(suite.cores!.wrapper, ['server', 'status', '--json'], env), raw = status.json as any;
  expect(status.exitCode, status.stderr).toBe(0);
  expect(raw.core.id).not.toBe(suite.cores!.local.coreId);
  expect(raw.core.id).not.toBe(suite.cores!.dest.coreId);
  expect((await stat(socket)).isSocket()).toBe(true);
  const identity = identityOf(raw.pid);
  suite.ledger.update(ledger => { Object.assign(ledger.cores.find(row => row.side === side)!, { coreId: raw.core.id, pid: identity.pid, start: identity.start }); });
  return { side, namespace, env, socket, coreId: String(raw.core.id) };
}

export async function createMoveStory(suite: Suite): Promise<MoveStory> {
  if (process.platform !== 'linux') throw new HarnessError('missing-prerequisite', 'move stories require the Linux story runner');
  const cores = suite.cores;
  if (!cores) throw new HarnessError('missing-prerequisite', 'move stories need owned cores');
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
    probe: [text('owned move session responds')],
    charge: [text('owned destination responds')],
  } });
  const cwd = await suite.project('source');
  const gitEnv = { ...suite.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = async (directory: string, args: readonly string[]) => {
    const result = await suite.invoke('git', args, gitEnv, directory);
    if (result.exitCode !== 0) throw new Error(result.stderr + result.stdout);
    return result.stdout.trim();
  };
  await writeFile(join(cwd, 'tracked.txt'), 'base\n');
  await git(cwd, ['add', 'tracked.txt']); await git(cwd, ['commit', '-qm', 'fixture content']);
  const origin = suite.ownPath(join(suite.root, 'origin.git'));
  await git(suite.root, ['clone', '--bare', '-q', cwd, origin]);
  await git(cwd, ['remote', 'add', 'origin', origin]);
  const destination = suite.ownPath(join(suite.root, 'p', 'destination'));
  await git(suite.root, ['clone', '-q', origin, destination]);
  const secondDestination = suite.ownPath(join(suite.root, 'p', 'second-destination'));
  await git(suite.root, ['clone', '-q', origin, secondDestination]);
  for (const directory of [cwd, destination, secondDestination]) await writeFile(join(directory, '.git', 'info', 'exclude'), '.spider/\n');
  const effects = suite.ownPath(join(suite.root, 'platform-effects.jsonl')); await writeFile(effects, '');
  const faults = suite.ownPath(join(suite.root, 'move-faults.json')); await writeFile(faults, JSON.stringify({ drop: [] }), { mode: 0o600 });
  const cli = await platformCli(suite), descriptor = suite.ownPath(join(suite.root, 'move-machines.json'));
  const machineCores = [cores.local, cores.dest, await secondBoxCore(suite)];
  const machines = machineCores.map((core, i) => {
    const root = suite.ownPath(join(suite.root, `m${i}`, 'g')), agent = suite.ownPath(join(suite.root, `m${i}`, 'a'));
    return { id: [HUB, BOX, BOX2][i], alias: ['hub.invalid', cores.machine, 'box-2.invalid'][i], root, cwd: [cwd, destination, secondDestination][i], agent, side: core.side, coreId: core.coreId,
      shell: suite.ownPath(join(suite.root, 'bin', `move-shell-${i}`)),
      env: { ...suite.env, ...core.env, HC_SESSION: core.namespace, HC_SOCKET: core.socket, SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: agent,
        SPIDER_ROAM_PI: suite.pi.launcher, SPIDER_E2E_MOVE_DESCRIPTOR: descriptor, SPIDER_HERDR_E2E_PROCESS_DOMAIN: join(root, 'manifest.json') } } as MoveMachine;
  }) as [MoveMachine, MoveMachine, MoveMachine];
  const [hub, box, secondBox] = machines;
  const sessionId = randomUUID(), originalFile = suite.ownPath(join(hub.agent, 'sessions', 'source-project', `${sessionId}.jsonl`));
  const peers = machines.map((machine, i) => ({ machineId: machine.id, alias: machine.alias, node: process.execPath, pi: suite.pi.launcher, cli,
    core: cores.wrapper, globalRoot: machine.root }));
  const services: Array<{ stop(): Promise<void> }> = [];
  let original: InteractiveDriver | undefined;
  const close = async () => { for (const service of services.splice(0).reverse()) await service.stop(); };
  try {
    // The reverse route is owned by this story as well.
    const reverse = suite.ownPath(join(suite.root, 'bin', 'via-i1')), reverseDescriptor = suite.ownPath(join(suite.root, 'via-i1.json'));
    await writeFile(reverseDescriptor, JSON.stringify({ root: suite.root, env: cores.local.env, log: cores.viaLog, ledgerPath: suite.ledger.path,
      socket: cores.local.socket, viaDirectory: join(suite.root, 'via-processes'), localDestination: { ledgerId: suite.ledger.id, coreId: cores.local.coreId } }), { mode: 0o600 });
    await writeFile(reverse, `#!/bin/sh\nexec 9<"$0"\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('../fixtures/via.mjs', import.meta.url)))} ${quote(reverseDescriptor)} "$@"\n`, { mode: 0o700 });
    suite.ledger.update(ledger => { ledger.machines.push({ side: 'dest', name: hub.alias }); });
    const route = await suite.hc(['machine', 'add', '--via', reverse, '--name', hub.alias, '--session', cores.local.namespace, '--json'], 'dest');
    expect(route.exitCode, route.stderr).toBe(0);
    const secondVia = suite.ownPath(join(suite.root, 'bin', 'via-i2'));
    const secondDescriptor = suite.ownPath(join(suite.root, 'via-i2.json'));
    await writeFile(secondDescriptor, JSON.stringify({ root: suite.root, env: machineCores[2].env, log: cores.viaLog, ledgerPath: suite.ledger.path,
      socket: machineCores[2].socket, viaDirectory: join(suite.root, 'via-processes') }), { mode: 0o600 });
    await writeFile(secondVia, `#!/bin/sh\nexec 9<"$0"\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('../fixtures/via.mjs', import.meta.url)))} ${quote(secondDescriptor)} "$@"\n`, { mode: 0o700 });
    for (const machine of machines.slice(0, 2)) {
      suite.ledger.update(ledger => { ledger.machines.push({ side: machine.side, name: secondBox.alias }); });
      const route = await runHc(cores.wrapper, ['machine', 'add', '--via', secondVia, '--name', secondBox.alias, '--session', machineCores[2].namespace, '--json'], machine.env);
      expect(route.exitCode, route.stderr).toBe(0);
    }
    for (const [machine, via, namespace] of [[hub, reverse, cores.local.namespace], [box, join(suite.root, 'bin', 'via-d'), cores.dest.namespace]] as const) {
      suite.ledger.update(ledger => { ledger.machines.push({ side: secondBox.side, name: machine.alias }); });
      const route = await runHc(cores.wrapper, ['machine', 'add', '--via', via, '--name', machine.alias, '--session', namespace, '--json'], secondBox.env);
      expect(route.exitCode, route.stderr).toBe(0);
    }
    for (const [i, machine] of machines.entries()) {
      for (const directory of [join(machine.root, 'roam'), join(machine.root, 'herdr'), join(machine.agent, 'sessions')]) await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(machine.root, 'manifest.json'), JSON.stringify({ version: 1, root: machine.root }), { mode: 0o600 });
      for (const name of ['settings.json', 'models.json']) await copyFile(join(suite.directories.PI_CODING_AGENT_DIR, name), join(machine.agent, name));
      await writeFile(join(machine.agent, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } }), { mode: 0o600 });
      await copyFile(join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json'), join(machine.root, 'config.json'));
      await writeFile(join(machine.root, 'roam', 'machine.json'), JSON.stringify({ machineId: machine.id }), { mode: 0o600 });
      const others = peers.filter(peer => peer.machineId !== machine.id);
      const config = parseConfig({ enabled: true, role: i ? 'box' : 'hub', machineId: machine.id, hubMachineId: HUB,
        peers: i === 0 ? others : [], discoveryRoots: [], coreUnit: 'fixture.service',
        intercom: { enabled: true, mode: 'hub-only', machineAlias: machine.alias, routes: others.map(peer => i && peer.machineId !== HUB
          ? { kind: 'relay', via: HUB, peer } : { kind: 'direct', peer, edgeEpoch: 'fixture-edge' }) } });
      await writeFile(join(machine.root, 'roam', 'config.json'), JSON.stringify(config), { mode: 0o600 });
      if (i > 0) {
        const core = machineCores[i];
        installSupervisorCorePin(machine.root, { binary: cores.wrapper, coreId: core.coreId, socket: core.socket,
          sessionNamespace: core.namespace, stateHome: core.env.XDG_STATE_HOME, configHome: core.env.XDG_CONFIG_HOME });
      }
      await writeFile(join(machine.root, 'herdr', 'config.json'), JSON.stringify({ app: { binary: join(suite.root, 'closed-app'), home: suite.directories.HERDR_APP_HOME },
        core: { binary: cores.wrapper, config: join(suite.root, 'core.toml') }, globalRoot: machine.root, agentDirectory: machine.agent,
        shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [] }), { mode: 0o600 });
      await writeFile(machine.shell, `#!/bin/sh\n[ "$1" = '-c' ] || exit 90\nscript=$2\nshift 2\n[ "$1" = "$0" ] || exit 91\nprintf '%s\\n' "$2" >> ${quote(effects)}\nexport SPIDER_HERDR_E2E_PROCESS_DOMAIN="$3/manifest.json"\n[ "$6" = ${quote(suite.pi.launcher)} ] && [ "$7" = '--session' ] || exit 92\ncase "$8" in ${quote(suite.root)}/*) ;; *) exit 93 ;; esac\n[ ! -f ${quote(join(machine.root, 'roam', 'fail-launch'))} ] || exit 95\nexec /bin/sh -c 'ulimit() { return 0; }; '"$script" "$@"\n`, { mode: 0o700 });
      const db = openDb(join(machine.root, 'spider.db'));
      try {
        migrate(db, 'global', { machineId: machine.id, globalRoot: machine.root });
        enableMemoryCapture(db, 'global');
        await mapRepository(db, { repoKey: REPO, path: machine.cwd });
        await mapWorkspace(db, { repoKey: REPO, workspaceId: WORKSPACE, path: machine.cwd });
        for (const [scope, file, key] of [
          ['worktree', join(machine.cwd, '.spider', 'project.db'), WT],
          ['repo', join(machine.cwd, '.git', 'spider', 'repo.db'), `repo:${REPO}`],
        ] as const) {
          await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          const store = openDb(file);
          try {
            migrate(store, scope, { machineId: machine.id, globalRoot: machine.root });
            if (scope === 'repo') enableMemoryCapture(store, key);
            else store.prepare('UPDATE roam_meta SET store_key=?,capture_enabled=1 WHERE id=1').run(key);
          }
          finally { store.close(); }
        }
        db.prepare('INSERT INTO projects(project_key,real_path,db_path,git_common_dir,created_at,last_seen_at) VALUES(?,?,?,?,1,1)')
          .run(machine.cwd, machine.cwd, join(machine.cwd, '.spider', 'project.db'), join(machine.cwd, '.git'));
      } finally { db.close(); }
    }
    const { storyPresentation } = await import('../fixtures/roam-presentation.js');
    const presentation = await storyPresentation(suite, machines, sessionId);
    services.push({ stop: () => presentation.close() });
    await writeFile(descriptor, JSON.stringify({ root: suite.root, pi: suite.pi.launcher, effects, faults, entry: suite.packed.roamCli, cli: join(suite.packed.root, 'dist/roam/cli-main.mjs'),
      supervisor: suite.packed.roamSupervisor, presentationSocket: presentation.socket, machines }), { mode: 0o600 });
    for (const machine of machines) {
      const baseline = await suite.invoke(process.execPath, [cli, 'fixture-baseline', sessionId], machine.env);
      expect(baseline.exitCode, baseline.stderr + baseline.stdout).toBe(0);
    }
    const systemctl = suite.ownPath(join(suite.root, 'bin', 'systemctl'));
    await writeFile(systemctl, `#!/bin/sh\ncase "$*" in '--user start spider-roam-supervisor.service') printf '%s\\n' "$*" >> ${quote(effects)} ;; *) exit 94 ;; esac\n`, { mode: 0o700 });
    for (const machine of machines) {
      const broker = spawnOwned(suite.ledger, { label: 'move-broker', command: process.execPath, args: [suite.packed.intercomBroker], env: machine.env,
        cwd: suite.root, stdio: { log: join(suite.root, `broker-${machine.id}.log`) } });
      services.push(broker);
      await waitFor('owned broker socket', () => existsSync(join(machine.agent, 'intercom', 'broker.sock')), Boolean, deadline(20_000));
    }
    const supervisors = new Map<string, { stop(): Promise<void> }>();
    for (const machine of machines.slice(1)) {
      const supervisorLog = suite.ownPath(join(suite.root, `move-supervisor-${machine.id}.log`));
      const supervisor = spawnOwned(suite.ledger, { label: 'move-supervisor', command: process.execPath, args: [cli, 'fixture-supervisor'], env: machine.env,
        cwd: suite.root, stdio: { log: supervisorLog } });
      services.push(supervisor); supervisors.set(machine.id, supervisor);
      await waitFor('packed move supervisor', async () => {
        const text = await readFile(supervisorLog, 'utf8'); if (supervisor.child.exitCode !== null) throw Error(text); return text;
      }, text => text.includes('move supervisor ready'), deadline(20_000));
    }
    const hubLog = suite.ownPath(join(suite.root, 'move-hub.log'));
    const hubService = spawnOwned(suite.ledger, { label: 'move-hub', command: process.execPath, args: [cli, 'roam', 'hub'], env: hub.env,
      cwd: suite.root, stdio: { log: hubLog } });
    services.push(hubService);
    await waitFor('packed move hub', async () => { if (hubService.child.exitCode !== null) throw Error(await readFile(hubLog, 'utf8')); return existsSync(join(hub.root, 'roam', 'hub.sock')); }, Boolean, deadline(20_000));
    await mkdir(dirname(originalFile), { recursive: true, mode: 0o700 });
    await writeFile(originalFile, [
      { type: 'session', version: 3, id: sessionId, cwd, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'message', id: 'root-leaf', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'fixture root', timestamp: 1 } },
      { type: 'message', id: 'historical-answer', parentId: 'root-leaf', timestamp: '2026-01-02T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'a newer unselected branch' }],
        api: 'e2e-fixture-api', provider: 'e2e-fixture', model: 'scripted', usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 2 } },
      { type: 'message', id: 'older-leaf', parentId: 'root-leaf', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'mirrored history', timestamp: 1 } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    const global = openDb(join(hub.root, 'spider.db')), worktree = openDb(join(cwd, '.spider', 'project.db'));
    try {
      seedSession(worktree, sessionId, 1, WT, 1024 * 1024);
      global.prepare('INSERT INTO session_homes (session_id, machine_id, epoch, move_id, updated_at) VALUES (?,?,1,NULL,1)').run(sessionId, HUB);
      recordLocation(global, { sessionId, file: originalFile, cwd, stores: ['global', `repo:${REPO}`, WT], home: { sessionId, machineId: HUB, epoch: 1, moveId: null, updatedAt: 1 } });
    } finally { worktree.close(); global.close(); }
    original = await suite.launchPi({ mode: 'interactive', cwd, args: ['--session', originalFile], extraEnv: hub.env }) as InteractiveDriver;
    await original.waitEvent('session_start', row => row.sessionId === sessionId, deadline(30_000));
    await waitFor('participating source holds its ID lock', () => inspectIdLock(join(hub.root, 'herdr'), sessionId), row => row?.identity.pid === original!.pid, deadline(30_000));
    await writeFile(join(cwd, 'tracked.txt'), 'staged\n'); await git(cwd, ['add', 'tracked.txt']); await writeFile(join(cwd, 'tracked.txt'), 'working\n');
    await writeFile(join(cwd, 'untracked.txt'), 'untracked fixture\n');
    const untouched = suite.ownPath(join(suite.root, 'unrelated-root.txt')); await writeFile(untouched, 'must not change\n');
    const untouchedDigest = createHash('sha256').update(await readFile(untouched)).digest('hex');
    let calls = 0;
    const control: MoveStory['cli'] = async (machine, args) => {
      const startedAt = Date.now();
      console.info(JSON.stringify({ story: suite.story, phase: 'cli-start', machine: machine.side, args, startedAt }));
      const result = await suite.invoke(process.execPath, [cli, ...args, '--json'], machine.env);
      console.info(JSON.stringify({ story: suite.story, phase: 'cli-end', machine: machine.side, args, durationMs: Date.now() - startedAt, exitCode: result.exitCode }));
      await suite.evidence(`${suite.story}-${++calls}-${machine.side}-${args.filter(arg => !arg.startsWith('-')).join('-').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)}.json`, result);
      if (args[0] === 'move' || args[0] === 'roam' && args[1] === 'recover') {
        const phases = effectJsonLines(await readFile(effects, 'utf8')).map(line => JSON.parse(line))
          .filter(row => row.effect === 'move-phase' && row.at >= startedAt);
        console.info(JSON.stringify({ story: suite.story, phase: 'move-timeline', startedAt, phases }));
      }
      let value: Record<string, any>; try { value = JSON.parse(result.stdout); } catch { throw Error(result.stdout + result.stderr); }
      expect(result.exitCode, result.stderr + result.stdout).toBe(value.code);
      if (suite.story === 'R08' && args[0] === 'roam' && args[1] === 'recover') console.info(JSON.stringify({ story: suite.story, phase: 'recovery-result', result: value }));
      return value;
    };
    const moveTo: MoveStory['moveTo'] = async (machine, destination) => {
      const initial = await control(machine, ['move', sessionId, destination]);
      if (initial.code !== 3 || initial.reason !== 'move-destination-pending') return initial;
      // A pending move requires the documented recovery command after supervision starts its owner.
      return waitFor('documented recovery completes the pending move', async () => {
        const recovered = await control(machine, ['roam', 'recover', initial.operationId]);
        expect(recovered.operationId).toBe(initial.operationId);
        return recovered;
      }, recovered => !(recovered.code === 0 && recovered.value?.sourceCleanup?.status === 'pending') && !moveRecoveryPending(recovered), deadline(60_000), { reconcileMs: 500 });
    };
    const owners: MoveStory['owners'] = async () => {
      const result: MoveOwner[] = [];
      for (const machine of machines) {
        const membershipDb = openDb(join(machine.cwd, '.spider', 'project.db'));
        let active: boolean;
        try { active = (membershipDb.prepare('SELECT state FROM roam_sessions WHERE session_id=?').get(sessionId) as { state: string } | undefined)?.state === 'active'; }
        finally { membershipDb.close(); }
        if (!active) continue;
        const lock = await inspectIdLock(join(machine.root, 'herdr'), sessionId);
        if (!lock || lock.pendingOperationId !== null) continue;
        let alive = false;
        try {
          const proc = await readFile(`/proc/${lock.identity.pid}/stat`, 'utf8');
          const fields = proc.slice(proc.lastIndexOf(')') + 2).split(' ');
          alive = fields[0] !== 'Z' && lock.identity.startIdentity === `linux:${fields[19]}`;
        } catch { /* An owner may exit during inspection. */ }
        if (!alive) continue;
        const event = (await readObserved(suite.pi.observerDir, lock.identity.pid)).find(row => row.type === 'session_start' && row.sessionId === sessionId);
        if (event && typeof event.hcTerminal === 'string' && typeof event.sessionFile === 'string' && typeof event.cwd === 'string') {
          result.push({ pid: lock.identity.pid, terminal: event.hcTerminal, file: event.sessionFile, cwd: event.cwd, sessionId });
          const identity = identityOf(lock.identity.pid);
          suite.ledger.update(ledger => {
            if (!ledger.terminals.some(row => row.side === machine.side && row.address === event.hcTerminal)) ledger.terminals.push({ side: machine.side, address: event.hcTerminal as string });
            if (!ledger.processes.some(row => row.pid === identity.pid && row.start === identity.start)) ledger.processes.push({ ...identity, label: 'moved-pi', group: false });
          });
        }
      }
      return result;
    };
    const owner: MoveStory['owner'] = async machine => {
      const rows = await waitFor('one exact owner at the mapped checkout', owners, values => values.length === 1 && values[0].cwd === machine.cwd, deadline(60_000));
      const found = rows[0], lease = await createSessionLeases(join(machine.root, 'herdr')).get(found.file);
      expect(lease?.pid).toBe(found.pid); return found;
    };
    const home = () => { const db = openDb(join(hub.root, 'spider.db')); try { return db.prepare('SELECT machine_id,epoch,move_id FROM session_homes WHERE session_id=?').get(sessionId) as ReturnType<MoveStory['home']>; } finally { db.close(); } };
    const trees = async (directory: string) => {
      const index = await git(directory, ['write-tree']);
      const temporaryIndex = suite.ownPath(join(suite.root, `tree-index-${randomUUID()}`));
      const result = await suite.invoke('git', ['add', '-A'], { ...gitEnv, GIT_INDEX_FILE: temporaryIndex }, directory);
      expect(result.exitCode, result.stderr).toBe(0);
      const working = await suite.invoke('git', ['write-tree'], { ...gitEnv, GIT_INDEX_FILE: temporaryIndex }, directory);
      expect(working.exitCode, working.stderr).toBe(0);
      return { head: await git(directory, ['rev-parse', 'HEAD']), index, working: working.stdout.trim() };
    };
    const sync = async () => { for (const machine of machines.slice(1)) expect(await control(hub, ['roam', 'sync', machine.id])).toMatchObject({ code: 0 }); };
    return { suite, sessionId, originalFile, original, machines, owners, owner, home, trees, cli: control, moveTo, sync, effects, faults, untouched, untouchedDigest,
      presentation, stopBox: () => supervisors.get(BOX)!.stop(), async reconnectBox() {
        const log = suite.ownPath(join(suite.root, 'move-retirement.log'));
        const service = spawnOwned(suite.ledger, { label: 'move-retirement', command: process.execPath, args: [cli, 'fixture-retirement', sessionId], env: box.env,
          cwd: suite.root, stdio: { log } });
        services.push(service);
        await waitFor('returning machine accepts only retirement', async () => {
          const text = await readFile(log, 'utf8'); if (service.child.exitCode !== null) throw Error(text); return text;
        }, text => text.includes('move retirement ready'), deadline(20_000));
      }, close };
  } catch (error) { await close(); throw error; }
}

export async function assertMoveState(f: MoveStory, machine: MoveMachine, expectedTrees: Awaited<ReturnType<MoveStory['trees']>>, epoch: number,
  unavailableMachines: readonly string[] = []): Promise<MoveOwner> {
  const owner = await f.owner(machine), actual = await inspectSession(owner.file, f.sessionId);
  const actualSessionId = actual.sessionId, originalSessionId = f.sessionId, actualCwd = actual.cwd, mappedCwd = machine.cwd;
  expect(actualSessionId).toBe(originalSessionId);
  expect(actualCwd).toBe(mappedCwd);
  expect(await f.owners()).toHaveLength(1);
  expect(f.home()).toMatchObject({ machine_id: machine.id, epoch });
  const actualTrees = await f.trees(machine.cwd);
  expect(actualTrees).toEqual(expectedTrees);
  const history = (await readFile(owner.file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  expect(history.find(row => row.id === 'older-leaf').message.content).toBe('mirrored history');
  expect(history.filter(row => row.customType === 'spider-roam-segment').at(-1).data.nextMachine).toBe(machine.id);
  const selected: string[] = [];
  for (let id: string | null = actual.leaf; id; id = history.find(row => row.id === id)?.parentId ?? null) selected.push(id);
  expect(selected).toContain('older-leaf');
  expect(selected).not.toContain('historical-answer');
  expect(createHash('sha256').update(await readFile(f.untouched)).digest('hex')).toBe(f.untouchedDigest);
  for (const host of f.machines) {
    const catalog = openDb(join(host.root, 'spider.db'));
    let file: string | null;
    try { file = (catalog.prepare('SELECT file FROM roam_locations WHERE session_id=?').get(f.sessionId) as { file: string } | undefined)?.file ?? null; }
    finally { catalog.close(); }
    if (!file || !existsSync(file)) continue;
    if (!unavailableMachines.includes(host.id)) {
      const bytes = await stat(file);
      expect(await waitFor('usage reaches the observed transcript prefix', () => f.cli(host, ['fixture-ingest', f.sessionId, file!, String(bytes.size)]),
        result => result.code === 0, deadline(30_000))).toMatchObject({ code: 0 });
    }
    const ledger = openDb(join(host.root, 'usage.db'), { fileMustExist: true });
    try {
      const foreignCharges = ledger.prepare('SELECT entry_id,execution_machine FROM calls WHERE session_id=? AND execution_machine IS NOT NULL AND execution_machine<>?').all(f.sessionId, host.id);
      expect(foreignCharges).toEqual([]);
      const historical = ledger.prepare("SELECT input,output,execution_machine FROM calls WHERE session_id=? AND entry_id='historical-answer'").all(f.sessionId);
      expect(historical).toEqual(host.id === HUB ? [{ input: 10, output: 1, execution_machine: HUB }] : []);
    } finally { ledger.close(); }
  }
  await f.suite.evidence(`${f.suite.story}-owner-${epoch}.json`, { owner, home: f.home(), actualTrees });
  return owner;
}

async function assertRouteWarnings(f: MoveStory, result: Record<string, any>): Promise<void> {
  const db = openDb(join(f.machines[0].root, 'roam', 'journal.db'));
  try {
    const observations = (db.prepare("SELECT result_json FROM roam_operation_actions WHERE operation_id=? AND action='move-action-complete' ORDER BY seq")
      .all(result.operationId) as { result_json: string }[]).map(row => JSON.parse(row.result_json))
      .filter(row => row.action === 'intercom-inspect' || row.action === 'intercom-ready');
    expect(observations.map(row => row.action)).toEqual(['intercom-inspect', 'intercom-ready']);
    const actual = [...new Set(observations.flatMap(row => row.value.warnings as string[]))].sort();
    expect(result.value.warnings.filter((warning: string) => warning.startsWith('intercom-route-')).sort()).toEqual(actual);
    await f.suite.evidence(`${f.suite.story}-route-warnings-${result.operationId}.json`, { observations, warnings: result.value.warnings });
  } finally { db.close(); }
}

async function outward(suite: Suite): Promise<void> {
  const f = await createMoveStory(suite), [hub, box, secondBox] = f.machines;
  try {
    const expectedTrees = await f.trees(hub.cwd), indexBytes = await readFile(join(hub.cwd, '.git', 'index'));
    await f.presentation.prepare(hub, 1);
    expect((await f.presentation.store.read()).presentations[0]).toMatchObject({ mode: 'native', proxy: null, target: { terminalId: f.original.terminal } });
    expect(await f.presentation.machineText()).toBe('This computer');
    f.presentation.sourceFocused(false);
    await writeFile(f.faults, JSON.stringify({ drop: [], intercomDown: BOX2 }));
    const outage = await waitFor('source reports its actual unavailable intercom route', () => f.cli(hub, ['fixture-status']),
      result => result.value?.intercom?.links?.some((link: { peer: string }) => link.peer === BOX2), deadline(30_000), { reconcileMs: 500 });
    const result = await f.moveTo(hub, box.alias);
    expect(result).toMatchObject({ code: 0, reason: 'moved', home: { machineId: BOX, epoch: 2 } });
    expect(result.value.intercomAddress).toContain(box.alias);
    expect(result.value.warnings).toContain('tool-auth-unverified');
    await assertRouteWarnings(f, result);
    expect(result.value.warnings).toContain(`intercom-route-unavailable:${BOX2}`);
    await suite.evidence('R06-route-outage.json', outage);
    await assertMoveState(f, box, expectedTrees, 2);
    const deferred = (await f.presentation.store.read()).presentations[0];
    expect(deferred).toMatchObject({ mode: 'native', slot: { space: f.presentation.slot.space, tab: f.presentation.slot.tab }, conversion: { state: 'waiting-focus' } });
    expect(f.presentation.events).not.toContain('proxy-created');
    f.presentation.sourceFocused(true);
    await f.presentation.present(box, 2);
    const presented = (await f.presentation.store.read()).presentations[0];
    expect(presented).toMatchObject({ mode: 'proxy', visibility: 'visible', slot: { space: f.presentation.slot.space, tab: f.presentation.slot.tab }, target: { homeEpoch: 2 } });
    expect(await f.presentation.machineText()).toBe(box.alias);
    expect(f.presentation.events.filter(value => value === 'proxy-created')).toHaveLength(1);
    expect(f.presentation.events.indexOf('destination-observed')).toBeLessThan(f.presentation.events.indexOf('terminal.park'));
    expect(await f.cli(hub, ['roam', 'recover', result.operationId])).toMatchObject({ code: 0 });
    await writeFile(f.faults, JSON.stringify({ drop: [] }));
    await waitFor('restored intercom route clears its diagnostic', () => f.cli(hub, ['fixture-status']),
      result => result.value?.intercom?.links?.every((link: { peer: string }) => link.peer !== BOX2), deadline(30_000), { reconcileMs: 500 });
    expect(await f.moveTo(hub, secondBox.alias)).toMatchObject({ code: 0 });
    await assertMoveState(f, secondBox, expectedTrees, 3);
    const retargeted = (await f.presentation.store.read()).presentations[0];
    expect(retargeted).toMatchObject({ id: presented.id, proxy: presented.proxy, mode: 'proxy',
      slot: { space: presented.slot!.space, tab: presented.slot!.tab }, target: { machineId: BOX2, homeEpoch: 3 } });
    expect(f.presentation.events.filter(value => value === 'proxy-created')).toHaveLength(1);
    expect(await f.presentation.machineText()).toBe(secondBox.alias);
    await suite.evidence('R06-retargeted.json', { presented, retargeted });
    await suite.evidence('R06-presentation.json', { deferred, presented, events: f.presentation.events, nativeWindow: 'blocked on Linux: requires the app' });
    expect(await readFile(join(hub.cwd, '.git', 'index'))).toEqual(indexBytes);
    expect(await f.trees(hub.cwd)).toEqual(expectedTrees);
    expect(await readFile(f.effects, 'utf8')).toContain('power-release');
  } finally { await f.close(); }
}

async function returnMove(suite: Suite): Promise<void> {
  const f = await createMoveStory(suite), [hub, box, secondBox] = f.machines;
  try {
    const expectedTrees = await f.trees(hub.cwd), checkout = await stat(join(hub.cwd, '.git'));
    expect(await f.moveTo(hub, box.alias)).toMatchObject({ code: 0 });
    await assertMoveState(f, box, expectedTrees, 2);
    const remotePresentation = (await f.presentation.store.read()).presentations[0];
    expect(remotePresentation).toMatchObject({ mode: 'proxy', slot: { space: f.presentation.slot.space, tab: f.presentation.slot.tab } });
    expect(await f.presentation.machineText()).toBe(box.alias);
    expect(await f.moveTo(hub, secondBox.alias)).toMatchObject({ code: 0 });
    await assertMoveState(f, secondBox, expectedTrees, 3);
    const retargeted = (await f.presentation.store.read()).presentations[0];
    expect(retargeted).toMatchObject({ id: remotePresentation.id, proxy: remotePresentation.proxy, mode: 'proxy',
      slot: { space: remotePresentation.slot!.space, tab: remotePresentation.slot!.tab }, target: { machineId: BOX2, homeEpoch: 3 } });
    expect(await f.presentation.machineText()).toBe(secondBox.alias);
    const boxOwner = await f.owner(secondBox), sentAt = Date.now();
    expect((await runHc(suite.cores!.wrapper, ['send', '--force', '--json', boxOwner.terminal, mark('charge')], secondBox.env)).exitCode).toBe(0);
    await waitFor('destination turn settles before the return move', () => readObserved(suite.pi.observerDir, boxOwner.pid),
      events => events.some(row => row.type === 'agent_settled' && row.at >= sentAt), deadline(30_000));
    const destinationCalls = (await readFile(boxOwner.file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
      .filter(row => row.type === 'message' && row.message?.role === 'assistant' && JSON.stringify(row.message.content).includes('owned destination responds'));
    expect(destinationCalls).toHaveLength(1);
    const result = await f.moveTo(hub, 'mac');
    expect(result).toMatchObject({ code: 0, reason: 'moved' });
    expect(result.value.intercomAddress).toContain(hub.alias);
    expect(result.value.warnings).toContain('tool-auth-unverified');
    await assertRouteWarnings(f, result);
    const owner = await assertMoveState(f, hub, expectedTrees, 4);
    expect(owner.file).toBe(f.originalFile);
    for (const machine of f.machines) {
      const ledger = openDb(join(machine.root, 'usage.db'), { fileMustExist: true });
      try {
        expect(ledger.prepare('SELECT execution_machine FROM calls WHERE session_id=? AND entry_id=?').all(f.sessionId, destinationCalls[0].id))
          .toEqual(machine.id === BOX2 ? [{ execution_machine: BOX2 }] : []);
      } finally { ledger.close(); }
    }
    const returnedPresentation = (await f.presentation.store.read()).presentations[0];
    expect(returnedPresentation).toMatchObject({ mode: 'native', proxy: null, visibility: 'visible', slot: { space: remotePresentation.slot!.space, tab: remotePresentation.slot!.tab },
      target: { terminalId: owner.terminal, homeEpoch: 4 } });
    expect(await f.presentation.machineText()).toBe('This computer');
    expect(f.presentation.events.filter(value => value === 'proxy-created')).toHaveLength(1);
    await suite.evidence('R07-presentation.json', { remotePresentation, returnedPresentation, events: f.presentation.events, nativeWindow: 'blocked on Linux: requires the app' });
    expect((await stat(join(hub.cwd, '.git'))).ino).toBe(checkout.ino);
    const entries = (await readFile(owner.file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    expect(entries.filter(row => row.customType === 'spider-roam-segment').map(row => row.data.nextMachine)).toEqual([BOX, BOX2, HUB]);
    await f.sync();
  } finally { await f.close(); }
}

async function exclusion(suite: Suite): Promise<void> {
  const startedAt = Date.now();
  const phase = (name: string) => console.info(JSON.stringify({ story: suite.story, phase: name, elapsedMs: Date.now() - startedAt }));
  phase('setup');
  const f = await createMoveStory(suite), [hub, box] = f.machines;
  phase('busy-source');
  try {
    // A real in-flight provider request blocks freeze before ownership can change.
    const pendingTurn = await scripts(suite, { busy: [held('busy-move', 'released')] });
    await f.original.prompt(mark('busy')); await pendingTurn.ready('busy-move', deadline(30_000));
    const blocked = await f.cli(hub, ['move', f.sessionId, box.alias]);
    expect(blocked.code).not.toBe(0);
    expect(JSON.stringify(blocked)).toMatch(/busy|blocker/);
    expect(f.home()).toMatchObject({ machine_id: HUB, epoch: 1 });
    expect((await f.owners()).map(row => row.pid)).toEqual([f.original.pid]);
    pendingTurn.release('busy-move');
    await f.original.waitEvent('agent_settled', () => true, deadline(30_000));
    phase('lost-readiness');
    const expectedTrees = await f.trees(hub.cwd);
    await writeFile(f.faults, JSON.stringify({ drop: ['session-start', 'session-inspect', 'move-observation', 'move-ready-target'] }));
    const pending = await f.cli(hub, ['move', f.sessionId, box.alias]);
    expect(pending.code).toBe(3);
    const owner = await f.owner(box), before = f.home();
    expect(before).toMatchObject({ machine_id: BOX, epoch: 2 });
    expect(await readFile(f.effects, 'utf8')).toContain('reply-dropped');
    const sourceDb = openDb(join(hub.cwd, '.spider', 'project.db'));
    try { expect(sourceDb.prepare('SELECT state,epoch FROM roam_sessions WHERE session_id=?').get(f.sessionId)).toEqual({ state: 'frozen', epoch: 1 }); }
    finally { sourceDb.close(); }
    phase('cancel-live-destination');
    const cancel = await f.cli(hub, ['roam', 'cancel', pending.operationId]);
    expect(cancel.code).toBe(3);
    expect(f.home()).toEqual(before);
    expect((await f.owners()).map(row => row.pid)).toEqual([owner.pid]);
    await writeFile(f.faults, JSON.stringify({ drop: [] }));
    phase('forward-recovery');
    const recovered = await f.cli(hub, ['roam', 'recover', pending.operationId]);
    expect(recovered.code).toBe(0);
    expect(f.home()).toEqual(before);
    await assertMoveState(f, box, expectedTrees, 2);
    phase('return-home');
    expect(await f.moveTo(hub, 'mac')).toMatchObject({ code: 0 });
    await assertMoveState(f, hub, expectedTrees, 3);
    phase('complete');
    await suite.evidence('R08-exclusion.json', { blocked, pending, cancel, recovered, before, owner });
  } finally { phase('cleanup'); await f.close(); phase('closed'); }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R06'), title: 'outward move preserves state', tiers: ['headless'], run: outward },
  { id: storyId('R07'), title: 'return move reuses checkout', tiers: ['headless'], run: returnMove },
  { id: storyId('R08'), title: 'lost readiness prevents unsafe rollback', tiers: ['headless'], run: exclusion },
];
registerScenarios(scenarios);
