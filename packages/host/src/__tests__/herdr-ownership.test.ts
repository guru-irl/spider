// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { copyFile, cp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { createTerminalRegistry } from '../../../herdr/src/sessions/registry.js';
import { createProcessPresence } from '../../../herdr/src/sessions/presence.js';
import { setupHerdr, standardHerdrConfigPath } from '../../../herdr/src/setup/installer.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { controlConfig } from '../control.js';
import { mountHerdr, type HerdrMount } from '../herdr/mount.js';
import { isCoreAvailable } from '../../../herdr/src/client/liveness.js';
import { processStartTime } from '../../../subagents/src/process-identity.js';

const mounts: HerdrMount[] = [];
afterEach(async () => { for (const m of mounts.splice(0)) await m.dispose(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function fixture(mode: 'fake' | 'hc' = 'fake') {
  const h = await createHerdrHarness(mode);
  try {
    await h.start();
    execFileSync('git', ['init', '-q', h.directories.local]);
    await mkdir(join(h.root, 'dist/herdr'), { recursive: true });
    await copyFile(resolve('dist/herdr/cli.mjs'), join(h.root, 'dist/herdr/cli.mjs'));
    await copyFile(resolve('dist/herdr/remote-runtime.mjs'), join(h.root, 'dist/herdr/remote-runtime.mjs'));
    await cp(resolve('packages/herdr/assets'), join(h.root, 'packages/herdr/assets'), { recursive: true });
    await mkdir(join(h.directories.global, 'herdr'), { recursive: true });
    await writeFile(standardHerdrConfigPath(h.directories.global), JSON.stringify({ enabled: true,
      core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') }, app: { binary: mode === 'fake' ? h.appBinary : join(h.root, 'no-app'), home: h.directories.app },
      agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', aliases: [], nodePath: process.execPath,
        runtime: { cwd: null, directory: join(h.directories.remote, 'programs'), commands: {} } }] }));
    await writeFile(join(h.directories.app, 'settings.json'), '{}');
    const ports = createProductionHerdrCliPorts(h.root, h.localEnv);
    try {
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(h.directories.local);
      let request;
      try { request = await ports.request(); } finally { cwd.mockRestore(); }
      const parts = await ports.setupParts(request);
      await setupHerdr(request, { ...parts,
        preflight: async () => ({ fingerprint: 'session-registry-test', coreIdentity: h.owner!.terminal, mods: ['panel', 'machines'].map(name => ({ directory: join(h.directories.app, 'mods', `spider-${name}`) })), targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'isolated' }], retiredTerminals: [], layoutExport: true }),
        stageLook: async () => [], generateTemplates: async () => [], cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ checks: [], failures: [], warnings: [], probes: [] }),
      });
    } finally { await ports.dispose(); }
    const registry = createTerminalRegistry(join(h.directories.global, 'herdr'));
    const dbPath = join(h.root, 'runs.db'), globalPath = join(h.root, 'global.db');
    openDbAt(dbPath, 'worktree').close(); openDbAt(globalPath, 'global').close();
    const hooks = new Map<string, Function[]>(), notices: string[] = [], noticeLevels: string[] = [], errors: unknown[] = [];
    let session = 'owner-session';
    const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI: true, isIdle: () => true,
      sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
      ui: { notify: (message: string, level: string) => { notices.push(message); noticeLevels.push(level); }, setStatus() {}, setWidget() {}, setFooter() {} } };
    const pi = { on: (name: string, handler: Function) => { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; }, registerTool() {}, registerCommand() {}, registerShortcut() {}, sendMessage() {} };
    const environment = (synthetic = true) => {
      for (const [key, value] of Object.entries(h.localEnv)) if (value !== undefined) vi.stubEnv(key, value);
      vi.stubEnv('PI_SUBAGENT_CHILD', '0');
      if (!synthetic) vi.stubEnv('HERDR_TEST_SYNTHETIC_CALLER', undefined);
    };
    environment();
    controlConfig('set', h.directories.local, 'herdr.enabled', true, 'global');
    const mounted = (otherPi = pi) => {
      const mount = mountHerdr(otherPi as never, { packageRoot: h.root, actionContext: () => ({}), reportError: error => errors.push(error),
        views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } },
        dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }),
          readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } } });
      mounts.push(mount); return mount;
    };
    const start = async () => { for (const hook of [...hooks.get('session_start') ?? []]) await hook({ reason: 'reload' }, ctx); };
    const shutdown = async () => { for (const hook of [...hooks.get('session_shutdown') ?? []]) await hook({ reason: 'reload' }, ctx); };
    return { h, registry, ctx, hooks, notices, noticeLevels, errors, start, shutdown, mounted, environment, nextSession: () => { session = 'next-session'; }, feed: join(h.directories.global, 'herdr/sessions/owner-session/session.json') };
  } catch (error) { await h.close(); throw error; }
}

test('only an attested live Herdr owner supplies a supervisor launcher', async () => {
  const f = await fixture();
  try {
    vi.stubEnv('HC_TERMINAL_ID', undefined);
    const m = f.mounted(); await f.start();
    expect(m.owner()).toBeNull();
    expect(m.execution().supervisorHcBinary).toBeUndefined();
    f.environment(); await f.start();
    expect(m.execution().supervisorHcBinary).toBe(f.h.hcBinary);
    await f.shutdown();
    expect(m.execution().supervisorHcBinary).toBeUndefined();
  } finally { for (const m of mounts.splice(0)) await m.dispose(); await f.h.close(); }
}, 60000);

