// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, chmod, stat, access, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { collectRemoteChunks, createFileLogSink, ensureRemoteRuntime, type LogSink, type RemoteLogLocation } from '../remote/transfer.js';
import { createHerdrHarness } from './testutil.js';
import { stripTypeScriptTypes } from 'node:module';
import { probeRuntimeDirectory, installRuntimeDirectory, verifyProgramMarker, pruneSettledPrograms, readBoundedFile } from '../remote/runtime.js';
import type { HcClient, MachineName } from '../contracts.js';
const roots: string[] = [];
const processes = new Set<ReturnType<typeof spawn>>();
const launchDiagnostics = new Map<string, () => object>();
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
afterEach(async context => {
  try {
    if (process.env.SPIDER_HERDR_RUNTIME_DIAGNOSTICS === '1' || context.task.result?.state === 'fail') {
      const directory = resolve('.spider/scratch/h/logs/runtime-diagnostics'); await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const parent of roots) {
        const program = join(parent, 'a'.repeat(32)); const files: Record<string, object> = {};
        for (const name of ['request.json', 'request.json.sha256', 'receipt.json', 'receipt.json.sha256', 'index.json', '.spider-program', 'payload.cjs', 'stdout.log', 'stderr.log']) {
          try {
            const bytes = await readFile(join(program, name));
            files[name] = { bytes: bytes.length, sha256: hash(bytes), ...(name.endsWith('.json') ? { value: JSON.parse(bytes.toString()) } : {}) };
          } catch (error) { files[name] = { error: (error as NodeJS.ErrnoException).code ?? String(error) }; }
        }
        const rootStat = await stat(parent).catch(() => null);
        await writeFile(join(directory, parent.split('/').pop()! + '.json'), JSON.stringify({ testName: context.task.name, fixture: 'direct Node destination runtime; no hc install or PATH binary lookup', parent, nodeVersion: process.version, rootMode: rootStat ? rootStat.mode & 0o777 : null, launch: launchDiagnostics.get(parent)?.(), files }, null, 2), { mode: 0o600 });
      }
    }
  } finally {
    for (const proc of processes) if (proc.exitCode === null && proc.signalCode === null) { const closed = new Promise<void>(r => proc.once('close', () => r())); proc.kill('SIGKILL'); await closed; }
    processes.clear(); launchDiagnostics.clear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  }
});
async function runtime(code: string, options: { args?: string[]; deadline?: number; argv?: string[]; cwd?: string | null; digest?: string; direct?: boolean; console?: boolean; slowChunkWrites?: boolean; initialReleaseSha?: string } = {}) {
  const base = resolve('.spider/scratch/h'); await mkdir(base, { recursive: true });
  const parent = await mkdtemp(join(base, 'runtime-')); roots.push(parent);
  const root = join(parent, 'a'.repeat(32)); await mkdir(root, { mode: 0o700 });
  const programNonce = 'f'.repeat(32); const marker = join(root, '.spider-program'); await writeFile(marker, programNonce);
  const source = join(root, 'payload.cjs'); await writeFile(source, code);
  const nonce = '0123456789abcdef0123456789abcdef';
  const consoleDirectory = join(parent, '.consoles', 'agent');
  if (options.console) { await mkdir(consoleDirectory, { recursive: true }); await writeFile(join(consoleDirectory, 'heartbeat.json'), JSON.stringify({ version: 1, at: Date.now() })); }
  const request = { version: 1, jobId: 'job', nonce, programNonce, argv: options.argv ?? [process.execPath, source, ...(options.args ?? [])], cwd: options.cwd === undefined ? root : options.cwd, env: {}, files: [{ path: marker, sha256: hash(programNonce) }, { path: source, sha256: options.digest ?? hash(code) }], releaseWindowMs: options.deadline === undefined ? 10000 : Math.max(1, options.deadline - Date.now()), ...(options.console ? { consoleDirectory } : {}) };
  const requestPath = join(root, 'request.json'); const bytes = JSON.stringify(request);
  await writeFile(requestPath, bytes); await writeFile(requestPath + '.sha256', hash(bytes));
  const wrapper = join(root, 'wrapper.mjs');
  await writeFile(wrapper, `import { runRemoteRuntime } from ${JSON.stringify(fileURLToPath(new URL('../remote/runtime.ts', import.meta.url)))}; process.exitCode = await runRemoteRuntime(${JSON.stringify(requestPath)});`);
  let command = [wrapper];
  if (options.direct) {
    const artifact = join(root, 'remote-runtime.mjs');
    await writeFile(artifact, stripTypeScriptTypes(await readFile(fileURLToPath(new URL('../remote/runtime.ts', import.meta.url)), 'utf8')));
    command = [artifact, requestPath];
    if (options.slowChunkWrites) {
      await writeFile(wrapper, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original=fs.promises.open;fs.promises.open=async(path,...args)=>{const file=await original(path,...args);if(String(path).includes('/chunk-')&&args[0]==='wx'){const write=file.writeFile.bind(file);file.writeFile=async(...values)=>{await new Promise(r=>setTimeout(r,20));return write(...values);};}return file;};syncBuiltinESMExports();
const {runRemoteRuntime}=await import(${JSON.stringify(artifact)});process.exitCode=await runRemoteRuntime(${JSON.stringify(requestPath)});`);
      command = [wrapper];
    }
  }
  if (options.initialReleaseSha) await writeFile(join(root, 'release.json'), JSON.stringify({ version: 1, jobId: 'job', nonce, requestSha256: options.initialReleaseSha }));
  const proc = spawn(process.execPath, command, { env: { ...process.env, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] }); processes.add(proc);
  let mirror = '', errors = ''; proc.stdout.on('data', b => { if (mirror.length < 1000) mirror += b.toString(); }); proc.stderr.on('data', b => { if (errors.length < 4000) errors += b.toString(); });
  launchDiagnostics.set(parent, () => ({ pid: proc.pid, argv: [process.execPath, ...command], PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS ?? null, exitCode: proc.exitCode, signal: proc.signalCode, stdoutPreview: mirror.slice(-1000), stderrPreview: errors.slice(-4000) }));
  const finished = new Promise<{ code: number | null; signal: string | null }>(r => proc.once('close', (code, signal) => r({ code, signal })));
  return { root, nonce, proc, finished, ready: async () => { const end = Date.now() + 2000; while (!mirror.includes(nonce) && proc.exitCode === null && proc.signalCode === null && Date.now() < end) await new Promise(r => setTimeout(r, 10)); },
    requestSha256: hash(bytes),
    release: () => writeFile(join(root, 'release.json'), JSON.stringify({ version: 1, jobId: 'job', nonce, requestSha256: hash(bytes) })),
    log: (stream: string) => readFile(join(root, stream + '.log')).catch(() => Buffer.alloc(0)),
    receipt: async () => JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8')),
    started: async () => !!(await readFile(join(root, 'started')).catch(() => null)), mirror: () => mirror, errors: () => errors };
}
function fileClient(): HcClient {
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected external operation'); };
  return { identity: unsupported, caller: unsupported, machines: unsupported, run: unsupported, get: unsupported, read: unsupported, kill: unsupported, rm: unsupported, setLabels: unsupported, fileWrite: unsupported, events: () => { throw new Error('Unexpected events'); }, fileRead: async (_on, path) => readFile(path) };
}
function memorySink(maxCaptureBytes = 100 * 1024 * 1024) {
  const data = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const sink: LogSink = { position: stream => data[stream].length, write: async (stream, offset, bytes) => { if (offset !== data[stream].length) throw new Error('Output gap'); data[stream] = Buffer.concat([data[stream], bytes]); }, read: async (stream, maxBytes) => data[stream].subarray(0, maxBytes), maxCaptureBytes, finish() {} };
  return { sink, data };
}
async function location(job: Awaited<ReturnType<typeof runtime>>): Promise<RemoteLogLocation> {
  return { on: 'remote.invalid' as MachineName, directory: job.root, nonce: job.nonce, jobId: 'job', requestSha256: hash(await readFile(join(job.root, 'request.json'))) };
}
async function runtimeThroughHc(mode: 'fake' | 'hc'): Promise<void> {
  const h = await createHerdrHarness(mode);
  try {
    await h.start(); expect(h.localCoreId).not.toBe(h.remoteCoreId);
    expect(h.localSocket).toContain(h.root); expect(h.remoteSocket).toContain(h.root);
    const on = 'remote.invalid' as MachineName;
    const runtimePath = join(h.directories.remote, 'remote-runtime.mjs');
    const programRoot = join(h.directories.remote, 'programs'), directory = join(programRoot, 'a'.repeat(32));
    if (mode === 'fake') await h.scenario({ steps: [{ argvPrefix: ['file', 'read'], argvIncludes: [runtimePath], once: true, stderr: { error: { kind: 'not_found', message: 'Runtime is not installed' } }, exitCode: 3 }] }, 'remote');
    const runtimeSource = Buffer.from(stripTypeScriptTypes(await readFile(fileURLToPath(new URL('../remote/runtime.ts', import.meta.url)), 'utf8')));
    await ensureRemoteRuntime(h.hc, on, runtimePath, runtimeSource, hash(runtimeSource));
    const writesBefore = (await h.calls()).filter(c => c.argv[0] === 'file' && c.argv[1] === 'write').length;
    await ensureRemoteRuntime(h.hc, on, runtimePath, runtimeSource, hash(runtimeSource));
    expect((await h.calls()).filter(c => c.argv[0] === 'file' && c.argv[1] === 'write')).toHaveLength(writesBefore);
    const events = h.hc.events(); await events.ready;
    const installed = await h.hc.run({ argv: [h.nodeBinary, runtimePath, '--install', programRoot], cwd: null, on, labels: {}, noNotify: true, background: true, outliveParent: true });
    const installDeadline = Date.now() + 5000; let probe = await events.lookup(installed.address);
    while (probe?.state !== 'finished' && Date.now() < installDeadline) { await new Promise(r => setTimeout(r, 25)); probe = await events.lookup(installed.address); }
    expect(probe).toMatchObject({ exitCode: 0, state: 'finished' });
    const programNonce = 'f'.repeat(32), markerPath = join(directory, '.spider-program'); await h.hc.fileWrite(on, markerPath, Buffer.from(programNonce));
    const sourcePath = join(directory, 'echo.cjs'); const source = "console.log(process.argv[2]); console.error('diagnostic'); process.stdin.resume(); process.stdin.on('end',()=>{console.log('EOF'); process.exitCode=23});";
    await h.hc.fileWrite(on, sourcePath, Buffer.from(source));
    const nonce = '0123456789abcdef0123456789abcdef', requestPath = join(directory, 'request.json');
    const requestBytes = Buffer.from(JSON.stringify({ version: 1, jobId: 'job', nonce, programNonce, argv: [h.nodeBinary, sourcePath, "a 'quoted' value"], cwd: null, env: { PATH: '/must-not-import-controller-path', SPIDER_HERDR_SSH_BYPASS: '1' }, files: [{ path: markerPath, sha256: hash(programNonce) }, { path: sourcePath, sha256: hash(source) }], releaseWindowMs: 10000 }));
    await h.hc.fileWrite(on, requestPath, requestBytes); await h.hc.fileWrite(on, requestPath + '.sha256', Buffer.from(hash(requestBytes)));
    const terminal = await h.hc.run({ argv: [h.nodeBinary, runtimePath, requestPath], cwd: null, on, labels: {}, noNotify: true, background: true, outliveParent: true });
    const readyDeadline = Date.now() + 5000; let screen = '';
    while (!screen.includes(nonce) && Date.now() < readyDeadline) { screen = await h.hc.read(terminal.address, { lines: 20 }); if (!screen.includes(nonce)) await new Promise(r => setTimeout(r, 25)); }
    expect(screen).toContain(nonce);
    await h.hc.fileWrite(on, join(directory, 'release.json'), Buffer.from(JSON.stringify({ version: 1, jobId: 'job', nonce, requestSha256: hash(requestBytes) })));
    const deadline = Date.now() + 5000; let summary = await events.lookup(terminal.address);
    while (summary?.state !== 'finished' && Date.now() < deadline) { await new Promise(r => setTimeout(r, 25)); summary = await events.lookup(terminal.address); }
    expect(summary).toMatchObject({ state: 'finished', exitCode: 23 });
    const sink = await createFileLogSink(join(h.directories.local, 'logs'));
    const logs = await collectRemoteChunks(h.hc, { on, directory, jobId: 'job', nonce, requestSha256: hash(requestBytes) }, sink);
    expect(logs).toMatchObject({ stdout: "a 'quoted' value\nEOF\n", stderr: 'diagnostic\n', complete: true, receipt: { outcome: 'exited', exitCode: 23 } });
    if (mode === 'fake') {
      const launches = (await h.calls()).filter(c => c.argv[0] === 'run' && c.argv.includes('--on') && !c.argv.includes('--install'));
      expect(launches).toHaveLength(1); expect(launches[0].argv).toContain('--no-notify'); expect(launches[0].argv).not.toContain('--parent'); expect(launches[0].argv).not.toContain('--cwd');
    }
  } finally {
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
    await mkdir(resolve('.spider/scratch/h/logs'), { recursive: true });
    await writeFile(resolve(`.spider/scratch/h/logs/c2-${mode}-cleanup.json`), JSON.stringify(h.cleanupProof, null, 2));
  }
}
describe('destination runtime', () => {
  it('records launch and finish on the destination clock after release', async () => {
    const job = await runtime('setTimeout(() => {}, 50)', { direct: true });
    await job.ready(); await new Promise(resolve => setTimeout(resolve, 120));
    const releasedAt = Date.now(); await job.release();
    expect((await job.finished).code).toBe(0);
    const receipt = await job.receipt();
    expect(receipt.startedAt).toBeTypeOf('number');
    expect(receipt.startedAt).toBeGreaterThanOrEqual(releasedAt);
    expect(receipt.finishedAt).toBeGreaterThanOrEqual(receipt.startedAt + 50);
    expect(receipt.finishedAt).toBeLessThanOrEqual(Date.now());
    const collected = await collectRemoteChunks(fileClient(), await location(job), memorySink().sink);
    expect(collected.receipt?.startedAt).toBe(receipt.startedAt);
  });
  it('creates a console hold before readiness and before the shortest payload can settle', async () => {
    const job = await runtime('process.exitCode=0', { console: true, direct: true }); await job.ready();
    await expect(access(join(job.root, '.spider-console-hold'))).resolves.toBeUndefined();
    const hold = JSON.parse(await readFile(join(job.root, '.spider-console-hold'), 'utf8'));
    expect(hold).toMatchObject({ version: 1, consoleDirectory: join(job.root, '..', '.consoles', 'agent') });
    expect(await job.started()).toBe(false); await job.release(); expect((await job.finished).code, job.errors()).toBe(0);
    await expect(access(join(job.root, '.spider-console-hold'))).resolves.toBeUndefined();
  });
  it('retries a concurrently growing and partially published release until a complete bound packet arrives', async () => {
    for (let iteration = 0; iteration < 4; iteration++) {
      const job = await runtime("require('fs').writeFileSync('started','yes');process.exitCode=23", { direct: true });
      const path = join(job.root, 'release.json'); await writeFile(path, '{');
      const writer = (async () => { for (let write = 0; write < 20; write++) { await appendFile(path, ' '); await new Promise(r => setTimeout(r, 2)); } })();
      await job.ready(); await writer;
      expect(await job.started()).toBe(false);
      await job.release(); expect((await job.finished).code, JSON.stringify(await job.receipt())).toBe(23);
      expect(await job.started()).toBe(true);
    }
  }, 15000);
  it('keeps direct runtime fixture folders disjoint when another completed fixture is removed', async () => {
    const one = await runtime('process.exitCode=23'), two = await runtime("require('fs').writeFileSync('started','yes');process.exitCode=23");
    expect(dirname(one.root)).not.toBe(dirname(two.root)); await one.ready(); await two.ready();
    await one.release(); expect((await one.finished).code).toBe(23); await rm(dirname(one.root), { recursive: true, force: true });
    await expect(access(join(two.root, 'wrapper.mjs'))).resolves.toBeUndefined();
    await two.release(); expect((await two.finished).code).toBe(23); expect(await two.started()).toBe(true);
  });
  it('publishes complete chunk snapshots while strict readers race the payload writer', async () => {
    const job = await runtime("process.stdout.write('x'.repeat(3*1024*1024));process.exitCode=23", { direct: true, slowChunkWrites: true }); await job.ready();
    let completed = false; void job.finished.then(() => { completed = true; }); await job.release();
    let next = 0; const failures: string[] = [];
    while (true) {
      try { JSON.parse((await readBoundedFile(join(job.root, `chunk-${String(next).padStart(8, '0')}.json`), 128 * 1024)).toString()); next++; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (completed) break; } else if (failures.length < 3) failures.push(String(error)); await new Promise(r => setTimeout(r, 1)); }
    }
    expect((await job.finished).code).toBe(23); expect(next).toBeGreaterThan(0); expect(failures).toEqual([]);
  }, 10000);
  it('a mismatched request checksum remains unpublished through the release deadline', async () => {
    const job = await runtime("require('fs').writeFileSync('started','yes')", { deadline: Date.now() + 2000, direct: true, initialReleaseSha: '0'.repeat(64) }); await job.ready();
    expect((await job.finished).code).toBe(124); expect((await job.receipt()).outcome).toBe('release-timeout'); expect(await job.started()).toBe(false);
  });
  it('a complete release with a different request checksum cannot run the payload', async () => {
    const job = await runtime("require('fs').writeFileSync('started','yes');process.exitCode=23", { direct: true }); await job.ready();
    await writeFile(join(job.root, 'release.json'), JSON.stringify({ version: 1, jobId: 'job', nonce: job.nonce, requestSha256: '0'.repeat(64) }));
    await new Promise(r => setTimeout(r, 50)); expect(await job.started()).toBe(false);
    await job.release(); expect((await job.finished).code).toBe(23); expect(await job.started()).toBe(true);
  });
  it('a payload that reads stdin gets EOF and exits with exact separate logs', async () => {
    const job = await runtime(`require('fs').writeFileSync('started','yes'); console.log(process.argv[2]); console.error('diagnostic'); process.stdin.resume(); process.stdin.on('end',()=>{console.log('EOF'); process.exitCode=23});`, { args: ["a 'quoted' value"] });
    await job.ready(); expect(await job.started()).toBe(false);
    await job.release(); const finished = await job.finished;
    expect(finished.code, job.errors()).toBe(23);
    expect((await job.log('stdout')).toString()).toBe("a 'quoted' value\nEOF\n");
    expect((await job.log('stderr')).toString()).toBe('diagnostic\n'); expect(finished.code).toBe(23);
    expect(job.mirror()).toContain(job.nonce);
    expect(await job.receipt()).toMatchObject({ outcome: 'exited', exitCode: 23, stdoutBytes: 21, stderrBytes: 11 });
  });
  it('an existing program directory with a different owner marker refuses before any payload runs', async () => {
    const job = await runtime("require('fs').writeFileSync('started','yes')");
    const marker = join(job.root, '.spider-program'); await writeFile(marker, 'e'.repeat(32));
    await expect(verifyProgramMarker(job.root, 'f'.repeat(32))).rejects.toMatchObject({ code: 'program-marker-mismatch' });
    await job.release(); expect((await job.finished).code).not.toBe(0); expect(await job.started()).toBe(false);
  });
  it.each(['marker', 'source'])('refuses %s tampering after readiness but before release', async kind => {
    const job = await runtime("require('fs').writeFileSync('started','yes')"); await job.ready();
    if (kind === 'marker') await writeFile(join(job.root, '.spider-program'), 'e'.repeat(32));
    else await writeFile(join(job.root, 'payload.cjs'), "require('fs').writeFileSync('started','wrong')");
    await job.release(); expect((await job.finished).code).not.toBe(0); expect(await job.started()).toBe(false);
  });
  it('a 0700 destination probe refuses a permissive or symlink root without changing it', async () => {
    const job = await runtime("console.log('unused')");
    const root = join(job.root, 'runtime-root'); await mkdir(root, { mode: 0o755 });
    await expect(probeRuntimeDirectory(root)).rejects.toMatchObject({ code: 'runtime-root-unprivate' });
    await expect(installRuntimeDirectory(root)).rejects.toMatchObject({ code: 'runtime-root-unprivate' });
    await chmod(root, 0o700); expect(await probeRuntimeDirectory(root)).toMatchObject({ mode: 0o700, uid: process.getuid!() });
    const alias = join(job.root, 'alias'); await symlink(root, alias);
    await expect(probeRuntimeDirectory(alias)).rejects.toMatchObject({ code: 'runtime-root-invalid' });
  });
  it('prunes only directly settled folders and never follows symlinks or deletes an active directory', async () => {
    const job = await runtime("console.log('unused')"); const root = join(job.root, 'programs'); await mkdir(root, { mode: 0o700 });
    for (const name of ['done', 'active', 'unmarked', 'nested']) await mkdir(join(root, name));
    await writeFile(join(root, 'done/.spider-settled'), 'settled'); await writeFile(join(root, 'active/.spider-settled'), 'settled');
    await mkdir(join(root, 'nested/child')); await writeFile(join(root, 'nested/child/.spider-settled'), 'settled');
    const outside = join(job.root, 'outside'); await mkdir(outside); await writeFile(join(outside, '.spider-settled'), 'settled'); await symlink(outside, join(root, 'link'));
    await symlink(join(outside, '.spider-settled'), join(root, 'unmarked/.spider-settled'));
    expect(await pruneSettledPrograms(root, join(root, 'active'))).toEqual([join(root, 'done')]);
    expect((await readdir(root)).sort()).toEqual(['active', 'link', 'nested', 'unmarked']); expect(await readFile(join(outside, '.spider-settled'), 'utf8')).toBe('settled');
  });
  it('the built-in-only runtime artifact executes directly with its request argv', async () => {
    const job = await runtime("console.log('direct artifact');process.exitCode=23", { direct: true });
    await job.ready(); await job.release(); expect((await job.finished).code, job.errors()).toBe(23);
    expect((await job.log('stdout')).toString()).toBe('direct artifact\n'); expect(await job.receipt()).toMatchObject({ exitCode: 23, outcome: 'exited' });
  });
  it('an owner crash before release expires without starting the payload', async () => {
    const job = await runtime("require('fs').writeFileSync('started','yes'); console.log('wrong')", { deadline: Date.now() + 60000 });
    expect((await job.finished).code).toBe(124);
    expect(await job.started()).toBe(false); expect(await job.log('stdout')).toHaveLength(0);
    expect(await job.receipt()).toMatchObject({ outcome: 'release-timeout', exitCode: null });
  }, 15000);
  it('cancellation before release starts no payload', async () => {
    const job = await runtime("require('fs').writeFileSync('started','yes')"); await job.ready(); job.proc.kill('SIGHUP');
    expect((await job.finished).signal).toBe('SIGHUP'); expect(await job.started()).toBe(false);
    expect(await job.receipt()).toMatchObject({ outcome: 'signal', signal: 'SIGHUP', exitCode: null });
  });
  it('retries a torn cancellation file before release and cancels without launching', async () => {
    const job = await runtime("require('fs').writeFileSync('started','yes')"); await job.ready();
    await writeFile(join(job.root, 'cancel.json'), '{');
    const early = await Promise.race([job.finished, new Promise<null>(resolve => setTimeout(() => resolve(null), 300))]);
    expect(early).toBeNull();
    await writeFile(join(job.root, 'cancel.json'), JSON.stringify({ version: 1, jobId: 'job', nonce: job.nonce }));
    expect((await job.finished).code).toBe(137);
    expect(await job.started()).toBe(false);
    expect(await job.receipt()).toMatchObject({ outcome: 'cancelled', exitCode: 137 });
  });
  it('forwards the observed signal after release and persists it before wrapper termination', async () => {
    const job = await runtime("require('fs').writeFileSync('started','yes'); setInterval(()=>{},1000)"); await job.ready(); await job.release();
    const deadline = Date.now() + 2000; while (!(await job.started()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    expect(await job.started()).toBe(true); job.proc.kill('SIGHUP');
    expect((await job.finished).signal).toBe('SIGHUP');
    expect(await job.receipt()).toMatchObject({ outcome: 'signal', signal: 'SIGHUP', exitCode: null });
  });
  it.each([
    ['source digest mismatch', { digest: '0'.repeat(64) }],
    ['invalid cwd', { cwd: '/nonexistent-spider-fixture-cwd' }],
    ['missing interpreter', { argv: ['/nonexistent-spider-fixture-interpreter'] }],
  ])('refuses %s without inventing a successful exit', async (_name, options) => {
    const job = await runtime("require('fs').writeFileSync('started','yes')", options); await job.ready(); await job.release();
    expect((await job.finished).code).not.toBe(0); expect(await job.started()).toBe(false);
    expect(await job.receipt()).toMatchObject({ outcome: 'spawn-error', exitCode: null });
  });
  it('reconstructs split UTF-8, binary bytes and more than 8 MiB without terminal-tail truncation', async () => {
    const job = await runtime("process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(()=>{process.stdout.write(Buffer.from([0x95,0xb8])); process.stderr.write(Buffer.alloc(9*1024*1024,255));},20)"); await job.ready(); await job.release(); const finished = await job.finished; expect(finished.code, (await job.receipt()).error ?? job.errors().slice(-2000)).toBe(0);
    const { sink, data } = memorySink(); const result = await collectRemoteChunks(fileClient(), await location(job), sink);
    expect(result).toMatchObject({ stdout: '🕸', complete: true, stdoutBytes: 4, stderrBytes: 9 * 1024 * 1024 });
    expect(data.stderr.equals(Buffer.alloc(9 * 1024 * 1024, 255))).toBe(true); expect(data.stdout).toEqual(Buffer.from('🕸'));
    const index = JSON.parse(await readFile(join(job.root, 'index.json'), 'utf8'));
    expect(index.chunks.every((c: { bytes: number }) => c.bytes <= 48 * 1024)).toBe(true);
    expect(index.head).toMatchObject({ file: expect.stringMatching(/^page-[0-9]{8}\.json$/) });
    expect((await readFile(join(job.root, 'index.json'))).length).toBeLessThanOrEqual(64 * 1024);
    const first = data.stdout; await collectRemoteChunks(fileClient(), await location(job), sink); expect(data.stdout).toEqual(first);
  }, 20000);
  it('rejects chunk corruption, foreign receipt nonces and local symlinks', async () => {
    const job = await runtime("console.log('payload')"); await job.ready(); await job.release(); await job.finished;
    const loc = await location(job); const index = JSON.parse(await readFile(join(job.root, 'index.json'), 'utf8'));
    const chunkPath = join(job.root, index.chunks[0].file), originalChunk = await readFile(chunkPath);
    await writeFile(chunkPath, JSON.stringify({ stream: 'stdout', offset: 0, data: Buffer.from('changed').toString('base64') }));
    await expect(collectRemoteChunks(fileClient(), loc, memorySink().sink)).rejects.toMatchObject({ code: 'remote-chunk-digest-mismatch' });
    await writeFile(chunkPath, originalChunk);
    const receiptPath = join(job.root, 'receipt.json'); const receipt = JSON.parse(await readFile(receiptPath, 'utf8')); receipt.nonce = 'foreign-nonce-000';
    const receiptBytes = JSON.stringify(receipt); await writeFile(receiptPath, receiptBytes); await writeFile(receiptPath + '.sha256', hash(receiptBytes));
    await expect(collectRemoteChunks(fileClient(), loc, memorySink().sink)).rejects.toMatchObject({ code: 'remote-receipt-mismatch' });
    const sinkDir = join(job.root, 'sink'); await mkdir(sinkDir); const trap = join(job.root, 'trap'); await writeFile(trap, 'untouched'); await symlink(trap, join(sinkDir, 'stdout.log'));
    await expect(createFileLogSink(sinkDir)).rejects.toMatchObject({ code: 'local-log-invalid' });
    expect(await readFile(trap, 'utf8')).toBe('untouched');
  });
  it('a resumed file sink repairs an unpublished crash tail before replaying chunks', async () => {
    const job = await runtime("console.log('payload')"); await job.ready(); await job.release(); const finished = await job.finished;
    expect(finished.code, (await job.receipt()).error ?? job.errors().slice(-2000)).toBe(0);
    const sinkDir = join(job.root, 'local-logs'); const first = await createFileLogSink(sinkDir);
    expect((await collectRemoteChunks(fileClient(), await location(job), first)).complete).toBe(true);
    await writeFile(join(sinkDir, 'stdout.log'), 'payload\nunfinished-tail');
    const resumed = await createFileLogSink(sinkDir); const result = await collectRemoteChunks(fileClient(), await location(job), resumed);
    expect(result).toMatchObject({ stdout: 'payload\n', stdoutBytes: 8, complete: true });
    expect((await readFile(join(sinkDir, 'stdout.log'))).toString()).toBe('payload\n');
  });
  it('a resumed file sink completes a split UTF-8 character without a replacement or duplicate prefix', async () => {
    const job = await runtime("console.log('unused')"); const sinkDir = join(job.root, 'local-logs');
    const first = await createFileLogSink(sinkDir); await first.write('stdout', 0, Buffer.from([0xf0, 0x9f]));
    const previews: string[] = []; const resumed = await createFileLogSink(sinkDir, { onData: text => previews.push(text) });
    await resumed.write('stdout', 2, Buffer.from([0x95, 0xb8])); resumed.finish();
    expect(previews).toEqual(['🕸']); expect(await readFile(join(sinkDir, 'stdout.log'))).toEqual(Buffer.from('🕸'));
  });
  it('uses the shared fake hc for runtime installation, released argv and exact chunks', async () => { await runtimeThroughHc('fake'); }, 20000);
  it.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('real isolated hc runtime without an app window (requires SPIDER_HERDR_E2E=1)', async () => { await runtimeThroughHc('hc'); }, 30000);
  it('collects all 20,000 lines and reports a missing chunk instead of silently using a tail', async () => {
    const job = await runtime("for(let i=0;i<20000;i++) console.log('line-'+i); console.error('diagnostic')"); await job.ready(); await job.release(); expect((await job.finished).code, JSON.stringify(await job.receipt())).toBe(0);
    const result = await collectRemoteChunks(fileClient(), await location(job), memorySink().sink);
    expect(result.stdout.split('\n')).toHaveLength(20001); expect(result.stdout).toMatch(/^line-0\n/); expect(result.stdout).toMatch(/line-19999\n$/); expect(result.stderr).toBe('diagnostic\n'); expect(result.complete).toBe(true);
    const chunks = (await readdir(job.root)).filter(name => name.startsWith('chunk-')); await rm(join(job.root, chunks[0]));
    const incomplete = await collectRemoteChunks(fileClient(), await location(job), memorySink().sink); expect(incomplete.complete).toBe(false); expect(incomplete.receipt).toBeNull();
  });
});
