// SPDX-License-Identifier: MIT
import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, vi } from 'vitest';
import { openGlobal, setGlobalDbPathForTests } from '@spider/db-core';
import { createHostHerdrHarness } from './herdr-fixture-inventory.testutil.js';
import { setupHerdr, standardHerdrConfigPath, type SetupRequest } from '../../../herdr/src/setup/installer.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { createAppClient } from '../../../herdr/src/client/app.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { mountHerdr } from '../herdr/mount.js';
import { openSessionRunDb } from '../session-run-db.js';
import { RunStore } from '../../../subagents/src/run-store.js';
import { createSessionIpcClient } from '../../../herdr/src/feed/ipc-client.js';
import type { RunId, SessionFeed } from '../../../herdr/src/contracts.js';

interface MountedViewerFixture {
  h: Awaited<ReturnType<typeof createHostHerdrHarness>>;
  store: RunStore;
  activeRun: RunId | undefined;
  emit(name: string, event?: object): Promise<void>;
  feed: SessionFeed;
  feedRoot: string;
  ipc: ReturnType<typeof createSessionIpcClient>;
  app: ReturnType<typeof createAppClient>;
  errors: unknown[];
  close(): Promise<void>;
}

export async function mountedViewerFixture(mode: 'fake' | 'hc', existingRun = false, automaticSubagentPanes = false): Promise<MountedViewerFixture> {
  const h = await createHostHerdrHarness(mode); await h.start();
  try {
    // Real cores use a recording app double, never an app process or window.
    if (mode === 'hc') {
      const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
      const app = join(h.root, 'app-double'), source = join(h.root, 'app-double.mjs');
      await writeFile(join(h.root, 'hc'), `#!/bin/sh\nexec ${quote(h.hcBinary)} "$@"\n`); await chmod(join(h.root, 'hc'), 0o700);
      await writeFile(source, `import { execFileSync } from 'node:child_process'; import { writeFileSync } from 'node:fs';\nprocess.env.HERDR_FAKE_ROOT=${JSON.stringify(h.directories.local)}; process.env.HERDR_TEST_ROOT=${JSON.stringify(h.root)};\nconst rows=JSON.parse(execFileSync(${JSON.stringify(h.hcBinary)},['ls','--all','--json'],{env:process.env})).terminals;\nwriteFileSync(${JSON.stringify(join(h.directories.local, 'core.json'))},JSON.stringify({terminals:rows.map(row=>JSON.parse(execFileSync(${JSON.stringify(h.hcBinary)},['get',row.address,'--json'],{env:process.env})))}));\nawait import(${JSON.stringify(resolve('packages/herdr/src/__tests__/fake-app.mjs'))});\n`);
      await writeFile(app, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`); await chmod(app, 0o700);
      h.appBinary = app;
      await writeFile(join(h.directories.local, 'app.json'), JSON.stringify({ spaces: [{ id: 's1', name: 'Fixture', tabs: [{ id: 'tb1', name: 'Owner', terminals: [{ terminal: h.owner!.terminal.address, pane: 'p1' }] }] }] }));
      await writeFile(join(h.directories.local, 'app-calls.jsonl'), '');
    }
    for (const [name, value] of Object.entries(h.localEnv)) if (value !== undefined && /^(HC_|XDG_|HERDR_)/.test(name)) vi.stubEnv(name, value);
    vi.stubEnv('PI_SUBAGENT_CHILD', '0'); vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
    const file = standardHerdrConfigPath(h.directories.global);
    const config = parseHerdrConfig({ enabled: true, automaticSubagentPanes, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') },
      agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'programs'), cwd: null, commands: {} } }] });
    await mkdir(join(h.root, 'packages/herdr'), { recursive: true });
    await cp(resolve('packages/herdr/assets'), join(h.root, 'packages/herdr/assets'), { recursive: true });
    await cp(resolve('dist/herdr'), join(h.root, 'dist/herdr'), { recursive: true });
    await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, JSON.stringify(config)); await writeFile(join(h.directories.app, 'settings.json'), '{}');
    const request: SetupRequest = { config, configPath: file, packageRoot: h.root, journalRoot: join(h.directories.global, 'herdr/setup') };
    const cli = createProductionHerdrCliPorts(h.root, h.localEnv);
    try {
      const production = await cli.setupParts(request);
      await setupHerdr(request, { ...production,
        preflight: async () => ({ fingerprint: 'layout-proof', coreIdentity: await h.hc.identity(), layoutExport: true, targets: [], retiredTerminals: [], mods: ['spider-panel', 'spider-machines'].map(name => ({ directory: join(h.directories.app, 'mods', name) })) }),
        stageLook: async () => [], generateTemplates: async () => [], cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
      });
    } finally { await cli.dispose(); }
    execFileSync('git', ['init', '-q', h.directories.local]);
    setGlobalDbPathForTests(join(h.directories.global, 'global.db')); const global = openGlobal();
    const opened = openSessionRunDb(h.directories.local, h.owner!.sessionId), store = new RunStore(opened.db);
    let activeRun: RunId | undefined;
    if (existingRun) { const { id } = store.create({ sessionId: h.owner!.sessionId, agent: 'worker' }); store.start(id); activeRun = id as RunId; }
    const hooks = new Map<string, Set<Function>>(), errors: unknown[] = [];
    const pi = { on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); }, getSessionName() {}, registerTool() {}, registerShortcut() {}, sendMessage() {} };
    const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => h.owner!.sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
    const mount = mountHerdr(pi as never, { packageRoot: h.root, reportError: error => errors.push(error), views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } }, actionContext: () => ({ db: opened.db, globalDb: global, sessionId: h.owner!.sessionId, pi }) });
    const emit = async (name: string, event: object = {}) => { for (const handler of [...hooks.get(name) ?? []]) await handler(event, ctx); };
    await emit('session_start');
    const feedRoot = join(h.directories.global, 'herdr'), sessionId = h.owner!.sessionId;
    const feed = JSON.parse(await readFile(join(feedRoot, 'sessions', sessionId, 'session.json'), 'utf8')) as SessionFeed;
    const ipc = createSessionIpcClient({ version: 1, sessionId, generation: feed.generation, ...feed.ipc! });
    const app = createAppClient({ binary: h.appBinary, env: h.localEnv });
    return { h, store, activeRun, emit, feed, feedRoot, ipc, app, errors, async close() {
      ipc.dispose(); await emit('session_shutdown', { reason: 'quit' }); await mount.dispose(); opened.db.close(); global.close();
      await writeFile(resolve(`.spider/scratch/fx5-layout-${mode}-${basename(h.root)}-diagnostics.json`), JSON.stringify({ errors: errors.map(error => String(error)), calls: await readFile(join(h.directories.local, 'app-calls.jsonl'), 'utf8'), app: await readFile(join(h.directories.local, 'app.json'), 'utf8'), core: await readFile(join(h.directories.local, 'core.json'), 'utf8') }, null, 2));
      await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
    } };
  } catch (error) { await h.close(); throw error; }
}
