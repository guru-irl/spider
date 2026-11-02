// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openGlobal, setGlobalDbPathForTests, type Db } from '@spider/db-core';
import { cleanupScratch } from '@spider/db-core/testutil';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { setupHerdr, standardHerdrConfigPath, type SetupRequest } from '../../../herdr/src/setup/installer.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { createProductionHerdrCliPorts, createViewerPorts } from '../herdr/ports.js';
import { mountHerdr } from '../herdr/mount.js';
import { openSessionRunDb } from '../session-run-db.js';
import { RunStore } from '../../../subagents/src/run-store.js';
import { createSessionIpcClient } from '../../../herdr/src/feed/ipc-client.js';
import type { RunId, IpcDescriptor } from '../../../herdr/src/contracts.js';
import { createViewerLauncher } from '../../../herdr/src/viewers/register.js';
import { runViewer, createViewerFeedSource } from '../../../herdr/src/viewers/program.js';

const observed = vi.hoisted(() => ({ readonly: [] as Db[], closed: 0 }));
vi.mock('@spider/db-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@spider/db-core')>();
  return { ...actual, openGlobalReadOnly: () => { const db = actual.openGlobalReadOnly(); if (db) { observed.readonly.push(db); const close = db.close.bind(db); db.close = () => { observed.closed++; close(); }; } return db; } };
});
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); for (const db of observed.readonly.splice(0)) if (db.raw.open) db.close(); observed.closed = 0; vi.unstubAllEnvs(); setGlobalDbPathForTests(null); cleanupScratch(); });

async function fixture(mode: 'fake' | 'hc' = 'fake', endingOwner = false) {
  const h = await createHerdrHarness(mode); cleanups.push(() => h.close()); await h.start();
  const endOwner = join(h.root, 'end-owner');
  if (endingOwner) {
    const parent = await h.hc.run({ argv: [process.execPath, '-e', `const fs=require('node:fs'); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(endOwner)})){clearInterval(t);process.exit(0)}},50)`], cwd: h.root, parent: null, background: true, outliveParent: true, noNotify: true, labels: {} });
    h.localEnv.HC_TERMINAL_ID = parent.address;
    h.owner = { ...h.owner!, terminal: await h.hc.caller(h.localEnv) };
  }
  for (const [name, value] of Object.entries(h.localEnv)) if (value !== undefined && /^(HC_|XDG_|HERDR_)/.test(name)) vi.stubEnv(name, value);
  vi.stubEnv('PI_SUBAGENT_CHILD', '0'); vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
  const configPath = standardHerdrConfigPath(h.directories.global);
  const request: SetupRequest = { config: parseHerdrConfig({ enabled: true, app: { binary: h.appBinary, home: h.directories.app },
    core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') },
    agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'programs'), cwd: null, commands: {} } }] }),
    configPath, packageRoot: h.root, journalRoot: join(h.directories.global, 'herdr/setup') };
  await mkdir(join(h.root, 'packages/herdr'), { recursive: true });
  await cp(resolve('packages/herdr/assets'), join(h.root, 'packages/herdr/assets'), { recursive: true });
  await cp(resolve('dist/herdr'), join(h.root, 'dist/herdr'), { recursive: true });
  await mkdir(join(configPath, '..'), { recursive: true }); await writeFile(configPath, JSON.stringify(request.config));
  await writeFile(join(h.directories.app, 'settings.json'), '{}');
  const cli = createProductionHerdrCliPorts(h.root, h.localEnv); cleanups.push(() => cli.dispose());
  const production = await cli.setupParts(request);
  // Layout inspection and a doctor result are external ports. Install files,
  // config registration, resume hook and runtime planning use production code.
  await setupHerdr(request, { ...production,
    preflight: async () => ({ fingerprint: 'viewer-fixture', coreIdentity: await h.hc.identity(), layoutExport: true, targets: [], retiredTerminals: [],
      mods: ['spider-panel', 'spider-machines'].map(name => ({ directory: join(h.directories.app, 'mods', name) })) }),
    stageLook: async () => [], generateTemplates: async () => [], cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
  });
  execFileSync('git', ['init', '-q', h.directories.local]);
  setGlobalDbPathForTests(join(h.directories.global, 'global.db')); const global = openGlobal();
  const opened = openSessionRunDb(h.directories.local, h.owner!.sessionId); const store = new RunStore(opened.db);
  const hooks = new Map<string, Set<Function>>(); const errors: unknown[] = [];
  const pi = { on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); },
    getSessionName() { return undefined; }, registerTool() {}, registerShortcut() {}, sendMessage() {} };
  const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI: false, isIdle: () => true,
    sessionManager: { getSessionId: () => h.owner!.sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
  const mount = mountHerdr(pi as never, { packageRoot: h.root, reportError: error => errors.push(error),
    views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
    actionContext: () => ({ db: opened.db, globalDb: global, sessionId: h.owner!.sessionId, pi }) });
  const emit = async (name: string, event = {}) => { for (const handler of [...hooks.get(name) ?? []]) await handler(event, ctx); };
  await emit('session_start');
  const feed = JSON.parse(await readFile(join(h.directories.global, 'herdr/sessions', h.owner!.sessionId, 'session.json'), 'utf8'));
  const ipc = createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc });
  return { h, mount, store, ipc, errors, emit, feed, endOwner, async close() { ipc.dispose(); await emit('session_shutdown', { reason: 'quit' }); await mount.dispose(); opened.db.close(); global.close(); await cli.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); } };
}

