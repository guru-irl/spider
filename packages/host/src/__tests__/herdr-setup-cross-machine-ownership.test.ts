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
}
