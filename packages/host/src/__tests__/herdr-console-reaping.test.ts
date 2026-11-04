// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDbAt } from '@spider/db-core';
import { scratchDbPath } from '@spider/db-core/testutil';
import { RunStore } from '../../../subagents/src/run-store.js';
import { createHerdrHarness, type HerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { createProcessPresence } from '../../../herdr/src/sessions/presence.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { setupHerdr, type SetupRequest } from '../../../herdr/src/setup/installer.js';
import { installRuntimeDirectory } from '../../../herdr/src/remote/runtime.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { mountHerdr } from '../herdr/mount.js';
import type { HcClient, MachineName, TerminalAddress, TerminalHandle } from '../../../herdr/src/contracts.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });

async function fixture(mode: 'fake' | 'hc' = 'fake', reportErrors = true, hasUI = false) {
  const h: HerdrHarness = await createHerdrHarness(mode); cleanups.push(async () => { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }); await h.start();
  execFileSync('git', ['init', '-q', h.directories.local]);
  for (const [name, value] of Object.entries(h.localEnv)) if (value !== undefined && (name.startsWith('HC_') || name.startsWith('XDG_') || name.startsWith('HERDR_'))) vi.stubEnv(name, value);
  vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global); vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  const root = join(h.directories.remote, 'programs'), coreConfig = join(h.root, 'core.toml');
  await writeFile(coreConfig, 'notes = false\n');
  let appBinary = h.appBinary;
  if (mode === 'hc') { appBinary = join(h.root, 'fake-app'); await writeFile(appBinary, '#!/bin/sh\nprintf "{\\"spaces\\":[]}\\n"\n'); await chmod(appBinary, 0o700); }
  const config = parseHerdrConfig({ enabled: true, app: { binary: appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: coreConfig }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', nodePath: h.nodeBinary, runtime: { directory: root, cwd: h.root, commands: { javascript: [h.nodeBinary], shell: ['/bin/sh'] } } }] });
  const file = join(h.directories.global, 'herdr/config.json'); await mkdir(join(h.directories.global, 'herdr'), { recursive: true }); await writeFile(file, JSON.stringify(config));
  const packageRoot = join(h.root, 'package'); await mkdir(join(packageRoot, 'dist/herdr'), { recursive: true });
  await writeFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs'), await readFile(resolve('dist/herdr/remote-runtime.mjs')));
  await writeFile(join(packageRoot, 'dist/herdr/viewer.mjs'), await readFile(resolve('dist/herdr/viewer.mjs')));
  const request: SetupRequest = { config, configPath: file, packageRoot, journalRoot: join(h.root, 'journal') };
  const setup = createProductionHerdrCliPorts(packageRoot, h.localEnv);
  let runtime: Awaited<ReturnType<Awaited<ReturnType<typeof setup.setupParts>>['ensureRuntime']>>[number];
  try {
    const parts = await setup.setupParts(request);
    await setupHerdr(request, { ...parts, hc: h.hc,
      preflight: async () => ({ fingerprint: 'fixture', coreIdentity: h.owner!.terminal, mods: [], targets: [], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
      bootstrapRuntime: async () => { await installRuntimeDirectory(root); },
      cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }), warn() {} });
    [runtime] = await parts.ensureRuntime(request, {} as never);
  } finally { await setup.dispose(); }
  const dbPath = scratchDbPath('fx4-console-runs'), globalPath = scratchDbPath('fx4-console-global');
  const db = openDbAt(dbPath, 'worktree'), globalDb = openDbAt(globalPath, 'global'), store = new RunStore(db);
  cleanups.push(async () => { db.close(); globalDb.close(); });
  const hooks = new Map<string, Set<Function>>(), errors: unknown[] = [], notices: string[] = [];
  const pi = { getSessionName: () => undefined, on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); }, registerTool() {}, registerShortcut() {}, sendMessage() {} };
  const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI, ui: { notify(message: string) { notices.push(message); }, setStatus() {} }, sessionManager: { getSessionId: () => h.owner!.sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
  const mount = mountHerdr(pi as never, { packageRoot, actionContext: () => ({ db, globalDb, sessionId: h.owner!.sessionId, pi }), ...(reportErrors ? { reportError: (error: unknown) => errors.push(error) } : {}),
    views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
    dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }), readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } },
  });
  const emit = async (name: string, event: object) => { for (const handler of [...hooks.get(name) ?? []]) await handler(event, ctx); };
  cleanups.push(async () => { await emit('session_shutdown', { reason: 'quit' }); await mount.dispose(); });
  const labels = (session: string, run?: string, terminal: string = h.owner!.terminal.terminalId, core: string = h.owner!.terminal.coreId) => ({ 'spider.kind': 'remote-console', 'spider.session': session, 'spider.machine': 'remote.invalid', 'spider.owner-core': core, 'spider.owner-terminal': terminal, ...(run ? { 'spider.run': run } : {}) });
  const launch = async (attrs: Record<string, string>) => h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as MachineName, labels: attrs, noNotify: true, background: true, outliveParent: true });
  const missing = async (address: TerminalAddress) => { try { await h.hc.get(address); return false; } catch (error) { if ((error as { code?: string }).code === 'not_found') return true; throw error; } };
  return { h, store, mount, emit, labels, launch, missing, errors, notices, runtime, config, presence: createProcessPresence(join(h.directories.global, 'herdr')) };
}

