// SPDX-License-Identifier: MIT
import { describe, it } from 'vitest';
import { modes, run } from './acceptance-runner.js';
import { scenarioRemote } from './scenario-remote.js';
import { scenarioSsh } from './scenario-ssh.js';
import { scenarioViewers } from './scenario-viewers.js';
import { scenarioShortcuts } from './scenario-templates.js';
import { scenarioSpiderPanel } from './scenario-panels.js';
import { scenarioLook } from './scenario-look.js';

describe.each(modes)('complete acceptance (%s)', mode => {
  it('remote execution and SSH routing', () => run(mode, async h => {
    await scenarioRemote(h); await scenarioSsh(h);
  }), 120000);
  it('subagent viewers', () => run(mode, scenarioViewers), 60000);
  it('spider panel', () => run(mode, scenarioSpiderPanel), 60000);
  it('look', () => run(mode, scenarioLook), 60000);
  it('shortcuts', () => run(mode, scenarioShortcuts), 60000);
});
