// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { chmod, copyFile, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import { assertSocketPath } from '../../harness/environment.js';
import { spawnOwned } from '../../harness/processes.js';
import type { Suite } from '../../harness/suite.js';
import { deadline } from '../../harness/wait.js';
import { artifactTransport } from './artifact.js';

/** The admin CLI creates the real capability. Only its owned file timestamps are changed. */
export async function tokenExpiry(suite: Suite): Promise<void> {
  const transport = await artifactTransport(suite);
  try {
  const wrapper = join(transport.root, 'expiry-wrapper'), observationsPath = join(transport.root, 'expiry-wrapper.jsonl');
  await copyFile(resolve('packages/herdr/e2e/fixtures/transports/admin-wrapper.mjs'), wrapper); await chmod(wrapper, 0o700);
  const hash = createHash('sha256').update(await readFile(wrapper)).digest('hex');
  const globalRoot = suite.directories.SPIDER_GLOBAL_ROOT, adminDirectory = join(globalRoot, 'herdr/admin');
  const configPath = join(transport.root, 'expiry-config.json');
  const config = {
    app: { binary: join(transport.root, 'no-app'), home: suite.directories.HERDR_APP_HOME },
    core: { binary: join(transport.root, 'no-hc'), config: join(transport.root, 'no-core') },
    agentDirectory: suite.directories.PI_CODING_AGENT_DIR, globalRoot, shellRc: join(transport.root, 'rc'), spaces: [],
    machines: [{ name: 'managed.invalid', aliases: [], runtime: { cwd: null, directory: join(transport.root, 'runtime'), commands: {} } }],
    admin: { wrappers: [{ path: wrapper, sha256: hash }] },
  };
  await writeFile(join(globalRoot, 'config.json'), JSON.stringify({ 'herdr.config': configPath }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await transport.valid();
  assertSocketPath(suite.root, suite.pi.gateSocket);
  const gates = await suite.gates();
  const env = { ...transport.env, FIXTURE_SHIM_CLI: suite.packed.cli, FIXTURE_ADMIN_DIRECTORY: adminDirectory,
    FIXTURE_ADMIN_OBSERVATIONS: observationsPath, FIXTURE_ADMIN_GATE_SOCKET: suite.pi.gateSocket,
    FIXTURE_ADMIN_GATE_STORY: suite.story, FIXTURE_ADMIN_GATE_NAME: 'token-expiry' };
  const args = ['admin', '--session-id', 'owner-session', '--wrapper', wrapper, '--reason', 'Repair fixture', '--destination', 'managed.invalid', '--', 'admin arg'];
  const admin = spawnOwned(suite.ledger, { label: 'expiry-admin', command: process.execPath, args: [suite.packed.cli, ...args], env, cwd: suite.root, stdio: 'pipe' });
  const out: Buffer[] = [], err: Buffer[] = [];
  admin.child.stdout!.on('data', data => out.push(data)); admin.child.stderr!.on('data', data => err.push(data));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
    admin.child.once('error', reject); admin.child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  admin.child.stdin!.end('admin stdin\n');
  const findings: string[] = [], evidence: object[] = [];
  const record = async (item: object) => { evidence.push(item); await suite.evidence('token-expiry.json', evidence); };
  const check = (condition: boolean, message: string) => { if (!condition) findings.push(message); };
  const control = async (name: string) => {
    await transport.valid();
    const args = ['outside.invalid', name], before = (await transport.records()).length;
    const result = await transport.run(args), records = (await transport.records()).slice(before);
    expect(result).toEqual({ exitCode: 41, stdout: `TRANSPORT-OUT\n${JSON.stringify(args)}\n`, stderr: 'TRANSPORT-ERR\n' });
    expect(records).toEqual([{ argv: args }]);
  };
  let released = false;
  try {
    await gates.ready('token-expiry', deadline(60_000));
    const row = JSON.parse((await readFile(observationsPath, 'utf8')).trim().split('\n').at(-1)!);
    const token = row.token as string;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(row.audit).toMatchObject({ owner: 'owner-session', destination: 'managed.invalid', wrapper: { path: wrapper, sha256: hash } });
    expect(row.auditMode).toBe(0o600); expect(row.capabilityMode).toBe(0o600);
    const capability = suite.ownPath(join(adminDirectory, 'bypass', token));
    await control('sibling-positive');
    let before = (await transport.records()).length;
    const sibling = await transport.run(['managed.invalid', 'sibling']);
    await record({ name: 'sibling without token', result: sibling });
    check(sibling.exitCode === 126 && (await transport.records()).length === before, 'ordinary sibling inherited approval');
    const liveArgs = ['managed.invalid', 'live-token'];
    const live = await transport.run(liveArgs, { SPIDER_HERDR_SSH_BYPASS: token });
    expect(live).toEqual({ exitCode: 41, stdout: `TRANSPORT-OUT\n${JSON.stringify(liveArgs)}\n`, stderr: 'TRANSPORT-ERR\n' });
    for (const [name, milliseconds] of [['expired', Date.now() - 120_000], ['future', Date.now() + 120_000]] as const) {
      await control(`${name}-positive`);
      await utimes(capability, new Date(milliseconds), new Date(milliseconds));
      const mtime = (await stat(capability)).mtimeMs;
      before = (await transport.records()).length;
      const result = await transport.run(['managed.invalid', name], { SPIDER_HERDR_SSH_BYPASS: token });
      const after = (await transport.records()).length;
      await record({ name, mtime, result, transportCount: after - before });
      check(result.exitCode === 126 && after === before, `${name} token authorized managed transport`);
    }
    const now = new Date(); await utimes(capability, now, now);
    const restoredArgs = ['managed.invalid', 'restored-token'];
    const restored = await transport.run(restoredArgs, { SPIDER_HERDR_SSH_BYPASS: token });
    expect(restored).toEqual({ exitCode: 41, stdout: `TRANSPORT-OUT\n${JSON.stringify(restoredArgs)}\n`, stderr: 'TRANSPORT-ERR\n' });
    gates.release('token-expiry'); released = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('admin wrapper did not exit')), 30_000); })])
      .finally(() => { if (timer) clearTimeout(timer); });
    const result = { ...exit, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
    await record({ name: 'completed admin', result });
    expect(result).toEqual({ code: 41, signal: null, stdout: 'TRANSPORT-OUT\n["managed.invalid","admin arg"]\nadmin stdin\n', stderr: 'TRANSPORT-ERR\n' });
    expect(await readdir(join(adminDirectory, 'bypass'))).toEqual([]);
    await transport.close();
    const beforeDead = (await transport.records()).length;
    const dead = await transport.run(['managed.invalid', 'sibling']);
    expect(dead.exitCode).toBe(41); expect(await transport.records()).toHaveLength(beforeDead + 1);
    expect((await transport.records()).at(-1)?.argv).toEqual(['managed.invalid', 'sibling']);
    await record({ name: 'same ordinary sibling passes with dead descriptor core', result: dead });
    await suite.keepEvidence(transport.log, 'token-expiry-transport.jsonl');
  } finally {
    if (!released) try { gates.abort('token-expiry'); } catch { /* the gate did not reach ready */ }
    await admin.stop();
  }
  if (findings.length) throw new Error(`admin capability expiry failures: ${findings.join('; ')}`);
  } finally { await transport.close(); }
}
