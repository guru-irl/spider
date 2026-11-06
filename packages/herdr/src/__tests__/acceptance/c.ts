// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { prepareRemoteProgram } from '../../../../context/src/remote-plan.js';
import { registerExecActions } from '../../../../context/src/actions/exec.js';
import { createRemoteExecutor, type RemoteExecutionPorts } from '../../remote/execute.js';
import { collectRemoteChunks, createFileLogSink, ensureRemoteRuntime, type RemoteLogLocation } from '../../remote/transfer.js';
import { sha256, type RuntimeRequest } from '../../remote/runtime.js';
import { HERDR_LABELS, HERDR_KINDS, type JobPort, type JobId, type JobHandle, type TerminalFinish, type TerminalSummary, type RuntimeTarget, type TerminalAddress } from '../../contracts.js';
import type { HerdrHarness } from '../testutil.js';

export interface RemoteTestFixture {
  ports: RemoteExecutionPorts;
  started: JobHandle[]; detached: JobId[]; consumed: JobId[]; cancellations: { id: JobId; reason: string }[];
  transportLost: boolean;
}
/** Test-only stand-in for the job monitor, never a production JobPort or a claim of composed pane/notice acceptance. */
export async function createRemoteTestFixture(h: HerdrHarness): Promise<RemoteTestFixture> {
  if (!h.owner) throw new Error('Start the isolated harness before remote tests');
  const on = 'remote.invalid' as RuntimeTarget['on']; const runtimePath = join(h.directories.remote, 'remote-runtime.mjs');
  if (h.mode === 'fake') await h.scenario({ steps: [{ argvPrefix: ['file', 'read'], argvIncludes: [runtimePath], once: true, stderr: { error: { kind: 'not_found', message: 'Runtime is not installed' } }, exitCode: 3 }] }, 'remote');
  const runtimeBytes = Buffer.from(stripTypeScriptTypes(await readFile(fileURLToPath(new URL('../../remote/runtime.ts', import.meta.url)), 'utf8')));
  await ensureRemoteRuntime(h.hc, on, runtimePath, runtimeBytes, sha256(runtimeBytes));
  const stream = h.hc.events(); await stream.ready;
  const programRoot = join(h.directories.remote, 'programs');
  const install = await h.hc.run({ argv: [h.nodeBinary, runtimePath, '--install', programRoot], cwd: null, on, labels: { [HERDR_LABELS.kind]: HERDR_KINDS.setupProbe }, noNotify: true, background: true, outliveParent: true });
  const installDeadline = Date.now() + 5000; let installed = await stream.lookup(install.address);
  while (installed?.state !== 'finished' && Date.now() < installDeadline) { await new Promise(r => setTimeout(r, 25)); installed = await stream.lookup(install.address); }
  if (installed?.exitCode !== 0) throw new Error('Destination runtime root install failed');
  const locations = new Map<JobId, RemoteLogLocation>();
  const started: JobHandle[] = [], detached: JobId[] = [], consumed: JobId[] = [], cancellations: { id: JobId; reason: string }[] = [];
  const unsubscribers: (() => void)[] = [];
  const terminalFinish = (summary: TerminalSummary): TerminalFinish => ({ exitCode: summary.exitCode, reason: summary.reason ?? 'unknown', signal: summary.signal, finishedAt: summary.finishedAt ?? 0 });
  const jobs: JobPort = {
    start: async (prepare, owner, machine) => {
      const program = await prepare();
      const id = randomUUID() as JobId, nonce = randomBytes(16).toString('hex');
      const remoteDirectory = program.directory; const localDirectory = join(h.directories.local, id);
      await mkdir(localDirectory, { recursive: true });
      for (const file of program.files) await h.hc.fileWrite(machine, file.path, file.bytes);
      const request: RuntimeRequest = { version: 1, jobId: id, nonce, programNonce: program.files[0].bytes.toString(), argv: program.argv, cwd: program.cwd, env: program.env, files: program.files.map(f => ({ path: f.path, sha256: f.sha256 })), releaseWindowMs: 10000, ...(program.consoleDirectory ? { consoleDirectory: program.consoleDirectory } : {}) };
      const bytes = Buffer.from(JSON.stringify(request)), requestPath = join(remoteDirectory, 'request.json');
      await h.hc.fileWrite(machine, requestPath, bytes); await h.hc.fileWrite(machine, requestPath + '.sha256', Buffer.from(sha256(bytes)));
      await writeFile(join(localDirectory, 'job.json'), JSON.stringify({ id, requestSha256: sha256(bytes), nonce, remoteDirectory }));
      locations.set(id, { on: machine, directory: remoteDirectory, jobId: id, nonce, requestSha256: sha256(bytes) });
      let address: TerminalAddress | null = null;
      let settle!: (finish: TerminalFinish) => void;
      const finished = new Promise<TerminalFinish>(resolve => { settle = resolve; });
      const unsubscribe = stream.subscribe(event => {
        if (event.type === 'finished' && event.terminal === address) settle(event.data);
        if (event.type === 'snapshot' || event.type === 'missed') { const row = event.terminals.find(t => t.address === address && t.state === 'finished'); if (row) settle(terminalFinish(row)); }
      }); unsubscribers.push(unsubscribe);
      const terminal = await h.hc.run({ argv: [h.nodeBinary, runtimePath, requestPath], cwd: program.cwd, on: machine, labels: { [HERDR_LABELS.job]: id, [HERDR_LABELS.session]: owner.sessionId, [HERDR_LABELS.ownerCore]: owner.terminal.coreId, [HERDR_LABELS.ownerTerminal]: owner.terminal.terminalId, [HERDR_LABELS.kind]: HERDR_KINDS.exec }, background: true, outliveParent: true, noNotify: true });
      address = terminal.address;
      const deadline = Date.now() + 5000; let ready = '';
      while (!ready.includes(nonce) && Date.now() < deadline) { ready = await h.hc.read(address, { lines: 20 }); if (!ready.includes(nonce)) await new Promise(r => setTimeout(r, 25)); }
      if (!ready.includes(nonce)) throw new Error('Test runtime did not become ready');
      // This test-only release proves the runtime handshake, not the observer's owner-pane acknowledgement.
      await h.hc.fileWrite(machine, join(remoteDirectory, 'release.json'), Buffer.from(JSON.stringify({ version: 1, jobId: id, nonce, requestSha256: sha256(bytes) })));
      const snapshot = await stream.lookup(address); if (snapshot?.state === 'finished') settle(terminalFinish(snapshot));
      const handle: JobHandle = { id, address, remoteDirectory, localDirectory, finished, cancel: async reason => {
        cancellations.push({ id, reason }); await h.hc.kill(address!);
        const summary = await h.hc.get(address!); if (summary.state === 'finished') settle(terminalFinish(summary));
      } };
      started.push(handle); return handle;
    },
    detach: async id => { detached.push(id); },
    consumeNotice: async id => { consumed.push(id); },
    toolReturned: async () => {},
    dispose: () => { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); },
  };
  const collectionClient = { ...h.hc, fileRead: async (machine: RuntimeTarget['on'], path: string) => {
    try { return await h.hc.fileRead(machine, path); }
    catch (error) {
      const e = error as { code?: string; message?: string };
      if (h.mode === 'fake' && e.code === 'invalid_params' && e.message?.startsWith('ENOENT:')) throw Object.assign(new Error('File is not published yet'), { code: 'not_found' });
      throw error;
    }
  } };
  const fixture: RemoteTestFixture = {
    started, detached, consumed, cancellations, transportLost: false,
    ports: {
      hc: h.hc, jobs, clock: Date.now, environmentPolicy: env => ({ ...env }), prepare: prepareRemoteProgram,
      target: async machine => {
        if (machine !== on) throw Object.assign(new Error('Missing machine'), { code: 'machine-not-found' });
        return { on, cwd: h.directories.remote, directory: programRoot, commands: { javascript: [h.nodeBinary], python: ['/usr/bin/python3'], shell: ['/bin/sh'] }, environment: {}, nodePath: h.nodeBinary, runtimePath, runtimeSha256: sha256(runtimeBytes) };
      },
      logSink: async (job, options) => {
        const sink = await createFileLogSink(job.localDirectory, options); const location = locations.get(job.id)!;
        return { collect: async () => {
          if (fixture.transportLost) throw Object.assign(new Error('Transport unavailable'), { code: 'transport-loss' });
          const logs = await collectRemoteChunks(collectionClient, location, sink);
          if (logs.receipt) await writeFile(join(job.localDirectory, 'receipt.json'), JSON.stringify(logs.receipt));
          return logs;
        }, dispose() {} };
      },
    },
  };
  return fixture;
}

