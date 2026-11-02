// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, rm, symlink, readFile, utimes, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixtureRoot, ownedPath, fencedDirectories } from '../environment.js';
import { runSetup, readInstalled } from '../setup.js';
import { openLedger, identityOf } from '../resources.js';
import { waitFor, deadline } from '../wait.js';
import type { Cores } from '../hc.js';
import { storyId } from '../scenario.js';
import type { Suite } from '../suite.js';
import { installationConfig, brokenPackedCopy, prepareInstallInputs, startPlainSetup, fingerprintInstallation, stopCreatedOwners } from '../../fixtures/install-inputs.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await createFixtureRoot(); roots.push(root);
  const g = join(root, 'g'), a = join(root, 'a'), agent = join(root, 'agent');
  for (const dir of [g, a, agent]) await mkdir(dir, { recursive: true });
  const calls: unknown[] = [], own = (path: string) => ownedPath(root, path);
  const unexpected = (): never => { throw new Error('unexpected setup mock call'); };
  const directories = fencedDirectories(root), env = { TMPDIR: directories.TMPDIR };
  const packedRoot = own(join(root, 'packed')), id = storyId('S05');
  const suite: Suite = {
    root, directories, env, story: id, options: { tier: 'ci', story: id },
    ledger: openLedger(join(root, 'ledgers'), root), cores: null,
    packed: { root: packedRoot, cli: own(join(packedRoot, 'dist/herdr/cli.mjs')), extension: own(join(packedRoot, 'dist/extension.js')), viewer: own(join(packedRoot, 'dist/herdr/viewer.mjs')), remoteRuntime: own(join(packedRoot, 'dist/herdr/remote-runtime.mjs')),
      digests: { 'dist/extension.js': '0'.repeat(64), 'dist/herdr/cli.mjs': '0'.repeat(64), 'dist/herdr/viewer.mjs': '0'.repeat(64), 'dist/herdr/remote-runtime.mjs': '0'.repeat(64), 'dist/herdr/viewer-pi.mjs': '0'.repeat(64) } },
    pi: { root, bin: own(join(root, 'bin')), launcher: own(join(root, 'bin/pi')), observerDir: own(join(root, 'observer')), scriptPath: own(join(root, 'script.json')), gateSocket: own(join(root, 'gate.sock')), providerPath: join(root, 'provider.mjs'), observerPath: join(root, 'observer.mjs'), env, story: id },
    evidenceDirectory: join(root, 'evidence'), cleanupProofPath: join(root, 'cleanup.json'),
    evidence: unexpected, keepEvidence: unexpected, hc: unexpected, launchPi: unexpected, project: unexpected, gates: unexpected, app: unexpected, close: unexpected,
    ownPath: own,
    invoke: async (binary, argv, invokeEnv) => {
      calls.push({ binary, argv, env: invokeEnv }); return { exitCode: 19, stdout: 'actual-out', stderr: 'actual-error' };
    },
  };
  const cores: Cores = {
    local: { side: 'local', namespace: 'setup-mock-local', socket: own(join(root, 'local.sock')), env, coreId: 'setup-mock-local', pid: 2147483647 },
    dest: { side: 'dest', namespace: 'setup-mock-dest', socket: own(join(root, 'dest.sock')), env, coreId: 'setup-mock-dest', pid: 2147483647 },
    machine: 'dest.invalid', wrapper: own(join(root, 'bin/hc')), recordLog: own(join(root, 'hc.jsonl')), viaLog: own(join(root, 'via.jsonl')), hc: unexpected, records: unexpected,
  };
  const config = installationConfig({ ...suite, cores }, join(root, 'bin/app'));
  return { root, suite, cores, config, calls };
}
describe('setup helper boundary', () => {
  it('does not signal a PID from a presence artifact without its actual fixture-domain registration', async () => {
    const { suite, root, config } = await fixture();
    const identity = identityOf(process.pid), signals: unknown[] = [], originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 'SIGTERM') { signals.push({ pid, signal }); return true; }
      return originalKill(pid, signal);
    });
    const directory = join(config.globalRoot, 'herdr/processes'); await mkdir(directory, { recursive: true });
    // Explicitly malformed external input: this real test PID is not a pi in the fixture domain.
    await writeFile(join(directory, 'unregistered.json'), JSON.stringify({ pid: identity.pid, startIdentity: `posix:${identity.start}`, sessionId: 'malformed-presence' }));
    const prepared = suite;
    const error = await stopCreatedOwners(prepared, ['malformed-presence']).catch(error => error);
    expect(signals).toEqual([]); expect(error).toMatchObject({ code: 'owner-identity-unproved' });
  });
  it('blocks Tier 2 installation unless the caller supplies explicit owned remote machine inputs', async () => {
    const { suite, cores } = await fixture();
    const prepared: Suite = { ...suite, cores, options: { tier: 'remote', story: suite.story, machine: 'dest.invalid' } };
    await expect(prepareInstallInputs(prepared)).rejects.toMatchObject({ code: 'P3-remote-install-inputs' });
  });
  it('blocks missing installed native base assets before the app boundary starts', async () => {
    const { suite, cores, root, config } = await fixture();
    const prepared: Suite = { ...suite, cores, directories: { ...suite.directories, HERDR_APP_HOME: config.app.home }, options: { tier: 'headless', story: suite.story }, app: () => { throw new Error('app-boundary-started-before-prerequisites'); } };
    await expect(prepareInstallInputs(prepared, { baseAppHome: join(root, 'absent-base') })).rejects.toMatchObject({ code: 'missing-prerequisite' });
    expect(await readdir(config.app.home)).toEqual([]);
  });
  it('retains the actual plain-shell stdout and stderr in their separate named files', async () => {
    const { suite, config, root } = await fixture();
    const cli = join(root, 'cli.mjs'); await writeFile(cli, "process.stdout.write('actual-out'); process.stderr.write('actual-err'); process.exitCode=9;\n");
    const prepared: Suite = { ...suite, packed: { ...suite.packed, cli: suite.ownPath(cli) } };
    const running = await startPlainSetup(prepared, config);
    expect((await running.process.exited).code).toBe(9);
    await waitFor('plain setup streams have been captured', async () => [await readFile(running.stdout, 'utf8'), await readFile(running.stderr, 'utf8')], streams => streams[0] === 'actual-out' && streams[1] === 'actual-err', deadline(3000));
  });
  it('compares files without treating an empty lock directory as an installed-file change', async () => {
    const { suite, config } = await fixture();
    const before = await fingerprintInstallation(suite, config);
    await mkdir(join(config.globalRoot, 'herdr/setup'), { recursive: true });
    expect(await fingerprintInstallation(suite, config)).toEqual(before);
    const path = config.shellRc; await writeFile(path, 'first');
    const written = await fingerprintInstallation(suite, config);
    await writeFile(path, 'other'); expect(await fingerprintInstallation(suite, config)).not.toEqual(written);
    const sameBytes = await fingerprintInstallation(suite, config);
    await utimes(path, 1000, 1000); expect(await fingerprintInstallation(suite, config)).not.toEqual(sameBytes);
  });
  it('creates empty cutover inputs and destination paths without installing a runtime', async () => {
    const { suite, cores, root } = await fixture();
    const config = installationConfig({ ...suite, cores }, join(root, 'bin/app'));
    expect(config.spaces).toEqual([]);
    expect(config.machines).toMatchObject([{ name: 'dest.invalid', runtime: { directory: join(root, 'r'), commands: { shell: ['/bin/sh'] } } }]);
    const invalid: Suite = { ...suite, cores: { ...cores } };
    // Deliberately corrupt a runtime scalar to exercise validation, not the mock's structural type.
    Reflect.set(invalid.cores!, 'machine', 'invalid\u0000machine');
    expect(() => installationConfig(invalid, join(root, 'bin/app'))).toThrow(/nonempty string/);
  });
  it('the broken helper copy cannot read the shipped helper', async () => {
    const { suite, root } = await fixture();
    const packed = join(root, 'packed'); await mkdir(join(packed, 'packages/herdr/assets/shared'), { recursive: true });
    await writeFile(join(packed, 'packages/herdr/assets/shared/feed.js'), 'export const fixture = true;');
    await writeFile(join(packed, 'package.json'), '{}');
    const bad = await brokenPackedCopy({ ...suite, packed: { ...suite.packed, root: suite.ownPath(packed) } }, 'helper');
    await expect(import('node:fs/promises').then(fs => fs.readFile(join(bad.root, 'packages/herdr/assets/shared/feed.js')))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('returns real CLI streams and writes the explicit fenced config', async () => {
    const { suite, config, calls } = await fixture();
    expect(await runSetup(suite, config)).toMatchObject({ exitCode: 19, stdout: 'actual-out', stderr: 'actual-error' });
    expect(calls).toEqual([{ binary: process.execPath, argv: [suite.packed.cli, 'setup', '--config', join(config.globalRoot, 'herdr/config.json')], env: suite.env }]);
  });
  it('rejects a foreign writable path before launching the CLI', async () => {
    const { suite, config, calls } = await fixture();
    await expect(runSetup(suite, { ...config, shellRc: process.cwd() })).rejects.toThrow(/outside|unowned/);
    expect(calls).toEqual([]);
  });
  it('reports only paths present in the installed journal and layout', async () => {
    const { suite, config, root } = await fixture();
    await runSetup(suite, config);
    const dir = join(config.globalRoot, 'herdr/setup'); await mkdir(dir, { recursive: true });
    const mod = join(config.app.home, 'mods/spider/main.js'); await mkdir(join(config.app.home, 'mods/spider'), { recursive: true }); await writeFile(mod, 'installed');
    const layout = join(config.app.home, 'layouts/spider-glass.json'); await mkdir(join(config.app.home, 'layouts'), { recursive: true }); await writeFile(layout, JSON.stringify({ props: { cliPath: suite.packed.cli } }));
    const runtime = join(root, 'runtime.mjs'); await writeFile(runtime, 'runtime');
    await writeFile(join(dir, 'journal.json'), JSON.stringify({ version: 1, entries: [{ path: mod }, { path: layout }], runtimes: [{ machine: 'dest.invalid', path: runtime }] }));
    const installed = await readInstalled(suite);
    expect(installed.files.map(f => f.path)).toEqual([mod, layout]);
    expect(installed.mods).toEqual({ spider: join(config.app.home, 'mods/spider') });
    expect(installed.runtimes).toEqual([{ machine: 'dest.invalid', path: runtime }]);
    expect(installed.layout.path).toBe(layout);
  });
  it('rejects a journal that points outside the fixture', async () => {
    const { suite, config } = await fixture(); await runSetup(suite, config);
    const dir = join(config.globalRoot, 'herdr/setup'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'journal.json'), JSON.stringify({ version: 1, entries: [{ path: process.cwd() }], runtimes: [] }));
    await expect(readInstalled(suite)).rejects.toThrow(/outside|unowned/);
  });
  it('rejects symlink config paths before invocation', async () => {
    const { suite, config, calls, root } = await fixture();
    const real = join(root, 'config.json'); await writeFile(real, JSON.stringify(config));
    const link = join(root, 'link.json'); await symlink(real, link);
    await expect(runSetup(suite, link)).rejects.toThrow(/symlink/); expect(calls).toEqual([]);
  });
});
