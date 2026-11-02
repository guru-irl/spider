// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile, writeFile } from 'node:fs/promises';
import type { ScriptTurn } from '../scripted-provider.js';
import type { Suite } from '../../harness/suite.js';
import { launchActiveRouting, runTool, scripted } from './active.js';

const nested = (host: string | readonly string[], marker: string) => ({ action: 'exec', language: 'javascript', code:
  `const r=require('node:child_process').spawnSync('ssh',${JSON.stringify([...(typeof host === 'string' ? [host] : host), marker])},{encoding:'utf8'}); console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr}));` });

export async function activeCache(suite: Suite): Promise<void> {
  const tests = [
    { name: 'expired-managed', state: 'expired', destination: 'dest.invalid' },
    { name: 'expired-unmanaged', state: 'expired', destination: 'outside.invalid' },
    { name: 'malformed-managed', state: 'malformed', destination: 'dest.invalid' },
    { name: 'malformed-unmanaged', state: 'malformed', destination: 'outside.invalid' },
    { name: 'expired-ambiguous', state: 'expired', destination: ['-o', 'ProxyCommand=ssh -W %h:%p outside.invalid', 'other.invalid'] },
    { name: 'malformed-ambiguous', state: 'malformed', destination: ['-o', 'ProxyCommand=ssh -W %h:%p outside.invalid', 'other.invalid'] },
  ] as const;
  const scripts: Record<string, ScriptTurn[]> = {};
  for (const test of tests) {
    scripts[`cache-allow-${test.name}`] = scripted(`cache-allow-${test.name}`, 'spider', nested('outside.invalid', `allow-${test.name}`));
    scripts[`cache-deny-${test.name}`] = scripted(`cache-deny-${test.name}`, 'spider', nested(test.destination, `deny-${test.name}`));
  }
  const active = await launchActiveRouting(suite, scripts, { SPIDER_HERDR_SSH_BYPASS: '1' });
  const original = await readFile(active.cache.path);
  const fresh = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
  const failures: string[] = [], observations: object[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
  const parse = (result: unknown) => {
    try { return JSON.parse((result as { details?: { stdout?: string } }).details?.stdout ?? '{}') as { status?: number; stdout?: string; stderr?: string }; } catch { return {}; }
  };
  try {
    for (const test of tests) {
      await writeFile(active.cache.path, original, { mode: 0o600 });
      const before = (await active.records()).length;
      const allowed = await runTool(active.driver, `cache-allow-${test.name}`, `cache-allow-${test.name}`);
      const allowedRecords = (await active.records()).slice(before), allowResult = parse(allowed.result);
      const corrupted = test.state === 'expired' ? JSON.stringify({ ...fresh, fetchedAt: Date.now() - 180_000 }) : '{ invalid cache';
      await writeFile(active.cache.path, corrupted, { mode: 0o600 });
      const afterAllowed = (await active.records()).length;
      const denied = await runTool(active.driver, `cache-deny-${test.name}`, `cache-deny-${test.name}`);
      const afterDenied = (await active.records()).length;
      const actualCache = await readFile(active.cache.path, 'utf8');
      const denyResult = parse(denied.result);
      observations.push({ ...test, allowed, allowedRecords, allowResult, denied, denyResult, cacheStillCorrupt: actualCache === corrupted });
      await suite.evidence('active-cache-cases.json', observations);
      check(allowResult.status === 41 && JSON.stringify(allowedRecords) === JSON.stringify([{ argv: ['outside.invalid', `allow-${test.name}`] }]), `${test.name} positive control failed`);
      check(allowResult.stderr === 'TRANSPORT-ERR\n' && allowResult.stdout === `TRANSPORT-OUT\n${JSON.stringify(['outside.invalid', `allow-${test.name}`])}\n`, `${test.name} positive streams changed`);
      check(actualCache === corrupted, `${test.name} cache was refreshed during the observation`);
      const unmanaged = test.name === 'expired-unmanaged';
      check(denyResult.status === (unmanaged ? 41 : 126), `${test.name} violates I4-R exit policy`);
      check(afterDenied === afterAllowed + (unmanaged ? 1 : 0), `${test.name} violates I4-R transport policy`);
      if (unmanaged) check(JSON.stringify((await active.records()).at(-1)?.argv) === JSON.stringify(['outside.invalid', `deny-${test.name}`]), 'I4-R unmanaged argv changed');
      else check(typeof denyResult.stderr === 'string' && denyResult.stderr.includes('on:'), `${test.name} did not report cache refusal`);
    }
    await suite.keepEvidence(active.log, 'active-cache-transport.jsonl');
  } finally {
    await writeFile(active.cache.path, original, { mode: 0o600 });
    await active.driver.close();
  }
  if (failures.length) throw new Error(`active cache failures: ${failures.join('; ')}`);
}
