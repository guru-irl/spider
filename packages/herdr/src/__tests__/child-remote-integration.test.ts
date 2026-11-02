// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { startTerminalChild, type TerminalChild } from './child-remote-process.js';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { build } from 'vite';
import { createHerdrHarness, createClientFixture } from './testutil.js';
import { createJobMonitor, type JobMonitor, type JobNotice } from '../jobs/monitor.js';
import { createHostHerdrPorts, createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { createJobStore } from '../jobs/store.js';
import { createJobHandoff, processStartIdentity } from '../jobs/handoff.js';
import type { HcClient, Owner, JobId, TerminalAddress, TerminalSummary } from '../contracts.js';
import { setupHerdr, runtimeInstallPath, standardHerdrConfigPath } from '../setup/installer.js';
import type { HerdrConfig, RunId } from '../contracts.js';

async function scenario(mode: 'fake' | 'hc', legacyChildPolicy = false) {
  const h = await createHerdrHarness(mode); let monitor: JobMonitor | undefined;
  let child: TerminalChild | undefined;
  let output: ReturnType<typeof createHostHerdrPorts> | undefined;
  try {
    await h.start();
    const config: HerdrConfig = { enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid' as never, aliases: ['managed.invalid'], runtime: { cwd: h.directories.remote, directory: join(h.directories.remote, 'programs'), commands: {} }, nodePath: process.execPath }], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
    const configPath = standardHerdrConfigPath(config.globalRoot);
    const dist = join(h.root, 'dist/herdr'); await mkdir(dist, { recursive: true });
    await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: [/^@spider\//] }, build: { ssr: fileURLToPath(new URL('./child-remote-entry.ts', import.meta.url)), outDir: dist, emptyOutDir: false, minify: false, rollupOptions: { external: [/^@earendil-works\//, 'better-sqlite3', 'sqlite-vec'], output: { entryFileNames: 'child.mjs' } } } });
    if (legacyChildPolicy) {
      const bundlePath = join(dist, 'child.mjs'), bundle = await readFile(bundlePath, 'utf8');
      const childHook = /if\s*\(process\.env\.PI_SUBAGENT_CHILD\s*===\s*["']1["']\)\s*return mountChildHerdr\([^;]+\);/g;
      // Round 4 removed the dead parent child guard. Restore it in this isolated
      // mutant as well as removing delegation, so it still models missing policy.
      const parentActivation = /if\s*\(!process\.env\.HC_TERMINAL_ID\)\s*\{\s*disabled\(["']not inside Herdr["']\);/g;
      expect([bundle.match(childHook)?.length, bundle.match(parentActivation)?.length]).toEqual([1, 1]);
      await writeFile(bundlePath, bundle.replace(childHook, '').replace(parentActivation, match => `if (process.env.PI_SUBAGENT_CHILD === '1') return; ${match}`));
    }
    const runtime = Buffer.from(stripTypeScriptTypes(await readFile(fileURLToPath(new URL('../remote/runtime.ts', import.meta.url)), 'utf8')));
    await writeFile(join(dist, 'remote-runtime.mjs'), runtime);
    execFileSync('git', ['init', '-q', h.root]);
    const request = { config, configPath, packageRoot: h.root, journalRoot: join(config.globalRoot, 'herdr/setup') };
    const installer = createProductionHerdrCliPorts(h.root, h.localEnv), parts = await installer.setupParts(request);
    try {
      await setupHerdr(request, { ...parts,
        preflight: async () => ({ fingerprint: 'child-fixture', coreIdentity: await h.hc.identity(), mods: [], targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'fixture' }], retiredTerminals: [], layoutExport: true }),
        stageLook: async () => [], installFiles: async () => [{ path: configPath, bytes: Buffer.from(JSON.stringify(config)), expected: null }], generateTemplates: async () => [], installResume: async () => [],
        cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [] } as never),
      });
    } finally { await installer.dispose(); }
    output = createHostHerdrPorts({ hc: h.hc, config, runtimeBytes: runtime, runtimePath: () => runtimeInstallPath(config.machines[0].runtime.directory, runtime) });
    const setupCallCount = mode === 'fake' ? (await h.calls()).length : 0;
    const notices: JobNotice[] = [], errors: unknown[] = [];
    const parentMonitor = () => createJobMonitor({ hc: h.hc, clock: Date.now, journalRoot: join(config.globalRoot, 'herdr/jobs'), outputCollector: output!.outputCollector, observedJobMessages: async () => [], notifier: notice => { notices.push(notice); }, reportError: error => errors.push(error) });
    monitor = parentMonitor();
    const messages: any[] = [], waiters: { predicate: (message: any) => boolean; resolve: (message: any) => void }[] = [];
    let stderr = '';
    child = await startTerminalChild(h, join(dist, 'child.mjs'), { ...h.localEnv, PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'child-run', PI_SUBAGENT_RUN_NAME: 'worker', PI_SPIDER_SESSION_ID: h.owner!.sessionId, PI_SPIDER_TOP_SESSION_ID: h.owner!.sessionId, SPIDER_GLOBAL_ROOT: config.globalRoot, SPIDER_CHILD_FIXTURE_CONFIG: configPath, SPIDER_CHILD_FIXTURE_CWD: h.root, SPIDER_CHILD_FIXTURE_PACKAGE: h.root });
    await monitor.activate(h.owner!);
    child.stderr!.on('data', bytes => { stderr += bytes; });
    createInterface({ input: child.stdout! }).on('line', line => { const message = JSON.parse(line); messages.push(message); for (const waiter of [...waiters]) if (waiter.predicate(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); } });
    const message = (predicate: (message: any) => boolean) => {
      const existing = messages.find(predicate); if (existing) return Promise.resolve(existing);
      return new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Child message timeout: ${stderr}`)), 15000); waiters.push({ predicate, resolve: result => { clearTimeout(timer); resolve(result); } }); });
    };
    const exit = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    await message(m => m.type === 'ready');
    child.stdin!.write(JSON.stringify({ id: 'local-shell', action: 'exec', language: 'shell', code: 'printf shell-ok' }) + '\n');
    const shell = await message(m => m.id === 'local-shell');
    expect(shell.type, shell.reason ?? shell.error).toBe('result'); expect(shell.result.details.stdout).toBe('shell-ok');
    child.stdin!.write(JSON.stringify({ id: 'plain-bash', action: 'bash', command: 'printf bash-ok' }) + '\n');
    const bash = await message(m => m.id === 'plain-bash'); expect(bash.type, bash.reason ?? bash.error).toBe('result'); expect(JSON.stringify(bash.result.content)).toContain('bash-ok');
    child.stdin!.write(JSON.stringify({ id: 'foreground', action: 'exec', on: 'remote.invalid', language: 'javascript', code: "console.log('returned to child');console.error('child diagnostic');process.exitCode=23" }) + '\n');
    const foreground = await message(m => m.id === 'foreground');
    if (legacyChildPolicy) { expect(foreground).toMatchObject({ type: 'refused', reason: expect.stringContaining('herdr-disabled') }); return; }
    expect(foreground.type, foreground.error).toBe('result'); expect(foreground.result.details).toMatchObject({ stdout: 'returned to child\n', stderr: 'child diagnostic\n', exitCode: 23 });
    child.stdin!.write(JSON.stringify({ id: 'managed-ssh', action: 'bash', command: '/usr/bin/ssh managed.invalid' }) + '\n');
    const ssh = await message(m => m.id === 'managed-ssh'); expect(ssh).toMatchObject({ type: 'refused', reason: expect.stringContaining('on:remote.invalid') });
    const terminal = await h.hc.get(foreground.result.details.remote.address);
    expect(terminal.labels).toMatchObject({ 'spider.session': h.owner!.sessionId, 'spider.owner-terminal': h.owner!.terminal.terminalId, 'spider.run': 'child-run', 'spider.kind': 'exec' });
    const journal = await createJobStore(join(config.globalRoot, 'herdr/jobs'), h.owner!.sessionId, 'child-run' as RunId).read();
    expect(journal.child?.pid).toBe(child.pid); expect(journal.jobs[0].viewer).toBeNull(); expect(journal.jobs[0].notice).toBe('observed');
    child.stdin!.write(JSON.stringify({ id: 'background', action: 'exec', on: 'remote.invalid', language: 'javascript', background: true, timeout: 100, code: "setTimeout(()=>{console.log('survived child');process.exitCode=29},2500)" }) + '\n');
    const background = await message(m => m.id === 'background');
    expect(background.type, background.error).toBe('result'); expect(background.result.details).toMatchObject({ backgrounded: true, exitCode: null });
    expect(await h.hc.get(background.result.details.remote.address)).toMatchObject({ state: 'live' });
    const remoteRows = (await h.cli(['ls', '--all', '--json'], 'remote') as { terminals: { address: string }[] }).terminals;
    const remoteTerminals = await Promise.all(remoteRows.map(row => h.remoteHc.get(row.address as import('../contracts.js').TerminalAddress)));
    const consoles = remoteTerminals.filter(row => row.labels['spider.kind'] === 'remote-console'); expect(consoles).toHaveLength(1);
    const consoleAddress = `remote.invalid/${consoles[0].address}` as import('../contracts.js').TerminalAddress;
    // A parent reload must leave a live child writer and its payload untouched.
    await monitor.shutdown('reload'); monitor = parentMonitor(); await monitor.activate({ ...h.owner!, generation: 'reloaded-parent' as never });
    expect(notices).toEqual([]); child.kill('SIGKILL'); await exit; await monitor.reconcile();
    await expect(h.hc.get(consoleAddress)).rejects.toMatchObject({ code: 'not_found' });
    const done = new Promise<void>((resolve, reject) => { const deadline = Date.now() + 15000; const timer = setInterval(() => { void monitor!.reconcile().then(() => { if (notices.length) { clearInterval(timer); resolve(); } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Handoff completion timeout')); } }, error => { clearInterval(timer); reject(error); }); }, 100); });
    await done; await monitor.reconcile();
    expect(notices.map(n => ({ runId: n.details.runId, jobId: n.details.jobId, exitCode: n.details.exitCode }))).toEqual([{ runId: 'child-run', jobId: background.result.details.remote.jobId, exitCode: 29 }]);
    expect(await readFile(join(background.result.details.backgroundJob.dir, 'stdout.log'), 'utf8')).toBe('survived child\n');
    const adopted = (await createJobStore(join(config.globalRoot, 'herdr/jobs'), h.owner!.sessionId, 'child-run' as RunId).read()).jobs.find(job => job.id === background.result.details.remote.jobId)!;
    expect(adopted).toMatchObject({ settledMarked: true, notice: 'submitted', noticeDelivered: true });
    const runStore = createJobStore(join(config.globalRoot, 'herdr/jobs'), h.owner!.sessionId, 'child-run' as RunId);
    expect((await runStore.read()).child).toMatchObject({ ended: true, settled: true });
    const before = await readFile(runStore.path, 'utf8'); await monitor.reconcile();
    expect(await readFile(runStore.path, 'utf8')).toBe(before);
    expect(JSON.parse((await h.hc.fileRead('remote.invalid' as never, join(adopted.remoteDirectory, '.spider-settled'))).toString()).jobId).toBe(adopted.id);
    await monitor.shutdown('reload'); monitor = parentMonitor(); await monitor.activate(h.owner!); await monitor.reconcile(); expect(notices).toHaveLength(1);
    if (mode === 'fake') {
      const calls = (await h.calls()).slice(setupCallCount).filter(call => call.argv[0] === 'run' && call.argv.includes('--on'));
      const labels = calls.map(call => Object.fromEntries(call.argv.flatMap((arg, index) => arg === '--label' ? [call.argv[index + 1]!.split('=', 2)] : [])));
      expect(labels.map(label => [label['spider.kind'], label['spider.job'] ?? null])).toEqual([
        ['remote-console', null], ['exec', foreground.result.details.remote.jobId], ['exec', background.result.details.remote.jobId],
      ]);
      for (const label of labels) expect(label).toMatchObject({ 'spider.session': h.owner!.sessionId, 'spider.owner-core': h.owner!.terminal.coreId, 'spider.owner-terminal': h.owner!.terminal.terminalId, 'spider.machine': 'remote.invalid', 'spider.run': 'child-run' });
      const consoleCall = calls[0];
      const metadata = JSON.parse(JSON.parse((await h.hc.fileRead('remote.invalid' as never, join(consoleCall.argv[consoleCall.argv.indexOf('--console') + 1]!, 'console.json'))).toString()).body);
      expect(metadata.title).toBe('worker · remote.invalid');
      expect(calls.every(call => call.env.PI_SUBAGENT_CHILD === '1' && call.env.PI_SUBAGENT_RUN_ID === 'child-run' && Reflect.get(call, 'parentPid') === child!.pid && call.argv.includes('--no-notify'))).toBe(true);
      expect(await readFile(join(h.directories.local, 'app-calls.jsonl'), 'utf8')).toBe('');
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill('SIGKILL'); await closed; }
    await monitor?.shutdown('reload'); output?.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
  }
}
it('the real-child regression detects the legacy missing-policy branch in an isolated compiled artifact', async () => { await scenario('fake', true); }, 45000);
it('real Node child runs direct exec against fake hc and hands off a background job after SIGKILL', async () => { await scenario('fake'); }, 45000);
const hcAvailable = await access(process.env.SPIDER_HERDR_HC_BINARY ?? join(homedir(), '.local/bin/hc')).then(() => true, () => false);
it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !hcAvailable)('real Node child runs on an isolated hc fake remote and parent posts one notice after child exit (requires SPIDER_HERDR_E2E=1 and hc; no app window)', async () => { await scenario('hc'); }, 45000);

it('handoff releases a settled run monitor and never re-adopts it after reload', async () => {
  const f = await createClientFixture();
  const owner = { sessionId: 'owner', generation: 'g1', terminal: { coreId: 'core', terminalId: 't-owner', address: 't-owner', socket: f.localSocket, sessionNamespace: 'fl' }, cwd: f.root, sessionFile: null, name: null } as Owner;
  const runId = 'ended-run' as RunId, store = createJobStore(f.root, owner.sessionId, runId);
  const finish = { exitCode: 0, reason: 'exited', signal: null, finishedAt: 1000 };
  const journal = await store.read();
  journal.child = { id: runId, pid: process.pid, startIdentity: 'ended', ended: true };
  journal.jobs = [{ version: 1, id: 'job' as JobId, runId, owner, machine: 'remote.invalid' as never, kind: 'exec', phase: { kind: 'finished', address: 'remote.invalid/t1' as TerminalAddress, result: finish }, viewer: null, localDirectory: join(store.directory, 'logs/job'), remoteDirectory: join(f.root, 'program'), detached: true, noticeMode: 'async', notice: 'pending', nonce: 'nonce', releaseDeadlineAt: 10000, originalFinish: finish, output: { complete: true, summary: 'done' }, callerOwned: true, uncertain: false, evidenceConflict: false, noticeDelivered: false, settledMarked: false, terminalExpired: false, updatedAt: 1000 }];
  await store.write(journal);
  const adopted: string[] = [], stopped: string[] = [], consoles: string[] = [];
  const options = { root: f.root, owner, hc: {} as HcClient,
    closeAgentConsoles: async (o: Owner & { runId: RunId }) => { consoles.push(o.runId); },
    adopt: async (id: RunId) => { adopted.push(id); return {
      reconcile: async () => { const j = await store.read(); j.jobs[0].settledMarked = true; j.jobs[0].noticeDelivered = true; j.jobs[0].notice = 'observed'; await store.write(j); },
      shutdown: async (reason: 'quit' | 'reload') => { stopped.push(reason); },
    }; },
  };
  const handoff = createJobHandoff(options);
  try {
    await handoff.reconcile(); expect(stopped).toEqual(['reload']);
    expect((await store.read()).child).toMatchObject({ settled: true });
    const bytes = await readFile(store.path, 'utf8'); await handoff.reconcile();
    expect(await readFile(store.path, 'utf8')).toBe(bytes);
    await handoff.shutdown('reload'); const reloaded = createJobHandoff(options); await reloaded.reconcile(); await reloaded.shutdown('reload');
    expect(adopted).toEqual([runId]); expect(consoles).toEqual([runId]); expect(stopped).toEqual(['reload']);
  } finally { await handoff.shutdown('reload'); await f.close(); }
});

it('an adopted monitor uses no periodic timer and leaves unchanged journal bytes intact', async () => {
  const f = await createClientFixture();
  const owner = { sessionId: 'owner', generation: 'g1', terminal: { coreId: 'core', terminalId: 't-owner', address: 't-owner', socket: f.localSocket, sessionNamespace: 'fl' }, cwd: f.root, sessionFile: null, name: null } as Owner;
  const runId = 'ended-run' as RunId, store = createJobStore(f.root, owner.sessionId, runId), journal = await store.read();
  journal.child = { id: runId, pid: process.pid, startIdentity: 'ended', ended: true }; await store.write(journal);
  let disposed = false;
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected hc call for settled jobs'); };
  const hc: HcClient = { identity: async () => owner.terminal, caller: async () => owner.terminal, machines: async () => [], run: unexpected, get: unexpected, read: unexpected, kill: unexpected, rm: unexpected, fileRead: unexpected, fileWrite: unexpected, setLabels: unexpected, events: () => ({ ready: Promise.resolve(), lookup: async () => null, subscribe: () => () => {}, dispose: async () => { disposed = true; } }) };
  const monitor = createJobMonitor({ hc, adoptedRunId: runId, journalRoot: f.root, clock: () => 1000, observedJobMessages: async () => [], notifier: () => {}, outputCollector: { prepare: async () => { throw new Error('no launch'); }, collect: async () => { throw new Error('no jobs'); } } });
  vi.useFakeTimers();
  try {
    await monitor.activate(owner); expect(vi.getTimerCount()).toBe(0);
    const before = await readFile(store.path, 'utf8'); await monitor.reconcile(); await monitor.reconcile();
    expect(await readFile(store.path, 'utf8')).toBe(before);
    await monitor.shutdown('reload'); expect(disposed).toBe(true);
  } finally { await monitor.shutdown('reload'); vi.useRealTimers(); await f.close(); }
});

it.each(['activation', 'periodic'] as const)('an unreachable ended child discovered at %s does not delay launches or a settled sibling', async trigger => {
  const f = await createClientFixture();
  const owner = { sessionId: 'owner', generation: 'g1', terminal: { coreId: 'core', terminalId: 't-owner', address: 't-owner', socket: f.localSocket, sessionNamespace: 'fl' }, cwd: f.root, sessionFile: null, name: null } as Owner;
  const terminals = new Map<TerminalAddress, TerminalSummary>(); let launches = 0, blocked = false;
  let unblock!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; }), stuckEntered = new Promise<void>(resolve => { entered = resolve; });
  const hc: HcClient = { identity: async () => owner.terminal, caller: async () => owner.terminal, machines: async () => [], setLabels: async () => {},
    events: () => ({ ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null, subscribe: () => () => {}, dispose: async () => {} }),
    run: async request => { const address = `${request.on}/t${++launches}` as TerminalAddress; terminals.set(address, { address, parent: owner.terminal.address, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null }); return { address, coreId: 'remote' as never }; },
    get: async address => { const row = terminals.get(address); if (!row) throw Object.assign(new Error('missing'), { code: 'not_found' }); return row; }, read: async () => '', kill: async () => {}, rm: async () => {}, fileRead: async () => Buffer.alloc(0), fileWrite: async () => {},
  };
  const finish = { exitCode: 0, reason: 'exited', signal: null, finishedAt: Date.now() };
  const options = { hc, journalRoot: f.root, clock: Date.now, observedJobMessages: async () => [], notifier: () => {},
    closeAgentConsoles: async (child: Owner & { runId: RunId }) => { if (trigger === 'periodic' && blocked && child.runId === 'a-stuck') { entered(); await barrier; } },
    outputCollector: { prepare: async (program: import('../contracts.js').PreparedProgram, job: import('../contracts.js').JobRecord) => ({ program: { ...program, directory: join(f.root, 'programs', job.id) }, nonce: 'nonce', releaseDeadlineAt: Date.now() + 10000 }),
      collect: async (job: import('../contracts.js').JobRecord) => { if (trigger === 'activation' && blocked && job.machine === 'stuck.invalid') { entered(); await barrier; } const done = 'address' in job.phase && terminals.get(job.phase.address)?.state === 'finished'; return { complete: done, summary: done ? 'done' : '', receipt: done ? { jobId: job.id, nonce: 'nonce', finish } : null }; },
    },
  };
  const children = ['a-stuck', 'b-healthy'].map(id => createJobMonitor({ ...options, child: { id: id as RunId, pid: process.pid, startIdentity: processStartIdentity(process.pid)! } })), parent = createJobMonitor(options);
  let activation: Promise<void> | undefined, starting: ReturnType<JobMonitor['start']> | undefined;
  const within = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    const program = { directory: join(f.root, 'program'), argv: ['node'], files: [], cwd: null, env: {} };
    if (trigger === 'periodic') await parent.activate(owner);
    const stuck = await children[0].start(program, owner, 'stuck.invalid' as never, { background: true }); await children[0].detach(stuck.id);
    const healthy = await children[1].start(program, owner, 'healthy.invalid' as never, { background: true }); await children[1].detach(healthy.id);
    for (const child of children) await child.shutdown('quit');
    Object.assign(terminals.get(healthy.address)!, { state: 'finished', ...finish }); blocked = true;
    if (trigger === 'activation') { activation = parent.activate(owner); void activation.catch(() => {}); }
    // In the periodic case no explicit reconcile may discover the ended runs.
    await within(stuckEntered, 6000, 'Ended-run check did not reach the stuck child');
    starting = parent.start(program, owner, 'healthy.invalid' as never, { background: true });
    const launched = await within(starting, trigger === 'periodic' ? 5000 : 1000, 'New remote launch waited behind an unreachable child');
    expect(launched.address).toBe('healthy.invalid/t3');
    const healthyStore = createJobStore(f.root, owner.sessionId, 'b-healthy' as RunId);
    await expect.poll(async () => (await healthyStore.read()).child?.settled, { timeout: 2000 }).toBe(true);
  } finally { unblock(); await activation?.catch(() => {}); await starting?.catch(() => {}); await parent.shutdown('reload'); for (const child of children) await child.shutdown('reload'); await f.close(); }
}, 15000);
