// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import { openGlobal, setGlobalDbPathForTests } from '@spider/db-core';
import { cleanupScratch } from '@spider/db-core/testutil';
import { registerChild, teardownAll } from '../../../subagents/src/coordinators.js';
import { RunStore } from '../../../subagents/src/run-store.js';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { setupHerdr, standardHerdrConfigPath, type SetupRequest } from '../../../herdr/src/setup/installer.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { createSessionIpcClient } from '../../../herdr/src/feed/ipc-client.js';
import { createViewerFeedSource, runViewer } from '../../../herdr/src/viewers/program.js';
import type { RunId, RunViewFrame, SessionId } from '../../../herdr/src/contracts.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { openSessionRunDb } from '../session-run-db.js';
import spiderExtension from '../extension.js';
import * as mountModule from '../herdr/mount.js';
import * as endpointModule from '../../../herdr/src/feed/ipc-server.js';
import { clearActions } from '../dispatch.js';
const realMount = mountModule.mountHerdr;
const realStartEndpoint = endpointModule.startSessionEndpoint;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { teardownAll(); clearActions(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setGlobalDbPathForTests(null); cleanupScratch(); });

async function fixture(failQuitDisposal: boolean) {
  if (failQuitDisposal) {
    let fail = true;
    vi.spyOn(endpointModule, 'startSessionEndpoint').mockImplementation(async (...args) => {
      const endpoint = await realStartEndpoint(...args);
      return { ...endpoint, async dispose(reason) {
        await endpoint.dispose(reason);
        if (fail) { fail = false; throw new Error('Fixture endpoint cleanup failed'); }
      } };
    });
  }
  const h = await createHerdrHarness('fake'); cleanups.push(() => h.close()); await h.start();
  const manager = SessionManager.create(h.directories.local, join(h.root, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'Fork this task', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [], api: 'fixture', provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as never);
  h.owner = { ...h.owner!, sessionId: manager.getSessionId() as SessionId };
  for (const [name, value] of Object.entries(h.localEnv)) if (value !== undefined && /^(HC_|XDG_|HERDR_)/.test(name)) vi.stubEnv(name, value);
  vi.stubEnv('PI_SUBAGENT_CHILD', '0'); vi.stubEnv('PI_CODING_AGENT_DIR', h.directories.agent); vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
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
  const hooks = new Map<string, Set<Function>>();
  const pi = { on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); },
    getSessionName() { return undefined; }, registerTool() {}, registerCommand() {}, registerShortcut() {}, sendMessage() {} };
  const terminal = Object.create(ProcessTerminal.prototype); Reflect.set(terminal, 'programStatusSupported', false);
  const notices: string[] = [];
  const ctx = { cwd: h.directories.local, mode: 'tui', hasUI: true, isIdle: () => true, getContextUsage: () => undefined,
    ui: { notify(message: string) { notices.push(message); }, setWidget(name: string, factory: unknown) { if (name === 'spider-herdr-status' && typeof factory === 'function') factory({ terminal }); }, setFooter() {}, setStatus() {} }, sessionManager: manager };
  const mounting = vi.spyOn(mountModule, 'mountHerdr').mockImplementation((api, options) => realMount(api, { ...options, packageRoot: h.root }));
  try { spiderExtension(pi as never); } finally { mounting.mockRestore(); }
  const emit = async (name: string, event = {}) => { for (const handler of [...hooks.get(name) ?? []]) await handler(event, ctx); };
  await emit('session_start');
  const feed = JSON.parse(await readFile(join(h.directories.global, 'herdr/sessions', h.owner!.sessionId, 'session.json'), 'utf8'));
  const ipc = createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc });
  return { h, manager, ctx, store, ipc, emit, feed, hooks, notices, async close() { ipc.dispose(); await emit('session_shutdown', { reason: 'quit' }); opened.db.close(); global.close(); await cli.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); } };
}

// Quit must end the endpoint before child cancellation can emit a normal run finish.
// A mount-only test omits the earlier registered subagent teardown and misses this race.
test.each([false, true])('quit hands off the stream before cancellation and retains the viewer, cleanup failure: %s', async failQuitDisposal => {
  const f = await fixture(failQuitDisposal); const abort = new AbortController(); const input = new PassThrough(); const output = new PassThrough();
  let text = '', viewerExited = false;
  output.on('data', bytes => { text += bytes.toString(); });
  const sessionId = f.h.owner!.sessionId, { id } = f.store.create({ sessionId, agent: 'worker' });
  f.store.setLaunch(id, { childMode: 'rpc' }); f.store.start(id);
  const frames: RunViewFrame[] = [];
  const subscription = await f.ipc.subscribeRun(id as RunId, null, frame => frames.push(frame));
  const feeds = createViewerFeedSource(join(f.h.directories.global, 'herdr'), sessionId);
  const viewer = runViewer({ runId: id as RunId, sessionId, feedRoot: join(f.h.directories.global, 'herdr'), stdin: input, stdout: output, signal: abort.signal,
    createClient: descriptor => createSessionIpcClient(descriptor),
    submitSteer: async () => { throw new Error('A closed viewer must refuse steering'); },
  }).finally(() => { viewerExited = true; });
  registerChild(sessionId, id, { pid: 0, wait: () => new Promise(() => {}), detach() {}, kill() { f.store.cancel(id); },
    async killAsync() {
      f.store.cancel(id);
      await expect.poll(() => frames.some(frame => frame.kind === 'end')).toBe(true);
      await expect.poll(async () => (await feeds.read())?.runs.rows.find(run => run.id === id)?.status, { timeout: 5000 }).toBe('cancelled');
    },
  });
  try {
    await expect.poll(() => text).toContain('[running');
    await expect.poll(async () => (await feeds.read())?.runs.rows.find(run => run.id === id)?.status, { timeout: 5000 }).toBe('running');
    await f.emit('session_shutdown', { reason: 'quit' });
    expect(frames.find(frame => frame.kind === 'end')?.data).toEqual({ reason: 'disposed' });
    const finalFeed = await feeds.read();
    expect(finalFeed?.lifecycle).toBe('closed');
    expect(finalFeed?.runs.rows.find(run => run.id === id)?.status).toBe('cancelled');
    await expect.poll(() => text, { timeout: 2000, interval: 10 }).toContain('Owning session closed. Saved log is read-only.');
    await new Promise(resolve => setTimeout(resolve, 2200));
    expect(viewerExited).toBe(false);
    input.write('do not deliver this draft\n'); await expect.poll(() => text).toContain('[refused]');
    expect(text).not.toContain('Owning session unavailable for 30 seconds.');
    expect(f.notices.filter(message => message.includes('Fixture endpoint cleanup failed'))).toHaveLength(failQuitDisposal ? 1 : 0);
  } finally { abort.abort(); await viewer; await subscription.dispose(); await f.close(); }
}, 30000);
