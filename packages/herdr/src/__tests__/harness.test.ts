// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync, statSync } from 'node:fs';
import net from 'node:net';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { HERDR_LABELS } from '../contracts.js';
import type { TerminalAddress, MachineName } from '../contracts.js';
import { afterEach, test, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { selectedSocket } from '../client/parse.js';
import { spawnSync } from 'node:child_process';
import { fenceHerdrTestEnvironment } from '../../../../vitest.setup.js';
import { runAcceptance } from './scenarios.js';
import type { HerdrHarness } from './isolated.js';
import { createHerdrHarness, proveSocketPaths, seedAppWindow } from './isolated.js';
import { createClientFixture, type ClientFixture } from './testutil.js';
import { createHcClient, invokeCli } from '../client/hc.js';
if (process.env.SPIDER_HERDR_APP_TESTS !== '1') console.info('SKIP real app windows: require the user opt-in SPIDER_HERDR_APP_TESTS=1 and SPIDER_HERDR_TEST_DISPLAY_UUID');
const fixtures: ClientFixture[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const h of fixtures.splice(0)) await h.close(); });
test('production defaults cannot reach a socket outside the test root', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  const env = { ...h.localEnv }; delete env.HC_SOCKET; delete env.HC_TERMINAL_SOCKET; delete env.XDG_RUNTIME_DIR;
  expect(selectedSocket(env, { isDirectory: () => false })).toBe(join(h.localEnv.XDG_STATE_HOME!, 'herdr-core/fl/fl.sock'));
  const realDefault = join(homedir(), '.local/state/herdr-core/default/default.sock');
  const socketState = () => existsSync(realDefault) ? statSync(realDefault, { bigint: true }).mtimeNs : null;
  const before = socketState();
  delete env.XDG_STATE_HOME; delete env.HC_SESSION; delete env.HC_TERMINAL_ID;
  // A broken guard must fail this test without contacting the user's socket.
  const connection = vi.spyOn(net, 'connect').mockImplementation(() => { throw new Error('Unexpected default-core connection'); });
  try {
    await expect(Promise.resolve().then(() => createHcClient({ binary: h.hcBinary, env }).identity())).rejects.toMatchObject({ code: 'isolation-unproved' });
    expect(connection).not.toHaveBeenCalled();
    expect(await h.calls()).toEqual([]);
    expect(socketState()).toBe(before);
  } finally { connection.mockRestore(); }
});
test('the test environment deletes inherited HC and Herdr values and blocks default executables', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  const original = { ...process.env };
  try {
    process.env.HC_TEST_INHERITED = 'unsafe'; process.env.HERDR_TEST_INHERITED = 'unsafe';
    fenceHerdrTestEnvironment(process.cwd(), h.root);
    expect(Object.keys(process.env).filter(k => k.startsWith('HC_') || k.startsWith('HERDR_'))).toEqual([]);
    for (const binary of ['hc', 'herdr-app']) {
      const reply = spawnSync(binary, ['--version'], { encoding: 'utf8', env: process.env });
      expect(reply.status).not.toBe(0); expect(reply.stderr).toContain('real hc is disabled in tests');
    }
  } finally { for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k]; Object.assign(process.env, original); }
});
test('the global test fence blocks SSH before any inherited fallback can run', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  const original = { ...process.env };
  const marker = join(h.root, 'fallback-ran');
  try {
    const fallbackBin = join(h.root, 'inherited-bin'); await mkdir(fallbackBin);
    const fallback = join(fallbackBin, 'ssh');
    await writeFile(fallback, `#!/bin/sh\nprintf unsafe > ${JSON.stringify(marker)}\n`); await chmod(fallback, 0o700);
    process.env.PATH = `${fallbackBin}:${process.env.PATH}`;
    fenceHerdrTestEnvironment(process.cwd(), h.root);
    for (const destination of ['elsewhere.invalid', '2001:db8::1', '192.0.2.1', '198.51.100.1', '203.0.113.1']) {
      const reply = spawnSync('/bin/sh', ['-c', 'ssh "$1" echo forbidden', 'fixture', destination], { encoding: 'utf8', env: process.env });
      expect(reply.status).toBe(91);
      expect(reply.stderr).toContain('real ssh is disabled in tests');
      expect(existsSync(marker)).toBe(false);
    }
  } finally { for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k]; Object.assign(process.env, original); }
});

