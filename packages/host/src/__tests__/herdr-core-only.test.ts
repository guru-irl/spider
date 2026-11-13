// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import { openDbAt } from '@spider/db-core';
import * as appModule from '@spider/herdr/client/app';
import * as hcModule from '@spider/herdr/client/hc';
import * as hostPorts from '../herdr/ports.js';
import { createClientFixture } from '../../../herdr/src/__tests__/testutil.js';
import { createProcessPresence } from '../../../herdr/src/sessions/presence.js';
import { createTerminalRegistry } from '../../../herdr/src/sessions/registry.js';
import { createSessionIpcClient } from '../../../herdr/src/feed/ipc-client.js';
import type { HcClient, HcEvent, HcRunRequest, JobId, RunId, TerminalAddress, TerminalSummary } from '../../../herdr/src/contracts.js';
import { RunStore } from '../../../subagents/src/run-store.js';
import { mountHerdr } from '../herdr/mount.js';
import { controlConfig } from '../control.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { configFixtureCwd } from './herdr-config-fixture.js';
import { runHerdrCli } from '@spider/herdr/setup/cli';
import { HerdrError } from '@spider/herdr/client/parse';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

async function fixture(child = false) {
  const hc = await createClientFixture();
  cleanups.push(() => hc.close());
  execFileSync('git', ['init', '-q', hc.root]);
  const globalRoot = join(hc.root, 'g'), agentDirectory = join(hc.root, 'agent');
  await mkdir(join(globalRoot, 'herdr'), { recursive: true });
  await mkdir(join(hc.root, 'dist/herdr'), { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await copyFile(resolve('dist/herdr/remote-runtime.mjs'), join(hc.root, 'dist/herdr/remote-runtime.mjs'));
  const installedRuntime = await readFile(join(hc.root, 'dist/herdr/remote-runtime.mjs'));
  const machine = { name: 'box-1.invalid', aliases: [], runtime: { cwd: null, directory: join(hc.root, 'remote'), commands: {} } };
  const identity = { coreId: 'local-core' as never, socket: hc.localSocket, sessionNamespace: hc.namespace };
  const caller = { ...identity, terminalId: 't1' as never, address: 't1' as TerminalAddress };
  const terminals = new Map<TerminalAddress, TerminalSummary>();
  const addTerminal = (address: string, labels: Record<string, string> = {}) => {
    terminals.set(address as TerminalAddress, { address: address as TerminalAddress, parent: null, labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null });
  };
  addTerminal('t1');
  const runCalls: HcRunRequest[] = [], remoteFiles = new Map<string, Buffer>();
  const eventListeners = new Set<(event: HcEvent) => void>();
  let allowRemote = false, terminalSequence = 0;
  const client: HcClient & { dispose(): void } = {
    identity: async () => identity, caller: async () => caller,
    machines: async () => [{ id: 'remote-core' as never, name: machine.name as never, aliases: [], state: 'connected', sessionNamespace: 'remote', runtime: null }],
    get: async address => { const result = terminals.get(address); if (!result) throw Object.assign(new Error('missing terminal'), { code: 'not_found' }); return result; },
    events: () => { const listeners = new Set<(event: HcEvent) => void>(); return {
      ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null,
      subscribe: listener => { listeners.add(listener); eventListeners.add(listener); queueMicrotask(() => { if (listeners.has(listener)) listener({ type: 'snapshot', seq: 0, terminals: [...terminals.values()] }); }); return () => { listeners.delete(listener); eventListeners.delete(listener); }; },
      dispose: () => { for (const listener of listeners) eventListeners.delete(listener); listeners.clear(); },
    }; },
    run: async request => {
      runCalls.push(request);
      if (!allowRemote || request.on !== machine.name) throw new Error('Fixture refuses local or unconfigured launches');
      const address = `${machine.name}/t${++terminalSequence}` as TerminalAddress;
      addTerminal(address, request.labels);
      const consoleFlag = request.argv.indexOf('--console');
      if (consoleFlag >= 0) remoteFiles.set(join(request.argv[consoleFlag + 1], 'heartbeat.json'), Buffer.from(JSON.stringify({ version: 1, instance: request.argv[consoleFlag + 2] })));
      const terminal = terminals.get(address)!;
      queueMicrotask(() => { for (const listener of eventListeners) listener({ type: 'created', seq: terminalSequence, terminal: address, data: terminal }); });
      return { address, coreId: 'remote-core' as never };
    },
    read: async () => '', kill: async () => {}, rm: async address => { terminals.delete(address); }, setLabels: async () => {},
    fileRead: async (on, path) => {
      if (on === machine.name && /spider-remote-runtime-[a-f0-9]{16}\.mjs$/.test(path)) return installedRuntime;
      const bytes = on === machine.name ? remoteFiles.get(path) : undefined;
      if (!bytes) throw Object.assign(new Error('missing file'), { code: 'not_found' });
      return bytes;
    },
    fileWrite: async (on, path, bytes) => { if (on !== machine.name) throw new Error('Fixture refuses unconfigured writes'); remoteFiles.set(path, Buffer.from(bytes)); }, dispose() {},
  };
  vi.spyOn(hcModule, 'createHcClient').mockImplementation(() => client);
  vi.spyOn(hostPorts, 'coreStartedAt').mockResolvedValue(1234);
  for (const [name, value] of Object.entries(hc.localEnv)) if (value !== undefined && /^(HC_|XDG_|HERDR_)/.test(name)) vi.stubEnv(name, value);
  vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot); vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('PI_SUBAGENT_CHILD', child ? '1' : '0');
  if (child) { vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', 'owner-session'); vi.stubEnv('PI_SUBAGENT_RUN_ID', 'child-run'); }
  const configFile = join(globalRoot, 'herdr/config.json');
  const config = { enabled: true, mode: 'core-only', core: { binary: hc.hcBinary, config: join(hc.root, 'core.toml') }, agentDirectory, globalRoot,
    shellRc: join(hc.root, 'shellrc'), spaces: [], machines: [machine] };
  await writeFile(configFile, JSON.stringify(config));
  const dbPath = join(hc.root, 'runs.db'), globalPath = join(hc.root, 'global.db');
  const db = openDbAt(dbPath, 'worktree'), globalDb = openDbAt(globalPath, 'global'), store = new RunStore(db);
  cleanups.push(async () => { db.close(); globalDb.close(); });
  const hooks = new Map<string, Set<Function>>(), errors: unknown[] = [], notices: string[] = [];
  const nativeTerminal = Object.create(ProcessTerminal.prototype);
  Reflect.set(nativeTerminal, 'programStatusSupported', false); nativeTerminal.setProgramStatus({ state: 'done' });
  const ctx = { cwd: hc.root, mode: child ? 'rpc' : 'tui', hasUI: !child,
    ui: { notify: (message: string) => { notices.push(message); }, setStatus() {}, setWidget(_name: string, factory: unknown) { if (typeof factory === 'function') factory({ terminal: nativeTerminal }); } },
    sessionManager: { getSessionId: () => child ? 'child-session' : 'owner-session', getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
  const pi = { on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); },
    getSessionName: () => null, registerTool() {}, registerShortcut() {}, sendMessage() {} };
  const mount = mountHerdr(pi as never, { packageRoot: hc.root, actionContext: () => ({ db, globalDb, sessionId: 'owner-session', pi }), reportError: error => errors.push(error),
    views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } },
    dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }),
      readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } } });
  const emit = async (name: string, event: unknown = {}) => { for (const hook of [...hooks.get(name) ?? []]) await hook(event, ctx); };
  cleanups.push(async () => { await emit('session_shutdown', { reason: 'quit' }); await mount.dispose(); });
  const feedPath = join(globalRoot, 'herdr/sessions/owner-session/session.json');
  const ipc = async () => {
    const feed = JSON.parse(await readFile(feedPath, 'utf8'));
    const client = createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc });
    cleanups.push(async () => client.dispose());
    return client;
  };
  return { hc, globalRoot, config, configFile, ctx, store, mount, emit, feedPath, ipc, errors, notices, nativeTerminal, addTerminal, runCalls, allowRemote: () => { allowRemote = true; } };
}

