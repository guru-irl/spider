// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assertSocketPath, buildEnvironment, createFencedDirectories, createFixtureRoot } from '../environment.js';
import { openLedger, cleanupLedger, readLedger, identityAlive, identityOf, rootProcesses } from '../resources.js';
import { spawnOwned } from '../processes.js';
import { startCores } from '../hc.js';
import { waitFor, deadline } from '../wait.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe('via transport fences', () => {
  it('records concurrent via identities independently and removes them on exit', async () => {
    const root = await createFixtureRoot(); roots.push(root);
    const ledgers = join(root, '..', '_test-ledgers', root.split('/').at(-1)!); mkdirSync(ledgers, { recursive: true }); roots.push(ledgers);
    const ledger = openLedger(ledgers, root);
    const env = buildEnvironment(process.env, await createFencedDirectories(root), { binDirectory: join(root, 'bin') });
    const socket = assertSocketPath(root, join(root, 'via-test.sock'));
    const directory = join(root, 'via-processes'); mkdirSync(directory, { mode: 0o700 });
    const server = createServer(client => client.end());
    ledger.update(l => { l.viaDirectory = directory; l.cores.push({ side: 'dest', namespace: 'd', socket, hcBinary: join(root, 'not-used'), env }); });
    const descriptor = join(root, 'via-test.json');
    writeFileSync(descriptor, JSON.stringify({ root, env: { ...env, HC_SESSION: 'd' }, log: join(root, 'via-test.log'), ledgerPath: ledger.path, socket, viaDirectory: directory }));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    const via = fileURLToPath(new URL('../../fixtures/via.mjs', import.meta.url));
    const line = `exec '${process.execPath}' -e 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'`;
    const processes = [1, 2].map(index => spawnOwned(ledger, { label: `via-${index}`, command: process.execPath, args: [via, descriptor, line], env, cwd: root, stdio: 'pipe' }));
    for (const process of processes) { process.child.stdout!.resume(); process.child.stderr!.resume(); }
    try {
      const records = await waitFor('both via identities registered', () => readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8'))),
        rows => processes.every(process => rows.some(row => row.pid === process.identity.pid && row.start === process.identity.start && row.child)), deadline(10_000));
      expect(records).toHaveLength(2);
      for (const process of processes) process.child.stdin!.end();
      for (const process of processes) expect((await process.exited).code).toBe(0);
      expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toEqual([]);
    } finally {
      for (const process of processes) if (identityAlive(process.identity)) await process.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      expect((await cleanupLedger(ledger.path, 'via-identity-test')).clean).toBe(true);
    }
  });

  it('reaps a live transport child after its via parent is killed', async () => {
    const root = await createFixtureRoot(); roots.push(root);
    const ledgers = join(root, '..', '_test-ledgers', root.split('/').at(-1)!); mkdirSync(ledgers, { recursive: true }); roots.push(ledgers);
    const ledger = openLedger(ledgers, root);
    const env = buildEnvironment(process.env, await createFencedDirectories(root), { binDirectory: join(root, 'bin') });
    const socket = assertSocketPath(root, join(root, 'via-test.sock'));
    const directory = join(root, 'via-processes'); mkdirSync(directory, { mode: 0o700 });
    const server = createServer(client => client.end());
    ledger.update(l => { l.viaDirectory = directory; l.cores.push({ side: 'dest', namespace: 'd', socket, hcBinary: join(root, 'not-used'), env }); });
    const descriptor = join(root, 'via-test.json');
    writeFileSync(descriptor, JSON.stringify({ root, env: { ...env, HC_SESSION: 'd' }, log: join(root, 'via-test.log'), ledgerPath: ledger.path, socket, viaDirectory: directory }));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    const via = fileURLToPath(new URL('../../fixtures/via.mjs', import.meta.url));
    const childScript = join(root, 'held-child.cjs'), childReady = join(root, 'held-child-ready');
    writeFileSync(childScript, `process.on('SIGHUP',()=>{});require('node:fs').writeFileSync(process.argv[2],'ready');setInterval(()=>{},1000);`);
    const line = `exec '${process.execPath}' '${childScript}' '${childReady}'`;
    const transport = spawnOwned(ledger, { label: 'killed-via', command: process.execPath, args: [via, descriptor, line], env, cwd: root, stdio: 'pipe' });
    transport.child.stdout!.resume(); transport.child.stderr!.resume();
    let child: { pid: number; start: string } | undefined;
    try {
      const record = await waitFor('via child registered', () => {
        try { return JSON.parse(readFileSync(join(directory, `${transport.identity.pid}.json`), 'utf8')); } catch { return null; }
      }, value => Boolean(value?.child), deadline(10_000));
      child = record.child;
      await waitFor('transport child ready', () => existsSync(childReady), Boolean, deadline(10_000));
      expect(identityAlive(child!)).toBe(true);
      process.kill(transport.identity.pid, 'SIGKILL');
      await transport.exited;
      expect(identityAlive(child!)).toBe(true);
      await new Promise<void>(resolve => server.close(() => resolve()));
      const proof = await cleanupLedger(ledger.path, 'orphaned-via-child');
      expect(proof.clean, JSON.stringify(proof.survivors)).toBe(true);
      expect(identityAlive(child!)).toBe(false);
      expect(proof.viaActions.some(action => action.pid === child!.pid && action.action === 'SIGTERM')).toBe(true);
      expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toEqual([]);
    } finally {
      transport.child.stdin!.end();
      if (identityAlive(transport.identity)) await transport.stop();
      if (child && identityAlive(child)) {
        process.kill(child.pid, 'SIGKILL');
        await waitFor('orphan-control child exits', () => identityAlive(child!), alive => !alive, deadline(5000));
      }
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      if (readLedger(ledger.path).state !== 'closed') expect((await cleanupLedger(ledger.path, 'orphan-control-finally')).clean).toBe(true);
    }
  });

  for (const blocked of ['teardown', 'dead socket', 'missing ledger'] as const) it(`refuses ${blocked} before running the transport`, async () => {
    const root = await createFixtureRoot(); roots.push(root);
    const ledgers = join(root, '..', '_test-ledgers', root.split('/').at(-1)!); mkdirSync(ledgers, { recursive: true }); roots.push(ledgers);
    const ledger = openLedger(ledgers, root);
    const env = buildEnvironment(process.env, await createFencedDirectories(root), { binDirectory: join(root, 'bin') });
    const socket = assertSocketPath(root, join(root, 'via-test.sock'));
    const server = createServer(client => client.end());
    const descriptor = join(root, 'via-test.json'), log = join(root, 'via-test.log'), viaDirectory = join(root, 'via-processes');
    mkdirSync(viaDirectory, { mode: 0o700 });
    ledger.update(l => { l.viaDirectory = viaDirectory; l.cores.push({ side: 'dest', namespace: 'd', socket, hcBinary: join(root, 'not-used'), env }); });
    writeFileSync(descriptor, JSON.stringify({ root, env: { ...env, HC_SESSION: 'd' }, log, ledgerPath: ledger.path, socket, viaDirectory }));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    const via = fileURLToPath(new URL('../../fixtures/via.mjs', import.meta.url));
    const run = async (target: string) => {
      const marker = join(root, target);
      const p = spawnOwned(ledger, { label: 'via-test', command: process.execPath, args: [via, descriptor, `printf fixture > '${marker}'`], env, cwd: root, stdio: 'pipe' });
      p.child.stdin!.end(); p.child.stdout!.resume(); p.child.stderr!.resume();
      return { result: await p.exited, marker };
    };
    try {
      const allowed = await run('allowed');
      expect(allowed.result.code).toBe(0);
      expect(readFileSync(allowed.marker, 'utf8')).toBe('fixture');
      if (blocked === 'teardown') ledger.update(l => { Object.assign(l, { tearingDown: true }); });
      else if (blocked === 'dead socket') await new Promise<void>(resolve => server.close(() => resolve()));
      else writeFileSync(descriptor, JSON.stringify({ root, env: { ...env, HC_SESSION: 'd' }, log, ledgerPath: join(root, 'missing-ledger.json'), socket, viaDirectory }));
      const refused = await run('refused');
      expect(refused.result.code).toBe(94);
      expect(existsSync(refused.marker)).toBe(false);
      expect(readdirSync(viaDirectory).filter(name => name.endsWith('.json'))).toEqual([]);
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      ledger.update(l => { Object.assign(l, { tearingDown: false }); });
      expect((await cleanupLedger(ledger.path, 'via-test')).clean).toBe(true);
    }
  });
});

