// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { registerHerdrTemplates } from '../../../herdr/src/templates/register.js';
import { cleanup, fixture, type SetupFixture } from './herdr-setup-fixture.js';

// An isolated fixture must not inventory unrelated host sessions.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

const unavailableWorker = 'unavailable.invalid/missing-worker';
const cases = [
  { name: 'unavailable worker default', empty: false, code: 'role-unresolved', message: 'Configured worker model is unavailable', repair: 'Choose an available configured model' },
  { name: 'empty catalog', empty: true, code: 'catalog-unavailable', message: 'No available catalog model for worker', repair: 'Make an eligible catalog model available' },
] as const;
async function configure(f: SetupFixture, empty: boolean) {
  const path = join(f.h.directories.global, 'config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config['models.defaults'] = empty ? {} : { worker: unavailableWorker };
  await writeFile(path, JSON.stringify(config));
  if (empty) {
    vi.spyOn(ModelRegistry.prototype, 'getAll').mockReturnValue([]);
    vi.spyOn(ModelRegistry.prototype, 'getAvailable').mockReturnValue([]);
  }
}
async function installedBytes(f: SetupFixture): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files[file] = (await readFile(file)).toString('base64');
    }
  };
  for (const root of [f.h.directories.app, f.h.directories.agent, f.h.directories.global, dirname(f.request.config.core.config)]) await walk(root);
  const shellRc = await readFile(f.request.config.shellRc).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (shellRc !== null) files[f.request.config.shellRc] = shellRc.toString('base64');
  return files;
}

it.each(cases)('setup refuses $name before writing any setup-owned file on a fresh install', async scenario => {
  const f = await fixture(); await configure(f, scenario.empty);
  const before = await installedBytes(f);
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true; });
  const code = await runHerdrCli(['setup', '--config', f.request.configPath], { ...f.ports, stdout() {}, stderr: message => { stderr += message; } });
  expect(code, stderr).toBe(1);
  expect(stderr.trim().split('\n')).toEqual([`${scenario.code}: ${scenario.message}`]);
  const after = await installedBytes(f);
  // Pi initializes these two stores on its first run; setup owns neither file.
  for (const name of ['auth.json', 'models-cache.json']) {
    const path = join(f.h.directories.agent, name);
    if (!(path in before)) delete after[path];
  }
  expect(after).toEqual(before);
});

it.each(cases)('setup refuses $name without changing an existing installation', async scenario => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); await configure(f, scenario.empty);
  const before = await installedBytes(f);
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true; });
  const code = await runHerdrCli(['setup', '--config', f.request.configPath], { ...f.ports, stdout() {}, stderr: message => { stderr += message; } });
  expect(code, stderr).toBe(1);
  expect(stderr.trim().split('\n')).toEqual([`${scenario.code}: ${scenario.message}`]);
  expect(await installedBytes(f)).toEqual(before);
});

it.each(cases)('doctor reports $name as a role failure with a repair', async scenario => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); await configure(f, scenario.empty);
  let output = '', stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true; });
  const code = await runHerdrCli(['doctor', '--config', f.request.configPath], { ...f.ports, stdout: message => { output += message; }, stderr: message => { stderr += message; } });
  expect(code, output + stderr).toBe(1);
  expect(output.split('\n').filter(line => line.startsWith(`${scenario.code}:`))).toEqual([`${scenario.code}: ${scenario.message}`]);
  expect(output).toContain(`Repair: ${scenario.repair}`);
  expect(stderr).toBe('');
  const roles = await (await f.ports.doctorParts(f.request)).inspect('roles', f.request);
  expect(roles.failures).toContainEqual(expect.objectContaining({ item: 'roles', code: scenario.code, message: scenario.message, repair: expect.stringContaining(scenario.repair) }));
});

it('session activation still warns once and skips the same unavailable worker default across reloads', async () => {
  const f = await fixture(); await configure(f, false);
  const runtime = await ModelRuntime.create({ authPath: join(f.h.directories.agent, 'auth.json'), modelsPath: join(f.h.directories.agent, 'models.json'), modelsStorePath: join(f.h.directories.agent, 'models-cache.json'), allowModelNetwork: false });
  const templateDirectory = join(dirname(f.request.config.core.config), 'templates');
  const instructions = join(f.h.directories.global, 'herdr/instructions');
  await mkdir(templateDirectory, { recursive: true }); await mkdir(instructions, { recursive: true });
  let start: ((event: unknown, context: ExtensionContext) => unknown) | undefined;
  const pi = { on: (_event: string, handler: typeof start) => { start = handler; return () => {}; } } as unknown as ExtensionAPI;
  const warnings: string[] = [];
  const registration = registerHerdrTemplates(pi, {
    globalModelDefaultLayers: async () => ({ global: JSON.parse(await readFile(join(f.h.directories.global, 'config.json'), 'utf8'))['models.defaults'] }),
    modelRegistry: new ModelRegistry(runtime), templateDirectory,
    roleTemplateOptions: { piExecutable: 'pi', instructionPaths: { worker: join(instructions, 'worker.md'), reviewer: join(instructions, 'reviewer.md'), watcher: join(instructions, 'watcher.md') } },
    reportWarning: message => warnings.push(message), writeVerifiedFile: writeFile,
  });
  cleanup.push(async () => registration.dispose());
  await expect(start!({}, {} as ExtensionContext)).resolves.toBeUndefined();
  await expect(start!({}, {} as ExtensionContext)).resolves.toBeUndefined();
  expect(warnings).toEqual(['Configured worker model is unavailable']);
  expect((await readdir(templateDirectory)).sort()).toEqual(['spider-reviewer.md', 'spider-watcher.md']);
  expect((await readdir(instructions)).sort()).toEqual(['reviewer.md', 'watcher.md']);
});
