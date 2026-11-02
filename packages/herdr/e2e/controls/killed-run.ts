import { existsSync, readFileSync, writeFileSync, appendFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createSuite, type Suite } from '../harness/suite.js';
import { checkoutRoot } from '../harness/environment.js';
import { spawnOwned, type OwnedProcess } from '../harness/processes.js';
import { identityOf, identityAlive, readLedger, rootProcesses, cleanupLedger, type CleanupProof, type Ledger, type ProcessIdentity } from '../harness/resources.js';
import { waitFor, deadline } from '../harness/wait.js';

interface Ready {
  runnerRoot: string; fixtureRoot: string; ledgerPath: string; cleanupProofPath: string;
  worker: ProcessIdentity; daemon: ProcessIdentity; socket: string;
}
export function assertRecoveryProof(proof: Pick<CleanupProof, 'clean' | 'survivors'>): void {
  if (!proof.clean) throw new Error('cleanup unproved');
  if (proof.survivors.length) throw new Error(`cleanup survivors: ${JSON.stringify(proof.survivors)}`);
}
/** Fixture mode in the central runner: bootstrap real resources, then hold until externally killed. */
export async function holdCleanupFixture(suite: Suite, runnerRoot: string, phase: 'daemon' | 'destination'): Promise<never> {
  const socket = suite.ownPath(join(suite.root, 'owned.s'));
  const script = `import {createServer} from 'node:net'; const server=createServer(s=>s.end('owned')); server.listen(${JSON.stringify(socket)});`;
  const daemon = spawnOwned(suite.ledger, { label: 'cleanup-owned-daemon', command: process.execPath, args: ['--input-type=module', '-e', script, join(suite.root, 'daemon-marker')], cwd: suite.root, env: { ...suite.env }, stdio: { log: join(suite.root, 'daemon.log') } });
  await waitFor('owned cleanup daemon socket ready', () => existsSync(socket), Boolean, deadline(10_000));
  if (phase === 'destination') {
    if (!suite.cores) throw new Error('destination cleanup control requires real isolated cores');
    for (const kind of ['foreground', 'background']) {
      const result = await suite.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--', process.execPath, '-e', 'setInterval(()=>{},1000)', join(suite.root, `destination-${kind}`)], 'dest');
      if (result.exitCode !== 0) throw new Error(`destination cleanup payload refused: ${result.stderr}`);
      await suite.evidence(`destination-${kind}.json`, result);
    }
  }
  const ready: Ready = { runnerRoot, fixtureRoot: suite.root, ledgerPath: suite.ledger.path, cleanupProofPath: suite.cleanupProofPath, worker: identityOf(process.pid), daemon: daemon.identity, socket };
  await suite.evidence('killed-control-ready.json', ready);
  writeFileSync(join(runnerRoot, 'control-ready.json'), JSON.stringify(ready, null, 2));
  process.stdout.write('E2E_CLEANUP_READY ' + JSON.stringify(ready) + '\n');
  return new Promise<never>(() => {});
}

