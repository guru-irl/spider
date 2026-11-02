// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { artifactTransport } from '../fixtures/transports/artifact.js';
import { tokenExpiry } from '../fixtures/transports/token-expiry.js';
import { activeIsolation } from '../fixtures/transports/active-isolation.js';
import { activeFailedChild } from '../fixtures/transports/active-child.js';
import { activeCache } from '../fixtures/transports/active-cache.js';
import { activeDeadCore } from '../fixtures/transports/active-dead-core.js';
import { installFresh } from '../fixtures/install-inputs.js';
import { marker } from '../fixtures/scripted-provider.js';
import { writeScript, type RpcDriver } from '../harness/pi.js';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { deadline } from '../harness/wait.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S47'),
  title: 'Cache outages and forged bypasses do not authorize managed SSH',
  tiers: ['ci', 'headless'],
  async run(suite) {
    if (suite.options.tier !== 'ci') {
      const installed = await installFresh(suite);
      const failures: string[] = [], results: object[] = [];
      for (const [name, run] of [['isolation', activeIsolation], ['failed-child', activeFailedChild], ['cache', activeCache], ['dead-core', activeDeadCore], ['token-expiry', tokenExpiry]] as const) {
        try { await run(installed.suite); results.push({ name, result: 'passed' }); }
        catch (error) { const message = String((error as Error).message ?? error); failures.push(`${name}: ${message}`); results.push({ name, result: 'failed', message }); }
        await suite.evidence('active-phases.json', results);
      }
      if (failures.length) throw new Error(`active routing failures: ${failures.join('; ')}`);
      return;
    }
    const transport = await artifactTransport(suite);
    try {
    const observations: object[] = [];
    const unmatched = async () => {
      await transport.valid();
      const args = ['outside.invalid', 'unmanaged arg'];
      const before = (await transport.records()).length;
      const result = await transport.run(args);
      expect(result).toEqual({ exitCode: 41, stdout: `TRANSPORT-OUT\n${JSON.stringify(args)}\n`, stderr: 'TRANSPORT-ERR\n' });
      expect(await transport.records()).toHaveLength(before + 1);
      expect((await transport.records()).at(-1)?.argv).toEqual(args);
    };
    for (const [name, bypass] of [['boolean bypass', '1'], ['arbitrary token', 'a'.repeat(64)], ['path token', '../audit.jsonl']] as const) {
      await unmatched();
      const before = (await transport.records()).length;
      const result = await transport.run(['managed.invalid'], { SPIDER_HERDR_SSH_BYPASS: bypass });
      observations.push({ name, result });
      await suite.evidence('ssh-cache.json', observations);
      expect(result.exitCode, name).toBe(126);
      expect(await transport.records(), name).toHaveLength(before);
    }
    for (const [name, corrupt] of [['expired cache', transport.expired], ['unavailable cache', transport.malformed]] as const) {
      await unmatched();
      await corrupt();
      for (const args of [['managed.invalid'], ['outside.invalid'], ['-o', 'ProxyCommand=ssh -W %h:%p outside.invalid', 'other.invalid']]) {
        const before = (await transport.records()).length, result = await transport.run(args);
        const unmanaged = name === 'expired cache' && args.length === 1 && args[0] === 'outside.invalid';
        observations.push({ name, args, result, ruling: 'I4-R', confidentlyUnmanaged: unmanaged });
        await suite.evidence('ssh-cache.json', observations);
        expect(result.exitCode, `${name}: ${JSON.stringify(args)}`).toBe(unmanaged ? 41 : 126);
        expect(await transport.records(), name).toHaveLength(before + (unmanaged ? 1 : 0));
        if (unmanaged) expect((await transport.records()).at(-1)?.argv).toEqual(args);
      }
    }
    await transport.close();
    for (const bypass of ['1', 'a'.repeat(64), '../audit.jsonl']) {
      await transport.valid();
      const before = (await transport.records()).length;
      const dead = await transport.run(['managed.invalid'], { SPIDER_HERDR_SSH_BYPASS: bypass });
      expect(dead.exitCode).toBe(41); expect(await transport.records()).toHaveLength(before + 1);
      expect((await transport.records()).at(-1)?.argv).toEqual(['managed.invalid']);
      observations.push({ phase: 'dead-core', bypass, dead });
    }
    for (const corrupt of [transport.expired, transport.malformed]) {
      await corrupt();
      for (const args of [['managed.invalid'], ['outside.invalid'], ['-o', 'ProxyCommand=ssh -W %h:%p outside.invalid', 'other.invalid']]) {
        const before = (await transport.records()).length, dead = await transport.run(args);
        expect(dead.exitCode).toBe(41); expect(await transport.records()).toHaveLength(before + 1);
        expect((await transport.records()).at(-1)?.argv).toEqual(args);
        observations.push({ phase: 'dead-core', args, dead });
      }
    }
    await suite.evidence('ssh-cache.json', observations);
    await suite.keepEvidence(transport.log, 'transport.jsonl');

    // A real no-hc pi session with Herdr disabled must still run local commands.
    // The absolute test-owned executable makes system SSH unreachable even if PATH changes.
    const sentinel = join(suite.pi.bin, 'ssh');
    await copyFile(transport.sentinel, sentinel); await chmod(sentinel, 0o700);
    const project = await suite.project('inactive');
    const effect = join(suite.root, 'must-not-exist');
    const globalConfig = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
    const config = JSON.parse(await readFile(globalConfig, 'utf8'));
    await writeFile(globalConfig, JSON.stringify({ ...config, 'herdr.enabled': false }));
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
      passthrough: [
        { steps: [{ tool: { id: 'inactive-local', name: 'spider', arguments: { action: 'exec', language: 'shell', code: `${quote(sentinel)} managed.invalid 'literal arg'` } } }] },
        { steps: [{ text: 'local finished' }] },
      ],
      noFallback: [
        { steps: [{ tool: { id: 'inactive-on', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'managed.invalid', code: `printf unwanted > ${quote(effect)}` } } }] },
        { steps: [{ text: 'remote refused' }] },
      ],
    } });
    const driver = await suite.launchPi({ mode: 'rpc', cwd: project, label: 'inactive-pi', extraEnv: { FIXTURE_TRANSPORT_LOG: transport.log } }) as RpcDriver;
    try {
      const start = await driver.waitEvent('session_start', () => true, deadline(60_000));
      expect(start).toMatchObject({ mode: 'rpc', hcTerminal: null });
      const before = (await transport.records()).length;
      await driver.prompt(`${marker('passthrough')} run local command`, deadline(90_000));
      const result = await driver.toolResult('inactive-local', deadline(5_000));
      await suite.evidence('inactive-local.json', result);
      expect(JSON.stringify(result.result)).toContain('TRANSPORT-OUT');
      expect((await transport.records()).at(-1)?.argv).toEqual(['managed.invalid', 'literal arg']);
      expect(await transport.records()).toHaveLength(before + 1);
      const userBash = await driver.rpc({ type: 'bash', command: `${quote(sentinel)} outside.invalid 'user arg'` }, deadline(60_000));
      await suite.evidence('inactive-user-bash.json', userBash);
      expect(userBash.data).toMatchObject({ exitCode: 41 });
      expect(JSON.stringify(userBash.data)).toContain('TRANSPORT-OUT');
      const beforeRefusal = (await transport.records()).length;
      await driver.prompt(`${marker('noFallback')} try an unavailable remote`, deadline(90_000));
      const refusal = await driver.toolResult('inactive-on', deadline(5_000));
      await suite.evidence('inactive-on.json', refusal);
      expect(refusal.isError).toBe(true);
      expect(JSON.stringify(refusal.result)).toMatch(/Herdr is off in this session|Herdr stopped responding/);
      expect(existsSync(effect)).toBe(false);
      expect(await transport.records()).toHaveLength(beforeRefusal);
      await suite.keepEvidence(join(suite.pi.observerDir, `${driver.pid}.jsonl`), 'inactive-pi-events.jsonl');
    } finally { await driver.close(); }
    await tokenExpiry(suite);
    } finally { await transport.close(); }
  },
}];