test('full mode still activates and constructs an app client', async () => {
  const app = vi.spyOn(appModule, 'createAppClient');
  const f = await fixture();
  await writeFile(f.configFile, JSON.stringify({ ...f.config, mode: 'full', app: { binary: f.hc.appBinary, home: join(f.hc.root, 'app') } }));
  expect(() => controlConfig('get', f.ctx.cwd, 'herdr.enabled')).not.toThrow();
  await f.emit('session_start', { reason: 'startup' });
  expect(f.mount.enabled(), JSON.stringify({ errors: f.errors.map(String), notices: f.notices })).toBe(true);
  expect(app.mock.calls.length).toBeGreaterThan(0);
}, 5000);

test('malformed full-mode app configuration never falls back to core-only', async () => {
  const app = vi.spyOn(appModule, 'createAppClient');
  const f = await fixture();
  await writeFile(f.configFile, JSON.stringify({ ...f.config, mode: 'full', app: { binary: 'relative-app', home: join(f.hc.root, 'app') } }));
  await f.emit('session_start', { reason: 'startup' });
  expect(f.mount.enabled()).toBe(false);
  expect(f.mount.owner()).toBeNull();
  expect(f.mount.execution().remote).toBeUndefined();
  expect(app.mock.calls.length).toBe(0);
  expect(f.notices).toHaveLength(1);
}, 5000);

