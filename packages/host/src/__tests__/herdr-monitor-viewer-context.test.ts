import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendRunEvent, openDbAt } from '@spider/db-core';
import { RunStore } from '../../../subagents/src/run-store.js';
import { buildChildSpawnSpec } from '../../../subagents/src/pi-args.js';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import type { HcRunRequest, RunId } from '../../../herdr/src/contracts.js';
import type { ViewerRegistration, ViewerRegistrationPorts } from '../../../herdr/src/viewers/register.js';
import * as hcModule from '../../../herdr/src/client/hc.js';
import * as viewerModule from '../../../herdr/src/viewers/register.js';
import { mountHerdr } from '../herdr/mount.js';

const cleanups: (() => Promise<void>)[] = [];
async function closeAll(callbacks: readonly (() => Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const close of callbacks) try { await close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Metadata fixture cleanup failed');
}
afterEach(async () => { try { await closeAll(cleanups.splice(0).reverse()); } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); } });

it('metadata fixture cleanup still closes its core after mount cleanup fails', async () => {
  const calls: string[] = [];
  await expect(closeAll([async () => { calls.push('mount'); throw new Error('mount cleanup failed'); }, async () => { calls.push('core'); }])).rejects.toThrow();
  expect(calls).toEqual(['mount', 'core']);
});

