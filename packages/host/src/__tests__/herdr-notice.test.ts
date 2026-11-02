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

const realHc = process.env.SPIDER_HERDR_E2E === '1' && await access(process.env.SPIDER_HERDR_HC_BINARY ?? join(process.env.HOME!, '.local/bin/hc')).then(() => true, () => false);
if (!realHc) console.log('real hc notice control skipped: set SPIDER_HERDR_E2E=1 with hc installed');
for (const mode of ['fake', 'hc'] as const) test.skipIf(mode === 'hc' && !realHc)(`${mode} outage produces one notice despite several failing handlers, then one recovery notice`, async () => {
  const f = await fixture(mode), paused = new Set<number>();
  let m: HerdrMount | undefined;
  try {
    m = f.mounted();
    // The core dies between mount activation and the other session hooks. Those
    // real handlers fail concurrently, before and during inactive teardown.
    const [activate, ...handlers] = f.hooks.get('session_start')!;
    await activate({ reason: 'reload' }, f.ctx); expect(m.enabled()).toBe(true);
    const before = await f.h.cli(['server', 'status', '--json']) as { pid: number; core: { id: string }; holders: { pid: number }[] };
    if (mode === 'hc') {
      for (const holder of before.holders) { process.kill(holder.pid, 'SIGSTOP'); paused.add(holder.pid); }
      process.kill(before.pid, 'SIGKILL');
    } else await crashFakeCore(f.h);
    await until(async () => !await isCoreAvailable(f.h.localEnv), 'core did not go down');
    // Preserve the real socket-guard failure at the host data boundary so the
    // independent feed and viewer handlers report it alongside job activation.
    const unavailable = await f.h.hc.identity().catch(error => error);
    expect(unavailable).toMatchObject({ code: 'core-unavailable' });
    f.storageError(unavailable);
    await Promise.all(handlers.map(hook => hook({ reason: 'reload' }, f.ctx)));
    await until(async () => !m!.enabled(), 'parent did not go inactive');
    await m.guard({ toolName: 'bash', input: { command: 'true' } });
    expect(f.errors.filter(error => error instanceof HerdrError && error.code === 'core-unavailable').length).toBeGreaterThanOrEqual(2);
    expect(f.notices).toEqual([expect.stringContaining("Herdr stopped responding")]);
    // Match the reported outage duration; repeated guards must not add notices.
    for (let i = 0; i < 5; i++) { await delay(2000); await m.guard({ toolName: 'bash', input: { command: 'true' } }); }
    expect(f.notices).toHaveLength(1);
    // An inactive session still reports unrelated bookkeeping failures once.
    const sessionFile = f.ctx.sessionManager.getSessionFile;
    Reflect.set(f.ctx.sessionManager, 'getSessionFile', () => { throw new Error('Unrelated session metadata failure'); });
    try {
      for (let i = 0; i < 2; i++) for (const hook of f.hooks.get('session_info_changed') ?? []) await hook({}, f.ctx);
    } finally { Reflect.set(f.ctx.sessionManager, 'getSessionFile', sessionFile); }
    expect(f.notices).toEqual([expect.stringContaining("Herdr stopped responding"), "Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine."]);
    expect(f.errors.filter(error => error instanceof Error && error.message === 'Unrelated session metadata failure')).toHaveLength(2);
    if (mode === 'hc') { for (const pid of paused) process.kill(pid, 'SIGCONT'); paused.clear(); }
    else await f.h.cli(['server', 'start', '--json']);
    await until(async () => f.notices.includes("Herdr is running again. Run /reload to reconnect this session to the sidebar and panes."), 'no recovery notice');
    expect(f.notices).toEqual([expect.stringContaining("Herdr stopped responding"), "Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine.", "Herdr is running again. Run /reload to reconnect this session to the sidebar and panes."]);
    expect(m.enabled()).toBe(false);
    const after = await f.h.cli(['server', 'status', '--json']) as typeof before;
    expect(after.core.id).toBe(before.core.id);
    console.log(`${mode} outage diagnostic codes:`, f.errors.map(error => error instanceof HerdrError ? error.code : String(error)));
  } finally {
    await m?.dispose();
    for (const pid of paused) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    await f.h.close(); expect(await f.h.remainingOwnedResources()).toEqual([]);
    await writeFile(resolve(`.spider/scratch/notice-evidence-${mode}.json`), JSON.stringify({ notices: f.notices,
      diagnostics: f.errors.map(error => error instanceof HerdrError ? { code: error.code, message: error.message } : String(error)), cleanup: f.h.cleanupProof }, null, 2));
    console.log(`${mode} notice cleanup:`, JSON.stringify(f.h.cleanupProof));
  }
}, 60000);

