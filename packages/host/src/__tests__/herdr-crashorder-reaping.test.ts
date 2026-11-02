// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import * as hcModule from '@spider/herdr/client/hc';
import * as monitorModule from '@spider/herdr/jobs/monitor';
import * as consoleModule from '@spider/herdr/remote/console';
import * as viewerModule from '@spider/herdr/viewers/register';
import { processStartIdentity } from '../../../herdr/src/jobs/handoff.js';
import { openDbAt } from '@spider/db-core';
import { scratchDbPath } from '@spider/db-core/testutil';
import { RunStore } from '../../../subagents/src/run-store.js';
import { createHerdrHarness, type HerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { setupHerdr, type SetupRequest } from '../../../herdr/src/setup/installer.js';
import { installRuntimeDirectory } from '../../../herdr/src/remote/runtime.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { mountHerdr } from '../herdr/mount.js';
import type { HcClient, MachineName, TerminalAddress } from '../../../herdr/src/contracts.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function fixture(mode: 'fake' | 'hc' = 'fake', wrap?: (client: HcClient) => HcClient) {
  const h: HerdrHarness = await createHerdrHarness(mode);
  cleanups.push(async () => {
    await h.close();
    await mkdir(resolve('.spider/scratch/crashorder'), { recursive: true });
    await writeFile(resolve(`.spider/scratch/crashorder/cleanup-${h.root.split('/').at(-1)}.json`), JSON.stringify(h.cleanupProof, null, 2));
    expect(await h.remainingOwnedResources()).toEqual([]);
  });
  await h.start();
  execFileSync('git', ['init', '-q', h.directories.local]);
  for (const [name, value] of Object.entries(h.localEnv)) if (value !== undefined && (name.startsWith('HC_') || name.startsWith('XDG_') || name.startsWith('HERDR_'))) vi.stubEnv(name, value);
  vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global); vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  const root = join(h.directories.remote, 'programs'), coreConfig = join(h.root, 'core.toml');
  await writeFile(coreConfig, 'notes = false\n');
  let appBinary = h.appBinary;
  if (mode === 'hc') {
    appBinary = join(h.root, 'fake-app');
    const layout = JSON.stringify({ spaces: [{ id: 'space', tabs: [{ id: 'owner-tab', terminals: [{ terminal: h.owner!.terminal.address, pane: 'main-pane' }] }] }] });
    await writeFile(appBinary, `#!/bin/sh\nprintf '%s\\n' '${layout}'\n`); await chmod(appBinary, 0o700);
  }
  const config = parseHerdrConfig({ enabled: true, app: { binary: appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: coreConfig }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', nodePath: h.nodeBinary, runtime: { directory: root, cwd: h.root, commands: { javascript: [h.nodeBinary], shell: ['/bin/sh'] } } }] });
  const file = join(h.directories.global, 'herdr/config.json'); await mkdir(join(h.directories.global, 'herdr'), { recursive: true }); await writeFile(file, JSON.stringify(config));
  const packageRoot = join(h.root, 'package'); await mkdir(join(packageRoot, 'dist/herdr'), { recursive: true });
  await writeFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs'), await readFile(resolve('dist/herdr/remote-runtime.mjs')));
  const request: SetupRequest = { config, configPath: file, packageRoot, journalRoot: join(h.root, 'journal') };
  const setup = createProductionHerdrCliPorts(packageRoot, h.localEnv);
  try {
    const parts = await setup.setupParts(request);
    await setupHerdr(request, { ...parts, hc: h.hc,
      preflight: async () => ({ fingerprint: 'fixture', coreIdentity: h.owner!.terminal, mods: [], targets: [], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
      bootstrapRuntime: async () => { await installRuntimeDirectory(root); },
      cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }), warn() {} });
  } finally { await setup.dispose(); }
  const dbPath = scratchDbPath('fx4-console-runs'), globalPath = scratchDbPath('fx4-console-global');
  const db = openDbAt(dbPath, 'worktree'), globalDb = openDbAt(globalPath, 'global'), store = new RunStore(db);
  cleanups.push(async () => { db.close(); globalDb.close(); });
  const hooks = new Map<string, Set<Function>>(), errors: unknown[] = [], notices: monitorModule.JobNotice[] = [];
  const pi = { getSessionName: () => undefined, on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); }, registerTool() {}, registerShortcut() {}, sendMessage(notice: monitorModule.JobNotice) { notices.push(notice); } };
  const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => h.owner!.sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
  if (wrap) { const original = hcModule.createHcClient; vi.spyOn(hcModule, 'createHcClient').mockImplementation(options => wrap(original(options)) as ReturnType<typeof hcModule.createHcClient>); }
  const mount = mountHerdr(pi as never, { packageRoot, actionContext: () => ({ db, globalDb, sessionId: h.owner!.sessionId, pi }), reportError: error => errors.push(error),
    views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
    dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }), readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } },
  });
  const emit = async (name: string, event: object) => { for (const handler of [...hooks.get(name) ?? []]) await handler(event, ctx); };
  cleanups.push(async () => { await emit('session_shutdown', { reason: 'quit' }); await mount.dispose(); });
  const labels = (session: string, run?: string, terminal: string = h.owner!.terminal.terminalId, core: string = h.owner!.terminal.coreId) => ({ 'spider.kind': 'remote-console', 'spider.session': session, 'spider.machine': 'remote.invalid', 'spider.owner-core': core, 'spider.owner-terminal': terminal, ...(run ? { 'spider.run': run } : {}) });
  const launch = async (attrs: Record<string, string>) => h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as MachineName, labels: attrs, noNotify: true, background: true, outliveParent: true });
  const missing = async (address: TerminalAddress) => { try { await h.hc.get(address); return false; } catch (error) { if ((error as { code?: string }).code === 'not_found') return true; throw error; } };
  return { h, store, mount, emit, labels, launch, missing, errors, notices, config, file, packageRoot };
}


