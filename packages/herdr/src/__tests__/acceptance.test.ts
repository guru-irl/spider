// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { modes, run } from './acceptance-runner.js';
import { scenarioStatus } from './scenario-status.js';
import { scenarioJobs } from './scenario-jobs.js';
import { scenarioResume, scenarioSpaces } from './scenario-sessions.js';
import { scenarioGuidance, scenarioRoles } from './scenario-templates.js';
import { assertNoNativeNotes, observeSecondSetup } from './scenario-setup.js';

if (modes.length === 1) console.info('Real isolated-core acceptance disabled. Set SPIDER_HERDR_E2E=1; native app acceptance requires user opt-in.');

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
  it('status', () => run(mode, scenarioStatus), 60000);
  it('job notices', () => run(mode, scenarioJobs), 60000);
  it('guidance', () => run(mode, scenarioGuidance), 60000);
  it('reboot resume', () => run(mode, scenarioResume), 60000);
  it('spaces', () => run(mode, scenarioSpaces), 60000);
  it('role templates', () => run(mode, scenarioRoles), 60000);
});
