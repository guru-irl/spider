// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { chmod, lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, cleanup } from './herdr-setup-fixture.js';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

test('production setup creates private feed folders and repairs a deleted folder on unchanged setup', async () => {
  const f = await fixture();
  const root = join(f.h.directories.global, 'herdr'), sessions = join(root, 'sessions');
  await setupHerdr(f.request, f.parts);
  expect((await lstat(sessions)).mode & 0o777).toBe(0o700);
  await rm(sessions, { recursive: true });
  const result = await setupHerdr(f.request, f.parts);
  expect(result.writes).toEqual([]);
  expect((await lstat(sessions)).mode & 0o777).toBe(0o700);
  await chmod(sessions, 0o755);
  await setupHerdr(f.request, f.parts);
  expect((await lstat(sessions)).mode & 0o777).toBe(0o700);
  await rollbackHerdr(f.request, f.parts);
  expect((await lstat(sessions)).isDirectory()).toBe(true);
}, 120000);

test('production setup refuses a symlinked feed folder without changing its target', async () => {
  const f = await fixture();
  const root = join(f.h.directories.global, 'herdr'), sessions = join(root, 'sessions'), outside = join(f.h.root, 'outside');
  await mkdir(root, { recursive: true }); await mkdir(outside, { mode: 0o755 }); await symlink(outside, sessions);
  const mode = (await lstat(outside)).mode;
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'destination-symlink' });
  expect((await lstat(outside)).mode).toBe(mode);
}, 120000);

test('production setup refuses a wrong-owner feed folder on an unchanged setup', async () => {
  const f = await fixture();
  await setupHerdr(f.request, f.parts);
  const owner = process.getuid!();
  vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'feed-directory-owner-mismatch' });
}, 120000);
