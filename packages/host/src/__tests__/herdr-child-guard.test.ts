// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { access, chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resetProcessStartTimeForTests } from '../../../subagents/src/process-identity.js';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { setupHerdr, standardHerdrConfigPath } from '../../../herdr/src/setup/installer.js';
import { createMachineCache } from '../../../herdr/src/ssh/cache.js';
import { createExecutionEnvironmentPolicy, installSshShim, sshShimDirectory } from '../../../herdr/src/ssh/shim.js';
import { mountHerdr } from '../herdr/mount.js';
import { paths } from '@spider/db-core';
import { globalConfigForTest } from '../../../db-core/src/__tests__/global-config.testutil.js';
import { createProductionHerdrCliPorts, type HostHerdrOptions } from '../herdr/ports.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function childFixture(mode: 'fake' | 'hc' = 'fake') {
  const h = await createHerdrHarness(mode);
  let cache: ReturnType<typeof createMachineCache> | undefined, mount: ReturnType<typeof mountHerdr> | undefined;
  try {
    await h.start();
    execFileSync('git', ['init', '-q', h.root]);
    for (const [key, value] of Object.entries(h.localEnv)) {
      if (value !== undefined && /^(HC_|XDG_|HERDR_)/.test(key)) vi.stubEnv(key, value);
    }
    vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', h.owner!.sessionId);
    vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
    const packageRoot = join(h.root, 'package');
    await cp(resolve('dist/herdr'), join(packageRoot, 'dist/herdr'), { recursive: true });
    await cp(resolve('packages/herdr/assets'), join(packageRoot, 'packages/herdr/assets'), { recursive: true });
    const config = { enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', aliases: ['managed.invalid', 'box.invalid'], runtime: { cwd: h.directories.remote, directory: join(h.directories.remote, 'programs'), commands: {} }, nodePath: process.execPath }], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
    const configPath = standardHerdrConfigPath(config.globalRoot);
    await mkdir(join(config.globalRoot, 'herdr'), { recursive: true });
    // The config is setup's input; the runtime and mod files below are its real output.
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(join(config.app.home, 'settings.json'), '{}');
    const installer = createProductionHerdrCliPorts(packageRoot, { ...h.localEnv, SPIDER_GLOBAL_ROOT: h.directories.global });
    const request = { config: config as never, configPath, packageRoot, journalRoot: join(config.globalRoot, 'herdr/setup') };
    const parts = await installer.setupParts(request);
    try {
      await setupHerdr(request, { ...parts,
        preflight: async () => ({ fingerprint: 'child-policy-fixture', coreIdentity: await h.hc.identity(), mods: ['panel'].map(name => ({ directory: join(config.app.home, 'mods', `spider-${name}`) })), targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'fixture' }], retiredTerminals: [], layoutExport: true }),
        stageLook: async () => [], generateTemplates: async () => [], installResume: async () => [],
        cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [] } as never),
      });
    } finally { await installer.dispose(); }
    await access(join(config.app.home, 'mods/spider-panel/main.js'));
    await expect(access(join(config.app.home, 'mods/spider-machines/main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    cache = createMachineCache({ hc: h.hc, identity: h.owner!.terminal, directory: join(config.globalRoot, 'herdr/ssh'), aliases: { 'remote.invalid': ['managed.invalid', 'box.invalid'] } });
    await cache.ready;
    const ssh = join(h.root, 'ssh');
    await writeFile(ssh, '#!/bin/sh\nexit 0\n'); await chmod(ssh, 0o700);
    const shim = { shimDirectory: sshShimDirectory(cache.descriptor), realSshBinary: ssh, cacheDescriptor: cache.descriptor, shimProgram: join(packageRoot, 'dist/herdr/cli.mjs') };
    await installSshShim(shim);
    const inherited = createExecutionEnvironmentPolicy(shim)(process.env);
    vi.stubEnv('PATH', inherited.PATH);
    vi.stubEnv('SPIDER_HERDR_SSH_DESCRIPTOR', inherited.SPIDER_HERDR_SSH_DESCRIPTOR);
    vi.stubEnv('PI_SUBAGENT_CHILD', '1'); vi.stubEnv('PI_SUBAGENT_RUN_ID', 'policy-child');
    const hooks = new Map<string, Function[]>(), errors: unknown[] = [], notices: string[] = [];
    const pi = { on(name: string, fn: Function) { hooks.set(name, [...hooks.get(name) ?? [], fn]); return () => hooks.set(name, (hooks.get(name) ?? []).filter(f => f !== fn)); }, sendMessage() {}, registerTool() {}, getSessionName: () => 'child' };
    const ctx = { cwd: h.root, mode: 'rpc', hasUI: false, ui: { notify(message: string) { notices.push(message); } }, sessionManager: { getSessionId: () => 'policy-child-session', getSessionFile: () => undefined, getBranch: () => [] } };
    const options: HostHerdrOptions = { packageRoot, reportError: error => errors.push(error), actionContext: () => { throw new Error('No parent action context in child'); }, views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } } };
    return { h, config, configPath, pi, ctx, hooks, errors, notices, shim,
      mount(overrides: Partial<HostHerdrOptions> = {}) { mount = mountHerdr(pi as never, { ...options, ...overrides }); return mount; },
      async emit(name: string, event: unknown = { reason: 'startup' }) { for (const fn of hooks.get(name) ?? []) await fn(event, ctx); },
      async close() { await mount?.dispose(); cache?.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); },
    };
  } catch (error) {
    await mount?.dispose(); cache?.dispose(); await h.close(); throw error;
  }
}

