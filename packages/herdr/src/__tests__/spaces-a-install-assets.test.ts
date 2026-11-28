// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { setupHerdr } from '../setup/installer.js';
import { cleanup, fixture } from '../../../host/src/__tests__/herdr-setup-fixture.js';
import { releaseFixture } from '../../../host/src/__tests__/herdr-setup-release-fixture.js';
import { fingerprint, unresolvedImports } from './spaces-a-install-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

test('installs the packaged picker View and manifest with resolvable imports', async () => {
  const f = await fixture('fake', false, { coreTransport: 'socket' }); await setupHerdr(f.request, f.parts);
  const mods = join(f.h.directories.app, 'mods'), root = join(mods, 'spider-picker');
  const main = await readFile(join(root, 'main.js'), 'utf8');
  expect(main).toContain("from './shared/navigation.js'");
  expect(main).toContain("from './shared/look.js'");
  expect(main).toContain("from './shared/feed.js'");
  expect(main).toContain("from './shared/open-failure.js'");
  expect(await readFile(join(root, 'mod.json'))).toEqual(await readFile(join(f.root, 'packages/herdr/assets/picker/mod.json')));
  expect(JSON.parse(await readFile(join(root, 'mod.json'), 'utf8'))).toMatchObject({ place: 'none', overlay: { kind: 'popup' } });
  expect(await unresolvedImports(mods, ['main.js', 'model.js', 'shared/navigation.js', 'shared/look.js', 'shared/feed.js', 'spider-children.js'].map(file => join(root, file)))).toEqual([]);
  expect((await stat(join(root, 'config.json'))).mode & 0o777).toBe(0o600);
  const before = await fingerprint(f.h.directories.app), doctor = await f.ports.doctorParts(f.request);
  expect((await doctor.inspect('mods', f.request)).failures).toEqual([]);
  expect(await fingerprint(f.h.directories.app)).toEqual(before);
});

test('doctor verifies native key commands or reports that inspection is unavailable', async () => {
  const f = await releaseFixture('0.1.13'), keysPath = join(f.h.directories.app, 'keys.json');
  const native = JSON.parse(await readFile(keysPath, 'utf8')) as Record<string, Record<string, unknown>>;
  const desired = JSON.parse(await readFile(join(f.root, 'packages/herdr/assets/keys.json'), 'utf8')) as Record<string, Record<string, unknown>>;
  for (const [section, bindings] of Object.entries(desired)) native[section] = { ...native[section], ...bindings };
  await writeFile(keysPath, JSON.stringify(native));
  const inspect = await f.ports.doctorParts(f.request), before = await fingerprint(f.h.directories.app);
  const unavailable = await inspect.inspect('keys', f.request);
  expect(unavailable.warnings).toContainEqual(expect.objectContaining({ code: 'inspection-unavailable', message: expect.stringContaining('native commands') }));
  expect(await fingerprint(f.h.directories.app)).toEqual(before);
  const script = join(f.h.root, 'app-selection.mjs'), original = await readFile(script, 'utf8');
  const commands = [
    { name: 'mod.open', args: [{ name: 'name', required: true }] },
    { name: 'terminal.park', args: [{ name: 'terminal', required: true }] },
    { name: 'pane.close', args: [{ name: 'pane', required: false }] },
  ];
  const reply = async (rows: unknown[]) => writeFile(script, `if (process.argv[2] === 'commands') { console.log(${JSON.stringify(JSON.stringify({ commands: rows }))}); process.exit(0); }\n` + original);
  await reply(commands);
  const valid = await inspect.inspect('keys', f.request);
  expect(valid.failures).toEqual([]);
  expect(valid.warnings ?? []).not.toContainEqual(expect.objectContaining({ message: expect.stringContaining('native commands') }));
  await reply(commands.filter(command => command.name !== 'terminal.park'));
  expect((await inspect.inspect('keys', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'native-command-missing', message: expect.stringContaining('terminal.park') }));
  expect(await fingerprint(f.h.directories.app)).toEqual(before);
});

test('all installed shipped mod JavaScript imports resolve inside their own mod', async () => {
  const f = await fixture('fake', false, { coreTransport: 'socket' });
  await setupHerdr(f.request, f.parts);
  const mods = join(f.h.directories.app, 'mods'), files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith('.js')) files.push(path);
    }
  };
  for (const name of await readdir(mods)) if (name.startsWith('spider-')) await walk(join(mods, name));
  expect(files.length).toBeGreaterThan(10);
  expect(files.some(path => path.endsWith('/spider-picker/main.js'))).toBe(true);
  expect(files.some(path => path.endsWith('/spider-panel/main.js'))).toBe(true);
  expect(await unresolvedImports(mods, files)).toEqual([]);
}, 60_000);

test.each([
  ['0.1.16', 'toast/main.js', 'toast/main-0.1.18.js'],
  ['0.1.18', 'toast/main-0.1.18.js', 'toast/main.js'],
] as const)('%s stages every applicable mod asset with in-root imports', async (version, toast, otherToast) => {
  const f = await releaseFixture(version), app = f.h.directories.app, assets = join(f.root, 'packages/herdr/assets');
  const base = f.context.modProps[0].props;
  f.context.modProps = [...f.context.modProps, ...['picker', 'toast'].map(name => ({ directory: join(app, 'mods', `spider-${name}`), props: { ...base, modId: `spider-${name}` } }))];
  const staged = [...await f.parts.stageLook(f.request, f.context, 'export'), ...await f.parts.installFiles(f.request, f.context)];
  const mods = join(f.h.root, 'staged-mods'), originalMods = join(app, 'mods'), stagedJs: string[] = [];
  for (const file of staged) {
    const name = relative(originalMods, file.path);
    if (name.startsWith('..') || !name.startsWith('spider-') || !name.endsWith('.js')) continue;
    const path = join(mods, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.bytes); stagedJs.push(path);
  }
  const sourceJs: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith('.js')) sourceJs.push(relative(assets, path));
    }
  };
  await walk(assets);
  const target = (source: string) => {
    const [group, ...rest] = source.split('/');
    if (source === toast) return 'spider-toast/main.js';
    if (source === 'agents/children.js') return 'spider-agents/spider-children.js';
    if (group === 'machines') return `spider-machine-picker/${rest.join('/')}`;
    if (group === 'shared') return `spider-picker/shared/${rest.join('/')}`;
    if (group === 'mods') return `spider-panel/${rest.slice(1).join('/')}`;
    return `spider-${group === 'spaces' ? 'spaces' : group}/${rest.join('/')}`;
  };
  expect(sourceJs.length).toBeGreaterThan(10);
  expect(sourceJs.filter(source => source !== otherToast && !stagedJs.includes(join(mods, target(source))))).toEqual([]);
  expect(await readFile(join(mods, 'spider-toast/main.js'))).toEqual(await readFile(join(assets, toast)));
  expect(stagedJs).not.toContain(join(mods, 'spider-toast/main-0.1.18.js'));
  expect(await unresolvedImports(mods, stagedJs)).toEqual([]);
}, 60_000);