it.each(['top-level', 'nested', 'rpc', 'gone', 'file', 'blocked', 'invalid-header', 'legacy'] as const)('the production viewer launch uses run metadata with a safe %s cwd', async mode => {
  const core = process.env.SPIDER_HERDR_E2E === '1' && process.env.SPIDER_HERDR_HEADER_CORE === 'hc' ? 'hc' : 'fake';
  const h = await createHerdrHarness(core); cleanups.push(() => h.close()); await h.start();
  let appBinary = h.appBinary;
  if (core === 'hc') {
    const hcAlias = join(h.root, 'hc');
    if (!existsSync(hcAlias)) { await writeFile(hcAlias, `#!/bin/sh\nexec '${h.hcBinary}' "$@"\n`); await chmod(hcAlias, 0o700); }
    const script = join(h.root, 'header-app.mjs'); appBinary = join(h.root, 'header-app');
    await writeFile(join(h.directories.local, 'app.json'), JSON.stringify({ spaces: [{ id: 'space', active: true, tabs: [{ id: 'tab', active: true, terminals: [{ terminal: h.owner!.terminal.address, pane: 'owner-pane' }] }] }] }));
    await writeFile(script, `import {execFileSync} from 'node:child_process'; import {writeFileSync} from 'node:fs';\nconst env={...process.env,HERDR_FAKE_ROOT:${JSON.stringify(h.directories.local)},HERDR_TEST_ROOT:${JSON.stringify(h.root)}};\nconst rows=JSON.parse(execFileSync(${JSON.stringify(h.hcBinary)},['ls','--all','--json'],{env,encoding:'utf8'}));\nwriteFileSync(${JSON.stringify(join(h.directories.local, 'core.json'))},JSON.stringify({coreId:${JSON.stringify(h.owner!.terminal.coreId)},terminals:rows.terminals.map(t=>JSON.parse(execFileSync(${JSON.stringify(h.hcBinary)},['get',t.address,'--json'],{env,encoding:'utf8'}))),machines:[]}));\nprocess.stdout.write(execFileSync(process.execPath,[${JSON.stringify(resolve('packages/herdr/src/__tests__/fake-app.mjs'))},...process.argv.slice(2)],{env}));\n`);
    await writeFile(appBinary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`); await chmod(appBinary, 0o700);
  }
  const globalRoot = join(h.root, 'global'), cwd = join(h.root, 'owner-cwd'), runCwd = join(h.root, 'run-cwd');
  await mkdir(cwd); execFileSync('git', ['init', '-q', cwd]);
  if (mode === 'file') await writeFile(runCwd, 'Not a directory'); else if (mode !== 'gone') await mkdir(runCwd);
  if (mode === 'blocked') { await chmod(runCwd, 0); cleanups.push(() => chmod(runCwd, 0o700)); }
  for (const [key, value] of Object.entries(h.localEnv)) if (value !== undefined && /^(HC_|XDG_|HERDR_)/.test(key)) vi.stubEnv(key, value);
  vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot); vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  const configPath = join(globalRoot, 'herdr/config.json'); await mkdir(join(globalRoot, 'herdr'), { recursive: true });
  const config = parseHerdrConfig({ enabled: true, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, app: { binary: appBinary, home: join(h.root, 'app-home') }, globalRoot, agentDirectory: join(h.root, 'agent'), shellRc: join(h.root, 'shellrc'), spaces: [], machines: [] });
  await writeFile(configPath, JSON.stringify(config));
  await setupHerdr({ config, configPath, packageRoot: h.root, journalRoot: join(h.root, 'setup') }, {
    globalRoot, preflight: async () => ({ fingerprint: 'fixture', coreIdentity: await h.hc.identity(), mods: [], targets: [], retiredTerminals: [], layoutExport: true }),
    stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
    probeMachineNode: async () => { throw new Error('No remote machine'); }, ensureRuntime: async () => [], bootstrapRuntime: async () => {},
    hc: h.hc, cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }), rollback: async () => {}, warn() {},
  });
  const dbPath = join(h.root, 'runs.db'), globalPath = join(h.root, 'global.db');
  const db = openDbAt(dbPath, 'worktree'), globalDb = openDbAt(globalPath, 'global'); cleanups.push(async () => { db.close(); globalDb.close(); });
  const calls: HcRunRequest[] = [], originalClient = hcModule.createHcClient, originalRegistration = viewerModule.registerHerdrViewers;
  vi.spyOn(hcModule, 'createHcClient').mockImplementation(options => { const hc = originalClient(options); return { ...hc, run: async request => { calls.push(request); return hc.run(request); } }; });
  let registration: ViewerRegistration | undefined, panePort: ViewerRegistrationPorts['panes'] | undefined;
  vi.spyOn(viewerModule, 'registerHerdrViewers').mockImplementation((pi, ports) => { panePort = ports.panes; registration = originalRegistration(pi, ports); return registration; });
  const hooks = new Map<string, Set<Function>>(), warnings: string[] = [];
  const pi = { on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); }, sendMessage() {}, registerTool() {}, registerShortcut() {}, getSessionName: () => 'Parent Session' } as unknown as ExtensionAPI;
  const sessionId = 'viewer-context-session';
  const ctx = { cwd, mode: 'rpc', hasUI: false, isIdle: () => true, ui: { notify(message: string) { warnings.push(message); } }, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getBranch: () => [], getEntries: () => [] } } as unknown as ExtensionContext;
  const mount = mountHerdr(pi, { packageRoot: resolve('.'), actionContext: () => ({ db, globalDb, sessionId, pi }) as never,
    views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
    dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} }, readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }) },
  });
  cleanups.push(async () => { await mount.dispose(); });
  for (const handler of [...hooks.get('session_start') ?? []]) await handler({}, ctx);
  expect(mount.enabled()).toBe(true);
  const store = new RunStore(db), parent = mode === 'nested' ? store.create({ sessionId, agent: 'worker', name: 'Parent Run' }).id : undefined;
  const { id } = store.create({ sessionId, agent: 'worker', name: 'Compile routes', parentRunId: parent }); store.start(id);
  store.setLaunch(id, { childMode: mode === 'rpc' ? 'rpc' : 'print' });
  // This is the locator emitted by Runner in 6395fa16. Its path comes from the
  // production spawn-spec builder, not the owner's cwd or a mocked launch row.
  const spec = buildChildSpawnSpec({ runId: id, sessionId, agent: 'worker', task: 'fixture', cwd: runCwd, scratchRoot: join(h.root, 'other-run-root'), dbPath, childMode: mode === 'rpc' ? 'rpc' : 'print', context: 'fresh', parentSessionId: sessionId, childIndex: 0 });
  if (mode !== 'legacy') {
    appendRunEvent(db, { runId: id, sessionId, ts: Date.now(), type: 'child_transcript', payload: { version: 1, directory: spec.sessionDir } });
    await writeFile(spec.sessionFile!, mode === 'invalid-header' ? '{broken}\n' : JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: spec.cwd }) + '\n');
  }
  const terminal = await registration!.peek(id as RunId); expect(terminal).not.toBeNull();
  const launch = calls.find(request => request.labels?.['spider.run'] === id)!;
  expect(launch).toBeDefined(); expect(launch.labels?.['spider.display-name']).toBe('Compile routes');
  expect(launch.name).toMatch(/^[a-z0-9][a-z0-9_.-]{0,31}$/);
  expect(launch.cwd).toBe(mode === 'top-level' || mode === 'nested' || mode === 'rpc' ? runCwd : cwd);
  expect(launch.labels?.['spider.parent-name']).toBe(mode === 'nested' ? 'Parent Run' : 'Parent Session');
  expect(launch.labels?.['spider.steer']).toBe(mode === 'rpc' ? 'rpc' : 'headless');
  expect(launch.labels?.['spider.kind']).toBe('subagent-viewer');
  const observed = await h.hc.get(terminal!.address); expect(observed.state).toBe('live');
  expect(observed.labels).toMatchObject({ 'spider.parent-name': mode === 'nested' ? 'Parent Run' : 'Parent Session', 'spider.steer': mode === 'rpc' ? 'rpc' : 'headless', 'spider.kind': 'subagent-viewer', 'spider.display-name': 'Compile routes' });
  expect((await h.cli(['get', terminal!.address, '--json']) as { name: string }).name).toBe(launch.name);
  if (mode === 'top-level') {
    expect((await registration!.peek(id as RunId))!.address).toBe(terminal!.address);
    const second = store.create({ sessionId, agent: 'worker', name: 'Compile routes' }).id; store.start(second); store.setLaunch(second, { childMode: 'print' });
    const next = await registration!.peek(second as RunId), secondLaunch = calls.find(request => request.labels?.['spider.run'] === second)!;
    expect(next!.address).not.toBe(terminal!.address);
    expect(secondLaunch.name).not.toBe(launch.name);
    expect((await h.hc.get(next!.address)).labels['spider.display-name']).toBe('Compile routes');
    await panePort!.park(second as RunId);
    expect(store.get(second)!.status).toBe('running');
  }
  expect(warnings.filter(message => /viewer|cwd/i.test(message))).toEqual([]);
}, 30000);