it('reports a console replacement failure without adding a UI warning', async () => {
  const f = await fixture('fake', false, true); await f.emit('session_start', { reason: 'startup' });
  const old = await f.launch(f.labels(f.h.owner!.sessionId));
  await f.h.scenario({ steps: [{ argvPrefix: ['kill'], once: true, stderr: { error: { kind: 'fixture-failure', message: 'Cannot stop console' } }, exitCode: 3 }] }, 'remote');
  const noticesBefore = [...f.notices]; const messages: string[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((text: string | Uint8Array) => { messages.push(String(text)); return true; }) as typeof process.stderr.write);
  try {
    const result = await f.mount.execution().remote!.execute({ owner: f.mount.owner()!, on: 'remote.invalid' as MachineName, source: { kind: 'code', language: 'shell', code: 'printf result' } });
    expect(result).toMatchObject({ stdout: 'result', exitCode: 0 });
    expect((await f.h.hc.get(old.address)).state).toBe('live');
    expect(messages.filter(message => message.includes('fixture-failure'))).toHaveLength(1);
    expect(f.notices).toEqual(noticesBefore);
  } finally { stderr.mockRestore(); }
}, 30000);

it('startup reaps crashed-owner run consoles while keeping live and unverified owners', async () => {
  const f = await fixture();
  const parent = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, labels: {}, noNotify: true, background: true, outliveParent: true });
  const orphan = await f.launch(f.labels('abandoned', 'old-run', parent.address));
  const unknown = await f.launch(f.labels('unknown', 'unknown-run', parent.address));
  const foreign = await f.launch(f.labels('abandoned', 'foreign-run', parent.address, 'other-core'));
  await f.presence.record({ pid: 2147483647, startIdentity: 'crashed', sessionId: 'abandoned' as never, sessionFile: null, sessionName: null, hcAddress: parent.address, kind: 'top-level' });
  const session = f.h.owner!.sessionId;
  const ended = f.store.create({ sessionId: session, agent: 'worker' }).id; f.store.start(ended); f.store.cancel(ended, 'ended before restart');
  const finishedConsole = await f.launch(f.labels(session, ended));
  await f.emit('session_start', { reason: 'reload' }); expect(f.mount.enabled()).toBe(true);
  expect((await f.h.hc.get(orphan.address)).state).toBe('live');
  await f.emit('session_shutdown', { reason: 'reload' });
  await f.emit('session_start', { reason: 'startup' });
  expect(await f.missing(orphan.address)).toBe(true);
  expect(await f.missing(finishedConsole.address)).toBe(true);
  expect((await f.h.hc.get(unknown.address)).state).toBe('live');
  expect((await f.h.hc.get(foreign.address)).state).toBe('live');
  expect((await f.h.hc.get(parent.address)).state).toBe('live'); expect(f.errors).toEqual([]);
}, 30000);

