// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, digest } from '../../../herdr/src/setup/backup.js';
import { join } from 'node:path';
import { cleanup } from './herdr-setup-fixture.js';
import { releaseFixture } from './herdr-setup-release-fixture.js';
import { fastRelease } from './herdr-setup-cross-machine-fixture.js';
import { useStaticSetupApp } from './herdr-setup-focused-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

test('doctor names the insecure machine-picker config and chmod repair', async () => {
  const f = await fastRelease('0.1.13');
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'mods/spider-machine-picker-right/config.json');
  await chmod(path, 0o644);
  const doctor = await f.ports.doctorParts(f.request);
  expect((await doctor.inspect('mods', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'picker-config-insecure', message: expect.stringContaining(`chmod 600 '${path}'`) }));
  expect((await stat(path)).mode & 0o777).toBe(0o644);
});

for (const version of ['0.1.13', '0.1.16'] as const) {
  test(`${version} rollback removes created mod directories but preserves existing and populated directories`, async () => {
    const f = await fastRelease(version, false), mods = join(f.h.directories.app, 'mods');
    const keys = join(f.h.directories.app, 'keys.json');
    const originalKeys = version === '0.1.13' ? await readFile(keys) : undefined;
    if (version === '0.1.13') {
      expect(JSON.parse(originalKeys!.toString('utf8')).global).not.toHaveProperty('cmd-m');
      f.request.nativeKeys = 'accept';
    }
    const existing = join(mods, 'spider-new-menu'), shared = join(existing, 'shared');
    await mkdir(shared, { recursive: true });
    await setupHerdr(f.request, f.parts);
    if (version === '0.1.13') expect(JSON.parse(await readFile(keys, 'utf8')).global['cmd-m']).toBe('window.minimize');
    const userFile = join(mods, 'spider-machine-picker-down', 'user.txt');
    await writeFile(userFile, 'keep this');
    await rollbackHerdr(f.request, f.parts);
    if (version === '0.1.13') expect(await readFile(keys)).toEqual(originalKeys);
    for (const name of ['spider-machine-picker', 'spider-machine-picker-right', 'spider-pane-waiting']) await expect(stat(join(mods, name))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(existing, 'machines'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(existing)).isDirectory()).toBe(true);
    expect((await stat(shared)).isDirectory()).toBe(true);
    expect(await readFile(userFile, 'utf8')).toBe('keep this');
  });

  test(`${version} installs B as one owned set and repeats and rolls back without changing stock`, async () => {
    const f = await useStaticSetupApp(await releaseFixture(version), version), home = f.h.directories.app;
    const keys = join(home, 'keys.json'), beforeKeys = await readFile(keys);
    const stock = await readFile(join(home, 'mods/new-menu/main.js'));
    await setupHerdr(f.request, f.parts);
    const journal = await readJournal(f.request.journalRoot);
    const newFiles = journal.entries.filter(entry => /\/mods\/spider-(?:new-menu|machine-picker(?:-right|-down)?|menu)\//.test(entry.path));
    const requiredFiles = ['spider-new-menu/main.js', 'spider-new-menu/mod.json', 'spider-menu/actions.js', 'spider-menu/machine.js',
      ...['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down'].flatMap(name => ['main.js', 'picker.js', 'actions.js', 'mod.json', 'config.json'].map(file => `${name}/${file}`))];
    expect(newFiles.map(entry => entry.path)).toEqual(expect.arrayContaining(requiredFiles.map(file => join(home, 'mods', file))));
    for (const entry of newFiles) {
      expect(entry.before, entry.path).toBeNull();
      expect(digest(await readFile(entry.path)), entry.path).toBe(entry.after);
    }
    for (const name of ['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down']) expect((await stat(join(home, 'mods', name, 'config.json'))).mode & 0o777).toBe(0o600);
    const doctor = await f.ports.doctorParts(f.request);
    for (const item of ['mods', 'clones', 'patch-version', 'layout-theme'] as const) expect((await doctor.inspect(item, f.request)).failures).toEqual([]);
    const savedJournal = await readFile(join(f.request.journalRoot, 'journal.json'));
    expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
    expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(savedJournal);
    const body = join(home, 'mods/spider-new-menu/main.js'), original = await readFile(body);
    await writeFile(body, '// changed installed B body\n');
    expect((await doctor.inspect('clones', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed' }));
    await writeFile(body, original);
    await rollbackHerdr(f.request, f.parts);
    for (const entry of newFiles) await expect(readFile(entry.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(keys)).toEqual(beforeKeys);
    expect(await readFile(join(home, 'mods/new-menu/main.js'))).toEqual(stock);
    expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
  });

  test(`${version} an unowned B file refuses unless replaced and rollback restores its original bytes`, async () => {
    const f = await fastRelease(version), home = f.h.directories.app;
    const directory = join(home, 'mods/spider-new-menu'); await mkdir(directory);
    const path = join(directory, 'main.js'), original = '// existing custom menu\n';
    await writeFile(path, original, { mode: 0o640 });
    const keys = join(home, 'keys.json'), beforeKeys = await readFile(keys);
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'unowned-clone-collision' });
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readFile(keys)).toEqual(beforeKeys);
    await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
    expect(await readFile(path, 'utf8')).toContain('spider-look:b-new-menu-terminal-entry');
    await rollbackHerdr(f.request, f.parts);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await readFile(keys)).toEqual(beforeKeys);
  });
}
