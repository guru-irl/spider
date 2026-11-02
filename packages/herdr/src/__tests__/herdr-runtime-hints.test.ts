// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, type SetupRequest } from '../setup/installer.js';
import { installRuntimeDirectory, sha256 } from '../remote/runtime.js';
import { collectRemoteChunks, createFileLogSink } from '../remote/transfer.js';
import type { MachineName } from '../contracts.js';

const harnesses: HerdrHarness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); } });

it.each([
  ['request', /Request digest does not match/],
  ['source', /Uploaded source digest does not match/],
  ['settled', /settled program cannot run again/],
] as const)('reports a %s failure without recommending setup', async (failure, message) => {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start();
  const on = 'remote.invalid' as MachineName, root = join(h.directories.remote, 'programs'), coreConfig = join(h.root, 'core.toml'); await writeFile(coreConfig, 'notes = false\n');
  const config = parseHerdrConfig({ app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: coreConfig }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: on, nodePath: h.nodeBinary, runtime: { directory: root, cwd: h.root, commands: { javascript: [h.nodeBinary], shell: ['/bin/sh'] } } }] });
  const packageRoot = join(h.root, 'package'); await mkdir(join(packageRoot, 'dist/herdr'), { recursive: true });
  await writeFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs'), await readFile(resolve('dist/herdr/remote-runtime.mjs')));
  const request: SetupRequest = { config, configPath: join(h.root, 'config.json'), packageRoot, journalRoot: join(h.root, 'journal') };
  const setup = createProductionHerdrCliPorts(packageRoot, h.localEnv);
  let runtime: Awaited<ReturnType<Awaited<ReturnType<typeof setup.setupParts>>['ensureRuntime']>>[number];
  try {
    const parts = await setup.setupParts(request);
    await setupHerdr(request, { ...parts, hc: h.hc,
      preflight: async () => ({ fingerprint: 'fixture', coreIdentity: h.owner!.terminal, mods: [], targets: [], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
      bootstrapRuntime: async () => { await installRuntimeDirectory(root); },
      cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }), warn() {} });
    [runtime] = await parts.ensureRuntime(request, {} as never);
  } finally { await setup.dispose(); }
  const directory = join(root, 'job'), nonce = '0123456789abcdef0123456789abcdef', programNonce = 'f'.repeat(32);
  const marker = join(directory, '.spider-program'), source = join(directory, 'source.cjs'), requestPath = join(directory, 'request.json');
  await h.hc.fileWrite(on, marker, Buffer.from(programNonce)); await h.hc.fileWrite(on, source, Buffer.from('process.exit(42)'));
  if (failure === 'settled') await h.hc.fileWrite(on, join(directory, '.spider-settled'), Buffer.from('settled'));
  const bytes = Buffer.from(JSON.stringify({ version: 1, jobId: 'job', nonce, programNonce, argv: [h.nodeBinary, source], cwd: null, env: {}, files: [{ path: marker, sha256: sha256(programNonce) }, { path: source, sha256: failure === 'source' ? '0'.repeat(64) : sha256('process.exit(42)') }], releaseWindowMs: 10000 }));
  await h.hc.fileWrite(on, requestPath, bytes); await h.hc.fileWrite(on, requestPath + '.sha256', Buffer.from(failure === 'request' ? '0'.repeat(64) : sha256(bytes)));
  const terminal = await h.hc.run({ argv: [h.nodeBinary, runtime.path, requestPath], cwd: null, on, labels: {}, noNotify: true, background: true, outliveParent: true });
  await expect.poll(async () => (await h.hc.get(terminal.address)).state, { timeout: 10000 }).toBe('finished');
  const sink = await createFileLogSink(join(h.directories.local, 'logs'));
  const logs = await collectRemoteChunks(h.hc, { on, directory, jobId: 'job', nonce, requestSha256: sha256(bytes) }, sink);
  expect(logs).toMatchObject({ complete: true, receipt: { outcome: 'spawn-error', error: expect.stringMatching(message) } });
  expect(logs.receipt!.error).not.toMatch(/rerun.*setup/i);
}, 30000);