const managedCommands = ['scp f MANAGED.INVALID:/x', 'sftp box.invalid', '/usr/bin/ssh managed.invalid true', 'ssh managed.invalid true', 'rsync -e ssh f box.invalid:/x', 'GIT_SSH_COMMAND=/usr/bin/ssh git fetch box.invalid:repo'];

it('a child with failed activation keeps the inherited transport guard and names the failure', async () => {
  const f = await childFixture();
  try {
    const mount = f.mount({ readConfig: async () => { throw new Error('activation unavailable'); } });
    await f.emit('session_start');
    expect(mount.enabled()).toBe(false);
    expect(mount.execution().environmentPolicy(process.env).PATH?.split(':')[0]).toBe(f.shim.shimDirectory);
    for (const command of managedCommands) {
      expect(await mount.guard({ toolName: 'bash', input: { command } }), command).toMatchObject({ block: true, reason: expect.stringContaining("couldn't read the Herdr configuration") });
    }
    expect(await mount.guard({ toolName: 'bash', input: { command: 'ssh unmanaged.invalid true' } })).toBeUndefined();
  } finally { await f.close(); }
}, 30000);

it('a child outside Herdr keeps inherited managed-destination enforcement on every shell tool', async () => {
  const f = await childFixture();
  try {
    vi.stubEnv('HC_TERMINAL_ID', undefined);
    const mount = f.mount(); await f.emit('session_start');
    const script = join(f.h.root, 'transport.sh'); await writeFile(script, 'scp f managed.invalid:/x');
    const calls = [
      { toolName: 'bash', input: { command: 'sftp managed.invalid' } },
      { toolName: 'spider', input: { action: 'exec', language: 'shell', code: '/usr/bin/ssh managed.invalid true' } },
      { toolName: 'functions.spider', input: { action: 'batch', commands: [{ language: 'shell', code: 'rsync -e ssh f box.invalid:/x' }] } },
      { toolName: 'spider', input: { action: 'exec_file', language: 'shell', path: script } },
    ];
    for (const call of calls) expect(await mount.guard(call), JSON.stringify(call)).toMatchObject({ block: true, reason: expect.stringContaining("isn't running inside Herdr") });
    expect(await mount.guard({ toolName: 'spider', input: { action: 'exec', on: 'remote.invalid', language: 'shell', code: 'true' } }))
      .toMatchObject({ block: true, reason: expect.stringContaining('Herdr is off in this session') });
  } finally { await f.close(); }
}, 30000);

