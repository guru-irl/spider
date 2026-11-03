// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { access, copyFile, cp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { crashFakeCore } from '../../../herdr/src/__tests__/fake-core-crash.js';
import { createTerminalRegistry } from '../../../herdr/src/sessions/registry.js';
import { setupHerdr, standardHerdrConfigPath } from '../../../herdr/src/setup/installer.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { configFixtureCwd } from './herdr-config-fixture.js';
import { controlConfig } from '../control.js';
import { mountHerdr, type HerdrMount } from '../herdr/mount.js';
import { HERDR_NOTICES } from '../../../herdr/src/notices.js';
import { isCoreAvailable } from '../../../herdr/src/client/liveness.js';
import { setTimeout as delay } from 'node:timers/promises';

async function until(check: () => Promise<boolean>, description: string, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error(description); await delay(25); }
}

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
    const ports = configFixtureCwd(createProductionHerdrCliPorts(h.root, h.localEnv), h.directories.local);
    try {
      const request = await ports.request(), parts = await ports.setupParts(request);
      await setupHerdr(request, { ...parts,
        preflight: async () => ({ fingerprint: 'core-ownership-test', coreIdentity: h.owner!.terminal, mods: ['panel', 'machines'].map(name => ({ directory: join(h.directories.app, 'mods', `spider-${name}`) })), targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'isolated' }], retiredTerminals: [], layoutExport: true }),
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
    const mounted = () => {
      const mount = mountHerdr(pi as never, { packageRoot: h.root, actionContext: () => ({}), reportError: error => errors.push(error),
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

const realHc = process.env.SPIDER_HERDR_E2E === '1' && await access(process.env.SPIDER_HERDR_HC_BINARY ?? join(process.env.HOME!, '.local/bin/hc')).then(() => true, () => false);
for (const mode of ['fake', 'hc'] as const) test.skipIf(mode === 'hc' && !realHc)(`reload rejects a changed ${mode} core, prunes only its stale mappings, and leaves the old feed untouched`, async () => {
  const f = await fixture(mode), oldProcesses = new Set<number>();
  try {
    const m = f.mounted(); await f.start(); expect(m.enabled()).toBe(true); expect(f.errors).toEqual([]);
    const oldFeed = await readFile(f.feed, 'utf8'); const [mapping] = await f.registry.list(); expect(mapping).toBeDefined();
    const peer = { ...mapping, owner: { ...mapping.owner, terminal: { ...mapping.owner.terminal, socket: f.h.remoteSocket } } };
    await f.registry.record(peer);
    if (mode === 'fake') await f.h.scenario({ steps: [{ argvPrefix: ['server', 'status'], reply: { version: '0.1.16', pid: process.pid, core: { id: 'replacement-core' } } }] });
    else {
      const status = await f.h.cli(['server', 'status', '--json']) as { pid: number; core: { id: string }; holders: { pid: number }[] };
      const old = await f.h.cli(['get', mapping.owner.terminal.address, '--json']) as { pid: number };
      oldProcesses.add(old.pid);
      for (const holder of status.holders) { oldProcesses.add(holder.pid); process.kill(holder.pid, 'SIGSTOP'); }
      process.kill(status.pid, 'SIGKILL');
      await until(async () => !await isCoreAvailable(f.h.localEnv), 'old core still live');
      await rename(join(f.h.root, 'herdr-core/l'), join(f.h.root, 'old-core-state'));
      await f.h.cli(['server', 'start', '--json']);
      const next = await f.h.cli(['server', 'status', '--json']) as typeof status;
      expect(next.core.id).not.toBe(status.core.id);
      const decoy = await f.h.cli(['run', '--bg', '--no-notify', '--outlive-parent', '--no-parent', '--json', '--', process.execPath, '-e', 'setInterval(()=>{},1000)']) as { address: string };
      expect(decoy.address).toBe(mapping.owner.terminal.address);
      process.kill(old.pid, 0);
      await writeFile(join(f.h.root, '../../coreid-real-mount-reset.json'), JSON.stringify({ oldCore: status.core.id, newCore: next.core.id, oldPid: old.pid, decoy, oldOwner: mapping.owner.terminal }, null, 2));
    }
    await m.guard({ toolName: 'bash', input: { command: 'true' } });
    expect(m.enabled()).toBe(false);
    expect(m.execution().remoteUnavailableReason).toBe(HERDR_NOTICES.retired.text);
    expect(await m.guard({ toolName: 'spider', input: { on: 'remote.invalid' } })).toMatchObject({ block: true, reason: HERDR_NOTICES.retired.text });
    expect(await readFile(f.feed, 'utf8')).toBe(oldFeed);
    await f.shutdown();
    await f.start(); await f.start();
    expect(m.enabled()).toBe(false); expect(m.owner()).toBeNull();
    expect(await readFile(f.feed, 'utf8')).toBe(oldFeed);
    expect((await f.registry.list()).map(r => r.owner.terminal.socket)).toEqual([f.h.remoteSocket]);
    expect(f.notices.filter(message => message.includes("This session's Herdr pane belongs to a Herdr instance that has stopped. Close this session and open a new session in Herdr."))).toHaveLength(1);
    expect(await m.guard({ toolName: 'bash', input: { command: 'ssh remote.invalid true' } })).toBeUndefined();
    expect(await m.guard({ toolName: 'bash', input: { on: 'remote.invalid', command: 'true' } })).toMatchObject({ block: true, reason: expect.stringMatching(/Herdr instance that has stopped.*Close this session and open a new session/) });
  } finally {
    for (const m of mounts.splice(0)) await m.dispose();
    for (const pid of oldProcesses) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await f.h.close(); expect(await f.h.remainingOwnedResources()).toEqual([]);
  }
}, 60000);

test('a same-ID core return notifies once but stays inactive until reload', async () => {
  const f = await fixture();
  try {
    const m = f.mounted(); await f.start(); const oldFeed = await readFile(f.feed, 'utf8');
    let outage = await crashFakeCore(f.h);
    await m.guard({ toolName: 'bash', input: { command: 'true' } }); expect(m.enabled()).toBe(false);
    const calls = (await f.h.calls()).length;
    await delay(2200); expect((await f.h.calls()).length).toBe(calls); // Socket-only while absent: no hc autostart.
    await outage.recover();
    await until(async () => f.notices.includes("Herdr is running again. Run /reload to reconnect this session to the sidebar and panes."), 'no recovery notice');
    expect(m.enabled()).toBe(false); expect(m.owner()).toBeNull();
    expect(await readFile(f.feed, 'utf8')).toBe(oldFeed);
    expect(f.notices.filter(message => message === "Herdr is running again. Run /reload to reconnect this session to the sidebar and panes.")).toHaveLength(1);
    expect(await m.guard({ toolName: 'bash', input: { command: 'ssh remote.invalid true' } })).toBeUndefined();
    await f.start(); expect(m.enabled(), f.notices.join('\n')).toBe(true);
    outage = await crashFakeCore(f.h); await m.guard({ toolName: 'bash', input: { command: 'true' } });
    await outage.recover();
    await until(async () => f.notices.filter(message => message === "Herdr is running again. Run /reload to reconnect this session to the sidebar and panes.").length === 2, 'no second recovery notice', 2500);
    // One recovery notice per outage: the reload reactivated Herdr, so the second outage notifies again.
    expect(f.notices.filter(message => message === "Herdr is running again. Run /reload to reconnect this session to the sidebar and panes.")).toHaveLength(2);
    expect(m.enabled()).toBe(false);
  } finally { for (const m of mounts.splice(0)) await m.dispose(); await f.h.close(); expect(await f.h.remainingOwnedResources()).toEqual([]); }
}, 60000);

test('after a recovery notice, session shutdown cancels the next inactive watcher', async () => {
  const f = await fixture();
  try {
    const m = f.mounted(); await f.start();
    let outage = await crashFakeCore(f.h); await m.guard({ toolName: 'bash', input: { command: 'true' } });
    await outage.recover();
    await until(async () => f.notices.includes("Herdr is running again. Run /reload to reconnect this session to the sidebar and panes."), 'no first recovery notice');
    f.nextSession(); await f.start(); expect(m.enabled(), f.notices.join('\n')).toBe(true);
    outage = await crashFakeCore(f.h); await m.guard({ toolName: 'bash', input: { command: 'true' } });
    await f.shutdown(); await outage.recover(); const calls = (await f.h.calls()).length;
    await delay(2500);
    expect(f.notices.filter(message => message === "Herdr is running again. Run /reload to reconnect this session to the sidebar and panes.")).toHaveLength(1);
    expect((await f.h.calls()).length).toBe(calls);
    expect(m.enabled()).toBe(false);
  } finally { for (const m of mounts.splice(0)) await m.dispose(); await f.h.close(); expect(await f.h.remainingOwnedResources()).toEqual([]); }
}, 60000);

test.skipIf(!realHc)('real hc holder recovery keeps the parent inactive and announces reload', async () => {
  const f = await fixture('hc');
  try {
    const m = f.mounted(); await f.start(); expect(m.enabled()).toBe(true);
    const before = await f.h.cli(['server', 'status', '--json']) as { pid: number; core: { id: string } };
    process.kill(before.pid, 'SIGKILL');
    await until(async () => !await isCoreAvailable(f.h.localEnv), 'core socket did not go down');
    await m.guard({ toolName: 'bash', input: { command: 'true' } }); expect(m.enabled()).toBe(false);
    await until(async () => f.notices.includes("Herdr is running again. Run /reload to reconnect this session to the sidebar and panes."), 'holder returned without a notice');
    const after = await f.h.cli(['server', 'status', '--json']) as typeof before;
    expect(after.core.id).toBe(before.core.id); expect(after.pid).not.toBe(before.pid);
    expect(m.enabled()).toBe(false); expect(m.owner()).toBeNull();
    expect(f.notices.filter(message => message === "Herdr is running again. Run /reload to reconnect this session to the sidebar and panes.")).toHaveLength(1);
    await f.start(); expect(m.enabled()).toBe(true);
  } finally { for (const m of mounts.splice(0)) await m.dispose(); await f.h.close(); expect(await f.h.remainingOwnedResources()).toEqual([]); console.log('real holder-recovery cleanup:', JSON.stringify(f.h.cleanupProof)); }
}, 60000);

test.skipIf(!realHc)('a real process outside the claimed hc terminal publishes no owner mapping or feed', async () => {
  const f = await fixture('hc');
  try {
    f.environment(false); const m = f.mounted(); await f.start();
    expect(m.enabled()).toBe(false); expect(m.owner()).toBeNull();
    expect(await f.registry.list()).toEqual([]);
    expect(f.noticeLevels).toEqual(['error']);
    expect(await access(f.feed).then(() => true, () => false)).toBe(false);
    expect(f.notices.filter(message => message.includes("This session isn't running in the Herdr pane it belongs to"))).toHaveLength(1);
    await f.start(); expect(f.notices.filter(message => message.includes("This session isn't running in the Herdr pane it belongs to"))).toHaveLength(1);
  } finally { await f.h.close(); expect(await f.h.remainingOwnedResources()).toEqual([]); console.log('real external-caller cleanup:', JSON.stringify(f.h.cleanupProof)); }
}, 60000);
