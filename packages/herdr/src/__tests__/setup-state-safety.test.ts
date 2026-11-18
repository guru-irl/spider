// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { applyFiles, atomicWrite, digest, managedProjection, prepareBackups, readJournal, rollbackFiles, saveJournal, validateFiles } from '../setup/backup.js';
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

const appPaths = { kind: 'json-paths', paths: ['theme', 'layout', 'sounds.enabled'] } as const;
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

test('migrates the old settings projection and restores each recorded baseline', async () => {
  const { root, journal } = await fixture(), path = join(root, 'settings.json');
  const original = { theme: 'stock', layout: 'main', zoom: 1.25 }, oldInstalled = { ...original, theme: 'spider-glass', layout: 'spider-glass' };
  await writeFile(path, json(original));
  const old: InstallFile = { path, expected: digest(json(original)), bytes: json(oldInstalled), managed: { kind: 'json', fields: ['theme', 'layout'] } };
  await validateFiles([old], journal); await prepareBackups(root, [old], journal); await applyFiles(root, [old], journal);
  journal.verified = true;
  const edited = { ...oldInstalled, sounds: { enabled: true, done: 'custom-done.mp3', blocked: 'custom-blocked.mp3' } };
  await writeFile(path, json(edited));
  const installed = { ...edited, sounds: { ...edited.sounds, enabled: false } };
  const next: InstallFile = { path, expected: digest(json(edited)), bytes: json(installed), managed: appPaths };
  await validateFiles([next], journal); await prepareBackups(root, [next], journal); await applyFiles(root, [next], journal);
  const saved = await readJournal(root);
  expect(saved.entries).toHaveLength(1);
  expect(saved.entries[0].managed).toEqual(appPaths);
  expect(saved.entries[0].previous).toHaveLength(1);
  await rollbackFiles(root, saved);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...original, sounds: edited.sounds });
});

test('releases a user-edited theme and restores owned paths without reformatting', async () => {
  const { root, journal } = await fixture(), path = join(root, 'settings.json');
  const original = '{\n  "zoom" : 1.25,\n  "theme" : "stock",\n  "layout"  : "main",\n  "sounds" : { "done" : "custom.mp3", "enabled" : true },\n  "extra" : [1, 2]\n}\n';
  const installed = original.replace('"stock"', '"spider-glass"').replace('"main"', '"spider-glass"').replace('"enabled" : true', '"enabled" : false');
  await writeFile(path, original);
  const file: InstallFile = { path, expected: digest(Buffer.from(original)), bytes: Buffer.from(installed), managed: appPaths };
  await validateFiles([file], journal); await prepareBackups(root, [file], journal); await applyFiles(root, [file], journal);
  journal.verified = true; await saveJournal(root, journal);
  const edited = installed.replace('"theme" : "spider-glass"', '"theme" : "user-theme"'); await writeFile(path, edited);
  const expected = edited.replace('"layout"  : "spider-glass"', '"layout"  : "main"').replace('"enabled" : false', '"enabled" : true');
  const warnings: string[] = []; await rollbackFiles(root, journal, { warn: message => warnings.push(message) });
  expect(await readFile(path, 'utf8')).toBe(expected);
  expect(warnings).toContainEqual(expect.stringMatching(/theme.*released|released.*theme/));
  expect(journal.entries).toEqual([]);
  expect(await rollbackFiles(root, journal)).toEqual([]);
  expect(await readFile(path, 'utf8')).toBe(expected);
});

test('rolls back still-owned settings paths without overwriting a later sound edit', async () => {
  const { root, journal } = await fixture(), path = join(root, 'settings.json');
  const original = { theme: 'stock', layout: 'main', sounds: { done: 'custom.mp3' } };
  const installed = { theme: 'spider-glass', layout: 'spider-glass', sounds: { done: 'custom.mp3', enabled: false } };
  await writeFile(path, json(original));
  const file: InstallFile = { path, expected: digest(json(original)), bytes: json(installed), managed: appPaths };
  await validateFiles([file], journal); await prepareBackups(root, [file], journal); await applyFiles(root, [file], journal);
  journal.verified = true; await saveJournal(root, journal);
  await writeFile(path, json({ ...installed, sounds: { ...installed.sounds, enabled: true, blocked: 'later.mp3' } }));
  const warnings: string[] = []; await rollbackFiles(root, journal, { warn: message => warnings.push(message) });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...original, sounds: { done: 'custom.mp3', enabled: true, blocked: 'later.mp3' } });
  expect(warnings).toContainEqual(expect.stringMatching(/sounds\.enabled.*released|released.*sounds\.enabled/));
  expect(journal.entries).toEqual([]);
  const after = await readFile(path);
  expect(await rollbackFiles(root, journal)).toEqual([]);
  expect(await readFile(path)).toEqual(after);
});

