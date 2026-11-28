// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { doctorHerdr } from '../../../herdr/src/setup/doctor.js';
import { digest } from '../../../herdr/src/setup/backup.js';
import { cleanup } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { editUnrelated, installedModFiles } from './herdr-setup-production-helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();

test('semantic pi and app saves preserve bytes and journal without another cutover', async () => {
  const f = await fastFixture(); const cutover = vi.spyOn(f.parts, 'cutover');
  await setupHerdr(f.request, f.parts); await editUnrelated(f);
  const app = join(f.h.directories.app, 'settings.json');
  await writeFile(app, JSON.stringify({ ...JSON.parse(await readFile(app, 'utf8')), zoom: 2 }, null, 4));
  const shared = [join(f.h.directories.agent, 'settings.json'), app, join(f.h.directories.app, 'keys.json'), f.request.config.shellRc, f.request.config.core.config];
  const bytes = await Promise.all(shared.map(path => readFile(path)));
  const journal = await readFile(join(f.request.journalRoot, 'journal.json'));
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
  expect(cutover).toHaveBeenCalledTimes(1);
  expect(await Promise.all(shared.map(path => readFile(path)))).toEqual(bytes);
  expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(journal);
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(shared[0], 'utf8'))).toEqual({ theme: 'stock', unrelated: 'edited' });
});

test('an artifact-only upgrade does not repeat a settled cutover', async () => {
  const f = await fastFixture(); const cutover = vi.spyOn(f.parts, 'cutover');
  await setupHerdr(f.request, f.parts);
  const source = join(f.root, 'packages/herdr/assets/mods/spider/main.js');
  await writeFile(source, (await readFile(source, 'utf8')) + '\n// updated panel\n');
  expect((await setupHerdr(f.request, f.parts)).writes).toContain(join(f.h.directories.app, 'mods/spider-panel/main.js'));
  expect(cutover).toHaveBeenCalledTimes(1);
});
