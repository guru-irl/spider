// SPDX-License-Identifier: MIT
import { access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createMachineCache, type MachineCache } from '../ssh/cache.js';
import { createExecutionEnvironmentPolicy, finalChildEnvironment, installSshShim, sshShimDirectory } from '../ssh/shim.js';
import { isCoreAvailable } from '../client/liveness.js';

const realHc = process.env.SPIDER_HERDR_E2E === '1' && await access(process.env.SPIDER_HERDR_HC_BINARY ?? join(process.env.HOME!, '.local/bin/hc')).then(() => true, () => false);
if (!realHc) console.info('Real isolated hc core-loss checks skipped; set SPIDER_HERDR_E2E=1 with hc installed.');

function bash(command: string, env: Readonly<NodeJS.ProcessEnv>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], { env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function stopOwnerCore(h: HerdrHarness) {
  // The harness proves these sockets and core identities before its first mutation.
  expect(h.localSocket).not.toBe(join(process.env.HOME!, '.local/state/herdr-core/default/default.sock'));
  await h.hc.kill(h.owner!.terminal.address); await h.hc.rm(h.owner!.terminal.address);
  await h.cli(['machine', 'rm', 'remote.invalid', '--json']);
  await h.cli(['server', 'stop', '--json']);
  expect(await isCoreAvailable(h.localEnv)).toBe(false);
}

for (const mode of ['fake', 'hc'] as const) for (const age of [200000, 0]) {
  test.skipIf(mode === 'hc' && !realHc)(`${mode}: child bash reaches ordinary ssh after core loss with a ${age} ms old cache`, async () => {
    const h = await createHerdrHarness(mode); let cache: MachineCache | undefined;
    try {
      await h.start();
      cache = createMachineCache({ hc: h.hc, identity: h.owner!.terminal, directory: join(h.directories.global, 'herdr/ssh'), clock: () => Date.now() - age });
      await cache.ready;
      expect(cache.snapshot()?.machines.map(machine => machine.name)).toContain('remote.invalid');
      const realSshBinary = join(h.root, 'ordinary-ssh');
      await writeFile(realSshBinary, '#!/bin/sh\nprintf "ORDINARY-SSH %s\\n" "$*"\n', { mode: 0o700 });
      const options = { shimDirectory: sshShimDirectory(cache.descriptor), realSshBinary, cacheDescriptor: cache.descriptor, shimProgram: resolve('dist/herdr/cli.mjs') };
      await installSshShim(options);
      // This is the same final environment constructor used by the child runner.
      const parentEnv = createExecutionEnvironmentPolicy(options)(h.localEnv);
      const childEnv = finalChildEnvironment(parentEnv, { PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'shim-core-loss' });
      const alive = await bash('ssh remote.invalid true', childEnv);
      expect(alive.code).toBe(126); expect(alive.stdout).not.toContain('ORDINARY-SSH');
      if (age === 0) {
        const unmanaged = await bash('ssh unmanaged.invalid true', childEnv);
        expect(unmanaged.code).toBe(0); expect(unmanaged.stdout).toContain('ORDINARY-SSH unmanaged.invalid true');
      }
      await cache.dispose(); cache = undefined;
      await stopOwnerCore(h);
      // Other inherited HC settings cannot make a dead descriptor use an unrelated live core.
      const misleadingEnv = { ...childEnv, HC_SOCKET: h.remoteSocket, HC_TERMINAL_SOCKET: h.remoteSocket, HC_SESSION: 'r' };
      expect(await isCoreAvailable(misleadingEnv)).toBe(true);
      for (const command of ['ssh unmanaged.invalid true', 'ssh remote.invalid true', 'ssh -F missing-config unmanaged.invalid true']) {
        const dead = await bash(command, misleadingEnv);
        expect(dead.code).toBe(0); expect(dead.stdout).toContain('ORDINARY-SSH'); expect(dead.stderr).toBe('');
      }
      expect(await isCoreAvailable(h.localEnv)).toBe(false);
    } finally {
      await cache?.dispose(); await h.close();
      expect(await h.remainingOwnedResources()).toEqual([]);
    }
  }, 60000);
}
