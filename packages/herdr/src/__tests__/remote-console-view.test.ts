// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { runRemoteConsole } from '../remote/runtime.js';
import { createFixtureRoot } from '../../e2e/harness/environment.js';

const roots: string[] = [];
const sessions: { stop: () => void; done: Promise<void> }[] = [];
afterEach(async () => {
  const running = sessions.splice(0);
  for (const session of running) session.stop();
  await Promise.all(running.map(session => session.done));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function publication(value: unknown): string {
  const body = JSON.stringify(value);
  return JSON.stringify({ body, sha256: createHash('sha256').update(body).digest('hex') });
}
function plain(text: string): string {
  return text.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;]*m/g, '');
}
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Console did not process the fixture');
    await delay(5);
  }
}
const startedAt = new Date(2026, 0, 2, 12, 34, 56).getTime();
async function fixture(columns?: number) {
  const root = await createFixtureRoot(); roots.push(root);
  const directory = join(root, '.consoles', 'agent'); await mkdir(directory, { recursive: true });
  let output = ''; let count = 0;
  const start = () => {
    let stopped = false;
    const options = { get signal() { return stopped ? AbortSignal.abort() : undefined; }, pollMs: 5, columns, write: (text: string) => { output += text; } };
    sessions.push({ stop: () => { stopped = true; }, done: runRemoteConsole(directory, options) });
  };
  const title = async (value: string) => writeFile(join(directory, 'console.json'), publication({ version: 1, title: value }));
  const job = async (id: string, command: string, tool?: string) => {
    const dir = join(root, id); await mkdir(dir);
    await writeFile(join(dir, '.spider-console-hold'), JSON.stringify({ version: 1, consoleDirectory: directory, createdAt: Date.now() }));
    await writeFile(join(directory, `command-${count}.json`), publication({ version: 1, jobId: id, directory: dir, command, startedAt, ...(tool ? { tool } : {}) }));
    await writeFile(join(directory, 'head.json'), publication({ version: 1, count: ++count }));
    let nextChunk = 0; const offsets = { stdout: 0, stderr: 0 };
    const stream = async (name: 'stdout' | 'stderr', text: string) => {
      const bytes = Buffer.from(text);
      await writeFile(join(dir, `chunk-${String(nextChunk++).padStart(8, '0')}.json`), JSON.stringify({ stream: name, offset: offsets[name], data: bytes.toString('base64') }));
      offsets[name] += bytes.length;
    };
    const finish = async (outcome: string, exitCode: number | null, signal: string | null = null) => {
      await writeFile(join(dir, 'receipt.json'), JSON.stringify({ version: 1, jobId: id, nonce: '0123456789abcdef', requestSha256: '0'.repeat(64), indexSha256: '1'.repeat(64), outcome, exitCode, signal, finishedAt: startedAt + 12300, stdoutBytes: offsets.stdout, stderrBytes: offsets.stderr }));
    };
    const settled = async () => {
      await waitFor(async () => { try { await access(join(dir, '.spider-console-hold')); return false; } catch { return true; } });
      await delay(5);
    };
    return { stream, finish, settled };
  };
  return { start, title, job, raw: () => output, text: () => plain(output), waitText: (text: string) => waitFor(() => output.includes(text)), directory };
}