test('bad terminal files are diagnosed once without disabling activation or hiding good mappings', async () => {
  const f = await fixture();
  try {
    const directory = join(f.h.directories.global, 'herdr/terminals');
    const old = { ...f.h.owner!, terminal: { ...f.h.owner!.terminal, coreId: 'retired-core' as never } };
    await f.registry.record({ owner: old, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: f.h.directories.agent, extensionArguments: [] } });
    const bad = ['aa-shape.json', 'ab-syntax.json', 'ac-public.json', 'ad-link.json'];
    await writeFile(join(directory, bad[0]), '{"version":1}', { mode: 0o600 });
    await writeFile(join(directory, bad[1]), '{', { mode: 0o600 });
    await writeFile(join(directory, bad[2]), '{}', { mode: 0o644 });
    await symlink(join(directory, bad[0]), join(directory, bad[3]));
    const m = f.mounted(); await f.start();
    expect(m.enabled()).toBe(true);
    expect(await f.registry.get(old.terminal)).toBeNull();
    expect((await f.registry.get(m.owner()!.terminal))?.owner.sessionId).toBe('owner-session');
    await f.shutdown(); await f.start();
    expect(m.enabled()).toBe(true);
    for (const name of bad) {
      expect(f.errors.filter(error => String(error).includes(name))).toHaveLength(1);
    }
    expect(f.notices).toEqual(["Spider couldn't read some saved Herdr session information. Other Herdr features may still work. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine."]);
  } finally { for (const m of mounts.splice(0)) await m.dispose(); await f.h.close(); }
}, 60000);

test.each(['print', 'rpc'])('a headless %s session cannot replace the interactive terminal mapping', async mode => {
  const f = await fixture();
  try {
    const parent = f.mounted(); await f.start(); expect(parent.enabled()).toBe(true);
    const hooks = new Map<string, Function[]>();
    const pi = { on: (name: string, handler: Function) => { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; }, registerTool() {}, registerCommand() {}, registerShortcut() {}, sendMessage() {} };
    const ctx = { ...f.ctx, hasUI: mode === 'rpc', mode, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => 'one-shot-session' } };
    const presenceStore = createProcessPresence(join(f.h.directories.global, 'herdr'));
    const terminal = await f.h.cli(['get', parent.owner()!.terminal.address, '--json']) as { pid: number };
    const ancestor = { pid: terminal.pid, startIdentity: processStartTime(terminal.pid)! };
    await presenceStore.record({ ...ancestor, sessionId: 'owner-session' as never, sessionFile: null, sessionName: null, kind: 'top-level', mode: 'tui', hcAddress: parent.owner()!.terminal.address });
    f.mounted(pi);
    for (const hook of hooks.get('session_start') ?? []) await hook({}, ctx);
    expect((await f.registry.get(parent.owner()!.terminal))?.owner.sessionId).toBe('owner-session');
    for (const hook of hooks.get('session_info_changed') ?? []) await hook({}, ctx);
    expect((await f.registry.get(parent.owner()!.terminal))?.owner.sessionId).toBe('owner-session');
    const presence = await createProcessPresence(join(f.h.directories.global, 'herdr')).list();
    expect(presence.some(record => record.sessionId === 'one-shot-session' && record.mode === mode)).toBe(true);
    // An interactive destination still replaces the mapping on a session change.
    await presenceStore.remove(ancestor);
    const interactive = { ...ctx, mode: 'rpc', hasUI: true };
    for (const hook of hooks.get('session_start') ?? []) await hook({}, interactive);
    for (const hook of hooks.get('session_info_changed') ?? []) await hook({}, interactive);
    expect((await f.registry.get(parent.owner()!.terminal))?.owner.sessionId).toBe('one-shot-session');
    expect(f.errors).toEqual([]);
  } finally { for (const m of mounts.splice(0)) await m.dispose(); await f.h.close(); }
}, 60000);

test('bad terminal files cannot interrupt cleanup when a live core is replaced', async () => {
  const f = await fixture();
  try {
    const m = f.mounted(); await f.start(); expect(m.enabled()).toBe(true);
    await writeFile(join(f.h.directories.global, 'herdr/terminals/aa-bad.json'), '{', { mode: 0o600 });
    await f.h.scenario({ steps: [{ argvPrefix: ['server', 'status'], reply: { version: '0.1.16', pid: process.pid, core: { id: 'replacement-core' } } }] });
    expect(await m.guard({ toolName: 'bash', input: { command: 'ssh unmanaged.invalid true' } })).toBeUndefined();
    expect(m.enabled()).toBe(false); expect(m.owner()).toBeNull();
    const feed = JSON.parse(await readFile(f.feed, 'utf8'));
    expect(await isCoreAvailable({ HC_SOCKET: feed.ipc.address })).toBe(false);
  } finally { for (const m of mounts.splice(0)) await m.dispose(); await f.h.close(); }
}, 60000);
