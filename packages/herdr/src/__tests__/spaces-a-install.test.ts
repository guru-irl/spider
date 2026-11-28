// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { chmod, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setupHerdr } from '../setup/installer.js';
import { readJournal, saveJournal } from '../setup/backup.js';
import { cleanup } from '../../../host/src/__tests__/herdr-setup-fixture.js';
import { pickerFixture, shapes, exists, fingerprint, unresolvedImports } from './spaces-a-install-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

test('installs a standalone picker with private config and resolved helper imports', async () => {
  const f = await pickerFixture('process');
  await setupHerdr(f.request, f.parts);
  const mods = join(f.h.directories.app, 'mods'), picker = join(mods, 'spider-picker');
  const configPath = join(picker, 'config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  expect(config).toMatchObject({ version: 1, modId: 'spider-picker', retention: { completedRows: f.request.config.limits.completedRows, completedHours: f.request.config.limits.completedHours } });
  expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  for (const name of ['feedRoot', 'cliPath', 'nodePath', 'appBinary', 'configPath']) expect(isAbsolute(config[name]), name).toBe(true);
  expect(config.machines).toEqual(f.request.config.machines);
  expect(config.fonts).toMatchObject({ body: expect.any(String), label: expect.any(String), paths: expect.any(String) });
  const main = await readFile(join(picker, 'main.js'), 'utf8');
  expect(main).toContain("import './shared/navigation.js'");
  expect(main).toContain("import('./shared/look.js')");
  expect(main).toContain("// import '../shared/comment.js'");
  expect(main).toContain("'../shared/not-an-import.js'");
  expect(await Promise.all(shapes.map(name => exists(join(picker, `space-${name}.svg`))))).toEqual(shapes.map(() => true));
  const imports: string[] = [];
  for (const name of ['spider-picker', 'spider-agents', 'spider-panel']) {
    const root = join(mods, name), nav = join(root, 'shared/navigation.js'), children = join(root, 'spider-children.js');
    expect(await readFile(nav, 'utf8')).toContain("from '../spider-children.js'");
    expect(await exists(children)).toBe(true);
    expect(await exists(join(root, 'shared/open-failure.js'))).toBe(true);
    imports.push(nav, children);
  }
  imports.push(join(picker, 'main.js'), join(picker, 'model.js'));
  expect(await unresolvedImports(mods, imports)).toEqual([]);
  for (const name of ['grouping.js', 'connections.js', 'console-groups.js']) expect(await exists(join(mods, 'spider-agents', name)), name).toBe(true);
  expect(await exists(join(mods, 'spider-spaces/local.js'))).toBe(true);
  const layout = await readFile(join(f.h.directories.app, 'layouts/spider-glass.json'), 'utf8');
  expect(layout).not.toContain('spider-picker');
  for (const file of ['picker/main.js', 'picker/model.js', 'shared/navigation.js', 'agents/children.js']) {
    const source = await readFile(join(f.root, 'packages/herdr/assets', file), 'utf8');
    expect(source).not.toContain(f.h.root);
    expect(source).not.toMatch(/\/Users\/|\/home\//);
  }
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
});

test('doctor checks picker and shared helpers without changing installed files', async () => {
  const f = await pickerFixture(); await setupHerdr(f.request, f.parts);
  const picker = join(f.h.directories.app, 'mods/spider-picker'), helper = join(picker, 'shared/navigation.js');
  const inspect = await f.ports.doctorParts(f.request);
  const beforeInspection = await fingerprint(f.h.directories.app);
  expect((await inspect.inspect('mods', f.request)).failures).toEqual([]);
  expect(await fingerprint(f.h.directories.app)).toEqual(beforeInspection);
  const original = await readFile(helper);
  await writeFile(helper, Buffer.concat([original, Buffer.from('\nexport const changed = true;\n')]));
  const before = await readFile(helper);
  expect((await inspect.inspect('mods', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed', message: expect.stringContaining(helper) }));
  expect(await readFile(helper)).toEqual(before);
  await writeFile(helper, original);
  const config = join(picker, 'config.json');
  await chmod(config, 0o644);
  expect((await inspect.inspect('mods', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'picker-config-insecure' }));
  expect((await stat(config)).mode & 0o777).toBe(0o644);
  await chmod(config, 0o600);
  const journal = await readJournal(f.request.journalRoot), entry = journal.entries.find(item => item.path === join(picker, 'main.js'))!;
  entry.after = '0'.repeat(64); await saveJournal(f.request.journalRoot, journal);
  const journalBefore = await readFile(join(f.request.journalRoot, 'journal.json'));
  expect((await inspect.inspect('mods', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed' }));
  expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(journalBefore);
});

test('refuses incomplete picker sources before making installation changes', async () => {
  const f = await pickerFixture('process'), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings);
  await unlink(join(f.root, 'packages/herdr/assets/picker/main.js'));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'picker-assets-missing' });
  expect(await readFile(settings)).toEqual(before);
  expect(await exists(join(f.h.directories.app, 'mods/spider-picker/config.json'))).toBe(false);
});

test('refuses an unresolved rewritten import before writing files', async () => {
  const f = await pickerFixture(), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings);
  await writeFile(join(f.root, 'packages/herdr/assets/picker/main.js'), "import '../shared/missing.js';\n");
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'picker-import-unresolved' });
  expect(await readFile(settings)).toEqual(before);
  expect(await exists(join(f.h.directories.app, 'mods/spider-picker/config.json'))).toBe(false);
});

test.each(['./missing.js', '../../outside.js'])('refuses an unsafe picker import %s before any writes', async specifier => {
  const f = await pickerFixture(), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings), source = join(f.root, 'packages/herdr/assets/picker/main.js');
  await writeFile(source, `import '${specifier}';\n`);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'picker-import-unresolved', message: expect.stringContaining(specifier) });
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ message: expect.stringContaining('main.js') });
  expect(await readFile(settings)).toEqual(before);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
}, 60_000);

test('refuses a skipped import after a quote-containing regex and names its source', async () => {
  const f = await pickerFixture(), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings), source = join(f.root, 'packages/herdr/assets/picker/main.js');
  const specifier = '../shared/navigation.js';
  await writeFile(source, `const quote = /['"]/;\nimport '${specifier}';\n`);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'picker-import-unresolved', message: expect.stringContaining('spider-picker/main.js') });
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ message: expect.stringContaining(specifier) });
  expect(await readFile(settings)).toEqual(before);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
}, 60_000);

test('refuses a symlinked navigation source before writing files', async () => {
  const f = await pickerFixture(), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings), source = join(f.root, 'packages/herdr/assets/shared/navigation.js');
  const target = join(f.h.root, 'private-navigation.js');
  await writeFile(target, Buffer.concat([await readFile(source), Buffer.from('\nexport const marker = "private";\n')]));
  await unlink(source); await symlink(target, source);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'asset-symlink' });
  expect(await readFile(settings)).toEqual(before);
  expect(await exists(join(f.h.directories.app, 'mods/spider-picker/config.json'))).toBe(false);
});

test('rejects a relative path in generated picker props', async () => {
  const f = await pickerFixture(), directory = join(f.h.directories.app, 'mods/spider-picker');
  const props = { ...f.context.modProps[0].props, modId: 'spider-picker', configPath: 'relative.json' };
  const context = { ...f.context, modProps: [...f.context.modProps, { directory, props }] };
  await expect(f.parts.stageLook(f.request, context, 'export')).rejects.toMatchObject({ code: 'invalid-mod-path' });
  expect(await exists(join(directory, 'config.json'))).toBe(false);
});