async function startVictim(suite: Suite, label: string, phase: 'daemon' | 'destination'): Promise<{ process: OwnedProcess; ready: Ready; log: string }> {
  const log = suite.ownPath(join(suite.root, `${label}.log`));
  const proc = spawnOwned(suite.ledger, { label, command: process.execPath, args: [join(checkoutRoot(), 'scripts/herdr-e2e.mjs'), '--built', '--tier', suite.options.tier === 'ci' ? 'ci' : 'headless', '--story', 'S55', '--cleanup-control', phase], cwd: checkoutRoot(), env: { ...suite.env }, stdio: 'pipe' });
  proc.child.stdin!.end();
  let output = '';
  const save = (chunk: Buffer) => { output += chunk.toString(); appendFileSync(log, chunk); };
  proc.child.stdout!.on('data', save); proc.child.stderr!.on('data', save);
  const ready = await waitFor(`${label} actual fixture readiness`, () => {
    const match = /E2E_CLEANUP_READY (\{[^\n]+\})/.exec(output);
    if (match) return JSON.parse(match[1]) as Ready;
    if (!identityAlive(proc.identity)) throw new Error(`${label} exited before readiness: ${output.slice(-3000)}`);
    return undefined;
  }, Boolean, deadline(90_000), { reconcileMs: 100 });
  return { process: proc, ready: ready!, log };
}
async function socketAlive(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const { connect } = await import('node:net');
  return new Promise(resolve => { const s = connect(path); const finish = (alive: boolean) => { s.destroy(); resolve(alive); }; s.once('connect', () => finish(true)); s.once('error', () => finish(false)); s.setTimeout(2000, () => finish(true)); });
}
async function collected(suite: Suite, victim: { process: OwnedProcess; ready: Ready; log: string }, name: string): Promise<void> {
  const ready = victim.ready;
  await waitFor(`${name} independent fixture cleanup proof`, () => existsSync(ready.cleanupProofPath) ? JSON.parse(readFileSync(ready.cleanupProofPath, 'utf8')) as CleanupProof : undefined, p => Boolean(p?.clean), deadline(60_000), { reconcileMs: 100 });
  const proof = JSON.parse(readFileSync(ready.cleanupProofPath, 'utf8')) as CleanupProof;
  assertRecoveryProof(proof);
  const ledger = readLedger(ready.ledgerPath);
  const identities = [...ledger.processes, ...ledger.cores.flatMap(c => c.pid && c.start ? [{ pid: c.pid, start: c.start }] : [])];
  for (const identity of [ready.worker, ready.daemon, ...identities]) if (identityAlive(identity)) throw new Error(`cleanup left owned PID ${identity.pid}`);
  // A stale Unix socket pathname is not a listener. Connection must fail.
  for (const socket of [ready.socket, ...ledger.cores.map(core => core.socket)]) if (await socketAlive(socket)) throw new Error(`cleanup left owned socket listener ${socket}`);
  const rootSurvivors = rootProcesses(ready.fixtureRoot, ledger.watchdog ? [ledger.watchdog.pid] : []);
  if (rootSurvivors.length) throw new Error(`cleanup root processes remain: ${JSON.stringify(rootSurvivors)}`);
  await suite.evidence(`${name}-proof.json`, proof);
  await suite.evidence(`${name}-ledger.json`, ledger);
  await suite.keepEvidence(victim.log, `${name}-runner.log`);
  const runnerLedgerPath = join(ready.runnerRoot, 'runner-ledger.json');
  const runner = JSON.parse(readFileSync(runnerLedgerPath, 'utf8')) as { ledgerPath: string; cleanupProofPath: string; watchdog: ProcessIdentity };
  await waitFor(`${name} runner cleanup proof`, () => existsSync(runner.cleanupProofPath) ? JSON.parse(readFileSync(runner.cleanupProofPath, 'utf8')) as CleanupProof : undefined, p => Boolean(p?.clean), deadline(30_000));
  assertRecoveryProof(JSON.parse(readFileSync(runner.cleanupProofPath, 'utf8')) as CleanupProof);
  await suite.evidence(`${name}-runner-proof.json`, JSON.parse(readFileSync(runner.cleanupProofPath, 'utf8')) as object);
  for (const watchdog of [runner.watchdog, ledger.watchdog].filter(Boolean) as ProcessIdentity[]) await waitFor(`${name} watchdog exit`, () => identityAlive(watchdog), alive => !alive, deadline(10_000));
}