test('a distinct unrelated error reports once per session across repeated hooks and remounts, without losing diagnostics', async () => {
  const f = await fixture();
  let m = f.mounted();
  f.storageError(new Error('Usage snapshot could not be read'));
  await f.start(); await f.start();
  expect(f.notices).toEqual(["Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine."]);
  expect(f.storageFailures()).toBeGreaterThanOrEqual(4);
  expect(f.errors.length).toBeGreaterThanOrEqual(f.storageFailures());
  await m.dispose(); f.hooks.clear(); m = f.mounted(); await f.start();
  expect(f.notices).toEqual(["Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine."]);
  f.storageError(new Error('Another unrelated failure')); await f.start(); await f.start();
  expect(f.notices).toEqual(["Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine."]);
  f.nextSession(); await f.start();
  expect(f.notices).toEqual(["Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine.", "Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine."]);
  expect(f.errors.length).toBeGreaterThanOrEqual(f.storageFailures());
}, 60000);


test('repeated notices return after 60 seconds independently for each session and catalog entry', async () => {
  const f = await fixture();
  f.mounted();
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const paneNotices = () => f.notices.filter(text => text.includes("Herdr couldn't open a pane for this session"));
  f.storageError(new HerdrError('pane-timeout', 'first failure'));
  await f.start();
  expect(paneNotices()).toHaveLength(1);
  now += 59_999;
  await f.start();
  expect(paneNotices()).toHaveLength(1);
  f.storageError(new HerdrError('owner-unplaced', 'different failure'));
  await f.start();
  expect(f.notices.some(text => text.includes("Herdr couldn't find the session pane"))).toBe(true);
  f.storageError(new HerdrError('pane-timeout', 'second failure'));
  f.nextSession();
  await f.start();
  expect(paneNotices()).toHaveLength(2);
  now += 1;
  // Return to the original session at exactly the boundary.
  Reflect.set(f.ctx.sessionManager, 'getSessionId', () => 'notice-session');
  await f.start();
  expect(paneNotices()).toHaveLength(3);
}, 60000);

test('non-actionable pane diagnostics do not notify pi', async () => {
  const f = await fixture();
  f.mounted();
  for (const code of ['pane-removal-timeout', 'agent-pane-protected', 'run-finished']) {
    const error = new HerdrError(code, `Details for ${code}`);
    f.storageError(error); await f.start();
    expect(f.errors).toContain(error);
  }
  expect(f.notices).toEqual([]);
}, 60000);

test('a failed initial feed retries on ordinary refresh without another session start', async () => {
  const f = await fixture(), m = f.mounted();
  const feedPath = join(f.h.directories.global, 'herdr/sessions', f.ctx.sessionManager.getSessionId(), 'session.json');
  f.storageError(new Error('Initial feed storage unavailable'));
  await f.start();
  expect(f.notices).toEqual(["Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine."]);
  expect(m.enabled()).toBe(true);
  f.storageError(undefined);
  await until(async () => access(feedPath).then(() => true, () => false), 'feed did not recover after initial storage failure');
  const { readFile } = await import('node:fs/promises');
  expect(JSON.parse(await readFile(feedPath, 'utf8'))).toMatchObject({ version: 1, sessionId: f.ctx.sessionManager.getSessionId(), lifecycle: 'live' });
}, 30000);

