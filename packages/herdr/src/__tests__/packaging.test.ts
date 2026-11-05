// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { execFileSync, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, cpSync, writeFileSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHerdrHarness } from './testutil.js';
import { releaseRemoteJob } from '../jobs/observer.js';
import type { JobRecord, JobId } from '../contracts.js';

const root = resolve('.');
const scratch = join(root, '.spider/scratch/packaging');
const env = { ...process.env, TMPDIR: join(root, '.spider/scratch/tmp'), COPYFILE_DISABLE: '1' };
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
let packedRoot: string;
let files: string[];
let tarball: string;
const run = (args: string[], cwd = root) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180_000, stdio: 'pipe' });
const npm = (args: string[]) => execFileSync('npm', args, { cwd: root, env, encoding: 'utf8', timeout: 180_000 });

// A missing build entry or package allowlist entry must fail through npm's real artifact.
const h = {
  async buildAndInspectPackage() {
    npm(['run', 'build']);
    const manifest = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--foreground-scripts=false', '--pack-destination', packedRoot]))[0];
    tarball = join(packedRoot, manifest.filename);
    execFileSync('tar', ['-xzf', tarball, '-C', packedRoot]);
    files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n').map(path => path.replace(/^package\//, ''));
    const remote = files.includes('dist/herdr/remote-runtime.mjs') ? readFileSync(join(packedRoot, 'package/dist/herdr/remote-runtime.mjs'), 'utf8') : '';
    const imports = [...remote.matchAll(/\b(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)].map(match => match[1]);
    return {
      files,
      frozenBuiltinMods: files.filter(path => /^packages\/herdr\/assets\/mods\/(?!spider\/)/.test(path)),
      remoteNonBuiltinImports: imports.filter(name => !builtins.has(name)),
    };
  },
};

beforeAll(() => {
  mkdirSync(scratch, { recursive: true });
  mkdirSync(env.TMPDIR!, { recursive: true });
  packedRoot = mkdtempSync(join(scratch, 'pack-'));
});
afterAll(() => { rmSync(packedRoot, { recursive: true, force: true }); });

function packageWithIdentity(sha: string): { directory: string; artifact: string } {
  const directory = mkdtempSync(join(scratch, 'identity-'));
  cpSync(join(packedRoot, 'package'), join(directory, 'package'), { recursive: true });
  const extension = join(directory, 'package/dist/extension.js');
  writeFileSync(extension, readFileSync(extension, 'utf8').replace(/SPIDER_BUILD_ID=(?:unknown|[0-9a-f]{7,40})(?:-dirty)?@/, `SPIDER_BUILD_ID=${sha}@`));
  const artifact = join(directory, 'artifact.tgz');
  execFileSync('tar', ['-czf', artifact, '-C', directory, 'package'], { env });
  return { directory, artifact };
}

function publishCommands(): string {
  const workflow = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8');
  const publish = workflow.split('      - name: Publish\n')[1];
  const run = publish.match(/        run: (.*)\n/)!;
  return run[1] === '|' ? publish.split('        run: |\n')[1].split('        env:')[0].split('\n').map(line => line.slice(10)).join('\n') : run[1];
}

describe.sequential('published Herdr artifact', () => {
  it('declares the Herdr workspace for every consuming package in manifests and lock metadata', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    for (const consumer of ['host', 'context', 'subagents']) {
      const manifest = JSON.parse(readFileSync(join(root, `packages/${consumer}/package.json`), 'utf8'));
      expect(manifest.dependencies['@spider/herdr'], consumer).toBe('0.0.0');
      expect(lock.packages[`packages/${consumer}`].dependencies['@spider/herdr'], consumer).toBe('0.0.0');
    }
    const herdr = JSON.parse(readFileSync(join(root, 'packages/herdr/package.json'), 'utf8'));
    expect(herdr.license).toBe('MIT AND OFL-1.1 AND Apache-2.0');
    expect(lock.packages['packages/herdr']).toMatchObject({ name: '@spider/herdr', version: '0.0.0', license: 'MIT AND OFL-1.1 AND Apache-2.0' });
    expect(lock.packages['node_modules/@spider/herdr']).toEqual({ resolved: 'packages/herdr', link: true });
  });
  it('the packed package contains the runtimes, optional pi view and assets without frozen mods', async () => {
    const packed = await h.buildAndInspectPackage();
    expect(packed.files).toEqual(expect.arrayContaining([
      'dist/herdr/cli.mjs', 'dist/herdr/viewer.mjs', 'dist/herdr/feed-reader.mjs', 'dist/herdr/remote-runtime.mjs', 'dist/herdr/viewer-pi.mjs', 'dist/herdr/subagent-supervisor.mjs',
      'packages/herdr/assets/themes/dracula-plus-glass.json',
      'packages/herdr/assets/themes/spider-glass.json',
      'packages/herdr/assets/shared/feed.js',
      'packages/herdr/assets/tabs/spider.svg',
      'packages/herdr/assets/mods/spider/main.js',
      'packages/herdr/assets/agents/children.js', 'packages/herdr/assets/agents/move.js', 'packages/herdr/assets/agents/move-menu.js', 'packages/herdr/assets/agents/bot.svg', 'packages/herdr/assets/agents/list.svg', 'packages/herdr/assets/agents/bell.svg', 'packages/herdr/assets/agents/chevron-up.svg',
      'packages/herdr/assets/look/patches.json', 'packages/herdr/assets/look/layout-edits.json',
      'packages/herdr/assets/fonts/GoogleSansFlex.ttf', 'packages/herdr/assets/fonts/GlassLabel-Bold.ttf',
      'packages/herdr/assets/fonts/GoogleSansFlex-OFL.txt', 'packages/herdr/assets/fonts/GoogleSansFlex-TRADEMARKS.md',
      'packages/herdr/assets/keys.json', 'packages/herdr/assets/templates/role.md',
      'packages/herdr/assets/templates/role-instructions.md', 'packages/herdr/assets/shell/resume.sh',
      'packages/herdr/LICENSE', 'NOTICE.md', 'LICENSE',
    ]));
    expect(packed.files).toContain('packages/herdr/assets/agents/corner-up-left.svg');
    expect(packed.files).toContain('packages/herdr/assets/shared/look.js');
    for (const shape of ['triangle', 'diamond', 'pentagon', 'hexagon', 'heptagon', 'octagon', 'star']) expect(packed.files).toContain(`packages/herdr/assets/agents/space-${shape}.svg`);
    expect(packed.files).not.toContain('packages/herdr/assets/agents/space-square.svg');
    expect(packed.files).not.toContain('dist/herdr/metrics-runtime.mjs');
    expect(packed.frozenBuiltinMods).toEqual([]);
    expect(packed.remoteNonBuiltinImports).toEqual([]);
    expect(packed.files.filter(path => /(?:__tests__|recordings|\.d\.ts$|config\.example\.json$|\.map$)/.test(path))).toEqual([]);
  }, 180_000);

  it('the packed feed reader serves and closes from only an explicit fixture root', async () => {
    const feedRoot = join(packedRoot, 'reader-root');
    const connection = JSON.parse(run([join(packedRoot, 'package/dist/herdr/feed-reader.mjs'), '--root', feedRoot], packedRoot));
    const request = (route: string) => fetch(`http://127.0.0.1:${connection.port}${route}`, { method: 'POST', headers: { authorization: `Bearer ${connection.token}` }, body: JSON.stringify(route === '/snapshot' ? { known: {} } : {}) });
    try {
      const snapshot = await request('/snapshot'); expect(snapshot.ok).toBe(true);
      expect(await snapshot.json()).toEqual({ version: 1, entries: [], changes: [], errors: [] });
    } finally { expect((await request('/close')).ok).toBe(true); }
  });

  it('CLI usage never accidentally runs the remote runtime entry', () => {
    const result = spawnSync(process.execPath, [join(packedRoot, 'package/dist/herdr/cli.mjs'), '--invalid-command'], { cwd: packedRoot, env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^cli-usage:/);
    expect(result.stderr).not.toContain('ENOENT');
  });

  it.each(['cli', 'viewer'])('the shipped %s offers help with stdin closed and never runs remote main', entry => {
    const home = join(packedRoot, 'help-home');
    const help = spawnSync(process.execPath, [join(packedRoot, `package/dist/herdr/${entry}.mjs`), '--help'], {
      cwd: packedRoot, env: { ...env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), HERDR_APP_HOME: join(home, 'app') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    });
    expect(help.error).toBeUndefined();
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/usage:/i);
    expect(help.stderr).toBe('');
  });

  it('remote-runtime is the only bundle containing the remote main guard', () => {
    const bundles = ['dist/extension.js', 'dist/herdr/cli.mjs', 'dist/herdr/viewer.mjs', 'dist/herdr/feed-reader.mjs', 'dist/herdr/remote-runtime.mjs', 'dist/herdr/viewer-pi.mjs', 'dist/herdr/subagent-supervisor.mjs'];
    // This diagnostic belongs exclusively to C's main block, never its library API.
    const mains = bundles.filter(file => readFileSync(join(packedRoot, 'package', file), 'utf8').includes('A runtime request file is required'));
    expect(mains).toEqual(['dist/herdr/remote-runtime.mjs']);
    expect(bundles.map(file => readFileSync(join(packedRoot, 'package', file), 'utf8').match(/SPIDER_HERDR_RUNTIME_ENTRY=(true|false)/)?.[1])).toEqual(['false', 'false', 'false', 'false', 'true', 'false', 'false']);
    for (const file of bundles) expect(readFileSync(join(packedRoot, 'package', file), 'utf8')).not.toContain('import.meta.spiderHerdrRuntimeEntry');
  });

  it('ships the Apache licence and prominent modified Herdr patch notice', () => {
    expect(files).toEqual(expect.arrayContaining(['licenses/herdr-apache-2.0.txt', 'packages/herdr/assets/look/NOTICE']));
    const licence = readFileSync(join(packedRoot, 'package/licenses/herdr-apache-2.0.txt'));
    expect(createHash('sha256').update(licence).digest('hex')).toBe('c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4');
    expect(readFileSync(join(packedRoot, 'package/packages/herdr/assets/look/NOTICE'), 'utf8')).toContain('modified portions of Herdr');
    expect(readFileSync(join(packedRoot, 'package/NOTICE.md'), 'utf8')).toContain('Herdr 0.1.12 by the Herdr authors');
  });

  it('checks the real packed tarball', () => {
    expect(run(['scripts/assert-bundle.mjs', '--package', tarball])).toContain('tarball');
  });

  it.each(['clean commit', 'different commit', 'dirty build', 'unknown build'])('checks packed build identity: %s', kind => {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const sha = kind === 'different commit' ? '0000000' : kind === 'dirty build' ? `${commit}-dirty` : kind === 'unknown build' ? 'unknown' : commit;
    const copy = packageWithIdentity(sha);
    try {
      const result = spawnSync(process.execPath, ['scripts/assert-bundle.mjs', '--package', copy.artifact, '--commit', commit], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
      expect(result.status, result.stderr).toBe(kind === 'clean commit' ? 0 : 1);
      if (kind !== 'clean commit') expect(result.stderr).toContain('packed build identity does not match clean commit');
    } finally { rmSync(copy.directory, { recursive: true, force: true }); }
  });

  it.each(['clean commit', 'different commit', 'dirty build', 'missing runtime'])('publish verifies its exact tarball before uploading: %s', kind => {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const copy = packageWithIdentity(kind === 'different commit' ? '0000000' : kind === 'dirty build' ? `${commit}-dirty` : commit);
    try {
      if (kind === 'missing runtime') {
        rmSync(join(copy.directory, 'package/dist/herdr/viewer.mjs'));
        execFileSync('tar', ['-czf', copy.artifact, '-C', copy.directory, 'package'], { env });
      }
      const checkout = join(copy.directory, 'publish');
      mkdirSync(join(checkout, 'scripts'), { recursive: true });
      mkdirSync(join(checkout, 'bin'), { recursive: true });
      for (const file of ['assert-bundle.mjs', 'build-id.mjs', 'check-package-files.cjs']) cpSync(join(root, 'scripts', file), join(checkout, 'scripts', file));
      for (const collection of ['superpowers', 'pstack']) cpSync(join(root, `packages/${collection}/skills`), join(checkout, `packages/${collection}/skills`), { recursive: true });
      const recorder = join(checkout, 'npm-events.jsonl');
      const npmPath = join(checkout, 'bin/npm');
      writeFileSync(npmPath, `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const args = process.argv.slice(2), log = process.env.PACK_RECORD;
const event = (kind, file) => fs.appendFileSync(log, JSON.stringify({ kind, file: path.resolve(file), digest: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }) + '\\n');
if (args[0] === 'pack') {
  const destination = process.env.npm_config_pack_destination;
  fs.mkdirSync(destination, { recursive: true });
  const artifact = path.join(destination, 'fixture.tgz'); fs.copyFileSync(process.env.PACK_ARTIFACT, artifact); event('pack', artifact);
  console.log(JSON.stringify([{ filename: 'fixture.tgz', files: JSON.parse(process.env.PACK_FILES).map(path => ({ path })) }]));
} else if (args[0] === 'publish' && args[1] && fs.existsSync(args[1])) event('publish', args[1]);
else { console.error('Publish requires a checked tarball path'); process.exit(1); }\n`);
      chmodSync(npmPath, 0o755);
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', publishCommands()], { cwd: checkout, env: { ...env, PATH: `${join(checkout, 'bin')}${delimiter}${process.env.PATH}`, PACK_RECORD: recorder, PACK_ARTIFACT: copy.artifact, PACK_FILES: JSON.stringify(files) }, encoding: 'utf8', timeout: 30_000 });
      const events = existsSync(recorder) ? readFileSync(recorder, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      expect(result.status, result.stderr).toBe(kind === 'clean commit' ? 0 : 1);
      expect(events.map(event => event.kind)).toEqual(kind === 'clean commit' ? ['pack', 'publish'] : ['pack']);
      if (kind === 'clean commit') expect(events[1]).toEqual({ ...events[0], kind: 'publish' });
    } finally { rmSync(copy.directory, { recursive: true, force: true }); }
  });

  it('the standalone remote runtime runs without a workspace or dependencies', () => {
    const detached = join(packedRoot, 'remote-runtime.mjs');
    cpSync(join(packedRoot, 'package/dist/herdr/remote-runtime.mjs'), detached);
    expect(() => execFileSync(process.execPath, [detached], { cwd: packedRoot, env, encoding: 'utf8', stdio: 'pipe' })).toThrow(/runtime request/);
    // A data URL has no directory from which Node could resolve workspace or npm imports.
    const code = readFileSync(detached).toString('base64');
    const directory = join(packedRoot, 'standalone-programs');
    const probe = run(['--input-type=module', '-e', `const runtime = await import('data:text/javascript;base64,${code}'); console.log(JSON.stringify(await runtime.installRuntimeDirectory(${JSON.stringify(directory)})));`], packedRoot);
    expect(JSON.parse(probe)).toMatchObject({ directory, mode: 0o700, nodePath: process.execPath });
  });

  it.each(['file', 'directory', 'preserved main'])('the shipped remote runtime enters main through a symlinked %s', kind => {
    const executable = join(packedRoot, 'package/dist/herdr/remote-runtime.mjs');
    const link = join(packedRoot, `linked-${kind.replaceAll(' ', '-')}`);
    symlinkSync(kind === 'directory' ? join(packedRoot, 'package/dist/herdr') : executable, link);
    const result = spawnSync(process.execPath, [
      ...(kind === 'preserved main' ? ['--preserve-symlinks-main'] : []),
      kind === 'directory' ? join(link, 'remote-runtime.mjs') : link,
    ], { cwd: packedRoot, env, encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('A runtime request file is required');
  });

  it('the packed remote executable runs a payload and publishes its actual exit receipt', async () => {
    const core = await createHerdrHarness('fake');
    try {
      await core.start();
      const directory = join(core.directories.remote, 'runtime-programs', 'a'.repeat(32));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const nonce = 'b'.repeat(32), programNonce = 'c'.repeat(32), jobId = 'packaging-job';
      const marker = join(directory, '.spider-program'), payload = join(directory, 'payload.cjs');
      const code = "console.log('packed payload'); console.error('packed diagnostic'); process.exitCode = 23;";
      const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
      writeFileSync(marker, programNonce); writeFileSync(payload, code);
      const request = JSON.stringify({ version: 1, jobId, nonce, programNonce, argv: [process.execPath, payload], cwd: directory, env: {}, files: [{ path: marker, sha256: hash(programNonce) }, { path: payload, sha256: hash(code) }], releaseWindowMs: 10_000 });
      const requestPath = join(directory, 'request.json');
      writeFileSync(requestPath, request); writeFileSync(`${requestPath}.sha256`, hash(request));
      const owner = core.owner!, machine = (await core.hc.machines()).find(machine => machine.id === core.remoteCoreId)!.name;
      const launched = await core.hc.run({ argv: [process.execPath, join(packedRoot, 'package/dist/herdr/remote-runtime.mjs'), requestPath], cwd: packedRoot, on: machine,
        labels: { 'spider.kind': 'exec', 'spider.job': jobId, 'spider.session': owner.sessionId, 'spider.machine': machine, 'spider.owner-core': owner.terminal.coreId, 'spider.owner-terminal': owner.terminal.terminalId },
        background: true, outliveParent: true, noNotify: true });
      const job: JobRecord = { version: 1, id: jobId as JobId, owner, machine, kind: 'exec', phase: { kind: 'waiting-for-pane', address: launched.address },
        viewer: null, remoteDirectory: directory, localDirectory: join(directory, 'local'), detached: false, noticeMode: 'tool', notice: 'pending' };
      await releaseRemoteJob(job, { hc: core.hc, nonce, releaseDeadlineAt: Date.now() + 10_000, clock: Date.now,
        releaseFileWriter: (record, bytes) => core.hc.fileWrite(record.machine, join(record.remoteDirectory, 'release.json'), bytes) });
      await vi.waitFor(async () => expect((await core.hc.get(launched.address)).state).toBe('finished'), { timeout: 15_000 });
      expect((await core.hc.get(launched.address)).exitCode).toBe(23);
      expect(readFileSync(join(directory, 'stdout.log'), 'utf8')).toBe('packed payload\n');
      expect(readFileSync(join(directory, 'stderr.log'), 'utf8')).toBe('packed diagnostic\n');
      expect(JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ jobId, nonce, requestSha256: hash(request), outcome: 'exited', exitCode: 23 });
    } finally { await core.close(); }
  });

  it.each(['missing entry', 'missing asset', 'missing parent icon', 'Node mod API', 'Node mod global', 'external remote import', 'invalid runtime syntax', 'extra runtime', 'frozen built-in mod', 'truncated licence'])('rejects a broken artifact: %s', kind => {
    const copy = mkdtempSync(join(scratch, 'broken-'));
    try {
      cpSync(join(packedRoot, 'package'), copy, { recursive: true });
      if (kind === 'missing entry') rmSync(join(copy, 'dist/herdr/viewer.mjs'));
      if (kind === 'truncated licence') writeFileSync(join(copy, 'licenses/herdr-apache-2.0.txt'), 'Apache License\n');
      if (kind === 'missing asset') rmSync(join(copy, 'packages/herdr/assets/shared/feed.js'));
      if (kind === 'missing parent icon') rmSync(join(copy, 'packages/herdr/assets/agents/corner-up-left.svg'), { force: true });
      if (kind === 'Node mod global') writeFileSync(join(copy, 'packages/herdr/assets/mods/spider/data.js'), 'export const bad = globalThis["process"];\n');
      if (kind === 'invalid runtime syntax') writeFileSync(join(copy, 'dist/herdr/remote-runtime.mjs'), 'export {\n');
      if (kind === 'frozen built-in mod') {
        mkdirSync(join(copy, 'packages/herdr/assets/mods/agents'), { recursive: true });
        writeFileSync(join(copy, 'packages/herdr/assets/mods/agents/main.js'), 'export {};\n');
      }
      if (kind === 'Node mod API') writeFileSync(join(copy, 'packages/herdr/assets/mods/spider/data.js'), 'import fs from "node:fs";\nexport const bad = fs;\n');
      if (kind === 'external remote import') writeFileSync(join(copy, 'dist/herdr/remote-runtime.mjs'), 'import "@spider/context";\n');
      if (kind === 'extra runtime') writeFileSync(join(copy, 'dist/herdr/metrics-runtime.mjs'), 'export {};\n');
      expect(() => run(['scripts/assert-bundle.mjs', '--root', copy])).toThrow(new RegExp(kind.startsWith('Node mod') ? 'Node API' : kind === 'external remote import' ? 'non-builtin' : kind === 'missing asset' ? 'feed.js' : kind === 'missing parent icon' ? 'corner-up-left.svg' : 'Herdr'));
    } finally { rmSync(copy, { recursive: true, force: true }); }
  });
});
