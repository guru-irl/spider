// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { artifactTransport } from '../fixtures/transports/artifact.js';
import { activeS46 } from '../fixtures/transports/active-transfers.js';
import { installFresh } from '../fixtures/install-inputs.js';
import { marker, type ScriptTurn } from '../fixtures/scripted-provider.js';
import { HarnessError } from '../harness/environment.js';
import { writeScript, type RpcDriver } from '../harness/pi.js';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { deadline } from '../harness/wait.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S46'),
  title: 'Transfer commands cannot silently bypass managed routing',
  tiers: ['ci', 'headless'],
  async run(suite) {
    if (suite.options.tier !== 'ci') {
      const installed = await installFresh(suite);
      await activeS46(installed.suite);
      return;
    }
    const transport = await artifactTransport(suite);
    try {
    const sshEnv = { ...transport.env, PATH: [transport.bin, dirname(process.execPath)].join(':'), FIXTURE_TRANSPORT_SKIP_INPUT: '1' };
    // scp delegates local copies to cp. Keep all other PATH lookups fenced.
    await writeFile(join(transport.bin, 'cp'), '#!/bin/sh\nexec /bin/cp "$@"\n', { mode: 0o700 });
    const scp = '/usr/bin/scp', sftp = '/usr/bin/sftp', rsync = '/usr/bin/rsync';
    const git = existsSync('/usr/bin/git') ? '/usr/bin/git' : '/usr/local/bin/git';
    for (const executable of [scp, sftp, rsync, git]) if (!existsSync(executable)) throw new HarnessError('missing-prerequisite', `CI transfer fixture needs ${executable}`);
    const invoke = (binary: string, argv: string[], env: Record<string, string>) =>
      suite.invoke('/usr/bin/perl', ['-e', 'alarm 15; exec @ARGV', '--', binary, ...argv], env);
    const source = join(transport.root, 'source.txt'), copied = join(transport.root, 'copied.txt');
    await writeFile(source, 'local fixture bytes\n');
    const local = await invoke(scp, [source, copied], sshEnv);
    await suite.evidence('local-copy.json', local);
    expect(local.exitCode).toBe(0);
    expect(await readFile(copied, 'utf8')).toBe('local fixture bytes\n');
    expect(await transport.records()).toHaveLength(0);

    const cases: { name: string; binary: string; argv: string[]; env?: Record<string, string> }[] = [
      { name: 'scp -S', binary: scp, argv: ['-S', transport.sentinel, source, 'person@outside.invalid:/fixture'] },
      { name: 'sftp -S', binary: sftp, argv: ['-S', transport.sentinel, '-b', '-', 'person@outside.invalid'] },
      { name: 'rsync -e', binary: rsync, argv: ['-e', transport.sentinel, source, 'person@outside.invalid:/fixture'] },
      { name: 'git GIT_SSH', binary: git, argv: ['ls-remote', 'ssh://person@outside.invalid/fixture'], env: { GIT_SSH: transport.sentinel, GIT_SSH_VARIANT: 'ssh' } },
      { name: 'git GIT_SSH_COMMAND', binary: git, argv: ['ls-remote', 'ssh://person@outside.invalid/fixture'], env: { GIT_SSH_COMMAND: `${transport.sentinel} -oBatchMode=yes`, GIT_SSH_VARIANT: 'ssh' } },
    ];
    const observations: object[] = [];
    for (const test of cases) {
      const before = (await transport.records()).length;
      const result = await invoke(test.binary, test.argv, { ...sshEnv, ...test.env });
      const records = (await transport.records()).slice(before);
      observations.push({ name: test.name, result, records });
      await suite.evidence('transfer-controls.json', observations);
      // The sentinel intentionally is not an SSH server. The real binary must invoke it and report failure.
      expect(result.exitCode, test.name).not.toBe(0);
      expect(records.length, test.name).toBeGreaterThan(0);
      expect(records.some(record => record.argv.some(arg => arg.includes('outside.invalid'))), test.name).toBe(true);
    }
    const noSource = join(transport.root, 'missing.txt'), noCopy = join(transport.root, 'not-created.txt');
    const negative = await invoke(scp, [noSource, noCopy], sshEnv);
    await suite.evidence('missing-source-control.json', negative);
    expect(negative.exitCode).not.toBe(0);
    expect(existsSync(noCopy)).toBe(false);
    // Pair the failed local operation with one more working owned transport control.
    const before = (await transport.records()).length;
    await invoke(scp, ['-S', transport.sentinel, source, 'person@outside.invalid:/fixture'], sshEnv);
    expect((await transport.records()).length).toBeGreaterThan(before);

    const project = await suite.project('transfer-pi');
    const piCopy = join(transport.root, 'pi-copy.txt');
    const piConfigPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
    const piConfig = JSON.parse(await readFile(piConfigPath, 'utf8'));
    await writeFile(piConfigPath, JSON.stringify({ ...piConfig, 'herdr.enabled': false }));
    const commands = [
      { name: 'local-copy', binary: scp, argv: [source, piCopy] },
      ...cases.map((test, index) => ({ ...test, name: `transport-${index}` })),
    ];
    const scripts: Record<string, ScriptTurn[]> = {};
    for (const test of commands) {
      const variables = { PATH: sshEnv.PATH, ...('env' in test ? test.env : {}) };
      const prefix = Object.entries(variables).map(([key, value]) => `${key}=${quote(value)}`).join(' ');
      const command = `${prefix} /usr/bin/perl -e ${quote('alarm 15; exec @ARGV')} -- ${[test.binary, ...test.argv].map(quote).join(' ')}`;
      scripts[test.name] = [
        { steps: [{ tool: { id: `pi-${test.name}`, name: 'spider', arguments: { action: 'exec', language: 'shell', code: command } } }] },
        { steps: [{ text: 'tool complete' }] },
      ];
    }
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts });
    const driver = await suite.launchPi({ mode: 'rpc', cwd: project, label: 'transfer-pi', extraEnv: {
      FIXTURE_TRANSPORT_LOG: transport.log, FIXTURE_TRANSPORT_SKIP_INPUT: '1',
    } }) as RpcDriver;
    try {
      await driver.waitEvent('session_start', () => true, deadline(60_000));
      const piResults: object[] = [];
      for (const test of commands) {
        const count = (await transport.records()).length;
        await driver.prompt(`${marker(test.name)} execute the fixture`, deadline(90_000));
        const result = await driver.toolResult(`pi-${test.name}`, deadline(5_000));
        const records = (await transport.records()).slice(count);
        piResults.push({ name: test.name, result, records });
        await suite.evidence('transfer-pi-results.json', piResults);
        if (test.name === 'local-copy') {
          expect(result.isError).toBe(false);
          expect(await readFile(piCopy, 'utf8')).toBe('local fixture bytes\n');
          expect(records).toHaveLength(0);
        } else {
          expect(result.isError, test.name).toBe(true);
          expect(records.some(record => record.argv.some(arg => arg.includes('outside.invalid'))), test.name).toBe(true);
        }
      }
      await suite.keepEvidence(join(suite.pi.observerDir, `${driver.pid}.jsonl`), 'transfer-pi-events.jsonl');
    } finally { await driver.close(); }
    await suite.keepEvidence(transport.log, 'transfer-transport.jsonl');
    } finally { await transport.close(); }
  },
}];
