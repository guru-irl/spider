// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { createProductionHerdrCliPorts, createHostHerdrPorts } from '../../../host/src/herdr/ports.js';
import { setupHerdr, type SetupParts, type SetupRequest } from '../setup/installer.js';
import { parseHerdrConfig } from '../config.js';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import { executeRemote, type RemoteExecutionPorts } from './execute.js';
import { sha256, installRuntimeDirectory } from './runtime.js';
import { createJobMonitor, type JobNotice, type JobMonitorOptions } from '../jobs/monitor.js';
import { createJobStore, type JournalJob } from '../jobs/store.js';
import { doctorHerdr, type DoctorParts } from '../setup/doctor.js';
import type { CoreId, HcClient, HcEvent, JobRecord, JobHandle, JobId, Owner, MachineName, TerminalAddress, TerminalSummary } from '../contracts.js';

const roots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(r => child.once('close', () => r())); child.kill('SIGKILL'); await closed;
  }
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(nodeVersion?: string) {
  vi.stubEnv('HC_TERMINAL_ID', '');
  const base = resolve('.spider/scratch/fx3'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'r-')); roots.push(root);
  await mkdir(join(root, 'global'), { mode: 0o700 });
  vi.stubEnv('SPIDER_GLOBAL_ROOT', join(root, 'global'));
  const on = 'destination.invalid' as MachineName;
  const owner = { sessionId: 'session', generation: 'generation', terminal: { address: 'agent', coreId: 'core', terminalId: 'agent', socket: join(root, 'unused.sock'), sessionNamespace: 'isolated' }, cwd: root, name: null, sessionFile: null } as Owner;
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected core operation'); };
  const hc: HcClient = { identity: unsupported, caller: unsupported, machines: async () => [], run: unsupported, get: unsupported, read: unsupported, kill: unsupported, rm: unsupported, setLabels: unsupported, events: () => { throw new Error('Unexpected core subscription'); },
    fileRead: async (_on, path) => { try { return await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(new Error('File not found'), { code: 'not_found' }); throw error; } }, fileWrite: async (_on, path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode: 0o600 }); } };
  const runtimeDirectory = join(root, 'remote/programs');
  const config = parseHerdrConfig({ app: { binary: '/unused', home: join(root, 'app') }, core: { binary: '/unused', config: join(root, 'core.toml') }, agentDirectory: join(root, 'agent'), globalRoot: join(root, 'global'), shellRc: join(root, 'shellrc'), spaces: [], machines: [{ name: on, nodePath: process.execPath, runtime: { directory: runtimeDirectory, cwd: root, commands: { javascript: [process.execPath], shell: ['/bin/sh'] } } }] });
  const request: SetupRequest = { config, configPath: join(root, 'config.json'), packageRoot: root, journalRoot: join(root, 'journal') };
  await writeFile(config.core.config, 'notes = false\n');
  await mkdir(join(root, 'dist/herdr'), { recursive: true });
  await writeFile(join(root, 'dist/herdr/remote-runtime.mjs'), await readFile(resolve('dist/herdr/remote-runtime.mjs')));
  const production = createProductionHerdrCliPorts(request.packageRoot, { ...process.env, HC_SESSION: 'isolated', HC_TERMINAL_SOCKET: owner.terminal.socket, XDG_STATE_HOME: root, XDG_CONFIG_HOME: join(root, 'config') });
  const runtimeParts = await production.setupParts(request);
  const parts: SetupParts = { ...runtimeParts, hc,
    preflight: async () => ({ fingerprint: 'runtime-only', coreIdentity: owner.terminal, mods: [], targets: nodeVersion ? [{ machine: on, nodePath: process.execPath, coreStartedAt: 'start' }] : [], retiredTerminals: [], layoutExport: true }),
    stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
    probeMachineNode: async () => nodeVersion ?? process.version,
    bootstrapRuntime: async () => { await installRuntimeDirectory(runtimeDirectory); },
    cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }), warn() {} };
  await setupHerdr(request, parts); // Real installer writes only the digest-named artifact supplied by production.
  const [runtime] = await runtimeParts.ensureRuntime(request, {} as never);
  await production.dispose();
  const target = { on, cwd: root, directory: runtimeDirectory, commands: config.machines[0].runtime.commands, environment: {}, nodePath: process.execPath, runtimePath: runtime.path, runtimeSha256: sha256(runtime.bytes) };
  const output = createHostHerdrPorts({ hc, config, runtimeBytes: runtime.bytes, runtimePath: () => runtime.path });
  let count = 0;
  const jobs: JobHandle[] = [];
  let destinationSkew = 0;
  const launch = async (record: JobRecord) => {
    const wrapper = join(root, `launch-${count}.mjs`);
    await writeFile(wrapper, `const now=Date.now; Date.now=()=>now()+${destinationSkew}; const {runRemoteRuntime}=await import(${JSON.stringify(runtime.path)}); process.exitCode=await runRemoteRuntime(${JSON.stringify(join(record.remoteDirectory, 'request.json'))});`);
    const child = spawn(process.execPath, [wrapper], { env: { ...process.env, PATH: '/usr/bin:/bin', TMPDIR: join(root, 'tmp') }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
    let ready = ''; child.stdout.on('data', b => { ready += b.toString(); }); child.stderr.resume();
    const finished = new Promise<import('../contracts.js').TerminalFinish>(r => child.once('close', (exitCode, signal) => r({ exitCode, signal: null, reason: signal ?? 'exited', finishedAt: Date.now() })));
    const deadline = Date.now() + 2000;
    while (!ready.includes('SPIDER_HERDR_READY') && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
    const bytes = await readFile(join(record.remoteDirectory, 'request.json'));
    const request = JSON.parse(bytes.toString());
    await hc.fileWrite(on, join(record.remoteDirectory, 'release.json'), Buffer.from(JSON.stringify({ version: 1, jobId: record.id, nonce: request.nonce, requestSha256: sha256(bytes) })));
    return { child, finished };
  };
  const ports: RemoteExecutionPorts = { hc, target: async () => target, prepare: prepareRemoteProgram, environmentPolicy: env => env, clock: Date.now,
    jobs: { start: async (prepare, owner, machine) => {
      const program = await prepare();
      const id = `job-${++count}` as JobId;
      const record = { version: 1, id, kind: 'exec', owner, machine, phase: { kind: 'preparing' }, viewer: null, localDirectory: join(root, 'local', id), remoteDirectory: program.directory, detached: false, noticeMode: 'tool', notice: 'pending' } as JobRecord;
      await output.outputCollector.prepare(program, record);
      const { child, finished } = await launch(record);
      const handle: JobHandle = { id, address: `${on}/${id}` as TerminalAddress, localDirectory: record.localDirectory, remoteDirectory: record.remoteDirectory, finished, cancel: async () => { child.kill('SIGKILL'); await finished; } }; jobs.push(handle); return handle;
    }, detach: async () => {}, consumeNotice: async () => {}, toolReturned: async () => {}, dispose() {} },
    logSink: async job => output.logReader(job.id) };
  const execute = (code: string, options = {}) => executeRemote({ source: { kind: 'code', language: 'javascript', code }, on, owner, ...options }, ports);
  return { root, owner, hc, request, parts, runtime, target, output, ports, jobs, execute, skew: (ms: number) => { destinationSkew = ms; } };
}

test.each(['source', 'command'] as const)('a retry uses a fresh directory and the original %s after the first runtime creates logs', async changed => {
  const f = await fixture(), listeners = new Set<(event: HcEvent) => void>();
  const marker = join(f.root, 'payload-runs');
  const source = { kind: 'code' as const, language: 'javascript' as const, code: `require('node:fs').appendFileSync(${JSON.stringify(marker)},'run\\n');console.log('retry output');process.exitCode=17` };
  const active = new Map<TerminalAddress, { terminal: TerminalSummary; child: ReturnType<typeof spawn>; closed: Promise<void> }>();
  const directories: string[] = [];
  let firstLogExists = false, rejectFirst = true;
  const emit = (event: HcEvent) => { for (const listener of listeners) listener(event); };
  f.hc.identity = async () => f.owner.terminal;
  f.hc.machines = async () => [{ id: 'destination-core' as CoreId, name: f.target.on, aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }];
  f.hc.events = () => ({ ready: Promise.resolve(), lookup: async address => active.get(address)?.terminal ?? null,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, dispose: () => {} });
  f.hc.run = async request => {
    const directory = dirname(request.argv[request.argv.length - 1]); directories.push(directory);
    const address = `${f.target.on}/t${directories.length}` as TerminalAddress;
    const terminal: TerminalSummary = { address, parent: null, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null };
    const child = spawn(request.argv[0], [...request.argv.slice(1)], { cwd: request.cwd ?? undefined, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
    child.stderr.resume();
    const closed = new Promise<void>(resolve => child.once('close', (exitCode, signal) => {
      const finish = { exitCode, signal: signal ? 15 : null, reason: 'exited', finishedAt: Date.now() };
      Object.assign(terminal, { state: 'finished', ...finish }); emit({ type: 'finished', terminal: address, data: finish, seq: 2 }); resolve();
    }));
    active.set(address, { terminal, child, closed }); emit({ type: 'created', terminal: address, data: terminal, seq: 1 });
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Runtime did not start')), 2000);
      child.stdout.on('data', bytes => { output += bytes.toString(); if (output.includes('SPIDER_HERDR_READY')) { clearTimeout(timer); resolve(); } });
      void closed.then(() => { clearTimeout(timer); resolve(); });
    });
    if (directories.length === 1) firstLogExists = await access(join(directory, 'stdout.log')).then(() => true, () => false);
    return { address, coreId: 'destination-core' as CoreId };
  };
  f.hc.get = async address => {
    if (rejectFirst) {
      rejectFirst = false;
      if (changed === 'source') source.code = "console.log('wrong output');process.exitCode=9";
      else f.target.commands = { ...f.target.commands, javascript: ['/missing-fixture-executable'] };
      throw Object.assign(new Error('Confirmation failed'), { code: 'hc-error' });
    }
    const entry = active.get(address); if (!entry) throw Object.assign(new Error('Not found'), { code: 'not_found' });
    return entry.terminal;
  };
  f.hc.kill = async address => { const entry = active.get(address)!; entry.child.kill('SIGTERM'); await entry.closed; };
  f.hc.rm = async address => { active.delete(address); };
  const jobs = createJobMonitor({ hc: f.hc, outputCollector: f.output.outputCollector, journalRoot: join(f.root, 'retry-journal'),
    observedJobMessages: async () => [], notifier: () => {}, clock: Date.now });
  f.ports.jobs = jobs;
  try {
    const result = await executeRemote({ source, on: f.target.on, owner: f.owner }, f.ports);
    expect(firstLogExists).toBe(true);
    expect(result).toMatchObject({ outcome: 'exited', exitCode: 17, stdout: 'retry output\n' });
    expect(await readFile(marker, 'utf8')).toBe('run\n');
    expect(directories).toHaveLength(2);
    expect(directories[0]).not.toBe(directories[1]);
    await expect(access(directories[0])).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await jobs.shutdown('reload'); }
}, 5000);

test('a lost release acknowledgement leaves the real payload running and recovers its receipt', async () => {
  const f = await fixture(), listeners = new Set<(event: HcEvent) => void>(), active = new Map<TerminalAddress, TerminalSummary>();
  const marker = join(f.root, 'released-runs'), notices: JobNotice[] = [];
  let launches = 0, kills = 0;
  const emit = (event: HcEvent) => { for (const listener of listeners) listener(event); };
  f.hc.identity = async () => f.owner.terminal;
  f.hc.machines = async () => [{ id: 'destination-core' as CoreId, name: f.target.on, aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }];
  f.hc.events = () => ({ ready: Promise.resolve(), lookup: async address => active.get(address) ?? null, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, dispose: () => {} });
  f.hc.run = async request => {
    const address = `${f.target.on}/t${++launches}` as TerminalAddress;
    const terminal: TerminalSummary = { address, parent: null, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null };
    const child = spawn(request.argv[0], [...request.argv.slice(1)], { cwd: request.cwd ?? undefined, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
    child.stdout.resume(); child.stderr.resume(); active.set(address, terminal);
    child.once('close', (exitCode, signal) => {
      const finish = { exitCode, signal: signal ? 15 : null, reason: 'exited', finishedAt: Date.now() };
      Object.assign(terminal, { state: 'finished', ...finish }); emit({ type: 'finished', terminal: address, data: finish, seq: 2 });
    });
    return { address, coreId: 'destination-core' as CoreId };
  };
  f.hc.get = async address => { const terminal = active.get(address); if (!terminal) throw Object.assign(new Error('Not found'), { code: 'not_found' }); return terminal; };
  f.hc.kill = async () => { kills++; };
  f.hc.rm = async address => { active.delete(address); };
  const write = f.hc.fileWrite;
  f.hc.fileWrite = async (on, path, bytes, options) => { await write(on, path, bytes, options); if (path.endsWith('/release.json')) throw Object.assign(new Error('Acknowledgement lost'), { code: 'cli-timeout' }); };
  const root = join(f.root, 'uncertain-journal');
  const jobs = createJobMonitor({ hc: f.hc, outputCollector: f.output.outputCollector, journalRoot: root, observedJobMessages: async () => [], notifier: notice => { notices.push(notice); }, clock: Date.now });
  f.ports.jobs = jobs;
  try {
    const result = await executeRemote({ source: { kind: 'code', language: 'javascript', code: `require('node:fs').appendFileSync(${JSON.stringify(marker)},'run\\n');console.log('completed');process.exitCode=17` }, on: f.target.on, owner: f.owner }, f.ports);
    expect(result).toMatchObject({ outcome: 'unknown', exitCode: null, backgroundJob: { id: result.remote.jobId } });
    expect(result.stderr).toMatch(/release.*may.*running/i);
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('run\n'), { timeout: 3000, interval: 20 });
    const store = createJobStore(root, f.owner.sessionId);
    await vi.waitFor(async () => expect((await store.read()).jobs[0].phase).toMatchObject({ kind: 'finished', result: { exitCode: 17 } }), { timeout: 3000, interval: 20 });
    await vi.waitFor(() => expect(notices.map(notice => notice.details.jobId)).toEqual([result.remote.jobId]), { timeout: 1000, interval: 20 });
    expect(await readFile(join(result.backgroundJob!.dir, 'stdout.log'), 'utf8')).toBe('completed\n');
    expect(launches).toBe(1); expect(kills).toBe(0);
  } finally { await jobs.shutdown('reload'); }
}, 5000);

test('slow request uploads do not spend the runtime release budget', async () => {
  const f = await fixture(), terminals = new Map<TerminalAddress, TerminalSummary>();
  let now = 1000, launches = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const write = f.hc.fileWrite;
  f.hc.fileWrite = async (on, path, bytes, options) => { await write(on, path, bytes, options); if (path.endsWith('/request.json')) now += 12000; };
  f.hc.identity = async () => f.owner.terminal;
  f.hc.machines = async () => [{ id: 'destination-core' as CoreId, name: f.target.on, aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }];
  f.hc.events = () => ({ ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null, subscribe: () => () => {}, dispose: () => {} });
  f.hc.run = async request => {
    const address = `${f.target.on}/t${++launches}` as TerminalAddress;
    terminals.set(address, { address, parent: null, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null });
    return { address, coreId: 'destination-core' as CoreId };
  };
  f.hc.get = async address => { const terminal = terminals.get(address); if (!terminal) throw Object.assign(new Error('Not found'), { code: 'not_found' }); return terminal; };
  f.hc.kill = async () => {};
  f.hc.rm = async address => { terminals.delete(address); };
  const jobs = createJobMonitor({ hc: f.hc, outputCollector: f.output.outputCollector, journalRoot: join(f.root, 'slow-upload-journal'),
    observedJobMessages: async () => [], notifier: () => {}, clock: () => now });
  try {
    const source = { kind: 'code' as const, language: 'javascript' as const, code: "console.log('uploaded')" };
    const actual = await jobs.start(() => prepareRemoteProgram(source, f.target), f.owner, f.target.on, {}).then(handle => ({ handle }), error => ({ error }));
    expect(launches).toBe(1);
    expect(actual).toHaveProperty('handle');
    if (!('handle' in actual)) return;
    expect(JSON.parse(await readFile(join(actual.handle.remoteDirectory, 'release.json'), 'utf8'))).toMatchObject({ jobId: actual.handle.id });
    expect(JSON.parse(await readFile(join(actual.handle.remoteDirectory, 'request.json'), 'utf8'))).toMatchObject({ releaseWindowMs: 10000 });
    const journal = await createJobStore(join(f.root, 'slow-upload-journal'), f.owner.sessionId).read();
    expect(journal.jobs[0].releaseDeadlineAt).toBe(23000);
  } finally { await jobs.shutdown('reload'); clock.mockRestore(); }
}, 5000);

test.each([11000, -60000])('production writer and installed runtime release with destination clock skew %i ms', async skew => {
  const f = await fixture(); f.skew(skew);
  const result = await f.execute("console.log('released');process.exitCode=23");
  expect(result).toMatchObject({ outcome: 'exited', exitCode: 23, stdout: 'released\n' });
}, 15000);

test('a slow read begun before exit gets a fresh final round before returning unknown', async () => {
  const f = await fixture(); const logSink = f.ports.logSink; let rounds = 0;
  f.ports.logSink = async (job, options) => {
    const reader = await logSink(job, options);
    return { ...reader, collect: async () => {
      if (++rounds === 1) {
        const beforeExit = await reader.collect();
        await job.finished; await new Promise(r => setTimeout(r, 1100)); return { ...beforeExit, complete: false, receipt: null };
      }
      return reader.collect();
    } };
  };
  expect(await f.execute("setTimeout(()=>{console.log('final output');process.exitCode=17},100)")).toMatchObject({ outcome: 'exited', exitCode: 17, stdout: 'final output\n' });
}, 15000);

test('detached handles point to a local manifest and a verified local receipt after completion', async () => {
  const f = await fixture();
  const detached = await f.execute("setTimeout(()=>{console.log('background output');process.exitCode=17},200)", { timeout: 25, background: true });
  expect(detached).toMatchObject({ outcome: 'timeout', exitCode: null, backgrounded: true });
  const manifest = JSON.parse(await readFile(detached.backgroundJob!.manifest, 'utf8'));
  expect(manifest).toMatchObject({ id: detached.remote.jobId, remoteDirectory: f.jobs[0].remoteDirectory, machine: 'destination.invalid' });
  await f.jobs[0].finished;
  expect(await f.output.logReader(f.jobs[0].id).collect()).toMatchObject({ complete: true, stdout: 'background output\n' });
  expect(JSON.parse(await readFile(detached.backgroundJob!.receipt, 'utf8'))).toMatchObject({ jobId: detached.remote.jobId, outcome: 'exited', exitCode: 17, stdoutBytes: 18 });
}, 15000);

test('a completion notice links the actual published remote receipt', async () => {
  const f = await fixture();
  await f.execute("console.log('notice output');process.exitCode=17", { background: true });
  const handle = f.jobs[0], finish = await handle.finished;
  const wire = JSON.parse(await readFile(join(handle.remoteDirectory, 'request.json'), 'utf8'));
  const journalRoot = join(f.root, 'notice-journal'), store = createJobStore(journalRoot, f.owner.sessionId);
  const journal = await store.read();
  journal.jobs.push({ version: 1, id: handle.id, kind: 'exec', owner: f.owner, machine: f.target.on,
    phase: { kind: 'finished', address: handle.address, result: finish }, viewer: null, localDirectory: handle.localDirectory, remoteDirectory: handle.remoteDirectory,
    detached: true, noticeMode: 'async', notice: 'pending', nonce: wire.nonce, releaseDeadlineAt: Date.now(), originalFinish: finish, output: null,
    callerOwned: false, uncertain: false, evidenceConflict: false, noticeDelivered: false, settledMarked: false, terminalExpired: false, updatedAt: Date.now() } satisfies JournalJob);
  await store.write(journal);
  f.hc.identity = async () => f.owner.terminal;
  f.hc.events = () => ({ ready: Promise.resolve(), lookup: async () => null, subscribe: () => () => {}, dispose() {} });
  const notices: JobNotice[] = [];
  const monitor = createJobMonitor({ hc: f.hc, outputCollector: f.output.outputCollector, journalRoot, observedJobMessages: async () => [], notifier: notice => { notices.push(notice); }, clock: Date.now });
  try {
    await monitor.activate(f.owner); await monitor.reconcile();
    expect(notices).toHaveLength(1);
    const remoteReceipt = notices[0].content.match(/remote receipt: (.+)$/)![1];
    expect(JSON.parse((await f.hc.fileRead(f.target.on, remoteReceipt)).toString())).toMatchObject({ exitCode: 17, outcome: 'exited' });
  } finally { await monitor.shutdown('reload'); }
}, 15000);

async function savedJob(f: Awaited<ReturnType<typeof fixture>>, originalFinish: JournalJob['originalFinish'], patch: Partial<JournalJob> = {}) {
  const handle = f.jobs[0]; await handle.finished;
  const wire = JSON.parse(await readFile(join(handle.remoteDirectory, 'request.json'), 'utf8'));
  const journalRoot = join(f.root, 'restart-journal'), store = createJobStore(journalRoot, f.owner.sessionId, patch.runId);
  const journal = await store.read();
  journal.jobs.push({ version: 1, id: handle.id, kind: 'exec', owner: f.owner, machine: f.target.on,
    phase: { kind: 'disconnected', address: handle.address, lastSeq: 0 }, viewer: null, localDirectory: handle.localDirectory, remoteDirectory: handle.remoteDirectory,
    detached: true, noticeMode: 'async', notice: 'pending', nonce: wire.nonce, releaseDeadlineAt: Date.now(), originalFinish, output: null,
    callerOwned: false, uncertain: false, evidenceConflict: false, noticeDelivered: false, settledMarked: false, terminalExpired: false, updatedAt: Date.now(), ...patch } satisfies JournalJob);
  await store.write(journal);
  f.hc.identity = async () => f.owner.terminal;
  f.hc.events = () => ({ ready: Promise.resolve(), lookup: async () => null, subscribe: () => () => {}, dispose() {} });
  f.hc.get = async () => { throw Object.assign(new Error('Not found'), { code: 'not_found' }); };
  f.hc.machines = async () => [{ id: 'destination-core' as CoreId, name: f.target.on, aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }];
  return { journalRoot, store };
}

async function runActivation(f: Awaited<ReturnType<typeof fixture>>, journalRoot: string, options: { settled?: boolean; child?: JobMonitorOptions['child'] } = {}) {
  const { child } = options;
  let reads = 0;
  const notices: JobNotice[] = [], errors: unknown[] = [];
  const monitor = createJobMonitor({ hc: f.hc, outputCollector: { ...f.output.outputCollector, collect: async job => { reads++; return f.output.outputCollector.collect(job); } }, journalRoot, child,
    observedJobMessages: async () => [], notifier: notice => { notices.push(notice); }, reportError: error => { errors.push(error); }, clock: Date.now });
  try {
    await monitor.activate(f.owner); await monitor.reconcile();
    if (options.settled) await expect.poll(async () => (await createJobStore(journalRoot, f.owner.sessionId, child?.id).read()).jobs[0].settledMarked).toBe(true);
  }
  finally { await monitor.shutdown('reload'); }
  return { reads, notices, errors };
}

test('a restart stop is not exit evidence', async () => {
  const f = await fixture();
  await f.execute("process.kill(process.pid, 'SIGHUP')", { background: true });
  const restart = { exitCode: null, signal: null, reason: 'stopped_by_restart', finishedAt: Date.now() };
  const { journalRoot, store } = await savedJob(f, restart);
  const first = await runActivation(f, journalRoot, { settled: true });
  const job = (await store.read()).jobs[0];
  expect(job.phase).toMatchObject({ kind: 'finished', result: { exitCode: null, reason: 'signal', signal: 1 } });
  expect(job.evidenceConflict).toBe(false);
  expect(job.settledMarked).toBe(true);
  expect(first.reads).toBeGreaterThan(0);
  expect(first.notices).toHaveLength(1);
  expect(first.notices[0].content).toContain('signal=1');
  expect(first.errors).toEqual([]);
  const second = await runActivation(f, journalRoot);
  expect(second).toEqual({ reads: 0, notices: [], errors: [] });
}, 15000);

test('heals an old restart conflict and delivers a pending notice once', async () => {
  const f = await fixture();
  await f.execute("process.kill(process.pid, 'SIGHUP')", { background: true });
  const restart = { exitCode: null, signal: null, reason: 'stopped_by_restart', finishedAt: Date.now() };
  const receipt = { exitCode: null, signal: 1, reason: 'signal', finishedAt: Date.now() };
  const { journalRoot, store } = await savedJob(f, restart, { callerOwned: true, evidenceConflict: true, exitEvidence: { native: restart, receipt }, output: { complete: true, summary: 'Complete' } });
  const first = await runActivation(f, journalRoot, { settled: true });
  const job = (await store.read()).jobs[0];
  expect(job.phase).toMatchObject({ kind: 'finished', result: { exitCode: null, reason: 'signal', signal: 1 } });
  expect(job.evidenceConflict).toBe(false);
  expect(job).not.toHaveProperty('exitEvidence');
  expect(job.settledMarked).toBe(true);
  expect(job.notice).toBe('submitted');
  expect(job.noticeDelivered).toBe(true);
  expect(first.reads).toBeGreaterThan(0);
  expect(first.notices).toHaveLength(1);
  expect(first.notices[0].details).toMatchObject({ exitCode: null, reason: 'signal', signal: 1 });
  expect(first.errors).toEqual([]);
  const second = await runActivation(f, journalRoot);
  expect(second).toEqual({ reads: 0, notices: [], errors: [] });
}, 15000);

test.each(['holder_lost', 'server_stop', 'killed'])('a %s finish without exit data settles on the receipt', async reason => {
  const f = await fixture();
  await f.execute("process.kill(process.pid, 'SIGHUP')", { background: true });
  const native = { exitCode: null, signal: null, reason, finishedAt: Date.now() };
  const { journalRoot, store } = await savedJob(f, native);
  const first = await runActivation(f, journalRoot, { settled: true });
  const job = (await store.read()).jobs[0];
  expect(job.phase).toMatchObject({ kind: 'finished', result: { exitCode: null, reason: 'signal', signal: 1 } });
  expect(job.evidenceConflict).toBe(false);
  expect(job.settledMarked).toBe(true);
  expect(first.notices).toHaveLength(1);
  expect(first.notices[0].details).toMatchObject({ exitCode: null, reason: 'signal', signal: 1 });
  expect(first.errors).toEqual([]);
  expect(await runActivation(f, journalRoot)).toEqual({ reads: 0, notices: [], errors: [] });
}, 15000);

test('heals an observed conflict with empty native exit data without another notice', async () => {
  const f = await fixture();
  await f.execute("process.kill(process.pid, 'SIGHUP')", { background: true });
  const native = { exitCode: null, signal: null, reason: 'holder_lost', finishedAt: Date.now() };
  const receipt = { exitCode: null, signal: 1, reason: 'signal', finishedAt: Date.now() };
  const { journalRoot, store } = await savedJob(f, native, { notice: 'observed', noticeDelivered: true, evidenceConflict: true, exitEvidence: { native, receipt }, output: { complete: true, summary: 'Complete' } });
  const first = await runActivation(f, journalRoot, { settled: true });
  const job = (await store.read()).jobs[0];
  expect(job.phase).toMatchObject({ kind: 'finished', result: { exitCode: null, reason: 'signal', signal: 1 } });
  expect(job.evidenceConflict).toBe(false);
  expect(job).not.toHaveProperty('exitEvidence');
  expect(job.notice).toBe('observed');
  expect(job.noticeDelivered).toBe(true);
  expect(job.settledMarked).toBe(true);
  expect(first.notices).toEqual([]);
  expect(first.errors).toEqual([]);
  expect(await runActivation(f, journalRoot)).toEqual({ reads: 0, notices: [], errors: [] });
}, 15000);

test('a child monitor heals a pending conflict and delivers its receipt once', async () => {
  const f = await fixture();
  await f.execute("process.kill(process.pid, 'SIGHUP')", { background: true });
  const native = { exitCode: null, signal: null, reason: 'stopped_by_restart', finishedAt: Date.now() };
  const receipt = { exitCode: null, signal: 1, reason: 'signal', finishedAt: Date.now() };
  const child = { id: 'run-one' as NonNullable<JournalJob['runId']>, pid: process.pid, startIdentity: 'writer' };
  const { journalRoot, store } = await savedJob(f, native, { runId: child.id, callerOwned: true, evidenceConflict: true, exitEvidence: { native, receipt }, output: { complete: true, summary: 'Complete' } });
  const first = await runActivation(f, journalRoot, { settled: true, child });
  const job = (await store.read()).jobs[0];
  expect(job.phase).toMatchObject({ kind: 'finished', result: { exitCode: null, reason: 'signal', signal: 1 } });
  expect(job.evidenceConflict).toBe(false);
  expect(job).not.toHaveProperty('exitEvidence');
  expect(job.settledMarked).toBe(true);
  expect(first.notices).toHaveLength(1);
  expect(first.notices[0].details).toMatchObject({ runId: child.id, exitCode: null, reason: 'signal', signal: 1 });
  expect(first.errors).toEqual([]);
  expect(await runActivation(f, journalRoot, { child })).toEqual({ reads: 0, notices: [], errors: [] });
}, 15000);

test('a restart-labelled finish with a real exit code still conflicts with a different receipt', async () => {
  const f = await fixture();
  await f.execute('process.exitCode=17', { background: true });
  const native = { exitCode: 0, signal: null, reason: 'stopped_by_restart', finishedAt: Date.now() };
  const { journalRoot, store } = await savedJob(f, native);
  const first = await runActivation(f, journalRoot);
  const job = (await store.read()).jobs[0];
  expect(job.phase.kind).toBe('disconnected');
  expect(job.evidenceConflict).toBe(true);
  expect(job.exitEvidence).toMatchObject({ native: { exitCode: 0 }, receipt: { exitCode: 17 } });
  expect(job.settledMarked).toBe(false);
  expect(first.notices).toEqual([]);
  expect(first.errors).toEqual([]);
}, 15000);

test('a saved conflict with a real restart-labelled exit remains a conflict', async () => {
  const f = await fixture();
  await f.execute('process.exitCode=17', { background: true });
  const native = { exitCode: 0, signal: null, reason: 'stopped_by_restart', finishedAt: Date.now() };
  const receipt = { exitCode: 17, signal: null, reason: 'exited', finishedAt: Date.now() };
  const { journalRoot, store } = await savedJob(f, native, { evidenceConflict: true, exitEvidence: { native, receipt }, output: { complete: true, summary: 'Complete' } });
  const first = await runActivation(f, journalRoot);
  const job = (await store.read()).jobs[0];
  expect(job.phase.kind).toBe('disconnected');
  expect(job.evidenceConflict).toBe(true);
  expect(job.exitEvidence).toMatchObject({ native: { exitCode: 0 }, receipt: { exitCode: 17 } });
  expect(job.settledMarked).toBe(false);
  expect(first).toEqual({ reads: 0, notices: [], errors: [] });
}, 15000);

test('does not reread a real conflict after complete output', async () => {
  const f = await fixture();
  await f.execute('process.exitCode=17', { background: true });
  const native = { exitCode: 0, signal: null, reason: 'exited', finishedAt: Date.now() };
  const { journalRoot, store } = await savedJob(f, native);
  const first = await runActivation(f, journalRoot);
  const job = (await store.read()).jobs[0];
  expect(job.phase.kind).toBe('disconnected');
  expect(job.evidenceConflict).toBe(true);
  expect(job.exitEvidence).toMatchObject({ native: { exitCode: 0 }, receipt: { exitCode: 17 } });
  expect(job.output?.complete).toBe(true);
  expect(first.reads).toBeGreaterThan(0);
  expect(first.notices).toEqual([]);
  expect(first.errors).toEqual([]);
  const second = await runActivation(f, journalRoot);
  expect(second).toEqual({ reads: 0, notices: [], errors: [] });
}, 15000);

test('an output timeout reports the job and machine and accepts a later receipt', async () => {
  const f = await fixture();
  await f.execute('process.exitCode=17', { background: true });
  const { journalRoot, store } = await savedJob(f, { exitCode: null, signal: null, reason: 'holder_lost', finishedAt: Date.now() });
  let release!: () => void, finishRead!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const readFinished = new Promise<void>(resolve => { finishRead = resolve; });
  let readStarted = false;
  const errors: unknown[] = [];
  const monitor = createJobMonitor({ hc: f.hc, journalRoot, clock: Date.now, observedJobMessages: async () => [], notifier: () => {}, reportError: error => { errors.push(error); },
    outputCollector: { ...f.output.outputCollector, collect: async job => {
      readStarted = true;
      try { await blocked; return await f.output.outputCollector.collect(job); } finally { finishRead(); }
    } } });
  const timeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => timeout(callback, ms === 60000 ? 20 : ms, ...args)) as typeof setTimeout);
  try {
    await monitor.activate(f.owner); await monitor.reconcile();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'output-unavailable', details: { jobId: f.jobs[0].id, machine: f.target.on } });
    release(); await readFinished; await new Promise<void>(resolve => setImmediate(resolve)); await monitor.reconcile();
    expect((await store.read()).jobs[0].phase).toMatchObject({ kind: 'finished', result: { exitCode: 17, reason: 'exited', signal: null } });
  } finally {
    release(); if (readStarted) await readFinished;
    try { await monitor.shutdown('reload'); } finally { spy.mockRestore(); }
  }
}, 15000);