const realEnabled = process.env.SPIDER_HERDR_E2E === '1' && existsSync(process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc'));
if (!realEnabled) console.info('SKIP independent crash reaping proof: requires hc and SPIDER_HERDR_E2E=1; no app window');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
it.skipIf(!realEnabled).each(['run-status', 'late-created', 'missed'] as const)('real hc independent %s reaping waits for crashed foreground cancellation', async path => {
  let foreground: TerminalAddress | undefined, consoleAddress: TerminalAddress | undefined;
  let permitKill!: () => void, killStarted!: () => void, reaperRequested!: () => void, consoleClosed!: () => void;
  const heldKill = new Promise<void>(resolve => { permitKill = resolve; });
  const cancelling = new Promise<void>(resolve => { killStarted = resolve; });
  const cleanupRequested = new Promise<void>(resolve => { reaperRequested = resolve; });
  const closed = new Promise<void>(resolve => { consoleClosed = resolve; });
  let gate = '', backgroundEffect = '', foregroundEffect = '', payloadPid = 0, identityAtClose: string | null | undefined;
  const deliveries = new Set<(event: import('../../../herdr/src/contracts.js').HcEvent) => void>();
  // Viewer placement is independent of crash cleanup and this proof opens no app window.
  vi.spyOn(viewerModule, 'registerHerdrViewers').mockImplementation(() => ({ dispose() {}, peek: async () => null, launcher: async () => { throw new Error('Viewer launch is outside this proof'); } }));
  const originalMonitor = monitorModule.createJobMonitor;
  vi.spyOn(monitorModule, 'createJobMonitor').mockImplementation(options => {
    const monitor = originalMonitor(options);
    return { ...monitor, reconcile: async () => { reaperRequested(); await monitor.reconcile(); } };
  });
  if (path === 'missed') {
    const original = consoleModule.registerAgentConsoleLifecycle;
    vi.spyOn(consoleModule, 'registerAgentConsoleLifecycle').mockImplementation((pi, ports) => original(pi, { ...ports, subscribeRunEnds: () => () => {} }));
  }
  const f = await fixture('hc', client => ({ ...client,
    kill: async address => {
      if (address === foreground) { killStarted(); await heldKill; }
      await client.kill(address);
      if (address === consoleAddress) {
        identityAtClose = processStartIdentity(payloadPid);
        await writeFile(gate, 'console closed');
        await expect.poll(() => existsSync(backgroundEffect), { timeout: 10000 }).toBe(true);
        consoleClosed();
      }
    },
    events: () => { const source = client.events(); return { ...source, subscribe: listener => { deliveries.add(listener); const off = source.subscribe(listener); return () => { deliveries.delete(listener); off(); }; } }; },
  }));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    gate = join(f.h.root, 'gate'); backgroundEffect = join(f.h.root, 'background-effect'); foregroundEffect = join(f.h.root, 'foreground-effect');
    const run = f.store.create({ sessionId: f.h.owner!.sessionId, agent: 'worker' }).id; f.store.start(run);
    await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.spiderHerdrRuntimeEntry': 'false' }, ssr: { noExternal: [/^@spider\//] }, build: { ssr: fileURLToPath(new URL('../../../herdr/src/__tests__/herdr-crashfg-owner.ts', import.meta.url)), outDir: join(f.h.root, 'bundle'), emptyOutDir: false,
      rollupOptions: { external: [/^@earendil-works\//, 'better-sqlite3', 'sqlite-vec'], output: { entryFileNames: 'owner.mjs' } } } });
    const held = (name: string, effect: string) => `printf '%s' "$$" > ${quote(join(f.h.root, name + '-ready'))}; while [ ! -f ${quote(gate)} ]; do sleep 0.05; done; printf ${quote(name)} > ${quote(effect)}; exit 29`;
    const readyFile = join(f.h.root, 'ready.json'), inputFile = join(f.h.root, 'input.json');
    await writeFile(inputFile, JSON.stringify({ owner: f.h.owner, runId: run, configFile: f.file, runtimeFile: join(f.packageRoot, 'dist/herdr/remote-runtime.mjs'), journalRoot: join(f.config.globalRoot, 'herdr/jobs'), readyFile, foreground: held('foreground', foregroundEffect), background: held('background', backgroundEffect) }));
    let stderr = '';
    child = spawn(process.execPath, [join(f.h.root, 'bundle/owner.mjs'), inputFile], { env: f.h.localEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr!.on('data', bytes => { stderr += bytes; });
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    await expect.poll(() => existsSync(readyFile), { timeout: 20000, message: stderr }).toBe(true);
    const ready = JSON.parse(await readFile(readyFile, 'utf8'));
    foreground = ready.foreground.address;
    await expect.poll(() => existsSync(join(f.h.root, 'foreground-ready')) && existsSync(join(f.h.root, 'background-ready')), { timeout: 10000 }).toBe(true);
    payloadPid = Number(await readFile(join(f.h.root, 'foreground-ready'), 'utf8'));
    const payloadIdentity = processStartIdentity(payloadPid); expect(payloadIdentity).not.toBeNull();
    await f.emit('session_start', { reason: 'startup' }); expect(f.mount.enabled()).toBe(true);
    const launchConsole = async () => { const console = await f.launch(f.labels(f.h.owner!.sessionId, run)); consoleAddress = console.address; return console; };
    if (path !== 'late-created') await launchConsole();
    const sibling = await f.launch(f.labels(f.h.owner!.sessionId, 'active-sibling'));
    child.kill('SIGKILL'); await exited; expect(child.signalCode).toBe('SIGKILL');
    await cancelling;
    f.store.cancel(run, 'writer crashed');
    if (path === 'late-created') await launchConsole();
    if (path === 'missed') { const terminal = await f.h.hc.get(consoleAddress!); for (const deliver of [...deliveries]) deliver({ type: 'missed', seq: 1000, terminals: [terminal] }); }
    await Promise.race([cleanupRequested, closed]);
    expect(existsSync(foregroundEffect), 'independent reaper closed before foreground cancellation').toBe(false);
    expect((await f.h.hc.get(consoleAddress!)).state).toBe('live');
    expect((await f.h.hc.get(foreground!)).state).toBe('live');
    permitKill(); await closed;
    expect(identityAtClose).not.toBe(payloadIdentity);
    await expect.poll(() => f.missing(consoleAddress!), { timeout: 10000 }).toBe(true);
    await expect.poll(() => f.notices.filter(notice => notice.details.jobId === ready.background.id).length, { timeout: 10000 }).toBe(1);
    expect(existsSync(foregroundEffect)).toBe(false);
    expect(await readFile(backgroundEffect, 'utf8')).toBe('background');
    expect(f.notices.find(notice => notice.details.jobId === ready.background.id)?.details.runId).toBe(run);
    expect((await f.h.hc.get(sibling.address)).state).toBe('live');
    expect(f.errors, stderr).toEqual([]); expect(stderr).toBe('');
    await mkdir(resolve('.spider/scratch/crashorder'), { recursive: true });
    await writeFile(resolve(`.spider/scratch/crashorder/reaping-${path}.json`), JSON.stringify({ path, foregroundPayloadGoneAtClose: identityAtClose !== payloadIdentity, foregroundEffect: false, backgroundEffect: 'background', notices: f.notices.length, runId: run, localSocket: f.h.localSocket, remoteSocket: f.h.remoteSocket }, null, 2));
  } finally {
    permitKill();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill('SIGKILL'); await exited; }
  }
}, 60000);
