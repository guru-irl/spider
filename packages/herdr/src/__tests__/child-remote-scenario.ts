// SPDX-License-Identifier: MIT
import { buildRuntimeArtifact } from './runtime-artifact.js';
import { expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { startTerminalChild, type TerminalChild } from './child-remote-process.js';
import { writeFixturePaneEndpoint } from './endpoint-fixture.js';
import { openRetainedConsole } from './console-view-fixture.js';
import { readRetainedAgentConsole, type AgentConsoleLaunch } from '../remote/console.js';
import { sha256 } from '../remote/runtime.js';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createHerdrHarness, terminal as fixtureTerminal } from './testutil.js';
import { createJobMonitor, type JobMonitor, type JobNotice } from '../jobs/monitor.js';
import { createHostHerdrPorts, createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { createJobStore } from '../jobs/store.js';
import type { JobId, TerminalAddress, HerdrConfig, RunId } from '../contracts.js';
import { setupHerdr, runtimeInstallPath, standardHerdrConfigPath } from '../setup/installer.js';

export async function scenario(mode: 'fake' | 'hc', legacyChildPolicy = false, largeSnapshot = false, monitorFailure = false): Promise<void> {
  const h = await createHerdrHarness(mode); let monitor: JobMonitor | undefined;
  let child: TerminalChild | undefined;
  let output: ReturnType<typeof createHostHerdrPorts> | undefined;
  try {
    await h.start();
    const config: HerdrConfig = { enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid' as never, aliases: ['managed.invalid'], runtime: { cwd: h.directories.remote, directory: join(h.directories.remote, 'programs'), commands: {} }, nodePath: process.execPath }], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
    const configPath = standardHerdrConfigPath(config.globalRoot);
    const dist = join(h.root, 'dist/herdr'); await mkdir(dist, { recursive: true });
    await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.spiderPaneEndpointEntry': 'false' }, ssr: { noExternal: [/^@spider\//] }, build: { ssr: fileURLToPath(new URL('./child-remote-entry.ts', import.meta.url)), outDir: dist, emptyOutDir: false, minify: false, rollupOptions: { external: [/^@earendil-works\//, 'better-sqlite3', 'sqlite-vec'], output: { entryFileNames: 'child.mjs' } } } });
    if (legacyChildPolicy) {
      const bundlePath = join(dist, 'child.mjs'), bundle = await readFile(bundlePath, 'utf8');
      const childHook = /if\s*\(process\.env\.PI_SUBAGENT_CHILD\s*===\s*["']1["']\)\s*return mountChildHerdr\([^;]+\);/g;
      // Round 4 removed the dead parent child guard. Restore it in this isolated
      // mutant as well as removing delegation, so it still models missing policy.
      const parentActivation = /if\s*\(!process\.env\.HC_TERMINAL_ID\)\s*\{\s*disabled\(["']outside["']\);/g;
      expect([bundle.match(childHook)?.length, bundle.match(parentActivation)?.length]).toEqual([1, 1]);
      await writeFile(bundlePath, bundle.replace(childHook, '').replace(parentActivation, match => `if (process.env.PI_SUBAGENT_CHILD === '1') return; ${match}`));
    }
    const runtime = await buildRuntimeArtifact();
    await writeFile(join(dist, 'remote-runtime.mjs'), runtime);
    await writeFixturePaneEndpoint(h.root);
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
    if (largeSnapshot) {
      const existing = (await h.cli(['ls', '--all', '--json']) as { terminals: unknown[] }).terminals;
      const terminals = [...existing, ...Array.from({ length: 8000 }, (_, i) => fixtureTerminal(`large-${i}`))];
      expect(Buffer.byteLength(JSON.stringify({ terminals }))).toBeGreaterThan(1024 * 1024);
      await h.emitCore({ type: 'snapshot', seq: 10000, terminals });
    }
    const setupCallCount = mode === 'fake' ? (await h.calls()).length : 0;
    const notices: JobNotice[] = [], errors: unknown[] = [], observed: JobId[] = [];
    const parentMonitor = () => createJobMonitor({ hc: h.hc, clock: Date.now, journalRoot: join(config.globalRoot, 'herdr/jobs'), outputCollector: output!.outputCollector, observedJobMessages: async () => observed, notifier: notice => { notices.push(notice); }, reportError: error => errors.push(error) });
    monitor = parentMonitor();
    const messages: any[] = [], waiters: { predicate: (message: any) => boolean; resolve: (message: any) => void }[] = [];
    let stderr = '';
    if (monitorFailure) {
      await monitor.activate(h.owner!);
      await h.scenario({ steps: [{ argvPrefix: ['events'], reply: { seq: 'invalid', terminals: [] } }] });
    }
    child = await startTerminalChild(h, join(dist, 'child.mjs'), { ...h.localEnv, PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'child-run', PI_SUBAGENT_RUN_NAME: 'worker', PI_SPIDER_SESSION_ID: h.owner!.sessionId, PI_SPIDER_TOP_SESSION_ID: h.owner!.sessionId, SPIDER_GLOBAL_ROOT: config.globalRoot, SPIDER_CHILD_FIXTURE_CONFIG: configPath, SPIDER_CHILD_FIXTURE_CWD: h.root, SPIDER_CHILD_FIXTURE_PACKAGE: h.root });
    if (!monitorFailure) await monitor.activate(h.owner!);
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
    if (monitorFailure) {
      expect(foreground).toMatchObject({ type: 'refused', reason: expect.stringMatching(/Remote execution is unavailable in this subagent.*job monitor failed because a reply could not be read/) });
      return;
    }
    if (legacyChildPolicy) { expect(foreground).toMatchObject({ type: 'refused', reason: expect.stringContaining('Herdr is off in this session') }); return; }
    expect(foreground.type, foreground.error).toBe('result'); expect(foreground.result.details).toMatchObject({ stdout: 'returned to child\n', stderr: 'child diagnostic\n', exitCode: 23 });
    child.stdin!.write(JSON.stringify({ id: 'managed-ssh', action: 'bash', command: '/usr/bin/ssh managed.invalid' }) + '\n');
    const ssh = await message(m => m.id === 'managed-ssh'); expect(ssh).toMatchObject({ type: 'refused', reason: expect.stringContaining('on:remote.invalid') });
    const childStore = createJobStore(join(config.globalRoot, 'herdr/jobs'), h.owner!.sessionId, 'child-run' as RunId);
    await expect.poll(async () => (await childStore.read()).jobs[0]?.terminalReleased, { timeout: 7000 }).toBe(true);
    await expect(h.hc.get(foreground.result.details.remote.address)).rejects.toMatchObject({ code: 'not_found' });
    const journal = await createJobStore(join(config.globalRoot, 'herdr/jobs'), h.owner!.sessionId, 'child-run' as RunId).read();
    expect(journal.jobs[0]).toMatchObject({ owner: { sessionId: h.owner!.sessionId, terminal: { terminalId: h.owner!.terminal.terminalId } }, runId: 'child-run', kind: 'exec', terminalReleased: true });
    expect(journal.child?.pid).toBe(child.pid); expect(journal.jobs[0].viewer).toBeNull(); expect(journal.jobs[0].notice).toBe('observed');
    child.stdin!.write(JSON.stringify({ id: 'background', action: 'exec', on: 'remote.invalid', language: 'javascript', background: true, timeout: 100, code: "setTimeout(()=>{console.log('survived child');process.exitCode=29},2500)" }) + '\n');
    const background = await message(m => m.id === 'background');
    expect(background.type, background.error).toBe('result'); expect(background.result.details).toMatchObject({ backgrounded: true, exitCode: null });
    expect(await h.hc.get(background.result.details.remote.address)).toMatchObject({ state: 'live' });
    const remoteRows = (await h.cli(['ls', '--all', '--json'], 'remote') as { terminals: { address: string }[] }).terminals;
    const remoteTerminals = await Promise.all(remoteRows.map(row => h.remoteHc.get(row.address as import('../contracts.js').TerminalAddress)));
    const consoles = remoteTerminals.filter(row => row.labels['spider.kind'] === 'remote-console'); expect(consoles).toHaveLength(0);
    const on = 'remote.invalid' as import('../contracts.js').MachineName;
    const consoleRequest: AgentConsoleLaunch = { owner: h.owner!, on,
      target: { ...config.machines[0].runtime, on, environment: {}, nodePath: process.execPath, runtimePath: runtimeInstallPath(config.machines[0].runtime.directory, runtime), runtimeSha256: sha256(runtime) },
      source: { kind: 'code', language: 'javascript', code: 'explicit console view' } };
    const consoleEnv = { ...h.localEnv, HC_TERMINAL_ID: h.owner!.terminal.terminalId, PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'child-run', PI_SUBAGENT_RUN_NAME: 'worker' };
    const retained = await readRetainedAgentConsole(consoleRequest, h.hc, consoleEnv); expect(retained).not.toBeNull();
    const view = await openRetainedConsole(consoleRequest, h.hc, consoleEnv); expect(view).not.toBeNull();
    expect(view!.consoleId).toBe(retained!.consoleId);
    const consoleAddress = view!.address;
    expect((await h.hc.get(consoleAddress)).labels).toMatchObject({ 'spider.kind': 'remote-console', 'spider.session': h.owner!.sessionId,
      'spider.owner-core': h.owner!.terminal.coreId, 'spider.owner-terminal': h.owner!.terminal.terminalId, 'spider.machine': 'remote.invalid', 'spider.run': 'child-run' });
    // A parent reload must leave a live child writer and its payload untouched.
    await monitor.shutdown('reload'); monitor = parentMonitor(); await monitor.activate({ ...h.owner!, generation: 'reloaded-parent' as never });
    expect(notices).toEqual([]); child.kill('SIGKILL'); await exit; await monitor.reconcile();
    await vi.waitFor(async () => { await expect(h.hc.get(consoleAddress)).rejects.toMatchObject({ code: 'not_found' }); }, { timeout: 7000 });
    const done = new Promise<void>((resolve, reject) => { const deadline = Date.now() + 15000; const timer = setInterval(() => { void monitor!.reconcile().then(() => { if (notices.length) { clearInterval(timer); resolve(); } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Handoff completion timeout')); } }, error => { clearInterval(timer); reject(error); }); }, 100); });
    await done; await monitor.reconcile();
    expect(notices.map(n => ({ runId: n.details.runId, jobId: n.details.jobId, exitCode: n.details.exitCode }))).toEqual([{ runId: 'child-run', jobId: background.result.details.remote.jobId, exitCode: 29 }]);
    expect(await readFile(join(background.result.details.backgroundJob.dir, 'stdout.log'), 'utf8')).toBe('survived child\n');
    await expect.poll(async () => (await childStore.read()).jobs.find(job => job.id === background.result.details.remote.jobId), { timeout: 5000 }).toMatchObject({ settledMarked: true, notice: 'submitted', noticeDelivered: true });
    const adopted = (await createJobStore(join(config.globalRoot, 'herdr/jobs'), h.owner!.sessionId, 'child-run' as RunId).read()).jobs.find(job => job.id === background.result.details.remote.jobId)!;
    expect(adopted).toMatchObject({ settledMarked: true, notice: 'submitted', noticeDelivered: true });
    expect(await h.hc.get(adopted.phase.kind === 'finished' ? adopted.phase.address : '' as TerminalAddress)).toMatchObject({ state: 'finished' });
    observed.push(adopted.id); await monitor.reconcile();
    await expect.poll(async () => (await childStore.read()).child?.settled, { timeout: 7000 }).toBe(true);
    await expect(h.hc.get(background.result.details.remote.address)).rejects.toMatchObject({ code: 'not_found' });
    const runStore = createJobStore(join(config.globalRoot, 'herdr/jobs'), h.owner!.sessionId, 'child-run' as RunId);
    expect((await runStore.read()).child).toMatchObject({ ended: true, settled: true });
    const before = await readFile(runStore.path, 'utf8'); await monitor.reconcile();
    expect(await readFile(runStore.path, 'utf8')).toBe(before);
    expect(JSON.parse((await h.hc.fileRead('remote.invalid' as never, join(adopted.remoteDirectory, '.spider-settled'))).toString()).jobId).toBe(adopted.id);
    await monitor.shutdown('reload'); monitor = parentMonitor(); await monitor.activate(h.owner!); await monitor.reconcile(); expect(notices).toHaveLength(1);
    if (mode === 'fake') {
      const allCalls = (await h.calls()).slice(setupCallCount).filter(call => call.argv[0] === 'run' && call.argv.includes('--on'));
      const viewCalls = allCalls.filter(call => call.argv.includes('--console')); expect(viewCalls).toHaveLength(1);
      const calls = allCalls.filter(call => call !== viewCalls[0]);
      const labels = calls.map(call => Object.fromEntries(call.argv.flatMap((arg, index) => arg === '--label' ? [call.argv[index + 1]!.split('=', 2)] : [])));
      expect(labels.map(label => [label['spider.kind'], label['spider.job'] ?? null])).toEqual([
        ['exec', foreground.result.details.remote.jobId], ['exec', background.result.details.remote.jobId],
      ]);
      for (const label of labels) expect(label).toMatchObject({ 'spider.session': h.owner!.sessionId, 'spider.owner-core': h.owner!.terminal.coreId, 'spider.owner-terminal': h.owner!.terminal.terminalId, 'spider.machine': 'remote.invalid', 'spider.run': 'child-run' });
      const metadata = JSON.parse(JSON.parse((await h.hc.fileRead('remote.invalid' as never, join(retained!.directory, 'console.json'))).toString()).body);
      const head = JSON.parse(JSON.parse((await h.hc.fileRead('remote.invalid' as never, join(retained!.directory, 'head.json'))).toString()).body);
      expect(head.count).toBe(2);
      expect(metadata.title).toBe('worker · remote.invalid');
      expect(calls.every(call => call.env.PI_SUBAGENT_CHILD === '1' && call.env.PI_SUBAGENT_RUN_ID === 'child-run' && Reflect.get(call, 'parentPid') === child!.pid && call.argv.includes('--no-notify'))).toBe(true);
      expect(await readFile(join(h.directories.local, 'app-calls.jsonl'), 'utf8')).toBe('');
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill('SIGKILL'); await closed; }
    await monitor?.shutdown('reload'); output?.dispose();
    if (largeSnapshot) {
      const rows = (await h.cli(['ls', '--all', '--json']) as { terminals: { address: string }[] }).terminals;
      await h.emitCore({ type: 'snapshot', seq: 1000000, terminals: rows.filter(row => !row.address.startsWith('large-')) });
      await expect.poll(async () => ((await h.cli(['ls', '--all', '--json']) as { terminals: unknown[] }).terminals.length)).toBeLessThan(8000);
    }
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
  }
}
