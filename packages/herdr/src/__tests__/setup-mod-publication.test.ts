// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { atomicWrite, applyFiles, digest, prepareBackups, prepareModDirectories, readJournal, rollbackFiles, rollbackModDirectories } from '../setup/backup.js';
import { createClientFixture } from './testutil.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), rename: vi.fn(actual.rename), link: vi.fn(actual.link), unlink: vi.fn(actual.unlink) };
});
const real = await vi.importActual<typeof fs>('node:fs/promises');
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ['mkdir', 'rename', 'link', 'unlink'] as const) vi.mocked(fs[name]).mockImplementation(real[name] as never);
});
async function fixture(modId = 'spider-example') {
  const client = await createClientFixture();
  const home = join(client.root, 'app-home'), root = join(client.root, 'setup'), mods = join(home, 'mods'), directory = join(mods, modId);
  await fs.mkdir(mods, { recursive: true });
  const files = [
    { path: join(directory, 'helper.js'), expected: null, bytes: Buffer.from('export const value = 2;') },
    { path: join(directory, 'main.js'), expected: null, bytes: Buffer.from('import "./helper.js";') },
    { path: join(directory, 'mod.json'), expected: null, bytes: Buffer.from('{"place":"none"}') },
  ];
  return { client, home, root, mods, directory, files };
}
// Deliberately observe every filesystem publication boundary, not a debounced OS watch.
function watch(mods: string) {
  const states: Record<string, string[]>[] = [];
  const record = async () => {
    const state: Record<string, string[]> = {};
    for (const name of await real.readdir(mods).catch(() => [])) {
      if (name.startsWith('.')) continue;
      if ((await real.lstat(join(mods, name))).isDirectory()) state[name] = await real.readdir(join(mods, name));
    }
    states.push(state);
  };
  for (const name of ['mkdir', 'rename', 'link', 'unlink'] as const) {
    const original = real[name] as (...args: any[]) => Promise<any>;
    vi.mocked(fs[name]).mockImplementation((async (...args: any[]) => { const result = await original(...args); await record(); return result; }) as never);
  }
  return states;
}

test('a watcher never sees a newly published mod without its manifest', async () => {
  const f = await fixture();
  try {
    const states = watch(f.mods), journal = await readJournal(f.root);
    await prepareBackups(f.root, f.files, journal);
    await prepareModDirectories(f.root, f.home, f.files, journal);
    await applyFiles(f.root, f.files, journal);
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter(state => state['spider-example'] && !state['spider-example'].includes('mod.json'))).toEqual([]);
    expect(await fs.readdir(f.directory)).toEqual(['helper.js', 'main.js', 'mod.json']);
  } finally { await f.client.close(); }
});

test('a validated mod name without the spider prefix is also published complete', async () => {
  const f = await fixture('custom-widget');
  try {
    const states = watch(f.mods), journal = await readJournal(f.root);
    await prepareBackups(f.root, f.files, journal); await prepareModDirectories(f.root, f.home, f.files, journal); await applyFiles(f.root, f.files, journal);
    expect(states.filter(state => state['custom-widget'] && !state['custom-widget'].includes('mod.json'))).toEqual([]);
    expect(await fs.readdir(f.directory)).toEqual(['helper.js', 'main.js', 'mod.json']);
    await rollbackFiles(f.root, journal); await rollbackModDirectories(f.home, journal);
    expect(await real.readdir(f.mods)).toEqual([]);
  } finally { await f.client.close(); }
});

test('an interrupted publish stays invisible and the next run completes it', async () => {
  const f = await fixture();
  try {
    const journal = await readJournal(f.root);
    await prepareBackups(f.root, f.files, journal);
    await prepareModDirectories(f.root, f.home, f.files, journal);
    vi.mocked(fs.rename).mockImplementation(async (from, to) => { if (to === f.directory) throw new Error('interrupted publish'); return real.rename(from, to); });
    await expect(applyFiles(f.root, f.files, journal)).rejects.toThrow('interrupted publish');
    expect(await real.readdir(f.mods)).toEqual([]);
    vi.mocked(fs.rename).mockImplementation(real.rename);
    const recovered = await readJournal(f.root);
    await prepareModDirectories(f.root, f.home, f.files, recovered);
    await applyFiles(f.root, f.files, recovered);
    expect(await fs.readFile(join(f.directory, 'mod.json'), 'utf8')).toBe('{"place":"none"}');
    await rollbackFiles(f.root, recovered); await rollbackModDirectories(f.home, recovered);
    expect(await real.readdir(f.mods)).toEqual([]);
  } finally { await f.client.close(); }
});

test('rollback removes owned staging files after an interrupted publish', async () => {
  const f = await fixture();
  try {
    const journal = await readJournal(f.root);
    await prepareBackups(f.root, f.files, journal); await prepareModDirectories(f.root, f.home, f.files, journal);
    vi.mocked(fs.rename).mockImplementation(async (from, to) => { if (to === f.directory) throw new Error('interrupted publish'); return real.rename(from, to); });
    await expect(applyFiles(f.root, f.files, journal)).rejects.toThrow('interrupted publish');
    vi.mocked(fs.rename).mockImplementation(real.rename);
    const recovered = await readJournal(f.root);
    await rollbackFiles(f.root, recovered); await rollbackModDirectories(f.home, recovered);
    expect(await real.readdir(f.mods)).toEqual([]);
    expect((await real.readdir(f.home)).filter(name => name.startsWith('.spider-mod-'))).toEqual([]);
  } finally { await f.client.close(); }
});

