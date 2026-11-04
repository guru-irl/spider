// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    const stream = async (name: 'stdout' | 'stderr', text: string | Buffer) => {
      const bytes = Buffer.from(text);
      await writeFile(join(dir, `chunk-${String(nextChunk++).padStart(8, '0')}.json`), JSON.stringify({ stream: name, offset: offsets[name], data: bytes.toString('base64') }));
      offsets[name] += bytes.length;
    };
    const finish = async (outcome: string, exitCode: number | null, signal: string | null = null, times: { startedAt?: number; finishedAt?: number } = { startedAt, finishedAt: startedAt + 12300 }) => {
      await writeFile(join(dir, 'receipt.json'), JSON.stringify({ version: 1, jobId: id, nonce: '0123456789abcdef', requestSha256: '0'.repeat(64), indexSha256: '1'.repeat(64), outcome, exitCode, signal, ...times, stdoutBytes: offsets.stdout, stderrBytes: offsets.stderr }));
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
it('uses remote receipt timestamps and omits duration for a legacy receipt', async () => {
  const f = await fixture();
  const remote = await f.job('remote', 'remote clock');
  await remote.finish('exited', 0, null, { startedAt: 10000, finishedAt: 12500 });
  f.start(); await remote.settled();
  const legacy = await f.job('legacy', 'legacy clock');
  await legacy.finish('exited', 0, null, { finishedAt: startedAt + 99000 }); await legacy.settled();
  expect(f.text()).toContain('✓ exit 0 · 2.5 s');
  expect(f.text().match(/✓ exit 0[^\n]*/g)).toEqual(['✓ exit 0 · 2.5 s', '✓ exit 0']);
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
it('identifies overlapping commands on one key line', async () => {
  const f = await fixture(100); const first = await f.job('firstjob', 'first command', 'batch');
  f.start(); await f.waitText('first command');
  const second = await f.job('secondjob', 'second command', 'exec_file'); await f.waitText('second command');
  await second.finish('exited', 0); await second.settled();
  await first.stream('stderr', 'late failure\n'); await first.finish('exited', 1); await first.settled();
  expect(f.text()).toMatch(/◆ batch first command.*12:34:56 · firstjob/);
  expect(f.text()).toMatch(/  #1 batch first command · #2 exec_file second command\s+12:34:56 · secondjo/);
  expect(f.text()).not.toContain('(continued)');
  expect(f.text()).not.toContain('○ concurrent');
  expect(f.text()).not.toMatch(/◆ exec_file/);
  expect(f.text()).toMatch(/#1.*│ late failure\n\s*#1.*✗ exit 1/);
});
it('updates the key in tag order as jobs join and leave', async () => {
  const f = await fixture(100); const first = await f.job('firstjob', 'first', 'batch');
  f.start(); await f.waitText('◆ batch first');
  const second = await f.job('secondjob', 'second'); await f.waitText('second');
  const third = await f.job('thirdjob', 'third', 'exec_file'); await f.waitText('third');
  await first.finish('exited', 0); await first.settled();
  const fourth = await f.job('fourthjob', 'fourth'); await f.waitText('fourth');
  expect(f.text()).toMatch(/#1 batch first · #2 exec second · #3 exec_file third/);
  expect(f.text()).toMatch(/#2 exec second · #3 exec_file third · #4 exec fourth/);
  expect(f.text()).not.toMatch(/#1 batch first[^\n]*#4 exec fourth/);
  await second.finish('exited', 0); await third.finish('exited', 0); await fourth.finish('exited', 0);
  await second.settled(); await third.settled(); await fourth.settled();
});
it('escapes controls in both commands on a key line', async () => {
  const f = await fixture(120); const first = await f.job('firstjob', 'first\x1b[2J', 'batch');
  f.start(); await f.waitText('first\\x1b');
  const second = await f.job('secondjob', 'second\u009b31m', 'exec_file'); await f.waitText('second\\x9b');
  const key = f.text().split('\n').find(line => line.includes('#2')) ?? '';
  expect(key).toContain('#1 batch first\\x1b[2J · #2 exec_file second\\x9b31m');
  expect(f.raw()).not.toContain('\x1b[2J');
  expect(f.raw()).not.toContain('\u009b');
  await first.finish('exited', 0); await second.finish('exited', 0); await first.settled(); await second.settled();
});
it('shows no tags for a command that never overlaps', async () => {
  const f = await fixture(); const job = await f.job('singlejob', 'single command');
  await job.stream('stdout', 'single output\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('single command');
  expect(f.text()).toContain('│ single output');
  expect(f.text()).toContain('✓ exit 0');
  expect(f.text()).not.toMatch(/#\d+/);
});
it.each([8, 20])('keeps whole tags on a %i-column key line', async columns => {
  const f = await fixture(columns); const first = await f.job('firstjob', 'first command', 'batch');
  f.start(); await f.waitText('◆ batch');
  const second = await f.job('secondjob', 'second command', 'exec_file'); await f.waitText('#2');
  const key = f.text().split('\n').find(line => line.includes('#2'));
  expect(key).toBe('#1 · #2');
  await second.finish('exited', 0); await second.settled();
  await first.finish('exited', 0); await first.settled();
});
it('marks omitted tags without splitting one at eight columns', async () => {
  const f = await fixture(8); const first = await f.job('firstjob', 'first', 'batch');
  f.start(); await f.waitText('◆ batch');
  const second = await f.job('secondjob', 'second', 'exec_file'); await f.waitText('#2');
  const third = await f.job('thirdjob', 'third'); await third.finish('exited', 0); await third.settled();
  expect(f.text().split('\n').filter(line => line.startsWith('#'))).toEqual(['#1 · #2', '#1 …']);
  await first.finish('exited', 0); await second.finish('exited', 0);
  await first.settled(); await second.settled();
});
it('drops metadata before sharing command space at 40 columns', async () => {
  const f = await fixture(40); const first = await f.job('firstjob', 'first-long-command', 'batch');
  f.start(); await f.waitText('◆ batch');
  const second = await f.job('secondjob', 'second-long-command', 'exec_file'); await f.waitText('#2');
  const key = f.text().split('\n').find(line => line.includes('#2')) ?? '';
  expect(key).toMatch(/#1 batch first.*… · #2 exec_file second.*…/);
  expect(key).not.toContain('12:34:56');
  expect(key.length).toBeLessThanOrEqual(40);
  await first.finish('exited', 0); await second.finish('exited', 0); await first.settled(); await second.settled();
});
it('clips wide commands without splitting an escaped control on the key', async () => {
  const f = await fixture(40); const first = await f.job('firstjob', '漢\x1bLONG', 'batch');
  f.start(); await f.waitText('◆ batch');
  const second = await f.job('secondjob', '界 second-long-command', 'exec_file'); await f.waitText('#2');
  const key = f.text().split('\n').find(line => line.includes('#2')) ?? '';
  expect(key).toBe('  #1 batch 漢… · #2 exec_file 界 sec…');
  expect(key).not.toContain('\\x1');
  expect(f.raw()).not.toContain('\x1bLONG');
  await first.finish('exited', 0); await second.finish('exited', 0); await first.settled(); await second.settled();
});
it('prints a normal header and one key when two arrive together', async () => {
  const f = await fixture(100);
  const first = await f.job('firstjob', 'first command');
  const second = await f.job('secondjob', 'second command');
  await first.finish('exited', 0); await second.finish('exited', 0);
  f.start(); await first.settled(); await second.settled();
  expect(f.text().match(/◆[^\n]*first command/g)).toHaveLength(1);
  expect(f.text()).toMatch(/◆ exec first command/);
  expect(f.text()).toMatch(/#1 exec first command · #2 exec second command/);
  expect(f.text()).not.toMatch(/◆ exec #2/);
  expect(f.text()).not.toContain('(continued)');
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
it('loads and renders without Intl using a code-point fallback', async () => {
  const f = await fixture(20); const job = await f.job('fallback', 'command');
  await job.stream('stdout', '漢 output\n'); await job.finish('exited', 0);
  const moduleUrl = new URL('../remote/runtime.ts', import.meta.url).href;
  const script = `globalThis.Intl = undefined; const { runRemoteConsole } = await import(${JSON.stringify(moduleUrl)}); await runRemoteConsole(${JSON.stringify(f.directory)}, { signal: AbortSignal.timeout(500), pollMs: 5, columns: 20, write: text => process.stdout.write(text) });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000, cwd: fileURLToPath(new URL('../../../..', import.meta.url)) });
  expect(result.status, result.stderr).toBe(0);
  expect(plain(result.stdout)).toContain('│ 漢 output');
  expect(plain(result.stdout)).toContain('✓ exit 0');
});
it('fits title, headers, tagged output and results in widths one through 24', async () => {
  for (let columns = 1; columns <= 24; columns++) {
    const f = await fixture(columns); await f.title('title 漢');
    const first = await f.job('first', 'command 漢'); const second = await f.job('second', 'another');
    await first.stream('stdout', '漢x\n'); await second.stream('stderr', 'error\n');
    await first.finish('exited', 3); await second.finish('exited', 0); f.start();
    await first.settled(); await second.settled();
    for (const line of f.text().split('\n')) {
      const cells = [...line].reduce((sum, char) => sum + (char === '漢' ? 2 : 1), 0);
      expect(cells, `width ${columns}, row ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
    }
  }
});
it('keeps escaped controls together when wrapping output', async () => {
  const f = await fixture(9); const job = await f.job('escape', 'wrap');
  await job.stream('stdout', 'abcd\x1bZ\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('│ abcd\n  │ \\x1bZ');
});
it('does not let a signal name create a new terminal row', async () => {
  const f = await fixture(); const job = await f.job('signal', 'finish');
  await job.finish('signal', null, 'SIGTERM\nforged'); f.start(); await job.settled();
  expect(f.text()).toContain('✗ signal SIGTERM\\x0aforged');
  expect(f.text()).not.toContain('\nforged');
});
it('replaces an escaped control that cannot fit in a narrow content row', async () => {
  const f = await fixture(7); const job = await f.job('escape', 'wrap');
  await job.stream('stdout', '\x1bX\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('│ …\n  │ X');
  expect(f.text()).not.toContain('\\x1');
});
it('never leaves a partial escaped control when clipping a header', async () => {
  const f = await fixture(31); const job = await f.job('abcdefgh', 'x\x1bZ');
  await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('◆ exec x…');
  expect(f.text()).not.toMatch(/\\(?:x[0-9a-f]?)?…/);
});
it('expands tabs at eight-column stops in command and output content', async () => {
  const f = await fixture(80); const job = await f.job('tabs', 'ab\tcd\tend');
  await job.stream('stdout', 'ok  \tgithub.com/x/pkg\t0.12s\nname\tsize\n');
  await job.stream('stderr', '漢\tx\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('ab      cd      end');
  expect(f.text()).toContain('│ ok      github.com/x/pkg        0.12s');
  expect(f.text()).toContain('│ name    size');
  expect(f.text()).toContain('│ 漢      x');
  expect(f.raw()).not.toContain('\t');
});
it('resets tab stops after CRLF', async () => {
  const f = await fixture(80); const job = await f.job('crlf', 'lines');
  await job.stream('stdout', 'a\r\n\tz\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('│ a\\x0d\n  │         z');
});
it('hard-wraps output at the terminal width with a gutter on each row', async () => {
  const f = await fixture(24); const job = await f.job('first', 'wrap');
  await job.stream('stdout', 'abcdefghijklmnopqrstuvwxyz\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('│ abcdefghijklmnopqrst\n  │ uvwxyz');
});
it.each([undefined, 80, 7])('sanitizes controls in every console path at width %s', async columns => {
  const f = await fixture(columns);
  const hostile = '\x1b]52;c;eA==\x07\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07\x1b[200~text\x1b[201~\x1b[10A\x1b[H\u009b\x1b';
  await f.title('title ' + hostile);
  const job = await f.job('hostile', 'command ' + hostile);
  await job.stream('stdout', 'stdout ' + hostile + '\n');
  await job.stream('stderr', 'stderr ' + hostile + '\n');
  await job.stream('stdout', Buffer.from([0x72, 0x61, 0x77, 0x20, 0x9b, 0x0a, 0xc2]));
  await job.stream('stdout', Buffer.from([0x9b, 0x0a]));
  await job.finish('signal', null, 'signal ' + hostile);
  f.start(); await job.settled();
  const raw = f.raw();
  const titles = raw.match(/\x1b\]0;[^\x00-\x1f\x7f-\x9f]*\x07/g) ?? [];
  expect(titles).toHaveLength(1);
  const content = raw.replace(/\x1b\]0;[^\x00-\x1f\x7f-\x9f]*\x07/g, '').replace(/\x1b\[(?:0|2|31|32)m/g, '');
  expect(content).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  if (columns === undefined || columns === 80) {
    expect(content).toContain('command \\x1b]52');
    expect(content).toContain('stderr \\x1b]52');
    expect(content).toContain('signal \\x1b]52');
    expect(content).toContain('\\x9b');
  }
});
it('escapes terminal controls from output instead of executing them', async () => {
  const f = await fixture(); const job = await f.job('first', 'show controls');
  await job.stream('stdout', 'safe\x1b[2J\u009b31m\rtext\n'); await job.finish('exited', 0); f.start(); await job.settled();
  expect(f.text()).toContain('safe\\x1b[2J\\x9b31m\\x0dtext');
  expect(f.raw()).not.toContain('\x1b[2J');
  expect(f.raw()).not.toContain('\u009b');
});
