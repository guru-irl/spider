// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal } from '../../../herdr/src/setup/backup.js';
import { cleanup } from './herdr-setup-fixture.js';
import { releaseFixture } from './herdr-setup-release-fixture.js';

const interruption = vi.hoisted(() => ({ target: '', enabled: false, fired: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    const result = await actual.mkdir(...args);
    if (interruption.enabled && args[0] === interruption.target) {
      interruption.enabled = false; interruption.fired = true;
      throw new Error('interrupted after directory creation');
    }
    return result;
  } };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { interruption.enabled = false; for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

test('setup reuses an unrecorded empty mod directory and doctor accepts it', async () => {
  const f = await releaseFixture('0.1.13');
  const directory = join(f.h.directories.app, 'mods/spider-new-menu');
  interruption.target = directory; interruption.fired = false; interruption.enabled = true;
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('interrupted after directory creation');
  expect(interruption.fired).toBe(true);
  expect(await readdir(directory)).toEqual([]);
  const before = await stat(directory), journal = await readJournal(f.request.journalRoot);
  expect(journal.entries.length).toBeGreaterThan(0);
  expect(journal.modDirectories?.some(entry => entry.path === directory) ?? false).toBe(false);
  await setupHerdr(f.request, f.parts);
  expect((await stat(directory)).ino).toBe(before.ino);
  const doctor = await f.ports.doctorParts(f.request);
  for (const item of ['mods', 'clones'] as const) {
    const result = await doctor.inspect(item, f.request);
    expect(result.failures).toEqual([]);
    expect((result.warnings ?? []).every(warning => warning.code === 'inspection-unavailable' && warning.message.includes('source content matches; mod loading is not verified'))).toBe(true);
  }
  await rollbackHerdr(f.request, f.parts);
  expect((await stat(directory)).isDirectory()).toBe(true);
  expect(await readdir(directory)).toEqual([]);
});
