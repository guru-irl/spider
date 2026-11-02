// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { setupHerdr, type SetupParts, type SetupRequest } from '../setup/installer.js';
import { parseHerdrConfig } from '../config.js';
import { installRuntimeDirectory, sha256 } from '../remote/runtime.js';
import { collectRemoteChunks, createFileLogSink } from '../remote/transfer.js';
import type { MachineName } from '../contracts.js';

const harnesses: HerdrHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
    console.info('isolated hc cleanup', JSON.stringify(h.cleanupProof));
  }
});

async function fixture(mode: 'fake' | 'hc') {
  const h = await createHerdrHarness(mode); harnesses.push(h); await h.start();
  const on = 'remote.invalid' as MachineName;
  const root = join(h.directories.remote, 'programs');
  const coreConfig = join(h.directories.local, 'core.toml'); await writeFile(coreConfig, 'notes = false\n');
  const config = parseHerdrConfig({ app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: coreConfig }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: on, nodePath: h.nodeBinary, runtime: { directory: root, cwd: h.root, commands: { javascript: [h.nodeBinary], shell: ['/bin/sh'] } } }] });
  const packageRoot = join(h.root, 'package'); await mkdir(join(packageRoot, 'dist/herdr'), { recursive: true });
  await writeFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs'), await readFile(resolve('dist/herdr/remote-runtime.mjs')));
  const request: SetupRequest = { config, configPath: join(h.root, 'config.json'), packageRoot, journalRoot: join(h.root, 'journal') };
  const production = createProductionHerdrCliPorts(request.packageRoot, h.localEnv);
  try {
    const base = await production.setupParts(request);
    const parts: SetupParts = { ...base, hc: h.hc,
      preflight: async () => ({ fingerprint: 'runtime-only', coreIdentity: h.owner!.terminal, mods: [], targets: [], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
      bootstrapRuntime: async () => { await installRuntimeDirectory(root); },
      cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }), warn() {} };
    await setupHerdr(request, parts);
    const [runtime] = await base.ensureRuntime(request, {} as never);
    return { h, on, root, runtime };
  } finally { await production.dispose(); }
}

async function failRoot(mode: 'fake' | 'hc', kind: 'normal' | 'alias' | 'different-uid' = 'normal') {
  const previousUmask = process.umask(0o022);
  let installed: Awaited<ReturnType<typeof fixture>>;
  try { installed = await fixture(mode); } finally { process.umask(previousUmask); }
  const { h, on, root, runtime } = installed;
  expect(h.localSocket).toContain(h.root); expect(h.remoteSocket).toContain(h.root);
  expect(h.localCoreId).not.toBe(h.remoteCoreId);
  const directory = join(root, 'job');
  if (kind === 'alias') { await mkdir(join(h.root, 'redirect')); await symlink(join(h.root, 'redirect'), directory); }
  const nonce = '0123456789abcdef0123456789abcdef', programNonce = 'f'.repeat(32);
  const requestPath = join(directory, 'request.json');
  const request = Buffer.from(JSON.stringify({ version: 1, jobId: 'job', nonce, programNonce, argv: [h.nodeBinary, '-e', 'process.exit(42)'], cwd: null, env: {}, files: [], releaseWindowMs: 10000 }));
  await h.hc.fileWrite(on, requestPath, request);
  await h.hc.fileWrite(on, requestPath + '.sha256', Buffer.from(sha256(request)));
  if (kind !== 'alias') {
    const folderMode = (await stat(directory)).mode & 0o777;
    console.info(`${mode === 'hc' ? 'real' : 'fake'} hc job folder with umask 0022: ${folderMode.toString(8)}`);
    expect(folderMode).toBe(0o755);
  }
  await chmod(root, 0o755);
  let argv = [h.nodeBinary, runtime.path, requestPath];
  if (kind === 'different-uid') {
    const wrapper = join(h.root, 'different-uid.mjs');
    await writeFile(wrapper, `process.getuid=()=>${process.getuid!() + 1}; const {runRemoteRuntime}=await import(${JSON.stringify(runtime.path)}); try { process.exitCode=await runRemoteRuntime(${JSON.stringify(requestPath)}); } catch { process.exitCode=127; }`);
    argv = [h.nodeBinary, wrapper];
  }
  const terminal = await h.hc.run({ argv, cwd: null, on, labels: {}, noNotify: true, background: true, outliveParent: true });
  await expect.poll(async () => (await h.hc.get(terminal.address)).state, { timeout: 10000 }).toBe('finished');
  expect((await h.hc.get(terminal.address)).exitCode).toBe(127);
  if (kind !== 'normal') {
    const actualDirectory = kind === 'alias' ? join(h.root, 'redirect') : directory;
    await expect(readFile(join(actualDirectory, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    return;
  }
  const sink = await createFileLogSink(join(h.directories.local, 'logs'));
  const logs = await collectRemoteChunks(h.hc, { on, directory, jobId: 'job', nonce, requestSha256: sha256(request) }, sink);
  expect(logs).toMatchObject({ complete: true, receipt: { outcome: 'spawn-error', error: expect.stringMatching(/0700.*rerun.*setup/i) } });
}

it('publishes early failures only in real, owned hc folders', async () => { await failRoot('fake'); await failRoot('fake', 'alias'); await failRoot('fake', 'different-uid'); }, 45000);
it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !existsSync(process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc')))('real isolated hc creates a 0755 job folder and publishes the early failure (requires hc and SPIDER_HERDR_E2E=1)', () => failRoot('hc'), 45000);
