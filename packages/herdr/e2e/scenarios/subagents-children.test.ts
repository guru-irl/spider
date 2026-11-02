// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { storyId } from '../harness/scenario.js';
import { destinationRoot, destinationPath } from '../harness/destination.js';
import type { Suite } from '../harness/suite.js';
import type { ObservedEvent } from '../harness/pi.js';
import type { ExecResult as ContextExecResult } from '../../../context/src/executor.js';
import type { JobJournal } from '../../src/jobs/store.js';
import { deadline, waitFor } from '../harness/wait.js';
import { identityAlive, identityOf } from '../harness/resources.js';
import { stagePayload, readDestination, writeDestination, shellQuote } from '../fixtures/payloads/index.js';
import {
  setupFresh, scripts, parent, parentTurns, runChild, text, held, tool, mark, prompt, runRow, feed,
  terminals, childEvent, childEvents, childTranscript, inventoryFiles, saveOwner, reload, withinPhase,
  stageChildOutput, childOutput, sourceHelperControl, type ChildParent,
} from '../fixtures/child-scripts.js';

type ExecResult = ContextExecResult & { remote: NonNullable<ContextExecResult['remote']> };
function result(event: ObservedEvent): ExecResult {
  const value = (event.result as { details?: unknown } | undefined)?.details;
  assert.ok(value && typeof value === 'object', JSON.stringify(event));
  const parsed = value as ContextExecResult;
  assert.equal(typeof parsed.stdout, 'string'); assert.equal(typeof parsed.stderr, 'string');
  assert.ok(parsed.exitCode === null || Number.isInteger(parsed.exitCode));
  assert.ok(parsed.remote, 'A real remote result is required');
  return parsed as ExecResult;
}
async function journal(suite: Suite, owner: ChildParent, runId: string): Promise<JobJournal> {
  const path = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'jobs', 'sessions', owner.sessionId, 'runs', runId, 'jobs.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(value.version, 1); assert.equal(value.sessionId, owner.sessionId);
  assert.ok(Array.isArray(value.jobs));
  await suite.keepEvidence(path, `jobs-${runId}.json`); return value as JobJournal;
}
async function consoleFor(suite: Suite, runId: string) {
  const value = await waitFor(`child console ${runId}`, () => terminals(suite), rows => rows.some(t => t.labels['spider.kind'] === 'remote-console' && t.labels['spider.run'] === runId && t.state === 'live'), deadline(30_000));
  const rows = value.filter(t => t.labels['spider.kind'] === 'remote-console' && t.labels['spider.run'] === runId && t.state === 'live');
  assert.equal(rows.length, 1); return rows[0];
}

