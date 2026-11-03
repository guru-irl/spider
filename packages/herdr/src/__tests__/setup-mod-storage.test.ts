// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { applyFiles, prepareBackups, readJournal, validateFiles } from '../setup/backup.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const load = () => import('../setup/mod-storage.js').catch(() => null);

test.each([
  [null, 'store.json'],
  [{}, 'store-5477a4babbc26733.json'],
  [{ a: 1 }, 'store-ce95b977d32344d8.json'],
  [{ b: 2, a: 1 }, 'store-9f21b4f9e3d4d883.json'],
  [{ label: 'café' }, 'store-d32becfea1b87b9a.json'],
])('matches Herdr store naming for props %j', async (props, expected) => {
  expect((await load())?.modStoreFileName(props)).toBe(expected);
});

test('changed props copy saved state to the new store without replacing existing state', async () => {
  const parent = resolve(process.env.SPIDER_GLOBAL_ROOT!, 'mod-storage'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')); roots.push(root);
  const data = join(root, 'data/spider-agents'); await mkdir(data, { recursive: true });
  const oldStore = join(data, 'store-94630e0b396dc745.json'), newStore = join(data, 'store-97d9d849eea9eed8.json');
  const bytes = '{"folded":"[\"example\"]","timer":"42"}'; await writeFile(oldStore, bytes);
  const layout = (path: string) => Buffer.from(JSON.stringify({ content: { mod: 'spider-agents', props: { path } } }));
  const mod = await load();
  const files = await mod?.planModStorage(root, layout('/path/to/old'), layout('/path/to/new'));
  expect(files?.map(file => file.path)).toEqual([newStore]);
  const journal = await readJournal(join(root, 'setup'));
  await validateFiles(files!, journal); await prepareBackups(join(root, 'setup'), files!, journal); await applyFiles(files!, journal);
  expect(await readFile(newStore, 'utf8')).toBe(bytes);
  expect(await readFile(oldStore, 'utf8')).toBe(bytes);
  await writeFile(newStore, '{"timer":"99"}');
  expect(await mod!.planModStorage(root, layout('/path/to/old'), layout('/path/to/new'))).toEqual([]);
  expect(await readFile(newStore, 'utf8')).toBe('{"timer":"99"}');
});