test('a staging allocation interrupted before identity persistence is recovered without an orphan', async () => {
  const f = await fixture();
  try {
    const journal = await readJournal(f.root);
    await prepareBackups(f.root, f.files, journal);
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === join(f.root, 'journal.json') && (await real.readdir(f.home)).some(name => name.startsWith('.spider-mod-'))) throw new Error('allocation interrupted');
      return real.rename(from, to);
    });
    await expect(prepareModDirectories(f.root, f.home, f.files, journal)).rejects.toThrow('allocation interrupted');
    vi.mocked(fs.rename).mockImplementation(real.rename);
    const recovered = await readJournal(f.root);
    await prepareModDirectories(f.root, f.home, f.files, recovered); await applyFiles(f.root, f.files, recovered);
    expect((await real.readdir(f.home)).filter(name => name.startsWith('.spider-mod-'))).toEqual([]);
    expect(await real.readFile(join(f.directory, 'mod.json'), 'utf8')).toBe('{"place":"none"}');
  } finally { await f.client.close(); }
});

test('an unowned staging file is never published as part of a mod', async () => {
  const f = await fixture();
  try {
    const journal = await readJournal(f.root);
    await prepareBackups(f.root, f.files, journal); await prepareModDirectories(f.root, f.home, f.files, journal);
    const staging = (await real.readdir(f.home)).find(name => name.startsWith('.spider-mod-'))!;
    await real.writeFile(join(f.home, staging, 'unowned.js'), 'user file');
    await expect(applyFiles(f.root, f.files, journal)).rejects.toMatchObject({ code: 'mod-publication-conflict' });
    expect(await real.readdir(f.mods)).toEqual([]);
    expect(await real.readFile(join(f.home, staging, 'unowned.js'), 'utf8')).toBe('user file');
  } finally { await f.client.close(); }
});

test('an existing mod receives its placement manifest before executable updates', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.directory);
    await fs.writeFile(join(f.directory, 'main.js'), 'old');
    await fs.writeFile(join(f.directory, 'mod.json'), '{"place":"right"}');
    const files = await Promise.all(f.files.map(async file => ({ ...file, expected: await real.readFile(file.path).then(digest, () => null) })));
    const journal = await readJournal(f.root), seen: string[] = [];
    for (const name of ['rename', 'link'] as const) vi.mocked(fs[name]).mockImplementation(async (from, to) => {
      await real[name](from, to);
      if (await real.readFile(join(f.directory, 'main.js'), 'utf8') !== 'old') seen.push(await real.readFile(join(f.directory, 'mod.json'), 'utf8'));
    });
    await prepareBackups(f.root, files, journal); await prepareModDirectories(f.root, f.home, files, journal); await applyFiles(f.root, files, journal);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(manifest => manifest === '{"place":"none"}')).toBe(true);
  } finally { await f.client.close(); }
});


test('successful publication clears its staging record immediately', async () => {
  const f = await fixture();
  try {
    const journal = await readJournal(f.root);
    await prepareBackups(f.root, f.files, journal); await prepareModDirectories(f.root, f.home, f.files, journal); await applyFiles(f.root, f.files, journal);
    expect(journal.modStages ?? []).toEqual([]);
    expect((await readJournal(f.root)).modStages ?? []).toEqual([]);
  } finally { await f.client.close(); }
});

test('full rollback unpublishes before removing a manifest or executable', async () => {
  const f = await fixture();
  try {
    const journal = await readJournal(f.root);
    await prepareBackups(f.root, f.files, journal); await prepareModDirectories(f.root, f.home, f.files, journal); await applyFiles(f.root, f.files, journal);
    const states = watch(f.mods);
    await rollbackFiles(f.root, journal); await rollbackModDirectories(f.home, journal);
    expect(states.filter(state => state['spider-example']?.includes('main.js') && !state['spider-example'].includes('mod.json'))).toEqual([]);
    expect(await real.readdir(f.mods)).toEqual([]);
  } finally { await f.client.close(); }
});


test('new setup writes respect a private umask', async () => {
  const f = await fixture(), previous = process.umask(0o077);
  try {
    await atomicWrite(join(f.home, 'private.json'), Buffer.from('{}'), 0o644, null);
    expect((await fs.stat(join(f.home, 'private.json'))).mode & 0o777).toBe(0o600);
  } finally { process.umask(previous); await f.client.close(); }
});


test('unpublication verifies the renamed inode before deleting the directory', async () => {
  const f = await fixture();
  try {
    const journal = await readJournal(f.root);
    await prepareBackups(f.root, f.files, journal); await prepareModDirectories(f.root, f.home, f.files, journal); await applyFiles(f.root, f.files, journal);
    let impostor: string | undefined;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      await real.rename(from, to);
      if (from === f.directory) {
        impostor = String(to);
        await real.rename(to, String(to) + '-kept'); await real.mkdir(to); await real.writeFile(join(String(to), 'user.txt'), 'do not delete');
      }
    });
    await expect(rollbackFiles(f.root, journal)).rejects.toMatchObject({ code: 'mod-unpublication-conflict' });
    expect(await real.readFile(join(impostor!, 'user.txt'), 'utf8')).toBe('do not delete');
    expect(await real.readFile(join(impostor! + '-kept', 'main.js'), 'utf8')).toBe('import "./helper.js";');
  } finally { await f.client.close(); }
});
