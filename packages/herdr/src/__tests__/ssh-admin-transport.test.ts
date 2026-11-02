// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runHerdrAdmin } from '../ssh/admin.js';
import { runAdminCli } from '../ssh/admin-cli.js';
import { installSshShim, createExecutionEnvironmentPolicy } from '../ssh/shim.js';
import { standardHerdrConfigPath } from '../setup/installer.js';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { configFixtureCwd } from '../../../host/src/__tests__/herdr-config-fixture.js';

async function fixture(body: (root: string, env: NodeJS.ProcessEnv, wrapper: string) => Promise<void>) {
  const root = await mkdtemp(resolve('.spider/scratch/ssh-admin-expiry-'));
  const wrapper = join(root, 'wrapper'), capture = join(root, 'destination');
  try {
    execFileSync('git', ['init', '-q', root]);
    await writeFile(wrapper, '#!/bin/sh\nprintf "%s" "$1" > "$CAPTURE_DESTINATION"\nexit 19\n', { mode: 0o700 });
    const globalRoot = join(root, 'state');
    await mkdir(join(globalRoot, 'herdr'), { recursive: true });
    await writeFile(standardHerdrConfigPath(globalRoot), JSON.stringify({ enabled: true,
      app: { binary: join(root, 'no-app'), home: join(root, 'app') }, core: { binary: join(root, 'no-core'), config: join(root, 'core.toml') },
      agentDirectory: join(root, 'agent'), globalRoot, shellRc: join(root, 'shellrc'), spaces: [],
      machines: [{ name: 'managed.invalid', aliases: ['managed-alias.invalid'], runtime: { cwd: null, directory: join(root, 'runtime'), commands: {} } }],
      admin: { wrappers: [{ path: wrapper, sha256: createHash('sha256').update(await readFile(wrapper)).digest('hex') }] } }));
    await body(root, { ...process.env, SPIDER_GLOBAL_ROOT: globalRoot, CAPTURE_DESTINATION: capture }, wrapper);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test.each(['MANAGED.invalid', 'MANAGED-ALIAS.invalid'])('admin authorizes configured destination %s case-insensitively', async destination => fixture(async (root, env, wrapper) => {
  const ports = configFixtureCwd(createProductionHerdrCliPorts(resolve('.'), env), root);
  try {
    expect(await runAdminCli(['--session-id', 'owner', '--wrapper', wrapper, '--reason', 'Repair transport', '--destination', destination, '--'], env,
      async () => (await ports.request()).config)).toBe(19);
    expect(await readFile(join(root, 'destination'), 'utf8')).toBe(destination);
  } finally { await ports.dispose(); }
}));

test('admin transport receives one sanitized execution environment', async () => fixture(async (root, env, wrapper) => {
  const ports = configFixtureCwd(createProductionHerdrCliPorts(resolve('.'), env), root);
  try {
    const config = (await ports.request()).config;
    await runHerdrAdmin({ owner: { sessionId: 'owner' as never }, wrapper, reason: 'Repair transport', destination: 'managed.invalid' }, {
      wrappers: config.admin.wrappers, environment: { ...env, SPIDER_HERDR_SSH_BYPASS: '1' },
      routing: { checkArgv: async () => ({ kind: 'refuse', machine: 'managed.invalid', reason: 'Managed' }), checkShell: async () => ({ kind: 'allow' }) },
      audit: async () => {}, transport: async request => {
        expect(Object.keys(request).sort()).toEqual(['argv', 'destination', 'env', 'wrapper']);
        expect(request.env.SPIDER_HERDR_SSH_BYPASS).toBeUndefined();
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
  } finally { await ports.dispose(); }
}));

test('an expired orphan bypass token cannot reach real SSH', async () => fixture(async (root, env) => {
  const realSshBinary = join(root, 'real-ssh');
  await writeFile(realSshBinary, '#!/bin/sh\nprintf RAW-SSH-REACHED\nexit 23\n', { mode: 0o700 });
  const options = { shimDirectory: join(root, 'bin'), realSshBinary, shimProgram: resolve('dist/herdr/cli.mjs'),
    cacheDescriptor: { path: join(env.SPIDER_GLOBAL_ROOT!, 'herdr/ssh/missing.json'), identity: { coreId: 'isolated' as never, sessionNamespace: 'isolated', socket: join(root, 's') } } };
  await installSshShim(options);
  const token = 'b'.repeat(64), directory = join(env.SPIDER_GLOBAL_ROOT!, 'herdr/admin/bypass');
  await mkdir(directory, { recursive: true });
  const capability = join(directory, token);
  await writeFile(capability, token, { mode: 0o600 });
  // Model a token left on disk after abrupt admin termination, well beyond its short lifetime.
  const expired = new Date(Date.now() - 120000); await utimes(capability, expired, expired);
  const core = createServer(connection => connection.end());
  try {
    await new Promise<void>((resolve, reject) => { core.once('error', reject); core.listen(options.cacheDescriptor.identity.socket, resolve); });
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(join(options.shimDirectory, 'ssh'), ['managed.invalid'], {
        env: { ...createExecutionEnvironmentPolicy(options)(env), SPIDER_HERDR_SSH_BYPASS: token }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.resume();
      child.once('error', reject); child.once('close', code => resolve({ code, stdout }));
    });
    expect(result).toEqual({ code: 126, stdout: '' });
  } finally {
    if (core.listening) await new Promise<void>((resolve, reject) => core.close(error => error ? reject(error) : resolve()));
  }
}));
