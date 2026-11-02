// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import type { AcceptanceScenario } from './testutil.js';
import { scenarioStatus } from './scenario-status.js';
import { scenarioJobs } from './scenario-jobs.js';
import { scenarioRemote } from './scenario-remote.js';
import { scenarioSsh } from './scenario-ssh.js';
import { scenarioViewers } from './scenario-viewers.js';
import { scenarioResume, scenarioSpaces } from './scenario-sessions.js';
import { scenarioGuidance, scenarioRoles, scenarioShortcuts } from './scenario-templates.js';
import { scenarioSpiderPanel } from './scenario-panels.js';
import { scenarioLook } from './scenario-look.js';
import { runCompleteSetupAcceptance, createAcceptanceHarness, assertNoNativeNotes, scenarioShared, observeSecondSetup } from './scenario-setup.js';
import type { AcceptanceMode } from '../contracts.js';

async function run(mode: AcceptanceMode, scenario: AcceptanceScenario): Promise<void> {
  const h = await createAcceptanceHarness(mode);
  try { await h.start(); await scenario(h); }
  finally { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}

const modes: AcceptanceMode[] = ['fake'];
if (process.env.SPIDER_HERDR_E2E === '1') modes.push(process.env.SPIDER_HERDR_APP_E2E === '1' ? 'app' : 'hc');
else console.info('Real isolated-core acceptance disabled. Set SPIDER_HERDR_E2E=1; native app acceptance requires user opt-in.');

it('observes remote file writes and launches in the rerun counter', () => run('fake', async h => {
  const before = await h.calls();
  await h.hc.fileWrite('remote.invalid' as never, `${h.directories.remote}/counter-control`, Buffer.from('control'));
  await h.hc.run({ argv: [h.nodeBinary, '-e', 'process.exit(0)'], cwd: h.root, labels: {}, background: true, outliveParent: true, noNotify: true });
  expect(observeSecondSetup(0, (await h.calls()).slice(before.length))).toEqual({ writes: 1, launches: 1 });
}));

it('rejects a launch that omits native-note suppression and an empty launch log', () => {
  expect(() => assertNoNativeNotes([{ argv: ['run', '--no-notify', '--', 'fixture'] }, { argv: ['run', '--', 'fixture'] }])).toThrow('Native notes were not disabled');
  expect(() => assertNoNativeNotes([])).toThrow('at least one actual hc run');
});

describe.each(modes)('complete acceptance (%s)', mode => {
  it('shared status, remote job, viewer, panel notification and setup do not interfere', () => run(mode, scenarioShared), 120000);
  it('status', () => run(mode, scenarioStatus), 60000);
  it('job notices', () => run(mode, scenarioJobs), 60000);
  it('guidance', () => run(mode, scenarioGuidance), 60000);
  it('reboot resume', () => run(mode, scenarioResume), 60000);
  it('spaces', () => run(mode, scenarioSpaces), 60000);
  it('role templates', () => run(mode, scenarioRoles), 60000);
  it('remote execution and SSH routing', () => run(mode, async h => {
    await scenarioRemote(h); await scenarioSsh(h);
  }), 120000);
  it('subagent viewers', () => run(mode, scenarioViewers), 60000);
  it('spider panel', () => run(mode, scenarioSpiderPanel), 60000);
  it('look', () => run(mode, scenarioLook), 60000);
  it('shortcuts', () => run(mode, scenarioShortcuts), 60000);
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