test('recovers a partial theme transition only after the sound compare-write', async () => {
  const { root, journal } = await fixture(), path = join(root, 'settings.json');
  const original = { theme: 'stock', layout: 'main', sounds: { done: 'custom.mp3' } };
  const prewrite = { ...original, sounds: { ...original.sounds, enabled: false } };
  const transition = { path, planned: { theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false as const } } };
  await writeFile(path, json(original));
  const file: InstallFile = { path, expected: digest(json(original)), bytes: json(prewrite), managed: appPaths, updateAfterCutover: true };
  await validateFiles([file], journal, false, transition); await prepareBackups(root, [file], journal); await applyFiles(root, [file], journal);
  journal.cutoverPending = true; await saveJournal(root, journal);
  const partial = { ...prewrite, theme: 'spider-glass' }; await writeFile(path, json(partial));
  const retry: InstallFile = { ...file, expected: digest(json(partial)), bytes: json(partial) };
  await expect(validateFiles([retry], journal, false, transition)).resolves.toBeDefined();
  await rollbackFiles(root, journal, { appSettings: transition });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(original);
});

test('releases a sound edit while restoring an interrupted theme transition', async () => {
  const { root, journal } = await fixture(), path = join(root, 'settings.json');
  const original = '{\n  "theme" : "stock",\n  "layout" : "main",\n  "sounds" : { "done" : "custom.mp3" },\n  "other" : [1, 2]\n}\n';
  const prewrite = original.replace('"custom.mp3"', '"custom.mp3", "enabled" : false');
  const transition = { path, planned: { theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false as const } } };
  await writeFile(path, original);
  const file: InstallFile = { path, expected: digest(Buffer.from(original)), bytes: Buffer.from(prewrite), managed: appPaths, updateAfterCutover: true };
  await validateFiles([file], journal, false, transition); await prepareBackups(root, [file], journal); await applyFiles(root, [file], journal);
  journal.cutoverPending = true; await saveJournal(root, journal);
  const edited = prewrite.replace('"stock"', '"spider-glass"').replace('"enabled" : false', '"enabled" : true');
  await writeFile(path, edited);
  const warnings: string[] = []; await rollbackFiles(root, journal, { appSettings: transition, warn: message => warnings.push(message) });
  const expected = edited.replace('"spider-glass"', '"stock"');
  expect(await readFile(path, 'utf8')).toBe(expected);
  expect(warnings).toContainEqual(expect.stringMatching(/sounds\.enabled.*released|released.*sounds\.enabled/));
  expect(journal.entries).toEqual([]);
  expect(await rollbackFiles(root, journal, { appSettings: transition })).toEqual([]);
  expect(await readFile(path, 'utf8')).toBe(expected);
});

test('releases a planned sound value without proof of the compare-write', async () => {
  const { root, journal } = await fixture(), path = join(root, 'settings.json');
  const original = '{"theme":"stock","layout":"main","sounds":{"enabled":true},"note":"keep"}';
  const planned = original.replace('true', 'false');
  const transition = { path, planned: { theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false as const } } };
  await writeFile(path, original);
  const file: InstallFile = { path, expected: digest(Buffer.from(original)), bytes: Buffer.from(planned), managed: appPaths, updateAfterCutover: true };
  await validateFiles([file], journal, false, transition); await prepareBackups(root, [file], journal);
  const edited = planned.replace('"keep"', '"user edit"'); await writeFile(path, edited);
  const warnings: string[] = []; await rollbackFiles(root, journal, { appSettings: transition, warn: message => warnings.push(message) });
  expect(await readFile(path, 'utf8')).toBe(edited);
  expect(warnings).toContainEqual(expect.stringMatching(/sounds\.enabled.*released|released.*sounds\.enabled/));
  expect(journal.entries).toEqual([]);
});

