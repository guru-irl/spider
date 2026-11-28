// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { createLimiter, createProcessRunners } from './packaging-process.js';

describe('packaging validation subprocess', () => {
  it('runs at most two validations and releases a slot after failure', async () => {
    const limit = createLimiter(2);
    const started: number[] = [];
    const releases: (() => void)[] = [];
    const task = (id: number, fail = false) => limit(async () => {
      started.push(id);
      await new Promise<void>(resolve => { releases[id] = resolve; });
      if (fail) throw new Error('validator failed');
      return id;
    });
    const first = task(0, true), second = task(1), third = task(2);
    expect(started).toEqual([0, 1]);
    releases[0]();
    await expect(first).rejects.toThrow('validator failed');
    expect(started).toEqual([0, 1, 2]);
    releases[1](); releases[2]();
    expect(await Promise.all([second, third])).toEqual([1, 2]);
  });

  it('returns the same stdout for a successful child', async () => {
    const { run, runAsync } = createProcessRunners(process.cwd(), process.env);
    const args = ['-e', 'process.stdout.write("validator output")'];
    expect(await runAsync(args)).toBe(run(args));
  });

  it('keeps stderr in a failing child error', async () => {
    const { run, runAsync } = createProcessRunners(process.cwd(), process.env);
    const args = ['-e', 'process.stderr.write("invalid artifact"); process.exitCode = 1'];
    expect(() => run(args)).toThrow('invalid artifact');
    await expect(runAsync(args)).rejects.toThrow('invalid artifact');
  });
});
