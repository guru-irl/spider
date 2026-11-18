// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { applyFiles, digest, prepareBackups, prepareModDirectories, readJournal, rollbackFiles, rollbackModDirectories } from '../setup/backup.js';
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
async function fixture() {
  const client = await createClientFixture();
  const home = join(client.root, 'app-home'), root = join(client.root, 'setup'), mods = join(home, 'mods'), directory = join(mods, 'spider-example');
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
    await applyFiles(f.files, journal);
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter(state => state['spider-example'] && !state['spider-example'].includes('mod.json'))).toEqual([]);
    expect(await fs.readdir(f.directory)).toEqual(['helper.js', 'main.js', 'mod.json']);
  } finally { await f.client.close(); }
});

test('an interrupted publish stays invisible and the next run completes it', async () => {
  const f = await fixture();
  try {
    const journal = await readJournal(f.root);
    await prepareBackups(f.root, f.files, journal);
    await prepareModDirectories(f.root, f.home, f.files, journal);
    vi.mocked(fs.rename).mockImplementation(async (from, to) => { if (to === f.directory) throw new Error('interrupted publish'); return real.rename(from, to); });
    await expect(applyFiles(f.files, journal)).rejects.toThrow('interrupted publish');
    expect(await real.readdir(f.mods)).toEqual([]);
    vi.mocked(fs.rename).mockImplementation(real.rename);
    const recovered = await readJournal(f.root);
    await prepareModDirectories(f.root, f.home, f.files, recovered);
    await applyFiles(f.files, recovered);
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
    await expect(applyFiles(f.files, journal)).rejects.toThrow('interrupted publish');
    vi.mocked(fs.rename).mockImplementation(real.rename);
    const recovered = await readJournal(f.root);
    await rollbackFiles(f.root, recovered); await rollbackModDirectories(f.home, recovered);
    expect(await real.readdir(f.mods)).toEqual([]);
    expect((await real.readdir(f.home)).filter(name => name.startsWith('.spider-mod-'))).toEqual([]);
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
    await prepareBackups(f.root, files, journal); await prepareModDirectories(f.root, f.home, files, journal); await applyFiles(files, journal);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(manifest => manifest === '{"place":"none"}')).toBe(true);
  } finally { await f.client.close(); }
});