async function proveCoreLoss(mode: 'fake' | 'hc') {
  const f = await childFixture(mode);
  try {
    const mount = f.mount(); await f.emit('session_start');
    expect(mount.enabled(), JSON.stringify(f.errors)).toBe(true);
    expect(await mount.guard({ toolName: 'bash', input: { command: 'ssh managed.invalid true' } })).toMatchObject({ block: true });
    await f.h.cli(['server', 'stop', '--json']);
    expect(await mount.guard({ toolName: 'bash', input: { command: 'ssh unmanaged.invalid true' } })).toBeUndefined();
    expect(mount.enabled()).toBe(false); expect(mount.owner()).toBeNull();
    const env = mount.execution().environmentPolicy(process.env);
    expect(env.SPIDER_HERDR_SSH_DESCRIPTOR).toBeUndefined();
    expect(env.PATH?.split(':')).not.toContain(f.shim.shimDirectory);
    const remoteCall = { toolName: 'spider', input: { action: 'exec', language: 'shell', on: 'remote.invalid', code: 'true' } };
    const message = "Herdr stopped responding while this subagent was running, so it can't run commands on other machines for the rest of this run. Finish without remote commands, or report back so the parent can start a new run.";
    expect(await mount.guard(remoteCall)).toEqual({ block: true, reason: message });
    for (const command of [...managedCommands, 'scp f unmanaged.invalid:/x']) {
      expect(await mount.guard({ toolName: 'bash', input: { command } })).toBeUndefined();
    }
    await f.h.cli(['server', 'start', '--json']);
    expect(mount.enabled()).toBe(false);
    expect(await mount.guard(remoteCall)).toEqual({ block: true, reason: message });
    expect(f.errors).toHaveLength(1);
    expect(String(f.errors[0])).toContain('core');
  } finally { await f.close(); }
}

it('core loss makes the child inactive, removes the shim, allows SSH and reports once', () => proveCoreLoss('fake'), 30000);
it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !existsSync(process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc')))('isolated real hc core loss matches the fake (requires installed hc and SPIDER_HERDR_E2E=1, no app)', () => proveCoreLoss('hc'), 30000);

it('an idle child notices core loss without a tool call', async () => {
  const f = await childFixture();
  try {
    const mount = f.mount(); await f.emit('session_start');
    expect(mount.enabled()).toBe(true);
    await f.h.cli(['server', 'stop', '--json']);
    await vi.waitFor(() => expect(mount.enabled()).toBe(false), { timeout: 5000, interval: 50 });
    expect(f.errors).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);

it('an inherited invalid cache still refuses SSH rather than guessing destinations', async () => {
  const f = await childFixture();
  try {
    await writeFile(f.shim.cacheDescriptor.path, 'invalid cache');
    const mount = f.mount({ readConfig: async () => { throw new Error('activation unavailable'); } });
    await f.emit('session_start');
    for (const command of ['ssh managed.invalid true', 'ssh unmanaged.invalid true']) {
      expect(await mount.guard({ toolName: 'bash', input: { command } })).toMatchObject({ block: true, reason: expect.stringContaining("couldn't check Herdr's machine list") });
    }
  } finally { await f.close(); }
}, 30000);

// Linux reads process identity from /proc, so these ps failures only exist elsewhere.
it.skipIf(process.platform === 'linux').each(['ENOENT', 'ETIMEDOUT'])('a failing ps (%s) cannot throw through child mount or session hooks', async code => {
  const f = await childFixture();
  const run = childProcess.execFileSync;
  let psCalls = 0;
  const ps = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, ...args: unknown[]) => {
    if (file === 'ps') { psCalls++; throw Object.assign(new Error(`ps unavailable: ${code}`), { code }); }
    return Reflect.apply(run, childProcess, [file, ...args]);
  }) as typeof childProcess.execFileSync);
  syncBuiltinESMExports(); resetProcessStartTimeForTests();
  try {
    const mount = f.mount({ readConfig: async () => ({ ...f.config, enabled: false }) as never });
    expect(psCalls).toBe(0);
    await expect(f.emit('session_start')).resolves.toBeUndefined();
    expect(mount.enabled()).toBe(false);
    expect(f.errors).toHaveLength(1);
    expect(String(f.errors[0])).toContain('process start time');
  } finally { ps.mockRestore(); syncBuiltinESMExports(); resetProcessStartTimeForTests(); await f.close(); }
}, 30000);

