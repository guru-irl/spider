import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { crashFakeCore } from '../../../herdr/src/__tests__/fake-core-crash.js';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import * as hcModule from '../../../herdr/src/client/hc.js';
import * as paneModule from '../../../herdr/src/jobs/placement.js';
import { mountHerdr } from '../herdr/mount.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  try { for (const close of cleanups.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } } }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  if (errors.length) throw new AggregateError(errors, 'Cleanup failed');
});
it.each(['new', 'resume', 'fork'].flatMap(reason => [{ reason, gated: false }, { reason, gated: true }]))('a cleanup failure still disposes the client and allows $reason reactivation (gated=$gated)', async ({ reason, gated }) => {
  const h = await createHerdrHarness('fake'); cleanups.push(() => h.close()); await h.start();
  const ownerPid = ((await h.cli(['ls', '--all', '--json'])) as { terminals: { address: string; pid?: number }[] }).terminals.find(t => t.address === h.owner!.terminal.address)?.pid;
  const killOwner = () => { if (ownerPid) { try { process.kill(ownerPid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } } };
  cleanups.push(async () => { killOwner(); });
  let outage: Awaited<ReturnType<typeof crashFakeCore>>;
  const f = { root: h.root, localEnv: h.localEnv, hcBinary: h.hcBinary, appBinary: h.appBinary,
    stopCore: async () => { outage = await crashFakeCore(h); }, listenCore: () => outage.recover(), close: () => h.close() };
  const globalRoot = join(f.root, 'global'), cwd = join(f.root, 'repo');
  await mkdir(cwd); execFileSync('git', ['init', '-q', cwd]);
  for (const [key, value] of Object.entries(f.localEnv)) if (value !== undefined && /^(HC_|XDG_|HERDR_)/.test(key)) vi.stubEnv(key, value);
  vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot); vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  const input = join(globalRoot, 'herdr/config.json'); await mkdir(join(globalRoot, 'herdr'), { recursive: true });
  const config = parseHerdrConfig({ enabled: true, core: { binary: f.hcBinary, config: join(f.root, 'core.toml') }, app: { binary: f.appBinary, home: join(f.root, 'app-home') }, globalRoot, agentDirectory: join(f.root, 'agent'), shellRc: join(f.root, 'shellrc'), spaces: [], machines: [] });
  await writeFile(input, JSON.stringify(config));
  const probe = hcModule.createHcClient({ binary: f.hcBinary, env: f.localEnv });
  await setupHerdr({ config, configPath: input, packageRoot: f.root, journalRoot: join(f.root, 'setup') }, {
    globalRoot, preflight: async () => ({ fingerprint: 'fixture', coreIdentity: await probe.identity(), mods: [], targets: [], retiredTerminals: [], layoutExport: true }),
    stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
    probeMachineNode: async () => { throw new Error('No remote machine'); }, ensureRuntime: async () => [], bootstrapRuntime: async () => {}, hc: probe,
    cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }), rollback: async () => {}, warn() {},
  });
  await probe.dispose();
  expect(JSON.parse(await readFile(input, 'utf8')).core.binary).toBe(f.hcBinary);
  const originalClient = hcModule.createHcClient, originalPanes = paneModule.createAuxiliaryPanes;
  let disposals = 0, fail = false;
  let releaseTeardown!: () => void, enteredTeardown!: () => void;
  let teardownHeld = false, overlappingDisposal = false;
  const teardownGate = new Promise<void>(resolve => { releaseTeardown = resolve; });
  const teardownEntered = new Promise<void>(resolve => { enteredTeardown = resolve; });
  vi.spyOn(hcModule, 'createHcClient').mockImplementation(options => { const client = originalClient(options); return { ...client, dispose: async () => { disposals++; if (teardownHeld) overlappingDisposal = true; await client.dispose(); } }; });
  vi.spyOn(paneModule, 'createAuxiliaryPanes').mockImplementation(options => { const panes = originalPanes(options); return { ...panes, dispose: async () => { await panes.dispose(); if (fail) { fail = false; enteredTeardown(); if (gated) { teardownHeld = true; await teardownGate; teardownHeld = false; } throw new Error('Pane cleanup failed'); } } }; });
  const hooks = new Map<string, Set<Function>>(), warnings: string[] = [];
  const pi = { on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); }, sendMessage() {}, registerTool() {}, registerShortcut() {}, getSessionName: () => undefined } as unknown as ExtensionAPI;
  const dbPath = join(f.root, 'runs.db'), globalPath = join(f.root, 'global.db');
  const db = openDbAt(dbPath, 'worktree'), globalDb = openDbAt(globalPath, 'global');
  const ctx = { cwd, mode: 'rpc', hasUI: false, isIdle: () => true, ui: { notify(message: string) { warnings.push(message); } }, sessionManager: { getSessionId: () => 'cleanup-session', getSessionFile: () => undefined, getBranch: () => [], getEntries: () => [] } } as unknown as ExtensionContext;
  const mount = mountHerdr(pi, { packageRoot: resolve('.'), actionContext: () => ({ db, globalDb, sessionId: 'cleanup-session', pi }) as never,
    views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
    dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} }, readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }) },
  });
  const emit = async (name: string, event: unknown = {}) => { for (const handler of [...hooks.get(name) ?? []]) await handler(event, ctx); };
  try {
    await emit('session_start'); expect(mount.enabled()).toBe(true); fail = true;
    await f.stopCore(); await expect.poll(() => existsSync(h.localSocket), { timeout: 5000, interval: 10 }).toBe(false);
    const lost = mount.guard({ toolName: 'spider', input: {} });
    if (gated) {
      await teardownEntered;
      expect(mount.enabled()).toBe(false);
      await f.listenCore();
      const restarting = emit('session_start', { reason });
      // Fault injection: keep the old pane cleanup pending across a full activation.
      // A new lifecycle must not dispose any of that activation's remaining resources.
      await Promise.race([restarting, new Promise<void>(resolve => setTimeout(resolve, 1000))]);
      releaseTeardown();
      await Promise.all([lost, restarting]);
    } else {
      await lost;
      await expect.poll(() => mount.enabled(), { timeout: 5000, interval: 25 }).toBe(false);
      expect(disposals).toBe(1);
      await f.listenCore(); await emit('session_start', { reason });
    }
    expect(disposals).toBe(1);
    expect(mount.enabled()).toBe(true);
    expect(overlappingDisposal).toBe(false);
    expect(warnings.filter(message => message.includes('core is not running'))).toEqual([]);
  } finally { releaseTeardown(); await mount.dispose(); db.close(); globalDb.close(); killOwner(); await f.close(); }
}, 30000);
