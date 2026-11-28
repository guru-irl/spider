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



// Recording cutover as complete before both app commands succeed skips selection on retry.
test.each(['layout.switch', 'app.theme'] as const)('setup resumes an interruption at %s and preserves its original backup', async command => {
  const { f, settings, original, shared, originalShared } = await interruptSelection(command, command === 'layout.switch' ? 'process' : 'socket');
  const partial = JSON.parse(await readFile(settings, 'utf8'));
  expect(partial.theme).toBe('stock');
  expect(JSON.parse(await readFile(shared, 'utf8')).layout).toBe(command === 'app.theme' ? 'Spider' : 'main');
  const backup = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === settings)!.backup!;
  expect(await readFile(backup)).toEqual(original);
  const backupMtime = (await stat(backup)).mtimeMs;

  const resumed = await setupHerdr(f.request, f.parts);
  expect(resumed.doctor.failures).toEqual([]);
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ zoom: 1.25, theme: 'spider-glass', sounds: { enabled: false } });
  expect(JSON.parse(await readFile(shared, 'utf8')).layout).toBe('Spider');
  expect((await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === settings)!.backup).toBe(backup);
  expect(await readFile(backup)).toEqual(original);
  expect((await stat(backup)).mtimeMs).toBe(backupMtime);

  const installed = await readFile(settings), unchangedBefore = await fingerprint(f);
  const unchanged = await setupHerdr(f.request, f.parts);
  expect(unchanged.writes).toEqual([]);
  expect(await fingerprint(f)).toEqual(unchangedBefore);
  // Even an original value is a user edit once setup has verified the installation.
  const edited = JSON.stringify({ ...JSON.parse(installed.toString()), theme: 'stock' });
  await writeFile(settings, edited);
  const editedBefore = await fingerprint(f);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  expect(await fingerprint(f)).toEqual(editedBefore);
  await writeFile(settings, installed);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings)).toEqual(original);
  expect(await readFile(shared)).toEqual(originalShared);
}, 60_000);


test('rollback releases a verified user theme and restores the other owned paths', async () => {
  const f = await fastFixture(), settings = join(f.request.config.app.home, 'settings.json');
  await setupHerdr(f.request, f.parts);
  const shared = join(f.request.config.app.home, 'shared.json');
  const edited = JSON.stringify({ ...JSON.parse((await readFile(settings)).toString()), theme: 'stock' });
  await writeFile(settings, edited);
  const warn = vi.spyOn(f.parts, 'warn');
  await rollbackHerdr(f.request, f.parts);
  const expected = '{"zoom":1.25,"theme":"stock"}';
  expect(await readFile(settings, 'utf8')).toBe(expected);
  expect(JSON.parse(await readFile(shared, 'utf8')).layout).toBe('main');
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/theme.*released|released.*theme/));
  expect((await readJournal(f.request.journalRoot)).entries.some(entry => entry.path === settings)).toBe(false);
  expect(await rollbackHerdr(f.request, f.parts)).toEqual([]);
  expect(await readFile(settings, 'utf8')).toBe(expected);
}, 60_000);
