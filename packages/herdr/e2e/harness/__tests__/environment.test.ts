// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, symlinkSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { assertSocketPath, buildEnvironment, createFencedDirectories, createFixtureRoot, defaultCoreSocket, ownedPath, holderSocket, SOCKET_PATH_LIMIT, checkoutRoot, fencedDirectories } from '../environment.js';
import { startCores } from '../hc.js';
import { openLedger, cleanupLedger } from '../resources.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
async function root(): Promise<string> { const r = await createFixtureRoot(); roots.push(r); return r; }

describe('owned paths and sockets', () => {
  it('creates short fixture roots under the checkout scratch directory', async () => {
    const r = await root();
    expect(r.startsWith(join(checkoutRoot(), '.spider/scratch/e2/'))).toBe(true);
    expect(r.split('/').at(-1)).toMatch(/^[a-z0-9]{5}$/);
  });

  it('refuses paths outside the root, traversal, and symlinked components', async () => {
    const r = await root();
    expect(() => ownedPath(r, '/var/tmp/x')).toThrow(/outside-owned-root/);
    expect(() => ownedPath(r, join(r, '../escape'))).toThrow(/outside-owned-root/);
    mkdirSync(join(r, 'real'));
    symlinkSync(join(r, 'real'), join(r, 'link'));
    expect(() => ownedPath(r, join(r, 'link/inner.sock'))).toThrow(/symlink/);
    expect(ownedPath(r, join(r, 'real/inner.sock'))).toBe(join(r, 'real/inner.sock'));
  });

  it('checks the holder-suffixed socket against the 103-byte limit, not just the primary path', async () => {
    const r = await root();
    const primary = join(r, 'x/herdr-core/n/n.sock');
    expect(holderSocket(primary)).toBe(join(r, 'x/herdr-core/n/n.holder.4294967295.sock'));
    expect(assertSocketPath(r, primary)).toBe(primary);
    // A primary path that fits alone but whose holder variant does not must fail.
    const pad = 'p'.repeat(SOCKET_PATH_LIMIT - Buffer.byteLength(join(r, 'x/herdr-core/n/.sock')) - 1);
    const tight = join(r, `x/herdr-core/n/${pad}.sock`);
    expect(Buffer.byteLength(tight)).toBeLessThanOrEqual(SOCKET_PATH_LIMIT);
    expect(() => assertSocketPath(r, tight)).toThrow(/socket-path-too-long/);
  });

  it('refuses the real account default socket even with a fenced HOME and XDG state', async () => {
    const r = await root();
    const actual = join(userInfo().homedir, '.local/state/herdr-core/default/default.sock');
    vi.stubEnv('HOME', join(r, 'h')); vi.stubEnv('XDG_STATE_HOME', join(r, 'x'));
    try {
      expect(homedir()).not.toBe(userInfo().homedir);
      expect(defaultCoreSocket()).toBe(actual);
      expect(() => assertSocketPath(r, actual)).toThrow(/default-socket/);
      const safe = join(r, 'x/herdr-core/l/l.sock');
      expect(assertSocketPath(r, safe)).toBe(safe);
    } finally { vi.unstubAllEnvs(); }
  });

  it('refuses an explicitly configured real default socket before any hc call', async () => {
    const r = await root();
    const dirs = await createFencedDirectories(r);
    const env = buildEnvironment(process.env, dirs, { binDirectory: join(r, 'bin') });
    const actual = join(userInfo().homedir, '.local/state/herdr-core/default/default.sock');
    const ledgers = join(r, '..', '_test-ledgers', r.split('/').at(-1)!); mkdirSync(ledgers, { recursive: true }); roots.push(ledgers);
    const ledger = openLedger(ledgers, r);
    vi.stubEnv('HOME', dirs.HOME); vi.stubEnv('XDG_STATE_HOME', dirs.XDG_STATE_HOME);
    try {
      // The outside state path also guarantees that the pre-fix control cannot bootstrap a core.
      const hostile = { ...env, HC_SOCKET: actual, XDG_STATE_HOME: join(userInfo().homedir, '.local/state') };
      for (const candidate of [hostile, { ...env, HC_SOCKET: actual }, { ...env, HC_TERMINAL_SOCKET: actual }])
        await expect(startCores(ledger, r, candidate, join(r, 'bin'))).rejects.toMatchObject({ code: 'default-socket' });
      const calls = join(r, 'hc-calls.jsonl');
      expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('');
      expect(ledger.read().cores).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      expect((await cleanupLedger(ledger.path, 'default-socket-control')).clean).toBe(true);
    }
  });
});

