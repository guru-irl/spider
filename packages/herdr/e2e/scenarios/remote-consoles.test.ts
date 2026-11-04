// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { storyId } from '../harness/scenario.js';
import { destinationPath } from '../harness/destination.js';
import { stagePayload, readDestination, writeDestination, removeDestination } from '../fixtures/payloads/index.js';
import { remoteStory, anotherOwner, nameSession, begin, result, call, settled, exactResult, detached, inventory, consoles, consoleFor, consoleText, snapshot, assertNoPanes, persistedLogs, digest, reload, oneNotice, deadline, waitFor, typeInObservedConsole } from '../fixtures/payloads/story.js';

export const scenarios: readonly ScenarioDefinition[] = [
  {
    id: storyId('S18'), title: 'Concurrent commands share exactly one console per real agent and machine', tiers: ['headless', 'remote', 'app'],
    async run(suite) {
      // Catches console keying by cwd/name instead of owner and missing serialization of console creation.
      const s = await remoteStory(suite, { secondMachine: true });
      const name = 'Parent with spaces 雪 ' + 'long name '.repeat(24).trim();
      await nameSession(s, name);
      const a = await stagePayload(suite, { id: 'pair-a', beforeStdout: 'held-a\n', stdout: 'done-a\n' });
      const b = await stagePayload(suite, { id: 'pair-b', machine: 'second.invalid', beforeStdout: 'held-b\n', stdout: 'done-b\n' });
      const at = await begin(s, 'same-turn', [
        { id: 'pair-a', args: { action: 'exec', on: s.machine, language: 'shell', code: a.code, background: true, timeout: 4000 } },
        { id: 'same-machine-fast', args: { action: 'exec', on: s.machine, language: 'shell', code: "printf 'fast\\n'" } },
        { id: 'pair-b', args: { action: 'exec', on: 'second.invalid', language: 'shell', code: b.code, background: true, timeout: 4000 } },
      ]);
      await a.ready(deadline(30000)); const ar = await result(s, 'pair-a'); detached(ar);
      exactResult(await result(s, 'same-machine-fast'), 'fast\n', '', 0);
      await b.ready(deadline(30000)); const br = await result(s, 'pair-b'); detached(br); await settled(s.driver, at);
      const sibling = await anotherOwner(s); await nameSession(sibling, 'Sibling with spaces 🙂');
      const cr = await call(sibling, 'sibling-a', { action: 'exec', on: s.machine, language: 'shell', code: "printf 'sibling\\n'" }); exactResult(cr, 'sibling\n', '', 0);
      const dr = await call(sibling, 'sibling-b', { action: 'exec', on: 'second.invalid', language: 'shell', code: "printf 'other-machine\\n'" }); exactResult(dr, 'other-machine\n', '', 0);
      const rows = await inventory(suite);
      for (const [owner, agentName] of [[s, name], [sibling, 'Sibling with spaces 🙂']] as const) for (const machine of [s.machine, 'second.invalid']) {
        const owned = consoles(rows, owner.sessionId, machine); assert.equal(owned.length, 1);
        assert.equal(owned[0].labels['spider.owner-terminal'], owner.driver.terminal);
        const title = await waitFor('actual owned console title', async () => (await suite.hc(['get', owned[0].address, '--json'])).json as { title?: string }, t => t.title === `${agentName} · ${machine}`, deadline(15000));
        assert.equal(title.title, `${agentName} · ${machine}`);
        assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(title.title!));
      }
      assert.equal(new Set(rows.filter(t => t.labels['spider.kind'] === 'remote-console').map(t => t.address)).size, 4);
      expect(() => assert.equal(consoles(rows, sibling.sessionId, s.machine)[0].labels['spider.session'], s.sessionId)).toThrow();
      const target = consoles(rows, s.sessionId, s.machine)[0];
      const native = (await suite.hc(['get', target.address, '--json'])).json as { argv: string[] };
      const directory = native.argv[native.argv.indexOf('--console') + 1]; assert.ok(directory); destinationPath(suite, directory);
      const publicationPath = join(directory, 'console.json'), originalPublication = await readDestination(suite, s.machine, publicationPath); assert.ok(originalPublication);
      const body = JSON.stringify({ version: 1, title: `Safe\x1b]0;injected\x07 Title · ${s.machine}` });
      await writeDestination(suite, s.machine, publicationPath, JSON.stringify({ body, sha256: digest(Buffer.from(body)) }));
      const sanitized = `Safe]0;injected Title · ${s.machine}`;
      await waitFor('control-stripped real console title', async () => (await suite.hc(['get', target.address, '--json'])).json as { title: string }, t => t.title === sanitized, deadline(15000));
      await writeDestination(suite, s.machine, publicationPath, originalPublication);
      await assertNoPanes(s); await a.release(); await b.release(); await oneNotice(s, ar.remote!.jobId); await oneNotice(s, br.remote!.jobId);
      await snapshot(s, 'console-pairs'); await sibling.driver.close();
    },
  },
  {
    id: storyId('S19'), title: 'Console chronology preserves split UTF-8, stderr and read-only input', tiers: ['headless', 'remote', 'app'],
    async run(suite) {
      // Catches a console blocked behind its oldest job, UTF-8 per-chunk decoding, and observer input forwarding.
      const s = await remoteStory(suite), held = await stagePayload(suite, { id: 'long', beforeStdout: 'long-start\n', stdout: 'long-finish\n', exitCode: 23 });
      const at = await begin(s, 'long', [{ id: 'long', args: { action: 'exec', on: s.machine, language: 'shell', code: held.code, background: true, timeout: 4000 } }]);
      await held.ready(deadline(30000)); const long = await result(s, 'long'); detached(long); await settled(s.driver, at);
      const split = await stagePayload(suite, { id: 'split', gate: false, splitUnicode: true, stdout: 'short-finish\n', stderr: 'short-error\n', exitCode: 7 });
      const fast = await call(s, 'split', { action: 'exec', on: s.machine, language: 'shell', code: split.code });
      exactResult(fast, 'split:雪🙂é\nshort-finish\n', 'interleaved-error\nshort-error\n', 7);
      const console = await consoleFor(s);
      const text = await waitFor('later job console exit before older release', () => consoleText(suite, console.address), t => t.includes('#2 ✗ exit 7'), deadline(15000));
      assert.ok(text.includes('long-start')); assert.ok(!text.includes('long-finish'));
      assert.ok(text.includes('#2 │ split:雪🙂é')); assert.ok(text.includes('#2 │ short-error'));
      assert.match(text, /#1 exec [^\n]*\n\s*#2 exec /); assert.ok(!text.includes('(continued)'));
      assert.ok(text.includes(long.remote!.jobId.slice(0, 8)));
      assert.equal((await persistedLogs(s, fast)).receipt.jobId, fast.remote!.jobId);
      expect(() => assert.ok(text.includes('split:local-garbage'))).toThrow();
      assert.equal(await held.effect(), null);
      await typeInObservedConsole(suite, console.address, "printf 'observer-must-not-execute'\r\x03");
      const phase = await call(s, 'post-input', { action: 'exec', on: s.machine, language: 'shell', code: "printf 'input-phase-complete\\n'" });
      exactResult(phase, 'input-phase-complete\n', '', 0); assert.equal(await held.effect(), null);
      await held.release(); await oneNotice(s, long.remote!.jobId);
      const final = await waitFor('long console exit after release', () => consoleText(suite, console.address), t => t.includes('✗ exit 23'), deadline(20000));
      assert.ok(final.indexOf('short-finish') < final.indexOf('long-finish'));
      assert.ok(final.includes('#1 │ long-finish')); assert.ok(final.includes('#1 ✗ exit 23'));
      await snapshot(s, 'console-streams');
    },
  },
  {
    id: storyId('S20'), title: 'Full output survives screen history and bounded model text', tiers: ['headless', 'remote', 'app'],
    async run(suite) {
      // Catches tail-only capture, missing chunks, dropped stream bytes, and leaked wrapper markers.
      const s = await remoteStory(suite), payload = await stagePayload(suite, { id: 'large', gate: false, large: { lines: 20000, bytes: 5 * 1024 * 1024 }, stderr: 'large-error\n', exitCode: 31 });
      const value = await call(s, 'large', { action: 'exec', on: s.machine, language: 'shell', code: payload.code });
      assert.equal(value.exitCode, 31); assert.equal(value.outcome, 'exited');
      const actual = await persistedLogs(s, value);
      // Independently build the expected fixture bytes, without importing the payload generator.
      const numbered = Buffer.from(Array.from({ length: 20000 }, (_, i) => `line-${String(i).padStart(5, '0')}\n`).join(''));
      const bytes = Buffer.from('abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(5 * 1024 * 1024 / 26))).subarray(0, 5 * 1024 * 1024);
      const expected = Buffer.concat([numbered, Buffer.from('bytes-start\n'), bytes, Buffer.from('\nbytes-end\n')]);
      assert.equal(actual.stdout.length, expected.length); assert.equal(digest(actual.stdout), digest(expected));
      assert.equal(actual.stderr.length, 12); assert.equal(digest(actual.stderr), digest(Buffer.from('large-error\n')));
      assert.ok(actual.stdout.subarray(0, 11).equals(Buffer.from('line-00000\n'))); assert.ok(actual.stdout.includes(Buffer.from('line-19999\n')));
      assert.ok(actual.stdout.subarray(-11).equals(Buffer.from('\nbytes-end\n')));
      assert.equal(actual.receipt.exitCode, 31); assert.equal(actual.receipt.stdoutBytes, expected.length); assert.equal(actual.receipt.stderrBytes, 12);
      const event = await s.driver.toolResult('large', deadline(5000)), text = JSON.stringify((event.result as { content: unknown }).content);
      assert.ok(Buffer.byteLength(text) < 20000, 'bounded model output'); assert.ok(text.includes('stdout.log'));
      assert.ok(!text.includes('SPIDER_REMOTE_READY') && !text.includes('waiting-for-pane'), 'wrapper markers stay out of model context');
      const tiny = await call(s, 'large-negative', { action: 'exec', on: s.machine, language: 'shell', code: "printf 'line-00000\\nbytes-end\\n'" });
      const tinyLogs = await persistedLogs(s, tiny);
      expect(() => assert.equal(digest(tinyLogs.stdout), digest(expected))).toThrow();
      await snapshot(s, 'large-output');
    },
  },
  {
    id: storyId('S25'), title: 'Console ID and replay survive reload and settled-history pruning', tiers: ['headless', 'remote', 'app'],
    async run(suite) {
      // Catches console closure on reload and replay that cannot advance after a settled historical directory disappears.
      const s = await remoteStory(suite);
      const historic = await call(s, 'historical', { action: 'exec', on: s.machine, language: 'shell', code: "printf 'historical-complete\\n'" });
      const old = await persistedLogs(s, historic), console = await consoleFor(s);
      const remoteDirectory = destinationPath(suite, old.manifest.remoteDirectory);
      await waitFor('historical foreground directory settled before pruning', () => readDestination(suite, s.machine, join(remoteDirectory, '.spider-settled')), marker => marker !== null, deadline(20000));
      const held = await stagePayload(suite, { id: 'reload-held', beforeStdout: 'before-reload\n', stdout: 'after-reload\n', exitCode: 29 });
      const at = await begin(s, 'reload-held', [{ id: 'reload-held', args: { action: 'exec', on: s.machine, language: 'shell', code: held.code, background: true, timeout: 4000 } }]);
      await held.ready(deadline(30000)); const value = await result(s, 'reload-held'); detached(value); await settled(s.driver, at);
      await reload(s); assert.equal((await consoleFor(s)).address, console.address);
      await held.release(); await oneNotice(s, value.remote!.jobId);
      const logs = await persistedLogs(s, value); assert.equal(logs.stdout.toString(), 'before-reload\nafter-reload\n');
      assert.equal(logs.receipt.exitCode, 29);
      // Prune only a completed foreground directory, never the returned caller-owned background directory.
      assert.notEqual(remoteDirectory, logs.manifest.remoteDirectory);
      await removeDestination(suite, s.machine, remoteDirectory);
      const next = await call(s, 'after-prune', { action: 'exec', on: s.machine, language: 'shell', code: "printf 'new-after-prune\\n'; exit 3" });
      exactResult(next, 'new-after-prune\n', '', 3); assert.equal((await consoleFor(s)).address, console.address);
      const text = await waitFor('console replay after pruned job', () => consoleText(suite, console.address), t => t.includes('✗ exit 3'), deadline(20000));
      assert.ok(text.includes('new-after-prune')); assert.ok(text.includes(next.remote!.jobId.slice(0, 8)));
      assert.equal((await readFile(suite.ownPath(value.backgroundJob!.logs.stdout))).toString(), 'before-reload\nafter-reload\n');
      expect(() => assert.ok(text.includes('invented-after-prune'))).toThrow();
      await snapshot(s, 'reload-history');
    },
  },
];
