// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { digest, managedProjection, readJournal } from '../../../herdr/src/setup/backup.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

test('recovers a sound write interrupted after publication', async () => {
  const f = await fixture(), settings = join(f.request.config.app.home, 'settings.json');
  const original = JSON.parse(await realFs.readFile(settings, 'utf8'));
  await realFs.writeFile(settings, JSON.stringify({ ...original, sounds: { enabled: true } }));
  let interrupted = false;
  vi.mocked(fs.rename).mockImplementation(async (from: PathLike, to: PathLike) => {
    await realFs.rename(from, to);
    if (to === settings && !interrupted) { interrupted = true; throw new Error('write-interrupted'); }
  });
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'setup-failed', message: expect.stringContaining('write-interrupted') });
  expect(JSON.parse(await realFs.readFile(settings, 'utf8')).sounds.enabled).toBe(false);
  expect((await setupHerdr(f.request, f.parts)).doctor.failures).toEqual([]);
  const { rollbackHerdr } = await import('../../../herdr/src/setup/installer.js');
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await realFs.readFile(settings, 'utf8'))).toEqual({ ...original, sounds: { enabled: true } });
}, 60_000);

test.each([1, 2])('settles or reports %s app rewrites after the sound write', async rewrites => {
  const f = await fixture(), settings = join(f.request.config.app.home, 'settings.json');
  let writes = 0;
  vi.mocked(fs.rename).mockImplementation(async (from: PathLike, to: PathLike) => {
    await realFs.rename(from, to);
    if (to === settings && ++writes <= rewrites) {
      const current = JSON.parse(await realFs.readFile(settings, 'utf8'));
      delete current.sounds;
      await realFs.writeFile(settings, JSON.stringify(current));
    }
  });
  if (rewrites === 1) {
    const result = await setupHerdr(f.request, f.parts);
    expect(result.doctor.failures).toEqual([]);
    expect(JSON.parse(await realFs.readFile(settings, 'utf8')).sounds.enabled).toBe(false);
  } else {
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'concurrent-settings-edit', message: expect.stringContaining('Sound changed after app selection') });
    expect(JSON.parse(await realFs.readFile(settings, 'utf8')).sounds).toBeUndefined();
  }
  expect(writes).toBe(2);
  const current = await realFs.readFile(settings);
  const entry = (await readJournal(f.request.journalRoot)).entries.find(item => item.path === settings)!;
  expect(entry.after).toBe(digest(current));
  expect(entry.managedAfter).toBe(managedProjection(current, entry.managed!));
  expect(entry.soundApplied).toBe(rewrites === 1);
}, 60_000);
