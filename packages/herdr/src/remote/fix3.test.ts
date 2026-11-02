// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { createProductionHerdrCliPorts, createHostHerdrPorts } from '../../../host/src/herdr/ports.js';
import { setupHerdr, type SetupParts, type SetupRequest } from '../setup/installer.js';
import { parseHerdrConfig } from '../config.js';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import { executeRemote, type RemoteExecutionPorts } from './execute.js';
import { sha256, installRuntimeDirectory } from './runtime.js';
import { createJobMonitor, type JobNotice } from '../jobs/monitor.js';
import { createJobStore, type JournalJob } from '../jobs/store.js';
import { doctorHerdr, type DoctorParts } from '../setup/doctor.js';
import type { HcClient, JobRecord, JobHandle, JobId, Owner, MachineName, TerminalAddress } from '../contracts.js';

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
    jobs: { start: async (program, owner, machine) => {
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
  f.ports.jobs.start = (program, ...rest) => start({ ...program, env: { ...program.env, PATH: '/local-shim', Path: '/local-shim' } }, ...rest);
  expect(await f.execute("console.log(process.env.PATH);console.log(process.env.Path ?? 'absent')")).toMatchObject({ outcome: 'exited', stdout: '/usr/bin:/bin\nabsent\n' });
}, 15000);
