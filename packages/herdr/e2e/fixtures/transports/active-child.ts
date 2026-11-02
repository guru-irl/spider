// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import type { ScriptTurn } from '../scripted-provider.js';
import { assertSocketPath, HarnessError } from '../../harness/environment.js';
import { observe } from '../../harness/pi.js';
import type { Suite } from '../../harness/suite.js';
import { deadline, waitFor } from '../../harness/wait.js';
import { launchActiveRouting, quote, runTool, scripted, transportRecords } from './active.js';

type Transfer = { name: string; binary: string; allowed: string[]; denied: string[]; env?: Record<string, string> };

/** A child that cannot read the global Herdr config still inherits the parent's shim and must fail closed. */
export async function activeFailedChild(suite: Suite): Promise<void> {
  const scp = '/usr/bin/scp', sftp = '/usr/bin/sftp', rsync = '/usr/bin/rsync';
  const git = existsSync('/usr/bin/git') ? '/usr/bin/git' : '/usr/local/bin/git';
  for (const binary of [scp, sftp, rsync, git]) if (!existsSync(binary)) throw new HarnessError('missing-prerequisite', `child transport fixture needs ${binary}`);
  const failedProject = await suite.project('failed-child');
  const configPath = suite.ownPath(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/config.json'));
  const originalConfig = await readFile(configPath);
  const sentinel = join(suite.pi.bin, 'ssh'), source = suite.ownPath(join(suite.root, 'child-source.txt'));
  await writeFile(source, 'child transfer fixture\n');
  const childBin = suite.ownPath(join(suite.root, 'child-bin'));
  await mkdir(childBin, { mode: 0o700 });
  // This launcher records only the test-owned descriptor and then execs the real fixture pi launcher in the same PID.
  const wrapper = join(childBin, 'pi');
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$SPIDER_HERDR_SSH_DESCRIPTOR" > ${quote(childBin)}/$$.descriptor\nprintf '%s' "${'${SPIDER_HERDR_SSH_BYPASS-}'}" > ${quote(childBin)}/$$.bypass\nexec ${quote(suite.pi.launcher)} "$@"\n`, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  const path = [suite.pi.bin, dirname(process.execPath)].join(':');
  const cases: Transfer[] = [
    { name: 'scp', binary: scp, allowed: ['-S', sentinel, source, 'person@outside.invalid:/fixture'], denied: ['-S', sentinel, source, 'person@dest.invalid:/fixture'] },
    { name: 'sftp', binary: sftp, allowed: ['-S', sentinel, '-b', '-', 'person@outside.invalid'], denied: ['-S', sentinel, '-b', '-', 'person@dest.invalid'] },
    { name: 'rsync', binary: rsync, allowed: ['-e', sentinel, source, 'person@outside.invalid:/fixture'], denied: ['-e', sentinel, source, 'person@dest.invalid:/fixture'] },
    { name: 'git-ssh', binary: git, allowed: ['ls-remote', 'ssh://person@outside.invalid/fixture'], denied: ['ls-remote', 'ssh://person@dest.invalid/fixture'], env: { GIT_SSH: sentinel, GIT_SSH_VARIANT: 'ssh' } },
    { name: 'git-command', binary: git, allowed: ['ls-remote', 'person@outside.invalid:fixture'], denied: ['ls-remote', 'person@dest.invalid:fixture'], env: { GIT_SSH_COMMAND: `${sentinel} -oBatchMode=yes`, GIT_SSH_VARIANT: 'ssh' } },
    { name: 'absolute-ssh', binary: sentinel, allowed: ['outside.invalid', 'transfer'], denied: ['dest.invalid', 'transfer'] },
  ];
  const command = (test: Transfer, args: string[]) => `${Object.entries({ PATH: path, ...test.env }).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} ${[test.binary, ...args].map(quote).join(' ')}`;
  const childTurns: ScriptTurn[] = [{ steps: [{ gate: 'child-env' }, { tool: { id: 'child-env', name: 'spider', arguments: { action: 'exec', language: 'javascript', code: "console.log(process.env.SPIDER_HERDR_SSH_BYPASS ?? 'unset')" } } }] }];
  for (const test of cases) {
    childTurns.push({ steps: [{ gate: `child-control-${test.name}` }, { tool: { id: `child-control-${test.name}`, name: 'spider', arguments: { action: 'exec', language: 'shell', code: `ssh outside.invalid ${quote(test.name)}` } } }] });
    childTurns.push({ steps: [{ gate: `child-allow-${test.name}` }, { tool: { id: `child-allow-${test.name}`, name: 'spider', arguments: { action: 'exec', language: 'shell', timeout: 15_000, code: command(test, test.allowed) } } }] });
    childTurns.push({ steps: [{ gate: `child-deny-${test.name}` }, { tool: { id: `child-deny-${test.name}`, name: 'spider', arguments: { action: 'exec', language: 'shell', timeout: 15_000, code: `${command(test, test.denied)}; printf bad > ${quote(join(suite.root, `child-effect-${test.name}`))}` } } }] });
  }
  childTurns.push({ steps: [{ text: 'child fixture complete' }] });
  const scripts: Record<string, ScriptTurn[]> = {
    'start-failed-child': scripted('start-failed-child', 'spider', { action: 'run', agent: 'worker', name: 'failed-child', cwd: failedProject, model: 'e2e-fixture/scripted', thinking: 'off', task: '[[e2e:failed-child]] Execute the controlled child fixture.' }),
    'failed-child': childTurns,
  };
  assertSocketPath(suite.root, suite.pi.gateSocket);
  const gates = await suite.gates();
  const active = await launchActiveRouting(suite, scripts, { PATH: `${childBin}:${suite.env.PATH}`, SPIDER_HERDR_SSH_BYPASS: '1' });
  const failures: string[] = [], observations: object[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
  const evidence = async (item: object) => { observations.push(item); await suite.evidence('failed-child-cases.json', observations); };
  try {
    // The active parent retains its parsed config. The child reads this owned, temporarily malformed file at startup.
    await writeFile(configPath, '{ invalid json');
    const { parentResult, ready } = await (async () => {
      try {
        const parentResult = await runTool(active.driver, 'start-failed-child', 'start-failed-child');
        expect(parentResult.isError).toBe(false);
        const ready = await gates.ready('child-env', deadline(90_000));
        return { parentResult, ready };
      } finally { await writeFile(configPath, originalConfig); }
    })();
    const child = observe(suite.pi.observerDir, () => ready.pid);
    const start = await child.waitEvent('session_start', () => true, deadline(60_000));
    expect(start).toMatchObject({ subagentChild: '1', cwd: failedProject });
    const presenceRoot = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/processes');
    const presence = await waitFor('inactive child presence', async () => {
      for (const name of await readdir(presenceRoot).catch(() => [])) {
        try { const record = JSON.parse(await readFile(join(presenceRoot, name), 'utf8')); if (record.pid === ready.pid) return record; } catch { /* wait for publication */ }
      }
      return null;
    }, value => value?.kind === 'child' && value?.hcAddress === null, deadline(60_000));
    const descriptorPath = join(childBin, `${ready.pid}.descriptor`), bypassPath = join(childBin, `${ready.pid}.bypass`);
    const inherited = await readFile(descriptorPath, 'utf8');
    const inheritedBypass = await readFile(bypassPath, 'utf8');
    await evidence({ name: 'child startup', parentResult, ready, start, presence, inheritedDescriptor: Boolean(inherited), inheritedBypass });
    check(Boolean(inherited), 'child did not inherit the parent routing descriptor');
    check(inheritedBypass === '', 'child inherited an ordinary bypass token');
    gates.release('child-env');
    const childEnv = await child.toolResult('child-env', deadline(60_000));
    const envDetail = (childEnv.result as { details?: { stdout?: string; exitCode?: number } }).details;
    await evidence({ name: 'child payload environment', result: childEnv });
    check(childEnv.isError === false && envDetail?.stdout === 'unset\n' && envDetail?.exitCode === 0, 'child payload inherited a bypass or could not read its absence');
    for (const test of cases) {
      await gates.ready(`child-control-${test.name}`, deadline(60_000));
      const controlBefore = (await active.records()).length;
      gates.release(`child-control-${test.name}`);
      const control = await child.toolResult(`child-control-${test.name}`, deadline(60_000));
      const controlRecords = (await active.records()).slice(controlBefore);
      const controlDetail = (control.result as { details?: { stdout?: string; stderr?: string; exitCode?: number } }).details;
      check(JSON.stringify(controlRecords) === JSON.stringify([{ argv: ['outside.invalid', test.name] }]), `${test.name} SSH control argv changed`);
      check(controlDetail?.stdout === `TRANSPORT-OUT\n${JSON.stringify(['outside.invalid', test.name])}\n` && controlDetail?.stderr === 'TRANSPORT-ERR\n' && controlDetail?.exitCode === 41, `${test.name} SSH control streams or exit changed`);
      const baselineLog = join(suite.root, `child-baseline-${test.name}.jsonl`);
      const baselineEnv = { ...suite.env, PATH: path, FIXTURE_TRANSPORT_LOG: baselineLog, FIXTURE_TRANSPORT_SKIP_INPUT: '1', ...test.env };
      const baseline = await suite.invoke('/usr/bin/perl', ['-e', 'alarm 15; exec @ARGV', '--', test.binary, ...test.allowed], baselineEnv);
      const baselineRecords = await transportRecords(baselineLog);
      await gates.ready(`child-allow-${test.name}`, deadline(60_000));
      const before = (await active.records()).length;
      gates.release(`child-allow-${test.name}`);
      const allowed = await child.toolResult(`child-allow-${test.name}`, deadline(60_000));
      const allowedRecords = (await active.records()).slice(before);
      const allowedDetail = (allowed.result as { details?: { stdout?: string; stderr?: string; exitCode?: number } }).details;
      const normalize = (text: string) => test.name === 'rsync' ? text.replace(/rsync\(\d+\):/g, 'rsync(<pid>):').split('\n').sort().join('\n') : text;
      check(baselineRecords.length > 0 && JSON.stringify(allowedRecords) === JSON.stringify(baselineRecords), `${test.name} unmanaged transport argv changed`);
      check(allowedDetail?.stdout === baseline.stdout && normalize(allowedDetail?.stderr ?? '') === normalize(baseline.stderr) && allowedDetail?.exitCode === baseline.exitCode, `${test.name} unmanaged streams or exit changed`);
      await gates.ready(`child-deny-${test.name}`, deadline(60_000));
      const afterAllowed = (await active.records()).length;
      gates.release(`child-deny-${test.name}`);
      const denied = await child.toolResult(`child-deny-${test.name}`, deadline(60_000));
      const afterDenied = (await active.records()).length;
      await evidence({ name: test.name, control, controlRecords, baseline, baselineRecords, allowed, allowedRecords, denied, newManagedTransports: afterDenied - afterAllowed });
      check(denied.isError === true && JSON.stringify(denied.result).includes('on:'), `${test.name} was not refused with a route`);
      check(afterDenied === afterAllowed, `${test.name} reached managed transport`);
      check(!existsSync(join(suite.root, `child-effect-${test.name}`)), `${test.name} executed the later effect`);
    }
    await child.waitEvent('agent_settled', () => true, deadline(90_000));
    await suite.keepEvidence(join(suite.pi.observerDir, `${ready.pid}.jsonl`), 'failed-child-events.jsonl');
    await suite.keepEvidence(active.log, 'failed-child-transport.jsonl');
  } finally { await active.driver.close(); }
  if (failures.length) throw new Error(`failed-activation child failures: ${failures.join('; ')}`);
}
