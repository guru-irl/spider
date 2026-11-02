// SPDX-License-Identifier: MIT
import { access, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createMachineCache, type MachineCache } from '../ssh/cache.js';
import { createExecutionEnvironmentPolicy, finalChildEnvironment, installSshShim, sshShimDirectory } from '../ssh/shim.js';
import { isCoreAvailable } from '../client/liveness.js';

const realHc = process.env.SPIDER_HERDR_E2E === '1' && await access(process.env.SPIDER_HERDR_HC_BINARY ?? join(process.env.HOME!, '.local/bin/hc')).then(() => true, () => false);
if (!realHc) console.info('Real isolated hc restart checks skipped; set SPIDER_HERDR_E2E=1 with hc installed.');

function bash(command: string, env: Readonly<NodeJS.ProcessEnv>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], { env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function stopOwnerCore(h: HerdrHarness): Promise<void> {
  expect(h.localSocket).not.toBe(join(process.env.HOME!, '.local/state/herdr-core/default/default.sock'));
  await h.hc.kill(h.owner!.terminal.address); await h.hc.rm(h.owner!.terminal.address);
  await h.cli(['machine', 'rm', 'remote.invalid', '--json']);
  await h.cli(['server', 'stop', '--json']);
  expect(await isCoreAvailable(h.localEnv)).toBe(false);
}

// Rejecting all destinations solely because the cache aged breaks these tests.
for (const mode of ['fake', 'hc'] as const) for (const age of [200000, -200000]) {
  test.skipIf(mode === 'hc' && !realHc)(`${mode}: inherited ssh allows only known-unmanaged routes after core restart with cache age ${age}`, async () => {
    const h = await createHerdrHarness(mode); let cache: MachineCache | undefined;
    try {
      await h.start();
      cache = createMachineCache({ hc: h.hc, identity: h.owner!.terminal, directory: join(h.directories.global, 'herdr/ssh'),
        aliases: { 'remote.invalid': ['remote-alias.invalid', 'remote-host.invalid', 'resolved-target.invalid'] }, clock: () => Date.now() - age });
      await cache.ready;
      expect(cache.snapshot()?.machines.map(machine => machine.name)).toContain('remote.invalid');
      const realSshBinary = join(h.root, 'ordinary-ssh');
      await writeFile(realSshBinary, '#!/bin/sh\nprintf "ORDINARY-SSH %s\\n" "$*"\n', { mode: 0o700 });
      const options = { shimDirectory: sshShimDirectory(cache.descriptor), realSshBinary, cacheDescriptor: cache.descriptor, shimProgram: resolve('dist/herdr/cli.mjs') };
      await installSshShim(options);
      const parentEnv = createExecutionEnvironmentPolicy(options)(h.localEnv);
      const childEnv = finalChildEnvironment(parentEnv, { PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'shim-core-restart' });
      await cache.dispose(); cache = undefined;
      await stopOwnerCore(h);
      // Real hc status itself restarts the stopped namespace. The fake needs start.
      if (mode === 'fake') await h.cli(['server', 'start', '--json']);
      const status = await h.cli(['server', 'status', '--json']);
      expect(await isCoreAvailable(h.localEnv)).toBe(true);
      expect((await h.hc.identity()).coreId).toBe(h.owner!.terminal.coreId);
      await writeFile(join(h.root, '..', `restart-${h.localCoreId}-${age}.json`), JSON.stringify({ status, oldCoreId: h.owner!.terminal.coreId, socket: h.localSocket, age }));

      for (const env of [parentEnv, childEnv]) {
        for (const command of [
          'ssh unmanaged.invalid true',
          'ssh -J gateway.invalid -o HostName=unmanaged-target.invalid unmanaged.invalid true',
        ]) {
          const result = await bash(command, env);
          expect(result.code, `${command}: ${result.stderr}`).toBe(0);
          expect(result.stdout).toContain('ORDINARY-SSH'); expect(result.stderr).toBe('');
        }
        for (const command of [
          'ssh remote.invalid true',
          'ssh user@REMOTE.INVALID. true',
          'ssh remote-alias.invalid true',
          'ssh remote-host.invalid true',
          'ssh resolved-target.invalid true',
          'ssh -o HostName=remote-host.invalid unmanaged.invalid true',
          'ssh -J remote-alias.invalid unmanaged.invalid true',
          'ssh -o "ProxyCommand=ssh remote.invalid true" unmanaged.invalid true',
          'ssh -W resolved-target.invalid:22 unmanaged.invalid true',
          'ssh -F missing-config unmanaged.invalid true',
          'ssh -o "ProxyCommand=unknown-proxy" unmanaged.invalid true',
          'ssh --unknown unmanaged.invalid true',
          'ssh',
        ]) {
          const result = await bash(command, env);
          expect(result.code, command).toBe(126); expect(result.stdout).not.toContain('ORDINARY-SSH');
        }
      }
      // Without any readable snapshot, the existing alive-core fail-closed rule stays.
      await unlink(options.cacheDescriptor.path);
      const missing = await bash('ssh unmanaged.invalid true', childEnv);
      expect(missing.code).toBe(126); expect(missing.stdout).not.toContain('ORDINARY-SSH');
      expect(missing.stderr).toContain("Spider couldn't check Herdr's machine list");
    } finally {
      await cache?.dispose(); await h.close();
      expect(await h.remainingOwnedResources()).toEqual([]);
    }
  }, 60000);
}
