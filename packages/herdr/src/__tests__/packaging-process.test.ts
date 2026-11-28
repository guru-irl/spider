// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { run, runAsync } from './packaging-process.js';

describe('packaging validation subprocess', () => {
  it('returns the same stdout for a successful child', async () => {
    const args = ['-e', 'process.stdout.write("validator output")'];
    expect(await runAsync(args)).toBe(run(args));
  });

  it('keeps stderr in a failing child error', async () => {
    const args = ['-e', 'process.stderr.write("invalid artifact"); process.exitCode = 1'];
    expect(() => run(args)).toThrow('invalid artifact');
    await expect(runAsync(args)).rejects.toThrow('invalid artifact');
  });
});
