// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { artifactTransport } from '../fixtures/transports/artifact.js';
import { activeS45 } from '../fixtures/transports/active-ssh.js';
import { installFresh } from '../fixtures/install-inputs.js';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S45'),
  title: 'Managed SSH is refused before transport',
  tiers: ['ci', 'headless', 'remote'],
  async run(suite) {
    if (suite.options.tier !== 'ci') {
      const installed = await installFresh(suite);
      await activeS45(installed.suite);
      return;
    }
    const transport = await artifactTransport(suite);
    try {
    const cases: { name: string; args: string[] }[] = [
      { name: 'machine name', args: ['managed.invalid'] },
      { name: 'mixed case and user', args: ['person@MaNaGeD.InVaLiD', 'remote-command'] },
      { name: 'configured alias', args: ['alias.invalid'] },
      { name: 'SSH URI', args: ['ssh://person@managed.invalid:2222'] },
      { name: 'port and double dash', args: ['-p', '2222', '--', 'managed.invalid'] },
      { name: 'managed jump', args: ['-J', 'person@managed.invalid', 'outside.invalid'] },
      { name: 'managed forwarding', args: ['-W', 'managed.invalid:22', 'outside.invalid'] },
      { name: 'managed ProxyJump', args: ['-o', 'ProxyJump=managed.invalid', 'outside.invalid'] },
      { name: 'managed ProxyCommand', args: ['-o', 'ProxyCommand=ssh -W other.invalid:22 managed.invalid', 'outside.invalid'] },
      { name: 'unresolved forwarding', args: ['-o', 'ProxyCommand=ssh -W %h:%p outside.invalid', 'other.invalid'] },
    ];
    const observations: object[] = [];
    for (const test of cases) {
      await transport.valid();
      const positiveArgs = ['-p', '2222', 'outside.invalid', 'literal arg'];
      const before = (await transport.records()).length;
      const positive = await transport.run(positiveArgs);
      expect(positive).toEqual({ exitCode: 41, stdout: `TRANSPORT-OUT\n${JSON.stringify(positiveArgs)}\n`, stderr: 'TRANSPORT-ERR\n' });
      expect((await transport.records()).at(-1)?.argv).toEqual(positiveArgs);
      expect(await transport.records()).toHaveLength(before + 1);
      const refused = await transport.run(test.args);
      observations.push({ ...test, positive, refused });
      await suite.evidence('ssh-parsing.json', observations);
      expect(refused.exitCode, test.name).toBe(126);
      expect(refused.stderr, test.name).toMatch(/^Spider (couldn't|blocked)/);
      expect(await transport.records(), test.name).toHaveLength(before + 1);
    }
    // I4-R: last-known hosts still prove this route unmanaged. Cache expiry is not a blanket SSH ban.
    await transport.valid();
    const valid = await transport.run(['outside.invalid']);
    expect(valid.exitCode).toBe(41);
    const count = (await transport.records()).length;
    await transport.expired();
    const expired = await transport.run(['outside.invalid']);
    observations.push({ name: 'I4-R expired cache confidently unmanaged', valid, expired });
    expect(expired.exitCode).toBe(41);
    expect(await transport.records()).toHaveLength(count + 1);
    expect((await transport.records()).at(-1)?.argv).toEqual(['outside.invalid']);
    for (const args of [['managed.invalid'], ['-o', 'ProxyCommand=ssh -W %h:%p outside.invalid', 'other.invalid']]) {
      const before = (await transport.records()).length, refused = await transport.run(args);
      expect(refused.exitCode).toBe(126); expect(refused.stderr).toMatch(/^Spider couldn't check Herdr's machine list/);
      expect(await transport.records()).toHaveLength(before);
      observations.push({ name: 'I4-R same expired snapshot refuses managed or ambiguous route', args, refused });
    }
    await suite.evidence('ssh-parsing.json', observations);
    await transport.close();
    for (const test of cases) {
      const before = (await transport.records()).length, dead = await transport.run(test.args);
      expect(dead.exitCode, `dead core: ${test.name}`).toBe(41);
      expect(await transport.records()).toHaveLength(before + 1);
      expect((await transport.records()).at(-1)?.argv).toEqual(test.args);
      observations.push({ ...test, phase: 'dead-core', dead });
    }
    await suite.evidence('ssh-parsing.json', observations);
    await suite.keepEvidence(transport.log, 'transport.jsonl');
    } finally { await transport.close(); }
  },
}];
