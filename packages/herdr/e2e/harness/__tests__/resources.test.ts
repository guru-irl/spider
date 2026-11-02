// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEnvironment, fencedDirectories } from '../environment.js';
import { startCores } from '../hc.js';
import { dirname, join } from 'node:path';
import { assertSocketPath, createFixtureRoot, createFencedDirectories } from '../environment.js';
import { openLedger, cleanupLedger, reconcileLedgers, identityAlive, identityOf, processStart, readLedger, spawnedIdentity, type LedgerHandle } from '../resources.js';
import { spawnOwned } from '../processes.js';
import { waitFor, deadline } from '../wait.js';
import { createSuite } from '../suite.js';
import { storyId } from '../scenario.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
async function fixture(): Promise<{ root: string; ledger: LedgerHandle; ledgers: string }> {
  const root = await createFixtureRoot(); roots.push(root); await createFencedDirectories(root);
  const ledgers = join(root, '..', '_test-ledgers', root.split('/').at(-1)!); mkdirSync(ledgers, { recursive: true }); roots.push(ledgers);
  return { root, ledger: openLedger(ledgers, root), ledgers };
}
const sleeper = (root: string) => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', join(root, 'marker')], env: { PATH: '/usr/bin:/bin', TMPDIR: join(root, 't') }, cwd: root });

