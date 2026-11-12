// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentSessionRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
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
import { clearActions } from '../dispatch.js';
const realMount = mountModule.mountHerdr;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { teardownAll(); clearActions(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setGlobalDbPathForTests(null); cleanupScratch(); });

async function fixture() {
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
  const ctx = { cwd: h.directories.local, mode: 'tui', hasUI: true, isIdle: () => true, getContextUsage: () => undefined,
    ui: { notify() {}, setWidget(name: string, factory: unknown) { if (name === 'spider-herdr-status' && typeof factory === 'function') factory({ terminal }); }, setFooter() {}, setStatus() {} }, sessionManager: manager };
  const mounting = vi.spyOn(mountModule, 'mountHerdr').mockImplementation((api, options) => realMount(api, { ...options, packageRoot: h.root }));
  try { spiderExtension(pi as never); } finally { mounting.mockRestore(); }
  const emit = async (name: string, event = {}) => { for (const handler of [...hooks.get(name) ?? []]) await handler(event, ctx); };
  await emit('session_start');
  const feed = JSON.parse(await readFile(join(h.directories.global, 'herdr/sessions', h.owner!.sessionId, 'session.json'), 'utf8'));
  const ipc = createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc });
  return { h, manager, ctx, store, ipc, emit, feed, hooks, async close() { ipc.dispose(); await emit('session_shutdown', { reason: 'quit' }); opened.db.close(); global.close(); await cli.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); } };
}

