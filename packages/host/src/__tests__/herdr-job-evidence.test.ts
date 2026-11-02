// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { setupHerdr, runtimeInstallPath } from '../../../herdr/src/setup/installer.js';
import { createJobMonitor } from '../../../herdr/src/jobs/monitor.js';
import { createJobStore } from '../../../herdr/src/jobs/store.js';
import { sha256 } from '../../../herdr/src/remote/runtime.js';
import { createRemoteExecutor } from '../../../herdr/src/remote/execute.js';
import { publishSessionFeed } from '../../../herdr/src/feed/publisher.js';
import { parseFeed } from '../../../herdr/assets/shared/feed.js';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import { runExec } from '../../../context/src/actions/exec.js';
import { createHostHerdrPorts, createProductionHerdrCliPorts, readJobJournal } from '../herdr/ports.js';
import { createHerdrDataSource } from '../herdr/data-source.js';
import type { RuntimeTarget, RemoteResult } from '../../../herdr/src/contracts.js';

const binary = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
const real = process.env.SPIDER_HERDR_E2E === '1' && await access(binary).then(() => true, () => false);
if (!real) console.info('SKIP real exit-evidence proof: requires hc and SPIDER_HERDR_E2E=1; isolated cores only, no app');
async function prove(mode: 'fake' | 'hc', kind: 'conflict' | 'delayed-receipt' | 'slow-observable' = 'conflict') {
  const delayedReceipt = kind === 'delayed-receipt', slowObservable = kind === 'slow-observable';
  let restoreDeadline = () => {};
  // A complete receipt must not settle a tool before the monitor compares it to native exit evidence.
  const h = await createHerdrHarness(mode);
  let output: ReturnType<typeof createHostHerdrPorts> | undefined, jobs: ReturnType<typeof createJobMonitor> | undefined;
  let source: ReturnType<typeof createHerdrDataSource> | undefined;
  let release!: () => void, seen!: () => void, collected!: () => void;
  const evidenceGate = new Promise<void>(r => { release = r; }), evidenceSeen = new Promise<void>(r => { seen = r; }), toolCollected = new Promise<void>(r => { collected = r; });
  let executing: ReturnType<typeof runExec> | undefined;
  let receiptVisible = !delayedReceipt;
  try {
    await h.start(); execFileSync('git', ['init', '-q', h.root]); vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global); vi.stubEnv('HC_TERMINAL_ID', '');
    const file = join(h.directories.global, 'herdr/config.json'); await mkdir(join(file, '..'), { recursive: true });
    const config = parseHerdrConfig({ enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') },
      agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'runtime'), cwd: null, commands: {} } }] });
    await writeFile(file, JSON.stringify(config)); await writeFile(join(h.directories.app, 'settings.json'), '{}');
    await mkdir(join(h.root, 'packages/herdr'), { recursive: true }); await cp(resolve('packages/herdr/assets'), join(h.root, 'packages/herdr/assets'), { recursive: true }); await cp(resolve('dist/herdr'), join(h.root, 'dist/herdr'), { recursive: true });
    const cli = createProductionHerdrCliPorts(h.root, h.localEnv);
    try {
      const request = { config, configPath: file, packageRoot: h.root, journalRoot: join(h.directories.global, 'herdr/setup') }, parts = await cli.setupParts(request);
      await setupHerdr(request, { ...parts, preflight: async () => ({ fingerprint: 'exit-proof', coreIdentity: h.owner!.terminal, layoutExport: true, targets: [], retiredTerminals: [], mods: ['spider-panel', 'spider-machines'].map(name => ({ directory: join(h.directories.app, 'mods', name) })) }), stageLook: async () => [], generateTemplates: async () => [], installResume: async () => [], cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }) });
    } finally { await cli.dispose(); }
    const runtime = await readFile(resolve('dist/herdr/remote-runtime.mjs')), runtimePath = runtimeInstallPath(config.machines[0].runtime.directory, runtime);
    expect((await h.hc.fileRead('remote.invalid' as never, runtimePath)).equals(runtime)).toBe(true);
    const collectionHc = { ...h.hc, fileRead: async (on: Parameters<typeof h.hc.fileRead>[0], path: string) => {
      if (!receiptVisible && path.endsWith('/receipt.json')) throw Object.assign(new Error('Receipt publication is delayed'), { code: 'ENOENT' });
      return h.hc.fileRead(on, path);
    } };
    output = createHostHerdrPorts({ hc: collectionHc, config, runtimeBytes: runtime, runtimePath: () => runtimePath });
    const journalRoot = join(h.directories.global, 'herdr/jobs');
    jobs = createJobMonitor({ hc: h.hc, journalRoot, clock: Date.now, notifier() {}, observedJobMessages: async () => [], outputCollector: {
      prepare: async (program, job) => {
        const launch = await output!.outputCollector.prepare(program, job);
        if (delayedReceipt || slowObservable) return launch;
        // The installed runtime records the payload's real 23; its terminal wrapper exits 0.
        return { ...launch, program: { ...launch.program, argv: [process.execPath, '-e', 'const child=require("node:child_process").spawn(process.execPath,process.argv.slice(1),{stdio:"inherit"}); child.on("exit",()=>{process.exitCode=0});', runtimePath, join(job.remoteDirectory, 'request.json')] } };
      },
      collect: async job => { const logs = await output!.outputCollector.collect(job); if (logs.complete && kind === 'conflict') { seen(); await evidenceGate; } return logs; },
    } });
    const target: RuntimeTarget = { on: 'remote.invalid' as never, ...config.machines[0].runtime, environment: {}, nodePath: process.execPath, runtimePath, runtimeSha256: sha256(runtime) };
    const remote = createRemoteExecutor({ hc: h.hc, jobs, prepare: prepareRemoteProgram, target: async () => target, environmentPolicy: env => env, clock: Date.now,
      logSink: async job => { const reader = output!.logReader(job.id); return { ...reader, collect: async () => { const logs = await reader.collect(); if (logs.complete && kind === 'conflict') { await evidenceSeen; collected(); } return logs; } }; } });
    if (slowObservable) {
      const timeout = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => timeout(callback, ms === 60000 ? 500 : ms, ...args)) as typeof setTimeout);
      restoreDeadline = () => { spy.mockRestore(); };
    }
    executing = runExec({ language: 'shell', code: (slowObservable ? 'sleep 2; ' : '') + 'sleep 0.2; printf "conflict-output\\n"; exit 23', on: target.on }, { cwd: h.root, remote, owner: h.owner! });
    const store = createJobStore(journalRoot, h.owner!.sessionId);
    if (slowObservable) {
      await expect.poll(async () => (await store.read()).jobs[0]?.phase.kind, { timeout: 5000 }).toBe('running');
      expect(await Promise.race([executing, delay(600).then(() => null)])).toBeNull();
      const job = (await store.read()).jobs[0];
      if (job.phase.kind !== 'running') throw new Error('Healthy command stopped being observable');
      expect(await h.hc.get(job.phase.address)).toMatchObject({ state: 'live' });
      const action = await executing;
      expect(action.details).toMatchObject({ outcome: 'exited', exitCode: 23, stdout: 'conflict-output\n' });
      await writeFile(resolve(`.spider/scratch/fx5-slow-${mode}-evidence.json`), JSON.stringify({ localSocket: h.localSocket, remoteSocket: h.remoteSocket, action, journal: await store.read() }, null, 2));
      return;
    }
    if (delayedReceipt) {
      await expect.poll(async () => (await store.read()).jobs[0]?.originalFinish?.exitCode, { timeout: 5000 }).toBe(23);
      const job = (await store.read()).jobs[0];
      await expect(access(join(job.localDirectory, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      const premature = await Promise.race([executing, delay(1500).then(() => null)]);
      expect(premature).toBeNull();
      receiptVisible = true;
      const action = await executing, result = action.details as RemoteResult;
      expect(result).toMatchObject({ outcome: 'exited', exitCode: 23, stdout: 'conflict-output\n' });
      expect(JSON.parse(await readFile(join(job.localDirectory, 'receipt.json'), 'utf8'))).toMatchObject({ outcome: 'exited', exitCode: 23 });
      await writeFile(resolve(`.spider/scratch/fx5-delayed-${mode}-evidence.json`), JSON.stringify({ localSocket: h.localSocket, remoteSocket: h.remoteSocket, result, journal: await store.read() }, null, 2));
      return;
    }
    await Promise.race([toolCollected, executing.then(() => { throw new Error('Execution settled before evidence collection'); })]);
    const early = await Promise.race([executing, delay(200).then(() => null)]);
    expect(early).toBeNull();
    release(); const action = await executing, result = action.details as RemoteResult;
    expect(action.text).not.toContain('no exit receipt was ever written');
    expect(action.text).toMatch(/exit uncertain.*native.*0.*receipt.*23/i);
    expect(action.isError).toBe(false);
    expect(result).toMatchObject({ exitCode: null, outcome: 'unknown', evidenceConflict: true, stdout: 'conflict-output\n', exitEvidence: { native: { exitCode: 0, signal: null }, receipt: { exitCode: 23, signal: null } } });
    expect(result.stderr).toMatch(/uncertain.*native.*0.*receipt.*23/i);
    const journal = await store.read();
    expect(journal.jobs[0]).toMatchObject({ evidenceConflict: true, phase: { kind: 'disconnected' }, exitEvidence: { native: { exitCode: 0 }, receipt: { exitCode: 23 } } });
    const dbPath = join(h.root, 'runs.db'), globalPath = join(h.root, 'global.db');
    openDbAt(dbPath, 'worktree').close(); openDbAt(globalPath, 'global').close();
    source = createHerdrDataSource({ resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }), runEvents: { on: () => () => {} },
      readJobJournal: owner => readJobJournal(journalRoot, owner), scheduler: { listTriggers: () => [], subscribe: () => () => {} }, readConfig: () => config,
      readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), clock: Date.now });
    const feed = await source.snapshot(h.owner!); await publishSessionFeed(join(h.directories.global, 'herdr'), feed);
    const wire = await readFile(join(h.directories.global, 'herdr/sessions', h.owner!.sessionId, 'session.json'), 'utf8'), decoded = parseFeed(wire)!;
    expect(decoded).not.toBeNull();
    const notice = decoded.notifications.find(n => n.kind === 'job-result');
    expect(notice).toMatchObject({ kind: 'job-result', job: { exitCode: null, outcome: 'unknown', evidenceConflict: true, exitEvidence: { native: { exitCode: 0 }, receipt: { exitCode: 23 } } } });
    expect(notice?.body).toMatch(/uncertain.*native.*0.*receipt.*23/i);
    await writeFile(resolve(`.spider/scratch/fx5-exit-${mode}-evidence.json`), JSON.stringify({ localSocket: h.localSocket, remoteSocket: h.remoteSocket, result, journal, feed: decoded }, null, 2));
  } finally {
    restoreDeadline(); receiptVisible = true; release(); await jobs?.reconcile(); await executing?.catch(() => {}); source?.dispose(); await jobs?.shutdown('reload'); output?.dispose(); vi.unstubAllEnvs(); await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
  }
}
it('a plain local command keeps its pre-fix result text byte-identical', async () => {
  const result = await runExec({ language: 'javascript', code: 'console.log("local exact"); console.error("diagnostic")' }, { cwd: process.cwd() });
  expect(Buffer.from(result.text)).toEqual(Buffer.from('local exact\n\n[stderr]\ndiagnostic\n'));
});
it('fake: a healthy observable command outlives the collection bound and returns its actual exit', () => prove('fake', 'slow-observable'), 45000);
it.skipIf(!real)('real hc: a healthy observable command outlives the collection bound and returns its actual exit', () => prove('hc', 'slow-observable'), 60000);
it('fake: a native exit waits for delayed receipt collection before reporting exit 23', () => prove('fake', 'delayed-receipt'), 45000);
it.skipIf(!real)('real hc: a native exit waits for delayed receipt collection before reporting exit 23', () => prove('hc', 'delayed-receipt'), 60000);
it('fake: the tool and published feed disclose native/receipt conflicts instead of trusting an early receipt', () => prove('fake'), 45000);
it.skipIf(!real)('real hc: the tool and published feed disclose native/receipt conflicts instead of trusting an early receipt', () => prove('hc'), 60000);
