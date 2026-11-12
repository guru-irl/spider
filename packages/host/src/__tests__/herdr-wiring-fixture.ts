import { expect, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { configFixtureCwd } from './herdr-config-fixture.js';

export async function mountedFixture(mode: 'fake' | 'hc' = 'fake', sessionMode = 'tui', hasUI = true, child = false, hcOwner = true, launches = false, requested: boolean | 'auto' = true, deadSocket = false, failShortcutRegistration = false, coreAvailable = true, killAction?: (ctx: any, id: string) => Promise<unknown>, options: { automaticSubagentPanes?: boolean; admitted?: () => boolean; allowMissingFeed?: boolean } = {}): Promise<{
    h: import("@spider/herdr/__tests__/isolated").HerdrHarness;
    pi: {
        getSessionName: () => undefined;
        registerTool(tool: {
            name: string;
        }): void;
        registerShortcut(key: string): void;
        on(name: string, handler: Function): () => boolean;
        sendMessage(message: unknown): void;
    };
    hooks: Map<string, Set<Function>>;
    mount: import("../herdr/mount.js").HerdrMount;
    store: import("@spider/subagents").RunStore;
    db: import("@spider/db-core").Db;
    globalDb: import("@spider/db-core").Db;
    owner: import("@spider/herdr").Owner | null;
    ctx: {
        cwd: string;
        mode: string;
        hasUI: boolean;
        isIdle: () => boolean;
        ui: {
            notify(message: string): void;
            setStatus(key: string, text: string | undefined): void;
            setWidget(name: string, factory: unknown): void;
        };
        sessionManager: {
            getSessionId: () => import("@spider/herdr").SessionId;
            getSessionFile: () => undefined;
            getEntries: () => never[];
            getBranch: () => never[];
        };
    };
    errors: unknown[];
    opened: string[];
    notices: unknown[];
    shimDirectory: string | undefined;
    captured: string[];
    terminal: any;
    config: {
        enabled: "auto" | boolean;
        app: {
            binary: string;
            home: string;
        };
        core: {
            binary: string;
            config: string;
        };
        agentDirectory: string;
        globalRoot: string;
        shellRc: string;
        spaces: never[];
        machines: {
            name: string;
            aliases: string[];
            runtime: {
                cwd: null;
                directory: string;
                commands: {};
            };
            nodePath: string;
        }[];
        limits: {
            auxiliaryPanes: number;
            completedRows: number;
            completedHours: number;
        };
        retention: {
            foregroundDays: number;
        };
        admin: {
            wrappers: never[];
        };
    };
    feed: any;
    ipc: import("../../../herdr/src/feed/ipc-client.js").SessionIpcClient | null;
    emit: (name: string, event?: unknown) => Promise<unknown>;
    feedPath: string;
    registrations: {
        tools: string[];
        shortcuts: string[];
    };
    statusMessages: string[];
    statusValues: Map<string, string | undefined>;
    calls: () => Promise<{
        argv: string[];
    }[]>;
    presence: import("../../../herdr/src/sessions/presence.js").ProcessPresenceStore;
    close(): Promise<void>;
}> {
  const { createHerdrHarness } = await import('../../../herdr/src/__tests__/testutil.js');
  const { mountHerdr } = await import('../herdr/mount.js');
  const { createProcessPresence } = await import('../../../herdr/src/sessions/presence.js');
  const { ProcessTerminal } = await import('@earendil-works/pi-tui');
  const { openDbAt, bus } = await import('@spider/db-core');
  const { scratchDbPath } = await import('@spider/db-core/testutil');
  const { RunStore } = await import('../../../subagents/src/run-store.js');
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { createSessionIpcClient } = await import('../../../herdr/src/feed/ipc-client.js');
  const h = await createHerdrHarness(mode); await h.start();
  execFileSync('git', ['init', '-q', h.directories.local]);
  for (const [name, value] of Object.entries(h.localEnv)) if (value !== undefined && (name.startsWith('HC_') || name.startsWith('XDG_') || name.startsWith('HERDR_'))) vi.stubEnv(name, value);
  vi.stubEnv('PI_SUBAGENT_CHILD', child ? '1' : '0');
  vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
  if (!hcOwner) vi.stubEnv('HC_TERMINAL_ID', '');
  if (deadSocket) vi.stubEnv('HC_TERMINAL_SOCKET', join(h.root, 'dead.sock'));
  const dbPath = scratchDbPath('wiring-runs'), globalPath = scratchDbPath('wiring-global');
  const db = openDbAt(dbPath, 'worktree'), globalDb = openDbAt(globalPath, 'global'), store = new RunStore(db);
  const hooks = new Map<string, Set<Function>>(); const notices: unknown[] = [], opened: string[] = [], captured: string[] = [], errors: unknown[] = [];
  const terminal = Object.create(ProcessTerminal.prototype); Reflect.set(terminal, 'programStatusSupported', false); terminal.setProgramStatus({ state: 'done' });
  const statusMessages: string[] = []; const statusValues = new Map<string, string | undefined>();
  const ctx = { cwd: h.directories.local, mode: sessionMode, hasUI, isIdle: () => true, ui: { notify(message: string) { notices.push(message); }, setStatus(key: string, text: string | undefined) { statusValues.set(key, text); if (key === 'spider-herdr' && text !== undefined) statusMessages.push(text); }, setWidget(name: string, factory: unknown) { if (name === 'spider-herdr-status' && typeof factory === 'function') captured.push(name); if (typeof factory === 'function') factory({ terminal }); } }, sessionManager: { getSessionId: () => h.owner!.sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
  const registrations = { tools: [] as string[], shortcuts: [] as string[] };
  const pi = { getSessionName: () => undefined, registerTool(tool: { name: string }) { registrations.tools.push(tool.name); }, registerShortcut(key: string) { registrations.shortcuts.push(key); if (failShortcutRegistration) throw new Error('No shortcut API in this embedding'); }, on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); }, sendMessage(message: unknown) { notices.push(message); } };
  const { admitted, allowMissingFeed, ...configOptions } = options;
  const config = { ...configOptions, enabled: requested, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', aliases: ['managed.example.invalid'], runtime: { cwd: null, directory: join(h.directories.remote, 'programs'), commands: {} }, nodePath: process.execPath }], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };

  const callLog = join(h.root, 'host-hc-calls.jsonl'); await writeFile(callLog, '');
    const { chmod } = await import('node:fs/promises'); const { fileURLToPath } = await import('node:url');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const logger = join(h.root, 'argv.mjs'); await writeFile(logger, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ argv: process.argv.slice(2) }) + String.fromCharCode(10));`);
    const recorded = join(h.root, 'recorded-hc'); await writeFile(recorded, `#!/bin/sh\n${quote(process.execPath)} ${quote(logger)} "$@"\n${coreAvailable ? '' : 'if [ "$1" = server ] && [ "$2" = status ]; then printf \'%s\\n\' \'{"error":{"kind":"unavailable","message":"Fixture core is offline"}}\' >&2; exit 2; fi\n'}exec ${quote(h.hcBinary)} "$@"\n`); await chmod(recorded, 0o700); config.core.binary = recorded;
  if (launches || mode === 'hc') {
    const appScript = join(h.root, 'app-port.mjs'), parked = join(h.root, 'parked.json'); await writeFile(parked, '[]');
    await writeFile(appScript, `import { execFileSync } from 'node:child_process'; import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2), parkedPath = ${JSON.stringify(parked)};
const parked = JSON.parse(readFileSync(parkedPath, 'utf8'));
if (argv[0] === 'do') { if (argv[1] === 'terminal.park') { parked.push(argv[argv.indexOf('--terminal') + 1]); writeFileSync(parkedPath, JSON.stringify(parked)); } console.log('{}'); }
else { const core = JSON.parse(execFileSync(${JSON.stringify(h.hcBinary)}, ['ls', '--all', '--json'], { encoding: 'utf8' }));
const terminals = core.terminals.filter(t => t.state === 'live' && !t.address.includes('/') && !parked.includes(t.address)).map(t => ({ terminal: t.address, pane: 'p-' + t.address }));
console.log(JSON.stringify({ spaces: [{ id: 's1', name: 'work', tabs: [{ id: 'tb1', name: 'owner', terminals }] }] })); }
`);
    const appBinary = join(h.root, 'app-port'); await writeFile(appBinary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(appScript)} "$@"\n`); await chmod(appBinary, 0o700); config.app.binary = appBinary;
    if (launches) {
      const { build } = await import('vite');
      await build({ define: { 'import.meta.spiderHerdrRuntimeEntry': 'false' }, configFile: false, logLevel: 'silent', ssr: { noExternal: [/^@spider\//] }, build: { ssr: true, outDir: join(h.root, 'dist/herdr'), emptyOutDir: false, minify: false, rollupOptions: { input: { cli: fileURLToPath(new URL('../../../herdr/src/bin/cli.ts', import.meta.url)), 'viewer-main': fileURLToPath(new URL('../../../herdr/src/bin/viewer.ts', import.meta.url)) }, external: [/^@earendil-works\//, 'better-sqlite3', 'sqlite-vec'], output: { entryFileNames: '[name].mjs' } } } });
      const { stripTypeScriptTypes } = await import('node:module');
      const runtime = Buffer.from(stripTypeScriptTypes(await readFile(fileURLToPath(new URL('../../../herdr/src/remote/runtime.ts', import.meta.url)), 'utf8')));
      await writeFile(join(h.root, 'dist/herdr/remote-runtime.mjs'), runtime);
      if (mode === 'fake') await writeFile(join(h.root, 'dist/herdr/viewer.mjs'), `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(join(h.root, 'dist/herdr/viewer-main.mjs'))}, ...process.argv.slice(2)], { stdio: ['pipe', 'inherit', 'inherit'] });
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.once(signal, () => child.kill(signal)); child.once('exit', code => { child.stdin.destroy(); process.exit(code ?? 1); });`);
      else await writeFile(join(h.root, 'dist/herdr/viewer.mjs'), await readFile(join(h.root, 'dist/herdr/viewer-main.mjs')));
    }
  }
  const mount = mountHerdr(pi as never, { packageRoot: h.root, admitted, ...(killAction ? { killAction } : {}), readConfig: async () => config as never, actionContext: () => ({ db, globalDb, sessionId: h.owner!.sessionId, pi }), reportError: error => errors.push(error),
    views: { agents: { open: async () => { opened.push('agents'); } }, todos: { handler: async () => { opened.push('todos'); } }, usage: { handler: async () => { opened.push('usage'); } }, memory: async () => { opened.push('memory'); }, loop: { handler: async () => { opened.push('triggers'); } } },
    dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }), readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } },
  });
  const emit = async (name: string, event: unknown = {}) => { let result: unknown; for (const handler of [...hooks.get(name) ?? []]) { const next = await handler(event, ctx); if (next !== undefined) result = next; } return result; };
  await emit('session_start', { reason: 'startup' });
  const owner = mount.owner();
  const descriptor = mount.execution().environmentPolicy(process.env).SPIDER_HERDR_SSH_DESCRIPTOR;
  const shimDirectory: string | undefined = descriptor ? JSON.parse(descriptor).shimDirectory : undefined;
  const feedPath = join(config.globalRoot, 'herdr/sessions', h.owner!.sessionId, 'session.json');
  const feed = owner && !child ? JSON.parse(await readFile(feedPath, 'utf8').catch(error => {
    if (allowMissingFeed && error.code === 'ENOENT') return 'null';
    throw error;
  })) : null;
  const ipc = feed ? createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc }) : null;
  return { h, pi, hooks, mount, store, db, globalDb, owner, ctx, errors, opened, notices, shimDirectory, captured, terminal, config, feed, ipc, emit, feedPath, registrations, statusMessages, statusValues,
    calls: async () => (await readFile(callLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { argv: string[] }),
    presence: createProcessPresence(join(config.globalRoot, 'herdr')),
    async close() { ipc?.dispose(); await emit('session_shutdown', { reason: 'quit' }); await mount.dispose(); db.close(); globalDb.close(); await h.close(); },
  };
}

export async function heldObserverScenario(mode: 'fake' | 'hc', timing: 'before' | 'after'): Promise<void> {
  const f = await mountedFixture(mode, 'tui', true, false, true, true);
  const { createProductionHerdrCliPorts } = await import('../herdr/ports.js');
  const { setupHerdr } = await import('../../../herdr/src/setup/installer.js'); const { writeFile } = await import('node:fs/promises');
  const ports = configFixtureCwd(createProductionHerdrCliPorts(f.h.root, process.env), f.ctx.cwd);
  let executing: ReturnType<NonNullable<ReturnType<typeof f.mount.execution>['remote']>['execute']> | undefined;
  const finish = join(f.h.directories.remote, 'finish-observed-job');
  try {
    const request = { config: f.config as never, configPath: join(f.h.root, 'config.json'), packageRoot: f.h.root, journalRoot: join(f.config.globalRoot, 'herdr/setup') };
    await writeFile(request.configPath, JSON.stringify(f.config)); const parts = await ports.setupParts(request);
    await setupHerdr(request, { ...parts,
      preflight: async () => ({ fingerprint: 'fixture', coreIdentity: f.owner!.terminal, mods: [], targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'fixture' }], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
      cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
    });
    executing = f.mount.execution().remote!.execute({ owner: f.owner!, on: 'remote.invalid' as never, source: { kind: 'code', language: 'shell', code: `printf 'first line\\n'; while [ ! -f '${finish}' ]; do sleep 0.05; done; printf 'last line\\n'; exit 23` } });
    void executing.catch(() => {});
    let id: string | undefined;
    await vi.waitFor(async () => {
      const listed = await f.h.cli(['ls', '--all', '--json']) as { terminals: { address: string }[] };
      const terminals = await Promise.all(listed.terminals.map(row => f.h.hc.get(row.address as never)));
      id = terminals.find(row => row.labels['spider.kind'] === 'exec')?.labels['spider.job']; expect(id).toBeDefined();
    }, { timeout: 10000 });
    const { readJobJournal } = await import('../herdr/ports.js');
    await vi.waitFor(async () => {
      const job = (await readJobJournal(join(f.config.globalRoot, 'herdr/jobs'), f.owner!)).find(job => job.id === id);
      expect(job && 'address' in job.phase).toBe(true);
    }, { timeout: 10000 });
    if (timing === 'before') { await writeFile(finish, 'done'); expect(await executing).toMatchObject({ exitCode: 23, stdout: 'first line\nlast line\n' }); }
    const reply = await f.ipc!.openJob(id as never); expect(reply).toMatchObject({ ok: true, op: 'openJob' });
    if (!reply.ok || reply.op !== 'openJob') throw new Error('Observer did not open');
    if (timing === 'after') { await writeFile(finish, 'done'); expect(await executing).toMatchObject({ exitCode: 23, stdout: 'first line\nlast line\n' }); }
    await vi.waitFor(async () => {
      const text = await f.h.hc.read(reply.viewer, { lines: 100 });
      expect(text).toContain('first line'); expect(text).toContain('last line'); expect(text).toContain('Finished, exit 23.');
      expect(text).not.toContain('observer-removal-timeout');
    }, { timeout: 5000 });
    expect((await f.h.hc.get(reply.viewer)).state).toBe('live');
    const { createAppClient } = await import('../../../herdr/src/client/app.js');
    expect(await createAppClient({ binary: f.config.app.binary, env: { ...process.env } }).ownerPlacement(reply.viewer)).toMatchObject({ space: 's1', tab: 'tb1' });
    await f.h.hc.kill(reply.viewer);
    await vi.waitFor(async () => expect(await f.h.hc.get(reply.viewer)).toMatchObject({ state: 'finished', exitCode: 0 }), { timeout: 5000 });
    await f.h.hc.rm(reply.viewer); expect(f.errors).toEqual([]);
  } finally { await writeFile(finish, 'done').catch(() => {}); await ports.dispose(); await f.close(); await executing?.catch(() => {}); }
  expect(await f.h.remainingOwnedResources()).toEqual([]);
  expect(f.h.cleanupProof).toMatchObject({ remaining: [], defaultCoreUnchanged: true });
}

export function assertNoNativeNotes(calls: readonly { argv: readonly string[] }[]): {
    argv: readonly string[];
}[] {
  const runs = calls.filter(call => call.argv[0] === 'run'); expect(runs.length).toBeGreaterThan(0);
  for (const run of runs) expect(run.argv).toContain('--no-notify');
  return runs;
}

export async function launchScenario(mode: 'fake' | 'hc'): Promise<void> {
  const f = await mountedFixture(mode, 'tui', true, false, true, true);
  const { createProductionHerdrCliPorts } = await import('../herdr/ports.js');
  const { probeLaunch } = await import('../../../herdr/src/setup/doctor.js');
  const { readFile, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  const ports = configFixtureCwd(createProductionHerdrCliPorts(f.h.root, process.env), f.ctx.cwd);
  try {
    expect(f.errors).toEqual([]);
    const { existsSync } = await import('node:fs');
    expect(existsSync(f.config.machines[0].runtime.directory)).toBe(false);
    const request = { config: f.config as never, configPath: join(f.h.root, 'config.json'), packageRoot: f.h.root, journalRoot: join(f.h.directories.global, 'herdr/setup') };
    const parts = await ports.setupParts(request);
    await writeFile(request.configPath, JSON.stringify(f.config));
    const { setupHerdr } = await import('../../../herdr/src/setup/installer.js');
    const setup = await setupHerdr(request, { ...parts,
      preflight: async () => ({ fingerprint: 'fixture', coreIdentity: f.owner!.terminal, mods: [], targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'fixture' }], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
      cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
    });
    expect(setup.writes).toContain(f.config.core.config);
    const { readJournal } = await import('../../../herdr/src/setup/backup.js');
    const installed = (await readJournal(request.journalRoot)).runtimes[0];
    expect(installed.path).toMatch(/spider-remote-runtime-[a-f0-9]{16}\.mjs$/);
    expect(existsSync(f.config.machines[0].runtime.directory)).toBe(true);
    const first = await f.mount.execution().remote!.execute({ owner: f.owner!, on: 'remote.invalid' as never, source: { kind: 'code', language: 'shell', code: "printf 'bootstrap-ready'" } });
    expect(first).toMatchObject({ stdout: 'bootstrap-ready', stderr: '', exitCode: 0, outcome: 'exited' });
    const run = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker' }); f.store.start(run.id); f.store.setLaunch(run.id, { childMode: 'print' });
    const opened = await f.ipc!.openRun(run.id as never); expect(opened).toMatchObject({ ok: true, op: 'openRun' });
    // The launcher's temporary event view has closed. The pane actor and job monitor must still work.
    const result = await f.mount.execution().remote!.execute({ owner: f.owner!, on: 'remote.invalid' as never, source: { kind: 'code', language: 'shell', code: "printf 'output\\n'; printf 'diagnostic\\n' >&2; exit 23" } });
    expect(result).toMatchObject({ stdout: 'output\n', stderr: 'diagnostic\n', exitCode: 23, outcome: 'exited' });
    const view = await f.ipc!.openJob(result.remote.jobId); expect(view).toMatchObject({ ok: true, op: 'openJob' });
    expect((await f.calls()).filter(call => call.argv[0] === 'events')).toHaveLength(2);
    const doctor = await ports.doctorParts(request); const target = { machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'fixture' };
    expect(await doctor.probeMachineNode(target, probeLaunch(target))).toContain(process.version);
    const runs = assertNoNativeNotes(await f.calls());
    for (const kind of ['exec', 'remote-observer', 'subagent-viewer', 'setup-probe']) expect(runs.some(call => call.argv.includes('spider.kind=' + kind))).toBe(true);
  } finally { await ports.dispose(); await f.close(); }
  expect(await f.h.remainingOwnedResources()).toEqual([]);
  expect(f.h.localSocket).not.toContain('/default/default.sock'); expect(f.h.remoteSocket).not.toContain('/default/default.sock');
  expect(f.h.remoteSocket).not.toBe(f.h.localSocket);
  expect(f.h.cleanupProof).toMatchObject({ defaultCoreUnchanged: true, remaining: [] });
  await writeFile(resolve(`.spider/scratch/herdr-host-proof-${mode}.json`), JSON.stringify({ localSocket: f.h.localSocket, remoteSocket: f.h.remoteSocket, appHome: f.config.app.home, appBinary: f.config.app.binary, appTests: process.env.SPIDER_HERDR_APP_TESTS ?? null, cleanup: f.h.cleanupProof }, null, 2));
}

export async function installFixtureRuntime(f: Awaited<ReturnType<typeof mountedFixture>>): Promise<void> {
  const { createProductionHerdrCliPorts } = await import('../herdr/ports.js');
  const { setupHerdr } = await import('../../../herdr/src/setup/installer.js');
  const { readJournal } = await import('../../../herdr/src/setup/backup.js');
  const { writeFile } = await import('node:fs/promises');
  const ports = configFixtureCwd(createProductionHerdrCliPorts(f.h.root, process.env), f.ctx.cwd);
  try {
    const configPath = join(f.h.root, 'config.json');
    await writeFile(configPath, JSON.stringify(f.config));
    const request = await ports.request(configPath);
    const parts = await ports.setupParts(request);
    await setupHerdr(request, { ...parts,
      preflight: async () => ({ fingerprint: 'fixture', coreIdentity: f.owner!.terminal, mods: [], targets: [{ machine: 'remote.invalid' as never, nodePath: f.config.machines[0].nodePath, coreStartedAt: 'fixture' }], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
      cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
    });
    const installed = (await readJournal(request.journalRoot)).runtimes[0];
    expect(installed.path).toMatch(/spider-remote-runtime-[a-f0-9]{16}\.mjs$/);
    expect((await f.h.hc.fileRead('remote.invalid' as never, installed.path)).length).toBeGreaterThan(0);
  } finally { await ports.dispose(); }
}

export async function closePaneScenario(mode: 'fake' | 'hc', pane: 'observer' | 'console'): Promise<void> {
  const f = await mountedFixture(mode, 'tui', true, false, true, true);
  const { writeFile, access } = await import('node:fs/promises');
  const gate = join(f.h.directories.remote, 'finish-payload');
  const started = join(f.h.directories.remote, 'payload-started');
  const installed = installFixtureRuntime(f);
  const executing = (async () => {
    await installed;
    return f.mount.execution().remote!.execute({ owner: f.owner!, on: 'remote.invalid' as never,
      source: { kind: 'code', language: 'shell', code: `printf 'started\\n'; printf yes > '${started}'; while [ ! -f '${gate}' ]; do sleep 0.05; done; printf 'completed\\n'; exit 23` } });
  })();
  void executing.catch(() => {});
  const inventory = async () => {
    const listed = await f.h.cli(['ls', '--all', '--json']) as { terminals: { address: string }[] };
    return Promise.all(listed.terminals.map(t => f.h.hc.get(t.address as never)));
  };
  try {
    await installed;
    let target: { address: string; labels: Readonly<Record<string, string>> } | undefined;
    await vi.waitFor(async () => {
      target = (await inventory()).find(t => t.labels['spider.kind'] === (pane === 'console' ? 'remote-console' : 'exec'));
      expect(target).toBeDefined();
    }, { timeout: 10000 });
    await vi.waitFor(() => access(started), { timeout: 10000 });
    const original = (await inventory()).find(t => t.labels['spider.kind'] === 'exec')!;
    expect((await f.h.hc.get(original.address as never)).state).toBe('live');
    const id = (pane === 'console' ? `console:${target!.address}` : target!.labels['spider.job']) as never;
    const opened = await f.ipc!.openJob(id);
    expect(opened).toMatchObject({ ok: true, op: 'openJob' });
    if (!opened.ok || opened.op !== 'openJob') throw new Error('Observer did not open');
    const viewer = await f.h.hc.get(opened.viewer);
    expect(viewer.labels).toMatchObject({ 'spider.kind': 'remote-observer', 'spider.machine': 'remote.invalid' });
    expect(viewer.parent).toBeNull();
    // The readiness marker can precede attach; exercise closure only after output is visible.
    await vi.waitFor(async () => expect(await f.h.hc.read(opened.viewer, { lines: 100 })).toContain('started'), { timeout: 10000 });
    await f.h.hc.kill(opened.viewer);
    await vi.waitFor(async () => expect((await f.h.hc.get(opened.viewer)).state).toBe('finished'), { timeout: 5000 });
    await f.h.hc.rm(opened.viewer);
    expect((await f.h.hc.get(target!.address as never)).state).toBe('live');
    expect((await f.h.hc.get(original.address as never)).state).toBe('live');
    expect((await f.calls()).filter(c => c.argv[0] === 'kill' && c.argv[1] === original.address)).toEqual([]);
    await writeFile(gate, 'finish');
    expect(await executing).toMatchObject({ outcome: 'exited', exitCode: 23, stdout: 'started\ncompleted\n' });
  } finally { await writeFile(gate, 'finish').catch(() => {}); await f.close(); await executing.catch(() => {}); }
  expect(await f.h.remainingOwnedResources()).toEqual([]);
  expect(f.h.cleanupProof).toMatchObject({ remaining: [], defaultCoreUnchanged: true });
}
