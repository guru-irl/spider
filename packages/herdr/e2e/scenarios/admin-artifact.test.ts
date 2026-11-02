// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import { activeAdmin } from '../fixtures/transports/active-admin.js';
import { listenCoreIdentity } from '../fixtures/transports/live-socket.js';
import { prepareInstallInputs } from '../fixtures/install-inputs.js';
import { runSetup, readInstalled } from '../harness/setup.js';
import { spawnOwned } from '../harness/processes.js';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';

const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const lines = async (path: string): Promise<Record<string, any>[]> => {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
};

async function call(suite: Suite, env: Record<string, string>, args: string[], input = '') {
  const proc = spawnOwned(suite.ledger, { label: 'admin-artifact-cli', command: process.execPath, args: [suite.packed.cli, ...args], env, cwd: suite.root, stdio: 'pipe' });
  const out: Buffer[] = [], err: Buffer[] = [];
  proc.child.stdout!.on('data', data => out.push(data));
  proc.child.stderr!.on('data', data => err.push(data));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
    proc.child.once('error', reject);
    proc.child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  proc.child.stdin!.end(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { void proc.stop(); reject(new Error('packed CLI did not exit within 30 seconds')); }, 30_000);
    })]);
    return { ...result, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  } finally { if (timer) clearTimeout(timer); }
}