test('core-only never constructs AppClient', async () => {
  const app = vi.spyOn(appModule, 'createAppClient');
  const f = await fixture();
  await f.emit('session_start', { reason: 'startup' });
  expect(f.mount.enabled()).toBe(true);
  expect(app.mock.calls.length).toBe(0);
  expect(f.errors).toEqual([]);
  expect(f.notices).toEqual([]);
}, 5000);

test('core-only does not invoke a missing app executable', async () => {
  const app = vi.spyOn(appModule, 'createAppClient');
  const f = await fixture();
  await writeFile(f.configFile, JSON.stringify({ ...f.config, app: { binary: join(f.hc.root, 'missing-app'), home: join(f.hc.root, 'missing-home') } }));
  await f.emit('session_start', { reason: 'startup' });
  expect(f.mount.enabled()).toBe(true);
  expect(app.mock.calls.length).toBe(0);
  expect(f.notices).toEqual([]);
  expect(f.errors).toEqual([]);
}, 5000);

test('children jobs ownership and status still work', async () => {
  const f = await fixture();
  const run = f.store.create({ sessionId: 'owner-session', agent: 'worker' }); f.store.start(run.id);
  await f.emit('session_start', { reason: 'startup' });
  const owner = f.mount.owner();
  expect(owner?.sessionId).toBe('owner-session');
  expect(f.mount.execution().remote).toBeDefined();
  const feed = JSON.parse(await readFile(f.feedPath, 'utf8'));
  expect(feed.runs.total).toBe(1);
  expect(feed.runs.rows[0]).toMatchObject({ id: run.id, status: 'running' });
  expect(feed.placement).toBeNull();
  expect(f.nativeTerminal.programStatus).toMatchObject({ state: 'working', message: '1 subagent running' });
  expect(await createProcessPresence(join(f.globalRoot, 'herdr')).list()).toMatchObject([{ sessionId: 'owner-session', kind: 'top-level', hcAddress: 't1' }]);
  expect((await createTerminalRegistry(join(f.globalRoot, 'herdr')).get(owner!.terminal))?.owner.sessionId).toBe('owner-session');
  expect(f.errors).toEqual([]);
}, 5000);