export const scenarios: readonly ScenarioDefinition[] = [
  {
    id: storyId('S26'), title: 'Real child uses installed remote exec, file and batch and refuses grandchild delegation', tiers: ['headless', 'remote', 'app'],
    // Break caught: a child resolving a source/manual runtime or losing the top-level owner/action labels.
    async run(suite) {
      await stageChildOutput(suite); suite = await setupFresh(suite); const cwd = await suite.project('first-child');
      const p = await stagePayload(suite, { id: 'child-exec', gate: false, stdout: 'CHILD_REMOTE_OUT\n', stderr: 'CHILD_REMOTE_ERR\n', exitCode: 23 });
      const a = await stagePayload(suite, { id: 'child-batch-a', gate: false, stdout: 'BATCH_A\n', exitCode: 0 });
      const b = await stagePayload(suite, { id: 'child-batch-b', gate: false, stdout: 'BATCH_B\n', exitCode: 0 });
      const remoteFile = destinationPath(suite, join(destinationRoot(suite), 'child file 界.txt')); await writeDestination(suite, p.machine, remoteFile, 'DESTINATION_FILE_界');
      const gates = await scripts(suite, {
        owner: parentTurns(runChild('spawn-child', 'first-child', 'child-remote')),
        'child-remote': [
          tool('child-exec', { action: 'exec', language: 'shell', on: p.machine, code: p.code }),
          tool('child-file', { action: 'exec_file', language: 'javascript', on: p.machine, path: remoteFile, code: 'console.log(FILE_CONTENT); console.log(file_path)' }),
          tool('child-batch', { action: 'batch', on: p.machine, commands: [{ language: 'shell', code: a.code }, { language: 'shell', code: b.code }] }),
          { steps: [{ gate: 'before-grandchild-refusal' }, ...runChild('spawn-grandchild', 'forbidden-grandchild', 'grandchild', { task: `${mark('grandchild')} Request this named grandchild.` }).steps] },
          held('child-complete', 'CHILD_COMPLETE'), ...Array.from({ length: 6 }, () => text('grandchild completion observed')),
        ],
        grandchild: [text('FORBIDDEN_GRANDCHILD_MUST_NOT_START')],
      });
      const owner = await parent(suite, cwd, gates); await prompt(owner, mark('owner'));
      const ready = await gates.ready('before-grandchild-refusal', deadline(120_000));
      const processesBefore = (await readdir(join(suite.root, 'procs'))).sort(); const startsBefore = (await childEvents(suite, ready.pid)).filter(e => e.type === 'session_start').length;
      const runsBefore = (await feed(owner)).runs.rows.map(row => row.id).sort(); const terminalsBefore = await terminals(suite);
      gates.release('before-grandchild-refusal'); await gates.ready('child-complete', deadline(60_000));
      const delegation = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'spawn-grandchild');
      if (delegation.isError) {
        const exec = result(await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'child-exec'));
        const file = result(await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'child-file'));
        const batch = (await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'child-batch')).result as { details: ExecResult[] };
        assert.equal(exec.stdout, 'CHILD_REMOTE_OUT\n'); assert.equal(exec.stderr, 'CHILD_REMOTE_ERR\n'); assert.equal(exec.exitCode, 23);
        assert.equal(file.stdout, `DESTINATION_FILE_界\n${remoteFile}\n`); assert.equal(file.exitCode, 0);
        assert.deepEqual(batch.details.map(value => value.stdout), ['BATCH_A\n', 'BATCH_B\n']);
        await suite.evidence('first-child-before-delegation-refusal.json', { exec, file, batch, delegation, output: await childOutput(suite, ready.pid), records: await suite.cores!.records() });
      }
      assert.equal(delegation.isError, true); assert.equal((delegation.result as { details: { code: string; run?: unknown } }).details.code, 'unavailable_in_child');
      assert.equal((delegation.result as { details: { run?: unknown } }).details.run, undefined);
      assert.deepEqual((await readdir(join(suite.root, 'procs'))).sort(), processesBefore, 'Refused delegation must launch no pi process');
      assert.equal((await childEvents(suite, ready.pid)).filter(e => e.type === 'session_start').length, startsBefore);
      assert.deepEqual((await feed(owner)).runs.rows.map(row => row.id).sort(), runsBefore, 'Refused delegation must create no run row');
      const terminalsAfter = await terminals(suite); assert.ok(terminalsAfter.every(row => terminalsBefore.some(before => before.address === row.address)), 'Refused delegation must create no terminal or console');
      await suite.evidence('grandchild-refusal.json', { retired: 'no grandchild delegation by design (dispatch.ts:89)', delegation, processesBefore, runsBefore, terminalsBefore, terminalsAfter });
      const run = await runRow(owner, 'first-child', r => r.status === 'running');
      const childStart = await childEvent(suite, ready.pid, 'session_start', () => true);
      assert.equal(childStart.model, 'e2e-fixture/scripted');
      const childBytes = await childOutput(suite, ready.pid); assert.ok(childBytes.stdout.includes('CHILD_REMOTE_OUT'));
      assert.ok(!childBytes.stdout.includes('\u001b]7501;')); assert.ok(!childBytes.stderr.includes('\u001b]7501;'));
      await suite.evidence('actual-child-bytes.json', { childBytes });
      const exec = result(await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'child-exec'));
      assert.equal(exec.stdout, 'CHILD_REMOTE_OUT\n'); assert.equal(exec.stderr, 'CHILD_REMOTE_ERR\n'); assert.equal(exec.exitCode, 23);
      assert.equal(exec.remote.machine, p.machine); assert.ok(exec.remote.jobId);
      const file = result(await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'child-file'));
      assert.equal(file.stdout, `DESTINATION_FILE_界\n${remoteFile}\n`); assert.equal(file.exitCode, 0);
      const batchEvent = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'child-batch');
      const batch = (batchEvent.result as { details: ExecResult[] }).details; assert.equal(batch.length, 2);
      assert.equal(batch[0].stdout, 'BATCH_A\n'); assert.equal(batch[1].stdout, 'BATCH_B\n'); assert.notEqual(batch[0].remote.jobId, batch[1].remote.jobId);
      const childJournal = await journal(suite, owner, run.id);
      assert.ok(childJournal.child); assert.equal(childJournal.child.id, run.id);
      for (const job of childJournal.jobs) assert.equal(job.owner.sessionId, owner.sessionId);
      assert.deepEqual(childJournal.jobs.map(job => job.kind), ['exec', 'exec-file', 'batch', 'batch']);
      const records = await suite.cores!.records();
      const expected = [[exec, 'exec', run.id], [file, 'exec-file', run.id], [batch[0], 'batch', run.id], [batch[1], 'batch', run.id]] as const;
      const runtimeName = `spider-remote-runtime-${suite.packed.digests['dist/herdr/remote-runtime.mjs'].slice(0, 16)}.mjs`;
      for (const [value, kind, runId] of expected) {
        const launches = records.filter(r => r.argv[0] === 'run' && r.argv.includes(`spider.job=${value.remote.jobId}`));
        assert.equal(launches.length, 1, 'A child job must launch exactly once through real hc');
        assert.ok(launches[0].argv.includes(`spider.session=${owner.sessionId}`));
        assert.ok(launches[0].argv.includes(`spider.run=${runId}`));
        assert.ok(launches[0].argv.includes(`spider.kind=${kind}`));
        assert.ok(launches[0].argv.includes('--no-notify'));
        const installedPath = launches[0].argv.find(arg => arg.endsWith('/' + runtimeName)); assert.ok(installedPath);
        const installedBytes = await readDestination(suite, p.machine, installedPath); assert.ok(installedBytes);
        assert.equal(createHash('sha256').update(installedBytes).digest('hex'), suite.packed.digests['dist/herdr/remote-runtime.mjs']);
      }
      const childConsole = await consoleFor(suite, run.id);
      assert.equal(childConsole.labels['spider.session'], owner.sessionId);
      assert.equal(await p.effect(), 'child-exec\n'); assert.equal(await a.effect(), 'child-batch-a\n'); assert.equal(await b.effect(), 'child-batch-b\n');
      // Invalid-target control goes through the actual child tool and must not execute locally.
      const forbiddenEffect = suite.ownPath(join(cwd, 'bad-local-fallback'));
      await scripts(suite, { ...(JSON.parse(await readFile(suite.pi.scriptPath, 'utf8')).scripts), bad: [tool('bad-target', { action: 'exec', on: 'missing.invalid', language: 'shell', code: `printf 'BAD_LOCAL_FALLBACK' > ${shellQuote(forbiddenEffect)}` }), text('bad target observed')], 'spawn-bad': parentTurns(runChild('bad-child', 'bad-target', 'bad')) });
      await prompt(owner, mark('spawn-bad')); const badRun = await runRow(owner, 'bad-target');
      await runRow(owner, 'bad-target', r => r.status === 'done' || r.status === 'failed');
      const all = await import('../harness/pi.js').then(m => m.readObserved(suite.pi.observerDir));
      const bad = all.find(e => e.type === 'tool_execution_end' && e.toolCallId === 'bad-target'); assert.ok(bad); assert.equal(bad.isError, true);
      await assert.rejects(readFile(forbiddenEffect), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
      await suite.evidence('composed-children.json', { exec, file, batch, childStart, records, childConsole, delegation, badRun, bad });
      await sourceHelperControl(suite);
      gates.release('child-complete'); await saveOwner(suite, owner); await owner.pi.close();
    },
  },
  {
    id: storyId('S28'), title: 'Normal, killed and crashed children cancel foreground and hand off background once', tiers: ['headless', 'remote', 'app'],
    // Break caught: parent handoff killing detached work, adopting a sibling, or posting duplicate notices.
    async run(suite) {
      suite = await setupFresh(suite); const cwd = await suite.project('handoff');
      const normal = await stagePayload(suite, { id: 'normal-bg', stdout: 'NORMAL_BG_FINISH\n', exitCode: 29 });
      const killedBg = await stagePayload(suite, { id: 'killed-bg', stdout: 'KILLED_BG_FINISH\n', exitCode: 29 });
      const killedFg = await stagePayload(suite, { id: 'killed-fg', stdout: 'KILLED_FG_MUST_NOT_FINISH\n' });
      const crashBg = await stagePayload(suite, { id: 'crash-bg', stdout: 'CRASH_BG_FINISH\n', exitCode: 29 });
      const crashFg = await stagePayload(suite, { id: 'crash-fg', stdout: 'CRASH_FG_MUST_NOT_FINISH\n' });
      const sibling = await stagePayload(suite, { id: 'sibling-bg', stdout: 'SIBLING_BG_FINISH\n', exitCode: 29 });
      const quitBg = await stagePayload(suite, { id: 'quit-bg', stdout: 'QUIT_BG_FINISH\n', exitCode: 29 });
      const bg = (id: string, p: typeof normal) => tool(id, { action: 'exec', language: 'shell', on: p.machine, code: p.code, background: true, timeout: 1200 });
      const fg = (id: string, p: typeof normal) => tool(id, { action: 'exec', language: 'shell', on: p.machine, code: p.code });
      const gates = await scripts(suite, {
        owner: parentTurns(runChild('normal-run', 'normal', 'normal')), normal: [bg('normal-bg', normal), held('normal-end', 'normal child done')],
        'spawn-sibling': parentTurns(runChild('sibling-run', 'sibling', 'sibling')), sibling: [bg('sibling-bg', sibling), held('sibling-end', 'sibling child done')],
        'spawn-kill': parentTurns(runChild('killed-run', 'killed', 'killed')), killed: [bg('killed-bg', killedBg), fg('killed-fg', killedFg), text('killed child must not finish')],
        'spawn-crash': parentTurns(runChild('crash-run', 'crashed', 'crashed')), crashed: [bg('crash-bg', crashBg), fg('crash-fg', crashFg), text('crashed child must not finish')],
        ordinary: parentTurns(text('ordinary reconciliation turn')),
        'spawn-quit': parentTurns(runChild('quit-run', 'quit-survivor', 'quit-survivor')), 'quit-survivor': [bg('quit-bg', quitBg), held('quit-adopt', 'quit background adopted')],
      });
      const owner = await parent(suite, cwd, gates); await prompt(owner, mark('owner'));
      await normal.ready(deadline(60_000)); await gates.ready('normal-end', deadline(60_000));
      const normalRun = await runRow(owner, 'normal', r => r.status === 'running');
      const normalConsole = await consoleFor(suite, normalRun.id);
      const normalSpawn = await owner.pi.toolResult('normal-run', deadline(30_000));
      const normalPid = (normalSpawn.result as { details: { run: { pid: number } } }).details.run.pid;
      const normalResult = result(await childEvent(suite, normalPid, 'tool_execution_end', e => e.toolCallId === 'normal-bg'));
      assert.equal(normalResult.exitCode, null); assert.ok(normalResult.backgroundJob);
      const adoptedNotices = [{ runId: normalRun.id, jobId: normalResult.remote.jobId }];
      gates.release('normal-end'); await runRow(owner, 'normal', r => r.status === 'done');
      await waitFor('normal child console closes without killing its background', () => terminals(suite), rows => !rows.some(t => t.address === normalConsole.address && t.state === 'live'), deadline(30_000));
      assert.equal(await normal.effect(), null);
      await prompt(owner, mark('spawn-sibling')); await sibling.ready(deadline(60_000)); await gates.ready('sibling-end', deadline(60_000));
      const siblingRun = await runRow(owner, 'sibling', r => r.status === 'running'); const siblingConsole = await consoleFor(suite, siblingRun.id);
      for (const [spawnMarker, name, callId, background, foreground, mode] of [
        ['spawn-kill', 'killed', 'killed-run', killedBg, killedFg, 'tool'],
        ['spawn-crash', 'crashed', 'crash-run', crashBg, crashFg, 'signal'],
      ] as const) {
        await prompt(owner, mark(spawnMarker)); await background.ready(deadline(60_000)); await foreground.ready(deadline(60_000));
        const run = await runRow(owner, name, r => r.status === 'running'); const console = await consoleFor(suite, run.id);
        const spawnEvent = await owner.pi.toolResult(callId, deadline(30_000));
        const pid = (spawnEvent.result as { details: { run: { pid: number } } }).details.run.pid;
        const foregroundJob = (await journal(suite, owner, run.id)).jobs.find(job => !job.detached);
        assert.ok(foregroundJob && 'address' in foregroundJob.phase, 'held foreground job must identify its actual native terminal');
        const foregroundAddress = foregroundJob.phase.address;
        const beforeStop = (await terminals(suite)).find(t => t.address === foregroundAddress);
        assert.equal(beforeStop?.state, 'live', 'foreground terminal must be genuinely alive before the child ends');
        const detached = result(await childEvent(suite, pid, 'tool_execution_end', e => e.toolCallId === background.id));
        assert.equal(detached.exitCode, null); assert.ok(detached.backgroundJob);
        adoptedNotices.push({ runId: run.id, jobId: detached.remote.jobId });
        const identity = identityOf(pid); suite.ledger.update(l => { l.processes.push({ ...identity, label: `handoff-${name}`, group: false }); });
        if (mode === 'tool') {
          const killMarker = `kill-${name}`;
          await scripts(suite, { ...(JSON.parse(await readFile(suite.pi.scriptPath, 'utf8')).scripts), [killMarker]: parentTurns(tool(`kill-${run.id}`, { action: 'kill', id: run.id })) });
          await prompt(owner, mark(killMarker)); const killed = await owner.pi.toolResult(`kill-${run.id}`, deadline(30_000)); assert.equal(killed.isError, false);
        } else { assert.ok(identityAlive(identity)); process.kill(pid, 'SIGKILL'); }
        await waitFor('proved child writer gone', () => identityAlive(identity), live => !live, deadline(30_000));
        const atClosure = await waitFor('ended child console closed but sibling survives', () => terminals(suite), ts => !ts.some(t => t.address === console.address && t.state === 'live') && ts.some(t => t.address === siblingConsole.address && t.state === 'live'), deadline(30_000));
        const foregroundAtClosure = atClosure.find(t => t.address === foregroundAddress);
        await suite.evidence(`foreground-at-console-close-${name}.json`, { job: foregroundJob, beforeStop, foregroundAtClosure, terminals: atClosure });
        assert.notEqual(foregroundAtClosure?.state, 'live', 'foreground terminal must already be stopped when the child console closes');
        await foreground.release();
        await withinPhase('cancelled foreground has no effect after release', foreground.effect, value => assert.equal(value, null));
        assert.equal(await background.effect(), null); await background.release();
        await waitFor('adopted background finishes once', background.effect, effect => effect === `${background.id}\n`, deadline(60_000));
        const j = await waitFor('adopted job has verified finish', () => journal(suite, owner, run.id), j => j.jobs.some(job => job.detached && job.phase.kind === 'finished' && job.phase.result.exitCode === 29), deadline(60_000));
        await suite.evidence(`handoff-${name}.json`, { run, identity, journal: j, foregroundEffect: await foreground.effect(), backgroundEffect: await background.effect() });
      }
      await normal.release(); await waitFor('normal adopted payload finishes', normal.effect, effect => effect === 'normal-bg\n', deadline(60_000));
      for (const notice of adoptedNotices) await owner.pi.waitEvent('message_end', e => e.customType === 'spider.job_done' && JSON.stringify(e.content).includes(notice.jobId) && JSON.stringify(e.content).includes(notice.runId), deadline(60_000));
      await reload(owner); await reload(owner); await prompt(owner, mark('ordinary'));
      const jobNotices = (await owner.pi.events()).filter(e => e.type === 'message_end' && e.customType === 'spider.job_done');
      for (const notice of adoptedNotices) assert.equal(jobNotices.filter(e => JSON.stringify(e.content).includes(notice.jobId) && JSON.stringify(e.content).includes(notice.runId)).length, 1);
      await suite.evidence('job-notices.json', jobNotices);
      await prompt(owner, mark('spawn-quit')); await quitBg.ready(deadline(60_000)); await gates.ready('quit-adopt', deadline(60_000));
      const quitRun = await runRow(owner, 'quit-survivor'); gates.release('quit-adopt'); await runRow(owner, 'quit-survivor', r => r.status === 'done');
      const quitJournal = await journal(suite, owner, quitRun.id); const quitJob = quitJournal.jobs.find(j => j.detached); assert.ok(quitJob);
      gates.release('sibling-end'); await sibling.release(); await waitFor('sibling independent finish', sibling.effect, effect => effect === 'sibling-bg\n', deadline(60_000));
      await saveOwner(suite, owner); await owner.pi.key('\u0004'); await waitFor('owner closed before payload release', () => feed(owner), f => f.lifecycle === 'closed', deadline(30_000));
      await quitBg.release(); await waitFor('adopted background outlives parent quit', quitBg.effect, effect => effect === 'quit-bg\n', deadline(60_000));
      assert.equal(await readDestination(suite, quitBg.machine, quitBg.effectPath), 'quit-bg\n');
      const receiptText = await waitFor('destination receipt finishes after owner quit', () => readDestination(suite, quitBg.machine, join(quitJob.remoteDirectory, 'receipt.json')), value => value !== null, deadline(30_000));
      assert.ok(receiptText); const receipt = JSON.parse(receiptText);
      assert.equal(receipt.jobId, quitJob.id); assert.equal(receipt.nonce, quitJob.nonce); assert.equal(receipt.outcome, 'exited'); assert.equal(receipt.exitCode, 29);
      const digest = await readDestination(suite, quitBg.machine, join(quitJob.remoteDirectory, 'receipt.json.sha256'));
      assert.equal(createHash('sha256').update(receiptText).digest('hex'), digest?.trim());
      await suite.evidence('quit-survival.json', { quitRun, effect: await quitBg.effect(), receipt }); await owner.pi.close();
    },
  },
];
