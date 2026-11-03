// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm, access, symlink, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as runtime from '../remote/runtime.js';
import { createHash } from 'node:crypto';
function publication(value: unknown) { const body = JSON.stringify(value); return JSON.stringify({ body, sha256: createHash('sha256').update(body).digest('hex') }); }
function visible(text: string) { return text.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;]*m/g, ''); }
const roots: string[] = [];
const aborts: AbortController[] = [];
const runs: Promise<void>[] = [];
afterEach(async () => { for (const abort of aborts.splice(0)) abort.abort(); await Promise.all(runs.splice(0)); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const base = resolve('.spider/scratch/h'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'console-')); roots.push(root);
  const directory = join(root, '.consoles', 'agent'); await mkdir(directory, { recursive: true });
  let output = ''; const abort = new AbortController(); aborts.push(abort);
  const start = () => {
    const run = (runtime as unknown as { runRemoteConsole: (directory: string, options: { signal: AbortSignal; pollMs: number; write: (text: string) => void }) => Promise<void> }).runRemoteConsole;
    expect(run).toBeTypeOf('function');
    const done = run(directory, { signal: abort.signal, pollMs: 5, write: text => { output += text; } }); runs.push(done);
  };
  const job = async (id: string, index: number, command: string) => {
    const dir = join(root, id); await mkdir(dir);
    await writeFile(join(directory, `command-${index}.json`), publication({ version: 1, jobId: id, directory: dir, command, startedAt: 0 }));
    await writeFile(join(directory, 'head.json'), publication({ version: 1, count: index + 1 }));
    let chunk = 0; const offsets = { stdout: 0, stderr: 0 };
    const publish = async (stream: 'stdout' | 'stderr', text: string) => {
      const bytes = Buffer.from(text); await appendFile(join(dir, `${stream}.log`), bytes);
      for (let start = 0; start < bytes.length; start += 49152) {
        const raw = bytes.subarray(start, start + 49152);
        await writeFile(join(dir, `chunk-${String(chunk++).padStart(8, '0')}.json`), JSON.stringify({ stream, offset: offsets[stream], data: raw.toString('base64') })); offsets[stream] += raw.length;
      }
    };
    return { dir, out: (text: string) => publish('stdout', text), err: (text: string) => publish('stderr', text), receipt: (stdoutBytes: number, stderrBytes: number, exitCode: number) => writeFile(join(dir, 'receipt.json'), JSON.stringify({ version: 1, jobId: id, stdoutBytes, stderrBytes, outcome: 'exited', exitCode, signal: null })) };
  };
  const until = async (text: string) => { const end = Date.now() + 3000; while (!output.includes(text) && !visible(output).includes(text) && Date.now() < end) await delay(5); expect(output.includes(text) || visible(output).includes(text)).toBe(true); };
  return { root, directory, start, job, until, output: () => output, abort };
}
it('sets the display title through OSC without allowing a title to inject terminal controls', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'console.json'), publication({ version: 1, title: 'Builder\u001b]2;injected\u0007\n · remote.invalid' }));
  f.start(); await f.until('\u001b]0;Builder]2;injected · remote.invalid\u0007');
  expect(f.output().match(/\u001b\]0;/g)).toHaveLength(1); expect(f.output()).not.toContain('\u001b]2;'); expect(f.output().match(/\u0007/g)).toHaveLength(1);
  expect(f.output().replace(/\x1b\]0;[^\x00-\x1f\x7f-\x9f]*\x07/g, '').replace(/\x1b\[(?:0|2|31|32)m/g, '')).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
});
it.each(['console.json', 'head.json', 'command-0.json'])('retries torn and checksum-failing host publication %s without a wrong action', async name => {
  const f = await fixture(); const job = await f.job('one', 0, 'correct command');
  await writeFile(join(f.directory, 'console.json'), publication({ version: 1, title: 'correct title · remote.invalid' }));
  const path = join(f.directory, name), complete = await readFile(path);
  const bad = JSON.parse(complete.toString()); bad.sha256 = '0'.repeat(64);
  await writeFile(path, JSON.stringify(bad)); f.start(); await delay(30);
  if (name === 'console.json') expect(f.output()).not.toContain('correct title');
  else expect(f.output()).not.toContain('correct command');
  await writeFile(path, '{'); const writer = (async () => { for (let i = 0; i < 20; i++) { await appendFile(path, ' '); await delay(2); } })(); await writer;
  if (name === 'console.json') expect(f.output()).not.toContain('correct title');
  else expect(f.output()).not.toContain('correct command');
  await writeFile(path, complete);
  await f.until(name === 'console.json' ? 'correct title · remote.invalid' : 'correct command');
  await job.out('recovered\n'); await f.until('│ recovered');
});
it('skips a pruned historical job directory when reopening the console journal', async () => {
  const f = await fixture(); const old = await f.job('old', 0, 'settled history'); const current = await f.job('current', 1, 'new command');
  await rm(old.dir, { recursive: true, force: true }); await current.out('new output\n'); await current.receipt(11, 0, 23); f.start();
  await f.until('│ new output'); await f.until('✗ exit 23');
});
it('shows ordered command headers, interleaved per-job streams and exact exits', async () => {
  const f = await fixture(); const one = await f.job('one', 0, 'echo first'); const two = await f.job('two', 1, 'echo second'); f.start();
  await one.out('first\n'); await f.until('#1 │ first');
  await two.err('diagnostic\n'); await f.until('#2 │ diagnostic');
  await one.out('last\n'); await two.out('other\n');
  await one.receipt(11, 0, 23); await f.until('#1 ✗ exit 23');
  await two.receipt(6, 11, 0); await f.until('✓ exit 0');
  const output = visible(f.output());
  expect(output.indexOf('echo first')).toBeLessThan(output.indexOf('echo second'));
  expect(output.indexOf('#1 │ first')).toBeLessThan(output.indexOf('#2 │ diagnostic'));
  expect(output.indexOf('#2 │ diagnostic')).toBeLessThan(output.indexOf('#1 │ last'));
  expect(output).toContain(new Date(0).toTimeString().slice(0, 8));
  expect(output.match(/#1 ✗ exit 23/g)).toHaveLength(1);
  expect(f.output()).toMatch(/#2 \x1b\[31m│ \x1b\[0mdiagnostic/);
});
it('preserves publication order across stdout and stderr even when both logs already exist', async () => {
  const f = await fixture(); const job = await f.job('one', 0, 'write both streams');
  await job.err('first diagnostic\n'); await job.out('second output\n'); await job.err('last diagnostic\n'); await job.receipt(14, 33, 0); f.start();
  await f.until('✓ exit 0'); const output = f.output();
  expect(output.indexOf('first diagnostic')).toBeLessThan(output.indexOf('second output'));
  expect(output.indexOf('second output')).toBeLessThan(output.indexOf('last diagnostic'));
});
it('retries missing and partial files without executing their payload argv', async () => {
  const f = await fixture(); const job = await f.job('one', 0, 'touch forbidden\nsecond line');
  const marker = join(f.root, 'forbidden');
  await writeFile(join(job.dir, 'request.json'), JSON.stringify({ argv: ['/bin/sh', '-c', `touch '${marker}'`] }));
  await writeFile(join(f.directory, 'command-0.json'), '{'); f.start(); await delay(25);
  await writeFile(join(f.directory, 'command-0.json'), publication({ version: 1, jobId: 'one', directory: job.dir, command: 'touch forbidden', startedAt: 0 }));
  await job.out('complete\n'); await writeFile(join(job.dir, 'receipt.json'), '{'); await f.until('│ complete');
  await job.receipt(9, 0, 0); await f.until('✓ exit 0');
  expect(f.output()).not.toContain('second line'); await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retries a partial chunk while other jobs remain visible and preserves split UTF-8', async () => {
  const f = await fixture(); const one = await f.job('one', 0, 'partial output'); const two = await f.job('two', 1, 'visible output');
  await one.out('repaired\n'); await writeFile(join(one.dir, 'chunk-00000000.json'), '{');
  const text = 'a'.repeat(49151) + '🌍b\n'; await two.out(text); await two.receipt(Buffer.byteLength(text), 0, 0); f.start();
  await f.until('✓ exit 0'); expect(f.output()).toContain('🌍b'); expect(f.output()).not.toContain('\ufffd'); expect(f.output()).not.toContain('repaired');
  await writeFile(join(one.dir, 'chunk-00000000.json'), JSON.stringify({ stream: 'stdout', offset: 0, data: Buffer.from('repaired\n').toString('base64') })); await one.receipt(9, 0, 0);
  await f.until('│ repaired'); await f.until('✓ exit 0');
});
it('bounded output reads catch up and aborting the view never changes job files', async () => {
  const f = await fixture(); const job = await f.job('one', 0, 'produce large output'); const bytes = 'x'.repeat(200000);
  await job.out(bytes); await job.receipt(bytes.length, 0, 0); f.start(); await f.until('✓ exit 0');
  expect(f.output().split('x').length - 1).toBe(bytes.length + 2); // Includes the x in "exec" and "exit".
  f.abort.abort(); await Promise.all(runs);
  await job.out('still writable\n'); await expect(access(join(job.dir, 'receipt.json'))).resolves.toBeUndefined();
});
it('shows a later concurrent job while the first read-budget of jobs are still running', async () => {
  const f = await fixture();
  for (let index = 0; index < 32; index++) await f.job(`live-${index}`, index, 'keep running');
  const later = await f.job('later', 32, 'finish independently');
  await later.out('not starved\n'); await later.receipt(12, 0, 0); f.start();
  await f.until('#33 │ not starved'); await f.until('#33 ✓ exit 0');
});
it.each([
  { heartbeatAge: 1000, holdAge: 1000, survives: true },
  { heartbeatAge: 120001, holdAge: 1000, survives: false },
  { heartbeatAge: 1000, holdAge: 86400001, survives: false },
])('settled output hold expiry: $heartbeatAge ms heartbeat, $holdAge ms hold', async ({ heartbeatAge, holdAge, survives }) => {
  const f = await fixture(); const job = await f.job('one', 0, 'held output'); const now = Date.now();
  await writeFile(join(job.dir, '.spider-settled'), 'settled');
  await writeFile(join(job.dir, '.spider-console-hold'), JSON.stringify({ version: 1, consoleDirectory: f.directory, createdAt: now - holdAge }));
  await writeFile(join(f.directory, 'heartbeat.json'), JSON.stringify({ version: 1, at: now - heartbeatAge }));
  const later = join(f.root, 'later'); await mkdir(later); await writeFile(join(later, '.spider-settled'), 'settled');
  const removed = await runtime.pruneSettledPrograms(f.root, later);
  expect(removed).toEqual(survives ? [] : [job.dir]);
});
it('updates the console heartbeat and removes a job hold only after reading its receipt', async () => {
  const f = await fixture(); const job = await f.job('one', 0, 'finish');
  await writeFile(join(job.dir, '.spider-console-hold'), JSON.stringify({ version: 1, consoleDirectory: f.directory, createdAt: Date.now() }));
  f.start(); await f.until('finish');
  await expect(access(join(f.directory, 'heartbeat.json'))).resolves.toBeUndefined();
  const heartbeat = JSON.parse(await readFile(join(f.directory, 'heartbeat.json'), 'utf8')); expect(heartbeat.at).toBeGreaterThan(Date.now() - 2000);
  await expect(access(join(job.dir, '.spider-console-hold'))).resolves.toBeUndefined();
  await job.receipt(0, 0, 23); await f.until('✗ exit 23');
  await expect(access(join(job.dir, '.spider-console-hold'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not follow a symlink job directory or read an oversized descriptor', async () => {
  const f = await fixture(); const job = await f.job('one', 0, 'unsafe'); const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'stdout.log'), 'private data\n');
  await rm(job.dir, { recursive: true }); await symlink(outside, job.dir); f.start(); await delay(50); expect(f.output()).not.toContain('private data');
  await writeFile(join(f.directory, 'command-0.json'), ' '.repeat(100000)); await delay(25); expect(f.output()).not.toContain('private data');
});