test('the production collector saves the verified receipt locally after a detached job exits', async () => {
  const f = await fixture();
  const detached = await f.execute("setTimeout(()=>{console.log('background output');process.exitCode=17},200)", { timeout: 25, background: true });
  await f.jobs[0].finished;
  expect(await f.output.logReader(f.jobs[0].id).collect()).toMatchObject({ complete: true });
  expect(JSON.parse(await readFile(detached.backgroundJob!.receipt, 'utf8'))).toMatchObject({ outcome: 'exited', exitCode: 17, stdoutBytes: 18 });
}, 15000);

test.each(['missing', 'outdated'])('a %s installed runtime fails before launching with a setup repair hint', async state => {
  const f = await fixture();
  if (state === 'missing') await rm(f.runtime.path); else await writeFile(f.runtime.path, '// obsolete runtime');
  await expect(f.execute("console.log('must not run')")).rejects.toMatchObject({ code: 'runtime-not-installed', message: expect.stringMatching(/rerun.*setup/i) });
  expect(f.jobs).toEqual([]);
}, 15000);

test('an early runtime-root failure publishes a verified spawn-error receipt and a setup repair hint', async () => {
  const f = await fixture(); await chmod(f.target.directory, 0o755);
  const result = await f.execute("console.log('must not run')");
  expect(result).toMatchObject({ outcome: 'spawn-error', exitCode: null, stdout: '' });
  expect(result.stderr).toMatch(/0700.*rerun.*setup/i);
  const receipt = JSON.parse(await readFile(join(f.jobs[0].remoteDirectory, 'receipt.json'), 'utf8'));
  expect(receipt).toMatchObject({ jobId: f.jobs[0].id, outcome: 'spawn-error', stdoutBytes: 0, stderrBytes: 0 });
  expect(await f.output.logReader(f.jobs[0].id).collect()).toMatchObject({ complete: true });
}, 15000);

