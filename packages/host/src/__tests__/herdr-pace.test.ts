// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { configFixtureCwd } from './herdr-config-fixture.js';
import { createHerdrHarness, type HerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { globalConfigForTest } from '../../../db-core/src/__tests__/global-config.testutil.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
const mods = process.env.SPIDER_HERDR_MOD_FIXTURE;
if (!mods) console.info('SKIP production pace feed: set SPIDER_HERDR_MOD_FIXTURE to the upstream Herdr mods');
describe.skipIf(!mods)('production pace feed', () => {
  let h: HerdrHarness;
  let ports: ReturnType<typeof createProductionHerdrCliPorts>;

  beforeAll(async () => {
    h = await createHerdrHarness('fake'); await h.start();
    expect(h.localSocket).toContain(h.root); expect(h.remoteSocket).toContain(h.root);
    expect(h.localSocket).not.toContain('/default/default.sock');
    execFileSync('git', ['init', '-q', h.directories.local]);
    const root = join(h.root, 'package');
    await mkdir(join(root, 'packages/herdr'), { recursive: true });
    await cp(resolve('packages/herdr/assets'), join(root, 'packages/herdr/assets'), { recursive: true });
    await mkdir(join(root, 'dist/herdr'), { recursive: true });
    await writeFile(join(root, 'dist/herdr/remote-runtime.mjs'), stripTypeScriptTypes(await readFile(resolve('packages/herdr/src/remote/runtime.ts'), 'utf8')));
    await mkdir(join(h.directories.agent, 'sessions'), { recursive: true });
    for (const kind of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome']) {
      const target = join(h.directories.app, 'mods', kind);
      await cp(join(mods!, kind), target, { recursive: true });
    }
    await mkdir(join(h.directories.app, 'layouts'), { recursive: true });
    await writeFile(join(h.directories.app, 'layouts/main.json'), JSON.stringify({ children: [
      { id: 'brand', content: { mod: 'workspace-chrome' } }, { id: 'sidebar', content: { mod: 'agents' } }, { id: 'spaces', content: { mod: 'spaces' } }, { id: 'tabs', content: { mod: 'tabs' } },
      { id: 'work-body', children: [{ id: 'main', content: { tab: 'active', pane: { header: { content: { mod: 'pane' } } } } },
        { id: 'panel', children: [{ id: 'panel-body', type: 'stack', children: [{ id: 'files' }, { id: 'changes' }] }] }] },
    ] }));
    await writeFile(join(h.directories.app, 'settings.json'), '{"theme":"stock"}');
    await writeFile(join(h.directories.agent, 'settings.json'), '{"theme":"stock"}');
    const script = join(h.root, 'app-selection.mjs');
    await writeFile(script, `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), path = process.env.HERDR_APP_HOME + '/settings.json';
if (args[0] === '--version') console.log('herdr-app 0.1.12');
else if (args[0] === 'do') { const s = JSON.parse(readFileSync(path, 'utf8')); if (args[1] === 'layout.switch') s.layout = args[args.indexOf('--name') + 1]; if (args[1] === 'app.theme') s.theme = args[args.indexOf('--name') + 1]; writeFileSync(path, JSON.stringify(s)); console.log('{}'); }
else console.log('{"spaces":[]}');\n`);
    const app = join(h.root, 'app-selection'); await writeFile(app, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`); await chmod(app, 0o700);
    const configPath = join(h.root, 'config.json');
    await writeFile(configPath, JSON.stringify({ app: { binary: app, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'programs'), cwd: null, commands: {} } }] }));
    vi.spyOn(ModelRegistry.prototype, 'getAvailable').mockImplementation(function (this: ModelRegistry) { return this.getAll(); });
    ports = configFixtureCwd(createProductionHerdrCliPorts(root, { ...h.localEnv, SPIDER_GLOBAL_ROOT: h.directories.global }), h.directories.local);
    const request = await ports.request(configPath);
    const installed = await setupHerdr(request, await ports.setupParts(request));
    expect(installed.probes).toHaveLength(1);
    const config = join(h.directories.global, 'config.json');
    await writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config, 'utf8')), 'usage.monthlyBudget': 70, 'usage.counter.poll': false, 'usage.footer': false, 'usage.calibration': 'off', organism: { enabled: false } }));
    for (const [name, value] of Object.entries(h.localEnv)) if (value !== undefined && (name.startsWith('HC_') || name.startsWith('XDG_') || name.startsWith('HERDR_'))) vi.stubEnv(name, value);
    vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global); vi.stubEnv('PI_CODING_AGENT_DIR', h.directories.agent); vi.stubEnv('PI_SUBAGENT_CHILD', '0');
    vi.resetModules();
  }, 120_000);

  afterAll(async () => {
    await ports?.dispose();
    if (h) { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules();
  }, 120_000);

  test('two ledger readings a day apart project usage without producing retired budget notices', async () => {
    globalConfigForTest(h.directories.global).set('herdr.enabled', true);
    const { openUsageLedger } = await import('../usage/ledger.js');
    const file = join(h.directories.global, 'usage.db');
    const ledger = openUsageLedger(file);
    const now = Date.parse('2026-11-15T12:00:00Z'), day = 86400000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const resetDate = new Date(now + 14 * day).toISOString().slice(0, 10);
    const counter = (ts: number, creditsUsed: number) => ({ ts, creditsUsed, accountLogin: 'fixture', entitlement: 1000, resetDate, raw: {} });
    const { default: extension, loadedBundle } = await import('../extension.js');
    const feedPath = join(h.directories.global, 'herdr/sessions', h.owner!.sessionId, 'session.json');
    const capture = async () => {
      const hooks = new Map<string, Function[]>();
      const pi = { getSessionName: () => undefined, registerTool() {}, registerCommand() {}, registerShortcut() {}, on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; }, sendMessage() {} };
      const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI: false, isIdle: () => true, ui: { notify() {}, setWidget() {}, setFooter() {}, setStatus() {} }, sessionManager: { getSessionId: () => h.owner!.sessionId, getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined, getSessionName: () => undefined } };
      const sourceUrl = loadedBundle.url;
      loadedBundle.url = pathToFileURL(resolve('dist/extension.js')).href;
      try { extension(pi as never); } finally { loadedBundle.url = sourceUrl; }
      try {
        for (const handler of hooks.get('session_start') ?? []) await handler({ reason: 'startup' }, ctx);
        return await vi.waitFor(async () => {
          const feed = JSON.parse(await readFile(feedPath, 'utf8'));
          if (feed.pace.updatedAt === null) throw new Error('Waiting for the usage worker snapshot');
          return feed;
        }, { timeout: 10000, interval: 25 });
      } finally {
        for (const handler of hooks.get('session_shutdown') ?? []) await handler({ reason: 'quit' }, ctx);
      }
    };
    try {
      ledger.insertCounter(counter(now - 5 * day, 50));
      const one = await capture();
      expect(one.pace.used).toBe(50);
      expect(one.pace.projected).toBeNull();
      expect(one.notifications.some((n: any) => n.kind === 'budget' && n.id.endsWith(':projected'))).toBe(false);
      ledger.insertCounter(counter(now - 6 * day, 40));
      const two = await capture();
      expect(two.pace.used).toBe(50);
      expect(two.pace.projected).not.toBeNull();
      expect(two.pace.projected).toBeGreaterThan(70);
      expect(two.notifications.filter((n: any) => n.kind === 'budget')).toEqual([]);
    } finally { ledger.close(); }
  }, 120_000);
});