it('an unreadable active child writer identity deactivates only Herdr and preserves the SSH guard', async () => {
  const f = await childFixture();
  const identity = await import('../../../herdr/src/jobs/handoff.js');
  const ps = vi.spyOn(identity, 'processStartIdentity').mockImplementation(() => { throw new Error('child writer identity unavailable'); });
  try {
    const mount = f.mount();
    await expect(f.emit('session_start')).resolves.toBeUndefined();
    expect(mount.enabled()).toBe(false);
    expect(await mount.guard({ toolName: 'bash', input: { command: 'scp f managed.invalid:/x' } })).toMatchObject({ block: true, reason: expect.stringContaining("couldn't connect this subagent to Herdr") });
    expect(f.errors).toHaveLength(1);
  } finally { ps.mockRestore(); await f.close(); }
}, 30000);

it('auto is silent without configuration or a Herdr terminal, but reports an expected inactive child once', async () => {
  const f = await childFixture();
  try {
    await rm(f.configPath);
    vi.stubEnv('HC_TERMINAL_ID', undefined);
    const mount = f.mount(); await f.emit('session_start');
    expect(f.errors).toEqual([]); expect(mount.enabled()).toBe(false);
    vi.stubEnv('HC_TERMINAL_ID', f.h.localEnv.HC_TERMINAL_ID);
    await f.emit('session_start'); await f.emit('session_start', { reason: 'reload' });
    expect(f.errors).toHaveLength(1);
    expect(String(f.errors[0])).toContain('configuration');
  } finally { await f.close(); }
}, 30000);

