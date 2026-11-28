// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { modes, run } from './acceptance-runner.js';
import { runCompleteSetupAcceptance } from './scenario-setup.js';

describe.each(modes)('complete acceptance (%s)', mode => {
  it('propagates a producer assertion failure instead of reporting success', () => run(mode, async h => {
    const failure = new assert.AssertionError({ message: 'producer negative control', actual: 1, expected: 0, operator: 'strictEqual' });
    await expect(runCompleteSetupAcceptance(h, [async () => { throw failure; }])).rejects.toBe(failure);
  }), 60000);
});
