// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { expect } from 'vitest';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { storyId } from '../harness/scenario.js';
import { stagePayload } from '../fixtures/payloads/index.js';
import { armFault } from '../fixtures/payloads/transport.js';
import { remoteStory, call, begin, result, settled, rejection, exactResult, snapshot, assertNoPanes, writeMarker, remoteEffect, configChanged, shellQuote, deadline, rawDetails } from '../fixtures/payloads/story.js';

export const scenarios: readonly ScenarioDefinition[] = [
  {
    id: storyId('S15'), title: 'Selected destination preserves stdout, stderr, exit and local semantics', tiers: ['headless', 'remote', 'app'],
    async run(suite) {
      // Catches local fallback, merged stderr, wrong exit, and automatic pane creation.
      const s = await remoteStory(suite), effect = join(s.destinationCwd, 'destination-effect');
      await writeFile(join(s.cwd, 'where.txt'), 'local-marker\n');
      await writeMarker(suite, s.machine, join(s.destinationCwd, 'where.txt'), 'destination-marker\n');
      const code = `test "$(cat where.txt)" = destination-marker || exit 97\nprintf 'remote-out\\n'; printf 'remote-err\\n' >&2; printf 'once\\n' >> ${shellQuote(effect)}; exit 23`;
      const value = await call(s, 'route', { action: 'exec', language: 'shell', on: s.machine, code });
      exactResult(value, 'remote-out\n', 'remote-err\n', 23);
      assert.equal(value.remote?.machine, s.machine); assert.ok(value.remote?.jobId); assert.ok(value.remote?.address.startsWith(s.machine + '/'));
      assert.equal(await remoteEffect(suite, s.machine, effect), 'once\n');
      const local = await call(s, 'local', { action: 'exec', language: 'shell', code: 'cat where.txt' });
      exactResult(local, 'local-marker\n', '', 0); assert.equal(local.remote, undefined);
      const bad = await call(s, 'wrong-bytes', { action: 'exec', language: 'shell', on: s.machine, code: "printf 'wrong\\n'; exit 0" });
      expect(() => exactResult(bad, 'remote-out\n', 'remote-err\n', 23)).toThrow();
      await rejection(s, 'invalid-target', { action: 'exec', language: 'shell', on: 'unconfigured.invalid', code: `printf bad >> ${shellQuote(join(s.destinationCwd, 'invalid-effect'))}` }, join(s.destinationCwd, 'invalid-effect'));
      await assertNoPanes(s); await snapshot(s, 'routing');
    },
  },
  {
    id: storyId('S16'), title: 'exec_file reads destination bytes and refuses cwd-less relative paths', tiers: ['headless', 'remote', 'app'],
    async run(suite) {
      // Catches local file reads, early cached contents, and relative-path fallback to the local cwd.
      const s = await remoteStory(suite), path = 'source 雪 space.txt', absolutePath = join(s.destinationCwd, path);
      await writeFile(join(s.cwd, path), 'local-only\n');
      await writeMarker(suite, s.machine, join(s.destinationCwd, path), 'destination-old\n');
      const gate = await armFault(s, { id: 'file-release', mode: 'hold', match: ['file', 'write'], containsSuffix: '/release.json' });
      const at = await begin(s, 'file', [{ id: 'file', args: { action: 'exec_file', language: 'javascript', on: s.machine, path: absolutePath, code: 'console.log(JSON.stringify({content:FILE_CONTENT,path:file_path}))' } }]);
      await gate.ready();
      await writeMarker(suite, s.machine, join(s.destinationCwd, path), 'destination-new\n');
      await gate.release();
      const value = await result(s, 'file'); await settled(s.driver, at);
      const observed = JSON.parse(value.stdout);
      assert.equal(observed.content, 'destination-new\n');
      assert.equal(observed.path, absolutePath); assert.equal(value.exitCode, 0);
      expect(() => assert.equal(observed.content, 'local-only\n')).toThrow();
      const relative = await call(s, 'relative-file', { action: 'exec_file', language: 'javascript', on: s.machine, path, code: 'console.log(JSON.stringify({content:FILE_CONTENT,path:file_path}))' });
      assert.deepEqual(JSON.parse(relative.stdout), { content: 'destination-new\n', path: absolutePath });
      assert.equal(relative.exitCode, 0);
      s.config.machines.find((m: { name: string }) => m.name === s.machine).runtime.cwd = null;
      await configChanged(s);
      const effect = join(s.destinationCwd, 'relative-refusal');
      await rejection(s, 'relative-without-cwd', { action: 'exec_file', language: 'shell', on: s.machine, path, code: `printf bad >> ${shellQuote(effect)}` }, effect);
      const absolute = await call(s, 'absolute-file', { action: 'exec_file', language: 'javascript', on: s.machine, path: join(s.destinationCwd, path), code: 'console.log(FILE_CONTENT)' });
      exactResult(absolute, 'destination-new\n\n', '', 0);
      await snapshot(s, 'file');
    },
  },
  {
    id: storyId('S17'), title: 'Remote batch orders jobs, stops on abort, and preflights every entry', tiers: ['headless', 'remote', 'app'],
    async run(suite) {
      // Catches launching entry three after abort and late batch validation after an earlier effect.
      const s = await remoteStory(suite), effect = join(s.destinationCwd, 'ordered');
      const commands = ['first', 'second', 'third'].map((name, i) => ({ language: 'shell', code: `printf '${name}\\n' >> ${shellQuote(effect)}; printf '${name}\\n'; exit ${i}` }));
      let at = await begin(s, 'ordered', [{ id: 'ordered', args: { action: 'batch', on: s.machine, commands } }]);
      const event = await s.driver.toolResult('ordered', deadline(180000)); await suite.evidence('ordered-result.json', event);
      const values = rawDetails(event) as { stdout: string; exitCode: number; remote: { machine: string; jobId: string } }[];
      assert.equal(values.length, 3);
      assert.deepEqual(values.map(v => v.stdout), ['first\n', 'second\n', 'third\n']);
      assert.deepEqual(values.map(v => v.exitCode), [0, 1, 2]);
      assert.equal(new Set(values.map(v => v.remote.jobId)).size, 3); assert.ok(values.every(v => v.remote.machine === s.machine));
      assert.equal(await remoteEffect(suite, s.machine, effect), 'first\nsecond\nthird\n'); await settled(s.driver, at);
      expect(() => assert.deepEqual(values.map(v => v.stdout), ['third\n', 'second\n', 'first\n'])).toThrow();
      const held = await stagePayload(suite, { id: 'batch-two', beforeStdout: 'entry-two-held\n', stdout: 'entry-two-done\n' });
      const after = join(s.destinationCwd, 'third-must-not-start');
      at = await begin(s, 'aborted', [{ id: 'aborted', args: { action: 'batch', on: s.machine, commands: [
        { language: 'shell', code: "printf 'entry-one\\n'" }, { language: 'shell', code: held.code }, { language: 'shell', code: `printf bad >> ${shellQuote(after)}` },
      ] } }]);
      await held.ready(deadline(30000)); assert.equal(await held.effect(), null); await s.driver.key('\x1b');
      const aborted = await s.driver.toolResult('aborted', deadline(60000)); await suite.evidence('abort-result.json', aborted); await settled(s.driver, at);
      const abortValues = rawDetails(aborted) as { aborted?: boolean; outcome?: string }[];
      assert.equal(abortValues.length, 2); assert.ok(abortValues[1].aborted || abortValues[1].outcome === 'aborted');
      assert.equal(await remoteEffect(suite, s.machine, after), null);
      const early = join(s.destinationCwd, 'preflight-effect');
      await rejection(s, 'entry-target', { action: 'batch', on: s.machine, commands: [{ language: 'shell', code: `printf bad >> ${shellQuote(early)}` }, { language: 'shell', code: 'true', on: s.machine }] }, early);
      await rejection(s, 'denied-ssh-entry', { action: 'batch', on: s.machine, commands: [{ language: 'shell', code: `printf bad >> ${shellQuote(early)}` }, { language: 'shell', code: `ssh ${s.machine} true` }] }, early);
      assert.equal(await readFile(join(suite.root, 'ssh-sentinel.txt'), 'utf8').catch(() => null), null, 'denied batch never reaches the transport sentinel');
      const permitted = await call(s, 'sentinel-control', { action: 'exec', language: 'shell', code: 'ssh unmanaged.invalid true' });
      assert.equal(permitted.exitCode, 99); assert.ok(permitted.stderr.includes('fixture SSH sentinel'));
      assert.equal(await readFile(join(suite.root, 'ssh-sentinel.txt'), 'utf8'), 'invoked\n');
      await assertNoPanes(s); await snapshot(s, 'batch');
    },
  },
];