describe('resource ledger cleanup', () => {
  it('stops core-starting actors before the local core', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-teardown-order') });
    let closed = false, release: string | undefined, closing: ReturnType<typeof suite.close> | undefined;
    try {
      await suite.app();
      const daemon = suite.ledger.read().processes.find(process => process.label === 'fake-app-daemon');
      expect(daemon && identityAlive(daemon)).toBe(true);
      if (!suite.cores) throw new Error('owned core is missing');
      const ready = join(suite.root, 'starter-ready'), observed = join(suite.root, 'starter-observed');
      release = join(suite.root, 'starter-release');
      const script = `const fs=require('node:fs'),net=require('node:net');
        process.on('SIGTERM',()=>{const s=net.connect(process.argv[2]);let done=false;const finish=v=>{if(done)return;done=true;fs.writeFileSync(process.argv[3],v);s.destroy();const t=setInterval(()=>{if(fs.existsSync(process.argv[4])){clearInterval(t);process.exit(0);}},20);};s.on('connect',()=>finish('live'));s.on('error',()=>finish('dead'));s.setTimeout(1000,()=>finish('dead'));});
        fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);`;
      const starter = spawnOwned(suite.ledger, { label: 'other-core-starter', command: process.execPath, args: ['-e', script, ready, suite.cores.local.socket, observed, release], env: { ...suite.env }, cwd: suite.root, stdio: { log: join(suite.root, 'starter.log') } });
      suite.ledger.update(l => { Object.assign(l.processes.find(process => process.pid === starter.identity.pid)!, { startsCores: true }); });
      await waitFor('core starter ready', () => existsSync(ready), Boolean, deadline(10_000));
      closing = suite.close();
      await waitFor('starter observed core', () => existsSync(observed), Boolean, deadline(5000));
      await waitFor('fake app exited', () => identityAlive(daemon!), alive => !alive, deadline(5000));
      const coreLive = await new Promise<boolean>(resolve => {
        const socket = connect(suite.cores!.local.socket); const done = (value: boolean) => { socket.destroy(); resolve(value); };
        socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(1000, () => done(false));
      });
      writeFileSync(release, 'release');
      const proof = await closing; closed = true;
      expect(proof.clean, JSON.stringify(proof.survivors)).toBe(true);
      expect(coreLive).toBe(true);
      expect(readFileSync(observed, 'utf8')).toBe('live');
      expect(proof.phases.map(phase => phase.phase)).toEqual(['app-stopped', 'local-stopped', 'via-drained', 'destination-stopped']);
      expect(proof.phases.every(phase => phase.ok)).toBe(true);
      expect(identityAlive(daemon!)).toBe(false);
      expect(identityAlive(starter.identity)).toBe(false);
      expect((suite.ledger.read().processes.find(process => process.label === 'fake-app-daemon') as { startsCores?: boolean }).startsCores).toBe(true);
      await suite.evidence('teardown-order.json', { proof, coreLive, observed: readFileSync(observed, 'utf8') });
    } finally {
      if (release) writeFileSync(release, 'release');
      if (!closed) await (closing ?? suite.close());
    }
  }, 120_000);

  it('kills a core starter that does not exit on SIGTERM before stopping the core', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-stubborn-app') });
    let closed = false;
    try {
      const ready = join(suite.root, 'stubborn-ready'), term = join(suite.root, 'stubborn-term');
      const script = `const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(process.argv[2],'term'));fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);`;
      const starter = spawnOwned(suite.ledger, { label: 'stubborn-core-starter', startsCores: true, command: process.execPath, args: ['-e', script, ready, term], env: { ...suite.env }, cwd: suite.root, stdio: { log: join(suite.root, 'stubborn.log') } });
      await waitFor('stubborn starter ready', () => existsSync(ready), Boolean, deadline(10_000));
      const proof = await suite.close(); closed = true;
      expect(proof.clean, JSON.stringify(proof.survivors)).toBe(true);
      expect(existsSync(term)).toBe(true);
      expect(proof.signalled.filter(item => item.label === 'stubborn-core-starter').map(item => item.signal)).toEqual(['SIGTERM', 'SIGKILL']);
      expect(proof.phases.slice(0, 2)).toEqual([{ phase: 'app-stopped', ok: true }, { phase: 'local-stopped', ok: true }]);
      expect(identityAlive(starter.identity)).toBe(false);
      await suite.evidence('stubborn-app-cleanup.json', proof);
    } finally { if (!closed) await suite.close(); }
  }, 120_000);

  it('kills owned processes by identity, proves nothing survives, and is idempotent', async () => {
    const { root, ledger } = await fixture();
    const p = spawnOwned(ledger, { label: 'sleeper', stdio: { log: join(root, 'sleeper.log') }, ...sleeper(root) });
    expect(identityAlive(p.identity)).toBe(true);
    const first = await cleanupLedger(ledger.path, 'test');
    expect(first.clean).toBe(true); expect(first.repeated).toBe(false);
    expect(first.signalled.map(s => s.label)).toContain('sleeper');
    expect(identityAlive(p.identity)).toBe(false);
    const second = await cleanupLedger(ledger.path, 'test-again');
    expect(second).toMatchObject({ clean: true, repeated: true, signalled: [] });
    expect(readLedger(ledger.path).state).toBe('closed');
    expect(existsSync(ledger.path.replace(/\.json$/, '.cleanup.json'))).toBe(true);
  });

  it('stops a destination again when it reappears during the quiet phase', async () => {
    const { root, ledger } = await fixture();
    const socket = assertSocketPath(root, join(root, 'fake-core.sock'));
    const control = assertSocketPath(root, join(root, 'fake-ctl.sock'));
    const ready = join(root, 'fake-ready'), serverFile = join(root, 'fake-core.cjs'), cli = join(root, 'fake-hc.cjs');
    writeFileSync(serverFile, `const net=require('node:net'),fs=require('node:fs');
      const [socket,control,ready]=process.argv.slice(2);let server,stops=0;
      function open(){server=net.createServer(s=>s.end());server.listen(socket,()=>fs.writeFileSync(ready,'ready'));}
      net.createServer(conn=>conn.on('data',()=>{server.close(()=>{stops++;conn.end('ok');if(stops===1)setTimeout(open,150);});})).listen(control,open);
      process.on('SIGTERM',()=>process.exit(0));`);
    writeFileSync(cli, `#!/usr/bin/env node
      const net=require('node:net'),a=process.argv.slice(2);
      if(a[0]==='ls'){console.log(JSON.stringify({terminals:[]}));}
      else if(a[0]==='machine'){console.log(JSON.stringify({machines:[]}));}
      else if(a[0]==='server'&&a[1]==='stop'){const s=net.connect(process.env.TEST_CONTROL);s.on('connect',()=>s.write('stop'));s.on('data',()=>{console.log(JSON.stringify({stopped:true}));s.destroy();});}
      else process.exitCode=2;`, { mode: 0o700 });
    const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: join(root, 't'), TEST_CONTROL: control };
    const server = spawnOwned(ledger, { label: 'fake-core', command: process.execPath, args: [serverFile, socket, control, ready], env, cwd: root, stdio: { log: join(root, 'fake-core.log') } });
    ledger.update(l => { l.cores.push({ side: 'dest', namespace: 'fixture', socket, hcBinary: cli, env }); });
    try {
      await waitFor('fake core ready', () => existsSync(ready), Boolean, deadline(5000));
      const proof = await cleanupLedger(ledger.path, 'reappearing-core');
      expect(proof.clean, JSON.stringify(proof)).toBe(true);
      expect(proof.coreActions.filter(action => action.side === 'dest' && action.argv[0] === 'server' && action.argv[1] === 'stop')).toHaveLength(2);
      expect(proof.verificationRounds.filter(round => round.side === 'dest').map(round => round.listening)).toEqual([true, false, true]);
      expect(proof.verificationRounds.find(round => round.side === 'dest' && round.round === 2)?.quiet).toBe(false);
      expect(existsSync(socket)).toBe(false);
    } finally { if (identityAlive(server.identity)) await server.stop(); }
  }, 30_000);

  it('drains a live via registration before declaring cleanup complete', async () => {
    const { root, ledger } = await fixture();
    const directory = join(root, 'via-processes'); mkdirSync(directory, { recursive: true });
    ledger.update(l => { Object.assign(l, { viaDirectory: directory }); });
    const via = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(root, 'via-d.json')], { stdio: 'ignore' });
    try {
      const identity = await waitFor('via process identity', () => { try { return identityOf(via.pid!); } catch { return null; } }, Boolean, deadline(5000));
      writeFileSync(join(directory, `${identity!.pid}.json`), JSON.stringify(identity));
      const proof = await cleanupLedger(ledger.path, 'drain-via');
      expect(proof.clean, JSON.stringify(proof.survivors)).toBe(true);
      expect(identityAlive(identity!)).toBe(false);
      expect((proof as unknown as { viaActions: { pid: number }[] }).viaActions.some(item => item.pid === identity!.pid)).toBe(true);
    } finally {
      if (via.pid && processStart(via.pid)) {
        via.kill('SIGKILL');
        await waitFor('via negative control exits', () => processStart(via.pid!), start => start === null, deadline(5000));
      }
    }
  });

  it('retries a failed ledger and stops registered resources that still belong to it', async () => {
    const { root, ledger } = await fixture();
    const victim = spawnOwned(ledger, { label: 'retry-victim', stdio: { log: join(root, 'retry.log') }, ...sleeper(root) });
    ledger.update(l => { l.state = 'cleanup-failed'; });
    try {
      const proof = await cleanupLedger(ledger.path, 'retry-failed-cleanup');
      expect(proof).toMatchObject({ clean: true, repeated: true });
      expect(proof.signalled.map(item => item.label)).toContain('retry-victim');
      expect(identityAlive(victim.identity)).toBe(false);
    } finally { if (identityAlive(victim.identity)) await victim.stop(); }
  });

  it('never signals a PID whose start identity changed', async () => {
    const { ledger } = await fixture();
    const self = identityOf(process.pid);
    ledger.update(l => { l.processes.push({ pid: process.pid, start: 'Thu Jan  1 00:00:00 1970', label: 'reused', group: false }); });
    const proof = await cleanupLedger(ledger.path, 'test');
    expect(proof.refused).toEqual([expect.objectContaining({ pid: process.pid, why: expect.stringMatching(/start identity changed/) })]);
    expect(proof.signalled).toEqual([]);
    expect(identityAlive(self)).toBe(true);
  });

  it('reports failed cleanup rather than success when a root process survives outside the ledger', async () => {
    const { root, ledger } = await fixture();
    const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(root, 'stray')], { stdio: 'ignore' });
    try {
      await waitFor('stray visible', () => processStart(stray.pid!), Boolean, deadline(5000));
      const proof = await cleanupLedger(ledger.path, 'test');
      expect(proof.clean).toBe(false);
      expect(proof.survivors.some(s => s.kind === 'root-process' && s.id.startsWith(String(stray.pid)))).toBe(true);
      expect(readLedger(ledger.path).state).toBe('cleanup-failed');
    } finally { stray.kill('SIGKILL'); }
  });
});