// Regression: full host registration kills children before its later Herdr shutdown hook.
// A mount-only lifecycle test has no child teardown and cannot catch this ordering.
test.each(['new', 'resume', 'fork'] as const)('real pi %s replacement ends the mounted stream before child cancellation', async reason => {
  const f = await fixture(); const abort = new AbortController(); const input = new PassThrough(); const output = new PassThrough();
  let text = '', viewerExited = false, now = Date.now(), changed = () => {}, attempts = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  output.on('data', bytes => { text += bytes.toString(); });
  const sessionId = f.h.owner!.sessionId, { id } = f.store.create({ sessionId, agent: 'worker' });
  f.store.setLaunch(id, { childMode: 'rpc' }); f.store.start(id);
  const frames: RunViewFrame[] = [];
  const subscription = await f.ipc.subscribeRun(id as RunId, null, frame => frames.push(frame));
  const feeds = createViewerFeedSource(join(f.h.directories.global, 'herdr'), sessionId);
  const viewer = runViewer({ runId: id as RunId, sessionId, feedRoot: join(f.h.directories.global, 'herdr'), stdin: input, stdout: output, signal: abort.signal, clock: () => now,
    feedSource: { read: () => feeds.read(), subscribe: listener => { changed = listener; return feeds.subscribe(listener); } },
    createClient: descriptor => { const client = createSessionIpcClient(descriptor); const subscribe = client.subscribeRun.bind(client); client.subscribeRun = (...args) => { attempts++; return subscribe(...args); }; return client; },
    submitSteer: async () => { throw new Error('A replaced viewer must refuse steering'); },
  }).finally(() => { viewerExited = true; });
  // The held child exits during the real registered subagent shutdown hook, as in S33.
  // Keep the kill port deterministic by waiting for the actual IPC end frame.
  let cancelled = false;
  registerChild(sessionId, id, { pid: 0, wait: () => new Promise(() => {}), detach() {}, kill() { f.store.cancel(id); },
    async killAsync() { cancelled = true; f.store.cancel(id); await expect.poll(() => frames.some(frame => frame.kind === 'end')).toBe(true); },
  });
  const events: { type: string; reason?: string }[] = [];
  const runner = { hasHandlers: (name: string) => f.hooks.has(name), async emit(event: { type: string; reason?: string }) { events.push(event); await f.emit(event.type, event); } };
  const session = { sessionManager: f.manager, sessionFile: f.manager.getSessionFile(), extensionRunner: runner, abort: async () => {}, dispose() {} };
  const services = { cwd: f.h.directories.local, agentDir: f.h.directories.agent };
  const activations: { close(): Promise<void> }[] = [];
  const target = SessionManager.create(f.h.directories.local, join(f.h.root, 'sessions'));
  for (const entry of f.manager.getEntries()) if (entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant')) target.appendMessage(entry.message);
  // Pi constructs a fresh runtime after each accepted shutdown. Its own start event
  // activates the real mount and endpoint, including when the original session returns.
  const runtime = new AgentSessionRuntime(session as never, services as never, async options => {
    const manager = options.sessionManager!, hooks = new Map<string, Set<Function>>();
    const api = { on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); },
      getSessionName() {}, registerTool() {}, registerShortcut() {}, sendMessage() {} };
    const notices: string[] = [];
    const ctx = { ...f.ctx, ui: { ...f.ctx.ui, notify(message: string) { notices.push(message); } }, sessionManager: manager };
    const emit = async (event: { type: string }) => { for (const handler of [...hooks.get(event.type) ?? []]) await handler(event, ctx); };
    const activationErrors: unknown[] = [];
    const mount = realMount(api as never, { packageRoot: f.h.root, actionContext: () => ({}) as never, reportError: error => activationErrors.push(error),
      views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } } });
    activations.push({ async close() { await emit({ type: 'session_shutdown', reason: 'quit' } as { type: string }); await mount.dispose(); } });
    await emit(options.sessionStartEvent!);
    expect(activationErrors).toEqual([]); expect(mount.enabled(), notices.join('\n')).toBe(true);
    return { session: { sessionManager: manager, sessionFile: manager.getSessionFile(), abort: async () => {}, dispose() {},
      extensionRunner: { hasHandlers: (name: string) => hooks.has(name), emit } }, services } as never;
  });
  try {
    await expect.poll(() => text).toContain('[running');
    if (reason === 'new') await runtime.newSession();
    else if (reason === 'resume') await runtime.switchSession(target.getSessionFile()!);
    else await runtime.fork(f.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user')!.id);
    expect(events.map(event => [event.type, event.reason])).toEqual(reason === 'fork' ? [['session_before_fork', undefined], ['session_shutdown', reason]] : [['session_before_switch', reason], ['session_shutdown', reason]]);
    expect(cancelled).toBe(true);
    expect(frames.find(frame => frame.kind === 'end')?.data).toEqual({ reason: 'wrong-generation' });
    expect((await feeds.read())?.lifecycle).toBe('live');
    now += 30000; changed();
    await expect.poll(() => text, { timeout: 3000 }).toContain('Owning session unavailable for 30 seconds. Saved log is read-only.');
    expect(viewerExited).toBe(false); expect(text).not.toContain('Owning session closed.');
    input.write('do not deliver this draft\n'); await expect.poll(() => text).toContain('[refused]');
    const finalAttempts = attempts; now += 90000; changed(); await new Promise(resolve => setTimeout(resolve, 1200));
    expect(attempts).toBe(finalAttempts); expect(viewerExited).toBe(false);
    await runtime.switchSession(f.manager.getSessionFile()!);
    // The resumed owner is genuinely authenticated and serving this same run.
    const resumedFeed = (await feeds.read())!;
    const resumedIpc = createSessionIpcClient({ version: 1, sessionId, generation: resumedFeed.generation, ...resumedFeed.ipc! });
    const resumedFrames: RunViewFrame[] = [];
    try { const stream = await resumedIpc.subscribeRun(id as RunId, null, frame => resumedFrames.push(frame)); await stream.closed; await stream.dispose(); }
    finally { resumedIpc.dispose(); }
    expect(resumedFrames.find(frame => frame.kind === 'snapshot')?.data).toMatchObject({ run: { id, ownerSessionId: sessionId, status: 'cancelled' } });
    now += 1000; changed(); await new Promise(resolve => setTimeout(resolve, 2200));
    expect(attempts).toBe(finalAttempts); expect(viewerExited).toBe(false);
  } finally { abort.abort(); await viewer; await subscription.dispose(); for (const activation of activations.reverse()) await activation.close(); await f.close(); }
}, 30000);
