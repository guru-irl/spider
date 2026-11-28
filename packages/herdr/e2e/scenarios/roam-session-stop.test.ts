// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { SessionOutcome, SessionStatus } from '../../../roam/src/relocate/session-stop-types.js';
import { held, parentTurns, runChild, scripts, text, tool } from '../fixtures/child-scripts.js';
import { sessionStopFixture, type CliResult } from '../fixtures/roam-session-stop.js';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

const birth = [text('ordinary source reply')];

async function stopAndStart(suite: Suite): Promise<void> {
  const fixture = await sessionStopFixture(suite);
  const { sessionId } = fixture;
  try {
    const proof = async (stage: string) => {
      const result = await fixture.proof();
      await suite.evidence(`R20-${stage}.json`, result);
      return result;
    };
    const mutationReply = (result: CliResult) => {
      expect([0, 3], result.stderr + result.stdout).toContain(result.exitCode);
      const reply = JSON.parse(result.stdout) as SessionOutcome;
      expect(reply).toMatchObject({ sessionId, machineId: fixture.box.id,
        outcome: result.exitCode === 0 ? 'complete' : 'pending' });
      return reply;
    };
    const mutate = async (action: 'stop' | 'start') =>
      mutationReply(await fixture.cli(action, sessionId, '--json'));
    const status = async (wanted: 'stopped' | 'running'): Promise<SessionStatus> => {
      const found = await waitFor(`cached CLI reports ${wanted}`, async () => {
        const result = await fixture.cli('status', '--json');
        expect(result.exitCode, result.stderr + result.stdout).toBe(0);
        const { sessions } = JSON.parse(result.stdout) as { sessions: SessionStatus[] };
        return sessions.find(row => row.sessionId === sessionId);
      }, row => row?.status === wanted, deadline(35_000), { reconcileMs: 750 });
      if (!found) throw new Error('The session is missing from cached status');
      return found;
    };

    const original = await proof('original');
    const { file: originalFile, cwd: originalCwd, owner: originalOwner, transcriptPrefixHash } = original;
    const checkout = await fixture.checkoutIdentity();
    const runningHome = original.hub.home;
    expect(runningHome).toMatchObject({ session_id: sessionId, machine_id: fixture.box.id, state: 'running' });
    expect(original.box.home).toEqual(runningHome);
    expect(original.liveOwnerCount).toBe(1);
    if (!runningHome || !originalOwner) throw new Error('relocated session has no running home or owner');
    const stoppedHome = { ...runningHome, state: 'stopped', epoch: runningHome.epoch + 1 };
    await suite.evidence('R20-checkout.json', checkout);

    await mutate('stop');
    await status('stopped');
    const confirmedAt = Date.now();
    const proofsAcrossTwoPasses = [];
    let nextScanAfter = confirmedAt;
    for (const pass of [1, 2]) {
      const scan = await fixture.supervisorScanAfter(nextScanAfter);
      await suite.evidence(`R20-supervisor-pass-${pass}.json`, scan);
      const stopped = await proof(`stopped-pass-${pass}`);
      expect(stopped).toMatchObject({ hub: { home: stoppedHome }, box: { home: stoppedHome }, liveOwnerCount: 0, liveOwned: [] });
      proofsAcrossTwoPasses.push(stopped);
      // A retry or a second scan in the same pass is not another 10-second tick.
      nextScanAfter = scan.at + 9_000;
    }
    expect(proofsAcrossTwoPasses).toHaveLength(2);

    const start = async (previous: NonNullable<typeof originalOwner>, stage: string) => {
      await mutate('start');
      await status('running');
      const started = await proof(stage);
      expect(started).toMatchObject({ sessionId, file: originalFile, cwd: originalCwd, liveOwnerCount: 1, transcriptPrefixHash });
      expect(started.owner).not.toEqual(previous);
      expect(started.box.home).toEqual(started.hub.home);
      expect(started.box.home).toMatchObject({ state: 'running' });
      expect(await fixture.checkoutIdentity()).toEqual(checkout);
      if (!started.owner) throw new Error('Start left no verified owner');
      return started.owner;
    };
    const startedOwner = await start(originalOwner, 'started');

    const release = suite.ownPath(join(originalCwd, '.spider', 'r20-job-release'));
    const ready = suite.ownPath(join(originalCwd, '.spider', 'r20-job-ready'));
    const releaseJob = () => writeFile(release, 'release\n', { mode: 0o600 });
    try {
      const gates = await scripts(suite, { birth,
        'spawn-child': parentTurns(runChild('r20-child', 'stop-child', 'held-child')),
        'held-child': [held('r20-child-ready', 'held child')],
        'launch-job': [tool('r20-job', { action: 'exec', language: 'javascript', background: true, timeout: 1_000,
          code: `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid), { mode: 0o600 });
const expires = Date.now() + 90_000;
const poll = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) clearInterval(poll);
  else if (Date.now() >= expires) { clearInterval(poll); process.exitCode = 1; }
}, 50);` }), text('job detached')],
      });
      await fixture.prompt('spawn-child', 'r20-child');
      const child = await gates.ready('r20-child-ready', deadline(30_000));
      await fixture.prompt('launch-job', 'r20-job');
      const jobPid = Number(await readFile(ready, 'utf8'));
      const beforeKill = await proof('before-kill');
      expect(beforeKill.runs).toEqual([{ id: expect.any(String), status: 'running' }]);
      const childRunId = beforeKill.runs[0].id;
      expect(beforeKill.liveOwned).toContainEqual(expect.objectContaining({ pid: child.pid }));
      expect(beforeKill.jobs).toEqual([{ id: expect.any(String), exitVerified: false }]);
      const jobId = beforeKill.jobs[0].id;
      const jobProcesses = beforeKill.jobEvidence[0].live;
      expect(jobProcesses).toContainEqual(expect.objectContaining({ pid: jobPid }));
      expect(jobProcesses).toContainEqual(expect.objectContaining({ pid: beforeKill.jobEvidence[0].manifest.supervisorPid }));
      expect(jobProcesses.map(identity => identity.pid)).not.toContain(child.pid);

      const killResult = await fixture.cli('stop', sessionId, '--now', '--json');
      const beforeJobRelease = await proof('kill-with-held-job');
      const killWithJob = mutationReply(killResult);
      expect(killWithJob).toMatchObject({ status: 'stop-pending', outcome: 'pending', reason: expect.stringContaining(jobId) });
      expect(beforeJobRelease).toMatchObject({ liveOwnerCount: 0, liveOwned: jobProcesses,
        runs: [{ id: childRunId, status: 'cancelled' }], jobs: [{ id: jobId, exitVerified: false }] });
      await releaseJob();
      await status('stopped');
      const afterJobRelease = await proof('job-exited');
      expect(afterJobRelease).toMatchObject({ liveOwnerCount: 0, liveOwned: [] });
      expect(afterJobRelease.jobs).toContainEqual({ id: jobId, exitVerified: true });
    } finally { await releaseJob(); }

    const latestOwner = await start(startedOwner, 'started-after-kill');
    const beforeCut = await proof('before-cut');
    await fixture.partition(true);
    const disconnectedStop = await mutate('stop');
    expect(disconnectedStop).toMatchObject({ outcome: 'pending', status: 'stop-pending' });
    const disconnectedProof = await proof('disconnected');
    expect(disconnectedProof).toMatchObject({ hub: { home: { state: 'stopped' } }, box: { home: { state: 'running' } },
      liveOwnerCount: 1, owner: latestOwner, liveOwned: [latestOwner] });
    expect(disconnectedProof.box.home).toEqual(beforeCut.box.home);
    expect(disconnectedProof.hub.home?.epoch).toBe((beforeCut.hub.home?.epoch ?? 0) + 1);

    await fixture.partition(false);
    const reconnectedStatus = await status('stopped');
    const reconnectedProof = await proof('reconnected');
    expect(reconnectedProof).toMatchObject({ liveOwnerCount: 0, liveOwned: [], hub: { home: disconnectedProof.hub.home },
      box: { home: disconnectedProof.hub.home }, sessionId, file: originalFile, cwd: originalCwd, transcriptPrefixHash });
    expect(reconnectedStatus.status).toBe('stopped');
    expect(await fixture.checkoutIdentity()).toEqual(checkout);
    await suite.evidence('R20-reconnected-status.json', reconnectedStatus);
  } finally { await fixture.close(); }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R20'), title: 'packaged CLI stops, starts, and reconciles after reconnect', tiers: ['headless'],
    script: { scripts: { birth } }, run: stopAndStart },
];
registerScenarios(scenarios);
