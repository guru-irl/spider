// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { expect } from 'vitest';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { storyId } from '../harness/scenario.js';
import { stagePayload, readDestination, writeDestination, removeDestination } from '../fixtures/payloads/index.js';
import { runtimePid, registerDestinationProcess, destinationProcessAlive, signalDestinationProcess } from '../fixtures/payloads/processes.js';
import { stageFault, payloadTransport } from '../fixtures/payloads/transport.js';
import { join } from 'node:path';
import { proveCrashDelivery } from '../fixtures/payloads/crash-notice.js';
import { remoteStory, begin, call, result, settled, exactResult, detached, snapshot, persistedLogs, oneNotice, notices, noticeCount, reload, deadline, waitFor } from '../fixtures/payloads/story.js';

export const scenarios: readonly ScenarioDefinition[] = [
  {
    id: storyId('S21'), title: 'Background capture waits without timeout and detaches with a real durable handle', tiers: ['headless', 'remote', 'app'],
    async run(suite) {
      // Catches background:true being treated as immediate detachment and guessed zero exits at timeout.
      const s = await remoteStory(suite), held = await stagePayload(suite, { id: 'background-wait', beforeStdout: 'capture-start\n', stdout: 'capture-finish\n', stderr: 'capture-error\n', exitCode: 29 });
      let at = await begin(s, 'background-wait', [{ id: 'background-wait', args: { action: 'exec', on: s.machine, language: 'shell', code: held.code, background: true } }]);
      await held.ready(deadline(30000));
      assert.equal(await held.effect(), null);
      assert.ok(!(await s.driver.events()).some(e => e.type === 'tool_execution_end' && e.toolCallId === 'background-wait'), 'no timeout means the tool still waits');
      await held.release(); const foreground = await result(s, 'background-wait'); await settled(s.driver, at);
      exactResult(foreground, 'capture-start\ncapture-finish\n', 'capture-error\n', 29);
      expect(() => detached(foreground)).toThrow();
      const p = await stagePayload(suite, { id: 'detach', beforeStdout: 'before-detach\n', stdout: 'after-detach\n', stderr: 'detached-error\n', exitCode: 29 });
      at = await begin(s, 'detach', [{ id: 'detach', args: { action: 'exec', on: s.machine, language: 'shell', code: p.code, background: true, timeout: 4000 } }]);
      await p.ready(deadline(30000)); const value = await result(s, 'detach'); detached(value); await settled(s.driver, at);
      const handle = value.backgroundJob!;
      const before = await readDestination(suite, s.machine, p.effectPath); assert.equal(before, null);
      const { readFile } = await import('node:fs/promises');
      const saved = await readFile(suite.ownPath(handle.logs.stdout));
      assert.ok(saved.toString().includes('before-detach')); assert.ok(!saved.toString().includes('after-detach'));
      assert.ok(JSON.parse(await readFile(suite.ownPath(handle.manifest), 'utf8')).remoteDirectory);
      await p.release(); const notice = await oneNotice(s, value.remote!.jobId); const logs = await persistedLogs(s, value);
      assert.ok(logs.stdout.length > saved.length); assert.equal(logs.stdout.toString(), 'before-detach\nafter-detach\n'); assert.equal(logs.stderr.toString(), 'detached-error\n');
      assert.equal(logs.receipt.exitCode, 29); assert.equal(notice.details.exitCode, 29); assert.equal(notice.details.machine, s.machine);
      assert.equal(notice.details.address, value.remote!.address); assert.equal(notice.details.complete, true);
      assert.equal(await p.effect(), 'detach\n'); await snapshot(s, 'background');
    },
  },
  {
    id: storyId('S22'), title: 'Fast completion has no duplicate, detach notices survive reload and preserve editor input', tiers: ['headless', 'remote', 'app'],
    async run(suite) {
      // Catches a notice racing a foreground waiter, reload replay, and terminal-paste notice delivery.
      const s = await remoteStory(suite);
      const fast = await call(s, 'foreground-fast', { action: 'exec', on: s.machine, language: 'shell', code: "printf 'fast-result\\n'; exit 23" });
      exactResult(fast, 'fast-result\n', '', 23);
      await call(s, 'fast-reconcile', { action: 'exec', language: 'shell', code: "printf 'ordinary-turn\\n'" });
      noticeCount(await notices(s, fast.remote!.jobId), 0);
      const foregroundNotices = await notices(s, fast.remote!.jobId);
      expect(() => noticeCount(foregroundNotices, 1)).toThrow();
      const p = await stagePayload(suite, { id: 'notice-race', stdout: 'race-finish\n', exitCode: 29 });
      const at = await begin(s, 'notice-race', [{ id: 'notice-race', args: { action: 'exec', on: s.machine, language: 'shell', code: p.code, background: true, timeout: 4000 } }]);
      await p.ready(deadline(30000));
      // Release at the observed return boundary, not after a guessed timer interval.
      const value = await result(s, 'notice-race'); detached(value); await p.release(); await settled(s.driver, at);
      await oneNotice(s, value.remote!.jobId);
      await reload(s); await call(s, 'first-reconcile', { action: 'exec', language: 'shell', code: "printf 'first-reconcile\\n'" });
      await reload(s); await call(s, 'second-reconcile', { action: 'exec', language: 'shell', code: "printf 'second-reconcile\\n'" });
      noticeCount(await notices(s, value.remote!.jobId), 1); noticeCount(await notices(s, fast.remote!.jobId), 0);
      const draftJob = await stagePayload(suite, { id: 'draft-notice', stdout: 'draft-safe-finish\n', exitCode: 23 });
      const draftAt = await begin(s, 'draft-notice', [{ id: 'draft-notice', args: { action: 'exec', on: s.machine, language: 'shell', code: draftJob.code, background: true, timeout: 4000 } }]);
      await draftJob.ready(deadline(30000)); const draftValue = await result(s, 'draft-notice'); detached(draftValue); await settled(s.driver, draftAt);
      const draft = 'left 雪🙂 middle right'; await s.driver.key(draft + '\x1b[D'.repeat(5));
      await waitFor('half-written multibyte draft', () => s.driver.draft(), text => text === draft, deadline(10000));
      await draftJob.release(); const notice = await oneNotice(s, draftValue.remote!.jobId);
      await s.driver.waitEvent('agent_settled', e => e.at >= Date.parse(notice.timestamp), deadline(60000));
      assert.equal(await s.driver.draft(), draft); await s.driver.key('!');
      await waitFor('sentinel proves preserved cursor', () => s.driver.draft(), text => text === 'left 雪🙂 middle !right', deadline(10000));
      noticeCount(await notices(s, draftValue.remote!.jobId), 1);
      const calls = await suite.cores!.records(); assert.ok(!calls.some(c => c.argv[0] === 'send'), 'notices never use hc send');
      const logs = await persistedLogs(s, draftValue); assert.equal(logs.receipt.exitCode, 23); assert.equal(notice.details.complete, true);
      await snapshot(s, 'notice-dedup');
      await s.driver.key('\x03');
      await waitFor('editor cleared by the owned user before crash cases', () => s.driver.draft(), text => text === '', deadline(10000));
      await proveCrashDelivery(s, false);
      const recovered = await proveCrashDelivery(s, true);
      await snapshot(recovered, 'notice-crash');
    },
  },
  {
    id: storyId('S23'), title: 'Timeout, abort, stdin EOF and signal results never fabricate success', tiers: ['headless', 'remote', 'app'],
    async run(suite) {
      // Catches a trapped signal exit zero being reported as a successful timed-out call.
      const missing = await stageFault(suite, { id: 'missing-receipt', mode: 'hold', match: ['file', 'read'], deferred: true });
      const gate = await stageFault(suite, { id: 'receipt-gate', mode: 'hold', match: ['file', 'read'], deferred: true }, missing.binary);
      const s = await remoteStory(suite, { coreBinary: gate.binary }), trap = await stagePayload(suite, { id: 'timeout-zero', onSignalExitZero: true, beforeStdout: 'trap-ready\n' });
      const at = await begin(s, 'timeout-zero', [{ id: 'timeout-zero', args: { action: 'exec', on: s.machine, language: 'shell', code: trap.code, timeout: 8000 } }]);
      await trap.ready(deadline(20000)); const event = await s.driver.toolResult('timeout-zero', deadline(60000));
      await suite.evidence('timeout-zero-result.json', event); const value = await result(s, 'timeout-zero'); await settled(s.driver, at);
      assert.equal(value.timedOut, true); assert.equal(event.isError, true); assert.equal(value.exitCode, 0); assert.equal(value.outcome, 'exited');
      const signal = JSON.parse((await readDestination(suite, s.machine, trap.signalPath))!);
      assert.ok(['SIGHUP', 'SIGTERM', 'SIGINT'].includes(signal.signal)); assert.equal(signal.exitCode, 0); assert.equal(value.signal, undefined);
      assert.equal(await trap.effect(), null, 'timeout must cancel before the gated effect');
      const ordinary = await call(s, 'not-timed-out', { action: 'exec', on: s.machine, language: 'shell', code: 'exit 0' });
      expect(() => assert.equal(ordinary.timedOut, true)).toThrow();
      const stdin = await stagePayload(suite, { id: 'stdin-eof', gate: false, stdin: true });
      exactResult(await call(s, 'stdin-eof', { action: 'exec', on: s.machine, language: 'shell', code: stdin.code }), 'stdin-bytes:0\n', '', 0);
      const killed = await stagePayload(suite, { id: 'signal', gate: false, signal: 'SIGTERM', stdout: 'before-signal\n' });
      const death = await call(s, 'signal', { action: 'exec', on: s.machine, language: 'shell', code: killed.code });
      assert.equal(death.exitCode, null); assert.equal(death.outcome, 'signal'); assert.equal(death.signal, 'SIGTERM');
      assert.equal((await persistedLogs(s, death)).receipt.signal, 'SIGTERM');
      const missingPayload = await stagePayload(suite, { id: 'missing-receipt', beforeStdout: 'missing-receipt-start\n', stdout: 'missing-receipt-out\n' });
      const missingAt = await begin(s, 'missing-receipt', [{ id: 'missing-receipt', args: { action: 'exec', on: s.machine, language: 'shell', code: missingPayload.code } }]);
      await missingPayload.ready(deadline(30000)); const missingTransport = await payloadTransport(s, missingPayload.configPath);
      const missingReceiptPath = join(missingTransport.remoteDirectory, 'receipt.json');
      await missing.enable(missingReceiptPath); await missing.ready(); await missingPayload.release();
      await waitFor('actual receipt publication before removal', () => readDestination(suite, s.machine, missingReceiptPath), bytes => bytes !== null, deadline(20000));
      await removeDestination(suite, s.machine, missingReceiptPath);
      await removeDestination(suite, s.machine, missingReceiptPath + '.sha256');
      await missing.release();
      const missingResult = await result(s, 'missing-receipt'); await settled(s.driver, missingAt);
      assert.equal(missingResult.exitCode, null); assert.equal(missingResult.outcome, 'unknown');
      await waitFor('missing receipt payload completes exactly once', () => missingPayload.effect(), text => text !== null, deadline(10000));
      assert.equal(await missingPayload.effect(), 'missing-receipt\n');
      await suite.evidence('missing-receipt-transport.json', await missing.records());
      const crashed = await stagePayload(suite, { id: 'wrapper-crash', beforeStdout: 'wrapper-start\n', stdout: 'orphan-finish\n' });
      const crashAt = await begin(s, 'wrapper-crash', [{ id: 'wrapper-crash', args: { action: 'exec', on: s.machine, language: 'shell', code: crashed.code } }]);
      const ready = await crashed.ready(deadline(30000)); const original = await payloadTransport(s, crashed.configPath);
      const get = await suite.hc(['get', original.address, '--json']); assert.equal(get.exitCode, 0);
      await suite.evidence('wrapper-crash-native-get.json', get.json as object);
      const wrapperPid = await runtimePid(suite, join(original.remoteDirectory, 'request.json')); assert.notEqual(wrapperPid, ready.pid);
      const wrapperIdentity = await registerDestinationProcess(suite, wrapperPid, 'crashed-runtime', false);
      const payloadIdentity = await registerDestinationProcess(suite, ready.pid, 'orphan-payload', true);
      assert.ok(await destinationProcessAlive(suite, wrapperIdentity)); await signalDestinationProcess(suite, wrapperIdentity, 'SIGKILL');
      const unknown = await result(s, 'wrapper-crash'); await settled(s.driver, crashAt);
      assert.equal(unknown.exitCode, null); assert.equal(unknown.outcome, 'unknown');
      await crashed.release();
      await waitFor('original payload reaches an observable terminal state after wrapper loss', async () => ({ alive: await destinationProcessAlive(suite, payloadIdentity), effect: await crashed.effect() }), observation => !observation.alive || observation.effect !== null, deadline(10000));
      const effect = await crashed.effect(); assert.ok(effect === null || effect === 'wrapper-crash\n', 'wrapper loss cannot execute the effect twice');
      const finalReady = JSON.parse((await readDestination(suite, s.machine, crashed.readyPath))!);
      assert.equal(finalReady.pid, ready.pid, 'the wrapper crash never restarts the gated payload');
      await suite.evidence('wrapper-crash-result.json', { result: unknown, effect, original, originalPayloadPid: ready.pid, finalReadyPid: finalReady.pid, payloadAlive: await destinationProcessAlive(suite, payloadIdentity) });
      const conflict = await stagePayload(suite, { id: 'conflicting', beforeStdout: 'conflict-start\n', stdout: 'conflict-end\n' });
      const conflictAt = await begin(s, 'conflicting', [{ id: 'conflicting', args: { action: 'exec', on: s.machine, language: 'shell', code: conflict.code } }]);
      await conflict.ready(deadline(30000)); const transport = await payloadTransport(s, conflict.configPath);
      const receiptPath = join(transport.remoteDirectory, 'receipt.json');
      await gate.enable(receiptPath); await gate.ready(); await conflict.release();
      const receiptBytes = await waitFor('actual exited receipt before conflict', () => readDestination(suite, s.machine, receiptPath), b => b !== null, deadline(30000));
      const receipt = JSON.parse(receiptBytes!); assert.equal(receipt.exitCode, 0); receipt.exitCode = 23;
      const changed = JSON.stringify(receipt);
      const { digest } = await import('../fixtures/payloads/story.js');
      await writeDestination(suite, s.machine, receiptPath, changed);
      await writeDestination(suite, s.machine, receiptPath + '.sha256', digest(Buffer.from(changed)));
      await gate.release(); const conflicting = await result(s, 'conflicting'); await settled(s.driver, conflictAt);
      assert.equal(conflicting.exitCode, null); assert.equal(conflicting.outcome, 'unknown'); assert.equal(await conflict.effect(), 'conflicting\n');
      await snapshot(s, 'timeout-signal');
    },
  },
];