async function assertFakeSshResolution(mode: 'fake' | 'hc') {
  const h = await createHerdrHarness(mode);
  try {
    await h.scenario({ ssh: { exitCode: 17, stdout: 'fixture-only\n' } });
    for (const env of [h.localEnv, h.remoteEnv]) {
      const resolution = spawnSync('/bin/sh', ['-c', 'command -v ssh'], { encoding: 'utf8', env });
      expect(resolution.status).toBe(0);
      // Do not run a transport until resolution proves that it is fixture-owned.
      expect(resolution.stdout.trim()).toBe(h.sshBinary);
      const reply = spawnSync('ssh', ['elsewhere.invalid', 'echo', 'ok'], { encoding: 'utf8', env });
      expect(reply.status).toBe(17); expect(reply.stdout).toBe('fixture-only\n');
    }
    expect(await readFile(join(h.root, 'ssh-calls.jsonl'), 'utf8')).toContain('elsewhere.invalid');
  } finally { await h.close(); }
}
test('the fake harness always resolves its own fake SSH without starting a core', () => assertFakeSshResolution('fake'));
test.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('the hc harness always resolves its own fake SSH without starting a core; requires SPIDER_HERDR_E2E=1', () => assertFakeSshResolution('hc'));

test('reads the local observer screen rather than assuming pane readiness', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  await h.configure({ reply: JSON.stringify({ text: 'WAIT nonce-123\n', complete: true, how: 'history' }) });
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  expect(await client.read(h.address('t1'), { lines: 100 })).toBe('WAIT nonce-123\n');
  expect((await h.calls())[0].argv).toEqual(['read', 't1', '--json', '--lines', '100']);
});
test('refuses mutation until both cores are proved isolated', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await expect(h.withUnprovedSocket().start()).rejects.toMatchObject({ code: 'isolation-unproved' });
    expect(h.mutations()).toEqual([]);
    await h.start(); expect(h.localCoreId).not.toBe(h.remoteCoreId);
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
  } finally { await h.close(); }
});

test.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('isolated hc uses a distinct local transport core and cleans up', async () => {
  const h = await createHerdrHarness('hc');
  try { await h.start(); expect(h.localCoreId).not.toBe(h.remoteCoreId);
    try { await h.hc.fileRead('remote.invalid' as MachineName, h.directories.remote + '/missing-file'); throw new Error('Missing file unexpectedly read'); }
    catch (error) { const e = error as { code: string; message: string; details?: { hint?: unknown } }; if (!e.code) throw error; await writeFile('.spider/scratch/h/captured-file-read-error.json', JSON.stringify({ error: { kind: e.code, message: e.message, hint: e.details?.hint ?? null } })); }
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
  finally { await h.close(); }
});

test('checks UTF-8 holder socket paths before starting a core', () => {
  const root = '/fixture/' + 'α'.repeat(30);
  const socket = root + '/herdr-core/l/l.sock';
  expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
  expect(() => proveSocketPaths(root, [socket])).toThrowError(/103/);
});

test('scenario JSON drives early finishes, held adoption, remote files and fake SSH argv', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    await h.scenario({ steps: [{ argvPrefix: ['run'], argvIncludes: ['--on', 'remote.invalid'], once: true, delayMs: 150,
      beforeReply: [
        { jsonrpc: '2.0', method: 'event', params: { type: 'created', seq: 100, terminal: 'remote.invalid/t99', data: { address: 'remote.invalid/t99', parent: h.owner!.terminal.address, labels: {}, state: 'live', status: null, exit_code: null, reason: null, signal: null, finished_ms: null } } },
        { jsonrpc: '2.0', method: 'event', params: { type: 'finished', seq: 101, terminal: 'remote.invalid/t99', data: { exit_code: 23, reason: 'exited', signal: null, finished_ms: 12345 } } },
      ], reply: { address: 'remote.invalid/t99', state: 'live', parent: h.owner!.terminal.address, agent: 'node', cwd: '/fixture', turn: 0 } }], app: { holdAdoption: true }, ssh: { stdout: 'ssh output\n', stderr: 'ssh diagnostic\n', exitCode: 23 } });
    const stream = h.hc.events(); await stream.ready; let replied = false;
    const launch = h.hc.run({ argv: [h.nodeBinary, '-e', 'process.exit(23)'], cwd: null, on: 'remote.invalid' as MachineName, labels: {}, outliveParent: true, background: true, noNotify: true }).then(result => { replied = true; return result; });
    await expect.poll(() => stream.lookup('remote.invalid/t99' as TerminalAddress)).toMatchObject({ state: 'finished', exitCode: 23 });
    expect(replied).toBe(false); expect((await launch).address).toBe('remote.invalid/t99');
    await h.scenario({ files: { '/sample.json': '{"sample":23}\n' } }, 'remote');
    expect((await h.hc.fileRead('remote.invalid' as MachineName, '/sample.json')).toString()).toBe('{"sample":23}\n');
    const file = h.directories.remote + '/written.txt'; await h.hc.fileWrite('remote.invalid' as MachineName, file, Buffer.from('α\n'));
    expect((await h.hc.fileRead('remote.invalid' as MachineName, file)).toString()).toBe('α\n');
    const viewer = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: h.root, labels: { [HERDR_LABELS.space]: 's1', [HERDR_LABELS.tab]: 'tb1' }, parent: null, outliveParent: true, background: true, noNotify: true });
    const owner = await h.app.ownerPlacement(h.owner!.terminal.address);
    await expect(h.app.awaitPane(viewer.address, owner, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'pane-timeout' });
    await h.scenario({ app: { holdAdoption: false }, ssh: { stdout: 'ssh output\n', stderr: 'ssh diagnostic\n', exitCode: 23 } });
    expect(await h.app.awaitPane(viewer.address, owner, { timeoutMs: 500 })).toBeTruthy();
    expect(await h.hc.read(viewer.address, { lines: 100 })).not.toContain('nonce-ready');
    const ssh = spawnSync(h.sshBinary, ['-p', '2222', 'host.invalid', "a 'quoted' value"], { encoding: 'utf8', env: h.localEnv });
    expect(ssh.status).toBe(23); expect(ssh.stdout).toBe('ssh output\n'); expect(ssh.stderr).toBe('ssh diagnostic\n');
    expect(JSON.parse(await readFile(h.root + '/ssh-calls.jsonl', 'utf8'))).toEqual(['-p', '2222', 'host.invalid', "a 'quoted' value"]);
    expect((await h.calls()).filter(c => c.argv[0] === 'run').every(c => c.argv.includes('--no-notify'))).toBe(true);
  } finally { await h.close(); }
});

