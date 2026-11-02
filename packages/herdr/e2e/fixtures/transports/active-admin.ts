// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { assertSocketPath } from '../../harness/environment.js';
import { spawnOwned } from '../../harness/processes.js';
import type { Suite } from '../../harness/suite.js';
import { deadline } from '../../harness/wait.js';
import { launchActiveRouting, runTool, scripted } from './active.js';

/** The caller approved wrapper's path and digest in the actual fresh setup config. */
export async function activeAdmin(suite: Suite, wrapper: string): Promise<void> {
  const descriptorPath = suite.ownPath(join(suite.root, 'active-admin-descriptor.json'));
  const wrapperLog = suite.ownPath(join(suite.root, 'active-admin-wrapper.jsonl'));
  const scripts = {
    'admin-descriptor': scripted('admin-descriptor', 'spider', { action: 'exec', language: 'javascript', code:
      `require('node:fs').writeFileSync(${JSON.stringify(descriptorPath)},process.env.SPIDER_HERDR_SSH_DESCRIPTOR || '')` }),
    'admin-sibling-allow': scripted('admin-sibling-allow', 'spider', { action: 'exec', language: 'shell', code: 'ssh outside.invalid admin-control' }),
    'admin-sibling-deny': scripted('admin-sibling-deny', 'spider', { action: 'exec', language: 'shell', code: 'ssh dest.invalid sibling' }),
  };
  assertSocketPath(suite.root, suite.pi.gateSocket);
  const gates = await suite.gates();
  const active = await launchActiveRouting(suite, scripts);
  let admin: ReturnType<typeof spawnOwned> | undefined, released = false;
  try {
    const descriptorResult = await runTool(active.driver, 'admin-descriptor', 'admin-descriptor');
    expect(descriptorResult.isError).toBe(false);
    const descriptor = await readFile(descriptorPath, 'utf8');
    expect(descriptor).not.toBe('');
    const env = { ...suite.env, ...active.env, SPIDER_HERDR_SSH_DESCRIPTOR: descriptor, FIXTURE_SHIM_CLI: suite.packed.cli,
      FIXTURE_ADMIN_DIRECTORY: join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/admin'), FIXTURE_ADMIN_OBSERVATIONS: wrapperLog,
      FIXTURE_ADMIN_GATE_SOCKET: suite.pi.gateSocket, FIXTURE_ADMIN_GATE_STORY: suite.story, FIXTURE_ADMIN_GATE_NAME: 'active-admin' };
    const args = ['admin', '--session-id', 'fixture-owner', '--wrapper', wrapper, '--reason', 'Repair fixture', '--destination', 'dest.invalid', '--', 'admin arg'];
    admin = spawnOwned(suite.ledger, { label: 'active-admin', command: process.execPath, args: [suite.packed.cli, ...args], env, cwd: suite.root, stdio: 'pipe' });
    const out: Buffer[] = [], err: Buffer[] = [];
    admin.child.stdout!.on('data', data => out.push(data)); admin.child.stderr!.on('data', data => err.push(data));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
      admin!.child.once('error', reject); admin!.child.once('close', (code, signal) => resolveClose({ code, signal }));
    });
    admin.child.stdin!.end('');
    await gates.ready('active-admin', deadline(60_000));
    const row = JSON.parse((await readFile(wrapperLog, 'utf8')).trim().split('\n').at(-1)!);
    const capability = suite.ownPath(join(env.FIXTURE_ADMIN_DIRECTORY, 'bypass', row.token));
    expect((await stat(capability)).mode & 0o777).toBe(0o600);
    expect(row.audit).toMatchObject({ owner: 'fixture-owner', destination: 'dest.invalid', wrapper: { path: wrapper } });
    const before = (await active.records()).length;
    const positive = await runTool(active.driver, 'admin-sibling-allow', 'admin-sibling-allow');
    const positiveRecords = (await active.records()).slice(before);
    expect(positiveRecords).toEqual([{ argv: ['outside.invalid', 'admin-control'] }]);
    expect((positive.result as { details?: unknown }).details).toMatchObject({ stdout: 'TRANSPORT-OUT\n["outside.invalid","admin-control"]\n', stderr: 'TRANSPORT-ERR\n', exitCode: 41 });
    const after = (await active.records()).length;
    const refusal = await runTool(active.driver, 'admin-sibling-deny', 'admin-sibling-deny');
    await suite.evidence('active-admin-sibling.json', { row, positive, positiveRecords, refusal, transportCount: (await active.records()).length - after });
    expect(refusal.isError).toBe(true);
    expect(JSON.stringify(refusal.result)).toMatch(/on:/);
    expect(await active.records()).toHaveLength(after);
    gates.release('active-admin'); released = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('active admin did not exit')), 30_000); })])
      .finally(() => { if (timer) clearTimeout(timer); });
    const result = { ...exit, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
    await suite.evidence('active-admin-result.json', result);
    expect(result).toEqual({ code: 41, signal: null, stdout: 'TRANSPORT-OUT\n["dest.invalid","admin arg"]\n', stderr: 'TRANSPORT-ERR\n' });
    expect(await readdir(join(env.FIXTURE_ADMIN_DIRECTORY, 'bypass'))).toEqual([]);
    await suite.keepEvidence(active.log, 'active-admin-transport.jsonl');
  } finally {
    if (!released) try { gates.abort('active-admin'); } catch { /* gate did not reach ready */ }
    if (admin) await admin.stop();
    await active.driver.close();
  }
}