async function doctorParts(f: Awaited<ReturnType<typeof fixture>>, nodeVersion = process.version): Promise<DoctorParts> {
  const probeMachineNode: DoctorParts['probeMachineNode'] = async (_target, launch) => {
      if (launch.argv[1] === '--version') return nodeVersion;
      const child = spawn(launch.argv[0], [...launch.argv.slice(1)], { env: { ...process.env, TMPDIR: join(f.root, 'tmp') }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
      let output = '', error = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { error += b.toString(); });
      const code = await new Promise<number | null>(r => child.once('close', r));
      if (code !== 0) throw new Error(error); return output.trim();
    };
  return { targets: async () => [{ machine: f.target.on, nodePath: process.execPath, coreStartedAt: 'start' }], inspect: async () => ({ failures: [] }), launchHistory: async () => [], probeMachineNode, probeRuntimeRoot: probeMachineNode };
}

test('setup accepts the supported remote Node 22.18.0 without lowering the package engine', async () => {
  const f = await fixture('v22.18.0');
  f.parts.probeMachineNode = async () => { throw new Error('An unchanged supported destination must not require a new Node probe'); };
  expect((await setupHerdr(f.request, f.parts)).probes).toEqual([]);
  expect(await f.execute("console.log('supported')")).toMatchObject({ outcome: 'exited', stdout: 'supported\n' });
  expect(JSON.parse(await readFile(resolve('package.json'), 'utf8')).engines.node).toBe('>=22.19.0');
}, 15000);

test('setup refuses remote Node 22.17.9 below the supported boundary', async () => {
  await expect(fixture('v22.17.9')).rejects.toMatchObject({ code: 'remote-node-unavailable', message: expect.stringContaining('22.18.0') });
});

test('doctor accepts the supported remote Node 22.18.0', async () => {
  const f = await fixture();
  const report = await doctorHerdr(f.request, await doctorParts(f, 'v22.18.0'));
  expect(report.failures.filter(failure => failure.item === 'remote-node')).toEqual([]);
}, 15000);

test.each(['missing', 'permissive'])('doctor detects a %s runtime root even with a correct installed runtime digest', async state => {
  const f = await fixture();
  if (state === 'missing') await rm(f.target.directory, { recursive: true }); else await chmod(f.target.directory, 0o755);
  const report = await doctorHerdr(f.request, await doctorParts(f));
  expect(report.failures).toContainEqual(expect.objectContaining({ item: 'runtime-root', repair: expect.stringMatching(/rerun.*setup/i) }));
}, 15000);

test('remote execution strips both local PATH spellings before writing the destination request', async () => {
  const f = await fixture();
  f.ports.environmentPolicy = env => ({ ...env, PATH: '/local-shim:/local-tools', Path: '/local-shim' });
  const result = await f.execute("console.log(process.env.PATH);console.log(process.env.Path ?? 'absent')");
  expect(result).toMatchObject({ outcome: 'exited', stdout: '/usr/bin:/bin\nabsent\n' });
  const request = JSON.parse(await readFile(join(f.jobs[0].remoteDirectory, 'request.json'), 'utf8'));
  expect(request.env).not.toHaveProperty('PATH'); expect(request.env).not.toHaveProperty('Path');
}, 15000);

test('the runtime ignores local PATH overrides embedded in a wire request', async () => {
  const f = await fixture(); const start = f.ports.jobs.start;
  f.ports.jobs.start = (prepare, ...rest) => start(async () => { const program = await prepare(); return { ...program, env: { ...program.env, PATH: '/local-shim', Path: '/local-shim' } }; }, ...rest);
  expect(await f.execute("console.log(process.env.PATH);console.log(process.env.Path ?? 'absent')")).toMatchObject({ outcome: 'exited', stdout: '/usr/bin:/bin\nabsent\n' });
}, 15000);
