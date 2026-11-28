// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { modes, run } from './acceptance-runner.js';
import { runCompleteSetupAcceptance, scenarioShared } from './scenario-setup.js';

describe.each(modes)('complete acceptance (%s)', mode => {
  it('shared status, remote job, viewer, panel notification and setup do not interfere', () => run(mode, scenarioShared), 120000);
  it('complete setup has zero second-run writes and no duplicate writer or resources', () => run(mode, async h => {
    const result = await runCompleteSetupAcceptance(h);
    expect(result.secondSetup).toMatchObject({ writes: 0, launches: 0 });
    expect(result.piTerminalTextWrites).toEqual([]);
    expect(result.duplicateSessionWriters).toEqual([]);
    expect(result.remainingOwnedResources).toEqual([]);
  }), 180000);
  it('propagates a producer assertion failure instead of reporting success', () => run(mode, async h => {
    const failure = new assert.AssertionError({ message: 'producer negative control', actual: 1, expected: 0, operator: 'strictEqual' });
    await expect(runCompleteSetupAcceptance(h, [async () => { throw failure; }])).rejects.toBe(failure);
  }), 60000);
});