async function runArtifact(suite: Suite): Promise<void> {
    const dir = suite.ownPath(join(suite.root, 'admin-artifact'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const wrapper = join(dir, 'approved-wrapper');
    const otherWrapper = join(dir, 'other-wrapper');
    const sentinel = join(dir, 'ssh-sentinel');
    for (const [source, target] of [['admin-wrapper.mjs', wrapper], ['admin-wrapper.mjs', otherWrapper], ['ssh-sentinel.mjs', sentinel]]) {
      await copyFile(resolve('packages/herdr/e2e/fixtures/transports', source), target);
      await chmod(target, 0o700);
    }
    const wrapperBytes = await readFile(wrapper);
    const wrapperHash = digest(wrapperBytes);
    const globalRoot = suite.directories.SPIDER_GLOBAL_ROOT;
    const adminDirectory = join(globalRoot, 'herdr/admin');
    const audit = join(adminDirectory, 'audit.jsonl');
    const observations = join(dir, 'wrapper-observations.jsonl');
    const transportLog = join(dir, 'transport.jsonl');
    const cache = join(globalRoot, 'herdr/ssh/cache.json');
    const shimDirectory = join(dir, 'shim');
    await mkdir(join(globalRoot, 'herdr/ssh'), { recursive: true, mode: 0o700 });
    await mkdir(shimDirectory, { mode: 0o700 });
    // The packed --ssh-shim entry realpaths this identity to reject self-resolution.
    // It is not executed in this artifact-only fixture and fails closed if called.
    await writeFile(join(shimDirectory, 'ssh'), '#!/bin/sh\nexit 90\n', { mode: 0o700 });
    const identity = { coreId: 'fixture-core', socket: join(suite.root, 'admin.sock'), sessionNamespace: 'fixture' };
    // The real shim probes connectivity only. This listener supplies that exact boundary, not hc responses.
    const alive = await listenCoreIdentity(suite, identity.socket);
    try {
    const snapshot = () => ({ version: 1, identity, fetchedAt: Date.now(), machines: [{ id: 'm1', name: 'managed.invalid', targets: ['managed.invalid', 'alias.invalid'] }] });
    const validCache = () => writeFile(cache, JSON.stringify(snapshot()), { mode: 0o600 });
    const descriptor = JSON.stringify({ shimDirectory, realSshBinary: sentinel, shimProgram: suite.packed.cli, cacheDescriptor: { path: cache, identity } });
    const env = { ...suite.env, SPIDER_HERDR_SSH_DESCRIPTOR: descriptor, FIXTURE_SHIM_CLI: suite.packed.cli, FIXTURE_ADMIN_DIRECTORY: adminDirectory,
      FIXTURE_ADMIN_OBSERVATIONS: observations, FIXTURE_TRANSPORT_LOG: transportLog };
    const configPath = join(dir, 'resolved-config.json');
    const config = {
      enabled: true, app: { binary: join(dir, 'no-app'), home: suite.directories.HERDR_APP_HOME },
      core: { binary: join(dir, 'no-hc'), config: join(dir, 'no-core-config') },
      agentDirectory: suite.directories.PI_CODING_AGENT_DIR, globalRoot, shellRc: join(dir, 'rc'), spaces: [],
      machines: [{ name: 'managed.invalid', aliases: ['alias.invalid'], runtime: { cwd: null, directory: join(dir, 'runtime'), commands: {} } }],
      admin: { wrappers: [{ path: wrapper, sha256: wrapperHash }] },
    };
    await writeFile(join(globalRoot, 'config.json'), JSON.stringify({ 'herdr.config': configPath }), { mode: 0o600 });
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const argv = ['admin', '--session-id', 'owner-session', '--wrapper', wrapper, '--reason', 'Repair fixture', '--destination', 'managed.invalid', '--', 'arg with spaces', ';literal'];
    const input = 'stdin fixture\n';
    const expected = (args: string[]) => ({ code: 41, signal: null, stdout: `TRANSPORT-OUT\n${JSON.stringify(args)}\n${input}`, stderr: 'TRANSPORT-ERR\n' });
    const progress: object[] = [];
    const record = async (item: object) => { progress.push(item); await suite.evidence('admin-progress.json', progress); };
    const approved = async (destination = 'managed.invalid', reason = 'Repair fixture') => {
      const args = [...argv];
      args[args.indexOf('--destination') + 1] = destination;
      args[args.indexOf('--reason') + 1] = reason;
      const delivered = [destination, 'arg with spaces', ';literal'];
      const before = (await lines(observations)).length;
      const result = await call(suite, env, args, input);
      await record({ case: 'approved', destination, reasonLength: reason.length, result, observationCount: (await lines(observations)).length });
      expect(result).toEqual(expected(delivered));
      const rows = await lines(observations);
      expect(rows).toHaveLength(before + 1);
      const row = rows.at(-1)!;
      expect(row.argv).toEqual(delivered);
      expect(row.audit).toMatchObject({ owner: 'owner-session', reason, destination, argv: delivered, wrapper: { path: wrapper, sha256: wrapperHash } });
      expect(row.auditCount).toBe((await lines(audit)).length);
      expect(row.auditMode).toBe(0o600);
      expect(row.capabilityMode).toBe(0o600);
      expect(row.token).toMatch(/^[a-f0-9]{64}$/);
      expect(await readdir(join(adminDirectory, 'bypass'))).toEqual([]);
      return row.token as string;
    };
    const unmanaged = async () => {
      await validCache();
      const args = ['outside.invalid', 'unmanaged arg'];
      const before = (await lines(transportLog)).length;
      const result = await call(suite, env, ['--ssh-shim', ...args], input);
      expect(result).toEqual(expected(args));
      expect(await lines(transportLog)).toHaveLength(before + 1);
      expect((await lines(transportLog)).at(-1)?.argv).toEqual(args);
    };
    const refused = async (name: string, command: string[], candidateEnv = env, diagnostic = /admin-not-authorized|cli-usage|setup-failed/) => {
      await unmanaged();
      const beforeWrappers = (await lines(observations)).length;
      const beforeTransport = (await lines(transportLog)).length;
      const beforeAudit = (await lines(audit)).length;
      const result = await call(suite, candidateEnv, command, input);
      await record({ case: name, result, beforeWrappers, beforeTransport });
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBe(41);
      expect(result.stderr).toMatch(diagnostic);
      expect(await lines(observations)).toHaveLength(beforeWrappers);
      expect(await lines(transportLog)).toHaveLength(beforeTransport);
      expect(await lines(audit)).toHaveLength(beforeAudit);
    };
    // The first successful repair deliberately has neither hc nor a cache.
    await writeFile(cache, 'invalid cache', { mode: 0o600 });
    const first = await approved();
    await validCache();
    const second = await approved();
    expect(first).not.toBe(second);
    expect((await stat(audit)).mode & 0o777).toBe(0o600);
    await unmanaged();
    const beforeSibling = (await lines(transportLog)).length;
    const sibling = await call(suite, { ...env, SPIDER_HERDR_SSH_BYPASS: second }, ['--ssh-shim', 'managed.invalid'], input);
    await record({ case: 'revoked token in sibling', result: sibling });
    expect(sibling.code).toBe(126);
    expect(await lines(transportLog)).toHaveLength(beforeSibling);

    const alternateConfig = join(dir, 'caller-config.json');
    await writeFile(alternateConfig, JSON.stringify({ ...config, admin: { wrappers: [{ path: otherWrapper, sha256: wrapperHash }] } }));
    const cases: { name: string; alter: (args: string[]) => void }[] = [
      { name: 'caller config', alter: args => { args.splice(1, 0, '--config', alternateConfig); args[args.indexOf('--wrapper') + 1] = otherWrapper; } },
      { name: 'unapproved wrapper', alter: args => { args[args.indexOf('--wrapper') + 1] = otherWrapper; } },
      { name: 'unmanaged destination', alter: args => { args[args.indexOf('--destination') + 1] = 'outside.invalid'; } },
      { name: 'blank reason', alter: args => { args[args.indexOf('--reason') + 1] = '   '; } },
      { name: 'control reason', alter: args => { args[args.indexOf('--reason') + 1] = 'repair\nnow'; } },
      { name: 'C1 control reason', alter: args => { args[args.indexOf('--reason') + 1] = 'repair\u0085now'; } },
      { name: 'overlong reason', alter: args => { args[args.indexOf('--reason') + 1] = 'x'.repeat(2049); } },
    ];
    for (const item of cases) { const args = [...argv]; item.alter(args); await refused(item.name, args); }
    await writeFile(wrapper, Buffer.concat([wrapperBytes, Buffer.from('\n// changed\n')]));
    try { await refused('changed wrapper', argv); } finally { await writeFile(wrapper, wrapperBytes); }
    const failedAuditRoot = join(dir, 'bad-audit-root');
    await mkdir(join(failedAuditRoot, 'herdr/admin/audit.jsonl'), { recursive: true, mode: 0o700 });
    await writeFile(configPath, JSON.stringify({ ...config, globalRoot: failedAuditRoot }));
    try { await refused('failed audit', argv); } finally { await writeFile(configPath, JSON.stringify(config)); }
    const positiveFailures: string[] = [];
    for (const [destination, reason] of [['MaNaGeD.InVaLiD', 'Repair fixture'], ['ALIAS.InVaLiD', 'Repair fixture'], ['managed.invalid', 'x'.repeat(2048)]] as const) {
      await validCache();
      try { await approved(destination, reason); } catch (error) { positiveFailures.push(`${destination}: ${String((error as Error).message ?? error)}`); }
    }
    await alive.close();
    const beforeDead = (await lines(transportLog)).length;
    const deadSibling = await call(suite, { ...env, SPIDER_HERDR_SSH_BYPASS: second }, ['--ssh-shim', 'managed.invalid'], input);
    expect(deadSibling).toEqual(expected(['managed.invalid']));
    expect(await lines(transportLog)).toHaveLength(beforeDead + 1);
    expect((await lines(transportLog)).at(-1)?.argv).toEqual(['managed.invalid']);
    await record({ case: 'dead core passes the same revoked-token sibling unchanged', result: deadSibling });
    await suite.keepEvidence(observations, 'wrapper-observations.jsonl');
    await suite.keepEvidence(audit, 'audit.jsonl');
    await suite.keepEvidence(transportLog, 'transport.jsonl');
    if (positiveFailures.length) throw new Error(`admin positive controls failed: ${positiveFailures.join('; ')}`);
    } finally { await alive.close(); }
}

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S48'),
  title: 'The packed admin route authorizes only an audited approved wrapper',
  tiers: ['ci', 'headless', 'remote'],
  async run(suite) {
    if (suite.options.tier !== 'ci') {
      const { remoteInstallOptions } = await import('../fixtures/remote-install-inputs.js');
      const inputs = await prepareInstallInputs(suite, await remoteInstallOptions(suite));
      const wrapper = suite.ownPath(join(suite.root, 'active-approved-wrapper'));
      await copyFile(resolve('packages/herdr/e2e/fixtures/transports/admin-wrapper.mjs'), wrapper); await chmod(wrapper, 0o700);
      const sha256 = digest(await readFile(wrapper));
      const result = await runSetup(inputs.suite, { ...inputs.config, admin: { wrappers: [{ path: wrapper, sha256 }] } });
      await suite.evidence('active-admin-setup.json', result);
      expect(result.exitCode, result.stderr).toBe(0);
      await readInstalled(inputs.suite);
      let failure: unknown;
      try { await activeAdmin(inputs.suite, wrapper); } catch (error) { failure = error; }
      await runArtifact(suite);
      if (failure) throw failure;
      return;
    }
    await runArtifact(suite);
  },
}];
