// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRoot, createFencedDirectories, buildEnvironment, type StoryId } from '../environment.js';
import { openLedger, identityAlive, cleanupLedger } from '../resources.js';
import { spawnOwned } from '../processes.js';
import { startCores } from '../hc.js';
import { waitFor, deadline } from '../wait.js';
import { createSuite } from '../suite.js';
import { remoteMachine, type RemoteSuite } from '../remote.js';
const guardian = fileURLToPath(new URL('../../fixtures/remote-guardian.mjs', import.meta.url));

afterEach(() => vi.unstubAllEnvs());
it('reads default terminal identities from disk without invoking a default core command', async () => {
  const root = await createFixtureRoot();
  const state = join(root, 'state/herdr-core/default'); await mkdir(state, { recursive: true });
  await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals: { '7': { id: 7 }, '2': { id: 2 } } }));
  const helper = await import(/* @vite-ignore */ guardian);
  try {
    const value = await helper.defaultInventory({ hcBinary: join(root, 'must-not-execute'), socket: join(root, 'absent.sock'), env: { HOME: root, XDG_STATE_HOME: join(root, 'state') }, wasListening: false });
    expect(value.terminals).toEqual([{ id: '2' }, { id: '7' }]);
    expect(value.machines).toEqual({ present: false });
    await writeFile(join(state, 'terminals.json'), '{invalid');
    await expect(helper.defaultInventory({ socket: join(root, 'absent.sock'), env: { HOME: root, XDG_STATE_HOME: join(root, 'state') } })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

describe('Tier 2 prerequisites', () => {
  it.each(['-option', 'user@fixture.invalid', 'fixture.invalid;true', 'fixture.invalid other.invalid'])('refuses unsafe destination %s before any SSH', machine => {
    expect(() => remoteMachine({ SPIDER_HERDR_E2E_REMOTE: machine })).toThrow('invalid-remote-destination');
  });
  it('refuses two conflicting environment destinations', () => {
    expect(() => remoteMachine({ SPIDER_HERDR_E2E_REMOTE: 'one.invalid', SPIDER_HERDR_REAL_MACHINE: 'two.invalid' })).toThrow('invalid-remote-destination');
  });
  it('accepts a single runtime alias from either supported environment variable', () => {
    expect(remoteMachine({ SPIDER_HERDR_E2E_REMOTE: 'one.invalid' })).toBe('one.invalid');
    expect(remoteMachine({ SPIDER_HERDR_REAL_MACHINE: 'two.invalid' })).toBe('two.invalid');
  });
  it('blocks without a runtime environment destination, even when a caller supplies a machine', async () => {
    vi.stubEnv('SPIDER_HERDR_REAL_MACHINE', ''); vi.stubEnv('SPIDER_HERDR_E2E_REMOTE', '');
    await expect(createSuite({ tier: 'remote', story: 'H-tier2-smoke' as StoryId, machine: 'fixture.invalid' }))
      .rejects.toMatchObject({ code: 'missing-prerequisite', message: expect.stringContaining('SPIDER_HERDR_REAL_MACHINE') });
  });
});

it.runIf(Boolean(process.env.SPIDER_HERDR_E2E_REMOTE || process.env.SPIDER_HERDR_REAL_MACHINE))('the opted-in installation guard requires the real owned packed input', async () => {
  const { remoteInstallOptions, validateRemoteInstallInputs } = await import('../../fixtures/remote-install-inputs.js');
  const { prepareInstallInputs } = await import('../../fixtures/install-inputs.js');
  const { assertDestinationPaths } = await import('../destination.js');
  const suite = await createSuite({ tier: 'remote', story: 'H-tier2-inputs' as StoryId, machine: 'dest.invalid' }) as RemoteSuite;
  try {
    await expect(prepareInstallInputs(suite)).rejects.toMatchObject({ code: 'P3-remote-install-inputs' });
    const m = suite.remote.metadata;
    const machines: Parameters<typeof validateRemoteInstallInputs>[1] = [{ name: suite.cores!.machine as Parameters<typeof validateRemoteInstallInputs>[1][number]['name'], aliases: [], runtime: { directory: m.root + '/runtime', cwd: m.root + '/work', commands: { shell: ['/bin/sh'] } } }];
    await expect(validateRemoteInstallInputs(suite, machines)).rejects.toMatchObject({ code: 'P3-remote-install-inputs' });
    const options = await remoteInstallOptions(suite);
    await validateRemoteInstallInputs(suite, options.machines!);
    await expect(validateRemoteInstallInputs(suite, [{ ...options.machines![0], runtime: { ...options.machines![0].runtime, directory: suite.root + '/runtime' } }])).rejects.toMatchObject({ code: 'outside-owned-root' });
    expect((await suite.remote.exec(`ln -s work '${m.root}/linked'`)).exitCode).toBe(0);
    await expect(assertDestinationPaths(suite, [m.root + '/linked/file'])).rejects.toMatchObject({ code: 'destination-path-unproved' });
    expect((await suite.remote.exec(`printf corrupt > '${m.root}/inputs/packed-runtime.mjs'`)).exitCode).toBe(0);
    await expect(validateRemoteInstallInputs(suite, options.machines!)).rejects.toMatchObject({ code: 'P3-remote-install-inputs' });
    await suite.evidence('input-controls.json', { absentRefused: true, localPathRefused: true, symlinkRefused: true, corruptRefused: true, packedAccepted: true });
  } finally { await suite.close(); }
}, 180_000);

it.runIf(Boolean(process.env.SPIDER_HERDR_E2E_REMOTE || process.env.SPIDER_HERDR_REAL_MACHINE))('the opted-in guardian streams an expiry proof with renewal control stopped', async () => {
  const suite = await createSuite({ tier: 'remote', story: 'H-tier2-expiry-reason' as StoryId, machine: process.env.SPIDER_HERDR_E2E_REMOTE ?? process.env.SPIDER_HERDR_REAL_MACHINE! }) as RemoteSuite;
  try {
    expect((await suite.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--', 'perl', '-e', 'alarm shift; exec @ARGV', '90', suite.remote.metadata.nodePath, '-e', 'setInterval(()=>{},1000)'], 'dest')).exitCode).toBe(0);
    const lease = await suite.remote.abandon({ disconnectObserver: false });
    // Guardian stdin has been closed since launch. This retained stream cannot renew or control it.
    await waitFor('renewal-free lease expires', () => Date.now(), n => n >= lease.expiresAt, deadline(20_000));
    expect((await suite.close()).clean).toBe(true);
    const result = JSON.parse(await readFile(join(suite.evidenceDirectory, 'remote-final.json'), 'utf8'));
    expect(result.guardian).toMatchObject({ reason: 'lease-expired', clean: true, rootRemoved: true, survivors: [] });
    expect(result.guardian.defaultAfter).toEqual(result.guardian.defaultBefore);
  } finally { await suite.close(); }
}, 180_000);

it.runIf(Boolean(process.env.SPIDER_HERDR_E2E_REMOTE || process.env.SPIDER_HERDR_REAL_MACHINE))('lease expiry on the opted-in destination cleans without the local control connection', async () => {
  const suite = await createSuite({ tier: 'remote', story: 'H-tier2-expiry' as StoryId, machine: process.env.SPIDER_HERDR_E2E_REMOTE ?? process.env.SPIDER_HERDR_REAL_MACHINE! }) as RemoteSuite;
  try {
    expect(suite.env.HOME.startsWith(suite.root + '/')).toBe(true);
    expect(suite.env.SSH_AUTH_SOCK).toBeUndefined();
    const launched = await suite.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--', 'perl', '-e', 'alarm shift; exec @ARGV', '90', suite.remote.metadata.node, '-e', 'setInterval(()=>{},1000)'], 'dest');
    expect(launched.exitCode).toBe(0);
    await suite.evidence('expiry-terminal.json', launched);
    const before = await suite.remote.snapshot();
    expect(before).toMatchObject({ rootExists: true, socketListening: true, coreAlive: true, guardianAlive: true });
    expect(before.rootProcesses.length).toBeGreaterThan(0);
    await suite.evidence('expiry-before.json', before);
    const lease = await suite.remote.abandon();
    // No SSH observation or control operation happens until the remotely recorded lease deadline has elapsed.
    await waitFor('remote lease deadline elapsed with all control disconnected', () => Date.now(), n => n >= lease.expiresAt, deadline(20_000), { reconcileMs: 100 });
    const proof = await suite.close();
    expect(proof.clean).toBe(true);
    const after = JSON.parse(await readFile(join(suite.evidenceDirectory, 'remote-final.json'), 'utf8'));
    expect(after).toMatchObject({ observerDisconnected: true, after: { rootExists: false, socketListening: false, coreAlive: false, guardianAlive: false, rootProcesses: [] } });
    expect(after.after.defaultAfter).toEqual(suite.remote.metadata.defaultBefore);
  } finally { await suite.close(); }
}, 180_000);

it.runIf(Boolean(process.env.SPIDER_HERDR_E2E_REMOTE || process.env.SPIDER_HERDR_REAL_MACHINE))('the next invocation recovers a killed remote guardian without claiming the first cleanup passed', async () => {
  const options = { tier: 'remote' as const, story: 'H-tier2-recovery' as StoryId, machine: process.env.SPIDER_HERDR_E2E_REMOTE ?? process.env.SPIDER_HERDR_REAL_MACHINE! };
  const prior = await createSuite(options) as RemoteSuite;
  let next: RemoteSuite | undefined;
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  try {
    expect((await prior.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--', 'perl', '-e', 'alarm shift; exec @ARGV', '180', prior.remote.metadata.nodePath, '-e', 'setInterval(()=>{},1000)'], 'dest')).exitCode).toBe(0);
    await prior.remote.abandon();
    const m = prior.remote.metadata;
    const kill = `const h=await import(${JSON.stringify(m.root + '/guardian.mjs')});if(h.processStart(${m.guardianPid})!==${JSON.stringify(m.guardianStart)})throw new Error('guardian-identity-changed');process.kill(${m.guardianPid},'SIGKILL');`;
    expect((await prior.remote.exec(`${quote(m.nodePath)} --input-type=module -e ${quote(kill)}`)).exitCode).toBe(0);
    await expect(prior.close()).rejects.toMatchObject({ code: 'cleanup-unproved' });
    const failed = JSON.parse(await readFile(prior.cleanupProofPath, 'utf8'));
    expect(failed.clean).toBe(false);
    expect(failed.survivors).toContainEqual(expect.objectContaining({ kind: 'remote-cleanup-unverified' }));
    next = await createSuite(options) as RemoteSuite;
    const path = join(next.evidenceDirectory, `reconciled-${prior.ledger.id}.remote.json`);
    const reconciled = JSON.parse(await readFile(path, 'utf8'));
    expect(reconciled.metadata.root).toBe(m.root);
    expect(reconciled.observed).toMatchObject({ rootExists: false, socketListening: false, coreAlive: false, guardianAlive: false, rootProcesses: [] });
    expect(reconciled.observed.defaultAfter).toEqual(m.defaultBefore);
    expect((await next.close()).clean).toBe(true);
  } finally {
    if (next) await next.close();
    // A refused cleanup remains a refused cleanup, even after a later invocation repairs its ledger.
    try { await prior.close(); } catch { /* asserted and recorded above */ }
  }
}, 180_000);

it('expiry independently removes the owned folder, terminals and cores and streams its proof', async () => {
  const root = await createFixtureRoot(); const dirs = await createFencedDirectories(root);
  const ledgerDir = join(root, '..', '_remote-test-ledgers', root.split('/').at(-1)!);
  const ledger = openLedger(ledgerDir, root);
  const env = buildEnvironment(process.env, dirs, { binDirectory: join(root, 'bin') });
  const cores = await startCores(ledger, root, env, join(root, 'bin'));
  const payload = spawnOwned(ledger, { label: 'payload', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)', join(root, 'payload')], env, cwd: root, stdio: 'pipe' });
  expect((await cores.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--', process.execPath, '-e', 'setInterval(()=>{},1000)'])).exitCode).toBe(0);
  const lease = join(root, 'lease.json'); await writeFile(lease, JSON.stringify({ version: 1, expiresAt: Date.now() + 1500 }));
  const child = spawn(process.execPath, [guardian, ledger.path, lease, '--remove-root'], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout!.on('data', d => { out += d; }); child.stderr!.on('data', d => { err += d; });
  try {
    const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
    expect(err).toBe(''); expect(exit).toBe(0); expect(out).toContain('guardian-ready'); expect(existsSync(root)).toBe(false);
    expect(identityAlive(payload.identity)).toBe(false); expect(existsSync(cores.local.socket)).toBe(false); expect(existsSync(cores.dest.socket)).toBe(false);
    const proof = JSON.parse(out.split('\n').find(line => line.startsWith('{'))!);
    expect(proof).toMatchObject({ reason: 'lease-expired', clean: true, rootRemoved: true, survivors: [] });
  } finally {
    child.kill('SIGKILL'); await cleanupLedger(ledger.path, 'test-finally');
    await rm(root, { recursive: true, force: true }); await rm(ledgerDir, { recursive: true, force: true });
  }
}, 90_000);

it('refuses a default core ledger before acknowledging readiness or issuing commands', async () => {
  const root = await createFixtureRoot(); await mkdir(join(root, 't'));
  const ledger = join(root, 'ledger.json'), lease = join(root, 'lease.json');
  await writeFile(ledger, JSON.stringify({ version: 1, id: 'unsafe', root, state: 'open', processes: [], cores: [{ namespace: 'default', socket: join(root, 'default.sock'), env: {} }] }));
  await writeFile(lease, JSON.stringify({ version: 1, expiresAt: Date.now() }));
  const child = spawn(process.execPath, [guardian, ledger, lease, '--remove-root'], { env: { PATH: '/usr/bin:/bin', TMPDIR: join(root, 't') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout!.on('data', d => { out += d; }); child.stderr!.on('data', d => { err += d; });
  const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
  try { expect(exit).not.toBe(0); expect(out).not.toContain('guardian-ready'); expect(err).toContain('unsafe-remote-ledger'); expect(existsSync(root)).toBe(true); }
  finally { await rm(root, { recursive: true, force: true }); }
});

it('clears synthetic inherited secrets at the SSH payload boundary', async () => {
  const root = await createFixtureRoot(), recipient = join(root, 'recipient'), config = join(root, 'transport.json');
  await writeFile(recipient, '#!/bin/sh\nfor arg do last="$arg"; done\nexec /bin/sh -c "$last"\n', { mode: 0o700 });
  await writeFile(config, JSON.stringify({ machine: 'fixture.invalid', sshBinary: recipient, log: join(root, 'transport.jsonl'), seconds: 5, prefix: '', remoteEnv: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root }, env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, HERDR_FIXTURE_SECRET: 'synthetic-only' } }), { mode: 0o600 });
  const result = spawnSync(process.execPath, [guardian, '--transport', config, 'fixture.invalid', 'test -z "$HERDR_FIXTURE_SECRET" || exit 71; printf clean'], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root }, encoding: 'utf8' });
  try { expect(result.status).toBe(0); expect(result.stdout).toBe('clean'); }
  finally { await rm(root, { recursive: true, force: true }); }
});

it('finishes root removal when a prior cleanup already closed the remote ledger', async () => {
  const root = await createFixtureRoot(); await mkdir(join(root, 't'));
  const ledger = join(root, 'ledger.json'), lease = join(root, 'lease.json');
  await writeFile(ledger, JSON.stringify({ version: 1, id: 'closed', root, state: 'closed', cores: [], processes: [] }));
  await writeFile(lease, JSON.stringify({ version: 1, expiresAt: Date.now() }));
  const child = spawn(process.execPath, [guardian, ledger, lease, '--remove-root'], { env: { PATH: '/usr/bin:/bin', TMPDIR: join(root, 't') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout!.on('data', d => { out += d; });
  const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    expect(exit).toBe(0); expect(existsSync(root)).toBe(false);
    expect(JSON.parse(out.split('\n').find(line => line.startsWith('{'))!)).toMatchObject({ clean: true, rootRemoved: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses an unregistered root layout instead of removing an arbitrary private folder', async () => {
  const parent = await createFixtureRoot(), root = join(parent, 'unregistered');
  await mkdir(root, { mode: 0o700 });
  const ledger = join(root, 'ledger.json'), lease = join(root, 'lease.json');
  await writeFile(ledger, JSON.stringify({ version: 1, id: 'foreign', root, state: 'open', cores: [], processes: [] }));
  await writeFile(lease, JSON.stringify({ version: 1, expiresAt: Date.now() }));
  const child = spawn(process.execPath, [guardian, ledger, lease, '--remove-root'], { env: { PATH: '/usr/bin:/bin', TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout!.on('data', d => { out += d; }); child.stderr!.on('data', d => { err += d; });
  const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
  try { expect(exit).not.toBe(0); expect(out).not.toContain('guardian-ready'); expect(err).toContain('unsafe-remote-ledger'); expect(existsSync(root)).toBe(true); }
  finally { await rm(parent, { recursive: true, force: true }); }
});

it('refuses a socket symlink before acknowledging readiness', async () => {
  const root = await createFixtureRoot(); await mkdir(join(root, 't'));
  const ledger = join(root, 'ledger.json'), lease = join(root, 'lease.json'), socket = join(root, 'owned.sock');
  await symlink(join(root, '..', 'foreign.sock'), socket);
  await writeFile(ledger, JSON.stringify({ version: 1, id: 'link', root, state: 'open', processes: [], cores: [{ namespace: 'owned', socket, env: { HC_SESSION: 'owned', HOME: join(root, 'h'), TMPDIR: join(root, 't'), XDG_STATE_HOME: join(root, 'x'), XDG_CONFIG_HOME: join(root, 'c') } }] }));
  await writeFile(lease, JSON.stringify({ version: 1, expiresAt: Date.now() }));
  const child = spawn(process.execPath, [guardian, ledger, lease, '--remove-root'], { env: { PATH: '/usr/bin:/bin', TMPDIR: join(root, 't') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout!.on('data', d => { out += d; }); child.stderr!.on('data', d => { err += d; });
  const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
  try { expect(exit).not.toBe(0); expect(out).not.toContain('guardian-ready'); expect(err).toContain('unsafe-remote-ledger'); expect(existsSync(root)).toBe(true); }
  finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['HC_SOCKET', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'XDG_RUNTIME_DIR'])('refuses an inherited %s escape in a guardian core environment', async key => {
  const root = await createFixtureRoot(); await mkdir(join(root, 't'));
  const ledger = join(root, 'ledger.json'), lease = join(root, 'lease.json');
  const env = { HC_SESSION: 'owned', HOME: join(root, 'h'), TMPDIR: join(root, 't'), XDG_STATE_HOME: join(root, 'x'), XDG_CONFIG_HOME: join(root, 'c'), [key]: key === 'HC_SCOPE' ? 'default' : join(root, '..', 'foreign.sock') };
  await writeFile(ledger, JSON.stringify({ version: 1, id: 'escape', root, state: 'open', processes: [], cores: [{ namespace: 'owned', socket: join(root, 'owned.sock'), env }] }));
  await writeFile(lease, JSON.stringify({ version: 1, expiresAt: Date.now() }));
  const child = spawn(process.execPath, [guardian, ledger, lease, '--remove-root'], { env: { PATH: '/usr/bin:/bin', TMPDIR: join(root, 't') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout!.on('data', d => { out += d; }); child.stderr!.on('data', d => { err += d; });
  const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
  try { expect(exit).not.toBe(0); expect(out).not.toContain('guardian-ready'); expect(err).toContain('unsafe-remote-ledger'); expect(existsSync(root)).toBe(true); }
  finally { await rm(root, { recursive: true, force: true }); }
});

it('an independent supervisor renews the lease only until its owner pipe closes', async () => {
  const root = await createFixtureRoot(); await mkdir(join(root, 't'));
  const lease = join(root, 'lease.json'), config = join(root, 'supervisor.json'), recipient = join(root, 'recipient');
  await writeFile(recipient, '#!/bin/sh\nfor last do :; done\nexec /bin/sh -c "$last"\n', { mode: 0o700 });
  await writeFile(lease, JSON.stringify({ version: 1, expiresAt: 0 }));
  await writeFile(config, JSON.stringify({ sshBinary: recipient, machine: 'fixture.invalid', env: { PATH: '/usr/bin:/bin', TMPDIR: join(root, 't') }, leasePath: lease, deadlineAt: Date.now() + 10_000, leaseMs: 1500, renewMs: 100, remoteNode: process.execPath, remoteTmp: join(root, 't') }));
  const child = spawn(process.execPath, [guardian, '--supervise', config], { detached: true, env: { PATH: '/usr/bin:/bin', TMPDIR: join(root, 't') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = ''; child.stderr!.on('data', d => { err += d; });
  try {
    const initial = await waitFor('supervisor renews', async () => JSON.parse(await readFile(lease, 'utf8')).expiresAt as number, n => n > Date.now(), deadline(5000));
    await waitFor('a second renewal', async () => JSON.parse(await readFile(lease, 'utf8')).expiresAt as number, n => n > initial, deadline(5000));
    child.stdin!.end(); const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
    expect(exit).toBe(0); expect(err).toBe(''); const last = JSON.parse(await readFile(lease, 'utf8')).expiresAt;
    await waitFor('lease expires without further renewal', () => Date.now() >= last, Boolean, deadline(5000));
    expect(JSON.parse(await readFile(lease, 'utf8')).expiresAt).toBe(last);
  } finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});
