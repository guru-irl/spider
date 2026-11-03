// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { applyFiles, atomicWrite, digest, prepareBackups, readJournal, rollbackFiles, validateFiles } from '../setup/backup.js';
import { planModStorage } from '../setup/mod-storage.js';
import type { InstallFile } from '../setup/installer.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link) };
});
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const parent = resolve(process.env.SPIDER_GLOBAL_ROOT!, 'state-safety'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')); roots.push(root);
  return { root, journal: await readJournal(root) };
}
async function migration(root: string) {
  const data = join(root, 'data/spider-agents'); await mkdir(data, { recursive: true });
  const source = join(data, 'store-94630e0b396dc745.json'), destination = join(data, 'store-97d9d849eea9eed8.json');
  await writeFile(source, '{"timer":"42"}');
  const layout = (path: string) => Buffer.from(JSON.stringify({ content: { mod: 'spider-agents', props: { path } } }));
  return { source, destination, files: await planModStorage(root, layout('/path/to/old'), layout('/path/to/new')) };
}

test('rollback leaves saved migrated state and completes without owning either store', async () => {
  const { root, journal } = await fixture(), { source, destination, files } = await migration(root);
  await validateFiles(files, journal); await prepareBackups(root, files, journal); await applyFiles(files, journal);
  await writeFile(destination, '{"timer":"99"}');
  const warnings: string[] = []; await rollbackFiles(root, journal, { warn: text => warnings.push(text) });
  expect(warnings).toEqual([]);
  expect(journal.entries).toEqual([]);
  expect(await readFile(source, 'utf8')).toBe('{"timer":"42"}');
  expect(await readFile(destination, 'utf8')).toBe('{"timer":"99"}');
});

test.each([false, true])('a store created before validation stays untouched with replacement %s', async replaceChanged => {
  const { root, journal } = await fixture(), { destination, files } = await migration(root);
  await writeFile(destination, '{"timer":"99"}');
  await validateFiles(files, journal, false, undefined, { replaceChanged });
  await prepareBackups(root, files, journal); await applyFiles(files, journal);
  expect(await readFile(destination, 'utf8')).toBe('{"timer":"99"}');
  expect((await readJournal(root)).entries).toEqual([]);
});

test('a store created at publication wins the exclusive-create race', async () => {
  const { root, journal } = await fixture(), { destination, files } = await migration(root);
  await validateFiles(files, journal); await prepareBackups(root, files, journal);
  const race = async (to: PathLike) => { if (to === destination) await writeFile(destination, '{"timer":"99"}'); };
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { await race(to); return realFs.rename(from, to); });
  vi.mocked(fs.link).mockImplementation(async (from, to) => { await race(to); return realFs.link(from, to); });
  await applyFiles(files, journal);
  expect(await readFile(destination, 'utf8')).toBe('{"timer":"99"}');
  expect(journal.entries).toEqual([]);
});

test('an unowned file created at publication is not replaced by an atomic write', async () => {
  const { root } = await fixture(), path = join(root, 'mod.js');
  const race = async (to: PathLike) => { if (to === path) await writeFile(path, 'user bytes'); };
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { await race(to); return realFs.rename(from, to); });
  vi.mocked(fs.link).mockImplementation(async (from, to) => { await race(to); return realFs.link(from, to); });
  await expect(atomicWrite(path, Buffer.from('installed'), 0o600, null)).rejects.toMatchObject({ code: 'concurrent-settings-edit' });
  expect(await readFile(path, 'utf8')).toBe('user bytes');
});

test('a second replacement retains the pre-install backup and restores the latest user bytes', async () => {
  const { root, journal } = await fixture(), path = join(root, 'mod.js');
  let files: InstallFile[] = [{ path, bytes: Buffer.from('installed-1'), expected: null, collision: 'clone' }];
  await writeFile(path, 'original');
  await validateFiles(files, journal, false, undefined, { replaceChanged: true }); await prepareBackups(root, files, journal); await applyFiles(files, journal);
  journal.verified = true;
  const originalBackup = journal.entries[0].backup!;
  await writeFile(path, 'later user bytes');
  files = [{ path, bytes: Buffer.from('installed-2'), expected: digest(Buffer.from('installed-1')), collision: 'clone' }];
  await validateFiles(files, journal, false, undefined, { replaceChanged: true }); await prepareBackups(root, files, journal); await applyFiles(files, journal);
  const saved = await readJournal(root);
  expect(saved.entries[0]).toMatchObject({ previous: [expect.objectContaining({ backup: originalBackup, before: digest(Buffer.from('original')) })] });
  expect(await readFile(originalBackup, 'utf8')).toBe('original');
  await rollbackFiles(root, saved);
  expect(await readFile(path, 'utf8')).toBe('later user bytes');
});

test('restoring backed-up user bytes after verification requires explicit replacement again', async () => {
  const { root, journal } = await fixture(), path = join(root, 'mod.js');
  await writeFile(path, 'user bytes');
  const files: InstallFile[] = [{ path, bytes: Buffer.from('installed'), expected: null, collision: 'clone' }];
  await validateFiles(files, journal, false, undefined, { replaceChanged: true }); await prepareBackups(root, files, journal); await applyFiles(files, journal);
  journal.verified = true; await writeFile(path, 'user bytes');
  const repeated: InstallFile[] = [{ path, bytes: Buffer.from('installed'), expected: digest(Buffer.from('installed')), collision: 'clone' }];
  await expect(validateFiles(repeated, journal)).rejects.toMatchObject({ code: 'unowned-clone-collision' });
  expect(await readFile(path, 'utf8')).toBe('user bytes');
});
