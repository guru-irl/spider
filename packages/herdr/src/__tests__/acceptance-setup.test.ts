// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { modes, run } from './acceptance-runner.js';
import { runCompleteSetupAcceptance } from './scenario-setup.js';

describe.each(modes)('complete acceptance (%s)', mode => {
  it('complete setup has zero second-run writes and no duplicate writer or resources', () => run(mode, async h => {
    const result = await runCompleteSetupAcceptance(h);
    expect(result.secondSetup).toMatchObject({ writes: 0, launches: 0 });
    expect(result.piTerminalTextWrites).toEqual([]);
    expect(result.duplicateSessionWriters).toEqual([]);
    expect(result.remainingOwnedResources).toEqual([]);
  }), 180000);
});