test('a setup-launched session reloads without a reservation warning in pi', async () => {
  const f = await fixture();
  const { launchSession } = await import('../../../herdr/src/sessions/launcher.js');
  const { createSessionLeases } = await import('../../../herdr/src/sessions/lease.js');
  const { createProcessPresence } = await import('../../../herdr/src/sessions/presence.js');
  const { processStartTime } = await import('../../../subagents/src/process-identity.js');
  const file = join(f.h.directories.local, 'planner.jsonl');
  const id = f.ctx.sessionManager.getSessionId();
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id, cwd: f.h.directories.local }) + '\n');
  const root = join(f.h.directories.global, 'herdr'), leases = createSessionLeases(root), presence = createProcessPresence(root);
  const identity = { pid: process.pid, startIdentity: processStartTime(process.pid)! };
  const inventory = { leases, presence, processes: async () => [], probe: async (pid: number) => pid === identity.pid ? { kind: 'live' as const, startIdentity: identity.startIdentity } : { kind: 'absent' as const } };
  let launchEnv: Readonly<NodeJS.ProcessEnv> = {};
  await launchSession({ sessionFile: file, sessionId: id as never, cwd: f.h.directories.local, environment: { agentDirectory: f.h.directories.agent, extensionArguments: [] } },
    { leases, processInventory: inventory, processIdentity: identity, leasePolicy: { mode: 'switch', sessionId: id as never }, env: process.env,
      spawnPi: async request => { launchEnv = request.env; return identity; } });
  vi.stubEnv('SPIDER_HERDR_LEASE_TOKEN', launchEnv.SPIDER_HERDR_LEASE_TOKEN);
  vi.stubEnv('SPIDER_HERDR_LEASE_FILE', launchEnv.SPIDER_HERDR_LEASE_FILE);
  Reflect.set(f.ctx.sessionManager, 'getSessionFile', () => file);
  let mount = f.mounted();
  await f.start();
  expect(mount.enabled()).toBe(true);
  expect(f.notices).toEqual([]);
  for (const hook of [...f.hooks.get('session_shutdown') ?? []]) await hook({ reason: 'reload' }, f.ctx);
  await mount.dispose(); f.hooks.clear();
  mount = f.mounted(); await f.start();
  expect(mount.enabled()).toBe(true);
  expect(f.notices).toEqual([]);
  expect(f.errors).toEqual([]);
  expect(await leases.get(file)).toMatchObject(identity);
  for (const hook of [...f.hooks.get('session_shutdown') ?? []]) await hook({ reason: 'quit' }, f.ctx);
  expect(await leases.get(file)).toBeNull();
}, 60000);

test('session handoff and unknown errors reach pi as actionable notices while diagnostics stay available', async () => {
  const f = await fixture();
  f.mounted();
  const handoff = new HerdrError('lease-token-invalid', 'Lease adoption requires the launcher capability');
  f.storageError(handoff);
  await f.start();
  expect(f.notices).toEqual(["Spider couldn't register this session with Herdr, so reopening it later may not work. This session still works. Close and reopen the session in Herdr."]);
  expect(f.errors).toContain(handoff);
  const unexpected = new HerdrError('future-failure', 'private diagnostic');
  f.storageError(unexpected);
  await f.start();
  expect(f.notices.at(-1)).toBe("Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine (future-failure).");
  expect(f.errors).toContain(unexpected);
}, 60000);

test('a disconnected event transport with a live core still reports once', async () => {
  const f = await fixture(), m = f.mounted();
  f.storageError(new HerdrError('events-disconnected', 'Event transport disconnected'));
  await f.start(); await f.start();
  await until(async () => f.notices.length > 0, 'live-core transport failure was hidden');
  expect(await isCoreAvailable(f.h.localEnv)).toBe(true);
  expect(m.enabled()).toBe(true);
  expect(f.notices).toEqual(["Herdr stopped sending updates to this session, so the sidebar and panes may be out of date. Everything else in spider still works. Run /reload to reconnect."]);
  expect(f.errors.length).toBeGreaterThanOrEqual(f.storageFailures());
}, 60000);
