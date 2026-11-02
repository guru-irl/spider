// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createMachineCache, type MachineCache } from '../ssh/cache.js';
import { createSshPolicy } from '../ssh/policy.js';
import { parseSshDestinations } from '../ssh/parse.js';

async function fixture(test: (h: HerdrHarness, cache: MachineCache, tick: (n: number) => void) => Promise<void>) {
  const h = await createHerdrHarness('fake'); let now = 1000; let cache: MachineCache | undefined;
  try {
    await h.start(); await h.scenario({ ssh: { stdout: 'ok\n', stderr: 'separate\n', exitCode: 17 } });
    cache = createMachineCache({ hc: h.hc, identity: await h.hc.identity(), directory: join(h.root, 'cache'), aliases: { 'remote.invalid': ['alias.invalid', 'user@server.invalid:2222', '[2001:db8::1]'] }, clock: () => now });
    await cache.ready; await test(h, cache, n => { now += n; });
  } finally { await cache?.dispose(); await h.scenario({}); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}
async function invoke(h: HerdrHarness, argv: string[]) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(h.sshBinary, argv, { env: h.localEnv, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject); child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}
describe('managed SSH policy', () => {
  it('refuses a managed destination before connecting but preserves another host', async () => fixture(async (h, cache) => {
    const policy = createSshPolicy(cache);
    expect(await policy.checkArgv(['-p', '2222', 'user@remote.invalid', 'echo', 'hidden'])).toMatchObject({ kind: 'refuse', machine: 'remote.invalid' });
    const argv = ['user@elsewhere.invalid', 'echo', 'ok']; expect(await policy.checkArgv(argv)).toEqual({ kind: 'allow' });
    expect(await invoke(h, argv)).toMatchObject({ exitCode: 17, stdout: 'ok\n', stderr: 'separate\n' });
    expect(JSON.parse((await readFile(join(h.root, 'ssh-calls.jsonl'), 'utf8')).trim())).toEqual(argv);
  }));
  it('refreshes every 30 seconds and expires at 120 seconds without losing denial', async () => fixture(async (h, cache, tick) => {
    expect(cache.snapshot()?.machines.some(m => m.name === 'remote.invalid')).toBe(true); await access(cache.descriptor.path);
    const policy = createSshPolicy(cache); tick(119999); expect(await policy.checkArgv(['elsewhere.invalid'])).toEqual({ kind: 'allow' });
    tick(1); expect(await policy.checkArgv(['elsewhere.invalid'])).toMatchObject({ kind: 'refuse' });
    expect(await policy.checkArgv(['remote.invalid'])).toMatchObject({ kind: 'refuse' });
    const before = (await h.calls()).filter(c => c.argv[0] === 'machine' && c.argv[1] === 'ls').length;
    vi.useFakeTimers();
    try { const periodic = createMachineCache({ hc: h.hc, identity: await h.hc.identity(), directory: join(h.root, 'periodic') }); await periodic.ready;
      await vi.advanceTimersByTimeAsync(29999);
      expect((await h.calls()).filter(c => c.argv[0] === 'machine' && c.argv[1] === 'ls').length).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(1); await periodic.refresh(); await periodic.dispose();
    } finally { vi.useRealTimers(); }
    expect((await h.calls()).filter(c => c.argv[0] === 'machine' && c.argv[1] === 'ls').length).toBe(before + 2);
  }));
  it('keeps a valid cache after failed refresh but refuses every host in an outage', async () => fixture(async (h, cache, tick) => {
    await h.scenario({ steps: [{ argvPrefix: ['machine', 'ls'], exitCode: 1, stderr: 'outage' }] });
    await cache.refresh(); const policy = createSshPolicy(cache);
    expect(await policy.checkArgv(['alias.invalid'])).toMatchObject({ kind: 'refuse', machine: 'remote.invalid' });
    expect(await policy.checkArgv(['elsewhere.invalid'])).toEqual({ kind: 'allow' }); tick(120000);
    expect(await policy.checkArgv(['elsewhere.invalid'])).toMatchObject({ kind: 'refuse' });
    const empty = createMachineCache({ hc: h.hc, identity: await h.hc.identity(), directory: join(h.root, 'outage') });
    try { await empty.ready; expect(await createSshPolicy(empty).checkArgv(['elsewhere.invalid'])).toMatchObject({ kind: 'refuse' }); } finally { empty.dispose(); }
  }));
  it('publishes a newly registered alias atomically and never borrows another core', async () => fixture(async (h, cache) => {
    await h.scenario({ steps: [{ argvPrefix: ['machine', 'ls'], reply: { machines: [{ id: 'new-core', name: 'new-machine.invalid', session: 'r', state: 'connected', host: 'new-alias.invalid', target: 'user@new-alias.invalid', via: null }] } }] });
    await cache.refresh(); expect(await createSshPolicy(cache).checkArgv(['new-alias.invalid'])).toMatchObject({ kind: 'refuse', machine: 'new-machine.invalid' });
    const identity = await h.remoteHc.identity();
    const other = createMachineCache({ hc: h.remoteHc, identity, directory: join(h.root, 'cache') });
    try { await other.ready; expect(other.descriptor.path).not.toBe(cache.descriptor.path); expect(await createSshPolicy(other).checkArgv(['alias.invalid'])).toEqual({ kind: 'allow' }); } finally { other.dispose(); }
  }));
  it.each([
    ['-p', '2222', 'user@alias.invalid'], ['--', 'remote.invalid'], ['ssh://user@remote.invalid:2222'], ['user@[2001:db8::1]:22'],
    ['-o', 'HostName=server.invalid', 'elsewhere.invalid'], ['-oHostName remote.invalid', 'elsewhere.invalid'],
    ['-J', 'user@remote.invalid:22,elsewhere.invalid', 'other.invalid'], ['-o', 'ProxyJump=alias.invalid', 'other.invalid'],
    ['-o', 'ProxyCommand=ssh -W %h:%p remote.invalid', 'other.invalid'],
  ])('normalizes options, URI, IPv6, HostName and proxy routes: %j', async (...argv) => fixture(async (_h, cache) => {
    expect(await createSshPolicy(cache).checkArgv(argv)).toMatchObject({ kind: 'refuse', machine: 'remote.invalid' });
  }));
  it.each(['true; ssh remote.invalid echo hidden', 'echo ok | ssh alias.invalid cat', '/usr/bin/ssh remote.invalid', 'command ssh remote.invalid', 'env X=1 ssh remote.invalid', 'ssh "$TARGET"', 'ssh -o ProxyCommand="opaque-helper %h" elsewhere.invalid', 'ssh -p', 'ssh remote.invalid; echo "unterminated', 'bash -c "ssh remote.invalid"'])('blocks compound, absolute, ambiguous or unsupported shell routes: %s', async code => fixture(async (_h, cache) => {
    expect(await createSshPolicy(cache).checkShell(code)).toMatchObject({ kind: 'refuse' });
  }));
  it.each(['env -u PATH /usr/bin/ssh remote.invalid', 'sudo -u root ssh remote.invalid', 'exec -a label /usr/bin/ssh remote.invalid', 'env -S "ssh remote.invalid"'])('cannot hide explicit SSH behind a wrapper operand: %s', async code => fixture(async (_h, cache) => {
    expect(await createSshPolicy(cache).checkShell(code)).toMatchObject({ kind: 'refuse' });
  }));
  it('preserves nonmanaged routes with redirection without treating output files as hosts', async () => fixture(async (_h, cache) => {
    const policy = createSshPolicy(cache);
    for (const code of ['echo ok > output', 'ssh elsewhere.invalid > output 2>&1', 'ssh < input elsewhere.invalid', 'echo ok >> "ssh remote.invalid"', '2>output ssh elsewhere.invalid']) expect(await policy.checkShell(code)).toEqual({ kind: 'allow' });
    for (const code of ['ssh > output remote.invalid', 'ssh 2>&1 remote.invalid', 'echo ok > output; ssh remote.invalid', '2>output ssh remote.invalid']) expect(await policy.checkShell(code)).toMatchObject({ kind: 'refuse', machine: 'remote.invalid' });
  }));
  it('does not execute config probes or mistake an ordinary echo for SSH', async () => fixture(async (h, cache) => {
    expect(await createSshPolicy(cache).checkShell('echo "ssh remote.invalid"; ssh elsewhere.invalid printf ok')).toEqual({ kind: 'allow' });
    expect(parseSshDestinations(['-p', '2222', 'USER@Example.invalid.'])).toMatchObject([{ host: 'example.invalid', source: 'destination' }]);
    expect((await h.calls()).some(c => c.argv.includes('-G'))).toBe(false);
  }));
});