it('resuming a session keeps a running subagent console whose original parent terminal is gone', async () => {
  const f = await fixture();
  const session = f.h.owner!.sessionId, oldTerminal = 'retired-parent' as TerminalAddress;
  const run = f.store.create({ sessionId: session, agent: 'worker' }).id; f.store.start(run);
  const console = await f.launch(f.labels(session, run, oldTerminal));
  await f.presence.record({ pid: 2147483647, startIdentity: 'exited', sessionId: session, sessionFile: null, sessionName: null, hcAddress: oldTerminal, kind: 'top-level' });
  await f.emit('session_start', { reason: 'startup' });
  expect((await f.h.hc.get(console.address)).state).toBe('live');
  f.store.cancel(run, 'Explicit stop');
  await expect.poll(() => f.missing(console.address), { timeout: 8000 }).toBe(true);
  expect(f.errors).toEqual([]);
}, 30000);

it('reaps a cancelled run even when its first console arrives after cancellation', async () => {
  const f = await fixture(); await f.emit('session_start', { reason: 'startup' }); expect(f.mount.enabled()).toBe(true);
  const session = f.h.owner!.sessionId;
  const early = f.store.create({ sessionId: session, agent: 'worker' }).id; f.store.start(early);
  const live = f.store.create({ sessionId: session, agent: 'worker' }).id; f.store.start(live);
  const late = f.store.create({ sessionId: session, agent: 'worker' }).id; f.store.start(late);
  const first = await f.launch(f.labels(session, early)); const survivor = await f.launch(f.labels(session, live));
  f.store.cancel(early, 'killed');
  f.store.cancel(late, 'killed before console launch completes');
  const delayed = await f.launch(f.labels(session, late));
  await expect.poll(() => f.missing(first.address), { timeout: 8000 }).toBe(true);
  await expect.poll(() => f.missing(delayed.address), { timeout: 8000 }).toBe(true);
  expect((await f.h.hc.get(survivor.address)).state).toBe('live'); expect(f.errors).toEqual([]);
}, 30000);

async function firstConsoleRace(mode: 'fake' | 'hc') {
  const f = await fixture(mode); await f.emit('session_start', { reason: 'startup' }); expect(f.mount.enabled()).toBe(true);
  const session = f.h.owner!.sessionId, run = f.store.create({ sessionId: session, agent: 'worker' }).id; f.store.start(run);
  let release!: () => void, launched!: (handle: TerminalHandle) => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<TerminalHandle>(resolve => { launched = resolve; });
  const hc: HcClient = { ...f.h.hc, run: async request => { const handle = await f.h.hc.run(request); launched(handle); await blocked; return handle; } };
  const { ensureAgentConsole } = await import('../../../herdr/src/remote/console.js');
  const on = 'remote.invalid' as MachineName;
  const target = { on, ...f.config.machines[0].runtime, environment: {}, nodePath: f.h.nodeBinary, runtimePath: f.runtime.path, runtimeSha256: f.runtime.sha256 };
  const starting = ensureAgentConsole({ owner: f.h.owner!, on, target, source: { kind: 'code', language: 'shell', code: 'echo unused' } }, hc,
    { ...f.h.localEnv, PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: run });
  const settled = starting.catch(() => null);
  try {
    const console = await started;
    await expect(access(join(f.config.globalRoot, 'herdr/jobs/sessions', session, 'runs', run, 'jobs.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    f.store.cancel(run, 'killed while starting the first console');
    await expect.poll(() => f.missing(console.address), { timeout: 8000 }).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { release(); await settled; }
}
it('closes the first console if its run is killed before the launch reply', () => firstConsoleRace('fake'), 30000);
it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !existsSync(process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc')))('real isolated hc closes a first console killed during startup (requires hc and SPIDER_HERDR_E2E=1)', () => firstConsoleRace('hc'), 45000);
