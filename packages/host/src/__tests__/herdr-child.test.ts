// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile, readdir, chmod, access } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { paths } from '@spider/db-core';
import { globalConfigForTest } from '../../../db-core/src/__tests__/global-config.testutil.js';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { mountHerdr } from '../herdr/mount.js';
import { runExec, runExecFile, runBatch } from '../../../context/src/actions/exec.js';
import { execFileSync } from 'node:child_process';
import { setupHerdr, runtimeInstallPath, standardHerdrConfigPath } from '../../../herdr/src/setup/installer.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';

afterEach(() => vi.unstubAllEnvs());
async function childFixture(location: 'standard' | 'relative' = 'standard') {
  const globalConfig = globalConfigForTest(paths.globalRoot);
  const h = await createHerdrHarness('fake'); await h.start();
  for (const [key, value] of Object.entries(h.localEnv)) if (value !== undefined && /^(HC_|XDG_|HERDR_)/.test(key)) vi.stubEnv(key, value);
  vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', h.owner!.sessionId); vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
  const config = { enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', aliases: ['managed.invalid', 'box.invalid', 'MyBox.invalid'], runtime: { cwd: h.directories.remote, directory: join(h.directories.remote, 'programs'), commands: {} }, nodePath: process.execPath }], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
  const runtime = Buffer.from(stripTypeScriptTypes(await readFile(fileURLToPath(new URL('../../../herdr/src/remote/runtime.ts', import.meta.url)), 'utf8')));
  await mkdir(join(h.root, 'dist/herdr'), { recursive: true }); await writeFile(join(h.root, 'dist/herdr/remote-runtime.mjs'), runtime);
  execFileSync('git', ['init', '-q', h.root]);
  globalConfig.set('herdr.enabled', true);
  const configPath = location === 'standard' ? standardHerdrConfigPath(config.globalRoot) : join(config.globalRoot, 'relative-config.json');
  const request = { config: config as never, configPath, packageRoot: h.root, journalRoot: join(config.globalRoot, 'herdr/setup') };
  const installer = createProductionHerdrCliPorts(h.root, h.localEnv), parts = await installer.setupParts(request);
  try {
    await setupHerdr(request, { ...parts,
      preflight: async () => ({ fingerprint: 'child-fixture', coreIdentity: await h.hc.identity(), mods: [], targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'fixture' }], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], installFiles: async () => [{ path: configPath, bytes: Buffer.from(JSON.stringify(config)), expected: null }], generateTemplates: async () => [], installResume: async () => [],
      cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [] } as never),
    });
  } finally { await installer.dispose(); }
  if (location === 'relative') globalConfig.set('herdr.config', relative(paths.globalRoot, configPath));
  vi.stubEnv('PI_SUBAGENT_CHILD', '1'); vi.stubEnv('PI_SUBAGENT_RUN_ID', 'child-run'); vi.stubEnv('PI_SUBAGENT_RUN_NAME', 'worker');
  const setupCallCount = (await h.calls()).length;
  const parentDirectory = join(h.directories.global, 'herdr/sessions', h.owner!.sessionId); await mkdir(parentDirectory, { recursive: true });
  const protectedFiles = ['session.json', 'ipc.json', 'terminal-map.json'].map(name => join(parentDirectory, name));
  for (const path of protectedFiles) await writeFile(path, 'parent-owned bytes');
  const hooks = new Map<string, Function[]>(), sent: any[] = [], widgets: string[] = [], errors: unknown[] = [];
  const pi = { on(name: string, fn: Function) { hooks.set(name, [...hooks.get(name) ?? [], fn]); return () => hooks.set(name, (hooks.get(name) ?? []).filter(f => f !== fn)); }, sendMessage(message: unknown) { sent.push(message); }, registerTool() {}, registerShortcut() { throw new Error('child shortcuts'); }, getSessionName: () => 'child' };
  const ctx = { cwd: h.root, mode: 'rpc', hasUI: false, ui: { notify() {}, setWidget(name: string) { widgets.push(name); } }, sessionManager: { getSessionId: () => 'child-session', getSessionFile: () => undefined, getBranch: () => [] } };
  const mount = mountHerdr(pi as never, { packageRoot: h.root, actionContext: () => { throw new Error('child action context'); }, reportError: error => errors.push(error), views: { agents: { open: async () => { throw new Error('child agents'); } }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } }, dataSource: { resolveRunDb: () => { throw new Error('child feed'); }, openApprovalDbs: () => { throw new Error('child approvals'); }, readUsage: async () => { throw new Error('child usage'); }, scheduler: { listTriggers: () => [], subscribe: () => () => {} } } });
  const emit = async (name: string, event: unknown) => { for (const fn of hooks.get(name) ?? []) await fn(event, ctx); };
  return { h, mount, ctx, pi, hooks, config, globalConfig, configPath, runtimePath: runtimeInstallPath(config.machines[0].runtime.directory, runtime), setupCallCount, sent, widgets, errors, protectedFiles, emit, async close() { await emit('session_shutdown', { reason: 'quit' }); await mount.dispose(); globalConfig.restore(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); } };
}
it('child host starts only its own remote execution and job monitor, never parent resources', async () => {
  const f = await childFixture();
  try {
    await f.emit('session_start', { reason: 'startup' });
    const ctx = { cwd: f.h.root, ...f.mount.execution() };
    const exec = await runExec({ action: 'exec', on: 'remote.invalid', language: 'javascript', code: "console.log('child output');process.exitCode=23" }, ctx);
    expect(exec.details).toMatchObject({ stdout: 'child output\n', exitCode: 23 });
    await writeFile(join(f.h.directories.remote, 'input.txt'), 'file value');
    const file = await runExecFile({ on: 'remote.invalid', path: 'input.txt', language: 'javascript', code: 'console.log(FILE_CONTENT)' }, ctx);
    expect(file.details.stdout).toBe('file value\n');
    const batch = await runBatch({ on: 'remote.invalid', commands: [{ language: 'javascript', code: "console.log('one')" }, { language: 'javascript', code: "console.log('two')" }] }, ctx);
    expect(batch.details.map(r => r.stdout)).toEqual(['one\n', 'two\n']);
    expect(f.widgets).toEqual([]); expect(f.sent).toEqual([]); expect(f.errors).toEqual([]);
    for (const path of f.protectedFiles) expect(await readFile(path, 'utf8')).toBe('parent-owned bytes');
    const herdrFiles = await readdir(join(f.h.directories.global, 'herdr'));
    expect(herdrFiles.sort()).toEqual(['config.json', 'jobs', 'processes', 'sessions', 'setup']);
    const calls = (await f.h.calls()).slice(f.setupCallCount);
    expect(calls.filter(c => ['label', 'set-labels'].includes(c.argv[0]))).toEqual([]);
    const launches = calls.filter(call => call.argv[0] === 'run' && call.argv.includes('--on'));
    const labels = launches.map(call => Object.fromEntries(call.argv.flatMap((arg, index) => arg === '--label' ? [call.argv[index + 1]!.split('=', 2)] : [])));
    expect(labels.map(label => [label['spider.kind'], label['spider.job'] ?? null])).toEqual([
      ['remote-console', null], ['exec', exec.details.remote?.jobId], ['exec-file', file.details.remote?.jobId], ...batch.details.map(result => ['batch', result.remote?.jobId]),
    ]);
    for (const label of labels) expect(label).toMatchObject({ 'spider.session': f.h.owner!.sessionId, 'spider.owner-core': f.h.owner!.terminal.coreId, 'spider.owner-terminal': f.h.owner!.terminal.terminalId, 'spider.machine': 'remote.invalid', 'spider.run': 'child-run' });
    const consoleCall = launches[0];
    const metadata = JSON.parse(JSON.parse((await f.h.hc.fileRead('remote.invalid' as never, join(consoleCall.argv[consoleCall.argv.indexOf('--console') + 1]!, 'console.json'))).toString()).body);
    expect(metadata.title).toBe('worker · remote.invalid');
    expect(await readFile(join(f.h.directories.local, 'app-calls.jsonl'), 'utf8')).toBe('');
    expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', language: 'shell', code: 'echo fine', on: 'remote.invalid' } })).toBeUndefined();
    expect(await f.mount.guard({ toolName: 'bash', input: { command: '/usr/bin/ssh managed.invalid echo forbidden' } })).toMatchObject({ block: true, reason: expect.stringContaining('on:remote.invalid') });
  } finally { await f.close(); }
// Four production-path jobs plus setup and cleanup spawn hundreds of fake-hc clients.
}, 60000);
it('child console lifecycle keeps reload alive and closes the run console on quit', async () => {
  const f = await childFixture();
  try {
    await f.emit('session_start', { reason: 'startup' });
    await runExec({ on: 'remote.invalid', language: 'javascript', code: "console.log('console entry')" }, { cwd: f.h.root, ...f.mount.execution() });
    const rows = (await f.h.cli(['ls', '--all', '--json'], 'remote') as { terminals: { address: string; labels: Record<string, string> }[] }).terminals;
    const consoles = rows.filter(row => row.labels['spider.kind'] === 'remote-console'); expect(consoles).toHaveLength(1);
    const address = `remote.invalid/${consoles[0].address}` as import('../../../herdr/src/contracts.js').TerminalAddress;
    await f.emit('session_shutdown', { reason: 'reload' }); expect(await f.h.hc.get(address)).toMatchObject({ state: 'live' });
    await f.emit('session_start', { reason: 'reload' }); await f.emit('session_shutdown', { reason: 'quit' });
    await expect(f.h.hc.get(address)).rejects.toMatchObject({ code: 'not_found' });
  } finally { await f.close(); }
}, 30000);
it.each(['disabled', 'outside'])('a child %s Herdr has ordinary local execution and a clear on error', async mode => {
  const f = await childFixture();
  try {
    const { createExecutionEnvironmentPolicy, SSH_DESCRIPTOR_ENV } = await import('../../../herdr/src/ssh/shim.js');
    const { createMachineCache } = await import('../../../herdr/src/ssh/cache.js');
    const cache = createMachineCache({ hc: f.h.hc, identity: f.h.owner!.terminal, directory: join(f.h.root, 'inherited-cache') });
    try { await cache.ready; } finally { cache.dispose(); }
    const shimDirectory = join(f.h.root, 'inherited-shim');
    const inherited = createExecutionEnvironmentPolicy({ shimDirectory, realSshBinary: f.h.sshBinary, shimProgram: join(f.h.root, 'shim.mjs'), cacheDescriptor: cache.descriptor })(f.h.localEnv);
    vi.stubEnv(SSH_DESCRIPTOR_ENV, inherited[SSH_DESCRIPTOR_ENV]); vi.stubEnv('PATH', inherited.PATH);
    if (mode === 'disabled') f.globalConfig.set('herdr.enabled', false); else vi.stubEnv('HC_TERMINAL_ID', '');
    await f.emit('session_start', { reason: 'startup' });
    const ctx = { cwd: f.h.root, ...f.mount.execution() };
    await expect(runExec({ on: 'remote.invalid', language: 'shell', code: 'printf forbidden' }, ctx)).rejects.toMatchObject({ code: 'herdr-unavailable' });
    const managed = await f.mount.guard({ toolName: 'bash', input: { command: 'ssh remote.invalid' } });
    if (mode === 'disabled') expect(managed).toBeUndefined();
    else expect(managed).toEqual({ block: true, reason: "This session isn't running inside Herdr. Spider blocked SSH to this Herdr-managed machine. Use spider exec with on:remote.invalid instead." });
    expect(await f.mount.guard({ toolName: 'bash', input: { command: 'ssh unmanaged.invalid' } })).toBeUndefined();
    const local = await runExec({ language: 'javascript', code: `console.log(process.env.${SSH_DESCRIPTOR_ENV} ?? 'clear');console.log(process.env.PATH.split(':')[0])` }, ctx);
    if (mode === 'disabled') { expect(local.details.stdout.split('\n')[0]).toBe('clear'); expect(local.details.stdout).not.toContain(shimDirectory); }
    else { expect(JSON.parse(local.details.stdout.split('\n')[0])).toMatchObject({ shimDirectory, cacheDescriptor: { identity: { coreId: f.h.owner!.terminal.coreId } } }); expect(local.details.stdout.split('\n')[1]).toBe(shimDirectory); }
    expect(f.mount.owner()).toBeNull(); expect(f.widgets).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it('child resolves a relative configured path through the same lookup as its parent', async () => {
  const f = await childFixture('relative');
  try {
    await f.emit('session_start', { reason: 'startup' });
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: "console.log('relative config')" }, { cwd: f.h.root, ...f.mount.execution() });
    expect(result.details).toMatchObject({ stdout: 'relative config\n', exitCode: 0 });
  } finally { await f.close(); }
}, 30000);

it('child shares the parent transport checks and resolves unmanaged SSH from PATH', async () => {
  const f = await childFixture();
  try {
    const bin = join(f.h.root, 'custom-bin'), ssh = join(bin, 'ssh'); await mkdir(bin);
    await writeFile(ssh, '#!/bin/sh\nprintf "custom-ssh:%s\\n" "$*"\nexit 23\n'); await chmod(ssh, 0o700);
    vi.stubEnv('PATH', bin + ':' + process.env.PATH);
    await f.emit('session_start', { reason: 'startup' });
    for (const command of ['scp f BOX.invalid:/x', 'sftp box.invalid', 'rsync -e ssh f MyBox.invalid:/x', 'GIT_SSH_COMMAND=/usr/bin/ssh git fetch box.invalid:repo', 'ssh MYBOX.INVALID true']) {
      expect(await f.mount.guard({ toolName: 'bash', input: { command } }), command).toMatchObject({ block: true, reason: expect.stringContaining('on:remote.invalid') });
    }
    expect(await f.mount.guard({ toolName: 'bash', input: { command: 'ssh unmanaged.invalid true' } })).toBeUndefined();
    const environment = f.mount.execution().environmentPolicy(process.env);
    expect(JSON.parse(environment.SPIDER_HERDR_SSH_DESCRIPTOR!).realSshBinary).toBe(ssh);
  } finally { await f.close(); }
}, 30000);

it('an active child without a remote job never writes a run journal', async () => {
  const f = await childFixture();
  try {
    await f.emit('session_start', { reason: 'startup' });
    const file = join(f.config.globalRoot, 'herdr/jobs/sessions', f.h.owner!.sessionId, 'runs/child-run/jobs.json');
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await f.emit('session_shutdown', { reason: 'quit' });
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.close(); }
}, 30000);

it('production child mount receives a bounded stderr error reporter', async () => {
  const f = await childFixture(), module = await import('../herdr/mount.js');
  const prior = new Set([...f.hooks.values()].flat()), mount = vi.spyOn(module, 'mountHerdr').mockReturnValue(f.mount);
  const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  Reflect.set(f.pi, 'registerCommand', () => {});
  try {
    const { default: extension } = await import('../extension.js'); extension(f.pi as never);
    const reporter = mount.mock.calls.at(-1)![1].reportError;
    expect(reporter).toBeTypeOf('function');
    reporter!(new Error('activation failed\n' + 'x'.repeat(5000)));
    const text = writes.mock.calls.map(([value]) => String(value)).join('');
    expect(text).toBe("Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine.\n"); expect(text.length).toBeLessThanOrEqual(1100);
    expect(text.trimEnd()).not.toContain('\n'); expect(text).toMatch(/\n$/);
    writes.mockClear();
    reporter!(new Error('private detail'), "This session isn't running inside Herdr, so spider's Herdr features are off here. Everything else in spider still works.");
    expect(writes.mock.calls.map(([value]) => String(value)).join('')).toBe("This session isn't running inside Herdr, so spider's Herdr features are off here. Everything else in spider still works.\n");
  } finally {
    mount.mockRestore(); writes.mockRestore();
    for (const fn of f.hooks.get('session_shutdown') ?? []) if (!prior.has(fn)) await fn({ reason: 'quit' }, f.ctx);
    await f.close();
  }
}, 30000);

it('the parent opens a child job from its run journal with session and owner checks', async () => {
  const f = await childFixture();
  const { openDbAt } = await import('@spider/db-core');
  const { RunStore } = await import('../../../subagents/src/run-store.js');
  const { createSessionIpcClient } = await import('../../../herdr/src/feed/ipc-client.js');
  const { createJobStore } = await import('../../../herdr/src/jobs/store.js');
  const { build } = await import('vite');
  const dbPath = join(f.h.root, 'runs.db'), globalPath = join(f.h.root, 'global.db'), db = openDbAt(dbPath, 'worktree'), store = new RunStore(db);
  const run = store.create({ sessionId: f.h.owner!.sessionId, agent: 'worker' }); store.start(run.id);
  let parent: ReturnType<typeof mountHerdr> | undefined, ipc: ReturnType<typeof createSessionIpcClient> | undefined;
  const hooks = new Map<string, Function[]>();
  const pi = { ...f.pi, on(name: string, fn: Function) { hooks.set(name, [...hooks.get(name) ?? [], fn]); return () => hooks.set(name, (hooks.get(name) ?? []).filter(f => f !== fn)); } };
  const ctx = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => f.h.owner!.sessionId } };
  const emit = async (name: string, event: unknown) => { for (const fn of hooks.get(name) ?? []) await fn(event, ctx); };
  try {
    vi.stubEnv('PI_SUBAGENT_RUN_ID', run.id);
    await f.emit('session_start', { reason: 'startup' });
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: "console.log('child journal output')" }, { cwd: f.h.root, ...f.mount.execution() });
    expect(result.details).toMatchObject({ stdout: 'child journal output\n', exitCode: 0 });
    await f.emit('session_shutdown', { reason: 'reload' });
    const journal = createJobStore(join(f.config.globalRoot, 'herdr/jobs'), f.h.owner!.sessionId, run.id as never), before = await readFile(journal.path, 'utf8');
    store.finish(run.id, { status: 'done', result: 'child journal output' });
    vi.stubEnv('PI_SUBAGENT_CHILD', '0');
    await build({ define: { 'import.meta.spiderHerdrRuntimeEntry': 'false' }, configFile: false, logLevel: 'silent', ssr: { noExternal: [/^@spider\//] }, build: { ssr: fileURLToPath(new URL('../../../herdr/src/bin/cli.ts', import.meta.url)), outDir: join(f.h.root, 'dist/herdr'), emptyOutDir: false, minify: false, rollupOptions: { external: [/^@earendil-works\//, 'better-sqlite3', 'sqlite-vec'], output: { entryFileNames: 'cli.mjs' } } } });
    parent = mountHerdr(pi as never, { packageRoot: f.h.root, actionContext: () => ({}), reportError: error => f.errors.push(error),
      views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
      dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }), readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } },
    });
    await emit('session_start', { reason: 'startup' });
    const feedPath = join(f.config.globalRoot, 'herdr/sessions', f.h.owner!.sessionId, 'session.json'), feed = JSON.parse(await readFile(feedPath, 'utf8'));
    ipc = createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc });
    const opened = await ipc.openJob(result.details.remote!.jobId);
    expect(opened).toMatchObject({ ok: true, op: 'openJob' });
    if (!opened.ok || opened.op !== 'openJob' || !opened.viewer) throw new Error('No child job viewer');
    expect(await f.h.hc.get(opened.viewer)).toMatchObject({ labels: { 'spider.kind': 'remote-observer', 'spider.session': f.h.owner!.sessionId, 'spider.run': run.id } });
    expect(await readFile(journal.path, 'utf8')).toBe(before);
    db.prepare('UPDATE runs SET session_id=? WHERE id=?').run('foreign-session', run.id);
    expect(await ipc.openJob(result.details.remote!.jobId)).toMatchObject({ ok: false });
    db.prepare('UPDATE runs SET session_id=? WHERE id=?').run(f.h.owner!.sessionId, run.id);
    const foreign = await journal.read(); foreign.jobs[0].owner.terminal.terminalId = 'foreign-terminal' as never; await journal.write(foreign);
    expect(await ipc.openJob(result.details.remote!.jobId)).toMatchObject({ ok: false });
    await writeFile(journal.path, before); expect(f.errors).toEqual([]);
  } finally { ipc?.dispose(); await emit('session_shutdown', { reason: 'quit' }); await parent?.dispose(); db.close(); await f.close(); }
}, 60000);

it('child presence tolerates a partial embedding context and ignores parent-mode callbacks', async () => {
  const f = await childFixture(); const { createProcessPresence } = await import('../../../herdr/src/sessions/presence.js');
  const presence = createProcessPresence(join(f.config.globalRoot, 'herdr'));
  try {
    Reflect.deleteProperty(f.ctx.sessionManager, 'getSessionFile');
    await expect(f.emit('session_start', { reason: 'startup' })).resolves.toBeUndefined();
    expect(await presence.list()).toMatchObject([{ sessionId: 'child-session', sessionFile: null, kind: 'child', mode: 'rpc', pid: process.pid }]);
    await f.emit('session_shutdown', { reason: 'quit' }); expect(await presence.list()).toEqual([]);
    vi.stubEnv('PI_SUBAGENT_CHILD', '0'); const calls = (await f.h.calls()).length;
    await expect(f.emit('session_start', { reason: 'reload' })).resolves.toBeUndefined();
    expect(await presence.list()).toEqual([]); expect((await f.h.calls()).length).toBe(calls);
  } finally { await f.close(); }
}, 30000);
