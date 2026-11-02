// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { ScriptTurn } from '../scripted-provider.js';
import type { Suite } from '../../harness/suite.js';
import { deadline, waitFor } from '../../harness/wait.js';
import { launchActiveRouting, quote, runTool, scripted } from './active.js';
import { launchPeerCore } from './peer-core.js';

const nested = (host: string, marker: string) => ({ action: 'exec', language: 'javascript', code:
  `const r=require('node:child_process').spawnSync('ssh',[${JSON.stringify(host)},${JSON.stringify(marker)}],{encoding:'utf8'}); console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr}));` });

/** Uses two real terminals and cores sharing one setup-owned global root. */
export async function activeIsolation(suite: Suite): Promise<void> {
  const scripts: Record<string, ScriptTurn[]> = {};
  for (const [name, host] of [['parent-allow', 'outside.invalid'], ['parent-managed', 'dest.invalid'], ['peer-allow', 'outside.invalid'], ['peer-managed', 'dest.invalid']] as const)
    scripts[name] = scripted(name, 'spider', nested(host, name));
  scripts['read-bypass'] = scripted('read-bypass', 'spider', { action: 'exec', language: 'shell', code: 'printf "bypass=<%s>\\n" "${SPIDER_HERDR_SSH_BYPASS-unset}"' });
  scripts['read-bypass-js'] = scripted('read-bypass-js', 'spider', { action: 'exec', language: 'javascript', code: "console.log(process.env.SPIDER_HERDR_SSH_BYPASS ?? 'unset')" });
  scripts['quoted-bypass'] = scripted('quoted-bypass', 'spider', { action: 'exec', language: 'shell', code: "printf '%s\\n' 'SPIDER_HERDR_SSH_BYPASS=1'" });
  scripts['commented-bypass'] = scripted('commented-bypass', 'spider', { action: 'exec', language: 'shell', code: 'printf safe # SPIDER_HERDR_SSH_BYPASS=1' });
  scripts['allow-before-set'] = scripted('allow-before-set', 'spider', { action: 'exec', language: 'shell', code: "ssh outside.invalid 'before set'" });
  scripts['set-bypass'] = scripted('set-bypass', 'spider', { action: 'exec', language: 'shell', code: 'SPIDER_HERDR_SSH_BYPASS=1 ssh outside.invalid' });
  scripts['allow-before-export'] = scripted('allow-before-export', 'spider', { action: 'exec', language: 'shell', code: "ssh outside.invalid 'before export'" });
  scripts['export-bypass'] = scripted('export-bypass', 'spider', { action: 'exec', language: 'shell', code: 'export SPIDER_HERDR_SSH_BYPASS=1; ssh outside.invalid' });
  scripts['allow-before-js'] = scripted('allow-before-js', 'spider', { action: 'exec', language: 'shell', code: "ssh outside.invalid 'before js'" });
  scripts['set-bypass-js'] = scripted('set-bypass-js', 'spider', { action: 'exec', language: 'javascript', code: "process.env.SPIDER_HERDR_SSH_BYPASS='1'; require('node:child_process').spawnSync('ssh',['outside.invalid'])" });
  const invalidEffect = suite.ownPath(join(suite.root, 'invalid-target-effect'));
  scripts['allow-before-invalid'] = scripted('allow-before-invalid', 'spider', { action: 'exec', language: 'shell', code: 'ssh outside.invalid before-invalid' });
  scripts['invalid-target'] = scripted('invalid-target', 'spider', { action: 'exec', language: 'shell', on: 'missing.invalid', code: `printf bad > ${quote(invalidEffect)}` });
  const active = await launchActiveRouting(suite, scripts, { SPIDER_HERDR_SSH_BYPASS: '1' });
  const failures: string[] = [], observations: object[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
  const evidence = async (item: object) => { observations.push(item); await suite.evidence('isolation-cases.json', observations); };
  const parse = (result: unknown) => {
    try { return JSON.parse((result as { details?: { stdout?: string } }).details?.stdout ?? '{}') as { status?: number; stdout?: string; stderr?: string }; }
    catch { return {}; }
  };
  let peer: Awaited<ReturnType<typeof launchPeerCore>> | undefined;
  try {
    peer = await launchPeerCore(suite, await suite.project('routing-peer'), active.env);
    const start = await peer.waitEvent('session_start', () => true, deadline(60_000));
    if (typeof start.sessionId !== 'string' || !suite.cores) throw new Error('peer did not expose its session or cores');
    const feedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/sessions', start.sessionId, 'session.json');
    const feed = await waitFor('peer active on the second core', async () => {
      try { return JSON.parse(await readFile(feedPath, 'utf8')); } catch { return null; }
    }, value => value?.owner?.terminal?.coreId === suite.cores!.dest.coreId && value?.owner?.terminal?.address === peer!.terminal, deadline(60_000));
    const cacheRoot = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/ssh');
    const peerCache = await waitFor('peer machine list for the second core', async () => {
      for (const name of await readdir(cacheRoot).catch(() => [])) {
        if (!name.endsWith('.json')) continue;
        try { const value = JSON.parse(await readFile(join(cacheRoot, name), 'utf8')); if (value.identity?.coreId === suite.cores!.dest.coreId) return value; } catch { /* wait for publication */ }
      }
      return null;
    }, value => value !== null, deadline(60_000));
    expect(peerCache.machines).toEqual([]);
    await evidence({ name: 'peer activation', start, feed, peerCache });
    const cases = [
      { name: 'parent-allow', driver: active.driver, target: 'outside.invalid', status: 41, launches: true },
      { name: 'parent-managed', driver: active.driver, target: 'dest.invalid', status: 126, launches: false },
      { name: 'peer-allow', driver: peer, target: 'outside.invalid', status: 41, launches: true },
      { name: 'peer-managed', driver: peer, target: 'dest.invalid', status: 41, launches: true },
    ];
    for (const test of cases) {
      const before = (await active.records()).length;
      const result = await runTool(test.driver, test.name, test.name);
      const records = (await active.records()).slice(before), parsed = parse(result.result);
      await evidence({ name: test.name, result, parsed, records });
      check(parsed.status === test.status, `${test.name} returned ${String(parsed.status)}, expected ${test.status}`);
      if (test.launches) {
        check(JSON.stringify(records) === JSON.stringify([{ argv: [test.target, test.name] }]), `${test.name} transport argv changed`);
        check(parsed.stdout === `TRANSPORT-OUT\n${JSON.stringify([test.target, test.name])}\n` && parsed.stderr === 'TRANSPORT-ERR\n', `${test.name} streams changed`);
      } else {
        check(records.length === 0, `${test.name} reached managed transport`);
        check(typeof parsed.stderr === 'string' && parsed.stderr.includes('on:'), `${test.name} did not name the route`);
      }
    }
    const read = await runTool(active.driver, 'read-bypass', 'read-bypass');
    await evidence({ name: 'read bypass variable', result: read });
    check(read.isError === false && JSON.stringify(read.result).includes('bypass=<unset>'), 'reading the cleared bypass variable was refused or inherited a value');
    for (const [name, expected] of [['read-bypass-js', 'unset'], ['quoted-bypass', 'SPIDER_HERDR_SSH_BYPASS=1'], ['commented-bypass', 'safe']] as const) {
      const result = await runTool(active.driver, name, name);
      await evidence({ name, result });
      check(result.isError === false && JSON.stringify(result.result).includes(expected), `${name} was incorrectly refused`);
    }
    for (const [allow, denied] of [['allow-before-set', 'set-bypass'], ['allow-before-export', 'export-bypass'], ['allow-before-js', 'set-bypass-js']] as const) {
      const before = (await active.records()).length;
      const positive = await runTool(active.driver, allow, allow);
      const positiveRecords = (await active.records()).slice(before);
      const after = (await active.records()).length;
      const refusal = await runTool(active.driver, denied, denied);
      await evidence({ name: denied, positive, positiveRecords, refusal });
      check(positiveRecords.length === 1 && positiveRecords[0].argv[0] === 'outside.invalid', `${denied} unmanaged control did not reach the sentinel`);
      check(refusal.isError === true && JSON.stringify(refusal.result).includes('SPIDER_HERDR_SSH_BYPASS'), `${denied} was not refused`);
      check((await active.records()).length === after, `${denied} reached transport`);
    }
    const beforeInvalid = (await active.records()).length;
    const invalidControl = await runTool(active.driver, 'allow-before-invalid', 'allow-before-invalid');
    const controlRecords = (await active.records()).slice(beforeInvalid);
    const afterControl = (await active.records()).length;
    const invalid = await runTool(active.driver, 'invalid-target', 'invalid-target');
    await evidence({ name: 'invalid target', invalidControl, controlRecords, invalid, effect: existsSync(invalidEffect) });
    const controlDetail = (invalidControl.result as { details?: { stdout?: string; stderr?: string; exitCode?: number } }).details;
    check(JSON.stringify(controlRecords) === JSON.stringify([{ argv: ['outside.invalid', 'before-invalid'] }]) && controlDetail?.exitCode === 41 && controlDetail?.stderr === 'TRANSPORT-ERR\n', 'invalid-target control did not pass through');
    check(invalid.isError === true && !existsSync(invalidEffect) && (await active.records()).length === afterControl, 'invalid target fell back to local execution');
    if (existsSync(active.log)) await suite.keepEvidence(active.log, 'isolation-transport.jsonl');
    else await suite.evidence('isolation-transport-missing.json', { reason: 'no transport invocation was observed' });
  } finally {
    if (peer) await peer.close();
    await active.driver.close();
  }
  if (failures.length) throw new Error(`routing isolation failures: ${failures.join('; ')}`);
}
