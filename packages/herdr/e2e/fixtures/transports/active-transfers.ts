// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import type { ScriptTurn } from '../scripted-provider.js';
import type { Suite } from '../../harness/suite.js';
import { HarnessError } from '../../harness/environment.js';
import { launchActiveRouting, quote, runTool, scripted, transportRecords } from './active.js';

type Transfer = { name: string; binary: string; allowed: string[]; denied: string[]; env?: Record<string, string> };
const envAssignments = (env: Record<string, string>) => Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ');

/** Every client uses an explicit owned transport; no system SSH binary can be reached. */
export async function activeS46(suite: Suite): Promise<void> {
  const scp = '/usr/bin/scp', sftp = '/usr/bin/sftp', rsync = '/usr/bin/rsync';
  const git = existsSync('/usr/bin/git') ? '/usr/bin/git' : '/usr/local/bin/git';
  for (const binary of [scp, sftp, rsync, git]) if (!existsSync(binary)) throw new HarnessError('missing-prerequisite', `transfer fixture needs ${binary}`);
  const sentinel = join(suite.pi.bin, 'ssh'), source = suite.ownPath(join(suite.root, 'transfer-source.txt'));
  const localCopy = suite.ownPath(join(suite.root, 'transfer-copy.txt'));
  await writeFile(source, 'transfer fixture bytes\n');
  await writeFile(join(suite.pi.bin, 'cp'), '#!/bin/sh\nexec /bin/cp "$@"\n', { mode: 0o700 });
  const allowedRemote = 'person@outside.invalid:/fixture', managedRemote = 'person@dest.invalid:/fixture';
  const cases: Transfer[] = [
    { name: 'scp', binary: scp, allowed: ['-S', sentinel, source, allowedRemote], denied: ['-S', sentinel, source, managedRemote] },
    { name: 'sftp', binary: sftp, allowed: ['-S', sentinel, '-b', '-', 'person@outside.invalid'], denied: ['-S', sentinel, '-b', '-', 'person@dest.invalid'] },
    { name: 'rsync', binary: rsync, allowed: ['-e', sentinel, source, allowedRemote], denied: ['-e', sentinel, source, managedRemote] },
    { name: 'git-ssh', binary: git, allowed: ['ls-remote', 'ssh://person@outside.invalid/fixture'], denied: ['ls-remote', 'ssh://person@dest.invalid/fixture'], env: { GIT_SSH: sentinel, GIT_SSH_VARIANT: 'ssh' } },
    { name: 'git-command', binary: git, allowed: ['ls-remote', 'person@outside.invalid:fixture'], denied: ['ls-remote', 'person@dest.invalid:fixture'], env: { GIT_SSH_COMMAND: `${sentinel} -oBatchMode=yes`, GIT_SSH_VARIANT: 'ssh' } },
  ];
  const path = [suite.pi.bin, dirname(process.execPath)].join(':');
  const command = (test: Transfer, args: string[]) => `${envAssignments({ PATH: path, ...test.env })} ${[test.binary, ...args].map(quote).join(' ')}`;
  const scripts: Record<string, ScriptTurn[]> = {};
  for (const test of cases) {
    scripts[`transfer-allow-${test.name}`] = scripted(`transfer-allow-${test.name}`, 'spider', { action: 'exec', language: 'shell', timeout: 15_000, code: command(test, test.allowed) });
    scripts[`transport-control-${test.name}`] = scripted(`transport-control-${test.name}`, 'spider', { action: 'exec', language: 'shell', code: "ssh outside.invalid 'control arg'" });
    scripts[`transfer-deny-${test.name}`] = scripted(`transfer-deny-${test.name}`, 'spider', { action: 'exec', language: 'shell', timeout: 15_000, code: `${command(test, test.denied)}; printf bad > ${quote(join(suite.root, `transfer-effect-${test.name}`))}` });
  }
  scripts['local-copy'] = scripted('local-copy', 'spider', { action: 'exec', language: 'shell', code: `${envAssignments({ PATH: path })} ${[scp, source, localCopy].map(quote).join(' ')}` });
  const gitProject = await suite.project('https-source');
  const localUrl = pathToFileURL(`${gitProject}/`).href;
  scripts.https = scripted('https', 'spider', { action: 'exec', language: 'shell', code:
    `${envAssignments({ PATH: path })} ${quote(git)} -c ${quote(`url.${localUrl}.insteadOf=https://outside.invalid/`)} ls-remote https://outside.invalid/` });
  const active = await launchActiveRouting(suite, scripts);
  try {
    const observations: object[] = [];
    const local = await runTool(active.driver, 'local-copy', 'local-copy');
    expect(local.isError).toBe(false);
    expect(await readFile(localCopy, 'utf8')).toBe('transfer fixture bytes\n');
    const https = await runTool(active.driver, 'https', 'https');
    observations.push({ name: 'https URL with local rewrite', result: https });
    await suite.evidence('transfer-active-cases.json', observations);
    expect(https.isError).toBe(false);
    expect(JSON.stringify(https.result)).toMatch(/[0-9a-f]{40}/);
    for (const test of cases) {
      const baselineLog = join(suite.root, `baseline-${test.name}.jsonl`);
      const baselineEnv = { ...suite.env, PATH: path, FIXTURE_TRANSPORT_LOG: baselineLog, FIXTURE_TRANSPORT_SKIP_INPUT: '1', ...test.env };
      const baseline = await suite.invoke('/usr/bin/perl', ['-e', 'alarm 15; exec @ARGV', '--', test.binary, ...test.allowed], baselineEnv);
      const baselineRecords = await transportRecords(baselineLog);
      expect(baselineRecords.length, `${test.name} baseline`).toBeGreaterThan(0);
      const before = (await active.records()).length;
      const allowed = await runTool(active.driver, `transfer-allow-${test.name}`, `transfer-allow-${test.name}`);
      const allowedRecords = (await active.records()).slice(before);
      observations.push({ name: test.name, phase: 'unmanaged', baseline, baselineRecords, result: allowed, records: allowedRecords });
      await suite.evidence('transfer-active-cases.json', observations);
      expect(allowedRecords, `${test.name} argv`).toEqual(baselineRecords);
      const detail = (allowed.result as { details?: { stdout?: string; stderr?: string; exitCode?: number } }).details;
      // rsync and its transport write independently to the same stderr pipe.
      const normalize = (text: string) => test.name === 'rsync' ? text.replace(/rsync\(\d+\):/g, 'rsync(<pid>):').split('\n').sort().join('\n') : text;
      expect(detail, `${test.name} stdout and exit`).toMatchObject({ stdout: baseline.stdout, exitCode: baseline.exitCode });
      expect(normalize(detail?.stderr ?? ''), `${test.name} stderr`).toBe(normalize(baseline.stderr));
      const controlBefore = (await active.records()).length;
      const control = await runTool(active.driver, `transport-control-${test.name}`, `transport-control-${test.name}`);
      expect((await active.records()).slice(controlBefore)).toEqual([{ argv: ['outside.invalid', 'control arg'] }]);
      const controlDetail = (control.result as { details?: { stdout?: string; stderr?: string; exitCode?: number } }).details;
      expect(controlDetail).toMatchObject({ stdout: 'TRANSPORT-OUT\n["outside.invalid","control arg"]\n', stderr: 'TRANSPORT-ERR\n', exitCode: 41 });
      const afterControl = (await active.records()).length;
      const denied = await runTool(active.driver, `transfer-deny-${test.name}`, `transfer-deny-${test.name}`);
      observations.push({ name: test.name, phase: 'managed', result: denied });
      await suite.evidence('transfer-active-cases.json', observations);
      expect(denied.isError, test.name).toBe(true);
      expect(JSON.stringify(denied.result), test.name).toMatch(/on:/);
      expect(await active.records(), test.name).toHaveLength(afterControl);
      expect(existsSync(join(suite.root, `transfer-effect-${test.name}`)), test.name).toBe(false);
    }
    await suite.keepEvidence(active.log, 'active-transfer-transport.jsonl');
  } finally { await active.driver.close(); }
}
