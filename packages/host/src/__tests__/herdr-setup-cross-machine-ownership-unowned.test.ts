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
for (const version of ['0.1.13', '0.1.16'] as const) {

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