describe('remote guardian', () => {
  it('holds while the lease is renewed, then cleans cores and processes on expiry with no control connection', async () => {
    const { root, ledger } = await fixture();
    const env = buildEnvironment(process.env, fencedDirectories(root), { binDirectory: join(root, 'bin') });
    const cores = await startCores(ledger, root, env, join(root, 'bin'));
    const victim = spawnOwned(ledger, { label: 'payload', stdio: { log: join(root, 'p.log') }, ...sleeper(root) });
    const lease = join(root, 'lease.json');
    const renew = (ms: number) => writeFileSync(lease, JSON.stringify({ version: 1, expiresAt: Date.now() + ms }));
    renew(4000);
    const guardian = spawn(process.execPath, [fileURLToPath(new URL('../../fixtures/remote-guardian.mjs', import.meta.url)), ledger.path, lease], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const ack = await new Promise<string>(r => guardian.stdout!.once('data', d => r(String(d))));
    expect(ack).toBe(`guardian-ready ${guardian.pid}\n`);
    guardian.unref();
    // Renewed phase: two renewals spanning more than the original lease; nothing may be cleaned.
    const renewedUntil = Date.now() + 6000;
    await waitFor('renewed phase observed', () => { if (Date.now() + 3000 > renewedUntil) return true; renew(4000); return false; }, Boolean, deadline(20_000), { reconcileMs: 1000 });
    expect(readLedger(ledger.path).state).toBe('open');
    expect(identityAlive(victim.identity)).toBe(true);
    expect(existsSync(cores.local.socket)).toBe(true);
    // Stop renewing: the guardian alone must clean up.
    await waitFor('guardian closes the ledger', () => readLedger(ledger.path).state, s => s !== 'open', deadline(30_000), { reconcileMs: 250 });
    const proof = JSON.parse(readFileSync(ledger.path.replace(/\.json$/, '.remote-cleanup.json'), 'utf8'));
    expect(proof).toMatchObject({ clean: true, reason: 'lease-expired' });
    expect(identityAlive(victim.identity)).toBe(false);
    for (const core of [cores.local, cores.dest]) { expect(existsSync(core.socket)).toBe(false); expect(processStart(core.pid)).toBeNull(); }
    await waitFor('guardian exits', () => processStart(guardian.pid!), s => s === null, deadline(10_000));
  }, 120_000);
});

describe('killed worker', () => {
  it('the out-of-group watchdog cleans up after its owner is SIGKILLed with its whole process group', async () => {
    const { root, ledgers } = await fixture();
    rmSync(join(ledgers, `${root.split('/').at(-1)}.json`));
    const resources = new URL('../resources.ts', import.meta.url).href;
    const worker = `
      import { openLedger, startWatchdog, identityOf } from ${JSON.stringify(resources)};
      import { spawn } from 'node:child_process';
      const ledger = openLedger(${JSON.stringify(ledgers)}, ${JSON.stringify(root)});
      startWatchdog(ledger, Date.now() + 120000, ${JSON.stringify(join(ledgers, 'watchdog.log'))});
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', ${JSON.stringify(join(root, 'payload'))}], { detached: true, stdio: 'ignore' });
      ledger.update(l => { l.processes.push({ ...identityOf(child.pid), label: 'payload', group: true }); });
      process.stdout.write('ready ' + child.pid + '\\n');
      setInterval(() => {}, 1000);`;
    const owner = spawn(process.execPath, ['--input-type=module', '-e', worker], { detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: '/usr/bin:/bin', TMPDIR: join(root, 't') } });
    const line = await new Promise<string>((resolve, reject) => { owner.stdout!.once('data', d => resolve(String(d))); owner.once('exit', c => reject(new Error(`worker exited ${c}`))); });
    const payloadPid = Number(/ready (\d+)/.exec(line)![1]);
    const ledgerPath = join(ledgers, `${root.split('/').at(-1)}.json`);
    const before = readLedger(ledgerPath);
    expect(before.watchdog).toBeDefined();
    const payload = before.processes.find(p => p.label === 'payload')!;
    expect(payload.pid).toBe(payloadPid);
    // The watchdog runs in its own session: killing the worker's process group must not reach it.
    process.kill(-owner.pid!, 'SIGKILL');
    await waitFor('ledger closed by watchdog', () => readLedger(ledgerPath).state, s => s !== 'open', deadline(30_000), { reconcileMs: 100 });
    const proof = JSON.parse(readFileSync(ledgerPath.replace(/\.json$/, '.cleanup.json'), 'utf8'));
    expect(proof).toMatchObject({ clean: true, reason: 'watchdog:owner-pipe-closed' });
    expect(identityAlive(payload)).toBe(false);
    await waitFor('watchdog exits', () => identityAlive(before.watchdog!), alive => !alive, deadline(10_000));
  });

  it('startup reconciliation finishes a ledger whose owner and watchdog both died', async () => {
    const { root, ledger, ledgers } = await fixture();
    const victim = spawnOwned(ledger, { label: 'orphan', stdio: { log: join(root, 'o.log') }, ...sleeper(root) });
    // Pretend the owner and watchdog are long dead by recording identities that cannot match.
    ledger.update(l => { l.owner = { pid: l.owner.pid, start: 'Thu Jan  1 00:00:00 1970' }; });
    const proofs = await reconcileLedgers(ledgers);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({ clean: true, reason: 'startup-reconciliation' });
    expect(identityAlive(victim.identity)).toBe(false);
    expect(await reconcileLedgers(ledgers)).toEqual([]);
  });
});

describe('spawned process identity', () => {
  it('names a just-spawned child that already exited, while liveness checks still treat it as gone', () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid!;
    // Stay synchronous: Node reaps children only when the event loop runs, so the exited child stays a zombie here.
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let stat = '';
    for (const until = Date.now() + 10000; Date.now() < until; Atomics.wait(pause, 0, 0, 20)) {
      stat = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' } }).trim();
      if (stat.startsWith('Z')) break;
    }
    expect(stat.startsWith('Z')).toBe(true);
    expect(processStart(pid)).toBeNull();
    expect(() => identityOf(pid)).toThrow(/process-identity-unavailable/);
    expect(spawnedIdentity(pid)).toEqual({ pid, start: expect.stringMatching(/\d{4}$/) });
  });
});
