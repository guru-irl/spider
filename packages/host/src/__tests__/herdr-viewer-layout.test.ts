// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { access, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openGlobal, setGlobalDbPathForTests } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { setupHerdr, standardHerdrConfigPath, type SetupRequest } from '../../../herdr/src/setup/installer.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { createAppClient } from '../../../herdr/src/client/app.js';
import * as paneModule from '../../../herdr/src/jobs/placement.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { mountHerdr } from '../herdr/mount.js';
import { openSessionRunDb } from '../session-run-db.js';
import { RunStore } from '../../../subagents/src/run-store.js';
import { createSessionIpcClient } from '../../../herdr/src/feed/ipc-client.js';
import { createViewerFeedSource } from '../../../herdr/src/viewers/program.js';
import type { RunId, SessionFeed } from '../../../herdr/src/contracts.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setGlobalDbPathForTests(null); });
async function fixture(mode: 'fake' | 'hc', existingRun = false) {
  const h = await createHerdrHarness(mode); await h.start();
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
    const config = parseHerdrConfig({ enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') },
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
    return { h, mount, store, activeRun, emit, feed, feedRoot, ipc, app, errors, async close() {
      ipc.dispose(); await emit('session_shutdown', { reason: 'quit' }); await mount.dispose(); opened.db.close(); global.close();
      await writeFile(resolve(`.spider/scratch/fx5-layout-${mode}-diagnostics.json`), JSON.stringify({ errors: errors.map(error => String(error)), calls: await readFile(join(h.directories.local, 'app-calls.jsonl'), 'utf8'), app: await readFile(join(h.directories.local, 'app.json'), 'utf8'), core: await readFile(join(h.directories.local, 'core.json'), 'utf8') }, null, 2));
      await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
    } };
  } catch (error) { await h.close(); throw error; }
}

it.each(['quit', 'reload', 'new', 'resume', 'fork'] as const)('mounted %s leaves a displayed viewer in its exact pane', async reason => {
  // Catches pane-actor disposal parking; registration stop is tested separately.
  // Actor teardown runs first here, so later reservation release would be a no-op.
  const f = await fixture('fake');
  try {
    const { id } = f.store.create({ sessionId: f.feed.sessionId, agent: 'worker' }); f.store.start(id);
    const reply = await f.ipc.openRun(id as RunId);
    expect(reply).toMatchObject({ ok: true, op: 'openRun' });
    if (!reply.ok || reply.op !== 'openRun') throw new Error('Viewer not opened');
    const placed = await f.app.ownerPlacement(reply.viewer);
    await f.emit('session_shutdown', { reason });
    expect(await f.app.ownerPlacement(reply.viewer)).toEqual(placed);
    expect((await f.h.hc.get(reply.viewer)).state).toBe('live');
    const calls = (await readFile(join(f.h.directories.local, 'app-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(args => args[1] === 'terminal.park')).toEqual([]);
    if (reason !== 'quit') {
      if (reason !== 'reload') f.h.owner = { ...f.h.owner!, sessionId: randomUUID() as typeof f.feed.sessionId };
      await f.emit('session_start');
      expect(await f.app.ownerPlacement(reply.viewer)).toEqual(placed);
    }
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it.each([{ gated: false }, { gated: true }])('reload does not move a viewer from the tab the user kept it in (gated=$gated)', async ({ gated }) => {
  let release!: () => void, settled!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const oldOpenerSettled = new Promise<void>(resolve => { settled = resolve; });
  let tracked = false, held = false, heldOwner: string | undefined;
  if (gated) {
    const createPanes = paneModule.createAuxiliaryPanes;
    vi.spyOn(paneModule, 'createAuxiliaryPanes').mockImplementation(options => {
      const actor = createPanes({ ...options, app: { ...options.app, ownerPlacement: async address => {
        if (!held && address === heldOwner) { held = true; await gate; }
        return options.app.ownerPlacement(address);
      } } });
      return { ...actor, acquire: async (...args: Parameters<typeof actor.acquire>) => {
        const oldAutomatic = !tracked && Boolean(args[3].automatic);
        if (oldAutomatic) { tracked = true; heldOwner = args[2].terminal.address; }
        try { return await actor.acquire(...args); }
        finally { if (oldAutomatic) settled(); }
      } };
    });
  }
  const f = await fixture('fake', gated); let reloaded: ReturnType<typeof createSessionIpcClient> | undefined;
  try {
    const id = f.activeRun ?? f.store.create({ sessionId: f.feed.sessionId, agent: 'worker' }).id;
    if (!f.activeRun) f.store.start(id);
    if (gated) await expect.poll(() => held, { timeout: 5000 }).toBe(true);
    const first = await f.ipc.openRun(id as RunId);
    if (!first.ok || first.op !== 'openRun') throw new Error('Viewer not opened');
    await f.app.command('terminal.park', { terminal: first.viewer });
    await f.app.command('terminal.keep', { terminal: first.viewer, place: 'tab' });
    const placement = await f.app.ownerPlacement(first.viewer);
    await f.emit('session_shutdown', { reason: 'reload' }); await f.emit('session_start');
    release();
    if (gated) await oldOpenerSettled;
    const feed = await createViewerFeedSource(f.feedRoot, f.feed.sessionId).read();
    if (!feed?.ipc) throw new Error('Reload did not publish its endpoint');
    reloaded = createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc });
    expect(await reloaded.openRun(id as RunId)).toMatchObject({ ok: true, op: 'openRun', viewer: first.viewer });
    expect(await f.app.ownerPlacement(first.viewer)).toEqual(placement);
    expect((await f.h.hc.get(first.viewer)).labels['herdr.tab']).toBe(placement.tab);
    expect(f.errors).toEqual([]);
  } finally { release(); reloaded?.dispose(); await f.close(); }
}, 30000);

it('shutdown during an explicit reopen never hides or kills the already displayed viewer', async () => {
  const f = await fixture('fake');
  try {
    const { id } = f.store.create({ sessionId: f.feed.sessionId, agent: 'worker' }); f.store.start(id);
    const first = await f.ipc.openRun(id as RunId);
    if (!first.ok || first.op !== 'openRun') throw new Error('Viewer not opened');
    const placement = await f.app.ownerPlacement(first.viewer);
    const callsFile = join(f.h.directories.local, 'app-calls.jsonl');
    const count = async () => (await readFile(callsFile, 'utf8')).split('\n').filter(line => line.includes('pane.focus')).length;
    const before = await count();
    await f.h.scenario({ appSteps: [{ argvPrefix: ['do', 'pane.focus'], delayMs: 500 }] });
    const opening = f.ipc.openRun(id as RunId).catch(() => null);
    await expect.poll(count, { timeout: 3000 }).toBeGreaterThan(before);
    await f.emit('session_shutdown', { reason: 'reload' }); await opening;
    expect(await f.app.ownerPlacement(first.viewer)).toEqual(placement);
    expect((await f.h.hc.get(first.viewer)).state).toBe('live');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

const binary = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
const real = process.env.SPIDER_HERDR_E2E === '1' && await access(binary).then(() => true, () => false);
if (!real) console.info('SKIP mounted viewer real proof: requires hc and SPIDER_HERDR_E2E=1; app is a recording double, no window');
it.skipIf(!real)('real hc: the mounted viewer stays displayed and read-only after quit and owner removal', async () => {
  const f = await fixture('hc');
  try {
    const { id } = f.store.create({ sessionId: f.feed.sessionId, agent: 'worker' }); f.store.start(id);
    const reply = await f.ipc.openRun(id as RunId);
    expect(reply).toMatchObject({ ok: true, op: 'openRun' });
    if (!reply.ok || reply.op !== 'openRun') throw new Error('Viewer not opened');
    const placed = await f.app.ownerPlacement(reply.viewer);
    await f.emit('session_shutdown', { reason: 'quit' });
    expect(await f.app.ownerPlacement(reply.viewer)).toEqual(placed);
    await f.h.hc.kill(f.h.owner!.terminal.address); await f.h.hc.rm(f.h.owner!.terminal.address);
    expect((await f.h.hc.get(reply.viewer)).state).toBe('live');
    await expect.poll(() => f.h.hc.read(reply.viewer, { lines: 50 }), { timeout: 5000 }).toContain('Saved log is read-only');
    expect(await f.app.ownerPlacement(reply.viewer)).toEqual(placed);
    const feed = await createViewerFeedSource(f.feedRoot, f.feed.sessionId).read();
    expect(feed?.lifecycle).toBe('closed');
    await writeFile(resolve('.spider/scratch/fx5-viewer-real-evidence.json'), JSON.stringify({ localSocket: f.h.localSocket, remoteSocket: f.h.remoteSocket, localCore: f.h.localCoreId, remoteCore: f.h.remoteCoreId, viewer: reply.viewer, placement: placed, state: 'live', ownerRemoved: true, readOnly: true }, null, 2));
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 45000);