/** Injected-port scenario. Composed acceptance must supply the real job monitor instead of this stand-in. */
export async function acceptanceC(h: HerdrHarness): Promise<void> {
  const fixture = await createRemoteTestFixture(h);
  const handlers = new Map<string, (args: unknown, ctx: unknown) => Promise<{ text: string; details: unknown }>>();
  registerExecActions((name, handler) => handlers.set(name, handler));
  const ctx = { cwd: h.owner!.cwd, owner: h.owner!, remote: createRemoteExecutor(fixture.ports) };
  try {
    await h.hc.fileWrite('remote.invalid' as RuntimeTarget['on'], join(h.directories.remote, 'input.txt'), Buffer.from('destination-only value'));
    const code = await handlers.get('exec')!({ on: 'remote.invalid', language: 'javascript', code: "console.log('visible output'); console.error('diagnostic'); process.exitCode=23" }, ctx);
    expect(code.text).toContain('visible output'); expect(code.text).toContain('diagnostic'); expect(code.details).toMatchObject({ exitCode: 23, remote: { machine: 'remote.invalid' } });
    const file = await handlers.get('exec_file')!({ on: 'remote.invalid', path: 'input.txt', language: 'python', code: 'print(FILE_CONTENT.upper())' }, ctx);
    expect(file.details).toMatchObject({ stdout: 'DESTINATION-ONLY VALUE\n', exitCode: 0 });
    const batch = await handlers.get('batch')!({ on: 'remote.invalid', commands: [{ language: 'shell', code: 'echo one' }, { language: 'shell', code: 'echo two' }] }, ctx);
    expect(batch.details).toMatchObject([{ stdout: 'one\n', remote: { machine: 'remote.invalid' } }, { stdout: 'two\n', remote: { machine: 'remote.invalid' } }]);
    expect(fixture.started).toHaveLength(4); expect(fixture.consumed).toHaveLength(4);
    await expect(handlers.get('exec')!({ on: 'missing.invalid', language: 'shell', code: 'echo wrong' }, ctx)).rejects.toMatchObject({ code: 'machine-not-found' });
    if (h.mode === 'fake') {
      const calls = await h.calls(); const remoteLaunches = calls.filter(c => c.argv[0] === 'run' && c.argv.includes('--on') && !c.argv.includes('--install'));
      expect(remoteLaunches).toHaveLength(4);
      for (const call of remoteLaunches) { expect(call.argv).toContain('--no-notify'); expect(call.argv).not.toContain('--parent'); expect(call.env.HC_TERMINAL_ID).toBe(h.owner!.terminal.terminalId); }
      expect(JSON.stringify(remoteLaunches)).not.toContain('destination-only value');
    }
  } finally { await fixture.ports.jobs.dispose(); }
}