test('app actions explain Mac placement', async () => {
  const f = await fixture();
  const run = f.store.create({ sessionId: 'owner-session', agent: 'worker' }); f.store.start(run.id);
  await f.emit('session_start', { reason: 'startup' });
  const owner = f.mount.owner();
  expect(owner).not.toBeNull();
  if (!owner) throw new Error('Expected an active owner');
  const labels = { 'spider.kind': 'remote-console', 'spider.session': owner.sessionId, 'spider.machine': 'box-1.invalid',
    'spider.owner-core': owner.terminal.coreId, 'spider.owner-terminal': owner.terminal.terminalId };
  f.addTerminal('box-1.invalid/t1', labels);
  const ipc = await f.ipc();
  const replies = await Promise.all([
    ipc.openView('agents'),
    ipc.openRun(run.id as RunId),
    ipc.openJob('console:box-1.invalid/t1' as JobId),
    ipc.request({ op: 'moveSession', generation: owner.generation, destination: { kind: 'new' } }),
    ipc.request({ op: 'moveRun', generation: owner.generation, runId: run.id as RunId, destination: { kind: 'new' } }),
    ipc.request({ op: 'moveJob', generation: owner.generation, jobId: 'console:box-1.invalid/t1' as JobId, viewer: 't2' as never, destination: { kind: 'new' } }),
  ]);
  for (const reply of replies) expect(reply).toMatchObject({ ok: false, code: 'refused', message: 'This view is available on the Mac.' });
  expect(f.notices).toEqual([]);
  expect(f.errors).toEqual([]);
}, 5000);

test('core-only session reload retains ownership and job monitoring without an app', async () => {
  const app = vi.spyOn(appModule, 'createAppClient');
  const f = await fixture();
  await f.emit('session_start', { reason: 'startup' });
  const first = f.mount.owner();
  await f.emit('session_shutdown', { reason: 'reload' });
  await f.emit('session_start', { reason: 'reload' });
  expect(f.mount.enabled()).toBe(true);
  expect(f.mount.owner()).toMatchObject({ sessionId: 'owner-session', terminal: { coreId: first?.terminal.coreId } });
  expect(f.mount.owner()?.generation).not.toBe(first?.generation);
  expect(f.mount.execution().remote).toBeDefined();
  expect(await createProcessPresence(join(f.globalRoot, 'herdr')).list()).toHaveLength(1);
  expect(app.mock.calls.length).toBe(0);
  expect(f.notices).toEqual([]);
  expect(f.errors).toEqual([]);
}, 5000);

test('a configured core-only background job remains monitored after reload', async () => {
  const app = vi.spyOn(appModule, 'createAppClient');
  const f = await fixture();
  f.allowRemote();
  await f.emit('session_start', { reason: 'startup' });
  const owner = f.mount.owner(), remote = f.mount.execution().remote;
  if (!owner || !remote) throw new Error('Expected core-only ownership and job monitoring');
  const result = await remote.execute({ owner, on: 'box-1.invalid' as never, background: true, timeout: 50,
    source: { kind: 'code', language: 'javascript', code: 'console.log(1)' } });
  expect(result).toMatchObject({ outcome: 'timeout', timedOut: true, backgrounded: true, remote: { machine: 'box-1.invalid' } });
  const jobId = result.remote.jobId;
  expect(f.runCalls.filter(call => call.labels['spider.kind'] === 'exec').map(call => call.on)).toEqual(['box-1.invalid']);
  const root = join(f.globalRoot, 'herdr/jobs');
  expect(await hostPorts.readJobJournal(root, owner)).toEqual(expect.arrayContaining([expect.objectContaining({ id: jobId, detached: true })]));
  await f.emit('session_shutdown', { reason: 'reload' });
  await f.emit('session_start', { reason: 'reload' });
  const reloaded = f.mount.owner();
  expect(reloaded?.sessionId).toBe(owner.sessionId);
  expect(f.mount.execution().remote).toBeDefined();
  expect(await hostPorts.readJobJournal(root, reloaded!)).toEqual(expect.arrayContaining([expect.objectContaining({ id: jobId, detached: true })]));
  expect(app.mock.calls.length).toBe(0);
  expect(f.notices).toEqual([]);
  expect(f.errors).toEqual([]);
}, 5000);

test('unconfigured remote destination never executes locally', async () => {
  const f = await fixture();
  await f.emit('session_start', { reason: 'startup' });
  const sentinel = join(f.hc.root, 'local-execution');
  const remote = f.mount.execution().remote;
  expect(remote).toBeDefined();
  if (!remote) throw new Error('Expected active remote execution');
  await expect(remote.execute({ owner: f.mount.owner()!, on: 'unknown.invalid' as never,
    source: { kind: 'code', language: 'shell', code: `printf wrong > '${sentinel}'` } })).rejects.toMatchObject({ code: 'machine-unconfigured' });
  expect(existsSync(sentinel)).toBe(false);
  expect(f.runCalls).toEqual([]);
}, 5000);