test('the parsers accept real scrubbed recordings and the fake preserves native reply shapes', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  const record = async (name: string) => JSON.parse(await readFile(new URL('./recordings/' + name, import.meta.url), 'utf8'));
  const core = await record('core-status.json'); await h.configure({ reply: JSON.stringify(core) });
  expect((await createHcClient({ binary: h.hcBinary, env: h.localEnv }).identity()).coreId).toBe(core.core.id);
  const get = await record('get.json'); await h.configure({ reply: JSON.stringify(get) });
  expect(await createHcClient({ binary: h.hcBinary, env: h.localEnv }).get(h.address('remote.invalid/t3'))).toMatchObject({ address: 'remote.invalid/t3', state: 'live', parent: 't2' });
  const machines = await record('machines.json'); await h.configure({ reply: JSON.stringify(machines) });
  expect(await createHcClient({ binary: h.hcBinary, env: h.localEnv }).machines()).toMatchObject([{ name: 'remote.invalid', state: 'disconnected' }]);
  const read = await record('read.json'); await h.configure({ reply: JSON.stringify(read) });
  expect(await createHcClient({ binary: h.hcBinary, env: h.localEnv }).read(h.address('t1'), { lines: 100 })).toBe(read.text);
  await h.configure({ reply: undefined, machines: machines.machines, terminals: [get] });
  const nativeGet = await invokeCli(h.hcBinary, ['get', 'remote.invalid/t3', '--json'], h.localEnv);
  expect(nativeGet).toEqual(get);
  const nativeRun = await invokeCli(h.hcBinary, ['run', '--json', '--bg', '--no-notify', '--on', 'remote.invalid', '--', 'node', '-e', 'process.exit(0)'], h.localEnv);
  expect(Object.keys(nativeRun as object).sort()).toEqual(Object.keys(await record('run.json')).sort());
  for (const name of ['terminal-read-error.json', 'file-read-error.json']) {
    const error = await record(name); await h.configure({ failure: error.error, failureExitCode: 3 });
    await expect(invokeCli(h.hcBinary, ['read', 'missing.invalid', '--json'], h.localEnv)).rejects.toMatchObject({ code: error.error.kind, message: error.error.message, details: { exitCode: 3 } });
  }
});
test('recorded lifecycle notifications retain the original finished event', async () => {
  const h = await createClientFixture(); fixtures.push(h); const client = createHcClient({ binary: h.hcBinary, env: h.localEnv }); const stream = client.events();
  try {
    await stream.ready; const seen: string[] = []; stream.subscribe(e => seen.push(e.type));
    const lines = (await readFile(new URL('./recordings/events.jsonl', import.meta.url), 'utf8')).trim().split('\n');
    for (const line of lines) await h.emitCore(line + '\n');
    await expect.poll(() => seen).toEqual(['snapshot', 'snapshot', 'created', 'status', 'finished', 'lost', 'restarted', 'removed']);
    expect(await stream.lookup(h.address('remote.invalid/t11'))).toMatchObject({ state: 'finished', exitCode: 23 });
  } finally { await client.dispose(); }
});

