// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { strict as assert } from 'node:assert';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { HerdrHarness } from '../testutil.js';
import type { JobRecord, Owner, PreparedProgram } from '../../contracts.js';
import { HERDR_LABELS, HERDR_KINDS } from '../../contracts.js';
import { createJobMonitor, type JobMonitorOptions, type JobNotice } from '../../jobs/monitor.js';
import { observerMarker } from '../../jobs/observer.js';
import { sha256 } from '../../remote/runtime.js';
import { parseFinish } from '../../jobs/store.js';

/** Test-only C port: real destination files and processes, never a production fallback runtime. */
function fixtureRuntime(job: JobRecord, nonce: string): string {
  return `// SPDX-License-Identifier: MIT
import { readFile, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const directory = ${JSON.stringify(job.remoteDirectory)}, nonce = ${JSON.stringify(nonce)}, jobId = ${JSON.stringify(job.id)};
console.log(${JSON.stringify(observerMarker(nonce))});
const deadline = Date.now() + 10000;
while (true) {
  try { const release = JSON.parse(await readFile(directory + '/release.json', 'utf8')); if (release.nonce === nonce && release.jobId === jobId) break; } catch {}
  if (Date.now() >= deadline) process.exit(71);
  await delay(10);
}
const child = spawn(process.execPath, ['-e', 'process.stdout.write("one-line\\\\n"); process.stderr.write("separate-error\\\\n"); process.exit(23)'], { stdio: ['ignore', 'pipe', 'pipe'] });
const out = [], err = [];
child.stdout.on('data', bytes => { out.push(bytes); process.stdout.write(bytes); });
child.stderr.on('data', bytes => { err.push(bytes); process.stderr.write(bytes); });
const code = await new Promise(resolve => child.once('close', resolve));
await writeFile(directory + '/stdout.log', Buffer.concat(out)); await writeFile(directory + '/stderr.log', Buffer.concat(err));
const finish = { exitCode: code, reason: 'exited', signal: null, finishedAt: Date.now() };
await writeFile(directory + '/exit.next', JSON.stringify({ version: 1, jobId, nonce, finish })); await rename(directory + '/exit.next', directory + '/exit.json');
process.exitCode = code;
`;
}
export async function acceptanceD(h: HerdrHarness): Promise<void> {
  await h.start(); const owner = h.owner!;
  const messages = join(h.root, 'job-messages.json'); await writeFile(messages, '[]');
  const client = h.hc;
  const options = (): JobMonitorOptions => ({ hc: client, app: h.app, panes: {
    reserve: async () => { throw new Error('Parked jobs must not reserve strip slots'); },
    observe: async () => { throw new Error('Parked jobs must not start observers'); },
    abandon: async () => {},
  }, journalRoot: join(h.directories.global, 'herdr'),
    outputCollector: {
      prepare: async (_program, record) => {
        const nonce = randomBytes(16).toString('hex'), remoteDirectory = join(h.directories.remote, randomBytes(16).toString('hex'));
        await mkdir(remoteDirectory, { mode: 0o700 });
        const requestBytes = Buffer.from(JSON.stringify({ version: 1, jobId: record.id, nonce }));
        await client.fileWrite(record.machine, join(remoteDirectory, 'request.json'), requestBytes);
        await client.fileWrite(record.machine, join(remoteDirectory, 'request.json.sha256'), Buffer.from(sha256(requestBytes)));
        const script = join(remoteDirectory, 'fixture-runtime.mjs');
        await client.fileWrite(record.machine, script, Buffer.from(fixtureRuntime({ ...record, remoteDirectory }, nonce)));
        return { program: { directory: remoteDirectory, argv: [h.nodeBinary, script], cwd: null, env: {}, files: [] }, nonce, releaseDeadlineAt: Date.now() + 10000 };
      },
      collect: async record => {
        try {
          const bytes = await client.fileRead(record.machine, join(record.remoteDirectory, 'exit.json'));
          const receipt = JSON.parse(bytes.toString()); assert.equal(receipt.version, 1); assert.equal(receipt.jobId, record.id);
          const finish = parseFinish(receipt.finish);
          const stdout = await client.fileRead(record.machine, join(record.remoteDirectory, 'stdout.log')), stderr = await client.fileRead(record.machine, join(record.remoteDirectory, 'stderr.log'));
          await writeFile(join(record.localDirectory, 'stdout.log'), stdout); await writeFile(join(record.localDirectory, 'stderr.log'), stderr);
          return { complete: true, summary: stdout.toString(), receipt: { jobId: record.id, nonce: receipt.nonce, finish } };
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && ['not_found', 'file_not_found', 'invalid_params', 'ENOENT'].includes(String(error.code))) return { complete: false, summary: '', receipt: null };
          throw error;
        }
      },
    },
    observedJobMessages: async () => (JSON.parse(await readFile(messages, 'utf8')) as JobNotice[]).map(n => n.details.jobId),
    notifier: async notice => { const list = JSON.parse(await readFile(messages, 'utf8')); list.push(notice); await writeFile(messages, JSON.stringify(list)); }, clock: Date.now,
  });
  let jobs = createJobMonitor(options());
  try {
    const program: PreparedProgram = { directory: h.directories.remote, argv: [], cwd: null, files: [], env: {} };
    const handle = await jobs.start(program, owner, 'remote.invalid' as JobRecord['machine'], { background: true });
    const original = await client.get(handle.address); assert.equal(original.parent, null);
    assert.equal(original.labels[HERDR_LABELS.machine], 'remote.invalid');
    const journalPath = join(h.directories.global, 'herdr', 'sessions', owner.sessionId, 'jobs.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(journal.jobs[0].viewer, null);
    assert.equal(original.labels[HERDR_LABELS.job], handle.id);
    assert.equal(original.labels[HERDR_LABELS.session], owner.sessionId);
    assert.equal(original.labels[HERDR_LABELS.ownerCore], owner.terminal.coreId);
    assert.equal(original.labels[HERDR_LABELS.ownerTerminal], owner.terminal.terminalId);
    assert.equal(original.labels[HERDR_LABELS.kind], HERDR_KINDS.exec);
    if (h.mode !== 'fake') {
      const raw = await h.cli(['get', handle.address, '--json']) as { cols: number; rows: number }; assert.equal(raw.cols, 200); assert.equal(raw.rows, 120);
    }
    await jobs.detach(handle.id); await jobs.toolReturned(handle.id); await jobs.shutdown('reload');
    jobs = createJobMonitor(options()); await jobs.activate({ ...owner, generation: randomUUID() as Owner['generation'] });
    const deadline = Date.now() + 10000;
    while (JSON.parse(await readFile(messages, 'utf8')).length === 0 && Date.now() < deadline) { await jobs.reconcile(); await new Promise(r => setTimeout(r, 20)); }
    const notices: JobNotice[] = JSON.parse(await readFile(messages, 'utf8')); assert.deepEqual(notices.map(n => n.details.jobId), [handle.id]); assert.equal(notices[0].details.exitCode, 23);
    assert.equal(await readFile(join(handle.localDirectory, 'stdout.log'), 'utf8'), 'one-line\n');
    assert.equal(await readFile(join(handle.localDirectory, 'stderr.log'), 'utf8'), 'separate-error\n');
    await jobs.reconcile(); assert.equal(JSON.parse(await readFile(messages, 'utf8')).length, 1);
    assert.match(basename(handle.remoteDirectory), /^[0-9a-f]{32}$/); assert.equal((await stat(handle.remoteDirectory)).mode & 0o777, 0o700);
    await expect.poll(async () => JSON.parse((await client.fileRead('remote.invalid' as JobRecord['machine'], join(handle.remoteDirectory, '.spider-settled'))).toString()), { timeout: 10000 }).toMatchObject({ jobId: handle.id, version: 1 });
  } catch (error) {
    await writeFile(join(dirname(h.root), `d-failure-${basename(h.root)}.json`), JSON.stringify({ error: String(error), calls: await h.calls(), remoteCalls: await h.calls('remote') }, null, 2));
    throw error;
  } finally { await jobs.dispose(); }
}
