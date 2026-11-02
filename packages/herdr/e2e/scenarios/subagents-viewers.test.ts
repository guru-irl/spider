// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readObserved } from '../harness/pi.js';
import { readFile } from 'node:fs/promises';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { storyId } from '../harness/scenario.js';
import { deadline, waitFor } from '../harness/wait.js';
import type { Suite } from '../harness/suite.js';
import {
  setupFresh, scripts, parent, parentTurns, runChild, text, held, tool, mark, prompt, runRow, viewerAddress,
  attachViewer, viewerContains, ipc, childTranscript, childEvent, instructionCount, messageText,
  feed, putDraft, proveDraft, clearDraft, reload, terminals, saveOwner, withinPhase, transcriptRootControl, replacementLifecycles, readOnlyViewer, childPidForRun, stageViewerTrace, viewerIdentity,
} from '../fixtures/child-scripts.js';

const tiers = ['headless', 'app'] as const;
const refuse = (reply: Record<string, unknown>) => {
  if (reply.ok === true) {
    const ack = reply.acknowledgement as Record<string, unknown> | undefined; assert.ok(ack, JSON.stringify(reply));
    assert.equal(ack.delivery, 'refused', JSON.stringify(reply)); assert.equal(ack.accepted, false); assert.equal(ack.delivered, false); assert.equal(ack.queued, false);
    return;
  }
  assert.equal(reply.ok, false, JSON.stringify(reply));
  assert.ok(['refused', 'unavailable', 'not-found'].includes(String(reply.code)), JSON.stringify(reply));
};