describe('isolated hc cores', () => {
  it('cleans up after an abrupt destination death and drains reconnects', async () => {
    const root = await createFixtureRoot();
    const ledgers = join(root, '..', '_test-ledgers', root.split('/').at(-1)!); mkdirSync(ledgers, { recursive: true });
    const ledger = openLedger(ledgers, root);
    let proof: Awaited<ReturnType<typeof cleanupLedger>> | undefined;
    try {
      const env = buildEnvironment(process.env, await createFencedDirectories(root), { binDirectory: join(root, 'bin') });
      const cores = await startCores(ledger, root, env, join(root, 'bin'));
      const destination = identityOf(cores.dest.pid);
      expect(identityAlive(destination)).toBe(true);
      process.kill(destination.pid, 'SIGKILL');
      await waitFor('destination core exits', () => identityAlive(destination), alive => !alive, deadline(20_000));
      // A via process already past its liveness check may reconnect. Teardown must drain it and converge.
      proof = await cleanupLedger(ledger.path, 'dead-destination');
      writeFileSync(join(root, 'dead-destination-result.json'), JSON.stringify({ destination, proof, socket: cores.dest.socket }, null, 2));
      expect(proof.clean, JSON.stringify(proof.survivors)).toBe(true);
      expect(proof.phases).toEqual([{ phase: 'app-stopped', ok: true }, { phase: 'local-stopped', ok: true }, { phase: 'via-drained', ok: true }, { phase: 'destination-stopped', ok: true }]);
      const rounds = proof.verificationRounds.filter(round => round.side === 'dest');
      expect(rounds.length).toBeGreaterThan(0);
      expect(rounds.every(round => round.round <= 3)).toBe(true);
      expect(existsSync(cores.dest.socket)).toBe(false);
      expect(readdirSync(join(root, 'x/herdr-core/d')).filter(name => name.includes('.holder.'))).toEqual([]);
      expect(readdirSync(readLedger(ledger.path).viaDirectory!).filter(name => name.endsWith('.json'))).toEqual([]);
      expect(rootProcesses(root).filter(process => process.command.includes('hc hold'))).toEqual([]);
    } finally {
      if (!proof) proof = await cleanupLedger(ledger.path, 'dead-destination-finally');
      expect(proof.clean, JSON.stringify(proof.survivors)).toBe(true);
    }
  }, 120_000);

  it('starts two distinct fenced cores, reaches the destination through the local --via machine, records every call, and cleans up', async () => {
    const root = await createFixtureRoot(); roots.push(root);
    const ledgers = join(root, '..', '_test-ledgers', root.split('/').at(-1)!); mkdirSync(ledgers, { recursive: true }); roots.push(ledgers);
    const ledger = openLedger(ledgers, root);
    try {
      const dirs = await createFencedDirectories(root);
      const env = buildEnvironment(process.env, dirs, { binDirectory: join(root, 'bin') });
      const cores = await startCores(ledger, root, env, join(root, 'bin'));
      expect(cores.local.coreId).not.toBe(cores.dest.coreId);
      expect(cores.local.socket.startsWith(root + '/')).toBe(true);
      // A real terminal on the destination through the machine, proved by an effect only the destination home can see.
      const run = await cores.hc(['run', '--on', cores.machine, '--bg', '--no-notify', '--json', '--', '/bin/sh', '-c', 'printf "%s" "$HC_SESSION" > "$HOME/route-marker"']);
      expect(run.exitCode, run.stderr).toBe(0);
      const marker = join(cores.dest.env.HOME, 'route-marker');
      await waitFor('destination marker written', () => existsSync(marker) && readFileSync(marker, 'utf8'), v => v === 'd', deadline(20_000));
      expect(existsSync(join(cores.local.env.HOME, 'route-marker'))).toBe(false);
      const records = await cores.records();
      expect(records.some(r => r.argv[0] === 'run' && r.namespace === 'l')).toBe(true);
      expect(records.some(r => r.namespace === 'd')).toBe(true);
      expect(records.every(r => r.socket?.startsWith(root + '/'))).toBe(true);
      expect(readFileSync(cores.viaLog, 'utf8')).toContain('"line"');
      const viaDirectory = (readLedger(ledger.path) as { viaDirectory?: string }).viaDirectory;
      expect(typeof viaDirectory).toBe('string');
      const registrations = await waitFor('live via registration', () => readdirSync(viaDirectory!).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(viaDirectory!, name), 'utf8'))),
        rows => rows.some(identityAlive), deadline(10_000));
      expect(registrations.some(identityAlive)).toBe(true);
    } finally {
      const proof = await cleanupLedger(ledger.path, 'test');
      expect(proof.clean, JSON.stringify(proof.survivors)).toBe(true);
      const stopLocal = proof.coreActions.findIndex(action => action.side === 'local' && action.argv[0] === 'server' && action.argv[1] === 'stop');
      const inspectDest = proof.coreActions.findIndex(action => action.side === 'dest');
      expect(stopLocal).toBeGreaterThanOrEqual(0);
      expect(inspectDest).toBeGreaterThan(stopLocal);
      expect(readLedger(ledger.path).state).toBe('closed');
      expect(readdirSync(readLedger(ledger.path).viaDirectory!).filter(name => name.endsWith('.json'))).toEqual([]);
      for (const core of readLedger(ledger.path).cores) expect(existsSync(core.socket)).toBe(false);
    }
  });
});
