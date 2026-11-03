import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { invokeCli as invokeCore } from '../client/hc.js';
import { createClientFixture } from './testutil.js';
import { invokeCli } from '../client/cli-transport.js';
import { HerdrError } from '../client/parse.js';

// Only the impossible-to-reap child is simulated; ordinary CLI calls use real processes.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const roots: string[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function fixture(mode: string) {
  const scratch = resolve('.spider/scratch/cli-transport');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'request-')); roots.push(directory);
  const executable = join(directory, 'cli.cjs'), pidFile = join(directory, 'pid'), signals = join(directory, 'signals');
  writeFileSync(executable, `const fs = require('node:fs');
fs.writeFileSync(process.env.CLI_PID_FILE, String(process.pid));
const mode = process.argv[2];
process.on('SIGTERM', () => { fs.appendFileSync(process.env.CLI_SIGNALS, 'SIGTERM\\n'); if (mode !== 'ignore-term') process.exit(0); });
if (mode === 'normal') {
  let input = ''; process.stdin.on('data', bytes => input += bytes).on('end', () => console.log(JSON.stringify({ input, value: process.env.CLI_VALUE })));
} else if (mode === 'slow') setTimeout(() => console.log(JSON.stringify({ finished: true })), 350);
else setInterval(() => {}, 1000);
`);
  return { directory, pidFile, signals, argv: [executable, mode], env: { ...process.env, CLI_PID_FILE: pidFile, CLI_SIGNALS: signals, CLI_VALUE: 'fixture' } };
}
async function boundedResult(promise: Promise<unknown>, ms = 3500): Promise<unknown> {
  const abort = new AbortController();
  try {
    return await Promise.race([promise.catch(error => error), delay(ms, new Error('CLI did not settle by its deadline'), { signal: abort.signal })]);
  } finally { abort.abort(); }
}
afterEach(async () => {
  vi.useRealTimers(); vi.mocked(spawn).mockClear();
  for (const root of roots.splice(0)) {
    const pidFile = join(root, 'pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (alive(pid)) { process.kill(pid, 'SIGKILL'); for (let i = 0; i < 100 && alive(pid); i++) await delay(10); }
      expect(alive(pid), `fixture process ${pid} must be reaped`).toBe(false);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('CLI request deadlines', () => {
  it('preserves normal JSON replies, stdin and environment without options', async () => {
    const f = fixture('normal');
    expect(await invokeCli(process.execPath, f.argv, f.env, undefined, Buffer.from('request'))).toEqual({ input: 'request', value: 'fixture' });
    expect(alive(Number(readFileSync(f.pidFile, 'utf8')))).toBe(false);
  });

  it('times out a real CLI that ignores SIGTERM and reaps it before rejecting', async () => {
    const f = fixture('ignore-term'), start = Date.now();
    const error = await boundedResult(invokeCli(process.execPath, f.argv, f.env, undefined, undefined, { timeoutMs: 300 }));
    expect(error).toBeInstanceOf(HerdrError);
    expect(error).toMatchObject({ code: 'cli-timeout', details: { timeoutMs: 300 } });
    expect(Date.now() - start).toBeLessThan(3000);
    expect(readFileSync(f.signals, 'utf8')).toBe('SIGTERM\n');
    const pid = Number(readFileSync(f.pidFile, 'utf8'));
    expect(error).toMatchObject({ details: { pid } });
    expect(alive(pid)).toBe(false);
  });

  it('allows a per-call deadline long enough for a slower reply', async () => {
    const f = fixture('slow');
    expect(await invokeCli(process.execPath, f.argv, f.env, undefined, undefined, { timeoutMs: 1000 })).toEqual({ finished: true });
  });

  it('cancels an in-flight call and reaps its process with a distinct abort error', async () => {
    const f = fixture('hang'), controller = new AbortController();
    const result = invokeCli(process.execPath, f.argv, f.env, undefined, undefined, { signal: controller.signal });
    for (let i = 0; i < 100 && !existsSync(f.pidFile); i++) await delay(10);
    expect(existsSync(f.pidFile)).toBe(true);
    controller.abort();
    const error = await boundedResult(result);
    expect(error).toBeInstanceOf(HerdrError);
    expect(error).toMatchObject({ code: 'cli-aborted' });
    expect(alive(Number(readFileSync(f.pidFile, 'utf8')))).toBe(false);
  });

  it('does not spawn when cancellation already happened', async () => {
    const f = fixture('hang'), controller = new AbortController(); controller.abort();
    const error = await boundedResult(invokeCli(process.execPath, f.argv, f.env, undefined, undefined, { signal: controller.signal }));
    expect(error).toMatchObject({ code: 'cli-aborted' });
    expect(existsSync(f.pidFile)).toBe(false);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects an invalid deadline %s without spawning', async timeoutMs => {
    const f = fixture('hang');
    await expect(invokeCli(process.execPath, f.argv, f.env, undefined, undefined, { timeoutMs })).rejects.toMatchObject({ code: 'invalid-cli-deadline' });
    expect(existsSync(f.pidFile)).toBe(false);
  });

  it.each(['timeout', 'abort'])('bounds an unreaped child after SIGKILL and preserves the typed %s error and pid', async kind => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123456, kill: () => true });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const controller = new AbortController(); let result: unknown;
    const promise = invokeCli('fixture-cli', [], {}, undefined, undefined, { signal: controller.signal }).catch(error => { result = error; });
    if (kind === 'abort') controller.abort();
    else { await vi.advanceTimersByTimeAsync(14_999); expect(result).toBeUndefined(); await vi.advanceTimersByTimeAsync(1); }
    await vi.advanceTimersByTimeAsync(2999); expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeInstanceOf(HerdrError);
    expect(result).toMatchObject({ code: kind === 'abort' ? 'cli-aborted' : 'cli-timeout', details: { pid: 123456, unreaped: true } });
    await promise;
    expect(vi.getTimerCount()).toBe(0);
    child.emit('close', null, 'SIGKILL');
  });
});

it('core calls honor cleanup deadlines and reap the CLI instead of leaving it running', async () => {
  const core = await createClientFixture(), f = fixture('slow');
  try {
    await expect(invokeCore(process.execPath, f.argv, { ...f.env, ...core.localEnv }, undefined, undefined, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'cli-timeout' });
    expect(alive(Number(readFileSync(f.pidFile, 'utf8')))).toBe(false);
  } finally { await core.close(); }
});
