// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { mkdir, readFile, writeFile, chmod, stat, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHerdrHarness } from '../__tests__/testutil.js';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, type SetupRequest } from '../setup/installer.js';
import { doctorHerdr } from '../setup/doctor.js';
import type { MachineName } from '../contracts.js';
const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

async function withBootstrap(version: string, check: (request: SetupRequest, production: ReturnType<typeof createProductionHerdrCliPorts>, parts: import('../setup/installer.js').SetupParts) => Promise<void>) {
  const h = await createHerdrHarness('fake');
  const on = 'bootstrap.invalid' as MachineName;
  let production: ReturnType<typeof createProductionHerdrCliPorts> | undefined;
  let added = false;
  try {
    await h.start();
    await h.cli(['machine', 'add', '--via', join(h.root, 'via'), '--name', on, '--session', 'r', '--json']); added = true;
    const preload = join(h.root, 'node-version.mjs'), nodePath = join(h.root, 'remote-node');
    await writeFile(preload, `Object.defineProperty(process, 'version', {value:${JSON.stringify(version)}});\n`);
    await writeFile(nodePath, `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(preload)} "$@"\n`); await chmod(nodePath, 0o700);
    await mkdir(join(h.root, 'dist/herdr'), { recursive: true });
    await writeFile(join(h.root, 'dist/herdr/remote-runtime.mjs'), await readFile(resolve('dist/herdr/remote-runtime.mjs')));
    const runtimeDirectory = join(h.directories.remote, 'programs');
    const config = parseHerdrConfig({ app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') },
      agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [],
      machines: [{ name: on, nodePath, runtime: { directory: runtimeDirectory, cwd: null, commands: {} } }] });
    const request: SetupRequest = { config, configPath: join(h.root, 'config.json'), packageRoot: h.root, journalRoot: join(h.root, 'journal') };
    production = createProductionHerdrCliPorts(h.root, h.localEnv);
    const parts = await production.setupParts(request);
    const selectedParts = { ...parts,
      preflight: async () => ({ fingerprint: 'runtime-only', coreIdentity: h.owner!.terminal, mods: [], targets: [], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
      cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }), warn() {} };
    await setupHerdr(request, selectedParts);
    expect((await stat(runtimeDirectory)).mode & 0o777).toBe(0o700);
    const [runtime] = await parts.ensureRuntime(request, {} as never);
    expect(await h.hc.fileRead(on, runtime.path)).toEqual(runtime.bytes);
    await check(request, production, selectedParts);
  } finally {
    await production?.dispose();
    if (added) await h.cli(['machine', 'rm', on, '--json']);
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
  }
}

test('the production bootstrap accepts runtime probes from supported remote Node 22.18.0', async () => {
  await withBootstrap('v22.18.0', async () => {});
}, 20000);

test('the production doctor factory diagnoses an unprivate runtime root with a setup repair', async () => {
  await withBootstrap(process.version, async (request, production) => {
    await chmod(request.config.machines[0].runtime.directory, 0o755);
    const report = await doctorHerdr(request, await production.doctorParts(request));
    expect(report.failures).toContainEqual(expect.objectContaining({ item: 'runtime-root', repair: expect.stringMatching(/rerun.*setup/i) }));
  });
}, 30000);

test('unchanged production runtime setup recreates a deleted root and passes the runtime doctor checks', async () => {
  await withBootstrap(process.version, async (request, production, parts) => {
    const directory = request.config.machines[0].runtime.directory;
    await rm(directory, { recursive: true });
    parts.cutover = async () => { throw new Error('Unexpected repeated cutover'); };
    await setupHerdr(request, parts);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const report = await doctorHerdr(request, await production.doctorParts(request));
    expect(report.failures.filter(failure => ['runtime-root', 'runtime-digest', 'remote-node'].includes(failure.item))).toEqual([]);
  });
}, 30000);

test.each(['permissive', 'symlink', 'foreign-owner'])('unchanged production runtime setup refuses a %s root instead of trusting its cached bootstrap', async state => {
  await withBootstrap(process.version, async (request, _production, parts) => {
    const directory = request.config.machines[0].runtime.directory;
    if (state === 'permissive') await chmod(directory, 0o755);
    else if (state === 'symlink') {
      const target = join(directory, '..', 'alias-target'); await mkdir(target, { mode: 0o700 });
      await rm(directory, { recursive: true }); await symlink(target, directory);
    } else {
      const preload = join(request.packageRoot, 'node-version.mjs');
      await writeFile(preload, "const uid=process.getuid();process.getuid=()=>uid+1;\n");
    }
    await expect(setupHerdr(request, parts)).rejects.toMatchObject({ code: 'runtime-bootstrap-failed', message: expect.stringMatching(/rerun setup/i) });
  });
}, 30000);
