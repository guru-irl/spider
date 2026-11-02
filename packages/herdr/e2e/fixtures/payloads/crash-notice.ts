// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { chmod, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { signalPi } from '../lifecycle-driver.js';
import { identityAlive, registerModeRestore } from '../../harness/resources.js';
import { HarnessError } from '../../harness/environment.js';
import { stagePayload } from './index.js';
import { begin, result, settled, detached, oneNotice, notices, persistedLogs, call, reload, snapshot, deadline, waitFor, type RemoteStory } from './story.js';

/** The unfaulted and faulted cases use the same real detached payload shape. */
export async function proveCrashDelivery(story: RemoteStory, fault: boolean): Promise<RemoteStory> {
  const suite = story.suite, id = fault ? 'crash-notice' : 'crash-control';
  const p = await stagePayload(suite, { id, beforeStdout: 'P3-start\n', stdout: 'P3-finish\n', stderr: 'P3-error\n', exitCode: 29 });
  const at = await begin(story, id, [{ id, args: { action: 'exec', on: story.machine, language: 'shell', code: p.code, background: true, timeout: 4000 } }]);
  await p.ready(deadline(30000)); const value = await result(story, id); detached(value); await settled(story.driver, at);
  if (!fault) {
    await p.release(); const notice = await oneNotice(story, value.remote!.jobId);
    const logs = await persistedLogs(story, value); assert.equal(logs.stdout.toString(), 'P3-start\nP3-finish\n'); assert.equal(logs.stderr.toString(), 'P3-error\n'); assert.equal(notice.details.exitCode, 29);
    await suite.evidence('P3-paired-control.json', { jobId: value.remote!.jobId, notices: await notices(story, value.remote!.jobId), effect: await p.effect() });
    return story;
  }
  // A mode fault is forbidden until the independent supervisor has registered its restoration.
  const path = suite.ownPath(story.sessionFile), original = await stat(path);
  assert.ok(original.isFile());
  const restoration = registerModeRestore(suite.ledger, path);
  let resumed = story;
  try {
    await chmod(path, (original.mode & 0o777) & ~0o222);
    const journalPath = suite.ownPath(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/jobs/sessions', story.sessionId, 'jobs.json'));
    const submitted = waitFor('P3 durable submission before observed append', async () => {
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      return journal.jobs.find((j: { id: string }) => j.id === value.remote!.jobId);
    }, j => j?.notice === 'submitted', deadline(30000), { reconcileMs: 50 });
    await p.release(); const beforeCrash = await submitted;
    await suite.evidence('P3-submitted.json', beforeCrash);
    const behavior = await waitFor('pi append-refusal observation', async () => ({ alive: identityAlive(story.driver.identity), raw: (await story.driver.rawOutput()).toString(), events: await story.driver.events(), entries: await notices(story, value.remote!.jobId) }),
      v => /EACCES|permission denied|session.*(?:write|save|append).*fail/i.test(v.raw + JSON.stringify(v.events)) || !v.alive || v.entries.length > 0, deadline(15000), { reconcileMs: 100 });
    await suite.evidence('P3-append-refusal.json', behavior); await suite.evidence('P3-append-refusal.raw', behavior.raw);
    assert.equal(behavior.entries.length, 0, 'the denied append must actually prevent durable notice observation');
    assert.ok(behavior.alive, 'pi must remain running long enough to exercise the requested SIGKILL');
    await signalPi(story.driver, 'SIGKILL');
    await restoration.restore();
    assert.equal((await stat(path)).mode & 0o777, original.mode & 0o777);
    const driver = await suite.launchPi({ mode: 'interactive', cwd: story.cwd, args: ['--approve', '--session', path] });
    assert.equal(driver.mode, 'interactive'); const start = await driver.waitEvent('session_start', () => true, deadline(60000));
    assert.equal(start.sessionId, story.sessionId); resumed = { ...story, driver, sessionFile: String(start.sessionFile) };
    await call(resumed, 'crash-reconcile', { action: 'exec', language: 'shell', code: "printf 'crash-reconcile\\n'" });
    await reload(resumed); await call(resumed, 'crash-second-reconcile', { action: 'exec', language: 'shell', code: "printf 'crash-second-reconcile\\n'" });
    const entries = await notices(resumed, value.remote!.jobId); assert.ok(entries.length <= 1, 'P3 promises at most one after unobserved submission');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')), job = journal.jobs.find((j: { id: string }) => j.id === value.remote!.jobId);
    assert.equal(job.phase.kind, 'finished', 'the result remains retrievable after the crash');
    assert.equal(job.phase.result.exitCode, 29);
    assert.equal(job.output.complete, true);
    // Pi may consume the in-memory notice before its denied durable append. No cross-file transaction exists.
    await suite.evidence('P3-delivery-uncertainty.json', { observedNoticeCount: entries.length, deliveryUncertain: entries.length === 0, notice: job.notice, noticeDelivered: job.noticeDelivered, rawJob: job });
    const logs = await persistedLogs(resumed, value); assert.equal(logs.stdout.toString(), 'P3-start\nP3-finish\n'); assert.equal(logs.stderr.toString(), 'P3-error\n'); assert.equal(logs.receipt.exitCode, 29);
    assert.equal(await p.effect(), 'crash-notice\n', 'crash and resume must not re-run the payload');
    await snapshot(resumed, 'P3-crash'); return resumed;
  } finally {
    await restoration.restore();
    assert.equal((await stat(path)).mode & 0o777, original.mode & 0o777, 'owned session mode restored even on story failure');
  }
}
