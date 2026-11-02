// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createProductionHerdrCliPorts, createHostHerdrPorts } from '../../../host/src/herdr/ports.js';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, type SetupRequest } from '../setup/installer.js';
import { createJobMonitor } from '../jobs/monitor.js';
import { executeRemote, type RemoteExecutionPorts } from '../remote/execute.js';
import { installRuntimeDirectory } from '../remote/runtime.js';
import type { HcClient, MachineName } from '../contracts.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(mode: 'fake' | 'hc' = 'fake') {
  const h: HerdrHarness = await createHerdrHarness(mode); cleanups.push(async () => { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }); await h.start();
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
  let reads = 0, failure: Error | undefined, targetPath = runtime.path;
  const hc: HcClient = { ...h.hc, fileRead: async (machine, path) => {
    if (path === targetPath) { reads++; if (failure) throw failure; }
    return h.hc.fileRead(machine, path);
  } };
  const output = createHostHerdrPorts({ hc: h.hc, config, runtimeBytes: runtime.bytes, runtimePath: () => runtime.path });
  const monitor = createJobMonitor({ hc: h.hc, outputCollector: output.outputCollector, journalRoot: join(h.root, 'jobs'), observedJobMessages: async () => [], notifier: () => {}, clock: Date.now });
  cleanups.push(async () => { await monitor.shutdown('reload'); output.dispose(); });
  await monitor.activate(h.owner!);
  const ports: RemoteExecutionPorts = { hc, jobs: monitor, prepare: prepareRemoteProgram, environmentPolicy: env => env, clock: Date.now,
    target: async () => ({ on, ...config.machines[0].runtime, environment: {}, nodePath: h.nodeBinary, runtimePath: targetPath, runtimeSha256: runtime.sha256 }),
    logSink: async job => output.logReader(job.id) };
  const execute = () => executeRemote({ on, owner: h.owner!, source: { kind: 'code', language: 'javascript', code: 'console.log("ok")' } }, ports);
  return { h, runtime, ports, execute, reads: () => reads, fail: (error?: Error) => { failure = error; }, path: (path: string) => { targetPath = path; } };
}

it('verifies once for repeated and concurrent commands, but not for a different runtime path', async () => {
  const f = await fixture();
  const results = await Promise.all([f.execute(), f.execute()]);
  expect(results.map(result => result.outcome)).toEqual(['exited', 'exited']);
  expect(await f.execute()).toMatchObject({ outcome: 'exited', stdout: 'ok\n' }); expect(f.reads()).toBe(1);
  const secondExecutorPorts = { ...f.ports };
  expect(await executeRemote({ on: 'remote.invalid' as MachineName, owner: f.h.owner!, source: { kind: 'code', language: 'javascript', code: 'console.log("ok")' } }, secondExecutorPorts)).toMatchObject({ outcome: 'exited', stdout: 'ok\n' });
  expect(f.reads()).toBe(1);
  f.path(f.runtime.path + '-different');
  await expect(f.execute()).rejects.toMatchObject({ code: 'runtime-not-installed' });
  expect(f.reads()).toBe(2);
}, 45000);

it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !existsSync(process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc')))('real isolated hc reuses a verified runtime for repeated commands (requires hc and SPIDER_HERDR_E2E=1)', async () => {
  const f = await fixture('hc');
  expect(await f.execute()).toMatchObject({ outcome: 'exited', stdout: 'ok\n' });
  expect(await f.execute()).toMatchObject({ outcome: 'exited', stdout: 'ok\n' });
  expect(f.reads()).toBe(1);
}, 45000);

it('invalidates the verified digest after an unknown result without a receipt', async () => {
  const f = await fixture();
  expect(await f.execute()).toMatchObject({ outcome: 'exited' });
  const reader = f.ports.logSink;
  f.ports.logSink = async () => ({ collect: async () => { throw new Error('transport interrupted'); }, dispose() {} });
  const unreadable = await f.execute();
  expect(unreadable).toMatchObject({ outcome: 'exited', exitCode: 0 });
  expect(unreadable.stderr).toContain('Output could not be read');
  expect(unreadable.stderr).toContain(unreadable.backgroundLogs!.stdout);
  expect(unreadable.stderr).toContain(unreadable.backgroundLogs!.stderr);
  expect(await readFile(unreadable.backgroundLogs!.stdout, 'utf8')).toBe('ok\n');
  f.ports.logSink = reader; await writeFile(f.runtime.path, '// replaced runtime');
  await expect(f.execute()).rejects.toMatchObject({ code: 'runtime-not-installed' });
  expect(f.reads()).toBe(2);
}, 45000);

it('does not tell users to rerun setup for a dead core or an unavailable machine', async () => {
  const f = await fixture();
  for (const code of ['core-unavailable', 'machine-not-found']) {
    const error = Object.assign(new Error('transport is unavailable'), { code }); f.fail(error);
    await expect(f.execute()).rejects.toBe(error);
  }
  expect(f.reads()).toBe(2);
}, 30000);
