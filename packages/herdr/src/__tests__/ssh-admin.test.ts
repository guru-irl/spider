// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHerdrHarness, runAcceptance, type HerdrHarness } from './testutil.js';
import { createMachineCache } from '../ssh/cache.js';
import { createSshPolicy } from '../ssh/policy.js';
import { runHerdrAdmin, preflightTransports, createTransportPolicy, type AdminPolicy, type AdminAuditRow, type AdminTransportRequest } from '../ssh/admin.js';
import { ordinaryExecutionEnvironment } from '../ssh/shim.js';
import { acceptanceE } from './acceptance/e.js';
async function fixture(test: (h: HerdrHarness, policy: AdminPolicy, rows: AdminAuditRow[], transports: AdminTransportRequest[]) => Promise<void>) {
  const h = await createHerdrHarness('fake'); let cache: ReturnType<typeof createMachineCache> | undefined;
  try {
    await h.start(); await h.scenario({ ssh: { exitCode: 17, stdout: 'ok\n' } });
    cache = createMachineCache({ hc: h.hc, identity: await h.hc.identity(), directory: join(h.root, 'cache') }); await cache.ready;
    const wrapper = join(h.root, 'approved'); await writeFile(wrapper, '#!/bin/sh\nexit 0\n'); await chmod(wrapper, 0o700);
    const sha256 = createHash('sha256').update(await readFile(wrapper)).digest('hex'); const rows: AdminAuditRow[] = [], transports: AdminTransportRequest[] = [];
    const policy: AdminPolicy = { wrappers: [{ path: wrapper, sha256 }], routing: createSshPolicy(cache), environment: { ...h.localEnv, SPIDER_HERDR_SSH_BYPASS: '1', SPIDER_HERDR_TRANSPORT_CAPABILITY: 'stale', SPIDER_SESSION_LEASE_TOKEN: 'stale' },
      audit: async row => { rows.push(row); }, transport: async request => {
        transports.push(request);
        // Actual owned processes observe the two separate environments. No real host is contacted.
        const script = 'console.log(JSON.stringify(process.env))';
        const execute = (env: Readonly<NodeJS.ProcessEnv>) => new Promise<string>((resolve, reject) => {
          const child = spawn(h.nodeBinary, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', b => { output += b; }); child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`probe exit ${code}`)));
        });
        return { exitCode: 0, stdout: await execute(request.env), stderr: await execute(request.env) };
      } };
    await test(h, policy, rows, transports);
  } finally { await cache?.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}
describe('audited SSH administration', () => {
  it('ordinary jobs cannot inherit an administrative transport bypass', async () => fixture(async (h, policy, rows, transports) => {
    const result = await runHerdrAdmin({ owner: h.owner!, wrapper: policy.wrappers[0].path, reason: 'Synchronize runtime', destination: 'remote.invalid' }, policy);
    expect(rows).toMatchObject([{ destination: 'remote.invalid', reason: 'Synchronize runtime' }]);
    expect(Object.keys(rows[0]).sort()).toEqual(['argv', 'at', 'destination', 'owner', 'pid', 'reason', 'wrapper']);
    expect(JSON.parse(result.stdout).SPIDER_HERDR_SSH_BYPASS).toBeUndefined(); expect(JSON.parse(result.stderr).SPIDER_HERDR_SSH_BYPASS).toBeUndefined();
    expect(JSON.parse(result.stdout).SPIDER_HERDR_TRANSPORT_CAPABILITY).toBeUndefined(); expect(JSON.parse(result.stderr).SPIDER_SESSION_LEASE_TOKEN).toBeUndefined();
    await expect(runHerdrAdmin({ owner: h.owner!, wrapper: join(h.root, 'other.invalid'), reason: '', destination: 'remote.invalid' }, policy)).rejects.toMatchObject({ code: 'admin-not-authorized' });
    expect(transports).toHaveLength(1);
  }));
  it('never exempts a basename, changed wrapper contents, missing reason, or unknown destination', async () => fixture(async (h, policy, rows, transports) => {
    const request = { owner: h.owner!, wrapper: policy.wrappers[0].path, reason: 'Inspect', destination: 'remote.invalid' };
    await expect(runHerdrAdmin({ ...request, wrapper: '/usr/bin/ssh' }, policy)).rejects.toMatchObject({ code: 'admin-not-authorized' });
    await expect(runHerdrAdmin({ ...request, reason: ' ' }, policy)).rejects.toMatchObject({ code: 'admin-not-authorized' });
    await expect(runHerdrAdmin({ ...request, destination: 'elsewhere.invalid' }, policy)).rejects.toMatchObject({ code: 'admin-not-authorized' });
    await writeFile(request.wrapper, '#!/bin/sh\nexit 17\n');
    await expect(runHerdrAdmin(request, policy)).rejects.toMatchObject({ code: 'admin-not-authorized' });
    expect(rows).toEqual([]); expect(transports).toEqual([]);
  }));
  it('does not grant transport bypass if the local audit sink fails', async () => fixture(async (h, policy, _rows, transports) => {
    await expect(runHerdrAdmin({ owner: h.owner!, wrapper: policy.wrappers[0].path, reason: 'Inspect', destination: 'remote.invalid' }, { ...policy, audit: async () => { throw new Error('audit unavailable'); } })).rejects.toThrow('audit unavailable');
    expect(transports).toEqual([]);
  }));
  it.each([
    'scp -P 2222 local user@remote.invalid:/file', 'scp remote.invalid:/file elsewhere.invalid:/file', 'scp scp://user@remote.invalid:2222/file local',
    'sftp -b commands user@remote.invalid', 'sftp sftp://remote.invalid/path',
    'rsync -e "ssh -p 2222" local remote.invalid:/path', 'RSYNC_RSH="ssh -J remote.invalid" rsync local elsewhere.invalid:/path',
    'git clone user@remote.invalid:repo', 'git clone ssh://user@remote.invalid:2222/repo',
    'git -c core.sshCommand="ssh -J remote.invalid" clone ssh://elsewhere.invalid/repo', 'GIT_SSH_COMMAND="ssh -J remote.invalid" git fetch', 'GIT_SSH=/usr/bin/ssh git clone remote.invalid:/repo',
  ])('preflights explicit managed transfer or Git SSH transport: %s', async code => fixture(async (_h, policy) => {
    expect(await preflightTransports(code, policy.routing, {})).toMatchObject({ kind: 'refuse' });
    expect(await createTransportPolicy(policy.routing, () => ({})).checkShell(code)).toMatchObject({ kind: 'refuse' });
  }));
  it('preflights transport overrides in the final environment', async () => fixture(async (_h, policy) => {
    expect(await preflightTransports('rsync local elsewhere.invalid:/path', policy.routing, { RSYNC_RSH: 'ssh -J remote.invalid' })).toMatchObject({ kind: 'refuse' });
    expect(await preflightTransports('git fetch', policy.routing, { GIT_SSH_COMMAND: 'ssh -J remote.invalid' })).toMatchObject({ kind: 'refuse' });
  }));
  it('preserves HTTPS Git, local copies and unrelated explicit endpoints', async () => fixture(async (_h, policy) => {
    for (const code of ['git clone https://example.invalid/repo', 'cp local other', 'scp local other.invalid', 'scp file elsewhere.invalid:/path', 'rsync -e ssh file elsewhere.invalid:/path']) expect(await preflightTransports(code, policy.routing, {})).toEqual({ kind: 'allow' });
    expect(await preflightTransports('git clone https://example.invalid/repo', policy.routing, { GIT_SSH_COMMAND: 'ssh -J remote.invalid' })).toEqual({ kind: 'allow' });
    expect(ordinaryExecutionEnvironment({ SPIDER_HERDR_SSH_BYPASS: '1' }).SPIDER_HERDR_SSH_BYPASS).toBeUndefined();
  }));
  it('proves guards and nested PATH SSH while recording the nested absolute-binary limitation', async () => {
    const h = await createHerdrHarness(process.env.SPIDER_HERDR_E2E === '1' ? 'hc' : 'fake');
    try {
      await h.start();
      console.log('SSH ACCEPTANCE ISOLATION', JSON.stringify({ mode: h.mode, root: h.root, localSocket: h.localSocket, remoteSocket: h.remoteSocket, localCoreId: h.localCoreId, remoteCoreId: h.remoteCoreId }));
      await acceptanceE(h);
    } finally {
      await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
      console.log('SSH ACCEPTANCE CLEANUP', JSON.stringify(h.cleanupProof));
      await writeFile(resolve('.spider/scratch/h', `ssh-policy-${h.mode}-proof.json`), JSON.stringify({ mode: h.mode, root: h.root, localSocket: h.localSocket, remoteSocket: h.remoteSocket, localCoreId: h.localCoreId, remoteCoreId: h.remoteCoreId, cleanup: h.cleanupProof }, null, 2));
    }
  }, 30000);
});
