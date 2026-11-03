// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { applyFiles, digest, prepareBackups, readJournal, rollbackFiles, validateFiles } from '../setup/backup.js';
import type { InstallFile } from '../setup/installer.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const parent = resolve(process.env.SPIDER_GLOBAL_ROOT!, 'setup-adopt');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')); roots.push(root);
  return { root, journal: await readJournal(root) };
}

test('identical unowned bytes become owned and rollback preserves the adopted file', async () => {
  const { root, journal } = await fixture(), path = join(root, 'mod.js');
  await writeFile(path, 'planned');
  const files: InstallFile[] = [{ path, bytes: Buffer.from('planned'), expected: null, collision: 'clone' }];
  await validateFiles(files, journal);
  await prepareBackups(root, files, journal);
  expect(await applyFiles(files, journal)).toEqual([]);
  const entry = (await readJournal(root)).entries[0];
  expect(entry).toMatchObject({ path, before: digest(Buffer.from('planned')), after: digest(Buffer.from('planned')) });
  expect(await readFile(entry.backup!, 'utf8')).toBe('planned');
  await rollbackFiles(root, journal);
  expect(await readFile(path, 'utf8')).toBe('planned');
});

test('identical bytes replace stale ownership while retaining the original rollback baseline', async () => {
  const { root, journal } = await fixture(), path = join(root, 'mod.js');
  await writeFile(path, 'original');
  const files: InstallFile[] = [{ path, bytes: Buffer.from('old'), expected: digest(Buffer.from('original')), collision: 'clone' }];
  await validateFiles(files, journal); await prepareBackups(root, files, journal); await applyFiles(files, journal);
  await writeFile(path, 'new');
  files[0] = { path, bytes: Buffer.from('new'), expected: digest(Buffer.from('old')), collision: 'clone' };
  await validateFiles(files, journal); await prepareBackups(root, files, journal);
  expect(journal.entries[0].after).toBe(digest(Buffer.from('new')));
  await rollbackFiles(root, journal);
  expect(await readFile(path, 'utf8')).toBe('original');
});

test('all changed targets are listed with an explicit replacement option before any backup', async () => {
  const { root, journal } = await fixture();
  const files = await Promise.all(['one.js', 'two.js'].map(async name => {
    const path = join(root, name); await writeFile(path, 'user edit');
    return { path, bytes: Buffer.from('planned'), expected: null, collision: 'clone' as const };
  }));
  const error = await validateFiles(files, journal).then(() => null, error => error);
  expect(error.message).toContain(files[0].path);
  expect(error.message).toContain(files[1].path);
  expect(error.message).toContain('--replace-changed');
  expect((await readJournal(root)).entries).toEqual([]);
});

test.each([false, true])('replacement saves the current user bytes for rollback, prior ownership %s', async owned => {
  const { root, journal } = await fixture(), path = join(root, 'mod.js');
  const files: InstallFile[] = [{ path, bytes: Buffer.from('old'), expected: null, collision: 'clone' }];
  if (owned) { await validateFiles(files, journal); await prepareBackups(root, files, journal); await applyFiles(files, journal); }
  await writeFile(path, 'user edit');
  files[0] = { path, bytes: Buffer.from('planned'), expected: owned ? digest(Buffer.from('old')) : null, collision: 'clone' };
  await validateFiles(files, journal, false, undefined, { replaceChanged: true });
  await prepareBackups(root, files, journal); await applyFiles(files, journal);
  const entry = (await readJournal(root)).entries[0];
  expect(await readFile(entry.backup!, 'utf8')).toBe('user edit');
  expect(await readFile(path, 'utf8')).toBe('planned');
  await rollbackFiles(root, journal);
  expect(await readFile(path, 'utf8')).toBe('user edit');
});

test('snapshot-only plans do not adopt changed app selections as intended bytes', async () => {
  const { root, journal } = await fixture(), path = join(root, 'settings.json');
  await writeFile(path, '{"theme":"original"}');
  const files: InstallFile[] = [{ path, bytes: Buffer.from('{"theme":"installed"}'), expected: digest(Buffer.from('{"theme":"original"}')), managed: { kind: 'json', fields: ['theme'] } }];
  await validateFiles(files, journal); await prepareBackups(root, files, journal); await applyFiles(files, journal);
  journal.verified = true;
  await writeFile(path, '{"theme":"user-choice"}');
  files[0] = { path, bytes: Buffer.from('{"theme":"user-choice"}'), expected: digest(Buffer.from('{"theme":"user-choice"}')), snapshotOnly: true, managed: { kind: 'json', fields: ['theme'] } };
  await expect(validateFiles(files, journal)).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  expect(await validateFiles(files, journal, false, undefined, { planOnly: true })).toEqual([expect.objectContaining({ action: 'replace' })]);
  await validateFiles(files, journal, false, undefined, { replaceChanged: true }); await prepareBackups(root, files, journal);
  expect(await readFile(journal.entries[0].backup!, 'utf8')).toBe('{"theme":"user-choice"}');
});

test('managed replacements restore the user values and preserve later unrelated edits', async () => {
  const { root, journal } = await fixture(), path = join(root, 'settings.json');
  await writeFile(path, '{"theme":"original","other":1}');
  const files: InstallFile[] = [{ path, bytes: Buffer.from('{"theme":"installed","other":1}'), expected: digest(Buffer.from('{"theme":"original","other":1}')), managed: { kind: 'json', fields: ['theme'] } }];
  await validateFiles(files, journal); await prepareBackups(root, files, journal); await applyFiles(files, journal); journal.verified = true;
  await writeFile(path, '{"theme":"user-choice","other":2}');
  files[0] = { path, bytes: Buffer.from('{"theme":"installed","other":2}'), expected: digest(Buffer.from('{"theme":"user-choice","other":2}')), managed: { kind: 'json', fields: ['theme'] } };
  await validateFiles(files, journal, false, undefined, { replaceChanged: true });
  await prepareBackups(root, files, journal); await applyFiles(files, journal);
  await writeFile(path, '{"theme":"installed","other":3}');
  await rollbackFiles(root, journal);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ theme: 'user-choice', other: 3 });
});

test('an edit after replacement authorization still refuses instead of overwriting it', async () => {
  const { root, journal } = await fixture(), path = join(root, 'mod.js');
  await writeFile(path, 'user edit');
  const files: InstallFile[] = [{ path, bytes: Buffer.from('planned'), expected: null, collision: 'clone' }];
  await validateFiles(files, journal, false, undefined, { replaceChanged: true });
  await writeFile(path, 'later edit');
  await expect(prepareBackups(root, files, journal)).rejects.toMatchObject({ code: 'concurrent-settings-edit' });
  expect(await readFile(path, 'utf8')).toBe('later edit');
});
