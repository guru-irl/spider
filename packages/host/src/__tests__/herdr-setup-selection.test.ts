// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, saveJournal } from '../../../herdr/src/setup/backup.js';
import { cleanup, type SetupFixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { fingerprint, interruptSelection } from './herdr-setup-selection-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();



test.each(['theme', 'layout'])('interrupted setup refuses a foreign %s value before any installation write', async field => {
  const { f, settings, original, shared, originalShared } = await interruptSelection('app.theme');
  const path = field === 'layout' ? shared : settings;
  const edited = JSON.stringify({ ...JSON.parse((await readFile(path)).toString()), [field]: 'foreign-selection' });
  await writeFile(path, edited);
  const before = await fingerprint(f);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  expect(await fingerprint(f)).toEqual(before);
  const backup = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === path)!.backup!;
  expect(await readFile(backup)).toEqual(field === 'layout' ? originalShared : original);
}, 60_000);

test('unrelated app settings edits survive interrupted setup recovery and rollback', async () => {
  const { f, settings, shared, originalShared } = await interruptSelection('app.theme');
  await writeFile(settings, JSON.stringify({ ...JSON.parse((await readFile(settings)).toString()), zoom: 2, custom: { keep: true } }));
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(JSON.parse((await readFile(settings)).toString())).toEqual({ theme: 'spider-glass', zoom: 2, custom: { keep: true }, sounds: { enabled: false } });
  expect(JSON.parse(await readFile(shared, 'utf8')).layout).toBe('Spider');
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse((await readFile(settings)).toString())).toEqual({ theme: 'stock', zoom: 2, custom: { keep: true } });
  expect(await readFile(shared)).toEqual(originalShared);
}, 60_000);

test('rollback from a partial app selection restores the original settings bytes exactly', async () => {
  const { f, settings, original, shared, originalShared } = await interruptSelection('app.theme');
  expect(JSON.parse((await readFile(settings)).toString())).toEqual({ zoom: 1.25, theme: 'stock' });
  expect(JSON.parse(await readFile(shared, 'utf8')).layout).toBe('Spider');
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings)).toEqual(original);
  expect(await readFile(shared)).toEqual(originalShared);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
}, 60_000);
