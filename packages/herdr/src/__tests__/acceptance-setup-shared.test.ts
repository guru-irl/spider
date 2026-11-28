// SPDX-License-Identifier: MIT
import { describe, it } from 'vitest';
import { modes, run } from './acceptance-runner.js';
import { scenarioShared } from './scenario-setup.js';

describe.each(modes)('complete acceptance (%s)', mode => {
  it('shared status, remote job, viewer, panel notification and setup do not interfere', () => run(mode, scenarioShared), 120000);
});
