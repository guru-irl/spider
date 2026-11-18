// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { applyFiles, prepareBackups, prepareModDirectories, readJournal, rollbackFiles, rollbackModDirectories } from '../setup/backup.js';
import { createClientFixture } from './testutil.js';

test('rollback leaves a replacement directory untouched', async () => {
  const f = await createClientFixture();
  try {
    const home = join(f.root, 'app-home'), mods = join(home, 'mods'), directory = join(mods, 'spider-example');
    const root = join(f.root, 'journal'), path = join(directory, 'main.js');
    await mkdir(mods, { recursive: true });
    const journal = await readJournal(root), files = [{ path, expected: null, bytes: Buffer.from('installed') }, { path: join(directory, 'mod.json'), expected: null, bytes: Buffer.from('{"place":"none"}') }];
    await prepareBackups(root, files, journal); await prepareModDirectories(root, home, files, journal); await applyFiles(root, files, journal);
    await rename(directory, join(mods, 'moved')); await mkdir(directory);
    await rollbackFiles(root, journal); await rollbackModDirectories(home, journal);
    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(journal.modDirectories).toBeUndefined();
  } finally { await f.close(); }
});

test('rollback refuses a recorded directory outside the managed mods root', async () => {
  const f = await createClientFixture();
  try {
    const home = join(f.root, 'app-home'), outside = join(f.root, 'outside');
    await mkdir(outside);
    const info = await stat(outside), journal = await readJournal(join(f.root, 'journal'));
    journal.modDirectories = [{ path: outside, dev: info.dev, ino: info.ino }];
    await expect(rollbackModDirectories(home, journal)).rejects.toMatchObject({ code: 'setup-journal-invalid' });
    expect((await stat(outside)).isDirectory()).toBe(true);
  } finally { await f.close(); }
});