it('prints the console title and a rule in the terminal body', async () => {
  const f = await fixture(72); await f.title('Build agent · remote.invalid'); f.start();
  await f.waitText('\x1b]0;Build agent · remote.invalid\x07'); await delay(20);
  expect(f.text()).toMatch(/Build agent · remote\.invalid\n[─]+/);
});
it.each([
  { tool: undefined, label: 'exec' },
  { tool: 'batch', label: 'batch' },
  { tool: 'exec_file', label: 'exec_file' },
])('shows the $label header with local time and short job id', async ({ tool, label }) => {
  const f = await fixture(72); const job = await f.job('abcdef123456', 'printf ready\nnot shown', tool);
  await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toMatch(new RegExp(`◆ ${label}.*printf ready.*12:34:56 · abcdef12`));
  expect(f.text()).not.toContain('not shown');
});
it('indents stdout and distinguishes the stderr gutter with red ANSI', async () => {
  const f = await fixture(); const job = await f.job('first', 'show streams');
  await job.stream('stdout', 'ordinary text\n'); await job.stream('stderr', 'diagnostic text\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toMatch(/│ ordinary text\n.*│ diagnostic text/);
  expect(f.raw()).toMatch(/\x1b\[(?:31|91|38;2;\d+;\d+;\d+)m[^\n]*│[^\n]*\x1b\[0m\s*diagnostic text/);
});
it.each([
  { outcome: 'exited', code: 0, signal: null, result: '✓ exit 0 · 12.3 s', color: '32' },
  { outcome: 'exited', code: 2, signal: null, result: '✗ exit 2 · 12.3 s', color: '31' },
  { outcome: 'signal', code: null, signal: 'SIGKILL', result: '✗ signal SIGKILL', color: '31' },
  { outcome: 'unknown', code: null, signal: null, result: '○ outcome unknown', color: '2' },
  { outcome: 'lost', code: null, signal: null, result: '○ output lost', color: '2' },
])('shows $outcome as a readable result', async ({ outcome, code, signal, result, color }) => {
  const f = await fixture(); const job = await f.job('first', 'work');
  await job.finish(outcome, code, signal); f.start(); await job.settled();
  expect(f.text()).toContain(result);
  expect(f.raw()).toContain(`\x1b[${color}m`);
});
it('keeps stream tags after an overlapping job finishes', async () => {
  const f = await fixture(); const first = await f.job('firstjob', 'first command'); f.start(); await f.waitText('first command');
  await first.stream('stdout', 'alone before\n'); await f.waitText('alone before');
  const second = await f.job('secondjob', 'second command'); await f.waitText('second command');
  await first.stream('stdout', 'first concurrent\n'); await second.stream('stderr', 'second concurrent\n');
  await f.waitText('first concurrent'); await f.waitText('second concurrent');
  await second.finish('exited', 0); await second.settled();
  await first.stream('stdout', 'alone after\n'); await f.waitText('alone after'); await first.finish('exited', 0); await first.settled();
  expect(f.text()).toMatch(/│ alone before/);
  expect(f.text()).toMatch(/#1.*│ first concurrent/);
  expect(f.text()).toMatch(/#2.*│ second concurrent/);
  expect(f.text()).toMatch(/#1.*│ alone after/);
  expect(f.text()).not.toMatch(/#\d+.*│ alone before/);
  expect(f.text()).toMatch(/#2.*✓ exit 0/);
  expect(f.text()).toMatch(/#1.*✓ exit 0/);
});
it('identifies both headers when an already visible command overlaps', async () => {
  const f = await fixture(72); const first = await f.job('firstjob', 'first command', 'batch');
  f.start(); await f.waitText('first command');
  const second = await f.job('secondjob', 'second command', 'exec_file'); await f.waitText('second command');
  await second.finish('exited', 0); await second.settled();
  await first.stream('stderr', 'late failure\n'); await first.finish('exited', 1); await first.settled();
  expect(f.text()).toMatch(/◆ batch #1 first command.*\(continued\)/);
  expect(f.text()).toMatch(/◆ exec_file #2 second command/);
  expect(f.text()).not.toContain('○ concurrent');
  expect(f.text()).toMatch(/#1.*│ late failure\n\s*#1.*✗ exit 1/);
});
it('shows no tags for a command that never overlaps', async () => {
  const f = await fixture(); const job = await f.job('singlejob', 'single command');
  await job.stream('stdout', 'single output\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('single command');
  expect(f.text()).toContain('│ single output');
  expect(f.text()).toContain('✓ exit 0');
  expect(f.text()).not.toMatch(/#\d+/);
});
it('keeps overlapping header tags visible in a narrow terminal', async () => {
  const f = await fixture(12); const first = await f.job('firstjob', 'first command', 'batch');
  f.start(); await f.waitText('◆ batch');
  const second = await f.job('secondjob', 'second command', 'exec_file'); await f.waitText('#2');
  await second.finish('exited', 0); await second.settled();
  await first.finish('exited', 0); await first.settled();
  const headers = f.text().split('\n').filter(line => line.startsWith('◆'));
  expect(headers.some(line => line.includes('#1'))).toBe(true);
  expect(headers.some(line => line.includes('#2'))).toBe(true);
  expect(headers.every(line => line.length <= 12)).toBe(true);
});
it('starts a new untagged block after all overlapping jobs settle', async () => {
  const f = await fixture(); const first = await f.job('firstjob', 'first command');
  f.start(); await f.waitText('first command');
  const second = await f.job('secondjob', 'second command'); await f.waitText('second command');
  await second.finish('exited', 0); await second.settled(); await first.finish('exited', 0); await first.settled();
  const start = f.text().length;
  const third = await f.job('thirdjob', 'third command'); await third.stream('stdout', 'third output\n');
  await third.finish('exited', 0); await third.settled();
  expect(f.text().slice(start)).toContain('third command');
  expect(f.text().slice(start)).toContain('│ third output');
  expect(f.text().slice(start)).toContain('✓ exit 0');
  expect(f.text().slice(start)).not.toMatch(/#\d+/);
});
it('keeps the tool header within a narrow terminal', async () => {
  const f = await fixture(12); const job = await f.job('abcdef123456', 'a long command');
  await job.finish('exited', 0); f.start(); await job.settled();
  const header = f.text().split('\n').find(line => line.trim())!;
  expect(header.length).toBeLessThanOrEqual(12);
  expect(header).toMatch(/^◆ exec/);
  expect(header).toContain('12');
});
it('hard-wraps output at the terminal width with a gutter on each row', async () => {
  const f = await fixture(24); const job = await f.job('first', 'wrap');
  await job.stream('stdout', 'abcdefghijklmnopqrstuvwxyz\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('│ abcdefghijklmnopqrst\n  │ uvwxyz');
});
it('escapes terminal controls from output instead of executing them', async () => {
  const f = await fixture(); const job = await f.job('first', 'show controls');
  await job.stream('stdout', 'safe\x1b[2J\u009b31m\rtext\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('safe\\x1b[2J\\x9b31m\\x0dtext');
  expect(f.raw()).not.toContain('\x1b[2J');
  expect(f.raw()).not.toContain('\u009b');
});
