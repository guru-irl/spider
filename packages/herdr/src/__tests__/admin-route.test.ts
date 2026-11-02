// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { beforeAll, afterAll, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rolldown } from 'rolldown';
import { installSshShim, createExecutionEnvironmentPolicy, ordinaryExecutionEnvironment } from '../ssh/shim.js';

let root: string, entry: string, shim: string;
beforeAll(async () => {
  root = await mkdtemp(resolve('.spider/scratch/admin-route-'));
  entry = join(root, 'entry.mjs'); shim = join(root, 'shim.mjs');
  const source = join(root, 'entry.ts');
  await writeFile(source, `import { runAdminCli } from ${JSON.stringify(resolve('packages/herdr/src/ssh/admin-cli.ts'))};\nimport { parseHerdrConfig } from ${JSON.stringify(resolve('packages/herdr/src/config.ts'))};\nimport { standardHerdrConfigPath } from ${JSON.stringify(resolve('packages/herdr/src/setup/installer.ts'))};\nimport { readFile } from 'node:fs/promises';\ntry { process.exitCode = await runAdminCli(process.argv.slice(2), process.env, async () => parseHerdrConfig(JSON.parse(await readFile(standardHerdrConfigPath(process.env.SPIDER_GLOBAL_ROOT!), 'utf8')))); if (process.env.PROBE_ADMIN_PARENT === '1') console.error('parent-bypass=' + (process.env.SPIDER_HERDR_SSH_BYPASS ?? 'absent')); } catch(e) { console.error(e.code + ': ' + e.message); process.exitCode = 1; }\n`);
  const build = await rolldown({ input: source, platform: 'node', external: [/^node:/] });
  try { await build.write({ file: entry, format: 'es' }); } finally { await build.close(); }
  const shimSource = join(root, 'shim.ts');
  await writeFile(shimSource, `import { runSshShim } from ${JSON.stringify(resolve('packages/herdr/src/ssh/shim.ts'))}; process.exitCode = await runSshShim(process.argv.slice(3));`);
  const shimBuild = await rolldown({ input: shimSource, platform: 'node', external: [/^node:/] });
  try { await shimBuild.write({ file: shim, format: 'es' }); } finally { await shimBuild.close(); }
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function execute(binary: string, argv: string[], env: NodeJS.ProcessEnv, stdin = '') {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, argv, { env, stdio: 'pipe' }); let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(stdin);
  });
}
async function fixture(body: (f: { directory: string; wrapper: string; configPath: string; auditPath: string; env: NodeJS.ProcessEnv; argv: string[] }) => Promise<void>) {
  const directory = await mkdtemp(join(root, 'case-')); const wrapper = join(directory, 'wrapper');
  const auditPath = join(directory, 'state/herdr/admin/audit.jsonl'); const configPath = join(directory, 'state/herdr/config.json');
  await mkdir(join(directory, 'state/herdr'), { recursive: true });
  await writeFile(wrapper, `#!/bin/sh\n# The approved wrapper accepts destination first and then SSH arguments.\n[ -s "$AUDIT_FILE" ] || exit 91\nprintf 'wrapper-stderr\\n' >&2\nexec ssh "$@"\n`); await chmod(wrapper, 0o700);
  const realSshBinary = join(directory, 'real-ssh');
  await writeFile(realSshBinary, '#!/bin/sh\nprintf "destination=%s\\n" "$1"\nshift\nprintf "arg=%s\\n" "$@"\ncat\nexit 23\n'); await chmod(realSshBinary, 0o700);
  const config = {
    app: { binary: '/nonexistent/app', home: '/nonexistent/app-home' }, core: { binary: '/nonexistent/hc', config: '/nonexistent/core' },
    agentDirectory: directory, globalRoot: join(directory, 'state'), shellRc: '/nonexistent/shell', spaces: [],
    machines: [{ name: 'managed.invalid', aliases: ['managed-alias.invalid'], runtime: { cwd: null, directory: '/runtime', commands: { shell: ['/bin/sh'] } } }],
    admin: { wrappers: [{ path: wrapper, sha256: createHash('sha256').update(await readFile(wrapper)).digest('hex') }] },
  };
  await writeFile(configPath, JSON.stringify(config));
  // A live socket with no hc binary or cache snapshot: ordinary SSH refuses, while approved repair still works.
  const options = { shimDirectory: join(directory, 'bin'), realSshBinary, shimProgram: shim, cacheDescriptor: { path: join(directory, 'state/herdr/ssh/absent-cache'), identity: { coreId: 'core' as never, socket: join(directory, 's'), sessionNamespace: 'isolated' } } };
  await installSshShim(options);
  const env = { ...createExecutionEnvironmentPolicy(options)(process.env), AUDIT_FILE: auditPath, SPIDER_GLOBAL_ROOT: join(directory, 'state') };
  const argv = ['--session-id', 'owner-session', '--wrapper', wrapper, '--reason', 'Repair hc', '--destination', 'managed.invalid', '--', 'uname', 'two words', ';not shell'];
  const core = createServer(connection => connection.end());
  try {
    await new Promise<void>((resolve, reject) => { core.once('error', reject); core.listen(options.cacheDescriptor.identity.socket, resolve); });
    await body({ directory, wrapper, configPath, auditPath, env, argv });
  } finally {
    if (core.listening) await new Promise<void>((resolve, reject) => core.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
test('approved wrapper reaches shim SSH without hc, preserving stdin, stdout, stderr and exit code', async () => fixture(async f => {
  const ordinary = await execute(join(f.directory, 'bin/ssh'), ['managed.invalid'], f.env);
  expect(ordinary.code).toBe(126);
  const result = await execute(process.execPath, [entry, ...f.argv], f.env, 'stdin bytes\n');
  expect(result).toEqual({ code: 23, stdout: 'destination=managed.invalid\narg=uname\narg=two words\narg=;not shell\nstdin bytes\n', stderr: 'wrapper-stderr\n' });
}));
test('forged SSH bypasses never reach the real transport', async () => fixture(async f => {
  for (const token of ['1', 'a'.repeat(64), '../audit.jsonl']) {
    const result = await execute(join(f.directory, 'bin/ssh'), ['managed.invalid'], { ...f.env, SPIDER_HERDR_SSH_BYPASS: token });
    expect(result.code).toBe(126); expect(result.stdout).toBe('');
  }
}));
test('admin launches with a private live token and revokes it before returning', async () => fixture(async f => {
  const captured = join(f.directory, 'captured-token');
  await writeFile(f.wrapper, '#!/bin/sh\n[ -s "$AUDIT_FILE" ] || exit 91\n[ -f "$BYPASS_DIRECTORY/$SPIDER_HERDR_SSH_BYPASS" ] || exit 92\nprintf "%s" "$SPIDER_HERDR_SSH_BYPASS" > "$CAPTURE_TOKEN"\nexec ssh "$@"\n');
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  config.admin.wrappers[0].sha256 = createHash('sha256').update(await readFile(f.wrapper)).digest('hex');
  await writeFile(f.configPath, JSON.stringify(config));
  const bypassDirectory = join(f.directory, 'state/herdr/admin/bypass');
  const result = await execute(process.execPath, [entry, ...f.argv], { ...f.env, CAPTURE_TOKEN: captured, BYPASS_DIRECTORY: bypassDirectory });
  expect(result.code).toBe(23);
  const token = await readFile(captured, 'utf8'); expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(await readdir(bypassDirectory)).toEqual([]);
  expect((await execute(join(f.directory, 'bin/ssh'), ['managed.invalid'], { ...f.env, SPIDER_HERDR_SSH_BYPASS: token })).code).toBe(126);
}));
test('audit is durably readable before the wrapper starts', async () => fixture(async f => {
  expect((await execute(process.execPath, [entry, ...f.argv], f.env)).code).toBe(23);
  const rows = (await readFile(f.auditPath, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  expect(rows).toMatchObject([{ owner: 'owner-session', reason: 'Repair hc', destination: 'managed.invalid', wrapper: { path: f.wrapper } }]);
  expect(rows).toHaveLength(1);
  expect(typeof rows[0].at).toBe('string');
  expect(rows[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(Number.isNaN(Date.parse(rows[0].at))).toBe(false);
  expect(rows[0].argv).toEqual(['managed.invalid', 'uname', 'two words', ';not shell']);
  expect(rows[0].pid).toBeGreaterThan(0);
}));
test.each(['unapproved', 'changed', 'missing-reason', 'unmanaged', 'control-reason', 'c1-reason', 'long-reason', 'relative-wrapper', 'duplicate-flag', 'no-separator', 'missing-session'])('%s is refused without launching or auditing', async kind => fixture(async f => {
  const argv = [...f.argv]; const replace = (flag: string, value: string) => { argv[argv.indexOf(flag) + 1] = value; };
  if (kind === 'unapproved') { const other = join(f.directory, 'other.invalid'); await writeFile(other, await readFile(f.wrapper)); await chmod(other, 0o700); replace('--wrapper', other); }
  if (kind === 'changed') await writeFile(f.wrapper, '#!/bin/sh\necho unexpected-launch\n');
  if (kind === 'missing-reason') argv.splice(argv.indexOf('--reason'), 2);
  if (kind === 'unmanaged') replace('--destination', 'elsewhere.invalid');
  if (kind === 'control-reason') replace('--reason', 'repair\nnow');
  if (kind === 'c1-reason') replace('--reason', 'repair\u0085now');
  if (kind === 'long-reason') replace('--reason', 'x'.repeat(2049));
  if (kind === 'relative-wrapper') replace('--wrapper', 'wrapper');
  if (kind === 'duplicate-flag') argv.unshift('--reason', 'other.invalid');
  if (kind === 'no-separator') argv.splice(argv.indexOf('--'), 1);
  if (kind === 'missing-session') argv.splice(argv.indexOf('--session-id'), 2);
  const result = await execute(process.execPath, [entry, ...argv], f.env);
  expect(result.code).not.toBe(0); expect(result.code).not.toBe(23); expect(result.stdout).toBe('');
  await expect(readFile(f.auditPath)).rejects.toMatchObject({ code: 'ENOENT' });
}));
test('audit failure refuses before launch', async () => fixture(async f => {
  await mkdir(join(f.directory, 'state/herdr/admin'), { recursive: true }); await mkdir(f.auditPath);
  const result = await execute(process.execPath, [entry, ...f.argv], f.env);
  expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('wrapper-stderr');
}));
test('subagent children can use the same route with their supplied session identity', async () => fixture(async f => {
  const argv = [...f.argv]; argv.splice(argv.indexOf('--session-id'), 2);
  expect((await execute(process.execPath, [entry, ...argv], { ...f.env, PI_SUBAGENT_CHILD: '1', PI_SPIDER_SESSION_ID: 'child-owner', PI_SUBAGENT_RUN_ID: 'child-run' })).code).toBe(23);
  expect(JSON.parse(await readFile(f.auditPath, 'utf8')).owner).toBe('child-owner');
}));
test('admin never changes its parent environment and ordinary sibling SSH still refuses', async () => fixture(async f => {
  const before = { ...process.env };
  const admin = execute(process.execPath, [entry, ...f.argv], { ...f.env, PROBE_ADMIN_PARENT: '1' });
  const sibling = execute(join(f.directory, 'bin/ssh'), ['managed.invalid'], ordinaryExecutionEnvironment(f.env));
  const adminResult = await admin;
  expect(adminResult.code).toBe(23); expect(adminResult.stderr).toBe('wrapper-stderr\nparent-bypass=absent\n');
  expect((await sibling).code).toBe(126);
  expect(process.env).toEqual(before);
  const probe = await execute(process.execPath, ['-e', 'console.log(process.env.SPIDER_HERDR_SSH_BYPASS ?? "absent")'], f.env);
  expect(probe.stdout).toBe('absent\n');
}));
