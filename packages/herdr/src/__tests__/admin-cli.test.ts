// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { beforeAll, afterAll, expect, test } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'vite';
import { runHerdrCli } from '../setup/cli.js';
import { installSshShim, createExecutionEnvironmentPolicy } from '../ssh/shim.js';
import { globalConfigForTest } from '../../../db-core/src/__tests__/global-config.testutil.js';

let root: string, cli: string;
beforeAll(async () => {
  root = await mkdtemp(resolve('.spider/scratch/admin-cli-')); cli = join(root, 'cli.mjs');
  execFileSync('git', ['init', '-q', root]);
  const external = [/^node:/, /^@earendil-works\//, /^better-sqlite3(?:\/|$)/, /^sqlite-vec(?:\/|$)/, /^fastembed(?:\/|$)/, /^onnxruntime-/, /^turndown(?:\/|$)/];
  await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.spiderHerdrRuntimeEntry': 'false' },
    ssr: { noExternal: [/^@spider\//] }, build: { ssr: true, outDir: root, emptyOutDir: false, minify: false,
      rollupOptions: { input: resolve('packages/herdr/src/bin/cli.ts'), external, output: { entryFileNames: 'cli.mjs', codeSplitting: false } } } });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function call(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, stdin = '') {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], { env, cwd: root, stdio: 'pipe' }); let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(stdin);
  });
}
test('CLI help documents the executable admin route and transport contract without reading configuration', async () => {
  const result = await call(['--help']);
  expect(result.code).toBe(0); expect(result.stdout).toContain('admin [--session-id');
  expect(result.stderr).toBe('');
  for (const flag of ['--wrapper', '--reason', '--destination', '--session-id']) expect(result.stdout).toContain(flag);
  expect(result.stdout).toContain('destination first'); expect(result.stdout).toContain('sha256');
});
test('packaged CLI dispatches admin inside Herdr and a child, preserving stdio and exit without hc', async () => {
  const wrapper = join(root, 'wrapper'); const configPath = join(root, 'config.json');
  const auditPath = join(root, 'state/herdr/admin/audit.jsonl');
  await writeFile(wrapper, '#!/bin/sh\n[ -s "$AUDIT_FILE" ] || exit 91\n[ -n "$SPIDER_HERDR_SSH_BYPASS" ] || exit 92\n[ -z "$SPIDER_HERDR_TRANSPORT_CAPABILITY" ] || exit 93\nprintf "destination=%s\\n" "$1"\nshift\nprintf "arg=%s\\n" "$@"\ncat\nprintf "transport-error\\n" >&2\nexit 29\n'); await chmod(wrapper, 0o700);
  await writeFile(configPath, JSON.stringify({
    app: { binary: '/nonexistent/app', home: '/nonexistent/app-home' }, core: { binary: '/nonexistent/hc', config: '/nonexistent/core' },
    agentDirectory: root, globalRoot: join(root, 'state'), shellRc: '/nonexistent/shell', spaces: [],
    machines: [{ name: 'managed.invalid', aliases: [], runtime: { cwd: null, directory: '/runtime', commands: {} } }],
    admin: { wrappers: [{ path: wrapper, sha256: createHash('sha256').update(await readFile(wrapper)).digest('hex') }] },
  }));
  await mkdir(join(root, 'state'), { recursive: true });
  globalConfigForTest(join(root, 'state')).set('herdr.config', configPath);
  const argv = ['admin', '--wrapper', wrapper, '--reason', 'Repair transport', '--destination', 'managed.invalid', '--', 'two words'];
  const result = await call(argv, { ...process.env, SPIDER_GLOBAL_ROOT: join(root, 'state'), HC_TERMINAL_ID: 'test-terminal', PI_SUBAGENT_CHILD: '1', PI_SPIDER_SESSION_ID: 'owner', SPIDER_HERDR_TRANSPORT_CAPABILITY: 'stale', AUDIT_FILE: auditPath }, 'input\n');
  expect(result).toEqual({ code: 29, stdout: 'destination=managed.invalid\narg=two words\ninput\n', stderr: 'transport-error\n' });
  expect(JSON.parse(await readFile(auditPath, 'utf8'))).toMatchObject({ owner: 'owner', destination: 'managed.invalid', reason: 'Repair transport' });
});
test('packaged admin crosses its shipped SSH shim while an ordinary sibling is refused without hc', async () => {
  const directory = await mkdtemp(join(root, 'shim-case-'));
  const wrapper = join(directory, 'wrapper'), realSshBinary = join(directory, 'real-ssh'), configPath = join(directory, 'config.json');
  await writeFile(wrapper, '#!/bin/sh\nexec ssh "$@"\n'); await chmod(wrapper, 0o700);
  await writeFile(realSshBinary, '#!/bin/sh\nprintf "ssh-destination=%s\\n" "$1"\nprintf "ssh-stderr\\n" >&2\nexit 37\n'); await chmod(realSshBinary, 0o700);
  await writeFile(configPath, JSON.stringify({
    app: { binary: '/nonexistent/app', home: '/nonexistent/app-home' }, core: { binary: '/nonexistent/hc', config: '/nonexistent/core' },
    agentDirectory: directory, globalRoot: join(directory, 'state'), shellRc: '/nonexistent/shell', spaces: [],
    machines: [{ name: 'managed.invalid', aliases: [], runtime: { cwd: null, directory: '/runtime', commands: {} } }],
    admin: { wrappers: [{ path: wrapper, sha256: createHash('sha256').update(await readFile(wrapper)).digest('hex') }] },
  }));
  const options = { shimDirectory: join(directory, 'bin'), realSshBinary, shimProgram: cli,
    cacheDescriptor: { path: join(directory, 'state/herdr/ssh/missing-cache'), identity: { coreId: 'core' as never, sessionNamespace: 'isolated', socket: join(directory, 's') } } };
  await installSshShim(options);
  await mkdir(join(directory, 'state'), { recursive: true });
  globalConfigForTest(join(directory, 'state')).set('herdr.config', configPath);
  const env = { ...createExecutionEnvironmentPolicy(options)(process.env), SPIDER_GLOBAL_ROOT: join(directory, 'state'), HC_TERMINAL_ID: 'test-terminal' };
  const core = createServer(connection => connection.end());
  try {
    await new Promise<void>((resolve, reject) => { core.once('error', reject); core.listen(options.cacheDescriptor.identity.socket, resolve); });
    expect((await call(['--ssh-shim', 'managed.invalid'], env)).code).toBe(126);
    expect(await call(['admin', '--session-id', 'top-owner', '--wrapper', wrapper, '--reason', 'Repair hc', '--destination', 'managed.invalid', '--'], env))
      .toEqual({ code: 37, stdout: 'ssh-destination=managed.invalid\n', stderr: 'ssh-stderr\n' });
    expect((await call(['--ssh-shim', 'managed.invalid'], env)).code).toBe(126);
  } finally {
    if (core.listening) await new Promise<void>((resolve, reject) => core.close(error => error ? reject(error) : resolve()));
  }
});
test('admin refuses a caller-supplied approval config before it can audit or launch', async () => {
  const directory = await mkdtemp(join(root, 'caller-config-'));
  const wrapper = join(directory, 'wrapper'), configPath = join(directory, 'config.json');
  await writeFile(wrapper, '#!/bin/sh\nprintf unapproved-wrapper-ran\\n\n'); await chmod(wrapper, 0o700);
  await writeFile(configPath, JSON.stringify({
    app: { binary: '/nonexistent/app', home: '/nonexistent/app-home' }, core: { binary: '/nonexistent/hc', config: '/nonexistent/core' },
    agentDirectory: directory, globalRoot: join(directory, 'state'), shellRc: '/nonexistent/shell', spaces: [],
    machines: [{ name: 'managed.invalid', aliases: [], runtime: { cwd: null, directory: '/runtime', commands: {} } }],
    admin: { wrappers: [{ path: wrapper, sha256: createHash('sha256').update(await readFile(wrapper)).digest('hex') }] },
  }));
  const result = await call(['admin', '--config', configPath, '--session-id', 'owner', '--wrapper', wrapper, '--reason', 'Repair', '--destination', 'managed.invalid', '--']);
  expect(result.code).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr).toContain('cli-usage');
  expect(await readFile(join(directory, 'state/herdr/admin/audit.jsonl')).then(() => true, () => false)).toBe(false);
});
test('admin and doctor without --config honour the host custom herdr.config setting', async () => {
  const directory = await mkdtemp(join(root, 'host-config-')), globalRoot = join(directory, 'state');
  await mkdir(globalRoot);
  const wrapper = join(directory, 'wrapper'), configPath = join(directory, 'user-policy.json'), coreConfig = join(directory, 'selected-core-config');
  await writeFile(wrapper, '#!/bin/sh\nprintf "host-policy=%s\\n" "$1"\n'); await chmod(wrapper, 0o700);
  await writeFile(configPath, JSON.stringify({
    app: { binary: '/nonexistent/app', home: '/nonexistent/app-home' }, core: { binary: '/nonexistent/hc', config: coreConfig },
    agentDirectory: directory, globalRoot, shellRc: '/nonexistent/shell', spaces: [],
    machines: [{ name: 'managed.invalid', aliases: [], runtime: { cwd: null, directory: '/runtime', commands: {} } }],
    admin: { wrappers: [{ path: wrapper, sha256: createHash('sha256').update(await readFile(wrapper)).digest('hex') }] },
  }));
  globalConfigForTest(globalRoot).set('herdr.config', configPath);
  const env = { ...process.env, SPIDER_GLOBAL_ROOT: globalRoot, HC_SESSION: 'admin-invalid', XDG_STATE_HOME: join(directory, 'xdg-state'), XDG_CONFIG_HOME: join(directory, 'xdg-config') };
  expect(await call(['admin', '--session-id', 'owner', '--wrapper', wrapper, '--reason', 'Repair', '--destination', 'managed.invalid', '--'], env))
    .toEqual({ code: 0, stdout: 'host-policy=managed.invalid\n', stderr: '' });
  const doctor = await call(['doctor'], env);
  expect(doctor.code).toBe(1); expect(doctor.stdout).toContain(`rerun doctor --config ${configPath}`);
});
test('repo herdr.config cannot redirect admin approvals or doctor config', async () => {
  const directory = await mkdtemp(join(root, 'repo-policy-')), globalRoot = join(directory, 'state');
  await mkdir(join(globalRoot, 'herdr'), { recursive: true }); await mkdir(join(root, '.spider'), { recursive: true });
  const wrapper = join(directory, 'wrapper'), configPath = join(globalRoot, 'herdr/config.json'), repoPath = join(directory, 'repo-owned.json');
  await writeFile(wrapper, '#!/bin/sh\nprintf "global-policy=%s\\n" "$1"\n'); await chmod(wrapper, 0o700);
  await writeFile(configPath, JSON.stringify({
    app: { binary: '/nonexistent/app', home: '/nonexistent/app-home' }, core: { binary: '/nonexistent/hc', config: '/nonexistent/core' },
    agentDirectory: directory, globalRoot, shellRc: '/nonexistent/shell', spaces: [],
    machines: [{ name: 'managed.invalid', aliases: [], runtime: { cwd: null, directory: '/runtime', commands: {} } }],
    admin: { wrappers: [{ path: wrapper, sha256: createHash('sha256').update(await readFile(wrapper)).digest('hex') }] },
  }));
  await writeFile(repoPath, '{}'); await writeFile(join(root, '.spider/config.json'), JSON.stringify({ 'herdr.config': repoPath }));
  const env = { ...process.env, SPIDER_GLOBAL_ROOT: globalRoot, HC_SESSION: 'admin-invalid', XDG_STATE_HOME: join(directory, 'xdg-state'), XDG_CONFIG_HOME: join(directory, 'xdg-config') };
  try {
    expect(await call(['admin', '--session-id', 'owner', '--wrapper', wrapper, '--reason', 'Repair', '--destination', 'managed.invalid', '--'], env))
      .toEqual({ code: 0, stdout: 'global-policy=managed.invalid\n', stderr: "Spider ignores the repository's herdr.config setting. Move it to the global spider settings if you want to use it.\n" });
    const doctor = await call(['doctor'], env); expect(doctor.code).toBe(1);
    expect(doctor.stdout).toContain(`rerun doctor --config ${configPath}`); expect(doctor.stderr).not.toContain(repoPath);
  } finally { await rm(join(root, '.spider/config.json')); }
});
test('admin invocation with missing configuration fails closed in the CLI boundary', async () => {
  let error = '';
  expect(await runHerdrCli(['admin', '--reason', 'Repair'], { stdout() {}, stderr(text) { error += text; }, request: async () => { throw new Error('must not request setup'); }, setupParts: async () => { throw new Error('must not set up'); }, doctorParts: async () => { throw new Error('must not inspect'); } })).toBe(2);
  expect(error).toContain('admin [--session-id');
});