it('a configured child outside Herdr reports one inactive notice, not a persistent status', async () => {
  const f = await childFixture();
  const statuses: string[] = [];
  Reflect.set(f.ctx.ui, 'setStatus', (key: string) => statuses.push(key));
  try {
    vi.stubEnv('HC_TERMINAL_ID', undefined);
    const mount = f.mount(); await f.emit('session_start'); await f.emit('session_start', { reason: 'reload' });
    expect(mount.enabled()).toBe(false); expect(f.errors).toHaveLength(1);
    expect(String(f.errors[0])).toContain("isn't running inside Herdr"); expect(statuses).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it('auto with a dead core uses only liveness probes and one notice across reload', async () => {
  const f = await childFixture();
  try {
    await f.h.cli(['server', 'stop', '--json']);
    const before = (await f.h.calls()).length;
    const mount = f.mount({ readConfig: async () => ({ ...f.config, enabled: 'auto' }) as never });
    await f.emit('session_start'); await f.emit('session_start', { reason: 'reload' });
    expect(mount.enabled()).toBe(false); expect((await f.h.calls()).length).toBe(before);
    expect(f.errors).toHaveLength(1);
    expect(mount.execution().environmentPolicy(process.env).SPIDER_HERDR_SSH_DESCRIPTOR).toBeUndefined();
    expect(await mount.guard({ toolName: 'bash', input: { command: 'ssh managed.invalid true' } })).toBeUndefined();
  } finally { await f.close(); }
}, 30000);

it('explicit true activation failure is one UI error notice, never a footer', async () => {
  const f = await childFixture();
  const notices: { message: string; kind: string }[] = [], statuses: string[] = [];
  Reflect.set(f.ctx, 'hasUI', true);
  Reflect.set(f.ctx.ui, 'notify', (message: string, kind: string) => notices.push({ message, kind }));
  Reflect.set(f.ctx.ui, 'setStatus', (key: string) => statuses.push(key));
  try {
    vi.stubEnv('HC_TERMINAL_ID', undefined);
    globalConfigForTest(paths.globalRoot).set('herdr.enabled', true);
    f.mount(); await f.emit('session_start'); await f.emit('session_start', { reason: 'reload' });
    expect(notices).toEqual([{ message: "This session isn't running inside Herdr, so spider's Herdr features are off here. Everything else in spider still works.", kind: 'error' }]);
    expect(statuses).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it('a transient child inventory failure uses the inherited policy, not a parser error for unmanaged SSH', async () => {
  const f = await childFixture();
  try {
    const mount = f.mount(); await f.emit('session_start');
    await f.h.scenario({ steps: [{ argvPrefix: ['machine', 'ls'], stderr: 'inventory unavailable', exitCode: 1 }] });
    expect(await mount.guard({ toolName: 'bash', input: { command: 'ssh unmanaged.invalid true' } })).toBeUndefined();
    expect(await mount.guard({ toolName: 'bash', input: { command: 'scp f managed.invalid:/x' } })).toMatchObject({ block: true, reason: expect.stringContaining('on:remote.invalid') });
    expect(mount.enabled()).toBe(true);
  } finally { await f.h.scenario({}); await f.close(); }
}, 30000);

it('core loss between the socket probe and machine inventory still allows ordinary SSH', async () => {
  const f = await childFixture();
  const hc = await import('../../../herdr/src/client/hc.js'), create = hc.createHcClient;
  const clients = vi.spyOn(hc, 'createHcClient').mockImplementation(options => {
    const client = create(options);
    client.machines = async () => { await f.h.cli(['server', 'stop', '--json']); throw new Error('inventory core unavailable'); };
    return client;
  });
  try {
    const mount = f.mount(); await f.emit('session_start');
    expect(mount.enabled()).toBe(true);
    expect(await mount.guard({ toolName: 'bash', input: { command: 'ssh unmanaged.invalid true' } })).toBeUndefined();
    expect(mount.enabled()).toBe(false);
    expect(mount.execution().environmentPolicy(process.env).SPIDER_HERDR_SSH_DESCRIPTOR).toBeUndefined();
    expect(f.errors).toHaveLength(1);
  } finally { clients.mockRestore(); await f.close(); }
}, 30000);

it.skipIf(process.platform === 'linux')('a first presence ps failure leaves Herdr inactive even if later ps calls would succeed', async () => {
  const f = await childFixture();
  const run = childProcess.execFileSync;
  let failed = false;
  const ps = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, ...args: unknown[]) => {
    if (file === 'ps' && !failed) { failed = true; throw Object.assign(new Error('first ps timeout'), { code: 'ETIMEDOUT' }); }
    return Reflect.apply(run, childProcess, [file, ...args]);
  }) as typeof childProcess.execFileSync);
  syncBuiltinESMExports(); resetProcessStartTimeForTests();
  try {
    const mount = f.mount(); await f.emit('session_start');
    expect(mount.enabled()).toBe(false); expect(mount.owner()).toBeNull();
    expect(f.errors).toHaveLength(1);
    expect(String(f.errors[0])).toContain('Cannot read child process start time');
    expect(await mount.guard({ toolName: 'bash', input: { command: 'scp f managed.invalid:/x' } })).toMatchObject({ block: true, reason: expect.stringContaining("Spider couldn't connect this subagent to Herdr") });
  } finally { ps.mockRestore(); syncBuiltinESMExports(); resetProcessStartTimeForTests(); await f.close(); }
}, 30000);