export const scenarios: readonly ScenarioDefinition[] = [
  {
    id: storyId('S29'), title: 'One actual viewer per run in a disposable worktree with no foreign transcript', tiers,
    // Break caught: transcript lookup using the parent checkout instead of the run's explicit cwd.
    async run(suite) {
      suite = await setupFresh(suite);
      await transcriptRootControl(suite);
      const base = await suite.project('base'); const cwd = suite.ownPath(join(suite.root, 'p', 'worktree'));
      const added = await suite.invoke('git', ['worktree', 'add', '-b', 'fixture-view', cwd], suite.env, base);
      assert.equal(added.exitCode, 0, added.stderr);
      const gates = await scripts(suite, {
        owner: parentTurns(runChild('spawn-view', 'same-name', 'view-child', { cwd })),
        'view-child': [{ steps: [
          { gate: 'view-start' }, { text: 'transcript prefix '.repeat(1000) + '\nVIEW_TEXT_α界\n' },
          { tool: { id: 'view-tool', name: 'spider', arguments: { action: 'exec', language: 'javascript', code: `console.log('VIEW_TOOL_λ'); console.log('saved-tool-prefix '.repeat(300)); console.log(Buffer.from('${Buffer.from('VIEW_TRANSCRIPT_TAIL_α界').toString('base64')}', 'base64').toString('utf8'));` } } },
        ] }, held('view-hold', 'ESCALATION[warning]: VIEW_ESCALATION_Ω')],
        decoy: parentTurns(runChild('spawn-decoy', 'same-name', 'decoy-child')),
        'decoy-child': [text('FOREIGN_TRANSCRIPT_DECOY')],
      });
      const decoyCwd = await suite.project('decoy');
      const decoy = await parent(suite, decoyCwd, gates);
      await prompt(decoy, mark('decoy')); await decoy.pi.waitEvent('message_end', e => e.customType === 'spider.subagent_done', deadline(60_000));
      const owner = await parent(suite, base, gates);
      await prompt(owner, mark('owner'));
      const ready = await gates.ready('view-start', deadline(60_000));
      const run = await runRow(owner, 'same-name', r => r.status === 'running');
      const address = await viewerAddress(suite, owner, run); const input = await attachViewer(suite, address);
      await viewerContains(suite, input, 'running');
      const startsBefore = (await readObserved(suite.pi.observerDir)).filter(e => e.type === 'session_start').length;
      const first = await ipc(suite, owner, { op: 'openRun', runId: run.id });
      const second = await ipc(suite, owner, { op: 'openRun', runId: run.id });
      assert.equal((await readObserved(suite.pi.observerDir)).filter(e => e.type === 'session_start').length, startsBefore, 'Opening a viewer may not start another pi agent');
      assert.equal(first.ok, true); assert.equal(second.viewer, first.viewer); assert.equal(first.viewer, address);
      gates.release('view-start'); await gates.ready('view-hold', deadline(60_000));
      const produced = await childEvent(suite, ready.pid, 'tool_execution_end', e => e.toolCallId === 'view-tool');
      assert.ok((produced.result as { details: { stdout: string } }).details.stdout.includes('VIEW_TRANSCRIPT_TAIL_α界'), 'actual tool result contains the committed saved tail');
      await viewerContains(suite, input, 'VIEW_TOOL_λ');
      const output = await viewerContains(suite, input, 'VIEW_TRANSCRIPT_TAIL_α界');
      assert.ok(output.includes('VIEW_TEXT_α界')); assert.ok(!output.includes('FOREIGN_TRANSCRIPT_DECOY'));
      assert.ok(output.includes(run.id) || output.includes('same-name'), 'Viewer must identify the actual run');
      const transcript = await childTranscript(suite, ready.pid);
      const childStart = await childEvent(suite, ready.pid, 'session_start', () => true);
      assert.equal(childStart.cwd, cwd); assert.notEqual(childStart.cwd, owner.cwd);
      assert.ok(transcript.path.startsWith(suite.root + '/')); assert.ok(transcript.raw.includes('VIEW_TRANSCRIPT_TAIL_α界'));
      // Negative ownership control: the real wrong-owner endpoint cannot open this run.
      assert.notEqual(decoy.sessionId, owner.sessionId);
      assert.equal((await ipc(suite, decoy, { op: 'ping' })).ok, true, 'The wrong-owner endpoint must be genuinely alive');
      const wrong = await ipc(suite, decoy, { op: 'openRun', runId: run.id }); assert.equal(wrong.ok, false);
      assert.equal((await terminals(suite)).filter(t => t.labels['spider.kind'] === 'subagent-viewer' && t.labels['spider.run'] === run.id && t.state === 'live').length, 1);
      gates.release('view-hold');
      await viewerContains(suite, input, 'VIEW_ESCALATION_Ω');
      assert.equal((await terminals(suite)).filter(t => t.labels['spider.kind'] === 'subagent-viewer' && t.labels['spider.run'] === run.id && t.state === 'live').length <= 1, true);
      await suite.evidence('worktree-and-decoy.json', { cwd, added, first, second, wrong, transcript: transcript.path });
      await saveOwner(suite, owner); await input.close(); await decoy.pi.close(); await owner.pi.close();
    },
  },
  {
    id: storyId('S30'), title: 'Viewer composer delivers one real steer and preserves the parent editor', tiers,
    // Break caught: an accepted flag without an actual child instruction or changed model behavior.
    async run(suite) {
      suite = await setupFresh(suite); const cwd = await suite.project('owner');
      const instruction = `${mark('steered')} Produce only STEER_APPLIED_界.`;
      const gates = await scripts(suite, {
        owner: parentTurns(runChild('spawn-steer', 'steer-child', 'before')),
        before: [held('steer-ready', 'BEFORE_STEER')],
        steered: [text('STEER_APPLIED_界')],
      });
      const owner = await parent(suite, cwd, gates); await prompt(owner, mark('owner'));
      const ready = await gates.ready('steer-ready', deadline(60_000));
      const run = await runRow(owner, 'steer-child', r => r.canSteer);
      const input = await attachViewer(suite, await viewerAddress(suite, owner, run));
      await viewerContains(suite, input, 'Steer>'); await putDraft(owner.pi);
      // Known-bad slash input reaches the actual endpoint and creates no instruction.
      await input.send('/forbidden-fixture\r'); await viewerContains(suite, input, 'refused');
      assert.equal(instructionCount((await childTranscript(suite, ready.pid)).entries, '/forbidden-fixture'), 0);
      await input.send(instruction + '\r'); await viewerContains(suite, input, '[accepted but not confirmed]'); gates.release('steer-ready');
      await childEvent(suite, ready.pid, 'message_end', e => e.role === 'user' && messageText(e.content) === instruction);
      const output = await viewerContains(suite, input, 'STEER_APPLIED_界');
      const delivered = await viewerContains(suite, input, '[steer_delivery] Steer delivered.');
      assert.ok(delivered.includes('STEER_APPLIED_界') && output.includes('STEER_APPLIED_界'), 'A queued/accepted acknowledgement is not proof of delivery');
      const transcript = await childTranscript(suite, ready.pid); assert.equal(instructionCount(transcript.entries, instruction), 1);
      await owner.pi.waitEvent('message_end', e => e.customType === 'spider.subagent_done', deadline(60_000));
      await proveDraft(owner.pi); await clearDraft(owner.pi);
      await scripts(suite, { ...(JSON.parse(await readFile(suite.pi.scriptPath, 'utf8')).scripts),
        'unknown-owner': parentTurns(runChild('spawn-unknown', 'unknown-child', 'unknown-before')),
        'unknown-before': [held('unknown-ready', 'UNKNOWN_BEFORE')],
        'unknown-steered': [text('UNKNOWN_STEER_APPLIED')],
      });
      await prompt(owner, mark('unknown-owner'));
      const unknownReady = await gates.ready('unknown-ready', deadline(60_000));
      const unknownRun = await runRow(owner, 'unknown-child', r => r.canSteer);
      const uncertain = await attachViewer(suite, await viewerAddress(suite, owner, unknownRun));
      await viewerContains(suite, uncertain, 'Steer>');
      const unknownInstruction = `${mark('unknown-steered')} Do not submit this instruction twice.`;
      // The real socket stays connected, but its owner cannot answer. No fake acknowledgement is injected.
      process.kill(owner.pi.pid, 'SIGSTOP');
      try {
        await uncertain.send(unknownInstruction + '\r');
        await viewerContains(suite, uncertain, 'delivery unknown', deadline(45_000));
      } finally { process.kill(owner.pi.pid, 'SIGCONT'); }
      const ping = await ipc(suite, owner, { op: 'ping' }); assert.equal(ping.ok, true);
      gates.release('unknown-ready');
      await childEvent(suite, unknownReady.pid, 'message_end', e => e.role === 'user' && messageText(e.content) === unknownInstruction);
      await viewerContains(suite, uncertain, 'UNKNOWN_STEER_APPLIED');
      await runRow(owner, 'unknown-child', r => r.status === 'done');
      await reload(owner); await reload(owner);
      await withinPhase('unknown submission remains one actual instruction after reconciliation', async () => childTranscript(suite, unknownReady.pid), value => assert.equal(instructionCount((value as Awaited<ReturnType<typeof childTranscript>>).entries, unknownInstruction), 1));
      await suite.evidence('unknown-delivery.raw', await uncertain.output());
      await saveOwner(suite, owner); await uncertain.close(); await input.close(); await owner.pi.close();
    },
  },
  {
    id: storyId('S31'), title: 'Print, settled, foreign and slash submissions refuse without child input', tiers,
    // Break caught: non-running or foreign runs gaining a writable RPC composer.
    async run(suite) {
      suite = await setupFresh(suite); const cwd = await suite.project('owner');
      const gates = await scripts(suite, {
        owner: parentTurns(runChild('spawn-running', 'running', 'running')),
        running: [held('running-ready', 'RUNNING_FINISH')],
        'spawn-failed': parentTurns(runChild('failed-run', 'failed', 'failure')), failure: [{ steps: [{ error: 'EXPECTED_CHILD_FAILURE' }] }],
        'spawn-print': parentTurns(runChild('print-run', 'print', 'print-child')), 'print-child': [held('print-ready', 'PRINT_FINISH')],
        'spawn-cancel': parentTurns(runChild('cancel-run', 'cancelled', 'cancel-child')), 'cancel-child': [held('cancel-ready', 'CANCEL_MUST_NOT_FINISH')],
        kill: parentTurns(tool('real-kill', { action: 'kill', id: 'all' })),
      });
      const owner = await parent(suite, cwd, gates); await prompt(owner, mark('owner'));
      const runningReady = await gates.ready('running-ready', deadline(60_000));
      const running = await runRow(owner, 'running', r => r.status === 'running');
      await suite.evidence('queued-repetition-retired.json', { retired: 'async parallel ignores concurrency (pre-existing, parallel.ts:15), follow-up filed' });
      const slash = await ipc(suite, owner, { op: 'steerRun', runId: running.id, text: '/must-not-expand' }); refuse(slash);
      const foreignCwd = await suite.project('foreign'); const foreign = await parent(suite, foreignCwd, gates);
      const wrong = await ipc(suite, foreign, { op: 'steerRun', runId: running.id, text: 'FOREIGN_INSTRUCTION_MUST_NOT_APPEAR' }); refuse(wrong);
      assert.equal(instructionCount((await childTranscript(suite, runningReady.pid)).entries, '/must-not-expand'), 0);
      assert.equal(instructionCount((await childTranscript(suite, runningReady.pid)).entries, 'FOREIGN_INSTRUCTION_MUST_NOT_APPEAR'), 0);
      const racing = await attachViewer(suite, await viewerAddress(suite, owner, running));
      await viewerContains(suite, racing, 'Steer>'); await racing.send('COMPLETION_RACE_MUST_NOT_APPEAR');
      gates.release('running-ready');
      await childEvent(suite, runningReady.pid, 'agent_settled', () => true);
      await racing.send('\r'); await viewerContains(suite, racing, '[refused]');
      assert.equal(instructionCount((await childTranscript(suite, runningReady.pid)).entries, 'COMPLETION_RACE_MUST_NOT_APPEAR'), 0);
      await runRow(owner, 'running', r => r.status === 'done');
      const finishedOutput = await viewerContains(suite, racing, 'This run is done.');
      await suite.evidence('completion-race.raw', finishedOutput);
      // A completed live viewer deliberately exits after its two-second linger.
      await waitFor('completed live viewer auto-closes before opening the saved view', () => terminals(suite), rows => !rows.some(row => row.address === racing.address && row.state === 'live'), deadline(10_000));
      await racing.close();
      refuse(await ipc(suite, owner, { op: 'steerRun', runId: running.id, text: 'FINISHED_INSTRUCTION_MUST_NOT_APPEAR' }));
      await readOnlyViewer(suite, owner, await runRow(owner, 'running'), 'FINISHED_INSTRUCTION_MUST_NOT_APPEAR', 'This run is done.', racing.address);
      assert.equal(instructionCount((await childTranscript(suite, runningReady.pid)).entries, 'FINISHED_INSTRUCTION_MUST_NOT_APPEAR'), 0);
      await prompt(owner, mark('spawn-failed')); const failed = await runRow(owner, 'failed', r => r.status === 'failed');
      refuse(await ipc(suite, owner, { op: 'steerRun', runId: failed.id, text: 'FAILED_INSTRUCTION_MUST_NOT_APPEAR' }));
      await readOnlyViewer(suite, owner, failed, 'FAILED_INSTRUCTION_MUST_NOT_APPEAR', 'This run is failed.');
      assert.equal(instructionCount((await childTranscript(suite, await childPidForRun(suite, failed.id))).entries, 'FAILED_INSTRUCTION_MUST_NOT_APPEAR'), 0);
      // Public control changes real spawn mode. No test edits a run row.
      await scripts(suite, { ...(JSON.parse(await readFile(suite.pi.scriptPath, 'utf8')).scripts),
        'set-print': parentTurns(tool('set-print-mode', { action: 'control', command: 'config', op: 'set', scope: 'repo', key: 'subagents.childMode', value: 'print' })),
        'set-rpc': parentTurns(tool('set-rpc-mode', { action: 'control', command: 'config', op: 'set', scope: 'repo', key: 'subagents.childMode', value: 'rpc' })),
      });
      await prompt(owner, mark('set-print')); await owner.pi.toolResult('set-print-mode', deadline(30_000));
      await prompt(owner, mark('spawn-print')); const printReady = await gates.ready('print-ready', deadline(60_000));
      const print = await runRow(owner, 'print', r => r.childMode === 'print');
      const printInput = await attachViewer(suite, await viewerAddress(suite, owner, print));
      await viewerContains(suite, printInput, 'one-shot print'); await printInput.send('PRINT_INSTRUCTION_MUST_NOT_APPEAR\r');
      await viewerContains(suite, printInput, 'refused');
      assert.equal(instructionCount((await childTranscript(suite, printReady.pid)).entries, 'PRINT_INSTRUCTION_MUST_NOT_APPEAR'), 0);
      gates.release('print-ready'); await runRow(owner, 'print', r => r.status === 'done'); await printInput.close();
      await prompt(owner, mark('set-rpc')); await owner.pi.toolResult('set-rpc-mode', deadline(30_000));
      await prompt(owner, mark('spawn-cancel')); const cancelReady = await gates.ready('cancel-ready', deadline(60_000));
      const cancelled = await runRow(owner, 'cancelled', r => r.status === 'running');
      await prompt(owner, mark('kill')); await owner.pi.toolResult('real-kill', deadline(30_000));
      const cancelledFinal = await runRow(owner, 'cancelled', r => r.status === 'cancelled');
      await readOnlyViewer(suite, owner, cancelledFinal, 'CANCELLED_INSTRUCTION_MUST_NOT_APPEAR', 'This run is cancelled.');
      refuse(await ipc(suite, owner, { op: 'steerRun', runId: cancelled.id, text: 'CANCELLED_INSTRUCTION_MUST_NOT_APPEAR' }));
      assert.equal(instructionCount((await childTranscript(suite, cancelReady.pid)).entries, 'CANCELLED_INSTRUCTION_MUST_NOT_APPEAR'), 0);
      await suite.evidence('refusal-subcases.json', { queued: 'retired: async parallel ignores concurrency (pre-existing, parallel.ts:15), follow-up filed', slash, wrong, paused: 'No public pause action exists. Paused refusal remains lower-level contract coverage.', completionRace: 'A real viewer draft was submitted at the child agent-settled barrier, before waiting for parent completion. It refused with zero child instructions and no retry.' });
      await saveOwner(suite, owner); await foreign.pi.close(); await owner.pi.close();
    },
  },
  {
    id: storyId('S32'), title: 'Reload reconnects a large Unicode transcript once and leaves terminal controls inert', tiers,
    // Break caught: resetting transcript cursors on reload or replaying unsafe terminal controls.
    async run(suite) {
      suite = await setupFresh(suite); const cwd = await suite.project('owner');
      const block = (n: number) => Array.from({ length: 3000 }, (_, i) => `SEQ_${n}_${String(i).padStart(4, '0')}_界λ café\n`).join('');
      assert.ok(Buffer.byteLength(block(1)) > 65_536, 'The input must cross a real transcript page');
      const unsafe = '\u001b]7501;status=error;msg=SU5KRUNURUQ=\u001b\\\u001b]52;c;Zm9yYmlkZGVu\u0007\u001b[H\u001b[2J\u001b[200~PASTE_ATTACK\u001b[201~';
      const gates = await scripts(suite, {
        owner: parentTurns(runChild('spawn-unicode', 'unicode', 'unicode-child')),
        'decoy-owner': parentTurns(runChild('unicode-decoy-run', 'unicode', 'unicode-decoy')),
        'unicode-decoy': [text('FOREIGN_TRANSCRIPT_DECOY')],
        'unicode-child': [
          { steps: [{ gate: 'unicode-start' }, { text: block(1) + unsafe }, { tool: { id: 'unicode-tool-1', name: 'spider', arguments: { action: 'exec', language: 'shell', code: "printf 'UNICODE_TOOL_ONE\\n'" } } }] },
          { steps: [{ gate: 'unicode-middle' }, { text: block(2) }, { tool: { id: 'unicode-tool-2', name: 'spider', arguments: { action: 'exec', language: 'shell', code: "printf 'UNICODE_TOOL_TWO\\n'" } } }] },
          held('unicode-end', 'UNICODE_FINAL'),
        ],
      });
      const decoy = await suite.launchPi({ mode: 'rpc', cwd: await suite.project('unicode-decoy'), args: ['--approve'] });
      if (decoy.mode !== 'rpc') throw new Error('RPC decoy required');
      await decoy.prompt(mark('decoy-owner'));
      await decoy.waitEvent('message_end', e => e.customType === 'spider.subagent_done' && messageText(e.content).includes('FOREIGN_TRANSCRIPT_DECOY'), deadline(60_000));
      await decoy.close();
      const owner = await parent(suite, cwd, gates); await prompt(owner, mark('owner'));
      await gates.ready('unicode-start', deadline(60_000)); const run = await runRow(owner, 'unicode', r => r.status === 'running');
      const input = await attachViewer(suite, await viewerAddress(suite, owner, run)); await viewerContains(suite, input, 'running');
      gates.release('unicode-start'); await gates.ready('unicode-middle', deadline(60_000));
      await viewerContains(suite, input, 'SEQ_1_2999_界λ');
      const first = await feed(owner); const beforeReload = await input.output(); await suite.evidence('unicode-before-reload.raw', beforeReload); const reloadOffset = beforeReload.length;
      await reload(owner); await reload(owner);
      assert.equal((await feed(owner)).lifecycle, 'live'); assert.equal((await feed(owner)).sessionId, first.sessionId);
      await putDraft(owner.pi); const before = await suite.hc(['get', owner.pi.terminal, '--json']);
      gates.release('unicode-middle'); await gates.ready('unicode-end', deadline(60_000));
      const output = await viewerContains(suite, input, 'SEQ_2_2999_界λ');
      // The guide documents a transient reload banner; recovery must precede the second stream.
      const reloadedOutput = output.slice(reloadOffset), reconnecting = reloadedOutput.lastIndexOf('[reconnecting]');
      if (reconnecting >= 0) {
        const reconnected = reloadedOutput.indexOf('[reconnected]', reconnecting + '[reconnecting]'.length);
        assert.ok(reconnected > reconnecting && reconnected < reloadedOutput.indexOf('SEQ_2_0000_'), 'The last reload reconnect must recover before the SEQ_2 output');
      }
      assert.ok(!output.slice(reloadOffset).includes('Saved log is read-only.'), 'Reload may not reach a final state');
      const counts = new Map<string, number>();
      for (const match of output.matchAll(/SEQ_([12])_(\d{4})_/g)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
      for (const n of [1, 2]) for (let i = 0; i < 3000; i++) assert.equal(counts.get(`SEQ_${n}_${String(i).padStart(4, '0')}_`), 1, `Repeated or absent sequence ${n}/${i}`);
      assert.ok(!output.includes('FOREIGN_TRANSCRIPT_DECOY'));
      assert.ok(!output.includes('\u001b]7501;')); assert.ok(!output.includes('\u001b]52;'));
      assert.ok(!output.includes('\u001b[200~')); assert.ok(!output.includes('\u001b[201~'));
      const after = await suite.hc(['get', owner.pi.terminal, '--json']);
      assert.deepEqual((after.json as { status?: unknown }).status, (before.json as { status?: unknown }).status);
      await proveDraft(owner.pi); await suite.evidence('status-before-after.json', { before, after });
      await saveOwner(suite, owner); gates.release('unicode-end'); await input.close(); await owner.pi.close();
    },
  },
  {
    id: storyId('S33'), title: 'Replaced and quit owners leave final read-only viewers; reload stays steerable without duplicate instructions', tiers,
    coreEnvironment: { NODE_OPTIONS: '--import=' + fileURLToPath(new URL('../fixtures/viewer-connections.mjs', import.meta.url)) },
    // Break caught: native parent cleanup killing the viewer on quit, or reload falsely closing its feed.
    async run(suite) {
      const trace = await stageViewerTrace(suite); suite = await setupFresh(suite); const cwd = await suite.project('owner');
      const gates = await scripts(suite, {
        owner: parentTurns(runChild('spawn-retained', 'retained', 'retained-child')),
        'retained-child': [text('SAVED_RETAINED_OUTPUT')],
        live: parentTurns(runChild('spawn-live', 'live-after-quit', 'live-child')),
        'live-child': [tool('live-tool', { action: 'exec', language: 'shell', code: "printf 'PRESERVED_VIEW_OUTPUT\\n'" }), held('quit-ready', 'QUIT_CHILD_MUST_NOT_FINISH')],
        'reload-steered': [{ steps: [{ text: 'RELOAD_STEER_APPLIED' }, { tool: { id: 'reload-tool', name: 'spider', arguments: { action: 'exec', language: 'shell', code: "printf 'RELOAD_TOOL_OK\\n'" } } }] }, held('quit-after-steer', 'QUIT_CHILD_STILL_HELD')],
      });
      let owner = await parent(suite, cwd, gates); await prompt(owner, `${mark('owner')} S33_RESUME_TARGET`);
      const retained = await runRow(owner, 'retained', r => r.status === 'done');
      const saved = await ipc(suite, owner, { op: 'openRun', runId: retained.id }); assert.equal(saved.ok, true);
      const savedInput = await attachViewer(suite, String(saved.viewer));
      await viewerContains(suite, savedInput, 'SAVED_RETAINED_OUTPUT');
      await savedInput.send('SAVED_INSTRUCTION_MUST_NOT_APPEAR\r'); await viewerContains(suite, savedInput, 'refused');
      assert.equal(instructionCount((await childTranscript(suite, await childPidForRun(suite, retained.id))).entries, 'SAVED_INSTRUCTION_MUST_NOT_APPEAR'), 0);
      await savedInput.send('\u0003');
      await waitFor('saved viewer explicitly closes', () => terminals(suite), ts => !ts.some(t => t.address === String(saved.viewer) && t.state === 'live'), deadline(30_000));
      await savedInput.close(); owner = await replacementLifecycles(suite, owner, trace);
      await prompt(owner, mark('live')); const ready = await gates.ready('quit-ready', deadline(60_000));
      const run = await runRow(owner, 'live-after-quit', r => r.status === 'running');
      const address = await viewerAddress(suite, owner, run); const input = await attachViewer(suite, address);
      await viewerContains(suite, input, 'PRESERVED_VIEW_OUTPUT');
      const identity = viewerIdentity(suite, run.id); const reloadOffset = (await input.output()).length;
      await reload(owner); assert.equal((await feed(owner)).lifecycle, 'live');
      await runRow(owner, 'live-after-quit', r => r.canSteer);
      await waitFor('viewer has authenticated its same-session snapshot after reload', () => input.output(), output => { const tail = output.slice(reloadOffset); return tail.includes('[reconnected]') || tail.includes('Steer> '); }, deadline(30_000));
      const instruction = `${mark('reload-steered')} Keep working after this real post-reload steer.`;
      await input.send(instruction + '\r'); await viewerContains(suite, input, '[accepted but not confirmed]'); gates.release('quit-ready');
      await childEvent(suite, ready.pid, 'message_end', e => e.role === 'user' && messageText(e.content) === instruction);
      await gates.ready('quit-after-steer', deadline(60_000));
      const reloaded = await viewerContains(suite, input, 'RELOAD_STEER_APPLIED');
      const reloadTail = reloaded.slice(reloadOffset), lastReconnect = reloadTail.lastIndexOf('[reconnecting]');
      if (lastReconnect >= 0) assert.ok(reloadTail.indexOf('[reconnected]', lastReconnect + '[reconnecting]'.length) > lastReconnect, 'Reload must recover after its last reconnect notice');
      assert.ok(!reloadTail.includes('Saved log is read-only.'), 'Reload may not reach a final read-only state');
      assert.equal(instructionCount((await childTranscript(suite, ready.pid)).entries, instruction), 1); assert.deepEqual(viewerIdentity(suite, run.id), identity);
      await suite.evidence('quiet-reload-steer.raw', reloaded); await owner.pi.key('\u0004');
      await waitFor('owner quit writes closed feed', () => feed(owner), f => f.lifecycle === 'closed', deadline(30_000));
      const closedAt = Date.now();
      const output = await viewerContains(suite, input, 'Owning session closed. Saved log is read-only.', deadline(2000));
      assert.ok(Date.now() - closedAt <= 2000); assert.deepEqual(viewerIdentity(suite, run.id), identity);
      assert.ok(output.includes('PRESERVED_VIEW_OUTPUT'));
      await input.send('CLOSED_INSTRUCTION_MUST_NOT_APPEAR\r'); await viewerContains(suite, input, 'refused');
      await withinPhase('closed viewer remains alive until explicit close', () => terminals(suite), value => assert.ok((value as Awaited<ReturnType<typeof terminals>>).some(t => t.address === address && t.state === 'live')));
      const transcript = await childTranscript(suite, ready.pid); assert.equal(instructionCount(transcript.entries, 'CLOSED_INSTRUCTION_MUST_NOT_APPEAR'), 0);
      await suite.evidence('closed-viewer.raw', await input.output()); await saveOwner(suite, owner);
      await input.send('\u0003');
      await waitFor('explicit viewer close removes live terminal', () => terminals(suite), ts => !ts.some(t => t.address === address && t.state === 'live'), deadline(30_000));
      await input.close(); await owner.pi.close();
    },
  },
];
