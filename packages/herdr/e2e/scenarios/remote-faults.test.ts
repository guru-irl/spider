// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { expect } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { storyId } from '../harness/scenario.js';
import { destinationRoot, destinationPath } from '../harness/destination.js';
import type { RemoteSuite } from '../harness/remote.js';
import { stagePayload, readDestination, writeDestination, removeDestination } from '../fixtures/payloads/index.js';
import { remoteStory, begin, call, result, settled, rejection, exactResult, snapshot, shellQuote, deadline, waitFor, configChanged } from '../fixtures/payloads/story.js';
import { armFault, payloadTransport } from '../fixtures/payloads/transport.js';

export const scenarios: readonly ScenarioDefinition[] = [
  {
    id: storyId('S24'), title: 'Transport loss and corrupt publication never retry payloads or fabricate complete results', tiers: ['headless', 'remote'],
    async run(suite) {
      // Catches retry-after-accept, local fallback, complete tail-only logs, and doctor mutation/autostart.
      const s = await remoteStory(suite), invalid = join(s.destinationCwd, 'invalid-target');
      await rejection(s, 'invalid', { action: 'exec', language: 'shell', on: 'missing.invalid', code: `printf bad >> ${shellQuote(invalid)}` }, invalid);
      const installed = await import('../harness/setup.js').then(m => m.readInstalled(suite));
      const runtime = installed.runtimes.find((r: { machine: string }) => r.machine === s.machine)!;
      assert.ok(runtime); const runtimeBytes = await readDestination(suite, s.machine, runtime.path); assert.ok(runtimeBytes);
      await writeDestination(suite, s.machine, runtime.path, 'invalid runtime fixture\n');
      const bootstrapEffect = join(s.destinationCwd, 'bootstrap-effect');
      await rejection(s, 'bootstrap', { action: 'exec', language: 'shell', on: s.machine, code: `printf bad >> ${shellQuote(bootstrapEffect)}` }, bootstrapEffect);
      const invalidDoctor = await suite.invoke(process.execPath, [suite.packed.cli, 'doctor', '--config', s.configPath], { ...suite.env, ...suite.cores!.local.env });
      await suite.evidence('doctor-invalid-runtime.json', invalidDoctor);
      assert.notEqual(invalidDoctor.exitCode, 0); assert.match(invalidDoctor.stdout + invalidDoctor.stderr, /runtime/i); assert.match(invalidDoctor.stdout + invalidDoctor.stderr, /setup|repair/i);
      await writeDestination(suite, s.machine, runtime.path, runtimeBytes);
      await removeDestination(suite, s.machine, runtime.path);
      const absentDoctor = await suite.invoke(process.execPath, [suite.packed.cli, 'doctor', '--config', s.configPath], suite.cores!.local.env);
      await suite.evidence('doctor-absent-runtime.json', absentDoctor);
      assert.notEqual(absentDoctor.exitCode, 0); assert.match(absentDoctor.stdout + absentDoctor.stderr, /runtime|ENOENT|not_found/i); assert.match(absentDoctor.stdout + absentDoctor.stderr, /setup|repair/i);
      await writeDestination(suite, s.machine, runtime.path, runtimeBytes);
      const dropped = await armFault(s, { id: 'lost-reply', mode: 'drop-reply', match: ['run', '--json'], contains: 'spider.kind=exec' });
      const effect = join(s.destinationCwd, 'accepted-once');
      const at = await begin(s, 'lost-reply', [{ id: 'lost-reply', args: { action: 'exec', language: 'shell', on: s.machine, code: `printf 'accepted-once\\n' >> ${shellQuote(effect)}; printf 'recovered-out\\n'; exit 23` } }]);
      const event = await s.driver.toolResult('lost-reply', deadline(60000)); await suite.evidence('lost-launch-result.json', event);
      await settled(s.driver, at);
      const observed = await waitFor('one accepted payload effect', () => readDestination(suite, s.machine, effect), text => text !== null, deadline(30000));
      assert.equal(observed, 'accepted-once\n');
      const records = await dropped.records(); assert.equal(records.filter(r => r.phase === 'accepted').length, 1); assert.equal(records.filter(r => r.phase === 'forwarded').length, 1);
      await suite.evidence('lost-launch-transport.json', records);
      const details = (event.result as { details?: any }).details;
      if (typeof details?.stdout === 'string') {
        if (details.outcome === 'unknown') assert.equal(details.exitCode, null);
        else exactResult(details, 'recovered-out\n', '', 23);
      } else assert.match(JSON.stringify(event.result), /launch-uncertain|unknown/i);
      expect(() => assert.equal(observed, 'accepted-once\naccepted-once\n')).toThrow();
      const held = await stagePayload(suite, { id: 'missing-chunk', beforeStdout: 'first-chunk\n', stdout: 'final-chunk\n', exitCode: 17 });
      const collection = await armFault(s, { id: 'collection-gate', mode: 'hold', match: ['file', 'read'], deferred: true });
      const chunkAt = await begin(s, 'missing-chunk', [{ id: 'missing-chunk', args: { action: 'exec', on: s.machine, language: 'shell', code: held.code } }]);
      await held.ready(deadline(30000)); const transport = await payloadTransport(s, held.configPath);
      await collection.enable(join(transport.remoteDirectory, 'index.json')); await collection.ready();
      await held.release();
      await waitFor('published real receipt before chunk removal', () => readDestination(suite, s.machine, join(transport.remoteDirectory, 'receipt.json')), v => v !== null, deadline(30000));
      const index = JSON.parse((await readDestination(suite, s.machine, join(transport.remoteDirectory, 'index.json')))!);
      const finalChunk = [...index.chunks].reverse().find((chunk: { stream: string; offset: number }) => chunk.stream === 'stdout' && chunk.offset > 0);
      assert.ok(finalChunk, 'the held stream must publish a separate final chunk'); assert.match(finalChunk.file, /^chunk-[0-9]{8}\.json$/);
      const chunkPath = destinationPath(suite, join(transport.remoteDirectory, finalChunk.file));
      assert.ok(await readDestination(suite, s.machine, chunkPath));
      // Only this settled fixture's published chunk is removed. The real index and receipt retain its reference.
      await removeDestination(suite, s.machine, chunkPath); await collection.release();
      const incomplete = await result(s, 'missing-chunk'); await settled(s.driver, chunkAt);
      assert.equal(incomplete.exitCode, null); assert.equal(incomplete.outcome, 'unknown');
      assert.equal(await held.effect(), 'missing-chunk\n');
      assert.ok(!incomplete.stdout.includes('final-chunk') || incomplete.stdout !== 'first-chunk\nfinal-chunk\n', 'missing published bytes must not be claimed complete');
      const wrongVersion = await armFault(s, { id: 'wrong-version', mode: 'wrong-version', match: ['server', 'status'], scope: 'doctor-version' });
      const wrongDoctor = await suite.invoke(process.execPath, [suite.packed.cli, 'doctor', '--config', s.configPath], { ...suite.cores!.local.env, SPIDER_E2E_FAULT_SCOPE: 'doctor-version' });
      await suite.evidence('doctor-wrong-core-version.json', wrongDoctor);
      assert.notEqual(wrongDoctor.exitCode, 0); assert.match(wrongDoctor.stdout + wrongDoctor.stderr, /unsupported-version|hc 0\.1\.16/i); assert.match(wrongDoctor.stdout + wrongDoctor.stderr, /doctor.*--config|repair|setup/i);
      s.config.core.binary = suite.cores!.wrapper; await configChanged(s);
      const oldNode = destinationPath(suite, join(destinationRoot(suite), 'old-node'));
      if (suite.options.tier === 'remote') {
        await writeDestination(suite, s.machine, oldNode, '#!/bin/sh\nprintf "v20.0.0\\n"\n');
        assert.equal((await (suite as RemoteSuite).remote.exec(`chmod 700 ${shellQuote(oldNode)}`)).exitCode, 0);
      } else await writeFile(oldNode, '#!/bin/sh\nprintf "v20.0.0\\n"\n', { mode: 0o700 });
      s.config.machines.find((m: { name: string }) => m.name === s.machine).nodePath = oldNode;
      await configChanged(s);
      const before = (await suite.cores!.records()).length;
      const oldDoctor = await suite.invoke(process.execPath, [suite.packed.cli, 'doctor', '--config', s.configPath], suite.cores!.local.env);
      await suite.evidence('doctor-old-node.json', oldDoctor); assert.notEqual(oldDoctor.exitCode, 0); assert.match(oldDoctor.stdout + oldDoctor.stderr, /remote-node-unavailable|Node.*22\.19/i); assert.match(oldDoctor.stdout + oldDoctor.stderr, /nodePath|install Node/i);
      const calls = (await suite.cores!.records()).slice(before); assert.ok(!calls.some(r => r.argv[0] === 'server' && ['start', 'restart'].includes(r.argv[1])), 'doctor never starts a core');
      await snapshot(s, 'transport-faults');
    },
  },
];