test('refuses an unowned sound edit during a partial app transition', async () => {
  const { root, journal } = await fixture(), path = join(root, 'settings.json');
  const original = { theme: 'stock', layout: 'main', sounds: { done: 'custom.mp3' } };
  const prewrite = { ...original, sounds: { ...original.sounds, enabled: false } };
  const transition = { path, planned: { theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false as const } } };
  await writeFile(path, json(original));
  const file: InstallFile = { path, expected: digest(json(original)), bytes: json(prewrite), managed: appPaths, updateAfterCutover: true };
  await validateFiles([file], journal, false, transition); await prepareBackups(root, [file], journal); await applyFiles(root, [file], journal);
  journal.cutoverPending = true; await saveJournal(root, journal);
  const changed = { ...prewrite, theme: 'spider-glass', sounds: { ...prewrite.sounds, enabled: true } }; await writeFile(path, json(changed));
  const retry: InstallFile = { ...file, expected: digest(json(changed)), bytes: json({ ...changed, sounds: { ...changed.sounds, enabled: false } }) };
  await expect(validateFiles([retry], journal, false, transition)).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  await expect(validateFiles([retry], journal, false, transition, { replaceChanged: true })).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(changed);
  const warnings: string[] = []; await rollbackFiles(root, journal, { appSettings: transition, warn: message => warnings.push(message) });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...original, sounds: { ...original.sounds, enabled: true } });
  expect(journal.entries).toEqual([]);
  expect(warnings).toContainEqual(expect.stringMatching(/sounds\.enabled.*released|released.*sounds\.enabled/));
});

test('refuses an unowned sound edit while migrating an unfinished legacy selection', async () => {
  const { root, journal } = await fixture(), path = join(root, 'settings.json');
  const original = { theme: 'stock', layout: 'main' }, oldInstalled = { theme: 'spider-glass', layout: 'spider-glass' };
  await writeFile(path, json(original));
  const old: InstallFile = { path, expected: digest(json(original)), bytes: json(oldInstalled), managed: { kind: 'json', fields: ['theme', 'layout'] } };
  await validateFiles([old], journal); await prepareBackups(root, [old], journal); await applyFiles(root, [old], journal);
  const changed = { ...oldInstalled, sounds: { enabled: true } }; await writeFile(path, json(changed));
  const next: InstallFile = { path, expected: digest(json(changed)), bytes: json({ ...changed, sounds: { enabled: false } }), managed: appPaths, updateAfterCutover: true };
  const transition = { path, planned: { theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false as const } } };
  await expect(validateFiles([next], journal, false, transition)).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  await expect(validateFiles([next], journal, false, transition, { replaceChanged: true })).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(changed);
});

test('rollback leaves saved migrated state and completes without owning either store', async () => {
  const { root, journal } = await fixture(), { source, destination, files } = await migration(root);
  await validateFiles(files, journal); await prepareBackups(root, files, journal); await applyFiles(root, files, journal);
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
  await prepareBackups(root, files, journal); await applyFiles(root, files, journal);
  expect(await readFile(destination, 'utf8')).toBe('{"timer":"99"}');
  expect((await readJournal(root)).entries).toEqual([]);
});

test('a store created at publication wins the exclusive-create race', async () => {
  const { root, journal } = await fixture(), { destination, files } = await migration(root);
  await validateFiles(files, journal); await prepareBackups(root, files, journal);
  const race = async (to: PathLike) => { if (to === destination) await writeFile(destination, '{"timer":"99"}'); };
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { await race(to); return realFs.rename(from, to); });
  vi.mocked(fs.link).mockImplementation(async (from, to) => { await race(to); return realFs.link(from, to); });
  await applyFiles(root, files, journal);
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
  await validateFiles(files, journal, false, undefined, { replaceChanged: true }); await prepareBackups(root, files, journal); await applyFiles(root, files, journal);
  journal.verified = true;
  const originalBackup = journal.entries[0].backup!;
  await writeFile(path, 'later user bytes');
  files = [{ path, bytes: Buffer.from('installed-2'), expected: digest(Buffer.from('installed-1')), collision: 'clone' }];
  await validateFiles(files, journal, false, undefined, { replaceChanged: true }); await prepareBackups(root, files, journal); await applyFiles(root, files, journal);
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
  await validateFiles(files, journal, false, undefined, { replaceChanged: true }); await prepareBackups(root, files, journal); await applyFiles(root, files, journal);
  journal.verified = true; await writeFile(path, 'user bytes');
  const repeated: InstallFile[] = [{ path, bytes: Buffer.from('installed'), expected: digest(Buffer.from('installed')), collision: 'clone' }];
  await expect(validateFiles(repeated, journal)).rejects.toMatchObject({ code: 'unowned-clone-collision' });
  expect(await readFile(path, 'utf8')).toBe('user bytes');
});
