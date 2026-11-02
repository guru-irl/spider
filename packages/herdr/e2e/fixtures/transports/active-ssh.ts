// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ScriptTurn } from '../scripted-provider.js';
import type { Suite } from '../../harness/suite.js';
import { deadline, waitFor } from '../../harness/wait.js';
import { launchActiveRouting, quote, runTool, scripted } from './active.js';

type Case = { name: string; tool: string; allowed: JsonObject; denied: JsonObject; effect?: string; nested?: boolean };
const exec = (code: string): JsonObject => ({ action: 'exec', language: 'shell', code });
const bash = (command: string): JsonObject => ({ command });
const nested = (host: string): JsonObject => ({ action: 'exec', language: 'javascript', code:
  `const r=require('node:child_process').spawnSync('ssh',[${JSON.stringify(host)},'nested arg'],{encoding:'utf8'}); console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr}));` });

/** Exercises real pi tool calls only after the caller has run fresh packed setup. */
export async function activeS45(suite: Suite): Promise<void> {
  const sentinel = join(suite.pi.bin, 'ssh');
  const effect = (name: string) => suite.ownPath(join(suite.root, `ssh-effect-${name}`));
  const managedFile = suite.ownPath(join(suite.root, 'managed-commands.sh'));
  const unmanagedFile = suite.ownPath(join(suite.root, 'unmanaged-commands.sh'));
  await writeFile(managedFile, `ssh dest.invalid 'file arg'; printf bad > ${quote(effect('file'))}\n`);
  await writeFile(unmanagedFile, `ssh outside.invalid 'file arg'\n`);
  const batchEffect = effect('batch');
  const cases: Case[] = [
    { name: 'shell', tool: 'spider', allowed: exec("ssh outside.invalid 'shell arg'"), denied: exec(`ssh dest.invalid; printf bad > ${quote(effect('shell'))}`), effect: effect('shell') },
    { name: 'mixed-case', tool: 'spider', allowed: exec("ssh Person@outside.invalid 'case arg'"), denied: exec('ssh Person@DeSt.InVaLiD'), },
    { name: 'alias', tool: 'spider', allowed: exec('ssh outside.invalid'), denied: exec('ssh RoUtE.InVaLiD') },
    { name: 'uri', tool: 'spider', allowed: exec('ssh ssh://person@outside.invalid:2222'), denied: exec('ssh ssh://person@dest.invalid:2222') },
    { name: 'options', tool: 'spider', allowed: exec('ssh -p 2222 -- outside.invalid'), denied: exec('ssh -p 2222 -- dest.invalid') },
    { name: 'jump', tool: 'spider', allowed: exec('ssh -J outside.invalid other.invalid'), denied: exec('ssh -J dest.invalid other.invalid') },
    { name: 'forward', tool: 'spider', allowed: exec('ssh -W outside.invalid:22 other.invalid'), denied: exec('ssh -W dest.invalid:22 other.invalid') },
    { name: 'proxy', tool: 'spider', allowed: exec("ssh -o 'ProxyCommand=ssh -W other.invalid:22 outside.invalid' other.invalid"), denied: exec("ssh -o 'ProxyCommand=ssh -W other.invalid:22 dest.invalid' other.invalid") },
    { name: 'dynamic-proxy', tool: 'spider', allowed: exec("ssh -o 'ProxyCommand=ssh -W other.invalid:22 outside.invalid' other.invalid"), denied: exec("ssh -o 'ProxyCommand=ssh -W %h:%p outside.invalid' other.invalid") },
    { name: 'absolute', tool: 'spider', allowed: exec(`${quote(sentinel)} outside.invalid`), denied: exec(`${quote(sentinel)} dest.invalid`) },
    { name: 'exec-file', tool: 'spider', allowed: { action: 'exec_file', path: unmanagedFile, language: 'shell', code: 'eval "$FILE_CONTENT"' }, denied: { action: 'exec_file', path: managedFile, language: 'shell', code: 'eval "$FILE_CONTENT"' }, effect: effect('file') },
    { name: 'batch', tool: 'spider', allowed: { action: 'batch', commands: [{ language: 'shell', code: 'printf allowed' }, { language: 'shell', code: 'ssh outside.invalid' }] },
      denied: { action: 'batch', commands: [{ language: 'shell', code: `printf bad > ${quote(batchEffect)}` }, { language: 'shell', code: 'ssh dest.invalid' }] }, effect: batchEffect },
    { name: 'native-bash', tool: 'bash', allowed: bash('ssh outside.invalid'), denied: bash('ssh dest.invalid') },
    { name: 'nested-javascript', tool: 'spider', allowed: nested('outside.invalid'), denied: nested('dest.invalid'), nested: true },
  ];
  const expectedArgv: Record<string, string[]> = {
    shell: ['outside.invalid', 'shell arg'], 'mixed-case': ['Person@outside.invalid', 'case arg'], alias: ['outside.invalid'],
    uri: ['ssh://person@outside.invalid:2222'], options: ['-p', '2222', '--', 'outside.invalid'],
    jump: ['-J', 'outside.invalid', 'other.invalid'], forward: ['-W', 'outside.invalid:22', 'other.invalid'],
    proxy: ['-o', 'ProxyCommand=ssh -W other.invalid:22 outside.invalid', 'other.invalid'],
    'dynamic-proxy': ['-o', 'ProxyCommand=ssh -W other.invalid:22 outside.invalid', 'other.invalid'],
    absolute: ['outside.invalid'], 'exec-file': ['outside.invalid', 'file arg'], batch: ['outside.invalid'],
    'native-bash': ['outside.invalid'], 'nested-javascript': ['outside.invalid', 'nested arg'],
  };
  const scripts: Record<string, ScriptTurn[]> = {};
  for (const test of cases) {
    scripts[`allow-${test.name}`] = scripted(`allow-${test.name}`, test.tool, test.allowed);
    scripts[`deny-${test.name}`] = scripted(`deny-${test.name}`, test.tool, test.denied);
  }
  const active = await launchActiveRouting(suite, scripts);
  const failures: string[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
  try {
    const observations: object[] = [];
    for (const test of cases) {
      const count = (await active.records()).length;
      const allowed = await runTool(active.driver, `allow-${test.name}`, `allow-${test.name}`);
      const allowedRecords = (await active.records()).slice(count);
      observations.push({ name: test.name, phase: 'unmanaged', result: allowed, records: allowedRecords });
      await suite.evidence('ssh-active-cases.json', observations);
      check(JSON.stringify(allowedRecords) === JSON.stringify([{ argv: expectedArgv[test.name] }]), `${test.name} unmanaged argv changed`);
      const expectedOutput = `TRANSPORT-OUT\n${JSON.stringify(expectedArgv[test.name])}\n`;
      const result = allowed.result as { details?: unknown; structuredContent?: { output?: string; exit_code?: number } };
      if (test.tool === 'bash') {
        check(result.structuredContent?.output === `${expectedOutput}TRANSPORT-ERR\n` && result.structuredContent?.exit_code === 41, `${test.name} unmanaged streams or exit changed`);
      } else if (test.nested) {
        try {
          const detail = result.details as { stdout?: string };
          const nestedResult = JSON.parse(detail.stdout ?? '{}');
          check(nestedResult.status === 41 && nestedResult.stdout === expectedOutput && nestedResult.stderr === 'TRANSPORT-ERR\n', `${test.name} unmanaged streams or exit changed`);
        } catch { failures.push(`${test.name} returned invalid nested output`); }
      } else {
        const detail = (Array.isArray(result.details) ? result.details.at(-1) : result.details) as { stdout?: string; stderr?: string; exitCode?: number } | undefined;
        check(detail?.stdout === expectedOutput && detail?.stderr === 'TRANSPORT-ERR\n' && detail?.exitCode === 41, `${test.name} unmanaged streams or exit changed`);
      }
      const afterAllowed = (await active.records()).length;
      const denied = await runTool(active.driver, `deny-${test.name}`, `deny-${test.name}`);
      observations.push({ name: test.name, phase: 'managed', result: denied });
      await suite.evidence('ssh-active-cases.json', observations);
      if (test.nested) {
        const details = (denied.result as { details?: { stdout?: string } }).details;
        try { check(JSON.parse(details?.stdout ?? '{}').status === 126, `${test.name} did not exit 126`); }
        catch { failures.push(`${test.name} returned invalid nested output`); }
      } else check(denied.isError === true, `${test.name} was not an error`);
      check(JSON.stringify(denied.result).includes('on:'), `${test.name} did not name the route`);
      check((await active.records()).length === afterAllowed, `${test.name} reached managed transport`);
      if (test.effect) check(!existsSync(test.effect), `${test.name} ran its later effect`);
    }

    // Actual user-bash input goes only through this fixture's owned PTY broker.
    let offset = (await active.driver.rawOutput()).length;
    let before = (await active.records()).length;
    await active.driver.prompt('!ssh outside.invalid user-bash');
    await waitFor('unmanaged user-bash transport', active.records, rows => rows.length > before, deadline(60_000));
    const userPositive = await waitFor('unmanaged user-bash completion', async () => (await active.driver.rawOutput()).subarray(offset).toString('utf8'), text => text.includes('TRANSPORT-ERR') && text.includes('(exit 41)'), deadline(60_000));
    check(JSON.stringify((await active.records()).slice(before)) === JSON.stringify([{ argv: ['outside.invalid', 'user-bash'] }]), 'user-bash unmanaged argv changed');
    before = (await active.records()).length;
    offset = (await active.driver.rawOutput()).length;
    await active.driver.prompt('!ssh dest.invalid user-bash');
    const refusedText = await waitFor('managed user-bash refusal', async () => (await active.driver.rawOutput()).subarray(offset).toString('utf8'), text => text.includes('on:') && text.includes('(exit 126)'), deadline(60_000));
    check((await active.records()).length === before, 'user-bash reached managed transport');
    await suite.evidence('ssh-user-bash.txt', userPositive + '\n' + refusedText);
    await suite.keepEvidence(active.log, 'active-transport.jsonl');
  } finally { await active.driver.close(); }
  if (failures.length) throw new Error(`active SSH failures: ${failures.join('; ')}`);
}