describe('subprocess environment', () => {
  const hostile: NodeJS.ProcessEnv = {
    PATH: '/srv/hostile/.local/bin:/usr/bin', HOME: '/srv/hostile', LANG: 'en_US.UTF-8',
    VITEST: 'true', VITEST_WORKER_ID: '3', VITEST_POOL_ID: '1', TEST: 'true', NODE_ENV: 'test', NODE_OPTIONS: '--require x',
    HC_TERMINAL_ID: 't1', HC_SESSION: 'default', HERDR_APP_HOME: '/srv/hostile/.config/herdr-app',
    PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'r', PI_SPIDER_DB_PATH: '/x', PI_SPIDER_SESSION_ID: 's', PI_SESSION_ID: 's',
    PI_CODING_AGENT_DIR: '/srv/hostile/.pi/agent', SPIDER_GLOBAL_ROOT: '/srv/hostile/.pi/agent/spider',
    SPIDER_TEST_FIXTURE_CHECKOUT: '/elsewhere', SPIDER_HERDR_SSH_BYPASS: '1', SPIDER_HERDR_APP_TESTS: '1',
    SSH_AUTH_SOCK: '/private/ssh', GIT_SSH_COMMAND: 'ssh -x', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', GITHUB_TOKEN: 'k', GH_TOKEN: 'k', COPILOT_API_KEY: 'k',
    TMPDIR: '/var/folders/x', XDG_STATE_HOME: '/srv/hostile/.local/state', XDG_RUNTIME_DIR: '/run/user/1',
  };

  it('starts from an allowlist and removes Vitest markers, credentials, HC, Herdr, pi and spider identity', async () => {
    const r = await root();
    const env = buildEnvironment(hostile, fencedDirectories(r), { binDirectory: join(r, 'bin') });
    for (const key of Object.keys(env)) expect(key, key).not.toMatch(/^(VITEST|TEST$|NODE_ENV$|NODE_OPTIONS$|HC_|PI_SUBAGENT_|PI_SPIDER_|PI_SESSION_|SSH_|GIT_SSH|ANTHROPIC|OPENAI|GITHUB_TOKEN|GH_TOKEN|COPILOT|XDG_RUNTIME_DIR|SPIDER_HERDR_)/);
    expect(env.HERDR_APP_HOME?.startsWith(r + '/')).toBe(true);
  });

  it('fences every writable root, temp directory and HOME inside the fixture root', async () => {
    const r = await root();
    const env = buildEnvironment(hostile, fencedDirectories(r), { binDirectory: join(r, 'bin') });
    for (const key of ['HOME', 'TMPDIR', 'PI_CODING_AGENT_DIR', 'SPIDER_GLOBAL_ROOT', 'HERDR_APP_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'PI_CODING_AGENT_SESSION_DIR'])
      expect(env[key]?.startsWith(r + '/'), key).toBe(true);
    expect(env.SPIDER_TEST_FIXTURE_CHECKOUT).toBe(checkoutRoot());
    expect(env.PI_OFFLINE).toBe('1'); expect(env.PI_SKIP_VERSION_CHECK).toBe('1'); expect(env.PI_TELEMETRY).toBe('0');
  });

  it('builds PATH from owned directories and system paths, never the inherited one', async () => {
    const r = await root();
    const env = buildEnvironment(hostile, fencedDirectories(r), { binDirectory: join(r, 'bin') });
    const parts = env.PATH!.split(':');
    expect(parts[0]).toBe(join(r, 'bin'));
    expect(parts).not.toContain('/srv/hostile/.local/bin');
    expect(parts.some(p => p.endsWith('/.local/bin'))).toBe(false);
  });

  it('refuses fenced values that point outside the root and caller attempts to re-add Vitest markers', async () => {
    const r = await root();
    expect(() => buildEnvironment(hostile, { ...fencedDirectories(r), TMPDIR: '/tmp/x' }, { binDirectory: join(r, 'bin') })).toThrow(/outside-owned-root/);
    expect(() => buildEnvironment(hostile, fencedDirectories(r), { binDirectory: join(r, 'bin'), extra: { VITEST: 'true' } })).toThrow(/forbidden-variable/);
    expect(() => buildEnvironment(hostile, fencedDirectories(r), { binDirectory: join(r, 'bin'), extra: { SPIDER_HERDR_APP_TESTS: '1' } })).toThrow(/forbidden-variable/);
  });
});
