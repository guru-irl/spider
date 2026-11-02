// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { access, copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { crashFakeCore } from '../../../herdr/src/__tests__/fake-core-crash.js';
import { setupHerdr, standardHerdrConfigPath } from '../../../herdr/src/setup/installer.js';
import { isCoreAvailable } from '../../../herdr/src/client/liveness.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { controlConfig } from '../control.js';
import { mountHerdr, type HerdrMount } from '../herdr/mount.js';

async function until(check: () => Promise<boolean>, description: string, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error(description); await delay(25); }
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.unstubAllEnvs(); vi.restoreAllMocks(); }
});

async function fixture(mode: 'fake' | 'hc' = 'fake') {
  const h = await createHerdrHarness(mode); cleanup.push(() => h.close()); await h.start();
  execFileSync('git', ['init', '-q', h.directories.local]);
  await mkdir(join(h.root, 'dist/herdr'), { recursive: true });
  for (const name of ['cli.mjs', 'remote-runtime.mjs']) await copyFile(resolve('dist/herdr', name), join(h.root, 'dist/herdr', name));
  await cp(resolve('packages/herdr/assets'), join(h.root, 'packages/herdr/assets'), { recursive: true });
  await mkdir(join(h.directories.global, 'herdr'), { recursive: true });
  await writeFile(standardHerdrConfigPath(h.directories.global), JSON.stringify({ enabled: true,
    core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') },
    app: { binary: mode === 'fake' ? h.appBinary : join(h.root, 'no-app'), home: h.directories.app },
    agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [],
    machines: [{ name: 'remote.invalid', aliases: [], nodePath: process.execPath,
      runtime: { cwd: null, directory: join(h.directories.remote, 'programs'), commands: {} } }] }));
  await writeFile(join(h.directories.app, 'settings.json'), '{}');
  const ports = createProductionHerdrCliPorts(h.root, h.localEnv);
  vi.stubEnv('SPIDER_TEST_FIXTURE_CHECKOUT', resolve('.'));
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(h.directories.local);
  try {
    const request = await ports.request(), parts = await ports.setupParts(request);
    await setupHerdr(request, { ...parts,
      // No app window or cutover: exercise the real installer and runtime bootstrap.
      preflight: async () => ({ fingerprint: 'notice-test', coreIdentity: h.owner!.terminal,
        mods: ['panel', 'machines'].map(name => ({ directory: join(h.directories.app, 'mods', `spider-${name}`) })),
        targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'isolated' }], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], generateTemplates: async () => [], cutover: async () => ({ terminals: [], identities: {} }),
      verify: async () => ({ checks: [], failures: [], warnings: [], probes: [] }),
    });
  } finally { cwd.mockRestore(); await ports.dispose(); }
  const dbPath = join(h.root, 'runs.db'), globalPath = join(h.root, 'global.db');
  openDbAt(dbPath, 'worktree').close(); openDbAt(globalPath, 'global').close();
  const hooks = new Map<string, Function[]>(), notices: string[] = [], errors: unknown[] = [];
  let session = 'notice-session', storageError: unknown, storageFailures = 0;
  const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI: true, isIdle: () => true,
    sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    ui: { notify: (message: string) => notices.push(message), setStatus() {}, setWidget() {}, setFooter() {} } };
  const pi = { on: (name: string, handler: Function) => {
    const handlers = hooks.get(name) ?? []; handlers.push(handler); hooks.set(name, handlers);
    return () => { const index = handlers.indexOf(handler); if (index >= 0) handlers.splice(index, 1); };
  }, registerTool() {}, registerCommand() {}, registerShortcut() {}, sendMessage() {} };
  for (const [key, value] of Object.entries(h.localEnv)) if (value !== undefined) vi.stubEnv(key, value);
  vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  controlConfig('set', h.directories.local, 'herdr.enabled', true, 'global');
  const mounted = () => {
    const mount = mountHerdr(pi as never, { packageRoot: h.root, actionContext: () => ({}), reportError: error => errors.push(error),
      views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } },
      dataSource: { resolveRunDb: () => { if (storageError) { storageFailures++; throw storageError; } return { db: openDbAt(dbPath, 'worktree'), dbPath }; },
        openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }),
        readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } } });
    cleanup.push(async () => { await mount.dispose(); }); return mount;
  };
  const start = async () => { for (const hook of [...hooks.get('session_start') ?? []]) await hook({ reason: 'reload' }, ctx); };
  return { h, ctx, hooks, notices, errors, mounted, start, storageError: (error: unknown) => { storageError = error; }, storageFailures: () => storageFailures, nextSession: () => { session = 'next-notice-session'; } };
}

async function outage(f: Awaited<ReturnType<typeof fixture>>, m: HerdrMount) {
  await crashFakeCore(f.h);
  await until(async () => !await isCoreAvailable(f.h.localEnv), 'core did not stop');
  await m.guard({ toolName: 'bash', input: { command: 'true' } });
  await until(async () => !m.enabled(), 'mount did not go inactive');
  for (let i = 0; i < 3; i++) await m.guard({ toolName: 'bash', input: { command: 'true' } });
}
async function back(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  await f.h.cli(['server', 'start', '--json']);
  await until(async () => f.notices.length === count, 'missing core-back notice');
  await delay(2100);
  expect(f.notices).toHaveLength(count);
}

test('an inactive session stays silent on later outages without reload', async () => {
  const f = await fixture(), m = f.mounted();
  await f.start(); expect(m.enabled()).toBe(true);
  await outage(f, m);
  expect(f.notices).toEqual([expect.stringContaining("Herdr stopped responding")]);
  await back(f, 2);
  expect(f.notices).toEqual([expect.stringContaining("Herdr stopped responding"), "Herdr is running again. Run /reload to reconnect this session to the sidebar and panes."]);
  expect(m.enabled()).toBe(false);
  await outage(f, m);
  await f.h.cli(['server', 'start', '--json']);
  await delay(2100);
  expect(m.enabled()).toBe(false);
  expect(f.notices).toHaveLength(2);
}, 60000);

test('successful reload rearms one loss and one recovery notice for each new outage', async () => {
  const f = await fixture(); let m = f.mounted();
  await f.start(); expect(m.enabled()).toBe(true);
  await outage(f, m);
  expect(f.notices).toEqual([expect.stringContaining("Herdr stopped responding")]);
  await back(f, 2);
  for (let cycle = 1; cycle <= 2; cycle++) {
    await m.dispose(); f.hooks.clear(); m = f.mounted(); await f.start();
    expect(m.enabled()).toBe(true);
    expect(f.notices).toHaveLength(cycle * 2);
    await outage(f, m);
    expect(f.notices).toHaveLength(cycle * 2 + 1);
    expect(f.notices.at(-1)).toContain("Herdr stopped responding");
    await back(f, cycle * 2 + 2);
    expect(f.notices.at(-1)).toBe("Herdr is running again. Run /reload to reconnect this session to the sidebar and panes.");
    expect(m.enabled()).toBe(false);
  }
}, 90000);