test('production subscriptions close both read-only binding handles at unsubscribe and owner shutdown', async () => {
  const f = await fixture();
  try {
    expect(f.errors).toEqual([]); expect(f.mount.enabled()).toBe(true);
    const ids = [0, 1].map(() => { const { id } = f.store.create({ sessionId: f.h.owner!.sessionId, agent: 'worker' }); f.store.start(id); return id as RunId; });
    const first = await f.ipc.subscribeRun(ids[0], null, () => {});
    const second = await f.ipc.subscribeRun(ids[1], null, () => {});
    expect(observed.readonly).toHaveLength(2); expect(observed.readonly.filter(db => db.raw.open)).toHaveLength(2);
    await first.dispose();
    await expect.poll(() => observed.readonly.filter(db => db.raw.open).length).toBe(1); expect(observed.closed).toBe(1);
    await f.emit('session_shutdown', { reason: 'quit' });
    await expect.poll(() => observed.readonly.filter(db => db.raw.open).length).toBe(0); expect(observed.closed).toBe(2);
    await second.dispose();
  } finally { await f.close(); }
}, 30000);

test('a mounted reload reattaches its viewer without reconnecting or final-state notices', async () => {
  const f = await fixture(); const abort = new AbortController(); const output = new PassThrough(); let text = ''; let clients = 0, snapshots = 0;
  output.on('data', bytes => { text += bytes.toString(); });
  const session = f.h.owner!.sessionId; const { id } = f.store.create({ sessionId: session, agent: 'worker' }); f.store.start(id);
  const ports = createViewerPorts(['--feed-root', join(f.h.directories.global, 'herdr'), '--session', session, '--run', id], { stdin: new PassThrough(), stdout: output, signal: abort.signal })!;
  const running = runViewer({ ...ports, createClient: descriptor => {
    clients++; const client = ports.createClient(descriptor); const subscribe = client.subscribeRun.bind(client);
    client.subscribeRun = (id, cursor, emit, options) => subscribe(id, cursor, frame => { if (frame.kind === 'snapshot') snapshots++; emit(frame); }, options);
    return client;
  } });
  try {
    await expect.poll(() => text, { timeout: 3000 }).toContain('[running');
    await f.emit('session_shutdown', { reason: 'reload' }); await f.emit('session_start');
    await expect.poll(() => clients, { timeout: 3000 }).toBe(2);
    await expect.poll(() => snapshots, { timeout: 3000 }).toBe(2);
    expect((text.match(/\[running/g) ?? []).length).toBe(1);
    expect(text).not.toContain('read-only'); expect(text).not.toContain('reconnecting');
  } finally { abort.abort(); await running; await f.close(); }
}, 30000);

test.each(['new', 'resume', 'fork'] as const)('a viewer of an owner replaced by %s becomes final read-only within the reconnect bound', async reason => {
  const f = await fixture(); const abort = new AbortController(); const output = new PassThrough(); let text = ''; let attempts = 0;
  output.on('data', bytes => { text += bytes.toString(); });
  const oldSession = f.h.owner!.sessionId; const { id } = f.store.create({ sessionId: oldSession, agent: 'worker' }); f.store.start(id);
  const feedRoot = join(f.h.directories.global, 'herdr'); let changed = () => {}; let now = Date.now();
  const feeds = createViewerFeedSource(feedRoot, oldSession);
  const ports = createViewerPorts(['--feed-root', feedRoot, '--session', oldSession, '--run', id], { stdin: new PassThrough(), stdout: output, signal: abort.signal })!;
  const running = runViewer({ ...ports, clock: () => now,
    feedSource: { read: () => feeds.read(), subscribe: listener => { changed = listener; return feeds.subscribe(listener); } },
    createClient: descriptor => { const client = ports.createClient(descriptor); const subscribe = client.subscribeRun.bind(client);
      client.subscribeRun = (...args) => { attempts++; return subscribe(...args); }; return client; } });
  try {
    await expect.poll(() => text, { timeout: 3000 }).toContain('[running');
    await f.emit('session_shutdown', { reason });
    f.h.owner = { ...f.h.owner!, sessionId: randomUUID() as typeof oldSession }; await f.emit('session_start');
    expect((await feeds.read())?.lifecycle).toBe('live');
    await expect.poll(() => attempts, { timeout: 3000 }).toBeGreaterThan(1);
    now += 29000; changed(); await new Promise(resolve => setTimeout(resolve, 25)); expect(text).not.toContain('Saved log is read-only');
    now += 1000; changed(); await expect.poll(() => text, { timeout: 3000 }).toContain('Saved log is read-only');
    const finalAttempts = attempts; now += 90000; changed(); await new Promise(resolve => setTimeout(resolve, 300));
    expect(attempts).toBe(finalAttempts); expect(text.match(/Saved log is read-only/g)).toHaveLength(1);
  } finally { abort.abort(); await running; await f.close(); }
}, 30000);

if (process.env.SPIDER_HERDR_E2E !== '1') console.info('Owner-terminal survival check requires SPIDER_HERDR_E2E=1 and isolated hc; no app window is used.');
test.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('real hc: the installed viewer survives its owner terminal ending and remains read-only', async () => {
  const f = await fixture('hc', true);
  try {
    expect(f.errors).toEqual([]);
    const owner = f.mount.owner()!; const { id } = f.store.create({ sessionId: owner.sessionId, agent: 'worker' }); f.store.start(id);
    const launcher = createViewerLauncher({ hc: f.h.hc, owner: () => f.mount.owner(), viewerExecutable: join(f.h.root, 'dist/herdr/viewer.mjs'),
      feedRoot: join(f.h.directories.global, 'herdr'), ipcDescriptor: () => ({ version: 1, sessionId: f.feed.sessionId, generation: f.feed.generation, ...f.feed.ipc } as IpcDescriptor) });
    const viewer = await launcher(id as RunId, owner);
    await f.emit('session_shutdown', { reason: 'quit' });
    await writeFile(f.endOwner, 'quit');
    await expect.poll(async () => (await f.h.hc.get(owner.terminal.address)).state, { timeout: 5000 }).toBe('finished');
    expect((await f.h.hc.get(viewer)).state).toBe('live');
    await expect.poll(async () => f.h.hc.read(viewer, { lines: 50 }), { timeout: 5000 }).toContain('Saved log is read-only');
    console.info('REAL HC owner=finished viewer=live read-only=true');
  } finally { await f.close(); }
}, 30000);