async function proveCleanupRetry(suite: Suite): Promise<void> {
  const retry = await createSuite({ tier: suite.options.tier === 'ci' ? 'ci' : 'headless', story: suite.story });
  const root = retry.root, ledger = retry.ledger;
  const cores = ledger.read().cores;
  const phases = ['app-stopped', 'local-stopped', 'via-drained', 'destination-stopped'];
  let daemon: OwnedProcess | undefined;
  // The outer suite supervises this daemon throughout the deliberately incomplete
  // inner ledger. It remains protected even if this negative control throws.
  try {
    daemon = spawnOwned(suite.ledger, { label: 'retry-owned-daemon', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)', join(root, 'owned-marker')], env: { ...retry.env }, cwd: root, stdio: { log: join(root, 'daemon.log') } });
    const initial = await Promise.all(cores.map(async core => ({ side: core.side, pid: core.pid, start: core.start, socket: core.socket, listening: await socketAlive(core.socket) })));
    if (suite.options.tier === 'headless' && (initial.length !== 2 || initial.some(core => !core.listening))) throw new Error('retry control requires two actual live owned cores before teardown');
    await suite.evidence('retry-initial-cores.json', initial);
    const first = await cleanupLedger(ledger.path, 'incomplete-ledger-control');
    if (first.clean || !identityAlive(daemon.identity)) throw new Error('cleanup retry negative control did not preserve an observable survivor');
    if (suite.options.tier === 'headless' && (cores.length !== 2 || cores.some(core => !first.verificationRounds.some(round => round.side === core.side && round.quiet === true)))) throw new Error('retry baseline did not perform actual owned local/destination core teardown');
    for (const core of cores) if ((core.pid && core.start && identityAlive({ pid: core.pid, start: core.start })) || await socketAlive(core.socket)) throw new Error('retry baseline left an actual owned core alive');
    await suite.evidence('retry-first-failed-proof.json', first);
    const identity = daemon.identity, label = daemon.label;
    ledger.update(l => l.processes.push({ ...identity, label, group: true }));
    const result = await suite.invoke(process.execPath, [join(checkoutRoot(), 'packages/herdr/e2e/harness/resources.ts'), 'cleanup', ledger.path]);
    const proof = JSON.parse(result.stdout) as CleanupProof;
    if (result.exitCode !== 0 || identityAlive(daemon.identity) || ledger.read().state !== 'closed') throw new Error(`independent failed-ledger retry left the owned daemon: ${result.stdout}`);
    assertRecoveryProof(proof);
    if (proof.phases.map(phase => phase.phase).join(',') !== phases.join(',') || proof.phases.some(phase => !phase.ok)) throw new Error('failed-ledger retry did not rerun the ordered app/local/via/destination teardown');
    if (cores.some(core => !proof.verificationRounds.some(round => round.side === core.side && round.quiet === true))) throw new Error('failed-ledger retry did not independently verify both owned cores stayed stopped');
    if (!proof.repeated || !proof.signalled.some(p => p.pid === identity.pid)) throw new Error('failed-ledger retry never reran cleanup');
    await suite.evidence('retry-second-clean-proof.json', proof);
  } finally { try { await daemon?.stop(); } finally { await retry.close(); } }
}

/** SIGTERM, SIGKILL, then loss of both watchdogs followed by a real next-run reconciliation. */
export async function proveKilledRunner(suite: Suite): Promise<void> {
  const defaultSocket = join(userInfo().homedir, '.local/state/herdr-core/default/default.sock');
  const defaultIdentity = () => {
    let stat;
    try { stat = lstatSync(defaultSocket); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
    const result = spawnSync(lsof, ['-t', '-a', '-U', defaultSocket], { encoding: 'utf8', env: { ...suite.env }, timeout: 5000 });
    if (result.status !== 0 && result.status !== 1) throw new Error('default listener identity could not be observed without a default-core call');
    const pids = [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))].sort((a, b) => a - b);
    if (pids.some(pid => !Number.isInteger(pid) || pid <= 0)) throw new Error('invalid default listener PID observation');
    return { device: stat.dev, inode: stat.ino, createdAt: stat.birthtimeMs, listeners: pids.map(identityOf) };
  };
  const defaultBefore = defaultIdentity();
  const phase = suite.options.tier === 'ci' ? 'daemon' : 'destination';
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const victim = await startVictim(suite, `victim-${signal}`, phase);
    try { process.kill(victim.process.identity.pid, signal); await victim.process.exited; await collected(suite, victim, signal.toLowerCase()); }
    finally { await victim.process.stop(); }
  }
  const victim = await startVictim(suite, 'victim-no-watchdogs', phase);
  const fixtureLedger = readLedger(victim.ready.ledgerPath);
  const runner = JSON.parse(readFileSync(join(victim.ready.runnerRoot, 'runner-ledger.json'), 'utf8')) as { ledgerPath: string; watchdog: ProcessIdentity };
  const runnerLedger: Ledger = readLedger(runner.ledgerPath);
  for (const guardian of [fixtureLedger.watchdog, runner.watchdog]) if (guardian && identityAlive(guardian)) process.kill(guardian.pid, 'SIGKILL');
  // Kill the worker's whole group as well as the runner; neither finally runs.
  process.kill(victim.process.identity.pid, 'SIGKILL');
  for (const worker of runnerLedger.processes) if (identityAlive(worker)) process.kill(worker.group ? -worker.pid : worker.pid, 'SIGKILL');
  await victim.process.exited;
  await waitFor('killed worker identity disappears before recovery', () => identityAlive(victim.ready.worker), alive => !alive, deadline(10_000));
  const recovery = await startVictim(suite, 'victim-after-reconciliation', phase);
  try {
    const proofs = JSON.parse(readFileSync(join(recovery.ready.runnerRoot, 'startup-reconciliation.json'), 'utf8')) as CleanupProof[];
    for (const ledger of [victim.ready.ledgerPath, runner.ledgerPath]) {
      const proof = proofs.find(p => p.ledger === ledger);
      if (!proof) throw new Error(`next runner did not reconcile ${ledger}`);
      assertRecoveryProof(proof);
    }
    await suite.evidence('startup-recovery-proofs.json', proofs);
    await collected(suite, victim, 'startup-recovery');
  } finally {
    process.kill(recovery.process.identity.pid, 'SIGKILL'); await recovery.process.exited;
    await collected(suite, recovery, 'after-recovery'); await recovery.process.stop();
  }
  await proveCleanupRetry(suite);
  const defaultAfter = defaultIdentity();
  await suite.evidence('default-socket-identity.json', { path: defaultSocket, before: defaultBefore, after: defaultAfter, scope: 'read-only socket inode and lsof PID/start identities; no default-core CLI call' });
  if (JSON.stringify(defaultBefore) !== JSON.stringify(defaultAfter)) throw new Error('default socket identity changed during owned cleanup control');
}