test('core-only resume remains available while app doctor reports Mac placement', async () => {
  const app = vi.spyOn(appModule, 'createAppClient');
  const f = await fixture();
  const ports = configFixtureCwd(createProductionHerdrCliPorts(f.hc.root, { ...process.env, SPIDER_GLOBAL_ROOT: f.globalRoot }), f.hc.root);
  cleanups.push(() => ports.dispose());
  const refusal = await ports.request(f.configFile).catch(error => error);
  expect(refusal).toMatchObject({ code: 'view-on-mac', message: 'This view is available on the Mac.' });
  expect(JSON.stringify(refusal)).not.toContain(f.globalRoot);
  expect(inspect(refusal)).not.toContain(f.globalRoot);
  let resumeError = '';
  expect(await runHerdrCli(['resume-offer', '--config', f.configFile], { ...ports, stdout() {}, stderr(text) { resumeError += text; } })).toBe(0);
  expect(resumeError).toBe('');
  let stderr = '';
  expect(await runHerdrCli(['doctor', '--config', f.configFile], { ...ports, stdout() {}, stderr(text) { stderr += text; } })).toBe(1);
  expect(stderr).toBe('view-on-mac: This view is available on the Mac.\n');
  expect(app.mock.calls.length).toBe(0);
});

test('full-mode core commands respect request overrides and refusals', async () => {
  const f = await fixture();
  await writeFile(f.configFile, JSON.stringify({ ...f.config, mode: 'full', app: { binary: f.hc.appBinary, home: join(f.hc.root, 'app') } }));
  const ports = configFixtureCwd(createProductionHerdrCliPorts(f.hc.root, { ...process.env, SPIDER_GLOBAL_ROOT: f.globalRoot }), f.hc.root);
  cleanups.push(() => ports.dispose());
  const request = vi.fn((path?: string) => ports.request(path));
  let stderr = '';
  const supplied = { ...ports, request, stdout() {}, stderr(text: string) { stderr += text; } };
  expect(await runHerdrCli(['resume-offer', '--config', f.configFile], supplied)).toBe(0);
  expect(request).toHaveBeenCalledOnce();
  expect(await runHerdrCli(['admin', '--session-id', 'owner-session', '--wrapper', join(f.hc.root, 'missing-wrapper'), '--reason', 'repair', '--destination', 'box-1.invalid', '--', 'id'], supplied)).toBe(1);
  expect(stderr).toContain('admin-not-authorized');
  expect(request).toHaveBeenCalledTimes(2);
  stderr = '';
  expect(await runHerdrCli(['resume-offer', '--config', f.configFile], { ...supplied, request: async () => { throw new HerdrError('view-on-mac', 'Request refused'); } })).toBe(1);
  expect(stderr).toBe('view-on-mac: Request refused\n');
}, 5000);

test('core-only child keeps its execution and presence without an app', async () => {
  const app = vi.spyOn(appModule, 'createAppClient');
  const f = await fixture(true);
  f.allowRemote();
  await f.emit('session_start', { reason: 'startup' });
  const owner = f.mount.owner(), remote = f.mount.execution().remote;
  expect(owner).toMatchObject({ sessionId: 'owner-session', terminal: { terminalId: 't1' } });
  expect(remote).toBeDefined();
  expect(await createProcessPresence(join(f.globalRoot, 'herdr')).list()).toMatchObject([{ sessionId: 'child-session', kind: 'child', hcAddress: 't1' }]);
  const result = await remote!.execute({ owner: owner!, on: 'box-1.invalid' as never, background: true, timeout: 50,
    source: { kind: 'code', language: 'javascript', code: 'console.log(1)' } });
  expect(result.remote.machine).toBe('box-1.invalid');
  expect(await hostPorts.readJobJournal(join(f.globalRoot, 'herdr/jobs'), owner!)).toEqual(expect.arrayContaining([expect.objectContaining({ id: result.remote.jobId, runId: 'child-run', detached: true })]));
  expect(app.mock.calls.length).toBe(0);
  expect(f.errors).toEqual([]);
  expect(f.notices).toEqual([]);
}, 5000);