test('close stops both owned cores when inventory fails and preserves the failure', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    await h.scenario({ steps: [{ argvPrefix: ['ls'], exitCode: 2, stderr: 'inventory failed' }] });
    await expect(h.close()).rejects.toThrow('CLI exited with 2');
    expect(await h.remainingOwnedResources()).toEqual([]);
  } finally {
    // Also cleans the original broken implementation while demonstrating the regression.
    await h.scenario({}).catch(() => {});
    await h.close().catch(() => {});
  }
}, 30000);

test('close terminates an owned daemon even if its stop command fails', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    await h.scenario({ steps: [{ argvPrefix: ['server', 'stop'], exitCode: 2, stderr: 'stop failed' }] });
    await expect(h.close()).rejects.toThrow('CLI exited with 2');
    expect(await h.remainingOwnedResources()).toEqual([]);
  } finally {
    await h.scenario({}).catch(() => {});
    await h.close().catch(() => {});
  }
}, 30000);

test('acceptance propagates an assertion failure and still proves fixture cleanup', async () => {
  let fixture: HerdrHarness | null = null;
  await expect(runAcceptance('failure cleanup', async h => { fixture = h; throw Object.assign(new Error('Scenario failure'), { code: 'scenario-sentinel' }); })).rejects.toMatchObject({ code: 'scenario-sentinel' });
  expect(fixture).not.toBeNull(); expect(await fixture!.remainingOwnedResources()).toEqual([]);
});
test.skipIf(process.env.SPIDER_HERDR_APP_E2E !== '1' || process.env.SPIDER_HERDR_APP_TESTS !== '1')('the fenced app observes the actual owner pane and closes only its own window', async () => {
  const h = await createHerdrHarness('app');
  try { await h.start(); expect(await h.app.ownerPlacement(h.owner!.terminal.address)).toMatchObject({ space: expect.any(String), tab: expect.any(String), pane: expect.any(String) }); }
  finally { await h.close(); }
  expect(await h.remainingOwnedResources()).toEqual([]);
});

test('explicit real requests fail before launch when binaries or the approved app launcher are absent', async () => {
  vi.stubEnv('SPIDER_HERDR_E2E', '1'); vi.stubEnv('SPIDER_HERDR_HC_BINARY', process.cwd() + '/.spider/scratch/h/missing-binary');
  await expect(createHerdrHarness('hc')).rejects.toMatchObject({ code: 'missing-binary' });
  vi.stubEnv('SPIDER_HERDR_APP_E2E', '1'); vi.stubEnv('SPIDER_HERDR_APP_LAUNCHER', '');
  await expect(createHerdrHarness('app')).rejects.toMatchObject({ code: 'app-launch-disabled' });
});
test('the scenario file store preserves UTF-8 across large socket replies', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start(); const content = 'α😀'.repeat(40000); await h.scenario({ files: { '/unicode.txt': content } }, 'remote');
    expect((await h.hc.fileRead('remote.invalid' as MachineName, '/unicode.txt')).toString('utf8')).toBe(content);
  } finally { await h.close(); }
});

test('refuses the default socket with an absolute hc path before it can spawn', () => {
  const env = { ...process.env }; for (const k of Object.keys(env)) if (k.startsWith('HC_')) delete env[k]; delete env.XDG_STATE_HOME;
  expect(selectedSocket(env)).toBe(join(homedir(), '.local/state/herdr-core/default/default.sock'));
  expect(() => createHcClient({ binary: join(homedir(), '.local/bin/hc'), env })).toThrowError(/Tests must use a socket/);
});

test('seeds the fenced window bounds and required display without launching an app', async () => {
  const h = await createClientFixture(); fixtures.push(h); const uuid = '00000000-0000-0000-0000-000000000001';
  await seedAppWindow(h.root, uuid); expect(existsSync(h.root + '/window.json')).toBe(true);
  expect(JSON.parse(await readFile(h.root + '/window.json', 'utf8'))).toEqual({ state: 'windowed', bounds: [40, 40, 1400, 900], display: uuid });
});
// The herdr-app window tier exists only on macOS.
test.skipIf(process.platform !== 'darwin')('window seeding requires an explicit display and refuses a foreign app home', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  await expect(seedAppWindow(h.root)).rejects.toMatchObject({ code: 'app-display-required' }); expect(existsSync(h.root + '/window.json')).toBe(false);
  await expect(seedAppWindow(join(homedir(), '.config/herdr-app'), '00000000-0000-0000-0000-000000000001')).rejects.toMatchObject({ code: 'isolation-unproved' });
});
